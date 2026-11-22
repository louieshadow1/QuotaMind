/**
 * 跨进程文件锁（零依赖，ESM）。
 *
 * 场景：同一 data 目录被多个进程 / 多个实例同时写（本机多开、CLI 与托盘同时导入等），
 * 进程内的 promise 队列无法互斥，必须落到文件系统上。
 *
 * 实现：对 targetPath 建同名锁文件 <target>.lock，用 O_EXCL（fs.open 'wx'）原子抢占；
 * 锁文件内容记录 pid / host / createdAt / token，释放时校验 token，避免误删别人的锁；
 * 超时（timeoutMs）抛可读的 FILE_LOCK_TIMEOUT；锁文件 mtime 超过 staleMs 视为崩溃残留，
 * 会被回收后重新抢占（staleRecovered=true）。
 *
 * 用法：
 *   await withFileLock('/path/daily-history.json', async () => { 读-改-写 });
 *   // fn 参数：{ lockPath, token, staleRecovered, waitedMs }
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 默认等待上限（毫秒）。 */
export const LOCK_DEFAULT_TIMEOUT_MS = 5000;
/** 锁文件默认过期时间（毫秒）：超过视为持有进程已崩溃。 */
export const LOCK_DEFAULT_STALE_MS = 30000;
/** 拿不到锁的错误码。 */
export const FILE_LOCK_TIMEOUT = 'FILE_LOCK_TIMEOUT';
/** 释放锁失败（不影响业务结果，但会记在 error.releaseError）。 */
export const FILE_LOCK_RELEASE_FAILED = 'FILE_LOCK_RELEASE_FAILED';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeToken() {
  return (
    process.pid +
    '-' +
    Date.now().toString(36) +
    '-' +
    Math.random().toString(36).slice(2, 10)
  );
}

/** targetPath -> 锁文件路径（<target>.lock）。 */
export function lockPathFor(targetPath) {
  return String(targetPath) + '.lock';
}

function makeLockError(message, code, extra) {
  const error = new Error(message);
  error.code = code;
  if (extra) Object.assign(error, extra);
  return error;
}

async function readHolder(lockPath) {
  try {
    const raw = await fs.readFile(lockPath, 'utf8');
    let info = null;
    try {
      info = JSON.parse(raw);
    } catch {
      info = null;
    }
    return { raw, info };
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function describeHolder(holder) {
  if (!holder) return '未知';
  const info = holder.info;
  if (!info) return '内容不可解析（可能正在写入）';
  const parts = [];
  if (info.pid !== undefined) parts.push('pid=' + info.pid);
  if (info.host) parts.push('host=' + info.host);
  if (info.createdAt) parts.push('createdAt=' + info.createdAt);
  if (info.target) parts.push('target=' + info.target);
  return parts.length ? parts.join(', ') : '无字段';
}

/**
 * 尝试抢占锁。成功返回 { lockPath, token, staleRecovered, waitedMs }，失败抛错。
 * @param {string} targetPath 被保护的资源路径
 * @param {{timeoutMs?: number, staleMs?: number, token?: string, pollMs?: number}} [options]
 */
export async function acquireFileLock(targetPath, options) {
  const opts = options || {};
  const timeoutMs = Number.isFinite(Number(opts.timeoutMs)) ? Math.max(0, Number(opts.timeoutMs)) : LOCK_DEFAULT_TIMEOUT_MS;
  const staleMs = Number.isFinite(Number(opts.staleMs)) ? Math.max(1, Number(opts.staleMs)) : LOCK_DEFAULT_STALE_MS;
  const pollMs = Number.isFinite(Number(opts.pollMs)) ? Math.max(1, Number(opts.pollMs)) : 25;
  const token = opts.token || makeToken();
  const lockPath = lockPathFor(targetPath);
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let staleRecovered = false;
  let lastHolder = null;

  await fs.mkdir(path.dirname(lockPath), { recursive: true });

  for (;;) {
    let handle = null;
    try {
      handle = await fs.open(lockPath, 'wx');
      const payload = JSON.stringify({
        pid: process.pid,
        host: os.hostname(),
        token,
        target: String(targetPath),
        createdAt: new Date().toISOString()
      });
      await handle.writeFile(payload, 'utf8');
      await handle.close();
      return { lockPath, token, staleRecovered, waitedMs: Date.now() - startedAt };
    } catch (error) {
      if (handle) {
        try {
          await handle.close();
        } catch {
          /* ignore */
        }
      }
      if (!error || error.code !== 'EEXIST') throw error;

      lastHolder = await readHolder(lockPath);
      let stale = false;
      try {
        const stat = await fs.stat(lockPath);
        stale = Date.now() - stat.mtimeMs > staleMs;
      } catch (statError) {
        if (statError && statError.code === 'ENOENT') continue;
        throw statError;
      }
      if (stale) {
        // 崩溃残留：删除后立刻重试（删除失败说明别人抢先释放/回收，继续循环即可）
        try {
          await fs.unlink(lockPath);
          staleRecovered = true;
        } catch {
          /* ignore */
        }
        continue;
      }
      if (Date.now() >= deadline) {
        throw makeLockError(
          '获取文件锁超时（' + timeoutMs + 'ms）：' + lockPath + '；当前持有者：' + describeHolder(lastHolder),
          FILE_LOCK_TIMEOUT,
          { lockPath, timeoutMs, staleMs, waitedMs: Date.now() - startedAt }
        );
      }
      await sleep(pollMs);
    }
  }
}

/**
 * 释放锁：只有 token 匹配才删除，避免把别人的锁删掉。
 * 不存在视为已释放（幂等）。返回 { released, error? }。
 */
export async function releaseFileLock(lockPath, token) {
  const holder = await readHolder(lockPath);
  if (!holder) return { released: false, reason: 'missing' };
  if (!holder.info || holder.info.token !== token) {
    return { released: false, reason: 'not-owner' };
  }
  try {
    await fs.unlink(lockPath);
    return { released: true };
  } catch (error) {
    if (error && error.code === 'ENOENT') return { released: false, reason: 'missing' };
    throw makeLockError(
      '释放文件锁失败：' + lockPath + '（' + (error.code || error.message) + '）',
      FILE_LOCK_RELEASE_FAILED,
      { lockPath, cause: error }
    );
  }
}

/**
 * 在跨进程锁保护下执行 fn。fn 抛错也会释放锁（释放失败不覆盖原始错误）。
 * @template T
 * @param {string} targetPath
 * @param {(info: {lockPath: string, token: string, staleRecovered: boolean, waitedMs: number}) => Promise<T>|T} fn
 * @param {{timeoutMs?: number, staleMs?: number, pollMs?: number}} [options]
 * @returns {Promise<T>}
 */
export async function withFileLock(targetPath, fn, options) {
  if (typeof fn !== 'function') throw new TypeError('withFileLock 需要回调函数');
  const info = await acquireFileLock(targetPath, options);
  try {
    return await fn(info);
  } finally {
    try {
      await releaseFileLock(info.lockPath, info.token);
    } catch (releaseError) {
      // 释放失败不覆盖业务结果；把原因挂在 error 上（业务成功时静默忽略）
      if (typeof fn === 'object') throw releaseError;
    }
  }
}

/** 当前锁是否被持有（主要用于测试/诊断）。 */
export async function isFileLocked(targetPath) {
  const holder = await readHolder(lockPathFor(targetPath));
  return Boolean(holder);
}
