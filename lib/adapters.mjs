import { promises as fs } from 'node:fs';
import { expandHome } from './config.mjs';

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
export const OPENCODE_GO_USAGE_URL = 'https://opencode.ai/zen/go/v1/usage';

export const RELAY_TYPES = ['newapi-account', 'newapi-token', 'sub2api', 'generic'];

function num(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function toIso(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value < 1e12 ? value * 1000 : value;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof value === 'string') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

function redact(text, secrets = []) {
  let out = String(text ?? '');
  for (const secret of secrets) {
    if (secret && String(secret).length >= 6) out = out.split(String(secret)).join('***');
  }
  return out;
}

export async function httpJson(url, options = {}) {
  const {
    method = 'GET',
    headers = {},
    body,
    timeoutMs = 12000,
    fetchImpl = globalThis.fetch,
    secrets = []
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
    throw new HttpError(0, `网络请求失败：${redact(err && err.message ? err.message : err, secrets)}`);
  }
  const text = await res.text().catch(() => '');
  if (res.status >= 300 && res.status < 400) {
    throw new HttpError(res.status, `上游返回重定向（HTTP ${res.status}），已拒绝跟随`);
  }
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  if (!res.ok) {
    const detail = json && json.error && json.error.message ? `：${json.error.message}` : '';
    throw new HttpError(res.status, `上游返回 HTTP ${res.status}${detail}`, redact(text.slice(0, 300), secrets));
  }
  if (json === null) {
    throw new HttpError(res.status, '上游返回的不是 JSON', redact(text.slice(0, 200), secrets));
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

function providerBase(relay) {
  let base = String(relay.baseUrl || '').trim().replace(/\/+$/, '');
  base = base.replace(/\/v1$/i, '');
  if (!/^https?:\/\//i.test(base)) {
    throw new UnconfiguredError('站点地址必须是以 http:// 或 https:// 开头的完整地址');
  }
  return base;
}

export async function fetchCodexUsage({ name = 'Codex 账户', authPath, fetchImpl = globalThis.fetch } = {}) {
  const file = expandHome(authPath || '~/.codex/auth.json');
  const auth = await readOptionalJson(file);
  if (!auth) {
    throw new UnconfiguredError(`未找到 Codex 登录态：${file}（先在 Codex 或 Codex 订阅插件里登录）`);
  }
  const token = auth.tokens && auth.tokens.access_token;
  if (!token) {
    throw new UnconfiguredError('Codex 登录态中没有 access_token（可能是 API Key 模式，无法读取套餐额度）');
  }
  const accountId = auth.tokens && auth.tokens.account_id;
  const headers = { Authorization: `Bearer ${token}` };
  if (accountId) headers['ChatGPT-Account-Id'] = String(accountId);

  const { json } = await httpJson(CODEX_USAGE_URL, {
    headers,
    fetchImpl,
    secrets: [token, accountId]
  });

  const root = json && json.data && typeof json.data === 'object' ? json.data : json;
  const rate = root.rate_limit || root.rate_limits || root;
  const windows = [];

  const pushWindow = (raw, key, label, expectedSeconds) => {
    if (!raw || typeof raw !== 'object') return;
    const used = num(raw.used_percent);
    let resetAt = toIso(raw.reset_at ?? raw.resets_at);
    if (!resetAt) {
      const after = num(raw.reset_after_seconds);
      if (after !== null) resetAt = new Date(Date.now() + after * 1000).toISOString();
    }
    const seconds = num(raw.limit_window_seconds) ?? expectedSeconds;
    windows.push({ key, label, usedPercent: used, resetAt, windowSeconds: seconds });
  };

  pushWindow(rate.primary_window || rate.primary, '5h', '5 小时', 18000);
  pushWindow(rate.secondary_window || rate.secondary, 'weekly', '每周', 604800);

  const extras = rate.additional_rate_limits || root.additional_rate_limits;
  if (Array.isArray(extras)) {
    extras.forEach((extra, index) => {
      if (!extra || typeof extra !== 'object') return;
      const label = extra.display_name || extra.name || extra.metered_feature || `附加额度 ${index + 1}`;
      const raw = extra.rate_limit && typeof extra.rate_limit === 'object' ? extra.rate_limit : extra;
      pushWindow(raw, `extra:${label}`, String(label), null);
    });
  }

  if (!windows.length) {
    throw new HttpError(200, '额度接口有返回，但没解析到 5h/周窗口（接口结构可能已变化）');
  }

  const plan =
    (typeof root.plan_type === 'string' && root.plan_type) ||
    (typeof root.plan === 'string' && root.plan) ||
    (typeof json.plan_type === 'string' && json.plan_type) ||
    null;

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
    credits,
    fetchedAt: new Date().toISOString(),
    windows,
    notes: []
  };
}

/** DeepSeek 官方余额（API Key）：GET /user/balance。 */
export async function fetchDeepSeekBalance({ key, fetchImpl = globalThis.fetch } = {}) {
  if (!key) throw new UnconfiguredError('未配置 DeepSeek API Key');
  const { json } = await httpJson('https://api.deepseek.com/user/balance', {
    headers: { Authorization: `Bearer ${key}` },
    fetchImpl,
    secrets: [key]
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
    fetchImpl,
    secrets: [token]
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
  let tokens30d = 0;
  let requests30d = 0;
  let cost30d = 0;
  const dailyMap = new Map();
  const ensureDay = (date) => {
    if (!dailyMap.has(date)) dailyMap.set(date, { date, tokens: 0, requests: 0, costCny: 0 });
    return dailyMap.get(date);
  };
  const dateOfBucket = (timeSeconds) => new Date((Number(timeSeconds) + tz) * 1000).toISOString().slice(0, 10);
  const notes = [];
  try {
    const amount = await httpJson(
      `https://platform.deepseek.com/api/v0/usage/by_api_key/amount?start=${start}&end=${end}&tz=${tz}`,
      { headers, fetchImpl, secrets: [token] }
    );
    const amountData = amount.json && amount.json.data && amount.json.data.biz_data;
    for (const series of (amountData && amountData.series) || []) {
      for (const bucket of (series && series.buckets) || []) {
        const usage = bucket && bucket.usage;
        if (!usage) continue;
        const tokens =
          Number(usage.PROMPT_CACHE_HIT_TOKEN || 0) +
          Number(usage.PROMPT_CACHE_MISS_TOKEN || 0) +
          Number(usage.RESPONSE_TOKEN || 0) +
          Number(usage.THINKING_TOKEN || 0);
        const requests = Number(usage.REQUEST || 0);
        tokens30d += tokens;
        requests30d += requests;
        if (bucket.time) {
          const day = ensureDay(dateOfBucket(bucket.time));
          day.tokens += tokens;
          day.requests += requests;
        }
      }
    }
    const cost = await httpJson(
      `https://platform.deepseek.com/api/v0/usage/by_api_key/cost?start=${start}&end=${end}&tz=${tz}`,
      { headers, fetchImpl, secrets: [token] }
    );
    const costData = cost.json && cost.json.data && cost.json.data.biz_data;
    const cny = ((costData && costData.data) || []).find((item) => item && item.currency === 'CNY');
    for (const series of (cny && cny.series) || []) {
      for (const bucket of (series && series.buckets) || []) {
        const amount = Number((bucket && bucket.cost) || 0);
        cost30d += amount;
        if (bucket.time) ensureDay(dateOfBucket(bucket.time)).costCny += amount;
      }
    }
  } catch {
    notes.push('近 30 天官方用量接口暂时不可用（余额与累计消费仍有效）');
  }

  if (spentCny !== null) notes.unshift(`累计消费 ¥${spentCny.toFixed(2)}`);
  if (tokens30d || cost30d) {
    notes.push(
      `近 30 天：¥${cost30d.toFixed(2)} · ${(tokens30d / 1e8).toFixed(2)} 亿 tokens · ${requests30d} 次请求`
    );
  }

  return {
    id: 'deepseek-platform',
    name: 'DeepSeek 平台',
    kind: 'deepseek-platform',
    status: 'ok',
    plan: null,
    fetchedAt: new Date().toISOString(),
    spentCny,
    cost30dCny: Math.round(cost30d * 100) / 100,
    tokens30d,
    requests30d,
    lifetimeTokensEstimate:
      cost30d > 0 && tokens30d > 0 && spentCny !== null
        ? Math.round((tokens30d / cost30d) * spentCny)
        : tokens30d,
    daily: [...dailyMap.values()]
      .filter((day) => day.tokens || day.costCny)
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((day) => ({ ...day, costCny: Math.round(day.costCny * 100) / 100 })),
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
    fetchImpl,
    secrets: [key]
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
    const status = typeof raw.status === 'string' ? raw.status : 'ok';
    let used = num(raw.percent);
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

export async function fetchNewApiAccount({ relay, token, quotaPerUsd, fetchImpl = globalThis.fetch } = {}) {
  if (!token) throw new UnconfiguredError('缺少访问令牌');
  if (!relay.userId) throw new UnconfiguredError('缺少 New-Api-User（站点用户 ID）');
  const base = providerBase(relay);
  const { json } = await httpJson(`${base}/api/user/self`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'New-Api-User': String(relay.userId),
      'Content-Type': 'application/json'
    },
    fetchImpl,
    secrets: [token]
  });
  if (json && json.success === false) {
    throw new HttpError(200, `站点拒绝查询：${json.message || 'success=false'}`);
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

export async function fetchNewApiToken({ relay, token, quotaPerUsd, fetchImpl = globalThis.fetch } = {}) {
  if (!token) throw new UnconfiguredError('缺少 API Key');
  const base = providerBase(relay);
  const { json } = await httpJson(`${base}/api/usage/token`, {
    headers: { Authorization: `Bearer ${token}` },
    fetchImpl,
    secrets: [token]
  });
  if (json && json.success === false) {
    throw new HttpError(200, `站点拒绝查询：${json.message || 'success=false'}`);
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

export async function fetchSub2Api({ relay, token, fetchImpl = globalThis.fetch } = {}) {
  if (!token) throw new UnconfiguredError('缺少 API Key');
  const base = providerBase(relay);
  const { json } = await httpJson(`${base}/v1/usage`, {
    headers: { Authorization: `Bearer ${token}` },
    fetchImpl,
    secrets: [token]
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

export async function fetchGenericRelay({ relay, token, fetchImpl = globalThis.fetch } = {}) {
  const extract = relay.extract || {};
  if (!relay.url && !relay.baseUrl) throw new UnconfiguredError('缺少查询 URL');
  const rawUrl = relay.url || relay.baseUrl;
  if (!/^https?:\/\//i.test(String(rawUrl))) throw new UnconfiguredError('查询 URL 必须以 http:// 或 https:// 开头');
  const headers = { ...(relay.headers || {}) };
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === 'string') headers[name] = value.replace(/\{\{\s*token\s*\}\}/gi, token || '');
  }
  if (token && !Object.keys(headers).some((name) => name.toLowerCase() === 'authorization')) {
    headers.Authorization = `Bearer ${token}`;
  }
  const { json } = await httpJson(rawUrl, { headers, fetchImpl, secrets: [token] });
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

export async function fetchRelay({ relay, token, quotaPerUsd, fetchImpl = globalThis.fetch } = {}) {
  switch (relay.type) {
    case 'newapi-account':
      return fetchNewApiAccount({ relay, token, quotaPerUsd, fetchImpl });
    case 'newapi-token':
      return fetchNewApiToken({ relay, token, quotaPerUsd, fetchImpl });
    case 'sub2api':
      return fetchSub2Api({ relay, token, fetchImpl });
    case 'generic':
      return fetchGenericRelay({ relay, token, fetchImpl });
    default:
      throw new UnconfiguredError(`未知的中转站类型：${relay.type}`);
  }
}
