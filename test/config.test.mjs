import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createStore, ConfigWriteError, DEFAULT_CONFIG, DEFAULT_UI_THEME, UI_MODULE_KEYS } from '../lib/config.mjs';
import { withFileLock, isFileLocked } from '../lib/file-lock.mjs';

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'quota-board-config-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * 可控 fs 包装：统计 rename 次数、检测并发写重叠、记录临时文件名。
 * renameFailures: 前 N 次 rename 抛 EPERM（模拟 Windows 文件占用/杀软扫描）。
 */
function makeFs({ renameFailures = 0, renameAlwaysFails = false, writeError = null } = {}) {
  const state = { renameCalls: 0, busy: false, overlap: false, maxBusy: 0, tmpPaths: [] };
  const fsImpl = {
    readFile: (...args) => fs.readFile(...args),
    mkdir: (...args) => fs.mkdir(...args),
    access: (...args) => fs.access(...args),
    unlink: (...args) => fs.unlink(...args),
    writeFile: async (file, data, enc) => {
      if (state.busy) state.overlap = true;
      state.busy = true;
      state.maxBusy = Math.max(state.maxBusy, 1);
      state.tmpPaths.push(file);
      try {
        if (writeError) {
          const err = new Error(writeError.message || 'write failed');
          err.code = writeError.code || 'ENOSPC';
          throw err;
        }
        return await fs.writeFile(file, data, enc);
      } catch (err) {
        state.busy = false;
        throw err;
      }
    },
    rename: async (from, to) => {
      state.renameCalls += 1;
      if (renameAlwaysFails || state.renameCalls <= renameFailures) {
        const err = new Error('EPERM: operation not permitted, rename');
        err.code = 'EPERM';
        throw err;
      }
      const result = await fs.rename(from, to);
      state.busy = false;
      return result;
    }
  };
  return { fsImpl, state };
}

function cfgWithPort(port) {
  return { ...JSON.parse(JSON.stringify(DEFAULT_CONFIG)), port };
}

test('config：20 路并发 saveConfig 全部成功、串行无重叠、目录无 *.tmp', async (t) => {
  const dir = await tempDir(t);
  const { fsImpl, state } = makeFs();
  const store = createStore(dir, { fsImpl });
  await store.init();
  const tmpBefore = state.tmpPaths.length;

  const ports = Array.from({ length: 20 }, (_, i) => 9000 + i);
  const saved = await Promise.all(ports.map((port) => store.saveConfig(cfgWithPort(port))));
  assert.equal(saved.length, 20);

  assert.equal(state.overlap, false, '同一配置文件的写入不能重叠');
  assert.equal(state.maxBusy, 1);

  const disk = JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8'));
  assert.ok(disk.port >= 9000 && disk.port <= 9019, '落盘值应是 20 个写入之一');
  assert.equal((await store.load()).port, disk.port, '内存缓存必须与磁盘一致');

  const files = await fs.readdir(dir);
  assert.deepEqual(files.filter((name) => name.endsWith('.tmp')), [], '不能残留临时文件');

  const writeTmp = state.tmpPaths.slice(tmpBefore);
  assert.equal(writeTmp.length, 20);
  assert.equal(new Set(writeTmp).size, 20, '每次写入的临时文件名必须唯一');
  assert.ok(writeTmp.every((name) => /\.tmp$/.test(name) && name.includes(String(process.pid))));
});

test('config：rename 前 2 次 EPERM 后重试成功，不残留 tmp', async (t) => {
  const dir = await tempDir(t);
  const real = createStore(dir);
  await real.init();
  await real.saveConfig(cfgWithPort(9100));

  const { fsImpl, state } = makeFs({ renameFailures: 2 });
  const store = createStore(dir, { fsImpl });
  await store.init();
  const before = state.renameCalls;

  await store.saveConfig(cfgWithPort(9101));
  assert.ok(state.renameCalls - before >= 3, '应至少重试到第 3 次才成功');
  const disk = JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(disk.port, 9101);
  const files = await fs.readdir(dir);
  assert.deepEqual(files.filter((name) => name.endsWith('.tmp')), []);
});

test('config：rename 一直失败 → 抛可读 ConfigWriteError、内存/磁盘都保持旧值、无 tmp', async (t) => {
  const dir = await tempDir(t);
  const real = createStore(dir);
  await real.init();
  await real.saveConfig(cfgWithPort(9200));

  const { fsImpl } = makeFs({ renameAlwaysFails: true });
  const store = createStore(dir, { fsImpl });
  await store.init();

  await assert.rejects(
    () => store.saveConfig(cfgWithPort(9299)),
    (err) =>
      err instanceof ConfigWriteError &&
      err.status === 500 &&
      err.code === 'CONFIG_WRITE_FAILED' &&
      /配置文件写入失败/.test(err.message) &&
      /EPERM/.test(err.message)
  );
  const disk = JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(disk.port, 9200, '失败的写入不能落地');
  assert.equal((await store.load()).port, 9200, '失败的写入不能更新内存缓存');
  const files = await fs.readdir(dir);
  assert.deepEqual(files.filter((name) => name.endsWith('.tmp')), [], '失败路径必须清理临时文件');
});

test('config：写临时文件失败（ENOSPC）→ 抛读错误、无 tmp、缓存不变', async (t) => {
  const dir = await tempDir(t);
  const real = createStore(dir);
  await real.init();
  await real.saveConfig(cfgWithPort(9300));

  const { fsImpl } = makeFs({ writeError: { code: 'ENOSPC', message: 'no space left on device' } });
  const store = createStore(dir, { fsImpl });
  await store.init();

  await assert.rejects(
    () => store.saveConfig(cfgWithPort(9399)),
    (err) => err instanceof ConfigWriteError && /ENOSPC/.test(err.message)
  );
  assert.equal((await store.load()).port, 9300);
  const files = await fs.readdir(dir);
  assert.deepEqual(files.filter((name) => name.endsWith('.tmp')), []);
});

test('config：saveSecrets 失败不污染缓存、不残留含密钥的 tmp', async (t) => {
  const dir = await tempDir(t);
  const real = createStore(dir);
  await real.init();

  const { fsImpl } = makeFs({ renameAlwaysFails: true });
  const store = createStore(dir, { fsImpl });
  await store.init();

  await assert.rejects(() => store.setSecret('F1_TEST_SECRET', 'secret-plaintext-abc123'), ConfigWriteError);
  assert.equal(await store.getSecret('F1_TEST_SECRET'), null, '写失败不能把密钥写进内存缓存');
  const files = await fs.readdir(dir);
  assert.deepEqual(files.filter((name) => name.endsWith('.tmp')), []);
  for (const name of files) {
    if (!name.endsWith('.json')) continue;
    const raw = await fs.readFile(path.join(dir, name), 'utf8');
    assert.ok(!raw.includes('secret-plaintext-abc123'), '任何落盘文件都不能含本次失败写入的密钥');
  }
});

test('config：saveSecrets 并发 10 路串行写入，最终文件可解析且无 tmp', async (t) => {
  const dir = await tempDir(t);
  const store = createStore(dir);
  await store.init();

  await Promise.all(
    Array.from({ length: 10 }, (_, i) => store.setSecret('F1_KEY_' + i, 'value-' + i))
  );
  const raw = await fs.readFile(path.join(dir, 'secrets.json'), 'utf8');
  const parsed = JSON.parse(raw);
  assert.equal(typeof parsed, 'object');
  const files = await fs.readdir(dir);
  assert.deepEqual(files.filter((name) => name.endsWith('.tmp')), []);
  assert.ok(Object.keys(parsed).length >= 1);
});

test('config：init/load/save 基本行为保持不变（默认值 + 往返）', async (t) => {
  const dir = await tempDir(t);
  const store = createStore(dir);
  await store.init();
  const loaded = await store.load();
  assert.equal(loaded.port, DEFAULT_CONFIG.port);
  assert.equal(loaded.settings.title, DEFAULT_CONFIG.settings.title);

  await store.saveConfig({ ...loaded, refreshSeconds: 30, settings: { ...loaded.settings, title: 'F1 标题' } });
  const again = await createStore(dir).load();
  assert.equal(again.refreshSeconds, 30);
  assert.equal(again.settings.title, 'F1 标题');
});

test('config：面板配置摘要省略私有代理和中转站接入参数，保留原配置', async (t) => {
  const dir = await tempDir(t);
  const store = createStore(dir);
  await store.init();
  const config = await store.load();
  const proxy = 'http://test-user:proxy-private-fixture@proxy.example:8080';
  const baseUrl = 'https://relay.example/api?key=relay-private-fixture';
  const relay = {
    id: 'relay-fixture',
    name: '示例中转站',
    type: 'newapi-account',
    baseUrl,
    userId: 'private-user-fixture',
    tokenRef: 'QUOTA_BOARD_PRIVACY_TEST_RELAY'
  };
  config.proxy = proxy;
  config.providers.relays = [relay];
  await store.saveConfig(config);
  await store.setSecret(relay.tokenRef, 'synthetic-relay-secret');

  const summary = await store.sanitize();
  assert.equal('proxy' in summary, false);
  assert.deepEqual(summary.providers.relays, [{
    id: relay.id,
    name: relay.name,
    type: relay.type,
    quotaPerUsd: 500000,
    unit: 'USD',
    hasToken: true
  }]);
  assert.equal((await createStore(dir).load()).proxy, proxy);
  assert.deepEqual((await createStore(dir).load()).providers.relays, [relay]);
});


// ============================================================
// G6：跨进程文件锁 + 损坏恢复
// ============================================================

test('G6-1 config.json 损坏：备份 .corrupt-<ts> 后重建默认值，不静默覆盖', async (t) => {
  const dir = await tempDir(t);
  const configPath = path.join(dir, 'config.json');
  await fs.writeFile(configPath, '{"port": 1, "broken": true', 'utf8'); // 非法 JSON（保留原始字节用于核对）
  const store = createStore(dir);

  await store.init();
  const notices = store.getRecoveryNotices();
  assert.equal(notices.length, 1, '应记录一条恢复通知');
  const notice = notices[0];
  assert.equal(notice.file, configPath);
  assert.equal(notice.reason, 'corrupt-json');
  assert.ok(notice.backupPath, '应产生备份');
  assert.match(path.basename(notice.backupPath), /^config\.json\.corrupt-.+/);
  assert.equal(notice.rebuilt, true, '应已用默认值重建');

  const backupRaw = await fs.readFile(notice.backupPath, 'utf8');
  assert.ok(backupRaw.includes('broken'), '备份必须是原始损坏内容，不能被默认值覆盖');

  const rebuilt = JSON.parse(await fs.readFile(configPath, 'utf8'));
  assert.equal(rebuilt.port, DEFAULT_CONFIG.port, '重建文件应是合法默认配置');
  assert.equal((await store.load()).port, DEFAULT_CONFIG.port);

  const files = await fs.readdir(dir);
  assert.ok(files.some((name) => /^config\.json\.broken-/.test(name)), '保留旧备份名兼容副本');
  assert.deepEqual(files.filter((name) => name.endsWith('.lock')), [], '恢复后不能残留锁文件');
});

test('G6-2 仅 load()（未 init）也能恢复损坏 config：备份 + 重建，返回默认值', async (t) => {
  const dir = await tempDir(t);
  const configPath = path.join(dir, 'config.json');
  await fs.writeFile(configPath, 'not-json-at-all', 'utf8');
  const store = createStore(dir);

  const loaded = await store.load();
  assert.equal(loaded.port, DEFAULT_CONFIG.port);
  const notices = store.getRecoveryNotices();
  assert.equal(notices.length, 1);
  assert.ok(notices[0].backupPath);
  const rebuilt = JSON.parse(await fs.readFile(configPath, 'utf8'));
  assert.equal(rebuilt.port, DEFAULT_CONFIG.port);
});

test('G6-3 secrets.json 损坏：备份 .corrupt-<ts> 后重建 {}，getSecret 不崩、可继续写入', async (t) => {
  const dir = await tempDir(t);
  const secretsPath = path.join(dir, 'secrets.json');
  const invalid = 'privacy-test-secret-fragment';
  await fs.writeFile(secretsPath, invalid, 'utf8');
  const store = createStore(dir);
  const warnings = t.mock.method(console, 'warn', () => {});

  await store.init();
  const notices = store.getRecoveryNotices().filter((notice) => notice.file === secretsPath);
  assert.equal(notices.length, 1);
  assert.match(path.basename(notices[0].backupPath), /^secrets\.json\.corrupt-.+/);
  assert.equal(await fs.readFile(notices[0].backupPath, 'utf8'), invalid);
  assert.equal(notices[0].parseError, 'JSON 格式无效');
  assert.match(warnings.mock.calls[0].arguments.join(' '), /JSON 格式无效/);
  assert.ok(!JSON.stringify(warnings.mock.calls[0].arguments).includes(invalid));
  const rebuilt = JSON.parse(await fs.readFile(secretsPath, 'utf8'));
  assert.deepEqual(rebuilt, {});
  assert.equal(await store.getSecret('G6_MISSING_KEY'), null);
  await store.setSecret('G6_KEY', 'g6-value-123');
  assert.equal(await store.getSecret('G6_KEY'), 'g6-value-123');
});

test('G6-4 跨进程锁被占用时 saveConfig 会等待，锁释放后成功且无 .lock 残留', async (t) => {
  const dir = await tempDir(t);
  const store = createStore(dir);
  await store.init();
  const configPath = path.join(dir, 'config.json');

  let savePromise = null;
  let settled = false;
  await withFileLock(configPath, async () => {
    savePromise = store.saveConfig(cfgWithPort(9600)).then(
      () => { settled = true; },
      () => { settled = true; }
    );
    assert.equal(await isFileLocked(configPath), true);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(settled, false, '锁被其它持有者占用时保存必须等待，不能并发写');
  });
  await savePromise;
  assert.equal(settled, true);
  const disk = JSON.parse(await fs.readFile(configPath, 'utf8'));
  assert.equal(disk.port, 9600);
  const files = await fs.readdir(dir);
  assert.deepEqual(files.filter((name) => name.endsWith('.lock')), []);
});

test('G6-5 跨进程锁超时：抛可读 ConfigWriteError（文件锁超时）、不落盘、缓存不变、无 tmp/.lock', async (t) => {
  const dir = await tempDir(t);
  const store = createStore(dir, { lockTimeoutMs: 120 });
  await store.init();
  const configPath = path.join(dir, 'config.json');
  await store.saveConfig(cfgWithPort(9650));

  await withFileLock(configPath, async () => {
    await assert.rejects(
      () => store.saveConfig(cfgWithPort(9651)),
      (err) => err instanceof ConfigWriteError && /文件锁超时/.test(err.message) && err.code === 'CONFIG_WRITE_FAILED'
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
  });

  const disk = JSON.parse(await fs.readFile(configPath, 'utf8'));
  assert.equal(disk.port, 9650, '锁超时不能落盘');
  assert.equal((await store.load()).port, 9650, '锁超时不能更新内存缓存');
  const files = await fs.readdir(dir);
  assert.deepEqual(files.filter((name) => name.endsWith('.tmp')), []);
  assert.deepEqual(files.filter((name) => name.endsWith('.lock')), []);
});

test('G6-6 写失败后内存回滚（复核 F1）：旧值可继续读，随后成功写入恢复', async (t) => {
  const dir = await tempDir(t);
  const real = createStore(dir);
  await real.init();
  await real.saveConfig(cfgWithPort(9800));

  const { fsImpl } = makeFs({ renameAlwaysFails: true });
  const failing = createStore(dir, { fsImpl });
  await failing.init();
  await assert.rejects(() => failing.saveConfig(cfgWithPort(9899)), ConfigWriteError);
  assert.equal((await failing.load()).port, 9800, '失败后缓存必须是旧值');

  const retry = createStore(dir);
  await retry.saveConfig(cfgWithPort(9801));
  const disk = JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(disk.port, 9801);
});


// ============================================================
// H3：config.ui.theme 默认值、迁移与深合并
// ============================================================

test('H3-1 全新配置包含默认 ui.theme（契约形状）', async (t) => {
  const dir = await tempDir(t);
  const store = createStore(dir);
  await store.init();
  const loaded = await store.load();
  assert.deepEqual(loaded.ui.theme, {
    preset: 'claude',
    mode: 'light',
    accent: null,
    modules: { codex: null, deepseek: null, opencodeGo: null, relay: null, other: null }
  });
  assert.deepEqual(Object.keys(loaded.ui.theme.modules), UI_MODULE_KEYS);
  // 磁盘上的新配置也应带 ui.theme（写入默认文件）
  const disk = JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(disk.ui.theme.preset, 'claude');
});

test('H3-2 老配置（无 ui）加载时补默认，其它字段保持不变', async (t) => {
  const dir = await tempDir(t);
  await fs.writeFile(
    path.join(dir, 'config.json'),
    JSON.stringify({ port: 8899, refreshSeconds: 42, settings: { title: '老面板' }, providers: { relays: [] } }),
    'utf8'
  );
  const store = createStore(dir);
  const loaded = await store.load();
  assert.equal(loaded.port, 8899);
  assert.equal(loaded.refreshSeconds, 42);
  assert.equal(loaded.settings.title, '老面板');
  assert.deepEqual(loaded.ui.theme, {
    preset: 'claude',
    mode: 'light',
    accent: null,
    modules: { codex: null, deepseek: null, opencodeGo: null, relay: null, other: null }
  });
  assert.deepEqual(loaded.providers.relays, []);
});

test('H3-3 部分 ui.theme 合并：缺字段补默认、modules 逐 key 合并、多余键保留', async (t) => {
  const dir = await tempDir(t);
  await fs.writeFile(
    path.join(dir, 'config.json'),
    JSON.stringify({
      ui: {
        otherUiKey: 'keep-ui',
        theme: {
          preset: 'midnight',
          mode: 'dark',
          accent: '#aabbcc',
          extraThemeKey: 'keep-theme',
          modules: { codex: '#112233', extraModule: '#ffffff' }
        }
      },
      providers: { relays: [] }
    }),
    'utf8'
  );
  const store = createStore(dir);
  const theme = (await store.load()).ui.theme;
  assert.equal(theme.preset, 'midnight');
  assert.equal(theme.mode, 'dark');
  assert.equal(theme.accent, '#aabbcc');
  assert.equal(theme.modules.codex, '#112233');
  assert.equal(theme.modules.deepseek, null, '缺失模块补默认 null');
  assert.equal(theme.modules.opencodeGo, null);
  assert.equal(theme.modules.relay, null);
  assert.equal(theme.modules.other, null);
  assert.equal(theme.extraThemeKey, 'keep-theme', 'theme 顶层多余键保留');
  assert.equal(theme.modules.extraModule, '#ffffff', 'modules 多余键保留');
  const cfg = await store.load();
  assert.equal(cfg.ui.otherUiKey, 'keep-ui', 'ui 顶层多余键保留');
});

test('H3-4 saveConfig 保存 ui.theme 后，新 store/新进程 load 一致（持久化）', async (t) => {
  const dir = await tempDir(t);
  const store = createStore(dir);
  await store.init();
  const base = await store.load();
  await store.saveConfig({
    ...base,
    ui: {
      theme: {
        preset: 'sage',
        mode: 'auto',
        accent: null,
        modules: { deepseek: '#00ff00' }
      }
    }
  });

  const reloaded = await createStore(dir).load();
  assert.equal(reloaded.ui.theme.preset, 'sage');
  assert.equal(reloaded.ui.theme.mode, 'auto');
  assert.equal(reloaded.ui.theme.accent, null);
  assert.equal(reloaded.ui.theme.modules.deepseek, '#00ff00');
  assert.equal(reloaded.ui.theme.modules.codex, null);
});

test('H3-5 深拷贝隔离：修改已加载的 ui.theme 不污染默认值/其它 store', async (t) => {
  const dir = await tempDir(t);
  const store = createStore(dir);
  await store.init();
  const first = await store.load();
  first.ui.theme.modules.codex = '#ff0000';
  first.ui.theme.preset = 'sunset';

  assert.equal(DEFAULT_UI_THEME.modules.codex, null, '默认常量必须保持不可变');
  assert.equal(DEFAULT_UI_THEME.preset, 'claude');
  assert.equal(DEFAULT_CONFIG.ui.theme.modules.codex, null);

  // 未保存的修改不能影响磁盘，也不能影响另一个 store 的加载结果
  const second = await createStore(dir).load();
  assert.equal(second.ui.theme.modules.codex, null);
  assert.equal(second.ui.theme.preset, 'claude');

  // 第二个 store 的 theme 对象与第一个不是同一引用（防共享污染）
  const third = await store.load();
  assert.notEqual(second.ui.theme.modules, third.ui.theme.modules);
});

test('H3-6 损坏 config 恢复后仍带默认 ui.theme（G6 回归）', async (t) => {
  const dir = await tempDir(t);
  await fs.writeFile(path.join(dir, 'config.json'), '{"ui": {"theme": ', 'utf8');
  const store = createStore(dir);
  const loaded = await store.load();
  assert.equal(loaded.ui.theme.preset, 'claude');
  assert.equal(loaded.ui.theme.mode, 'light');
  assert.equal(loaded.ui.theme.modules.codex, null);
  const notices = store.getRecoveryNotices();
  assert.equal(notices.length, 1);
  assert.ok(notices[0].backupPath);
});
