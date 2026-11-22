import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  archivedCodexAccounts,
  codexAccountAllowsRefresh,
  inspectCodexAuthFile,
  isLiveAuthPath,
  liveCodexAccount,
  readCodexAccountId,
  readCodexAuthStatus,
  scanCodexAuthFiles
} from '../lib/codex.mjs';

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'quota-board-codex-'));
}

test('liveCodexAccount：默认指向 ~/.codex/auth.json，可关闭', () => {
  const live = liveCodexAccount({ providers: { codex: {} } });
  assert.equal(live.id, 'codex-live');
  assert.equal(live.authPath, '~/.codex/auth.json');
  assert.equal(liveCodexAccount({ providers: { codex: { liveEnabled: false } } }), null);
  const custom = liveCodexAccount({ providers: { codex: { liveAuthPath: 'D:/codex/auth.json' } } });
  assert.equal(custom.authPath, 'D:/codex/auth.json');
});

test('archivedCodexAccounts：返回归档账户列表', () => {
  const accounts = archivedCodexAccounts({
    providers: {
      codex: {
        accounts: [
          { id: 'a', name: '主号', authPath: '~/.codex/accounts/a.json' },
          { name: '备用号', authPath: '~/.codex/accounts/b.json' }
        ]
      }
    }
  });
  assert.equal(accounts.length, 2);
  assert.equal(accounts[0].name, '主号');
  assert.equal(accounts[1].id, 'codex-2');
});

test('inspectCodexAuthFile / readCodexAccountId：识别有效登录态', async (t) => {
  const dir = await tempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const valid = path.join(dir, 'valid.json');
  await fs.writeFile(
    valid,
    JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'tok', account_id: 'acct-1' } })
  );
  const invalid = path.join(dir, 'invalid.json');
  await fs.writeFile(invalid, JSON.stringify({ auth_mode: 'apikey', tokens: {} }));

  assert.deepEqual(await inspectCodexAuthFile(valid), { exists: true, valid: true, mode: 'chatgpt' });
  assert.equal((await inspectCodexAuthFile(invalid)).valid, false);
  assert.equal((await inspectCodexAuthFile(path.join(dir, 'missing.json'))).exists, false);
  assert.equal(await readCodexAccountId(valid), 'acct-1');
  assert.equal(await readCodexAccountId(invalid), null);
});

test('scanCodexAuthFiles：只返回带 access_token 的文件，并生成名称', async (t) => {
  const home = await tempDir();
  t.after(() => fs.rm(home, { recursive: true, force: true }));

  const codexDir = path.join(home, '.codex');
  const accountsDir = path.join(codexDir, 'accounts');
  await fs.mkdir(accountsDir, { recursive: true });
  await fs.writeFile(
    path.join(codexDir, 'auth.json'),
    JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'tok-main' } })
  );
  await fs.writeFile(
    path.join(accountsDir, 'work.json'),
    JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'tok-work' } })
  );
  await fs.writeFile(path.join(accountsDir, 'broken.json'), JSON.stringify({ tokens: {} }));

  const candidates = await scanCodexAuthFiles({ home });
  assert.equal(candidates.length, 2);
  assert.ok(candidates.every((candidate) => candidate.path.startsWith('~')));
  assert.ok(candidates.some((candidate) => candidate.nameGuess === 'work'));
  assert.ok(!JSON.stringify(candidates).includes('tok-'), '扫描结果不能包含令牌');
});


// ============================================================
// A6：托管账号标记与登录态健康状态（只读，零网络）
// ============================================================

function a6CodexJwt(payload) {
  const encode = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return encode({ alg: 'none', typ: 'JWT' }) + '.' + encode(payload) + '.sig';
}

test('A6-15 readCodexAuthStatus：返回 exp/可续期/accountId，且不含 token', async (t) => {
  const dir = await tempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const iat = Math.floor(Date.now() / 1000);
  const file = path.join(dir, 'auth.json');
  await fs.writeFile(
    file,
    JSON.stringify({
      auth_mode: 'chatgpt',
      last_refresh: new Date().toISOString(),
      tokens: {
        access_token: a6CodexJwt({ iat, exp: iat + 10 * 24 * 3600 }),
        refresh_token: 'rt-status-secret-123456',
        id_token: a6CodexJwt({ iat, exp: iat + 3600 }),
        account_id: 'acct-status'
      }
    })
  );

  const status = await readCodexAuthStatus(file);
  assert.equal(status.exists, true);
  assert.equal(status.valid, true);
  assert.equal(status.accountId, 'acct-status');
  assert.equal(status.canRefresh, true);
  assert.ok(status.expiresAt);
  assert.equal(status.expired, false);
  assert.ok(!JSON.stringify(status).includes('rt-status-secret-123456'));
  assert.ok(!JSON.stringify(status).includes('eyJ'));

  // 将到期（1 小时）→ needsRefresh=true（默认 24h 提前量）
  await fs.writeFile(
    file,
    JSON.stringify({
      auth_mode: 'chatgpt',
      last_refresh: new Date().toISOString(),
      tokens: { access_token: a6CodexJwt({ iat, exp: iat + 3600 }), refresh_token: 'rt-x', id_token: 'id', account_id: 'acct-status' }
    })
  );
  const soon = await readCodexAuthStatus(file);
  assert.equal(soon.needsRefresh, true);

  const missing = await readCodexAuthStatus(path.join(dir, 'missing.json'));
  assert.equal(missing.exists, false);
  assert.equal(missing.reason, 'missing');
});

test('A6-16 archivedCodexAccounts：透传 managed/autoRefresh；仅 managed 允许续期', () => {
  const config = {
    providers: {
      codex: {
        authPath: '~/.codex/auth.json',
        accounts: [
          { id: 'm1', name: '托管号', authPath: 'C:/homes/a/auth.json', managed: true, autoRefresh: true },
          { id: 'a1', name: '旧归档', authPath: 'C:/archived/b.json' },
          { id: 'a2', name: '关掉续期', authPath: 'C:/archived/c.json', managed: true, autoRefresh: false }
        ]
      }
    }
  };
  const accounts = archivedCodexAccounts(config);
  assert.equal(accounts.length, 3);
  assert.equal(accounts[0].managed, true);
  assert.equal(accounts[0].autoRefresh, true);
  assert.equal(accounts[1].managed, false);
  assert.equal(accounts[1].autoRefresh, false);
  assert.equal(codexAccountAllowsRefresh(accounts[0]), true);
  assert.equal(codexAccountAllowsRefresh(accounts[1]), false);
  assert.equal(codexAccountAllowsRefresh(accounts[2]), false);
  assert.equal(codexAccountAllowsRefresh({ managed: true, live: true }), false);
  assert.equal(isLiveAuthPath('~/.codex/auth.json', config), true);
  assert.equal(isLiveAuthPath('C:/homes/a/auth.json', config), false);
});
