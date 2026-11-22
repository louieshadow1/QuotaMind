/**
 * 对抗性回归套件 2（G9 / task-55）—— P2/P3 清理轮
 *
 * 覆盖对抗报告剩余 P2/P3：API 语义（脱敏/405/OPTIONS/HEAD/days/usage.cached/请求合并/写令牌/HTTP1.0）、
 * 设备码接口（路径脱敏/DELETE :id/半写 auth 恢复）、窗口附加额度折叠、codexByAccount 一致性、
 * 跨进程 file-lock、config 损坏恢复、Retry-After date、DNS 失败拒绝。
 *
 * 只使用公开入口；所有写操作在 os.tmpdir() 临时 data；gate 表按源码特征自动探测，Gx 落盘后自动启用。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createStore } from '../lib/config.mjs';
import { startServer } from '../server.mjs';
import { assertPublicHttpUrl, fetchCodexUsage } from '../lib/adapters.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const P = (...parts) => path.join(ROOT, ...parts);

async function readSource(rel) {
  try {
    return await fs.readFile(P(rel), 'utf8');
  } catch {
    return '';
  }
}
const SRC = {
  server: await readSource('server.mjs'),
  adapters: await readSource(path.join('lib', 'adapters.mjs')),
  device: await readSource(path.join('lib', 'codex-device-login.mjs')),
  oauth: await readSource(path.join('lib', 'codex-oauth.mjs')),
  daily: await readSource(path.join('lib', 'daily-history.mjs'))
};
const GATE = {
  api: /X-Auth-Token|WRITE_TOKEN/.test(SRC.server) && /405/.test(SRC.server) && /\/api\/usage[\s\S]{0,400}cached/.test(SRC.server),
  merge: /inflight|inFlight|pendingSnapshot|refreshPromise|snapshotPromise/i.test(SRC.server),
  http10: /HTTP\/1\.0|httpVersion/.test(SRC.server),
  device: /auth\.json\.broken-/.test(SRC.device) || /redact|~/.test(SRC.device),
  extra: /limit_name/.test(SRC.adapters),
  dns: /解析失败/.test(SRC.adapters) && /拒绝|reject|throw/.test(SRC.adapters),
  ghost: /codexAccounts/.test(SRC.daily) || /codexAccounts/.test(SRC.server),
  retryDate: /Date\.parse\([^)]*Retry-After|retryAfter[\s\S]{0,120}Date\.parse/i.test(SRC.oauth),
  fileLock: /withFileLock|file-lock\.mjs/i.test(SRC.daily + SRC.server)
};
const skip = (key, label) => (GATE[key] ? false : '等待 ' + label + ' 落盘后启用');
// 收尾验收时按 G1-G8 实际落盘情况把这些标记翻成 false（或改成源码探测）；当前为本轮进行中的临时门控。
const PENDING = { api: false, device: false, ghost: false };
const pendingSkip = (key, label) => (PENDING[key] ? '等待 ' + label + ' 落盘后启用（收尾翻启）' : false);

async function makeDataDir({ codexEnabled = false, extraEnv = {} } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qb-adv2-'));
  const authPath = path.join(dir, 'codex-auth.json');
  await fs.writeFile(authPath, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'tok-adv2', account_id: 'acct-adv2' } }));
  await fs.writeFile(
    path.join(dir, 'config.json'),
    JSON.stringify({
      port: 0,
      refreshSeconds: 10,
      providers: {
        codex: { enabled: codexEnabled, liveEnabled: false, authPath },
        opencodeGo: { enabled: false },
        relays: []
      }
    })
  );
  return { dir, authPath, extraEnv };
}

async function startApp(t, dataDir, env = {}) {
  const app = await startServer({ dataDir, env: { PORT: '0', QUOTA_BOARD_DISABLE_ARCHIVER: '1', ...env } });
  t.after(async () => {
    await app.close();
    for (let i = 0; i < 8; i += 1) {
      try {
        await fs.rm(dataDir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
    }
  });
  return app;
}

function jsonFetch(url, options = {}) {
  return fetch(url, options);
}

function jsonPost(url, body, extraHeaders = {}) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body)
  });
}

function rawHttp10(port, raw) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => socket.write(raw));
    let data = '';
    socket.setTimeout(5000, () => socket.destroy(new Error('timeout')));
    socket.on('data', (chunk) => {
      data += chunk.toString('utf8');
    });
    socket.on('end', () => resolve(data));
    socket.on('error', reject);
    socket.on('close', () => resolve(data));
  });
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

// ─────────────────── G2：/api/config 路径脱敏 ───────────────────

test('P2 路径脱敏：/api/config 不泄露绝对路径与 secrets', { skip: pendingSkip('api', 'G2 路径脱敏') }, async (t) => {
  const { dir: dataDir } = await makeDataDir();
  const app = await startApp(t, dataDir);
  const response = await jsonFetch(app.url + '/api/config');
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.doesNotMatch(text, /[A-Za-z]:\\\\/, 'config 响应不得出现盘符绝对路径（如 C:\\\\ 或 G:\\\\）');
  assert.doesNotMatch(text, /secrets\.json\s*[:=]\s*"/, '不得泄露 secrets 路径内容');
  const config = JSON.parse(text);
  const codex = config.providers && config.providers.codex;
  if (codex && codex.authPath) assert.match(codex.authPath, /^~?[\\/]/, 'authPath 应缩写为 ~ 或相对路径');
});

// ─────────────────── G2：405 / OPTIONS / HEAD ───────────────────

test('P3 方法语义：已知路由错误方法 405+Allow、OPTIONS 非 404、HEAD 返回头', { skip: pendingSkip('api', 'G2 方法语义') }, async (t) => {
  const { dir: dataDir } = await makeDataDir();
  const app = await startApp(t, dataDir);

  const wrong = await jsonFetch(app.url + '/api/settings', { method: 'GET' });
  assert.equal(wrong.status, 405, 'GET /api/settings 应 405');
  const allow = wrong.headers.get('allow') || '';
  assert.match(allow, /POST/i, '405 应带 Allow: POST，实际 ' + allow);

  const options = await jsonFetch(app.url + '/api/health', { method: 'OPTIONS' });
  assert.ok([204, 405].includes(options.status), 'OPTIONS 不应 404，实际 ' + options.status);

  const head = await jsonFetch(app.url + '/api/health', { method: 'HEAD' });
  assert.equal(head.status, 200, 'HEAD /api/health 应 200');
  const body = await head.text();
  assert.equal(body, '', 'HEAD 不应返回 body');
});

// ─────────────────── G2：days 参数非法 → 400 ───────────────────

test('P3 days 参数：非数字/负数/超范围 → 400，合法值仍 200', { skip: pendingSkip('api', 'G2 days 校验') }, async (t) => {
  const { dir: dataDir } = await makeDataDir();
  const app = await startApp(t, dataDir);
  for (const value of ['abc', '-1', '999999', '3.5']) {
    const response = await jsonFetch(app.url + '/api/daily?days=' + encodeURIComponent(value));
    assert.equal(response.status, 400, 'days=' + value + ' 应 400');
  }
  for (const value of ['0', '371', '3650']) {
    const response = await jsonFetch(app.url + '/api/daily?days=' + value);
    assert.equal(response.status, 200, 'days=' + value + ' 应 200');
  }
});

// ─────────────────── G2：/api/usage cached 字段 ───────────────────

test('P3 /api/usage 与 quota/daily 一致：TTL 内第二次 reduced cached=true', { skip: pendingSkip('api', 'G2 usage.cached') }, async (t) => {
  const { dir: dataDir } = await makeDataDir();
  const app = await startApp(t, dataDir);
  const first = await (await jsonFetch(app.url + '/api/usage')).json();
  assert.equal('cached' in first, true, '/api/usage 应含 cached 字段');
  const second = await (await jsonFetch(app.url + '/api/usage')).json();
  assert.equal(second.cached, true, 'TTL 内第二次应 cached=true');
});

// ─────────────────── G2：并发 refresh 合并（上游 1 次） ───────────────────

test('P2 并发 GET /api/quota?refresh=1：同一时刻只重建一次（上游只打 1 次）', { skip: pendingSkip('api', 'G2⑤请求合并') }, async (t) => {
  let upstreamHits = 0;
  const upstream = http.createServer((req, res) => {
    upstreamHits += 1;
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, data: { unlimited_quota: false, total_used: 100, total_available: 1000 } }));
    }, 120);
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamPort = upstream.address().port;
  t.after(() => new Promise((resolve) => upstream.close(resolve)));

  const { dir: dataDir } = await makeDataDir();
  // adapters 读 process.env（不是 startServer 的 env 参数），测试内临时放行本机 mock 上游
  const savedAllow = process.env.QUOTA_BOARD_ALLOW_PRIVATE_RELAY;
  process.env.QUOTA_BOARD_ALLOW_PRIVATE_RELAY = '1';
  t.after(() => {
    if (savedAllow === undefined) delete process.env.QUOTA_BOARD_ALLOW_PRIVATE_RELAY;
    else process.env.QUOTA_BOARD_ALLOW_PRIVATE_RELAY = savedAllow;
  });
  const app = await startApp(t, dataDir);
  // 走真实写接口创建中转站（同时写入 token secret），确保采集链路真的会请求 mock 上游
  const created = await jsonPost(app.url + '/api/relays', {
    name: 'mock',
    type: 'generic',
    baseUrl: 'http://127.0.0.1:' + upstreamPort,
    extract: { remaining: 'data.total_available', spend: 'data.total_used' },
    token: 'mock-token'
  });
  assert.equal(created.status, 201, '创建 mock 中转站应 201');

  const responses = await Promise.all(Array.from({ length: 8 }, () => jsonFetch(app.url + '/api/quota?refresh=1')));
  assert.deepEqual(responses.map((response) => response.status), new Array(8).fill(200));
  assert.equal(upstreamHits, 1, '并发强制刷新应合并为 1 次上游请求，实际 ' + upstreamHits);
});

// ─────────────────── G2：可选写令牌 ───────────────────

test('P2 可选写令牌：设置 QUOTA_BOARD_WRITE_TOKEN 后无/错令牌 401，正确令牌放行；未设置不受影响', { skip: pendingSkip('api', 'G2⑥写令牌') }, async (t) => {
  const { dir: dataDir } = await makeDataDir();
  const app = await startApp(t, dataDir, { QUOTA_BOARD_WRITE_TOKEN: 'write-secret-1' });
  const url = app.url + '/api/settings';
  assert.equal((await jsonPost(url, { title: 'no-token' })).status, 401, '无令牌应 401');
  assert.equal((await jsonPost(url, { title: 'bad' }, { 'X-Auth-Token': 'nope' })).status, 401, '错误令牌应 401');
  const ok = await jsonPost(url, { title: 'token-ok' }, { 'X-Auth-Token': 'write-secret-1' });
  assert.equal(ok.status, 200, '正确令牌应放行');

  // 未设置 env 的实例：行为不变
  const second = await makeDataDir();
  const app2 = await startApp(t, second.dir);
  assert.equal((await jsonPost(app2.url + '/api/settings', { title: 'no-env' })).status, 200);
});

// ─────────────────── G2：HTTP/1.0 无 Host → 400 ───────────────────

test('P3 HTTP/1.0 无 Host：返回 400 而​不是放行', { skip: pendingSkip('api', 'G2⑦ HTTP/1.0') }, async (t) => {
  const { dir: dataDir } = await makeDataDir();
  const app = await startApp(t, dataDir);
  const port = Number(new URL(app.url).port);
  const raw = await rawHttp10(port, 'GET /api/health HTTP/1.0\r\n\r\n');
  assert.match(raw, /^HTTP\/1\.[01] 400/m, 'HTTP/1.0 无 Host 应 400，实际响应头：' + raw.split('\r\n')[0]);
});

// ─────────────────── G3：设备码 GET 不暴露绝对路径 / DELETE :id ───────────────────

test('P2 设备码 GET 不暴露绝对路径 + DELETE /:id 精确取消', { skip: pendingSkip('device', 'G3') }, async (t) => {
  const { dir: dataDir } = await makeDataDir();
  const app = await startApp(t, dataDir, { QUOTA_BOARD_CODEX_BIN: process.execPath, PATH: process.env.PATH || '' });
  const base = app.url + '/api/codex/managed-login';

  const started = await jsonPost(base, { name: 'g3' });
  assert.equal(started.status, 202, '设备码启动应 202');
  const session = (await started.json()).session || {};

  const list = await jsonFetch(base);
  assert.equal(list.status, 200);
  const listText = await list.text();
  assert.doesNotMatch(listText, /[A-Za-z]:\\\\/, 'GET 会话不得暴露绝对路径（codexHome 等）');
  assert.doesNotMatch(listText, /"codexHome"\s*:\s*"[A-Za-z]:/, 'codexHome 不得是绝对路径');

  if (session.id) {
    const del = await jsonFetch(base + '/' + encodeURIComponent(session.id), { method: 'DELETE' });
    assert.equal(del.status, 200, 'DELETE /:id 应 200');
    const after = await jsonFetch(base + '?id=' + encodeURIComponent(session.id));
    const afterBody = await after.json();
    const got = afterBody.session || (Array.isArray(afterBody.sessions) ? afterBody.sessions.find((item) => item.id === session.id) : null);
    assert.ok(!got || got.status === 'cancelled', '按 id 查询应显示 cancelled');
  } else {
    await jsonFetch(base, { method: 'DELETE' });
  }
});

// ─────────────────── G3：半写/损坏 auth.json 可恢复 ───────────────────

test('P2 半写 auth.json：视为无效登录并允许同 slug 重新登录（不永久阻塞）', { skip: pendingSkip('device', 'G3') }, async (t) => {
  const { dir: dataDir } = await makeDataDir();
  const profileDir = path.join(dataDir, 'codex-profiles', 'codex');
  await fs.mkdir(profileDir, { recursive: true });
  await fs.writeFile(path.join(profileDir, 'auth.json'), '{ "tokens": { "access_token": "tok', 'utf8');

  const app = await startApp(t, dataDir, { QUOTA_BOARD_CODEX_BIN: process.execPath, PATH: process.env.PATH || '' });
  const response = await jsonPost(app.url + '/api/codex/managed-login', { name: 'recover' });
  assert.equal(response.status, 202, '半写 auth 不应阻塞重新登录，实际 ' + response.status);
  await jsonFetch(app.url + '/api/codex/managed-login', { method: 'DELETE' }).catch(() => {});
});

// ─────────────────── G6：config 损坏恢复 ───────────────────

test('P2 config.json 损坏：备份为 .broken-* 并可用默认值启动', async (t) => {
  const { dir: dataDir } = await makeDataDir();
  await fs.writeFile(path.join(dataDir, 'config.json'), '{ 坏 JSON', 'utf8');
  const store = createStore(dataDir);
  await store.init();
  const files = await fs.readdir(dataDir);
  assert.ok(files.some((name) => /^config\.json\.broken-/.test(name)), '坏 config 应备份为 config.json.broken-*');
  const config = await store.load();
  assert.equal(typeof config, 'object');
  assert.ok(config.providers, '备份后应能继续启动');
});

// ─────────────────── G1：附加窗口折叠/健壮性 ───────────────────

test('P2 附加额度窗口：畸形条目跳过、最多 8 个、label 去重、limit_name 优先', { skip: skip('extra', 'G1 附加窗口') }, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qb-adv2-extra-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const authPath = path.join(dir, 'auth.json');
  await fs.writeFile(authPath, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'tok', account_id: 'acct' } }));

  const extras = [];
  for (let i = 0; i < 12; i += 1) {
    extras.push({
      display_name: 'Extra ' + i,
      limit_name: 'Limit ' + i,
      rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 604800 } }
    });
  }
  extras.push(null, 'garbage', { display_name: 'broken-no-window' });
  const body = {
    plan_type: 'plus',
    rate_limit: { primary_window: { used_percent: 1, limit_window_seconds: 18000 } },
    additional_rate_limits: extras
  };
  const provider = await fetchCodexUsage({
    name: 'extra',
    authPath,
    fetchImpl: async () => ({ status: 200, ok: true, text: async () => JSON.stringify(body) })
  });
  const extraWindows = provider.windows.filter((window) => String(window.key).startsWith('extra:'));
  assert.ok(extraWindows.length <= 8, '附加窗口最多渲染 8 个，实际 ' + extraWindows.length);
  const labels = extraWindows.map((window) => window.label);
  assert.equal(new Set(labels).size, labels.length, '附加窗口 label 不得重复：' + JSON.stringify(labels));
  assert.ok(labels.some((label) => label.includes('Limit 0')), 'limit_name 应优先于 display_name');
});

// ─────────────────── G1：DNS 解析失败 → 拒绝 ───────────────────

test('P2 SSRF DNS 解析失败：必须拒绝（不得因解析失败而放行）', { skip: skip('dns', 'G1③') }, async () => {
  await assert.rejects(
    () => assertPublicHttpUrl('https://unresolvable.invalid/api', { lookupImpl: async () => { throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }); } }),
    'DNS 解析失败应拒绝访问'
  );
});

// ─────────────────── G5：codexByAccount 一致性 ───────────────────

test('P2 codexByAccount 无 ghost 键：明细里的账号都能在 codexAccounts 映射到', { skip: pendingSkip('ghost', 'ghost 键修复') }, async (t) => {
  const { dir: dataDir } = await makeDataDir();
  const ghostId = 'ghost-account-0000';
  await fs.writeFile(
    path.join(dataDir, 'daily-history.json'),
    JSON.stringify({
      version: 1,
      days: {
        '2026-09-01': { date: '2026-09-01', codexTokens: 100, codexByAccount: { [ghostId]: 100 } },
        '2026-09-02': { date: '2026-09-02', codexTokens: 50, codexByAccount: { [ghostId]: 50 } }
      }
    }),
    'utf8'
  );
  const app = await startApp(t, dataDir);
  const daily = await (await jsonFetch(app.url + '/api/daily?days=371')).json();
  const idsInSeries = new Set();
  for (const entry of daily.series || []) for (const key of Object.keys(entry.codexByAccount || {})) idsInSeries.add(key);
  const mapped = new Set((daily.codexAccounts || []).map((item) => item.id));
  for (const id of idsInSeries) assert.ok(mapped.has(id), 'codexByAccount 的键必须能在 codexAccounts 找到：' + id);
});

// ─────────────────── G4：Retry-After HTTP-date ───────────────────

test('P3 Retry-After 支持 HTTP-date（不只看秒数）', async () => {
  const { refreshCodexAuth } = await import('../lib/codex-oauth.mjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qb-adv2-retry-'));
  const authPath = path.join(dir, 'auth.json');
  await fs.writeFile(authPath, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'old', refresh_token: 'refresh-1', account_id: 'acct' } }));
  const waitMs = 120000;
  const when = new Date(Date.now() + waitMs).toUTCString();
  const startedAt = Date.now();
  const error = await refreshCodexAuth(authPath, {
    force: true,
    fetchImpl: async () => ({
      status: 429,
      ok: false,
      headers: { get: (name) => (String(name).toLowerCase() === 'retry-after' ? when : null) },
      text: async () => JSON.stringify({ error: { message: 'rate limited' } })
    })
  }).then((value) => { throw new Error('429 应抛错，实际成功：' + JSON.stringify(value).slice(0, 200)); }, (err) => err);
  assert.equal(error.code, 'rate_limited', '429 应分类为 rate_limited');
  assert.equal(error.retryable, true, '429 应可重试');
  assert.equal(typeof error.retryAfterMs, 'number', '应解析 Retry-After 为 retryAfterMs');
  const elapsed = Date.now() - startedAt;
  assert.ok(
    error.retryAfterMs > waitMs - elapsed - 5000 && error.retryAfterMs <= waitMs + 5000,
    'HTTP-date 应换算成剩余毫秒，实际 ' + error.retryAfterMs
  );
  await fs.rm(dir, { recursive: true, force: true });
});

// ─────────────────── G5：跨进程 file-lock ───────────────────

test('P2 跨进程并发导入：两个进程同时写同一 data，不丢天', { skip: skip('fileLock', 'G5 文件锁') }, async (t) => {
  const { dir: dataDir } = await makeDataDir();
  const store = createStore(dataDir);
  await store.init();
  const workerPath = path.join(dataDir, 'worker.mjs');
  const libUrl = new URL('../lib/daily-history.mjs', import.meta.url).href;
  const configUrl = new URL('../lib/config.mjs', import.meta.url).href;
  await fs.writeFile(
    workerPath,
    'import { importDays } from ' + JSON.stringify(libUrl) + ';\n' +
      'import { createStore } from ' + JSON.stringify(configUrl) + ';\n' +
      'const store = createStore(process.argv[2]);\n' +
      'const date = process.argv[3];\n' +
      'await importDays(store, [{ date, codexTokens: 700 }]);\n' +
      'process.exit(0);\n',
    'utf8'
  );

  const run = (date) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [workerPath, dataDir, date], { cwd: ROOT, stdio: 'ignore' });
      child.on('error', reject);
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('worker exit ' + code))));
    });

  await Promise.all([run('2026-06-01'), run('2026-06-02')]);
  const saved = JSON.parse(await fs.readFile(path.join(dataDir, 'daily-history.json'), 'utf8'));
  assert.ok(saved.days['2026-06-01'], '跨进程并发后 2026-06-01 丢失');
  assert.ok(saved.days['2026-06-02'], '跨进程并发后 2026-06-02 丢失');
});
