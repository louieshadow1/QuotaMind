import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createStore } from '../lib/config.mjs';
import {
  createDeviceLoginManager,
  disposeCodexDeviceLogin,
  handleCodexDeviceLoginRequest,
  parseDeviceAuthOutput,
  resolveCodexBin,
  stripAnsi
} from '../lib/codex-device-login.mjs';

const SAMPLE_OUTPUT = [
  'Welcome to Codex [v0.154.0]',
  '1. Open this link in your browser and sign in to your account',
  '   \u001b[94mhttps://auth.openai.com/codex/device\u001b[0m',
  '2. Enter this one-time code \u001b[90m(expires in 15 minutes)\u001b[0m',
  '   \u001b[94mDU3A-D29IJ\u001b[0m'
].join('\n') + '\n';

function makeFakeCodex() {
  const state = { child: null, spawns: 0, lastArgs: null, lastOptions: null, kills: 0 };
  function spawnCodex(bin, args, options) {
    const child = new EventEmitter();
    child.pid = 4242;
    child.exitCode = null;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {
      if (child.exitCode === null) {
        child.exitCode = 0;
        child.emit('close', 0, 'SIGTERM');
      }
    };
    state.child = child;
    state.spawns += 1;
    state.lastArgs = args;
    state.lastOptions = options;
    return child;
  }
  function killTree(child) {
    state.kills += 1;
    if (child && typeof child.kill === 'function') child.kill();
  }
  return { state, spawnCodex, killTree };
}

async function makeSetup(depsOverrides = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qb-device-login-'));
  const store = createStore(dir);
  await store.init();
  // 单元测试禁止触碰 live 登录态：关掉 live 账号，避免 registerAccount 读取 ~/.codex/auth.json。
  const baseConfig = await store.load();
  baseConfig.providers.codex.liveEnabled = false;
  await store.saveConfig(baseConfig);
  const fake = makeFakeCodex();
  const manager = createDeviceLoginManager({
    store,
    env: { QUOTA_BOARD_CODEX_BIN: process.execPath },
    deps: Object.assign({ spawnCodex: fake.spawnCodex, killTree: fake.killTree, pollMs: 10, timeoutMs: 3000 }, depsOverrides)
  });
  return { dir, store, fake, manager };
}

async function cleanup(dir, manager) {
  if (manager) manager.dispose();
  await fs.rm(dir, { recursive: true, force: true });
}

function authJson(accountId, name) {
  const claims = { name: name || 'Second', email: 'second@example.com' };
  const idToken = 'aaaa.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.bbbb';
  return JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: {
      access_token: 'ACCESS-TOKEN-SECRET-abcdef',
      id_token: idToken,
      refresh_token: 'REFRESH-TOKEN-SECRET-abcdef',
      account_id: accountId
    }
  });
}

async function waitFor(fn, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('waitFor 超时');
}

test('设备码解析：剥 ANSI、取 URL / 9 位码 / 有效期', () => {
  assert.equal(stripAnsi('a\u001b[94mb\u001b[0m'), 'ab');
  const parsed = parseDeviceAuthOutput(SAMPLE_OUTPUT);
  assert.equal(parsed.url, 'https://auth.openai.com/codex/device');
  assert.equal(parsed.code, 'DU3A-D29IJ');
  assert.equal(parsed.expiresMinutes, 15);
  assert.deepEqual(parseDeviceAuthOutput('no code here'), { url: null, code: null, expiresMinutes: null });
});

test('resolveCodexBin：环境变量优先，找不到时报 CODEX_BIN_NOT_FOUND', () => {
  const found = resolveCodexBin({ QUOTA_BOARD_CODEX_BIN: process.execPath });
  assert.equal(found.source, 'env');
  assert.equal(found.bin, process.execPath);
  assert.throws(
    () => resolveCodexBin({ QUOTA_BOARD_CODEX_BIN: path.join(os.tmpdir(), 'private-installation-fixture.exe'), PATH: '' }),
    (err) => err.code === 'CODEX_BIN_NOT_FOUND' && !err.message.includes('private-installation-fixture')
  );
});

test('启动：在 data/codex-profiles 下建独立 CODEX_HOME，参数与 env 正确', async () => {
  const setup = await makeSetup();
  try {
    const session = await setup.manager.start({ name: '备用号' });
    assert.equal(session.status, 'starting');
    assert.equal(setup.fake.state.spawns, 1);
    assert.deepEqual(setup.fake.state.lastArgs, ['login', '--device-auth']);
    assert.equal(session.codexHomeLabel, 'codex-profiles/' + session.profile);
    assert.equal('codexHome' in session, false, 'DTO 不能暴露 codexHome 绝对路径');
    const options = setup.fake.state.lastOptions;
    const startedHome = setup.manager.profileHome(session.profile);
    assert.equal(options.env.CODEX_HOME, startedHome);
    assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
    assert.equal(options.windowsHide, true);
    assert.equal(options.shell, false);
    const stat = await fs.stat(startedHome);
    assert.ok(stat.isDirectory());
  } finally {
    await cleanup(setup.dir, setup.manager);
  }
});

test('单飞：starting 状态再次 start → 409 login_in_progress，不重复 spawn', async () => {
  const setup = await makeSetup();
  try {
    const first = await setup.manager.start({ name: 'A' });
    assert.equal(first.status, 'starting');
    await assert.rejects(
      () => setup.manager.start({ name: 'B' }),
      (err) => err.status === 409 && err.code === 'login_in_progress'
    );
    assert.equal(setup.fake.state.spawns, 1);
    assert.equal(setup.manager.status().id, first.id, '被拒绝的请求不能顶掉当前会话');
  } finally {
    await cleanup(setup.dir, setup.manager);
  }
});

test('单飞：waiting 状态再次 start → 409 login_in_progress', async () => {
  const setup = await makeSetup();
  try {
    const first = await setup.manager.start({ name: 'A' });
    setup.fake.state.child.stdout.write(SAMPLE_OUTPUT);
    await waitFor(() => setup.manager.status().status === 'waiting');
    await assert.rejects(
      () => setup.manager.start({ name: 'B' }),
      (err) => err.status === 409 && err.code === 'login_in_progress'
    );
    assert.equal(setup.manager.status().id, first.id);
  } finally {
    await cleanup(setup.dir, setup.manager);
  }
});

test('P1-02 并发 6 路 start：只 1 个成功、5 个 409、只 spawn 1 个进程', async () => {
  const setup = await makeSetup();
  try {
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, index) => setup.manager.start({ name: '并发号-' + index }))
    );
    const fulfilled = results.filter((item) => item.status === 'fulfilled');
    const rejected = results.filter((item) => item.status === 'rejected');
    assert.equal(fulfilled.length, 1, '只允许 1 个 202/成功');
    assert.equal(rejected.length, 5, '其余 5 个必须 409');
    for (const item of rejected) {
      assert.equal(item.reason.status, 409);
      assert.equal(item.reason.code, 'login_in_progress');
    }
    assert.equal(setup.fake.state.spawns, 1, '只能 spawn 一个 codex 进程');
  } finally {
    await cleanup(setup.dir, setup.manager);
  }
});

test('start 失败释放占位：bin 缺失抛 CODEX_BIN_NOT_FOUND，重试不被 409 卡住', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qb-device-binfail-'));
  const store = createStore(dir);
  await store.init();
  const fake = makeFakeCodex();
  const manager = createDeviceLoginManager({
    store,
    env: { QUOTA_BOARD_CODEX_BIN: path.join(dir, 'not-exist-codex.exe'), PATH: '' },
    deps: { spawnCodex: fake.spawnCodex, killTree: fake.killTree, pollMs: 10 }
  });
  try {
    await assert.rejects(() => manager.start({}), (err) => err.code === 'CODEX_BIN_NOT_FOUND');
    assert.equal(manager.status(), null, '启动失败后必须释放占位');
    await assert.rejects(
      () => manager.start({}),
      (err) => err.code === 'CODEX_BIN_NOT_FOUND' && err.status === 500,
      '重试仍应是可诊断的启动错误，而不是 409'
    );
    assert.equal(fake.state.spawns, 0);
  } finally {
    manager.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('已有 auth.json 的 profile：409 后释放占位，可正常开始另一个 profile', async () => {
  const setup = await makeSetup();
  try {
    const home = path.join(setup.dir, 'codex-profiles', 'occupied-2');
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(path.join(home, 'auth.json'), authJson('acct-occupied-2'));
    await assert.rejects(
      () => setup.manager.start({ slug: 'occupied-2' }),
      (err) => err.status === 409 && err.code === 'profile_has_auth'
    );
    assert.equal(setup.manager.status(), null, '409 后必须释放占位');
    const session = await setup.manager.start({ name: '重试号' });
    assert.equal(session.status, 'starting');
    assert.equal(setup.fake.state.spawns, 1);
  } finally {
    await cleanup(setup.dir, setup.manager);
  }
});

test('成功：写 auth.json 后释放单飞，可立即开始新会话', async () => {
  const setup = await makeSetup();
  try {
    const started = await setup.manager.start({ name: '第一次' });
    await fs.writeFile(path.join(setup.manager.profileHome(started.profile), 'auth.json'), authJson('acct-slot-release'));
    const success = await waitFor(() => {
      const item = setup.manager.status();
      return item && item.status === 'success' ? item : null;
    });
    assert.equal(success.status, 'success');
    const second = await setup.manager.start({ name: '第二次' });
    assert.equal(second.status, 'starting');
    assert.equal(setup.fake.state.spawns, 2, '成功后必须释放单飞，允许新会话');
  } finally {
    await cleanup(setup.dir, setup.manager);
  }
});

test('dispose：清理 activeSessions 全部会话（含成功后 grace 窗口内的子进程）', async () => {
  const setup = await makeSetup();
  try {
    const started = await setup.manager.start({ name: 'dispose 号' });
    await fs.writeFile(path.join(setup.manager.profileHome(started.profile), 'auth.json'), authJson('acct-dispose'));
    await waitFor(() => {
      const item = setup.manager.status();
      return item && item.status === 'success' ? item : null;
    });
    const killsBefore = setup.fake.state.kills;
    setup.manager.dispose();
    assert.equal(setup.manager.status(), null);
    assert.ok(setup.fake.state.kills >= killsBefore + 1, 'grace 窗口内的子进程也必须被杀');
  } finally {
    await cleanup(setup.dir, setup.manager);
  }
});

test('输出 URL+码后进入 waiting，并返回带 expiresAt 的 DTO（不含 token）', async () => {
  const setup = await makeSetup();
  try {
    const started = await setup.manager.start({ name: '备用号' });
    setup.fake.state.child.stdout.write(SAMPLE_OUTPUT);
    const session = await waitFor(() => {
      const item = setup.manager.status();
      return item && item.status === 'waiting' ? item : null;
    });
    assert.equal(session.url, 'https://auth.openai.com/codex/device');
    assert.equal(session.code, 'DU3A-D29IJ');
    assert.ok(session.expiresAt);
    const text = JSON.stringify(session);
    assert.ok(!text.includes('ACCESS-TOKEN'), 'DTO 不能包含 token');
    assert.ok(!text.includes('\u001b'), 'DTO 不能包含 ANSI 字符');
    assert.equal(started.status, 'starting');
  } finally {
    await cleanup(setup.dir, setup.manager);
  }
});

test('成功：auth.json 出现后写 config.accounts（managed/autoRefresh），并在 data/codex-profiles 下', async () => {
  const setup = await makeSetup();
  try {
    const started = await setup.manager.start({ name: '第二个号' });
    setup.fake.state.child.stdout.write(SAMPLE_OUTPUT);
    await waitFor(() => setup.manager.status().status === 'waiting');
    await fs.writeFile(path.join(setup.manager.profileHome(started.profile), 'auth.json'), authJson('acct-second-1', 'Second'));
    setup.fake.state.child.exitCode = 0;
    setup.fake.state.child.emit('close', 0, null);
    const session = await waitFor(() => {
      const item = setup.manager.status();
      return item && item.status === 'success' ? item : null;
    });
    assert.equal(session.duplicate, false);
    assert.ok(session.account && session.account.id);
    assert.equal(session.account.managed, true);
    assert.equal(session.account.autoRefresh, true);
    assert.equal(session.account.name, '第二个号');
    assert.equal('authPath' in session.account, false, '公开会话不回传登录文件的路径');
    assert.equal('codexHome' in session.account, false, '公开会话不回传配置目录的路径');
    const config = await setup.store.load();
    const accounts = config.providers.codex.accounts;
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0].managed, true);
    assert.equal(accounts[0].autoRefresh, true);
    assert.equal(accounts[0].codexHome, setup.manager.profileHome(started.profile));
    assert.equal(accounts[0].authPath, path.join(setup.manager.profileHome(started.profile), 'auth.json'));
    const dtoText = JSON.stringify(setup.manager.status());
    assert.ok(!dtoText.includes('ACCESS-TOKEN'), 'DTO 不能包含 token');
    assert.ok(!dtoText.includes('REFRESH-TOKEN'), 'DTO 不能包含 token');
  } finally {
    await cleanup(setup.dir, setup.manager);
  }
});

test('成功但 account_id 已存在：标 duplicate，不重复写 config', async () => {
  const setup = await makeSetup();
  try {
    const config = await setup.store.load();
    const existing = path.join(setup.dir, 'existing-auth.json');
    await fs.writeFile(existing, authJson('acct-second-1'));
    config.providers.codex.accounts = [{ id: 'codex-old', name: '旧号', authPath: existing }];
    await setup.store.saveConfig(config);
    const started = await setup.manager.start({ name: '重复号' });
    setup.fake.state.child.stdout.write(SAMPLE_OUTPUT);
    await waitFor(() => setup.manager.status().status === 'waiting');
    await fs.writeFile(path.join(setup.manager.profileHome(started.profile), 'auth.json'), authJson('acct-second-1'));
    setup.fake.state.child.exitCode = 0;
    setup.fake.state.child.emit('close', 0, null);
    const session = await waitFor(() => {
      const item = setup.manager.status();
      return item && item.status === 'success' ? item : null;
    });
    assert.equal(session.duplicate, true);
    assert.equal(session.account, null);
    const after = await setup.store.load();
    assert.equal(after.providers.codex.accounts.length, 1);
  } finally {
    await cleanup(setup.dir, setup.manager);
  }
});

test('已有 auth.json 的 profile 目录拒绝再次登录（避免注销现有会话）', async () => {
  const setup = await makeSetup();
  try {
    const home = path.join(setup.dir, 'codex-profiles', 'occupied');
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(path.join(home, 'auth.json'), authJson('acct-occupied'));
    await assert.rejects(
      () => setup.manager.start({ slug: 'occupied' }),
      (err) => err.status === 409 && /auth.json/.test(err.message)
    );
    assert.equal(setup.fake.state.spawns, 0, '拒绝时不应 spawn codex.exe');
  } finally {
    await cleanup(setup.dir, setup.manager);
  }
});

test('profile 名不能逃出 data/codex-profiles', async () => {
  const setup = await makeSetup();
  try {
    const session = await setup.manager.start({ slug: '../../evil' });
    const root = path.join(setup.dir, 'codex-profiles', '');
    const home = setup.manager.profileHome(session.profile);
    assert.ok(home.startsWith(root), 'profile 必须落在 data/codex-profiles 内：' + home);
    assert.ok(!home.includes('..'));
  } finally {
    await cleanup(setup.dir, setup.manager);
  }
});

test('超时：无输出到点杀进程并标 expired', async () => {
  const setup = await makeSetup({ timeoutMs: 60 });
  try {
    await setup.manager.start({ name: '超时号' });
    const session = await waitFor(() => {
      const item = setup.manager.status();
      return item && item.status === 'expired' ? item : null;
    }, 1500);
    assert.equal(session.errorCode, 'timeout');
    assert.ok(setup.fake.state.kills >= 1, '超时必须杀进程');
  } finally {
    await cleanup(setup.dir, setup.manager);
  }
});

test('取消：waiting 时取消 → cancelled，并杀进程', async () => {
  const setup = await makeSetup();
  try {
    await setup.manager.start({ name: '取消号' });
    setup.fake.state.child.stdout.write(SAMPLE_OUTPUT);
    await waitFor(() => setup.manager.status().status === 'waiting');
    const session = await setup.manager.cancel();
    assert.equal(session.status, 'cancelled');
    assert.equal(session.errorCode, 'cancelled');
    assert.ok(setup.fake.state.kills >= 1);
    const again = await setup.manager.cancel();
    assert.equal(again.id, session.id, '终止态取消应幂等');
    assert.equal(again.status, 'cancelled');
  } finally {
    await cleanup(setup.dir, setup.manager);
  }
});

test('失败：网络/代理错误转成可读提示且脱敏', async () => {
  const setup = await makeSetup();
  try {
    await setup.manager.start({ name: '网络失败号' });
    setup.fake.state.child.stderr.write(
      'Error logging in with device code: error sending request for url (https://auth.openai.com/api/accounts/deviceauth/usercode) private-proxy-fixture sk-abcdefghijklmnop\n'
    );
    setup.fake.state.child.exitCode = 1;
    setup.fake.state.child.emit('close', 1, null);
    const session = await waitFor(() => {
      const item = setup.manager.status();
      return item && item.status === 'failed' ? item : null;
    });
    assert.equal(session.errorCode, 'exited');
    assert.match(session.error, /网络或代理异常/);
    assert.match(session.error, /需要重新登录/);
    assert.ok(!session.error.includes('private-proxy-fixture'), '错误信息不能回传任意子进程输出');
    assert.ok(!session.error.includes('sk-abcdefghijklmnop'), '错误信息必须脱敏');
  } finally {
    await cleanup(setup.dir, setup.manager);
  }
});

test('dispose：终止活跃会话并释放管理器', async () => {
  const setup = await makeSetup();
  try {
    await setup.manager.start({ name: 'x' });
    setup.manager.dispose();
    assert.equal(setup.manager.status(), null);
    assert.ok(setup.fake.state.kills >= 1);
  } finally {
    await cleanup(setup.dir, setup.manager);
  }
});

test('分发钩子：POST/GET/DELETE 正确写响应，未知路径不认领', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qb-device-handler-'));
  const store = createStore(dir);
  await store.init();
  const fake = makeFakeCodex();
  let invalidated = 0;
  const responses = [];
  const ctx = {
    store,
    env: { QUOTA_BOARD_CODEX_BIN: process.execPath },
    deps: { spawnCodex: fake.spawnCodex, killTree: fake.killTree, pollMs: 10 },
    req: {},
    res: {},
    method: 'POST',
    pathname: '/api/codex/device-login',
    readBody: async () => ({ name: '面板号' }),
    jsonResponse: (res, status, payload) => responses.push({ status, payload }),
    invalidateAllCaches: () => {
      invalidated += 1;
    }
  };
  try {
    assert.equal(await handleCodexDeviceLoginRequest(Object.assign({}, ctx, { pathname: '/api/other' })), false);
    assert.equal(await handleCodexDeviceLoginRequest(ctx), true);
    assert.equal(responses[0].status, 202);
    assert.equal(responses[0].payload.session.status, 'starting');

    const getCtx = Object.assign({}, ctx, { method: 'GET' });
    await handleCodexDeviceLoginRequest(getCtx);
    assert.equal(responses[1].status, 200);
    assert.equal(responses[1].payload.session.status, 'starting');

    fake.state.child.stdout.write(SAMPLE_OUTPUT);
    let waiting = null;
    for (let index = 0; index < 100 && !waiting; index += 1) {
      await handleCodexDeviceLoginRequest(Object.assign({}, ctx, { method: 'GET' }));
      const current = responses[responses.length - 1].payload.session;
      if (current && current.status === 'waiting') waiting = current;
      else await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(waiting, '应轮询到 waiting');
    assert.equal(waiting.code, 'DU3A-D29IJ');

    const delCtx = Object.assign({}, ctx, { method: 'DELETE' });
    await handleCodexDeviceLoginRequest(delCtx);
    assert.equal(responses[responses.length - 1].status, 200);
    assert.equal(responses[responses.length - 1].payload.session.status, 'cancelled');
  } finally {
    disposeCodexDeviceLogin(store);
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('分发钩子：并发 6 路 POST 只 1 个 202、5 个 409、只 spawn 1 个进程', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qb-device-handler-race-'));
  const store = createStore(dir);
  await store.init();
  const fake = makeFakeCodex();
  const responses = [];
  const baseCtx = {
    store,
    env: { QUOTA_BOARD_CODEX_BIN: process.execPath },
    deps: { spawnCodex: fake.spawnCodex, killTree: fake.killTree, pollMs: 10 },
    req: {},
    res: {},
    method: 'POST',
    pathname: '/api/codex/device-login',
    readBody: async () => ({ name: '并发面板号' }),
    jsonResponse: (res, status, payload) => responses.push({ status, payload }),
    invalidateAllCaches: () => {}
  };
  try {
    await Promise.all(Array.from({ length: 6 }, () => handleCodexDeviceLoginRequest({ ...baseCtx })));
    const accepted = responses.filter((item) => item.status === 202);
    const rejected = responses.filter((item) => item.status === 409);
    assert.equal(accepted.length, 1, '并发 6 路只能有 1 个 202');
    assert.equal(rejected.length, 5, '其余必须 409');
    for (const item of rejected) assert.equal(item.payload.code, 'login_in_progress');
    assert.equal(fake.state.spawns, 1);
  } finally {
    disposeCodexDeviceLogin(store);
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('GET/DELETE 支持 :id 与 ?id=，兼容旧 session 字段并返回 sessions 列表', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qb-device-id-'));
  const store = createStore(dir);
  await store.init();
  const fake = makeFakeCodex();
  const responses = [];
  const baseCtx = {
    store,
    env: { QUOTA_BOARD_CODEX_BIN: process.execPath },
    deps: { spawnCodex: fake.spawnCodex, killTree: fake.killTree, pollMs: 10 },
    req: {},
    res: {},
    method: 'POST',
    pathname: '/api/codex/device-login',
    readBody: async () => ({ name: 'id 用例号' }),
    jsonResponse: (res, status, payload) => responses.push({ status, payload }),
    invalidateAllCaches: () => {}
  };
  try {
    await handleCodexDeviceLoginRequest({ ...baseCtx });
    const id = responses[0].payload.session.id;
    assert.equal(responses[0].status, 202);

    await handleCodexDeviceLoginRequest({ ...baseCtx, method: 'GET' });
    assert.equal(responses[1].status, 200);
    assert.equal(responses[1].payload.session.id, id, '旧客户端 session 字段必须保留');
    assert.ok(Array.isArray(responses[1].payload.sessions), '应返回 sessions 列表');
    assert.ok(responses[1].payload.sessions.some((item) => item.id === id));

    await handleCodexDeviceLoginRequest({ ...baseCtx, method: 'GET', pathname: '/api/codex/device-login/' + id });
    assert.equal(responses[2].status, 200);
    assert.equal(responses[2].payload.session.id, id);

    await handleCodexDeviceLoginRequest({
      ...baseCtx,
      method: 'GET',
      url: new URL('http://127.0.0.1:8863/api/codex/device-login?id=' + id)
    });
    assert.equal(responses[3].status, 200);
    assert.equal(responses[3].payload.session.id, id);

    await handleCodexDeviceLoginRequest({ ...baseCtx, method: 'GET', pathname: '/api/codex/device-login/ml-nope' });
    assert.equal(responses[4].status, 404);

    await handleCodexDeviceLoginRequest({ ...baseCtx, method: 'DELETE', pathname: '/api/codex/device-login/' + id });
    assert.equal(responses[5].status, 200);
    assert.equal(responses[5].payload.session.status, 'cancelled');

    const repeat = await handleCodexDeviceLoginRequest({ ...baseCtx, method: 'GET', pathname: '/api/codex/device-login/ml-nope' });
    assert.equal(repeat, true);
    assert.equal(responses[responses.length - 1].status, 404);
  } finally {
    disposeCodexDeviceLogin(store);
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('半写/损坏 auth.json：备份为 auth.json.broken-<ts>，同一 slug 可重新登录', async () => {
  const setup = await makeSetup();
  try {
    const home = path.join(setup.dir, 'codex-profiles', 'broken');
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(path.join(home, 'auth.json'), '{"auth_mode":"chatgpt","tokens":{"access_t');
    const session = await setup.manager.start({ slug: 'broken' });
    assert.equal(session.status, 'starting');
    assert.equal(setup.fake.state.spawns, 1, '损坏 auth.json 不应阻止登录');
    const files = await fs.readdir(home);
    assert.ok(!files.includes('auth.json'), '损坏文件必须被移走');
    assert.ok(files.some((name) => name.startsWith('auth.json.broken-')), '应留下 auth.json.broken-<ts> 备份');
  } finally {
    await cleanup(setup.dir, setup.manager);
  }
});

test('孤儿 profile 目录：无 auth.json 的残留被清理，有 auth.json/活跃目录保留', async () => {
  const setup = await makeSetup();
  try {
    const root = path.join(setup.dir, 'codex-profiles');
    const orphan = path.join(root, 'orphan-1');
    await fs.mkdir(orphan, { recursive: true });
    await fs.writeFile(path.join(orphan, 'tmp.txt'), 'leftover');
    const keepAuth = path.join(root, 'has-auth');
    await fs.mkdir(keepAuth, { recursive: true });
    await fs.writeFile(path.join(keepAuth, 'auth.json'), authJson('acct-keep'));
    const active = await setup.manager.start({ name: '活跃号' });
    const activeHome = setup.manager.profileHome(active.profile);
    const removed = await setup.manager.cleanupOrphans();
    assert.ok(removed.some((item) => item.toLowerCase() === orphan.toLowerCase()), '无 auth.json 的孤儿目录应被删');
    await assert.rejects(() => fs.stat(orphan));
    await fs.stat(keepAuth);
    await fs.stat(activeHome);
  } finally {
    await cleanup(setup.dir, setup.manager);
  }
});

test('exit 0 但没有 auth.json → failed/exited_no_auth（不会误判成功）', async () => {
  const setup = await makeSetup();
  try {
    await setup.manager.start({ name: '空退出号' });
    setup.fake.state.child.exitCode = 0;
    setup.fake.state.child.emit('close', 0, null);
    const session = await waitFor(() => {
      const item = setup.manager.status();
      return item && item.status === 'failed' ? item : null;
    });
    assert.equal(session.errorCode, 'exited_no_auth');
  } finally {
    await cleanup(setup.dir, setup.manager);
  }
});

test('真实子进程（非 mock）：stub 输出 URL/码 → waiting；取消后进程目录被清理（AT6 T4.2/T4.4 补回）', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'qb-device-real-'));
  const profiles = path.join(base, 'profiles');
  await fs.mkdir(path.join(profiles, 'real'), { recursive: true });
  await fs.writeFile(
    path.join(profiles, 'real', 'login'),
    [
      'const fs = require("fs");',
      'const path = require("path");',
      'process.stdout.write("\\n1. Open this link\\n   \\x1b[94mhttps://auth.openai.com/codex/device\\x1b[0m\\n2. Enter this one-time code \\x1b[90m(expires in 15 minutes)\\x1b[0m\\n   \\x1b[94mDU3A-D29IJ\\x1b[0m\\n");',
      'setInterval(() => {}, 1000);'
    ].join('\n'),
    'utf8'
  );
  const store = createStore(base);
  await store.init();
  const config = await store.load();
  config.providers.codex.liveEnabled = false;
  await store.saveConfig(config);
  const manager = createDeviceLoginManager({
    store,
    env: { QUOTA_BOARD_CODEX_BIN: process.execPath, QUOTA_BOARD_CODEX_PROFILES: profiles },
    deps: { pollMs: 50, timeoutMs: 5000 }
  });
  try {
    const started = await manager.start({ slug: 'real' });
    const session = await waitFor(() => {
      const item = manager.status();
      return item && item.status === 'waiting' ? item : null;
    }, 6000);
    assert.equal(session.url, 'https://auth.openai.com/codex/device');
    assert.equal(session.code, 'DU3A-D29IJ');
    const home = manager.profileHome(started.profile);
    const cancelled = await manager.cancel();
    assert.equal(cancelled.status, 'cancelled');
    const gone = await waitFor(async () => {
      try {
        await fs.stat(home);
        return false;
      } catch {
        return true;
      }
    }, 6000);
    assert.ok(gone, '取消后无 auth.json 的 profile 目录应被清理（同时证明子进程已退出）');
  } finally {
    manager.dispose();
    await fs.rm(base, { recursive: true, force: true });
  }
});
