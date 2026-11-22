import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { expandHome } from './config.mjs';
import { assessCodexAuth, readCodexAuth } from './codex-oauth.mjs';

/**
 * 当前 Codex 登录态（~/.codex/auth.json）。切换账号时这个文件会被覆盖，
 * 面板会在每次成功查询后自动把当前登录态归档到 data/codex-accounts/。
 */
export function liveCodexAccount(config) {
  const codex = (config && config.providers && config.providers.codex) || {};
  if (codex.liveEnabled === false) return null;
  const authPath =
    (typeof codex.liveAuthPath === 'string' && codex.liveAuthPath.trim()) ||
    (typeof codex.authPath === 'string' && codex.authPath.trim()) ||
    '~/.codex/auth.json';
  const name = typeof codex.liveName === 'string' && codex.liveName.trim() ? codex.liveName.trim() : '当前登录';
  return { id: 'codex-live', name, authPath, live: true };
}

/** 已归档的 Codex 账户列表（providers.codex.accounts）。 */
export function archivedCodexAccounts(config) {
  const codex = (config && config.providers && config.providers.codex) || {};
  const accounts = Array.isArray(codex.accounts) ? codex.accounts : [];
  return accounts
    .filter((account) => account && typeof account.authPath === 'string' && account.authPath.trim())
    .map((account, index) => ({
      id: account.id || `codex-${index + 1}`,
      name: account.name || `账户 ${index + 1}`,
      authPath: account.authPath.trim(),
      // 托管账号（设备码登录创建、独立 CODEX_HOME）才允许自动续期；
      // 旧归档账号没有这些字段，行为完全不变。
      kind: account.kind === 'managed' ? 'managed' : 'archived',
      managed: account.managed === true || account.kind === 'managed',
      autoRefresh: account.autoRefresh === true,
      codexHome: typeof account.codexHome === 'string' && account.codexHome.trim() ? account.codexHome.trim() : null
    }));
}

/** 判断一个文件是否是有效的 Codex/ChatGPT 登录态（只读，不加载 token 内容到返回值）。 */
export async function inspectCodexAuthFile(authPath) {
  const file = expandHome(authPath);
  try {
    const json = JSON.parse(await fs.readFile(file, 'utf8'));
    const token = json && json.tokens && json.tokens.access_token;
    return {
      exists: true,
      valid: Boolean(token),
      mode: (json && json.auth_mode) || null
    };
  } catch {
    return { exists: false, valid: false, mode: null };
  }
}

/**
 * 登录态健康状态：供服务端/UI 展示"令牌剩余多久、能否自动续期"。
 * 只返回元数据，绝不返回 token 内容。
 */
export async function readCodexAuthStatus(authPath, { now = Date.now, skewMs, maxAgeMs } = {}) {
  try {
    const auth = await readCodexAuth(expandHome(authPath));
    const options = { now: typeof now === 'function' ? now() : now };
    if (Number.isFinite(skewMs)) options.skewMs = skewMs;
    if (Number.isFinite(maxAgeMs)) options.maxAgeMs = maxAgeMs;
    const assess = assessCodexAuth(auth, options);
    return {
      exists: true,
      valid: assess.hasAccessToken,
      mode: typeof auth.auth_mode === 'string' ? auth.auth_mode : null,
      accountId: assess.accountId,
      expiresAt: assess.accessTokenExpiresAt ? assess.accessTokenExpiresAt.toISOString() : null,
      expiresInMs: assess.expiresInMs,
      expired: assess.expired,
      canRefresh: assess.hasRefreshToken,
      needsRefresh: assess.needsRefresh,
      reason: assess.reason
    };
  } catch {
    return {
      exists: false,
      valid: false,
      mode: null,
      accountId: null,
      expiresAt: null,
      expiresInMs: null,
      expired: false,
      canRefresh: false,
      needsRefresh: false,
      reason: 'missing'
    };
  }
}

/** 该账户是否允许自动续期：只有 managed 账号、且未显式关闭 autoRefresh；live 一律 false。 */
export function codexAccountAllowsRefresh(account) {
  if (!account || account.live === true) return false;
  const managed = account.managed === true || account.kind === 'managed';
  return managed && account.autoRefresh !== false;
}

/** authPath 是否就是 live 登录态（realpath 小写比对，用于"绝不刷新 live"的双保险）。 */
export function isLiveAuthPath(authPath, config) {
  const live = liveCodexAccount(config);
  if (!live || !live.authPath) return false;
  try {
    return (
      path.resolve(expandHome(authPath)).toLowerCase() ===
      path.resolve(expandHome(live.authPath)).toLowerCase()
    );
  } catch {
    return false;
  }
}

/** 读取 Codex 登录态里的 account_id，仅用于服务端去重，不对外返回。 */
export async function readCodexAccountId(authPath) {
  const file = expandHome(authPath);
  try {
    const json = JSON.parse(await fs.readFile(file, 'utf8'));
    const id = json && json.tokens && json.tokens.account_id;
    return typeof id === 'string' && id.trim() ? id.trim() : null;
  } catch {
    return null;
  }
}

function homeAbbrev(target, home) {
  const resolved = path.resolve(target);
  const homeResolved = path.resolve(home);
  const lower = resolved.toLowerCase();
  const homeLower = homeResolved.toLowerCase();
  if (lower === homeLower) return '~';
  if (lower.startsWith(homeLower + path.sep.toLowerCase())) {
    return '~' + resolved.slice(homeResolved.length).split(path.sep).join('/');
  }
  return resolved;
}

function nameFromFile(file) {
  const base = path.basename(file, path.extname(file));
  const cleaned = base.replace(/[-_ ]?(auth|token|credential|login|account)/gi, '').trim();
  if (!cleaned || /^(auth|codex|openai)$/i.test(base)) return '';
  return cleaned;
}

async function walkJsonFiles(dir, depth, out) {
  if (depth < 0) return;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'sessions' || entry.name === 'log') continue;
      await walkJsonFiles(full, depth - 1, out);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.json')) {
      out.push(full);
    }
  }
}

/**
 * 扫描本机常见的 Codex auth.json 位置，返回候选账户文件。
 * 只读取“是否存在 access_token”，不返回任何 token 内容。
 */
export async function scanCodexAuthFiles({ home = os.homedir(), extraDirs = [], limit = 20 } = {}) {
  const directories = [
    { dir: path.join(home, '.codex'), allJson: false },
    { dir: path.join(home, '.codex', 'accounts'), allJson: true },
    { dir: path.join(home, '.codex', 'codextop', 'auth_list'), allJson: true },
    { dir: path.join(home, '.config', 'codex'), allJson: true },
    { dir: path.join(home, '.cli-proxy-api'), allJson: true },
    ...extraDirs.map((dir) => ({ dir, allJson: true }))
  ];

  const seen = new Set();
  const candidates = [];

  async function consider(fullPath) {
    const resolved = path.resolve(fullPath).toLowerCase();
    if (seen.has(resolved)) return;
    seen.add(resolved);
    const info = await inspectCodexAuthFile(fullPath);
    if (!info.valid) return;
    let mtime = null;
    try {
      mtime = (await fs.stat(fullPath)).mtime.toISOString();
    } catch {
      /* ignore */
    }
    candidates.push({
      path: homeAbbrev(fullPath, home),
      fullPath,
      nameGuess: nameFromFile(fullPath) || 'Codex 账户',
      mode: info.mode,
      mtime
    });
  }

  for (const { dir, allJson } of directories) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.json')) continue;
      if (!allJson && !/auth/i.test(entry.name)) continue;
      await consider(path.join(dir, entry.name));
    }
  }

  // 兜底：~/.codex 与 ~/.config/codex 下最多 3 层深度的其它 .json（例如手工备份）
  const extraRoots = [path.join(home, '.codex'), path.join(home, '.config', 'codex')];
  const nested = [];
  for (const root of extraRoots) {
    await walkJsonFiles(root, 3, nested);
  }
  for (const file of nested.slice(0, 300)) {
    await consider(file);
  }

  return candidates
    .sort((a, b) => String(b.mtime || '').localeCompare(String(a.mtime || '')))
    .slice(0, limit);
}
