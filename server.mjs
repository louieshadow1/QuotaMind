import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { promises as fs, readFileSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore, expandHome } from './lib/config.mjs';
import {
  HttpError,
  UnconfiguredError,
  RELAY_TYPES,
  fetchCodexUsage,
  fetchDeepSeekBalance,
  fetchDeepSeekPlatform,
  fetchOpencodeGoUsage,
  fetchRelay,
  resolveOpencodeGoKey
} from './lib/adapters.mjs';
import {
  archivedCodexAccounts,
  inspectCodexAuthFile,
  liveCodexAccount,
  readCodexAccountId,
  scanCodexAuthFiles
} from './lib/codex.mjs';
import {
  normalizeHistory,
  mergeSeriesIntoHistory,
  historyRange,
  buildSeriesFromHistory,
  parseImportData,
  IMPORT_CHANNELS
} from './lib/daily-history.mjs';
import { collectUsage, collectDailyUsage } from './lib/usage.mjs';

/** 读 data/config.json 里的 proxy 设置（不给就用 auto）。 */
function readProxySetting() {
  const dataDir = process.env.QUOTA_BOARD_DATA
    ? path.resolve(process.env.QUOTA_BOARD_DATA)
    : path.resolve('data');
  try {
    const config = JSON.parse(readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
    if (typeof config.proxy === 'string') return config.proxy;
  } catch {
    /* 首次启动还没有配置文件 */
  }
  return 'auto';
}

/** 环境变量优先，其次读 Windows 系统代理（HKCU Internet Settings）。 */
function detectSystemProxy() {
  const fromEnv =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    process.env.ALL_PROXY ||
    process.env.all_proxy;
  if (fromEnv) return fromEnv;
  if (process.platform !== 'win32') return null;
  try {
    const out = execFileSync(
      'reg',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', '/v', 'ProxyServer'],
      { encoding: 'utf8', timeout: 4000 }
    );
    const line = out.split(/\r?\n/).find((item) => /ProxyServer\s+REG_SZ/.test(item));
    if (!line) return null;
    const raw = line.split('REG_SZ')[1].trim();
    const fromRaw = raw.split(';')[0];
    const httpsPart = raw
      .split(';')
      .map((item) => item.trim())
      .find((item) => item.startsWith('https='));
    const value = httpsPart ? httpsPart.slice('https='.length) : fromRaw;
    if (!value) return null;
    return /^https?:\/\//i.test(value) ? value : `http://${value}`;
  } catch {
    return null;
  }
}

/**
 * Node 的 fetch 只有带 --use-env-proxy 启动才会读 HTTP(S)_PROXY，进程内再设置无效
 * （实测：chatgpt.com 直连被 DNS 投毒超时，走本机代理才通）。所以这里检测到代理时
 * 带参数重启自身，子进程接管端口，父进程退出。
 */
function ensureProxy() {
  // Node 的 fetch 只在启动时读 HTTP(S)_PROXY（--use-env-proxy 或 NODE_USE_ENV_PROXY=1）。
  // 进程内再设环境变量无效，而自重启子进程会被外层 Job 一起收掉，所以这里只做检查+提示，
  // 真正的启动参数交给 start.cmd / start.ps1。
  if (process.env.NODE_USE_ENV_PROXY === '1' || process.execArgv.includes('--use-env-proxy')) return;
  const setting = readProxySetting();
  if (setting === '') return;
  const proxy = setting && setting !== 'auto' ? setting : detectSystemProxy();
  if (!proxy) return;
  console.warn(
    '[quota-board] 检测到系统代理 ' +
      proxy +
      ' 但本次启动没带 --use-env-proxy：ChatGPT/Codex 等需要代理的接口会 fetch failed。' +
      ' 请用 start.cmd（或 node --use-env-proxy server.mjs）启动。'
  );
  process.env.HTTP_PROXY = process.env.HTTP_PROXY || proxy;
  process.env.HTTPS_PROXY = process.env.HTTPS_PROXY || proxy;
}

const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const MAX_BODY_BYTES = 64 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

const caches = new WeakMap();
const usageCaches = new WeakMap();
const dailyCaches = new WeakMap();

function codexAccountsForUsage(config) {
  return [...(liveCodexAccount(config) ? [liveCodexAccount(config)] : []), ...archivedCodexAccounts(config)].map(
    (account) => ({ name: account.name, authPath: account.authPath })
  );
}

async function getDeepseekPlatformData(store) {
  const token = process.env.DEEPSEEK_PLATFORM_TOKEN || (await store.getSecret('DEEPSEEK_PLATFORM_TOKEN'));
  if (!token) return null;
  try {
    return await fetchDeepSeekPlatform({ token });
  } catch {
    return null;
  }
}

function localDateOf(ms) {
  const date = new Date(ms);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * 每日用量：采集 → 并入长期存档（data/daily-history.json）→ 一律从存档重建序列。
 * 这样即使数据源只保留最近 30 天（DeepSeek 官方），更早的历史也不会消失。
 */
async function getDailyReport(store, force = false, days = 371) {
  const ttl = 120 * 1000;
  const MAX_COLLECT_DAYS = 3650;
  let cache = dailyCaches.get(store);
  if (!cache) {
    cache = { expiresAt: 0, history: null };
    dailyCaches.set(store, cache);
  }

  let history = cache.history;
  let codexMeta = cache.codexMeta || { accounts: 0, stale: [] };
  if (force || !history || Date.now() >= cache.expiresAt) {
    const config = await store.load();
    const platform = await getDeepseekPlatformData(store);
    const codexDailySnapshots = await readCodexDailySnapshots(store);
    const collected = await collectDailyUsage({
      codexAccounts: codexAccountsForUsage(config),
      days: MAX_COLLECT_DAYS,
      opencodeProviders: ((config.providers.opencodeGo && config.providers.opencodeGo.subscriptions) || [])
        .map((sub) => sub.provider)
        .filter(Boolean),
      deepseekDaily: platform && Array.isArray(platform.daily) ? platform.daily : null,
      codexDailySnapshots
    });
    if (collected.codexDailySnapshots) {
      await writeCodexDailySnapshots(store, collected.codexDailySnapshots);
    }
    history = await readDailyHistory(store);
    mergeSeriesIntoHistory(history, collected.series);
    await writeDailyHistory(store, history);
    codexMeta = {
      accounts: (collected.codexAccounts || []).length,
      stale: collected.codexStale || [],
      deepseekSource: collected.deepseekSource || 'local'
    };
    cache.history = history;
    cache.codexMeta = codexMeta;
    cache.expiresAt = Date.now() + ttl;
  }

  const series = buildSeriesFromHistory(history, days, localDateOf);
  const totals = series.reduce(
    (acc, entry) => {
      acc.codexTokens += entry.codexTokens;
      acc.deepseekTokens += entry.deepseekTokens;
      acc.deepseekCostCny += entry.deepseekCostCny;
      acc.opencodeTokens += entry.opencodeTokens;
      acc.opencodeCostCny += entry.opencodeCostCny;
      acc.opencodeOtherTokens += entry.opencodeOtherTokens;
      acc.opencodeOtherCostCny += entry.opencodeOtherCostCny;
      return acc;
    },
    {
      codexTokens: 0,
      deepseekTokens: 0,
      deepseekCostCny: 0,
      opencodeTokens: 0,
      opencodeCostCny: 0,
      opencodeOtherTokens: 0,
      opencodeOtherCostCny: 0
    }
  );

  return {
    days: series.length,
    series,
    totals,
    deepseekSource: codexMeta.deepseekSource || 'local',
    history: historyRange(history),
    codexAccounts: codexMeta.accounts,
    codexStale: codexMeta.stale,
    cached: false
  };
}
async function mergeCodexLifetime(store, config, data) {
  const codex = (data.channels || []).find((channel) => channel.id === 'codex');
  if (!codex) return data;
  const file = path.join(store.dataDir, 'codex-lifetime.json');
  let cache = {};
  try {
    cache = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    cache = {};
  }
  let dirty = false;
  const accounts = codexAccountsForUsage(config);
  codex.accounts = Array.isArray(codex.accounts) ? codex.accounts : [];
  for (const account of accounts) {
    const accountId = await readCodexAccountId(account.authPath);
    if (!accountId) continue;
    const fetched = codex.accounts.find((entry) => entry.id === accountId);
    if (fetched) {
      cache[accountId] = {
        name: fetched.name,
        displayName: fetched.displayName,
        lifetime: fetched.lifetimeTokens,
        peak: fetched.peakDailyTokens,
        updatedAt: new Date().toISOString()
      };
      dirty = true;
    } else if (cache[accountId]) {
      codex.accounts.push({
        id: accountId,
        name: account.name,
        displayName: cache[accountId].displayName,
        lifetimeTokens: cache[accountId].lifetime,
        peakDailyTokens: cache[accountId].peak,
        cached: true,
        fetchedAt: cache[accountId].updatedAt
      });
    }
  }
  // 合计 = 所有账号累计之和（含只能取到历史快照的账号）；快照只做标注，不剔除
  const liveAccounts = codex.accounts.filter((entry) => !entry.cached);
  const staleAccounts = codex.accounts.filter((entry) => entry.cached);
  codex.tokens.total = codex.accounts.reduce((sum, entry) => sum + Number(entry.lifetimeTokens || 0), 0);
  codex.liveAccounts = liveAccounts.length;
  codex.staleAccounts = staleAccounts.length;
  codex.staleTokens = staleAccounts.reduce((sum, entry) => sum + Number(entry.lifetimeTokens || 0), 0);
  if (staleAccounts.length) {
    codex.note =
      '官方账户累计；其中 ' +
      staleAccounts.length +
      ' 个账号取的是最后一次成功同步的快照（' +
      (codex.staleTokens / 1e8).toFixed(2) +
      ' 亿 token）';
  }
  data.totalTokens = data.channels.reduce((sum, channel) => sum + Number(channel.tokens.total || 0), 0);
  if (dirty) await fs.writeFile(file, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
  return data;
}

async function getUsageReport(store, force = false) {
  const ttl = 120 * 1000;
  let cache = usageCaches.get(store);
  if (!cache) {
    cache = { expiresAt: 0, data: null };
    usageCaches.set(store, cache);
  }
  if (!force && cache.data && Date.now() < cache.expiresAt) {
    return { ...cache.data, cached: true };
  }
  const config = await store.load();
  const codexAccounts = codexAccountsForUsage(config);
  const deepseekOfficial = await getDeepseekPlatformData(store);
  const data = await collectUsage({
    codexAccounts,
    deepseekOfficial,
    opencodeSubscriptions: (config.providers.opencodeGo && config.providers.opencodeGo.subscriptions) || []
  });
  await mergeCodexLifetime(store, config, data);
  cache.data = data;
  cache.expiresAt = Date.now() + ttl;
  return data;
}

function cacheFor(store) {
  let cache = caches.get(store);
  if (!cache) {
    cache = { snapshot: null, lastGood: new Map() };
    caches.set(store, cache);
  }
  return cache;
}

function invalidateDailyCache(store) {
  const cache = dailyCaches.get(store);
  if (cache) {
    cache.expiresAt = 0;
    cache.history = null;
  }
}

export function invalidateSnapshot(store) {
  const cache = store ? caches.get(store) : null;
  if (cache) cache.snapshot = null;
}

/** 订阅/令牌变更后，额度、Token 统计、每日统计三处缓存一起失效。 */
function invalidateAllCaches(store) {
  invalidateSnapshot(store);
  const usage = usageCaches.get(store);
  if (usage) {
    usage.expiresAt = 0;
    usage.data = null;
  }
  const daily = dailyCaches.get(store);
  if (daily) {
    daily.expiresAt = 0;
    daily.data = null;
  }
}

/** 历史快照：按 Codex account_id 保存最后一次成功查询的额度，切换/令牌失效后仍可展示。 */
async function readCodexHistory(store) {
  try {
    const raw = await fs.readFile(path.join(store.dataDir, 'codex-history.json'), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed.accounts || typeof parsed.accounts !== 'object') parsed.accounts = {};
    return parsed;
  } catch {
    return { accounts: {} };
  }
}

async function writeCodexHistory(store, history) {
  await fs.mkdir(store.dataDir, { recursive: true });
  await fs.writeFile(
    path.join(store.dataDir, 'codex-history.json'),
    `${JSON.stringify(history, null, 2)}\n`,
    'utf8'
  );
}

/** Codex 每个账号的最后一次成功按天数据：失效账号用它回填热力图，保证「所有账号相加」。 */
async function readCodexDailySnapshots(store) {
  try {
    const raw = await fs.readFile(path.join(store.dataDir, 'codex-daily.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed.accounts === 'object' && parsed.accounts ? parsed.accounts : {};
  } catch {
    return {};
  }
}

async function writeCodexDailySnapshots(store, accounts) {
  try {
    await fs.mkdir(store.dataDir, { recursive: true });
    await fs.writeFile(
      path.join(store.dataDir, 'codex-daily.json'),
      `${JSON.stringify({ updatedAt: new Date().toISOString(), accounts }, null, 2)}\n`,
      'utf8'
    );
  } catch {
    /* 写快照失败不影响本次返回 */
  }
}

/** 每日用量的长期存档：data/daily-history.json（只增不减）。 */
async function readDailyHistory(store) {
  try {
    const raw = await fs.readFile(path.join(store.dataDir, 'daily-history.json'), 'utf8');
    return normalizeHistory(JSON.parse(raw));
  } catch (err) {
    if (err.code === 'ENOENT') return normalizeHistory(null);
    throw err;
  }
}

async function writeDailyHistory(store, history) {
  await fs.mkdir(store.dataDir, { recursive: true });
  const target = path.join(store.dataDir, 'daily-history.json');
  const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, `${JSON.stringify(history, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await fs.rename(tmp, target);
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
}

function historySnapshot(provider, name) {
  return {
    name,
    plan: provider.plan || null,
    credits: provider.credits || null,
    windows: provider.windows || [],
    fetchedAt: provider.fetchedAt,
    lastSeenAt: new Date().toISOString()
  };
}

function historyProvider(key, entry, { historyOnly = false } = {}) {
  return {
    id: `codex-hist:${key}`,
    name: entry.name || '历史账户',
    kind: 'codex',
    status: 'stale',
    plan: entry.plan || null,
    credits: entry.credits || null,
    windows: entry.windows || [],
    fetchedAt: entry.fetchedAt || null,
    stale: true,
    historyOnly,
    historyKey: key,
    error: historyOnly
      ? '历史快照：该账号当前不在登录/归档列表，无法实时刷新'
      : '登录态已失效或被覆盖，显示最后成功快照',
    notes: Array.isArray(entry.notes) ? entry.notes : []
  };
}

async function configForClient(store) {
  const [sanitized, config] = await Promise.all([store.sanitize(), store.load()]);
  const enabled = config.providers.codex.enabled !== false;
  const live = enabled ? liveCodexAccount(config) : null;
  const archived = archivedCodexAccounts(config);
  const liveAccountId = live ? await readCodexAccountId(live.authPath) : null;
  const entries = [];
  if (live) {
    entries.push({ ...live, accountId: liveAccountId || null, ...(await inspectCodexAuthFile(live.authPath)) });
  }
  for (const account of archived) {
    const archivedId = await readCodexAccountId(account.authPath);
    if (live && liveAccountId && archivedId && archivedId === liveAccountId) continue;
    entries.push({
      ...account,
      accountId: archivedId || null,
      ...(await inspectCodexAuthFile(account.authPath))
    });
  }
  sanitized.providers.codex.accounts = entries;
  return sanitized;
}

function sameAuthPath(a, b) {
  try {
    return path.resolve(expandHome(a)).toLowerCase() === path.resolve(expandHome(b)).toLowerCase();
  } catch {
    return false;
  }
}

/** 把当前登录态复制到 data/codex-accounts/，并按 account_id 自动登记为归档账户。 */
async function archiveLiveAuth(store, config, live) {
  const codexConfig = config.providers.codex;
  if (codexConfig.autoArchive === false) return;
  const source = expandHome(live.authPath);
  let raw;
  try {
    raw = await fs.readFile(source, 'utf8');
  } catch {
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  const token = parsed && parsed.tokens && parsed.tokens.access_token;
  const accountId = parsed && parsed.tokens && parsed.tokens.account_id;
  if (!token || !accountId) return;

  const safe = String(accountId).replace(/[^a-zA-Z0-9-]/g, '').slice(0, 40) || 'account';
  const dir = path.join(store.dataDir, 'codex-accounts');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${safe}.json`);
  await fs.writeFile(file, raw, { encoding: 'utf8', mode: 0o600 });

  const archived = archivedCodexAccounts(config);
  if (archived.some((account) => sameAuthPath(account.authPath, file))) return;
  codexConfig.accounts = [
    ...archived,
    {
      id: `codex-arch-${safe.slice(0, 10)}`,
      name: `账号 ${safe.slice(0, 8)}`,
      authPath: file
    }
  ];
  await store.saveConfig(config);
}


function jsonResponse(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(body);
}

/**
 * 只接受本机 Host 头：防止 DNS rebinding —— 恶意网页把自己的域名解析到 127.0.0.1 后，
 * 浏览器会以「同源」身份读写本机面板（Host 会是 evil.com）。本地服务没有理由接受陌生 Host。
 */
function hostAllowed(hostHeader, port) {
  if (!hostHeader) return true; // HTTP/1.0 等不带 Host 的情况放行（只监听 127.0.0.1）
  const host = String(hostHeader).toLowerCase();
  const allowed = new Set([
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    `[::1]:${port}`,
    '127.0.0.1',
    'localhost',
    '[::1]'
  ]);
  return allowed.has(host);
}

function readBody(req, { maxBytes = MAX_BODY_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    req.on('data', (chunk) => {
      if (tooLarge) return; // 继续把连接读干净，但不占内存
      size += chunk.length;
      if (size > maxBytes) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      // 超限也等请求读完再报 413，客户端才能收到明确的响应（而不是连接被重置）
      if (tooLarge) return reject(new HttpError(413, '请求体过大'));
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return reject(new HttpError(400, '请求体必须是 JSON 对象'));
        }
        resolve(parsed);
      } catch {
        reject(new HttpError(400, '请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function stringField(value, max = 200) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function normalizeRelayInput(input, config) {
  const name = stringField(input.name, 60);
  const type = stringField(input.type, 30);
  const baseUrl = stringField(input.baseUrl || input.url, 500);
  if (!name) throw new HttpError(400, '请填写站点名称');
  if (!RELAY_TYPES.includes(type)) throw new HttpError(400, `类型必须是：${RELAY_TYPES.join(' / ')}`);
  if (!/^https?:\/\//i.test(baseUrl)) throw new HttpError(400, '站点地址必须以 http:// 或 https:// 开头');
  const userId = stringField(input.userId, 40) || null;
  if (type === 'newapi-account' && !userId) throw new HttpError(400, 'New API 账户余额需要填写用户 ID（New-Api-User）');
  const quotaPerUsd = Number(input.quotaPerUsd);
  const unit = ['USD', 'CNY', 'CREDITS'].includes(input.unit) ? input.unit : 'USD';
  return {
    id: `relay-${Math.random().toString(16).slice(2, 10)}`,
    name,
    type,
    baseUrl,
    userId,
    unit,
    quotaPerUsd: Number.isFinite(quotaPerUsd) && quotaPerUsd > 0 ? quotaPerUsd : config.quotaPerUsd || 500000,
    ...(type === 'generic'
      ? {
          url: baseUrl,
          extract: { remaining: 'remaining', limit: 'total', spend: 'used', unit: 'USD' }
        }
      : {}),
    tokenRef: ''
  };
}

async function describeJob(cache, { key, meta, run }) {
  try {
    const provider = await run();
    cache.lastGood.set(key, provider);
    return provider;
  } catch (err) {
    const isUnconfigured = err instanceof UnconfiguredError;
    const stale = cache.lastGood.get(key) || null;
    const error = err && err.message ? err.message : String(err);
    const keepStale = !isUnconfigured && stale;
    return {
      ...(keepStale ? stale : meta),
      windows: keepStale && stale.windows ? stale.windows : [],
      status: isUnconfigured ? 'unconfigured' : 'error',
      error,
      stale: Boolean(keepStale),
      checkedAt: new Date().toISOString()
    };
  }
}

export async function buildSnapshot(store, { force = false } = {}) {
  const cache = cacheFor(store);
  const config = await store.load();
  const ttlSeconds = Math.max(10, Number(config.refreshSeconds) || 60);
  const now = Date.now();
  if (!force && cache.snapshot && now < cache.snapshot.expiresAt) {
    return { ...cache.snapshot.data, cached: true };
  }

  const jobs = [];
  const codexHistory = config.providers.codex.enabled !== false ? await readCodexHistory(store) : { accounts: {} };
  let codexHistoryDirty = false;
  const codexJobKeys = new Set();

  if (config.providers.codex.enabled !== false) {
    const live = liveCodexAccount(config);
    const liveAccountId = live ? await readCodexAccountId(live.authPath) : null;
    const archived = archivedCodexAccounts(config);
    const archivedInfo = await Promise.all(
      archived.map(async (account) => ({ ...account, accountId: await readCodexAccountId(account.authPath) }))
    );

    if (live) {
      const label = `Codex · ${live.name}`;
      const liveKey = liveAccountId ? `id:${liveAccountId}` : 'live';
      codexJobKeys.add(liveKey);
      jobs.push({
        key: 'codex:live',
        meta: { id: 'codex:live', name: label, kind: 'codex', windows: [], historyKey: liveKey },
        run: async () => {
          const provider = await fetchCodexUsage({ name: label, authPath: live.authPath });
          const accountId = await readCodexAccountId(live.authPath);
          const key = accountId ? `id:${accountId}` : liveKey;
          codexHistory.accounts[key] = historySnapshot(
            provider,
            accountId ? `账号 ${String(accountId).slice(0, 8)}` : '当前登录'
          );
          codexHistoryDirty = true;
          await archiveLiveAuth(store, config, live);
          return provider;
        }
      });
    }

    for (const account of archivedInfo) {
      if (live && liveAccountId && account.accountId === liveAccountId) continue;
      const label = `Codex · ${account.name}`;
      const key = account.accountId ? `id:${account.accountId}` : `cfg:${account.id}`;
      codexJobKeys.add(key);
      jobs.push({
        key: `codex:${account.id}`,
        meta: { id: `codex:${account.id}`, name: label, kind: 'codex', windows: [], historyKey: key },
        run: async () => {
          const provider = await fetchCodexUsage({ name: label, authPath: account.authPath });
          codexHistory.accounts[key] = historySnapshot(provider, account.name);
          codexHistoryDirty = true;
          return provider;
        }
      });
    }
  } else {
    jobs.push({
      key: 'codex',
      meta: { id: 'codex', name: 'Codex 账户', kind: 'codex', windows: [] },
      run: async () => {
        throw new UnconfiguredError('已在配置中关闭 Codex');
      }
    });
  }

  const goSubscriptions = Array.isArray(config.providers.opencodeGo.subscriptions)
    ? config.providers.opencodeGo.subscriptions
    : [];
  const effectiveGoSubscriptions = goSubscriptions.length
    ? goSubscriptions
    : [{ id: 'default', name: 'OpenCode Go', provider: 'opencode-go', keyRef: null }];

  if (config.providers.opencodeGo.enabled !== false) {
    for (const sub of effectiveGoSubscriptions) {
      const label = sub.name || 'OpenCode Go';
      jobs.push({
        key: `opencode-go:${sub.id}`,
        meta: { id: `opencode-go:${sub.id}`, name: label, kind: 'opencode-go', windows: [], subscription: sub.id },
        run: async () => {
          let key = sub.keyRef ? await store.getSecret(sub.keyRef) : null;
          if (!key && !sub.keyRef) {
            const resolved = await resolveOpencodeGoKey({ store });
            key = resolved ? resolved.key : null;
          }
          if (!key) throw new UnconfiguredError(`「${label}」还没填 Key（在「OpenCode Go 订阅」里填写）`);
          const card = await fetchOpencodeGoUsage({ key, id: `opencode-go:${sub.id}`, name: label });
          return { ...card, subscription: sub.id, provider: sub.provider };
        }
      });
    }
  } else {
    jobs.push({
      key: 'opencode-go',
      meta: { id: 'opencode-go', name: 'OpenCode Go', kind: 'opencode-go', windows: [] },
      run: async () => {
        throw new UnconfiguredError('已在配置中关闭 OpenCode Go');
      }
    });
  }

  if (config.providers.deepseek && config.providers.deepseek.enabled === true) {
    jobs.push({
      key: 'deepseek',
      meta: { id: 'deepseek', name: 'DeepSeek 账户', kind: 'deepseek', windows: [] },
      run: async () => {
        const key = process.env.DEEPSEEK_API_KEY || (await store.getSecret('DEEPSEEK_API_KEY'));
        if (!key) throw new UnconfiguredError('未配置 DeepSeek API Key（在页面「DeepSeek Key」里填写）');
        return fetchDeepSeekBalance({ key });
      }
    });
  }

  if ((config.providers.deepseekPlatform || {}).enabled !== false) {
    jobs.push({
      key: 'deepseek-platform',
      meta: { id: 'deepseek-platform', name: 'DeepSeek 平台', kind: 'deepseek-platform', windows: [] },
      run: async () => {
        const token =
          process.env.DEEPSEEK_PLATFORM_TOKEN || (await store.getSecret('DEEPSEEK_PLATFORM_TOKEN'));
        if (!token) throw new UnconfiguredError('未配置 DeepSeek 平台登录态（userToken）');
        return fetchDeepSeekPlatform({ token });
      }
    });
  }

  for (const relay of config.providers.relays) {
    jobs.push({
      key: relay.id,
      meta: { id: relay.id, name: relay.name, kind: 'relay', relayType: relay.type, windows: [] },
      run: async () => {
        const token = await store.getSecret(relay.tokenRef);
        if (!token) throw new UnconfiguredError('缺少令牌：点击卡片上的“设置令牌”或重新添加站点');
        return fetchRelay({ relay, token, quotaPerUsd: config.quotaPerUsd });
      }
    });
  }

  const providers = await Promise.all(jobs.map((job) => describeJob(cache, job)));
  if (codexHistoryDirty) {
    await writeCodexHistory(store, codexHistory);
  }
  for (let index = 0; index < providers.length; index += 1) {
    const key = jobs[index] && jobs[index].meta ? jobs[index].meta.historyKey : null;
    if (!key || providers[index].status === 'ok') continue;
    const entry = codexHistory.accounts[key];
    if (entry) {
      const replaced = historyProvider(key, entry);
      const liveError = providers[index] && providers[index].error;
      if (liveError) replaced.error = '实时查询失败：' + liveError + '（显示最后一次成功快照）';
      providers[index] = replaced;
    }
  }
  for (const [key, entry] of Object.entries(codexHistory.accounts)) {
    if (codexJobKeys.has(key)) continue;
    providers.push(historyProvider(key, entry, { historyOnly: true }));
  }
  const data = {
    generatedAt: new Date().toISOString(),
    refreshSeconds: ttlSeconds,
    providers,
    cached: false
  };
  cache.snapshot = { expiresAt: now + ttlSeconds * 1000, data };
  return data;
}

async function serveStatic(req, res, urlPath) {
  const relative = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath).replace(/^\/+/, '');
  const resolved = path.resolve(PUBLIC_DIR, relative);
  if (!resolved.startsWith(`${PUBLIC_DIR}${path.sep}`) && resolved !== path.join(PUBLIC_DIR, 'index.html')) {
    return jsonResponse(res, 403, { error: '禁止访问' });
  }
  let stat;
  try {
    stat = await fs.stat(resolved);
  } catch {
    return jsonResponse(res, 404, { error: '文件不存在' });
  }
  if (!stat.isFile()) return jsonResponse(res, 404, { error: '文件不存在' });
  const ext = path.extname(resolved).toLowerCase();
  const content = await fs.readFile(resolved);
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': ext === '.html' || ext === '.js' || ext === '.css' ? 'no-store' : 'public, max-age=300',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy':
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'"
  });
  res.end(content);
}

export async function createApp({ dataDir, env = process.env } = {}) {
  const store = createStore(dataDir);
  await store.init();
  const initialConfig = await store.load();
  const port = Number(env.PORT || initialConfig.port || 8799);

  // 将会修改本机文件的 API 与后台归档串行化，确保每次读取的是上一次已写入的结果。
  let previousOperation = Promise.resolve();
  async function acquireOperation() {
    const previous = previousOperation;
    let release;
    previousOperation = new Promise((resolve) => { release = resolve; });
    await previous;
    return release;
  }


  // 后台自动快照：即使没人打开页面，也定期把当天用量并入长期存档。
  // 定时器 unref，不阻止进程退出；间隔默认 30 分钟，可通过 config 调整。
  let archiverTimer = null;
  const startDailyArchiver = () => {
    if (env.QUOTA_BOARD_DISABLE_ARCHIVER === '1') return;
    const runOnce = async () => {
      const release = await acquireOperation();
      try {
        await getDailyReport(store, true, 3650);
      } catch (err) {
        console.error('[quota-board] 后台归档失败:', err.message);
      } finally {
        release();
      }
    };
    // 启动 15 秒后跑一次（等配置/网络就绪），之后按间隔跑
    const kick = setTimeout(() => {
      runOnce();
      const minutes = Math.max(5, Number((initialConfig.dailyArchiveMinutes || 30)));
      archiverTimer = setInterval(runOnce, minutes * 60 * 1000);
      if (archiverTimer.unref) archiverTimer.unref();
    }, 15000);
    if (kick.unref) kick.unref();
  };
  const server = http.createServer(async (req, res) => {
    const boundPort = (server.address() && server.address().port) || port;
    if (!hostAllowed(req.headers.host, boundPort)) {
      return jsonResponse(res, 403, { error: '非法的 Host 头（只允许 127.0.0.1 / localhost）' });
    }

    let url;
    try {
      url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    } catch {
      return jsonResponse(res, 400, { error: '请求地址无效' });
    }
    const { pathname } = url;
    const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    if (pathname.startsWith('/api/') && mutating) {
      const origin = req.headers.origin;
      if (origin) {
        try {
          const parsed = new URL(origin);
          if (parsed.protocol !== 'http:' || parsed.host !== req.headers.host || parsed.origin !== origin) throw new Error('origin');
        } catch {
          return jsonResponse(res, 403, { error: '不允许跨来源请求' });
        }
      }
      if (req.headers['sec-fetch-site'] === 'cross-site') return jsonResponse(res, 403, { error: '不允许跨站请求' });
      if (['POST', 'PUT', 'PATCH'].includes(req.method) && !/^application\/json(?:\s*;|\s*$)/i.test(req.headers['content-type'] || '')) {
        return jsonResponse(res, 415, { error: '请使用 application/json' });
      }
    }
    const needsLock = pathname.startsWith('/api/') && !['/api/health', '/api/version'].includes(pathname);
    const release = needsLock ? await acquireOperation() : null;
    try {
    try {
      if (pathname === '/api/version' && req.method === 'GET') {
        // 前端用它检测「页面里的代码是不是旧版本」，变了就自动 reload，免得改了样式/逻辑却看不到
        const stamp = async (name) => {
          try {
            return (await fs.stat(path.join(PUBLIC_DIR, name))).mtimeMs;
          } catch {
            return 0;
          }
        };
        return jsonResponse(res, 200, {
          html: await stamp('index.html'),
          js: await stamp('app.js'),
          css: await stamp('style.css')
        });
      }

      if (pathname === '/api/health') {
        return jsonResponse(res, 200, { ok: true, service: 'quota-board', now: new Date().toISOString() });
      }

      if (pathname === '/api/config' && req.method === 'GET') {
        return jsonResponse(res, 200, await configForClient(store));
      }

      if (pathname === '/api/codex/scan' && req.method === 'GET') {
        const current = await store.load();
        const known = [liveCodexAccount(current), ...archivedCodexAccounts(current)].filter(Boolean);
        const extraDirs = String(process.env.QUOTA_BOARD_CODEX_DIRS || '')
          .split(';')
          .map((value) => value.trim())
          .filter(Boolean)
          .map((value) => expandHome(value));
        const candidates = (await scanCodexAuthFiles({ extraDirs })).filter(
          (candidate) => !known.some((account) => sameAuthPath(account.authPath, candidate.fullPath))
        );
        return jsonResponse(res, 200, {
          candidates: candidates.map(({ fullPath, ...rest }) => rest)
        });
      }

      if (pathname === '/api/codex/accounts' && req.method === 'POST') {
        const current = await store.load();
        const body = await readBody(req);
        const name = stringField(body.name, 40) || 'Codex 账户';
        const authPath = stringField(body.authPath, 500);
        const authJsonRaw = typeof body.authJson === 'string' ? body.authJson.trim() : '';
        if (!authPath && !authJsonRaw) throw new HttpError(400, '请填写 auth.json 路径，或粘贴 auth.json 内容');

        const accounts = archivedCodexAccounts(current);
        const live = liveCodexAccount(current);
        const knownPaths = [...(live ? [live] : []), ...accounts];
        const existingIds = new Set();
        for (const account of knownPaths) {
          const id = await readCodexAccountId(account.authPath);
          if (id) existingIds.add(id);
        }

        const id = `codex-${Math.random().toString(16).slice(2, 10)}`;
        let storedPath = authPath;

        if (authJsonRaw) {
          let parsed;
          try {
            parsed = JSON.parse(authJsonRaw);
          } catch {
            throw new HttpError(400, '粘贴的内容不是合法 JSON');
          }
          const token = parsed && parsed.tokens && parsed.tokens.access_token;
          if (!token) throw new HttpError(400, '内容里没有 tokens.access_token，不是有效的 Codex 登录态');
          const newAccountId = parsed.tokens.account_id;
          if (newAccountId && existingIds.has(String(newAccountId))) {
            throw new HttpError(409, '这个账号已经添加过了（account_id 相同）');
          }
          const dir = path.join(store.dataDir, 'codex-accounts');
          await fs.mkdir(dir, { recursive: true });
          storedPath = path.join(dir, `${id}.json`);
          await fs.writeFile(storedPath, `${JSON.stringify(parsed, null, 2)}\n`, {
            encoding: 'utf8',
            mode: 0o600
          });
        } else {
          const info = await inspectCodexAuthFile(authPath);
          if (!info.exists) throw new HttpError(400, `找不到该文件：${authPath}`);
          if (!info.valid) throw new HttpError(400, '该文件不是有效的 Codex 登录态（缺少 tokens.access_token）');
          if (knownPaths.some((account) => sameAuthPath(account.authPath, authPath))) {
            throw new HttpError(409, '这个账户已经添加过了');
          }
          const existingId = await readCodexAccountId(authPath);
          if (existingId && existingIds.has(existingId)) {
            throw new HttpError(409, '这个账号已经添加过了（account_id 相同）');
          }
        }

        const account = { id, name, authPath: storedPath };
        current.providers.codex.accounts = [...accounts, account];
        await store.saveConfig(current);
        invalidateSnapshot(store);
        return jsonResponse(res, 201, { ok: true, id: account.id });
      }

      if (pathname === '/api/codex/live' && req.method === 'PUT') {
        const current = await store.load();
        const body = await readBody(req);
        const name = stringField(body.name, 40) || '当前登录';
        current.providers.codex.liveName = name;
        await store.saveConfig(current);
        invalidateSnapshot(store);
        return jsonResponse(res, 200, { ok: true });
      }

      if (
        pathname.startsWith('/api/codex/accounts/') &&
        req.method === 'PUT' &&
        !pathname.endsWith('/token')
      ) {
        const id = decodeURIComponent(pathname.slice('/api/codex/accounts/'.length));
        const current = await store.load();
        const accounts = archivedCodexAccounts(current);
        const target = accounts.find((account) => account.id === id);
        if (!target) return jsonResponse(res, 404, { error: '没有这个 Codex 归档账户' });
        const body = await readBody(req);
        const name = stringField(body.name, 40);
        if (!name) throw new HttpError(400, '请填写账户名称');
        current.providers.codex.accounts = accounts.map((account) =>
          account.id === id ? { ...account, name } : account
        );
        await store.saveConfig(current);
        invalidateSnapshot(store);
        return jsonResponse(res, 200, { ok: true });
      }

      if (pathname.startsWith('/api/codex/accounts/') && req.method === 'DELETE') {
        const id = decodeURIComponent(pathname.slice('/api/codex/accounts/'.length));
        const current = await store.load();
        const accounts = archivedCodexAccounts(current);
        const remaining = accounts.filter((account) => account.id !== id);
        if (remaining.length === accounts.length) {
          return jsonResponse(res, 404, { error: '没有这个 Codex 归档账户（当前登录账户不能删除）' });
        }
        current.providers.codex.accounts = remaining;
        await store.saveConfig(current);
        invalidateSnapshot(store);
        return jsonResponse(res, 200, { ok: true });
      }

      if (pathname === '/api/quota' && req.method === 'GET') {
        const force = url.searchParams.get('refresh') === '1';
        return jsonResponse(res, 200, await buildSnapshot(store, { force }));
      }

      if (pathname === '/api/usage' && req.method === 'GET') {
        const force = url.searchParams.get('refresh') === '1';
        return jsonResponse(res, 200, await getUsageReport(store, force));
      }

      if (pathname === '/api/daily' && req.method === 'GET') {
        const force = url.searchParams.get('refresh') === '1';
        // days=0 表示「全部历史」；上限 3650 天（10 年），足够长期使用
        const requested = Number(url.searchParams.get('days'));
        const days = requested === 0 ? 3650 : Math.min(3650, Math.max(7, requested || 371));
        return jsonResponse(res, 200, await getDailyReport(store, force, days));
      }

      if (pathname === '/api/settings' && req.method === 'POST') {
        // 改标题 / 副标题 / 标记引导完成；只接受短文本，防止塞入奇怪内容
        const body = await readBody(req);
        const config = await store.load();
        const settings = { ...(config.settings || {}) };
        const clean = (value, max) => String(value || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
        if (body.title !== undefined) settings.title = clean(body.title, 40) || '额度一念';
        if (body.subtitle !== undefined) settings.subtitle = clean(body.subtitle, 80);
        if (body.onboardingDone !== undefined) settings.onboardingDone = Boolean(body.onboardingDone);
        config.settings = settings;
        await store.saveConfig(config);
        return jsonResponse(res, 200, { ok: true, settings });
      }

      if (pathname === '/api/daily/import' && req.method === 'POST') {
        // 手工导入历史用量：CSV/JSON → 并入 daily-history.json（取较大值，不覆盖更大的历史）
        const body = await readBody(req, { maxBytes: 2 * 1024 * 1024 });
        const channel = String(body.channel || '');
        if (!IMPORT_CHANNELS[channel]) {
          throw new HttpError(400, '请选择渠道：' + Object.keys(IMPORT_CHANNELS).join(' / '));
        }
        const { rows, errors } = parseImportData(channel, body.data);
        if (!rows.length) {
          throw new HttpError(400, errors[0] || '没有可导入的数据行');
        }
        const history = await readDailyHistory(store);
        // 导入前备份，误导入可恢复
        try {
          await fs.writeFile(
            path.join(store.dataDir, 'daily-history.json.bak'),
            `${JSON.stringify(history, null, 2)}\n`,
            'utf8'
          );
        } catch {
          /* 备份失败不阻断导入 */
        }
        const summary = mergeSeriesIntoHistory(history, rows);
        await writeDailyHistory(store, history);
        invalidateDailyCache(store);
        const range = historyRange(history);
        return jsonResponse(res, 200, {
          ok: true,
          channel,
          importedRows: rows.length,
          addedDays: summary.addedDays,
          updatedDays: summary.updatedDays,
          skippedRows: summary.skipped,
          errors: errors.slice(0, 20),
          history: range
        });
      }

      if (pathname.startsWith('/api/codex/history/') && req.method === 'DELETE') {
        const key = decodeURIComponent(pathname.slice('/api/codex/history/'.length));
        const history = await readCodexHistory(store);
        if (!history.accounts[key]) return jsonResponse(res, 404, { error: '没有这条历史快照' });
        delete history.accounts[key];
        await writeCodexHistory(store, history);
        invalidateSnapshot(store);
        return jsonResponse(res, 200, { ok: true });
      }

      if (pathname === '/api/relays' && req.method === 'POST') {
        const current = await store.load();
        const body = await readBody(req);
        const relay = normalizeRelayInput(body, current);
        const token = stringField(body.token, 500);
        if (!token && relay.type !== 'generic') throw new HttpError(400, '请填写令牌');
        relay.tokenRef = `RELAY_${relay.id.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}_TOKEN`;
        if (token) await store.setSecret(relay.tokenRef, token);
        current.providers.relays.push(relay);
        await store.saveConfig(current);
        invalidateSnapshot(store);
        return jsonResponse(res, 201, { ok: true, id: relay.id });
      }

      if (pathname.startsWith('/api/relays/') && req.method === 'PUT' && pathname.endsWith('/token')) {
        const id = decodeURIComponent(pathname.slice('/api/relays/'.length, -'/token'.length));
        const current = await store.load();
        const relay = current.providers.relays.find((item) => item.id === id);
        if (!relay) return jsonResponse(res, 404, { error: '没有这个站点' });
        const body = await readBody(req);
        const token = stringField(body.token, 500);
        if (!token) throw new HttpError(400, '请填写令牌');
        await store.setSecret(relay.tokenRef, token);
        invalidateSnapshot(store);
        return jsonResponse(res, 200, { ok: true });
      }

      if (pathname.startsWith('/api/relays/') && req.method === 'DELETE') {
        const id = decodeURIComponent(pathname.slice('/api/relays/'.length));
        const current = await store.load();
        const index = current.providers.relays.findIndex((relay) => relay.id === id);
        if (index === -1) return jsonResponse(res, 404, { error: '没有这个站点' });
        const [removed] = current.providers.relays.splice(index, 1);
        await store.setSecret(removed.tokenRef, null);
        await store.saveConfig(current);
        invalidateSnapshot(store);
        return jsonResponse(res, 200, { ok: true });
      }

      if (pathname === '/api/opencode-go-key' && req.method === 'PUT') {
        const body = await readBody(req);
        const key = stringField(body.key, 500);
        if (!key) throw new HttpError(400, '请填写 Key');
        await store.setSecret('OPENCODE_GO_API_KEY', key);
        invalidateSnapshot(store);
        return jsonResponse(res, 200, { ok: true });
      }

      if (pathname === '/api/opencode-go-key' && req.method === 'DELETE') {
        await store.setSecret('OPENCODE_GO_API_KEY', null);
        invalidateSnapshot(store);
        return jsonResponse(res, 200, { ok: true });
      }

      if (pathname === '/api/opencode-go/subscriptions' && req.method === 'POST') {
        const current = await store.load();
        const body = await readBody(req);
        const name = stringField(body.name, 60) || 'OpenCode Go';
        const provider = stringField(body.provider, 60) || 'opencode-go';
        const key = stringField(body.key, 500);
        const subscriptions = Array.isArray(current.providers.opencodeGo.subscriptions)
          ? [...current.providers.opencodeGo.subscriptions]
          : [];
        const baseId =
          stringField(body.id, 60) ||
          provider.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
        const seed = baseId || `go-${Date.now().toString(36)}`;
        let id = seed;
        let n = 2;
        while (subscriptions.some((sub) => sub.id === id)) id = `${seed}-${n++}`;
        const keyRef = `OPENCODE_GO_KEY_${id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
        subscriptions.push({ id, name, provider, keyRef });
        current.providers.opencodeGo.subscriptions = subscriptions;
        await store.saveConfig(current);
        if (key) await store.setSecret(keyRef, key);
        invalidateAllCaches(store);
        return jsonResponse(res, 201, { ok: true, id, keyRef });
      }

      const goSubMatch = pathname.match(/^\/api\/opencode-go\/subscriptions\/([^/]+)$/);
      if (goSubMatch && req.method === 'PUT') {
        const current = await store.load();
        const id = decodeURIComponent(goSubMatch[1]);
        const body = await readBody(req);
        const subscriptions = current.providers.opencodeGo.subscriptions || [];
        const sub = subscriptions.find((item) => item.id === id);
        if (!sub) return jsonResponse(res, 404, { error: '没有这个订阅' });
        if (body.name !== undefined) {
          const name = stringField(body.name, 60);
          if (name) sub.name = name;
        }
        if (body.provider !== undefined) {
          const provider = stringField(body.provider, 60);
          if (provider) sub.provider = provider;
        }
        await store.saveConfig(current);
        const key = stringField(body.key, 500);
        if (key) await store.setSecret(sub.keyRef, key);
        invalidateAllCaches(store);
        return jsonResponse(res, 200, { ok: true });
      }

      if (goSubMatch && req.method === 'DELETE') {
        const current = await store.load();
        const id = decodeURIComponent(goSubMatch[1]);
        const subscriptions = current.providers.opencodeGo.subscriptions || [];
        const sub = subscriptions.find((item) => item.id === id);
        if (!sub) return jsonResponse(res, 404, { error: '没有这个订阅' });
        current.providers.opencodeGo.subscriptions = subscriptions.filter((item) => item.id !== id);
        await store.saveConfig(current);
        if (sub.keyRef) await store.setSecret(sub.keyRef, null);
        invalidateAllCaches(store);
        return jsonResponse(res, 200, { ok: true });
      }

      if (pathname === '/api/deepseek-key' && req.method === 'PUT') {
        const body = await readBody(req);
        const key = stringField(body.key, 500);
        if (!key) throw new HttpError(400, '请填写 DeepSeek API Key');
        await store.setSecret('DEEPSEEK_API_KEY', key);
        invalidateSnapshot(store);
        return jsonResponse(res, 200, { ok: true });
      }

      if (pathname === '/api/deepseek-key' && req.method === 'DELETE') {
        await store.setSecret('DEEPSEEK_API_KEY', null);
        invalidateSnapshot(store);
        return jsonResponse(res, 200, { ok: true });
      }

      if (pathname === '/api/deepseek-platform-token' && req.method === 'PUT') {
        const body = await readBody(req);
        const token = stringField(body.token, 2000);
        if (!token) throw new HttpError(400, '请填写平台 userToken');
        await store.setSecret('DEEPSEEK_PLATFORM_TOKEN', token);
        invalidateSnapshot(store);
        return jsonResponse(res, 200, { ok: true });
      }

      if (pathname === '/api/deepseek-platform-token' && req.method === 'DELETE') {
        await store.setSecret('DEEPSEEK_PLATFORM_TOKEN', null);
        invalidateSnapshot(store);
        return jsonResponse(res, 200, { ok: true });
      }

      if (pathname.startsWith('/api/')) {
        return jsonResponse(res, 404, { error: '接口不存在' });
      }

      return serveStatic(req, res, pathname);
    } catch (err) {
      if (err instanceof HttpError) {
        return jsonResponse(res, err.status >= 400 ? err.status : 500, { error: err.message });
      }
      const message = err && err.message ? err.message : '服务器内部错误';
      console.error('[quota-board] 请求失败:', message);
      return jsonResponse(res, 500, { error: '服务器内部错误' });
    }
    } finally {
      if (release) release();
    }
  });

  // 服务就绪后再挂后台归档，并把它挂到 server.close 上（关闭时自动清理）
  startDailyArchiver();
  server.once('close', () => {
    if (archiverTimer) clearInterval(archiverTimer);
  });

  return { server, store, port };
}

export async function startServer({ dataDir, env = process.env } = {}) {
  const app = await createApp({ dataDir, env });
  await new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(app.port, '127.0.0.1', resolve);
  });
  const address = app.server.address();
  return {
    ...app,
    port: address.port,
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        app.server.close((err) => (err ? reject(err) : resolve()));
      })
  };
}

let isMain = false;
try { isMain = Boolean(process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))); } catch { /* 模块导入时无需启动 */ }
if (isMain) {
  ensureProxy();
  const argPort = process.argv.indexOf('--port');
  const env = { ...process.env };
  if (argPort > -1 && process.argv[argPort + 1]) env.PORT = process.argv[argPort + 1];
  startServer({ env })
    .then((app) => {
      console.log(`额度面板已启动：${app.url}`);
      console.log(`数据目录：${app.store.dataDir}`);
      console.log('仅监听 127.0.0.1，按 Ctrl+C 停止。');
    })
    .catch((err) => {
      console.error('启动失败：', err && err.message ? err.message : err);
      process.exitCode = 1;
    });
}
