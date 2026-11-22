import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  HttpError,
  UnconfiguredError,
  fetchCodexUsage,
  fetchNewApiAccount,
  fetchNewApiToken,
  fetchOpencodeGoUsage,
  fetchRelay,
  fetchSub2Api,
  fetchDeepSeekBalance,
  fetchDeepSeekPlatform,
  resolveOpencodeGoKey,
  resetCodexRefreshState
} from '../lib/adapters.mjs';

function mockResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
  };
}

async function tempAuthFile(content) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'quota-board-auth-'));
  const file = path.join(dir, 'auth.json');
  await fs.writeFile(file, JSON.stringify(content));
  return file;
}

test('Codex: 解析 5h / 周窗口与 reset 时间', async () => {
  const authPath = await tempAuthFile({
    auth_mode: 'chatgpt',
    tokens: { access_token: 'tok_secret_abcdef', account_id: 'acct_9' }
  });
  const resetAt = Math.floor(Date.now() / 1000) + 3600;
  const fetchImpl = async (url, options) => {
    assert.equal(url, 'https://chatgpt.com/backend-api/wham/usage');
    assert.equal(options.headers.Authorization, 'Bearer tok_secret_abcdef');
    assert.equal(options.headers['ChatGPT-Account-Id'], 'acct_9');
    return mockResponse(200, {
      plan_type: 'plus',
      credits: { has_credits: false, unlimited: false, balance: '0' },
      rate_limit: {
        primary_window: { used_percent: 42, reset_at: resetAt, limit_window_seconds: 18000 },
        secondary_window: { used_percent: 61.5, reset_at: resetAt + 86400, limit_window_seconds: 604800 }
      }
    });
  };
  const provider = await fetchCodexUsage({ authPath, fetchImpl });
  assert.equal(provider.status, 'ok');
  assert.equal(provider.plan, 'plus');
  assert.equal(provider.windows.length, 2);
  assert.equal(provider.windows[0].key, '5h');
  assert.equal(provider.windows[0].usedPercent, 42);
  assert.ok(provider.windows[0].resetAt);
  assert.equal(provider.windows[1].usedPercent, 61.5);
  // 周期身份由 limit_window_seconds 派生，kind 是新增语义字段。
  assert.equal(provider.windows[0].label, '5 小时');
  assert.equal(provider.windows[0].kind, 'session');
  assert.equal(provider.windows[0].windowSeconds, 18000);
  assert.equal(provider.windows[1].key, 'weekly');
  assert.equal(provider.windows[1].label, '每周');
  assert.equal(provider.windows[1].kind, 'weekly');
  assert.equal(provider.windows[1].windowSeconds, 604800);
  assert.equal(provider.planMeta.id, 'plus');
  assert.equal(provider.planMeta.name, 'Plus');
  assert.deepEqual(provider.planMeta.expectedWindows, ['5h', 'weekly']);
  assert.equal(provider.credits.balance, 0);
  assert.equal(provider.credits.hasCredits, false);
});

test('Codex: prolite 单周窗口（primary=604800，secondary=null）', async () => {
  const authPath = await tempAuthFile({
    auth_mode: 'chatgpt',
    tokens: { access_token: 'tok_secret_abcdef', account_id: 'acct_prolite' }
  });
  const resetAt = Math.floor(Date.now() / 1000) + 3 * 86400;
  const fetchImpl = async () =>
    mockResponse(200, {
      plan_type: 'prolite',
      credits: { has_credits: false, unlimited: false, balance: '0' },
      rate_limit: {
        primary_window: { used_percent: 37, reset_at: resetAt, limit_window_seconds: 604800 },
        secondary_window: null
      }
    });
  const provider = await fetchCodexUsage({ authPath, fetchImpl });
  assert.equal(provider.plan, 'prolite');
  assert.equal(provider.windows.length, 1, 'prolite 只有主窗口，不能凭空造出第二窗口');
  const [window] = provider.windows;
  assert.equal(window.key, 'weekly', 'primary 槽位的 604800 秒必须派生为 weekly，而不是 5h');
  assert.equal(window.label, '每周');
  assert.equal(window.kind, 'weekly');
  assert.equal(window.usedPercent, 37);
  assert.equal(window.windowSeconds, 604800);
  assert.ok(window.resetAt);
  assert.equal(provider.planMeta.id, 'prolite');
  assert.equal(provider.planMeta.name, 'Pro Lite');
  assert.deepEqual(provider.planMeta.expectedWindows, ['weekly']);
  assert.match(provider.planMeta.note, /每周/);
});

test('Codex: 未知周期派生 custom，不再硬编码 5 小时/每周', async () => {
  const authPath = await tempAuthFile({ tokens: { access_token: 'tok_secret_abcdef' } });
  const fetchImpl = async () =>
    mockResponse(200, {
      plan_type: 'plus',
      rate_limit: {
        primary_window: { used_percent: 12, reset_at: Math.floor(Date.now() / 1000) + 600, limit_window_seconds: 12345 },
        secondary_window: null
      }
    });
  const provider = await fetchCodexUsage({ authPath, fetchImpl });
  const [window] = provider.windows;
  assert.equal(window.key, 'w12345');
  assert.equal(window.kind, 'custom');
  assert.equal(window.label, '3.43 小时');
  assert.equal(window.windowSeconds, 12345);
  assert.notEqual(window.label, '5 小时');
});

test('Codex: limit_window_seconds 缺失时安全兜底（未知窗口，不崩）', async () => {
  const authPath = await tempAuthFile({ tokens: { access_token: 'tok_secret_abcdef' } });
  const fetchImpl = async () =>
    mockResponse(200, {
      plan_type: 'plus',
      rate_limit: { primary_window: { used_percent: 5, reset_at: Math.floor(Date.now() / 1000) + 300 } }
    });
  const provider = await fetchCodexUsage({ authPath, fetchImpl });
  const [window] = provider.windows;
  assert.equal(window.key, 'unknown');
  assert.equal(window.kind, 'custom');
  assert.equal(window.label, '未知窗口');
  assert.equal(window.windowSeconds, null);
  assert.equal(provider.planMeta.id, 'plus');
});

test('Codex: 未识别计划 planMeta 兜底 unknown，窗口仍按实际返回', async () => {
  const authPath = await tempAuthFile({ tokens: { access_token: 'tok_secret_abcdef' } });
  const resetAt = Math.floor(Date.now() / 1000) + 3600;
  const fetchImpl = async () =>
    mockResponse(200, {
      plan_type: 'weird_tier',
      rate_limit: {
        primary_window: { used_percent: 20, reset_at: resetAt, limit_window_seconds: 18000 },
        secondary_window: { used_percent: 30, reset_at: resetAt + 86400, limit_window_seconds: 604800 }
      }
    });
  const provider = await fetchCodexUsage({ authPath, fetchImpl });
  assert.equal(provider.plan, 'weird_tier');
  assert.equal(provider.planMeta.id, 'weird_tier');
  assert.equal(provider.planMeta.tier, 'unknown');
  assert.deepEqual(provider.planMeta.expectedWindows, []);
  assert.match(provider.planMeta.note, /实际窗口/);
  assert.deepEqual(
    provider.windows.map((item) => item.key),
    ['5h', 'weekly']
  );
});

test('Codex: additional_rate_limits 走同一周期派生', async () => {
  const authPath = await tempAuthFile({ tokens: { access_token: 'tok_secret_abcdef' } });
  const resetAt = Math.floor(Date.now() / 1000) + 3600;
  const fetchImpl = async () =>
    mockResponse(200, {
      plan_type: 'plus',
      rate_limit: {
        primary_window: { used_percent: 10, reset_at: resetAt, limit_window_seconds: 18000 },
        secondary_window: { used_percent: 20, reset_at: resetAt + 86400, limit_window_seconds: 604800 },
        additional_rate_limits: [
          {
            display_name: 'Spark',
            rate_limit: {
              primary_window: { used_percent: 12, reset_at: resetAt + 172800, limit_window_seconds: 604800 }
            }
          }
        ]
      }
    });
  const provider = await fetchCodexUsage({ authPath, fetchImpl });
  const extra = provider.windows.find((item) => item.key.startsWith('extra:Spark'));
  assert.ok(extra, '附加额度窗口必须保留 extra: 前缀');
  assert.equal(extra.kind, 'weekly');
  assert.equal(extra.label, 'Spark · 每周');
  assert.equal(extra.usedPercent, 12);
  assert.equal(extra.windowSeconds, 604800);
  assert.ok(extra.resetAt);
});

test('Codex: free 计划没有窗口时 ok + windows=[] + 提示，不抛错', async () => {
  const authPath = await tempAuthFile({ tokens: { access_token: 'tok_secret_abcdef' } });
  const fetchImpl = async () =>
    mockResponse(200, {
      plan_type: 'free',
      credits: { has_credits: false, unlimited: false, balance: '0' },
      rate_limit: null
    });
  const provider = await fetchCodexUsage({ authPath, fetchImpl });
  assert.equal(provider.status, 'ok');
  assert.deepEqual(provider.windows, []);
  assert.equal(provider.planMeta.id, 'free');
  assert.ok(provider.notes.includes('该计划未提供额度窗口'));
});

test('Codex: 已识别计划但接口没返回窗口 → ok + 提示；完全未知结构仍抛错', async () => {
  const authPath = await tempAuthFile({ tokens: { access_token: 'tok_secret_abcdef' } });
  const emptyFetch = async () =>
    mockResponse(200, {
      plan_type: 'plus',
      rate_limit: { primary_window: null, secondary_window: null }
    });
  const provider = await fetchCodexUsage({ authPath, fetchImpl: emptyFetch });
  assert.equal(provider.status, 'ok');
  assert.deepEqual(provider.windows, []);
  assert.ok(provider.notes.includes('接口未返回窗口'));

  const unknownFetch = async () => mockResponse(200, { something: 'unexpected' });
  await assert.rejects(
    () => fetchCodexUsage({ authPath, fetchImpl: unknownFetch }),
    (err) => err instanceof HttpError && err.status === 200 && /额度窗口/.test(err.message)
  );
});

test('Codex: 缺少登录态时抛 UnconfiguredError', async () => {
  const filename = 'definitely-missing-auth.json';
  await assert.rejects(
    () => fetchCodexUsage({ authPath: path.join(os.tmpdir(), filename) }),
    (err) => err instanceof UnconfiguredError && /未找到可用的 Codex 登录态/.test(err.message) && !err.message.includes(filename)
  );
});

test('Codex: 403 只保留可读状态，不返回上游错误正文', async () => {
  const authPath = await tempAuthFile({ tokens: { access_token: 'tok_secret_abcdef' } });
  const fetchImpl = async () => mockResponse(403, { error: { message: 'fixture@example.invalid tok_secret_abcdef' } });
  await assert.rejects(
    () => fetchCodexUsage({ authPath, fetchImpl }),
    (err) => err instanceof HttpError && err.status === 403 &&
      err.message === '上游返回 HTTP 403' && err.body === ''
  );
});

test('OpenCode Go：网络异常或意外正文仅返回固定提示', async () => {
  const key = 'opencode-private-fixture';
  await assert.rejects(
    () => fetchOpencodeGoUsage({ key, fetchImpl: async () => { throw new Error(`代理错误 ${key}`); } }),
    (err) => err instanceof HttpError &&
      err.message === '网络请求失败，请检查连接或代理设置' && err.body === ''
  );
  await assert.rejects(
    () => fetchOpencodeGoUsage({ key, fetchImpl: async () => mockResponse(200, `正文 ${key}`) }),
    (err) => err instanceof HttpError && err.message === '上游返回的不是 JSON' && err.body === ''
  );
});

test('NewAPI 账户：quota 按 500000 换算，used 与比例正确', async () => {
  const fetchImpl = async (url, options) => {
    assert.equal(url, 'https://relay.example.com/api/user/self');
    assert.equal(options.headers['New-Api-User'], '12345');
    return mockResponse(200, {
      success: true,
      data: { quota: 5000000, used_quota: 1000000, group: 'vip' }
    });
  };
  const provider = await fetchNewApiAccount({
    relay: { id: 'r1', name: '示例站', type: 'newapi-account', baseUrl: 'https://relay.example.com', userId: '12345' },
    token: 'tok_secret_abcdef',
    quotaPerUsd: 500000,
    fetchImpl,
    lookupImpl: publicLookup
  });
  const [window] = provider.windows;
  assert.equal(window.remaining, 10);
  assert.equal(window.spend, 2);
  assert.equal(window.limit, 12);
  assert.equal(provider.plan, 'vip');
  assert.ok(Math.abs(window.usedPercent - (2 / 12) * 100) < 0.001);
});

test('NewAPI 令牌：unlimited_quota 不伪造余额', async () => {
  const fetchImpl = async () =>
    mockResponse(200, { success: true, data: { unlimited_quota: true, total_used: 2500000 } });
  const provider = await fetchNewApiToken({
    relay: { id: 'r2', name: '站', type: 'newapi-token', baseUrl: 'https://relay.example.com' },
    token: 'tok_secret_abcdef',
    quotaPerUsd: 500000,
    fetchImpl,
    lookupImpl: publicLookup
  });
  const [window] = provider.windows;
  assert.equal(window.unlimited, true);
  assert.equal(window.remaining, null);
  assert.ok(provider.notes.length >= 1);
});

test('NewAPI：账户和令牌查询均不回显站点的业务拒绝正文', async () => {
  const relay = { id: 'r1', name: '示例站', baseUrl: 'https://relay.example.com', userId: 'fixture-user' };
  const token = 'relay-private-fixture';
  const fetchImpl = async () => mockResponse(200, { success: false, message: `fixture@example.invalid ${token}` });
  for (const fetchQuota of [fetchNewApiAccount, fetchNewApiToken]) {
    await assert.rejects(
      () => fetchQuota({ relay, token, fetchImpl, lookupImpl: publicLookup }),
      (err) => err instanceof HttpError && err.message === '站点拒绝查询，请检查凭据或读取权限' && err.body === ''
    );
  }
});

test('OpenCode Go：三窗口、rate-limited 钉 100%、0% 丢弃占位 reset', async () => {
  const iso = new Date(Date.now() + 3600 * 1000).toISOString();
  const fetchImpl = async (url, options) => {
    assert.equal(url, 'https://opencode.ai/zen/go/v1/usage');
    assert.equal(options.headers.Authorization, 'Bearer oc_sk_secret_123456');
    return mockResponse(200, {
      usage: {
        rolling: { status: 'fixture-private-status', percent: 42, resetsAt: iso },
        weekly: { status: 'rate-limited', percent: 10, resetsAt: iso },
        monthly: { status: 'ok', percent: 0, resetsAt: iso }
      }
    });
  };
  const provider = await fetchOpencodeGoUsage({ key: 'oc_sk_secret_123456', fetchImpl });
  assert.equal(provider.windows.length, 3);
  assert.equal(provider.windows[0].usedPercent, 42);
  assert.equal(provider.windows[0].status, 'ok');
  assert.equal(provider.windows[1].usedPercent, 100, 'rate-limited 应视为打满');
  assert.equal(provider.windows[1].status, 'rate-limited');
  assert.equal(provider.windows[2].usedPercent, 0);
  assert.equal(provider.windows[2].resetAt, null, '0% 的 reset 是占位值，应丢弃');
  assert.ok(provider.notes.length >= 1);
});

test('OpenCode Go：无 Key 抛 UnconfiguredError', async () => {
  await assert.rejects(() => fetchOpencodeGoUsage({ key: '' }), (err) => err instanceof UnconfiguredError);
});

test('OpenCode Go Key：从环境变量解析', async () => {
  const resolved = await resolveOpencodeGoKey({ env: { OPENCODE_GO_API_KEY: 'oc_sk_env_12345678' } });
  assert.equal(resolved.key, 'oc_sk_env_12345678');
  assert.equal(resolved.source, 'env');
});

test('Sub2API：remaining/limit/used 解析', async () => {
  const fetchImpl = async (url) => {
    assert.equal(url, 'https://sub.example.com/v1/usage');
    return mockResponse(200, {
      isValid: true,
      remaining: 5.5,
      quota: { limit: 10, used: 4.5, unit: 'USD' },
      planName: 'Pro'
    });
  };
  const provider = await fetchSub2Api({
    relay: { id: 'r3', name: 'Sub 站', type: 'sub2api', baseUrl: 'https://sub.example.com' },
    token: 'tok_secret_abcdef',
    fetchImpl,
    lookupImpl: publicLookup
  });
  const [window] = provider.windows;
  assert.equal(window.remaining, 5.5);
  assert.equal(window.limit, 10);
  assert.equal(window.spend, 4.5);
  assert.equal(provider.plan, 'Pro');
});

test('通用中转站：按点路径提取并除以系数', async () => {
  const fetchImpl = async () =>
    mockResponse(200, { data: { balance: 2500000, total: 5000000, used: 2500000 } });
  const provider = await fetchRelay({
    relay: {
      id: 'r4',
      name: '通用站',
      type: 'generic',
      baseUrl: 'https://generic.example.com/api/balance',
      extract: { remaining: 'data.balance', limit: 'data.total', spend: 'data.used', unit: 'USD', divisor: 1000000 }
    },
    token: 'tok_secret_abcdef',
    quotaPerUsd: 1,
    fetchImpl,
    lookupImpl: publicLookup
  });
  const [window] = provider.windows;
  assert.equal(window.remaining, 2.5);
  assert.equal(window.limit, 5);
  assert.equal(window.spend, 2.5);
});


test('DeepSeek：官方余额接口解析（CNY / 充值 / 赠送）', async () => {
  const fetchImpl = async (url, options) => {
    assert.equal(url, 'https://api.deepseek.com/user/balance');
    assert.equal(options.headers.Authorization, 'Bearer sk-test-123456');
    return mockResponse(200, {
      is_available: true,
      balance_infos: [
        { currency: 'CNY', total_balance: '18.85', granted_balance: '0.00', topped_up_balance: '18.85' }
      ]
    });
  };
  const provider = await fetchDeepSeekBalance({ key: 'sk-test-123456', fetchImpl });
  const [window] = provider.windows;
  assert.equal(provider.kind, 'deepseek');
  assert.equal(window.remaining, 18.85);
  assert.equal(window.unit, 'CNY');
  assert.ok(provider.notes.length >= 1);
});

test('DeepSeek：没有 Key 时抛 UnconfiguredError', async () => {
  await assert.rejects(() => fetchDeepSeekBalance({ key: '' }), (err) => err instanceof UnconfiguredError);
});

test('DeepSeek 平台：余额 + 累计消费 + 近30天用量', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('/users/get_user_summary')) {
      return mockResponse(200, {
        code: 0,
        data: {
          biz_code: 0,
          biz_data: {
            normal_wallets: [{ currency: 'CNY', balance: '17.29' }],
            bonus_wallets: [{ currency: 'CNY', balance: '1.00' }],
            total_costs: [{ currency: 'CNY', amount: '406.81' }]
          }
        }
      });
    }
    if (url.includes('/usage/by_api_key/amount')) {
      return mockResponse(200, {
        code: 0,
        data: {
          biz_data: {
            series: [
              {
                buckets: [
                  { usage: { PROMPT_CACHE_HIT_TOKEN: 100, PROMPT_CACHE_MISS_TOKEN: 50, RESPONSE_TOKEN: 10, REQUEST: 2 } },
                  { usage: { PROMPT_CACHE_HIT_TOKEN: 200, PROMPT_CACHE_MISS_TOKEN: 0, RESPONSE_TOKEN: 5, REQUEST: 1 } }
                ]
              }
            ]
          }
        }
      });
    }
    if (url.includes('/usage/by_api_key/cost')) {
      return mockResponse(200, {
        code: 0,
        data: { biz_data: { data: [{ currency: 'CNY', series: [{ buckets: [{ cost: '1.5' }, { cost: '2.0' }] }] }] } }
      });
    }
    throw new Error('unexpected url ' + url);
  };
  const provider = await fetchDeepSeekPlatform({ token: 'platform-token', fetchImpl });
  assert.equal(provider.windows[0].remaining, 18.29);
  assert.equal(provider.spentCny, 406.81);
  assert.equal(provider.tokens30d, 365);
  assert.equal(provider.requests30d, 3);
  assert.equal(provider.cost30dCny, 3.5);
});


// ============================================================
// A6：Codex 自动续期集成（mock fetch、临时 auth 文件、零网络）
// ============================================================

const REFRESH_URL = 'https://auth.openai.com/oauth/token';
const CODEX_USAGE_HOST = 'https://chatgpt.com/backend-api/wham/usage';

function fakeJwt(payload) {
  const encode = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return encode({ alg: 'none', typ: 'JWT' }) + '.' + encode(payload) + '.sig';
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function makeCodexAuth({
  expiresInSec = 10 * 24 * 3600,
  refresh = 'rt-old-123456',
  accountId = 'acct-1',
  lastRefresh = new Date().toISOString()
} = {}) {
  const iat = nowSec();
  return {
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: '',
    last_refresh: lastRefresh,
    tokens: {
      access_token: fakeJwt({ iat, exp: iat + expiresInSec }),
      refresh_token: refresh,
      id_token: fakeJwt({ iat, exp: iat + 3600 }),
      account_id: accountId
    }
  };
}

function usageBody() {
  const resetAt = nowSec() + 3600;
  return {
    plan_type: 'plus',
    credits: { has_credits: false, unlimited: false, balance: '0' },
    rate_limit: {
      primary_window: { used_percent: 42, reset_at: resetAt, limit_window_seconds: 18000 },
      secondary_window: { used_percent: 61, reset_at: resetAt + 86400, limit_window_seconds: 604800 }
    }
  };
}

function refreshBody({ expiresInSec = 10 * 24 * 3600, refreshToken = 'rt-new-abcdef' } = {}) {
  const iat = nowSec();
  return {
    access_token: fakeJwt({ iat, exp: iat + expiresInSec }),
    refresh_token: refreshToken,
    id_token: fakeJwt({ iat, exp: iat + 3600 })
  };
}

async function tempCodexAuth(content) {
  return tempAuthFile(content);
}

test('A6-1 Codex：401 → 自动续期 → 重试一次成功，回写新 token', async () => {
  resetCodexRefreshState();
  const authPath = await tempCodexAuth(makeCodexAuth());
  let whamCalls = 0;
  let tokenCalls = 0;
  let secondAuthHeader = null;
  const fetchImpl = async (url, options) => {
    if (url === REFRESH_URL) {
      tokenCalls += 1;
      assert.match(options.headers['Content-Type'], /application\/json/);
      const body = JSON.parse(options.body);
      assert.equal(body.grant_type, 'refresh_token');
      assert.equal(body.refresh_token, 'rt-old-123456');
      assert.ok(body.client_id);
      return mockResponse(200, refreshBody());
    }
    assert.equal(url, CODEX_USAGE_HOST);
    whamCalls += 1;
    if (whamCalls === 2) secondAuthHeader = options.headers.Authorization;
    if (whamCalls === 1) return mockResponse(401, { error: { message: 'Encountered invalidated oauth token for user' } });
    return mockResponse(200, usageBody());
  };
  const provider = await fetchCodexUsage({ name: '托管号', authPath, allowRefresh: true, fetchImpl });
  assert.equal(provider.status, 'ok');
  assert.equal(provider.windows.length, 2);
  assert.equal(provider.managed, true, '托管账号卡片应标记 managed=true');
  assert.equal(whamCalls, 2);
  assert.equal(tokenCalls, 1);
  assert.equal(provider.refresh.attempted, true);
  assert.ok(provider.refresh.refreshedAt);
  assert.equal(provider.refresh.rotated, true);
  assert.ok(secondAuthHeader && !secondAuthHeader.includes('rt-'), '重试应使用新 access_token');

  const saved = JSON.parse(await fs.readFile(authPath, 'utf8'));
  assert.equal(saved.tokens.refresh_token, 'rt-new-abcdef');
  assert.ok(saved.last_refresh);
  assert.ok(!JSON.stringify(provider).includes('rt-'), '返回结构不能包含 token');
});

test('A6-2 Codex：live 永不续期（即使 401 且 allowRefresh=true）', async () => {
  resetCodexRefreshState();
  const auth = makeCodexAuth();
  const authPath = await tempCodexAuth(auth);
  const before = await fs.readFile(authPath, 'utf8');
  let tokenCalls = 0;
  let whamCalls = 0;
  const fetchImpl = async (url) => {
    if (url === REFRESH_URL) {
      tokenCalls += 1;
      return mockResponse(200, refreshBody());
    }
    whamCalls += 1;
    return mockResponse(401, { error: { message: 'invalidated' } });
  };
  await assert.rejects(
    () => fetchCodexUsage({ name: 'live', authPath, allowRefresh: true, live: true, fetchImpl }),
    (err) => err instanceof HttpError && err.status === 401
  );
  assert.equal(tokenCalls, 0, 'live 绝不能触发刷新');
  assert.equal(whamCalls, 1);
  assert.equal(await fs.readFile(authPath, 'utf8'), before, 'live 登录态文件不能变');
});

test('A6-3 Codex：续期 invalid_grant → 抛 401、不重试、文件不变、状态可读', async () => {
  resetCodexRefreshState();
  const authPath = await tempCodexAuth(makeCodexAuth());
  const before = await fs.readFile(authPath, 'utf8');
  let whamCalls = 0;
  let tokenCalls = 0;
  const fetchImpl = async (url) => {
    if (url === REFRESH_URL) {
      tokenCalls += 1;
      return mockResponse(401, { error: { code: 'refresh_token_invalidated', message: 'session revoked' } });
    }
    whamCalls += 1;
    return mockResponse(401, { error: { message: 'invalidated' } });
  };
  const err = await fetchCodexUsage({ name: '归档号', authPath, allowRefresh: true, fetchImpl }).then(
    () => null,
    (e) => e
  );
  assert.ok(err instanceof HttpError);
  assert.equal(err.status, 401);
  assert.match(err.message, /自动续期失败/);
  assert.equal(err.refresh.code, 'invalid_grant');
  assert.equal(whamCalls, 1, '续期失败不应重试 wham');
  assert.equal(tokenCalls, 1);
  assert.equal(await fs.readFile(authPath, 'utf8'), before);
});

test('A6-4 Codex：续期成功但重试仍 401 → 只刷一次、不循环', async () => {
  resetCodexRefreshState();
  const authPath = await tempCodexAuth(makeCodexAuth());
  let tokenCalls = 0;
  let whamCalls = 0;
  const fetchImpl = async (url) => {
    if (url === REFRESH_URL) {
      tokenCalls += 1;
      return mockResponse(200, refreshBody());
    }
    whamCalls += 1;
    return mockResponse(401, { error: { message: 'still unauthorized' } });
  };
  const err = await fetchCodexUsage({ name: '托管号', authPath, allowRefresh: true, fetchImpl }).then(
    () => null,
    (e) => e
  );
  assert.ok(err instanceof HttpError && err.status === 401);
  assert.match(err.message, /仍返回 401/);
  assert.equal(tokenCalls, 1);
  assert.equal(whamCalls, 2);
});

test('A6-5 Codex：access exp 剩余 <24h → 请求前主动续期', async () => {
  resetCodexRefreshState();
  const authPath = await tempCodexAuth(makeCodexAuth({ expiresInSec: 60 }));
  let tokenCalls = 0;
  const fetchImpl = async (url) => {
    if (url === REFRESH_URL) {
      tokenCalls += 1;
      return mockResponse(200, refreshBody());
    }
    return mockResponse(200, usageBody());
  };
  const provider = await fetchCodexUsage({ name: '托管号', authPath, allowRefresh: true, fetchImpl });
  assert.equal(tokenCalls, 1);
  assert.ok(provider.refresh.refreshedAt);
  const saved = JSON.parse(await fs.readFile(authPath, 'utf8'));
  assert.equal(saved.tokens.refresh_token, 'rt-new-abcdef');
});

test('A6-6 Codex：令牌新鲜时不主动续期', async () => {
  resetCodexRefreshState();
  const authPath = await tempCodexAuth(makeCodexAuth({ expiresInSec: 30 * 24 * 3600 }));
  let tokenCalls = 0;
  const fetchImpl = async (url) => {
    if (url === REFRESH_URL) {
      tokenCalls += 1;
      return mockResponse(200, refreshBody());
    }
    return mockResponse(200, usageBody());
  };
  const provider = await fetchCodexUsage({ name: '托管号', authPath, allowRefresh: true, fetchImpl });
  assert.equal(tokenCalls, 0);
  assert.equal(provider.refresh.attempted, false);
  assert.equal(provider.managed, true);
});

test('A6-7 Codex：403/429 不触发续期（不把限流误判成 token 失效）', async () => {
  resetCodexRefreshState();
  const authPath = await tempCodexAuth(makeCodexAuth());
  let tokenCalls = 0;
  const makeFetch = (status) => async (url) => {
    if (url === REFRESH_URL) {
      tokenCalls += 1;
      return mockResponse(200, refreshBody());
    }
    return mockResponse(status, { error: { message: 'nope' } });
  };
  for (const status of [403, 429]) {
    const err = await fetchCodexUsage({ name: '托管号', authPath, allowRefresh: true, fetchImpl: makeFetch(status) }).then(
      () => null,
      (e) => e
    );
    assert.ok(err instanceof HttpError);
    assert.equal(err.status, status);
  }
  assert.equal(tokenCalls, 0);
});

test('A6-8 Codex：失败后冷却不再打续期端点；并发同 authPath 只刷一次', async () => {
  resetCodexRefreshState();
  const authPath = await tempCodexAuth(makeCodexAuth());
  let tokenCalls = 0;
  const failingFetch = async (url) => {
    if (url === REFRESH_URL) {
      tokenCalls += 1;
      return mockResponse(401, { error: { code: 'refresh_token_invalidated' } });
    }
    return mockResponse(401, { error: { message: 'invalidated' } });
  };
  await assert.rejects(() => fetchCodexUsage({ name: 'x', authPath, allowRefresh: true, fetchImpl: failingFetch }));
  await assert.rejects(() => fetchCodexUsage({ name: 'x', authPath, allowRefresh: true, fetchImpl: failingFetch }));
  assert.equal(tokenCalls, 1, '冷却期内不应重复请求续期端点');

  resetCodexRefreshState();
  const authPath2 = await tempCodexAuth(makeCodexAuth({ accountId: 'acct-2' }));
  let tokenCalls2 = 0;
  let whamCalls = 0;
  const slowFetch = async (url) => {
    if (url === REFRESH_URL) {
      tokenCalls2 += 1;
      await new Promise((resolve) => setTimeout(resolve, 30));
      return mockResponse(200, refreshBody());
    }
    whamCalls += 1;
    if (whamCalls === 1 || whamCalls === 2) return mockResponse(401, { error: { message: 'invalidated' } });
    return mockResponse(200, usageBody());
  };
  const results = await Promise.allSettled([
    fetchCodexUsage({ name: 'a', authPath: authPath2, allowRefresh: true, fetchImpl: slowFetch }),
    fetchCodexUsage({ name: 'b', authPath: authPath2, allowRefresh: true, fetchImpl: slowFetch })
  ]);
  assert.equal(tokenCalls2, 1, '并发同一 auth 文件只能刷一次');
  assert.ok(results.every((r) => r.status === 'fulfilled'), '并发请求都应成功');
});

test('A6-9 Codex：错误与返回结构不泄漏 token', async () => {
  resetCodexRefreshState();
  const authPath = await tempCodexAuth(makeCodexAuth({ refresh: 'rt-super-secret-987654' }));
  const fetchImpl = async (url) => {
    if (url === REFRESH_URL) {
      return mockResponse(401, { error: { code: 'fixture-private-code', message: 'fixture@example.invalid' } });
    }
    return mockResponse(401, { error: { message: 'invalidated' } });
  };
  const err = await fetchCodexUsage({ name: 'x', authPath, allowRefresh: true, fetchImpl }).then(
    () => null,
    (e) => e
  );
  const dump = JSON.stringify({ message: err.message, refresh: err.refresh });
  assert.equal(err.refresh.code, 'invalid_request');
  assert.equal(err.refresh.lastError, '官方续期服务拒绝了请求');
  assert.ok(!dump.includes('rt-super-secret-987654'));
  assert.ok(!dump.includes('eyJ'));
  assert.ok(!dump.includes('fixture-private-code'));
  assert.ok(!dump.includes('fixture@example.invalid'));
});
// ---- F5：SSRF 防护（relay baseUrl 拒绝内网/回环/元数据） ----

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
const privateLookup = async () => [{ address: '10.0.0.5', family: 4 }];
const mustNotFetch = async () => {
  throw new Error('fetch 不应被调用');
};

test('SSRF：拒绝回环/私网/链路本地/元数据地址与本机域名', async () => {
  const urls = [
    'http://127.0.0.1:8799/api',
    'http://127.1.2.3/',
    'http://[::1]:8799/',
    'http://10.1.2.3/v1',
    'http://172.16.5.4/',
    'http://192.168.1.9/',
    'http://169.254.169.254/latest/meta-data/',
    'http://metadata.google.internal/computeMetadata/v1/',
    'http://localhost:8799/',
    'http://foo.localhost/',
    'http://[fe80::1]/',
    'http://[fd00::1]/',
    'http://0.0.0.0/'
  ];
  for (const baseUrl of urls) {
    await assert.rejects(
      () => fetchRelay({ relay: { id: 'x', name: 'x', type: 'generic', baseUrl }, token: 't', fetchImpl: mustNotFetch }),
      (err) => err instanceof UnconfiguredError && /内网|本机|元数据/.test(err.message),
      baseUrl
    );
  }
});

test('SSRF：非 http/https 协议拒绝（file/gopher/ftp/data）', async () => {
  for (const baseUrl of ['file:///C:/Windows/win.ini', 'gopher://127.0.0.1:70/', 'ftp://example.com/x', 'data:text/plain,hi']) {
    await assert.rejects(
      () => fetchRelay({ relay: { id: 'x', name: 'x', type: 'generic', baseUrl }, token: 't', fetchImpl: mustNotFetch }),
      (err) => err instanceof UnconfiguredError,
      baseUrl
    );
  }
});

test('SSRF：域名 DNS 解析到内网地址时拒绝（二次校验）', async () => {
  await assert.rejects(
    () =>
      fetchRelay({
        relay: { id: 'x', name: 'x', type: 'generic', baseUrl: 'https://evil.example.com/api/balance' },
        token: 't',
        fetchImpl: mustNotFetch,
        lookupImpl: privateLookup
      }),
    (err) => err instanceof UnconfiguredError && /解析到本机\/内网/.test(err.message)
  );
});

test('SSRF：公网域名正常放行，不误伤自定义 HTTP JSON 中转站', async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    return mockResponse(200, { data: { balance: 2500000, total: 5000000 } });
  };
  const provider = await fetchRelay({
    relay: {
      id: 'r9',
      name: '公网站',
      type: 'generic',
      baseUrl: 'https://api.example.com/v1/balance',
      extract: { remaining: 'data.balance', limit: 'data.total', divisor: 1000000 }
    },
    token: 'tok_secret_abcdef',
    fetchImpl,
    lookupImpl: publicLookup
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0], 'https://api.example.com/v1/balance');
  assert.equal(provider.windows[0].remaining, 2.5);
  assert.equal(provider.windows[0].limit, 5);
});

test('窗口数值：used_percent 收敛 0–100，超大值判无效，reset_at≤0/超大 → null', async () => {
  const authPath = await tempAuthFile({
    auth_mode: 'chatgpt',
    tokens: { access_token: 'tok_secret_abcdef', account_id: 'acct_9' }
  });
  const fetchImpl = async () =>
    mockResponse(200, {
      plan_type: 'plus',
      rate_limit: {
        primary_window: { used_percent: 999, reset_at: 0, limit_window_seconds: 18000 },
        secondary_window: { used_percent: -5, reset_at: -123, limit_window_seconds: 604800 }
      },
      additional_rate_limits: [
        { display_name: '额外', rate_limit: { primary_window: { used_percent: 1e14, reset_at: 1e14 } } }
      ]
    });
  const provider = await fetchCodexUsage({ authPath, fetchImpl });
  const byKey = Object.fromEntries(provider.windows.map((w) => [w.key, w]));
  assert.equal(provider.windows[0].usedPercent, 100);
  assert.equal(provider.windows[0].resetAt, null);
  assert.equal(provider.windows[1].usedPercent, 0);
  assert.equal(provider.windows[1].resetAt, null);
  assert.equal(provider.windows[2].usedPercent, null);
  assert.equal(provider.windows[2].resetAt, null);
  assert.equal(byKey['5h'].windowSeconds, 18000);
});
test('SSRF：opts.allowPrivateRelay 显式放行回环（仅测试/自建本地中转）', async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    return mockResponse(200, { api: { balance: 123 } });
  };
  const provider = await fetchRelay({
    relay: {
      id: 'local-r',
      name: '本地自建站',
      type: 'generic',
      baseUrl: 'http://127.0.0.1:8865/api/version',
      extract: { remaining: 'api.balance' }
    },
    token: 't',
    fetchImpl,
    allowPrivateRelay: true
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0], 'http://127.0.0.1:8865/api/version');
  assert.equal(provider.status, 'ok');
  assert.equal(provider.windows[0].remaining, 123);
});

test('SSRF：env QUOTA_BOARD_ALLOW_PRIVATE_RELAY=1 放行回环，默认仍拒绝', async () => {
  const relay = {
    id: 'local-env',
    name: '本地站',
    type: 'generic',
    baseUrl: 'http://127.0.0.1:8865/api/version',
    extract: { remaining: 'api.balance' }
  };
  const fetchImpl = async () => mockResponse(200, { api: { balance: 1 } });
  const saved = process.env.QUOTA_BOARD_ALLOW_PRIVATE_RELAY;
  try {
    delete process.env.QUOTA_BOARD_ALLOW_PRIVATE_RELAY;
    await assert.rejects(
      () => fetchRelay({ relay, token: 't', fetchImpl, lookupImpl: publicLookup }),
      (err) => err instanceof UnconfiguredError
    );
    process.env.QUOTA_BOARD_ALLOW_PRIVATE_RELAY = '1';
    const provider = await fetchRelay({ relay, token: 't', fetchImpl });
    assert.equal(provider.status, 'ok');
  } finally {
    if (saved === undefined) delete process.env.QUOTA_BOARD_ALLOW_PRIVATE_RELAY;
    else process.env.QUOTA_BOARD_ALLOW_PRIVATE_RELAY = saved;
  }
});
test('附加额度：只接受对象、缺窗口跳过、limit_name 优先、上限 8 个、重复去重', async () => {
  const authPath = await tempAuthFile({
    auth_mode: 'chatgpt',
    tokens: { access_token: 'tok_secret_abcdef', account_id: 'acct_9' }
  });
  const extras = [
    null,
    'x',
    42,
    [],
    { display_name: '无窗口' },
    { limit_name: '限流甲', display_name: '旧名', rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18000 } } },
    { limit_name: '限流甲', rate_limit: { primary_window: { used_percent: 20, limit_window_seconds: 18000 } } },
    { limit_name: '摊平', used_percent: 5, limit_window_seconds: 604800 },
    ...Array.from({ length: 10 }, (_, i) => ({
      limit_name: '批量' + (i + 1),
      rate_limit: { secondary_window: { used_percent: i, limit_window_seconds: 604800 } }
    }))
  ];
  const fetchImpl = async () =>
    mockResponse(200, {
      plan_type: 'plus',
      rate_limit: {
        primary_window: { used_percent: 1, limit_window_seconds: 18000 },
        additional_rate_limits: extras
      }
    });
  const provider = await fetchCodexUsage({ authPath, fetchImpl });
  const extraWindows = provider.windows.filter((w) => w.key.startsWith('extra:'));
  assert.equal(extraWindows.length, 8, '附加窗口最多 8 个');
  assert.equal(provider.windows.length, 9, '基础 1 个 + 附加 8 个');
  const labels = provider.windows.map((w) => w.label);
  assert.ok(labels.includes('限流甲 · 5 小时'), 'limit_name 应优先于 display_name');
  assert.ok(!labels.includes('旧名 · 5 小时'), 'display_name 不应覆盖 limit_name');
  assert.ok(labels.includes('摊平 · 每周'), '摊平形态应被接受');
  assert.ok(!labels.some((label) => label.includes('无窗口')), '缺窗口条目应跳过');
});

test('窗口数值：windowSeconds 0/负数/非数/超大 → null', async () => {
  const authPath = await tempAuthFile({
    auth_mode: 'chatgpt',
    tokens: { access_token: 'tok_secret_abcdef', account_id: 'acct_9' }
  });
  const fetchImpl = async () =>
    mockResponse(200, {
      plan_type: 'plus',
      rate_limit: {
        primary_window: { used_percent: 10, limit_window_seconds: 0 },
        secondary_window: { used_percent: 20, limit_window_seconds: -5 },
        additional_rate_limits: [
          { limit_name: '非数', rate_limit: { primary_window: { used_percent: 1, limit_window_seconds: 'abc' } } },
          { limit_name: '超大', rate_limit: { primary_window: { used_percent: 2, limit_window_seconds: 1e14 } } }
        ]
      }
    });
  const provider = await fetchCodexUsage({ authPath, fetchImpl });
  assert.equal(provider.windows.length, 4);
  for (const window of provider.windows) assert.equal(window.windowSeconds, null);
  assert.equal(provider.windows[0].usedPercent, 10);
  assert.equal(provider.windows[1].usedPercent, 20);
});

test('SSRF：DNS 解析失败默认拒绝，显式测试开关下放行', async () => {
  const relay = {
    id: 'dns-fail',
    name: '解析失败站',
    type: 'generic',
    baseUrl: 'https://no-such-host.example.com/api',
    extract: { remaining: 'ok' }
  };
  const failingLookup = async () => {
    throw new Error('ENOTFOUND');
  };
  const fetchImpl = async () => mockResponse(200, { ok: 1 });
  await assert.rejects(
    () => fetchRelay({ relay, token: 't', fetchImpl, lookupImpl: failingLookup }),
    (err) => err instanceof UnconfiguredError && /解析失败/.test(err.message)
  );
  const provider = await fetchRelay({
    relay,
    token: 't',
    fetchImpl,
    lookupImpl: failingLookup,
    allowPrivateRelay: true
  });
  assert.equal(provider.status, 'ok');
});
