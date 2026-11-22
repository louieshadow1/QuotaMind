/**
 * 对抗性回归套件（F9 / task-45）
 *
 * 目的：把 2026-11-14 对抗测试发现的 P1 转成可重复执行的断言，防止修复回退。
 * 约束：只使用模块公开入口（createStore / startServer / adapters / plan），不 mock 实现内部；
 *       所有写操作发生在 os.tmpdir() 的临时 data 目录，绝不触碰真实 data 与 live 登录态。
 * 门控：F4（历史数据容错）若尚未落盘，相关用例 skip 并在收尾自动启用（按源码特征探测，不改本文件）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createStore, ConfigWriteError } from '../lib/config.mjs';
import { startServer } from '../server.mjs';
import {
  assertPublicHttpUrl,
  isBlockedIp,
  fetchRelay,
  fetchCodexUsage
} from '../lib/adapters.mjs';
import { describeWindow, windowKindFromSeconds } from '../lib/plan.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const P = (...parts) => path.join(ROOT, ...parts);

async function readSource(relPath) {
  try {
    return await fs.readFile(P(relPath), 'utf8');
  } catch {
    return '';
  }
}
const historySrc = await readSource(path.join('lib', 'daily-history.mjs'));
const serverSrc = await readSource('server.mjs');
const F4_READY = /daily-history\.corrupt-/.test(historySrc) || /daily-history\.corrupt-/.test(serverSrc);
const F4_SKIP = F4_READY ? false : '等待 F4（P1-06/07/08/09）落盘后启用';

async function makeDataDir({ codexEnabled = false } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qb-adv-'));
  const authPath = path.join(dir, 'codex-auth.json');
  await fs.writeFile(authPath, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'tok-adv-test' } }));
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
  return { dir, authPath };
}

async function rmDirHard(dir) {
  let lastError = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await fs.rm(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  // Windows 上设备码登录子进程可能短暂占用其 CODEX_HOME 目录：最后兜底不掩盖主体断言
  if (lastError && lastError.code !== 'EBUSY' && lastError.code !== 'EPERM' && lastError.code !== 'ENOTEMPTY') throw lastError;
}

async function startApp(t, dataDir, env = {}) {
  const app = await startServer({
    dataDir,
    env: { PORT: '0', QUOTA_BOARD_DISABLE_ARCHIVER: '1', ...env }
  });
  t.after(async () => {
    await app.close();
    await rmDirHard(dataDir);
  });
  return app;
}

function jsonPost(url, body, extraHeaders = {}) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body)
  });
}

function newSettings(base, index) {
  const copy = JSON.parse(JSON.stringify(base));
  copy.settings = { ...(copy.settings || {}), title: 'title-' + index };
  return copy;
}

// ───────────────────────── P1-01 配置写入并发与原子性（F1） ─────────────────────────

test('P1-01 并发 20 路 saveConfig：全部成功、最终配置可解析、目录无 .tmp 残留', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qb-adv-config-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = createStore(dir);
  await store.init();
  const base = JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8'));

  const writes = [];
  for (let i = 0; i < 20; i += 1) writes.push(store.saveConfig(newSettings(base, i)));
  const results = await Promise.allSettled(writes);
  const failed = results.filter((item) => item.status === 'rejected');
  assert.equal(failed.length, 0, '并发写配置不得失败：' + failed.map((item) => item.reason && item.reason.message).join(' / '));

  const saved = JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(saved.settings.title, 'title-19', '串行队列应按提交顺序落盘');
  assert.equal(store.load() && (await store.load()).settings.title, 'title-19', 'commit 后内存缓存应与磁盘一致');

  const files = await fs.readdir(dir);
  const tmps = files.filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(tmps, [], '写成功后不允许残留 .tmp：' + tmps.join(','));
});

test('P1-01 rename 暂时 EPERM：退避重试后成功且不留 tmp', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qb-adv-retry-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({ providers: { codex: { enabled: false } } }));

  let attempts = 0;
  const flakyFs = {
    ...fs,
    rename: async (from, to) => {
      attempts += 1;
      if (attempts <= 2) {
        const err = new Error('EPERM: operation not permitted');
        err.code = 'EPERM';
        throw err;
      }
      return fs.rename(from, to);
    }
  };
  const store = createStore(dir, { fsImpl: flakyFs });
  const base = await store.load();
  await store.saveConfig({ ...base, settings: { title: 'after-retry' } });
  assert.equal(attempts, 3, '前两次 EPERM 应由退避重试吸收');
  assert.equal(JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8')).settings.title, 'after-retry');
  assert.deepEqual((await fs.readdir(dir)).filter((n) => n.endsWith('.tmp')), []);
});

test('P1-01 rename 永久失败：抛可读 ConfigWriteError、缓存不生效、无 tmp 残留', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qb-adv-fail-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const failingFs = {
    ...fs,
    rename: async () => {
      const err = new Error('EPERM: operation not permitted');
      err.code = 'EPERM';
      throw err;
    }
  };
  const store = createStore(dir, { fsImpl: failingFs });
  const base = await store.load();
  await assert.rejects(
    () => store.saveConfig({ ...base, settings: { title: 'should-not-commit' } }),
    (err) => {
      assert.ok(err instanceof ConfigWriteError, '应是 ConfigWriteError');
      assert.equal(err.status, 500);
      assert.match(err.message, /配置文件写入失败/);
      assert.doesNotMatch(err.message, /token|secret|refresh/i, '错误信息不得包含令牌字样');
      return true;
    }
  );
  assert.deepEqual((await fs.readdir(dir)).filter((n) => n.endsWith('.tmp')), [], '失败路径必须清理 tmp');
  const cached = await store.load();
  assert.notEqual(cached.settings && cached.settings.title, 'should-not-commit', '写失败后内存缓存不得先于磁盘生效');
});

// ───────────────────── P1-04 CSRF / Content-Type 写请求防护（F3） ─────────────────────

test('P1-04 写请求防护：坏 Origin 403、text/plain 415、Sec-Fetch-Site cross-site 403、本地无 Origin JSON 放行', async (t) => {
  const { dir: dataDir } = await makeDataDir();
  const app = await startApp(t, dataDir);
  const settingsUrl = app.url + '/api/settings';

  const evil = await jsonPost(settingsUrl, { title: 'pwn' }, { Origin: 'http://evil.example' });
  assert.equal(evil.status, 403, '跨站 Origin 必须 403');

  const plain = await fetch(settingsUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ title: 'pwn' })
  });
  assert.equal(plain.status, 415, 'text/plain 简单请求必须 415');

  const crossSite = await jsonPost(settingsUrl, { title: 'pwn' }, { 'Sec-Fetch-Site': 'cross-site' });
  assert.equal(crossSite.status, 403, 'Sec-Fetch-Site: cross-site 必须 403');

  const sameOrigin = await jsonPost(settingsUrl, { title: 'ok-local' }, { Origin: app.url });
  assert.equal(sameOrigin.status, 200, '同源 Origin 应放行');

  const noOrigin = await jsonPost(settingsUrl, { title: 'ok-script' });
  assert.equal(noOrigin.status, 200, '本地脚本（无 Origin）应放行');

  const cfg = await (await fetch(app.url + '/api/config')).json();
  assert.equal(cfg.settings.title, 'ok-script');
});

test('P1-04 其它写方法同样受保护：DELETE 无 body 放行、带坏 Origin 的 PUT 403', async (t) => {
  const { dir: dataDir } = await makeDataDir();
  const app = await startApp(t, dataDir);

  const del = await fetch(app.url + '/api/relays/not-exist', { method: 'DELETE' });
  assert.equal(del.status, 404, 'DELETE 无 body 不应被 415 拦截（先命中 404）');

  const put = await fetch(app.url + '/api/codex/live', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' },
    body: JSON.stringify({ name: 'x' })
  });
  assert.equal(put.status, 403, '坏 Origin 的 PUT 必须 403');
});

// ───────────────────── P1-03 并发导入不丢天（F3） ─────────────────────

test('P1-03 8 路并发导入不同日期：8 天全部保留、写后校验通过', async (t) => {
  const { dir: dataDir } = await makeDataDir();
  const app = await startApp(t, dataDir);
  const dates = ['2026-03-01', '2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06', '2026-03-07', '2026-03-08'];

  const responses = await Promise.all(
    dates.map((date, index) =>
      jsonPost(app.url + '/api/daily/import', { channel: 'codex', data: date + ',' + (1000 + index * 100) })
    )
  );
  for (const response of responses) assert.equal(response.status, 200, '并发导入应全部 200');
  const bodies = await Promise.all(responses.map((response) => response.json()));
  assert.ok(bodies.every((body) => body.verified === true), '响应必须带 verified:true');

  const saved = JSON.parse(await fs.readFile(path.join(dataDir, 'daily-history.json'), 'utf8'));
  for (const date of dates) {
    assert.ok(saved.days[date], '并发导入后日期丢失：' + date);
  }
  assert.equal(saved.days['2026-03-08'].codexTokens, 1700);
});

// ───────────────────── P1-06/07/08/09 历史数据容错（F4，门控） ─────────────────────

test('P1-06 损坏 daily-history：先备份再重建，接口不 500', { skip: F4_SKIP }, async (t) => {
  const { dir: dataDir } = await makeDataDir();
  await fs.writeFile(path.join(dataDir, 'daily-history.json'), '{ 这不是合法 JSON', 'utf8');
  const app = await startApp(t, dataDir);

  const response = await fetch(app.url + '/api/daily?refresh=1');
  assert.equal(response.status, 200, '坏存档不应让接口 500');
  const files = await fs.readdir(dataDir);
  assert.ok(
    files.some((name) => /^daily-history\.(corrupt|broken)-/.test(name)),
    '损坏文件必须先备份，实际文件：' + files.join(',')
  );
});

test('P1-07 只读存档导入：必须返回非 2xx，不得谎报成功', { skip: F4_SKIP }, async (t) => {
  const { dir: dataDir } = await makeDataDir();
  const historyPath = path.join(dataDir, 'daily-history.json');
  await fs.writeFile(historyPath, JSON.stringify({ version: 1, days: { '2026-01-01': { date: '2026-01-01', codexTokens: 10 } } }), 'utf8');
  await fs.chmod(historyPath, 0o444);
  const app = await startApp(t, dataDir);
  t.after(() => fs.chmod(historyPath, 0o666).catch(() => {}));

  const response = await jsonPost(app.url + '/api/daily/import', { channel: 'codex', data: '2026-05-01,999' });
  assert.ok(response.status >= 400, '写盘失败必须返回非 2xx，实际 ' + response.status);
});

test('P1-08 非法日期不落盘：坏日历/越界年份被拒', { skip: F4_SKIP }, async (t) => {
  const { dir: dataDir } = await makeDataDir();
  const app = await startApp(t, dataDir);

  const invalid = await jsonPost(app.url + '/api/daily/import', {
    channel: 'codex',
    data: '2026-13-45,10\n1970-01-01,10\n2099-12-31,10'
  });
  let saved = { days: {} };
  try {
    saved = JSON.parse(await fs.readFile(path.join(dataDir, 'daily-history.json'), 'utf8'));
  } catch {
    saved = { days: {} };
  }
  assert.equal(saved.days['2026-13-45'], undefined, '坏日历日期不得落盘');
  assert.equal(saved.days['1970-01-01'], undefined, '1970 年越界日期不得落盘');
  assert.equal(saved.days['2099-12-31'], undefined, '2099 年越界日期不得落盘');
  if (invalid.status === 200) {
    const body = await invalid.json();
    assert.ok(Array.isArray(body.errors) && body.errors.length >= 3, '被拒日期应出现在 errors 中');
  } else {
    assert.ok(invalid.status >= 400);
  }
});

test('P1-09 超大数值拒收：>1e13 tokens / 1e308 成本不得落盘', { skip: F4_SKIP }, async (t) => {
  const { dir: dataDir } = await makeDataDir();
  const app = await startApp(t, dataDir);

  const response = await jsonPost(app.url + '/api/daily/import', {
    channel: 'deepseek',
    data: JSON.stringify([
      { date: '2026-04-01', tokens: 9007199254740992 },
      { date: '2026-04-02', tokens: 1000, costCny: 1e308 }
    ])
  });
  assert.ok(response.status >= 400 || response.status === 200);
  let saved = { days: {} };
  try {
    saved = JSON.parse(await fs.readFile(path.join(dataDir, 'daily-history.json'), 'utf8'));
  } catch {
    saved = { days: {} };
  }
  const huge = saved.days['2026-04-01'];
  if (huge) assert.ok(!(huge.deepseekTokens > 1e13), '超大 tokens 必须被拒收/收敛');
  const hugeCost = saved.days['2026-04-02'];
  if (hugeCost) assert.ok(!(hugeCost.deepseekCostCny > 1e9), '超大成本必须被拒收/收敛');
});

// ───────────────────── P1-05 SSRF 防护（F5） ─────────────────────

test('P1-05 SSRF：回环/私网/链路本地/元数据地址全部拒绝，公网放行', async () => {
  const blocked = [
    'http://127.0.0.1:8799/api/quota',
    'http://127.1.2.3/',
    'http://10.0.0.1/',
    'http://172.16.5.4/',
    'http://192.168.1.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]:8799/',
    'http://localhost:8799/',
    'http://metadata.google.internal/computeMetadata/v1/',
    'file:///C:/Windows/win.ini',
    'gopher://127.0.0.1:70/'
  ];
  for (const url of blocked) {
    await assert.rejects(() => assertPublicHttpUrl(url), '应拒绝：' + url);
  }

  assert.deepEqual(
    ['127.0.0.1', '10.1.2.3', '192.168.0.9', '169.254.1.1', '::1', 'fe80::1', 'fd00::1'].map(isBlockedIp),
    [true, true, true, true, true, true, true]
  );
  assert.equal(isBlockedIp('93.184.216.34'), false);

  // 域名解析后再校验：解析到内网必须拒绝
  await assert.rejects(() =>
    assertPublicHttpUrl('https://relay.example.com/api', { lookupImpl: async () => [{ address: '10.0.0.5', family: 4 }] })
  );
  const ok = await assertPublicHttpUrl('https://relay.example.com/api', {
    lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }]
  });
  assert.match(ok.href, /relay\.example\.com/);

  // fetchRelay 在发请求前就会拒绝（fetchImpl 不应被调用）
  let fetchCalls = 0;
  await assert.rejects(() =>
    fetchRelay({
      relay: { id: 'r-ssrf', name: 'ssrf', type: 'generic', baseUrl: 'http://169.254.169.254/latest/meta-data' },
      token: 'tok',
      fetchImpl: async () => {
        fetchCalls += 1;
        return { status: 200, ok: true, text: async () => '{}' };
      }
    })
  );
  assert.equal(fetchCalls, 0, 'SSRF 地址不得发出真实请求');
});

test('P1-05 窗口数值收敛：used_percent 夹到 0–100、reset_at<=0 变 null', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qb-adv-window-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const authPath = path.join(dir, 'auth.json');
  await fs.writeFile(authPath, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'tok', account_id: 'acct' } }));

  const body = {
    plan_type: 'plus',
    rate_limit: {
      primary_window: { used_percent: 999, reset_at: 0, limit_window_seconds: 18000 },
      secondary_window: { used_percent: -5, reset_at: -1, limit_window_seconds: 604800 }
    }
  };
  const provider = await fetchCodexUsage({
    name: 'adv',
    authPath,
    fetchImpl: async () => ({ status: 200, ok: true, text: async () => JSON.stringify(body) })
  });
  assert.equal(provider.windows[0].usedPercent, 100);
  assert.equal(provider.windows[1].usedPercent, 0);
  assert.equal(provider.windows[0].resetAt, null);
  assert.equal(provider.windows[1].resetAt, null);
});

// ───────────────────── P1-11 / P2 计划窗口边界（F6） ─────────────────────

test('P1-11 plan 超大 reset_at：返回 null 而不是抛 RangeError', () => {
  const values = [8640000000000001, 8.64e15 + 1, 1e18, '1000000000000000000', Infinity, NaN];
  for (const value of values) {
    const window = describeWindow({ used_percent: 1, limit_window_seconds: 604800, reset_at: value });
    assert.equal(window.resetAt, null, '超大/非法 reset_at 应为 null：' + String(value));
  }
});

test('P2 自定义周期 label 不与标准周期撞名（17999/2591999）', () => {
  assert.deepEqual(windowKindFromSeconds(18000), { kind: 'session', key: '5h', label: '5 小时' });
  assert.deepEqual(windowKindFromSeconds(604800), { kind: 'weekly', key: 'weekly', label: '每周' });
  assert.deepEqual(windowKindFromSeconds(2592000), { kind: 'monthly', key: 'monthly', label: '每月' });
  for (const seconds of [17999, 18001]) {
    const identity = windowKindFromSeconds(seconds);
    assert.equal(identity.kind, 'custom');
    assert.notEqual(identity.label, '5 小时', seconds + ' 不得被标成标准 5 小时窗口');
  }
  for (const seconds of [2591999, 2592001]) {
    const identity = windowKindFromSeconds(seconds);
    assert.notEqual(identity.label, '每月', seconds + ' 不得被标成标准每月窗口');
  }
  for (const seconds of [0, -1, null, 'abc']) {
    const window = describeWindow({ used_percent: 1, limit_window_seconds: seconds, reset_at: 123 });
    assert.equal(window.windowSeconds, null);
    assert.equal(window.kind, 'custom');
    assert.equal(window.label, '未知窗口');
  }
});

// ───────────────────── P1-02 设备码登录并发单飞（F2） ─────────────────────

test('P1-02 6 路并发 device-login：仅 1×202、其余 409，不产生多进程入口', async (t) => {
  const { dir: dataDir } = await makeDataDir();
  const app = await startApp(t, dataDir, { QUOTA_BOARD_CODEX_BIN: process.execPath, PATH: process.env.PATH || '' });
  const url = app.url + '/api/codex/managed-login';

  const responses = await Promise.all(Array.from({ length: 6 }, () => jsonPost(url, { name: 'adv' })));
  const statuses = responses.map((response) => response.status);
  const started = statuses.filter((status) => status === 202).length;
  const rejected = statuses.filter((status) => status === 409).length;
  assert.equal(started, 1, '并发登录只允许 1 个 202，实际：' + JSON.stringify(statuses));
  assert.equal(rejected, 5, '其余必须 409，实际：' + JSON.stringify(statuses));

  // 主动取消，避免测试结束后留下会话/子进程
  await fetch(url, { method: 'DELETE' }).catch(() => {});
});

// ───────────────────── P1-10 / widget：前端修复的静态冒烟（F7） ─────────────────────

test('P1-10 / P2 前端修复落盘冒烟：长名称换行、数值 clamp、widget 跟随计划窗口', async () => {
  const css = await readSource(path.join('public', 'style.css'));
  const appJs = await readSource(path.join('public', 'app.js'));
  const widgetJs = await readSource(path.join('public', 'widget.js'));
  assert.match(css, /overflow-wrap:\s*anywhere/, 'style.css 需要 overflow-wrap:anywhere 防长名称撑破布局');
  assert.match(appJs, /clampPercent|Math\.min\(100|Math\.max\(0/, 'app.js 需要 usedPercent clamp 逻辑');
  assert.match(widgetJs, /planMeta|planName/, 'widget.js 需要读取计划名');
  assert.match(widgetJs, /label/, 'widget.js 需要渲染窗口 label');
});
