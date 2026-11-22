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
 * - 各字段取 max(已有, 新值)：token 消耗只增不减，官方偶发返回不完整/0 时不会把历史抹掉；
 * - 不删除任何一天（除非用户手动删 data 目录）；
 * - 同一天重复采集是幂等的。
 *
 * F4 健壮性（P1-06/07/08/09）：
 * - 读：损坏 JSON 先备份为 daily-history.corrupt-<ts>.json 再重建，返回 warning（不静默覆盖）；
 * - 读：日期必须真实存在（日历校验）且在 [2020-01-01, 今天+1]，越界丢弃并计数；
 * - 读/写：数值有上限（tokens <= 1e13、cost <= 1e9、requests <= 1e9），负数/NaN/Infinity/null 丢弃；
 * - 写：tmp + rename 原子写，失败抛 HISTORY_WRITE_FAILED，绝不吞错；
 * - 导入：importDays() 用进程内锁串行化「读-改-写」，并发导入不丢天（配合 P1-03）；
 * - 统计字段（warnings/dropped）挂在返回对象上但不可枚举，不会被写回 JSON。
 *
 * G5（P2/P3）：
 * - 跨进程：写路径在进程内锁之外再套 lib/file-lock.mjs 的 withFileLock（<file>.lock，O_EXCL，
 *   staleMs 后回收崩溃残留），多进程/多实例同时导入也不会丢天；
 * - 导入错误：最多回传 MAX_IMPORT_ERRORS(100) 条（不再只回 20 条），并带 errorsTruncated 标记；
 * - 同日多条/重复日期：mergeImportRows() 明确按字段 max 合并（与存档 merge 语义一致），结果与顺序无关。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { withFileLock, FILE_LOCK_TIMEOUT } from './file-lock.mjs';

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

/** 允许写入存档的最早日期。 */
export const HISTORY_DATE_MIN = '2020-01-01';
/** 数值上限：token 字段 / 成本字段 / 请求数字段。 */
export const LIMITS = Object.freeze({ tokens: 1e13, cost: 1e9, requests: 1e9 });
/** 读文件时可能的告警代码（供 server 透传给前端）。 */
export const HISTORY_WARNINGS = Object.freeze({
  corrupt: 'corrupt-json',
  normalized: 'normalized',
  write: 'write-failed'
});
/** 写失败的错误码。 */
export const HISTORY_WRITE_FAILED = 'HISTORY_WRITE_FAILED';
/** 损坏文件备份失败的错误码（此时宁可报错也不覆盖）。 */
export const HISTORY_BACKUP_FAILED = 'HISTORY_BACKUP_FAILED';

const TOKEN_FIELDS = new Set(['codexTokens', 'deepseekTokens', 'opencodeTokens', 'opencodeOtherTokens']);
const COST_FIELDS = new Set(['deepseekCostCny', 'opencodeCostCny', 'opencodeOtherCostCny']);
const MAX_WARNINGS = 50;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const USAGE_TIME_OFFSET_MS = 8 * 60 * 60 * 1000;

function pad2(value) {
  return String(value).padStart(2, '0');
}

/** 主机本地日期 YYYY-MM-DD，用于既有存档和导入的日期范围校验。 */
export function localDay(ms) {
  const date = new Date(Number(ms));
  return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
}

/** 用量日以 UTC+08:00 的午夜为界，与 DeepSeek 平台的逐日桶一致。 */
export function usageDay(ms) {
  return new Date(Number(ms) + USAGE_TIME_OFFSET_MS).toISOString().slice(0, 10);
}

/** 以日期键为锚点按日历倒推，返回由旧到新的日期，包含最后一天。 */
export function calendarDayRange(lastDate, days) {
  const count = Math.floor(days);
  if (!Number.isFinite(count) || count < 1) return [];
  const date = new Date(`${lastDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - count + 1);
  const range = [];
  for (let index = 0; index < count; index += 1) {
    range.push(date.toISOString().slice(0, 10));
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return range;
}

/** 日历真实性校验：2026-02-30、2026-13-45 这类「格式对但不存在」的日期返回 false。 */
export function isValidDate(text) {
  if (typeof text !== 'string' || !DATE_RE.test(text)) return false;
  const parts = text.split('-').map(Number);
  const date = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  return (
    date.getUTCFullYear() === parts[0] &&
    date.getUTCMonth() === parts[1] - 1 &&
    date.getUTCDate() === parts[2]
  );
}

/** 日期窗口：[HISTORY_DATE_MIN, 今天+1]（容忍时区导致的「明天」数据）。 */
export function isAllowedDate(text, now) {
  if (!isValidDate(text)) return false;
  if (text < HISTORY_DATE_MIN) return false;
  const today = localDay(now === undefined ? Date.now() : now);
  const parts = today.split('-').map(Number);
  const tomorrow = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2] + 1)).toISOString().slice(0, 10);
  return text <= tomorrow;
}

/** 字段对应的数值上限；未登记的字段返回 null（不限制）。 */
export function limitForField(field) {
  if (TOKEN_FIELDS.has(field)) return LIMITS.tokens;
  if (COST_FIELDS.has(field)) return LIMITS.cost;
  if (/requests?$/i.test(String(field))) return LIMITS.requests;
  return null;
}

/** 统一数值清洗：非数字/布尔/对象/负数/0/NaN/Infinity/超上限 -> null。数字字符串仍可被接受。 */
export function sanitizeNumber(raw, limit) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'boolean' || typeof raw === 'object') return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return null;
  if (limit !== null && limit !== undefined && value > limit) return null;
  return value;
}

function hasDropped(dropped) {
  if (!dropped) return false;
  return (
    dropped.invalidDate + dropped.outOfRange + dropped.badValue + dropped.badDay + dropped.badMapEntry > 0
  );
}

function attachStats(history, warnings, dropped) {
  Object.defineProperty(history, 'warnings', {
    value: warnings || [],
    enumerable: false,
    configurable: true,
    writable: true
  });
  Object.defineProperty(history, 'dropped', {
    value: dropped || { invalidDate: 0, outOfRange: 0, badValue: 0, badDay: 0, badMapEntry: 0 },
    enumerable: false,
    configurable: true,
    writable: true
  });
  return history;
}

function pushWarning(warnings, warning) {
  if (warnings.length < MAX_WARNINGS) warnings.push(warning);
}

function cleanMap(value, limits, dropped) {
  const out = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [key, raw] of Object.entries(value)) {
    const num = sanitizeNumber(raw, limits && limits.tokens !== undefined ? limits.tokens : LIMITS.tokens);
    if (num === null) {
      if (dropped && raw !== undefined && raw !== null) dropped.badMapEntry += 1;
      continue;
    }
    out[String(key).slice(0, 80)] = Math.round(num);
  }
  return out;
}

export function emptyHistory() {
  return attachStats({ version: DAILY_HISTORY_VERSION, updatedAt: null, days: {} }, [], null);
}

/**
 * 把文件里读出来的内容规整成可用结构（容忍手工改坏/旧版本）。
 * 非法/越界日期与异常数值会被丢弃，并在返回对象的 dropped / warnings（不可枚举）里计数。
 */
export function normalizeHistory(raw, options) {
  const opts = options || {};
  const now = opts.now === undefined ? Date.now() : opts.now;
  const out = emptyHistory();
  const warnings = [];
  const dropped = { invalidDate: 0, outOfRange: 0, badValue: 0, badDay: 0, badMapEntry: 0 };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return attachStats(out, warnings, dropped);
  out.updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : null;
  const days =
    raw.days && typeof raw.days === 'object' && !Array.isArray(raw.days) ? raw.days : {};
  for (const [date, entry] of Object.entries(days)) {
    if (typeof date !== 'string' || !DATE_RE.test(date) || !isValidDate(date)) {
      dropped.invalidDate += 1;
      pushWarning(warnings, { code: 'date-invalid', date: String(date), reason: '日期不存在' });
      continue;
    }
    if (!isAllowedDate(date, now)) {
      dropped.outOfRange += 1;
      pushWarning(warnings, {
        code: 'date-out-of-range',
        date,
        reason: '仅允许 ' + HISTORY_DATE_MIN + ' ~ 明天'
      });
      continue;
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      dropped.badDay += 1;
      pushWarning(warnings, { code: 'day-not-object', date });
      continue;
    }
    const day = { date };
    for (const field of DAILY_FIELDS) {
      const value = sanitizeNumber(entry[field], limitForField(field));
      if (value === null) {
        if (entry[field] !== undefined && entry[field] !== null) {
          dropped.badValue += 1;
          pushWarning(warnings, { code: 'value-invalid', date, field, value: String(entry[field]).slice(0, 40) });
        }
        continue;
      }
      day[field] = value;
    }
    for (const field of DAILY_MAP_FIELDS) {
      const map = cleanMap(entry[field], LIMITS, dropped);
      if (Object.keys(map).length) day[field] = map;
    }
    if (Object.keys(day).length > 1) out.days[date] = day;
  }
  return attachStats(out, warnings, dropped);
}

/**
 * 合并一天的采集结果（max 规则；越界数值按 null 处理，不会覆盖已有值）。
 */
export function mergeDay(existing, incoming) {
  const merged = { date: incoming && incoming.date ? incoming.date : existing && existing.date };
  let changed = false;
  for (const field of DAILY_FIELDS) {
    const limit = limitForField(field);
    const prev = sanitizeNumber(existing && existing[field], limit);
    const next = sanitizeNumber(incoming && incoming[field], limit);
    const prevValue = prev === null ? 0 : prev;
    const nextValue = next === null ? 0 : next;
    const value = Math.max(prevValue, nextValue);
    if (value > 0) merged[field] = value;
    if (value > prevValue) changed = true;
  }
  for (const field of DAILY_MAP_FIELDS) {
    const prevMap = cleanMap(existing && existing[field], LIMITS, null);
    const nextMap = cleanMap(incoming && incoming[field], LIMITS, null);
    const mergedMap = Object.assign({}, prevMap);
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
 * 非法/越界日期会被跳过并单独计数（不会静默混入）。
 */
export function mergeSeriesIntoHistory(history, series, options) {
  const opts = options || {};
  const now = opts.now === undefined ? Date.now() : opts.now;
  const summary = {
    addedDays: 0,
    updatedDays: 0,
    skipped: 0,
    droppedInvalidDate: 0,
    droppedOutOfRange: 0
  };
  for (const entry of series || []) {
    const date = entry && entry.date;
    if (!date || typeof date !== 'string' || !DATE_RE.test(date) || !isValidDate(date)) {
      summary.skipped += 1;
      summary.droppedInvalidDate += 1;
      continue;
    }
    if (!isAllowedDate(date, now)) {
      summary.skipped += 1;
      summary.droppedOutOfRange += 1;
      continue;
    }
    const existing = history.days[date] || null;
    const result = mergeDay(existing, entry);
    if (Object.keys(result.day).length <= 1) {
      summary.skipped += 1;
      continue;
    }
    if (!existing) summary.addedDays += 1;
    else if (result.changed) summary.updatedDays += 1;
    history.days[date] = result.day;
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
 * @param {(ms: number) => string} [dateOf] 以 UTC+08:00 确定结束日期，也兼容调用方指定日期
 * @param {number} [now] 采集和展示可共用同一毫秒时间戳
 */
export function buildSeriesFromHistory(history, days, dateOf = usageDay, now = Date.now()) {
  const total = Math.max(1, Math.min(3650, Number(days) || 371));
  return calendarDayRange(dateOf(now), total).map((date) => {
    const saved = history.days[date];
    return {
      date,
      // G8：当天是否真的观测到 Codex 数据（false -> 前端显示「无数据」而不是 0）
      codexObserved: Boolean(saved && saved.codexTokens > 0),
      codexTokens: saved && saved.codexTokens ? saved.codexTokens : 0,
      codexByAccount: (saved && saved.codexByAccount) || {},
      opencodeByProvider: (saved && saved.opencodeByProvider) || {},
      deepseekTokens: saved && saved.deepseekTokens ? saved.deepseekTokens : 0,
      deepseekCostCny: saved && saved.deepseekCostCny ? saved.deepseekCostCny : 0,
      opencodeTokens: saved && saved.opencodeTokens ? saved.opencodeTokens : 0,
      opencodeCostCny: saved && saved.opencodeCostCny ? saved.opencodeCostCny : 0,
      opencodeOtherTokens: saved && saved.opencodeOtherTokens ? saved.opencodeOtherTokens : 0,
      opencodeOtherCostCny: saved && saved.opencodeOtherCostCny ? saved.opencodeOtherCostCny : 0
    };
  });
}

/* ============================================================
 * F4：存档文件读写（损坏备份 / 原子写 / 串行锁 / 导入出口）
 * ============================================================ */

/** data 目录 -> daily-history.json 路径。 */
export function historyFilePath(dataDir) {
  return path.join(String(dataDir), 'daily-history.json');
}

function fileStamp(now) {
  const date = new Date(now);
  return (
    pad2(date.getFullYear()) +
    pad2(date.getMonth() + 1) +
    pad2(date.getDate()) +
    '-' +
    pad2(date.getHours()) +
    pad2(date.getMinutes()) +
    pad2(date.getSeconds()) +
    '-' +
    String(date.getMilliseconds()).padStart(3, '0')
  );
}

/** 损坏文件备份名：daily-history.corrupt-<ts>.json（同毫秒冲突时追加序号）。 */
async function nextCorruptPath(filePath, now) {
  const dir = path.dirname(filePath);
  const baseName = path.basename(filePath).replace(/\.json$/i, '');
  const stamp = fileStamp(now);
  for (let index = 0; index < 100; index += 1) {
    const suffix = index === 0 ? '' : '-' + index;
    const candidate = path.join(dir, baseName + '.corrupt-' + stamp + suffix + '.json');
    try {
      await fs.access(candidate);
    } catch {
      return candidate;
    }
  }
  return path.join(dir, baseName + '.corrupt-' + stamp + '-' + Date.now() + '.json');
}

function makeError(message, code, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

/**
 * 读取存档。返回 { history, warning, backupPath }。
 * - 文件不存在：空历史（不报错、不告警）；
 * - JSON 损坏：先 rename 备份为 daily-history.corrupt-<ts>.json，再返回空历史 + warning；
 * - 备份失败：抛 HISTORY_BACKUP_FAILED（宁可报错，不覆盖用户数据）；
 * - 读权限等其它 IO 错误：向上抛。
 */
export async function readHistoryFile(filePath, options) {
  const opts = options || {};
  const now = opts.now === undefined ? Date.now() : opts.now;
  let raw;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { history: normalizeHistory(null, { now }), warning: null, backupPath: null };
    }
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (parseError) {
    const backupPath = await nextCorruptPath(filePath, now);
    try {
      await fs.rename(filePath, backupPath);
    } catch (renameError) {
      throw makeError(
        '历史存档损坏且无法备份，已放弃覆盖写入：' + filePath + '（' + (renameError.code || renameError.message) + '）',
        HISTORY_BACKUP_FAILED,
        renameError
      );
    }
    return {
      history: normalizeHistory(null, { now }),
      backupPath,
      warning: {
        code: HISTORY_WARNINGS.corrupt,
        message:
          '历史存档不是合法 JSON，已备份为 ' + path.basename(backupPath) + ' 并重建（原数据未删除）',
        backupPath,
        detail: String(parseError && parseError.message ? parseError.message : parseError).slice(0, 200)
      }
    };
  }
  const history = normalizeHistory(parsed, { now });
  let warning = null;
  if (hasDropped(history.dropped) || history.warnings.length) {
    const total =
      history.dropped.invalidDate +
      history.dropped.outOfRange +
      history.dropped.badValue +
      history.dropped.badDay +
      history.dropped.badMapEntry;
    warning = {
      code: HISTORY_WARNINGS.normalized,
      message: '历史存档含 ' + total + ' 处非法日期/数值，已丢弃（未写回文件）',
      dropped: Object.assign({}, history.dropped),
      samples: history.warnings.slice(0, 10)
    };
  }
  return { history, warning, backupPath: null };
}

async function renameWithRetry(from, to) {
  let lastError = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await fs.rename(from, to);
      return;
    } catch (error) {
      lastError = error;
      if (!error || !/^(EPERM|EACCES|EBUSY)$/.test(String(error.code))) break;
      await new Promise((resolve) => setTimeout(resolve, 15 * (attempt + 1)));
    }
  }
  throw lastError;
}

/**
 * 原子写存档：先写唯一 tmp，再 rename 覆盖；失败清理 tmp 并抛 HISTORY_WRITE_FAILED。
 * 只读文件 / 权限拒绝 / 磁盘满都会抛错（不再静默吞掉）。
 */
export async function writeHistoryFile(filePath, history, options) {
  const payload = JSON.stringify(history, null, 2) + '\n';
  const dir = path.dirname(filePath);
  const tmp =
    filePath + '.tmp-' + process.pid + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(tmp, payload, 'utf8');
    await renameWithRetry(tmp, filePath);
  } catch (error) {
    try {
      await fs.unlink(tmp);
    } catch {
      /* tmp 可能根本没创建 */
    }
    throw makeError(
      '写入历史存档失败：' + filePath + '（' + (error.code || error.message) + '）',
      HISTORY_WRITE_FAILED,
      error
    );
  }
  return { filePath, bytes: Buffer.byteLength(payload, 'utf8') };
}

const lockTails = new Map();

/** 进程内串行锁：同一 key 的回调按调用顺序执行（用于读-改-写）。 */
export async function withHistoryLock(key, fn) {
  const previous = lockTails.get(key) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const tail = previous.then(
    () => gate,
    () => gate
  );
  lockTails.set(key, tail);
  try {
    await previous.catch(() => {});
    return await fn();
  } finally {
    release();
    if (lockTails.get(key) === tail) lockTails.delete(key);
  }
}

/** store（有 dataDir）或目录路径 -> 目录字符串。 */
function dataDirOf(store) {
  const dataDir = typeof store === 'string' ? store : store && store.dataDir;
  if (!dataDir) throw new TypeError('需要 store.dataDir 或 data 目录路径');
  return dataDir;
}

/** 读存档（store 版）：{ history, warning, backupPath }。 */
export async function readHistory(store, options) {
  return readHistoryFile(historyFilePath(dataDirOf(store)), options);
}

/** 原子写存档（store 版）。 */
export async function writeHistory(store, history, options) {
  return writeHistoryFile(historyFilePath(dataDirOf(store)), history, options);
}

/**
 * 导入合并出口（供 server 的 /api/daily/import 调用）：
 * 读（含损坏备份）-> 校验并 merge（max）-> 原子写回。默认加锁，并发导入不会丢天。
 *
 * @param {{dataDir: string}|string} store
 * @param {Array<{date: string}>} days 由 parseImportData 产出的行
 * @returns {Promise<{ok: true, filePath: string, summary: object, history: object, range: object, warning: object|null}>}
 * @throws {Error} 写失败抛 HISTORY_WRITE_FAILED；损坏且备份失败抛 HISTORY_BACKUP_FAILED
 */
export async function importDays(store, days, options) {
  const opts = options || {};
  const now = opts.now === undefined ? Date.now() : opts.now;
  const filePath = historyFilePath(dataDirOf(store));
  // ④ 同日多条 / 重复日期：先按字段 max 合并，保证结果与传入顺序无关
  const rows = mergeImportRows(days);
  const run = async () => {
    const loaded = await readHistoryFile(filePath, { now });
    const summary = mergeSeriesIntoHistory(loaded.history, rows, { now });
    summary.rows = rows.length;
    await writeHistoryFile(filePath, loaded.history, { now });
    return {
      ok: true,
      filePath,
      summary,
      history: loaded.history,
      range: historyRange(loaded.history),
      warning: loaded.warning
    };
  };
  const guarded = opts.lock === false ? run : () => withHistoryLock(filePath, run);
  if (opts.fileLock === false) return guarded();
  try {
    // ② 跨进程锁在进程内锁之外，覆盖整个「读-改-写」
    return await withFileLock(filePath, guarded, { timeoutMs: opts.timeoutMs, staleMs: opts.staleMs });
  } catch (error) {
    if (error && error.code === FILE_LOCK_TIMEOUT) throw error;
    if (error && /^(EACCES|EPERM|EROFS)$/.test(String(error.code))) {
      throw makeError('写入历史存档失败：' + filePath + '（' + error.code + '）', HISTORY_WRITE_FAILED, error);
    }
    throw error;
  }
}

/* ============================================================
 * 导入解析（CSV / JSON）
 * ============================================================ */

/** 导入错误最多回传条数（P3：server 侧不再只回 20 条）。 */
export const MAX_IMPORT_ERRORS = 100;

/**
 * 截断导入错误列表到 limit（默认 MAX_IMPORT_ERRORS）。
 * 返回数组本身，另附不可枚举的 { truncated, total }，方便路由层决定是否提示"还有更多"。
 */
export function limitImportErrors(errors, limit) {
  const max = Number.isFinite(Number(limit)) ? Math.max(0, Number(limit)) : MAX_IMPORT_ERRORS;
  const list = Array.isArray(errors) ? errors : [];
  const sliced = list.slice(0, max);
  Object.defineProperty(sliced, 'truncated', { value: list.length > max, enumerable: false });
  Object.defineProperty(sliced, 'total', { value: list.length, enumerable: false });
  return sliced;
}

/**
 * 同日多条 / 重复日期 -> 按字段 max 合并（与存档 merge 语义一致）。
 * 返回按日期升序的数组；非法/越界日期直接丢弃（parseImportData 已过滤，这里再兜底一次）。
 */
export function mergeImportRows(rows) {
  const byDate = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== 'object') continue;
    const date = String(row.date);
    if (!isValidDate(date) || !isAllowedDate(date)) continue;
    const current = byDate.get(date) || null;
    const result = mergeDay(current, row);
    byDate.set(date, result.day);
  }
  return [...byDate.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

/** 支持导入的渠道 -> 落到存档里的字段名 */
export const IMPORT_CHANNELS = {
  codex: { tokensField: 'codexTokens', costField: null },
  deepseek: { tokensField: 'deepseekTokens', costField: 'deepseekCostCny' },
  opencode: { tokensField: 'opencodeTokens', costField: 'opencodeCostCny' },
  opencodeOther: { tokensField: 'opencodeOtherTokens', costField: 'opencodeOtherCostCny' }
};

/**
 * 解析导入内容（CSV 或 JSON）。
 * CSV：每行 date,tokens[,cost]，允许有表头（含 date/tokens 等字样时自动跳过）；
 * JSON：[{ date, tokens, costCny }] 或 [{ date, codexTokens, ... }]（已按渠道字段给全也可）。
 * 非法/越界日期、负值、非数字、超过上限（tokens <= 1e13、cost <= 1e9）一律报错并跳过该行。
 * @returns {{ rows: Array<object>, errors: string[] }}
 */
export function parseImportData(channel, raw, options) {
  const opts = options || {};
  const now = opts.now === undefined ? Date.now() : opts.now;
  const conf = IMPORT_CHANNELS[channel];
  if (!conf) return { rows: [], errors: ['未知渠道：' + channel] };
  const errors = [];
  const rows = [];
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) {
    if (Array.isArray(raw)) return parseJsonRows(raw, channel, conf, errors, now);
    return { rows: [], errors: ['内容为空'] };
  }

  const firstChar = text.charAt(0);
  if (firstChar === '[' || firstChar === '{') {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { rows: [], errors: ['JSON 解析失败，请检查文件格式。'] };
    }
    const list = Array.isArray(parsed) ? parsed : parsed.days || parsed.rows || [];
    return parseJsonRows(list, channel, conf, errors, now);
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
    if (!DATE_RE.test(date)) {
      errors.push('第 ' + (index + 1) + ' 行：日期格式应为 YYYY-MM-DD');
      continue;
    }
    if (!isValidDate(date)) {
      errors.push('第 ' + (index + 1) + ' 行：日期不存在');
      continue;
    }
    if (!isAllowedDate(date, now)) {
      errors.push('第 ' + (index + 1) + ' 行：日期超出允许范围（' + HISTORY_DATE_MIN + ' ~ 明天）');
      continue;
    }
    if (!Number.isFinite(tokens) || tokens < 0) {
      errors.push('第 ' + (index + 1) + ' 行：tokens 必须是非负数字');
      continue;
    }
    if (tokens > LIMITS.tokens) {
      errors.push('第 ' + (index + 1) + ' 行：tokens 超出上限（最大 ' + LIMITS.tokens + '）');
      continue;
    }
    if (cost !== null && (!Number.isFinite(cost) || cost < 0)) {
      errors.push('第 ' + (index + 1) + ' 行：费用必须是非负数字');
      continue;
    }
    if (cost !== null && cost > LIMITS.cost) {
      errors.push('第 ' + (index + 1) + ' 行：费用超出上限（最大 ' + LIMITS.cost + '）');
      continue;
    }
    const row = { date };
    if (tokens > 0) row[conf.tokensField] = Math.round(tokens);
    if (cost !== null && conf.costField) row[conf.costField] = cost;
    rows.push(row);
  }
  // ③ 错误全量返回（最多 MAX_IMPORT_ERRORS 条，附带是否被截断）
  const capped = limitImportErrors(errors);
  return { rows, errors: capped, errorsTruncated: capped.truncated, errorCount: capped.total };
}

function parseJsonRows(list, channel, conf, errors, now) {
  if (!Array.isArray(list)) return { rows: [], errors: ['JSON 应为数组'] };
  const rows = [];
  for (const [index, item] of list.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      errors.push('第 ' + (index + 1) + ' 条：不是对象');
      continue;
    }
    const date = item.date || item.day;
    if (!date || !isValidDate(String(date))) {
      errors.push('第 ' + (index + 1) + ' 条：日期无效');
      continue;
    }
    if (!isAllowedDate(String(date), now)) {
      errors.push(
        '第 ' + (index + 1) + ' 条：日期超出允许范围（' + HISTORY_DATE_MIN + ' ~ 明天）'
      );
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
      if (value > LIMITS.tokens) {
        errors.push('第 ' + (index + 1) + ' 条：tokens 超出上限（最大 ' + LIMITS.tokens + '）');
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
        if (value > LIMITS.cost) {
          errors.push('第 ' + (index + 1) + ' 条：费用超出上限（最大 ' + LIMITS.cost + '）');
          continue;
        }
        if (value > 0) row[conf.costField] = value;
      }
    }
    // requests 目前不落存档，但导入时必须校验上限（防脏值进入统计链）
    const requests = item.requests;
    if (requests !== undefined) {
      const value = Number(requests);
      if (!Number.isFinite(value) || value < 0 || value > LIMITS.requests) {
        errors.push('第 ' + (index + 1) + ' 条：requests 必须是 0 ~ ' + LIMITS.requests + ' 的数字');
        continue;
      }
    }
    if (Object.keys(row).length > 1) rows.push(row);
  }
  const capped = limitImportErrors(errors);
  return { rows, errors: capped, errorsTruncated: capped.truncated, errorCount: capped.total };
}
