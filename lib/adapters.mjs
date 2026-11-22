import { promises as fs } from 'node:fs';
import path from 'node:path';
import { lookup as dnsLookup } from 'node:dns/promises';
import { expandHome } from './config.mjs';
import { ensureCodexAuthFresh, classifyRefreshFailure } from './codex-oauth.mjs';
import { windowKindFromSeconds, planMetaFor } from './plan.mjs';

export class HttpError extends Error {
  constructor(status, message, body = '') {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
  }
}

export class UnconfiguredError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnconfiguredError';
  }
}

const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
export const CODEX_PROFILE_URL = 'https://chatgpt.com/backend-api/wham/profiles/me';
export const OPENCODE_GO_USAGE_URL = 'https://opencode.ai/zen/go/v1/usage';

export const RELAY_TYPES = ['newapi-account', 'newapi-token', 'sub2api', 'generic'];

function num(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return null;
}

/** JS 时间上限（ms）：超过它 Date 会变 Invalid，统一判无效。 */
const MAX_TIME_MS = 8.64e15;
/** 数值上限：超过 1e13 的 epoch/百分比按无效处理（防 2^53、1e308 之类脏值）。 */
const MAX_NUMERIC_VALUE = 1e13;

function toIso(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0 || Math.abs(value) > MAX_NUMERIC_VALUE) return null;
    const ms = value < 1e12 ? value * 1000 : value;
    if (Math.abs(ms) > MAX_TIME_MS) return null;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof value === 'string') {
    const d = new Date(value);
    if (Number.isNaN(d.getTime()) || Math.abs(d.getTime()) > MAX_TIME_MS) return null;
    return d.toISOString();
  }
  return null;
}

/** used_percent 收敛：非法/超大视为 null，其余夹到 0–100。 */
function clampPercent(value) {
  const n = num(value);
  if (n === null) return null;
  if (Math.abs(n) > MAX_NUMERIC_VALUE) return null;
  return Math.max(0, Math.min(100, n));
}

export async function httpJson(url, options = {}) {
  const {
    method = 'GET',
    headers = {},
    body,
    timeoutMs = 12000,
    fetchImpl = globalThis.fetch
  } = options;
  let res;
  try {
    res = await fetchImpl(url, {
      method,
      headers: {
        'User-Agent': 'quota-board/1.0',
        Accept: 'application/json',
        ...headers
      },
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined
    });
  } catch (err) {
    throw new HttpError(0, err?.name === 'TimeoutError' ? '上游请求超时' : '网络请求失败，请检查连接或代理设置');
  }
  if (!res.ok || (res.status >= 300 && res.status < 400)) {
    res.body?.cancel().catch(() => {});
    if (res.status >= 300 && res.status < 400) {
      throw new HttpError(res.status, `上游返回重定向（HTTP ${res.status}），已拒绝跟随`);
    }
    // Provider error bodies may echo credentials, account information or proxy details.
    throw new HttpError(res.status, `上游返回 HTTP ${res.status}`);
  }
  let text = '';
  if (typeof res.text === 'function') {
    text = await res.text().catch(() => '');
  } else if (typeof res.json === 'function') {
    // 兼容注入的极简 fetch mock（只有 ok/json，没有 text）
    try {
      text = JSON.stringify(await res.json());
    } catch {
      text = '';
    }
  }
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  if (json === null) {
    throw new HttpError(res.status, '上游返回的不是 JSON');
  }
  return { status: res.status, json, text };
}

async function readOptionalJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

function findStringDeep(node, predicate, seen = new Set()) {
  if (node === null || node === undefined) return null;
  if (typeof node === 'string') return predicate(node) ? node : null;
  if (typeof node !== 'object' || seen.has(node)) return null;
  seen.add(node);
  for (const value of Object.values(node)) {
    const hit = findStringDeep(value, predicate, seen);
    if (hit) return hit;
  }
  return null;
}

// ---------------------------------------------------------------- Codex 鉴权 / 续期

/**
 * Codex 续期闸门（进程内）：
 * - 单飞：同一 auth 文件同一时刻只允许一个续期请求，跨 /api/quota、/api/usage、后台归档共用；
 * - 冷却：永久失败（invalid_grant 等）30 分钟、暂态失败 5 分钟不重试，避免每轮打 auth.openai.com；
 * - 主动续期最小间隔 60 秒。
 */
const PROACTIVE_REFRESH_MIN_INTERVAL_MS = 60 * 1000;
const REFRESH_COOLDOWN_MS = Object.freeze({
  invalid_grant: 30 * 60 * 1000,
  invalid_request: 30 * 60 * 1000,
  not_refreshable: 30 * 60 * 1000,
  write_failed: 10 * 60 * 1000,
  rate_limited: 5 * 60 * 1000,
  server: 5 * 60 * 1000,
  network: 5 * 60 * 1000,
  bad_response: 5 * 60 * 1000,
  bad_auth_file: 5 * 60 * 1000,
  default: 5 * 60 * 1000
});
const REFRESH_REASON_MESSAGES = Object.freeze({
  invalid_grant: '登录凭据已失效，需要重新登录该账号',
  invalid_request: '官方续期服务拒绝了请求',
  write_failed: '无法保存更新后的登录态',
  rate_limited: '官方续期服务暂时限流',
  server: '官方续期服务暂时不可用',
  network: '无法连接官方续期服务',
  bad_response: '官方续期服务返回了无法识别的结果',
  bad_auth_file: '无法读取有效的 Codex 登录文件',
  'no-refresh-token': '登录态没有 refresh_token，无法自动续期（可能需要重新登录）',
  not_refreshable: '登录态没有 refresh_token，无法自动续期（可能需要重新登录）',
  disabled: '该账号未开启自动续期',
  fresh: '令牌仍在有效期内',
  'already-refreshed': '另一个请求已完成续期'
});
const refreshStates = new Map();

/** 仅测试用：清空续期闸门（生产环境进程重启后自然清空）。 */
export function resetCodexRefreshState() {
  refreshStates.clear();
}

function refreshStateKey(authPath) {
  try {
    return path.resolve(expandHome(authPath)).toLowerCase();
  } catch {
    return String(authPath || '');
  }
}

function refreshGateFor(key) {
  let gate = refreshStates.get(key);
  if (!gate) {
    gate = { inFlight: null, lastAttemptAt: 0, blockedUntil: 0 };
    refreshStates.set(key, gate);
  }
  return gate;
}

function emptyCodexRefreshStatus() {
  return { attempted: false, refreshedAt: null, expiresAt: null, rotated: false, code: null, lastError: null };
}

/** 只合并标量状态，绝不把 auth（含 token）带进对外返回结构。 */
function mergeCodexRefreshStatus(target, update) {
  if (!update) return target;
  if (update.attempted) target.attempted = true;
  if (update.refreshedAt) {
    target.refreshedAt = update.refreshedAt;
    target.expiresAt = update.expiresAt || target.expiresAt;
    target.rotated = Boolean(update.rotated);
    target.code = null;
    target.lastError = null;
  } else if (update.lastError) {
    target.code = target.code || update.code || null;
    target.lastError = update.lastError;
  }
  return target;
}

/**
 * 带闸门的续期：
 * mode='proactive' 时只有确实需要（exp<24h 或 last_refresh>7d 由 ensureCodexAuthFresh 判断）才刷新；
 * mode='forced' 时（wham 401）无视阈值强制试一次（仍遵守失败冷却）。
 */
async function refreshCodexAuthGuarded(authPath, {
  allowRefresh = false,
  live = false,
  force = false,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  skewMs,
  maxAgeMs,
  refreshGate,
  mode = 'proactive'
} = {}) {
  const status = emptyCodexRefreshStatus();
  if (!allowRefresh || live) {
    status.code = 'disabled';
    return status;
  }
  const file = expandHome(authPath);
  const key = refreshStateKey(file);
  const gate = refreshGate || refreshGateFor(key);
  const nowMs = typeof now === 'function' ? now() : now;

  if (gate.inFlight) {
    const shared = await gate.inFlight;
    return Object.assign(status, shared.status);
  }
  if (gate.blockedUntil > nowMs) {
    status.code = 'cooldown';
    status.lastError = '上次续期失败，' + Math.max(1, Math.ceil((gate.blockedUntil - nowMs) / 1000)) + ' 秒内不再重试';
    return status;
  }
  if (mode === 'proactive' && gate.lastAttemptAt && nowMs - gate.lastAttemptAt < PROACTIVE_REFRESH_MIN_INTERVAL_MS) {
    return status; // 刚续期过，本轮跳过（不算失败）
  }

  const task = (async () => {
    const local = emptyCodexRefreshStatus();
    local.attempted = true;
    try {
      const options = { allowRefresh: true, force, now: nowMs, fetchImpl };
      if (Number.isFinite(skewMs)) options.skewMs = skewMs;
      if (Number.isFinite(maxAgeMs)) options.maxAgeMs = maxAgeMs;
      const result = await ensureCodexAuthFresh(file, options);
      if (result && result.refreshed) {
        local.refreshedAt =
          result.auth && result.auth.last_refresh ? String(result.auth.last_refresh) : new Date(nowMs).toISOString();
        local.expiresAt =
          result.expiresAt instanceof Date ? result.expiresAt.toISOString() : result.expiresAt ? String(result.expiresAt) : null;
        local.rotated = result.rotated === true;
        local.auth = result.auth;
        gate.blockedUntil = 0;
        gate.lastAttemptAt = nowMs;
      } else {
        local.attempted = false;
        local.code = (result && result.reason) || 'fresh';
      }
    } catch (err) {
      const { code } = classifyRefreshFailure(err);
      local.code = Object.hasOwn(REFRESH_REASON_MESSAGES, code) ? code : 'unknown';
      local.lastError = REFRESH_REASON_MESSAGES[local.code] || '自动续期失败';
      gate.blockedUntil = nowMs + (REFRESH_COOLDOWN_MS[local.code] || REFRESH_COOLDOWN_MS.default);
      gate.lastAttemptAt = nowMs;
    }
    return { status: local };
  })();
  gate.inFlight = task;
  try {
    const shared = await task;
    return Object.assign(status, shared.status);
  } finally {
    if (gate.inFlight === task) gate.inFlight = null;
  }
}

function codexAuthHeaders(auth, extraHeaders = {}) {
  const token = auth && auth.tokens && auth.tokens.access_token;
  if (!token) {
    throw new UnconfiguredError('Codex 登录态中没有 access_token（可能是 API Key 模式，无法读取套餐额度）');
  }
  const accountId = auth.tokens && auth.tokens.account_id;
  const headers = { ...(extraHeaders || {}), Authorization: 'Bearer ' + token };
  if (accountId && !headers['ChatGPT-Account-Id']) headers['ChatGPT-Account-Id'] = String(accountId);
  return headers;
}

async function requestCodexJson(url, { auth, extraHeaders, fetchImpl, timeoutMs = 12000 }) {
  return httpJson(url, { headers: codexAuthHeaders(auth, extraHeaders), fetchImpl, timeoutMs });
}

/**
 * Codex 官方接口的统一鉴权请求：
 * - 托管账号（allowRefresh=true 且非 live）在请求前按需续期（exp<24h 或 last_refresh>7d）；
 * - 401 时强制续期一次并只重试一次，仍失败保持 HttpError(401)，交给调用方走既有 stale 回落；
 * - live（live=true）结构上永不续期；续期失败/冷却只通过 refresh 状态字段暴露，不吞掉原有错误语义。
 * 返回 { status, json, text, auth, refresh }。
 */
export async function codexAuthenticatedJson(url, {
  authPath,
  extraHeaders = {},
  allowRefresh = false,
  live = false,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  skewMs,
  maxAgeMs,
  timeoutMs = 12000,
  refreshGate
} = {}) {
  const file = expandHome(authPath || '~/.codex/auth.json');
  const auth = await readOptionalJson(file);
  if (!auth) {
    throw new UnconfiguredError('未找到可用的 Codex 登录态，请检查账号设置或重新登录');
  }
  const canRefresh = allowRefresh === true && live !== true;
  const refresh = emptyCodexRefreshStatus();
  let current = auth;

  if (canRefresh) {
    const proactive = await refreshCodexAuthGuarded(file, {
      allowRefresh: true,
      live: false,
      force: false,
      fetchImpl,
      now,
      skewMs,
      maxAgeMs,
      refreshGate,
      mode: 'proactive'
    });
    mergeCodexRefreshStatus(refresh, proactive);
    if (proactive.auth) current = proactive.auth;
  }

  try {
    const envelope = await requestCodexJson(url, { auth: current, extraHeaders, fetchImpl, timeoutMs });
    return { ...envelope, auth: current, refresh };
  } catch (err) {
    if (!canRefresh || !(err instanceof HttpError) || err.status !== 401) {
      // 只有真正尝试过续期（或已有上次失败原因）才附带状态，保持旧调用方行为不变。
      if (err && typeof err === 'object' && (refresh.attempted || refresh.lastError)) err.refresh = refresh;
      throw err;
    }
    const forced = await refreshCodexAuthGuarded(file, {
      allowRefresh: true,
      live: false,
      force: true,
      fetchImpl,
      now,
      skewMs,
      maxAgeMs,
      refreshGate,
      mode: 'forced'
    });
    mergeCodexRefreshStatus(refresh, forced);
    if (forced.auth) current = forced.auth;
    else current = (await readOptionalJson(file)) || current;

    if (!forced.refreshedAt) {
      const reason =
        forced.lastError ||
        REFRESH_REASON_MESSAGES[forced.code] ||
        '自动续期失败';
      const wrapped = new HttpError(401, '上游返回 HTTP 401（自动续期失败：' + reason + '）');
      wrapped.refresh = refresh;
      throw wrapped;
    }

    try {
      const envelope = await requestCodexJson(url, { auth: current, extraHeaders, fetchImpl, timeoutMs });
      return { ...envelope, auth: current, refresh };
    } catch (retryErr) {
      if (retryErr instanceof HttpError && retryErr.status === 401) {
        const wrapped = new HttpError(401, '自动续期成功但上游仍返回 401（该账号可能需要重新登录）');
        wrapped.refresh = refresh;
        throw wrapped;
      }
      if (retryErr && typeof retryErr === 'object' && (refresh.attempted || refresh.lastError)) retryErr.refresh = refresh;
      throw retryErr;
    }
  }
}

/** OpenCode Go Key 解析：环境变量 → 本地 secrets → OpenCode auth.json。 */
export async function resolveOpencodeGoKey({ store, env = process.env } = {}) {
  const envKey = env.OPENCODE_GO_API_KEY || env.OPENCODE_API_KEY;
  if (typeof envKey === 'string' && envKey.trim()) return { key: envKey.trim(), source: 'env' };

  if (store) {
    for (const name of ['OPENCODE_GO_API_KEY', 'OPENCODE_API_KEY']) {
      const value = await store.getSecret(name);
      if (value) return { key: value, source: 'secrets' };
    }
  }

  const candidates = [
    '~/.local/share/opencode/auth.json',
    '~/.config/opencode/auth.json',
    '~/.opencode/auth.json'
  ];
  for (const candidate of candidates) {
    const json = await readOptionalJson(expandHome(candidate));
    if (!json) continue;
    const fromKnown = json['opencode-go'] || json.opencodeGo || json['opencode-go-api'];
    const knownKey =
      (fromKnown && (fromKnown.key || fromKnown.token || fromKnown.apiKey)) || null;
    const key =
      typeof knownKey === 'string' && knownKey.trim()
        ? knownKey.trim()
        : findStringDeep(json, (value) => /^oc_sk_[A-Za-z0-9_\-]{8,}$/.test(value));
    if (key) return { key, source: candidate.replace('~/', '~/') };
  }
  return null;
}

/**
 * SSRF 防护：只允许 http/https，且拒绝回环/私网/链路本地/元数据地址。
 * 先查字面量（IP），再对域名做 dns.lookup 二次校验（防 DNS 指向内网）。
 * 解析失败即拒绝（避免用无法解析/解析异常绕过内网校验），解析出的任一地址落在内网同样拒绝。
 */
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata',
  'metadata.google.internal',
  'instance-data',
  'instance-data.ec2.internal'
]);

const BLOCKED_V4_RANGES = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4]
];

function ipv4ToInt(ip) {
  const parts = String(ip || '').split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = ((value << 8) + n) >>> 0;
  }
  return value;
}

/** 判断单个 IP 是否属于禁止访问范围（IPv4 / IPv6 / IPv4-mapped）。 */
export function isBlockedIp(ip) {
  const raw = String(ip || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!raw) return true;
  const host = raw.split('%')[0];
  if (host.includes('.')) {
    const v4 = host.startsWith('::ffff:') ? host.slice('::ffff:'.length) : host;
    const n = ipv4ToInt(v4);
    if (n === null) return true;
    return BLOCKED_V4_RANGES.some(([base, bits]) => {
      const b = ipv4ToInt(base);
      const mask = bits === 32 ? 0xffffffff : ((0xffffffff << (32 - bits)) >>> 0);
      return (n & mask) === (b & mask);
    });
  }
  if (host === '::' || host === '::1') return true;
  if (/^fe[89ab]/.test(host)) return true; // fe80::/10 链路本地
  if (/^f[cd]/.test(host)) return true; // fc00::/7 唯一本地
  if (/^ff/.test(host)) return true; // 组播
  return false;
}

function hostnameBlocked(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (!host) return true;
  if (BLOCKED_HOSTNAMES.has(host)) return true;
  return ['.localhost', '.local', '.internal', '.home.arpa'].some((suffix) => host.endsWith(suffix));
}

/**
 * 校验中转站/自定义 URL 是否允许访问；不通过时抛 UnconfiguredError。
 * lookupImpl 可注入（测试用 mock dns），默认 node:dns/promises lookup。
 */
/** 测试/自建本地中转开关：仅当显式设置该环境变量时放行回环/私网地址。 */
function privateRelayAllowed() {
  return process.env.QUOTA_BOARD_ALLOW_PRIVATE_RELAY === '1' || process.env.QUOTA_BOARD_ALLOW_PRIVATE_RELAYS === '1';
}

export async function assertPublicHttpUrl(rawUrl, { lookupImpl = dnsLookup, allowPrivateRelay = privateRelayAllowed() } = {}) {
  let url;
  try {
    url = new URL(String(rawUrl));
  } catch {
    throw new UnconfiguredError('站点地址不是合法的 URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UnconfiguredError('站点地址必须是以 http:// 或 https:// 开头的完整地址');
  }
  if (url.username || url.password) {
    throw new UnconfiguredError('站点地址不允许包含用户名或密码');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  // 显式测试开关：放行回环/私网/本机域名（仅用于测试或自建本地中转）。
  if (allowPrivateRelay) return url;
  if (hostnameBlocked(hostname)) {
    throw new UnconfiguredError('站点地址指向本机/内网/元数据地址，已拒绝');
  }
  if (hostname.includes(':') || /^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
    if (isBlockedIp(hostname)) {
      throw new UnconfiguredError('站点地址指向本机/内网/元数据地址，已拒绝');
    }
    return url;
  }
  let addresses;
  try {
    addresses = await lookupImpl(hostname, { all: true, verbatim: true });
  } catch {
    // 解析失败即拒绝：否则可能用「解析失败」绕过内网校验，或制造解析/请求时差（TOCTOU）。
    throw new UnconfiguredError('站点域名解析失败，已拒绝');
  }
  const list = Array.isArray(addresses) ? addresses : [addresses];
  for (const item of list) {
    const address = item && typeof item === 'object' ? item.address : item;
    if (address && isBlockedIp(address)) {
      throw new UnconfiguredError('站点域名解析到本机/内网/元数据地址，已拒绝');
    }
  }
  return url;
}

async function providerBase(relay, { lookupImpl, allowPrivateRelay = privateRelayAllowed() } = {}) {
  let base = String(relay.baseUrl || '').trim().replace(/\/+$/, '');
  base = base.replace(/\/v1$/i, '');
  await assertPublicHttpUrl(base, { lookupImpl, allowPrivateRelay });
  return base;
}

export async function fetchCodexUsage({
  name = 'Codex 账户',
  authPath,
  fetchImpl = globalThis.fetch,
  allowRefresh = false,
  live = false,
  now = Date.now,
  skewMs,
  maxAgeMs,
  refreshGate
} = {}) {
  const file = expandHome(authPath || '~/.codex/auth.json');
  const { json, refresh } = await codexAuthenticatedJson(CODEX_USAGE_URL, {
    authPath: file,
    allowRefresh,
    live,
    fetchImpl,
    now,
    skewMs,
    maxAgeMs,
    refreshGate
  });

  const root = json && json.data && typeof json.data === 'object' ? json.data : json;
  const rate = root.rate_limit || root.rate_limits || root;

  const plan =
    (typeof root.plan_type === 'string' && root.plan_type) ||
    (typeof root.plan === 'string' && root.plan) ||
    (typeof json.plan_type === 'string' && json.plan_type) ||
    null;
  // plan 文本保持上游原值不变；planMeta 只做展示/窗口提示用的派生，二者并存。
  const planMeta = planMetaFor(plan);

  const windows = [];

  /** 同一 provider 内窗口 key 唯一：重复的 custom/unknown 窗口依次加 :2、:3。 */
  const uniqueWindowKey = (key, list) => {
    const base = String(key || 'unknown');
    if (!list.some((item) => item.key === base)) return base;
    let n = 2;
    while (list.some((item) => item.key === `${base}:${n}`)) n += 1;
    return `${base}:${n}`;
  };

  /**
   * primary_window / secondary_window / additional_rate_limits 共用的窗口归一化：
   * 周期身份只由 limit_window_seconds 派生（plan.mjs: windowKindFromSeconds），
   * 不再按槽位写死「5 小时 / 每周」；秒数缺失时如实标成 custom/未知窗口。
   * 保留 usedPercent / resetAt / windowSeconds 原语义。
   */
  const pushWindow = (raw, { labelPrefix = null, keyPrefix = null, dedupe = false } = {}) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
    const used = clampPercent(raw.used_percent);
    let resetAt = toIso(raw.reset_at ?? raw.resets_at);
    if (!resetAt) {
      const after = num(raw.reset_after_seconds);
      if (after !== null && after > 0 && after <= 1e10) {
        const ms = Date.now() + after * 1000;
        resetAt = ms <= MAX_TIME_MS ? new Date(ms).toISOString() : null;
      }
    }
    // windowSeconds 只接受正数有限值；0/负数/非数/超大都按未知周期（null）处理。
    let seconds = num(raw.limit_window_seconds);
    if (seconds !== null && (seconds <= 0 || seconds > MAX_NUMERIC_VALUE)) seconds = null;
    const identity = windowKindFromSeconds(seconds);
    const key = keyPrefix ? keyPrefix + ':' + identity.key : identity.key;
    const label = labelPrefix ? labelPrefix + ' · ' + identity.label : identity.label;
    // 附加窗口按 label/key 去重，避免上游重复条目撑出同名卡片行。
    if (dedupe && windows.some((item) => item.label === label || item.key === key)) return false;
    windows.push({
      key: uniqueWindowKey(key, windows),
      label,
      kind: identity.kind,
      usedPercent: used,
      resetAt,
      windowSeconds: seconds
    });
    return true;
  };

  pushWindow(rate.primary_window || rate.primary);
  pushWindow(rate.secondary_window || rate.secondary);

  const extras = rate.additional_rate_limits || root.additional_rate_limits;
  const MAX_EXTRA_WINDOWS = 8;
  let extraWindowCount = 0;
  /** 摊平形态：容器上直接带窗口字段才算有效窗口，否则视为缺少窗口而跳过。 */
  const hasWindowFields = (obj) =>
    obj &&
    typeof obj === 'object' &&
    (obj.used_percent !== undefined ||
      obj.reset_at !== undefined ||
      obj.resets_at !== undefined ||
      obj.limit_window_seconds !== undefined ||
      obj.reset_after_seconds !== undefined ||
      Boolean(obj.primary_window || obj.secondary_window || obj.primary || obj.secondary));
  if (Array.isArray(extras)) {
    for (const extra of extras) {
      if (extraWindowCount >= MAX_EXTRA_WINDOWS) break;
      if (!extra || typeof extra !== 'object' || Array.isArray(extra)) continue;
      // limit_name 优先（Codex 新接口用它区分附加额度），其次 display_name/name/metered_feature。
      const name =
        (typeof extra.limit_name === 'string' && extra.limit_name.trim()) ||
        extra.display_name ||
        extra.name ||
        extra.metered_feature ||
        '附加额度 ' + (extraWindowCount + 1);
      // additional_rate_limits 可能是 {rate_limit:{primary_window,secondary_window}}，
      // 也可能把窗口字段直接摊平在 rate_limit 上；两种都走同一派生。
      const container = extra.rate_limit && typeof extra.rate_limit === 'object' ? extra.rate_limit : extra;
      const nested = [];
      const primary = container.primary_window || container.primary;
      const secondary = container.secondary_window || container.secondary;
      if (primary) nested.push({ raw: primary, slot: 'primary' });
      if (secondary) nested.push({ raw: secondary, slot: 'secondary' });
      if (nested.length) {
        for (const item of nested) {
          if (extraWindowCount >= MAX_EXTRA_WINDOWS) break;
          if (
            pushWindow(item.raw, {
              labelPrefix: String(name),
              keyPrefix: 'extra:' + String(name) + ':' + item.slot,
              dedupe: true
            })
          ) {
            extraWindowCount += 1;
          }
        }
      } else if (hasWindowFields(container)) {
        if (pushWindow(container, { labelPrefix: String(name), keyPrefix: 'extra:' + String(name), dedupe: true })) {
          extraWindowCount += 1;
        }
      }
    }
  }

  // 没有窗口不一定是错误：free 等计划本就可能没有额度窗口，plus 也可能暂时不返回。
  // 只有「既没有可识别计划、也没有 rate_limit 结构」才视为接口结构异常（保留未知结构兜底）。
  const notes = [];
  if (!windows.length) {
    const expected = Array.isArray(planMeta.expectedWindows) ? planMeta.expectedWindows : [];
    const planHasNoWindows = planMeta.tier !== 'unknown' && expected.length === 0;
    const rateLimitPresent = Boolean(root.rate_limit || root.rate_limits);
    if (planHasNoWindows) {
      notes.push('该计划未提供额度窗口');
    } else if (rateLimitPresent) {
      notes.push('接口未返回窗口');
    } else {
      throw new HttpError(200, '额度接口有返回，但没解析到任何额度窗口（接口结构可能已变化）');
    }
  }

  const creditsRaw =
    (json.credits && typeof json.credits === 'object' && json.credits) ||
    (root.credits && typeof root.credits === 'object' && root.credits) ||
    null;
  const credits = creditsRaw
    ? {
        balance: num(creditsRaw.balance),
        hasCredits: creditsRaw.has_credits === true,
        unlimited: creditsRaw.unlimited === true
      }
    : null;

  return {
    id: 'codex',
    name,
    kind: 'codex',
    status: 'ok',
    plan,
    planMeta,
    credits,
    fetchedAt: new Date().toISOString(),
    windows,
    notes,
    // 供 UI 区分「托管账号（会自动续期）」与普通归档/live（只读不续期）。
    managed: allowRefresh === true && live !== true,
    refresh
  };
}

/** DeepSeek 官方余额（API Key）：GET /user/balance。 */
export async function fetchDeepSeekBalance({ key, fetchImpl = globalThis.fetch } = {}) {
  if (!key) throw new UnconfiguredError('未配置 DeepSeek API Key');
  const { json } = await httpJson('https://api.deepseek.com/user/balance', {
    headers: { Authorization: `Bearer ${key}` },
    fetchImpl
  });
  const infos = Array.isArray(json.balance_infos) ? json.balance_infos : [];
  const info = infos.find((item) => item && item.currency === 'CNY') || infos[0];
  if (!info) {
    throw new HttpError(200, '余额接口没有返回 balance_infos，可能 Key 无效或接口已变化');
  }
  const remaining = num(info.total_balance);
  const granted = num(info.granted_balance);
  const toppedUp = num(info.topped_up_balance);
  const notes = [];
  if (granted !== null || toppedUp !== null) {
    notes.push(`充值余额 ${toppedUp ?? '—'} · 赠送余额 ${granted ?? '—'}（${info.currency || 'CNY'}）`);
  }
  if (json.is_available === false) notes.push('账户当前不可用（is_available=false），请检查余额或 Key 状态');
  return {
    id: 'deepseek',
    name: 'DeepSeek 账户',
    kind: 'deepseek',
    status: 'ok',
    plan: null,
    fetchedAt: new Date().toISOString(),
    windows: [
      {
        key: 'balance',
        label: '余额',
        remaining,
        unit: info.currency || 'CNY',
        resetAt: null
      }
    ],
    notes
  };
}

/** DeepSeek 平台登录态：余额 + 累计消费 + 近 30 天官方用量（私有接口，需 userToken）。 */
export async function fetchDeepSeekPlatform({ token, fetchImpl = globalThis.fetch } = {}) {
  if (!token) throw new UnconfiguredError('未配置 DeepSeek 平台登录态（userToken）');
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'x-client-platform': 'web',
    'User-Agent': 'quota-board/1.0'
  };
  const summary = await httpJson('https://platform.deepseek.com/api/v0/users/get_user_summary', {
    headers,
    fetchImpl
  });
  const biz = summary.json && summary.json.data && summary.json.data.biz_data;
  if (!biz) throw new HttpError(200, '平台余额接口没有返回 biz_data（登录态可能失效）');

  const normalWallets = Array.isArray(biz.normal_wallets) ? biz.normal_wallets : [];
  const bonusWallets = Array.isArray(biz.bonus_wallets) ? biz.bonus_wallets : [];
  const pickCny = (wallets) => wallets.find((wallet) => wallet && wallet.currency === 'CNY');
  const cnyNormal = pickCny(normalWallets);
  const cnyBonus = pickCny(bonusWallets);
  const balance = (num(cnyNormal && cnyNormal.balance) || 0) + (num(cnyBonus && cnyBonus.balance) || 0);
  const totalCosts = Array.isArray(biz.total_costs) ? biz.total_costs : [];
  const cnyTotalCost = totalCosts.find((item) => item && item.currency === 'CNY');
  const spentCny = num(cnyTotalCost && cnyTotalCost.amount);

  // 近 30 天（+08 时区整天）官方每日用量
  const tz = 28800;
  const nowOffset = Date.now() + tz * 1000;
  const dayMs = 86400000;
  const todayStart = Math.floor(nowOffset / dayMs) * dayMs;
  const start = Math.floor((todayStart - 29 * dayMs) / 1000);
  const end = Math.floor((todayStart + dayMs) / 1000);
  let tokens30d = null;
  let requests30d = null;
  let cost30d = null;
  const dailyMap = new Map();
  const ensureDay = (date) => {
    if (!dailyMap.has(date)) dailyMap.set(date, { date });
    return dailyMap.get(date);
  };
  const dateOfBucket = (timeSeconds) => {
    const seconds = num(timeSeconds);
    if (seconds === null || seconds <= 0) return null;
    const date = new Date((seconds + tz) * 1000);
    return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : null;
  };
  const notes = [];
  try {
    const amount = await httpJson(
      `https://platform.deepseek.com/api/v0/usage/by_api_key/amount?start=${start}&end=${end}&tz=${tz}`,
      { headers, fetchImpl }
    );
    const amountData = amount.json && amount.json.data && amount.json.data.biz_data;
    if (!Array.isArray(amountData?.series)) throw new Error('缺少用量序列');
    tokens30d = 0;
    requests30d = 0;
    for (const series of amountData.series) {
      for (const bucket of Array.isArray(series?.buckets) ? series.buckets : []) {
        const usage = bucket && bucket.usage;
        if (!usage) continue;
        const tokens =
          (num(usage.PROMPT_CACHE_HIT_TOKEN) ?? 0) +
          (num(usage.PROMPT_CACHE_MISS_TOKEN) ?? 0) +
          (num(usage.RESPONSE_TOKEN) ?? 0) +
          (num(usage.THINKING_TOKEN) ?? 0);
        const requests = num(usage.REQUEST) ?? 0;
        if (!Number.isSafeInteger(tokens) || tokens < 0 || !Number.isSafeInteger(requests) || requests < 0) continue;
        tokens30d += tokens;
        requests30d += requests;
        const date = dateOfBucket(bucket.time);
        if (date) {
          const day = ensureDay(date);
          day.tokens = (day.tokens ?? 0) + tokens;
          day.requests = (day.requests ?? 0) + requests;
        }
      }
    }
  } catch {
    notes.push('近 30 天 Token 用量暂时不可用');
  }
  try {
    const cost = await httpJson(
      `https://platform.deepseek.com/api/v0/usage/by_api_key/cost?start=${start}&end=${end}&tz=${tz}`,
      { headers, fetchImpl }
    );
    const costData = cost.json && cost.json.data && cost.json.data.biz_data;
    if (!Array.isArray(costData?.data)) throw new Error('缺少费用序列');
    const cny = costData.data.find((item) => item && item.currency === 'CNY');
    cost30d = 0;
    for (const series of Array.isArray(cny?.series) ? cny.series : []) {
      for (const bucket of Array.isArray(series?.buckets) ? series.buckets : []) {
        const amount = num(bucket?.cost);
        if (amount === null || amount < 0) continue;
        cost30d += amount;
        const date = dateOfBucket(bucket.time);
        if (date) {
          const day = ensureDay(date);
          day.costCny = (day.costCny ?? 0) + amount;
        }
      }
    }
  } catch {
    notes.push('近 30 天费用暂时不可用');
  }

  if (spentCny !== null) notes.unshift(`累计消费 ¥${spentCny.toFixed(2)}`);

  return {
    id: 'deepseek-platform',
    name: 'DeepSeek 平台',
    kind: 'deepseek-platform',
    status: 'ok',
    plan: null,
    fetchedAt: new Date().toISOString(),
    spentCny,
    cost30dCny: cost30d === null ? null : Math.round(cost30d * 100) / 100,
    tokens30d,
    requests30d,
    daily: [...dailyMap.values()]
      .filter((day) => day.tokens || day.costCny)
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((day) => (day.costCny === undefined ? day : { ...day, costCny: Math.round(day.costCny * 100) / 100 })),
    windows: [
      {
        key: 'balance',
        label: '余额',
        remaining: balance,
        unit: 'CNY',
        resetAt: null
      }
    ],
    notes
  };
}

export async function fetchOpencodeGoUsage({ key, id = 'opencode-go', name = 'OpenCode Go', fetchImpl = globalThis.fetch } = {}) {
  if (!key) {
    throw new UnconfiguredError('未配置 OpenCode Go Key（在面板「OpenCode Go 订阅」里填写）');
  }
  const { json } = await httpJson(OPENCODE_GO_USAGE_URL, {
    headers: { Authorization: `Bearer ${key}` },
    fetchImpl
  });
  const usage = json.usage || json;
  const labels = [
    ['rolling', '5 小时', '5h'],
    ['weekly', '每周', 'weekly'],
    ['monthly', '每月', 'monthly']
  ];
  const windows = [];
  const notes = [];
  const zeroLabels = [];
  for (const [field, label, key] of labels) {
    const raw = usage[field];
    if (!raw || typeof raw !== 'object') continue;
    const status = raw.status === 'rate-limited' ? 'rate-limited' : 'ok';
    let used = clampPercent(raw.percent);
    if (status === 'rate-limited') used = 100;
    if (used === null) continue;
    let resetAt = toIso(raw.resetsAt ?? raw.resets_at);
    if (used === 0) {
      resetAt = null;
      zeroLabels.push(label);
    }
    windows.push({ key, label, usedPercent: used, resetAt, status });
  }
  if (zeroLabels.length) {
    notes.push(`${zeroLabels.join(' / ')}窗口当前为 0%，上游返回的重置时间是占位值，已忽略`);
  }
  if (!windows.length) {
    throw new HttpError(200, 'Go 用量接口有返回，但未解析到 rolling/weekly/monthly 窗口');
  }
  return {
    id,
    name,
    kind: 'opencode-go',
    status: 'ok',
    plan: null,
    fetchedAt: new Date().toISOString(),
    windows,
    notes
  };
}

function balanceProvider(relay, { remaining, spend, limit, unit, plan, notes = [], unlimited = false }) {
  const usedPercent =
    limit && limit > 0 && spend !== null && spend !== undefined
      ? Math.max(0, Math.min(100, (spend / limit) * 100))
      : null;
  return {
    id: relay.id,
    name: relay.name,
    kind: 'relay',
    relayType: relay.type,
    status: 'ok',
    plan: plan || null,
    fetchedAt: new Date().toISOString(),
    windows: [
      {
        key: 'balance',
        label: '余额',
        remaining: remaining === undefined ? null : remaining,
        spend: spend === undefined ? null : spend,
        limit: limit === undefined ? null : limit,
        usedPercent,
        unit: unit || relay.unit || 'USD',
        resetAt: null,
        unlimited
      }
    ],
    notes
  };
}

export async function fetchNewApiAccount({ relay, token, quotaPerUsd, fetchImpl = globalThis.fetch, lookupImpl, allowPrivateRelay } = {}) {
  if (!token) throw new UnconfiguredError('缺少访问令牌');
  if (!relay.userId) throw new UnconfiguredError('缺少 New-Api-User（站点用户 ID）');
  const base = await providerBase(relay, { lookupImpl, allowPrivateRelay });
  const { json } = await httpJson(`${base}/api/user/self`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'New-Api-User': String(relay.userId),
      'Content-Type': 'application/json'
    },
    fetchImpl
  });
  if (json && json.success === false) {
    throw new HttpError(200, '站点拒绝查询，请检查凭据或读取权限');
  }
  const data = json.data || json;
  const quota = num(data.quota);
  const used = num(data.used_quota);
  if (quota === null) {
    throw new HttpError(200, '响应缺少 data.quota，可能不是 New API 账户接口，或令牌没有权限');
  }
  const divisor = num(relay.quotaPerUsd) || num(quotaPerUsd) || 500000;
  return balanceProvider(relay, {
    remaining: quota / divisor,
    spend: used === null ? null : used / divisor,
    limit: used === null ? null : (quota + used) / divisor,
    unit: relay.unit || 'USD',
    plan: typeof data.group === 'string' ? data.group : null
  });
}

export async function fetchNewApiToken({ relay, token, quotaPerUsd, fetchImpl = globalThis.fetch, lookupImpl, allowPrivateRelay } = {}) {
  if (!token) throw new UnconfiguredError('缺少 API Key');
  const base = await providerBase(relay, { lookupImpl, allowPrivateRelay });
  const { json } = await httpJson(`${base}/api/usage/token`, {
    headers: { Authorization: `Bearer ${token}` },
    fetchImpl
  });
  if (json && json.success === false) {
    throw new HttpError(200, '站点拒绝查询，请检查凭据或读取权限');
  }
  const data = json.data || json;
  const available = num(data.total_available);
  const granted = num(data.total_granted);
  const used = num(data.total_used);
  if (data.unlimited_quota === true || available === null) {
    return balanceProvider(relay, {
      remaining: null,
      spend: used === null ? null : used,
      limit: null,
      unit: relay.unit || 'USD',
      unlimited: data.unlimited_quota === true,
      notes: ['该令牌为无限额度（unlimited_quota），没有可用的剩余额度字段；换用账户余额接口或有限额度令牌']
    });
  }
  const divisor = num(relay.quotaPerUsd) || num(quotaPerUsd) || 500000;
  return balanceProvider(relay, {
    remaining: available / divisor,
    spend: used === null ? null : used / divisor,
    limit: granted === null ? null : granted / divisor,
    unit: relay.unit || 'USD'
  });
}

export async function fetchSub2Api({ relay, token, fetchImpl = globalThis.fetch, lookupImpl, allowPrivateRelay } = {}) {
  if (!token) throw new UnconfiguredError('缺少 API Key');
  const base = await providerBase(relay, { lookupImpl, allowPrivateRelay });
  const { json } = await httpJson(`${base}/v1/usage`, {
    headers: { Authorization: `Bearer ${token}` },
    fetchImpl
  });
  if (json && json.isValid === false) {
    throw new HttpError(200, '站点返回 isValid=false（Key 无效或已过期）');
  }
  const quota = json.quota && typeof json.quota === 'object' ? json.quota : {};
  let remaining = num(json.remaining);
  let limit = num(quota.limit);
  let used = num(quota.used);
  if (remaining === null && limit !== null && used !== null) remaining = limit - used;
  if (remaining === null) {
    throw new HttpError(200, '响应缺少 remaining/quota 字段，无法解析余额');
  }
  return balanceProvider(relay, {
    remaining,
    spend: used,
    limit,
    unit: json.unit || quota.unit || relay.unit || 'USD',
    plan: typeof json.planName === 'string' ? json.planName : null
  });
}

function getByPath(object, dotPath) {
  if (!dotPath) return null;
  return String(dotPath)
    .split('.')
    .reduce((current, part) => (current && typeof current === 'object' ? current[part] : null), object);
}

export async function fetchGenericRelay({ relay, token, fetchImpl = globalThis.fetch, lookupImpl, allowPrivateRelay } = {}) {
  const extract = relay.extract || {};
  if (!relay.url && !relay.baseUrl) throw new UnconfiguredError('缺少查询 URL');
  const rawUrl = relay.url || relay.baseUrl;
  await assertPublicHttpUrl(String(rawUrl), { lookupImpl, allowPrivateRelay });
  const headers = { ...(relay.headers || {}) };
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === 'string') headers[name] = value.replace(/\{\{\s*token\s*\}\}/gi, token || '');
  }
  if (token && !Object.keys(headers).some((name) => name.toLowerCase() === 'authorization')) {
    headers.Authorization = `Bearer ${token}`;
  }
  const { json } = await httpJson(rawUrl, { headers, fetchImpl });
  const divisor = num(relay.quotaPerUsd) || num(extract.divisor) || 1;
  const remainingRaw = num(getByPath(json, extract.remaining));
  const usedRaw = num(getByPath(json, extract.spend));
  const limitRaw = num(getByPath(json, extract.limit));
  if (remainingRaw === null && limitRaw === null) {
    throw new HttpError(200, '按配置的提取路径没有取到数值，请检查 extract 配置');
  }
  return balanceProvider(relay, {
    remaining: remainingRaw === null ? null : remainingRaw / divisor,
    spend: usedRaw === null ? null : usedRaw / divisor,
    limit: limitRaw === null ? null : limitRaw / divisor,
    unit: extract.unit || relay.unit || 'USD'
  });
}

export async function fetchRelay({ relay, token, quotaPerUsd, fetchImpl = globalThis.fetch, lookupImpl, allowPrivateRelay } = {}) {
  switch (relay.type) {
    case 'newapi-account':
      return fetchNewApiAccount({ relay, token, quotaPerUsd, fetchImpl, lookupImpl, allowPrivateRelay });
    case 'newapi-token':
      return fetchNewApiToken({ relay, token, quotaPerUsd, fetchImpl, lookupImpl, allowPrivateRelay });
    case 'sub2api':
      return fetchSub2Api({ relay, token, fetchImpl, lookupImpl, allowPrivateRelay });
    case 'generic':
      return fetchGenericRelay({ relay, token, fetchImpl, lookupImpl, allowPrivateRelay });
    default:
      throw new UnconfiguredError('未知的中转站类型');
  }
}

