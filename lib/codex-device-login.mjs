import { promises as fs, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { expandHome } from './config.mjs';
import { liveCodexAccount, archivedCodexAccounts, readCodexAccountId } from './codex.mjs';

/**
 * 设备码登录：用 codex.exe login --device-auth 在面板自建的独立 CODEX_HOME 里登录第二个 Codex 账号。
 * 背景（A1 实测，codex-cli 0.154.0）：
 *  - 启动登录后约 2 秒会先 logout_with_revoke：删掉该 CODEX_HOME 下的 auth.json 并吊销旧 refresh_token；
 *  - 所以只能使用面板新建的专用 profile 目录，绝不能用 ~/.codex，也不能对已有 auth.json 的目录再次登录；
 *  - 取消/超时/网络失败 = 该 profile 掉登录且不可恢复，UI 必须提示“需要重新登录”；
 *  - 成功后文件在 <CODEX_HOME>/auth.json（非原子写，轮询读到半截 JSON 要重试）。
 */

export const DEVICE_LOGIN_PROFILE_DIR = 'codex-profiles';
export const LOGIN_TIMEOUT_MS = 14 * 60 * 1000; // 早于 codex 自带的 15 分钟，避免它先报错
const KEEP_SESSION_MS = 10 * 60 * 1000;
const MAX_SESSION_HISTORY = 20;
const BROKEN_AUTH_PREFIX = 'auth.json.broken-';
const MAX_BUFFER = 64 * 1024;
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const CODE_RE = /\b([A-Z0-9]{3,8}-[A-Z0-9]{3,8})\b/;
const EXPIRES_RE = /expires in (\d+) minutes?/i;
const URL_PREFIX = 'https://auth.openai.com/codex/device';

class DeviceLoginError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = 'DeviceLoginError';
    this.status = status || 500;
    this.code = code || 'device_login_error';
  }
}

/** 去掉 ANSI 色码（codex 输出带 90/94/0 色码）。 */
export function stripAnsi(text) {
  return String(text || '').replace(ANSI_RE, '');
}

function findDeviceUrl(text) {
  const index = text.indexOf(URL_PREFIX);
  if (index < 0) return null;
  let end = index;
  while (end < text.length && !/[\s"'<>]/.test(text[end])) end += 1;
  return text.slice(index, end);
}

/** 从设备码输出解析 URL / 一次性码 / 有效期（分钟）。解析要宽松：码为 4 位+'-'+5 位，共 9 字符。 */
export function parseDeviceAuthOutput(raw) {
  const text = stripAnsi(raw);
  const url = findDeviceUrl(text);
  const codeMatch = text.match(CODE_RE);
  const expiresMatch = text.match(EXPIRES_RE);
  return {
    url,
    code: codeMatch ? codeMatch[1] : null,
    expiresMinutes: expiresMatch ? Number(expiresMatch[1]) : null
  };
}

function isFile(target) {
  try {
    return statSync(target).isFile();
  } catch {
    return false;
  }
}

/** 会话 DTO 里只暴露 profile 名，不暴露 codexHome 绝对路径（P2 路径泄漏）。 */
function profileHomeLabel(profile) {
  return profile ? DEVICE_LOGIN_PROFILE_DIR + '/' + profile : null;
}

function isAuthJsonUsable(json) {
  const tokens = json && json.tokens;
  return Boolean(tokens && typeof tokens.access_token === 'string' && tokens.access_token.trim());
}

/**
 * 检查 profile 目录里的 auth.json：none / valid / broken。
 * broken（半写 JSON、缺 tokens.access_token）会在原目录备份为 auth.json.broken-<ts>，
 * 视为“无登录态”，允许同 slug 重新登录（P2 半写阻塞修复）。
 */
async function inspectProfileAuth(home) {
  const authPath = path.join(home, 'auth.json');
  let raw;
  try {
    raw = await fs.readFile(authPath, 'utf8');
  } catch {
    return { state: 'none', authPath, backupPath: null };
  }
  try {
    if (isAuthJsonUsable(JSON.parse(raw))) return { state: 'valid', authPath, backupPath: null };
  } catch {
    /* 半写/损坏 JSON，走备份流程 */
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(home, BROKEN_AUTH_PREFIX + stamp);
  try {
    await fs.rename(authPath, backupPath);
    return { state: 'broken', authPath, backupPath };
  } catch {
    return { state: 'broken', authPath, backupPath: null };
  }
}

/**
 * 清理孤儿 profile 目录：没有 auth.json 且不在 keepHomes（活跃会话目录）中的 starting 残留。
 * 有 auth.json 的目录（含损坏待备份的）保守保留，交给 allocateProfile/人工处理。
 */
async function cleanupOrphanProfiles(root, keepHomes = []) {
  const keep = new Set((keepHomes || []).map((item) => path.resolve(item).toLowerCase()));
  let entries = [];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const removed = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const home = path.join(root, entry.name);
    if (keep.has(path.resolve(home).toLowerCase())) continue;
    let hasAuth = false;
    try {
      await fs.access(path.join(home, 'auth.json'));
      hasAuth = true;
    } catch {
      hasAuth = false;
    }
    if (hasAuth) continue;
    try {
      await fs.rm(home, { recursive: true, force: true });
      removed.push(home);
    } catch {
      /* 目录被占用（可能仍有残留进程）：下一轮再清 */
    }
  }
  return removed;
}

function binError(message) {
  return new DeviceLoginError(message, 500, 'CODEX_BIN_NOT_FOUND');
}

/** 找 codex.exe：env QUOTA_BOARD_CODEX_BIN（兼容 CODEX_BIN）→ PATH → %LOCALAPPDATA% 默认位置。 */
export function resolveCodexBin(env = process.env) {
  const safeEnv = env || {};
  const custom = String(safeEnv.QUOTA_BOARD_CODEX_BIN || safeEnv.CODEX_BIN || '').trim();
  if (custom) {
    const bin = expandHome(custom);
    if (isFile(bin)) return { bin, source: 'env' };
    throw binError('环境变量 QUOTA_BOARD_CODEX_BIN 指向的文件不存在');
  }
  const pathValue = String(safeEnv.PATH || safeEnv.Path || '');
  const exts = process.platform === 'win32' ? ['.exe'] : [''];
  for (const dir of pathValue.split(path.delimiter)) {
    const base = dir.trim();
    if (!base) continue;
    for (const ext of exts) {
      const candidate = path.join(base, 'codex' + ext);
      if (isFile(candidate)) return { bin: candidate, source: 'path' };
    }
  }
  if (process.platform === 'win32') {
    const localAppData = safeEnv.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    const candidate = path.join(localAppData, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe');
    if (isFile(candidate)) return { bin: candidate, source: 'default' };
  }
  throw binError('找不到 codex.exe：请安装 Codex，或设置环境变量 QUOTA_BOARD_CODEX_BIN 指向可执行文件');
}

function killTreeDefault(child) {
  if (!child || child.exitCode !== null || !child.pid) return;
  try {
    if (process.platform === 'win32') {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true
      });
      killer.on('error', () => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
      });
    } else {
      child.kill();
    }
  } catch {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
  }
}

function maskEmail(email) {
  const value = String(email || '').trim();
  const at = value.indexOf('@');
  if (at < 1) return '';
  return value.slice(0, 1) + '***' + value.slice(at);
}

function decodeIdTokenClaims(idToken) {
  if (typeof idToken !== 'string') return null;
  const parts = idToken.split('.');
  if (parts.length < 2) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** 读 auth.json（非原子写，读失败/半截 JSON 重试 3 次），只取安全字段，绝不返回 token 全文。 */
async function readAuthIdentity(authPath) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const json = JSON.parse(await fs.readFile(authPath, 'utf8'));
      const tokens = json && json.tokens;
      if (!tokens || typeof tokens.access_token !== 'string' || !tokens.access_token.trim()) return null;
      const claims = decodeIdTokenClaims(tokens.id_token) || {};
      const authClaims = claims['https://api.openai.com/auth'] || {};
      return {
        authPath,
        accountId: typeof tokens.account_id === 'string' && tokens.account_id.trim() ? tokens.account_id.trim() : authClaims.chatgpt_account_id || null,
        name: typeof claims.name === 'string' && claims.name.trim() ? claims.name.trim() : '',
        emailMasked: maskEmail(claims.email)
      };
    } catch {
      if (attempt < 2) await sleep(100);
    }
  }
  return null;
}

function cleanName(value) {
  return String(value || '').replace(/[\r% B%n% B%t]+/g, ' ').trim().slice(0, 40);
}

function uniqueName(takenNames, base) {
  const taken = new Set((takenNames || []).filter(Boolean));
  const clean = String(base || 'Codex 设备码账号').trim().slice(0, 40) || 'Codex 设备码账号';
  if (!taken.has(clean)) return clean;
  for (let index = 2; index < 100; index += 1) {
    const candidate = clean.slice(0, 37) + ' ' + index;
    if (!taken.has(candidate)) return candidate;
  }
  return clean;
}

export function createDeviceLoginManager({ store, env = process.env, deps = {}, onRegistered = null } = {}) {
  if (!store || typeof store.load !== 'function') throw new Error('createDeviceLoginManager 需要 store');
  const spawnCodex = deps.spawnCodex || spawn;
  const killTree = deps.killTree || killTreeDefault;
  const now = deps.now || Date.now;
  const pollMs = Math.max(5, Number(deps.pollMs) || 1000);
  const timeoutMs = Math.max(50, Number(deps.timeoutMs) || LOGIN_TIMEOUT_MS);
  const keepMs = Math.max(0, Number(deps.keepMs ?? KEEP_SESSION_MS));
  let current = null;
  /** 活跃（starting/waiting）会话集合：dispose 时必须全部清理，避免竞态下的孤儿进程。 */
  const activeSessions = new Set();

  const safeEnv = env || {};

  function profileRoot() {
    const custom = String(safeEnv.QUOTA_BOARD_CODEX_PROFILES || '').trim();
    if (custom) return path.resolve(expandHome(custom));
    return path.join(store.dataDir, DEVICE_LOGIN_PROFILE_DIR);
  }

  function sanitizeSlug(value) {
    return String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24);
  }

  async function allocateProfile(root, requestedSlug) {
    const base = sanitizeSlug(requestedSlug) || 'codex';
    const explicit = Boolean(sanitizeSlug(requestedSlug));
    for (let index = 1; index <= 50; index += 1) {
      const candidate = index === 1 ? base : base + '-' + index;
      const home = path.join(root, candidate);
      let exists = false;
      try {
        const stat = await fs.stat(home);
        exists = stat.isDirectory();
      } catch {
        exists = false;
      }
      if (exists) {
        const auth = await inspectProfileAuth(home);
        if (auth.state === 'valid') {
          if (explicit) {
            throw new DeviceLoginError(
              '该 profile 目录已有登录态（auth.json），继续登录会注销它；请换一个名称或先手动清理该目录',
              409,
              'profile_has_auth'
            );
          }
          continue;
        }
        if (auth.state === 'broken') {
          // 半写/损坏 auth.json 已备份为 auth.json.broken-<ts>，目录可安全地重新登录。
          return { profile: candidate, home, recovered: true };
        }
        if (explicit) return { profile: candidate, home };
        continue;
      }
      await fs.mkdir(home, { recursive: true, mode: 0o700 });
      return { profile: candidate, home };
    }
    throw new DeviceLoginError('无法分配 profile 目录，请检查面板数据目录下的 codex-profiles', 500, 'profile_alloc_failed');
  }

  function sessionAuthPath(session) {
    return path.join(session.codexHome, 'auth.json');
  }

  /** 内部用：profile 名 → 绝对目录（不进 DTO，供测试/内部逻辑定位 auth.json）。 */
  function profileHome(profile) {
    if (!profile) return null;
    return path.join(profileRoot(), String(profile));
  }

  function clearTimers(session) {
    if (session.pollTimer) clearInterval(session.pollTimer);
    if (session.timeoutTimer) clearTimeout(session.timeoutTimer);
    session.pollTimer = null;
    session.timeoutTimer = null;
  }

  function scheduleCleanup(session) {
    if (session.cleanupTimer) clearTimeout(session.cleanupTimer);
    session.cleanupTimer = setTimeout(() => {
      if (current === session) current = null;
      activeSessions.delete(session);
    }, keepMs);
    if (session.cleanupTimer.unref) session.cleanupTimer.unref();
  }

  /** 最近会话（id → session），供 GET ?id= 查询与列表使用；只保留有界历史。 */
  const sessionsById = new Map();

  function rememberSession(session) {
    sessionsById.set(session.id, session);
    if (sessionsById.size > MAX_SESSION_HISTORY) {
      for (const [id, item] of sessionsById) {
        if (sessionsById.size <= MAX_SESSION_HISTORY) break;
        if (item.status === 'starting' || item.status === 'waiting') continue;
        sessionsById.delete(id);
      }
    }
  }

  function getSession(id) {
    if (!id) return null;
    const session = sessionsById.get(String(id));
    return session ? toPublic(session) : null;
  }

  function listSessions() {
    return [...sessionsById.values()]
      .sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')))
      .map((session) => toPublic(session));
  }

  function toPublic(session) {
    const account = session.account;
    return {
      id: session.id,
      status: session.status,
      profile: session.profile,
      codexHomeLabel: profileHomeLabel(session.profile),
      url: session.url,
      code: session.code,
      startedAt: session.startedAt,
      expiresAt: session.expiresAt,
      finishedAt: session.finishedAt,
      error: session.error,
      errorCode: session.errorCode,
      hint: session.hint,
      duplicate: session.duplicate,
      account: account ? { id: account.id, name: account.name, managed: account.managed, autoRefresh: account.autoRefresh } : null
    };
  }

  function failSession(session, errorCode, message) {
    if (session.status === 'success' || session.status === 'cancelled' || session.status === 'expired' || session.status === 'failed') return;
    clearTimers(session);
    session.status = 'failed';
    session.finishedAt = new Date(now()).toISOString();
    session.errorCode = errorCode;
    session.error = message;
    session.url = null;
    session.code = null;
    if (session.child) killTree(session.child);
    activeSessions.delete(session);
    scheduleCleanup(session);
  }

  /** 中断/异常后：目录里没有 auth.json 就删掉，避免 starting 残留目录累积（P3 孤儿清理）。 */
  function cleanupSessionHomeIfEmpty(session) {
    if (!session || !session.codexHome) return;
    const home = session.codexHome;
    void (async () => {
      try {
        await fs.access(path.join(home, 'auth.json'));
        return;
      } catch {
        /* 无 auth.json，可清理 */
      }
      await sleep(300); // 等子进程真正退出，避免 Windows 删除被占用
      try {
        await fs.access(path.join(home, 'auth.json'));
        return;
      } catch {
        /* still empty */
      }
      try {
        await fs.rm(home, { recursive: true, force: true });
      } catch {
        /* 删除失败留给启动时 cleanupOrphans 再清 */
      }
    })();
  }

  function expireSession(session) {
    if (session.status !== 'starting' && session.status !== 'waiting') return;
    clearTimers(session);
    session.status = 'expired';
    session.finishedAt = new Date(now()).toISOString();
    session.errorCode = 'timeout';
    session.error = '设备码已过期（约 15 分钟）；该账号会话已被注销，需要重新开始登录';
    session.url = null;
    session.code = null;
    if (session.child) killTree(session.child);
    activeSessions.delete(session);
    cleanupSessionHomeIfEmpty(session);
    scheduleCleanup(session);
  }

  async function registerAccount(session, identity) {
    const config = await store.load();
    const codex = config && config.providers && config.providers.codex;
    if (!codex) throw new Error('配置里没有 providers.codex');
    const rawAccounts = Array.isArray(codex.accounts) ? codex.accounts.slice() : [];
    const live = liveCodexAccount(config);
    const takenIds = new Set();
    if (live) {
      const liveId = await readCodexAccountId(live.authPath);
      if (liveId) takenIds.add(liveId);
    }
    for (const account of rawAccounts) {
      const accountId = await readCodexAccountId(account.authPath);
      if (accountId) takenIds.add(accountId);
    }
    if (identity.accountId && takenIds.has(identity.accountId)) return { duplicate: true, account: null };
    const baseName = cleanName(session.requestedName) || identity.name || identity.emailMasked || 'Codex 设备码账号';
    const name = uniqueName([...(live ? [live.name] : []), ...rawAccounts.map((item) => item.name)], baseName);
    const account = {
      id: 'codex-' + randomBytes(4).toString('hex'),
      name,
      authPath: sessionAuthPath(session),
      codexHome: session.codexHome,
      managed: true,
      autoRefresh: true,
      addedAt: new Date(now()).toISOString()
    };
    codex.accounts = [...rawAccounts, account];
    await store.saveConfig(config);
    return { duplicate: false, account };
  }

  async function completeSuccess(session, identity) {
    if (session.status !== 'starting' && session.status !== 'waiting') return;
    clearTimers(session);
    session.status = 'success';
    session.finishedAt = new Date(now()).toISOString();
    session.url = null;
    session.code = null;
    if (session.child && session.child.exitCode === null) {
      // 成功后子进程可能还在收尾：2 秒后仍存活就强杀，杀完再从活跃集合移除。
      session.graceTimer = setTimeout(() => {
        killTree(session.child);
        activeSessions.delete(session);
      }, 2000);
      if (session.graceTimer.unref) session.graceTimer.unref();
    } else {
      activeSessions.delete(session);
    }
    try {
      const result = await registerAccount(session, identity);
      if (result.duplicate) {
        session.duplicate = true;
        session.hint = '该账号已经出现在面板里（account_id 相同），没有重复添加；该 profile 已登录，可手动删除目录';
      } else {
        session.account = result.account;
        session.hint = '已加入 Codex 账户列表；下一轮采集会自动查询，并按续期规则自动续期';
        if (typeof onRegistered === 'function') await onRegistered(result.account);
      }
    } catch {
      session.hint = '登录成功，但写入面板配置失败，请检查本机文件权限';
    }
    scheduleCleanup(session);
  }

  async function pollAuth(session) {
    if (!session || (session.status !== 'starting' && session.status !== 'waiting')) return;
    const identity = await readAuthIdentity(sessionAuthPath(session));
    if (identity) await completeSuccess(session, identity);
  }

  function describeExit(session, code) {
    const stderr = stripAnsi(session.stderr);
    if (/error sending request for url/i.test(stderr)) {
      return '网络或代理异常，无法连接 auth.openai.com；该账号会话已被注销，需要重新登录';
    }
    if (/device code login is not enabled/i.test(stderr)) {
      return '当前 Codex 服务端未开放设备码登录，请改用浏览器登录';
    }
    if (/device auth timed out/i.test(stderr)) {
      return 'codex 报告设备码超时（15 分钟）；该账号会话已被注销，需要重新登录';
    }
    return Number.isSafeInteger(code) ? 'codex.exe 登录失败（退出码 ' + code + '）' : 'codex.exe 登录时已退出，请重试';
  }

  async function onChildClose(session, code) {
    if (!session || (session.status !== 'starting' && session.status !== 'waiting')) return;
    const identity = await readAuthIdentity(sessionAuthPath(session));
    if (identity) {
      await completeSuccess(session, identity);
      return;
    }
    if (/device auth timed out/i.test(stripAnsi(session.stderr))) {
      expireSession(session);
      return;
    }
    if (code === 0) {
      failSession(session, 'exited_no_auth', 'codex.exe 已退出但没有写出 auth.json，请重试');
      return;
    }
    failSession(session, 'exited', describeExit(session, code));
  }

  function onOutput(session, chunk, isStderr) {
    const text = stripAnsi(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
    if (isStderr) session.stderr = (session.stderr + text).slice(-MAX_BUFFER);
    else session.stdout = (session.stdout + text).slice(-MAX_BUFFER);
    if (session.status !== 'starting') return;
    const parsed = parseDeviceAuthOutput(session.stdout);
    if (!parsed.url || !parsed.code) return;
    session.status = 'waiting';
    session.url = parsed.url;
    session.code = parsed.code;
    const minutes = parsed.expiresMinutes && parsed.expiresMinutes > 0 ? parsed.expiresMinutes : 15;
    session.expiresAt = new Date(now() + minutes * 60000).toISOString();
  }

  function attachSession(session) {
    const child = session.child;
    if (!child || typeof child.on !== 'function') {
      failSession(session, 'spawn_failed', '无法启动 codex.exe');
      return;
    }
    child.on('error', () => {
      failSession(session, 'spawn_failed', '无法启动 codex.exe，请检查本机权限和 Codex 安装');
    });
    if (child.stdout && typeof child.stdout.on === 'function') child.stdout.on('data', (chunk) => onOutput(session, chunk, false));
    if (child.stderr && typeof child.stderr.on === 'function') child.stderr.on('data', (chunk) => onOutput(session, chunk, true));
    child.on('close', (code) => {
      onChildClose(session, code).catch(() => {});
    });
    session.timeoutTimer = setTimeout(() => expireSession(session), timeoutMs);
    if (session.timeoutTimer.unref) session.timeoutTimer.unref();
    session.pollTimer = setInterval(() => {
      pollAuth(session).catch(() => {});
    }, pollMs);
    if (session.pollTimer.unref) session.pollTimer.unref();
  }

  async function start(input = {}) {
    // P1-02 单飞（check-then-act 竞态修复）：
    // 第一行就同步判定并占位，任何 await 之前把 status=starting 的会话写进 current；
    // 并发请求在同一 tick 内会看到占位，从而直接 409，不会再 spawn 第二个进程。
    if (current && (current.status === 'starting' || current.status === 'waiting')) {
      throw new DeviceLoginError('已有设备码登录正在进行中，请稍候或先取消当前登录', 409, 'login_in_progress');
    }
    const session = {
      id: 'ml-' + randomBytes(5).toString('hex'),
      status: 'starting',
      profile: null,
      codexHome: null,
      url: null,
      code: null,
      startedAt: new Date(now()).toISOString(),
      expiresAt: null,
      finishedAt: null,
      error: null,
      errorCode: null,
      hint: null,
      duplicate: false,
      requestedName: cleanName(input && input.name),
      requestedSlug: input && (input.slug || input.profile),
      child: null,
      stdout: '',
      stderr: '',
      pollTimer: null,
      timeoutTimer: null,
      graceTimer: null,
      cleanupTimer: null
    };
    // 同步占位：从这里到 await 结束之前，其他并发 start() 都会被上面的 409 拦住。
    current = session;
    activeSessions.add(session);
    rememberSession(session);
    try {
      const binInfo = resolveCodexBin(safeEnv);
      const root = profileRoot();
      await fs.mkdir(root, { recursive: true, mode: 0o700 });
      const slot = await allocateProfile(root, session.requestedSlug);
      session.profile = slot.profile;
      session.codexHome = slot.home;
      session.child = spawnCodex(binInfo.bin, ['login', '--device-auth'], {
        cwd: slot.home,
        env: { ...process.env, ...safeEnv, CODEX_HOME: slot.home },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false
      });
      attachSession(session);
      return toPublic(session);
    } catch (err) {
      // 启动失败/异常必须释放占位，否则 409 会把后续所有登录永久挡住。
      clearTimers(session);
      if (session.graceTimer) {
        clearTimeout(session.graceTimer);
        session.graceTimer = null;
      }
      if (session.child) killTree(session.child);
      session.status = 'failed';
      session.finishedAt = new Date(now()).toISOString();
      const knownError = err instanceof DeviceLoginError;
      session.errorCode = knownError ? err.code : 'start_failed';
      session.error = knownError ? err.message : '启动设备码登录失败，请检查本机权限和 Codex 安装';
      session.url = null;
      session.code = null;
      activeSessions.delete(session);
      if (current === session) current = null;
      cleanupSessionHomeIfEmpty(session);
      throw err;
    }
  }

  function status(id) {
    if (id) return getSession(id);
    return current ? toPublic(current) : null;
  }

  function list() {
    return listSessions();
  }

  /** 启动时/手动清理：删除无 auth.json 的孤儿 profile 目录（保留活跃会话目录）。 */
  async function cleanupOrphans() {
    const keepHomes = [...activeSessions].map((session) => session.codexHome).filter(Boolean);
    if (current && current.codexHome) keepHomes.push(current.codexHome);
    return cleanupOrphanProfiles(profileRoot(), keepHomes);
  }

  async function cancel(id) {
    const session = id ? sessionsById.get(String(id)) : current;
    if (!session) return null;
    if (session.status === 'starting' || session.status === 'waiting') {
      const identity = await readAuthIdentity(sessionAuthPath(session));
      if (identity) {
        await completeSuccess(session, identity);
        return toPublic(session);
      }
      clearTimers(session);
      session.status = 'cancelled';
      session.finishedAt = new Date(now()).toISOString();
      session.errorCode = 'cancelled';
      session.hint = '已取消；该账号的登录会话已被注销，重新登录需要再走一次设备码';
      session.url = null;
      session.code = null;
      if (session.child) killTree(session.child);
      activeSessions.delete(session);
      cleanupSessionHomeIfEmpty(session);
      scheduleCleanup(session);
    }
    return toPublic(session);
  }

  function dispose() {
    const sessions = new Set(activeSessions);
    if (current) sessions.add(current);
    for (const session of sessions) {
      clearTimers(session);
      if (session.graceTimer) clearTimeout(session.graceTimer);
      if (session.cleanupTimer) clearTimeout(session.cleanupTimer);
      session.graceTimer = null;
      session.cleanupTimer = null;
      // 任何仍存活的子进程都要杀掉（成功后的 2 秒收尾窗口也不能漏）。
      if (session.child && session.child.exitCode === null) killTree(session.child);
    }
    activeSessions.clear();
    sessionsById.clear();
    current = null;
  }

  return { start, status, list, cancel, cleanupOrphans, profileHome, dispose };
}

// ── server.mjs 分发钩子（A6 在请求处理器里调用；路径兼容 lead/A6 两种约定） ─────────
/** 同一个 store 复用同一个 manager（单飞：一个面板进程只允许一个设备码会话）。 */
const managersByStore = new WeakMap();
const REQUEST_PATHS = ['/api/codex/device-login', '/api/codex/managed-login'];
let activeManager = null;

/** 匹配 /api/codex/device-login 或 /api/codex/device-login/:id（也兼容 managed-login）。 */
function matchDeviceLoginPath(pathname) {
  for (const base of REQUEST_PATHS) {
    if (pathname === base) return { base, id: null };
    if (pathname.startsWith(base + '/')) {
      const rest = pathname.slice(base.length + 1);
      if (!rest || rest.includes('/')) return null;
      let id = rest;
      try {
        id = decodeURIComponent(rest);
      } catch {
        /* 非法转义按原串处理 */
      }
      return { base, id: id || null };
    }
  }
  return null;
}

function queryParam(ctx, name) {
  const url = ctx && ctx.url;
  if (!url) return null;
  try {
    const parsed = typeof url === 'string' ? new URL(url, 'http://127.0.0.1') : url;
    return parsed.searchParams ? parsed.searchParams.get(name) : null;
  } catch {
    return null;
  }
}

process.once('exit', () => {
  if (!activeManager) return;
  try {
    activeManager.dispose();
  } catch {
    /* 进程退出阶段尽力而为 */
  }
});

function managerFor(ctx) {
  const store = ctx.store;
  const existing = managersByStore.get(store);
  if (existing) return existing;
  const env = ctx.env || process.env;
  const manager = createDeviceLoginManager({
    store,
    env,
    deps: ctx.deps || {},
    onRegistered: () => {
      try {
        if (typeof ctx.invalidateAllCaches === 'function') ctx.invalidateAllCaches(store);
      } catch {
        /* 缓存失效失败不影响登录结果 */
      }
    }
  });
  managersByStore.set(store, manager);
  activeManager = manager;
  // 启动时清理上一次中断/异常留下的孤儿 profile 目录（无 auth.json 的 starting 残留）。
  manager.cleanupOrphans().catch(() => {});
  return manager;
}

/**
 * 供 server.mjs 请求处理器调用。pathname 命中 /api/codex/device-login 或 /api/codex/managed-login 时：
 *  POST   启动设备码登录（202 {ok,session}）
 *  GET    查询当前会话（200 {session|null}）
 *  DELETE 取消当前会话（200 {ok,session}；无会话 404）
 * 返回 true 表示已写响应；false 表示不认领，调用方继续走原路由/404。
 */
export async function handleCodexDeviceLoginRequest(ctx) {
  const matched = ctx && ctx.pathname ? matchDeviceLoginPath(ctx.pathname) : null;
  if (!matched) return false;
  const pathId = matched.id || null;
  const json = ctx.jsonResponse;
  const { req, res, method } = ctx;
  const manager = managerFor(ctx);
  try {
    if (method === 'POST') {
      if (pathId) {
        json(res, 405, { error: '方法不支持：不能在具体会话 id 上发起登录' });
        return true;
      }
      let body = {};
      try {
        body = (await ctx.readBody(req)) || {};
      } catch (err) {
        if (err?.status === 413) json(res, 413, { error: '请求体过大' });
        else json(res, 400, { error: '请求体不是合法 JSON' });
        return true;
      }
      const session = await manager.start(body);
      json(res, 202, { ok: true, session });
      return true;
    }
    if (method === 'GET') {
      const id = pathId || queryParam(ctx, 'id');
      if (id) {
        const session = manager.status(id);
        if (!session) {
          json(res, 404, { error: '没有该设备码登录会话', code: 'session_not_found' });
          return true;
        }
        json(res, 200, { session });
        return true;
      }
      // 兼容旧客户端：session 字段永远存在；sessions 为最近会话列表（新）。
      json(res, 200, { session: manager.status(), sessions: manager.list() });
      return true;
    }
    if (method === 'DELETE') {
      const id = pathId || queryParam(ctx, 'id');
      const session = await manager.cancel(id || undefined);
      if (!session) {
        json(res, 404, {
          error: id ? '没有该设备码登录会话' : '当前没有进行中的设备码登录',
          code: id ? 'session_not_found' : null
        });
        return true;
      }
      json(res, 200, { ok: true, session });
      return true;
    }
    json(res, 405, { error: '方法不支持（只支持 POST / GET / DELETE）' });
    return true;
  } catch (err) {
    const knownError = err instanceof DeviceLoginError;
    json(res, knownError ? err.status : 500, {
      error: knownError ? err.message : '设备码登录失败，请检查本机权限和 Codex 安装',
      code: knownError ? err.code : null
    });
    return true;
  }
}

/** 服务关闭/测试清理时释放子进程与定时器。传 store 只释放该 store 的 manager。 */
export function disposeCodexDeviceLogin(store) {
  if (!store) {
    if (activeManager) activeManager.dispose();
    return;
  }
  const manager = managersByStore.get(store);
  if (manager) manager.dispose();
}
