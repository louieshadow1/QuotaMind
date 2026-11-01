/**
 * 每日用量长期保存：把每次采集到的按天数据合并进 data/daily-history.json。
 *
 * 背景：
 * - DeepSeek 官方只给最近 30 天的按天数据，过了就查不到了；
 * - Codex 官方 daily_usage_buckets 也只覆盖一段窗口；
 * - OpenCode Go 靠本机 DSH 日志，日志轮转/清理后会丢历史。
 * 所以需要「采集一次就存一次」，之后界面上的历史不再依赖数据源是否还在。
 *
 * 合并规则：
 * - 各字段取 **max(已有, 新值)**：token 消耗只增不减，官方偶发返回不完整/0 时不会把历史抹掉；
 * - 不删除任何一天（除非用户手动删 data 目录）；
 * - 同一天重复采集是幂等的。
 */

export const DAILY_HISTORY_VERSION = 1;
export const DAILY_FIELDS = [
  'codexTokens',
  'deepseekTokens',
  'deepseekCostCny',
  'opencodeTokens',
  'opencodeCostCny',
  'opencodeOtherTokens',
  'opencodeOtherCostCny'
];

/** 明细字段（对象 map）：按账号 / 按订阅记住每天各自用了多少，取消订阅后历史仍然可查。 */
export const DAILY_MAP_FIELDS = ['codexByAccount', 'opencodeByProvider'];

function cleanMap(value) {
  const out = {};
  if (!value || typeof value !== 'object') return out;
  for (const [key, raw] of Object.entries(value)) {
    const num = Number(raw);
    if (!Number.isFinite(num) || num <= 0) continue;
    out[String(key).slice(0, 80)] = Math.round(num);
  }
  return out;
}

export function emptyHistory() {
  return { version: DAILY_HISTORY_VERSION, updatedAt: null, days: {} };
}

/** 把文件里读出来的内容规整成可用结构（容忍手工改坏/旧版本）。 */
export function normalizeHistory(raw) {
  const out = emptyHistory();
  if (!raw || typeof raw !== 'object') return out;
  out.updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : null;
  const days = raw.days && typeof raw.days === 'object' ? raw.days : {};
  for (const [date, entry] of Object.entries(days)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !entry || typeof entry !== 'object') continue;
    const day = { date };
    for (const field of DAILY_FIELDS) {
      const value = Number(entry[field]);
      if (Number.isFinite(value) && value > 0) day[field] = value;
    }
    for (const field of DAILY_MAP_FIELDS) {
      const map = cleanMap(entry[field]);
      if (Object.keys(map).length) day[field] = map;
    }
    if (Object.keys(day).length > 1) out.days[date] = day;
  }
  return out;
}

/**
 * 合并一天的采集结果。
 * @param {object|null} existing 已保存的这一天
 * @param {object} incoming 本次采集到的这一天（字段同上，可缺省）
 * @returns {{day: object, changed: boolean}}
 */
export function mergeDay(existing, incoming) {
  const merged = { date: incoming && incoming.date ? incoming.date : existing && existing.date };
  let changed = false;
  for (const field of DAILY_FIELDS) {
    const prev = Number(existing && existing[field]);
    const next = Number(incoming && incoming[field]);
    const prevValue = Number.isFinite(prev) ? prev : 0;
    const nextValue = Number.isFinite(next) ? next : 0;
    const value = Math.max(prevValue, nextValue);
    if (value > 0) merged[field] = value;
    if (value > prevValue) changed = true;
  }
  for (const field of DAILY_MAP_FIELDS) {
    const prevMap = cleanMap(existing && existing[field]);
    const nextMap = cleanMap(incoming && incoming[field]);
    const mergedMap = { ...prevMap };
    for (const [key, num] of Object.entries(nextMap)) {
      if (num > (mergedMap[key] || 0)) {
        mergedMap[key] = num;
        changed = true;
      }
    }
    if (Object.keys(mergedMap).length) merged[field] = mergedMap;
  }
  return { day: merged, changed };
}

/**
 * 把一批采集结果并入历史（就地修改 history），返回变化摘要。
 * @param {{days: object}} history normalizeHistory 之后的对象
 * @param {Array<{date: string}>} series 采集到的按天数据
 */
export function mergeSeriesIntoHistory(history, series) {
  const summary = { addedDays: 0, updatedDays: 0, skipped: 0 };
  for (const entry of series || []) {
    const date = entry && entry.date;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      summary.skipped += 1;
      continue;
    }
    const existing = history.days[date] || null;
    const { day, changed } = mergeDay(existing, entry);
    if (Object.keys(day).length <= 1) {
      summary.skipped += 1;
      continue;
    }
    if (!existing) summary.addedDays += 1;
    else if (changed) summary.updatedDays += 1;
    history.days[date] = day;
  }
  if (summary.addedDays || summary.updatedDays) history.updatedAt = new Date().toISOString();
  return summary;
}

/** 历史覆盖范围。 */
export function historyRange(history) {
  const dates = Object.keys(history && history.days ? history.days : {}).sort();
  return {
    days: dates.length,
    firstDate: dates[0] || null,
    lastDate: dates[dates.length - 1] || null
  };
}

/**
 * 按天生成最近 days 天的序列（日期连续，缺的补 0），用于接口返回与前端绘图。
 * @param {{days: object}} history
 * @param {number} days
 * @param {(ms: number) => string} localDateOf 本地日期格式化（避免时区偏移）
 */
export function buildSeriesFromHistory(history, days, localDateOf) {
  const total = Math.max(1, Math.min(3650, Number(days) || 371));
  const now = Date.now();
  const out = [];
  for (let offset = total - 1; offset >= 0; offset -= 1) {
    const date = localDateOf(now - offset * 86400000);
    const saved = history.days[date];
    out.push({
      date,
      codexTokens: saved && saved.codexTokens ? saved.codexTokens : 0,
      codexByAccount: (saved && saved.codexByAccount) || {},
      opencodeByProvider: (saved && saved.opencodeByProvider) || {},
      deepseekTokens: saved && saved.deepseekTokens ? saved.deepseekTokens : 0,
      deepseekCostCny: saved && saved.deepseekCostCny ? saved.deepseekCostCny : 0,
      opencodeTokens: saved && saved.opencodeTokens ? saved.opencodeTokens : 0,
      opencodeCostCny: saved && saved.opencodeCostCny ? saved.opencodeCostCny : 0,
      opencodeOtherTokens: saved && saved.opencodeOtherTokens ? saved.opencodeOtherTokens : 0,
      opencodeOtherCostCny: saved && saved.opencodeOtherCostCny ? saved.opencodeOtherCostCny : 0
    });
  }
  return out;
}

/** 支持导入的渠道 → 落到存档里的字段名 */
export const IMPORT_CHANNELS = {
  codex: { tokensField: 'codexTokens', costField: null },
  deepseek: { tokensField: 'deepseekTokens', costField: 'deepseekCostCny' },
  opencode: { tokensField: 'opencodeTokens', costField: 'opencodeCostCny' },
  opencodeOther: { tokensField: 'opencodeOtherTokens', costField: 'opencodeOtherCostCny' }
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidDate(text) {
  if (!DATE_RE.test(text)) return false;
  const [y, m, d] = text.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/**
 * 解析导入内容（CSV 或 JSON）。
 * CSV：每行 `date,tokens[,cost]`，允许有表头（含 date/tokens 等字样时自动跳过）；
 * JSON：[{ date, tokens, costCny }] 或 [{ date, codexTokens, ... }]（已按渠道字段给全也可）。
 * @returns {{ rows: Array<object>, errors: string[] }}
 */
export function parseImportData(channel, raw) {
  const conf = IMPORT_CHANNELS[channel];
  if (!conf) return { rows: [], errors: ['未知渠道：' + channel] };
  const errors = [];
  const rows = [];
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) {
    if (Array.isArray(raw)) return parseJsonRows(raw, channel, conf, errors);
    return { rows: [], errors: ['内容为空'] };
  }

  if (text.startsWith('[') || text.startsWith('{')) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      return { rows: [], errors: ['JSON 解析失败：' + err.message] };
    }
    const list = Array.isArray(parsed) ? parsed : parsed.days || parsed.rows || [];
    return parseJsonRows(list, channel, conf, errors);
  }

  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const [index, line] of lines.entries()) {
    if (index === 0 && /date|日期|tokens|用量/i.test(line)) continue; // 表头
    const cells = line.split(/[,\t;]/).map((cell) => cell.trim());
    if (cells.length < 2) {
      errors.push('第 ' + (index + 1) + ' 行：至少需要 date,tokens 两列');
      continue;
    }
    const date = cells[0];
    const tokens = Number(cells[1]);
    const cost = cells[2] === undefined || cells[2] === '' ? null : Number(cells[2]);
    if (!isValidDate(date)) {
      errors.push('第 ' + (index + 1) + ' 行：日期格式应为 YYYY-MM-DD（收到 ' + date + '）');
      continue;
    }
    if (!Number.isFinite(tokens) || tokens < 0) {
      errors.push('第 ' + (index + 1) + ' 行：tokens 必须是非负数字');
      continue;
    }
    if (cost !== null && (!Number.isFinite(cost) || cost < 0)) {
      errors.push('第 ' + (index + 1) + ' 行：费用必须是非负数字');
      continue;
    }
    const row = { date };
    if (tokens > 0) row[conf.tokensField] = Math.round(tokens);
    if (cost !== null && conf.costField) row[conf.costField] = cost;
    rows.push(row);
  }
  return { rows, errors };
}

function parseJsonRows(list, channel, conf, errors) {
  if (!Array.isArray(list)) return { rows: [], errors: ['JSON 应为数组'] };
  const rows = [];
  for (const [index, item] of list.entries()) {
    if (!item || typeof item !== 'object') {
      errors.push('第 ' + (index + 1) + ' 条：不是对象');
      continue;
    }
    const date = item.date || item.day;
    if (!date || !isValidDate(String(date))) {
      errors.push('第 ' + (index + 1) + ' 条：日期无效（' + date + '）');
      continue;
    }
    const row = { date: String(date) };
    // 支持两种写法：直接写渠道字段，或写通用 tokens/costCny
    const directTokens = item[conf.tokensField];
    const genericTokens = item.tokens !== undefined ? item.tokens : item.tokensTotal;
    const tokens = directTokens !== undefined ? directTokens : genericTokens;
    if (tokens !== undefined) {
      const value = Number(tokens);
      if (!Number.isFinite(value) || value < 0) {
        errors.push('第 ' + (index + 1) + ' 条：tokens 必须是非负数字');
        continue;
      }
      if (value > 0) row[conf.tokensField] = Math.round(value);
    }
    if (conf.costField) {
      const directCost = item[conf.costField];
      const genericCost = item.costCny !== undefined ? item.costCny : item.cost;
      const cost = directCost !== undefined ? directCost : genericCost;
      if (cost !== undefined) {
        const value = Number(cost);
        if (!Number.isFinite(value) || value < 0) {
          errors.push('第 ' + (index + 1) + ' 条：费用必须是非负数字');
          continue;
        }
        if (value > 0) row[conf.costField] = value;
      }
    }
    if (Object.keys(row).length > 1) rows.push(row);
  }
  return { rows, errors };
}