import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  collectCodexUsage,
  collectDshUsage,
  collectUsage,
  buildUsageReport,
  collectCodexOfficialUsage,
  collectDailyUsage,
  buildCodexSummary,
  buildDailyCodexAccounts,
  decorateCodexProvider,
  deriveCodexWindow,
  collectCodexByAccountKeys,
  orphanAccountName,
  codexDayHasData,
  codexDayTokensOrNull
} from '../lib/usage.mjs';
import { resetCodexRefreshState } from '../lib/adapters.mjs';

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

test('DeepSeek：本机归档独立于平台登录态和 30 天估算', () => {
  const zero = () => ({ input: 0, cached: 0, cacheWrite: 0, output: 0, total: 0 });
  const dsh = {
    deepseek: { tokens: zero(), costCny: 0, priced: 0, unpriced: 0, sessions: 0, providers: {} },
    opencodeGo: { tokens: zero(), costCny: 0, priced: 0, unpriced: 0, sessions: 0, providers: {} }
  };
  const codex = { tokens: zero(), records: 0 };
  const deepseekOfficial = {
    tokens30d: 3362872343,
    spentCny: 410.39,
    requests30d: 11405,
    lifetimeTokensEstimate: 7484037072,
    daily: []
  };
  const archived = buildUsageReport({ codex, dsh, deepseekOfficial, deepseekLifetimeTokens: 9071854888 });
  const ds1 = archived.channels.find((channel) => channel.id === 'deepseek');
  assert.equal(ds1.tokens.total, 9071854888, '累计用量优先于估算');
  assert.ok(ds1.note.includes('累计用量'), '说明里要标明是累计用量');
  assert.ok(!ds1.note.includes('估算'), '说明里不能再写成估算');
  assert.equal(archived.totalTokens, 9071854888);

  const offline = buildUsageReport({ codex, dsh, deepseekArchive: { tokens: 9071854888, days: 40 } });
  assert.equal(offline.totalTokens, archived.totalTokens);
  assert.equal(offline.channels.find((channel) => channel.id === 'deepseek').source, 'archive');
  const firstRun = buildUsageReport({ codex, dsh, deepseekOfficial });
  const ds2 = firstRun.channels.find((channel) => channel.id === 'deepseek');
  assert.equal(ds2.tokens.total, null, '缺少已记录用量时不使用估算填补累计');
  assert.equal(ds2.source, 'unavailable');
  assert.equal(ds2.spentCny, 410.39);
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


test('collectDailyUsage：DSH 与 DeepSeek 官方逐日用量对齐 UTC+08 午夜', async (t) => {
  const home = await tempHome();
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const dir = path.join(home, '.dsh', 'storages', 'session_projcache', 'sessions');
  await fs.mkdir(dir, { recursive: true });
  const now = Date.parse('2026-03-08T16:00:00.000Z');
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
  await fs.writeFile(path.join(dir, 'c.json'), record(now - 1, 'deepseek-official', 3000000, 3.5));

  const report = await collectDailyUsage({ home, codexAccounts: [], days: 30, now });
  assert.equal(report.series.length, 30);
  const today = report.series[report.series.length - 1];
  assert.equal(today.date, '2026-03-09');
  assert.equal(today.deepseekTokens, 1000000);
  assert.equal(today.opencodeTokens, 2000000);
  assert.ok(Math.abs(today.deepseekCostCny - 1.5) < 0.001);
  const yesterday = report.series[report.series.length - 2];
  assert.equal(yesterday.date, '2026-03-08');
  assert.equal(yesterday.deepseekTokens, 3000000);

  const official = await collectDailyUsage({
    home,
    days: 2,
    now,
    deepseekDaily: [{ date: '2026-03-09', tokens: 1100000 }]
  });
  assert.deepEqual(official.series.map(({ date, deepseekTokens }) => [date, deepseekTokens]), [
    ['2026-03-08', 3000000],
    ['2026-03-09', 1100000]
  ]);
  assert.equal(official.totals.deepseekTokens, 4100000);
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

  const series = buildSeriesFromHistory(history, 3, (ms) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });
  assert.equal(series.length, 3);
  // 序列固定以“今天”收尾，断言不能写死日期，否则跨天就会假失败
  const today = new Date();
  const expectedLast =
    `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-` +
    String(today.getDate()).padStart(2, '0');
  assert.equal(series[series.length - 1].date, expectedLast);
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


// ============================================================
// A6：/api/usage 与 /api/daily 采集链的续期集成（mock fetch、零网络）
// ============================================================

const A6_REFRESH_URL = 'https://auth.openai.com/oauth/token';

function a6FakeJwt(payload) {
  const encode = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return encode({ alg: 'none', typ: 'JWT' }) + '.' + encode(payload) + '.sig';
}

function a6NowSec() {
  return Math.floor(Date.now() / 1000);
}

function a6Auth({ accountId = 'acct-a', refresh = 'rt-a-123456', expiresInSec = 10 * 24 * 3600 } = {}) {
  const iat = a6NowSec();
  return {
    auth_mode: 'chatgpt',
    last_refresh: new Date().toISOString(),
    tokens: {
      access_token: a6FakeJwt({ iat, exp: iat + expiresInSec }),
      refresh_token: refresh,
      id_token: a6FakeJwt({ iat, exp: iat + 3600 }),
      account_id: accountId
    }
  };
}

function a6RefreshBody() {
  const iat = a6NowSec();
  return {
    access_token: a6FakeJwt({ iat, exp: iat + 10 * 24 * 3600 }),
    refresh_token: 'rt-a-new-abcdef',
    id_token: a6FakeJwt({ iat, exp: iat + 3600 })
  };
}

async function a6AuthFile(content) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'quota-board-a6-'));
  const file = path.join(dir, 'auth.json');
  await fs.writeFile(file, JSON.stringify(content));
  return file;
}

function profileBody(accountId) {
  return {
    profile: { display_name: '账号' + accountId },
    stats: { lifetime_tokens: 1000, peak_daily_tokens: 100, daily_usage_buckets: [] }
  };
}

test('A6-10 /api/usage：400 后按需续期并重试成功，accounts 带 refreshedAt', async () => {
  resetCodexRefreshState();
  const authPath = await a6AuthFile(a6Auth());
  let whamCalls = 0;
  let tokenCalls = 0;
  const fetchImpl = async (url, options) => {
    if (url === A6_REFRESH_URL) {
      tokenCalls += 1;
      return { status: 200, ok: true, text: async () => JSON.stringify(a6RefreshBody()) };
    }
    assert.equal(url, 'https://chatgpt.com/backend-api/wham/profiles/me');
    whamCalls += 1;
    if (whamCalls === 1) {
      return { status: 401, ok: false, text: async () => JSON.stringify({ error: { message: 'invalidated' } }) };
    }
    return { status: 200, ok: true, text: async () => JSON.stringify(profileBody('acct-a')) };
  };
  const result = await collectCodexOfficialUsage({
    accounts: [{ name: '托管号', authPath, allowRefresh: true }],
    fetchImpl
  });
  assert.equal(whamCalls, 2);
  assert.equal(tokenCalls, 1);
  assert.equal(result.accounts.length, 1);
  assert.equal(result.failed.length, 0);
  assert.ok(result.accounts[0].refresh.refreshedAt);
  assert.equal(result.refresh.refreshed, 1);
  assert.equal(result.total, 1000);
});

test('A6-11 /api/usage：续期 invalid_grant → failed 带 refresh 状态，不中断其它采集', async () => {
  resetCodexRefreshState();
  const authPath = await a6AuthFile(a6Auth());
  const fetchImpl = async (url) => {
    if (url === A6_REFRESH_URL) {
      return { status: 401, ok: false, text: async () => JSON.stringify({ error: { code: 'refresh_token_invalidated' } }) };
    }
    return { status: 401, ok: false, text: async () => JSON.stringify({ error: { message: 'invalidated' } }) };
  };
  const result = await collectCodexOfficialUsage({
    accounts: [{ name: '归档号', authPath, allowRefresh: true }],
    fetchImpl
  });
  assert.equal(result.accounts.length, 0);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].refresh.code, 'invalid_grant');
  assert.match(result.failed[0].error, /HTTP 401/);
  assert.equal(result.refresh.failed, 1);
});

test('A6-12 /api/usage：双账号隔离，一个续期失败不影响另一个', async () => {
  resetCodexRefreshState();
  const badPath = await a6AuthFile(a6Auth({ accountId: 'acct-bad', refresh: 'rt-bad-123456' }));
  const goodPath = await a6AuthFile(a6Auth({ accountId: 'acct-good', refresh: 'rt-good-123456' }));
  const fetchImpl = async (url, options) => {
    if (url === A6_REFRESH_URL) {
      const body = JSON.parse(options.body);
      if (body.refresh_token === 'rt-bad-123456') {
        return { status: 401, ok: false, text: async () => JSON.stringify({ error: { code: 'refresh_token_invalidated' } }) };
      }
      return { status: 200, ok: true, text: async () => JSON.stringify(a6RefreshBody()) };
    }
    const accountId = options.headers['ChatGPT-Account-Id'];
    if (accountId === 'acct-bad') {
      return { status: 401, ok: false, text: async () => JSON.stringify({ error: { message: 'invalidated' } }) };
    }
    return { status: 200, ok: true, text: async () => JSON.stringify(profileBody('acct-good')) };
  };
  const result = await collectCodexOfficialUsage({
    accounts: [
      { name: '坏号', authPath: badPath, allowRefresh: true },
      { name: '好号', authPath: goodPath, allowRefresh: true }
    ],
    fetchImpl
  });
  assert.equal(result.accounts.length, 1);
  assert.equal(result.accounts[0].id, 'acct-good');
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].accountId, 'acct-bad');
});

test('A6-13 /api/usage：旧归档账号（allowRefresh=false）401 行为与以前一致', async () => {
  resetCodexRefreshState();
  const authPath = await a6AuthFile(a6Auth());
  let tokenCalls = 0;
  const fetchImpl = async (url) => {
    if (url === A6_REFRESH_URL) {
      tokenCalls += 1;
      return { status: 200, ok: true, text: async () => JSON.stringify(a6RefreshBody()) };
    }
    return { status: 401, ok: false, text: async () => JSON.stringify({ error: { message: 'invalidated' } }) };
  };
  const result = await collectCodexOfficialUsage({
    accounts: [{ name: '旧归档', authPath }],
    fetchImpl
  });
  assert.equal(tokenCalls, 0, '未开启 autoRefresh 的账号不能续期');
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].error, 'HTTP 401');
  assert.equal(result.failed[0].refresh, null);
});

test('A6-14 /api/daily + buildUsageReport：续期状态进入 codexStale 与 channel.refresh', async () => {
  resetCodexRefreshState();
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'quota-board-a6-home-'));
  const authPath = await a6AuthFile(a6Auth());
  const fetchImpl = async (url) => {
    if (url === A6_REFRESH_URL) {
      return { status: 401, ok: false, text: async () => JSON.stringify({ error: { code: 'refresh_token_invalidated' } }) };
    }
    return { status: 401, ok: false, text: async () => JSON.stringify({ error: { message: 'invalidated' } }) };
  };
  const daily = await collectDailyUsage({
    home,
    codexAccounts: [{ name: '归档号', authPath, allowRefresh: true }],
    days: 7,
    fetchImpl
  });
  assert.equal(daily.codexStale.length, 1);
  assert.equal(daily.codexStale[0].refresh.code, 'invalid_grant');
  await fs.rm(home, { recursive: true, force: true });

  const zero = () => ({ input: 0, cached: 0, cacheWrite: 0, output: 0, total: 0 });
  const dsh = {
    deepseek: { tokens: zero(), costCny: 0, priced: 0, unpriced: 0, sessions: 0, providers: {} },
    opencodeGo: { tokens: zero(), costCny: 0, priced: 0, unpriced: 0, sessions: 0, providers: {} }
  };
  const refreshSummary = { attempted: 1, refreshed: 0, failed: 1, accounts: [{ name: '归档号', refreshedAt: null, code: 'invalid_grant', lastError: 'x' }] };
  const report = buildUsageReport({
    codex: { tokens: zero(), records: 0 },
    dsh,
    codexOfficial: { total: 0, accounts: [], duplicates: 0, daily: [], failed: [], refresh: refreshSummary }
  });
  const codexChannel = report.channels.find((channel) => channel.id === 'codex');
  assert.equal(codexChannel.refresh.failed, 1);
  assert.equal(codexChannel.refresh.accounts[0].code, 'invalid_grant');
});

// ============================================================
// C3：窗口派生 / 计划元数据透传 / 多账号汇总（纯函数、零网络）
// ============================================================

test('C3-1 deriveCodexWindow：按 windowSeconds 派生 kind，并纠正旧快照的错误标签', () => {
  // 实测 live 是 prolite：primary_window.limit_window_seconds=604800，旧代码写死成 5h
  const weekly = deriveCodexWindow({
    key: '5h',
    label: '5 小时',
    windowSeconds: 604800,
    usedPercent: 0,
    resetAt: '2026-11-20T15:05:24.000Z'
  });
  assert.equal(weekly.key, 'weekly');
  assert.equal(weekly.label, '每周');
  assert.equal(weekly.kind, 'weekly');
  assert.equal(weekly.windowSeconds, 604800, 'windowSeconds 原语义保留');
  assert.equal(weekly.usedPercent, 0);
  assert.equal(weekly.resetAt, '2026-11-20T15:05:24.000Z');

  assert.equal(deriveCodexWindow({ key: '5h', label: '5 小时', windowSeconds: 18000 }).kind, 'session');
  assert.equal(deriveCodexWindow({ key: 'monthly', label: '每月', windowSeconds: 2592000 }).kind, 'monthly');
  const custom = deriveCodexWindow({ key: 'x', label: '2 小时', windowSeconds: 7200 });
  assert.equal(custom.kind, 'custom');
  assert.equal(custom.key, 'w7200');
  assert.match(custom.label, /2/);

  const unknown = deriveCodexWindow({ key: '5h', label: '5 小时', windowSeconds: null });
  assert.equal(unknown.kind, 'custom', '缺失秒数时归入 custom，保留旧 key/label');
  assert.equal(unknown.key, '5h');
  assert.equal(unknown.label, '5 小时');
  assert.equal(deriveCodexWindow(null), null);
});

test('C3-2 decorateCodexProvider：补 accountId/planMeta/windows.kind，保留 refresh 且不改入参', () => {
  const provider = {
    kind: 'codex',
    id: 'codex:live',
    name: 'Codex · 主号',
    status: 'ok',
    plan: 'prolite',
    managed: true,
    refresh: { attempted: false, refreshedAt: null, lastError: null },
    fetchedAt: '2026-11-13T23:00:00Z',
    windows: [{ key: '5h', label: '5 小时', windowSeconds: 604800, usedPercent: 7, resetAt: '2026-11-20T15:05:24.000Z' }]
  };
  const out = decorateCodexProvider(provider, { accountId: 'acct-1' });
  assert.equal(out.accountId, 'acct-1');
  assert.equal(out.planMeta.name, 'Pro Lite');
  assert.deepEqual(out.planMeta.expectedWindows, ['weekly']);
  assert.equal(out.windows[0].kind, 'weekly');
  assert.equal(out.windows[0].key, 'weekly');
  assert.deepEqual(out.refresh, { attempted: false, refreshedAt: null, lastError: null });
  assert.equal(provider.accountId, undefined, '不应修改传入的 provider 对象');

  // 适配器（C2）已经带 planMeta 时以它为准，不被覆盖
  const kept = decorateCodexProvider({
    kind: 'codex',
    plan: 'plus',
    planMeta: { id: 'plus', name: '自定义计划名', tier: 'plus', expectedWindows: [], note: '' },
    windows: []
  });
  assert.equal(kept.planMeta.name, '自定义计划名');
});

test('C3-3 buildCodexSummary：多号同登 total/active/multi 与每号窗口', () => {
  const providers = [
    {
      kind: 'codex',
      id: 'codex:live',
      accountId: 'acct-plus',
      historyKey: 'id:acct-plus',
      name: 'Codex · 主号',
      status: 'ok',
      plan: 'plus',
      fetchedAt: '2026-11-13T23:00:00Z',
      windows: [
        { key: '5h', windowSeconds: 18000, usedPercent: 12, resetAt: '2026-11-14T01:00:00.000Z' },
        { key: 'weekly', windowSeconds: 604800, usedPercent: 34, resetAt: '2026-11-20T00:00:00.000Z' }
      ]
    },
    {
      kind: 'codex',
      id: 'codex:arch',
      accountId: 'acct-pro',
      name: 'Codex · 托管号',
      status: 'ok',
      plan: 'prolite',
      managed: true,
      fetchedAt: '2026-11-13T23:01:00Z',
      windows: [{ key: 'weekly', windowSeconds: 604800, usedPercent: 7, resetAt: null }]
    },
    {
      kind: 'codex',
      id: 'codex:old',
      historyKey: 'id:acct-old',
      name: '旧号',
      status: 'stale',
      historyOnly: true,
      plan: 'plus',
      fetchedAt: '2026-11-10T00:00:00Z',
      windows: [{ key: '5h', windowSeconds: 18000, usedPercent: 50, resetAt: null }]
    },
    { kind: 'relay', id: 'relay-1', name: '中转站', status: 'ok', windows: [] }
  ];
  const summary = buildCodexSummary(providers);
  assert.equal(summary.total, 3);
  assert.equal(summary.active, 2, '两个实时 ok 账号有效；historyOnly 历史快照不算在线');
  assert.equal(summary.multi, true);

  const plus = summary.accounts.find((account) => account.id === 'acct-plus');
  assert.equal(plus.name, '主号', '汇总行名字不带「Codex · 」前缀');
  assert.equal(plus.plan, 'plus');
  assert.equal(plus.planName, 'Plus');
  assert.equal(plus.status, 'ok');
  assert.equal(plus.updatedAt, '2026-11-13T23:00:00Z');
  assert.deepEqual(
    plus.windows.map((window) => [window.key, window.kind, window.label, window.usedPercent, window.resetAt]),
    [
      ['5h', 'session', '5 小时', 12, '2026-11-14T01:00:00.000Z'],
      ['weekly', 'weekly', '每周', 34, '2026-11-20T00:00:00.000Z']
    ]
  );

  const pro = summary.accounts.find((account) => account.id === 'acct-pro');
  assert.equal(pro.planName, 'Pro Lite');
  assert.deepEqual(pro.windows.map((window) => window.kind), ['weekly']);
  const old = summary.accounts.find((account) => account.id === 'acct-old');
  assert.equal(old.status, 'stale');
  assert.equal(old.planName, 'Plus');
});

test('C3-4 buildCodexSummary：active 判定（stale 有快照算、error 不算）、占位卡与空配置兜底', () => {
  const staleConfigured = {
    kind: 'codex',
    accountId: 's1',
    historyKey: 'id:s1',
    name: 'Codex · 断网号',
    status: 'stale',
    plan: 'plus',
    windows: [{ key: '5h', windowSeconds: 18000, usedPercent: 10 }]
  };
  const staleEmpty = {
    kind: 'codex',
    accountId: 's2',
    historyKey: 'id:s2',
    name: 'Codex · 空快照号',
    status: 'stale',
    windows: []
  };
  const errorAccount = { kind: 'codex', accountId: 'e1', historyKey: 'id:e1', name: '坏号', status: 'error', windows: [] };
  const placeholder = { kind: 'codex', id: 'codex', name: 'Codex 账户', status: 'unconfigured', windows: [] };

  const summary = buildCodexSummary([staleConfigured, staleEmpty, errorAccount, placeholder]);
  assert.equal(summary.total, 3, '占位卡不计入账号数');
  assert.equal(summary.active, 1, 'stale 且有历史额度算有效；空快照/error 不算');
  assert.equal(summary.multi, false);

  assert.deepEqual(buildCodexSummary([]), { total: 0, active: 0, multi: false, accounts: [] });
  assert.deepEqual(buildCodexSummary([placeholder]), { total: 0, active: 0, multi: false, accounts: [] });

  // 登录态文件缺失、拿不到 account_id 又没有额度数据的 live 卡：只是错误占位，不算一个账号
  const unidentified = { kind: 'codex', id: 'codex:live', name: 'Codex · 当前登录', status: 'error', windows: [] };
  const onlyIdentified = buildCodexSummary([unidentified, staleConfigured]);
  assert.equal(onlyIdentified.total, 1, '不可识别的错误占位卡不占账号数');
  assert.equal(onlyIdentified.active, 1);
  assert.equal(onlyIdentified.multi, false);
});

test('C3-5 buildDailyCodexAccounts：账号列表带计划名，当前名字优先', () => {
  const accounts = buildDailyCodexAccounts({
    accounts: [{ id: 'acct-plus', name: '现在的名字' }],
    history: {
      accounts: {
        'id:acct-plus': { name: '旧名字', plan: 'plus' },
        'id:acct-pro': { name: 'ProLite 号', plan: 'prolite' },
        live: { name: '没有 account_id 的 key', plan: 'plus' }
      }
    }
  });
  assert.deepEqual(accounts, [
    { id: 'acct-plus', name: '现在的名字', planName: 'Plus' },
    { id: 'acct-pro', name: 'ProLite 号', planName: 'Pro Lite' }
  ]);
  assert.deepEqual(buildDailyCodexAccounts({}), []);
});

test('C3-6 同名多号消歧：codexSummary 与 daily 账号列表追加短 accountId，单号保持原名', () => {
  const liveId = 'aaaaaaaa-1111-2222-3333-444444444444';
  const archId = 'bbbbbbbb-1111-2222-3333-444444444444';
  const provider = (accountId, plan, windowSeconds, usedPercent) => ({
    kind: 'codex',
    accountId,
    historyKey: 'id:' + accountId,
    name: 'Codex · Louie',
    status: 'ok',
    plan,
    windows: [{ key: '5h', windowSeconds, usedPercent }]
  });
  const summary = buildCodexSummary([
    provider(liveId, 'plus', 18000, 10),
    provider(archId, 'prolite', 604800, 20)
  ]);
  assert.deepEqual(
    summary.accounts.map((account) => account.name),
    ['Louie · aaaaaaaa', 'Louie · bbbbbbbb'],
    '同名多号必须能区分'
  );

  const single = buildCodexSummary([provider(liveId, 'plus', 18000, 10)]);
  assert.equal(single.accounts[0].name, 'Louie', '单号保持原名不变');

  const daily = buildDailyCodexAccounts({
    accounts: [
      { id: liveId, name: 'Louie' },
      { id: archId, name: 'Louie' }
    ]
  });
  assert.deepEqual(daily.map((account) => account.name), ['Louie · aaaaaaaa', 'Louie · bbbbbbbb']);
  assert.deepEqual(
    buildDailyCodexAccounts({ accounts: [{ id: liveId, name: 'Louie' }] }).map((account) => account.name),
    ['Louie']
  );
});

// ============================================================
// G8：每日归属一致性（codexByAccount 孤儿键 / 无数据 null 语义）
// ============================================================

test('G8-1 buildDailyCodexAccounts：孤儿键映射为「未知账号 · 短 id」，不裸 UUID', () => {
  const known = 'aaaaaaaa-1111-2222-3333-444444444444';
  const ghost = 'deadbeef-1111-2222-3333-444444444444';
  const accounts = buildDailyCodexAccounts({
    accounts: [{ id: known, name: '主号' }],
    history: { accounts: {} },
    days: {
      '2026-11-10': { date: '2026-11-10', codexTokens: 300, codexByAccount: { [known]: 100, [ghost]: 200 } },
      '2026-11-11': { date: '2026-11-11', codexTokens: 0, codexByAccount: {} }
    }
  });
  const ghostRow = accounts.find((account) => account.id === ghost);
  assert.ok(ghostRow, '孤儿键必须补进 codexAccounts');
  assert.equal(ghostRow.name, '未知账号 · deadbeef');
  assert.equal(ghostRow.orphan, true);
  assert.equal(ghostRow.planName, null);
  assert.ok(!accounts.some((account) => account.name === ghost), '不能直接输出裸 UUID 作为名字');
  assert.equal(orphanAccountName(ghost), '未知账号 · deadbeef');

  const knownRow = accounts.find((account) => account.id === known);
  assert.equal(knownRow.name, '主号');
  assert.ok(!knownRow.orphan, '已知账号不应被标 orphan');

  // 兼容：不传 days 时行为与旧版一致（只有账号/历史快照）
  const legacy = buildDailyCodexAccounts({ accounts: [{ id: known, name: '主号' }] });
  assert.deepEqual(legacy.map((account) => account.id), [known]);
});

test('G8-2 collectCodexByAccountKeys：收集孤儿键、忽略 0/负值、兼容 {days} 包装', () => {
  const days = {
    '2026-11-09': { codexByAccount: { a: 10, zero: 0, neg: -1 } },
    '2026-11-10': { codexByAccount: { b: 5 } },
    '2026-11-11': { codexTokens: 0 }
  };
  assert.deepEqual(collectCodexByAccountKeys(days), ['a', 'b']);
  assert.deepEqual(collectCodexByAccountKeys({ days }), ['a', 'b']);
  assert.deepEqual(collectCodexByAccountKeys(null), []);
});

test('G8-3 /api/daily 一致性：每日 codexByAccount 键 ⊆ codexAccounts id，且合计不虚增', async () => {
  const { normalizeHistory, buildSeriesFromHistory } = await import('../lib/daily-history.mjs');
  const known = 'aaaaaaaa-1111-2222-3333-444444444444';
  const ghost = 'deadbeef-1111-2222-3333-444444444444';
  const now = new Date();
  const today = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
  const history = normalizeHistory({
    version: 1,
    days: {
      [today]: {
        date: today,
        codexTokens: 300,
        codexByAccount: { [known]: 100, [ghost]: 200 }
      }
    }
  });
  const accounts = buildDailyCodexAccounts({ accounts: [{ id: known, name: '主号' }], days: history.days });
  const ids = new Set(accounts.map((account) => account.id));
  for (const key of collectCodexByAccountKeys(history.days)) {
    assert.ok(ids.has(key), 'codexByAccount 键 ' + key + ' 必须在 codexAccounts 里可映射');
  }
  const series = buildSeriesFromHistory(history, 7, (ms) => {
    const d = new Date(ms);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  });
  const todayEntry = series.find((entry) => entry.date === today);
  for (const key of Object.keys(todayEntry.codexByAccount)) assert.ok(ids.has(key));
  const sum = Object.values(todayEntry.codexByAccount).reduce((acc, value) => acc + Number(value || 0), 0);
  assert.equal(sum, todayEntry.codexTokens, '分账号之和必须等于当日合计');
});

test('G8-4 无数据日：codexDayHasData/codexDayTokensOrNull 返回缺失语义（null），不伪造 0', () => {
  assert.equal(codexDayHasData({ date: '2026-11-13', codexTokens: 0, codexByAccount: {} }), false);
  assert.equal(codexDayTokensOrNull({ date: '2026-11-13', codexTokens: 0, codexByAccount: {} }), null);
  assert.equal(codexDayHasData({ codexTokens: 0 }), false);
  assert.equal(codexDayTokensOrNull({ codexTokens: 0 }), null);
  assert.equal(codexDayHasData({ codexTokens: 123, codexByAccount: {} }), true);
  assert.equal(codexDayTokensOrNull({ codexTokens: 123 }), 123);
  assert.equal(codexDayHasData({ codexByAccount: { a: 5 } }), true);
  assert.equal(codexDayTokensOrNull({ codexTokens: 0, codexByAccount: { a: 5 } }), 0);
  assert.equal(codexDayHasData(null), false);
  assert.equal(codexDayTokensOrNull(undefined), null);
});

test('G8-5 缓存合并复核：同一天重复合并 / 快照回填后孤儿键不重复、不膨胀', async () => {
  const { normalizeHistory, mergeSeriesIntoHistory } = await import('../lib/daily-history.mjs');
  const known = 'aaaaaaaa-1111-2222-3333-444444444444';
  const ghost = 'ghost-account';
  const history = normalizeHistory(null);
  mergeSeriesIntoHistory(history, [
    { date: '2026-11-10', codexTokens: 300, codexByAccount: { [known]: 100, [ghost]: 200 } }
  ]);
  // 第二轮采集只拿回已知账号、且数值更大：孤儿键不能被抹掉，也不能重复
  mergeSeriesIntoHistory(history, [{ date: '2026-11-10', codexTokens: 350, codexByAccount: { [known]: 150 } }]);
  const day = history.days['2026-11-10'];
  assert.deepEqual(day.codexByAccount, { [known]: 150, [ghost]: 200 });
  assert.equal(day.codexTokens, 350);
  const accounts = buildDailyCodexAccounts({ days: history.days });
  const ids = accounts.map((account) => account.id).sort();
  assert.deepEqual(ids, [known, ghost].sort());
});



