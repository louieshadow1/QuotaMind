import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.mjs';

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
  assert.match(html, /额度一念/);
  assert.match(await page.headers.get('content-security-policy'), /script-src 'self'/);

  const quota = await jsonFetch(`${app.url}/api/quota`);
  assert.equal(quota.status, 200);
  // 空配置时固定出现三张卡片：Codex（已关闭）、OpenCode Go（已关闭）、DeepSeek 平台
  assert.equal(quota.body.providers.length, 3);
  assert.deepEqual(
    quota.body.providers.map((provider) => provider.status),
    ['unconfigured', 'unconfigured', 'unconfigured']
  );
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
  assert.equal(initial.settings.title, '额度一念');
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
  assert.equal(empty.settings.title, '额度一念');
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
