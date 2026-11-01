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
  resolveOpencodeGoKey
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
  assert.equal(provider.credits.balance, 0);
  assert.equal(provider.credits.hasCredits, false);
});

test('Codex: 缺少登录态时抛 UnconfiguredError', async () => {
  await assert.rejects(
    () => fetchCodexUsage({ authPath: path.join(os.tmpdir(), 'definitely-missing-auth.json') }),
    (err) => err instanceof UnconfiguredError
  );
});

test('Codex: 403 转成可读 HttpError', async () => {
  const authPath = await tempAuthFile({ tokens: { access_token: 'tok_secret_abcdef' } });
  const fetchImpl = async () => mockResponse(403, { error: { message: 'forbidden' } });
  await assert.rejects(
    () => fetchCodexUsage({ authPath, fetchImpl }),
    (err) => err instanceof HttpError && err.status === 403
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
    fetchImpl
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
    fetchImpl
  });
  const [window] = provider.windows;
  assert.equal(window.unlimited, true);
  assert.equal(window.remaining, null);
  assert.ok(provider.notes.length >= 1);
});

test('OpenCode Go：三窗口、rate-limited 钉 100%、0% 丢弃占位 reset', async () => {
  const iso = new Date(Date.now() + 3600 * 1000).toISOString();
  const fetchImpl = async (url, options) => {
    assert.equal(url, 'https://opencode.ai/zen/go/v1/usage');
    assert.equal(options.headers.Authorization, 'Bearer oc_sk_secret_123456');
    return mockResponse(200, {
      usage: {
        rolling: { status: 'ok', percent: 42, resetsAt: iso },
        weekly: { status: 'rate-limited', percent: 10, resetsAt: iso },
        monthly: { status: 'ok', percent: 0, resetsAt: iso }
      }
    });
  };
  const provider = await fetchOpencodeGoUsage({ key: 'oc_sk_secret_123456', fetchImpl });
  assert.equal(provider.windows.length, 3);
  assert.equal(provider.windows[0].usedPercent, 42);
  assert.equal(provider.windows[1].usedPercent, 100, 'rate-limited 应视为打满');
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
    fetchImpl
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
    fetchImpl
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
