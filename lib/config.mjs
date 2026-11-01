import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

export const DEFAULT_CONFIG = {
  port: 8799,
  refreshSeconds: 60,
  quotaPerUsd: 500000,
  // 'auto' = 读环境变量/Windows 系统代理；填 http://127.0.0.1:7890 可指定；空字符串表示不用代理
  proxy: 'auto',
  // 界面设置：标题可自定义；onboardingDone 记录是否已完成首次引导
  settings: {
    title: '额度一念',
    subtitle: 'Codex + DeepSeek + OpenCode Go',
    onboardingDone: false
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

async function readJson(file, fallback) {
  try {
    const raw = await fs.readFile(file, 'utf8');
    if (!raw.trim()) return clone(fallback);
    return JSON.parse(raw);
  } catch (err) {
    if (err && err.code === 'ENOENT') return clone(fallback);
    // 文件损坏（手改 JSON 写坏、磁盘截断等）：备份原文件后用默认值继续启动，
    // 不能让整个面板因为一个坏字符就打不开。
    const backup = `${file}.broken-${Date.now()}`;
    try {
      await fs.rename(file, backup);
      console.warn(`[quota-board] ${path.basename(file)} 解析失败，已备份为 ${path.basename(backup)}，本次使用默认配置：${err.message}`);
    } catch {
      console.warn(`[quota-board] ${path.basename(file)} 解析失败，本次使用默认配置：${err.message}`);
    }
    return clone(fallback);
  }
}

async function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await fs.rename(tmp, file);
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
}

export function createStore(dataDir = defaultDataDir()) {
  const configFile = path.join(dataDir, 'config.json');
  const secretsFile = path.join(dataDir, 'secrets.json');
  let cached = null;
  let cachedSecrets = null;

  async function init() {
    await fs.mkdir(dataDir, { recursive: true });
    // 初始化时就把损坏的文件修好：坏文件被备份，同时补一份可用的默认文件，
    // 这样面板能启动，用户也能在页面上重新配置。
    for (const [file, fallback] of [
      [configFile, DEFAULT_CONFIG],
      [secretsFile, {}]
    ]) {
      let exists = true;
      try {
        await fs.access(file);
      } catch {
        exists = false;
      }
      if (!exists) {
        await writeJsonAtomic(file, fallback);
        continue;
      }
      const value = await readJson(file, fallback);
      let stillExists = true;
      try {
        await fs.access(file);
      } catch {
        stillExists = false;
      }
      if (!stillExists) await writeJsonAtomic(file, value);
    }
  }

  async function load() {
    if (!cached) cached = mergeDefaults(await readJson(configFile, DEFAULT_CONFIG));
    return cached;
  }

  async function loadSecrets() {
    if (!cachedSecrets) cachedSecrets = await readJson(secretsFile, {});
    return cachedSecrets;
  }

  async function saveConfig(next) {
    const value = mergeDefaults(next);
    await writeJsonAtomic(configFile, value);
    cached = value;
    return cached;
  }

  async function saveSecrets(next) {
    await writeJsonAtomic(secretsFile, next);
    cachedSecrets = next;
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
          baseUrl: relay.baseUrl,
          userId: relay.userId || null,
          quotaPerUsd: relay.quotaPerUsd || config.quotaPerUsd || 500000,
          unit: relay.unit || 'USD',
          tokenRef: relay.tokenRef,
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
      proxy: config.proxy === undefined ? 'auto' : config.proxy,
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

  return {
    dataDir,
    configFile,
    secretsFile,
    init,
    load,
    saveConfig,
    getSecret,
    setSecret,
    sanitize
  };
}
