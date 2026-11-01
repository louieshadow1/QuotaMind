import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.mjs';

function mockNewApiUpstream() {
  const server = http.createServer((req, res) => {
    if (req.url === '/api/user/self') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          success: true,
          data: { quota: 5000000, used_quota: 1000000, group: 'vip' }
        })
      );
      return;
    }
    if (req.url === '/api/usage/token') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          success: true,
          data: { total_available: 2500000, total_granted: 5000000, total_used: 2500000 }
        })
      );
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function makeDataDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'quota-board-int-'));
  await fs.writeFile(
    path.join(dir, 'config.json'),
    JSON.stringify({
      port: 0,
      refreshSeconds: 10,
      providers: {
        codex: { enabled: false },
        opencodeGo: { enabled: false },
        relays: []
      }
    })
  );
  return dir;
}

test('端到端：添加 NewAPI 账户站点后，快照里有真实余额', async (t) => {
  const dataDir = await makeDataDir();
  const upstream = await mockNewApiUpstream();
  const app = await startServer({ dataDir, env: { PORT: '0' } });
  t.after(async () => {
    await app.close();
    await new Promise((resolve) => upstream.server.close(resolve));
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  const created = await fetch(`${app.url}/api/relays`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: '本地 mock 中转站',
      type: 'newapi-account',
      baseUrl: `http://127.0.0.1:${upstream.port}`,
      userId: '1001',
      token: 'tok-mock-123456',
      quotaPerUsd: 500000
    })
  });
  assert.equal(created.status, 201);

  const quotaResponse = await fetch(`${app.url}/api/quota?refresh=1`);
  assert.equal(quotaResponse.status, 200);
  const snapshot = await quotaResponse.json();
  const relay = snapshot.providers.find((provider) => provider.kind === 'relay');
  assert.equal(relay.status, 'ok', `relay 查询失败：${relay.error || ''}`);
  assert.equal(relay.name, '本地 mock 中转站');
  const [window] = relay.windows;
  assert.equal(window.remaining, 10);
  assert.equal(window.spend, 2);
  assert.equal(window.limit, 12);
  assert.equal(relay.plan, 'vip');

  const raw = JSON.stringify(snapshot);
  assert.ok(!raw.includes('tok-mock-123456'), '快照不能包含明文令牌');
});

test('端到端：NewAPI 令牌口径（total_available）', async (t) => {
  const dataDir = await makeDataDir();
  const upstream = await mockNewApiUpstream();
  const app = await startServer({ dataDir, env: { PORT: '0' } });
  t.after(async () => {
    await app.close();
    await new Promise((resolve) => upstream.server.close(resolve));
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  const created = await fetch(`${app.url}/api/relays`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: '令牌口径站点',
      type: 'newapi-token',
      baseUrl: `http://127.0.0.1:${upstream.port}`,
      token: 'tok-mock-abcdef',
      quotaPerUsd: 500000
    })
  });
  assert.equal(created.status, 201);

  const snapshot = await (await fetch(`${app.url}/api/quota?refresh=1`)).json();
  const relay = snapshot.providers.find((provider) => provider.kind === 'relay');
  assert.equal(relay.status, 'ok', relay.error || '');
  assert.equal(relay.windows[0].remaining, 5);
  assert.equal(relay.windows[0].limit, 10);
  assert.equal(relay.windows[0].spend, 5);
});
