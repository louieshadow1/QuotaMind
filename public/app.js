import { buildGoQuotaEstimate, firstFullGoCycleDay, readGoWorkspaceCosts } from './go-quota-estimate.js';

const cardsEl = document.querySelector('#cards');
const usageCardsEl = document.querySelector('#usage-cards');
const usageUpdatedEl = document.querySelector('#usage-updated');
const dailyRowsEl = document.querySelector('#daily-rows');
const dailyUpdatedEl = document.querySelector('#daily-updated');
const updatedEl = document.querySelector('#updated');
const countdownEl = document.querySelector('#countdown');
const refreshBtn = document.querySelector('#refresh');
const autoEl = document.querySelector('#auto');
const bannerEl = document.querySelector('#banner');
const addForm = document.querySelector('#add-form');
const addResult = document.querySelector('#add-result');
const relayType = document.querySelector('#relay-type');
const rowNewapi = document.querySelector('#row-newapi');
const goForm = document.querySelector('#go-form');
const goResult = document.querySelector('#go-result');
const goList = document.querySelector('#go-list');
const deepseekPlatformForm = document.querySelector('#deepseek-platform-form');
const deepseekPlatformResult = document.querySelector('#deepseek-platform-result');
const deepseekPlatformClear = document.querySelector('#deepseek-platform-clear');
const dataDirEl = document.querySelector('#data-dir');
const codexList = document.querySelector('#codex-list');
const codexForm = document.querySelector('#codex-form');
const codexScan = document.querySelector('#codex-scan');
const codexResult = document.querySelector('#codex-result');
const codexCandidates = document.querySelector('#codex-candidates');
const deviceLoginBody = document.querySelector('#device-login-body');
const deviceLoginState = document.querySelector('#device-login-state');
const deviceLoginDevice = document.querySelector('#device-login-device');
const deviceLoginLink = document.querySelector('#device-login-link');
const deviceLoginCode = document.querySelector('#device-login-code');
const deviceLoginCountdown = document.querySelector('#device-login-countdown');
const deviceLoginStart = document.querySelector('#device-login-start');
const deviceLoginName = document.querySelector('#device-login-name');
const deviceLoginCopy = document.querySelector('#device-login-copy');
const deviceLoginCancel = document.querySelector('#device-login-cancel');
const DEVICE_LOGIN_PATH = '/api/codex/device-login';
const DEVICE_LOGIN_TERMINAL = ['success', 'failed', 'expired', 'cancelled'];
let deviceLoginSession = null;
let deviceLoginTimer = null;

const state = {
  data: null,
  usage: null,
  dailyData: null,
  goModels: null,
  config: null,
  loading: false,
  auto: true,
  nextAt: 0,
  windowExpand: new Set()
};
/* ── H4 主题：配色自定义（应用 / 交互 / 缓存）──────────────────────────
   契约：GET/PUT /api/theme → {presets,current,vars,warnings}；
   config.ui.theme = {preset, mode, accent, modules:{codex,deepseek,opencodeGo,relay,other}}。
   后端 lib/theme.mjs 是事实来源，这里保留一份最小 resolver 用于「本地即时预览/离线缓存」。 */
const THEME_CACHE_KEY = 'qb-theme-cache';
const THEME_PENDING_KEY = 'qb-theme-pending';
const THEME_MODULE_KEYS = ['codex', 'deepseek', 'opencodeGo', 'relay', 'other'];
const THEME_MODULE_VARS = {
  codex: '--mod-codex',
  deepseek: '--mod-deepseek',
  opencodeGo: '--mod-opencode',
  relay: '--mod-relay',
  other: '--mod-other'
};
const THEME_MODES = ['light', 'dark', 'auto'];
const THEME_DEFAULT = {
  preset: 'claude',
  mode: 'light',
  accent: null,
  modules: { codex: null, deepseek: null, opencodeGo: null, relay: null, other: null }
};
const themeRuntime = {
  current: null,
  presets: [],
  vars: {},
  cached: null,
  saved: null,
  loading: true,
  loadError: ''
};
let themeSaveTimer = null;
let pendingTheme = null;
let savingTheme = null;
let pendingThemeStored = false;
let themeSavedByPage = false;
let themeSaveError = '';

function cloneTheme(theme) {
  const source = theme && typeof theme === 'object' ? theme : {};
  const modules = {};
  for (const key of THEME_MODULE_KEYS) {
    modules[key] = source.modules && isValidThemeHex(source.modules[key]) ? normalizeThemeHex(source.modules[key]) : null;
  }
  return {
    preset: typeof source.preset === 'string' && source.preset ? source.preset : THEME_DEFAULT.preset,
    mode: THEME_MODES.indexOf(source.mode) > -1 ? source.mode : THEME_DEFAULT.mode,
    accent: isValidThemeHex(source.accent) ? normalizeThemeHex(source.accent) : null,
    modules
  };
}

function isValidThemeHex(value) {
  return typeof value === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value.trim());
}

function normalizeThemeHex(value) {
  if (!isValidThemeHex(value)) return null;
  let hex = value.trim().toLowerCase();
  if (hex.length === 4) hex = '#' + hex[1] + hex[1] + hex[2] + hex[2] + hex[3] + hex[3];
  return hex;
}

function hexToRgb(hex) {
  const clean = normalizeThemeHex(hex);
  if (!clean) return null;
  return { r: parseInt(clean.slice(1, 3), 16), g: parseInt(clean.slice(3, 5), 16), b: parseInt(clean.slice(5, 7), 16) };
}

function rgbToHex(rgb) {
  const part = (value) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0');
  return '#' + part(rgb.r) + part(rgb.g) + part(rgb.b);
}

/** 两色混合，ratio 是第二个颜色的占比（0-1）。 */
function mixThemeHex(base, overlay, ratio) {
  const a = hexToRgb(base);
  const b = hexToRgb(overlay);
  if (!a || !b) return normalizeThemeHex(base) || normalizeThemeHex(overlay) || null;
  const t = Number.isFinite(Number(ratio)) ? Math.max(0, Math.min(1, Number(ratio))) : 0.5;
  return rgbToHex({ r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t });
}

function themeSystemDark() {
  try {
    return Boolean(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  } catch {
    return false;
  }
}

function themePresetById(id) {
  const presets = Array.isArray(themeRuntime.presets) ? themeRuntime.presets : [];
  return presets.find((preset) => preset && preset.id === id) || null;
}

/** 默认模块色（与 lib/theme.mjs DEFAULT_MODULE_COLORS 对齐，作为 CSS 变量缺失兜底）。 */
const DEFAULT_MODULE_COLORS = { codex: '#c96442', deepseek: '#4f7bbf', opencodeGo: '#7e8f6b', relay: '#b8892f', other: '#918b7f' };

function effectiveModeOf(theme, systemDark) {
  return theme.mode === 'auto' ? (systemDark ? 'dark' : 'light') : theme.mode;
}

/** 本地最小 resolver：preset 当前明暗基础色 + accent 派生 + 模块色（空值用模块默认色）。 */
function computeThemeVars(theme, systemDark) {
  const preset = themePresetById(theme.preset) || themePresetById(THEME_DEFAULT.preset) || (themeRuntime.presets[0] || null);
  if (!preset) return {};
  const dark = typeof systemDark === 'boolean' ? systemDark : themeSystemDark();
  const effectiveMode = effectiveModeOf(theme, dark);
  const base = Object.assign({}, preset[effectiveMode] || preset.light || {});
  if (theme.accent) {
    const bg = base['--paper'] || '#f6f4ee';
    base['--accent'] = theme.accent;
    base['--accent-ink'] = mixThemeHex(theme.accent, '#000000', 0.22);
    base['--accent-soft'] = mixThemeHex(theme.accent, bg, 0.82);
    base['--accent-wash'] = mixThemeHex(theme.accent, bg, 0.92);
  }
  for (const key of THEME_MODULE_KEYS) {
    base[THEME_MODULE_VARS[key]] = (theme.modules && theme.modules[key]) || DEFAULT_MODULE_COLORS[key];
  }
  return base;
}

function applyThemeVars(vars) {
  const root = document.documentElement;
  for (const name of Object.keys(themeRuntime.vars)) {
    if (!Object.hasOwn(vars, name)) root.style.removeProperty(name);
  }
  for (const [name, value] of Object.entries(vars || {})) {
    if (typeof value === 'string' && value) root.style.setProperty(name, value);
  }
}

function sameThemeColors(theme, source) {
  return source && theme.preset === source.preset && theme.accent === source.accent &&
    THEME_MODULE_KEYS.every((key) => theme.modules[key] === source.modules[key]);
}

/** 只有同一组配色才可以复用服务端或首屏缓存的变量。 */
function pickThemeVars(theme, effectiveMode) {
  const snapshot = themeRuntime.saved || themeRuntime.cached;
  if (snapshot && sameThemeColors(theme, snapshot.theme)) {
    const vars = effectiveMode === 'dark' ? snapshot.varsDark : snapshot.varsLight;
    if (vars && Object.keys(vars).length) return vars;
    if (effectiveMode === snapshot.effectiveMode && snapshot.vars && Object.keys(snapshot.vars).length) return snapshot.vars;
  }
  return computeThemeVars(theme, effectiveMode === 'dark');
}

function writeThemeCache(theme, runtime) {
  try {
    localStorage.setItem(
      THEME_CACHE_KEY,
      JSON.stringify({
        preset: theme.preset,
        mode: theme.mode,
        effectiveMode: runtime.effectiveMode,
        current: theme,
        vars: runtime.vars,
        varsLight: runtime.varsLight || {},
        varsDark: runtime.varsDark || {}
      })
    );
  } catch {
    /* 隐私模式/配额满：忽略缓存失败 */
  }
}

function applyTheme(theme) {
  const normalized = cloneTheme(theme);
  const effectiveMode = effectiveModeOf(normalized, themeSystemDark());
  const vars = pickThemeVars(normalized, effectiveMode);
  const snapshot = themeRuntime.saved || themeRuntime.cached;
  const matches = snapshot && sameThemeColors(normalized, snapshot.theme);
  const root = document.documentElement;
  root.dataset.preset = normalized.preset;
  root.dataset.mode = effectiveMode;
  root.style.colorScheme = effectiveMode;
  applyThemeVars(vars);
  themeRuntime.current = normalized;
  themeRuntime.vars = vars;
  writeThemeCache(normalized, {
    effectiveMode,
    vars,
    varsLight: matches ? snapshot.varsLight : {},
    varsDark: matches ? snapshot.varsDark : {}
  });
  syncThemeControls();
  refreshThemeViews();
}

function applyThemeCache() {
  try {
    const cached = JSON.parse(localStorage.getItem(THEME_CACHE_KEY) || 'null');
    const source = cached && (cached.current || (cached.preset ? cached : null));
    if (!source) return;
    const theme = cloneTheme(source);
    themeRuntime.cached = { ...cached, theme };
    applyTheme(theme);
  } catch {
    /* 无可用缓存时交由服务端主题初始化。 */
  }
}

function rememberSavedTheme(data, systemDark) {
  if (!data?.current || typeof data.current !== 'object') throw new Error('没有收到有效的主题数据');
  const theme = cloneTheme(data.current);
  if (Array.isArray(data.presets)) themeRuntime.presets = data.presets;
  themeRuntime.saved = { ...data, theme, effectiveMode: effectiveModeOf(theme, systemDark) };
  themeRuntime.loadError = '';
}

async function loadTheme() {
  const systemDark = themeSystemDark();
  try {
    const data = await api('/api/theme?systemDark=' + (systemDark ? '1' : '0'));
    rememberSavedTheme(data, systemDark);
    applyTheme(pendingTheme || themeRuntime.saved.theme);
  } catch (error) {
    themeRuntime.loadError = error.message || String(error);
  } finally {
    themeRuntime.loading = false;
    updateThemeStatus();
    void flushThemeSave();
  }
}

function themeStatusEl() {
  return document.querySelector('#theme-status');
}

function setThemeStatus(message, tone) {
  const node = themeStatusEl();
  if (!node) return;
  node.textContent = message || '';
  node.className = 'theme-status' + (tone ? ' ' + tone : '');
}

function themePresetLabel(id) {
  const preset = themePresetById(id);
  return (preset && (preset.name || preset.id)) || id || THEME_DEFAULT.preset;
}

function effectiveThemeWarnings() {
  const saved = themeRuntime.saved;
  if (!saved) return [];
  const mode = document.documentElement.dataset.mode;
  const list = mode === 'dark' ? saved.warningsDark : saved.warningsLight;
  return Array.isArray(list) ? list : Array.isArray(saved.warnings) ? saved.warnings : [];
}

function themeSummaryText() {
  const theme = themeRuntime.current || cloneTheme(THEME_DEFAULT);
  const effectiveMode = document.documentElement.dataset.mode === 'dark' ? 'dark' : 'light';
  const effectiveLabel = effectiveMode === 'dark' ? '深色' : '浅色';
  const modeText = theme.mode === 'auto' ? '跟随系统（当前' + effectiveLabel + '）' : effectiveLabel;
  return themePresetLabel(theme.preset) + ' · ' + modeText;
}

function updateThemeStatus() {
  if (pendingTheme) {
    if (themeSaveError) {
      const retry = pendingThemeStored ? '。所选配色仍待保存，重开后将重试。' : '。所选配色只保留在此页，请重新选择以重试。';
      setThemeStatus('保存失败：' + themeSaveError + retry, 'err');
    } else {
      setThemeStatus((savingTheme === pendingTheme ? '正在保存 · ' : '待保存 · ') + themeSummaryText(), '');
    }
    return;
  }
  if (themeRuntime.loading) return;
  if (themeRuntime.loadError) {
    setThemeStatus('主题读取失败：' + themeRuntime.loadError + '（使用本地配色）', 'err');
    return;
  }
  const messages = effectiveThemeWarnings()
    .map((warning) => (warning && typeof warning === 'object' ? warning.message || warning.code : String(warning || '')))
    .filter(Boolean);
  const summary = (themeSavedByPage ? '已保存 · ' : '') + themeSummaryText();
  setThemeStatus(messages.length ? summary + ' · ' + messages.join('；') : summary,
    messages.length ? 'warn' : themeSavedByPage ? 'ok' : '');
}

function syncThemeControls() {
  const theme = themeRuntime.current || cloneTheme(THEME_DEFAULT);
  const root = document.documentElement;
  const effectiveMode = root.dataset.mode === 'dark' ? 'dark' : 'light';
  const vars = themeRuntime.vars || {};
  document.querySelectorAll('#theme-mode [data-mode]').forEach((node) => {
    const active = node.dataset.mode === theme.mode;
    node.classList.toggle('active', active);
    node.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
  document.querySelectorAll('#theme-presets [data-preset]').forEach((node) => {
    const preset = themePresetById(node.dataset.preset);
    const active = node.dataset.preset === theme.preset;
    node.classList.toggle('active', active);
    node.setAttribute('aria-pressed', active ? 'true' : 'false');
    if (preset) {
      const colors = preset[effectiveMode];
      for (const key of ['paper', 'surface', 'accent', 'ink']) {
        const color = normalizeThemeHex(colors?.['--' + key]);
        if (color) node.style.setProperty('--sample-' + key, color);
      }
      const nameEl = node.querySelector('.theme-card-name');
      if (nameEl && preset.name) nameEl.textContent = preset.name;
      const descEl = node.querySelector('.theme-card-desc');
      if (descEl && preset.description) descEl.textContent = preset.description;
      node.title = preset.description ? preset.name + ' · ' + preset.description : preset.name || node.dataset.preset;
    }
  });
  const accentColor = document.querySelector('#accent-color');
  const accentDefault =
    accentColor && (effectiveMode === 'dark' ? accentColor.dataset.defaultDark : accentColor.dataset.defaultLight);
  const accentEffective = theme.accent || vars['--accent'] || accentDefault || '#c96442';
  if (accentColor) accentColor.value = accentEffective;
  const accentHex = document.querySelector('#accent-hex');
  if (accentHex) accentHex.value = theme.accent || vars['--accent'] || accentEffective;
  document.querySelectorAll('#module-colors [data-module]').forEach((row) => {
    const key = row.dataset.module;
    const input = row.querySelector('input[type="color"]');
    const inputDefault = input ? (effectiveMode === 'dark' ? input.dataset.defaultDark : input.dataset.defaultLight) : null;
    const color =
      (theme.modules && theme.modules[key]) ||
      vars[THEME_MODULE_VARS[key]] ||
      inputDefault ||
      DEFAULT_MODULE_COLORS[key] ||
      accentEffective;
    if (input) input.value = color;
    row.querySelectorAll('[data-color-hex], .module-hex, .module-color-hex, code').forEach((node) => {
      if (node !== input) node.textContent = String(color).toUpperCase();
    });
  });
  const preview = document.querySelector('#theme-preview');
  if (preview) {
    preview.dataset.preset = theme.preset;
    preview.dataset.mode = effectiveMode;
    preview.style.setProperty('--preview-accent', vars['--accent'] || '');
    for (const key of THEME_MODULE_KEYS) preview.style.setProperty(THEME_MODULE_VARS[key], vars[THEME_MODULE_VARS[key]] || DEFAULT_MODULE_COLORS[key] || '');
    preview.title = '当前：' + themeSummaryText();
  }
}

function restorePendingTheme() {
  try {
    const raw = localStorage.getItem(THEME_PENDING_KEY);
    if (!raw || raw.length > 512) return;
    const theme = JSON.parse(raw);
    if (!theme || !/^[a-z]{1,16}$/.test(theme.preset) || !THEME_MODES.includes(theme.mode)) return;
    pendingTheme = cloneTheme(theme);
    pendingThemeStored = true;
    applyTheme(pendingTheme);
    updateThemeStatus();
  } catch {
    /* 存储不可用或待办已损坏时继续正常加载。 */
  }
}

function previewAndSaveTheme(theme) {
  pendingTheme = cloneTheme(theme);
  themeSaveError = '';
  pendingThemeStored = false;
  try {
    // 先记下选择，即使关掉页面时防抖计时尚未触发，也可以重试。
    localStorage.setItem(THEME_PENDING_KEY, JSON.stringify(pendingTheme));
    pendingThemeStored = true;
  } catch {
    /* 存储不可用时仍尝试正常保存。 */
  }
  if (themeSaveTimer !== null) clearTimeout(themeSaveTimer);
  themeSaveTimer = setTimeout(() => {
    themeSaveTimer = null;
    void flushThemeSave();
  }, 300);
  applyTheme(pendingTheme);
  updateThemeStatus();
}

async function flushThemeSave() {
  if (themeRuntime.loading || savingTheme || themeSaveTimer !== null || !pendingTheme) return;
  const payload = pendingTheme;
  savingTheme = payload;
  themeSaveError = '';
  updateThemeStatus();
  const systemDark = themeSystemDark();
  try {
    const data = await api('/api/theme?systemDark=' + (systemDark ? '1' : '0'), { method: 'PUT', body: payload });
    rememberSavedTheme(data, systemDark);
  } catch (error) {
    if (pendingTheme === payload) themeSaveError = error.message || String(error);
  } finally {
    savingTheme = null;
  }
  // 只处理当前版本。期间的操作共用同一个待办，旧响应不会盖掉当前预览。
  if (pendingTheme !== payload) {
    void flushThemeSave();
    return;
  }
  if (!themeSaveError) {
    try {
      if (localStorage.getItem(THEME_PENDING_KEY) === JSON.stringify(payload)) localStorage.removeItem(THEME_PENDING_KEY);
    } catch {
      /* 留下的待办在下次打开时可以安全重试。 */
    }
    pendingTheme = null;
    themeSavedByPage = true;
    applyTheme(themeRuntime.saved.theme);
  }
  updateThemeStatus();
}

function themeAllModulesEmpty(modules) {
  return !modules || THEME_MODULE_KEYS.every((key) => !modules[key]);
}

function setThemeMode(mode) {
  if (!THEME_MODES.includes(mode)) return;
  previewAndSaveTheme({ ...cloneTheme(themeRuntime.current), mode });
}

function selectThemePreset(presetId) {
  if (!presetId) return;
  previewAndSaveTheme({ ...THEME_DEFAULT, preset: presetId, mode: cloneTheme(themeRuntime.current).mode });
}

function setThemeAccent(value) {
  const hex = normalizeThemeHex(value);
  if (!hex) return;
  previewAndSaveTheme({ ...cloneTheme(themeRuntime.current), accent: hex, preset: 'custom' });
}

function resetThemeAccent() {
  const next = cloneTheme(themeRuntime.current);
  next.accent = null;
  next.preset = themeAllModulesEmpty(next.modules) ? 'claude' : 'custom';
  previewAndSaveTheme(next);
}

function setThemeModuleColor(key, value) {
  if (!THEME_MODULE_KEYS.includes(key)) return;
  const hex = normalizeThemeHex(value);
  if (!hex) return;
  const next = cloneTheme(themeRuntime.current);
  next.modules[key] = hex;
  next.preset = 'custom';
  previewAndSaveTheme(next);
}

function resetThemeModuleColor(key) {
  if (!THEME_MODULE_KEYS.includes(key)) return;
  const next = cloneTheme(themeRuntime.current);
  next.modules[key] = null;
  next.preset = next.accent || !themeAllModulesEmpty(next.modules) ? 'custom' : 'claude';
  previewAndSaveTheme(next);
}

function onThemeClick(event) {
  const target = event.target && event.target.closest ? event.target : null;
  if (!target) return;
  const modeButton = target.closest('#theme-mode [data-mode]');
  if (modeButton) {
    setThemeMode(modeButton.dataset.mode);
    return;
  }
  const presetCard = target.closest('#theme-presets [data-preset]');
  if (presetCard) {
    selectThemePreset(presetCard.dataset.preset);
    return;
  }
  if (target.closest('#accent-reset')) {
    resetThemeAccent();
    return;
  }
  const moduleRow = target.closest('#module-colors [data-module]');
  if (moduleRow && target.closest('button')) {
    resetThemeModuleColor(moduleRow.dataset.module);
  }
}

function onThemeInput(event) {
  const target = event.target;
  if (!target || !target.matches) return;
  if (target.id === 'accent-color' || target.id === 'accent-hex') {
    setThemeAccent(target.value);
    return;
  }
  if (target.matches('#module-colors input[type="color"]')) {
    const row = target.closest('[data-module]');
    if (row) setThemeModuleColor(row.dataset.module, target.value);
  }
}

function refreshThemeViews() {
  try {
    if (state.usage) renderUsage(state.usage);
    if (state.dailyData) renderActiveHistoryView(state.dailyData);
    if (state.data) render();
  } catch {
    /* 主题刷新图表失败不影响页面 */
  }
}

/** 图表用色：优先 CSS 变量（主题），保留回退。 */
function themeColor(varName, fallback) {
  try {
    const value = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
    if (value) return value;
  } catch {
    /* ignore */
  }
  return fallback;
}

function moduleColor(kind, fallback) {
  if (kind === 'codex') return themeColor('--mod-codex', fallback || DEFAULT_MODULE_COLORS.codex);
  if (kind === 'deepseek') return themeColor('--mod-deepseek', fallback || DEFAULT_MODULE_COLORS.deepseek);
  if (kind === 'opencode-go' || kind === 'opencode') return themeColor('--mod-opencode', fallback || DEFAULT_MODULE_COLORS.opencodeGo);
  if (kind === 'relay') return themeColor('--mod-relay', fallback || DEFAULT_MODULE_COLORS.relay);
  return themeColor('--mod-other', fallback || DEFAULT_MODULE_COLORS.other);
}

const themeMediaQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
function onSystemThemeChange() {
  const theme = themeRuntime.current;
  if (!theme || theme.mode !== 'auto') return;
  applyTheme(theme);
  updateThemeStatus();
}

if (themeMediaQuery) {
  if (themeMediaQuery.addEventListener) themeMediaQuery.addEventListener('change', onSystemThemeChange);
  else if (themeMediaQuery.addListener) themeMediaQuery.addListener(onSystemThemeChange);
}
document.addEventListener('click', onThemeClick);
document.addEventListener('input', onThemeInput);
document.addEventListener('change', onThemeInput);
window.addEventListener('online', flushThemeSave);

// 尽早应用缓存主题（DOM 已解析、脚本在 body 尾部），再异步拉取服务端主题。
applyThemeCache();
restorePendingTheme();


function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const base = (payload && payload.error) || 'HTTP ' + response.status + (response.statusText ? ' ' + response.statusText : '');
    const hint =
      response.status === 405
        ? '（该接口不支持此操作）'
        : response.status === 400
          ? ''
          : response.status >= 500
            ? '（服务端内部错误，稍后重试）'
            : '';
    throw new Error(base + hint);
  }
  return payload;
}

function clampPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

function levelClass(percent) {
  if (percent === null || percent === undefined) return '';
  if (percent >= 80) return 'danger';
  if (percent >= 50) return 'warn';
  return '';
}

function fmtMoney(value, unit) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  const n = Math.abs(Number(value)) >= 1000 ? Number(value).toFixed(0) : Number(value).toFixed(2);
  if (unit === 'USD') return `$${n}`;
  if (unit === 'CNY') return `¥${n}`;
  if (unit === 'CREDITS') return `${n} 积分`;
  return `${n} ${unit || ''}`.trim();
}

function fmtPercent(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  return `${Math.round(Number(value))}%`;
}

// F7：超长名称展示截断（title 保留全文）与额度百分比 clamp（0-100）
const DISPLAY_NAME_LIMIT = 48;
const PLAN_NAME_LIMIT = 24;

function truncateText(value, max) {
  const text = String(value === null || value === undefined ? '' : value);
  const limit = Number.isFinite(Number(max)) && Number(max) > 0 ? Math.floor(Number(max)) : DISPLAY_NAME_LIMIT;
  return text.length > limit ? text.slice(0, Math.max(1, limit - 1)) + '…' : text;
}

function setDisplayText(node, value, max) {
  if (!node) return node;
  const full = String(value === null || value === undefined ? '' : value);
  node.textContent = truncateText(full, max);
  if (node.textContent !== full && full) node.title = full;
  return node;
}

function clampQuotaPercent(value) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, n));
}

function fmtQuotaPercent(value) {
  const n = clampQuotaPercent(value);
  return n === null ? '—' : Math.round(n) + '%';
}

/** 路径展示：把本机用户目录缩成 ~，避免页面/接口路径泄露完整用户名。 */
function shortenDisplayPath(value) {
  const text = String(value || '');
  if (!text) return '';
  if (text.indexOf('~') === 0) return text;
  let match = text.match(/^[A-Za-z]:[\\/]Users[\\/][^\\/]+[\\/](.*)$/);
  if (match) return '~\\' + match[1];
  match = text.match(/^[A-Za-z]:[\\/]Documents and Settings[\\/][^\\/]+[\\/](.*)$/i);
  if (match) return '~\\' + match[1];
  match = text.match(/^(?:[A-Za-z]:)?[\\/]home[\\/][^\\/]+[\\/](.*)$/);
  if (match) return '~/' + match[1];
  return text;
}

function fmtTokens(value) {
  const n = Number(value) || 0;
  if (n >= 1e8) return `${(n / 1e8).toFixed(2)} 亿`;
  if (n >= 1e4) return `${(n / 1e4).toFixed(1)} 万`;
  return String(n);
}

function usageTile({ name, total, cost, detail, badge, className, title }) {
  const card = el('article', `usage-card ${className || ''}`.trim());
  if (title) card.title = title;
  const top = el('div', 'usage-top');
  top.append(el('span', 'usage-name', name));
  if (badge) top.append(el('span', 'usage-badge', badge));
  card.append(top);
  const totalEl = el('div', 'usage-total', fmtTokens(total));
  totalEl.append(el('small', '', 'tokens'));
  card.append(totalEl);
  const costEl = el('div', `usage-cost ${cost && cost.muted ? 'muted' : ''}`.trim(), cost ? cost.text : '');
  card.append(costEl);
  card.append(el('div', 'usage-detail', detail));
  return card;
}

// F7/H4：图表取色走主题变量（--mod-*），未配置时回退 Claude 土色系
function usagePalette() {
  const codex = moduleColor('codex', '#c15f3c');
  const deepseek = moduleColor('deepseek', '#bb8a52');
  const opencode = moduleColor('opencode', '#7e8f6b');
  return {
    codex: [
      [codex, mixThemeHex(codex, '#ffffff', 0.26) || codex],
      [mixThemeHex(codex, '#000000', 0.2) || codex, codex],
      [deepseek, mixThemeHex(deepseek, '#ffffff', 0.26) || deepseek]
    ],
    deepseek: [deepseek, mixThemeHex(deepseek, '#ffffff', 0.26) || deepseek],
    opencode: [opencode, mixThemeHex(opencode, '#ffffff', 0.2) || opencode]
  };
}

function usageBreakdownItem(name, value, metaLeft, share, palette, exactTokens) {
  const item = el('div', 'ub-item');
  if (exactTokens !== undefined && exactTokens !== null && Number.isFinite(Number(exactTokens))) {
    item.title = `精确值：${Number(exactTokens).toLocaleString('en-US')} tokens`;
  }
  const color = palette[0];
  item.style.setProperty('--ub-color', color);
  item.style.setProperty('--ub-color2', palette[1] || color);
  item.style.setProperty('--ub-tint', `${color}22`);
  item.append(el('div', 'ub-name', name));
  item.append(el('div', 'ub-value', value == null ? '—' : fmtTokens(value)));
  const meta = el('div', 'ub-meta');
  meta.append(el('span', '', metaLeft));
  meta.append(el('span', 'ub-share', `${share.toFixed(1)}%`));
  item.append(meta);
  const bar = el('div', 'ub-bar');
  const fill = el('i');
  fill.style.width = `${Math.min(100, share)}%`;
  bar.append(fill);
  item.append(bar);
  return item;
}

const usageShareEl = document.querySelector('#usage-share-chart');
const usageShareContent = document.querySelector('#usage-share-content');
const usageShareList = document.querySelector('#usage-share-list');
const usageShareEmpty = document.querySelector('#usage-share-empty');
let usageShareChart = null;

new ResizeObserver(() => {
  if (usageShareEl.clientWidth && usageShareEl.clientHeight) usageShareChart?.resize();
}).observe(usageShareEl);

function disposeUsageShare() {
  usageShareChart?.dispose();
  usageShareChart = null;
}

function renderUsageShare(sources, totalTokens) {
  const parts = sources.filter(({ value }) => value > 0);
  usageShareContent.hidden = parts.length === 0;
  usageShareEmpty.hidden = parts.length > 0;
  usageShareEmpty.textContent = '暂无已记录的用量';
  document.querySelector('#usage-share-total').textContent = fmtTokens(totalTokens);
  usageShareList.replaceChildren(...parts.map(({ name, value, color }) => {
    const row = el('li', 'usage-share-item');
    const dot = el('span', 'usage-share-dot');
    dot.style.backgroundColor = color;
    const details = el('div', 'usage-share-details');
    details.append(el('span', 'usage-share-name', name), el('span', 'usage-share-value', fmtTokens(value) + ' tokens'));
    row.append(dot, details, el('span', 'usage-share-percent', (value / totalTokens * 100).toFixed(1) + '%'));
    return row;
  }));

  if (!parts.length) {
    disposeUsageShare();
    return;
  }
  const echarts = echartsLib();
  if (!echarts || !usageShareEl.clientWidth || !usageShareEl.clientHeight) return;
  usageShareChart ??= echarts.init(usageShareEl, null, { renderer: 'canvas' });
  usageShareChart.setOption({
    animation: false,
    tooltip: {
      trigger: 'item',
      backgroundColor: themeColor('--surface', '#fffefb'),
      borderColor: themeColor('--line', '#e4dfd2'),
      textStyle: { color: themeColor('--ink', '#1f1e1d') },
      formatter: ({ name, value }) => `${name}<br>${fmtTokens(value)} tokens · ${(value / totalTokens * 100).toFixed(1)}%`
    },
    series: [{
      type: 'pie',
      radius: ['62%', '90%'],
      label: { show: false },
      labelLine: { show: false },
      data: parts.map(({ name, value, color }) => ({ name, value, itemStyle: { color } }))
    }]
  }, true);
}

function recordedTokens(channel) {
  const total = Number(channel?.tokens?.total);
  return Number.isFinite(total) && total > 0 ? total : 0;
}

function recordedGoTokens(channel, other) {
  // OpenCode 的聚合包含其它路由。按唯一来源求和，避免重复订阅重复计数。
  const providers = Object.values(channel?.providers || {});
  const aggregate = providers.length
    ? providers.reduce((sum, provider) => sum + recordedTokens(provider), 0)
    : recordedTokens(channel);
  return Math.max(0, aggregate - recordedTokens(other));
}

function renderUsage(data) {
  const overviewVisible = !usageCardsEl.closest('#usage').hidden;
  const shareVisible = !usageShareEl.closest('#total').hidden;
  if (!overviewVisible && !shareVisible) return;
  const channels = Array.isArray(data.channels) ? data.channels : [];
  const codex = channels.find((channel) => channel.id === 'codex');
  const deepseek = channels.find((channel) => channel.id === 'deepseek');
  const opencode = channels.find((channel) => channel.id === 'opencode');
  const other = channels.find((channel) => channel.id === 'opencode-other');
  const codexTokens = recordedTokens(codex);
  const deepseekTokens = recordedTokens(deepseek);
  const otherTokens = recordedTokens(other);
  const goTokens = recordedGoTokens(opencode, other);
  const palette = usagePalette();
  const otherColor = moduleColor('other', '#8c8379');
  const sources = [
    { name: 'Codex', value: codexTokens, color: palette.codex[0][0] },
    { name: 'DeepSeek', value: deepseekTokens, color: palette.deepseek[0] },
    { name: 'OpenCode Go', value: goTokens, color: palette.opencode[0] },
    { name: 'OpenCode 其它路由', value: otherTokens, color: otherColor }
  ];
  const totalTokens = sources.reduce((sum, part) => sum + part.value, 0);
  if (shareVisible) {
    renderUsageShare(sources, totalTokens);
    return;
  }
  usageCardsEl.replaceChildren();
  const card = el('article', 'usage-card total usage-summary');
  const top = el('div', 'usage-top');
  top.append(el('span', 'usage-name', '合计'), el('span', 'usage-badge', '已记录用量'));
  card.append(top);
  const totalEl = el('div', 'usage-total usage-total-big', fmtTokens(totalTokens));
  totalEl.append(el('small', '', 'tokens'));
  totalEl.title = `精确值：${Number(totalTokens).toLocaleString('en-US')} tokens（各块按亿四舍五入，逐项相加可能差 0.01）`;
  card.append(totalEl);
  const breakdown = el('div', 'usage-breakdown');
  // Codex 合成一个盒子：数值 = 两个账号累计之和（快照账号也计入），
  // 小字里拆出各账号，与 OpenCode Go「多个订阅合计」的呈现保持一致。
  const staleAccounts = [];
  if (codex) {
    const accounts = Array.isArray(codex.accounts) ? codex.accounts : [];
    for (const account of accounts) if (account.cached) staleAccounts.push(account);
    if (accounts.length) {
      const total = codexTokens;
      const split = accounts
        .map((account, index) => {
          const name = account.displayName || account.username || account.name || `账号 ${index + 1}`;
          const tail = account.cached ? '（快照）' : '';
          return `${name} ${fmtTokens(account.lifetimeTokens || 0)}${tail}`;
        })
        .join(' · ');
      breakdown.append(
        usageBreakdownItem(
          accounts.length > 1 ? `Codex（${accounts.length} 个账号合计）` : 'Codex',
          total,
          `官方累计 · ${split}`,
          totalTokens ? (total / totalTokens) * 100 : 0,
          palette.codex[0],
          total
        )
      );
    } else {
      breakdown.append(
        usageBreakdownItem(
          'Codex',
          codexTokens,
          codex.source === 'local' ? '本机会话日志' : '官方累计',
          totalTokens ? (codexTokens / totalTokens) * 100 : 0,
          palette.codex[0],
          codexTokens
        )
      );
    }
  }

  if (deepseek) {
    const value = deepseek.tokens.total;
    const archive = deepseek.archive;
    const basis = deepseek.source === 'archive'
      ? (archive ? `本机累计 · 已记录 ${archive.days} 天` : '本机归档累计')
      : deepseek.source === 'unavailable' ? '暂无已记录用量'
        : deepseek.source === 'local' ? '本机会话日志' : '旧版统计 · 重开应用后更新';
    const item = usageBreakdownItem(
      'DeepSeek',
      value,
      basis,
      totalTokens ? (deepseekTokens / totalTokens) * 100 : 0,
      palette.deepseek,
      value
    );
    if (archive?.firstDate) item.title += `\n归档范围：${archive.firstDate} 至 ${archive.lastDate}`;
    breakdown.append(item);
    if (archive?.warning) card.append(el('p', 'usage-note', archive.warning));
  }

  if (opencode) {
    const value = goTokens;
    const subs = Array.isArray(opencode.subs) ? opencode.subs : [];
    const realSubs = [...new Map(subs.filter((item) => item.provider).map((item) => [item.provider, item])).values()];
    const shortName = (name) => {
      const text = String(name || '');
      if (text.includes('谷歌')) return '谷歌';
      if (/github/i.test(text)) return 'Github';
      return text;
    };
    const split = realSubs.length > 1
      ? realSubs
          .map((item) => `${shortName(item.name)} ${fmtTokens(item.tokens.total)}`)
          .join(' · ')
      : '';
    const cost = Math.max(0, Number(opencode.costCny || 0) - Number(other?.costCny || 0));
    const metaLeft = `套餐内 ≈ ¥${cost.toFixed(2)}${split ? ` · ${split}` : ''}`;
    breakdown.append(
      usageBreakdownItem(
        realSubs.length > 1 ? `OpenCode Go（${realSubs.length} 个订阅合计）` : 'OpenCode Go',
        value,
        metaLeft,
        totalTokens ? (value / totalTokens) * 100 : 0,
        palette.opencode,
        value
      )
    );
  }
  if (other) {
    const value = otherTokens;
    breakdown.append(
      usageBreakdownItem(
        'OpenCode 其它路由',
        value,
        `未计入 Go 订阅 · 套餐外 ≈ ¥${Number(other.costCny || 0).toFixed(2)}`,
        totalTokens ? (value / totalTokens) * 100 : 0,
        [otherColor],
        value
      )
    );
  }

  if (staleAccounts.length) {
    const parts = staleAccounts
      .map(
        (account) =>
          `${account.displayName || account.username || account.name} ${fmtTokens(account.lifetimeTokens || 0)}（${new Date(account.fetchedAt).toLocaleDateString('zh-CN')} 快照）`
      )
      .join(' · ');
    card.append(
      el('div', 'usage-stale-line', `其中 ${parts}为历史快照，已计入上面的 Codex 合计`)
    );
  }

  card.append(breakdown);
  usageCardsEl.append(card);
  usageUpdatedEl.textContent = `统计于 ${new Date(data.generatedAt).toLocaleTimeString('zh-CN', { hour12: false })}`;
}
async function loadUsage(force = false) {
  try {
    const data = await api(`/api/usage${force ? '?refresh=1' : ''}`);
    const firstLoad = !state.usage;
    state.usage = data;
    renderUsage(data);
    if (firstLoad) syncInitialDailyAnchor();
    if (state.data) render();
  } catch {
    usageUpdatedEl.textContent = 'Token 统计失败';
    if (!state.usage) usageShareEmpty.textContent = '暂时无法读取用量';
  }
}

function syncInitialDailyAnchor() {
  if (location.hash !== '#daily') return;
  requestAnimationFrame(() => {
    if (location.hash === '#daily') document.querySelector('#daily').scrollIntoView({ block: 'start' });
  });
}

function fmtDateShort(date) {
  return String(date || '').slice(5).replace('-', '/');
}

// ── 每日用量：ECharts 日历热力图（Apache ECharts 5.5.1，本地 vendor）──────────
const DAILY_MODES = ['day', 'week', 'cum'];
let dailyMode = 'day';
// 每日用量的时间范围：90 天 / 1 年 / 全部（长期存档都在 data/daily-history.json）
const DAILY_RANGES = ['90', '371', 'all'];
let dailyRange = '371';
// 分渠道/分订阅热力图是否展开（记忆在 localStorage）
let dailyDetailVisible = (() => {
  try {
    return window.localStorage.getItem('qb-daily-detail') !== '0';
  } catch {
    return true;
  }
})();

// 每日用量筛选：null 表示不筛选；否则只显示集合里的 key
let dailyFilter = (() => {
  try {
    const raw = window.localStorage.getItem('qb-daily-filter');
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed) : null;
  } catch {
    return null;
  }
})();

let subGroupVisible = (() => {
  try {
    return window.localStorage.getItem('qb-daily-sub-group') !== '0';
  } catch {
    return true;
  }
})();

const dailyToggleEl = document.querySelector('#daily-toggle');
const dailyDetailCountEl = document.querySelector('#daily-detail-count');

function saveDailyFilter() {
  try {
    window.localStorage.setItem('qb-daily-filter', JSON.stringify(dailyFilter ? [...dailyFilter] : []));
  } catch {
    /* 隐私模式忽略 */
  }
}

function renderFilterPopover() {
  const list = document.querySelector('#daily-filter-list');
  const label = document.querySelector('#daily-filter-label');
  const options = (state.dailyFilterOptions || []).slice();
  if (label) {
    const total = options.length;
    const active = dailyFilter ? options.filter((item) => dailyFilter.has(item.key)).length : total;
    label.textContent = dailyFilter ? `筛选 ${active}/${total}` : '筛选';
  }
  if (!list) return;
  list.replaceChildren();
  if (!options.length) {
    list.append(el('div', 'filter-empty', '暂无可用热力图'));
    return;
  }
  let lastKind = null;
  for (const option of options) {
    if (option.kind !== lastKind) {
      lastKind = option.kind;
      list.append(el('div', 'filter-group', option.kind));
    }
    const row = el('label', 'filter-item');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = !dailyFilter || dailyFilter.has(option.key);
    input.addEventListener('change', () => {
      if (!dailyFilter) dailyFilter = new Set(options.map((item) => item.key));
      if (input.checked) dailyFilter.add(option.key);
      else dailyFilter.delete(option.key);
      // 全选等价于不筛选，存 null 更直观
      if (options.every((item) => dailyFilter.has(item.key))) dailyFilter = null;
      saveDailyFilter();
      renderFilterPopover();
      if (state.dailyData) renderDaily(state.dailyData);
    });
    row.append(input, document.createTextNode(option.name));
    list.append(row);
  }
}

const dailyFilterBtn = document.querySelector('#daily-filter');
const dailyFilterPop = document.querySelector('#daily-filter-pop');
if (dailyFilterBtn && dailyFilterPop) {
  dailyFilterBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    const open = dailyFilterPop.hidden;
    if (open) renderFilterPopover();
    dailyFilterPop.hidden = !open;
    dailyFilterBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  document.addEventListener('click', (event) => {
    if (dailyFilterPop.hidden) return;
    if (dailyFilterPop.contains(event.target) || dailyFilterBtn.contains(event.target)) return;
    dailyFilterPop.hidden = true;
    dailyFilterBtn.setAttribute('aria-expanded', 'false');
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !dailyFilterPop.hidden) {
      dailyFilterPop.hidden = true;
      dailyFilterBtn.setAttribute('aria-expanded', 'false');
    }
  });
  document.querySelector('#daily-filter-all')?.addEventListener('click', (event) => {
    event.stopPropagation();
    dailyFilter = null;
    saveDailyFilter();
    renderFilterPopover();
    if (state.dailyData) renderDaily(state.dailyData);
  });
  document.querySelector('#daily-filter-none')?.addEventListener('click', (event) => {
    event.stopPropagation();
    dailyFilter = new Set();
    saveDailyFilter();
    renderFilterPopover();
    if (state.dailyData) renderDaily(state.dailyData);
  });
}

function updateDailyToggle(count) {
  if (dailyToggleEl) {
    dailyToggleEl.setAttribute('aria-expanded', dailyDetailVisible ? 'true' : 'false');
    dailyToggleEl.classList.toggle('active', dailyDetailVisible);
    const label = document.querySelector('#daily-toggle-label');
    if (label) label.textContent = dailyDetailVisible ? '分渠道' : '仅合计';
  }
  if (dailyDetailCountEl) {
    dailyDetailCountEl.textContent = count ? `（${count} 项）` : '';
  }
  dailyToggleEl.classList.toggle('is-off', !dailyDetailVisible);
}

if (dailyToggleEl) {
  dailyToggleEl.addEventListener('click', () => {
    dailyDetailVisible = !dailyDetailVisible;
    try {
      window.localStorage.setItem('qb-daily-detail', dailyDetailVisible ? '1' : '0');
    } catch {
      /* 隐私模式下忽略 */
    }
    const detail = document.querySelector('#daily-detail');
    if (detail) detail.style.display = dailyDetailVisible ? '' : 'none';
    const count = detail ? detail.querySelectorAll('.heat-row').length : 0;
    updateDailyToggle(count);
  });
}
let dailyCharts = [];

function disposeDailyCharts() {
  for (const chart of dailyCharts) {
    try {
      chart.dispose();
    } catch {
      /* 已销毁 */
    }
  }
  dailyCharts = [];
}

function echartsLib() {
  return typeof window !== 'undefined' ? window.echarts : undefined;
}

function mondayOf(date) {
  const cursor = new Date(date + 'T00:00:00Z');
  cursor.setUTCDate(cursor.getUTCDate() - ((cursor.getUTCDay() + 6) % 7));
  return cursor.toISOString().slice(0, 10);
}

/** 按视图模式把每天的原始值换算成热力图上的值（每天 / 每周合计 / 累计）。 */
function metricValue(entry, metric) {
  if (!entry) return 0;
  if (typeof metric.getValue === 'function') return Number(metric.getValue(entry) || 0);
  return Number(entry[metric.key] || 0);
}

function dailyValues(series, metric) {
  const raw = series.map((entry) => metricValue(entry, metric));
  if (dailyMode === 'cum') {
    let acc = 0;
    return series.map((entry, index) => {
      acc += raw[index];
      return { date: entry.date, raw: raw[index], value: acc };
    });
  }
  if (dailyMode === 'week') {
    const weekTotals = new Map();
    series.forEach((entry, index) => {
      const key = mondayOf(entry.date);
      weekTotals.set(key, (weekTotals.get(key) || 0) + raw[index]);
    });
    return series.map((entry, index) => ({
      date: entry.date,
      raw: raw[index],
      value: weekTotals.get(mondayOf(entry.date)) || 0,
    }));
  }
  return series.map((entry, index) => ({ date: entry.date, raw: raw[index], value: raw[index] }));
}

const DARK_QUERY = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

function echartsTheme() {
  const dark = Boolean(DARK_QUERY && DARK_QUERY.matches);
  return dark
    ? {
        empty: 'rgba(243, 240, 233, 0.06)',
        gap: '#30302e',
        label: '#8b867c',
        tipBg: 'rgba(38, 38, 36, 0.97)',
        tipBorder: 'rgba(243, 240, 233, 0.16)',
        tipText: '#f3f0e9',
        emphasis: '#f3f0e9'
      }
    : {
        empty: 'rgba(31, 30, 29, 0.055)',
        gap: '#fffefb',
        label: '#918b7f',
        tipBg: 'rgba(255, 254, 251, 0.98)',
        tipBorder: 'rgba(31, 30, 29, 0.12)',
        tipText: '#1f1e1d',
        emphasis: '#1f1e1d'
      };
}

function providerLabel(provider) {
  const subs = (state.config && state.config.providers && state.config.providers.opencodeGo && state.config.providers.opencodeGo.subscriptions) || [];
  const hit = subs.find((sub) => sub.provider === provider);
  return hit ? hit.name : provider;
}

function accountLabel(accountId) {
  const info = accountInfo(accountId);
  if (info.name) return info.name;
  const id = String(accountId || '');
  return id.length > 10 ? id.slice(0, 8) + '…' : id || '未知账号';
}

/* ── 计划 / 窗口 / 多号同登（U2）────────────────────────────────────── */
// 计划显示名（服务端 planMeta.name 优先；缺失时按原始 plan_type 回退）
const PLAN_LABELS = { free: 'Free', plus: 'Plus', pro: 'Pro', prolite: 'Pro Lite', 'pro-lite': 'Pro Lite', go: 'Go', team: '团队', enterprise: '企业' };
// 窗口 kind → 中文标签（18000s=session / 604800s=weekly / 2592000s=monthly / 其他=custom）
const WINDOW_KIND_LABELS = { session: '5 小时', '5h': '5 小时', weekly: '每周', monthly: '每月', custom: '自定义' };

function escapeHtml(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function planDisplayName(planMeta, plan) {
  if (planMeta && planMeta.name) return String(planMeta.name);
  const key = String(plan || '').toLowerCase().replace(/[\s_-]+/g, '');
  return PLAN_LABELS[key] || (plan ? String(plan) : '');
}

function planMetaOf(provider) {
  const meta = provider && provider.planMeta;
  if (!meta || typeof meta !== 'object') return null;
  return {
    id: String(meta.id || (provider && provider.plan) || ''),
    name: String(meta.name || ''),
    tier: String(meta.tier || ''),
    expectedWindows: Array.isArray(meta.expectedWindows) ? meta.expectedWindows : [],
    note: String(meta.note || '')
  };
}

function normalizeKindName(value) {
  const raw = String(value || '').toLowerCase();
  if (raw === '5h' || raw === 'session' || raw === '5 小时') return 'session';
  if (raw === 'weekly') return 'weekly';
  if (raw === 'monthly') return 'monthly';
  if (raw === 'custom' || raw === 'generic') return 'custom';
  return '';
}

/** 服务端契约：18000→session、604800→weekly、2592000→monthly、其他→custom。 */
function windowKindForSeconds(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return null;
  if (value === 18000) return 'session';
  if (value === 604800) return 'weekly';
  if (value === 2592000) return 'monthly';
  return 'custom';
}

/** kind 优先，其次按 windowSeconds 派生，最后按旧 key 回退（兼容无 kind 的旧快照）。 */
function windowKindOf(window) {
  if (!window) return null;
  const explicit = normalizeKindName(window.kind);
  if (explicit) return explicit;
  const fromSeconds = windowKindForSeconds(window.windowSeconds);
  if (fromSeconds) return fromSeconds;
  const key = normalizeKindName(window.key);
  if (key) return key;
  return window.windowSeconds ? 'custom' : null;
}

function formatWindowSeconds(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return '';
  if (value % 86400 === 0) return value / 86400 + ' 天';
  if (value >= 3600) return Math.round(value / 3600) + ' 小时';
  return Math.round(value / 60) + ' 分钟';
}

/** 窗口中文标题：kind 优先；custom 用 label 或按秒数生成「N 天/N 小时」。 */
function windowDisplayLabel(window) {
  const kind = windowKindOf(window);
  if (kind && kind !== 'custom' && WINDOW_KIND_LABELS[kind]) return WINDOW_KIND_LABELS[kind];
  if (window && window.label) return String(window.label);
  return formatWindowSeconds(window && window.windowSeconds) || '额度窗口';
}

function windowKindLabelShort(kind) {
  return WINDOW_KIND_LABELS[kind] || (kind === 'custom' ? '自定义窗口' : String(kind || '窗口'));
}

function fallbackExpectedWindows(plan) {
  const key = String(plan || '').toLowerCase().replace(/[\s_-]+/g, '');
  if (key === 'plus') return ['session', 'weekly'];
  if (key === 'pro' || key === 'prolite') return ['weekly'];
  return [];
}

/** expectedWindows 兼容 ['5h'] / [{kind:'5h'}] / [{seconds:604800}]；无元数据时按计划本地兜底。 */
function expectedWindowKinds(planMeta, plan) {
  const fromMeta = planMeta && Array.isArray(planMeta.expectedWindows) ? planMeta.expectedWindows : null;
  const source = fromMeta || fallbackExpectedWindows(plan);
  const kinds = [];
  for (const item of source) {
    let kind = '';
    if (typeof item === 'string') kind = normalizeKindName(item);
    else if (item && typeof item === 'object') {
      kind = normalizeKindName(item.kind || item.key) || windowKindForSeconds(item.seconds || item.windowSeconds) || '';
    }
    if (kind && kinds.indexOf(kind) === -1) kinds.push(kind);
  }
  return kinds;
}

/** 克隆 index.html 里的 <template>（U1 DOM 契约）；旧页面没有模板时返回 null。 */
function cloneTemplate(id) {
  const template = document.getElementById(id);
  if (!template || !template.content) return null;
  const node = template.content.firstElementChild;
  return node ? node.cloneNode(true) : null;
}

/** 计划徽标：优先克隆 #tpl-plan-badge（details 弹层），缺失时回退普通 span。 */
function planBadgeNode({ plan, planName, meta }) {
  const name = planName || planDisplayName(meta, plan);
  if (!name) return null;
  const planId = String((meta && meta.id) || plan || '').toLowerCase();
  const tier = String((meta && meta.tier) || 'unknown');
  const expected = expectedWindowKinds(meta, plan);
  const note =
    (meta && meta.note) ||
    (expected.length ? '窗口：' + expected.map(windowKindLabelShort).join(' + ') : '按接口实际窗口显示');
  const node = cloneTemplate('tpl-plan-badge');
  if (node) {
    node.dataset.plan = planId || 'unknown';
    node.dataset.tier = tier;
    const nameEl = node.querySelector('.plan-badge-name');
    if (nameEl) setDisplayText(nameEl, name, PLAN_NAME_LIMIT);
    const popName = node.querySelector('.plan-badge-pop-name');
    if (popName) setDisplayText(popName, name, DISPLAY_NAME_LIMIT);
    const popTier = node.querySelector('.plan-badge-pop-tier');
    if (popTier) popTier.textContent = tier === 'unknown' ? '未知计划' : tier;
    const popNote = node.querySelector('.plan-badge-pop-note');
    if (popNote) setDisplayText(popNote, note, 200);
    const windowList = node.querySelector('.plan-badge-windows');
    if (windowList) {
      windowList.replaceChildren();
      if (expected.length) {
        for (const kind of expected) windowList.append(el('li', '', windowKindLabelShort(kind)));
      } else {
        windowList.append(el('li', '', '按接口实际窗口显示'));
      }
    }
    return node;
  }
  const badge = el('span', 'plan-badge', name);
  if (planId) badge.dataset.plan = planId;
  badge.dataset.tier = tier;
  badge.title = note;
  return badge;
}

function planBadge(provider, planOverride) {
  const meta = planMetaOf(provider);
  const plan = planOverride || (provider && provider.plan) || (meta && meta.id) || '';
  return planBadgeNode({ plan, planName: planDisplayName(meta, plan), meta });
}

/** 账号 id → {name, planName}：daily.codexAccounts → codexSummary → config.accounts。 */
function accountInfo(accountId) {
  const id = String(accountId || '');
  if (!id) return { name: '', planName: '' };
  const dailyAccounts = (state.dailyData && state.dailyData.codexAccounts) || [];
  const hitDaily = dailyAccounts.find((item) => item && String(item.id) === id);
  if (hitDaily) return { name: hitDaily.name || '', planName: hitDaily.planName || '' };
  const summary = (state.data && (state.data.codexSummary || state.data.accountsSummary)) || null;
  const hitSummary = summary && Array.isArray(summary.accounts) ? summary.accounts.find((item) => item && String(item.id) === id) : null;
  if (hitSummary) return { name: hitSummary.name || '', planName: hitSummary.planName || '' };
  const configAccounts = (state.config && state.config.providers && state.config.providers.codex && state.config.providers.codex.accounts) || [];
  const hitConfig = configAccounts.find((account) => account && String(account.accountId) === id);
  if (hitConfig) {
    const meta = planMetaOf(hitConfig);
    return { name: hitConfig.displayName || hitConfig.name || '', planName: planDisplayName(meta, hitConfig.plan) };
  }
  return { name: '', planName: '' };
}

/** 当前参与展示的 Codex 账号列表（codexSummary 优先，缺失时从 providers 推导）。 */
function codexAccountsForDisplay() {
  const summary = (state.data && (state.data.codexSummary || state.data.accountsSummary)) || null;
  if (summary && Array.isArray(summary.accounts) && summary.accounts.length) return summary.accounts;
  return codexProviders().map((provider) => ({
    id: provider.accountId || '',
    name: String(provider.name || '').replace(/^Codex · /, '')
  }));
}

/** name → 出现次数；同名冲突时前端追加 accountId 短码区分（数据层两个账号可能同名）。 */
function codexNameCounts() {
  if (state.nameCountsCache && state.nameCountsCache.data === state.data) return state.nameCountsCache.map;
  const map = new Map();
  for (const account of codexAccountsForDisplay()) {
    if (!account) continue;
    const name = String(account.name || '').trim();
    if (!name) continue;
    map.set(name, (map.get(name) || 0) + 1);
  }
  state.nameCountsCache = { data: state.data, map };
  return map;
}

/** 仅当同名冲突时才追加 ' · ' + id 前 8 位，避免两行看起来一模一样。 */
function disambiguateAccountName(name, accountId, counts) {
  const text = String(name || '').trim() || 'Codex 账号';
  const idText = String(accountId || '').trim();
  const map = counts || codexNameCounts();
  if (idText && (map.get(text) || 0) > 1) return text + ' · ' + idText.slice(0, 8);
  return text;
}

/** 卡片标题：'Codex · 名字' 前缀保留，名字部分按需消歧。 */
function disambiguateProviderName(provider) {
  const raw = String((provider && provider.name) || 'Codex 账户');
  const label = raw.replace(/^Codex · /, '');
  const configAccount = configCodexAccountByName(label);
  const accountId = (provider && provider.accountId) || (configAccount && configAccount.accountId) || '';
  const display = disambiguateAccountName(label, accountId);
  return raw.indexOf('Codex · ') === 0 ? 'Codex · ' + display : display;
}

function accountDetailLabel(accountId) {
  const info = accountInfo(accountId);
  const name = info.name || accountLabel(accountId);
  const display = disambiguateAccountName(name, accountId);
  return info.planName ? display + ' · ' + info.planName : display;
}

/** 当天按来源的明细行：账号（Codex）/ 订阅（OpenCode Go）。 */
function dailyDetailLines(entry, metric) {
  if (!entry) return [];
  const lines = [];
  if (metric.key === '__total') {
    const parts = [
      ['Codex', entry.codexTokens],
      ['DeepSeek', entry.deepseekTokens],
      ['OpenCode Go', entry.opencodeTokens],
      ['其它路由', entry.opencodeOtherTokens]
    ];
    for (const [name, tokens] of parts) {
      if (Number(tokens) > 0) lines.push(`${name}：${fmtTokens(tokens)}`);
    }
    return lines;
  }
  if (metric.key === 'codexTokens' && entry.codexByAccount) {
    const items = Object.entries(entry.codexByAccount)
      .map(([accountId, tokens]) => ({ accountId, tokens: Number(tokens) || 0 }))
      .filter((item) => item.tokens > 0)
      .sort((a, b) => b.tokens - a.tokens);
    const total = items.reduce((sum, item) => sum + item.tokens, 0);
    const MAX_ACCOUNT_LINES = 6;
    const shown = items.slice(0, MAX_ACCOUNT_LINES);
    for (const item of shown) lines.push(accountDetailLabel(item.accountId) + '：' + fmtTokens(item.tokens));
    if (items.length > shown.length) {
      const rest = items.slice(MAX_ACCOUNT_LINES);
      const restTotal = rest.reduce((sum, item) => sum + item.tokens, 0);
      lines.push('其余 ' + rest.length + ' 个账号：' + fmtTokens(restTotal));
    }
    if (items.length >= 2) lines.push('合计：' + fmtTokens(total));
  }
  if (metric.key === 'opencodeTokens' && entry.opencodeByProvider) {
    for (const [provider, tokens] of Object.entries(entry.opencodeByProvider)) {
      if (Number(tokens) > 0) lines.push(`${providerLabel(provider)}：${fmtTokens(tokens)}`);
    }
  }
  return lines;
}

function calendarOption({ series, metric, values, max, cell }) {
  const echarts = echartsLib();
  const first = series[0].date;
  const last = series[series.length - 1].date;
  // 0 值不画（像 GitHub 那样留空），避免整片浅色块糊住
  const data = values.filter((item) => item.value > 0).map((item) => [item.date, item.value]);
  const rawByDate = new Map(values.map((item) => [item.date, item]));
  const entryByDate = new Map(series.map((entry) => [entry.date, entry]));
  const levels = [0.16, 0.36, 0.58, 0.8, 1];
  const theme = echartsTheme();

  return {
    animationDuration: 260,
    backgroundColor: 'transparent',
    tooltip: {
      trigger: 'item',
      backgroundColor: theme.tipBg,
      borderColor: theme.tipBorder,
      borderWidth: 1,
      padding: [8, 11],
      textStyle: { color: theme.tipText, fontSize: 12 },
      extraCssText: 'border-radius:10px;box-shadow:0 12px 30px rgba(31,30,29,.16)',
      formatter: (params) => {
        const item = rawByDate.get(params.value[0]);
        if (!item) return '';
        const costText = metric.costKey
          ? ` · ≈ ¥${Number(series.find((e) => e.date === item.date)?.[metric.costKey] || 0).toFixed(2)}`
          : '';
        const details = dailyDetailLines(entryByDate.get(item.date), metric);
        const detailHtml = details.length
          ? '<br/><span style="opacity:.75">' + details.map(escapeHtml).join('<br/>') + '</span>'
          : '';
        return `<b>${item.date}</b><br/>${fmtTokens(item.raw)} tokens${costText}${detailHtml}`;
      },
    },
    calendar: {
      top: 26,
      left: 'center',
      cellSize: cell,
      range: [first, last],
      itemStyle: { color: theme.empty, borderWidth: 2, borderColor: theme.gap, borderRadius: 3 },
      splitLine: { show: false },
      yearLabel: { show: false },
      dayLabel: { firstDay: 0, nameMap: ['', '一', '', '三', '', '五', ''], color: theme.label, fontSize: 10, margin: 4 },
      monthLabel: { show: true, nameMap: 'ZH', color: theme.label, fontSize: 11, margin: 10, align: 'left' },
    },
    visualMap: {
      show: false,
      min: 0,
      max: max || 1,
      calculable: false,
      inRange: {
        color: levels.map((alpha) => {
          const value = String(metric.color).replace('#', '');
          const num = parseInt(value, 16);
          return `rgba(${(num >> 16) & 255}, ${(num >> 8) & 255}, ${num & 255}, ${alpha})`;
        }),
      },
    },
    series: [
      {
        type: 'heatmap',
        coordinateSystem: 'calendar',
        data,
        itemStyle: { borderRadius: 3, borderWidth: 2, borderColor: theme.gap },
        emphasis: { itemStyle: { borderColor: theme.emphasis, borderWidth: 1 } },
      },
    ],
  };
}

function renderDailyRow(metric, series, scrollOffset) {
  const values = dailyValues(series, metric);
  const total = series.reduce((sum, entry) => sum + metricValue(entry, metric), 0);
  const cost = metric.costKey
    ? series.reduce((sum, entry) => sum + Number(entry[metric.costKey] || 0), 0)
    : null;
  const activeDays = series.filter((entry) => metricValue(entry, metric) > 0).length;
  const peak = Math.max(0, ...series.map((entry) => metricValue(entry, metric)));
  const max = Math.max(1, ...values.map((item) => item.value));

  const row = el('div', 'daily-row heat-row');
  row.style.setProperty('--row-color', metric.color || '#c96442');
  const head = el('div', 'daily-head');
  const right = el('span', '');
  right.append(document.createTextNode(`${fmtTokens(total)} tokens`));
  if (cost !== null) right.append(el('span', 'daily-cost', ` · ≈ ¥${cost.toFixed(2)}`));
  const left = el('span', 'daily-name', metric.name);
  left.append(el('span', 'hm-meta', `活跃 ${activeDays} 天 · 峰值 ${fmtTokens(peak)}`));
  head.append(left, right);

  const weeks = Math.ceil((series.length + 6) / 7);
  const availableWidth = dailyRowsEl.clientWidth - 56;
  const cell = Math.max(11, Math.min(22, Math.floor(availableWidth / weeks)));
  const scroll = el('div', 'hm-scroll');
  scroll.dataset.metric = metric.key;
  const chartEl = el('div', 'hm-chart');
  chartEl.style.height = cell * 7 + 50 + 'px';
  chartEl.style.minWidth = weeks * cell + 26 + 'px';
  scroll.append(chartEl);
  const footer = el('div', 'hm-footer');
  const legend = el('div', 'hm-legend');
  legend.append(el('span', 'hm-legend-label', '少'));
  for (let level = 0; level < 5; level += 1) {
    const chip = el('i', 'hm-legend-chip');
    const value = String(metric.color).replace('#', '');
    const num = parseInt(value, 16);
    const alpha = [0.16, 0.36, 0.58, 0.8, 1][level];
    chip.style.background = `rgba(${(num >> 16) & 255}, ${(num >> 8) & 255}, ${num & 255}, ${alpha})`;
    legend.append(chip);
  }
  legend.append(el('span', 'hm-legend-label', '多'));
  footer.append(legend);

  row.append(head, scroll, footer);

  // 等元素进 DOM 后再初始化，否则拿不到宽高
  requestAnimationFrame(() => {
    const echarts = echartsLib();
    if (!echarts || !chartEl.isConnected || chartEl.closest('#usage').hidden) return;
    const maxScroll = scroll.scrollWidth - scroll.clientWidth;
    if (maxScroll > 0) {
      scroll.tabIndex = 0;
      scroll.setAttribute('role', 'region');
      scroll.setAttribute('aria-label', metric.name + '日期，可横向滚动');
      scroll.scrollLeft = maxScroll - (scrollOffset || 0);
    }
    let chart = echarts.getInstanceByDom(chartEl);
    if (!chart) chart = echarts.init(chartEl, null, { renderer: 'canvas' });
    chart.setOption(calendarOption({ series, metric, values, max, cell }), true);
    dailyCharts.push(chart);
  });

  return row;
}

function renderDaily(data) {
  if (dailyRowsEl.closest('#usage').hidden) return;
  const offsets = new Map();
  if (dailyRowsEl.dataset.range === dailyRange) {
    for (const scroll of dailyRowsEl.querySelectorAll('.hm-scroll[tabindex]')) {
      offsets.set(scroll.dataset.metric, scroll.scrollWidth - scroll.clientWidth - scroll.scrollLeft);
    }
  }
  dailyRowsEl.dataset.range = dailyRange;
  disposeDailyCharts();
  dailyRowsEl.replaceChildren();
  const series = historySeries(data, dailyRange);
  if (!series.length) {
    dailyRowsEl.append(el('div', 'skeleton small', '暂无每日用量数据'));
    return;
  }

  // ① 合计热力图（所有来源相加，常驻显示）
  const totalMetric = {
    key: '__total',
    name: '所有来源合计',
    color: '#5b4a3e',
    getValue: (entry) =>
      Number(entry.codexTokens || 0) +
      Number(entry.deepseekTokens || 0) +
      Number(entry.opencodeTokens || 0) +
      Number(entry.opencodeOtherTokens || 0),
  };
  if (!dailyFilter || dailyFilter.has(totalMetric.key)) dailyRowsEl.append(renderDailyRow(totalMetric, series, offsets.get(totalMetric.key)));

  // ② 分渠道（可整体折叠）
  const detail = el('div', 'daily-detail');
  detail.id = 'daily-detail';
  const channelMetrics = [
    { key: 'codexTokens', name: 'Codex（官方按天）', color: moduleColor('codex', '#c15f3c'), costKey: null },
    {
      key: 'deepseekTokens',
      name: data.deepseekSource === 'official' ? 'DeepSeek（官方按天）' : 'DeepSeek（本机估算）',
      color: moduleColor('deepseek', '#bb8a52'),
      costKey: 'deepseekCostCny',
    },
    { key: 'opencodeTokens', name: 'OpenCode Go（本机估算）', color: moduleColor('opencode', '#7e8f6b'), costKey: 'opencodeCostCny' },
    {
      key: 'opencodeOtherTokens',
      name: 'OpenCode 其它路由（本机估算）',
      color: moduleColor('other', '#9c958c'),
      costKey: 'opencodeOtherCostCny',
      hideIfZero: true,
    },
  ];
  const visibleChannels = channelMetrics.filter((metric) => {
    const sum = series.reduce((acc, entry) => acc + metricValue(entry, metric), 0);
    if (metric.hideIfZero && sum === 0) return false;
    return !dailyFilter || dailyFilter.has(metric.key);
  });
  for (const metric of visibleChannels) detail.append(renderDailyRow(metric, series, offsets.get(metric.key)));

  // ③ 每个订阅源 / 账号一份热力图（单独一个折叠按钮）
  const subs = (state.config && state.config.providers && state.config.providers.opencodeGo && state.config.providers.opencodeGo.subscriptions) || [];
  const accounts = (state.config && state.config.providers && state.config.providers.codex && state.config.providers.codex.accounts) || [];
  const sourceMetrics = [];
  subs.forEach((sub, index) => {
    if (!sub || !sub.provider) return;
    sourceMetrics.push({
      key: `sub:${sub.provider}`,
      name: `订阅 · ${sub.name}`,
      color: ['#7e8f6b', '#93a381', '#a8b598'][index % 3],
      getValue: (entry) => Number((entry.opencodeByProvider || {})[sub.provider] || 0),
    });
  });
  accounts.forEach((account, index) => {
    const id = account && account.accountId;
    if (!id) return;
    sourceMetrics.push({
      key: `acc:${id}`,
      name: truncateText('账号 · ' + disambiguateAccountName(account.displayName || account.name, id), DISPLAY_NAME_LIMIT),
      color: ['#c15f3c', '#cf795a', '#dc9a80'][index % 3],
      getValue: (entry) => Number((entry.codexByAccount || {})[id] || 0),
    });
  });

  const visibleSources = sourceMetrics.filter((metric) => {
    const sum = series.reduce((acc, entry) => acc + metricValue(entry, metric), 0);
    // 新订阅即使还没用量也显示，提醒它已被纳入统计
    if (sum <= 0 && !metric.key.startsWith('sub:')) return false;
    return !dailyFilter || dailyFilter.has(metric.key);
  });
  // 记录可选项，供筛选弹层渲染
  state.dailyFilterOptions = [
    { key: totalMetric.key, name: '所有来源合计', kind: '汇总' },
    ...channelMetrics
      .filter((metric) => {
        if (metric.hideIfZero && series.reduce((acc, entry) => acc + metricValue(entry, metric), 0) === 0) return false;
        return true;
      })
      .map((metric) => ({ key: metric.key, name: metric.name, kind: '分渠道' })),
    ...sourceMetrics
      .filter((metric) => {
        const sum = series.reduce((acc, entry) => acc + metricValue(entry, metric), 0);
        return sum > 0 || metric.key.startsWith('sub:');
      })
      .map((metric) => ({ key: metric.key, name: metric.name, kind: '订阅 / 账号' }))
  ];

  if (visibleSources.length) {
    const head = el('div', 'daily-group-head');
    head.append(el('span', 'daily-group-label', `按订阅 / 账号拆分（${visibleSources.length}）`));
    const toggle = el('button', 'group-toggle', subGroupVisible ? '收起' : '展开');
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', subGroupVisible ? 'true' : 'false');
    toggle.classList.toggle('is-off', !subGroupVisible);
    toggle.addEventListener('click', () => {
      subGroupVisible = !subGroupVisible;
      try {
        window.localStorage.setItem('qb-daily-sub-group', subGroupVisible ? '1' : '0');
      } catch {
        /* 隐私模式忽略 */
      }
      const wrap = document.querySelector('#daily-sub-rows');
      if (wrap) wrap.style.display = subGroupVisible ? '' : 'none';
      toggle.textContent = subGroupVisible ? '收起' : '展开';
      toggle.setAttribute('aria-expanded', subGroupVisible ? 'true' : 'false');
      toggle.classList.toggle('is-off', !subGroupVisible);
    });
    head.append(toggle);
    detail.append(head);

    const subWrap = el('div', 'daily-sub-rows');
    subWrap.id = 'daily-sub-rows';
    subWrap.style.display = subGroupVisible ? '' : 'none';
    for (const metric of visibleSources) subWrap.append(renderDailyRow(metric, series, offsets.get(metric.key)));
    detail.append(subWrap);
  }

  dailyRowsEl.append(detail);
  detail.style.display = dailyDetailVisible ? '' : 'none';
  updateDailyToggle(visibleChannels.length + visibleSources.length);
  renderFilterPopover();

  // ④ 覆盖说明
  const notes = [];
  if (data.history && data.history.days) {
    notes.push(`已存档 ${data.history.days} 天${data.history.firstDate ? `（自 ${data.history.firstDate}）` : ''}，此后每天自动累积；取消订阅/删账号后历史仍保留`);
  }
  const staleList = Array.isArray(data.codexStale) ? data.codexStale.filter((item) => item && !item.noData) : [];
  const noDataList = Array.isArray(data.codexStale) ? data.codexStale.filter((item) => item && item.noData) : [];
  if (staleList.length) notes.push(`Codex：${staleList.length} 个账号用历史快照补全天数据`);
  if (noDataList.length) {
    notes.push(`Codex：${noDataList.map((item) => item.name).join('、')} 暂无按天数据（登录态失效，重新登录后自动补）`);
  }
  if (!dailyRowsEl.querySelector('.heat-row')) {
    dailyRowsEl.append(el('div', 'daily-note', '没有勾选任何热力图：点右上角「筛选」重新选择'));
  }
  if (notes.length) dailyRowsEl.append(el('div', 'daily-note', notes.join(' · ')));

  const modeLabel = dailyMode === 'day' ? '按天' : dailyMode === 'week' ? '按周合计' : '累计总量';
  const history = data.history && data.history.days
    ? `已存档 ${data.history.days} 天${data.history.firstDate ? `（自 ${data.history.firstDate}）` : ''}`
    : '长期存档已开启';
  const rangeLabel = dailyRange === '90' ? '近 90 天' : dailyRange === 'all' ? '全部历史' : '近一年';
  dailyUpdatedEl.textContent = `${rangeLabel} · ${modeLabel} · ${history}`;
}

function renderActiveHistoryView(data) {
  renderDaily(data);
  renderTotalChart(data);
}

function historySeries(data, range) {
  const series = Array.isArray(data?.series) ? data.series : [];
  if (range !== 'all') return series.slice(-Number(range));
  const firstDate = data?.history?.firstDate;
  return firstDate ? series.filter(({ date }) => date >= firstDate) : [];
}

let dailyRequest = 0;

async function loadDaily(force = false) {
  const request = ++dailyRequest;
  try {
    const days = dailyRange === 'all' || totalRange === 'all' ? 0 : Number(dailyRange);
    const data = await api(`/api/daily?days=${days}${force ? '&refresh=1' : ''}`);
    if (request !== dailyRequest) return;
    const firstLoad = !state.dailyData;
    state.dailyData = data;
    renderActiveHistoryView(data);
    if (firstLoad) syncInitialDailyAnchor();
  } catch {
    if (request === dailyRequest) dailyUpdatedEl.textContent = '每日用量统计失败';
  }
}

function fmtClock(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleTimeString('zh-CN', { hour12: false });
}

function fmtAgo(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '刚刚';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 10) return '刚刚';
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

function fmtReset(iso) {
  const target = new Date(iso).getTime();
  if (!Number.isFinite(target)) return '';
  const ms = target - Date.now();
  if (ms <= 0) return '即将重置';
  const seconds = Math.floor(ms / 1000);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days} 天 ${hours} 小时后重置`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分后重置`;
  if (minutes > 0) return `${minutes} 分钟后重置`;
  return `${seconds} 秒后重置`;
}

function statusChip(status) {
  const map = {
    ok: ['正常', 'ok'],
    error: ['查询失败', 'error'],
    unconfigured: ['未配置', 'unconfigured'],
    stale: ['历史数据', 'stale']
  };
  const [label, cls] = map[status] || ['未知', ''];
  const node = el('span', `status ${cls}`);
  node.append(el('span', 'dot'), el('span', '', label));
  return node;
}

function kindBadge(kind) {
  if (kind === 'codex') return el('span', 'badge codex', 'Codex');
  if (kind === 'opencode-go') return el('span', 'badge go', 'OpenCode Go');
  return el('span', 'badge relay', '中转站');
}

function windowMeta(window) {
  const fragment = document.createDocumentFragment();
  const used = clampQuotaPercent(window.usedPercent);
  if (used !== null) {
    fragment.append(el('span', '', '已用 ' + fmtQuotaPercent(used)));
    fragment.append(el('span', '', ' · 剩余 ' + fmtQuotaPercent(100 - used)));
  }
  if (window.resetAt) {
    if (fragment.childNodes.length) fragment.append(el('span', '', ' · '));
    const timer = el('span', '', fmtReset(window.resetAt));
    timer.dataset.reset = window.resetAt;
    fragment.append(timer);
  }
  if (!fragment.childNodes.length) fragment.append(el('span', '', window.unlimited ? '无限额度' : ''));
  return fragment;
}

function renderWindow(window) {
  const used = window.usedPercent;
  const row = el('div', 'window');
  const kind = windowKindOf(window);
  if (kind) row.dataset.kind = kind;
  const head = el('div', 'window-head');
  head.append(el('span', 'wlabel', windowDisplayLabel(window)), el('span', 'wmeta'));
  if (kind === 'custom' && window.windowSeconds) {
    head.firstChild.title = '接口返回周期：' + formatWindowSeconds(window.windowSeconds) + '（' + window.windowSeconds + ' 秒）';
  }
  head.lastChild.append(windowMeta(window));

  const bar = el('div', 'bar');
  const fill = el('div', `fill ${levelClass(used)}`.trim());
  fill.style.width = `${clampPercent(used)}%`;
  bar.append(fill);
  row.append(head, bar);
  return row;
}

function renderBalance(window, provider) {
  const wrap = el('div', 'balance');
  const amount = el('div', 'amount');
  if (window.unlimited) amount.textContent = '无限额度';
  else amount.textContent = fmtMoney(window.remaining, window.unit);

  const parts = [];
  if (window.spend !== null && window.spend !== undefined) parts.push(`已用 ${fmtMoney(window.spend, window.unit)}`);
  if (window.limit !== null && window.limit !== undefined) parts.push(`共 ${fmtMoney(window.limit, window.unit)}`);
  wrap.append(amount);
  if (parts.length) wrap.append(el('div', 'balance-sub', parts.join(' / ')));
  if (window.usedPercent !== null && window.usedPercent !== undefined) {
    const bar = el('div', 'bar');
    const fill = el('div', `fill ${levelClass(window.usedPercent)}`.trim());
    fill.style.width = `${clampPercent(window.usedPercent)}%`;
    bar.append(fill);
    wrap.append(bar);
  }
  return wrap;
}

function cardAction(label, onClick, className = 'icon-btn') {
  const button = el('button', className, label);
  button.type = 'button';
  button.addEventListener('click', onClick);
  return button;
}

function platformMetrics(provider) {
  const balance = provider.windows && provider.windows[0] ? provider.windows[0].remaining : null;
  const wrap = el('div', 'ds-metrics');
  const metric = (label, value, extra = '') => {
    const box = el('div', 'ds-metric');
    box.append(el('div', 'ds-label', label), el('div', `ds-value ${extra}`.trim(), value));
    return box;
  };
  wrap.append(metric('余额', fmtMoney(balance, 'CNY')));
  wrap.append(metric('累计消费', fmtMoney(provider.spentCny, 'CNY'), 'spend'));

  const body = el('div', 'ds-body');
  body.append(wrap);
  if (provider.tokens30d !== null && provider.tokens30d !== undefined) {
    const strip = el('div', 'ds-30d');
    strip.append(el('span', 'ds-30d-label', '近 30 天用量 '));
    strip.append(el('b', '', `${fmtTokens(provider.tokens30d)} tokens`));
    body.append(strip);
  } else if (provider.status === 'ok') {
    body.append(el('div', 'ds-30d', '近 30 天用量暂时不可用'));
  }
  return body;
}

/** 判断一个 Codex 卡片是否来自设备码登录的托管账号（优先用服务端字段，缺失时按名字匹配配置兜底）。 */
function isManagedCodexProvider(provider) {
  if (provider.managed === true) return true;
  if (provider.kind !== 'codex') return false;
  const label = String(provider.name || '').replace(/^Codex · /, '');
  const accounts = (state.config && state.config.providers && state.config.providers.codex && state.config.providers.codex.accounts) || [];
  return accounts.some(
    (account) =>
      account &&
      account.name === label &&
      (account.managed === true || /codex-profiles/i.test(account.authPath || ''))
  );
}

let goModelRequest;
const goEstimateDialog = document.querySelector('#go-estimate-dialog');
const goEstimateForm = document.querySelector('#go-estimate-form');
const goEstimateScope = document.querySelector('#go-estimate-scope');
const goEstimateError = document.querySelector('#go-estimate-error');
let goEstimateTarget;

function goEstimateKey(provider) {
  return 'qb-go-estimate:' + JSON.stringify([provider.subscription ?? provider.id, provider.provider]);
}

function activeGoCycleEnd(provider) {
  const end = provider.status === 'ok' && provider.windows?.find((item) => item.key === 'monthly')?.resetAt;
  return end && Date.parse(end) > Date.now() ? new Date(end).toISOString() : null;
}

function savedGoEstimate(provider) {
  try {
    return JSON.parse(localStorage.getItem(goEstimateKey(provider)) || 'null');
  } catch {
    return null;
  }
}

function clearGoEstimate(subscription) {
  const key = goEstimateKey(subscription);
  if (goEstimateTarget?.key === key) goEstimateTarget = null;
  goModelRequest = null;
  if (state.goModels) {
    state.goModels.subscriptions = state.goModels.subscriptions.filter(({ id }) => id !== subscription.id);
  }
  try {
    localStorage.removeItem(key);
  } catch {}
}

function openGoEstimateDialog(provider) {
  const cycleEnd = activeGoCycleEnd(provider);
  if (!cycleEnd) return;
  const existing = savedGoEstimate(provider);
  goEstimateTarget = { key: goEstimateKey(provider), cycleEnd };
  goEstimateForm.reset();
  goEstimateForm.elements.from.min = firstFullGoCycleDay(cycleEnd);
  goEstimateForm.elements.from.max = new Date().toISOString().slice(0, 10);
  goEstimateForm.elements.from.value = existing?.cycleEnd === cycleEnd ? existing.from : goEstimateForm.elements.from.min;
  if (existing?.plan) goEstimateForm.elements.plan.value = existing.plan;
  goEstimateScope.textContent = `${provider.name} · ${new Date(cycleEnd).toLocaleString('zh-CN')} 续订`;
  goEstimateError.textContent = '';
  goEstimateDialog.showModal();
}

goEstimateForm.elements.cancel.addEventListener('click', () => goEstimateDialog.close());
goEstimateForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const target = goEstimateTarget;
  if (!target) return;
  const { csv, from: fromField, plan: planField, save } = goEstimateForm.elements;
  const file = csv.files[0];
  const from = fromField.value;
  const plan = planField.value;
  const through = new Date().toISOString().slice(0, 10);
  goEstimateError.textContent = '';
  if (!from || from < firstFullGoCycleDay(target.cycleEnd) || from > through) {
    goEstimateError.textContent = '请从本账期的完整 UTC 日期中选择起始日。';
    return;
  }
  if (!file || !/\.csv$/i.test(file.name) || file.size > 16 * 1024 * 1024) {
    goEstimateError.textContent = '请选择一个不超过 16 MB 的官网用量 CSV。';
    return;
  }
  if (/^usage-(?:user_|svcacct_)/i.test(file.name)) {
    goEstimateError.textContent = '请导出工作区的用量 CSV。成员或服务账号明细只覆盖部分请求。';
    return;
  }
  save.disabled = true;
  try {
    const catalog = await api('/go-model-limits.json', { cache: 'no-store' });
    const limits = new Map(catalog.models.map(({ id, limits }) => [id, limits[plan]]));
    const rows = readGoWorkspaceCosts(await file.text(), { from, through, limits });
    const payload = { cycleEnd: target.cycleEnd, from, through, plan, catalogDate: catalog.retrievedAt, rows };
    if (!buildGoQuotaEstimate(payload, target.cycleEnd)) throw new Error('这段账期没有可用于估算的 Go 模型费用。');
    const live = state.data?.providers?.find((item) => item.kind === 'opencode-go' && goEstimateKey(item) === target.key);
    if (goEstimateTarget !== target || !goEstimateDialog.open) return;
    if (!live || activeGoCycleEnd(live) !== target.cycleEnd) throw new Error('订阅账期已更新，请重新打开这张卡再导入。');
    localStorage.setItem(target.key, JSON.stringify(payload));
    goEstimateDialog.close();
    render();
  } catch (error) {
    if (goEstimateTarget === target && goEstimateDialog.open) {
      goEstimateError.textContent = error?.name === 'QuotaExceededError' ? '浏览器没有足够空间保存估算。' : String(error?.message || '无法导入这份 CSV。');
    }
  } finally {
    save.disabled = false;
  }
});

function loadGoModelUsage(force = false) {
  if (goModelRequest || !cardsEl.clientWidth ||
      !state.data?.providers?.some((provider) => provider.kind === 'opencode-go' && provider.subscription)) return;
  const request = api(`/api/opencode-go/model-usage${force ? '?refresh=1' : ''}`)
    .catch(() => ({ status: 'unavailable', subscriptions: [] }))
    .then((data) => {
      if (goModelRequest !== request) return;
      const changed = JSON.stringify(state.goModels) !== JSON.stringify(data);
      state.goModels = data;
      if (changed && cardsEl.clientWidth) render();
    })
    .finally(() => {
      if (goModelRequest === request) goModelRequest = null;
    });
  goModelRequest = request;
}

function goEstimateSyncHint(official, cycleEnd) {
  if (!cycleEnd || !official) return '';
  if (official.cycleEnd && official.cycleEnd !== cycleEnd) return '正在等待本期官网明细。';
  switch (official.status) {
    case 'denied': return '官网明细需要用量读取权限。';
    case 'incomplete': return '官网明细或模型权重暂不完整。';
    case 'pending': return '正在等待本期官网明细。';
    case 'unavailable': return '暂时无法同步官网明细。';
    default: return '';
  }
}

function createGoModelCard(provider) {
  const report = state.goModels;
  const configured = state.config?.providers?.opencodeGo?.subscriptions?.find(({ id }) => id === provider.subscription);
  const route = provider.provider || configured?.provider;
  const entry = report?.subscriptions?.find((item) =>
    item.id === provider.subscription && (!route || item.provider === route));
  let status = '';
  if (!report) status = '正在读取本机模型用量…';
  else if (entry?.status === 'ambiguous') status = '多个订阅共用同一路由，日志无法区分用量。';
  else if (report.status === 'unsupported') status = '当前 Node.js 无法读取压缩的模型日志。';
  else if (report.status === 'unavailable') status = '暂时无法读取本机模型日志。';
  else if (!entry?.totalTokens) status = report.partial ? '当前可读日志中没有此订阅的用量。' : '此订阅暂无本机用量记录。';
  else if (!entry.models.length) status = '本机有用量记录，暂未识别出模型。';

  const card = el('article', 'card go-model-card go-model-share');
  card.dataset.subscription = provider.subscription;
  card.setAttribute('aria-label', `${provider.name}的模型用量排行`);
  const cycleEnd = activeGoCycleEnd(provider);
  const official = entry?.officialEstimate;
  const saved = savedGoEstimate(provider);
  const syncHint = goEstimateSyncHint(official, cycleEnd);
  const monthlyUsed = provider.windows?.find((item) => item.key === 'monthly')?.usedPercent;
  if (cycleEnd && Number.isFinite(monthlyUsed) && monthlyUsed >= 0 && monthlyUsed <= 100) {
    const plan = saved?.plan || 'go';
    const automatic = official?.cycleEnd === cycleEnd && (official.status === 'ok' || official.status === 'stale')
      ? official.estimates?.[plan]
      : null;
    if (automatic && official.status === 'ok') return renderGoQuotaEstimate(card, provider, official, automatic, monthlyUsed, true);
    const estimate = buildGoQuotaEstimate(saved, cycleEnd);
    if (estimate && (!automatic || saved.through > official.through)) {
      const fallbackHint = syncHint || (automatic ? '官网同步暂缓。' : '');
      return renderGoQuotaEstimate(card, provider, saved, estimate, monthlyUsed, false, fallbackHint);
    }
    if (automatic) return renderGoQuotaEstimate(card, provider, official, automatic, monthlyUsed, true);
  }

  const shareHeading = el('div', 'go-model-section-head');
  const headingTitle = el('div', 'go-model-heading-title');
  headingTitle.append(el('h4', 'go-model-heading', '模型用量排行'));
  // 沿用智谱额度小卡的动态模型数，计数覆盖已识别模型，列表保留前三。
  if (!status) headingTitle.append(el('span', 'tag go-model-count', `${entry.models.length} 个模型`));
  shareHeading.append(headingTitle, el('span', 'go-model-scope', '本机累计 Token 占比'));
  const allowanceNote = el('p', 'go-model-hint go-model-allowance-note', syncHint || '月额度暂无模型明细');
  card.append(shareHeading, allowanceNote);
  if (cycleEnd) card.append(goEstimateImportButton(provider, '导入官网用量 CSV'));
  if (status) {
    card.append(el('p', 'go-model-hint', status));
    return card;
  }

  const shares = el('ol', 'go-model-shares');
  shares.setAttribute('aria-label', '按本机累计 Token 排列，最多三个模型');
  for (const { name, tokens, requests } of entry.models.slice(0, 3)) {
    const ratio = tokens / entry.totalTokens * 100;
    const requestCount = Number.isSafeInteger(requests) && requests > 0 ? ` · ${requests.toLocaleString('zh-CN')} 次请求` : '';
    const amount = el('div', 'go-model-tokens', fmtTokens(tokens) + ' tokens' + requestCount);
    amount.title = tokens.toLocaleString('zh-CN') + ' tokens';
    shares.append(createGoModelRow(name, ratio, '本订阅本机累计 Token', amount));
  }
  card.insertBefore(shares, allowanceNote);
  if (entry.models.length > 3 || entry.unknownTokens > 0) {
    card.insertBefore(el('p', 'go-model-hint', '占比按本订阅全部已记录 Token 计算'), allowanceNote);
  }
  if (report.partial) card.append(el('p', 'go-model-hint', '部分日志未能读取'));
  return card;
}

function createGoModelRow(name, ratio, scope, detail) {
  const row = el('li', 'go-model-row');
  const head = el('div', 'go-model-row-head');
  const percent = ratio > 0 && ratio < 0.05 ? '<0.1%' : ratio.toFixed(1) + '%';
  const share = el('span', 'go-model-percent', percent);
  share.title = `占${scope}的 ${percent}`;
  head.append(el('span', 'go-model-name', name), share);
  const track = el('div', 'go-model-bar');
  track.setAttribute('aria-hidden', 'true');
  const fill = el('span', '');
  fill.style.width = ratio + '%';
  track.append(fill);
  row.append(head);
  if (detail) row.append(detail);
  row.append(track);
  return row;
}

function goEstimateImportButton(provider, label) {
  const button = el('button', 'go-estimate-import', label);
  button.type = 'button';
  button.addEventListener('click', () => openGoEstimateDialog(provider));
  return button;
}

function renderGoQuotaEstimate(card, provider, source, estimate, monthlyUsed, automatic, syncHint) {
  card.dataset.estimate = 'true';
  card.dataset.estimateSource = automatic ? 'official' : 'csv';
  const head = el('div', 'go-model-section-head');
  const heading = el('div', 'go-model-heading-title');
  heading.append(el('h4', 'go-model-heading', '占本期月总额度'), el('span', 'tag go-model-count', '估算'));
  head.append(heading, el('span', 'go-model-scope', `${estimate.modelCount} 个模型`));
  const shares = el('ol', 'go-model-shares');
  shares.setAttribute('aria-label', '按本期估算扣减降序排列，最多三个模型');
  for (const item of estimate.models) {
    const percentOfMonthlyLimit = monthlyUsed * item.sharePercent / 100;
    shares.append(createGoModelRow(item.model, percentOfMonthlyLimit, '本期月总额度'));
  }
  const weightDay = new Date(source.catalogDate).toLocaleDateString('zh-CN');
  const note = el('p', 'go-model-hint go-model-allowance-note', `按月已用 ${monthlyUsed}% 分摊 · UTC ${source.from} 起`);
  note.title = `用官网用量费用和 ${weightDay} 的模型权重分摊当前月已用额度。按完整 UTC 日起算，权重变化或额外用量会影响估算。`;
  card.append(head, shares, note);
  if (automatic) {
    const syncLabel = source.status === 'stale' ? '同步暂缓 · 上次官网明细' : '官网自动更新';
    const syncNote = el('p', 'go-model-hint', `${syncLabel} · 最新用量日 ${source.through} UTC`);
    syncNote.title = `最近成功同步于 ${new Date(source.fetchedAt).toLocaleString('zh-CN')}`;
    card.append(syncNote);
  } else if (syncHint) {
    card.append(el('p', 'go-model-hint', `${syncHint} 使用已导入的 CSV。`));
  }
  card.append(goEstimateImportButton(provider, automatic ? '手动导入 CSV' : '更新官网用量 CSV'));
  return card;
}

function createCard(provider) {
  const card = el('article', `card kind-${provider.kind} ${provider.status === 'ok' ? '' : 'muted-card'}`.trim());
  const head = el('div', 'card-head');
  const title = el('div', 'card-title');
  const nameRow = el('div', 'card-name');
  if (provider.kind === 'relay') {
    const relayLabel =
      {
        'newapi-account': 'New API 账户',
        'newapi-token': 'New API 令牌',
        sub2api: 'Sub2API',
        generic: '自定义 HTTP'
      }[provider.relayType] || '中转站';
    nameRow.append(el('span', 'badge relay', relayLabel));
  } else if (provider.kind === 'deepseek') {
    nameRow.append(el('span', 'badge deepseek', 'DeepSeek'));
  } else if (provider.kind === 'deepseek-platform') {
    nameRow.append(el('span', 'badge deepseek', '官方'));
  }
  const cardNameSpan = el('span', '', '');
  setDisplayText(cardNameSpan, provider.kind === 'codex' ? disambiguateProviderName(provider) : provider.name, DISPLAY_NAME_LIMIT);
  nameRow.append(cardNameSpan);
  const planBadgeEl = provider.kind === 'codex' ? planBadge(provider) : null;
  if (planBadgeEl) nameRow.append(planBadgeEl);
  title.append(nameRow);
  if (provider.plan && !planBadgeEl) title.append(el('div', 'card-plan', provider.plan));

  const actions = el('div', 'card-actions');
  actions.append(statusChip(provider.status));
  if (provider.kind === 'codex' && isManagedCodexProvider(provider)) {
    const refreshInfo = provider.refresh || null;
    const refreshFailed = Boolean((refreshInfo && refreshInfo.lastError) || provider.refreshError);
    const refreshTag = refreshFailed ? '续期失败' : provider.autoRefresh === false ? '自动续期已关' : '自动续期';
    const tagNode = el('span', 'tag ' + (refreshFailed ? 'bad' : 'managed'), refreshTag);
    if (refreshFailed) {
      tagNode.title = '自动续期失败：' + ((refreshInfo && refreshInfo.lastError) || provider.refreshError);
    } else if (refreshInfo && refreshInfo.refreshedAt) {
      tagNode.title = '上次自动续期：' + fmtClock(refreshInfo.refreshedAt);
    } else if (refreshInfo && refreshInfo.attempted) {
      tagNode.title = '本轮尝试过续期（未写入新令牌）';
    } else {
      tagNode.title = '到期前会自动续期；本轮未到续期时间';
    }
    actions.append(tagNode);
  }
  if (provider.kind === 'relay') {
    actions.append(
      cardAction('令牌', async () => {
        const token = window.prompt(`粘贴「${provider.name}」的令牌（只保存在本机）`);
        if (!token || !token.trim()) return;
        try {
          await api(`/api/relays/${encodeURIComponent(provider.id)}/token`, {
            method: 'PUT',
            body: { token: token.trim() }
          });
          await load(true);
        } catch (err) {
          showBanner(`保存令牌失败：${err.message}`);
        }
      }),
      cardAction('删除', async () => {
        if (!window.confirm(`删除站点「${provider.name}」？`)) return;
        try {
          await api(`/api/relays/${encodeURIComponent(provider.id)}`, { method: 'DELETE' });
          await load(true);
        } catch (err) {
          showBanner(`删除失败：${err.message}`);
        }
      }, 'icon-btn danger')
    );
  }
  if (provider.historyOnly) {
    actions.append(
      cardAction('删除', async () => {
        if (!window.confirm(`删除「${provider.name}」的历史快照？`)) return;
        try {
          await api(`/api/codex/history/${encodeURIComponent(provider.historyKey)}`, { method: 'DELETE' });
          await load(true);
        } catch (err) {
          showBanner(`删除失败：${err.message}`);
        }
      }, 'icon-btn danger')
    );
  }
  head.append(title, actions);
  card.append(head);

  if (provider.status === 'error' || provider.status === 'unconfigured') {
    const text = el(
      'div',
      provider.status === 'error' ? 'error-text' : 'unconfigured-text',
      provider.error || '未配置'
    );
    card.append(text);
    if (provider.status === 'unconfigured' && provider.kind === 'opencode-go') {
      card.append(
        cardAction('填写 Go Key', () => navigateDashboard('go-panel'), 'btn')
      );
    }
  }

  if (provider.kind === 'deepseek-platform') {
    card.append(platformMetrics(provider));
  } else {
    const windowsEl = renderCardWindows(provider);
    if (windowsEl) card.append(windowsEl);
  }

  if (provider.kind === 'opencode-go' && provider.subscription) {
    card.dataset.providerKind = provider.kind;
    card.dataset.subscription = provider.subscription;
    const channels = state.usage?.channels || [];
    const opencodeChannel = channels.find((channel) => channel.id === 'opencode');
    const otherChannel = channels.find((channel) => channel.id === 'opencode-other');
    const subs = (opencodeChannel && opencodeChannel.subs) || [];
    const current = subs.find((item) => item.id === provider.subscription);
    if (current) {
      const channelTotal = recordedGoTokens(opencodeChannel, otherChannel);
      const share = channelTotal ? (Number(current.tokens.total || 0) / channelTotal) * 100 : 0;
      card.append(
        el(
          'div',
          'note',
          `本订阅 Token：${fmtTokens(current.tokens.total)} · 占 OpenCode Go 总计 ${share.toFixed(1)}% · 会话 ${current.sessions || 0} 个`
        )
      );
    }
  }

  if (provider.kind !== 'deepseek-platform' && provider.notes && provider.notes.length) {
    for (const note of provider.notes) card.append(el('div', 'note', note));
  }

  const refreshError = provider.refreshError || (provider.refresh && provider.refresh.lastError) || null;
  if (provider.kind === 'codex' && refreshError) {
    card.append(el('div', 'note', '自动续期失败：' + refreshError + '（可能需要在「Codex 账户」里重新登录这个号）'));
  }
  if (provider.status === 'stale' && provider.error) {
    card.append(el('div', 'note', provider.error));
  }

  if (provider.credits) {
    const label = provider.credits.unlimited
      ? '额度：无限'
      : `额度：${provider.credits.balance === null || provider.credits.balance === undefined ? '—' : provider.credits.balance}`;
    card.append(el('div', 'note', `${label}（credits，不含套餐内用量）`));
  }

  const foot = el('div', 'card-foot');
  const time = el(
    'span',
    'muted',
    provider.fetchedAt
      ? `更新于 ${fmtAgo(provider.fetchedAt)}`
      : provider.status === 'unconfigured'
        ? '尚未配置'
        : '尚未成功查询'
  );
  if (provider.fetchedAt) time.dataset.ago = provider.fetchedAt;
  foot.append(time);
  if (provider.stale) foot.append(el('span', 'stale-tag', '显示的是上次成功数据'));
  card.append(foot);
  return card;
}

function render() {
  cardsEl.replaceChildren();
  const providers = (state.data && state.data.providers) || [];
  const list = [...providers];
  const pendingIndex = list.findIndex(
    (provider) => provider.kind === 'codex' && provider.status === 'unconfigured' && /未登录/.test(provider.name || '')
  );
  const platformIndex = list.findIndex((provider) => provider.kind === 'deepseek-platform');
  if (pendingIndex > -1 && platformIndex > -1 && pendingIndex !== platformIndex) {
    [list[pendingIndex], list[platformIndex]] = [list[platformIndex], list[pendingIndex]];
  }
  if (!providers.length) {
    cardsEl.append(el('div', 'skeleton', '还没有任何额度源，先在下方添加中转站，或在 DSH/Codex 里登录。'));
    return;
  }
  for (const provider of list) {
    const card = createCard(provider);
    if (provider.kind === 'opencode-go' && provider.subscription) {
      const pair = el('div', 'go-quota-pair');
      pair.append(card, createGoModelCard(provider));
      cardsEl.append(pair);
    } else {
      cardsEl.append(card);
    }
  }
  renderAccountsSummary();
  updateTimers();
}

const WINDOW_VISIBLE_LIMIT = 6;

/** 窗口分组键：标准 kind 相同即合并；custom 按 key/秒数区分；balance 独立。 */
function windowGroupKey(window) {
  if (!window) return 'window';
  if (window.key === 'balance') return 'balance:' + (window.unit || '');
  const kind = windowKindOf(window);
  if (kind && kind !== 'custom') return 'kind:' + kind;
  return 'key:' + (window.key || (window.windowSeconds ? 'w' + window.windowSeconds : 'window'));
}

/** 同 kind 只保留第一项并计数，避免 100 个窗口/重复 weekly 把卡片撑爆。 */
function groupWindowsForDisplay(windows) {
  const groups = [];
  const index = new Map();
  for (const window of windows) {
    const key = windowGroupKey(window);
    if (index.has(key)) {
      groups[index.get(key)].count += 1;
      continue;
    }
    index.set(key, groups.length);
    groups.push({ key, window, kind: windowKindOf(window), count: 1 });
  }
  return groups;
}

function renderWindowGroup(group) {
  const row = renderWindow(group.window);
  if (group.count > 1) {
    const head = row.querySelector('.window-head');
    if (head) {
      const count = el('span', 'window-count', '×' + group.count);
      count.title = '接口返回 ' + group.count + ' 个同类型窗口，这里只显示第 1 个';
      head.append(count);
    }
  }
  return row;
}

function renderCardWindows(provider) {
  const windows = Array.isArray(provider.windows) ? provider.windows.filter(Boolean) : [];
  const groups = groupWindowsForDisplay(windows);
  const renderedKinds = [];
  for (const group of groups) if (group.kind) renderedKinds.push(group.kind);
  const expandKey = provider.id || provider.name || 'card';
  const expanded = Boolean(state.windowExpand && state.windowExpand.has(expandKey));
  const visible = expanded ? groups : groups.slice(0, WINDOW_VISIBLE_LIMIT);
  const hiddenCount = groups.length - visible.length;
  const body = el('div', 'card-body');
  body.style.display = 'flex';
  body.style.flexDirection = 'column';
  body.style.gap = '12px';
  for (const group of visible) {
    if (group.window.key === 'balance') body.append(renderBalance(group.window, provider));
    else body.append(renderWindowGroup(group));
  }
  if (hiddenCount > 0 || expanded) {
    const toggle = el('button', 'btn ghost small window-toggle');
    toggle.type = 'button';
    toggle.textContent = expanded ? '收起多余窗口' : '展开全部 ' + groups.length + ' 个窗口';
    toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    toggle.addEventListener('click', () => {
      if (!state.windowExpand) state.windowExpand = new Set();
      if (state.windowExpand.has(expandKey)) state.windowExpand.delete(expandKey);
      else state.windowExpand.add(expandKey);
      render();
    });
    body.append(toggle);
  }
  if (provider.kind === 'codex') {
    const meta = planMetaOf(provider);
    const expected = expectedWindowKinds(meta, provider.plan);
    const missing = expected.filter((kind) => renderedKinds.indexOf(kind) === -1);
    if (missing.length && (provider.status === 'ok' || provider.status === 'stale')) {
      for (const kind of missing) {
        const node = cloneTemplate('tpl-window-missing');
        if (node) {
          node.dataset.kind = kind;
          const label = node.querySelector('.window-missing-label');
          if (label) label.textContent = windowKindLabelShort(kind);
          body.append(node);
        } else {
          body.append(el('div', 'note plan-window-hint', windowKindLabelShort(kind) + '：该计划未提供此窗口'));
        }
      }
    }
  }
  if (!windows.length && provider.status !== 'unconfigured') {
    body.append(el('div', 'note plan-window-hint', '额度接口未返回窗口数据（接口结构可能变化）'));
  }
  if (!body.childNodes.length) return null;
  return body;
}

/* ── 多号同登汇总（C3 codexSummary 优先，缺失时本地推导）───────────────── */
function codexProviders() {
  return ((state.data && state.data.providers) || []).filter((provider) => provider && provider.kind === 'codex');
}

function configCodexAccountByName(name) {
  const accounts = (state.config && state.config.providers && state.config.providers.codex && state.config.providers.codex.accounts) || [];
  const label = String(name || '').replace(/^Codex · /, '');
  return (
    accounts.find((account) => account && (account.name === label || account.displayName === label)) || null
  );
}

function summaryWindowList(provider) {
  return (Array.isArray(provider.windows) ? provider.windows : []).map((window) => ({
    key: window.key || windowKindOf(window) || 'window',
    kind: windowKindOf(window),
    label: windowDisplayLabel(window),
    usedPercent: window.usedPercent,
    resetAt: window.resetAt || null
  }));
}

/** C3 未落盘时：从 /api/quota providers 本地推导同登汇总（字段对齐 C3 契约）。 */
function deriveCodexSummary() {
  const accounts = codexProviders().map((provider) => {
    const meta = planMetaOf(provider);
    const name = String(provider.name || '').replace(/^Codex · /, '');
    const configAccount = configCodexAccountByName(name);
    return {
      id: provider.accountId || (configAccount && configAccount.accountId) || 'name:' + name,
      name,
      plan: provider.plan || (meta && meta.id) || '',
      planName: planDisplayName(meta, provider.plan),
      planMeta: meta,
      status: provider.status,
      updatedAt: provider.fetchedAt || provider.checkedAt || null,
      windows: summaryWindowList(provider)
    };
  });
  const active = accounts.filter((account) => account.status === 'ok' || account.status === 'stale').length;
  return { total: accounts.length, active, multi: active >= 2, accounts };
}

function statusLabel(status) {
  return { ok: '正常', error: '查询失败', unconfigured: '未配置', stale: '历史数据' }[status] || '未知状态';
}

function configCodexAccountById(id) {
  if (!id) return null;
  const accounts = (state.config && state.config.providers && state.config.providers.codex && state.config.providers.codex.accounts) || [];
  return accounts.find((account) => account && String(account.accountId || '') === String(id)) || null;
}

function accountRoleOf(account) {
  const configAccount = configCodexAccountById(account && account.id) || configCodexAccountByName(account && account.name);
  if (configAccount && configAccount.live === true) return { role: 'live', text: '当前登录' };
  const managed =
    configAccount &&
    (configAccount.managed === true || configAccount.kind === 'managed' || /codex-profiles/i.test(String(configAccount.authPath || '')));
  if (managed) return { role: 'managed', text: '设备码' };
  return { role: 'archived', text: '归档' };
}

/** 优先复用 U1 的 #accounts section；旧页面没有时动态建一个同结构容器。 */
function accountsSectionEl() {
  const existing = document.querySelector('#accounts');
  if (existing) return existing;
  const main = document.querySelector('main');
  if (!main) return null;
  const section = el('section', 'accounts');
  section.id = 'accounts';
  section.hidden = true;
  const head = el('div', 'usage-head');
  head.append(el('h2', '', '多号同登'));
  const meta = el('span', 'usage-updated');
  meta.id = 'accounts-meta';
  head.append(meta);
  const summary = el('div', 'accounts-summary');
  summary.id = 'accounts-summary';
  const list = el('div', 'accounts-list');
  list.id = 'accounts-list';
  section.append(head, summary, list);
  const cards = document.querySelector('#cards');
  if (cards && cards.parentNode === main) main.insertBefore(section, cards);
  else main.append(section);
  return section;
}

function summaryMainWindow(account) {
  const windows = Array.isArray(account.windows) ? account.windows : [];
  return windows.find((window) => window.kind === 'session') || windows[0] || null;
}

function summaryUsedPercent(account) {
  const main = summaryMainWindow(account);
  if (!main || main.usedPercent === null || main.usedPercent === undefined) return -1;
  const used = Number(main.usedPercent);
  return Number.isFinite(used) ? used : -1;
}

function summaryAccountSort(a, b) {
  const rank = (account) => (account.status === 'ok' ? 0 : account.status === 'stale' ? 1 : account.status === 'unconfigured' ? 3 : 2);
  const diff = rank(a) - rank(b);
  if (diff !== 0) return diff;
  return summaryUsedPercent(b) - summaryUsedPercent(a);
}

function summaryTotalsText(accounts) {
  const values = accounts
    .map((account) => ({ name: account.name || '', used: summaryUsedPercent(account) }))
    .filter((item) => item.used >= 0);
  if (!values.length) return '';
  const avg = values.reduce((sum, item) => sum + item.used, 0) / values.length;
  const top = values.slice().sort((a, b) => b.used - a.used)[0];
  return '平均已用 ' + fmtPercent(avg) + ' · 最高 ' + fmtPercent(top.used) + (top.name ? '（' + top.name + '）' : '');
}

function renderAccountSummaryRow(account) {
  let row = cloneTemplate('tpl-account-row');
  if (!row) {
    row = el('div', 'account-card');
    const main = el('div', 'account-card-main');
    const head = el('div', 'account-card-head');
    head.append(el('span', 'account-role'), el('span', 'account-card-name'), el('span', 'plan-chip'));
    const sub = el('div', 'account-card-sub');
    main.append(head, sub);
    const windows = el('div', 'account-windows');
    const foot = el('div', 'account-card-foot');
    foot.append(el('span', 'account-tokens'), el('span', 'account-share'));
    row.append(main, windows, foot);
  }
  if (account.status) row.dataset.status = account.status;

  const roleEl = row.querySelector('.account-role');
  if (roleEl) {
    const role = accountRoleOf(account);
    roleEl.dataset.role = role.role;
    roleEl.textContent = role.text;
  }
  const nameEl = row.querySelector('.account-card-name');
  if (nameEl) setDisplayText(nameEl, disambiguateAccountName(account.name, account.id), DISPLAY_NAME_LIMIT);

  const chip = row.querySelector('.plan-chip');
  if (chip) {
    const meta = planMetaOf(account);
    const plan = account.plan || (meta && meta.id) || '';
    const planName = account.planName || planDisplayName(meta, plan);
    setDisplayText(chip, planName || '', PLAN_NAME_LIMIT);
    chip.dataset.plan = String((meta && meta.id) || plan || '').toLowerCase() || 'unknown';
    chip.dataset.tier = String((meta && meta.tier) || 'unknown');
    chip.title = (meta && meta.note) || (planName ? '计划：' + planName : '按接口实际窗口显示');
  }

  const sub = row.querySelector('.account-card-sub');
  if (sub) {
    const bits = [statusLabel(account.status)];
    const mainWindow = summaryMainWindow(account);
    if (mainWindow && mainWindow.usedPercent !== null && mainWindow.usedPercent !== undefined) {
      const used = clampQuotaPercent(mainWindow.usedPercent);
      if (used !== null) bits.push('主窗口已用 ' + fmtQuotaPercent(used));
    }
    sub.textContent = bits.join(' · ');
  }

  const windowsEl = row.querySelector('.account-windows');
  if (windowsEl) {
    windowsEl.replaceChildren();
    const windows = Array.isArray(account.windows) ? account.windows : [];
    const groups = groupWindowsForDisplay(windows);
    const visible = groups.slice(0, WINDOW_VISIBLE_LIMIT);
    for (const group of visible) windowsEl.append(renderWindowGroup(group));
    if (groups.length > visible.length) {
      windowsEl.append(el('div', 'account-window-more', '另有 ' + (groups.length - visible.length) + ' 个窗口未展开'));
    }
    if (!windows.length) windowsEl.append(el('div', 'window-missing-text', '未返回窗口数据'));
  }

  const tokensEl = row.querySelector('.account-tokens');
  if (tokensEl) setDisplayText(tokensEl, account.planName ? '计划 ' + account.planName : '', DISPLAY_NAME_LIMIT);
  const shareEl = row.querySelector('.account-share');
  if (shareEl && account.updatedAt) {
    shareEl.textContent = '更新于 ' + fmtAgo(account.updatedAt);
    shareEl.dataset.ago = account.updatedAt;
  }
  return row;
}

function renderAccountsSummary() {
  const section = accountsSectionEl();
  if (!section) return;
  const summary = (state.data && (state.data.codexSummary || state.data.accountsSummary)) || deriveCodexSummary();
  const accounts = summary && Array.isArray(summary.accounts) ? summary.accounts.filter(Boolean) : [];
  const list = document.querySelector('#accounts-list');
  const meta = document.querySelector('#accounts-meta');
  const summaryEl = document.querySelector('#accounts-summary');
  if (accounts.length < 2) {
    section.hidden = true;
    if (list) list.replaceChildren();
    if (summaryEl) summaryEl.textContent = '';
    if (meta) meta.textContent = '';
    return;
  }
  section.hidden = false;
  const active = Number.isFinite(Number(summary.active))
    ? Number(summary.active)
    : accounts.filter((account) => account.status === 'ok' || account.status === 'stale').length;
  if (meta) meta.textContent = '共 ' + accounts.length + ' 个账号 · ' + active + ' 个可查询' + (summary.multi ? ' · 同登中' : '');
  if (summaryEl) summaryEl.textContent = summaryTotalsText(accounts);
  if (list) {
    list.replaceChildren();
    accounts.slice().sort(summaryAccountSort).forEach((account) => list.append(renderAccountSummaryRow(account)));
  }
}

function updateTimers() {
  updateDeviceLoginCountdown();
  for (const node of document.querySelectorAll('[data-reset]')) {
    node.textContent = fmtReset(node.dataset.reset);
  }
  for (const node of document.querySelectorAll('[data-ago]')) {
    node.textContent = `更新于 ${fmtAgo(node.dataset.ago)}`;
  }
  if (state.data && state.auto !== false) {
    const remaining = Math.max(0, Math.ceil((state.nextAt - Date.now()) / 1000));
    countdownEl.textContent = remaining ? `${remaining}s 后刷新` : '即将刷新';
  } else {
    countdownEl.textContent = '';
  }
}

function showBanner(message) {
  bannerEl.textContent = message;
  bannerEl.hidden = false;
}

function hideBanner() {
  bannerEl.hidden = true;
}

function setLoading(loading) {
  state.loading = loading;
  refreshBtn.disabled = loading;
  const label = refreshBtn.querySelector('span');
  if (label) label.textContent = loading ? '刷新中…' : '刷新';
  else refreshBtn.textContent = loading ? '刷新中…' : '刷新';
}

/** Lucide 图标：把 <i data-lucide="x"> 替换成内联 SVG（本地 vendor，无外部请求）。 */
function renderIcons() {
  const lucide = typeof window !== 'undefined' ? window.lucide : undefined;
  if (lucide && typeof lucide.createIcons === 'function') {
    try {
      lucide.createIcons({ attrs: { 'stroke-width': 1.8 } });
    } catch {
      /* 图标失败不影响功能 */
    }
  }
}

export async function load(force = false) {
  setLoading(true);
  try {
    const data = await api(`/api/quota${force ? '?refresh=1' : ''}`);
    state.data = data;
    state.nextAt = Date.now() + (data.refreshSeconds || 60) * 1000;
    updatedEl.textContent = `更新于 ${fmtClock(data.generatedAt)}`;
    hideBanner();
    render();
    loadUsage(force);
    loadDaily(force);
    loadGoModelUsage(force);
  } catch (err) {
    showBanner(`刷新失败：${err.message}`);
  } finally {
    setLoading(false);
  }
}


// ── 首次使用引导 ───────────────────────────────────────────────
const onboardingEl = document.querySelector('#onboarding');
const obSlides = onboardingEl ? [...onboardingEl.querySelectorAll('.ob-slide')] : [];
const obStepLabel = document.querySelector('#ob-step-label');
const obDots = document.querySelector('#ob-dots');
const obPrev = document.querySelector('#ob-prev');
const obNext = document.querySelector('#ob-next');
const obSkip = document.querySelector('#ob-skip');
let obIndex = 0;
let obSelectedPanel = null;
let obReturnFocus = null;
const obProgressBar = document.querySelector('#ob-progress-bar');
const reduceMotion = typeof window !== 'undefined' && window.matchMedia
  ? window.matchMedia('(prefers-reduced-motion: reduce)')
  : null;

const obNameInput = document.querySelector('#ob-name');
const obTypedName = document.querySelector('#ob-typed-name');

async function saveObName() {
  if (!obNameInput) return;
  const value = obNameInput.value.trim().slice(0, 40);
  if (!value) return;
  if (titleEl && titleEl.textContent === value) return;
  try {
    await saveSettings({ title: value });
  } catch {
    /* 保存失败不阻断引导 */
  }
}

if (obNameInput) {
  obNameInput.addEventListener('input', () => {
    if (obTypedName) obTypedName.textContent = obNameInput.value.trim() || '我的额度面板';
  });
}

function animateObCounter() {
  const el = document.querySelector('#obv-count');
  if (!el) return;
  const target = 38.64;
  if (reduceMotion && reduceMotion.matches) {
    el.textContent = target.toFixed(2);
    return;
  }
  const started = performance.now();
  const duration = 900;
  el.textContent = '0.00';
  const tick = (now) => {
    const t = Math.min(1, (now - started) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = (target * eased).toFixed(2);
    if (t < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function renderOnboarding() {
  if (!onboardingEl) return;
  obSlides.forEach((slide, index) => {
    slide.hidden = index !== obIndex;
    slide.classList.remove('is-active');
  });
  const active = obSlides[obIndex];
  if (active) {
    const heading = active.querySelector('h2');
    if (heading?.id) onboardingEl.querySelector('[role=dialog]')?.setAttribute('aria-labelledby', heading.id);
    active.querySelectorAll('.ob-list li').forEach((item, index) => {
      item.style.setProperty('--i', String(index));
    });
    void active.offsetWidth; // 强制回流，让入场动画每次都播
    active.classList.add('is-active');

  }
  if (obProgressBar) {
    obProgressBar.style.width = `${((obIndex + 1) / Math.max(1, obSlides.length)) * 100}%`;
  }
  if (obStepLabel) {
    obStepLabel.textContent = `${String(obIndex + 1).padStart(2, '0')} / ${String(obSlides.length).padStart(2, '0')}`;
  }
  if (obDots) {
    obDots.replaceChildren();
    obSlides.forEach((_, index) => {
      const dot = document.createElement('span');
      dot.className = 'ob-dot' + (index === obIndex ? ' active' : '');
      obDots.append(dot);
    });
  }
  if (obPrev) obPrev.hidden = obIndex === 0;
  if (obNext) obNext.textContent = obIndex === obSlides.length - 1 ? '开始使用' : '下一步';
}

function openOnboarding() {
  if (!onboardingEl) return;
  obIndex = 0;
  obSelectedPanel = null;
  obReturnFocus = document.activeElement;
  onboardingEl.querySelectorAll('[data-ob-panel]').forEach((button) => button.setAttribute('aria-pressed', 'false'));
  if (obNameInput) {
    const current = (state.config && state.config.settings && state.config.settings.title) || (titleEl ? titleEl.textContent : '');
    obNameInput.value = current && current !== 'Token 使用情况' ? current : '';
    if (obTypedName) obTypedName.textContent = obNameInput.value || '我的额度面板';
  }
  renderOnboarding();
  onboardingEl.hidden = false;
  document.body.style.overflow = 'hidden';
  obNext?.focus({ preventScroll: true });
}

async function closeOnboarding(completed) {
  if (!onboardingEl) return;
  await saveObName();
  onboardingEl.hidden = true;
  document.body.style.overflow = '';
  if (obReturnFocus && typeof obReturnFocus.focus === 'function') obReturnFocus.focus({ preventScroll: true });
  try {
    localStorage.setItem('qb-onboarding-done', '1');
  } catch {
    /* 隐私模式忽略 */
  }
  if (completed) {
    try {
      await saveSettings({ onboardingDone: true });
    } catch {
      /* 服务端记录失败也不影响使用 */
    }
  }
}

if (onboardingEl) {
  renderOnboarding();
  onboardingEl.querySelectorAll('[data-ob-panel]').forEach((button) => {
    button.addEventListener('click', () => {
      obSelectedPanel = button.dataset.obPanel;
      onboardingEl.querySelectorAll('[data-ob-panel]').forEach((item) => item.setAttribute('aria-pressed', String(item === button)));
    });
  });
  obNext?.addEventListener('click', async () => {
    if (obIndex === 0) await saveObName();
    if (obIndex >= obSlides.length - 1) {
      await closeOnboarding(true);
      if (obSelectedPanel) navigateDashboard(obSelectedPanel);
    }
    else { obIndex += 1; renderOnboarding(); }
  });
  obPrev?.addEventListener('click', () => {
    if (obIndex > 0) { obIndex -= 1; renderOnboarding(); }
  });
  obSkip?.addEventListener('click', async () => { await saveObName(); closeOnboarding(true); });
  onboardingEl.addEventListener('click', (event) => {
    if (event.target === onboardingEl) closeOnboarding(true);
  });
  document.addEventListener('keydown', (event) => {
    if (onboardingEl.hidden) return;
    if (event.key === 'Escape') { closeOnboarding(true); return; }
    if (event.key === 'Tab') {
      const items = [...onboardingEl.querySelectorAll('button, input, select, textarea, a[href]')].filter((el) => !el.disabled && el.offsetParent !== null);
      if (items.length && event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items[items.length - 1].focus(); }
      else if (items.length && !event.shiftKey && document.activeElement === items[items.length - 1]) { event.preventDefault(); items[0].focus(); }
      return;
    }
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)) return;
    if (event.key === 'ArrowRight') obNext?.click();
    if (event.key === 'ArrowLeft' && !obPrev?.hidden) obPrev?.click();
  });
  document.querySelector('#reopen-onboarding')?.addEventListener('click', openOnboarding);
}

let onboardingShown = false;
function maybeShowOnboarding(settings) {
  if (onboardingShown || !onboardingEl) return;
  let localDone = false;
  try {
    localDone = localStorage.getItem('qb-onboarding-done') === '1';
  } catch {
    /* 隐私模式忽略 */
  }
  const serverDone = Boolean(settings && settings.onboardingDone);
  onboardingShown = true;
  if (!serverDone && !localDone) setTimeout(openOnboarding, reduceMotion?.matches ? 50 : 1250);
}

// ── 标题 / 副标题：可重命名并持久化到 config.json ──────────────
const titleEl = document.querySelector('#app-title');
const subEl = document.querySelector('#app-sub');
const titleEditEl = document.querySelector('#title-edit');

function applySettings(settings) {
  if (!settings) return;
  if (typeof settings.title === 'string' && settings.title) {
    if (titleEl) titleEl.textContent = settings.title;
    document.title = settings.title;
  }
  if (typeof settings.subtitle === 'string' && subEl) subEl.textContent = settings.subtitle;
}

async function saveSettings(patch) {
  const result = await api('/api/settings', { method: 'POST', body: patch });
  if (result && result.settings) {
    applySettings(result.settings);
    if (state.config) state.config.settings = result.settings;
  }
  return result;
}

function startTitleEdit() {
  if (!titleEl || !titleEl.isConnected) return;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'title-input';
  input.maxLength = 40;
  input.value = titleEl.textContent || '';
  titleEl.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = async (commit) => {
    if (done) return;
    done = true;
    const next = input.value.trim().slice(0, 40) || 'Token 使用情况';
    const h1 = document.createElement('h1');
    h1.id = 'app-title';
    if (commit && next !== (titleEl ? titleEl.textContent : '')) h1.textContent = next;
    else h1.textContent = titleEl ? titleEl.textContent : 'Token 使用情况';
    input.replaceWith(h1);
    if (commit) {
      try {
        await saveSettings({ title: next });
      } catch (err) {
        showBanner(`改名失败：${err.message}`);
      }
    }
  };
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') finish(true);
    if (event.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}

if (titleEditEl) titleEditEl.addEventListener('click', startTitleEdit);

async function loadConfig() {
  try {
    const config = await api('/api/config');
    state.config = config;
    applySettings(config.settings);
    maybeShowOnboarding(config.settings);
    if (config.paths && config.paths.dataDir) dataDirEl.textContent = shortenDisplayPath(config.paths.dataDir);
    renderCodexAccounts((config.providers && config.providers.codex && config.providers.codex.accounts) || []);
    renderGoSubscriptions(
      (config.providers && config.providers.opencodeGo && config.providers.opencodeGo.subscriptions) || []
    );
    if (state.data) renderAccountsSummary();
  } catch {
    /* 配置读取失败不影响主面板 */
  }
}

function renderCodexAccounts(accounts) {
  codexList.replaceChildren();
  if (!accounts.length) {
    codexList.append(el('div', 'account-row', '还没有配置 Codex 账户'));
    return;
  }
  for (const account of accounts) {
    const row = el('div', 'account-row');
    const main = el('div', 'account-main');
    const accountNameEl = el('div', 'account-name');
    setDisplayText(accountNameEl, account.displayName || account.name || 'Codex 账户', DISPLAY_NAME_LIMIT);
    main.append(accountNameEl);
    main.append(el('div', 'account-path', shortenDisplayPath(account.authPath || '')));
    if (account.codexHome) main.append(el('div', 'account-path', 'CODEX_HOME：' + shortenDisplayPath(account.codexHome)));
    const managed = account.managed === true || /codex-profiles/i.test(account.authPath || '');
    const actions = el('div', 'account-actions');
    if (managed) actions.append(el('span', 'tag managed', account.autoRefresh === false ? '设备码 · 续期已关' : '设备码 · 自动续期'));
    actions.append(el('span', `tag ${account.valid ? 'ok' : 'bad'}`, account.valid ? '登录态正常' : '文件不可用'));
    actions.append(
      cardAction('改名', async () => {
        const name = window.prompt(`给「${account.name}」起个新名字`, account.name);
        if (!name || !name.trim()) return;
        try {
          if (account.live) {
            await api('/api/codex/live', { method: 'PUT', body: { name: name.trim() } });
          } else {
            await api(`/api/codex/accounts/${encodeURIComponent(account.id)}`, {
              method: 'PUT',
              body: { name: name.trim() }
            });
          }
          await loadConfig();
          await load(true);
        } catch (err) {
          showBanner(`改名失败：${err.message}`);
        }
      }, 'btn small')
    );
    if (account.live) {
      actions.append(el('span', 'tag', '自动归档'));
    } else {
      actions.append(
        cardAction('删除', async () => {
          if (!window.confirm(`删除 Codex 归档账户「${account.name}」？`)) return;
          try {
            await api(`/api/codex/accounts/${encodeURIComponent(account.id)}`, { method: 'DELETE' });
            await loadConfig();
            await load(true);
          } catch (err) {
            showBanner(`删除失败：${err.message}`);
          }
        }, 'btn small')
      );
    }
    row.append(main, actions);
    codexList.append(row);
  }
}

// ── 设备码登录（第二个账号）：状态机 UI ──────────────────────────────
function setDeviceLoginState(text, tone) {
  deviceLoginState.textContent = text || '';
  deviceLoginState.className = 'device-login-state' + (tone ? ' ' + tone : '');
}

function updateDeviceLoginCountdown() {
  if (!deviceLoginCountdown) return;
  const iso = deviceLoginCountdown.dataset.deviceExpires;
  if (!iso) {
    deviceLoginCountdown.textContent = '';
    return;
  }
  const remain = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(remain)) {
    deviceLoginCountdown.textContent = '';
    return;
  }
  if (remain <= 0) {
    deviceLoginCountdown.textContent = '设备码已过期，等待服务端确认…';
    return;
  }
  const total = Math.ceil(remain / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = String(total % 60).padStart(2, '0');
  deviceLoginCountdown.textContent = '剩 ' + minutes + ':' + seconds;
}

function renderDeviceLogin(session) {
  deviceLoginSession = session || null;
  const active = Boolean(session && (session.status === 'starting' || session.status === 'waiting'));
  deviceLoginBody.hidden = !session;
  deviceLoginDevice.hidden = !(session && session.url && session.code);
  deviceLoginCancel.hidden = !active;
  deviceLoginStart.disabled = active;
  if (!session) {
    delete deviceLoginCountdown.dataset.deviceExpires;
    updateDeviceLoginCountdown();
    setDeviceLoginState('', '');
    return;
  }
  if (session.status === 'waiting') {
    setDeviceLoginState('在浏览器打开下面的链接登录，输入一次性码；成功后本页会自动刷新。', '');
  } else if (session.status === 'success') {
    const name = session.account && session.account.name ? '「' + session.account.name + '」' : '';
    const fallback = session.duplicate ? '该账号已经在面板里，未重复添加' : '已添加' + name + '，正在刷新额度…';
    setDeviceLoginState(session.hint || fallback, 'ok');
  } else if (session.status === 'failed') {
    setDeviceLoginState(session.error || session.hint || '登录失败，请重试', 'err');
  } else if (session.status === 'expired') {
    setDeviceLoginState(session.error || '设备码已过期，请重新获取', 'err');
  } else if (session.status === 'cancelled') {
    setDeviceLoginState(session.hint || '已取消', '');
  } else {
    setDeviceLoginState('正在启动 codex.exe 并获取设备码…（约 2 秒）', '');
  }
  if (session.url) {
    deviceLoginLink.href = session.url;
    deviceLoginLink.textContent = session.url;
  }
  if (session.code) deviceLoginCode.textContent = session.code;
  if (session.expiresAt) deviceLoginCountdown.dataset.deviceExpires = session.expiresAt;
  else delete deviceLoginCountdown.dataset.deviceExpires;
  updateDeviceLoginCountdown();
}

function stopDeviceLoginPolling() {
  if (deviceLoginTimer) clearTimeout(deviceLoginTimer);
  deviceLoginTimer = null;
}

function scheduleDeviceLoginPoll(delay) {
  stopDeviceLoginPolling();
  deviceLoginTimer = setTimeout(pollDeviceLogin, delay || 1000);
}

async function pollDeviceLogin() {
  try {
    const data = await api(DEVICE_LOGIN_PATH);
    const session = data && data.session ? data.session : null;
    renderDeviceLogin(session);
    if (!session) return;
    if (DEVICE_LOGIN_TERMINAL.indexOf(session.status) > -1) {
      if (session.status === 'success') {
        await loadConfig();
        await load(true);
        setTimeout(() => {
          if (!deviceLoginSession || DEVICE_LOGIN_TERMINAL.indexOf(deviceLoginSession.status) > -1) renderDeviceLogin(null);
        }, 6000);
      }
      return;
    }
    scheduleDeviceLoginPoll(1000);
  } catch (err) {
    setDeviceLoginState('查询登录状态失败：' + err.message, 'err');
    scheduleDeviceLoginPoll(3000);
  }
}

async function startDeviceLogin() {
  stopDeviceLoginPolling();
  renderDeviceLogin({ status: 'starting', url: null, code: null, expiresAt: null });
  deviceLoginStart.disabled = true;
  try {
    const body = deviceLoginName && deviceLoginName.value.trim() ? { name: deviceLoginName.value.trim() } : {};
    const data = await api(DEVICE_LOGIN_PATH, { method: 'POST', body });
    renderDeviceLogin(data.session || null);
    scheduleDeviceLoginPoll(1000);
  } catch (err) {
    deviceLoginStart.disabled = false;
    setDeviceLoginState('启动失败：' + err.message, 'err');
  }
}

async function cancelDeviceLogin() {
  stopDeviceLoginPolling();
  try {
    const data = await api(DEVICE_LOGIN_PATH, { method: 'DELETE' });
    renderDeviceLogin(data.session || null);
  } catch (err) {
    if (String(err.message || '').indexOf('没有进行中') > -1) renderDeviceLogin(null);
    else setDeviceLoginState('取消失败：' + err.message, 'err');
  }
}

async function copyDeviceLoginCode() {
  const code = deviceLoginCode.textContent || '';
  if (!code) return;
  try {
    await navigator.clipboard.writeText(code);
    deviceLoginCopy.textContent = '已复制';
  } catch {
    window.prompt('复制设备码', code);
  }
  setTimeout(() => {
    deviceLoginCopy.textContent = '复制';
  }, 1500);
}

async function resumeDeviceLogin() {
  try {
    const data = await api(DEVICE_LOGIN_PATH);
    const session = data && data.session ? data.session : null;
    if (!session) return;
    renderDeviceLogin(session);
    if (DEVICE_LOGIN_TERMINAL.indexOf(session.status) === -1) scheduleDeviceLoginPoll(1000);
  } catch {
    /* 页面刚打开，失败不影响主面板 */
  }
}

function renderGoSubscriptions(subscriptions) {
  goList.replaceChildren();
  if (!subscriptions.length) {
    goList.append(el('div', 'account-row', '还没有配置 OpenCode Go 订阅，用下面表单添加'));
    return;
  }
  for (const sub of subscriptions) {
    const row = el('div', 'account-row');
    const main = el('div', 'account-main');
    main.append(el('div', 'account-name', sub.name || sub.id));
    main.append(el('div', 'account-path', `路由 ${sub.provider} · ${sub.keyRef || '无凭据引用'}`));
    const actions = el('div', 'account-actions');
    actions.append(el('span', `tag ${sub.hasKey ? 'ok' : 'bad'}`, sub.hasKey ? 'Key 已配置' : '缺少 Key'));
    actions.append(
      cardAction('改名', async () => {
        const name = window.prompt(`给「${sub.name}」起个新名字`, sub.name);
        if (!name || !name.trim()) return;
        try {
          await api(`/api/opencode-go/subscriptions/${encodeURIComponent(sub.id)}`, {
            method: 'PUT',
            body: { name: name.trim() }
          });
          await loadConfig();
          await load(true);
        } catch (err) {
          showBanner(`改名失败：${err.message}`);
        }
      }, 'btn small')
    );
    actions.append(
      cardAction('换 Key', async () => {
        const key = window.prompt(`粘贴「${sub.name}」的新 Go Key（oc_sk_…）`);
        if (!key || !key.trim()) return;
        try {
          await api(`/api/opencode-go/subscriptions/${encodeURIComponent(sub.id)}`, {
            method: 'PUT',
            body: { key: key.trim() }
          });
          clearGoEstimate(sub);
          await loadConfig();
          await load(true);
        } catch (err) {
          showBanner(`换 Key 失败：${err.message}`);
        }
      }, 'btn small')
    );
    actions.append(
      cardAction('删除', async () => {
        if (!window.confirm(`删除订阅「${sub.name}」？会同时清掉它保存的 Key。`)) return;
        try {
          await api(`/api/opencode-go/subscriptions/${encodeURIComponent(sub.id)}`, { method: 'DELETE' });
          clearGoEstimate(sub);
          await loadConfig();
          await load(true);
        } catch (err) {
          showBanner(`删除失败：${err.message}`);
        }
      }, 'btn small')
    );
    row.append(main, actions);
    goList.append(row);
  }
}

function renderCodexCandidates(candidates) {
  codexCandidates.replaceChildren();
  if (!candidates.length) {
    codexCandidates.append(el('div', 'note', '没有发现新的 Codex 登录态文件；已知路径可以直接填到上面添加。'));
    return;
  }
  for (const candidate of candidates) {
    const row = el('div', 'account-row');
    const main = el('div', 'account-main');
    main.append(el('div', 'account-name', candidate.nameGuess || 'Codex 账户'));
    main.append(el('div', 'account-path', shortenDisplayPath(candidate.path)));
    const actions = el('div', 'account-actions');
    actions.append(el('span', 'tag ok', '登录态正常'));
    actions.append(
      cardAction('添加', async () => {
        try {
          await api('/api/codex/accounts', {
            method: 'POST',
            body: { name: candidate.nameGuess, authPath: candidate.path }
          });
          codexResult.className = 'form-result ok';
          codexResult.textContent = '已添加，正在刷新…';
          codexCandidates.replaceChildren();
          await loadConfig();
          await load(true);
        } catch (err) {
          codexResult.className = 'form-result err';
          codexResult.textContent = `添加失败：${err.message}`;
        }
      }, 'btn small primary')
    );
    row.append(main, actions);
    codexCandidates.append(row);
  }
}

codexForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(codexForm);
  const payload = {
    name: String(form.get('name') || '').trim(),
    authPath: String(form.get('authPath') || '').trim(),
    authJson: String(form.get('authJson') || '').trim()
  };
  if (!payload.authPath && !payload.authJson) {
    codexResult.className = 'form-result err';
    codexResult.textContent = '请填写 auth.json 路径，或粘贴其内容';
    return;
  }
  codexResult.className = 'form-result';
  codexResult.textContent = '添加中…';
  try {
    await api('/api/codex/accounts', { method: 'POST', body: payload });
    codexResult.className = 'form-result ok';
    codexResult.textContent = '已添加，正在查询…';
    codexForm.reset();
    codexCandidates.replaceChildren();
    await loadConfig();
    await load(true);
    codexResult.textContent = '已添加并完成查询';
  } catch (err) {
    codexResult.className = 'form-result err';
    codexResult.textContent = `添加失败：${err.message}`;
  }
});

codexScan.addEventListener('click', async () => {
  codexResult.className = 'form-result';
  codexResult.textContent = '扫描中…';
  try {
    const data = await api('/api/codex/scan');
    renderCodexCandidates(data.candidates || []);
    codexResult.textContent = `发现 ${(data.candidates || []).length} 个候选账户`;
  } catch (err) {
    codexResult.className = 'form-result err';
    codexResult.textContent = `扫描失败：${err.message}`;
  }
});

deviceLoginStart.addEventListener('click', startDeviceLogin);
deviceLoginCancel.addEventListener('click', cancelDeviceLogin);
deviceLoginCopy.addEventListener('click', copyDeviceLoginCode);

function toggleNewapiFields() {
  const type = relayType.value;
  rowNewapi.style.display = type === 'newapi-account' || type === 'newapi-token' ? '' : 'none';
  if (type !== 'newapi-account') {
    addForm.elements.userId.value = '';
  }
}

addForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(addForm);
  const payload = {
    name: String(form.get('name') || '').trim(),
    type: String(form.get('type') || ''),
    baseUrl: String(form.get('baseUrl') || '').trim(),
    userId: String(form.get('userId') || '').trim(),
    token: String(form.get('token') || '').trim(),
    quotaPerUsd: Number(form.get('quotaPerUsd')) || undefined
  };
  const submit = addForm.querySelector('button[type="submit"]');
  submit.disabled = true;
  addResult.className = 'form-result';
  addResult.textContent = '保存中…';
  try {
    await api('/api/relays', { method: 'POST', body: payload });
    addResult.className = 'form-result ok';
    addResult.textContent = '已保存，正在查询…';
    addForm.reset();
    relayType.value = 'newapi-account';
    toggleNewapiFields();
    await load(true);
    addResult.textContent = '已添加并完成查询';
  } catch (err) {
    addResult.className = 'form-result err';
    addResult.textContent = `添加失败：${err.message}`;
  } finally {
    submit.disabled = false;
  }
});

relayType.addEventListener('change', toggleNewapiFields);

goForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(goForm);
  const key = String(form.get('key') || '').trim();
  const name = String(form.get('name') || '').trim() || 'OpenCode Go';
  const provider = String(form.get('provider') || '').trim() || 'opencode-go2';
  if (!key) {
    goResult.className = 'form-result err';
    goResult.textContent = '请填写 Go API Key（oc_sk_…）';
    return;
  }
  goResult.className = 'form-result';
  goResult.textContent = '添加中…';
  try {
    await api('/api/opencode-go/subscriptions', { method: 'POST', body: { name, provider, key } });
    goResult.className = 'form-result ok';
    goResult.textContent = '已添加，正在查询额度…';
    goForm.reset();
    await loadConfig();
    await load(true);
    goResult.textContent = '订阅已添加并完成查询';
  } catch (err) {
    goResult.className = 'form-result err';
    goResult.textContent = `添加失败：${err.message}`;
  }
});

deepseekPlatformForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const token = String(new FormData(deepseekPlatformForm).get('token') || '').trim();
  if (!token) {
    deepseekPlatformResult.className = 'form-result err';
    deepseekPlatformResult.textContent = '请填写平台 userToken';
    return;
  }
  deepseekPlatformResult.className = 'form-result';
  deepseekPlatformResult.textContent = '保存中…';
  try {
    await api('/api/deepseek-platform-token', { method: 'PUT', body: { token } });
    deepseekPlatformResult.className = 'form-result ok';
    deepseekPlatformResult.textContent = '已保存，正在查询官方余额与消费…';
    deepseekPlatformForm.reset();
    await load(true);
    deepseekPlatformResult.textContent = '登录态已保存并完成查询';
  } catch (err) {
    deepseekPlatformResult.className = 'form-result err';
    deepseekPlatformResult.textContent = `保存失败：${err.message}`;
  }
});

deepseekPlatformClear.addEventListener('click', async () => {
  if (!window.confirm('清除本机保存的 DeepSeek 平台登录态？')) return;
  try {
    await api('/api/deepseek-platform-token', { method: 'DELETE' });
    deepseekPlatformResult.className = 'form-result ok';
    deepseekPlatformResult.textContent = '已清除';
    await load(true);
  } catch (err) {
    deepseekPlatformResult.className = 'form-result err';
    deepseekPlatformResult.textContent = `清除失败：${err.message}`;
  }
});

const dailyRangeEl = document.querySelector('#daily-range');
if (dailyRangeEl) {
  dailyRangeEl.addEventListener('change', () => {
    const range = dailyRangeEl.value;
    if (!DAILY_RANGES.includes(range)) return;
    dailyRange = range;
    loadDaily(true);
  });
}

const dailyModeEl = document.querySelector('#daily-mode');
if (dailyModeEl) {
  dailyModeEl.addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-mode]');
    if (!btn) return;
    const mode = btn.dataset.mode;
    if (!DAILY_MODES.includes(mode)) return;
    dailyMode = mode;
    dailyModeEl.querySelectorAll('button').forEach((item) => {
      const active = item === btn;
      item.classList.toggle('active', active);
      item.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    if (state.dailyData) renderDaily(state.dailyData);
  });
}

if (DARK_QUERY && DARK_QUERY.addEventListener) {
  DARK_QUERY.addEventListener('change', () => {
    if (state.dailyData) renderActiveHistoryView(state.dailyData);
  });
}



// ── 每日总用量（所有来源合并的柱状图）────────────────────────────
const totalValueEl = document.querySelector('#total-value');
const totalChartEl = document.querySelector('#total-chart');
const totalNoteEl = document.querySelector('#total-note');
const totalRangeLabelEl = document.querySelector('#total-range-label');
const totalModeEl = document.querySelector('#total-mode');
let totalMode = 'bar';
// 总用量图自己的范围：30 天（默认，类似 Codex 的柱状图）/ 90 天 / 全部
let totalRange = '30';
const totalRangeEl = document.querySelector('#total-range');
let totalChartInstance = null;

function sourceStack() {
  return [
    { key: 'codexTokens', name: 'Codex', color: moduleColor('codex', '#c15f3c') },
    { key: 'deepseekTokens', name: 'DeepSeek', color: moduleColor('deepseek', '#bb8a52') },
    { key: 'opencodeTokens', name: 'OpenCode Go', color: moduleColor('opencode', '#7e8f6b') },
    { key: 'opencodeOtherTokens', name: '其它路由', color: moduleColor('other', '#9c958c') }
  ];
}

function totalOf(entry) {
  return sourceStack().reduce((sum, source) => sum + Number(entry[source.key] || 0), 0);
}

/** 天数太多时按周聚合，避免柱子细到看不清。 */
function bucketSeries(series) {
  if (series.length <= 120) {
    return series.map((entry) => ({
      label: entry.date.slice(5),
      date: entry.date,
      values: sourceStack().map((source) => Number(entry[source.key] || 0)),
      total: totalOf(entry)
    }));
  }
  const buckets = new Map();
  for (const entry of series) {
    const monday = mondayOf(entry.date);
    if (!buckets.has(monday)) {
      buckets.set(monday, { label: monday.slice(5), date: monday, values: sourceStack().map(() => 0), total: 0 });
    }
    const bucket = buckets.get(monday);
    sourceStack().forEach((source, index) => {
      bucket.values[index] += Number(entry[source.key] || 0);
    });
    bucket.total += totalOf(entry);
  }
  return [...buckets.values()];
}

function disposeTotalChart() {
  if (!totalChartInstance) return;
  totalChartInstance.dispose();
  totalChartInstance = null;
}

function renderTotalChart(data) {
  if (!totalChartEl || totalChartEl.closest('#total').hidden) return;
  const series = historySeries(data, totalRange);
  disposeTotalChart();
  if (!series.length) {
    if (totalValueEl) totalValueEl.textContent = '—';
    if (totalRangeLabelEl) totalRangeLabelEl.textContent = '此时段暂无用量记录';
    return;
  }
  const buckets = bucketSeries(series);
  const grandTotal = series.reduce((sum, entry) => sum + totalOf(entry), 0);
  if (totalValueEl) totalValueEl.textContent = fmtTokens(grandTotal);

  let running = 0;
  const cumulative = buckets.map((bucket) => {
    running += bucket.total;
    return running;
  });
  // 7 日移动平均：让波动更有轮廓
  const totals = buckets.map((bucket) => bucket.total);
  const average = totals.map((_, index) => {
    const from = Math.max(0, index - 6);
    const slice = totals.slice(from, index + 1);
    return Math.round(slice.reduce((sum, value) => sum + value, 0) / slice.length);
  });

  if (totalRangeLabelEl) {
    const rangeText = totalRange === 'all' ? '全部历史' : `近 ${totalRange} 天`;
    const stale = Array.isArray(data.codexStale) && data.codexStale.length ? ' · 含 Codex 历史快照' : '';
    totalRangeLabelEl.textContent = `${rangeText} · ${series.length} 天${stale}`;
  }

  // 图例：色点 + 名称（+ 均线）
  const legendEl = document.querySelector('#total-legend');
  if (legendEl) {
    legendEl.replaceChildren();
    const items = totalMode === 'cum'
      ? [{ name: '累计', color: '#c96442' }]
      : [...sourceStack().map((item) => ({ name: item.name, color: item.color })), { name: '7 日均线', color: '#9a9386', dashed: true }];
    for (const item of items) {
      const chip = el('span', 'tl-item');
      const dot = el('i', 'tl-chip' + (item.dashed ? ' tl-chip-line' : ''));
      dot.style.background = item.color;
      chip.append(dot, document.createTextNode(item.name));
      legendEl.append(chip);
    }
  }

  const echarts = echartsLib();
  if (!echarts) return;
  totalChartInstance = echarts.init(totalChartEl, null, { renderer: 'canvas' });
  const theme = echartsTheme();
  const baseOption = {
    animationDuration: 320,
    animationEasing: 'cubicOut',
    backgroundColor: 'transparent',
    grid: { left: 48, right: 14, top: 16, bottom: 26 },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(31,30,29,0.045)' } },
      backgroundColor: theme.tipBg,
      borderColor: theme.tipBorder,
      borderWidth: 1,
      padding: [9, 12],
      textStyle: { color: theme.tipText, fontSize: 12 },
      extraCssText: 'border-radius:12px;box-shadow:0 14px 34px rgba(31,30,29,.14)',
      formatter: (params) => {
        if (!params || !params.length) return '';
        const index = params[0].dataIndex;
        const bucket = buckets[index];
        if (!bucket) return '';
        if (totalMode === 'cum') {
          return `<b>${bucket.date}</b><br/>累计 <b>${fmtTokens(cumulative[index])}</b> tokens`;
        }
        const lines = sourceStack()
          .map((source, i) => (bucket.values[i] > 0 ? `<span style="display:flex;justify-content:space-between;gap:16px"><span style="opacity:.72">${source.name}</span><b>${fmtTokens(bucket.values[i])}</b></span>` : null))
          .filter(Boolean)
          .join('');
        return `<div style="min-width:150px"><b>${bucket.date}</b>${lines ? '<div style="margin-top:4px">' + lines + '</div>' : ''}<div style="margin-top:5px;padding-top:5px;border-top:1px solid rgba(128,128,128,.22);display:flex;justify-content:space-between;gap:16px"><span style="opacity:.72">合计</span><b>${fmtTokens(bucket.total)}</b></div></div>`;
      }
    },
    xAxis: {
      type: 'category',
      data: buckets.map((bucket) => bucket.label),
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: theme.label, fontSize: 10.5, margin: 12, hideOverlap: true }
    },
    yAxis: {
      type: 'value',
      splitNumber: 4,
      axisLine: { show: false },
      axisTick: { show: false },
      splitLine: { lineStyle: { color: theme.gap, type: 'dashed', width: 1 } },
      axisLabel: {
        color: theme.label,
        fontSize: 10.5,
        margin: 10,
        formatter: (value) => (value >= 1e8 ? (value / 1e8).toFixed(1) + ' 亿' : value >= 1e6 ? (value / 1e6).toFixed(0) + ' M' : value)
      }
    }
  };

  if (totalMode === 'cum') {
    totalChartInstance.setOption({
      ...baseOption,
      series: [{
        name: '累计',
        type: 'line',
        smooth: 0.35,
        showSymbol: false,
        data: cumulative,
        lineStyle: { width: 2, color: '#c96442' },
        areaStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: 'rgba(201,100,66,0.22)' },
            { offset: 1, color: 'rgba(201,100,66,0.01)' }
          ])
        }
      }]
    }, true);
  } else {
    totalChartInstance.setOption({
      ...baseOption,
      series: [
        ...sourceStack().map((source, index) => ({
          name: source.name,
          type: 'bar',
          stack: 'total',
          barMaxWidth: 11,
          barCategoryGap: '42%',
          data: buckets.map((bucket) => bucket.values[index]),
          itemStyle: { color: source.color, borderRadius: [3, 3, 0, 0] },
          emphasis: { focus: 'series' }
        })),
        {
          name: '7 日均线',
          type: 'line',
          smooth: 0.4,
          symbol: 'none',
          data: average,
          lineStyle: { width: 1.5, color: '#9a9386', type: [4, 4], opacity: 0.9 },
          z: 6
        }
      ]
    }, true);
  }
}

totalRangeEl?.addEventListener('change', () => {
  totalRange = totalRangeEl.value;
  if (totalRange === 'all' && state.dailyData?.days !== 3650) loadDaily();
  else if (state.dailyData) renderTotalChart(state.dailyData);
});

if (totalModeEl) {
  totalModeEl.addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-tmode]');
    if (!btn) return;
    totalMode = btn.dataset.tmode;
    totalModeEl.querySelectorAll('button').forEach((item) => {
      const active = item === btn;
      item.classList.toggle('active', active);
      item.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    if (state.dailyData) renderTotalChart(state.dailyData);
  });
}

// ── 导入历史用量 ────────────────────────────────────────────────
const importForm = document.querySelector('#import-form');
const importFile = document.querySelector('#import-file');
const importResult = document.querySelector('#import-result');

if (importFile) {
  importFile.addEventListener('change', async () => {
    const file = importFile.files && importFile.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const textarea = importForm && importForm.querySelector('textarea[name="data"]');
      if (textarea) textarea.value = text;
      if (importResult) {
        importResult.className = 'form-result ok';
        importResult.textContent = `已读取 ${file.name}（${(file.size / 1024).toFixed(1)} KB）`;
      }
    } catch (err) {
      if (importResult) {
        importResult.className = 'form-result err';
        importResult.textContent = '读取文件失败：' + err.message;
      }
    }
  });
}

if (importForm) {
  importForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(importForm);
    const channel = String(form.get('channel') || '');
    const data = String(form.get('data') || '').trim();
    if (!data) {
      importResult.className = 'form-result err';
      importResult.textContent = '请粘贴数据或选择文件';
      return;
    }
    const submit = importForm.querySelector('button[type="submit"]');
    if (submit) submit.disabled = true;
    importResult.className = 'form-result';
    importResult.textContent = '导入中…';
    try {
      const result = await api('/api/daily/import', { method: 'POST', body: { channel, data } });
      importResult.className = 'form-result ok';
      const bits = [
        `导入 ${result.importedRows} 行`,
        `新增 ${result.addedDays} 天`,
        `更新 ${result.updatedDays} 天`
      ];
      if (result.history) bits.push(`存档共 ${result.history.days} 天`);
      if (result.errors && result.errors.length) bits.push(`${result.errors.length} 行有问题（已跳过）`);
      importResult.textContent = bits.join(' · ');
      if (result.errors && result.errors.length) {
        importResult.textContent += '：' + result.errors[0];
      }
      await Promise.all([loadDaily(true), loadUsage()]);
    } catch (err) {
      importResult.className = 'form-result err';
      importResult.textContent = '导入失败：' + err.message;
    } finally {
      if (submit) submit.disabled = false;
    }
  });
}

// ── 自动重载：样式/脚本被改过就刷新页面，避免一直看着旧界面 ──────────────
let buildStamp = null;
async function checkBuild() {
  try {
    const next = await api('/api/version');
    const fingerprint = [next.html, next.js, next.css].join(':');
    if (buildStamp === null) {
      buildStamp = fingerprint;
      return;
    }
    if (fingerprint !== buildStamp) {
      buildStamp = fingerprint;
      window.location.reload();
    }
  } catch {
    /* 忽略：拿不到版本不影响使用 */
  }
}
setInterval(checkBuild, 60 * 1000);
checkBuild();

let resizeTimer = null;
window.addEventListener('resize', () => {
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (state.dailyData) renderActiveHistoryView(state.dailyData);
  }, 200);
});

let dashboardNavigate;

function navigateDashboard(id) {
  dashboardNavigate?.('#' + id);
}

function initDashboardSidebar() {
  const sidebar = document.querySelector('#dashboard-sidebar');
  const drawer = document.querySelector('#sidebar-drawer');
  const toggle = document.querySelector('#sidebar-toggle');
  const main = document.querySelector('#dashboard-main');
  const overviewHeading = document.querySelector('#dashboard-overview-heading');
  const viewHeading = document.querySelector('#dashboard-view-title');
  const managementNav = document.querySelector('#management-nav');
  const daily = document.querySelector('#daily');
  if (!sidebar || !drawer || !toggle || !main || !overviewHeading || !viewHeading || !managementNav || !daily) return;

  const close = sidebar.querySelector('.sidebar-close');
  const header = toggle.closest('.topbar');
  const narrow = window.matchMedia('(max-width: 960px)');
  const routes = (links) => [...links].map((link) => {
    const hash = link.getAttribute('href');
    return { link, hash, target: document.getElementById(hash.slice(1)) };
  }).filter((entry) => entry.target);
  const entries = routes(sidebar.querySelectorAll('nav a'));
  const managementEntries = routes(managementNav.querySelectorAll('a'));
  const overview = entries.find((entry) => entry.hash === '#usage');
  const trend = entries.find((entry) => entry.hash === '#total');
  const manage = entries.find((entry) => entry.hash === '#manage');
  const sources = managementEntries.find((entry) => entry.hash === '#sources');
  let active;

  function show(hash, moveFocus) {
    const showDaily = hash === '#daily';
    let entry = !hash || showDaily ? overview : entries.find((item) => item.hash === hash);
    let managementPage = managementEntries.find((item) => item.hash === hash);
    let sourcePanel;
    if (!entry && !managementPage) {
      const id = hash === '#codex' ? 'codex-panel' : hash.slice(1);
      const candidate = document.getElementById(id);
      if (candidate instanceof HTMLDetailsElement && candidate.parentElement === sources?.target) {
        sourcePanel = candidate;
        managementPage = sources;
      }
    }
    if (managementPage) entry = manage;
    if (!entry) return false;
    if (drawer.open) drawer.close();
    if (entry === manage) {
      const selected = managementPage || managementEntries[0];
      for (const item of managementEntries) {
        item.target.hidden = item !== selected;
        if (item === selected) item.link.setAttribute('aria-current', 'page');
        else item.link.removeAttribute('aria-current');
      }
    }
    if (active !== entry) {
      if (active === overview) disposeDailyCharts();
      if (active === trend) {
        disposeTotalChart();
        disposeUsageShare();
      }
      for (const item of entries) {
        item.target.hidden = item !== entry;
        if (item === entry) item.link.setAttribute('aria-current', 'page');
        else item.link.removeAttribute('aria-current');
      }
      active = entry;
      overviewHeading.hidden = entry !== overview;
      viewHeading.hidden = entry === overview;
      viewHeading.textContent = entry.link.textContent.trim();
      syncHeaderOffset();
      if ((entry === overview || entry === trend) && state.usage) renderUsage(state.usage);
      if (state.dailyData) renderActiveHistoryView(state.dailyData);
    }
    if (sourcePanel) {
      sourcePanel.open = true;
      sourcePanel.scrollIntoView({ block: 'start' });
    } else if (showDaily) {
      daily.scrollIntoView({ block: 'start' });
    } else {
      window.scrollTo(0, 0);
    }
    if (moveFocus) {
      const heading = sourcePanel?.querySelector('summary') ||
        (showDaily ? document.querySelector('#daily-heading') : null) ||
        (entry === overview ? overviewHeading.querySelector('h1, input') : viewHeading);
      heading?.focus({ preventScroll: true });
    }
    if (entry === manage) loadGoModelUsage();
    return true;
  }

  function syncHeaderOffset() {
    document.body.style.setProperty('--sidebar-header-offset', `${header.offsetHeight}px`);
  }

  function syncLayout() {
    if (narrow.matches) {
      drawer.append(sidebar);
      toggle.hidden = false;
    } else {
      const restoreFocus = drawer.open;
      if (restoreFocus) drawer.close();
      header.before(sidebar);
      toggle.hidden = true;
      if (restoreFocus) sidebar.querySelector('[aria-current]')?.focus({ preventScroll: true });
    }
    syncHeaderOffset();
  }

  toggle.addEventListener('click', () => {
    if (drawer.open) return;
    drawer.showModal();
    toggle.setAttribute('aria-expanded', 'true');
    close?.focus();
  });
  close?.addEventListener('click', () => drawer.close());
  drawer.addEventListener('click', (event) => {
    if (event.target === drawer) drawer.close();
  });
  drawer.addEventListener('close', () => toggle.setAttribute('aria-expanded', 'false'));
  dashboardNavigate = (hash) => {
    if (!show(hash, true)) return false;
    if (location.hash !== hash) history.pushState(null, '', hash);
    return true;
  };
  function followRoute(event) {
    const link = event.target.closest('a[href^="#"]');
    if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey ||
        event.shiftKey || event.altKey) return;
    if (dashboardNavigate(link.getAttribute('href'))) event.preventDefault();
  }
  sidebar.addEventListener('click', followRoute);
  managementNav.addEventListener('click', followRoute);
  document.querySelector('.dashboard-skip')?.addEventListener('click', (event) => {
    event.preventDefault();
    main.focus();
  });
  narrow.addEventListener('change', syncLayout);
  new ResizeObserver(syncHeaderOffset).observe(header);
  window.addEventListener('hashchange', () => show(location.hash, false));
  syncLayout();
  if (!show(location.hash, false)) show('', false);
}

initDashboardSidebar();
refreshBtn.addEventListener('click', () => load(true));
autoEl.addEventListener('change', () => {
  state.auto = autoEl.checked;
  updateTimers();
});

setInterval(() => {
  updateTimers();
  if (state.auto && !state.loading && state.data && Date.now() >= state.nextAt) {
    load(false);
  }
}, 1000);

toggleNewapiFields();
renderIcons();
loadTheme();
loadConfig();
load(false);
resumeDeviceLogin();












