import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { expandHome } from './config.mjs';

/**
 * Codex（ChatGPT 登录）OAuth 令牌续期。
 *
 * 设计边界（与 A5 实施计划/A6/A7 契约一致）：
 * - 只操作用户明确给出的 auth.json（托管账号自己的文件），**绝不**替 live（~/.codex/auth.json）续期；
 *   调用方必须显式传 allowRefresh=true，默认 false。
 * - 纯逻辑（JWT exp 解析、是否续期、失败分类）与 IO（读、写、fetch）分离，IO 全部可注入，便于离线单测。
 * - 原子写回：同目录临时文件 + fsync + rename，只替换 tokens 里的令牌字段与 last_refresh，其余字段原样保留。
 * - 绝不记录 token：没有 console 输出；错误 message 只带 HTTP 状态与上游 error.code，且经脱敏。
 */

/** 官方刷新端点；测试可用 CODEX_REFRESH_TOKEN_URL_OVERRIDE 覆盖（与 codex.exe 同名环境变量）。 */
export const CODEX_OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token';
export const CODEX_REFRESH_URL_ENV = 'CODEX_REFRESH_TOKEN_URL_OVERRIDE';
/** codex.exe 内置的 ChatGPT 客户端 ID（auth.json 的 tokens.oauth_provenance.client_id 同值）。 */
export const DEFAULT_CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
/** access_token 剩余严格小于 24h 才提前续期（恰好 24h 不刷）。 */
export const DEFAULT_SKEW_MS = 24 * 60 * 60 * 1000;
/** last_refresh 超过 7 天也续期（兜底：access_token 的 exp 异常或不可解析时）。 */
export const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_TIMEOUT_MS = 15000;

/** 失败/状态码（classifyRefreshFailure 的 code 取值）。 */
export const REFRESH_ERROR_CODES = Object.freeze({
  INVALID_GRANT: 'invalid_grant',
  INVALID_REQUEST: 'invalid_request',
  NOT_REFRESHABLE: 'not_refreshable',
  RATE_LIMITED: 'rate_limited',
  SERVER: 'server',
  NETWORK: 'network',
  BAD_RESPONSE: 'bad_response',
  BAD_AUTH_FILE: 'bad_auth_file',
  WRITE_FAILED: 'write_failed'
});

/** 统一展开 ~ 并转绝对路径：read/refresh/lock/CAS 共用，避免同一文件出现两种 key。 */
function resolveAuthPath(authPath) {
  return path.resolve(expandHome(String(authPath || '')));
}

const PERMANENT_GRANT_ERRORS = new Set([
  'refresh_token_invalidated',
  'refresh_token_reused',
  'refresh_token_expired',
  'invalid_grant'
]);

/** 续期相关错误：code 见 REFRESH_ERROR_CODES；retryable 表示下一轮可再试。 */
export class CodexOauthError extends Error {
  constructor(code, message, { status = null, retryable = false, retryAfterMs = null, cause = null } = {}) {
    super(message);
    this.name = 'CodexOauthError';
    this.code = code;
    this.status = status;
    this.retryable = Boolean(retryable);
    this.retryAfterMs = retryAfterMs;
    if (cause) this.cause = cause;
  }
}

// ---------------------------------------------------------------- 脱敏 / 解析工具

export function redactSecrets(text, secrets = []) {
  let out = String(text ?? '');
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 6) out = out.split(secret).join('***');
  }
  return out;
}

/** 把令牌完全遮蔽，只留长度；仅用于调试日志，本模块自身不打印。 */
export function maskToken(value) {
  if (typeof value !== 'string' || !value) return '';
  return `***${value.length}`;
}

/** 解析 JWT 的 payload（不校验签名）；非 JWT/坏 base64 返回 null。 */
export function decodeJwtPayload(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length < 2 || !parts[1]) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
  } catch {
    return null;
  }
}

function parseTimestampMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  if (typeof value !== 'string' || !value.trim()) return null;
  // auth.json 的 last_refresh 带 6 位小数（如 .349324Z），Date.parse 在部分实现只认 3 位，先截断再解析
  const normalized = value.trim().replace(/(\.\d{3})\d+/, '$1');
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : null;
}

function accessTokenExpiryMs(authJson) {
  const token =
    authJson && authJson.tokens && typeof authJson.tokens === 'object' ? authJson.tokens.access_token : null;
  if (typeof token !== 'string' || !token) return null;
  const payload = decodeJwtPayload(token);
  const rawExp = payload && payload.exp !== undefined && payload.exp !== null ? Number(payload.exp) : NaN;
  const exp = Number.isFinite(rawExp) ? rawExp : null;
  return exp === null ? null : exp * 1000;
}

/** access_token 的到期时间（读取 JWT exp）；非 JWT 或没有 exp 时返回 null。 */
export function accessTokenExpiresAt(authJson) {
  const ms = accessTokenExpiryMs(authJson);
  return ms === null ? null : new Date(ms);
}

/** 同上，返回毫秒时间戳（便于与 Date.now() 比较）。 */
export function accessTokenExpiresAtMs(authJson) {
  return accessTokenExpiryMs(authJson);
}

/**
 * 详细评估登录态（供 UI/历史记录展示，shouldRefresh 是它的薄封装）。
 * 返回：hasAccessToken/hasRefreshToken/accountId/accessTokenExpiresAt/expiresInMs/
 *       expired/lastRefreshAt/tokenAgeMs/needsRefresh/reason。
 */
export function assessCodexAuth(authJson, {
  now = Date.now(),
  skewMs = DEFAULT_SKEW_MS,
  maxAgeMs = DEFAULT_MAX_AGE_MS
} = {}) {
  const tokens =
    authJson && authJson.tokens && typeof authJson.tokens === 'object' ? authJson.tokens : {};
  const hasAccessToken = typeof tokens.access_token === 'string' && tokens.access_token.length > 0;
  const hasRefreshToken = typeof tokens.refresh_token === 'string' && tokens.refresh_token.length > 0;
  const accountId = typeof tokens.account_id === 'string' && tokens.account_id ? tokens.account_id : null;
  const expMs = hasAccessToken ? accessTokenExpiryMs(authJson) : null;
  const lastRefreshMs = parseTimestampMs(authJson && authJson.last_refresh);
  const expiresInMs = expMs === null ? null : expMs - now;
  const tokenAgeMs = lastRefreshMs === null ? null : now - lastRefreshMs;

  let reason = 'fresh';
  if (!hasAccessToken) reason = 'no-access-token';
  else if (expMs === null) reason = 'unknown-expiry';
  else if (expiresInMs <= 0) reason = 'expired';
  else if (expiresInMs < skewMs) reason = 'expiring-soon';

  const expired = expMs !== null && expMs <= now;
  const staleRefresh = tokenAgeMs !== null && tokenAgeMs > maxAgeMs;
  let needsRefresh = false;
  if (hasRefreshToken && (reason !== 'fresh' || staleRefresh)) {
    needsRefresh = true;
    if (reason === 'fresh') reason = 'stale-last-refresh';
  } else if (!hasRefreshToken && reason !== 'fresh') {
    reason = hasAccessToken ? 'no-refresh-token' : 'no-access-token';
  }

  return {
    hasAccessToken,
    hasRefreshToken,
    accountId,
    accessTokenExpiresAt: expMs === null ? null : new Date(expMs),
    expiresInMs,
    expired,
    lastRefreshAt: lastRefreshMs === null ? null : new Date(lastRefreshMs),
    tokenAgeMs,
    needsRefresh,
    reason
  };
}

/** 是否该续期：exp 剩余 < skewMs，或 last_refresh 超过 maxAgeMs；没有 refresh_token 时永远 false。 */
export function shouldRefresh(authJson, { now = Date.now(), skewMs = DEFAULT_SKEW_MS, maxAgeMs = DEFAULT_MAX_AGE_MS } = {}) {
  return assessCodexAuth(authJson, { now, skewMs, maxAgeMs }).needsRefresh;
}

// ---------------------------------------------------------------- 读 / 写

/** 读取 auth.json 并返回解析后的对象（结构不对抛 bad_auth_file，错误文本不含令牌）。 */
export async function readCodexAuth(authPath, { fsImpl = fs } = {}) {
  const file = resolveAuthPath(authPath);
  let raw;
  try {
    raw = await fsImpl.readFile(file, 'utf8');
  } catch (err) {
    throw new CodexOauthError(
      REFRESH_ERROR_CODES.BAD_AUTH_FILE,
      `读取 Codex 登录态失败：${file}（${(err && err.code) || '读取错误'}）`,
      { cause: err }
    );
  }
  let auth;
  try {
    auth = JSON.parse(raw);
  } catch {
    throw new CodexOauthError(REFRESH_ERROR_CODES.BAD_AUTH_FILE, `Codex 登录态不是合法 JSON：${file}`);
  }
  if (!auth || typeof auth !== 'object' || Array.isArray(auth)) {
    throw new CodexOauthError(REFRESH_ERROR_CODES.BAD_AUTH_FILE, `Codex 登录态结构不对：${file}`);
  }
  if (!auth.tokens || typeof auth.tokens !== 'object' || Array.isArray(auth.tokens)) {
    throw new CodexOauthError(REFRESH_ERROR_CODES.BAD_AUTH_FILE, `Codex 登录态缺少 tokens：${file}`);
  }
  return auth;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function renameWithRetry(fsImpl, from, to) {
  const delays = [0, 20, 60];
  let lastError;
  for (const delay of delays) {
    if (delay) await sleep(delay);
    try {
      await fsImpl.rename(from, to);
      return;
    } catch (err) {
      lastError = err;
      const code = err && err.code;
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') throw err;
    }
  }
  throw lastError;
}

/** 只清理「陈旧」临时文件：仍在写入中的并发 tmp 不能误删，故按 mtime 设阈值。 */
const STALE_TMP_MS = 60 * 1000;

/** 清理本 auth 文件同一前缀的陈旧临时文件（进程被硬杀后可能残留含令牌的 .tmp）。 */
async function cleanupStaleTempFiles(fsImpl, file) {
  const dir = path.dirname(file);
  const prefix = `.${path.basename(file)}.`;
  let names;
  try {
    names = await fsImpl.readdir(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith('.tmp')) continue;
    const candidate = path.join(dir, name);
    try {
      const stat = await fsImpl.stat(candidate);
      if (Date.now() - stat.mtimeMs < STALE_TMP_MS) continue; // 可能是另一进程正在写的 tmp
      await fsImpl.unlink(candidate);
      removed += 1;
    } catch {
      /* 清理失败不影响本次写入 */
    }
  }
  return removed;
}

/**
 * 原子写回 auth.json：先清理同前缀陈旧 .tmp → 同目录临时文件（wx/0600）→ 写入 → fsync → rename 覆盖。
 * 只写调用方给的对象；写后重新读回校验 access_token 已生效。
 */
export async function writeCodexAuthAtomic(authPath, authJson, { fsImpl = fs, mode = 0o600 } = {}) {
  const file = resolveAuthPath(authPath);
  const dir = path.dirname(file);
  await cleanupStaleTempFiles(fsImpl, file);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  const text = `${JSON.stringify(authJson, null, 2)}\n`;
  let handle = null;
  try {
    handle = await fsImpl.open(tmp, 'wx', mode);
    await handle.writeFile(text, 'utf8');
    if (typeof handle.sync === 'function') {
      try {
        await handle.sync();
      } catch {
        /* 某些文件系统不支持 fsync，忽略 */
      }
    }
    await handle.close();
    handle = null;
  } catch (err) {
    if (handle) {
      try {
        await handle.close();
      } catch {
        /* ignore */
      }
    }
    try {
      await fsImpl.unlink(tmp);
    } catch {
      /* ignore */
    }
    throw new CodexOauthError(
      REFRESH_ERROR_CODES.WRITE_FAILED,
      `写回 Codex 登录态失败：${file}（${(err && err.code) || '写入错误'}）`,
      { cause: err }
    );
  }

  try {
    await renameWithRetry(fsImpl, tmp, file);
  } catch (err) {
    try {
      await fsImpl.unlink(tmp);
    } catch {
      /* ignore */
    }
    throw new CodexOauthError(
      REFRESH_ERROR_CODES.WRITE_FAILED,
      `写回 Codex 登录态失败：${file}（${(err && err.code) || 'rename 失败'}）`,
      { cause: err }
    );
  }

  // 写后校验：确认落盘的是新令牌（防止半写/被其他进程覆盖）
  try {
    const check = JSON.parse(await fsImpl.readFile(file, 'utf8'));
    const expected = authJson && authJson.tokens ? authJson.tokens.access_token : null;
    const actual = check && check.tokens ? check.tokens.access_token : null;
    if (expected && actual !== expected) {
      throw new CodexOauthError(
        REFRESH_ERROR_CODES.WRITE_FAILED,
        `写回 Codex 登录态后校验失败：${file}（文件内容与预期不一致）`
      );
    }
  } catch (err) {
    if (err instanceof CodexOauthError) throw err;
    throw new CodexOauthError(
      REFRESH_ERROR_CODES.WRITE_FAILED,
      `写回 Codex 登录态后无法读回校验：${file}`,
      { cause: err }
    );
  }

  return { path: file, bytes: Buffer.byteLength(text, 'utf8'), mode };
}

// ---------------------------------------------------------------- 并发锁

const authLocks = new Map();

function lockKey(authPath) {
  return resolveAuthPath(authPath).toLowerCase();
}

/** 同一 auth 文件（按绝对路径，Windows 不区分大小写）串行执行；不同文件互不阻塞。 */
export function withCodexAuthLock(authPath, fn) {
  const key = lockKey(authPath);
  const previous = authLocks.get(key) || Promise.resolve();
  const run = previous.catch(() => {}).then(() => fn());
  const tail = run.catch(() => {});
  authLocks.set(key, tail);
  tail.then(() => {
    if (authLocks.get(key) === tail) authLocks.delete(key);
  });
  return run;
}

// ---------------------------------------------------------------- 失败分类

function upstreamErrorCode(json) {
  if (!json || typeof json !== 'object') return null;
  const error = json.error;
  if (typeof error === 'string' && error.trim()) return error.trim();
  if (error && typeof error === 'object') {
    for (const field of ['code', 'type', 'reason']) {
      if (typeof error[field] === 'string' && error[field].trim()) return error[field].trim();
    }
  }
  if (typeof json.code === 'string' && json.code.trim()) return json.code.trim();
  return null;
}

function upstreamErrorDetail(json, text) {
  if (json && typeof json === 'object') {
    const error = json.error;
    if (error && typeof error === 'object') {
      for (const field of ['message', 'description', 'error_description']) {
        if (typeof error[field] === 'string' && error[field].trim()) return error[field].trim();
      }
    }
    for (const field of ['error_description', 'message']) {
      if (typeof json[field] === 'string' && json[field].trim()) return json[field].trim();
    }
  }
  return String(text || '').trim();
}

function parseRetryAfterMs(headers, json, now = Date.now()) {
  let raw = null;
  if (headers && typeof headers.get === 'function') {
    raw = headers.get('retry-after');
  }
  const text = raw === null || raw === undefined ? '' : String(raw).trim();
  if (text) {
    const numeric = Number(text);
    if (Number.isFinite(numeric) && numeric >= 0) return Math.round(numeric * 1000);
    // RFC 7231 允许 HTTP-date；过去时间视为立即可重试（0）
    const dateMs = Date.parse(text);
    if (Number.isFinite(dateMs)) return Math.max(0, dateMs - now);
  }
  const fallback = json && json.error && typeof json.error === 'object' ? Number(json.error.retry_after) : NaN;
  if (Number.isFinite(fallback) && fallback >= 0) return Math.round(fallback * 1000);
  return null;
}

function upstreamHttpError({ status, json, text, secrets }) {
  const code = upstreamErrorCode(json);
  const detail = redactSecrets(upstreamErrorDetail(json, text), secrets).slice(0, 200);
  const suffix = detail ? `：${detail}` : '';
  if (status === 429) {
    return new CodexOauthError(REFRESH_ERROR_CODES.RATE_LIMITED, `刷新被限流（HTTP 429）${suffix}`, {
      status,
      retryable: true,
      retryAfterMs: parseRetryAfterMs(null, json)
    });
  }
  if (status >= 500) {
    return new CodexOauthError(REFRESH_ERROR_CODES.SERVER, `刷新服务暂时不可用（HTTP ${status}）${suffix}`, {
      status,
      retryable: true
    });
  }
  if (code && PERMANENT_GRANT_ERRORS.has(code)) {
    return new CodexOauthError(
      REFRESH_ERROR_CODES.INVALID_GRANT,
      `refresh_token 已失效（HTTP ${status}，${code}），需要重新登录该账号`,
      { status, retryable: false }
    );
  }
  if (status >= 400) {
    return new CodexOauthError(
      REFRESH_ERROR_CODES.INVALID_REQUEST,
      `刷新请求被拒绝（HTTP ${status}${code ? `，${code}` : ''}）${suffix}`,
      { status, retryable: false }
    );
  }
  return new CodexOauthError(REFRESH_ERROR_CODES.BAD_RESPONSE, `刷新返回了意外的 HTTP 状态：${status}`, {
    status,
    retryable: false
  });
}

/** 把任意续期错误归一成 {code,retryable,status,retryAfterMs,message}，供集成层决定"下一轮再试/需重登"。 */
export function classifyRefreshFailure(err, { secrets = [] } = {}) {
  if (err instanceof CodexOauthError) {
    return {
      code: err.code,
      retryable: err.retryable,
      status: err.status === undefined ? null : err.status,
      retryAfterMs: err.retryAfterMs === undefined ? null : err.retryAfterMs,
      message: redactSecrets(err.message, secrets)
    };
  }
  const message = redactSecrets(err && err.message ? err.message : String(err), secrets).slice(0, 200);
  const looksNetwork =
    (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) ||
    /fetch failed|network|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket/i.test(message);
  return {
    code: looksNetwork ? REFRESH_ERROR_CODES.NETWORK : 'unknown',
    retryable: Boolean(looksNetwork),
    status: null,
    retryAfterMs: null,
    message
  };
}

// ---------------------------------------------------------------- 刷新主流程

function resolveEndpoint(endpoint) {
  if (typeof endpoint === 'string' && endpoint.trim()) return endpoint.trim();
  const fromEnv = process.env[CODEX_REFRESH_URL_ENV];
  if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv.trim();
  return CODEX_OAUTH_TOKEN_URL;
}

function resolveClientId(auth, clientId) {
  if (typeof clientId === 'string' && clientId.trim()) return clientId.trim();
  const provenance = auth && auth.tokens ? auth.tokens.oauth_provenance : null;
  if (provenance && typeof provenance === 'object' && typeof provenance.client_id === 'string' && provenance.client_id.trim()) {
    return provenance.client_id.trim();
  }
  return DEFAULT_CODEX_CLIENT_ID;
}

async function requestRefreshToken({ endpoint, clientId, refreshToken, refreshReason, fetchImpl, timeoutMs, secrets }) {
  const body = JSON.stringify({
    grant_type: 'refresh_token',
    client_id: clientId,
    refresh_token: refreshToken,
    refresh_reason: refreshReason
  });
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'quota-board/1.0'
      },
      body,
      redirect: 'manual',
      signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined
    });
  } catch (err) {
    throw new CodexOauthError(
      REFRESH_ERROR_CODES.NETWORK,
      `刷新 Codex 登录态失败：网络错误（${redactSecrets((err && err.message) || '请求失败', secrets).slice(0, 120)}）`,
      { retryable: true, cause: err }
    );
  }

  // 畸形 promise / 非标准响应对象统一归一为 network，避免抛裸 TypeError 破坏失败分类契约
  if (
    !response ||
    typeof response !== 'object' ||
    typeof response.text !== 'function' ||
    typeof response.ok !== 'boolean'
  ) {
    throw new CodexOauthError(
      REFRESH_ERROR_CODES.NETWORK,
      '刷新 Codex 登录态失败：上游返回了非标准响应对象',
      { retryable: true }
    );
  }
  let text;
  try {
    text = await response.text();
  } catch (err) {
    throw new CodexOauthError(
      REFRESH_ERROR_CODES.NETWORK,
      `刷新 Codex 登录态失败：读取响应体出错（${redactSecrets((err && err.message) || '读取失败', secrets).slice(0, 120)}）`,
      { retryable: true, cause: err }
    );
  }
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }

  if (!response.ok) {
    const error = upstreamHttpError({ status: Number(response.status) || 0, json, text, secrets });
    error.retryAfterMs = error.retryAfterMs || parseRetryAfterMs(response.headers, json);
    throw error;
  }
  if (
    !json ||
    typeof json !== 'object' ||
    typeof json.access_token !== 'string' ||
    !json.access_token.trim()
  ) {
    throw new CodexOauthError(
      REFRESH_ERROR_CODES.BAD_RESPONSE,
      `刷新返回的内容不含有效 access_token（HTTP ${response.status}）`,
      { status: Number(response.status) || null, retryable: true }
    );
  }
  json.access_token = json.access_token.trim();
  // refresh_token 若出现就必须是有效非空字符串：空白/类型错一律视为上游异常，绝不覆盖本地旧 refresh_token
  if (Object.prototype.hasOwnProperty.call(json, 'refresh_token')) {
    const nextRefresh = json.refresh_token;
    if (typeof nextRefresh !== 'string' || !nextRefresh.trim()) {
      throw new CodexOauthError(
        REFRESH_ERROR_CODES.BAD_RESPONSE,
        `刷新返回的 refresh_token 无效（空或非字符串），已拒绝写回（HTTP ${response.status}）`,
        { status: Number(response.status) || null, retryable: true }
      );
    }
    json.refresh_token = nextRefresh.trim();
  }
  if (typeof json.id_token === 'string') json.id_token = json.id_token.trim();
  return json;
}

function buildRefreshedAuth(auth, tokenJson, now) {
  const previousTokens = auth.tokens || {};
  const nextTokens = { ...previousTokens };
  nextTokens.access_token = tokenJson.access_token;
  const nextRefreshToken =
    typeof tokenJson.refresh_token === 'string' && tokenJson.refresh_token.trim()
      ? tokenJson.refresh_token.trim()
      : null;
  const rotated = Boolean(nextRefreshToken && nextRefreshToken !== previousTokens.refresh_token);
  if (nextRefreshToken) nextTokens.refresh_token = nextRefreshToken;
  const nextIdToken =
    typeof tokenJson.id_token === 'string' && tokenJson.id_token.trim() ? tokenJson.id_token.trim() : null;
  if (nextIdToken) nextTokens.id_token = nextIdToken;
  const nextAuth = { ...auth, tokens: nextTokens };
  nextAuth.last_refresh = new Date(now).toISOString();
  return { nextAuth, rotated };
}

function resultOf(auth, extra = {}) {
  const assess = assessCodexAuth(auth, { now: extra.now || Date.now(), skewMs: extra.skewMs, maxAgeMs: extra.maxAgeMs });
  return {
    refreshed: Boolean(extra.refreshed),
    skipped: Boolean(extra.skipped),
    changed: Boolean(extra.changed),
    rotated: Boolean(extra.rotated),
    reason: extra.reason || (assess.needsRefresh ? assess.reason : 'fresh'),
    auth,
    accountId: assess.accountId,
    expiresAt: assess.accessTokenExpiresAt,
    expiresAtIso: assess.accessTokenExpiresAt ? assess.accessTokenExpiresAt.toISOString() : null,
    expiresInMs: assess.expiresInMs,
    lastRefreshAt: assess.lastRefreshAt,
    endpoint: extra.endpoint || null
  };
}

// 写回前再读一次磁盘：若令牌已被外部进程轮换（CAS 失败），放弃写回，绝不覆盖别人刚写入的新令牌。
async function detectWriteConflict(authPath, expectedAuth, { fsImpl = fs } = {}) {
  const expectedTokens = (expectedAuth && expectedAuth.tokens) || {};
  let current;
  try {
    current = JSON.parse(await fsImpl.readFile(resolveAuthPath(authPath), 'utf8'));
  } catch {
    return { conflict: true, auth: null, reason: 'unreadable' };
  }
  const currentTokens = (current && current.tokens) || {};
  const sameAccess = currentTokens.access_token === expectedTokens.access_token;
  const sameRefresh = currentTokens.refresh_token === expectedTokens.refresh_token;
  if (sameAccess && sameRefresh) return { conflict: false, auth: current };
  return { conflict: true, auth: current };
}

async function refreshLocked(authPath, auth, options) {
  const {
    fetchImpl = globalThis.fetch,
    now = Date.now(),
    timeoutMs = DEFAULT_TIMEOUT_MS,
    clientId,
    refreshReason = 'proactive_expiry',
    endpoint,
    persist = true,
    fsImpl = fs
  } = options || {};

  const previousTokens = auth.tokens || {};
  const refreshToken = typeof previousTokens.refresh_token === 'string' ? previousTokens.refresh_token : '';
  if (!refreshToken) {
    throw new CodexOauthError(
      REFRESH_ERROR_CODES.NOT_REFRESHABLE,
      `该 Codex 登录态没有 refresh_token，无法自动续期（${path.basename(String(authPath || ''))}）`,
      { retryable: false }
    );
  }

  const previousExpiresAt = accessTokenExpiresAt(auth);
  const secrets = [refreshToken, previousTokens.access_token, previousTokens.id_token].filter(Boolean);
  const resolvedEndpoint = resolveEndpoint(endpoint);
  const tokenJson = await requestRefreshToken({
    endpoint: resolvedEndpoint,
    clientId: resolveClientId(auth, clientId),
    refreshToken,
    refreshReason,
    fetchImpl,
    timeoutMs,
    secrets: secrets.filter(Boolean)
  });

  const { nextAuth, rotated } = buildRefreshedAuth(auth, tokenJson, now);
  if (persist) {
    // CAS：写回前确认磁盘上的令牌仍是本次读取到的那一对；否则说明外部进程已轮换，放弃写回
    const cas = await detectWriteConflict(authPath, auth, { fsImpl });
    if (cas.conflict) {
      const diskAuth = cas.auth || auth;
      return {
        ...resultOf(diskAuth, {
          refreshed: false,
          skipped: true,
          changed: false,
          rotated: false,
          reason: 'stale',
          now,
          endpoint: resolvedEndpoint
        }),
        conflict: true
      };
    }
    try {
      await writeCodexAuthAtomic(authPath, nextAuth, { fsImpl });
    } catch (err) {
      const wrapped = new CodexOauthError(
        REFRESH_ERROR_CODES.WRITE_FAILED,
        `令牌已在服务端轮换，但写回本地失败：${path.basename(String(authPath || ''))}。该账号可能需重新登录。`,
        { cause: err }
      );
      throw wrapped;
    }
  }

  return resultOf(nextAuth, {
    refreshed: true,
    changed: true,
    rotated,
    reason: 'refreshed',
    now,
    endpoint: resolvedEndpoint
  });
}

// 兼容两种调用风格：refreshCodexAuth(authPath, opts) 与 refreshCodexAuth({ authPath, ...opts })。
// 另把 A6 约定的 leewaySeconds（秒）映射到内部的 skewMs（毫秒）。
function normalizeCallArgs(authPathOrOptions, maybeOptions = {}) {
  if (authPathOrOptions && typeof authPathOrOptions === 'object' && !Array.isArray(authPathOrOptions)) {
    const options = { ...authPathOrOptions, ...maybeOptions };
    if (typeof options.authPath !== 'string' || !options.authPath.trim()) {
      throw new CodexOauthError(REFRESH_ERROR_CODES.BAD_AUTH_FILE, '缺少 authPath');
    }
    return { authPath: options.authPath, options };
  }
  return { authPath: String(authPathOrOptions || ''), options: { ...maybeOptions } };
}

function withLeewayAlias(options) {
  if (!options || options.skewMs !== undefined) return options || {};
  const seconds = Number(options.leewaySeconds);
  if (!Number.isFinite(seconds) || seconds < 0) return options;
  return { ...options, skewMs: Math.max(0, Math.round(seconds * 1000)) };
}

/**
 * 强制续期（refresh_token 轮换 + 原子写回）；force=false 时先判断是否需要。
 * 返回 {refreshed, changed, rotated, reason, auth, accountId, expiresAt, expiresAtIso, expiresInMs, lastRefreshAt, endpoint}。
 */
export async function refreshCodexAuth(authPathOrOptions, maybeOptions = {}) {
  const normalized = normalizeCallArgs(authPathOrOptions, maybeOptions);
  const authPath = normalized.authPath;
  const options = withLeewayAlias(normalized.options);
  const { force = false, now = Date.now(), skewMs = DEFAULT_SKEW_MS, maxAgeMs = DEFAULT_MAX_AGE_MS } = options;
  return withCodexAuthLock(authPath, async () => {
    const auth = await readCodexAuth(authPath);
    const assess = assessCodexAuth(auth, { now, skewMs, maxAgeMs });
    // 并发保护：调用方读到的令牌已经被别人刷新过 → 不再强制刷第二次
    const expectedAccessToken = options.expectedAccessToken;
    if (
      expectedAccessToken &&
      auth.tokens &&
      typeof auth.tokens.access_token === 'string' &&
      auth.tokens.access_token !== expectedAccessToken
    ) {
      return resultOf(auth, {
        refreshed: false,
        changed: false,
        rotated: false,
        reason: 'already-refreshed',
        now,
        skewMs,
        maxAgeMs
      });
    }
    if (!force && !assess.needsRefresh) {
      return resultOf(auth, { refreshed: false, changed: false, rotated: false, reason: assess.reason, now, skewMs, maxAgeMs });
    }
    return refreshLocked(authPath, auth, { ...options, now });
  });
}

/**
 * 每轮采集入口：只在 allowRefresh=true（托管且开启自动续期）且确实将过期时续期。
 * allowRefresh=false 时只读不写（live 保护）。
 */
export async function ensureCodexAuthFresh(authPathOrOptions, maybeOptions = {}) {
  const normalized = normalizeCallArgs(authPathOrOptions, maybeOptions);
  const authPath = normalized.authPath;
  const options = withLeewayAlias(normalized.options);
  const {
    allowRefresh = false,
    force = false,
    now = Date.now(),
    skewMs = DEFAULT_SKEW_MS,
    maxAgeMs = DEFAULT_MAX_AGE_MS
  } = options;
  const auth = await readCodexAuth(authPath);
  const assess = assessCodexAuth(auth, { now, skewMs, maxAgeMs });
  if (!allowRefresh) {
    return {
      ...resultOf(auth, { refreshed: false, reason: 'disabled', now, skewMs, maxAgeMs }),
      needsRefresh: assess.needsRefresh
    };
  }
  if (!force && !assess.needsRefresh) {
    return {
      ...resultOf(auth, { refreshed: false, reason: 'fresh', now, skewMs, maxAgeMs }),
      needsRefresh: false
    };
  }
  // force（401 恢复）但没有 refresh_token：按 A6 约定不抛错，交给上层回落到快照
  if (force && !assess.hasRefreshToken) {
    return {
      ...resultOf(auth, { refreshed: false, reason: 'no-refresh-token', now, skewMs, maxAgeMs }),
      needsRefresh: assess.needsRefresh
    };
  }
  return refreshCodexAuth(authPath, {
    ...options,
    force: true,
    now,
    expectedAccessToken: auth.tokens ? auth.tokens.access_token : null
  });
}
