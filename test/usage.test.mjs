import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { collectCodexUsage, collectDshUsage, collectUsage, buildUsageReport, collectCodexOfficialUsage, collectDailyUsage } from '../lib/usage.mjs';

async function tempHome() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'quota-board-usage-'));
}

test('Codex：汇总 token_usage_record，按 response_id 去重', async (t) => {
  const home = await tempHome();
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const dir = path.join(home, '.codex', 'sessions', '2026', '10', '26');
  await fs.mkdir(dir, { recursive: true });
  const usage = (input, cached, output, total) =>
    JSON.stringify({
      type: 'token_usage_record',
      payload: {
        response_id: 'resp-1',
        usage: {
          input_tokens: input,
          cached_input_tokens: cached,
          cache_write_input_tokens: 0,
          output_tokens: output,
          total_tokens: total
        }
      }
    });
  await fs.writeFile(
    path.join(dir, 'rollout-a.jsonl'),
    [
      JSON.stringify({ type: 'session_meta', payload: {} }),
      usage(100, 40, 10, 110),
      usage(100, 40, 10, 110), // 同一个 response_id，应去重
      usage(50, 0, 5, 55).replace('resp-1', 'resp-2')
    ].join('\n') + '\n'
  );

  const result = await collectCodexUsage({ home });
  assert.equal(result.records, 2);
  assert.equal(result.tokens.input, 150);
  assert.equal(result.tokens.cached, 40);
  assert.equal(result.tokens.output, 15);
  assert.equal(result.tokens.total, 165);
});

test('DSH：按 provider 归类 DeepSeek / OpenCode Go，并汇总成本', async (t) => {
  const home = await tempHome();
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const dir = path.join(home, '.dsh', 'storages', 'session_projcache', 'sessions');
  await fs.mkdir(dir, { recursive: true });

  const session = (provider, input, cached, output, cost) =>
    JSON.stringify({
      version: 7,
      record: {
        rows: {
          tokenUsage: {
            val: {
              totals: {
                uncachedInputTokens: input,
                cacheReadTokens: cached,
                cacheWriteTokens: 0,
                outputTokens: output
              }
            }
          },
          whalePetCost: {
            val: {
              route: { provider, model: 'x' },
              totals: { peakCny: 0, offPeakCny: cost, pricedRequests: 10, unpricedRequests: 0 }
            }
          }
        }
      }
    });

  await fs.writeFile(path.join(dir, 'a.json'), session('deepseek-official', 1000, 2000, 500, 1.25));
  await fs.writeFile(path.join(dir, 'b.json'), session('deepseek-account', 500, 100, 50, 0.25));
  await fs.writeFile(path.join(dir, 'c.json'), session('opencode-go', 300, 400, 30, 0.5));
  await fs.writeFile(path.join(dir, 'd.json'), session('bonsai-local', 9999, 9999, 9999, 9));
  await fs.writeFile(path.join(dir, 'broken.json'), '{not json');

  const channels = await collectDshUsage({ home });
  assert.equal(channels.deepseek.sessions, 2);
  assert.equal(channels.deepseek.tokens.input, 1500);
  assert.equal(channels.deepseek.tokens.cached, 2100);
  assert.equal(channels.deepseek.tokens.output, 550);
  assert.ok(Math.abs(channels.deepseek.costCny - 1.5) < 0.0001);
  assert.equal(channels.opencodeGo.sessions, 1);
  assert.equal(channels.opencodeGo.tokens.total, 730);
  assert.ok(Math.abs(channels.opencodeGo.costCny - 0.5) < 0.0001);
});

test('buildUsageReport：三个渠道与合计', async (t) => {
  const home = await tempHome();
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const codex = { tokens: { input: 10, cached: 5, cacheWrite: 0, output: 2, total: 12 }, records: 1 };
  const dsh = {
    deepseek: {
      tokens: { input: 100, cached: 200, cacheWrite: 0, output: 50, total: 350 },
      costCny: 1.234,
      priced: 3,
      unpriced: 0,
      sessions: 2,
      providers: {}
    },
    opencodeGo: {
      tokens: { input: 20, cached: 30, cacheWrite: 0, output: 10, total: 60 },
      costCny: 0.5,
      priced: 1,
      unpriced: 0,
      sessions: 1,
      providers: {}
    }
  };
  const report = buildUsageReport({ codex, dsh });
  assert.equal(report.channels.length, 3);
  assert.equal(report.totalTokens, 12 + 350 + 60);
  const deepseek = report.channels.find((channel) => channel.id === 'deepseek');
  assert.equal(deepseek.costCny, 1.23);
  const codexChannel = report.channels.find((channel) => channel.id === 'codex');
  assert.equal(codexChannel.costCny, null);
});

test('Codex 官方累计：按 account_id 去重并读取 lifetime_tokens', async (t) => {
  const home = await tempHome();
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const mk = async (name, accountId) => {
    const file = path.join(home, name);
    await fs.writeFile(
      file,
      JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'tok-' + name, account_id: accountId } })
    );
    return file;
  };
  const a1 = await mk('a.json', 'acct-1');
  const a2 = await mk('b.json', 'acct-1');
  const a3 = await mk('c.json', 'acct-2');

  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push(options.headers['ChatGPT-Account-Id']);
    return {
      ok: true,
      json: async () => ({
        profile: { display_name: options.headers['ChatGPT-Account-Id'] === 'acct-1' ? '账号B' : '账号A' },
        stats: { lifetime_tokens: options.headers['ChatGPT-Account-Id'] === 'acct-1' ? 318714879 : 1100000000, peak_daily_tokens: 5 }
      })
    };
  };
  const result = await collectCodexOfficialUsage({
    accounts: [
      { name: '账号B', authPath: a1 },
      { name: '重复登录', authPath: a2 },
      { name: '账号A', authPath: a3 }
    ],
    fetchImpl
  });
  assert.equal(calls.length, 2, '同一 account_id 只请求一次');
  assert.equal(result.accounts.length, 2);
  assert.equal(result.duplicates, 1);
  assert.equal(result.total, 318714879 + 1100000000);
});


test('collectDailyUsage：近 30 天序列包含 DSH 每日用量', async (t) => {
  const home = await tempHome();
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const dir = path.join(home, '.dsh', 'storages', 'session_projcache', 'sessions');
  await fs.mkdir(dir, { recursive: true });
  const now = Date.now();
  const record = (createdAt, provider, tokens, cost) =>
    JSON.stringify({
      record: {
        identity: { createdAt },
        rows: {
          tokenUsage: {
            val: { totals: { uncachedInputTokens: tokens, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 } }
          },
          whalePetCost: {
            val: { route: { provider }, totals: { peakCny: 0, offPeakCny: cost, pricedRequests: 1, unpricedRequests: 0 } }
          }
        }
      }
    });
  await fs.writeFile(path.join(dir, 'a.json'), record(now, 'deepseek-official', 1000000, 1.5));
  await fs.writeFile(path.join(dir, 'b.json'), record(now, 'opencode-go', 2000000, 2.5));

  const report = await collectDailyUsage({ home, codexAccounts: [], days: 30 });
  assert.equal(report.series.length, 30);
  const today = report.series[report.series.length - 1];
  assert.equal(today.deepseekTokens, 1000000);
  assert.equal(today.opencodeTokens, 2000000);
  assert.ok(Math.abs(today.deepseekCostCny - 1.5) < 0.001);
});


test('daily-history：合并保留历史、取最大值、不丢旧日期', async () => {
  const {
    normalizeHistory,
    mergeSeriesIntoHistory,
    historyRange,
    buildSeriesFromHistory
  } = await import('../lib/daily-history.mjs');

  const history = normalizeHistory(null);
  // 第一次采集：只有最近两天
  mergeSeriesIntoHistory(history, [
    { date: '2026-10-30', deepseekTokens: 100, deepseekCostCny: 0.1 },
    { date: '2026-10-31', deepseekTokens: 200, deepseekCostCny: 0.2 }
  ]);
  // 第二次采集：官方只回最近一天，且数值变大
  mergeSeriesIntoHistory(history, [
    { date: '2026-10-31', deepseekTokens: 260, deepseekCostCny: 0.26 },
    { date: '2026-11-01', deepseekTokens: 50, deepseekCostCny: 0.05 }
  ]);

  assert.equal(history.days['2026-10-30'].deepseekTokens, 100, '旧日期不能被删');
  assert.equal(history.days['2026-10-31'].deepseekTokens, 260, '新值更大时更新');
  assert.equal(history.days['2026-11-01'].deepseekTokens, 50, '新增日期');

  // 数据源回退（返回 0）时不能把历史抹掉
  mergeSeriesIntoHistory(history, [{ date: '2026-10-31', deepseekTokens: 0 }]);
  assert.equal(history.days['2026-10-31'].deepseekTokens, 260, '0 值不应覆盖历史');

  const range = historyRange(history);
  assert.equal(range.days, 3);
  assert.equal(range.firstDate, '2026-10-30');

  // Anchor the formatter to the fixture's last date, independent of today's date and timezone.
  const currentMs = Date.now();
  const fixtureLastDay = Date.UTC(2026, 10, 1);
  const series = buildSeriesFromHistory(history, 3, (ms) => {
    const offset = Math.round((currentMs - ms) / 86400000);
    return new Date(fixtureLastDay - offset * 86400000).toISOString().slice(0, 10);
  });
  assert.deepEqual(series.map(({ date, deepseekTokens }) => ({ date, deepseekTokens })), [
    { date: '2026-10-30', deepseekTokens: 100 },
    { date: '2026-10-31', deepseekTokens: 260 },
    { date: '2026-11-01', deepseekTokens: 50 }
  ]);
  assert.ok(series.every((entry) => typeof entry.codexTokens === 'number'));
});

test('daily-history：坏文件/缺字段不会崩', async () => {
  const { normalizeHistory, mergeDay } = await import('../lib/daily-history.mjs');
  const history = normalizeHistory({ days: { '2026-13-99': { x: 1 }, bad: 'x', '2026-10-01': { codexTokens: 'abc', deepseekTokens: 10 } } });
  assert.deepEqual(Object.keys(history.days), ['2026-10-01']);
  assert.equal(history.days['2026-10-01'].deepseekTokens, 10);
  const { day } = mergeDay(null, { date: '2026-10-02', codexTokens: -5, deepseekTokens: 3 });
  assert.equal(day.codexTokens, undefined);
  assert.equal(day.deepseekTokens, 3);
});

test('导入解析：CSV 表头/坏行/费用列', async () => {
  const { parseImportData } = await import('../lib/daily-history.mjs');
  const csv = [
    'date,tokens,cost',
    '2026-08-01,1200000,0.31',
    '2026-08-02,800000',
    'bad-date,100',
    '2026-08-03,-5',
    '2026-08-04,1000,0.1'
  ].join('\n');
  const { rows, errors } = parseImportData('deepseek', csv);
  assert.equal(rows.length, 3, '有效行 3 条（表头/坏日期/负数都跳过）');
  assert.equal(rows[0].deepseekTokens, 1200000);
  assert.equal(rows[0].deepseekCostCny, 0.31);
  assert.equal(rows[1].deepseekTokens, 800000);
  assert.ok(errors.length >= 2, '错误行要有提示');
});

test('导入解析：JSON 两种写法 + 非法 JSON', async () => {
  const { parseImportData } = await import('../lib/daily-history.mjs');
  const generic = parseImportData('codex', JSON.stringify([{ date: '2026-08-01', tokens: 500 }]));
  assert.equal(generic.rows[0].codexTokens, 500);
  const direct = parseImportData('opencode', JSON.stringify([{ date: '2026-08-02', opencodeTokens: 700, opencodeCostCny: 0.07 }]));
  assert.equal(direct.rows[0].opencodeTokens, 700);
  assert.equal(direct.rows[0].opencodeCostCny, 0.07);
  const bad = parseImportData('codex', '{not json');
  assert.equal(bad.rows.length, 0);
  assert.ok(bad.errors[0].includes('JSON'));
});

test('daily-history：来源明细按 key 取最大值、可跨天保留', async () => {
  const { normalizeHistory, mergeSeriesIntoHistory, buildSeriesFromHistory } = await import('../lib/daily-history.mjs');
  const history = normalizeHistory(null);
  mergeSeriesIntoHistory(history, [
    {
      date: '2026-10-30',
      codexTokens: 100,
      codexByAccount: { accA: 60, accB: 40 },
      opencodeTokens: 500,
      opencodeByProvider: { 'opencode-go': 300, 'opencode-go2': 200 }
    }
  ]);
  // 第二次：B 账号涨了、A 账号变小（数据源回退），C 订阅出现
  mergeSeriesIntoHistory(history, [
    {
      date: '2026-10-30',
      codexTokens: 120,
      codexByAccount: { accA: 10, accB: 110 },
      opencodeTokens: 500,
      opencodeByProvider: { 'opencode-go': 300, 'opencode-go2': 200, 'opencode-go3': 50 }
    }
  ]);
  const day = history.days['2026-10-30'];
  assert.equal(day.codexByAccount.accA, 60, '较小的新值不覆盖历史');
  assert.equal(day.codexByAccount.accB, 110, '较大的新值生效');
  assert.equal(day.opencodeByProvider['opencode-go3'], 50, '新出现的订阅要记录');

  const series = buildSeriesFromHistory(history, 1, () => '2026-10-30');
  assert.equal(series.length, 1);
  assert.deepEqual(series[0].codexByAccount, { accA: 60, accB: 110 });
  assert.equal(series[0].opencodeByProvider['opencode-go2'], 200);
});

test('daily-history：明细字段容错（负数/非数字被丢弃）', async () => {
  const { normalizeHistory } = await import('../lib/daily-history.mjs');
  const history = normalizeHistory({
    days: {
      '2026-10-01': {
        date: '2026-10-01',
        codexTokens: 100,
        codexByAccount: { ok: 50, bad: -5, worse: 'x', zero: 0 },
        opencodeByProvider: { 'opencode-go': 30 }
      }
    }
  });
  assert.deepEqual(Object.keys(history.days['2026-10-01'].codexByAccount), ['ok']);
  assert.equal(history.days['2026-10-01'].opencodeByProvider['opencode-go'], 30);
});
