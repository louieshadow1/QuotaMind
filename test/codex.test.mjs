import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  archivedCodexAccounts,
  inspectCodexAuthFile,
  liveCodexAccount,
  readCodexAccountId,
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
