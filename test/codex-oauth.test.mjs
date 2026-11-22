import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CODEX_OAUTH_TOKEN_URL,
  CODEX_REFRESH_URL_ENV,
  DEFAULT_CODEX_CLIENT_ID,
  CodexOauthError,
  accessTokenExpiresAt,
  assessCodexAuth,
  classifyRefreshFailure,
  decodeJwtPayload,
  ensureCodexAuthFresh,
  readCodexAuth,
  refreshCodexAuth,
  shouldRefresh,
  withCodexAuthLock,
  writeCodexAuthAtomic
} from '../lib/codex-oauth.mjs';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1762900000000; // 固定"现在"，避免测试依赖真实时钟（2025-11-11T22:26:40Z）
const OLD_ACCESS = 'eyJhbGciOiJub25lIn0.old.old';
const OLD_REFRESH = 'rt.1.old-refresh-token-abcdef';
const NEW_REFRESH = 'rt.1.new-refresh-token-123456';
const NEW_ACCESS_SUFFIX = 'new-access';

function b64url(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function fakeJwt(payload) {
  return `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url(payload)}.sig`;
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function makeAuth({
  expMs = NOW + 10 * DAY,
  lastRefreshMs = NOW - DAY,
  refresh = OLD_REFRESH,
  access,
  accountId = 'acct-test-1234',
  extraTop = {},
  extraTokens = {}
} = {}) {
  return {
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: '',
    tokens: {
      id_token: fakeJwt({ exp: Math.floor((lastRefreshMs + 60 * 60 * 1000) / 1000), name: 'Tester' }),
      access_token: access || fakeJwt({ exp: Math.floor(expMs / 1000), iat: Math.floor(lastRefreshMs / 1000) }),
      refresh_token: refresh,
      oauth_provenance: { issuer: 'https://auth.openai.com', client_id: DEFAULT_CODEX_CLIENT_ID },
      login_owner_id: 'owner-1',
      account_id: accountId,
      ...extraTokens
    },
    last_refresh: iso(lastRefreshMs),
    ...extraTop
  };
}

function newAccessToken(expMs = NOW + 10 * DAY) {
  return fakeJwt({ exp: Math.floor(expMs / 1000), jti: NEW_ACCESS_SUFFIX });
}

function tokenResponse(overrides = {}) {
  const body = {
    access_token: newAccessToken(),
    token_type: 'Bearer',
    expires_in: 864000,
    refresh_token: NEW_REFRESH,
    id_token: fakeJwt({ exp: Math.floor((NOW + 10 * DAY) / 1000), name: 'Tester' }),
    ...overrides
  };
  for (const key of Object.keys(body)) {
    if (body[key] === undefined) delete body[key];
  }
  return body;
}

function mockResponse(status, body, headers = {}) {
  const map = new Map(Object.entries(headers).map(([key, value]) => [String(key).toLowerCase(), String(value)]));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => map.get(String(name).toLowerCase()) ?? null },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
  };
}

async function tempAuthFile(t, auth) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'quota-board-oauth-'));
  const file = path.join(dir, 'auth.json');
  await fs.writeFile(file, JSON.stringify(auth, null, 2));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return { dir, file };
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

// ---------------------------------------------------------------- JWT / 判断

test('decodeJwtPayload / accessTokenExpiresAt：解析 access_token 的 exp', () => {
  const exp = Math.floor((NOW + 3 * DAY) / 1000);
  const token = fakeJwt({ exp, iat: 1, email: 't@example.com' });
  assert.equal(decodeJwtPayload(token).exp, exp);
  assert.equal(decodeJwtPayload(token).email, 't@example.com');
  assert.equal(decodeJwtPayload('not-a-jwt'), null);
  assert.equal(decodeJwtPayload('a.%%%bad%%%.c'), null);
  assert.equal(decodeJwtPayload(null), null);

  assert.equal(accessTokenExpiresAt(makeAuth({ expMs: NOW + 3 * DAY })).getTime(), exp * 1000);
  assert.equal(accessTokenExpiresAt(makeAuth({ access: 'opaque-token-value' })), null);
  assert.equal(accessTokenExpiresAt({}), null);
  assert.equal(accessTokenExpiresAt(null), null);
});

test('readCodexAuth：正常返回解析对象；缺失/坏 JSON/无 tokens 抛 bad_auth_file 且不泄露令牌', async (t) => {
  const auth = makeAuth();
  const { file } = await tempAuthFile(t, auth);
  const parsed = await readCodexAuth(file);
  assert.equal(parsed.auth_mode, 'chatgpt');
  assert.equal(parsed.tokens.account_id, 'acct-test-1234');

  const missing = await readCodexAuth(path.join(os.tmpdir(), 'quota-board-missing-auth.json')).then(
    () => null,
    (err) => err
  );
  assert.ok(missing instanceof CodexOauthError);
  assert.equal(missing.code, 'bad_auth_file');
  assert.equal(missing.retryable, false);
  assert.ok(!String(missing.message).includes('rt.1.'));

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'quota-board-oauth-bad-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const broken = path.join(dir, 'broken.json');
  await fs.writeFile(broken, `{ "tokens": { "refresh_token": "${OLD_REFRESH}" `);
  await assert.rejects(readCodexAuth(broken), (err) => {
    assert.equal(err.code, 'bad_auth_file');
    assert.ok(!err.message.includes(OLD_REFRESH));
    return true;
  });

  const noTokens = path.join(dir, 'no-tokens.json');
  await fs.writeFile(noTokens, JSON.stringify({ auth_mode: 'chatgpt', nested: { access_token: 'x' } }));
  await assert.rejects(readCodexAuth(noTokens), (err) => err.code === 'bad_auth_file');
});

test('shouldRefresh：新令牌不动，临界/过期/超龄/last_refresh 超过 7 天才续期', () => {
  assert.equal(shouldRefresh(makeAuth(), { now: NOW }), false);
  assert.equal(shouldRefresh(makeAuth({ expMs: NOW + 1 * 60 * 60 * 1000 }), { now: NOW }), true);
  assert.equal(shouldRefresh(makeAuth({ expMs: NOW - 60 * 1000 }), { now: NOW }), true);
  // last_refresh 超过 7 天 → 即使 exp 还很远也续期
  assert.equal(shouldRefresh(makeAuth({ expMs: NOW + 10 * DAY, lastRefreshMs: NOW - 8 * DAY }), { now: NOW }), true);
  // 自定义阈值
  assert.equal(shouldRefresh(makeAuth({ expMs: NOW + 2 * 60 * 60 * 1000 }), { now: NOW, skewMs: 60 * 60 * 1000 }), false);
  assert.equal(shouldRefresh(makeAuth({ expMs: NOW + 2 * 60 * 60 * 1000 }), { now: NOW, skewMs: 3 * 60 * 60 * 1000 }), true);
  // last_refresh 坏值不影响 exp 判断
  const badLastRefresh = makeAuth();
  badLastRefresh.last_refresh = 'not-a-date';
  assert.equal(shouldRefresh(badLastRefresh, { now: NOW }), false);
});

test('shouldRefresh：没有 refresh_token 时不续期；access_token 不是 JWT 时有 refresh_token 才续期', () => {
  assert.equal(shouldRefresh(makeAuth({ refresh: '' }), { now: NOW }), false);
  assert.equal(shouldRefresh(makeAuth({ refresh: '', expMs: NOW - 60 * 1000 }), { now: NOW }), false);
  assert.equal(shouldRefresh(makeAuth({ access: 'opaque-token-value' }), { now: NOW }), true);
  assert.equal(shouldRefresh({ tokens: {} }, { now: NOW }), false);
});

test('assessCodexAuth：给出展示用字段（expiresAt/expiresInMs/lastRefreshAt/reason）', () => {
  const auth = makeAuth({ expMs: NOW + 2 * 60 * 60 * 1000 });
  const info = assessCodexAuth(auth, { now: NOW });
  assert.equal(info.hasAccessToken, true);
  assert.equal(info.hasRefreshToken, true);
  assert.equal(info.accountId, 'acct-test-1234');
  assert.equal(info.accessTokenExpiresAt?.getTime(), Math.floor((NOW + 2 * 60 * 60 * 1000) / 1000) * 1000);
  assert.ok(info.expiresInMs > 0 && info.expiresInMs <= 2 * 60 * 60 * 1000);
  assert.equal(info.lastRefreshAt?.getTime(), NOW - DAY);
  assert.equal(info.expired, false);
  assert.equal(info.needsRefresh, true);
  assert.equal(info.reason, 'expiring-soon');
  assert.equal(assessCodexAuth(makeAuth(), { now: NOW }).reason, 'fresh');
  assert.equal(assessCodexAuth(makeAuth({ refresh: '' }), { now: NOW }).reason, 'fresh');
  assert.equal(assessCodexAuth(makeAuth({ refresh: '', expMs: NOW - 1000 }), { now: NOW }).reason, 'no-refresh-token');
});

// ---------------------------------------------------------------- 刷新主流程

test('refreshCodexAuth：按 JSON 协议请求并原子写回，保留原文件其他字段', async (t) => {
  const auth = makeAuth({ extraTop: { custom_top: 'keep-me' }, extraTokens: { custom_token_field: 42 } });
  const { dir, file } = await tempAuthFile(t, auth);
  let captured = null;
  const fetchImpl = async (url, options) => {
    captured = { url, options, body: JSON.parse(options.body) };
    return mockResponse(200, tokenResponse());
  };

  const result = await refreshCodexAuth(file, { force: true, fetchImpl, now: NOW });
  assert.equal(result.refreshed, true);
  assert.equal(result.changed, true);
  assert.equal(result.rotated, true);
  assert.equal(result.accountId, 'acct-test-1234');
  assert.ok(result.expiresAt instanceof Date);
  assert.equal(typeof result.expiresAtIso, 'string');

  assert.equal(captured.url, CODEX_OAUTH_TOKEN_URL);
  assert.equal(captured.options.method, 'POST');
  assert.equal(captured.options.headers['Content-Type'], 'application/json');
  assert.deepEqual(captured.body, {
    grant_type: 'refresh_token',
    client_id: DEFAULT_CODEX_CLIENT_ID,
    refresh_token: OLD_REFRESH,
    refresh_reason: 'proactive_expiry'
  });

  const written = await readJson(file);
  assert.equal(written.tokens.access_token, tokenResponse().access_token);
  assert.equal(written.tokens.refresh_token, NEW_REFRESH);
  assert.notEqual(written.tokens.id_token, auth.tokens.id_token);
  assert.equal(written.last_refresh, iso(NOW));
  // 其余字段原样保留
  assert.equal(written.auth_mode, 'chatgpt');
  assert.equal(written.OPENAI_API_KEY, '');
  assert.equal(written.tokens.account_id, 'acct-test-1234');
  assert.equal(written.tokens.login_owner_id, 'owner-1');
  assert.deepEqual(written.tokens.oauth_provenance, auth.tokens.oauth_provenance);
  assert.equal(written.custom_top, 'keep-me');
  assert.equal(written.tokens.custom_token_field, 42);

  // 原子写：没有临时文件残留，JSON 以换行结尾
  const names = await fs.readdir(dir);
  assert.ok(!names.some((name) => name.endsWith('.tmp')), `不应残留临时文件：${names.join(',')}`);
  const raw = await fs.readFile(file, 'utf8');
  assert.ok(raw.endsWith('\n'));
  assert.equal(JSON.parse(raw).tokens.access_token, tokenResponse().access_token);
});

test('refreshCodexAuth：force=false 且不需要续期时不发请求；force=true 时强制刷新', async (t) => {
  const { file } = await tempAuthFile(t, makeAuth());
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return mockResponse(200, tokenResponse());
  };

  const skipped = await refreshCodexAuth(file, { fetchImpl, now: NOW });
  assert.equal(skipped.refreshed, false);
  assert.equal(skipped.reason, 'fresh');
  assert.equal(calls, 0);

  const forced = await refreshCodexAuth(file, { force: true, fetchImpl, now: NOW });
  assert.equal(forced.refreshed, true);
  assert.equal(calls, 1);
});

test('refreshCodexAuth：响应缺 refresh_token / id_token 时保留旧值，rotated=false', async (t) => {
  const auth = makeAuth();
  const { file } = await tempAuthFile(t, auth);
  const fetchImpl = async () => mockResponse(200, tokenResponse({ refresh_token: undefined, id_token: undefined }));
  const result = await refreshCodexAuth(file, { force: true, fetchImpl, now: NOW });
  assert.equal(result.rotated, false);
  const written = await readJson(file);
  assert.equal(written.tokens.refresh_token, OLD_REFRESH);
  assert.equal(written.tokens.id_token, auth.tokens.id_token);
  assert.equal(written.tokens.access_token, tokenResponse().access_token);
});

test('refreshCodexAuth：client_id 优先级 = 显式参数 > oauth_provenance > 内置默认值', async (t) => {
  const { file } = await tempAuthFile(t, makeAuth());
  const cases = [];
  const fetchImpl = async (url, options) => {
    cases.push(JSON.parse(options.body).client_id);
    return mockResponse(200, tokenResponse());
  };
  await refreshCodexAuth(file, { force: true, fetchImpl, now: NOW });
  await refreshCodexAuth(file, { force: true, fetchImpl, now: NOW, clientId: 'app_custom_client' });

  const noProvenance = makeAuth();
  delete noProvenance.tokens.oauth_provenance;
  const second = await tempAuthFile(t, noProvenance);
  await refreshCodexAuth(second.file, { force: true, fetchImpl, now: NOW });

  assert.deepEqual(cases, [DEFAULT_CODEX_CLIENT_ID, 'app_custom_client', DEFAULT_CODEX_CLIENT_ID]);
});

test('refreshCodexAuth：invalid_grant（400 refresh_token_invalidated）→ 分类错误，文件不变', async (t) => {
  const auth = makeAuth();
  const { file } = await tempAuthFile(t, auth);
  const before = await fs.readFile(file, 'utf8');
  const fetchImpl = async () =>
    mockResponse(400, { error: { code: 'refresh_token_invalidated', message: 'session invalidated' } });

  await assert.rejects(refreshCodexAuth(file, { force: true, fetchImpl, now: NOW }), (err) => {
    assert.ok(err instanceof CodexOauthError);
    assert.equal(err.code, 'invalid_grant');
    assert.equal(err.retryable, false);
    assert.equal(err.status, 400);
    assert.ok(!err.message.includes(OLD_REFRESH));
    return true;
  });
  assert.equal(await fs.readFile(file, 'utf8'), before);
});

test('refreshCodexAuth：invalid_grant（401 OAuth 风格 error=invalid_grant）→ 同样永久失败', async (t) => {
  const { file } = await tempAuthFile(t, makeAuth());
  const fetchImpl = async () => mockResponse(401, { error: 'invalid_grant', error_description: 'token revoked' });
  await assert.rejects(refreshCodexAuth(file, { force: true, fetchImpl, now: NOW }), (err) => {
    assert.equal(err.code, 'invalid_grant');
    assert.equal(err.retryable, false);
    assert.equal(err.status, 401);
    return true;
  });
});

test('refreshCodexAuth：429 带 Retry-After → rate_limited 可重试；网络/5xx 也归类可重试', async (t) => {
  const { file } = await tempAuthFile(t, makeAuth());

  await assert.rejects(
    refreshCodexAuth(file, { force: true, now: NOW, fetchImpl: async () => mockResponse(429, { error: { code: 'rate_limited' } }, { 'Retry-After': '30' }) }),
    (err) => {
      assert.equal(err.code, 'rate_limited');
      assert.equal(err.retryable, true);
      assert.equal(err.retryAfterMs, 30000);
      return true;
    }
  );

  await assert.rejects(
    refreshCodexAuth(file, {
      force: true,
      now: NOW,
      fetchImpl: async () => {
        throw new Error('fetch failed: ECONNRESET');
      }
    }),
    (err) => {
      assert.equal(err.code, 'network');
      assert.equal(err.retryable, true);
      return true;
    }
  );

  await assert.rejects(
    refreshCodexAuth(file, { force: true, now: NOW, fetchImpl: async () => mockResponse(503, 'upstream down') }),
    (err) => {
      assert.equal(err.code, 'server');
      assert.equal(err.retryable, true);
      assert.equal(err.status, 503);
      return true;
    }
  );
});

test('refreshCodexAuth：2xx 非 JSON / 缺 access_token → bad_response；force 但无 refresh_token → not_refreshable', async (t) => {
  const { file } = await tempAuthFile(t, makeAuth());
  await assert.rejects(
    refreshCodexAuth(file, { force: true, now: NOW, fetchImpl: async () => mockResponse(200, 'not json') }),
    (err) => err.code === 'bad_response'
  );
  await assert.rejects(
    refreshCodexAuth(file, { force: true, now: NOW, fetchImpl: async () => mockResponse(200, { token_type: 'Bearer' }) }),
    (err) => err.code === 'bad_response'
  );

  const noRefresh = await tempAuthFile(t, makeAuth({ refresh: '' }));
  await assert.rejects(refreshCodexAuth(noRefresh.file, { force: true, now: NOW, fetchImpl: async () => mockResponse(200, tokenResponse()) }), (err) => {
    assert.equal(err.code, 'not_refreshable');
    assert.equal(err.retryable, false);
    return true;
  });
});

// ---------------------------------------------------------------- ensure 入口

test('ensureCodexAuthFresh：allowRefresh=false 时只读不写（live 保护）', async (t) => {
  const auth = makeAuth({ expMs: NOW - 1000 }); // 已过期也不刷新
  const { file } = await tempAuthFile(t, auth);
  const before = await fs.readFile(file, 'utf8');
  let calls = 0;
  const result = await ensureCodexAuthFresh(file, {
    allowRefresh: false,
    now: NOW,
    fetchImpl: async () => {
      calls += 1;
      return mockResponse(200, tokenResponse());
    }
  });
  assert.equal(calls, 0);
  assert.equal(result.refreshed, false);
  assert.equal(result.reason, 'disabled');
  assert.equal(result.needsRefresh, true);
  assert.equal(result.auth.tokens.access_token, auth.tokens.access_token);
  assert.equal(await fs.readFile(file, 'utf8'), before);
});

test('ensureCodexAuthFresh：令牌还新时 refreshed=false 且不发请求', async (t) => {
  const { file } = await tempAuthFile(t, makeAuth());
  let calls = 0;
  const result = await ensureCodexAuthFresh(file, {
    allowRefresh: true,
    now: NOW,
    fetchImpl: async () => {
      calls += 1;
      return mockResponse(200, tokenResponse());
    }
  });
  assert.equal(calls, 0);
  assert.equal(result.refreshed, false);
  assert.equal(result.reason, 'fresh');
  assert.equal(result.needsRefresh, false);
});

test('ensureCodexAuthFresh：将过期时续期；支持对象式参数与 leewaySeconds', async (t) => {
  const expiring = await tempAuthFile(t, makeAuth({ expMs: NOW + 2 * 60 * 60 * 1000 }));
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return mockResponse(200, tokenResponse());
  };

  // 默认 24h 阈值：剩 2h 需要续期
  const refreshed = await ensureCodexAuthFresh(expiring.file, { allowRefresh: true, now: NOW, fetchImpl });
  assert.equal(calls, 1);
  assert.equal(refreshed.refreshed, true);
  assert.equal(refreshed.reason, 'refreshed');

  // 对象式参数 + leewaySeconds=6h：同样剩 2h 需要续期；此时刚刷过（剩 10 天）→ 不再刷
  calls = 0;
  const another = await tempAuthFile(t, makeAuth({ expMs: NOW + 2 * 60 * 60 * 1000 }));
  const byObject = await ensureCodexAuthFresh({
    authPath: another.file,
    allowRefresh: true,
    now: NOW,
    leewaySeconds: 6 * 60 * 60,
    fetchImpl
  });
  assert.equal(calls, 1);
  assert.equal(byObject.refreshed, true);

  // leewaySeconds=1h：剩 2h 视为还新 → 不刷
  calls = 0;
  const third = await tempAuthFile(t, makeAuth({ expMs: NOW + 2 * 60 * 60 * 1000 }));
  const notNeeded = await ensureCodexAuthFresh(third.file, { allowRefresh: true, now: NOW, leewaySeconds: 3600, fetchImpl });
  assert.equal(calls, 0);
  assert.equal(notNeeded.refreshed, false);
  assert.equal(notNeeded.reason, 'fresh');
});

test('ensureCodexAuthFresh：force 跳过过期判断；force 且无 refresh_token 时返回 reason 不抛错', async (t) => {
  const fresh = await tempAuthFile(t, makeAuth());
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return mockResponse(200, tokenResponse());
  };
  const forced = await ensureCodexAuthFresh(fresh.file, { allowRefresh: true, force: true, now: NOW, fetchImpl });
  assert.equal(calls, 1);
  assert.equal(forced.refreshed, true);

  const noRefresh = await tempAuthFile(t, makeAuth({ refresh: '' }));
  const skipped = await ensureCodexAuthFresh(noRefresh.file, { allowRefresh: true, force: true, now: NOW, fetchImpl });
  assert.equal(skipped.refreshed, false);
  assert.equal(skipped.reason, 'no-refresh-token');
  assert.equal(calls, 1);
});

// ---------------------------------------------------------------- 并发锁 / 原子写 / 安全

test('ensureCodexAuthFresh：同一账号并发只刷新一次（单账号锁 + 锁内二次判断）', async (t) => {
  const { file } = await tempAuthFile(t, makeAuth({ expMs: NOW + 60 * 60 * 1000 }));
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return mockResponse(200, tokenResponse());
  };

  const [first, second] = await Promise.all([
    ensureCodexAuthFresh(file, { allowRefresh: true, now: NOW, fetchImpl }),
    ensureCodexAuthFresh(file, { allowRefresh: true, now: NOW, fetchImpl })
  ]);
  assert.equal(calls, 1, '并发调用只应刷新一次');
  const flags = [first.refreshed, second.refreshed].sort();
  assert.deepEqual(flags, [false, true]);
  assert.deepEqual([first.skipped, second.skipped], [false, false], '并发不应产生 CAS 冲突跳过');
  const written = await readJson(file);
  assert.equal(written.tokens.access_token, tokenResponse().access_token);
  assert.equal(written.tokens.refresh_token, NEW_REFRESH);
});

test('withCodexAuthLock：同一路径串行、不同路径互不阻塞', async () => {
  const order = [];
  await Promise.all([
    withCodexAuthLock('C:/tmp/a/auth.json', async () => {
      order.push('a1');
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push('a2');
    }),
    withCodexAuthLock('C:/tmp/a/auth.json', async () => {
      order.push('a3');
    })
  ]);
  assert.deepEqual(order, ['a1', 'a2', 'a3']);

  const started = [];
  await Promise.all([
    withCodexAuthLock('C:/tmp/b/auth.json', async () => {
      started.push('b');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }),
    withCodexAuthLock('C:/tmp/c/auth.json', async () => {
      started.push('c');
    })
  ]);
  assert.deepEqual(started, ['b', 'c']);
});

test('writeCodexAuthAtomic：无 tmp 残留、换行结尾、写后校验；rename 失败 → write_failed', async (t) => {
  const { dir, file } = await tempAuthFile(t, makeAuth());
  const next = makeAuth({ access: fakeJwt({ exp: Math.floor((NOW + 5 * DAY) / 1000) }) });
  await writeCodexAuthAtomic(file, next);
  const names = await fs.readdir(dir);
  assert.deepEqual(names.filter((name) => name.endsWith('.tmp')), []);
  assert.ok((await fs.readFile(file, 'utf8')).endsWith('\n'));
  assert.equal((await readJson(file)).tokens.access_token, next.tokens.access_token);

  const before = await fs.readFile(file, 'utf8');
  const failingFs = {
    open: fs.open,
    readFile: fs.readFile,
    unlink: fs.unlink,
    rename: async () => {
      const err = new Error('EPERM: rename locked');
      err.code = 'EPERM';
      throw err;
    }
  };
  await assert.rejects(writeCodexAuthAtomic(file, makeAuth(), { fsImpl: failingFs }), (err) => {
    assert.ok(err instanceof CodexOauthError);
    assert.equal(err.code, 'write_failed');
    return true;
  });
  assert.equal(await fs.readFile(file, 'utf8'), before);
  assert.deepEqual((await fs.readdir(dir)).filter((name) => name.endsWith('.tmp')), []);
});

test('refreshCodexAuth：persist=false 只返回新令牌，不写盘', async (t) => {
  const { file } = await tempAuthFile(t, makeAuth());
  const before = await fs.readFile(file, 'utf8');
  const result = await refreshCodexAuth(file, {
    force: true,
    persist: false,
    now: NOW,
    fetchImpl: async () => mockResponse(200, tokenResponse())
  });
  assert.equal(result.refreshed, true);
  assert.equal(result.auth.tokens.refresh_token, NEW_REFRESH);
  assert.equal(await fs.readFile(file, 'utf8'), before);
});

test('错误与返回元数据不含令牌全文', async (t) => {
  const auth = makeAuth();
  const { file } = await tempAuthFile(t, auth);
  const fetchImpl = async () =>
    mockResponse(400, {
      error: { code: 'invalid_request', message: `bad token ${OLD_REFRESH} for ${auth.tokens.access_token}` }
    });
  const error = await refreshCodexAuth(file, { force: true, now: NOW, fetchImpl }).catch((err) => err);
  assert.ok(error instanceof CodexOauthError);
  assert.ok(!error.message.includes(OLD_REFRESH), '错误文本不得包含 refresh_token');
  assert.ok(!error.message.includes(auth.tokens.access_token), '错误文本不得包含 access_token');

  const success = await refreshCodexAuth(file, {
    force: true,
    now: NOW,
    fetchImpl: async () => mockResponse(200, tokenResponse())
  });
  const { auth: _auth, ...meta } = success;
  const serialized = JSON.stringify(meta);
  assert.ok(!serialized.includes(OLD_REFRESH));
  assert.ok(!serialized.includes(NEW_REFRESH));
  assert.ok(!serialized.includes(tokenResponse().access_token));
});

test('CODEX_REFRESH_TOKEN_URL_OVERRIDE 覆盖刷新端点', async (t) => {
  const { file } = await tempAuthFile(t, makeAuth());
  const previous = process.env[CODEX_REFRESH_URL_ENV];
  process.env[CODEX_REFRESH_URL_ENV] = 'http://127.0.0.1:9/mock-token-endpoint';
  t.after(() => {
    if (previous === undefined) delete process.env[CODEX_REFRESH_URL_ENV];
    else process.env[CODEX_REFRESH_URL_ENV] = previous;
  });

  let calledUrl = null;
  const result = await refreshCodexAuth(file, {
    force: true,
    now: NOW,
    fetchImpl: async (url) => {
      calledUrl = url;
      return mockResponse(200, tokenResponse());
    }
  });
  assert.equal(calledUrl, 'http://127.0.0.1:9/mock-token-endpoint');
  assert.equal(result.endpoint, 'http://127.0.0.1:9/mock-token-endpoint');
});

test('classifyRefreshFailure：归一化 code/retryable/status/retryAfterMs', async (t) => {
  const typed = new CodexOauthError('rate_limited', '刷新被限流', { status: 429, retryable: true, retryAfterMs: 5000 });
  assert.deepEqual(classifyRefreshFailure(typed), {
    code: 'rate_limited',
    retryable: true,
    status: 429,
    retryAfterMs: 5000,
    message: '刷新被限流'
  });
  const networkish = classifyRefreshFailure(new Error('fetch failed: ECONNREFUSED'));
  assert.equal(networkish.code, 'network');
  assert.equal(networkish.retryable, true);
  assert.equal(networkish.status, null);
  const unknown = classifyRefreshFailure(new Error('boom'));
  assert.equal(unknown.code, 'unknown');
  assert.equal(unknown.retryable, false);
});

// ---------------------------------------------------------------- 写回 CAS / 空白值 / 陈旧 tmp（F8）

test('refreshCodexAuth：上游 refresh_token 空白或非字符串 → bad_response，保留旧值不覆盖', async (t) => {
  for (const bad of ['', '   ', 123, null, {}]) {
    const auth = makeAuth();
    const { file } = await tempAuthFile(t, auth);
    const before = await fs.readFile(file, 'utf8');
    await assert.rejects(
      refreshCodexAuth(file, {
        force: true,
        now: NOW,
        fetchImpl: async () => mockResponse(200, tokenResponse({ refresh_token: bad }))
      }),
      (err) => {
        assert.ok(err instanceof CodexOauthError);
        assert.equal(err.code, 'bad_response');
        assert.equal(err.retryable, true);
        assert.ok(!err.message.includes(OLD_REFRESH));
        return true;
      }
    );
    assert.equal(await fs.readFile(file, 'utf8'), before, `refresh_token=${JSON.stringify(bad)} 时不应写盘`);
  }
});

test('refreshCodexAuth：写回前 CAS —— 刷新途中磁盘被外部轮换 → skipped/stale，不覆盖外部新令牌', async (t) => {
  const { file } = await tempAuthFile(t, makeAuth({ expMs: NOW + 60 * 60 * 1000 }));
  const external = makeAuth({ expMs: NOW + 10 * DAY });
  external.tokens.refresh_token = 'rt.1.EXTERNAL-CLI-ROTATED';
  external.tokens.access_token = fakeJwt({ exp: Math.floor((NOW + 10 * DAY) / 1000), jti: 'external' });
  const fetchImpl = async () => {
    await fs.writeFile(file, JSON.stringify(external, null, 2)); // 模拟外部进程在 HTTP 期间完成轮换
    return mockResponse(200, tokenResponse());
  };
  const result = await refreshCodexAuth(file, { force: true, now: NOW, fetchImpl });
  assert.equal(result.refreshed, false);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'stale');
  assert.equal(result.conflict, true);
  const written = await readJson(file);
  assert.equal(written.tokens.refresh_token, 'rt.1.EXTERNAL-CLI-ROTATED', '外部新 refresh_token 不得被覆盖');
  assert.equal(written.tokens.access_token, external.tokens.access_token);
});

test('refreshCodexAuth：CAS —— 刷新途中 auth.json 被删除或损坏 → 不写回，返回 skipped', async (t) => {
  const mutations = [
    async (file) => fs.rm(file),
    async (file) => fs.writeFile(file, '{ broken json')
  ];
  for (const mutate of mutations) {
    const { dir, file } = await tempAuthFile(t, makeAuth({ expMs: NOW + 60 * 60 * 1000 }));
    const result = await refreshCodexAuth(file, {
      force: true,
      now: NOW,
      fetchImpl: async () => {
        await mutate(file);
        return mockResponse(200, tokenResponse());
      }
    });
    assert.equal(result.skipped, true, '磁盘不可读/已损坏时必须放弃写回');
    assert.equal(result.reason, 'stale');
    const names = await fs.readdir(dir);
    assert.ok(!names.some((name) => name.endsWith('.tmp')), '跳过写回也不应残留 .tmp');
  }
});

test('ensureCodexAuthFresh：CAS 冲突时返回 skipped 且不抛错（集成层可无感降级）', async (t) => {
  const { file } = await tempAuthFile(t, makeAuth({ expMs: NOW + 60 * 60 * 1000 }));
  const external = makeAuth({ expMs: NOW + 10 * DAY });
  external.tokens.refresh_token = 'rt.1.EXTERNAL-CLI-ROTATED';
  const result = await ensureCodexAuthFresh(file, {
    allowRefresh: true,
    now: NOW,
    fetchImpl: async () => {
      await fs.writeFile(file, JSON.stringify(external, null, 2));
      return mockResponse(200, tokenResponse());
    }
  });
  assert.equal(result.refreshed, false);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'stale');
});

test('writeCodexAuthAtomic：写入前清理同前缀陈旧 .tmp（含令牌残留），不误删其它文件', async (t) => {
  const { dir, file } = await tempAuthFile(t, makeAuth());
  const stale = path.join(dir, '.auth.json.424242.deadbeef.tmp');
  const fresh = path.join(dir, '.auth.json.777777.fresh.tmp');
  const other = path.join(dir, '.other.json.1.cafe.tmp');
  await fs.writeFile(stale, JSON.stringify({ tokens: { access_token: 'rt.1.STALE-TMP-RESIDUE' } }));
  const old = new Date(Date.now() - 10 * 60 * 1000);
  await fs.utimes(stale, old, old);
  await fs.writeFile(fresh, 'active-write-in-progress'); // 新鲜 tmp 可能是另一进程在写，不能删
  await fs.writeFile(other, 'keep');
  const next = makeAuth({ access: fakeJwt({ exp: Math.floor((NOW + 5 * DAY) / 1000) }) });
  await writeCodexAuthAtomic(file, next);
  const names = await fs.readdir(dir);
  assert.ok(!names.includes('.auth.json.424242.deadbeef.tmp'), '同前缀陈旧 tmp 应被清理');
  assert.ok(names.includes('.auth.json.777777.fresh.tmp'), '新鲜同前缀 tmp 可能属于并发写入，不应误删');
  assert.ok(names.includes('.other.json.1.cafe.tmp'), '不应误删其它前缀的 tmp');
  assert.equal((await readJson(file)).tokens.access_token, next.tokens.access_token);
});
// ---------------------------------------------------------------- P3 六项（G4）

test('refreshCodexAuth：Retry-After 支持 HTTP-date（未来→剩余毫秒、过去→0）', async (t) => {
  const { file } = await tempAuthFile(t, makeAuth({ expMs: NOW + 60 * 60 * 1000 }));
  const future = new Date(Date.now() + 30000).toUTCString();
  await assert.rejects(
    refreshCodexAuth(file, { force: true, now: NOW, fetchImpl: async () => mockResponse(429, {}, { 'Retry-After': future }) }),
    (err) => {
      assert.equal(err.code, 'rate_limited');
      assert.equal(err.retryable, true);
      assert.ok(err.retryAfterMs > 0 && err.retryAfterMs <= 32000, `retryAfterMs=${err.retryAfterMs}`);
      return true;
    }
  );
  const past = new Date(Date.now() - 60000).toUTCString();
  await assert.rejects(
    refreshCodexAuth(file, { force: true, now: NOW, fetchImpl: async () => mockResponse(429, {}, { 'Retry-After': past }) }),
    (err) => {
      assert.equal(err.code, 'rate_limited');
      assert.equal(err.retryAfterMs, 0);
      return true;
    }
  );
});

test('refreshCodexAuth：畸形 fetch 返回/抛错归一为 network，不抛裸 TypeError', async (t) => {
  const fetches = [
    async () => null,
    async () => ({}),
    async () => ({ ok: true, status: 200, text: async () => { throw new Error('stream broken'); } }),
    async () => { throw 'boom'; },
    async () => { throw null; }
  ];
  for (const fetchImpl of fetches) {
    const { file } = await tempAuthFile(t, makeAuth({ expMs: NOW + 60 * 60 * 1000 }));
    await assert.rejects(refreshCodexAuth(file, { force: true, now: NOW, fetchImpl }), (err) => {
      assert.ok(err instanceof CodexOauthError, `应为 CodexOauthError，实际 ${err && err.name}`);
      assert.equal(err.code, 'network');
      assert.equal(err.retryable, true);
      return true;
    });
  }
});

test('classifyRefreshFailure：支持 secrets 脱敏，默认行为不变', () => {
  const secret = 'rt.1.LEAK-SECRET-abcdef';
  const raw = classifyRefreshFailure(new Error(`boom ${secret}`));
  assert.ok(raw.message.includes(secret), '不传 secrets 时保持原样（调用方可决定是否记录）');
  assert.equal(classifyRefreshFailure(new Error(`boom ${secret}`), { secrets: [secret] }).message, 'boom ***');
  const typed = new CodexOauthError('bad_response', `bad ${secret}`);
  assert.equal(classifyRefreshFailure(typed, { secrets: [secret] }).message, 'bad ***');
  assert.equal(classifyRefreshFailure(typed).message, `bad ${secret}`);
});

test('shouldRefresh：24h 阈值严格开区间（恰好 24h 不续期，24h-1s 续期）', async (t) => {
  const exact = NOW + 24 * 60 * 60 * 1000; // NOW 与秒对齐
  assert.equal(shouldRefresh(makeAuth({ expMs: exact }), { now: NOW }), false);
  assert.equal(shouldRefresh(makeAuth({ expMs: exact - 1000 }), { now: NOW }), true);
  assert.equal(shouldRefresh(makeAuth({ expMs: exact + 1000 }), { now: NOW }), false);
  assert.equal(assessCodexAuth(makeAuth({ expMs: exact }), { now: NOW }).reason, 'fresh');

  const { file } = await tempAuthFile(t, makeAuth({ expMs: exact }));
  let calls = 0;
  const result = await ensureCodexAuthFresh(file, {
    allowRefresh: true,
    now: NOW,
    fetchImpl: async () => {
      calls += 1;
      return mockResponse(200, tokenResponse());
    }
  });
  assert.equal(calls, 0, '剩余恰好 24h 不应发起刷新');
  assert.equal(result.refreshed, false);
  assert.equal(result.reason, 'fresh');
});

test('accessTokenExpiresAt / shouldRefresh：JWT exp 为字符串数字时也能解析', () => {
  const expSec = Math.floor((NOW + 3 * DAY) / 1000);
  const auth = makeAuth();
  auth.tokens.access_token = fakeJwt({ exp: String(expSec) });
  assert.equal(accessTokenExpiresAt(auth).getTime(), expSec * 1000);
  assert.equal(shouldRefresh(auth, { now: NOW }), false);

  auth.tokens.access_token = fakeJwt({ exp: 'not-a-number' });
  assert.equal(accessTokenExpiresAt(auth), null);
  assert.equal(assessCodexAuth(auth, { now: NOW }).reason, 'unknown-expiry');
  assert.equal(shouldRefresh(auth, { now: NOW }), true);
});

test('readCodexAuth / refreshCodexAuth：~ 路径统一展开为 home', async (t) => {
  const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'quota-board-home-'));
  const previousUserProfile = process.env.USERPROFILE;
  const previousHome = process.env.HOME;
  process.env.USERPROFILE = fakeHome;
  process.env.HOME = fakeHome;
  t.after(async () => {
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await fs.rm(fakeHome, { recursive: true, force: true });
  });

  const dir = path.join(fakeHome, '.codex-managed');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'auth.json');
  const auth = makeAuth({ expMs: NOW + 60 * 60 * 1000 });
  await fs.writeFile(file, JSON.stringify(auth, null, 2));
  const tildePath = '~/.codex-managed/auth.json';

  const read = await readCodexAuth(tildePath);
  assert.equal(read.tokens.account_id, auth.tokens.account_id);

  let calls = 0;
  const result = await refreshCodexAuth(tildePath, {
    force: true,
    now: NOW,
    fetchImpl: async () => {
      calls += 1;
      return mockResponse(200, tokenResponse());
    }
  });
  assert.equal(calls, 1);
  assert.equal(result.refreshed, true);
  const written = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(written.tokens.refresh_token, NEW_REFRESH);
});
