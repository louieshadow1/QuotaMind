import http from 'node:http';
import { promises as fs, readFileSync, openSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore, expandHome, ConfigWriteError } from './lib/config.mjs';
import { createGoOfficialEstimateReader } from './lib/go-official-estimate.mjs';
import { opencodeModelUsageForSubscriptions } from './lib/opencode-model-service.mjs';
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
  codexAccountAllowsRefresh,
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
  IMPORT_CHANNELS,
  readHistory,
  writeHistory,
  importDays,
  historyFilePath,
  withHistoryLock as withHistoryFileLock
} from './lib/daily-history.mjs';
import {
  collectUsage,
  collectDailyUsage,
  accountIdFromHistoryKey,
  buildCodexSummary,
  buildDailyCodexAccounts,
  decorateCodexProvider,
  disambiguateNames
} from './lib/usage.mjs';

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

/** 启动参数里的端口（--port / PORT），用于等待重启出来的子进程就绪。 */
function proxyTargetPort() {
  const idx = process.argv.indexOf('--port');
  if (idx > -1 && process.argv[idx + 1]) {
    const port = Number(process.argv[idx + 1]);
    if (Number.isFinite(port) && port > 0) return port;
  }
  const envPort = Number(process.env.PORT);
  return Number.isFinite(envPort) && envPort > 0 ? envPort : 8799;
}

/** 轮询等待端口可访问，用来确认重启出来的子进程已经就绪。 */
async function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/api/version', timeout: 1000 }, (res) => {
        res.resume();
        resolve(true);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
    });
    if (ok) return true;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return false;
}

/**
 * Node 的 fetch 只在启动时读 HTTP(S)_PROXY（NODE_USE_ENV_PROXY=1 / --use-env-proxy），进程内设置无效。
 * 检测到系统代理时，在监听端口之前用同样的参数重启自身，由子进程接管端口：
 * 无论从 start.cmd、桌面快捷方式还是直接 node server.mjs 启动，都能自动带上代理。
 * 返回 true 表示子进程已就绪（父进程直接退出），false 表示照常启动。
 */
async function ensureProxy() {
  if (process.env.NODE_USE_ENV_PROXY === '1' || process.execArgv.includes('--use-env-proxy')) return false;
  const setting = readProxySetting();
  if (setting === '') return false;
  const proxy = setting && setting !== 'auto' ? setting : detectSystemProxy();
  if (!proxy) return false;
  if (process.env.QUOTA_BOARD_PROXY_REEXEC === '1') {
    // 已经重启过一次仍未生效：不再循环，只提示。
    console.warn('[quota-board] 已带代理变量重启，但 Node 未能启用 fetch 代理（Node 版本过旧？）');
    return false;
  }
  let logFd = 'ignore';
  try {
    logFd = openSync(path.join(process.cwd(), 'server.log'), 'a');
  } catch {
    logFd = 'ignore';
  }
  let child;
  let spawnError = null;
  let childExited = false;
  try {
    child = spawn(process.execPath, process.argv.slice(1), {
      cwd: process.cwd(),
      detached: true,
      windowsHide: true,
      stdio: ['ignore', logFd, logFd],
      env: {
        ...process.env,
        NODE_USE_ENV_PROXY: '1',
        HTTP_PROXY: process.env.HTTP_PROXY || proxy,
        HTTPS_PROXY: process.env.HTTPS_PROXY || proxy,
        NO_PROXY: process.env.NO_PROXY || '127.0.0.1,localhost,::1',
        QUOTA_BOARD_PROXY_REEXEC: '1'
      }
    });
    child.on('error', (err) => {
      spawnError = err;
    });
    child.on('exit', () => {
      childExited = true;
    });
    child.unref();
  } catch (err) {
    console.warn('[quota-board] 代理自启动失败：' + (err && err.message ? err.message : err));
    return false;
  }
  console.log('[quota-board] 检测到系统代理，正在启用代理后重新启动…');
  const ready = await waitForPort(proxyTargetPort(), 8000);
  if (ready && !spawnError) return true;
  try {
    if (child && !childExited) child.kill();
  } catch {
    /* ignore */
  }
  console.warn(
    '[quota-board] 代理子进程没有就绪（' +
      (spawnError && spawnError.message ? spawnError.message : childExited ? '子进程退出' : '端口超时') +
      '），本次按无代理启动'
  );
  return false;
}

const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const MAX_BODY_BYTES = 64 * 1024;
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const JSON_CONTENT_TYPE_RE = /^application\/json(?:\s*;|$)/i;

/**
 * 写请求来源校验（P1-04 CSRF）：
 * - POST/PUT/PATCH 必须 Content-Type: application/json（否则 415），杜绝 text/plain 简单请求；
 * - DELETE 无 body 时（前端/脚本只带方法）不强制 Content-Type，有 body 时必须 JSON；
 * - 带 Origin 的请求必须与 Host 同源（否则 403）；Sec-Fetch-Site: cross-site 一律 403；
 * - 无 Origin 的本地脚本请求放行（但上面已要求必须是 JSON）。
 */
export function assertWriteRequestSafe(req, hostHeader, writeToken = '') {
  const method = String(req.method || 'GET').toUpperCase();
  if (!WRITE_METHODS.has(method)) return;
  // P2：可选写令牌（env QUOTA_BOARD_WRITE_TOKEN）。设置为非空时，写请求必须带匹配的 X-Auth-Token。
  const expected = typeof writeToken === 'string' ? writeToken.trim() : '';
  if (expected) {
    const provided = String(req.headers['x-auth-token'] || '').trim();
    if (provided !== expected) {
      throw new HttpError(401, '写请求需要有效的 X-Auth-Token（服务端已启用写令牌）');
    }
  }
  const contentType = String(req.headers['content-type'] || '').trim();
  const hasBody =
    Number(req.headers['content-length'] || 0) > 0 || Boolean(req.headers['transfer-encoding']);
  if (method !== 'DELETE' || hasBody) {
    if (!JSON_CONTENT_TYPE_RE.test(contentType)) {
      throw new HttpError(415, '写请求必须使用 Content-Type: application/json');
    }
  }
  assertSameOriginRequest(req, hostHeader);
}

function assertSameOriginRequest(req, hostHeader) {
  const origin = req.headers.origin;
  if (origin !== undefined) {
    const host = String(hostHeader || '').trim().toLowerCase();
    let requestOrigin;
    let expectedOrigin;
    try {
      requestOrigin = new URL(String(origin).trim()).origin;
      if (host) expectedOrigin = new URL(`http://${host}`).origin;
    } catch {}
    if (!expectedOrigin || requestOrigin !== expectedOrigin) {
      throw new HttpError(403, '请求来源与本机面板不同源');
    }
  }
  const site = String(req.headers['sec-fetch-site'] || '').trim().toLowerCase();
  if (site === 'cross-site') {
    throw new HttpError(403, '请求来自跨站上下文');
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

const PUBLIC_ASSETS = new Set([
  'index.html', 'app.js', 'style.css', 'icon.ico', 'theme-boot.js',
  'widget.html', 'widget.js', 'widget.css', 'go-model-limits.json', 'go-quota-estimate.js',
  'vendor/echarts.min.js', 'vendor/lucide.min.js', 'vendor/README.md',
  'vendor/licenses/echarts-LICENSE.txt', 'vendor/licenses/echarts-NOTICE.txt', 'vendor/licenses/lucide-LICENSE.txt'
]);

const caches = new WeakMap();
const usageCaches = new WeakMap();
const dailyCaches = new WeakMap();
const quotaRefreshes = new WeakMap();

/**
 * P2：/api 已知路由的「路径 → 允许方法」表。
 * 用途：已知路由 + 错误方法 → 405 + Allow；OPTIONS 预检 → 204 + Allow（不再 404）。
 */
const API_ROUTES = [
  { test: (p) => p === '/api/version' || p === '/api/health' || p === '/api/config', methods: ['GET'] },
  { test: (p) => p === '/api/theme', methods: ['GET', 'PUT'] },
  { test: (p) => p === '/api/codex/scan', methods: ['GET'] },
  { test: (p) => p === '/api/codex/accounts', methods: ['POST'] },
  { test: (p) => p.startsWith('/api/codex/accounts/'), methods: ['PUT', 'DELETE'] },
  { test: (p) => p === '/api/codex/live', methods: ['PUT'] },
  { test: (p) => p.startsWith('/api/codex/history/'), methods: ['DELETE'] },
  { test: (p) => p === '/api/quota' || p === '/api/usage' || p === '/api/daily', methods: ['GET'] },
  { test: (p) => p === '/api/settings', methods: ['POST'] },
  { test: (p) => p === '/api/daily/import', methods: ['POST'] },
  { test: (p) => p === '/api/relays', methods: ['POST'] },
  { test: (p) => p.startsWith('/api/relays/') && p.endsWith('/token'), methods: ['PUT'] },
  { test: (p) => p.startsWith('/api/relays/'), methods: ['DELETE'] },
  { test: (p) => p === '/api/opencode-go-key', methods: ['PUT', 'DELETE'] },
  { test: (p) => p === '/api/opencode-go/model-usage', methods: ['GET'] },
  { test: (p) => p === '/api/opencode-go/subscriptions', methods: ['POST'] },
  { test: (p) => /^\/api\/opencode-go\/subscriptions\/[^/]+$/.test(p), methods: ['PUT', 'DELETE'] },
  { test: (p) => p === '/api/deepseek-key' || p === '/api/deepseek-platform-token', methods: ['PUT', 'DELETE'] },
  { test: (p) => isCodexDeviceLoginPath(p), methods: ['GET', 'POST', 'DELETE'] }
];

function allowedMethodsFor(pathname) {
  for (const route of API_ROUTES) if (route.test(pathname)) return route.methods;
  return [];
}

/** P2：绝对路径脱敏（home → ~/...；非 home 的绝对路径只留末级，避免泄露本机目录结构）。 */
function redactPath(value) {
  if (typeof value !== 'string' || !value) return value;
  const home = os.homedir();
  const norm = value.replace(/\\/g, '/');
  const homeNorm = home.replace(/\\/g, '/');
  const lower = norm.toLowerCase();
  const homeLower = homeNorm.toLowerCase();
  if (lower === homeLower) return '~';
  if (lower.startsWith(homeLower + '/')) return '~' + norm.slice(homeNorm.length);
  if (path.isAbsolute(value)) return path.basename(value);
  return norm;
}

function codexAccountsForUsage(config) {
  const live = liveCodexAccount(config);
  const livePath = live ? live.authPath : null;
  const entries = [];
  if (live) {
    entries.push({ name: live.name, authPath: live.authPath, id: live.id, live: true, allowRefresh: false });
  }
  for (const account of archivedCodexAccounts(config)) {
    const isLive = livePath ? sameAuthPath(account.authPath, livePath) : false;
    entries.push({
      name: account.name,
      authPath: account.authPath,
      id: account.id,
      live: false,
      allowRefresh: !isLive && codexAccountAllowsRefresh(account)
    });
  }
  return entries;
}

async function getDeepseekPlatformData(store, config) {
  if (config.providers.deepseekPlatform?.enabled === false) return null;
  const token = process.env.DEEPSEEK_PLATFORM_TOKEN || (await store.getSecret('DEEPSEEK_PLATFORM_TOKEN'));
  if (!token) return null;
  try {
    return await fetchDeepSeekPlatform({ token });
  } catch {
    return null;
  }
}

/**
 * 每日用量：采集 → 并入长期存档（data/daily-history.json）→ 一律从存档重建序列。
 * 这样即使数据源只保留最近 30 天（DeepSeek 官方），更早的历史也不会消失。
 */
async function getDailyReport(store, force = false, days = 371) {
  const now = Date.now();
  const ttl = 120 * 1000;
  const MAX_COLLECT_DAYS = 3650;
  let cache = dailyCaches.get(store);
  if (!cache) {
    cache = { expiresAt: 0, history: null };
    dailyCaches.set(store, cache);
  }

  let history = cache.history;
  let codexMeta = cache.codexMeta || { accounts: 0, stale: [] };
  let dailyWarning = cache.dailyWarning || null;
  if (force || !history || Date.now() >= cache.expiresAt) {
    let writeFailed = false;
    const config = await store.load();
    const platform = await getDeepseekPlatformData(store, config);
    const codexDailySnapshots = await readCodexDailySnapshots(store);
    const collected = await collectDailyUsage({
      codexAccounts: codexAccountsForUsage(config),
      days: MAX_COLLECT_DAYS,
      now,
      opencodeProviders: ((config.providers.opencodeGo && config.providers.opencodeGo.subscriptions) || [])
        .map((sub) => sub.provider)
        .filter(Boolean),
      deepseekDaily: platform && Array.isArray(platform.daily) ? platform.daily : null,
      codexDailySnapshots
    });
    if (collected.codexDailySnapshots) {
      await writeCodexDailySnapshots(store, collected.codexDailySnapshots);
    }
    // P1-03：与手工导入共用同一把历史写锁（F4 withHistoryLock，按文件路径），读-改-写串行。
    // P1-06：读存档改用 F4 的 readHistory —— 损坏时先备份 .corrupt-<ts>.json 再重建，接口不 500。
    history = await lockDailyHistory(store, async () => {
      const loaded = await readHistory(store);
      dailyWarning = loaded.warning || null;
      const merged = mergeSeriesIntoHistory(loaded.history, collected.series);
      try {
        // P1-06：原子写（tmp + rename），失败抛 HISTORY_WRITE_FAILED；归档轮失败只降级为 warning。
        await writeHistory(store, loaded.history);
        if (merged.addedDays || merged.updatedDays) invalidateUsageCache(store);
      } catch {
        writeFailed = true;
        console.error('[quota-board] 后台历史存档写入失败');
        if (!dailyWarning) {
          dailyWarning = {
            code: 'history-write-failed',
            message: '历史存档写入失败（磁盘或权限问题），本次仅内存生效'
          };
        }
      }
      return loaded.history;
    });
    // C3：/api/daily 根 codexAccounts 需要 {id,name,planName}，供热力图 tooltip 把 codexByAccount 还原成账号名。
    // 计划名只能从 codex-history.json 的历史快照里拿（官方 profiles/me 不返回 plan_type）。
    const codexHistoryForDaily = await readCodexHistory(store);
    codexMeta = {
      accounts: (collected.codexAccounts || []).length,
      accountList: buildDailyCodexAccounts({
        accounts: collected.codexAccounts || [],
        history: codexHistoryForDaily,
        // G8：把日存档也传进去，孤儿账号（有 codexByAccount 但不在账号列表）也要出现在 codexAccounts。
        days: history.days
      }),
      stale: collected.codexStale || [],
      deepseekSource: collected.deepseekSource || 'local'
    };
    cache.history = history;
    cache.codexMeta = codexMeta;
    cache.dailyWarning = dailyWarning;
    cache.expiresAt = writeFailed ? 0 : Date.now() + ttl;
  }

  const series = buildSeriesFromHistory(history, days, undefined, now);
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

  const codexAccountList = Array.isArray(codexMeta.accountList) ? codexMeta.accountList : [];
  return {
    days: series.length,
    series,
    totals,
    deepseekSource: codexMeta.deepseekSource || 'local',
    history: historyRange(history),
    // 契约：codexAccounts = [{id,name,planName}]（tooltip 分账号）；数量另给 codexAccountCount，避免调用方拿数组当数字。
    codexAccounts: codexAccountList,
    codexAccountCount: codexAccountList.length,
    codexStale: codexMeta.stale,
    // P1-06：存档损坏/归一化/写失败的可读告警（null 表示正常）。
    warning: publicHistoryWarning(dailyWarning),
    cached: false
  };
}

function publicHistoryWarning(warning) {
  if (!warning) return null;
  return { code: warning.code, message: warning.message };
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

async function refreshUsageReport(store, cache) {
  const config = await store.load();
  const codexAccounts = codexAccountsForUsage(config);
  const deepseekOfficial = await getDeepseekPlatformData(store, config);
  const deepseekArchive = await syncDeepseekArchive(store, deepseekOfficial?.daily);
  const data = await collectUsage({
    codexAccounts,
    deepseekOfficial,
    deepseekArchive,
    opencodeSubscriptions: (config.providers.opencodeGo && config.providers.opencodeGo.subscriptions) || []
  });
  await mergeCodexLifetime(store, config, data);
  // 写失败时展示已经落盘的累计，但下一次普通刷新应立即重试。
  cache.data = deepseekArchive.warning ? null : data;
  cache.expiresAt = deepseekArchive.warning ? 0 : Date.now() + 120 * 1000;
  // P2：与 /api/quota、/api/daily 一致，显式返回 cached 标记。
  return { ...data, cached: false };
}

async function getUsageReport(store, force = false) {
  let cache = usageCaches.get(store);
  if (!cache) {
    cache = { expiresAt: 0, data: null, pending: null };
    usageCaches.set(store, cache);
  }
  if (!force && cache.data && Date.now() < cache.expiresAt) {
    return { ...cache.data, cached: true };
  }
  if (cache.pending) return cache.pending;
  cache.pending = refreshUsageReport(store, cache);
  try {
    return await cache.pending;
  } finally {
    cache.pending = null;
  }
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
  dailyCaches.delete(store);
}

function invalidateUsageCache(store) {
  usageCaches.delete(store);
}

export function invalidateSnapshot(store) {
  const cache = store ? caches.get(store) : null;
  if (cache) cache.snapshot = null;
}

/** 订阅/令牌变更后，额度、Token 统计、每日统计三处缓存一起失效。 */
function invalidateAllCaches(store) {
  invalidateSnapshot(store);
  invalidateUsageCache(store);
  invalidateDailyCache(store);
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

/**
 * 每日用量的长期存档：data/daily-history.json（只增不减）。
 * 读写全部走 lib/daily-history.mjs（F4）：损坏先备份再重建、原子写、按文件路径的串行锁。
 */
function lockDailyHistory(store, task) {
  return withHistoryFileLock(historyFilePath(store.dataDir), task);
}

function summarizeDeepseekArchive(history) {
  const summary = { tokens: 0, days: 0, firstDate: null, lastDate: null };
  for (const [date, day] of Object.entries(history.days)) {
    if (!day.deepseekTokens) continue;
    summary.tokens += day.deepseekTokens;
    summary.days += 1;
    if (!summary.firstDate || date < summary.firstDate) summary.firstDate = date;
    if (!summary.lastDate || date > summary.lastDate) summary.lastDate = date;
  }
  return summary;
}

// 顶部接口也存入刚获得的逐日数据，首次启动无需等待热力图或定时任务。
async function syncDeepseekArchive(store, daily = []) {
  return lockDailyHistory(store, async () => {
    const { history } = await readHistory(store);
    const previous = summarizeDeepseekArchive(history);
    const rows = daily.map(({ date, tokens, costCny }) => ({
      date, deepseekTokens: tokens, deepseekCostCny: costCny
    }));
    const change = mergeSeriesIntoHistory(history, rows);
    if (!change.addedDays && !change.updatedDays) return previous;
    try {
      await writeHistory(store, history);
    } catch {
      return { ...previous, warning: '本次 DeepSeek 用量未能写入存档，仍显示已保存的累计。' };
    }
    invalidateDailyCache(store);
    return summarizeDeepseekArchive(history);
  });
}

/**
 * P1-03/P1-07：导入写后校验。重新从磁盘读出的 history 必须包含每个导入日期，
 * 且数值不小于本次导入值；否则抛错（路由层转成非 2xx），不允许"谎报成功"。
 */
export function verifyImportedHistory(stored, rows, channel) {
  const conf = IMPORT_CHANNELS[channel];
  if (!conf) throw new HttpError(400, '未知渠道：' + channel);
  const days = (stored && stored.days) || {};
  for (const row of Array.isArray(rows) ? rows : []) {
    const day = days[row.date];
    if (!day) throw new HttpError(500, `导入校验失败：${row.date} 未写入存档`);
    const expectedTokens = Number(row[conf.tokensField] || 0);
    const actualTokens = Number(day[conf.tokensField] || 0);
    if (expectedTokens > 0 && actualTokens < expectedTokens) {
      throw new HttpError(500, `导入校验失败：${row.date} 的用量未按预期写入`);
    }
    if (conf.costField && row[conf.costField] !== undefined) {
      const expectedCost = Number(row[conf.costField]);
      const actualCost = Number(day[conf.costField] || 0);
      if (Number.isFinite(expectedCost) && actualCost < expectedCost) {
        throw new HttpError(500, `导入校验失败：${row.date} 的费用未按预期写入`);
      }
    }
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

/**
 * H2：外观主题（config.ui.theme）—— GET/PUT /api/theme。
 * 事实来源是 lib/theme.mjs（H1 落盘）；模块不可用时服务照常启动，主题接口返回 501。
 */
const FALLBACK_UI_THEME = Object.freeze({
  preset: 'claude',
  mode: 'light',
  accent: null,
  modules: { codex: null, deepseek: null, opencodeGo: null, relay: null, other: null }
});
const THEME_MODES = ['light', 'dark', 'auto'];
const FALLBACK_MODULE_KEYS = ['codex', 'deepseek', 'opencodeGo', 'relay', 'other'];
const HEX_COLOR_RE = /^#[0-9a-f]{6}$/;

let themeModulePromise = null;
/** 动态加载 lib/theme.mjs（缺失时不阻塞服务启动；加载成功后缓存）。 */
async function loadThemeModule() {
  if (!themeModulePromise) {
    themeModulePromise = import('./lib/theme.mjs').catch((err) => {
      themeModulePromise = null;
      throw err;
    });
  }
  return themeModulePromise;
}

function fallbackTheme() {
  return { ...FALLBACK_UI_THEME, modules: { ...FALLBACK_UI_THEME.modules } };
}

/** 读取当前主题（config.ui.theme），缺失/畸形字段用默认值补齐。 */
function currentThemeOf(config) {
  const ui = config && config.ui && typeof config.ui === 'object' ? config.ui : null;
  const stored = ui && ui.theme && typeof ui.theme === 'object' ? ui.theme : null;
  const base = fallbackTheme();
  if (!stored) return base;
  return {
    preset: typeof stored.preset === 'string' && stored.preset ? stored.preset : base.preset,
    mode: THEME_MODES.includes(stored.mode) ? stored.mode : base.mode,
    accent: typeof stored.accent === 'string' ? stored.accent : null,
    modules: { ...base.modules, ...(stored.modules && typeof stored.modules === 'object' ? stored.modules : {}) }
  };
}

function themePresetIds(mod) {
  const list = Array.isArray(mod.THEME_PRESETS) ? mod.THEME_PRESETS : [];
  return list.map((preset) => String(preset && preset.id ? preset.id : preset)).filter(Boolean);
}

function themeModuleKeys(mod) {
  const keys = Array.isArray(mod.MODULE_KEYS) ? mod.MODULE_KEYS : null;
  return keys && keys.length ? keys.map(String) : FALLBACK_MODULE_KEYS;
}

function isValidThemeHex(value) {
  return typeof value === 'string' && HEX_COLOR_RE.test(value.toLowerCase());
}

function normalizeThemeHex(value) {
  return String(value).toLowerCase();
}

class ThemeValidationError extends HttpError {
  constructor(details) {
    super(400, '主题配置不合法');
    this.name = 'ThemeValidationError';
    this.details = details;
  }
}

/** PUT body 校验 + 归一：preset 白名单 / mode 白名单 / accent 与 modules 必须是 #rrggbb 或 null。 */
function normalizeThemeInput(body, mod) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ThemeValidationError([{ field: '(body)', message: '请求体必须是 JSON 对象' }]);
  }
  const details = [];
  const allowed = new Set(['preset', 'mode', 'accent', 'modules']);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) details.push({ field: key, message: '未知字段（只接受 preset/mode/accent/modules）' });
  }
  const next = fallbackTheme();
  if (body.preset !== undefined) {
    const ids = themePresetIds(mod);
    const preset = typeof body.preset === 'string' ? body.preset : '';
    const customAllowed = preset === 'custom' || ids.includes('custom');
    if (!preset || (!ids.includes(preset) && !(preset === 'custom' && customAllowed))) {
      details.push({ field: 'preset', message: 'preset 必须是预设之一：' + (ids.length ? ids.join(' / ') : 'claude / graphite / sage / midnight / sunset') });
    } else {
      next.preset = preset;
    }
  }
  if (body.mode !== undefined) {
    if (!THEME_MODES.includes(body.mode)) {
      details.push({ field: 'mode', message: 'mode 必须是 light / dark / auto' });
    } else {
      next.mode = body.mode;
    }
  }
  if (body.accent !== undefined) {
    if (body.accent === null) next.accent = null;
    else if (isValidThemeHex(body.accent)) next.accent = normalizeThemeHex(body.accent);
    else details.push({ field: 'accent', message: 'accent 必须是 #rrggbb 或 null' });
  }
  if (body.modules !== undefined) {
    if (!body.modules || typeof body.modules !== 'object' || Array.isArray(body.modules)) {
      details.push({ field: 'modules', message: 'modules 必须是对象' });
    } else {
      const keys = themeModuleKeys(mod);
      for (const key of Object.keys(body.modules)) {
        if (!keys.includes(key)) {
          details.push({ field: 'modules.' + key, message: '未知模块（只接受 ' + keys.join(' / ') + '）' });
        }
      }
      for (const key of keys) {
        const value = body.modules[key];
        if (value === undefined || value === null) {
          next.modules[key] = null;
        } else if (isValidThemeHex(value)) {
          next.modules[key] = normalizeThemeHex(value);
        } else {
          details.push({ field: 'modules.' + key, message: '颜色必须是 #rrggbb 或 null' });
        }
      }
    }
  }
  if (details.length) throw new ThemeValidationError(details);
  return next;
}

/** R2/P1-1：解析 ?systemDark=1|0（默认 0）；非 1/0 值 → 400。 */
function parseSystemDark(searchParams) {
  const raw = searchParams.get('systemDark');
  if (raw === null || raw === '' || raw === '0' || raw === 'false') return false;
  if (raw === '1' || raw === 'true') return true;
  throw new HttpError(400, 'systemDark 只接受 1 或 0');
}

/** R2/P3-5：暴露给前端/widget 的脱敏主题：只含 preset/mode/accent/modules，且值必须是合法 hex 或 null。 */
function sanitizeThemeForClient(theme) {
  const modules = {};
  for (const key of FALLBACK_MODULE_KEYS) {
    const value = theme && theme.modules ? theme.modules[key] : null;
    modules[key] = isValidThemeHex(value) ? normalizeThemeHex(value) : null;
  }
  return {
    preset: theme && typeof theme.preset === 'string' && theme.preset ? theme.preset : FALLBACK_UI_THEME.preset,
    mode: theme && THEME_MODES.includes(theme.mode) ? theme.mode : FALLBACK_UI_THEME.mode,
    accent: theme && isValidThemeHex(theme.accent) ? normalizeThemeHex(theme.accent) : null,
    modules
  };
}

/** GET/PUT 共用响应：presets + current + vars(按 systemDark) + varsLight/varsDark + warnings。 */
async function themeResponse(store, mod = null, { systemDark = false } = {}) {
  const config = await store.load();
  const current = currentThemeOf(config);
  let loaded = mod;
  if (!loaded) {
    try {
      loaded = await loadThemeModule();
    } catch {
      loaded = null;
    }
  }
  if (!loaded) {
    return {
      presets: [],
      current,
      vars: {},
      varsLight: {},
      varsDark: {},
      warnings: [{ code: 'theme-module-missing', message: 'lib/theme.mjs 尚未安装，只能读写配置' }]
    };
  }
  // R2：vars 跟随 ?systemDark；varsLight/varsDark 各解析一份，供前端 auto 模式即时切换。
  const resolved = loaded.resolveTheme(current, { systemDark }) || {};
  const resolvedLight = loaded.resolveTheme({ ...current, mode: 'light' }, { systemDark: false }) || {};
  const resolvedDark = loaded.resolveTheme({ ...current, mode: 'dark' }, { systemDark: true }) || {};
  const varsOf = (value) => (value && value.vars && typeof value.vars === 'object' ? value.vars : {});
  const presets = (Array.isArray(loaded.THEME_PRESETS) ? loaded.THEME_PRESETS : []).map((preset) => ({
    id: preset.id,
    name: preset.name,
    description: preset.description || '',
    swatches: Array.isArray(preset.swatches) ? preset.swatches : [],
    light: preset.light && typeof preset.light === 'object' ? preset.light : {},
    dark: preset.dark && typeof preset.dark === 'object' ? preset.dark : {}
  }));
  return {
    presets,
    current,
    vars: varsOf(resolved),
    varsLight: varsOf(resolvedLight),
    varsDark: varsOf(resolvedDark),
    warnings: Array.isArray(resolved.warnings) ? resolved.warnings : [],
    warningsLight: Array.isArray(resolvedLight.warnings) ? resolvedLight.warnings : [],
    warningsDark: Array.isArray(resolvedDark.warnings) ? resolvedDark.warnings : []
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
  // 同名多号时给账户行和热力图生成不同的展示名，保留 name 字段原值。
  const displayNames = disambiguateNames(entries.map((entry) => ({ id: entry.accountId || null, name: entry.name || 'Codex' })));
  entries.forEach((entry, index) => {
    entry.displayName = displayNames.get(index);
  });
  sanitized.providers.codex.accounts = entries;
  // P2：/api/config 路径脱敏 —— home 前缀缩写为 ~，非 home 绝对路径只留末级，不向页面泄露本机路径。
  if (sanitized.paths) {
    for (const key of ['dataDir', 'configFile', 'secretsFile']) {
      if (typeof sanitized.paths[key] === 'string') sanitized.paths[key] = redactPath(sanitized.paths[key]);
    }
  }
  delete sanitized.providers.codex.authPath;
  for (const entry of entries) {
    if (typeof entry.authPath === 'string') entry.authPath = path.posix.basename(entry.authPath.replace(/\\/g, '/'));
    delete entry.codexHome;
  }
  // R2/P3-5：向 widget / 前端回退暴露脱敏后的 ui.theme（只含 preset/mode/accent/modules，无任何 secret）。
  sanitized.ui = { theme: sanitizeThemeForClient(currentThemeOf(config)) };
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


/**
 * 设备码登录路由分发钩子：server.mjs 只做接线，业务实现在 lib/codex-device-login.mjs（A7）。
 * 约定：模块导出 handleCodexDeviceLoginRequest(ctx) → Promise<boolean>（true=已写响应）。
 * 模块尚未落盘时返回 501，不影响其它路由与测试。
 */
let codexDeviceLoginHandler = null;
let codexDeviceLoginDispose = null;
const CODEX_DEVICE_LOGIN_PATHS = ['/api/codex/managed-login', '/api/codex/device-login'];

function isCodexDeviceLoginPath(pathname) {
  return CODEX_DEVICE_LOGIN_PATHS.some(
    (base) => pathname === base || pathname.startsWith(base + '/')
  );
}

async function dispatchCodexDeviceLogin(ctx) {
  if (!isCodexDeviceLoginPath(ctx.pathname)) return false;
  if (!codexDeviceLoginHandler) {
    try {
      const mod = await import('./lib/codex-device-login.mjs');
      codexDeviceLoginHandler = mod.handleCodexDeviceLoginRequest || mod.handleRequest || mod.default || null;
      codexDeviceLoginDispose = typeof mod.disposeCodexDeviceLogin === 'function' ? mod.disposeCodexDeviceLogin : null;
    } catch (err) {
      if (err && err.code === 'ERR_MODULE_NOT_FOUND') {
        jsonResponse(ctx.res, 501, { error: '设备码登录模块尚未安装（lib/codex-device-login.mjs）' });
        return true;
      }
      throw err;
    }
  }
  if (typeof codexDeviceLoginHandler !== 'function') {
    jsonResponse(ctx.res, 501, { error: '设备码登录模块未导出 handleCodexDeviceLoginRequest' });
    return true;
  }
  const handled = await codexDeviceLoginHandler({
    ...ctx,
    readBody,
    jsonResponse,
    invalidateAllCaches,
    HttpError,
    UnconfiguredError
  });
  return handled !== false;
}

function jsonResponse(res, status, value, headers = null) {
  const body = JSON.stringify(value);
  const head = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Referrer-Policy': 'no-referrer'
  };
  if (headers) Object.assign(head, headers);
  res.writeHead(status, head);
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
    const error = err instanceof HttpError || isUnconfigured ? err.message : '读取用量失败，请稍后重试。';
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

async function getGoSubscriptionKey(store, subscription) {
  if (subscription.keyRef) return store.getSecret(subscription.keyRef);
  return (await resolveOpencodeGoKey({ store }))?.key;
}

function goSubscriptions(goConfig) {
  return goConfig.subscriptions?.length
    ? goConfig.subscriptions
    : [{ id: 'default', name: 'OpenCode Go', provider: 'opencode-go', keyRef: null }];
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
      archived.map(async (account) => ({
        ...account,
        accountId: await readCodexAccountId(account.authPath),
        allowRefresh: !(live && sameAuthPath(account.authPath, live.authPath)) && codexAccountAllowsRefresh(account)
      }))
    );

    if (live) {
      const label = `Codex · ${live.name}`;
      const liveKey = liveAccountId ? `id:${liveAccountId}` : 'live';
      codexJobKeys.add(liveKey);
      jobs.push({
        key: 'codex:live',
        meta: { id: 'codex:live', name: label, kind: 'codex', windows: [], historyKey: liveKey, accountId: liveAccountId || null },
        run: async () => {
          const provider = await fetchCodexUsage({
            name: label,
            authPath: live.authPath,
            live: true,
            allowRefresh: false
          });
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
        meta: { id: `codex:${account.id}`, name: label, kind: 'codex', windows: [], historyKey: key, accountId: account.accountId || null },
        run: async () => {
          const provider = await fetchCodexUsage({
            name: label,
            authPath: account.authPath,
            live: false,
            allowRefresh: account.allowRefresh === true
          });
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

  if (config.providers.opencodeGo.enabled !== false) {
    for (const sub of goSubscriptions(config.providers.opencodeGo)) {
      const label = sub.name || 'OpenCode Go';
      jobs.push({
        key: `opencode-go:${sub.id}`,
        meta: { id: `opencode-go:${sub.id}`, name: label, kind: 'opencode-go', windows: [], subscription: sub.id },
        run: async () => {
          const key = await getGoSubscriptionKey(store, sub);
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
  // C3：每张 Codex 卡补齐 accountId / planMeta / windows[].kind（stale 历史快照也按 plan + 秒数派生），
  // 然后生成根字段 codexSummary 供前端做「多号同登」汇总。非 codex 卡原样保留。
  for (let index = 0; index < providers.length; index += 1) {
    const provider = providers[index];
    if (!provider || provider.kind !== 'codex') continue;
    const meta = jobs[index] && jobs[index].meta ? jobs[index].meta : null;
    const accountId =
      provider.accountId ||
      (meta && meta.accountId) ||
      accountIdFromHistoryKey(provider.historyKey || (meta && meta.historyKey));
    providers[index] = decorateCodexProvider(provider, { accountId });
  }
  // 同名多号的卡片追加短 accountId，单号保持原名。
  const codexCardIndexes = [];
  const codexCardNames = [];
  for (let index = 0; index < providers.length; index += 1) {
    const provider = providers[index];
    if (!provider || provider.kind !== 'codex') continue;
    const accountId = provider.accountId || accountIdFromHistoryKey(provider.historyKey);
    if (!accountId && !provider.historyKey) continue;
    codexCardIndexes.push(index);
    codexCardNames.push({ id: accountId, name: String(provider.name || '').replace(/^Codex · /, '') });
  }
  const cardDisplayNames = disambiguateNames(codexCardNames);
  codexCardIndexes.forEach((providerIndex, order) => {
    const provider = providers[providerIndex];
    const displayName = cardDisplayNames.get(order);
    if (!displayName || displayName === provider.name) return;
    const prefixed = typeof provider.name === 'string' && provider.name.startsWith('Codex · ');
    providers[providerIndex] = { ...provider, name: (prefixed ? 'Codex · ' : '') + displayName };
  });
  const data = {
    generatedAt: new Date().toISOString(),
    refreshSeconds: ttlSeconds,
    providers,
    codexSummary: buildCodexSummary(providers),
    cached: false
  };
  cache.snapshot = { expiresAt: now + ttlSeconds * 1000, data };
  return data;
}

async function serveStatic(req, res, urlPath) {
  let relative;
  try { relative = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath).slice(1); } catch {
    return jsonResponse(res, 400, { error: '资源地址无效' });
  }
  if (!PUBLIC_ASSETS.has(relative)) return jsonResponse(res, 404, { error: '文件不存在' });
  const candidate = path.join(PUBLIC_DIR, relative);
  let resolved;
  let stat;
  try {
    const realPublic = await fs.realpath(PUBLIC_DIR);
    resolved = await fs.realpath(candidate);
    const realRelative = path.relative(realPublic, resolved).split(path.sep).join('/');
    if (realRelative !== relative) return jsonResponse(res, 404, { error: '文件不存在' });
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
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy':
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'"
  });
  res.end(content);
}

export async function createApp({ dataDir, env = process.env } = {}) {
  const store = createStore(dataDir);
  const goOfficialEstimates = createGoOfficialEstimateReader();
  await store.init();
  const initialConfig = await store.load();
  const port = Number(env.PORT || initialConfig.port || 8799);
  // P2：可选写令牌；为空时保持原行为（本机无认证）。
  const writeToken = String(env.QUOTA_BOARD_WRITE_TOKEN || '').trim();

  // 后台自动快照：即使没人打开页面，也定期把当天用量并入长期存档。
  // 定时器 unref，不阻止进程退出；间隔默认 30 分钟，可通过 config 调整。
  let archiverTimer = null;
  const startDailyArchiver = () => {
    if (env.QUOTA_BOARD_DISABLE_ARCHIVER === '1') return;
    const runOnce = async () => {
      try {
        await getDailyReport(store, true, 3650);
      } catch {
        /* 后台任务失败不影响服务 */
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
    // P3：HTTP/1.0 等不带 Host 的请求直接 400（本地面板不支持无 Host 连接）。
    if (!req.headers.host) {
      return jsonResponse(res, 400, { error: '缺少 Host 头（不支持 HTTP/1.0 无 Host 的连接）' });
    }
    if (!hostAllowed(req.headers.host, boundPort)) {
      return jsonResponse(res, 403, { error: '非法的 Host 头（只允许 127.0.0.1 / localhost）' });
    }

    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    const { pathname } = url;

    // P2：HEAD 按 GET 语义派发（Node 不会发送响应体），让 HEAD 已知 GET 路由返回真实响应头。
    if (req.method === 'HEAD') req.method = 'GET';

    try {
      // P2：OPTIONS 预检 —— 已知 /api 路由返回 204 + Allow（不再 404）。
      if (req.method === 'OPTIONS' && pathname.startsWith('/api/')) {
        const allow = allowedMethodsFor(pathname);
        if (allow.length) {
          res.writeHead(204, { Allow: [...allow, 'OPTIONS'].join(', '), 'Cache-Control': 'no-store' });
          res.end();
          return;
        }
      }
      // P1-04：所有写请求先过来源/Content-Type 校验（Origin 同源、拒绝 text/plain 简单请求）。
      // P2：可选写令牌（env QUOTA_BOARD_WRITE_TOKEN）。
      assertWriteRequestSafe(req, req.headers.host, writeToken);
      if (req.method === 'GET' && pathname.startsWith('/api/')) {
        assertSameOriginRequest(req, req.headers.host);
      }
      if (await dispatchCodexDeviceLogin({ req, res, method: req.method, pathname, url, store })) return;

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

      if (pathname === '/api/theme' && req.method === 'GET') {
        const systemDark = parseSystemDark(url.searchParams);
        return jsonResponse(res, 200, await themeResponse(store, null, { systemDark }));
      }

      if (pathname === '/api/theme' && req.method === 'PUT') {
        // H2：沿用写请求 CSRF / 写令牌 / 64KB body 规则（assertWriteRequestSafe + readBody）。
        const body = await readBody(req);
        let mod = null;
        try {
          mod = await loadThemeModule();
        } catch {
          return jsonResponse(res, 501, { error: '主题模块 lib/theme.mjs 尚未安装' });
        }
        const next = normalizeThemeInput(body, mod);
        const config = await store.load();
        config.ui = { ...(config.ui && typeof config.ui === 'object' ? config.ui : {}), theme: next };
        await store.saveConfig(config);
        invalidateSnapshot(store);
        const systemDark = parseSystemDark(url.searchParams);
        return jsonResponse(res, 200, await themeResponse(store, mod, { systemDark }));
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
          if (!info.exists) throw new HttpError(400, '找不到所选的登录文件，请检查路径。');
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
        // P2：同一时刻只重建一次快照，其余请求 await 同一个 Promise（16 路并发上游只打 1 次）。
        let inflight = quotaRefreshes.get(store);
        if (!inflight) {
          inflight = buildSnapshot(store, { force }).finally(() => quotaRefreshes.delete(store));
          quotaRefreshes.set(store, inflight);
        }
        return jsonResponse(res, 200, await inflight);
      }

      if (pathname === '/api/usage' && req.method === 'GET') {
        const force = url.searchParams.get('refresh') === '1';
        return jsonResponse(res, 200, await getUsageReport(store, force));
      }

      if (pathname === '/api/opencode-go/model-usage' && req.method === 'GET') {
        const config = await store.load();
        const goConfig = config.providers.opencodeGo;
        const force = url.searchParams.get('refresh') === '1';
        const cards = cacheFor(store).snapshot?.data.providers || [];
        const configured = goConfig.enabled === false ? [] : goSubscriptions(goConfig);
        const [local, official] = await Promise.all([
          opencodeModelUsageForSubscriptions(goConfig, { force }),
          Promise.all(configured.map(async (subscription) => {
            const card = cards.find((item) => item.kind === 'opencode-go' && item.status === 'ok' &&
              item.subscription === subscription.id && item.provider === subscription.provider);
            const cycleEnd = card?.windows.find((window) => window.key === 'monthly')?.resetAt;
            if (!cycleEnd) return { status: 'pending' };
            try {
              const key = await getGoSubscriptionKey(store, subscription);
              return await goOfficialEstimates.read({ id: subscription.id, route: subscription.provider, key, cycleEnd, force });
            } catch {
              return { status: 'unavailable', cycleEnd };
            }
          }))
        ]);
        const byId = new Map(configured.map((sub, index) => [sub.id, official[index]]));
        return jsonResponse(res, 200, {
          ...local,
          subscriptions: local.subscriptions.map((sub) => ({ ...sub, officialEstimate: byId.get(sub.id) }))
        });
      }

      if (pathname === '/api/daily' && req.method === 'GET') {
        const force = url.searchParams.get('refresh') === '1';
        // P2：days 显式校验 —— 0 表示全部历史，其余必须是 1..3650 的整数；非法直接 400，不再静默夹取。
        const rawDays = url.searchParams.get('days');
        let days = 371;
        if (rawDays !== null && rawDays !== '') {
          if (!/^\d+$/.test(rawDays) || Number(rawDays) > 3650) {
            throw new HttpError(400, 'days 参数必须是 0-3650 的整数（0 表示全部历史，默认 371）');
          }
          const parsed = Number(rawDays);
          days = parsed === 0 ? 3650 : parsed;
        }
        return jsonResponse(res, 200, await getDailyReport(store, force, days));
      }

      if (pathname === '/api/settings' && req.method === 'POST') {
        // 改标题 / 副标题 / 标记引导完成；只接受短文本，防止塞入奇怪内容
        const body = await readBody(req);
        const config = await store.load();
        const settings = { ...(config.settings || {}) };
        const clean = (value, max) => String(value || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
        if (body.title !== undefined) settings.title = clean(body.title, 40) || 'Token 使用情况';
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
        // P1-03/P1-06：整段「读（损坏先备份重建）→ .bak → 合并 → 原子写 → 写后校验」持有同一把历史锁。
        const result = await lockDailyHistory(store, async () => {
          const loaded = await readHistory(store);
          // 导入前备份，误导入可恢复（保留原有 .bak 语义）
          try {
            await fs.writeFile(
              path.join(store.dataDir, 'daily-history.json.bak'),
              `${JSON.stringify(loaded.history, null, 2)}\n`,
              'utf8'
            );
          } catch {
            /* 备份失败不阻断导入，但写失败仍会抛错 */
          }
          // 已在锁内：importDays 传 lock:false，避免同一文件路径自锁（P1-03）。
          const imported = await importDays(store, rows, { lock: false });
          // 写后校验：从磁盘重新读，确认每个导入日期真的落盘（P1-03/P1-07）。
          const stored = (await readHistory(store)).history;
          verifyImportedHistory(stored, rows, channel);
          invalidateDailyCache(store);
          invalidateUsageCache(store);
          return { imported, warning: imported.warning || loaded.warning || null };
        });
        return jsonResponse(res, 200, {
          ok: true,
          channel,
          importedRows: rows.length,
          addedDays: result.imported.summary.addedDays,
          updatedDays: result.imported.summary.updatedDays,
          skippedRows: result.imported.summary.skipped,
          errors: errors.slice(0, 20),
          history: result.imported.range,
          warning: publicHistoryWarning(result.warning),
          verified: true
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
        goOfficialEstimates.forget('default');
        invalidateSnapshot(store);
        return jsonResponse(res, 200, { ok: true });
      }

      if (pathname === '/api/opencode-go-key' && req.method === 'DELETE') {
        await store.setSecret('OPENCODE_GO_API_KEY', null);
        goOfficialEstimates.forget('default');
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
        const keyRefFor = (subscriptionId) => `OPENCODE_GO_KEY_${subscriptionId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
        while (subscriptions.some((sub) => sub.id === id || sub.keyRef === keyRefFor(id))) {
          id = `${seed}-${n++}`;
        }
        const keyRef = keyRefFor(id);
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
        goOfficialEstimates.forget(id);
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
        goOfficialEstimates.forget(id);
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
        invalidateAllCaches(store);
        return jsonResponse(res, 200, { ok: true });
      }

      if (pathname === '/api/deepseek-platform-token' && req.method === 'DELETE') {
        await store.setSecret('DEEPSEEK_PLATFORM_TOKEN', null);
        invalidateAllCaches(store);
        return jsonResponse(res, 200, { ok: true });
      }

      if (pathname.startsWith('/api/')) {
        // P2/P3：已知路由 + 错误方法 → 405 + Allow；未知路径仍是 404。
        const allow = allowedMethodsFor(pathname);
        if (allow.length) {
          return jsonResponse(
            res,
            405,
            { error: `方法不允许：${req.method}（该接口只支持 ${allow.join(', ')}）` },
            { Allow: allow.join(', ') }
          );
        }
        return jsonResponse(res, 404, { error: '接口不存在' });
      }

      return await serveStatic(req, res, pathname);
    } catch (err) {
      if (err instanceof HttpError) {
        const payload = err.details ? { error: err.message, details: err.details } : { error: err.message };
        return jsonResponse(res, err.status >= 400 ? err.status : 500, payload);
      }
      // F1：配置原子写失败 → 可读状态码/文案（message 只含文件名与系统错误码，不含令牌）。
      if (err instanceof ConfigWriteError || (err && err.name === 'ConfigWriteError')) {
        const status = Number.isFinite(err.status) && err.status >= 400 ? err.status : 500;
        console.error('[quota-board] 配置写入失败:', err.message);
        return jsonResponse(res, status, { error: err.message || '配置写入失败' });
      }
      // F4：历史存档写/备份失败 → 500 + 可读文案（不回显绝对路径）。
      if (err && (err.code === 'HISTORY_WRITE_FAILED' || err.code === 'HISTORY_BACKUP_FAILED')) {
        console.error('[quota-board] 历史存档操作失败:', err.code);
        return jsonResponse(res, 500, {
          error:
            err.code === 'HISTORY_BACKUP_FAILED'
              ? '历史存档损坏且无法备份，已放弃写入（原文件未覆盖）'
              : '历史存档写入失败（磁盘或权限问题），本次操作未生效'
        });
      }
      console.error('[quota-board] 请求处理失败');
      return jsonResponse(res, 500, { error: '服务器内部错误' });
    }
  });

  // 服务就绪后再挂后台归档，并把它挂到 server.close 上（关闭时自动清理）
  startDailyArchiver();
  server.once('close', () => {
    if (archiverTimer) clearInterval(archiverTimer);
    if (codexDeviceLoginDispose) {
      try {
        codexDeviceLoginDispose(store);
      } catch {
        /* 清理失败不影响关闭 */
      }
    }
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

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const start = async () => {
    // 检测到系统代理时由带 NODE_USE_ENV_PROXY=1 的子进程接管端口，父进程直接退出
    if (await ensureProxy()) return;
    const argPort = process.argv.indexOf('--port');
    const env = { ...process.env };
    if (argPort > -1 && process.argv[argPort + 1]) env.PORT = process.argv[argPort + 1];
    const app = await startServer({ env });
    console.log(`额度面板已启动：${app.url}`);
    console.log(`数据目录：${app.store.dataDir}`);
    console.log('仅监听 127.0.0.1，按 Ctrl+C 停止。');
  };
  start().catch((err) => {
    console.error('启动失败：', err && err.message ? err.message : err);
    process.exitCode = 1;
  });
}


