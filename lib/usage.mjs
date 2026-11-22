import { promises as fs } from 'node:fs';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { expandHome } from './config.mjs';
import { codexAuthenticatedJson, CODEX_PROFILE_URL } from './adapters.mjs';
import { planMetaFor, windowKindFromSeconds } from './plan.mjs';
import { calendarDayRange, usageDay } from './daily-history.mjs';

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------- 计划 / 窗口 / 多账号汇总（v1.8.x）

/** 窗口秒数 → {kind,key,label}；lib/plan.mjs 已按 18000/604800/2592000 等派生，这里只做防御式调用。 */
function windowKindFor(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  if (typeof windowKindFromSeconds !== 'function') return null;
  try {
    const info = windowKindFromSeconds(seconds);
    return info && typeof info === 'object' ? info : null;
  } catch {
    return null;
  }
}

/**
 * 统一 Codex 窗口形状：kind 由 limit_window_seconds 派生；已知秒数时以秒数为准重新派生 key/label，
 * 这样 7 天窗口即使被旧快照写成 「5 小时」也能纠正。未知秒数保留原 key/label，kind 为 custom。
 */
export function deriveCodexWindow(window) {
  if (!window || typeof window !== 'object') return window;
  const seconds = num(window.windowSeconds);
  const info = windowKindFor(seconds);
  if (!info) return { ...window, kind: window.kind || 'custom' };
  return {
    ...window,
    key: info.key || window.key,
    label: info.label || window.label,
    kind: info.kind || 'custom'
  };
}

/** history 快照的 key（'id:<account_id>'）→ account_id；其它 key（live / cfg:…）返回 null。 */
export function accountIdFromHistoryKey(key) {
  const text = typeof key === 'string' ? key : '';
  return text.startsWith('id:') && text.length > 3 ? text.slice(3) : null;
}

/** 账号短 id（前 8 位），只用于展示消歧，不是凭据。 */
export function shortAccountId(accountId) {
  const text = typeof accountId === 'string' ? accountId : '';
  return text.length > 8 ? text.slice(0, 8) : text;
}

/**
 * 同一显示名出现多个账号时追加短 accountId。
 * 单号或拿不到 id 时保持原名不变；返回 Map<索引, 展示名>。
 */
export function disambiguateNames(entries = []) {
  const list = (Array.isArray(entries) ? entries : []).map((entry, index) => ({
    index,
    id: entry && entry.id ? String(entry.id) : null,
    name: entry && entry.name ? String(entry.name).trim() : ''
  }));
  const counts = new Map();
  for (const item of list) counts.set(item.name, (counts.get(item.name) || 0) + 1);
  const out = new Map();
  for (const item of list) {
    const duplicated = (counts.get(item.name) || 0) > 1 && item.id;
    out.set(item.index, duplicated ? item.name + ' · ' + shortAccountId(item.id) : item.name);
  }
  return out;
}

/**
 * 给一张 Codex 卡补齐 accountId / planMeta / windows[].kind。
 * 返回新对象，不改动入参（buildSnapshot 的缓存与 stale 复用都依赖原对象）。
 */
export function decorateCodexProvider(provider, { accountId = null } = {}) {
  if (!provider || typeof provider !== 'object') return provider;
  const windows = Array.isArray(provider.windows) ? provider.windows.map(deriveCodexWindow) : [];
  let planMeta = provider.planMeta && typeof provider.planMeta === 'object' ? provider.planMeta : null;
  if (!planMeta && typeof planMetaFor === 'function') {
    try {
      planMeta = planMetaFor(provider.plan || null) || null;
    } catch {
      planMeta = null;
    }
  }
  return {
    ...provider,
    accountId: provider.accountId || accountId || null,
    planMeta,
    windows
  };
}

/** 一个账号的「登录/额度是否有效」：实时 ok，或 stale 但仍有历史快照（非 historyOnly 的历史遗留卡）。 */
function isActiveCodexAccount(provider, windows) {
  if (!provider) return false;
  if (provider.status === 'ok') return true;
  if (provider.status !== 'stale') return false;
  if (provider.historyOnly === true) return false; // 已不在登录/归档列表，只剩历史快照
  return windows.length > 0;
}

/**
 * /api/quota 根字段 codexSummary：多号同登时的账号汇总。
 * 多张 Codex 卡各自独立；这里把每张卡的 accountId/计划/窗口/更新时间收敛成前端可直接消费的一行。
 * active = status ok，或 stale 但有历史额度快照（historyOnly 不算，因为它已不登录）；
 * multi = active >= 2（多号同登判定）。
 */
export function buildCodexSummary(providers = []) {
  const accounts = [];
  let active = 0;
  for (const raw of Array.isArray(providers) ? providers : []) {
    if (!raw || raw.kind !== 'codex') continue;
    const accountId = raw.accountId || accountIdFromHistoryKey(raw.historyKey);
    const provider = decorateCodexProvider(raw, { accountId });
    const windows = (provider.windows || []).map((window) => ({
      key: window.key || null,
      kind: window.kind || 'custom',
      label: window.label || null,
      usedPercent: num(window.usedPercent),
      resetAt: window.resetAt || null
    }));
    // 既拿不到 account_id、也没有任何额度数据的错误占位卡（如登录态文件缺失）不算一个账号；
    // 有 account_id 或历史窗口的都计入，保证汇总行与卡片一一对应。
    if (!accountId && windows.length === 0) continue;
    if (isActiveCodexAccount(provider, windows)) active += 1;
    accounts.push({
      id: accountId,
      name: String(provider.name || '').replace(/^Codex · /, '') || 'Codex',
      plan: provider.plan || null,
      planName: (provider.planMeta && provider.planMeta.name) || null,
      status: typeof provider.status === 'string' ? provider.status : 'error',
      updatedAt: provider.fetchedAt || provider.checkedAt || null,
      windows
    });
  }
  // 同名多号时追加短 accountId，单号保持原名。
  const displayNames = disambiguateNames(accounts);
  return {
    total: accounts.length,
    active,
    multi: active >= 2,
    accounts: accounts.map((account, index) => ({ ...account, name: displayNames.get(index) }))
  };
}

/** 从 daily-history 的 days（或 {days} 对象）收集所有出现过的 codexByAccount 键，含已移除账号的孤儿键。 */
export function collectCodexByAccountKeys(days) {
  const source = days && typeof days === 'object' && days.days && typeof days.days === 'object' ? days.days : days;
  const keys = new Set();
  if (!source || typeof source !== 'object') return [];
  for (const entry of Object.values(source)) {
    const map = entry && entry.codexByAccount;
    if (!map || typeof map !== 'object') continue;
    for (const [key, value] of Object.entries(map)) {
      if (!key) continue;
      if (!(Number(value) > 0)) continue;
      keys.add(String(key));
    }
  }
  return [...keys];
}

/** 孤儿账号（只有 codexByAccount 历史、没有任何账号元信息）的展示名：短 id + 未知账号，不裸 UUID。 */
export function orphanAccountName(accountId) {
  const short = shortAccountId(accountId);
  return '未知账号 · ' + (short || 'codex');
}

/**
 * /api/daily 根字段 codexAccounts：{id,name,planName}，供热力图 tooltip 把 codexByAccount 的 key
 * 还原成账号名。历史快照（codex-history.json）提供已移除账号的名字与计划；当前账号优先用实时名字。
 * days（日存档的 days 或 {days}）里的孤儿键也会补进列表，保证 codexByAccount 键集合 ⊆ codexAccounts id 集合。
 */
export function buildDailyCodexAccounts({ accounts = [], history = null, days = null } = {}) {
  const byId = new Map();
  const historyAccounts = history && history.accounts && typeof history.accounts === 'object' ? history.accounts : {};
  for (const [key, entry] of Object.entries(historyAccounts)) {
    if (!entry || typeof entry !== 'object') continue;
    const id = accountIdFromHistoryKey(key);
    if (!id) continue;
    let planName = null;
    if (typeof planMetaFor === 'function') {
      try {
        const meta = planMetaFor(entry.plan || null);
        planName = (meta && meta.name) || null;
      } catch {
        planName = null;
      }
    }
    byId.set(id, { id, name: entry.name || 'Codex', planName });
  }
  for (const account of Array.isArray(accounts) ? accounts : []) {
    if (!account || !account.id) continue;
    const id = String(account.id);
    const existing = byId.get(id) || null;
    byId.set(id, {
      id,
      name: account.name || (existing && existing.name) || 'Codex',
      planName: (existing && existing.planName) || null
    });
  }
  // G8：孤儿键（有历史每日用量、但当前账号/历史快照都查不到）也要在 codexAccounts 里出现，
  // 否则 tooltip 只能回落裸 UUID。名字用「未知账号 · 短id」，并标 orphan=true 供前端说明。
  const dailyDays = days || (history && history.days && typeof history.days === 'object' ? history.days : null);
  for (const key of collectCodexByAccountKeys(dailyDays)) {
    if (byId.has(key)) continue;
    byId.set(key, { id: key, name: orphanAccountName(key), planName: null, orphan: true });
  }
  // 热力图 tooltip / 分账号区块标题也统一用消歧名（同名多号时加短 accountId）。
  const list = [...byId.values()];
  const displayNames = disambiguateNames(list);
  return list.map((account, index) => ({ ...account, name: displayNames.get(index) }));
}

/**
 * 某一天的 Codex 是否真的采到数据。false 表示「官方按天桶还没更新 / 没采到」，
 * 前端应显示「—」而不是伪造的 0（数据层给出缺失语义，不伪造数字）。
 */
export function codexDayHasData(entry) {
  if (!entry || typeof entry !== 'object') return false;
  if (Number(entry.codexTokens) > 0) return true;
  const map = entry.codexByAccount;
  return Boolean(map && typeof map === 'object' && Object.values(map).some((value) => Number(value) > 0));
}

/** 某天的 Codex 用量：没有采集数据返回 null（前端显示「—」），有数据返回数字。 */
export function codexDayTokensOrNull(entry) {
  return codexDayHasData(entry) ? Number(entry.codexTokens) || 0 : null;
}

/** 读取 Codex 官方账户级累计用量（wham/profiles/me），按 account_id 去重。 */
export async function collectCodexOfficialUsage({ accounts = [], fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const seen = new Set();
  const list = [];
  const failed = [];
  let total = 0;
  let peakDaily = 0;
  let duplicates = 0;
  const daily = new Map();
  // 续期摘要（channel 级，server.mjs mergeCodexLifetime 会保留；accounts 级会被覆盖）
  const refresh = { attempted: 0, refreshed: 0, failed: 0, accounts: [] };

  for (const account of accounts) {
    if (!account || !account.authPath) continue;
    let auth;
    try {
      auth = JSON.parse(await fs.readFile(expandHome(account.authPath), 'utf8'));
    } catch {
      failed.push({ accountId: null, name: account.name || 'Codex', error: '读取登录态失败', refresh: null });
      continue;
    }
    const accountId = auth && auth.tokens && auth.tokens.account_id;
    if (!auth || !auth.tokens || !auth.tokens.access_token) {
      failed.push({ accountId: accountId || null, name: account.name || 'Codex', error: '登录态缺少 access_token', refresh: null });
      continue;
    }
    if (accountId) {
      if (seen.has(accountId)) {
        duplicates += 1;
        continue;
      }
      seen.add(accountId);
    }
    // 只有显式标记为托管（managed）且开启 autoRefresh 的账号才允许续期；live 永不续期。
    const allowRefresh = account.allowRefresh === true && account.live !== true;
    let json;
    let refreshInfo = null;
    try {
      const response = await codexAuthenticatedJson(CODEX_PROFILE_URL, {
        authPath: account.authPath,
        allowRefresh,
        live: account.live === true,
        fetchImpl,
        now
      });
      json = response.json;
      if (response.refresh) {
        refreshInfo = {
          attempted: response.refresh.attempted === true,
          refreshedAt: response.refresh.refreshedAt || null,
          expiresAt: response.refresh.expiresAt || null,
          rotated: response.refresh.rotated === true,
          code: response.refresh.code || null,
          lastError: response.refresh.lastError || null
        };
      }
    } catch (err) {
      let error;
      if (err && err.status === 0) error = (err && err.message) || '网络请求失败';
      else if (err && err.status) error = 'HTTP ' + err.status;
      else error = (err && err.message) || '网络请求失败';
      const errRefresh =
        err && err.refresh
          ? {
              attempted: err.refresh.attempted === true,
              refreshedAt: err.refresh.refreshedAt || null,
              expiresAt: err.refresh.expiresAt || null,
              rotated: err.refresh.rotated === true,
              code: err.refresh.code || null,
              lastError: err.refresh.lastError || null
            }
          : null;
      if (errRefresh && errRefresh.lastError) error += '（自动续期失败：' + errRefresh.lastError + '）';
      failed.push({ accountId: accountId || null, name: account.name || 'Codex', error, refresh: errRefresh });
      if (errRefresh && errRefresh.lastError) {
        refresh.failed += 1;
        refresh.accounts.push({ name: account.name || 'Codex', refreshedAt: null, code: errRefresh.code, lastError: errRefresh.lastError });
      }
      continue;
    }
    if (refreshInfo) {
      if (refreshInfo.attempted) refresh.attempted += 1;
      if (refreshInfo.refreshedAt) refresh.refreshed += 1;
      if (refreshInfo.lastError) refresh.failed += 1;
      if (refreshInfo.refreshedAt || refreshInfo.lastError) {
        refresh.accounts.push({ name: account.name || 'Codex', refreshedAt: refreshInfo.refreshedAt, code: refreshInfo.code, lastError: refreshInfo.lastError });
      }
    }
    const stats = json && json.stats;
    if (!stats) {
      failed.push({ accountId: accountId || null, name: account.name || 'Codex', error: '接口未返回 stats', refresh: refreshInfo });
      continue;
    }
    const lifetime = num(stats.lifetime_tokens) || 0;
    const peak = num(stats.peak_daily_tokens) || 0;
    total += lifetime;
    peakDaily = Math.max(peakDaily, peak);
    const accountDaily = [];
    for (const bucket of stats.daily_usage_buckets || []) {
      if (!bucket || !bucket.start_date) continue;
      const tokens = num(bucket.tokens) || 0;
      daily.set(bucket.start_date, (daily.get(bucket.start_date) || 0) + tokens);
      accountDaily.push({ date: bucket.start_date, tokens });
    }
    list.push({
      id: accountId || null,
      name: account.name || (json.profile && json.profile.display_name) || 'Codex',
      displayName: (json.profile && json.profile.display_name) || null,
      username: (json.profile && json.profile.username) || null,
      lifetimeTokens: lifetime,
      peakDailyTokens: peak,
      daily: accountDaily,
      refresh: refreshInfo
    });
  }

  return {
    total,
    peakDaily,
    accounts: list,
    failed,
    duplicates,
    daily: [...daily.entries()].map(([date, tokens]) => ({ date, tokens })),
    refresh
  };
}

function emptyTokens() {
  return { input: 0, cached: 0, cacheWrite: 0, output: 0, total: 0 };
}

function addTokens(target, source) {
  target.input += Number(source.input || 0);
  target.cached += Number(source.cached || 0);
  target.cacheWrite += Number(source.cacheWrite || 0);
  target.output += Number(source.output || 0);
  target.total += Number(source.total || 0);
}

async function walkFiles(dir, filter, out) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkFiles(full, filter, out);
    } else if (entry.isFile() && filter(entry.name)) {
      out.push(full);
    }
  }
}

/** 从 Codex 本地 rollout 日志统计 token（仅本机，去重同一 response）。 */
export async function collectCodexUsage({ home = os.homedir() } = {}) {
  const roots = [path.join(home, '.codex', 'sessions'), path.join(home, '.codex', 'archived_sessions')];
  const files = [];
  for (const root of roots) await walkFiles(root, (name) => name.endsWith('.jsonl'), files);

  const tokens = emptyTokens();
  const seen = new Set();
  let records = 0;

  for (const file of files) {
    let rl;
    try {
      rl = readline.createInterface({ input: createReadStream(file), crlfDelay: Infinity });
    } catch {
      continue;
    }
    for await (const line of rl) {
      if (!line.includes('token_usage_record')) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry.type !== 'token_usage_record') continue;
      const payload = entry.payload || {};
      const usage = payload.usage;
      if (!usage) continue;
      const responseId = payload.response_id;
      if (responseId) {
        if (seen.has(responseId)) continue;
        seen.add(responseId);
      }
      records += 1;
      addTokens(tokens, {
        input: usage.input_tokens,
        cached: usage.cached_input_tokens,
        cacheWrite: usage.cache_write_input_tokens,
        output: usage.output_tokens,
        total: usage.total_tokens ?? (Number(usage.input_tokens || 0) + Number(usage.output_tokens || 0))
      });
    }
    rl.close();
  }

  return { tokens, records, files: files.length };
}

/** 从 DSH 会话投影缓存统计各 provider 的 token 与本地成本估算（CNY）。 */
export async function collectDshUsage({ home = os.homedir() } = {}) {
  const dir = path.join(home, '.dsh', 'storages', 'session_projcache', 'sessions');
  let files = [];
  try {
    files = (await fs.readdir(dir)).filter((name) => name.endsWith('.json'));
  } catch {
    files = [];
  }

  const channels = {
    deepseek: { tokens: emptyTokens(), costCny: 0, priced: 0, unpriced: 0, sessions: 0, providers: {} },
    opencodeGo: { tokens: emptyTokens(), costCny: 0, priced: 0, unpriced: 0, sessions: 0, providers: {} }
  };

  await Promise.all(
    files.map(async (name) => {
      let record;
      try {
        const raw = await fs.readFile(path.join(dir, name), 'utf8');
        record = JSON.parse(raw);
      } catch {
        return;
      }
      const rows = record && record.record && record.record.rows;
      if (!rows) return;
      const cost = rows.whalePetCost && rows.whalePetCost.val;
      const modelSelection = rows.modelSelection && rows.modelSelection.val;
      const route = (cost && cost.route) || (modelSelection && modelSelection.lastUsed) || {};
      const provider = typeof route.provider === 'string' ? route.provider : '';
      const channel = provider.startsWith('deepseek') ? 'deepseek' : provider.startsWith('opencode') ? 'opencodeGo' : null;
      if (!channel) return;

      const usage = rows.tokenUsage && rows.tokenUsage.val && rows.tokenUsage.val.totals;
      const target = channels[channel];
      if (usage) {
        addTokens(target.tokens, {
          input: usage.uncachedInputTokens,
          cached: usage.cacheReadTokens,
          cacheWrite: usage.cacheWriteTokens,
          output: usage.outputTokens,
          total:
            Number(usage.uncachedInputTokens || 0) +
            Number(usage.cacheReadTokens || 0) +
            Number(usage.cacheWriteTokens || 0) +
            Number(usage.outputTokens || 0)
        });
      }
      if (cost && cost.totals) {
        const total = Number(cost.totals.peakCny || 0) + Number(cost.totals.offPeakCny || 0);
        target.costCny += total;
        target.priced += Number(cost.totals.pricedRequests || 0);
        target.unpriced += Number(cost.totals.unpricedRequests || 0);
      }
      if (usage || cost) target.sessions += 1;
      target.providers[provider] = target.providers[provider] || { sessions: 0, tokens: emptyTokens(), costCny: 0 };
      target.providers[provider].sessions += 1;
      if (cost && cost.totals) {
        target.providers[provider].costCny +=
          Number(cost.totals.peakCny || 0) + Number(cost.totals.offPeakCny || 0);
      }
      if (usage) {
        addTokens(target.providers[provider].tokens, {
          input: usage.uncachedInputTokens,
          cached: usage.cacheReadTokens,
          cacheWrite: usage.cacheWriteTokens,
          output: usage.outputTokens,
          total:
            Number(usage.uncachedInputTokens || 0) +
            Number(usage.cacheReadTokens || 0) +
            Number(usage.cacheWriteTokens || 0) +
            Number(usage.outputTokens || 0)
        });
      }
    })
  );

  return channels;
}

function emptyChannelTokens() {
  return { input: 0, cached: 0, cacheWrite: 0, output: 0, total: 0 };
}

export function buildUsageReport({
  codex,
  dsh,
  codexOfficial = null,
  deepseekOfficial = null,
  deepseekLifetimeTokens = null,
  deepseekArchive = null,
  opencodeSubscriptions = []
}) {
  const deepseek = dsh.deepseek;
  const opencode = dsh.opencodeGo;
  const official = codexOfficial && Array.isArray(codexOfficial.accounts) && codexOfficial.accounts.length > 0;
  const archivedTokens = Number(deepseekArchive?.tokens ?? deepseekLifetimeTokens);
  const hasDeepseekArchive = Number.isFinite(archivedTokens) && archivedTokens > 0;
  const hasDeepseekLogs = deepseek.tokens.total > 0;

  const round2 = (value) => Math.round(value * 100) / 100;

  // 官方累计里，拿不到实时数据的账号（cached=true）只作参考展示，**不计入合计**，
  // 否则一个失效账号的旧快照会长期虚增总量（实测：Outlook 账号失效后仍带 13.39 亿）。
  const codexAccountList = official ? codexOfficial.accounts || [] : [];
  const liveCodexAccounts = codexAccountList.filter((account) => !account.cached);
  const staleCodexAccounts = codexAccountList.filter((account) => account.cached);
  const liveCodexTotal = liveCodexAccounts.reduce((sum, account) => sum + Number(account.lifetimeTokens || 0), 0);
  const staleCodexTotal = staleCodexAccounts.reduce((sum, account) => sum + Number(account.lifetimeTokens || 0), 0);

  // 合计含所有账号（含历史快照），快照只做标注
  const codexTokens = official
    ? { input: null, cached: null, cacheWrite: null, output: null, total: codexOfficial.total }
    : codex.tokens;

  const opencodeSubs = (
    opencodeSubscriptions.length
      ? opencodeSubscriptions
      : [{ id: 'default', name: 'OpenCode Go', provider: 'opencode-go' }]
  ).map((sub) => {
    const entry = (opencode.providers && opencode.providers[sub.provider]) || null;
    return {
      id: sub.id,
      name: sub.name,
      provider: sub.provider,
      tokens: entry ? entry.tokens : emptyChannelTokens(),
      costCny: round2(entry ? Number(entry.costCny || 0) : 0),
      sessions: entry ? entry.sessions : 0
    };
  });

  // 未被任何订阅认领的 opencode* 路由（例如临时用过的 opencode 按量付费路由）
  // 单独归成一项，保证「OpenCode Go 合计 = 各订阅之和 + 其它」不会对不上。
  const knownProviders = new Set(opencodeSubs.map((sub) => sub.provider).filter(Boolean));
  const leftovers = Object.entries(opencode.providers || {}).filter(([provider]) => !knownProviders.has(provider));
  if (leftovers.length) {
    const rest = emptyChannelTokens();
    let restCost = 0;
    let restSessions = 0;
    for (const [, entry] of leftovers) {
      addTokens(rest, entry.tokens);
      restCost += Number(entry.costCny || 0);
      restSessions += Number(entry.sessions || 0);
    }
    opencodeSubs.push({
      id: 'other',
      name: `其它路由（${leftovers.map(([provider]) => provider).join(' / ')}）`,
      provider: null,
      tokens: rest,
      costCny: round2(restCost),
      sessions: restSessions
    });
  }

  const channels = [
    {
      id: 'codex',
      name: 'Codex',
      kind: 'subscription',
      tokens: codexTokens,
      costCny: null,
      sessions: official ? codexOfficial.accounts.length : codex.records,
      source: official ? 'official' : 'local',
      accounts: codexAccountList,
      liveAccounts: liveCodexAccounts.length,
      staleAccounts: staleCodexAccounts.length,
      staleTokens: staleCodexTotal,
      duplicateLogins: official ? codexOfficial.duplicates || 0 : 0,
      refresh: codexOfficial && codexOfficial.refresh ? codexOfficial.refresh : null,
      note: official
        ? staleCodexAccounts.length
          ? `官方账户累计；其中 ${staleCodexAccounts.length} 个账号取的是最后一次成功同步的快照（${(staleCodexTotal / 1e8).toFixed(2)} 亿 token）`
          : '官方账户累计（订阅套餐内，无按量费用）'
        : '本机 Codex 会话日志（可能不完整；订阅套餐内，无按量费用）'
    },
    {
      id: 'deepseek',
      name: 'DeepSeek',
      kind: 'api',
      tokens: hasDeepseekArchive || !hasDeepseekLogs
        ? {
            input: null,
            cached: null,
            cacheWrite: null,
            output: null,
            total: hasDeepseekArchive ? archivedTokens : null
          }
        : deepseek.tokens,
      costCny: deepseekOfficial ? deepseekOfficial.spentCny : hasDeepseekLogs ? round2(deepseek.costCny) : null,
      sessions: deepseekOfficial?.requests30d ?? deepseek.sessions,
      source: hasDeepseekArchive ? 'archive' : hasDeepseekLogs ? 'local' : 'unavailable',
      spentCny: deepseekOfficial?.spentCny ?? null,
      archive: deepseekArchive,
      providers: deepseek.providers,
      note: hasDeepseekArchive
        ? '累计用量来自本机已保存的逐日记录'
        : hasDeepseekLogs ? '用量来自本机会话日志' : '暂无 DeepSeek 归档或会话日志'
    },
    {
      id: 'opencode',
      name: 'OpenCode Go',
      kind: 'subscription',
      tokens: opencode.tokens,
      costCny: round2(opencode.costCny),
      sessions: opencode.sessions,
      providers: opencode.providers,
      subs: opencodeSubs,
      note: 'OpenCode Go 套餐内；多订阅时此项为各订阅之和；金额是按模型价格的等效估算，不是实际扣费'
    }
  ];

  // 「OpenCode Go 合计 = 各订阅之和」：订阅之外残留的 opencode* 路由单独成一项，
  // 不混进 OpenCode Go 的数字里，但仍在总合计中。
  const opencodeChannel = channels.find((channel) => channel.id === 'opencode');
  const subscribedTotal = opencodeSubs
    .filter((sub) => sub.provider)
    .reduce((sum, sub) => sum + Number(sub.tokens.total || 0), 0);
  const leftoverSubs = opencodeSubs.filter((sub) => !sub.provider);
  if (opencodeChannel) {
    const rawTotal = Number(opencodeChannel.tokens && opencodeChannel.tokens.total) || 0;
    const leftoverTotal = leftoverSubs.reduce((sum, sub) => sum + Number(sub.tokens.total || 0), 0);
    // 正常情况「订阅之和 + 其它路由 = 原始合计」；若 provider 映射对不上（例如历史数据没有
    // provider 字段、或测试里没有 providers 明细），退回原始合计，避免把总数算成 0。
    const mappedTotal = subscribedTotal + leftoverTotal;
    const finalTotal = mappedTotal > 0 || rawTotal === 0 ? mappedTotal : rawTotal;
    opencodeChannel.tokens = { ...opencodeChannel.tokens, total: finalTotal };
  }
  if (leftoverSubs.length) {
    const leftoverTokens = leftoverSubs.reduce((sum, sub) => sum + Number(sub.tokens.total || 0), 0);
    const leftoverCost = leftoverSubs.reduce((sum, sub) => sum + Number(sub.costCny || 0), 0);
    channels.push({
      id: 'opencode-other',
      name: 'OpenCode 其它路由',
      kind: 'subscription',
      tokens: { input: null, cached: null, cacheWrite: null, output: null, total: leftoverTokens },
      costCny: round2(leftoverCost),
      sessions: leftoverSubs.reduce((sum, sub) => sum + Number(sub.sessions || 0), 0),
      note: '不在任何 Go 订阅名下（例如临时用过的按量付费 opencode 路由），未计入 OpenCode Go'
    });
  }

  const totalTokens = channels.reduce((sum, channel) => sum + Number(channel.tokens.total || 0), 0);
  return {
    generatedAt: new Date().toISOString(),
    totalTokens,
    channels
  };
}

export async function collectUsage({
  home = os.homedir(),
  codexAccounts = [],
  deepseekOfficial = null,
  deepseekLifetimeTokens = null,
  deepseekArchive = null,
  opencodeSubscriptions = []
} = {}) {
  const [codex, dsh, codexOfficial] = await Promise.all([
    collectCodexUsage({ home }),
    collectDshUsage({ home }),
    codexAccounts.length
      ? collectCodexOfficialUsage({ accounts: codexAccounts })
      : Promise.resolve({ total: 0, peakDaily: 0, accounts: [], duplicates: 0, daily: [] })
  ]);
  return buildUsageReport({ codex, dsh, codexOfficial, deepseekOfficial, deepseekLifetimeTokens, deepseekArchive, opencodeSubscriptions });
}

/** 从 DSH 会话按天聚合 DeepSeek / OpenCode Go 的 token 与成本。 */
export async function collectDshDaily({ home = os.homedir(), opencodeProviders = [] } = {}) {
  const dir = path.join(home, '.dsh', 'storages', 'session_projcache', 'sessions');
  let files = [];
  try {
    files = (await fs.readdir(dir)).filter((name) => name.endsWith('.json'));
  } catch {
    files = [];
  }
  const series = new Map();

  for (const name of files) {
    let record;
    try {
      record = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8'));
    } catch {
      continue;
    }
    const rows = record && record.record && record.record.rows;
    const identity = record && record.record && record.record.identity;
    if (!rows || !identity || !identity.createdAt) continue;
    const cost = rows.whalePetCost && rows.whalePetCost.val;
    const modelSelection = rows.modelSelection && rows.modelSelection.val;
    const route = (cost && cost.route) || (modelSelection && modelSelection.lastUsed) || {};
    const provider = typeof route.provider === 'string' ? route.provider : '';
    const channel = provider.startsWith('deepseek')
      ? 'deepseek'
      : provider.startsWith('opencode')
        ? opencodeProviders.length && !opencodeProviders.includes(provider)
          ? 'opencodeOther'
          : 'opencode'
        : null;
    if (!channel) continue;
    const usage = rows.tokenUsage && rows.tokenUsage.val && rows.tokenUsage.val.totals;
    const tokens = usage
      ? Number(usage.uncachedInputTokens || 0) +
        Number(usage.cacheReadTokens || 0) +
        Number(usage.cacheWriteTokens || 0) +
        Number(usage.outputTokens || 0)
      : 0;
    const costCny = cost && cost.totals ? Number(cost.totals.peakCny || 0) + Number(cost.totals.offPeakCny || 0) : 0;
    const date = usageDay(identity.createdAt);
    if (!series.has(date)) {
      series.set(date, {
        date,
        deepseekTokens: 0,
        deepseekCostCny: 0,
        opencodeTokens: 0,
        opencodeCostCny: 0,
        opencodeOtherTokens: 0,
        opencodeOtherCostCny: 0,
        opencodeByProvider: {}
      });
    }
    const entry = series.get(date);
    if (channel === 'deepseek') {
      entry.deepseekTokens += tokens;
      entry.deepseekCostCny += costCny;
    } else if (channel === 'opencodeOther') {
      entry.opencodeOtherTokens += tokens;
      entry.opencodeOtherCostCny += costCny;
    } else {
      entry.opencodeTokens += tokens;
      entry.opencodeCostCny += costCny;
      if (provider) {
        const key = String(provider);
        entry.opencodeByProvider[key] = (entry.opencodeByProvider[key] || 0) + tokens;
      }
    }
  }
  return series;
}

export async function collectDailyUsage({
  home = os.homedir(),
  codexAccounts = [],
  days = 30,
  deepseekDaily = null,
  opencodeProviders = [],
  fetchImpl = globalThis.fetch,
  now = Date.now(),
  // { [accountId]: { name, fetchedAt, daily: [{date, tokens}] } } —— 失效账号的历史按天快照
  codexDailySnapshots = {}
} = {}) {
  const [codexOfficial, dshSeries] = await Promise.all([
    codexAccounts.length
      ? collectCodexOfficialUsage({ accounts: codexAccounts, fetchImpl })
      : Promise.resolve({ daily: [], accounts: [], failed: [], total: 0, duplicates: 0, refresh: null }),
    collectDshDaily({ home, opencodeProviders })
  ]);

  // 失效账号（拿不到实时按天数据）用上次成功同步的快照补上，保证热力图是「所有账号之和」
  const staleCodex = [];
  const freshSnapshots = {};
  for (const account of codexOfficial.accounts || []) {
    if (!account.id) continue;
    freshSnapshots[account.id] = {
      name: account.name || account.displayName || 'Codex',
      fetchedAt: new Date().toISOString(),
      daily: (account.daily || []).map((item) => ({ date: item.date, tokens: Number(item.tokens) || 0 }))
    };
  }
  for (const miss of codexOfficial.failed || []) {
    const key = miss.accountId;
    const snap = key ? codexDailySnapshots[key] : null;
    if (!snap || !Array.isArray(snap.daily) || !snap.daily.length) {
      staleCodex.push({ name: miss.name, noData: true, error: miss.error, refresh: miss.refresh || null });
      continue;
    }
    for (const item of snap.daily) {
      if (!item || !item.date) continue;
      codexOfficial.daily.push({ date: item.date, tokens: Number(item.tokens) || 0 });
    }
    // 快照原样保留，避免被“空结果”覆盖
    if (key) freshSnapshots[key] = snap;
    staleCodex.push({ name: miss.name, noData: false, fetchedAt: snap.fetchedAt, error: miss.error, refresh: miss.refresh || null });
  }

  const series = new Map();
  const ensure = (date) => {
    if (!series.has(date)) {
      series.set(date, {
        date,
        codexTokens: 0,
        codexByAccount: {},
        deepseekTokens: 0,
        deepseekCostCny: 0,
        opencodeTokens: 0,
        opencodeCostCny: 0,
        opencodeOtherTokens: 0,
        opencodeOtherCostCny: 0
      });
    }
    return series.get(date);
  };

  for (const bucket of codexOfficial.daily || []) {
    ensure(bucket.date).codexTokens += Number(bucket.tokens || 0);
  }
  // Codex 明细：按账号记，方便以后只看某个账号或账号被移除后仍能追溯
  for (const account of codexOfficial.accounts || []) {
    if (!account || !account.daily) continue;
    const key = account.id || account.name || 'codex';
    for (const item of account.daily) {
      if (!item || !item.date) continue;
      const target = ensure(item.date);
      if (!target.codexByAccount) target.codexByAccount = {};
      target.codexByAccount[key] = (target.codexByAccount[key] || 0) + (Number(item.tokens) || 0);
    }
  }
  for (const [date, entry] of dshSeries) {
    const target = ensure(date);
    // 先用本机日志兜底（官方只给最近 30 天，更早的日子靠它）
    target.deepseekTokens += entry.deepseekTokens;
    target.deepseekCostCny += entry.deepseekCostCny;
    target.opencodeTokens += entry.opencodeTokens;
    target.opencodeCostCny += entry.opencodeCostCny;
    if (entry.opencodeByProvider) {
      for (const [provider, tokens] of Object.entries(entry.opencodeByProvider)) {
        const current = target.opencodeByProvider || (target.opencodeByProvider = {});
        current[provider] = (current[provider] || 0) + tokens;
      }
    }
    target.opencodeOtherTokens += entry.opencodeOtherTokens;
    target.opencodeOtherCostCny += entry.opencodeOtherCostCny;
  }
  if (Array.isArray(deepseekDaily)) {
    for (const day of deepseekDaily) {
      if (!day || !day.date) continue;
      const target = ensure(day.date);
      if (Number.isFinite(day.tokens)) target.deepseekTokens = day.tokens;
      if (Number.isFinite(day.costCny)) target.deepseekCostCny = day.costCny;
    }
  }

  const dates = calendarDayRange(usageDay(now), days);
  const emptyDay = (date) => ({
    date,
    codexTokens: 0,
    deepseekTokens: 0,
    deepseekCostCny: 0,
    opencodeTokens: 0,
    opencodeCostCny: 0,
    opencodeOtherTokens: 0,
    opencodeOtherCostCny: 0
  });
  const sorted = dates.map((date) => {
    const entry = series.get(date);
    if (!entry) return emptyDay(date);
    return {
      ...entry,
      deepseekCostCny: Math.round(entry.deepseekCostCny * 100) / 100,
      opencodeCostCny: Math.round(entry.opencodeCostCny * 100) / 100,
      opencodeOtherCostCny: Math.round(entry.opencodeOtherCostCny * 100) / 100
    };
  });

  const totals = sorted.reduce(
    (acc, entry) => ({
      codexTokens: acc.codexTokens + entry.codexTokens,
      deepseekTokens: acc.deepseekTokens + entry.deepseekTokens,
      deepseekCostCny: Math.round((acc.deepseekCostCny + entry.deepseekCostCny) * 100) / 100,
      opencodeTokens: acc.opencodeTokens + entry.opencodeTokens,
      opencodeCostCny: Math.round((acc.opencodeCostCny + entry.opencodeCostCny) * 100) / 100,
      opencodeOtherTokens: acc.opencodeOtherTokens + entry.opencodeOtherTokens,
      opencodeOtherCostCny: Math.round((acc.opencodeOtherCostCny + entry.opencodeOtherCostCny) * 100) / 100
    }),
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
    days,
    series: sorted,
    totals,
    deepseekSource: deepseekDaily?.some((day) => Number.isFinite(day?.tokens)) ? 'official' : 'local',
    codexAccounts: (codexOfficial.accounts || []).map((account) => ({
      id: account.id,
      name: account.name || account.displayName || 'Codex',
      lifetimeTokens: account.lifetimeTokens
    })),
    codexStale: staleCodex,
    codexDailySnapshots: freshSnapshots
  };
}

