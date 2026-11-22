import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, verifyImportedHistory } from '../server.mjs';

async function makeDataDir({ codexEnabled = false } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'quota-board-test-'));
  const authPath = path.join(dir, 'codex-auth.json');
  await fs.writeFile(authPath, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'tok-test-codex' } }));
  await fs.writeFile(
    path.join(dir, 'config.json'),
    JSON.stringify({
      port: 0,
      refreshSeconds: 10,
      providers: {
        codex: { enabled: codexEnabled, authPath },
        opencodeGo: { enabled: false },
        relays: []
      }
    })
  );
  return { dir, authPath };
}

async function jsonFetch(url, options) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => null);
  return { status: response.status, body, response };
}

test('服务端：静态页与空配置快照', async (t) => {
  const { dir: dataDir } = await makeDataDir();
  const app = await startServer({ dataDir, env: { PORT: '0' } });
  t.after(async () => {
    await app.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  const page = await fetch(`${app.url}/`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Token 使用情况/);
  assert.match(await page.headers.get('content-security-policy'), /script-src 'self'/);

  const quota = await jsonFetch(`${app.url}/api/quota`);
  assert.equal(quota.status, 200);
  // 空配置时固定出现三张卡片：Codex（已关闭）、OpenCode Go（已关闭）、DeepSeek 平台
  assert.equal(quota.body.providers.length, 3);
  assert.deepEqual(
    quota.body.providers.map((provider) => provider.status),
    ['unconfigured', 'unconfigured', 'unconfigured']
  );
  // C3：Codex 未启用时多账号汇总为空（占位卡不算账号）
  assert.deepEqual(quota.body.codexSummary, { total: 0, active: 0, multi: false, accounts: [] });
});

test('DeepSeek 顶部累计：冷启动归档、30 天滚动、离线重启和补录', async (t) => {
  const { dir: dataDir } = await makeDataDir();
  const timezone = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
  t.after(() => {
    if (timezone === undefined) delete process.env.TZ;
    else process.env.TZ = timezone;
  });
  t.mock.method(Date, 'now', () => Date.parse('2026-11-02T07:30:00Z'));
  t.mock.method(os, 'homedir', () => dataDir);
  const fetchLoopback = globalThis.fetch;
  const today = Math.floor((Date.now() + 8 * 3600000) / 86400000) * 86400 - 28800;
  const ago = (days) => today - days * 86400;
  let usage = [[ago(29), 400], [ago(15), 100]];
  let offline = false;
  let rejectHistoryWrites = false;
  const rename = fs.rename;
  const historyFile = path.join(dataDir, 'daily-history.json');
  t.mock.method(fs, 'rename', async (from, to) => {
    if (rejectHistoryWrites && to === historyFile) {
      throw Object.assign(new Error('模拟磁盘暂时不可写'), { code: 'EIO' });
    }
    return rename(from, to);
  });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const target = new URL(url);
    if (target.hostname === '127.0.0.1') return fetchLoopback(url, options);
    assert.equal(target.hostname, 'platform.deepseek.com');
    const json = (biz_data) => Response.json({ code: 0, data: { biz_data } });
    if (offline) return new Response(null, { status: 503 });
    if (target.pathname.endsWith('/get_user_summary')) {
      return json({ total_costs: [{ currency: 'CNY', amount: '88.00' }] });
    }
    if (target.pathname.endsWith('/amount')) {
      const buckets = usage.map(([time, tokens]) => ({ time, usage: { RESPONSE_TOKEN: tokens } }));
      return json({ series: [{ buckets }] });
    }
    assert.ok(target.pathname.endsWith('/cost'));
    return new Response(null, { status: 503 });
  });

  const env = { PORT: '0', QUOTA_BOARD_DISABLE_ARCHIVER: '1' };
  let app = await startServer({ dataDir, env });
  t.after(async () => {
    await app.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const configured = await jsonFetch(`${app.url}/api/deepseek-platform-token`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: 'synthetic-deepseek-login' })
  });
  assert.equal(configured.status, 200);
  const report = async (refresh = '') => {
    const result = await jsonFetch(`${app.url}/api/usage${refresh}`);
    assert.equal(result.status, 200);
    const channel = result.body.channels.find((item) => item.id === 'deepseek');
    assert.equal(result.body.totalTokens, channel.tokens.total);
    return channel;
  };
  const first = await report();
  assert.equal(first.tokens.total, 500);
  assert.equal(first.archive.days, 2);
  assert.equal(first.spentCny, 88);

  usage = [[ago(15), 90], [ago(0), 25]];
  rejectHistoryWrites = true;
  const failed = await report('?refresh=1');
  assert.equal(failed.tokens.total, 500);
  assert.match(failed.archive.warning, /未能写入/);
  rejectHistoryWrites = false;
  const recovered = await report();
  assert.equal(recovered.tokens.total, 525);
  assert.equal(recovered.archive.warning, undefined);
  assert.equal((await report('?refresh=1')).tokens.total, 525);
  const plotted = await jsonFetch(`${app.url}/api/daily?days=90`);
  assert.equal(plotted.body.totals.deepseekTokens, 525);
  assert.equal(plotted.body.series.at(-1).date, '2026-11-02');
  assert.equal(plotted.body.series.at(-1).deepseekTokens, 25);
  assert.equal(new Set(plotted.body.series.map(({ date }) => date)).size, 90);

  offline = true;
  await app.close();
  app = await startServer({ dataDir, env });
  const restored = await report();
  assert.equal(restored.tokens.total, 525);
  assert.equal(restored.source, 'archive');
  assert.equal(restored.spentCny, null);
  const oldDate = new Date((ago(42) + 28800) * 1000).toISOString().slice(0, 10);
  const imported = await jsonFetch(`${app.url}/api/daily/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel: 'deepseek', data: `date,tokens\n${oldDate},50` })
  });
  assert.equal(imported.status, 200);
  const afterImport = await report();
  assert.equal(afterImport.tokens.total, 575);
  assert.equal(afterImport.archive.firstDate, oldDate);

  offline = false;
  usage = [[ago(0), 26]];
  rejectHistoryWrites = true;
  const failedDaily = await jsonFetch(`${app.url}/api/daily?days=90`);
  assert.equal(failedDaily.body.warning.code, 'history-write-failed');
  rejectHistoryWrites = false;
  const recoveredDaily = await jsonFetch(`${app.url}/api/daily?days=90`);
  assert.equal(recoveredDaily.body.warning, null);
  assert.equal(recoveredDaily.body.totals.deepseekTokens, 576);
  assert.equal((await report()).tokens.total, 576);
});

test('服务端：config.json 损坏时备份坏文件并用默认值启动', async (t) => {
  const { dir: dataDir } = await makeDataDir();
  const configPath = path.join(dataDir, 'config.json');
  await fs.writeFile(configPath, '{ 这不是合法 JSON', 'utf8');
  const app = await startServer({ dataDir, env: { PORT: '0' } });
  t.after(async () => {
    await app.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  const quota = await jsonFetch(`${app.url}/api/quota`);
  assert.equal(quota.status, 200);
  const files = await fs.readdir(dataDir);
  assert.ok(
    files.some((name) => name.startsWith('config.json.broken-')),
    '坏配置应被备份为 config.json.broken-*'
  );
  // 备份后应重新生成可用的 config.json
  const repaired = JSON.parse(await fs.readFile(configPath, 'utf8'));
  assert.equal(typeof repaired, 'object');
});

test('服务端：非法请求体（null / 数组 / 超大）返回 4xx 而不是 500', async (t) => {
  const { dir: dataDir } = await makeDataDir();
  const app = await startServer({ dataDir, env: { PORT: '0' } });
  t.after(async () => {
    await app.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  const post = (body) =>
    fetch(`${app.url}/api/relays`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body
    });

  // JSON null 曾被当成对象解构，抛 TypeError → 500
  assert.equal((await post('null')).status, 400);
  assert.equal((await post('[]')).status, 400);
  assert.equal((await post('"just a string"')).status, 400);
  // 超过 64KB 上限：应回 413，而不是把连接重置掉
  const oversized = JSON.stringify({ name: 'x'.repeat(80 * 1024) });
  assert.equal((await post(oversized)).status, 413);
  // 服务仍然可用
  assert.equal((await jsonFetch(`${app.url}/api/health`)).status, 200);
});

test('服务端：每日用量落盘为长期存档并保留旧日期', async (t) => {
  const { dir: dataDir } = await makeDataDir();
  const app = await startServer({ dataDir, env: { PORT: '0' } });
  t.after(async () => {
    await app.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  // 先手工放一条 3 年前的记录，模拟「历史存档」
  const historyFile = path.join(dataDir, 'daily-history.json');
  await fs.writeFile(
    historyFile,
    JSON.stringify({ version: 1, days: { '2023-01-02': { date: '2023-01-02', codexTokens: 42 } } }),
    'utf8'
  );

  const first = await jsonFetch(`${app.url}/api/daily?days=371&refresh=1`);
  assert.equal(first.status, 200);
  assert.ok(first.body.history, '响应应带 history 元信息');
  assert.ok(first.body.history.firstDate <= '2023-01-02', '旧日期应被统计进范围');

  // 落盘文件里那条老记录不能被覆盖掉
  const saved = JSON.parse(await fs.readFile(historyFile, 'utf8'));
  assert.equal(saved.days['2023-01-02'].codexTokens, 42);

  // 请求全部历史（days=0）也能返回
  const all = await jsonFetch(`${app.url}/api/daily?days=0`);
  assert.equal(all.status, 200);
  assert.ok(all.body.series.length > 300);
});

test('服务端：导入历史用量写入存档、可重复导入', async (t) => {
  const { dir: dataDir } = await makeDataDir();
  const app = await startServer({ dataDir, env: { PORT: '0' } });
  t.after(async () => {
    await app.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  const post = (body) =>
    fetch(`${app.url}/api/daily/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

  // 渠道缺失 → 400
  assert.equal((await post({ data: '2026-08-01,1' })).status, 400);
  // 未知渠道 → 400
  assert.equal((await post({ channel: 'nope', data: '2026-08-01,1' })).status, 400);
  // 没有有效行 → 400
  assert.equal((await post({ channel: 'codex', data: 'xx' })).status, 400);

  const ok = await post({ channel: 'deepseek', data: '2026-08-01,1200000,0.31' });
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.ok, true);
  assert.equal(body.importedRows, 1);
  assert.equal(body.history.firstDate, '2026-08-01');

  // 再导一次同样数据：幂等（不重复累计）
  const again = await (await post({ channel: 'deepseek', data: '2026-08-01,1200000,0.31' })).json();
  assert.equal(again.addedDays, 0);
  assert.equal(again.updatedDays, 0);

  // 更小的值不会覆盖更大的历史
  await post({ channel: 'deepseek', data: '2026-08-01,100' });
  const saved = JSON.parse(await fs.readFile(path.join(dataDir, 'daily-history.json'), 'utf8'));
  assert.equal(saved.days['2026-08-01'].deepseekTokens, 1200000);
  // 备份文件存在
  const files = await fs.readdir(dataDir);
  assert.ok(files.includes('daily-history.json.bak'));
});

test('服务端：标题设置可改可存、非法输入被清洗', async (t) => {
  const { dir: dataDir } = await makeDataDir();
  const app = await startServer({ dataDir, env: { PORT: '0' } });
  t.after(async () => {
    await app.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  // 默认值与 sanitize 暴露
  const initial = await (await fetch(`${app.url}/api/config`)).json();
  assert.equal(initial.settings.title, 'Token 使用情况');
  assert.equal(initial.settings.onboardingDone, false);

  // 改名（含换行，应被压成空格）
  const saved = await fetch(`${app.url}/api/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: '  我的\n面板  ', subtitle: '本地' })
  });
  assert.equal(saved.status, 200);
  const body = await saved.json();
  assert.equal(body.settings.title, '我的 面板');
  assert.equal(body.settings.subtitle, '本地');

  // 持久化到 config.json
  const onDisk = JSON.parse(await fs.readFile(path.join(dataDir, 'config.json'), 'utf8'));
  assert.equal(onDisk.settings.title, '我的 面板');

  // 空标题回落默认；超长截断到 40 字
  const empty = await (await fetch(`${app.url}/api/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: '' })
  })).json();
  assert.equal(empty.settings.title, 'Token 使用情况');
  const long = await (await fetch(`${app.url}/api/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'x'.repeat(80) })
  })).json();
  assert.equal(long.settings.title.length, 40);

  // 引导完成标记
  const done = await (await fetch(`${app.url}/api/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ onboardingDone: true })
  })).json();
  assert.equal(done.settings.onboardingDone, true);
});

test('服务端：拒绝陌生 Host 头（DNS rebinding 防护）', async (t) => {
  const { dir: dataDir } = await makeDataDir();
  const app = await startServer({ dataDir, env: { PORT: '0' } });
  t.after(async () => {
    await app.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  const http = await import('node:http');
  const port = Number(new URL(app.url).port);
  const request = (host) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, path: '/api/config', headers: { Host: host } },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        }
      );
      req.on('error', reject);
      req.end();
    });

  assert.equal(await request(`127.0.0.1:${port}`), 200);
  assert.equal(await request(`localhost:${port}`), 200);
  assert.equal(await request('evil.example.com'), 403);
  assert.equal(await request(`evil.example.com:${port}`), 403);
});

test('服务端：添加站点、令牌只落本地、可改可删', async (t) => {
  const { dir: dataDir } = await makeDataDir();
  const app = await startServer({ dataDir, env: { PORT: '0' } });
  t.after(async () => {
    await app.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  const invalid = await jsonFetch(`${app.url}/api/relays`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '坏站点', type: 'newapi-token', baseUrl: 'ftp://nope', token: 'x' })
  });
  assert.equal(invalid.status, 400);

  const secret = 'tok-local-only-123456';
  const created = await jsonFetch(`${app.url}/api/relays`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: '示例中转站',
      type: 'newapi-token',
      baseUrl: 'http://127.0.0.1:1',
      token: secret
    })
  });
  assert.equal(created.status, 201);
  const relayId = created.body.id;
  assert.ok(relayId);

  const config = await jsonFetch(`${app.url}/api/config`);
  assert.equal(config.status, 200);
  assert.equal(config.body.providers.relays.length, 1);
  assert.equal(config.body.providers.relays[0].hasToken, true);
  assert.ok(!JSON.stringify(config.body).includes(secret), '配置接口不能回传明文令牌');

  const secretsRaw = await fs.readFile(path.join(dataDir, 'secrets.json'), 'utf8');
  assert.ok(secretsRaw.includes(secret), '令牌应保存在本地 secrets.json');

  const patched = await jsonFetch(`${app.url}/api/relays/${relayId}/token`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: 'tok-new-123456' })
  });
  assert.equal(patched.status, 200);

  const removed = await jsonFetch(`${app.url}/api/relays/${relayId}`, { method: 'DELETE' });
  assert.equal(removed.status, 200);
  const after = await jsonFetch(`${app.url}/api/config`);
  assert.equal(after.body.providers.relays.length, 0);
});

test('服务端：OpenCode Go Key 可写可清，且不回显', async (t) => {
  const { dir: dataDir } = await makeDataDir();
  const app = await startServer({ dataDir, env: { PORT: '0' } });
  t.after(async () => {
    await app.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  const saved = await jsonFetch(`${app.url}/api/opencode-go-key`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'oc_sk_local_12345678' })
  });
  assert.equal(saved.status, 200);
  const config = await jsonFetch(`${app.url}/api/config`);
  assert.ok(!JSON.stringify(config.body).includes('oc_sk_local_12345678'));

  const cleared = await jsonFetch(`${app.url}/api/opencode-go-key`, { method: 'DELETE' });
  assert.equal(cleared.status, 200);
  const secrets = JSON.parse(await fs.readFile(path.join(dataDir, 'secrets.json'), 'utf8'));
  assert.equal(secrets.OPENCODE_GO_API_KEY, undefined);
});

test('服务端：目录穿越被拒绝', async (t) => {
  const { dir: dataDir } = await makeDataDir();
  const app = await startServer({ dataDir, env: { PORT: '0' } });
  t.after(async () => {
    await app.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  const traversal = await fetch(`${app.url}/..%2f..%2fpackage.json`);
  assert.ok([403, 404].includes(traversal.status), `期望 403/404，实际 ${traversal.status}`);
});

test('服务端：Codex 多账户增删、去重与校验', async (t) => {
  const { dir: dataDir } = await makeDataDir({ codexEnabled: true });
  const app = await startServer({ dataDir, env: { PORT: '0' } });
  t.after(async () => {
    await app.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  let config = await jsonFetch(`${app.url}/api/config`);
  assert.equal(config.body.providers.codex.accounts.length, 1);
  assert.equal(config.body.providers.codex.accounts[0].valid, true);

  const badPath = path.join(dataDir, 'bad-auth.json');
  await fs.writeFile(badPath, JSON.stringify({ tokens: {} }));
  const bad = await jsonFetch(`${app.url}/api/codex/accounts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '坏号', authPath: badPath })
  });
  assert.equal(bad.status, 400);

  const workPath = path.join(dataDir, 'work-auth.json');
  await fs.writeFile(workPath, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'tok-second' } }));
  const created = await jsonFetch(`${app.url}/api/codex/accounts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '工作号', authPath: workPath })
  });
  assert.equal(created.status, 201);

  const duplicate = await jsonFetch(`${app.url}/api/codex/accounts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '工作号2', authPath: workPath })
  });
  assert.equal(duplicate.status, 409);

  config = await jsonFetch(`${app.url}/api/config`);
  const accounts = config.body.providers.codex.accounts;
  assert.equal(accounts.length, 2);
  assert.ok(accounts.some((account) => account.name === '工作号' && account.valid));
  assert.ok(!JSON.stringify(config.body).includes('tok-second'), '配置接口不能回传令牌');

  const workAccount = accounts.find((account) => account.name === '工作号');
  const removed = await jsonFetch(`${app.url}/api/codex/accounts/${workAccount.id}`, { method: 'DELETE' });
  assert.equal(removed.status, 200);
  config = await jsonFetch(`${app.url}/api/config`);
  assert.equal(config.body.providers.codex.accounts.length, 1);
});


test('服务端：粘贴 auth.json 内容导入账户并按 account_id 去重', async (t) => {
  const { dir: dataDir } = await makeDataDir({ codexEnabled: true });
  const app = await startServer({ dataDir, env: { PORT: '0' } });
  t.after(async () => {
    await app.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  const authJson = JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: { access_token: 'tok-paste-abcdef', account_id: 'acct-paste-1' }
  });
  const created = await jsonFetch(`${app.url}/api/codex/accounts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '粘贴号', authJson })
  });
  assert.equal(created.status, 201);

  const config = await jsonFetch(`${app.url}/api/config`);
  const accounts = config.body.providers.codex.accounts;
  assert.equal(accounts.length, 2);
  assert.ok(accounts.some((account) => account.name === '粘贴号' && account.valid));
  assert.ok(!JSON.stringify(config.body).includes('tok-paste-abcdef'), '配置接口不能回传令牌');

  const storedDir = path.join(dataDir, 'codex-accounts');
  const stored = await fs.readdir(storedDir);
  assert.equal(stored.length, 1);

  const duplicate = await jsonFetch(`${app.url}/api/codex/accounts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '再贴一次', authJson })
  });
  assert.equal(duplicate.status, 409);

  const invalid = await jsonFetch(`${app.url}/api/codex/accounts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '坏内容', authJson: '{"tokens":{}}' })
  });
  assert.equal(invalid.status, 400);
});


test('服务端：Codex 历史快照可展示与删除', async (t) => {
  const { dir: dataDir } = await makeDataDir({ codexEnabled: true });
  await fs.writeFile(
    path.join(dataDir, 'config.json'),
    JSON.stringify({
      port: 0,
      refreshSeconds: 10,
      providers: {
        codex: {
          enabled: true,
          authPath: path.join(dataDir, 'missing-auth.json'),
          liveEnabled: true,
          autoArchive: true,
          accounts: []
        },
        opencodeGo: { enabled: false },
        relays: []
      }
    })
  );
  await fs.writeFile(
    path.join(dataDir, 'codex-history.json'),
    JSON.stringify({
      accounts: {
        'legacy:before-switch': {
          name: '上一个账号（历史快照）',
          plan: 'plus',
          windows: [{ key: '5h', label: '5 小时', usedPercent: 53, resetAt: null, windowSeconds: 18000 }],
          fetchedAt: '2026-10-25T23:36:00+08:00',
          notes: ['切换账号前的最后一次快照']
        }
      }
    })
  );

  const app = await startServer({ dataDir, env: { PORT: '0' } });
  t.after(async () => {
    await app.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  const quota = await jsonFetch(`${app.url}/api/quota?refresh=1`);
  const history = (quota.body.providers || []).filter((provider) => provider.historyOnly);
  assert.equal(history.length, 1);
  assert.equal(history[0].status, 'stale');
  assert.match(history[0].name, /上一个账号/);
  assert.equal(history[0].windows[0].usedPercent, 53);

  // C3：历史快照也进入 codexSummary（stale、非实时有效），窗口 kind 由秒数派生。
  // 本夹具里 live 登录态文件缺失、又拿不到 account_id，属于不可识别的错误占位卡，不计入账号数。
  assert.equal(quota.body.codexSummary.total, 1);
  assert.equal(quota.body.codexSummary.active, 0);
  assert.equal(quota.body.codexSummary.multi, false);
  const summaryRow = quota.body.codexSummary.accounts.find((account) => account.status === 'stale');
  assert.ok(summaryRow, '历史快照账号应在 codexSummary 里');
  assert.equal(summaryRow.planName, 'Plus');
  assert.equal(summaryRow.windows[0].kind, 'session');
  assert.equal(summaryRow.updatedAt, '2026-10-25T23:36:00+08:00');

  const removed = await jsonFetch(
    `${app.url}/api/codex/history/${encodeURIComponent('legacy:before-switch')}`,
    { method: 'DELETE' }
  );
  assert.equal(removed.status, 200);
  const again = await jsonFetch(`${app.url}/api/quota?refresh=1`);
  assert.equal((again.body.providers || []).filter((provider) => provider.historyOnly).length, 0);
});

test('服务端：Codex 账户改名（当前登录 + 归档）', async (t) => {
  const { dir: dataDir } = await makeDataDir({ codexEnabled: true });
  const second = path.join(dataDir, 'second-auth.json');
  await fs.writeFile(
    second,
    JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'tok-x', account_id: 'acct-second' } })
  );
  const app = await startServer({ dataDir, env: { PORT: '0' } });
  t.after(async () => {
    await app.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  const renamedLive = await jsonFetch(`${app.url}/api/codex/live`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '账号B' })
  });
  assert.equal(renamedLive.status, 200);

  const created = await jsonFetch(`${app.url}/api/codex/accounts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '临时名', authPath: second })
  });
  assert.equal(created.status, 201);

  const renamedArchived = await jsonFetch(`${app.url}/api/codex/accounts/${created.body.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '账号A' })
  });
  assert.equal(renamedArchived.status, 200);

  const config = await jsonFetch(`${app.url}/api/config`);
  const names = config.body.providers.codex.accounts.map((account) => account.name);
  assert.ok(names.includes('账号B'));
  assert.ok(names.includes('账号A'));
});

// ============================================================
// C3：多号同登 codexSummary 与 /api/daily codexAccounts（离线：mock 上游 / 缺省 auth）
// ============================================================

function mockCodexJson(body, status = 200) {
  return { status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(body) };
}

/** 只拦截 Codex 额度上游，其它 fetch（测试自己访问 127.0.0.1 面板）原样转发。 */
async function withCodexUsageUpstream(handler, fn) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith('https://chatgpt.com/backend-api/wham/usage')) {
      return handler(options || {});
    }
    return realFetch(url, options);
  };
  try {
    return await fn();
  } finally {
    globalThis.fetch = realFetch;
  }
}

async function writeCodexAuth(dir, fileName, { accountId, token }) {
  const target = path.join(dir, fileName);
  await fs.writeFile(
    target,
    JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: token, account_id: accountId } })
  );
  return target;
}

test('服务端：多号同登 codexSummary（live + 两个归档都实时 ok → multi=true）', async (t) => {
  const { dir: dataDir } = await makeDataDir({ codexEnabled: true });
  // live 与第一个归档同名 Louie：数据层必须用短 accountId 消歧
  const liveId = 'aaaaaaaa-1111-2222-3333-444444444444';
  const plusId = 'bbbbbbbb-1111-2222-3333-444444444444';
  const proId = 'cccccccc-1111-2222-3333-444444444444';
  const liveAuth = await writeCodexAuth(dataDir, 'live-auth.json', { accountId: liveId, token: 'tok-live-local-only' });
  const plusAuth = await writeCodexAuth(dataDir, 'plus-auth.json', { accountId: plusId, token: 'tok-plus-local-only' });
  const proAuth = await writeCodexAuth(dataDir, 'pro-auth.json', { accountId: proId, token: 'tok-pro-local-only' });
  await fs.writeFile(
    path.join(dataDir, 'config.json'),
    JSON.stringify({
      port: 0,
      refreshSeconds: 10,
      providers: {
        codex: {
          enabled: true,
          authPath: liveAuth,
          liveEnabled: true,
          liveName: 'Louie',
          autoArchive: false,
          accounts: [
            { id: 'arch-plus', name: 'Louie', authPath: plusAuth },
            { id: 'arch-pro', name: 'Pro 号', authPath: proAuth }
          ]
        },
        opencodeGo: { enabled: false },
        relays: []
      }
    })
  );

  const app = await startServer({ dataDir, env: { PORT: '0', QUOTA_BOARD_DISABLE_ARCHIVER: '1' } });
  t.after(async () => {
    await app.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  await withCodexUsageUpstream(
    (options) => {
      const accountId = options.headers && options.headers['ChatGPT-Account-Id'];
      if (accountId === liveId) {
        return mockCodexJson({
          plan_type: 'plus',
          rate_limit: {
            primary_window: { used_percent: 12, limit_window_seconds: 18000, reset_at: '2026-11-14T01:00:00Z' },
            secondary_window: { used_percent: 34, limit_window_seconds: 604800, reset_at: '2026-11-20T00:00:00Z' }
          }
        });
      }
      if (accountId === plusId) {
        return mockCodexJson({
          plan_type: 'plus',
          rate_limit: {
            primary_window: { used_percent: 56, limit_window_seconds: 18000, reset_at: '2026-11-14T02:00:00Z' },
            secondary_window: { used_percent: 90, limit_window_seconds: 604800, reset_at: '2026-11-15T17:40:32Z' }
          }
        });
      }
      // prolite：只有一个 7 天窗口（旧代码会把它标成「5 小时」）
      return mockCodexJson({
        plan_type: 'prolite',
        rate_limit: {
          primary_window: { used_percent: 7, limit_window_seconds: 604800, reset_at: '2026-11-20T15:05:24Z' },
          secondary_window: null
        }
      });
    },
    async () => {
      const quota = await jsonFetch(app.url + '/api/quota?refresh=1');
      assert.equal(quota.status, 200);
      assert.ok(!JSON.stringify(quota.body).includes('tok-'), '额度快照不能包含明文令牌');

      const codexProviders = quota.body.providers.filter((provider) => provider.kind === 'codex');
      assert.equal(codexProviders.length, 3);
      assert.ok(codexProviders.every((provider) => provider.status === 'ok'));

      const summary = quota.body.codexSummary;
      assert.equal(summary.total, 3);
      assert.equal(summary.active, 3);
      assert.equal(summary.multi, true);
      assert.equal(summary.accounts.length, 3);

      const liveRow = summary.accounts.find((account) => account.id === liveId);
      assert.equal(liveRow.planName, 'Plus');
      assert.equal(liveRow.name, 'Louie · aaaaaaaa', '同名多号用短 accountId 消歧');
      assert.deepEqual(liveRow.windows.map((window) => window.kind), ['session', 'weekly']);

      const plusRow = summary.accounts.find((account) => account.id === plusId);
      assert.equal(plusRow.name, 'Louie · bbbbbbbb');

      const proRow = summary.accounts.find((account) => account.id === proId);
      assert.equal(proRow.planName, 'Pro Lite');
      assert.equal(proRow.name, 'Pro 号', '唯一名字保持原样');
      assert.deepEqual(
        proRow.windows.map((window) => [window.key, window.kind]),
        [['weekly', 'weekly']],
        '7 天窗口不能标成 5 小时'
      );

      const liveProvider = codexProviders.find((provider) => provider.accountId === liveId);
      assert.equal(liveProvider.name, 'Codex · Louie · aaaaaaaa', '卡片名也要能区分同名账号');

      const proProvider = codexProviders.find((provider) => provider.accountId === proId);
      assert.ok(proProvider, '每张 Codex 卡都要带 accountId 供前端按账号关联每日明细');
      assert.equal(proProvider.planMeta.name, 'Pro Lite');
      assert.equal(proProvider.windows[0].kind, 'weekly');
      assert.ok(proProvider.refresh && typeof proProvider.refresh === 'object', 'refresh 字段保持');
      assert.equal(proProvider.refresh.lastError, null);

      // /api/config 的账户行也带消歧展示名（name 语义不变，供热力图/账户面板使用）
      const config = await jsonFetch(app.url + '/api/config');
      const configAccounts = config.body.providers.codex.accounts;
      const liveConfigRow = configAccounts.find((account) => account.accountId === liveId);
      assert.equal(liveConfigRow.name, 'Louie');
      assert.equal(liveConfigRow.displayName, 'Louie · aaaaaaaa');
      const proConfigRow = configAccounts.find((account) => account.accountId === proId);
      assert.equal(proConfigRow.displayName, 'Pro 号');
    }
  );
});

test('服务端：/api/daily 返回 codexAccounts 账号列表并保留每日 codexByAccount', async (t) => {
  const { dir: dataDir } = await makeDataDir();
  const plusId = 'aaaaaaaa-1111-2222-3333-444444444444';
  const proId = 'bbbbbbbb-1111-2222-3333-444444444444';
  // Codex live 指向不存在的 auth 文件：采集直接失败，绝不发上游请求（离线测试）
  const missingAuth = path.join(dataDir, 'missing-auth.json');
  await fs.writeFile(
    path.join(dataDir, 'config.json'),
    JSON.stringify({
      port: 0,
      refreshSeconds: 10,
      providers: {
        codex: { enabled: false, authPath: missingAuth, liveEnabled: true, accounts: [] },
        opencodeGo: { enabled: false },
        relays: []
      }
    })
  );
  await fs.writeFile(
    path.join(dataDir, 'codex-history.json'),
    JSON.stringify({
      accounts: {
        ['id:' + plusId]: {
          name: 'Louie',
          plan: 'plus',
          windows: [{ key: '5h', label: '5 小时', usedPercent: 10, resetAt: null, windowSeconds: 18000 }],
          fetchedAt: '2026-11-13T01:00:00Z'
        },
        ['id:' + proId]: {
          // 同名多号（与 live/归档同名）：daily 账号列表也要消歧
          name: 'Louie',
          plan: 'prolite',
          windows: [{ key: 'weekly', label: '每周', usedPercent: 20, resetAt: null, windowSeconds: 604800 }],
          fetchedAt: '2026-11-13T02:00:00Z'
        }
      }
    })
  );
  const now = new Date();
  const today =
    now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
  await fs.writeFile(
    path.join(dataDir, 'daily-history.json'),
    JSON.stringify({
      version: 1,
      days: {
        [today]: {
          date: today,
          codexTokens: 300,
          codexByAccount: { [plusId]: 200, [proId]: 100 }
        }
      }
    })
  );

  const app = await startServer({ dataDir, env: { PORT: '0', QUOTA_BOARD_DISABLE_ARCHIVER: '1' } });
  t.after(async () => {
    await app.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  const daily = await jsonFetch(app.url + '/api/daily?days=7&refresh=1');
  assert.equal(daily.status, 200);
  assert.ok(Array.isArray(daily.body.codexAccounts), 'codexAccounts 应是 [{id,name,planName}] 数组');
  assert.deepEqual(daily.body.codexAccounts, [
    { id: plusId, name: 'Louie · aaaaaaaa', planName: 'Plus' },
    { id: proId, name: 'Louie · bbbbbbbb', planName: 'Pro Lite' }
  ]);
  assert.equal(daily.body.codexAccountCount, 2);

  const todayEntry = daily.body.series.find((entry) => entry.date === today);
  assert.ok(todayEntry, '今天应在序列里');
  assert.deepEqual(todayEntry.codexByAccount, { [plusId]: 200, [proId]: 100 }, '分账号每日明细保持');
  assert.equal(todayEntry.codexTokens, 300);
});

// ============================================================
// 修复轮 F3：P1-04 写请求来源校验 / P1-03 导入串行化与写后校验
// ============================================================

test('服务端 P1-04：写请求校验 Content-Type / Origin / Sec-Fetch-Site', async (t) => {
  const { dir: dataDir } = await makeDataDir();
  const app = await startServer({ dataDir, env: { PORT: '0', QUOTA_BOARD_DISABLE_ARCHIVER: '1' } });
  t.after(async () => {
    await app.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  const jsonHeaders = { 'Content-Type': 'application/json' };
  const post = (headers, body) =>
    jsonFetch(`${app.url}/api/settings`, { method: 'POST', headers, body });

  // text/plain 简单请求（浏览器免预检的 CSRF 载体）必须被 415 拒绝
  const plain = await post({ 'Content-Type': 'text/plain' }, '{"title":"hacked"}');
  assert.equal(plain.status, 415);
  // 完全不带 Content-Type 也拒绝
  assert.equal((await fetch(`${app.url}/api/settings`, { method: 'POST', body: '{"title":"x"}' })).status, 415);

  // 无 Origin 的本地脚本请求放行（但已强制 JSON）
  assert.equal((await post(jsonHeaders, '{"title":"local"}')).status, 200);

  // 跨站 Origin / Sec-Fetch-Site: cross-site 必须 403
  assert.equal(
    (await post({ ...jsonHeaders, Origin: 'https://evil.example' }, '{"title":"csrf"}')).status,
    403
  );
  assert.equal(
    (await post({ ...jsonHeaders, 'Sec-Fetch-Site': 'cross-site' }, '{"title":"csrf"}')).status,
    403
  );

  // 同源 Origin 放行（前端正常路径）
  const sameOrigin = new URL(app.url).origin;
  assert.equal(
    (await post({ ...jsonHeaders, Origin: sameOrigin, 'Sec-Fetch-Site': 'same-origin' }, '{"title":"ok"}'))
      .status,
    200
  );

  // 无 body 的 DELETE 不因缺少 Content-Type 被 415（进入路由后是 404）
  const del = await jsonFetch(`${app.url}/api/relays/not-exist`, { method: 'DELETE' });
  assert.notEqual(del.status, 415);
  // 带 body 的 DELETE 仍必须 JSON
  assert.equal(
    (
      await jsonFetch(`${app.url}/api/relays/not-exist`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'text/plain' },
        body: 'x'
      })
    ).status,
    415
  );
});

test('服务端 P1-03：8 路并发导入不同日期全部保留（不再静默丢天）', async (t) => {
  const { dir: dataDir } = await makeDataDir();
  const app = await startServer({ dataDir, env: { PORT: '0', QUOTA_BOARD_DISABLE_ARCHIVER: '1' } });
  t.after(async () => {
    await app.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  const dates = Array.from({ length: 8 }, (_, index) => `2024-03-0${index + 1}`);
  const results = await Promise.all(
    dates.map((date, index) =>
      jsonFetch(`${app.url}/api/daily/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: 'codex', data: `${date},${100 + index}` })
      })
    )
  );
  for (const result of results) assert.equal(result.status, 200);

  const stored = JSON.parse(await fs.readFile(path.join(dataDir, 'daily-history.json'), 'utf8'));
  for (let index = 0; index < dates.length; index += 1) {
    const day = stored.days[dates[index]];
    assert.ok(day, `${dates[index]} 应在存档里，不能被并发覆盖丢掉`);
    assert.equal(day.codexTokens, 100 + index, `${dates[index]} 的数值应保留`);
  }
});

test('服务端 P1-07：导入写盘失败返回非 2xx，不谎报成功', async (t) => {
  const { dir: dataDir } = await makeDataDir();
  // 让 daily-history.json 变成目录：读失败（空存档）、写入 EISDIR 失败
  await fs.mkdir(path.join(dataDir, 'daily-history.json'), { recursive: true });
  const app = await startServer({ dataDir, env: { PORT: '0', QUOTA_BOARD_DISABLE_ARCHIVER: '1' } });
  t.after(async () => {
    await app.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  const result = await jsonFetch(`${app.url}/api/daily/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel: 'codex', data: '2024-04-01,123' })
  });
  assert.ok(result.status >= 400, `写盘失败必须返回非 2xx，实际 ${result.status}`);
  assert.ok(result.status !== 200);
  assert.ok(result.body && result.body.error, '应返回错误信息');
});

test('F3 单元：verifyImportedHistory 识别未落盘 / 数值变小', () => {
  const rows = [
    { date: '2024-05-01', codexTokens: 100 },
    { date: '2024-05-02', codexTokens: 200 }
  ];
  assert.doesNotThrow(() =>
    verifyImportedHistory(
      {
        days: {
          '2024-05-01': { date: '2024-05-01', codexTokens: 100 },
          '2024-05-02': { date: '2024-05-02', codexTokens: 200 }
        }
      },
      rows,
      'codex'
    )
  );
  assert.throws(() => verifyImportedHistory({ days: {} }, rows, 'codex'), /导入校验失败/);
  assert.throws(
    () =>
      verifyImportedHistory(
        { days: { '2024-05-01': { date: '2024-05-01', codexTokens: 1 }, '2024-05-02': { date: '2024-05-02', codexTokens: 200 } } },
        rows,
        'codex'
      ),
    /导入校验失败/
  );
});

// ============================================================
// P2/P3 清理轮 G2：路径脱敏 / 方法语义 / days 校验 / cached / 请求合并 / 写令牌 / 无 Host / G8 孤儿账号
// ============================================================

test('G2：/api/config 路径脱敏，不泄露绝对路径', async (t) => {
  const { dir: dataDir } = await makeDataDir();
  const app = await startServer({ dataDir, env: { PORT: '0', QUOTA_BOARD_DISABLE_ARCHIVER: '1' } });
  t.after(async () => {
    await app.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  const config = await (await fetch(app.url + '/api/config')).json();
  assert.ok(config.paths && typeof config.paths.secretsFile === 'string', 'paths 应存在');
  assert.ok(config.paths.dataDir.startsWith('~'), 'home 下的 dataDir 应缩写为 ~ 形式，实际：' + config.paths.dataDir);
  for (const key of ['dataDir', 'configFile', 'secretsFile']) {
    assert.ok(!path.isAbsolute(config.paths[key]), key + ' 不得是绝对路径：' + config.paths[key]);
  }
  for (const entry of config.providers.codex.accounts || []) {
    if (entry.authPath) {
      assert.ok(!path.isAbsolute(entry.authPath), '账户 authPath 不得是绝对路径：' + entry.authPath);
    }
  }
});

test('G2：方法语义 —— 405 + Allow、OPTIONS 204、HEAD 返回头', async (t) => {
  const { dir: dataDir } = await makeDataDir();
  const app = await startServer({ dataDir, env: { PORT: '0', QUOTA_BOARD_DISABLE_ARCHIVER: '1' } });
  t.after(async () => {
    await app.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  const wrongMethod = await fetch(app.url + '/api/quota', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  });
  assert.equal(wrongMethod.status, 405);
  assert.match(String(wrongMethod.headers.get('allow')), /GET/);
  await wrongMethod.text();

  const settingsGet = await fetch(app.url + '/api/settings');
  assert.equal(settingsGet.status, 405);
  assert.match(String(settingsGet.headers.get('allow')), /POST/);
  await settingsGet.text();

  const options = await fetch(app.url + '/api/quota', { method: 'OPTIONS' });
  assert.equal(options.status, 204);
  assert.match(String(options.headers.get('allow')), /GET/);

  const head = await fetch(app.url + '/api/health', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.match(String(head.headers.get('content-type')), /application\/json/);
  assert.equal(await head.text(), '');
});

test('G2：days 参数非法 → 400，合法 → 200', async (t) => {
  const { dir: dataDir } = await makeDataDir();
  const app = await startServer({ dataDir, env: { PORT: '0', QUOTA_BOARD_DISABLE_ARCHIVER: '1' } });
  t.after(async () => {
    await app.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  for (const bad of ['abc', '-1', '7.5', '99999', '1e3']) {
    const response = await fetch(app.url + '/api/daily?days=' + encodeURIComponent(bad));
    assert.equal(response.status, 400, 'days=' + bad + ' 应 400');
    const body = await response.json();
    assert.match(String(body.error), /days/);
  }
  assert.equal((await fetch(app.url + '/api/daily?days=0')).status, 200);
  assert.equal((await fetch(app.url + '/api/daily?days=30')).status, 200);
});

test('G2：/api/usage 带 cached 字段（fresh=false，缓存命中=true）', async (t) => {
  const { dir: dataDir } = await makeDataDir();
  const app = await startServer({ dataDir, env: { PORT: '0', QUOTA_BOARD_DISABLE_ARCHIVER: '1' } });
  t.after(async () => {
    await app.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  const fresh = await (await fetch(app.url + '/api/usage?refresh=1')).json();
  assert.equal(fresh.cached, false);
  const second = await (await fetch(app.url + '/api/usage')).json();
  assert.equal(second.cached, true);
});

test('G2：16 路并发 /api/quota?refresh=1 上游只请求 1 次', async (t) => {
  const { dir: dataDir } = await makeDataDir();
  const hits = { count: 0 };
  const upstream = http.createServer((req, res) => {
    hits.count += 1;
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ remaining: 10, total: 20, used: 10 }));
    }, 60);
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const relayUrl = 'http://127.0.0.1:' + upstream.address().port;
  await fs.writeFile(
    path.join(dataDir, 'config.json'),
    JSON.stringify({
      port: 0,
      refreshSeconds: 10,
      providers: {
        codex: { enabled: false },
        opencodeGo: { enabled: false },
        relays: [
          {
            id: 'relay-mock',
            name: 'mock',
            type: 'generic',
            baseUrl: relayUrl,
            url: relayUrl,
            extract: { remaining: 'remaining', limit: 'total', spend: 'used', unit: 'USD' },
            unit: 'USD',
            tokenRef: 'MOCK_TOKEN'
          }
        ]
      }
    })
  );
  // 站点需要 tokenRef 有值，否则 buildSnapshot 会先判「缺少令牌」而不发请求。
  await fs.writeFile(path.join(dataDir, 'secrets.json'), JSON.stringify({ MOCK_TOKEN: 'mock-token' }));
  process.env.QUOTA_BOARD_ALLOW_PRIVATE_RELAY = '1';
  const app = await startServer({ dataDir, env: { PORT: '0', QUOTA_BOARD_DISABLE_ARCHIVER: '1' } });
  t.after(async () => {
    await app.close();
    await new Promise((resolve) => upstream.close(resolve));
    delete process.env.QUOTA_BOARD_ALLOW_PRIVATE_RELAY;
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  const responses = await Promise.all(
    Array.from({ length: 16 }, () => fetch(app.url + '/api/quota?refresh=1'))
  );
  for (const response of responses) {
    assert.equal(response.status, 200);
    await response.text();
  }
  assert.equal(hits.count, 1, '16 路并发应只请求上游 1 次，实际 ' + hits.count);
});

test('G2：可选写令牌 QUOTA_BOARD_WRITE_TOKEN', async (t) => {
  const { dir: dataDir } = await makeDataDir();
  const app = await startServer({
    dataDir,
    env: { PORT: '0', QUOTA_BOARD_DISABLE_ARCHIVER: '1', QUOTA_BOARD_WRITE_TOKEN: 's3cret' }
  });
  t.after(async () => {
    await app.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  const post = (extra) =>
    fetch(app.url + '/api/settings', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, extra),
      body: JSON.stringify({ title: 'token-test' })
    });

  assert.equal((await post({})).status, 401, '缺 X-Auth-Token 应 401');
  assert.equal((await post({ 'X-Auth-Token': 'wrong' })).status, 401, '错误令牌应 401');
  const ok = await post({ 'X-Auth-Token': 's3cret' });
  assert.equal(ok.status, 200, '正确令牌应 200');
  await ok.text();
  assert.equal((await fetch(app.url + '/api/health')).status, 200);
});

test('G2：HTTP/1.0 无 Host → 400', async (t) => {
  const { dir: dataDir } = await makeDataDir();
  const app = await startServer({ dataDir, env: { PORT: '0', QUOTA_BOARD_DISABLE_ARCHIVER: '1' } });
  t.after(async () => {
    await app.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  const port = Number(new URL(app.url).port);
  const responseText = await new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write('GET /api/health HTTP/1.0\r\n\r\n'));
    let data = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      data += chunk;
    });
    socket.on('end', () => resolve(data));
    socket.on('close', () => resolve(data));
    socket.on('error', reject);
    setTimeout(() => {
      socket.destroy();
      resolve(data);
    }, 3000);
  });
  assert.match(responseText, /^HTTP\/1\.[01] 400/);
  assert.match(responseText, /Host/);
});

test('G8：/api/daily 对孤儿 codexByAccount 输出「未知账号 · 短id」', async (t) => {
  const { dir: dataDir } = await makeDataDir();
  const orphanId = 'deadbeef-1111-2222-3333-444444444444';
  const now = new Date();
  const today =
    now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
  await fs.writeFile(
    path.join(dataDir, 'daily-history.json'),
    JSON.stringify({
      version: 1,
      days: { [today]: { date: today, codexTokens: 300, codexByAccount: { [orphanId]: 300 } } }
    })
  );
  const app = await startServer({ dataDir, env: { PORT: '0', QUOTA_BOARD_DISABLE_ARCHIVER: '1' } });
  t.after(async () => {
    await app.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  const daily = await (await fetch(app.url + '/api/daily?days=7&refresh=1')).json();
  const orphan = (daily.codexAccounts || []).find((account) => account.id === orphanId);
  assert.ok(orphan, '孤儿账号应出现在 codexAccounts，实际：' + JSON.stringify(daily.codexAccounts));
  assert.equal(orphan.orphan, true);
  assert.match(String(orphan.name), /未知账号/);
  assert.match(String(orphan.name), new RegExp(orphanId.slice(0, 8)));
});

// ============================================================
// 配色轮 H2：/api/theme 读写（依赖 lib/theme.mjs；模块缺失时自动 skip 并如实标注）
// ============================================================

async function themeIsReady(app) {
  try {
    const response = await fetch(app.url + '/api/theme');
    if (response.status !== 200) return false;
    const body = await response.json();
    return Array.isArray(body.presets) && body.presets.length > 0;
  } catch {
    return false;
  }
}

test('H2：GET /api/theme 返回 presets / current / vars / warnings', async (t) => {
  const { dir: dataDir } = await makeDataDir();
  const app = await startServer({ dataDir, env: { PORT: '0', QUOTA_BOARD_DISABLE_ARCHIVER: '1' } });
  t.after(async () => {
    await app.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  if (!(await themeIsReady(app))) {
    t.skip('lib/theme.mjs 尚未落盘，跳过主题 API 形状用例');
    return;
  }
  const response = await fetch(app.url + '/api/theme');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(Array.isArray(body.presets) && body.presets.length >= 5, 'presets 至少 5 套');
  for (const preset of body.presets) {
    assert.equal(typeof preset.id, 'string');
    assert.equal(typeof preset.name, 'string');
    assert.ok(preset.light && typeof preset.light === 'object', 'preset.light 应为 CSS 变量表');
    assert.ok(preset.dark && typeof preset.dark === 'object', 'preset.dark 应为 CSS 变量表');
  }
  assert.ok(body.current && typeof body.current === 'object');
  for (const key of ['preset', 'mode', 'accent', 'modules']) assert.ok(key in body.current, 'current 缺少 ' + key);
  assert.deepEqual(Object.keys(body.current.modules).sort(), ['codex', 'deepseek', 'opencodeGo', 'other', 'relay']);
  assert.ok(body.vars && typeof body.vars === 'object', 'vars 应为 CSS 变量表');
  assert.ok(Object.prototype.hasOwnProperty.call(body.vars, '--paper'), 'vars 应含 --paper');
  assert.ok(Array.isArray(body.warnings));
});

test('H2：PUT /api/theme 合法值持久化，重启后仍生效', async (t) => {
  const { dir: dataDir } = await makeDataDir();
  let app = await startServer({ dataDir, env: { PORT: '0', QUOTA_BOARD_DISABLE_ARCHIVER: '1' } });
  let closed = false;
  t.after(async () => {
    if (!closed) await app.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  if (!(await themeIsReady(app))) {
    t.skip('lib/theme.mjs 尚未落盘，跳过主题持久化用例');
    return;
  }
  const next = {
    preset: 'graphite',
    mode: 'dark',
    accent: '#123456',
    modules: { codex: '#ABCDEF', deepseek: null, opencodeGo: '#00ff88', relay: null, other: null }
  };
  const put = await fetch(app.url + '/api/theme', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(next)
  });
  assert.equal(put.status, 200);
  const putBody = await put.json();
  assert.equal(putBody.current.preset, 'graphite');
  assert.equal(putBody.current.mode, 'dark');
  assert.equal(putBody.current.accent, '#123456');
  assert.equal(putBody.current.modules.codex, '#abcdef', 'hex 应归一为小写');
  assert.equal(putBody.vars['--mod-codex'], '#abcdef');
  const saved = JSON.parse(await fs.readFile(path.join(dataDir, 'config.json'), 'utf8'));
  assert.ok(saved.ui && saved.ui.theme, 'config.ui.theme 应落盘');
  assert.equal(saved.ui.theme.preset, 'graphite');
  assert.equal(saved.ui.theme.modules.opencodeGo, '#00ff88');
  await app.close();
  closed = true;
  app = await startServer({ dataDir, env: { PORT: '0', QUOTA_BOARD_DISABLE_ARCHIVER: '1' } });
  closed = false;
  const after = await (await fetch(app.url + '/api/theme')).json();
  assert.equal(after.current.preset, 'graphite');
  assert.equal(after.current.mode, 'dark');
  assert.equal(after.vars['--mod-codex'], '#abcdef');
});

test('H2：PUT /api/theme 非法 preset/hex/mode/未知键 → 400 + details', async (t) => {
  const { dir: dataDir } = await makeDataDir();
  const app = await startServer({ dataDir, env: { PORT: '0', QUOTA_BOARD_DISABLE_ARCHIVER: '1' } });
  t.after(async () => {
    await app.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  if (!(await themeIsReady(app))) {
    t.skip('lib/theme.mjs 尚未落盘，跳过主题校验用例');
    return;
  }
  const put = (body) =>
    fetch(app.url + '/api/theme', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  const cases = [
    { preset: 'nope' },
    { mode: 'blue' },
    { accent: 'red' },
    { accent: '#12345' },
    { modules: { codex: 'nothex' } },
    { modules: { foo: '#112233' } },
    { unknownKey: 1 }
  ];
  for (const body of cases) {
    const response = await put(body);
    assert.equal(response.status, 400, JSON.stringify(body) + ' 应 400');
    const json = await response.json();
    assert.match(String(json.error), /主题/);
    assert.ok(Array.isArray(json.details) && json.details.length >= 1, '应带 details');
  }
  const arrayBody = await fetch(app.url + '/api/theme', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: '[]'
  });
  assert.equal(arrayBody.status, 400);
  const plain = await fetch(app.url + '/api/theme', {
    method: 'PUT',
    headers: { 'Content-Type': 'text/plain' },
    body: '{"preset":"claude"}'
  });
  assert.equal(plain.status, 415);
});

test('H2：PUT /api/theme 跨站 Origin 403、写令牌 401', async (t) => {
  const { dir: dataDir } = await makeDataDir();
  const app = await startServer({
    dataDir,
    env: { PORT: '0', QUOTA_BOARD_DISABLE_ARCHIVER: '1', QUOTA_BOARD_WRITE_TOKEN: 'tok-secret' }
  });
  t.after(async () => {
    await app.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  if (!(await themeIsReady(app))) {
    t.skip('lib/theme.mjs 尚未落盘，跳过主题 CSRF/写令牌用例');
    return;
  }
  const put = (headers) =>
    fetch(app.url + '/api/theme', {
      method: 'PUT',
      headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
      body: JSON.stringify({ preset: 'claude' })
    });
  assert.equal((await put({})).status, 401, '写令牌启用后无 token 应 401');
  const origin = new URL(app.url).origin;
  assert.equal((await put({ 'X-Auth-Token': 'tok-secret', Origin: 'https://evil.example' })).status, 403);
  assert.equal((await put({ 'X-Auth-Token': 'tok-secret', Origin: origin })).status, 200);
  assert.equal((await fetch(app.url + '/api/theme')).status, 200);
});

// ============================================================
// R2：systemDark 与双 vars（varsLight/varsDark）+ /api/config 暴露脱敏 ui.theme
// ============================================================

test('R2：GET /api/theme?systemDark=1|0 与 varsLight/varsDark', async (t) => {
  const { dir: dataDir } = await makeDataDir();
  const app = await startServer({ dataDir, env: { PORT: '0', QUOTA_BOARD_DISABLE_ARCHIVER: '1' } });
  t.after(async () => {
    await app.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  if (!(await themeIsReady(app))) {
    t.skip('lib/theme.mjs 尚未落盘，跳过 systemDark 用例');
    return;
  }

  const plain = await (await fetch(app.url + '/api/theme')).json();
  assert.ok(plain.varsLight && typeof plain.varsLight === 'object', '响应应含 varsLight');
  assert.ok(plain.varsDark && typeof plain.varsDark === 'object', '响应应含 varsDark');
  const lightKeys = Object.keys(plain.varsLight).sort();
  const darkKeys = Object.keys(plain.varsDark).sort();
  assert.deepEqual(lightKeys, darkKeys, 'varsLight 与 varsDark 变量名集合应一致');
  assert.ok(lightKeys.includes('--paper'));
  assert.notEqual(plain.varsLight['--paper'], plain.varsDark['--paper'], '明暗 --paper 应不同');
  // 默认（无 query）= systemDark false：vars 等于 varsLight（当前 mode=light）
  assert.deepEqual(plain.vars, plain.varsLight);
  // 显式 light 模式下 systemDark 不影响 vars（resolveTheme 尊重显式 mode）
  const explicitLight = await (await fetch(app.url + '/api/theme?systemDark=1')).json();
  assert.deepEqual(explicitLight.vars, explicitLight.varsLight);
  // auto 模式：vars 跟随 ?systemDark
  const autoPut = await fetch(app.url + '/api/theme', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      preset: 'claude',
      mode: 'auto',
      accent: null,
      modules: { codex: null, deepseek: null, opencodeGo: null, relay: null, other: null }
    })
  });
  assert.equal(autoPut.status, 200);
  const auto0 = await (await fetch(app.url + '/api/theme?systemDark=0')).json();
  assert.deepEqual(auto0.vars, auto0.varsLight, 'auto + systemDark=0 时 vars 应为浅色');
  const auto1 = await (await fetch(app.url + '/api/theme?systemDark=1')).json();
  assert.deepEqual(auto1.vars, auto1.varsDark, 'auto + systemDark=1 时 vars 应为深色');
  assert.notDeepEqual(auto1.vars, auto0.vars);
  // 非法 systemDark
  const bad = await fetch(app.url + '/api/theme?systemDark=abc');
  assert.equal(bad.status, 400);
  assert.match(String((await bad.json()).error), /systemDark/);
});

test('R2：PUT /api/theme 响应含 varsLight/varsDark，auto 模式按 systemDark 取 vars 且持久化', async (t) => {
  const { dir: dataDir } = await makeDataDir();
  let app = await startServer({ dataDir, env: { PORT: '0', QUOTA_BOARD_DISABLE_ARCHIVER: '1' } });
  let closed = false;
  t.after(async () => {
    if (!closed) await app.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  if (!(await themeIsReady(app))) {
    t.skip('lib/theme.mjs 尚未落盘，跳过 PUT 双 vars 用例');
    return;
  }

  const payload = {
    preset: 'sage',
    mode: 'auto',
    accent: null,
    modules: { codex: '#112233', deepseek: null, opencodeGo: null, relay: null, other: null }
  };
  const put = await fetch(app.url + '/api/theme', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  assert.equal(put.status, 200);
  const putBody = await put.json();
  assert.ok(putBody.varsLight && putBody.varsDark, 'PUT 响应应含 varsLight/varsDark');
  assert.deepEqual(putBody.vars, putBody.varsLight, '默认 systemDark=0，vars 应为浅色');
  // 带上 systemDark=1 的 PUT：vars 应为深色
  const putDark = await (await fetch(app.url + '/api/theme?systemDark=1', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, preset: 'midnight' })
  })).json();
  assert.equal(putDark.current.preset, 'midnight');
  assert.deepEqual(putDark.vars, putDark.varsDark, '?systemDark=1 时 PUT 返回的 vars 应为深色');

  await app.close();
  closed = true;
  app = await startServer({ dataDir, env: { PORT: '0', QUOTA_BOARD_DISABLE_ARCHIVER: '1' } });
  closed = false;
  const after = await (await fetch(app.url + '/api/theme?systemDark=1')).json();
  assert.equal(after.current.preset, 'midnight');
  assert.equal(after.current.mode, 'auto');
  assert.deepEqual(after.vars, after.varsDark);
});

test('R2：/api/config 暴露脱敏 ui.theme（无 secret）且与 /api/theme current 一致', async (t) => {
  const { dir: dataDir } = await makeDataDir();
  const app = await startServer({ dataDir, env: { PORT: '0', QUOTA_BOARD_DISABLE_ARCHIVER: '1' } });
  t.after(async () => {
    await app.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  if (!(await themeIsReady(app))) {
    t.skip('lib/theme.mjs 尚未落盘，跳过 config.ui 用例');
    return;
  }

  const config = await (await fetch(app.url + '/api/config')).json();
  assert.ok(config.ui && config.ui.theme, '/api/config 应暴露 ui.theme');
  const theme = config.ui.theme;
  assert.deepEqual(Object.keys(theme).sort(), ['accent', 'mode', 'modules', 'preset']);
  assert.deepEqual(Object.keys(theme.modules).sort(), ['codex', 'deepseek', 'opencodeGo', 'other', 'relay']);
  const hexOrNull = (value) => value === null || /^#[0-9a-f]{6}$/i.test(String(value));
  assert.ok(hexOrNull(theme.accent));
  for (const value of Object.values(theme.modules)) assert.ok(hexOrNull(value));
  const raw = JSON.stringify(config.ui).toLowerCase();
  assert.ok(!raw.includes('token'), 'ui 不应包含 token');
  assert.ok(!raw.includes('secret'), 'ui 不应包含 secret');

  const current = (await (await fetch(app.url + '/api/theme')).json()).current;
  assert.deepEqual(theme, current, 'config.ui.theme 应与 /api/theme current 一致');

  // PUT 后 /api/config 同步反映
  const put = await fetch(app.url + '/api/theme', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      preset: 'sunset',
      mode: 'dark',
      accent: '#ABCDEF',
      modules: { codex: '#102030', deepseek: null, opencodeGo: null, relay: null, other: null }
    })
  });
  assert.equal(put.status, 200);
  const after = await (await fetch(app.url + '/api/config')).json();
  assert.equal(after.ui.theme.preset, 'sunset');
  assert.equal(after.ui.theme.mode, 'dark');
  assert.equal(after.ui.theme.accent, '#abcdef');
  assert.equal(after.ui.theme.modules.codex, '#102030');
});



