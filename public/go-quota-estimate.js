const DAY_FORMAT = /^\d{4}-\d{2}-\d{2}$/;
const TIMESTAMP_FORMAT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const MICROCENTS_PER_USD = 100_000_000;

function utcDay(value) {
  if (typeof value !== 'string' || !DAY_FORMAT.test(value)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? date : null;
}

function csvDay(value) {
  const text = value?.trim();
  const slashDate = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(text);
  const day = slashDate
    ? `${slashDate[1]}-${slashDate[2].padStart(2, '0')}-${slashDate[3].padStart(2, '0')}`
    : text;
  return utcDay(day) ? day : null;
}

function cycleTime(value) {
  if (typeof value !== 'string' || !utcDay(value.slice(0, 10))) return null;
  if (!DAY_FORMAT.test(value) && !TIMESTAMP_FORMAT.test(value)) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function modelId(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function isPositiveNumber(value) {
  return Number.isFinite(value) && value > 0;
}

export function previousGoCycleDay(cycleEnd) {
  const timestamp = cycleTime(cycleEnd);
  if (timestamp === null) return null;
  const previous = new Date(timestamp);
  const day = previous.getUTCDate();
  previous.setUTCDate(1);
  previous.setUTCMonth(previous.getUTCMonth() - 1);
  const lastDay = new Date(previous);
  lastDay.setUTCMonth(lastDay.getUTCMonth() + 1, 0);
  previous.setUTCDate(Math.min(day, lastDay.getUTCDate()));
  const date = previous.toISOString().slice(0, 10);
  return utcDay(date) ? date : null;
}

export function firstFullGoCycleDay(cycleEnd) {
  const timestamp = cycleTime(cycleEnd);
  const previous = previousGoCycleDay(cycleEnd);
  if (!previous) return null;
  const day = utcDay(previous);
  if (timestamp % 86_400_000 !== 0) day.setUTCDate(day.getUTCDate() + 1);
  return day.toISOString().slice(0, 10);
}

export function buildGoQuotaEstimate(report, cycleEnd) {
  const end = cycleTime(cycleEnd);
  if (end === null || cycleTime(report?.cycleEnd) !== end || !utcDay(report?.through) || !Array.isArray(report?.rows)) {
    return null;
  }

  const totals = new Map();
  for (const row of report.rows) {
    const id = modelId(row?.model);
    if (!id || !isPositiveNumber(row.costUsd) || !isPositiveNumber(row.monthlyLimitUsd)) continue;

    const used = row.costUsd / row.monthlyLimitUsd;
    if (isPositiveNumber(used)) totals.set(id, (totals.get(id) || 0) + used);
  }

  const total = [...totals.values()].reduce((sum, used) => sum + used, 0);
  if (!isPositiveNumber(total)) return null;
  const models = [...totals]
    .sort(([leftId, leftUsed], [rightId, rightUsed]) => rightUsed - leftUsed || leftId.localeCompare(rightId, 'en'))
    .slice(0, 3)
    .map(([model, used]) => ({ model, sharePercent: (used / total) * 100 }));

  return { through: report.through, modelCount: totals.size, models };
}

function* csvRecords(source) {
  let record = [];
  let cell = '';
  let quoted = false;
  let closedQuote = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char !== '"') cell += char;
      else if (source[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = false;
        closedQuote = true;
      }
    } else if (char === ',' || char === '\r' || char === '\n') {
      record.push(cell);
      cell = '';
      closedQuote = false;
      if (char === ',') continue;
      if (char === '\r' && source[index + 1] === '\n') index += 1;
      if (record.some((value) => value.trim())) yield record;
      record = [];
    } else if (char === '"' && !cell && !closedQuote) {
      quoted = true;
    } else if (char === '"' || closedQuote) {
      throw new Error('CSV 引号格式有误，请重新导出原始文件。');
    } else {
      cell += char;
    }
  }

  if (quoted) throw new Error('CSV 引号未结束，请重新导出原始文件。');
  record.push(cell);
  if (record.some((value) => value.trim())) yield record;
}

function readCost(value, inMicrocents) {
  const text = value?.trim();
  if (!text) return null;
  const format = inMicrocents ? /^\d+$/ : /^(?:\d+(?:\.\d+)?|\.\d+)$/;
  if (!format.test(text)) return null;
  const amount = Number(text);
  if (!Number.isFinite(amount) || (inMicrocents && !Number.isSafeInteger(amount))) return null;
  return inMicrocents ? amount / MICROCENTS_PER_USD : amount;
}

export function readGoWorkspaceCosts(csvText, { from, through, limits } = {}) {
  const costs = readGoWorkspaceModelCosts(csvText, { from, through });
  return applyGoModelLimits(costs.rows, limits);
}

export function applyGoModelLimits(rows, limits) {
  if (!(limits instanceof Map)) throw new Error('请提供各模型的月额度。');
  const limitsByModel = new Map();
  for (const [name, limit] of limits) {
    const id = modelId(name);
    if (!id || !isPositiveNumber(limit)) continue;
    if (limitsByModel.has(id) && limitsByModel.get(id) !== limit) {
      throw new Error('同一模型有多个不同的月额度，请核对额度口径。');
    }
    limitsByModel.set(id, limit);
  }
  return rows.map(({ model, costUsd, recordNumber }) => {
    const monthlyLimitUsd = limitsByModel.get(model);
    if (!isPositiveNumber(monthlyLimitUsd)) {
      throw new Error('CSV 第 ' + recordNumber + ' 条付费 Go 记录缺少适用的模型月额度。');
    }
    return { model, costUsd, monthlyLimitUsd };
  });
}

export function readGoWorkspaceModelCosts(csvText, { from, through } = {}) {
  if (!utcDay(from) || !utcDay(through) || from > through) {
    throw new Error('请选择有效的账期日期范围。');
  }
  if (typeof csvText !== 'string') throw new Error('请提供官网用量 CSV。');
  const records = csvRecords(csvText.replace(/^\uFEFF/, ''));
  const header = records.next().value?.map((name) => name.trim().toLowerCase()) || [];
  const dayIndex = header.indexOf('day');
  const providerIndex = header.indexOf('provider');
  const modelIndex = header.indexOf('model');
  const microcentsIndex = header.indexOf('cost_micro_cents');
  const costIndex = microcentsIndex >= 0 ? microcentsIndex : header.indexOf('cost_usd');
  if ([dayIndex, providerIndex, modelIndex, costIndex].includes(-1) || new Set(header).size !== header.length) {
    throw new Error('CSV 缺少或重复日期、提供商、模型或费用列，请使用官网活动页的用量导出。');
  }

  const totals = new Map();
  let recordNumber = 1;
  let latestDay = null;
  for (const record of records) {
    recordNumber += 1;
    if (modelId(record[providerIndex]) !== 'opencode-go') continue;

    const day = csvDay(record[dayIndex]);
    if (!day) throw new Error('CSV 第 ' + recordNumber + ' 条记录的用量日期无效，请使用 YYYY-MM-DD 或 YYYY/M/D。');
    if (day < from || day > through) continue;

    const costUsd = readCost(record[costIndex], microcentsIndex >= 0);
    if (record.length !== header.length || costUsd === null) {
      throw new Error('CSV 第 ' + recordNumber + ' 条 Go 用量记录格式或费用无效。');
    }
    if (costUsd === 0) continue;

    const model = modelId(record[modelIndex]);
    const existing = totals.get(model);
    const aggregated = (existing?.costUsd || 0) + costUsd;
    if (!Number.isFinite(aggregated)) throw new Error('CSV 中的模型累计费用超出可计算范围。');
    totals.set(model, { model, costUsd: aggregated, recordNumber: existing?.recordNumber ?? recordNumber });
    if (!latestDay || day > latestDay) latestDay = day;
  }

  return { rows: [...totals.values()], through: latestDay };
}
