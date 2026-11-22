import { promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { withFileLock, LOCK_DEFAULT_TIMEOUT_MS, FILE_LOCK_TIMEOUT } from './file-lock.mjs';
import { DEFAULT_UI_THEME, MODULE_KEYS } from './theme.mjs';

/**
 * 配色契约（THEME 轮统一契约；事实来源 = lib/theme.mjs，H1 提供）。
 * config 只负责默认值持久化与深合并；preset 合法性/hex 校验/明暗派生在 lib/theme.mjs 与 /api/theme。
 */
export const UI_MODULE_KEYS = MODULE_KEYS;
export { DEFAULT_UI_THEME };

function defaultUiTheme() {
  return {
    preset: DEFAULT_UI_THEME.preset,
    mode: DEFAULT_UI_THEME.mode,
    accent: DEFAULT_UI_THEME.accent,
    modules: {
      codex: DEFAULT_UI_THEME.modules.codex,
      deepseek: DEFAULT_UI_THEME.modules.deepseek,
      opencodeGo: DEFAULT_UI_THEME.modules.opencodeGo,
      relay: DEFAULT_UI_THEME.modules.relay,
      other: DEFAULT_UI_THEME.modules.other
    }
  };
}

/**
 * 深合并 ui.theme：
 * - 老配置无 ui / 无 ui.theme → 补默认；
 * - 部分字段缺失 → 逐字段补默认（preset/mode/accent/modules）；
 * - modules 逐模块 key 合并，已知 key 缺失补 null；
 * - 多余键（theme 顶层的非契约键、modules 里的非契约键）原样保留，不影响解析。
 * 返回全新对象（不做共享引用，避免调用方修改污染 DEFAULT_UI_THEME / 其它 store）。
 */
function mergeUiTheme(rawTheme) {
  const base = defaultUiTheme();
  const input = rawTheme && typeof rawTheme === 'object' && !Array.isArray(rawTheme) ? rawTheme : {};
  const out = { ...base, ...input };
  if (out.preset === undefined || out.preset === null || out.preset === '') out.preset = base.preset;
  if (out.mode === undefined || out.mode === null || out.mode === '') out.mode = base.mode;
  if (out.accent === undefined) out.accent = base.accent;
  const rawModules =
    input.modules && typeof input.modules === 'object' && !Array.isArray(input.modules) ? input.modules : {};
  out.modules = { ...base.modules, ...rawModules };
  for (const key of UI_MODULE_KEYS) {
    if (!(key in out.modules)) out.modules[key] = base.modules[key];
  }
  return out;
}

export const DEFAULT_CONFIG = {
  port: 8799,
  refreshSeconds: 60,
  quotaPerUsd: 500000,
  // 'auto' = 读环境变量/Windows 系统代理；填 http://127.0.0.1:7890 可指定；空字符串表示不用代理
  proxy: 'auto',
  // 界面设置：标题可自定义；onboardingDone 记录是否已完成首次引导
  settings: {
    title: 'Token 使用情况',
    subtitle: 'Codex + DeepSeek + OpenCode Go',
    onboardingDone: false
  },
  // 配色自定义（THEME 轮契约）：preset/mode/accent/modules，详细校验在服务端 /api/theme。
  ui: {
    theme: defaultUiTheme()
  },
  providers: {
    codex: {
      enabled: true,
      authPath: '~/.codex/auth.json',
      liveEnabled: true,
      liveName: '当前登录',
      autoArchive: true,
      accounts: []
    },
    opencodeGo: { enabled: true, subscriptions: [] },
    deepseek: { enabled: false },
    deepseekPlatform: { enabled: true },
    relays: []
  }
};

export function expandHome(p) {
  if (typeof p !== 'string' || !p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), ...p.slice(2).split(/[\\/]/));
  }
  return p;
}

export function defaultDataDir() {
  return process.env.QUOTA_BOARD_DATA
    ? path.resolve(process.env.QUOTA_BOARD_DATA)
    : path.resolve('data');
}

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function mergeDefaults(config) {
  const out = { ...clone(DEFAULT_CONFIG), ...(config || {}) };
  out.providers = {
    ...clone(DEFAULT_CONFIG.providers),
    ...((config && config.providers) || {})
  };
  out.settings = {
    ...clone(DEFAULT_CONFIG.settings),
    ...((config && config.settings) || {})
  };
  // 配色配置深合并：老配置无 ui 时补默认；部分字段缺失时补全；多余键原样保留。
  out.ui = { ...clone(DEFAULT_CONFIG.ui), ...((config && config.ui) || {}) };
  out.ui.theme = mergeUiTheme(config && config.ui ? config.ui.theme : null);
  out.providers.codex = {
    ...DEFAULT_CONFIG.providers.codex,
    ...((config && config.providers && config.providers.codex) || {})
  };
  out.providers.opencodeGo = {
    ...DEFAULT_CONFIG.providers.opencodeGo,
    ...((config && config.providers && config.providers.opencodeGo) || {})
  };
  if (!Array.isArray(out.providers.opencodeGo.subscriptions)) out.providers.opencodeGo.subscriptions = [];
  if (!Array.isArray(out.providers.relays)) out.providers.relays = [];
  return out;
}

/**
 * 配置文件写入失败（临时文件写失败 / rename 重试后仍失败）。
 * 带 status 便于服务端映射 409/500；message 只含文件名与系统错误码，不含文件内容（避免令牌泄漏）。
 */
export class ConfigWriteError extends Error {
  constructor(file, cause, message) {
    super(message);
    this.name = 'ConfigWriteError';
    this.code = 'CONFIG_WRITE_FAILED';
    this.status = 500;
    this.file = file;
    this.cause = cause || null;
    this.retryable = true;
  }
}

function ioFailureLabel(error, fallback) {
  const code = error?.code;
  return typeof code === 'string' && /^E[A-Z0-9]{2,12}$/.test(code) ? code : fallback;
}

function configWriteError(file, cause) {
  const reason = cause?.code === FILE_LOCK_TIMEOUT
    ? '文件锁超时（可能有另一个进程正在写）'
    : ioFailureLabel(cause, '写入失败');
  return new ConfigWriteError(
    file,
    cause,
    '配置文件写入失败：' + path.basename(file) + '（' + reason + '）。本次修改未生效，请重试'
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function queueKey(file) {
  try {
    return path.resolve(String(file || '')).toLowerCase();
  } catch {
    return String(file || '');
  }
}

// 进程内按绝对路径串行：config/secrets 的所有写入共用同一个队列（模块级）。
// 这样并发 saveConfig/saveSecrets/init 修复不会互相 rename 竞争（Windows EPERM/ENOENT）。
const writeQueues = new Map();

function runSerialized(file, task) {
  const key = queueKey(file);
  const previous = writeQueues.get(key) || Promise.resolve();
  const run = previous.catch(() => {}).then(task);
  const tail = run.catch(() => {});
  writeQueues.set(key, tail);
  tail.then(() => {
    if (writeQueues.get(key) === tail) writeQueues.delete(key);
  });
  return run;
}

async function removeIfExists(fsImpl, file) {
  try {
    await fsImpl.unlink(file);
  } catch {
    /* 清理失败不掩盖原始错误 */
  }
}

// rename 遇到 Windows 文件占用/杀软扫描/其它进程 rename 时重试；首次 + 3 次退避。
const WRITE_RETRY_DELAYS = [0, 40, 120, 250];
const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOENT']);

async function uniqueBackupPath(file, tag, fsImpl) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let candidate = file + '.' + tag + '-' + stamp;
  for (let i = 1; i <= 50; i += 1) {
    try {
      await fsImpl.access(candidate);
      candidate = file + '.' + tag + '-' + stamp + '-' + i;
    } catch {
      break;
    }
  }
  return candidate;
}

/**
 * 损坏文件先备份再重建（不静默覆盖用户数据）：
 * - 主备份：<file>.corrupt-<ISO 时间戳>（保留原始字节）；
 * - 兼容副本：<file>.broken-<ts>（旧版本备份名，best-effort，失败不影响主备份）；
 * - Windows 上 rename 可能被占用，退化为「读原文件 → 写备份 → 删原文件」。
 */
async function backupCorruptFile(file, fsImpl) {
  const backup = await uniqueBackupPath(file, 'corrupt', fsImpl);
  try {
    await fsImpl.rename(file, backup);
  } catch (renameError) {
    try {
      const raw = await fsImpl.readFile(file, 'utf8');
      await fsImpl.writeFile(backup, raw, 'utf8');
      await removeIfExists(fsImpl, file);
    } catch {
      return { backupPath: null, error: renameError };
    }
  }
  try {
    const raw = await fsImpl.readFile(backup, 'utf8');
    await fsImpl.writeFile(file + '.broken-' + Date.now(), raw, 'utf8');
  } catch {
    /* 兼容副本失败不影响主备份 */
  }
  return { backupPath: backup, error: null };
}

async function readJson(file, fallback, fsImpl = fs, onRecovered = null) {
  try {
    const raw = await fsImpl.readFile(file, 'utf8');
    if (!raw.trim()) return clone(fallback);
    return JSON.parse(raw);
  } catch (err) {
    if (err && err.code === 'ENOENT') return clone(fallback);
    // JSON 损坏（手改坏、磁盘截断、半写）：先备份原始文件，再由调用方用默认值重建。
    const backup = await backupCorruptFile(file, fsImpl).catch(() => ({ backupPath: null, error: err }));
    const notice = {
      file,
      backupPath: backup.backupPath,
      at: new Date().toISOString(),
      reason: 'corrupt-json',
      parseError: err instanceof SyntaxError ? 'JSON 格式无效' : ioFailureLabel(err, '无法读取文件')
    };
    console.warn(
      '[quota-board] ' +
        path.basename(file) +
        ' 解析失败' +
        (backup.backupPath ? '，已备份为 ' + path.basename(backup.backupPath) : '（备份失败）') +
        '，将用默认值重建：' +
        notice.parseError
    );
    if (typeof onRecovered === 'function') onRecovered(notice);
    return clone(fallback);
  }
}

/**
 * 原子写 JSON：
 * - 同一文件的写入串行化（进程内队列）；
 * - 临时文件名 = 目标 + pid + 随机串，避免并发同名互相覆盖；
 * - rename 成功后才算提交（onCommitted 在队列内、rename 后同步调用，调用方据此更新内存缓存）；
 * - rename 失败按退避重试；最终失败降级为可读 ConfigWriteError，并在 finally 清理临时文件；
 * - 临时文件里可能有密钥（secrets.json），任何失败路径都不允许残留。
 */
async function writeJsonAtomic(
  file,
  value,
  { fsImpl = fs, retryDelays = WRITE_RETRY_DELAYS, onCommitted = null, lockTimeoutMs = LOCK_DEFAULT_TIMEOUT_MS } = {}
) {
  const text = JSON.stringify(value, null, 2) + '\n';
  // 进程内串行队列 → 跨进程文件锁 → 临时文件 + rename。锁顺序固定，避免死锁。
  return runSerialized(file, () =>
    withFileLock(
      file,
      async () => {
        const tmp = file + '.' + process.pid + '.' + randomBytes(8).toString('hex') + '.tmp';
        let renamed = false;
        try {
          try {
            await fsImpl.writeFile(tmp, text, 'utf8');
          } catch (err) {
            throw configWriteError(file, err);
          }
          let lastError = null;
          for (const delay of retryDelays) {
            if (delay > 0) await sleep(delay);
            try {
              await fsImpl.rename(tmp, file);
              renamed = true;
              break;
            } catch (err) {
              lastError = err;
              const code = err && err.code;
              if (!RETRYABLE_RENAME_CODES.has(code)) break;
            }
          }
          if (!renamed) throw configWriteError(file, lastError);
          if (typeof onCommitted === 'function') onCommitted();
          return { path: file, bytes: Buffer.byteLength(text, 'utf8') };
        } finally {
          if (!renamed) await removeIfExists(fsImpl, tmp);
        }
      },
      { timeoutMs: lockTimeoutMs }
    ).catch((err) => {
      if (err && err.code === FILE_LOCK_TIMEOUT) throw configWriteError(file, err);
      throw err;
    })
  );
}


export function createStore(dataDir = defaultDataDir(), { fsImpl = fs, lockTimeoutMs = LOCK_DEFAULT_TIMEOUT_MS } = {}) {
  const configFile = path.join(dataDir, 'config.json');
  const secretsFile = path.join(dataDir, 'secrets.json');
  let cached = null;
  let cachedSecrets = null;
  const recoveryNotices = [];

  function recordRecovery(notice) {
    recoveryNotices.push(notice);
  }

  /** 损坏恢复：备份已完成，这里负责用默认值重建并记录警告（重建失败不阻断启动）。 */
  async function rebuildIfRecovered(file, value) {
    const notice = recoveryNotices.find((item) => item.file === file && !item.rebuilt);
    if (!notice) return;
    try {
      await writeJsonAtomic(file, value, { fsImpl, lockTimeoutMs });
      notice.rebuilt = true;
    } catch (err) {
      notice.rebuildError = ioFailureLabel(err, '无法写入本地配置');
      console.warn('[quota-board] ' + path.basename(file) + ' 重建失败：' + notice.rebuildError);
    }
  }

  async function init() {
    await fsImpl.mkdir(dataDir, { recursive: true });
    // 初始化时就把损坏的文件修好：坏文件被备份，同时补一份可用的默认文件，
    // 这样面板能启动，用户也能在页面上重新配置。
    for (const [file, fallback] of [
      [configFile, DEFAULT_CONFIG],
      [secretsFile, {}]
    ]) {
      let exists = true;
      try {
        await fsImpl.access(file);
      } catch {
        exists = false;
      }
      if (!exists) {
        await writeJsonAtomic(file, fallback, { fsImpl, lockTimeoutMs });
        continue;
      }
      const value = await readJson(file, fallback, fsImpl, recordRecovery);
      let stillExists = true;
      try {
        await fsImpl.access(file);
      } catch {
        stillExists = false;
      }
      if (!stillExists) {
        await writeJsonAtomic(file, value, { fsImpl, lockTimeoutMs });
        const notice = recoveryNotices.find((item) => item.file === file && !item.rebuilt);
        if (notice) notice.rebuilt = true;
      }
    }
  }

  async function load() {
    if (!cached) {
      cached = mergeDefaults(await readJson(configFile, DEFAULT_CONFIG, fsImpl, recordRecovery));
      await rebuildIfRecovered(configFile, cached);
    }
    return cached;
  }

  async function loadSecrets() {
    if (!cachedSecrets) {
      cachedSecrets = await readJson(secretsFile, {}, fsImpl, recordRecovery);
      await rebuildIfRecovered(secretsFile, cachedSecrets);
    }
    return cachedSecrets;
  }

  async function saveConfig(next) {
    const merged = mergeDefaults(next);
    // 只有 rename 成功后才更新内存缓存：写失败时缓存/磁盘保持一致（不会出现"接口 500 但内存已生效"）。
    await writeJsonAtomic(configFile, merged, { fsImpl, lockTimeoutMs, onCommitted: () => { cached = merged; } });
    return cached;
  }

  async function saveSecrets(next) {
    // 同上：先落盘、rename 成功后才替换内存缓存。
    await writeJsonAtomic(secretsFile, next, { fsImpl, lockTimeoutMs, onCommitted: () => { cachedSecrets = next; } });
    return cachedSecrets;
  }

  /** 令牌读取：环境变量优先，其次本地 secrets.json。 */
  async function getSecret(name) {
    if (!name) return null;
    const fromEnv = process.env[name];
    if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv.trim();
    const secrets = await loadSecrets();
    const value = secrets[name];
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }

  async function setSecret(name, value) {
    const secrets = { ...(await loadSecrets()) };
    if (value === null || value === undefined || value === '') delete secrets[name];
    else secrets[name] = String(value);
    await saveSecrets(secrets);
  }

  async function sanitize() {
    const config = await load();
    const relays = await Promise.all(
      config.providers.relays.map(async (relay) => {
        const hasToken = Boolean(await getSecret(relay.tokenRef));
        return {
          id: relay.id,
          name: relay.name,
          type: relay.type,
          quotaPerUsd: relay.quotaPerUsd || config.quotaPerUsd || 500000,
          unit: relay.unit || 'USD',
          hasToken
        };
      })
    );
    const opencodeGoConfig = config.providers.opencodeGo || {};
    const opencodeGoSubscriptions = await Promise.all(
      (opencodeGoConfig.subscriptions || []).map(async (sub) => ({
        id: sub.id,
        name: sub.name,
        provider: sub.provider || 'opencode-go',
        keyRef: sub.keyRef || null,
        hasKey: Boolean(sub.keyRef && (await getSecret(sub.keyRef)))
      }))
    );
    const settings = {
      title: (config.settings && config.settings.title) || DEFAULT_CONFIG.settings.title,
      subtitle: (config.settings && config.settings.subtitle) || DEFAULT_CONFIG.settings.subtitle,
      onboardingDone: Boolean(config.settings && config.settings.onboardingDone)
    };
    return {
      port: config.port,
      refreshSeconds: config.refreshSeconds,
      quotaPerUsd: config.quotaPerUsd,
      settings,
      providers: {
        codex: { enabled: config.providers.codex.enabled !== false, authPath: config.providers.codex.authPath },
        opencodeGo: {
          enabled: config.providers.opencodeGo.enabled !== false,
          subscriptions: opencodeGoSubscriptions
        },
        deepseek: { enabled: config.providers.deepseek.enabled !== false },
        deepseekPlatform: { enabled: (config.providers.deepseekPlatform || {}).enabled !== false },
        relays
      },
      paths: { dataDir, configFile, secretsFile }
    };
  }

  function getRecoveryNotices() {
    return recoveryNotices.slice();
  }

  return {
    dataDir,
    configFile,
    secretsFile,
    init,
    load,
    saveConfig,
    getSecret,
    setSecret,
    sanitize,
    /** 损坏恢复记录（file/backupPath/at/reason/rebuilt），供服务端/诊断展示。 */
    getRecoveryNotices
  };
}
