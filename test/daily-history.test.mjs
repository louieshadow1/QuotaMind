import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  normalizeHistory,
  mergeDay,
  mergeSeriesIntoHistory,
  historyRange,
  buildSeriesFromHistory,
  parseImportData,
  mergeImportRows,
  limitImportErrors,
  MAX_IMPORT_ERRORS,
  readHistoryFile,
  writeHistoryFile,
  importDays,
  historyFilePath,
  localDay,
  isValidDate,
  isAllowedDate,
  HISTORY_DATE_MIN,
  LIMITS,
  HISTORY_WARNINGS,
  HISTORY_WRITE_FAILED
} from '../lib/daily-history.mjs';

const DAY_MS = 86400000;

function dayOffset(offset, now) {
  return localDay((now === undefined ? Date.now() : now) + offset * DAY_MS);
}

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'quota-daily-'));
}

async function listFiles(dir) {
  return (await fs.readdir(dir)).sort();
}

// ---------- ① 日期真实校验 + 范围 ----------

test('F4 normalizeHistory：非法日历日期被丢弃并计数（2026-13-45 / 2026-02-30）', () => {
  const history = normalizeHistory({
    days: {
      '2026-13-45': { date: '2026-13-45', codexTokens: 5 },
      '2026-02-30': { date: '2026-02-30', codexTokens: 6 },
      [dayOffset(0)]: { date: dayOffset(0), codexTokens: 7 }
    }
  });
  assert.deepEqual(Object.keys(history.days), [dayOffset(0)]);
  assert.equal(history.dropped.invalidDate, 2);
  assert.ok(history.warnings.length >= 2);
  // 统计字段不可枚举 -> 不会被写回 JSON
  const persisted = JSON.parse(JSON.stringify(history));
  assert.equal(persisted.dropped, undefined);
  assert.equal(persisted.warnings, undefined);
});

test('F4 normalizeHistory：越界日期（1970 / 2099 / 今天+2）被丢弃，边界值保留', () => {
  const history = normalizeHistory({
    days: {
      '1970-01-01': { codexTokens: 1 },
      '2019-12-31': { codexTokens: 2 },
      '2099-12-31': { codexTokens: 3 },
      [dayOffset(2)]: { codexTokens: 4 },
      [dayOffset(1)]: { codexTokens: 5 },
      [HISTORY_DATE_MIN]: { codexTokens: 6 }
    }
  });
  assert.deepEqual(Object.keys(history.days).sort(), [HISTORY_DATE_MIN, dayOffset(1)].sort());
  assert.equal(history.dropped.outOfRange, 4);
  const range = historyRange(history);
  assert.notEqual(range.firstDate, '1970-01-01');
  assert.notEqual(range.lastDate, '2099-12-31');
});

// ---------- ② 数值上限 ----------

test('F4 normalizeHistory：超大/非法数值被丢弃（2^53 / 1e308 / 负数 / null / NaN 字符串）', () => {
  const today = dayOffset(0);
  const history = normalizeHistory({
    days: {
      [today]: {
        codexTokens: 9007199254740992,
        deepseekTokens: -5,
        deepseekCostCny: 1e308,
        opencodeTokens: null,
        opencodeCostCny: 'abc',
        opencodeOtherTokens: '1e308',
        opencodeOtherCostCny: 1e9 + 1,
        codexByAccount: { ok: 5 }
      }
    }
  });
  assert.deepEqual(Object.keys(history.days), [today]);
  const day = history.days[today];
  assert.equal(day.codexTokens, undefined);
  assert.equal(day.deepseekTokens, undefined);
  assert.equal(day.deepseekCostCny, undefined);
  assert.equal(day.opencodeTokens, undefined);
  assert.equal(day.opencodeCostCny, undefined);
  assert.equal(day.opencodeOtherTokens, undefined);
  assert.equal(day.opencodeOtherCostCny, undefined);
  assert.deepEqual(day.codexByAccount, { ok: 5 });
  assert.equal(history.dropped.badValue, 6);
});

test('F4 normalizeHistory：上限内的值保留（1e13 tokens / 1e9 cost / 数字字符串）', () => {
  const today = dayOffset(0);
  const history = normalizeHistory({
    days: {
      [today]: {
        codexTokens: LIMITS.tokens,
        deepseekCostCny: LIMITS.cost,
        deepseekTokens: '123',
        codexByAccount: { acc: 9007199254740992, ok: '456', bad: -1 }
      }
    }
  });
  const day = history.days[today];
  assert.equal(day.codexTokens, LIMITS.tokens);
  assert.equal(day.deepseekCostCny, LIMITS.cost);
  assert.equal(day.deepseekTokens, 123);
  assert.deepEqual(day.codexByAccount, { ok: 456 });
});

// ---------- ③ 合并 max 规则不变 ----------

test('F4 mergeDay：max 规则、越界限值不会覆盖历史、明细逐 key 取 max', () => {
  const lower = mergeDay({ date: '2026-11-01', codexTokens: 500 }, { date: '2026-11-01', codexTokens: 100 });
  assert.equal(lower.day.codexTokens, 500);
  assert.equal(lower.changed, false);

  const higher = mergeDay({ date: '2026-11-01', codexTokens: 500 }, { date: '2026-11-01', codexTokens: 900 });
  assert.equal(higher.day.codexTokens, 900);
  assert.equal(higher.changed, true);

  const overflow = mergeDay({ date: '2026-11-01', codexTokens: 500 }, { date: '2026-11-01', codexTokens: 2 ** 53 });
  assert.equal(overflow.day.codexTokens, 500, '超上限的新值必须被拒绝，不能污染历史');

  const maps = mergeDay(
    { date: '2026-11-01', codexByAccount: { a: 100, b: 5 } },
    { date: '2026-11-01', codexByAccount: { a: 10, b: 50, c: 7 } }
  );
  assert.deepEqual(maps.day.codexByAccount, { a: 100, b: 50, c: 7 });
});

test('F4 mergeSeriesIntoHistory：非法/越界日期跳过并计数，0 值不覆盖、不删天', () => {
  const history = normalizeHistory(null);
  mergeSeriesIntoHistory(history, [{ date: '2026-11-01', deepseekTokens: 260 }]);
  const summary = mergeSeriesIntoHistory(history, [
    { date: '2026-11-01', deepseekTokens: 0 },
    { date: '2026-13-45', deepseekTokens: 1 },
    { date: '1970-01-01', deepseekTokens: 2 },
    { date: 'not-a-date', deepseekTokens: 3 },
    { date: dayOffset(1), deepseekTokens: 9 }
  ]);
  assert.equal(history.days['2026-11-01'].deepseekTokens, 260);
  assert.equal(summary.droppedInvalidDate, 2);
  assert.equal(summary.droppedOutOfRange, 1);
  assert.equal(summary.addedDays, 1);
  assert.equal(history.days[dayOffset(1)].deepseekTokens, 9);
});

// ---------- ④ 导入解析：坏行/越界/超限 ----------

test('F4 parseImportData：CSV 越界日期、不存在日期、超限 token、超限费用均报错', () => {
  const csv = [
    'date,tokens,costCny',
    '2019-12-31,100,0.1',
    '2026-13-45,100,0.1',
    '2026-02-30,100,0.1',
    '2026-11-01,9007199254740992,0.1',
    '2026-11-02,100,1000000001',
    '2026-11-03,100,0.5'
  ].join('\n');
  const { rows, errors } = parseImportData('deepseek', csv);
  assert.deepEqual(rows, [{ date: '2026-11-03', deepseekTokens: 100, deepseekCostCny: 0.5 }]);
  assert.equal(errors.length, 5);
  assert.ok(errors.some((msg) => msg.includes('超出允许范围')));
  assert.ok(errors.some((msg) => msg.includes('日期不存在')));
  assert.ok(errors.some((msg) => msg.includes('tokens 超出上限')));
  assert.ok(errors.some((msg) => msg.includes('费用超出上限')));
});

test('F4 parseImportData：JSON requests 超限被拒，正常行保留', () => {
  const { rows, errors } = parseImportData(
    'codex',
    JSON.stringify([
      { date: '2026-11-04', tokens: 100, requests: 2e9 },
      { date: '2026-11-05', tokens: 200, requests: 10 }
    ])
  );
  assert.deepEqual(rows, [{ date: '2026-11-05', codexTokens: 200 }]);
  assert.equal(errors.length, 1);
});

// ---------- ⑤ 文件 IO：损坏备份 / 原子写 / 只读失败 ----------

test('F4 readHistoryFile：损坏 JSON 先备份为 daily-history.corrupt-<ts>.json 再重建', async () => {
  const dir = await makeTempDir();
  const file = historyFilePath(dir);
  try {
    await fs.writeFile(file, '{ this is not json ][', 'utf8');
    const loaded = await readHistoryFile(file);
    assert.ok(loaded.warning, '必须返回 warning');
    assert.equal(loaded.warning.code, HISTORY_WARNINGS.corrupt);
    assert.ok(loaded.backupPath, '必须给出备份路径');
    assert.match(path.basename(loaded.backupPath), /^daily-history\.corrupt-.+\.json$/);
    assert.deepEqual(Object.keys(loaded.history.days), [], '重建为空历史');
    // 原文件已被移走，备份内容原样保留
    await assert.rejects(fs.access(file));
    assert.equal(await fs.readFile(loaded.backupPath, 'utf8'), '{ this is not json ][');
    // 重建后可以正常写回
    await writeHistoryFile(file, loaded.history);
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')).days, {});
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('F4 readHistoryFile：文件不存在时返回空历史且不报错', async () => {
  const dir = await makeTempDir();
  try {
    const loaded = await readHistoryFile(historyFilePath(dir));
    assert.equal(loaded.warning, null);
    assert.equal(loaded.backupPath, null);
    assert.deepEqual(loaded.history.days, {});
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('F4 readHistoryFile：存档内非法日期只告警、不改写文件', async () => {
  const dir = await makeTempDir();
  const file = historyFilePath(dir);
  try {
    const raw = JSON.stringify({
      version: 1,
      days: {
        '2026-13-45': { codexTokens: 5 },
        '1970-01-01': { codexTokens: 7 },
        [dayOffset(0)]: { codexTokens: 9 }
      }
    });
    await fs.writeFile(file, raw, 'utf8');
    const loaded = await readHistoryFile(file);
    assert.equal(loaded.warning.code, HISTORY_WARNINGS.normalized);
    assert.deepEqual(Object.keys(loaded.history.days), [dayOffset(0)]);
    assert.equal(loaded.warning.dropped.invalidDate, 1);
    assert.equal(loaded.warning.dropped.outOfRange, 1);
    assert.equal(await fs.readFile(file, 'utf8'), raw, '只读校验不应改写文件');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('F4 writeHistoryFile：原子写且不残留 tmp', async () => {
  const dir = await makeTempDir();
  const file = historyFilePath(dir);
  try {
    const history = normalizeHistory(null);
    mergeSeriesIntoHistory(history, [{ date: '2026-11-01', codexTokens: 42 }]);
    await writeHistoryFile(file, history);
    const files = await listFiles(dir);
    assert.deepEqual(files, ['daily-history.json']);
    assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).days['2026-11-01'].codexTokens, 42);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('F4 importDays：只读文件必须抛 HISTORY_WRITE_FAILED，且文件不变、不残留 tmp', async () => {
  const dir = await makeTempDir();
  const file = historyFilePath(dir);
  try {
    const before = JSON.stringify({ version: 1, days: { '2026-11-01': { date: '2026-11-01', codexTokens: 500 } } });
    await fs.writeFile(file, before, 'utf8');
    await fs.chmod(file, 0o444);
    try {
      await assert.rejects(
        () => importDays(dir, [{ date: '2026-11-02', codexTokens: 100 }]),
        (error) => error.code === HISTORY_WRITE_FAILED
      );
      assert.equal(await fs.readFile(file, 'utf8'), before, '写失败时文件必须保持原样');
      const leftovers = (await listFiles(dir)).filter((name) => name !== 'daily-history.json');
      assert.deepEqual(leftovers, [], '失败的 tmp 必须清理');
    } finally {
      await fs.chmod(file, 0o666);
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------- ⑥ 导入合并出口：max / 并发锁 / 损坏后重建 ----------

test('F4 importDays：导入取 max、不丢已有天数', async () => {
  const dir = await makeTempDir();
  try {
    const first = await importDays(dir, [{ date: '2026-11-01', deepseekTokens: 500 }]);
    assert.equal(first.ok, true);
    assert.equal(first.summary.addedDays, 1);
    const second = await importDays(dir, [
      { date: '2026-11-01', deepseekTokens: 100 },
      { date: '2026-11-02', deepseekTokens: 300 }
    ]);
    assert.equal(second.summary.addedDays, 1);
    const days = JSON.parse(await fs.readFile(historyFilePath(dir), 'utf8')).days;
    assert.equal(days['2026-11-01'].deepseekTokens, 500);
    assert.equal(days['2026-11-02'].deepseekTokens, 300);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('F4 importDays：8 路并发导入不同日期不丢天（进程内锁）', async () => {
  const dir = await makeTempDir();
  try {
    const rows = [];
    for (let index = 0; index < 8; index += 1) {
      rows.push({ date: dayOffset(-index), codexTokens: 10 + index });
    }
    const results = await Promise.all(rows.map((row) => importDays(dir, [row])));
    assert.equal(results.length, 8);
    assert.ok(results.every((result) => result.ok));
    const days = JSON.parse(await fs.readFile(historyFilePath(dir), 'utf8')).days;
    assert.equal(Object.keys(days).length, 8, '并发导入不能丢天');
    rows.forEach((row) => assert.equal(days[row.date].codexTokens, row.codexTokens));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('F4 importDays：损坏存档先备份再导入，warning 透出', async () => {
  const dir = await makeTempDir();
  const file = historyFilePath(dir);
  try {
    await fs.writeFile(file, ']]]broken', 'utf8');
    const result = await importDays(dir, [{ date: '2026-11-01', codexTokens: 77 }]);
    assert.equal(result.ok, true);
    assert.equal(result.warning.code, HISTORY_WARNINGS.corrupt);
    const files = await listFiles(dir);
    assert.ok(files.some((name) => /^daily-history\.corrupt-.+\.json$/.test(name)), '备份文件必须存在');
    const days = JSON.parse(await fs.readFile(file, 'utf8')).days;
    assert.equal(days['2026-11-01'].codexTokens, 77);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('F4 importDays：store 对象（dataDir）形式可用，缺 dataDir 抛 TypeError', async () => {
  const dir = await makeTempDir();
  try {
    const result = await importDays({ dataDir: dir }, [{ date: '2026-11-03', opencodeTokens: 12 }]);
    assert.equal(result.ok, true);
    await assert.rejects(() => importDays({}, []), TypeError);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------- ⑦ 既有行为回归（避免破坏 138 基线） ----------

test('F4 回归：buildSeriesFromHistory 仍按窗口补 0 且日期连续', () => {
  const history = normalizeHistory({ days: { [dayOffset(0)]: { codexTokens: 5 } } });
  const series = buildSeriesFromHistory(history, 3, (ms) => localDay(ms));
  assert.equal(series.length, 3);
  assert.equal(series[series.length - 1].date, dayOffset(0));
  assert.equal(series[series.length - 1].codexTokens, 5);
  assert.equal(series[0].codexTokens, 0);
});

test('每日用量以 UTC+08 午夜切换日期，按原日期键读取历史', () => {
  const midnight = Date.parse('2026-03-08T16:00:00.000Z');
  const history = normalizeHistory({
    days: {
      '2026-03-07': { deepseekTokens: 7 },
      '2026-03-09': { deepseekTokens: 9 }
    }
  }, { now: midnight });
  const daily = (now) => buildSeriesFromHistory(history, 3, undefined, now)
    .map((day) => [day.date, day.deepseekTokens]);
  assert.deepEqual(daily(midnight - 1), [
    ['2026-03-06', 0], ['2026-03-07', 7], ['2026-03-08', 0]
  ]);
  assert.deepEqual(daily(midnight), [
    ['2026-03-07', 7], ['2026-03-08', 0], ['2026-03-09', 9]
  ]);
  assert.deepEqual(Object.keys(history.days), ['2026-03-07', '2026-03-09']);
});

test('自定义日期格式化器跨纽约夏令时切换仍逐日连续', () => {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  const dateOf = (ms) => {
    const { year, month, day } = Object.fromEntries(
      formatter.formatToParts(ms).map(({ type, value }) => [type, value])
    );
    return `${year}-${month}-${day}`;
  };
  const history = normalizeHistory(null);
  const dates = (now) => buildSeriesFromHistory(history, 3, dateOf, Date.parse(now)).map((day) => day.date);
  assert.deepEqual(dates('2026-03-09T04:30:00Z'), ['2026-03-07', '2026-03-08', '2026-03-09']);
  assert.deepEqual(dates('2026-11-02T04:30:00Z'), ['2026-10-30', '2026-10-31', '2026-11-01']);
});

test('F4 工具函数：isValidDate / isAllowedDate 口径', () => {
  assert.equal(isValidDate('2026-11-14'), true);
  assert.equal(isValidDate('2026-02-30'), false);
  assert.equal(isValidDate('2026-13-45'), false);
  assert.equal(isAllowedDate('1970-01-01'), false);
  assert.equal(isAllowedDate(HISTORY_DATE_MIN), true);
  assert.equal(isAllowedDate(dayOffset(0)), true);
  assert.equal(isAllowedDate(dayOffset(1)), true);
  assert.equal(isAllowedDate(dayOffset(3)), false);
});

// ---------- G5：跨进程锁 / 重复日期 max / 导入错误全量 ----------

import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const LIB_URL = pathToFileURL(path.resolve(import.meta.dirname, '../lib/daily-history.mjs')).href;
const LOCK_LIB_URL = pathToFileURL(path.resolve(import.meta.dirname, '../lib/file-lock.mjs')).href;

function runChild(script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, ...args], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
    });
    child.stderr.on('data', (chunk) => {
      err += chunk;
    });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, out, err }));
  });
}

test('G5 跨进程：两个独立 node 进程并发 importDays 不丢天', async () => {
  const dir = await makeTempDir();
  const script =
    'import { importDays } from ' + JSON.stringify(LIB_URL) + ';' +
    'const [dir, date, tokens] = process.argv.slice(1);' +
    'const r = await importDays(dir, [{ date, codexTokens: Number(tokens) }]);' +
    'process.stdout.write(JSON.stringify({ ok: r.ok, rows: r.summary.rows }));';
  try {
    const [a, b] = await Promise.all([
      runChild(script, [dir, dayOffset(-1), '111']),
      runChild(script, [dir, dayOffset(-2), '222'])
    ]);
    assert.equal(a.code, 0, '子进程 A 失败：' + a.err);
    assert.equal(b.code, 0, '子进程 B 失败：' + b.err);
    assert.equal(JSON.parse(a.out).ok, true);
    assert.equal(JSON.parse(b.out).ok, true);
    const days = JSON.parse(await fs.readFile(historyFilePath(dir), 'utf8')).days;
    assert.equal(days[dayOffset(-1)].codexTokens, 111);
    assert.equal(days[dayOffset(-2)].codexTokens, 222);
    const leftovers = (await listFiles(dir)).filter((name) => name.endsWith('.lock'));
    assert.deepEqual(leftovers, [], '锁文件必须释放');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('G5 跨进程锁：外部进程持锁时 importDays 会等待而不是丢数据（staleMs 内）', async () => {
  const dir = await makeTempDir();
  const file = historyFilePath(dir);
  await fs.writeFile(file, JSON.stringify({ version: 1, days: {} }), 'utf8');
  const marker = path.join(dir, 'held.marker');
  const holderScript =
    'import { writeFile } from "node:fs/promises";' +
    'import { withFileLock } from ' + JSON.stringify(LOCK_LIB_URL) + ';' +
    'const [target, markerPath] = process.argv.slice(1);' +
    'await withFileLock(target, async () => {' +
    '  await writeFile(markerPath, "held");' +
    '  await new Promise((r) => setTimeout(r, 400));' +
    '});';
  try {
    const child = spawn(process.execPath, ['--input-type=module', '-e', holderScript, file, marker], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let childErr = '';
    child.stderr.on('data', (chunk) => {
      childErr += chunk;
    });
    // 等子进程真正持锁（写 marker），最多 5s；避免盲目等 stdout 导致挂死
    const holdDeadline = Date.now() + 5000;
    while (Date.now() < holdDeadline) {
      try {
        await fs.access(marker);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    await fs.access(marker).catch(() => {
      throw new Error('子进程未能持锁：' + childErr);
    });
    const startedAt = Date.now();
    const result = await importDays(dir, [{ date: dayOffset(-3), codexTokens: 333 }], { timeoutMs: 3000 });
    const waited = Date.now() - startedAt;
    await Promise.race([
      new Promise((resolve) => child.on('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 5000))
    ]);
    assert.equal(result.ok, true);
    assert.ok(waited >= 100, '应该等到外部锁释放（实际等待 ' + waited + 'ms）');
    const days = JSON.parse(await fs.readFile(file, 'utf8')).days;
    assert.equal(days[dayOffset(-3)].codexTokens, 333);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('G5 重复日期/同日多条：按 max 合并，与顺序无关', async () => {
  const rowsA = [
    { date: '2026-11-01', deepseekTokens: 100, deepseekCostCny: 0.1 },
    { date: '2026-11-01', deepseekTokens: 900, deepseekCostCny: 0.05 }
  ];
  const mergedA = mergeImportRows(rowsA);
  assert.deepEqual(mergedA, [{ date: '2026-11-01', deepseekTokens: 900, deepseekCostCny: 0.1 }]);
  const mergedB = mergeImportRows([...rowsA].reverse());
  assert.deepEqual(mergedB, mergedA, 'max 合并结果与顺序无关');

  const dir = await makeTempDir();
  try {
    await importDays(dir, [{ date: '2026-11-02', codexTokens: 10 }]);
    const result = await importDays(dir, [
      { date: '2026-11-02', codexTokens: 5 },
      { date: '2026-11-02', codexTokens: 77 }
    ]);
    assert.equal(result.summary.rows, 1, '同日多条应先合并为 1 行');
    const days = JSON.parse(await fs.readFile(historyFilePath(dir), 'utf8')).days;
    assert.equal(days['2026-11-02'].codexTokens, 77);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('G5 导入错误：最多回传 100 条（不再只回 20），并标记截断', () => {
  const lines = ['date,tokens'];
  for (let index = 0; index < 150; index += 1) lines.push('bad-' + index + ',1');
  const result = parseImportData('codex', lines.join('\n'));
  assert.equal(result.errors.length, MAX_IMPORT_ERRORS);
  assert.equal(result.errorsTruncated, true);
  assert.equal(result.errorCount, 150);
  const capped = limitImportErrors(['e1', 'e2', 'e3'], 2);
  assert.deepEqual([...capped], ['e1', 'e2']);
  assert.equal(capped.truncated, true);
  const all = limitImportErrors(['e1', 'e2'], 100);
  assert.equal(all.truncated, false);
  assert.equal(all.length, 2);
});
