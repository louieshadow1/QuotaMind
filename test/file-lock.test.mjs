import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  withFileLock,
  acquireFileLock,
  releaseFileLock,
  lockPathFor,
  isFileLocked,
  FILE_LOCK_TIMEOUT,
  LOCK_DEFAULT_TIMEOUT_MS,
  LOCK_DEFAULT_STALE_MS
} from '../lib/file-lock.mjs';

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'quota-filelock-'));
}

async function cleanup(dir) {
  await fs.rm(dir, { recursive: true, force: true });
}

test('G5 file-lock：lockPathFor 约定为 <target>.lock，默认值可读', () => {
  assert.equal(lockPathFor('C:/data/daily-history.json'), 'C:/data/daily-history.json.lock');
  assert.equal(LOCK_DEFAULT_TIMEOUT_MS, 5000);
  assert.equal(LOCK_DEFAULT_STALE_MS, 30000);
});

test('G5 file-lock：withFileLock 串行化并发临界区（顺序执行）', async () => {
  const dir = await makeTempDir();
  const target = path.join(dir, 'counter.json');
  await fs.writeFile(target, JSON.stringify({ value: 0 }));
  const order = [];
  try {
    const bump = (name) =>
      withFileLock(target, async () => {
        order.push(name + ':in');
        const raw = JSON.parse(await fs.readFile(target, 'utf8'));
        await new Promise((resolve) => setTimeout(resolve, 15));
        raw.value += 1;
        await fs.writeFile(target, JSON.stringify(raw));
        order.push(name + ':out');
      });
    await Promise.all([bump('a'), bump('b'), bump('c'), bump('d')]);
    // 只保证互斥（in/out 不交错）；不承诺公平顺序（锁文件轮询实现）
    assert.equal(order.length, 8);
    for (let index = 0; index < order.length; index += 2) {
      const name = order[index].replace(':in', '');
      assert.equal(order[index], name + ':in');
      assert.equal(order[index + 1], name + ':out', '临界区不能交错：' + order.join(','));
    }
    assert.equal(JSON.parse(await fs.readFile(target, 'utf8')).value, 4);
    assert.equal(await isFileLocked(target), false, 'fn 结束后锁必须释放');
  } finally {
    await cleanup(dir);
  }
});

test('G5 file-lock：超时抛 FILE_LOCK_TIMEOUT，消息含持有者信息', async () => {
  const dir = await makeTempDir();
  const target = path.join(dir, 'data.json');
  const held = await acquireFileLock(target);
  try {
    await assert.rejects(
      () => withFileLock(target, () => 'never', { timeoutMs: 120, pollMs: 10 }),
      (error) => {
        assert.equal(error.code, FILE_LOCK_TIMEOUT);
        assert.match(error.message, /获取文件锁超时/);
        assert.match(error.message, /pid=/);
        return true;
      }
    );
    assert.equal(await isFileLocked(target), true, '失败方不能删掉持有者的锁');
  } finally {
    const released = await releaseFileLock(held.lockPath, held.token);
    assert.equal(released.released, true);
    await cleanup(dir);
  }
});

test('G5 file-lock：崩溃残留（过期锁）可回收，staleRecovered=true', async () => {
  const dir = await makeTempDir();
  const target = path.join(dir, 'daily-history.json');
  const lockPath = lockPathFor(target);
  try {
    await fs.writeFile(lockPath, JSON.stringify({ pid: 999999, host: 'dead', token: 'stale', createdAt: '2000-01-01T00:00:00.000Z' }));
    const old = new Date(Date.now() - 60000);
    await fs.utimes(lockPath, old, old);
    const info = await acquireFileLock(target, { staleMs: 1000, timeoutMs: 2000 });
    assert.equal(info.staleRecovered, true);
    assert.equal(await isFileLocked(target), true);
    await releaseFileLock(info.lockPath, info.token);
    assert.equal(await isFileLocked(target), false);
  } finally {
    await cleanup(dir);
  }
});

test('G5 file-lock：token 不匹配不会误删别人的锁（release 幂等）', async () => {
  const dir = await makeTempDir();
  const target = path.join(dir, 'x.json');
  const held = await acquireFileLock(target);
  try {
    const wrong = await releaseFileLock(held.lockPath, 'someone-else-token');
    assert.deepEqual(wrong, { released: false, reason: 'not-owner' });
    assert.equal(await isFileLocked(target), true);
    const again = await releaseFileLock(held.lockPath, held.token);
    assert.equal(again.released, true);
    const missing = await releaseFileLock(held.lockPath, held.token);
    assert.equal(missing.released, false);
  } finally {
    await cleanup(dir);
  }
});

test('G5 file-lock：fn 抛错时锁仍被释放，原始错误不被覆盖', async () => {
  const dir = await makeTempDir();
  const target = path.join(dir, 'y.json');
  try {
    await assert.rejects(
      () =>
        withFileLock(target, () => {
          throw new Error('业务失败');
        }),
      /业务失败/
    );
    assert.equal(await isFileLocked(target), false);
  } finally {
    await cleanup(dir);
  }
});
