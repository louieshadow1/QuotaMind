import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server.mjs';

const PRIVATE_FIXTURE = 'synthetic-private-marker';

async function fixture(t, providers = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'quota-board-privacy-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, 'config.json'), JSON.stringify({
    providers: {
      codex: { enabled: false, liveEnabled: false },
      deepseek: { enabled: false },
      deepseekPlatform: { enabled: false },
      ...providers
    }
  }));
  const app = await startServer({ dataDir: directory, env: { PORT: '0', QUOTA_BOARD_DISABLE_ARCHIVER: '1' } });
  t.after(() => app.close());
  return { ...app, directory };
}

function requestJson(url, method, body) {
  return fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

test('the normal local dashboard API is accessible with same-origin privacy headers', async (t) => {
  const app = await fixture(t);
  const response = await fetch(app.url + '/api/config', { headers: { Origin: app.url } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  const crossOrigin = await fetch(app.url + '/api/config', {
    headers: { Origin: 'https://example.invalid', 'Sec-Fetch-Site': 'cross-site' }
  });
  assert.equal(crossOrigin.status, 403);
});

test('the static asset list serves application files and leaves unrelated local files private', async (t) => {
  const app = await fixture(t);
  const filename = 'unlisted-' + randomUUID() + '.txt';
  const unlisted = fileURLToPath(new URL('../public/' + filename, import.meta.url));
  await fs.writeFile(unlisted, PRIVATE_FIXTURE, { flag: 'wx' });
  t.after(() => fs.unlink(unlisted));
  for (const resource of ['/', '/go-model-limits.json', '/vendor/lucide.min.js']) {
    assert.equal((await fetch(app.url + resource)).status, 200);
  }
  const unrelated = await fetch(app.url + '/' + filename);
  assert.equal(unrelated.status, 404);
  assert.ok(!(await unrelated.text()).includes(PRIVATE_FIXTURE));
});

test('configuration and missing auth replies omit managed home and private input fields', async (t) => {
  const missingPath = path.join(os.tmpdir(), PRIVATE_FIXTURE, 'auth.json');
  const app = await fixture(t, {
    codex: {
      enabled: true, liveEnabled: false,
      accounts: [{ id: 'fixture-account', name: '测试账户', kind: 'managed', codexHome: path.dirname(missingPath), authPath: missingPath }]
    },
    relays: [{ id: 'fixture-relay', name: '测试站', type: 'generic', baseUrl: 'https://example.invalid/' + PRIVATE_FIXTURE, userId: PRIVATE_FIXTURE }]
  });
  const response = await fetch(app.url + '/api/config');
  const config = await response.json();
  assert.equal(config.providers.codex.accounts[0].managed, true);
  assert.ok(!('codexHome' in config.providers.codex.accounts[0]));
  assert.ok(!JSON.stringify(config).includes(PRIVATE_FIXTURE));
  const missing = await requestJson(app.url + '/api/codex/accounts', 'POST', { authPath: missingPath });
  assert.equal(missing.status, 400);
  assert.match((await missing.json()).error, /^找不到所选的登录文件/);
});

test('import diagnostics identify the failing input line without returning its contents', async (t) => {
  const app = await fixture(t);
  const response = await requestJson(app.url + '/api/daily/import', 'POST', { channel: 'codex', data: PRIVATE_FIXTURE + ',100' });
  assert.equal(response.status, 400);
  const body = await response.text();
  assert.match(body, /YYYY-MM-DD/);
  assert.ok(!body.includes(PRIVATE_FIXTURE));
});

test('normalizing subscription IDs never shares keys across distinct subscriptions', async (t) => {
  const app = await fixture(t);
  const add = (id, key) => requestJson(app.url + '/api/opencode-go/subscriptions', 'POST', { id, name: id, key });
  assert.equal((await add('Example-Go', 'first-fixture-key')).status, 201);
  assert.equal((await add('example-go', 'second-fixture-key')).status, 201);
  const items = (await app.store.load()).providers.opencodeGo.subscriptions;
  assert.notEqual(items[0].keyRef, items[1].keyRef);
  assert.equal(await app.store.getSecret(items[0].keyRef), 'first-fixture-key');
  assert.equal(await app.store.getSecret(items[1].keyRef), 'second-fixture-key');
});
