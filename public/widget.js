const listEl = document.querySelector('#w-list');
const usageEl = document.querySelector('#w-usage');
const updatedEl = document.querySelector('#w-updated');
const refreshBtn = document.querySelector('#w-refresh');
const nextEl = document.querySelector('#w-next');

let nextAt = 0;
let loading = false;

// ── 配色主题（H7）：widget 跟随 /api/theme；失败回退 /api/config → 默认 claude ─────────
// 契约：server/lib/theme.mjs 是事实来源；这里只消费 GET /api/theme 的 { current, vars }。
const THEME_PRESETS = ['claude', 'graphite', 'sage', 'midnight', 'sunset', 'custom'];
const DEFAULT_UI_THEME = {
  preset: 'claude',
  mode: 'light',
  accent: null,
  modules: { codex: null, deepseek: null, opencodeGo: null, relay: null, other: null }
};
const THEME_VARS = [
  '--paper', '--paper-tint', '--surface', '--surface-2', '--ink', '--ink-soft', '--muted', '--muted-2',
  '--line', '--line-strong', '--accent', '--accent-ink', '--accent-soft', '--accent-wash', '--on-accent',
  '--sage', '--ochre', '--brick', '--slate',
  '--mod-codex', '--mod-deepseek', '--mod-opencode', '--mod-relay', '--mod-other'
];
const THEME_MODULE_VARS = { codex: '--mod-codex', deepseek: '--mod-deepseek', opencodeGo: '--mod-opencode', relay: '--mod-relay', other: '--mod-other' };
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

let currentTheme = DEFAULT_UI_THEME;
let currentThemeVars = null;

function isHexColor(value) {
  return typeof value === 'string' && HEX_COLOR_RE.test(value.trim());
}

function normalizeWidgetTheme(input) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const preset = THEME_PRESETS.includes(source.preset) ? source.preset : DEFAULT_UI_THEME.preset;
  const mode = ['light', 'dark', 'auto'].includes(source.mode) ? source.mode : DEFAULT_UI_THEME.mode;
  const accent = isHexColor(source.accent) ? source.accent.trim() : null;
  const modules = {};
  for (const key of Object.keys(DEFAULT_UI_THEME.modules)) {
    const value = source.modules && typeof source.modules === 'object' ? source.modules[key] : null;
    modules[key] = isHexColor(value) ? value.trim() : null;
  }
  return { preset, mode, accent, modules };
}

function resolvedWidgetMode(mode) {
  if (mode !== 'auto') return mode;
  try {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

/** 把主题写到 documentElement：data-preset/data-mode + CSS 变量；只接受 #rrggbb，不认未知变量。 */
function applyWidgetTheme(input, vars) {
  const theme = normalizeWidgetTheme(input);
  currentTheme = theme;
  currentThemeVars = vars && typeof vars === 'object' ? vars : null;
  const mode = resolvedWidgetMode(theme.mode);
  const root = document.documentElement;
  root.dataset.preset = theme.preset;
  root.dataset.mode = mode;
  root.style.colorScheme = mode;
  const resolved = {};
  if (currentThemeVars) {
    for (const key of THEME_VARS) {
      const value = currentThemeVars[key];
      if (isHexColor(value)) resolved[key] = value.trim();
    }
  }
  if (theme.accent && !resolved['--accent']) resolved['--accent'] = theme.accent;
  for (const key of Object.keys(THEME_MODULE_VARS)) {
    const varName = THEME_MODULE_VARS[key];
    if (theme.modules[key] && !resolved[varName]) resolved[varName] = theme.modules[key];
  }
  for (const key of THEME_VARS) {
    if (resolved[key]) root.style.setProperty(key, resolved[key]);
    else root.style.removeProperty(key);
  }
}

function systemPrefersDark() {
  try {
    return Boolean(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  } catch {
    return false;
  }
}

async function loadWidgetTheme() {
  const systemDark = systemPrefersDark();
  let theme = null;
  let vars = null;
  let hasDarkVars = false;
  try {
    // P1-1：把系统明暗传给服务端（R2 支持 ?systemDark=），并兼容 varsLight/varsDark 本地选择。
    const response = await fetch('/api/theme?systemDark=' + (systemDark ? '1' : '0'), {
      headers: { accept: 'application/json' }
    });
    if (response.ok) {
      const data = await response.json();
      theme = data && data.current ? data.current : null;
      const varsLight = data && data.varsLight && typeof data.varsLight === 'object' ? data.varsLight : null;
      const varsDark = data && data.varsDark && typeof data.varsDark === 'object' ? data.varsDark : null;
      // 先按“解析后的模式”选色：显式 light/dark 优先，auto 才看系统。
      const targetMode = theme && theme.mode === 'auto' ? (systemDark ? 'dark' : 'light') : (theme && theme.mode === 'dark' ? 'dark' : 'light');
      if (varsLight || varsDark) {
        vars = targetMode === 'dark' ? (varsDark || varsLight) : (varsLight || varsDark);
        hasDarkVars = Boolean(varsDark);
      } else {
        vars = data && data.vars && typeof data.vars === 'object' ? data.vars : null;
      }
    }
  } catch {
    /* /api/theme 未实现或离线：直接用内置 DEFAULT_UI_THEME（P3-5，不再依赖 /api/config.ui） */
  }
  if (!theme) {
    applyWidgetTheme(DEFAULT_UI_THEME, null);
    return;
  }
  // 旧版服务端：mode=auto 时 vars 固定按 systemDark:false 解析；系统深色下套浅色 vars 会造成浅字/浅卡错乱，
  // 此时不写基础 vars，交给 CSS 的 :root[data-mode="dark"] 兜底；accent/module 覆盖在 applyWidgetTheme 内补齐。
  if (theme.mode === 'auto' && systemDark && !hasDarkVars) vars = null;
  applyWidgetTheme(theme, vars);
}

function watchSystemTheme() {
  try {
    if (!window.matchMedia) return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      if (currentTheme && currentTheme.mode === 'auto') loadWidgetTheme().catch(() => {});
    };
    if (media.addEventListener) media.addEventListener('change', onChange);
    else if (media.addListener) media.addListener(onChange);
  } catch {
    /* ignore */
  }
}

function moduleKeyOf(provider) {
  if (provider && provider.kind === 'codex') return 'codex';
  if (provider && provider.kind === 'opencode-go') return 'opencodeGo';
  if (provider && (provider.kind === 'deepseek' || provider.kind === 'deepseek-platform')) return 'deepseek';
  if (provider && (provider.kind === 'relay' || provider.relayType)) return 'relay';
  return 'other';
}

function moduleDot(provider, label) {
  const dot = el('span', 'w-dot');
  dot.dataset.module = moduleKeyOf(provider);
  dot.title = label || '';
  dot.setAttribute('aria-hidden', 'true');
  return dot;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
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
  return n === null ? '—' : `${Math.round(n)}%`;
}

function fmtPercent(value) {
  return fmtQuotaPercent(value);
}

// F7：widget 跟随计划/窗口改造（planMeta.name + kind 标签；旧数据回退）
const WIDGET_NAME_LIMIT = 40;
const WIDGET_PLAN_LABELS = { free: 'Free', plus: 'Plus', pro: 'Pro', prolite: 'Pro Lite', 'pro-lite': 'Pro Lite', go: 'Go', team: '团队', enterprise: '企业' };
const WIDGET_KIND_LABELS = { session: '5 小时', '5h': '5 小时', weekly: '每周', monthly: '每月' };

function truncateText(value, max) {
  const text = String(value === null || value === undefined ? '' : value);
  const limit = Number.isFinite(Number(max)) && Number(max) > 0 ? Math.floor(Number(max)) : WIDGET_NAME_LIMIT;
  return text.length > limit ? text.slice(0, Math.max(1, limit - 1)) + '…' : text;
}

function setWidgetText(node, value, max) {
  if (!node) return node;
  const full = String(value === null || value === undefined ? '' : value);
  node.textContent = truncateText(full, max);
  if (node.textContent !== full && full) node.title = full;
  return node;
}

function planLabelOf(provider) {
  const meta = provider && provider.planMeta;
  if (meta && meta.name) return String(meta.name);
  const key = String((provider && provider.plan) || '').toLowerCase().replace(/[$s_-]+/g, '');
  return WIDGET_PLAN_LABELS[key] || (provider && provider.plan ? String(provider.plan) : '');
}

function windowKindOf(window) {
  if (!window) return null;
  const explicit = String(window.kind || '').toLowerCase();
  if (explicit) return explicit;
  const seconds = Number(window.windowSeconds);
  if (seconds === 18000) return 'session';
  if (seconds === 604800) return 'weekly';
  if (seconds === 2592000) return 'monthly';
  if (window.key === '5h') return 'session';
  if (window.key === 'weekly') return 'weekly';
  if (window.key === 'monthly') return 'monthly';
  return null;
}

function windowLabelOf(window) {
  const kind = windowKindOf(window);
  if (kind && WIDGET_KIND_LABELS[kind]) return WIDGET_KIND_LABELS[kind];
  const seconds = Number(window && window.windowSeconds);
  if (Number.isFinite(seconds) && seconds > 0) {
    if (seconds % 86400 === 0) return seconds / 86400 + ' 天';
    if (seconds >= 3600) return Math.round(seconds / 3600) + ' 小时';
  }
  return (window && window.label) || '额度窗口';
}

function fmtTokens(value) {
  const n = Number(value) || 0;
  if (n >= 1e8) return `${(n / 1e8).toFixed(2)} 亿`;
  if (n >= 1e4) return `${(n / 1e4).toFixed(1)} 万`;
  return String(n);
}

function usageRow(name, value, cost, extraClass = '') {
  const row = el('div', `w-usage-row ${extraClass}`.trim());
  row.append(el('span', 'w-usage-name', name), el('span', 'w-usage-val', value));
  if (cost) row.append(el('span', 'w-usage-cost', cost));
  return row;
}

function renderUsage(data) {
  usageEl.replaceChildren();
  const channels = data.channels || [];
  const total = data.totalTokens || channels.reduce((sum, channel) => sum + Number(channel.tokens.total || 0), 0);
  usageEl.append(usageRow('Token 合计', fmtTokens(total)));
  for (const channel of channels) {
    let cost = '';
    if (channel.id === 'codex') cost = '订阅';
    else if (channel.costCny !== null && channel.costCny !== undefined) cost = `≈¥${Number(channel.costCny).toFixed(2)}`;
    usageEl.append(usageRow(channel.name, fmtTokens(channel.tokens.total), cost));
  }
}

async function loadUsage() {
  try {
    const response = await fetch('/api/usage');
    if (!response.ok) return;
    renderUsage(await response.json());
  } catch {
    /* 忽略统计失败，不影响额度卡 */
  }
}

function fmtMoney(value, unit) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  const n = Math.abs(Number(value)) >= 1000 ? Number(value).toFixed(0) : Number(value).toFixed(2);
  if (unit === 'USD') return `$${n}`;
  if (unit === 'CNY') return `¥${n}`;
  if (unit === 'CREDITS') return `${n} 积分`;
  return `${n} ${unit || ''}`.trim();
}

function fmtReset(iso) {
  if (!iso) return '';
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms)) return '';
  if (ms <= 0) return '即将重置';
  const seconds = Math.floor(ms / 1000);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days} 天 ${hours} 小时后重置`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分后重置`;
  return `${minutes} 分钟后重置`;
}

function resetSpan(iso) {
  const span = el('span', '', fmtReset(iso) || '—');
  if (iso) span.dataset.reset = iso;
  return span;
}

function levelClass(remaining) {
  if (remaining === null || remaining === undefined) return '';
  if (remaining <= 0) return 'danger';
  if (remaining <= 20) return 'warn';
  return '';
}

function fillClass(usedPercent) {
  if (usedPercent >= 80) return 'danger';
  if (usedPercent >= 50) return 'warn';
  return '';
}

function statusClass(status) {
  return ['ok', 'error', 'unconfigured', 'stale'].includes(status) ? status : '';
}

function kindMeta(provider) {
  if (provider.kind === 'codex') {
    const planName = planLabelOf(provider);
    return { label: planName ? 'Codex · ' + planName : 'Codex', cls: '' };
  }
  if (provider.kind === 'opencode-go') {
    return { label: 'OpenCode Go 套餐', cls: 'go' };
  }
  if (provider.kind === 'deepseek') {
    return { label: 'DeepSeek 余额', cls: 'relay' };
  }
  if (provider.kind === 'deepseek-platform') {
    return { label: 'DeepSeek 平台', cls: 'relay' };
  }
  const relayLabel = {
    'newapi-account': 'New API 账户',
    'newapi-token': 'New API 令牌',
    sub2api: 'Sub2API',
    generic: '自定义中转站'
  }[provider.relayType] || '中转站';
  return { label: relayLabel, cls: 'relay' };
}

function avatarText(provider) {
  if (provider.kind === 'opencode-go') return 'GO';
  if (provider.kind === 'relay') return '$';
  const name = (provider.name || '').replace(/^Codex\s*·\s*/i, '').trim();
  return name ? name.slice(0, 1).toUpperCase() : 'C';
}

function header(provider, meta) {
  const head = el('div', 'w-head');
  const avatar = el('div', `w-avatar ${meta.cls}`.trim(), avatarText(provider));
  const dot = moduleDot(provider, meta.label);
  const metaWrap = el('div', 'w-meta');
  metaWrap.style.minWidth = '0';
  const nameNode = el('div', 'w-name');
  setWidgetText(nameNode, provider.name || '未命名', WIDGET_NAME_LIMIT);
  const tagNode = el('div', 'w-tag');
  setWidgetText(tagNode, meta.label, WIDGET_NAME_LIMIT);
  metaWrap.append(nameNode, tagNode);
  head.append(dot, avatar, metaWrap, el('span', `w-status ${statusClass(provider.status)}`));
  head.style.flexWrap = 'wrap';
  return head;
}

function bar(usedPercent, className = '') {
  const wrap = el('div', 'w-bar');
  const fill = el('div', `w-fill ${fillClass(Number(usedPercent) || 0)}`.trim());
  fill.style.width = `${Math.max(0, Math.min(100, Number(usedPercent) || 0))}%`;
  if (className) fill.classList.add(className);
  wrap.append(fill);
  return wrap;
}

function remainCard(provider) {
  const meta = kindMeta(provider);
  const windows = provider.windows || [];
  const main = windows[0] || null;
  const used = main ? clampQuotaPercent(main.usedPercent) : null;
  const remaining = used === null ? null : Math.max(0, 100 - used);
  const level = levelClass(remaining);

  const card = el('article', `w-card ${level}`.trim());
  card.dataset.module = moduleKeyOf(provider);
  card.append(header(provider, meta));

  if (main) {
    const mainRow = el('div', 'w-main');
    const remainWrap = el('div', 'w-remain-wrap');
    remainWrap.append(el('div', 'w-remain', remaining === null ? '—' : `${Math.round(remaining)}%`));
    remainWrap.append(el('div', 'w-remain-label', '剩余'));
    mainRow.append(remainWrap);
    const reset = el('div', 'w-reset');
    reset.style.whiteSpace = 'normal';
    reset.append(resetSpan(main.resetAt));
    mainRow.append(reset);
    mainRow.style.flexWrap = 'wrap';
    card.append(mainRow, bar(used));
  }

  const rows = el('div', 'w-rows');
  for (const window of windows.slice(1, 4)) {
    const row = el('div', 'w-row');
    const windowUsed = clampQuotaPercent(window.usedPercent);
    row.append(el('span', '', windowLabelOf(window)));
    const mini = el('span', 'w-mini');
    const fill = el('i', fillClass(windowUsed === null ? 0 : windowUsed));
    fill.style.width = (windowUsed === null ? 0 : windowUsed) + '%';
    mini.append(fill);
    row.append(mini);
    const right = el('span', '');
    right.style.marginLeft = 'auto';
    right.style.textAlign = 'right';
    right.style.whiteSpace = 'normal';
    const remainText = windowUsed === null ? '剩余 —' : '剩余 ' + Math.round(100 - windowUsed) + '%';
    right.append(document.createTextNode(remainText + ' · '));
    right.append(resetSpan(window.resetAt));
    row.append(right);
    row.style.display = 'flex';
    row.style.flexWrap = 'wrap';
    row.style.alignItems = 'baseline';
    row.style.gap = '2px 6px';
    rows.append(row);
  }
  if (rows.childNodes.length) card.append(rows);

  const chips = el('div', 'w-chips');
  const planChipLabel = planLabelOf(provider);
  if (planChipLabel) {
    const chip = el('span', 'w-chip');
    setWidgetText(chip, planChipLabel, WIDGET_NAME_LIMIT);
    chips.append(chip);
  }
  if (provider.credits) {
    const text = provider.credits.unlimited ? '额度 ∞' : `额度 ${provider.credits.balance ?? '—'}`;
    chips.append(el('span', 'w-chip credits', text));
  }
  if (provider.stale) chips.append(el('span', 'w-chip', '历史快照'));
  if (chips.childNodes.length) card.append(chips);

  if (provider.status !== 'ok' && provider.error) {
    card.append(el('div', 'w-note err', provider.error));
  }
  return card;
}

function relayCard(provider) {
  const meta = kindMeta(provider);
  const window = (provider.windows || [])[0] || null;
  const used = window ? clampQuotaPercent(window.usedPercent) : null;
  const remaining = used === null ? null : Math.max(0, 100 - used);
  const card = el('article', `w-card ${levelClass(remaining)}`.trim());
  card.dataset.module = moduleKeyOf(provider);
  card.append(header(provider, meta));

  if (window) {
    const main = el('div', 'w-main');
    const wrap = el('div', 'w-remain-wrap');
    wrap.append(el('div', 'w-remain', fmtMoney(window.remaining, window.unit)));
    wrap.append(el('div', 'w-remain-label', '余额'));
    main.append(wrap);
    card.append(main);
    if (window.usedPercent !== null) card.append(bar(window.usedPercent));
    if (window.limit !== null && window.limit !== undefined) {
      card.append(
        el('div', 'w-row', `已用 ${fmtMoney(window.spend, window.unit)} / 共 ${fmtMoney(window.limit, window.unit)}`)
      );
    }
  }

  const chips = el('div', 'w-chips');
  if (window && window.unit) chips.append(el('span', 'w-chip', window.unit));
  if (provider.stale) chips.append(el('span', 'w-chip', '历史快照'));
  if (chips.childNodes.length) card.append(chips);
  if (provider.status !== 'ok' && provider.error) card.append(el('div', 'w-note err', provider.error));
  return card;
}

function render(data) {
  listEl.replaceChildren();
  listEl.style.minWidth = '0';
  document.body.style.overflowX = 'hidden';
  const providers = data.providers || [];
  if (!providers.length) {
    listEl.append(el('div', 'w-loading', '还没有额度源'));
    return;
  }
  for (const provider of providers) {
    listEl.append(
      provider.kind === 'relay' || provider.kind === 'deepseek' || provider.kind === 'deepseek-platform'
        ? relayCard(provider)
        : remainCard(provider)
    );
  }
  updatedEl.textContent = `更新 ${new Date(data.generatedAt).toLocaleTimeString('zh-CN', { hour12: false })}`;
  nextAt = Date.now() + (data.refreshSeconds || 60) * 1000;
}

async function load() {
  if (loading) return;
  loading = true;
  refreshBtn.disabled = true;
  try {
    const response = await fetch('/api/quota');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    render(await response.json());
    loadUsage();
    loadWidgetTheme();
  } catch {
    updatedEl.textContent = '刷新失败';
  } finally {
    loading = false;
    refreshBtn.disabled = false;
  }
}

refreshBtn.addEventListener('click', load);

setInterval(() => {
  for (const node of document.querySelectorAll('[data-reset]')) {
    node.textContent = fmtReset(node.dataset.reset);
  }
  if (nextAt && Date.now() >= nextAt) load();
  nextEl.textContent = nextAt ? `${Math.max(0, Math.ceil((nextAt - Date.now()) / 1000))}s` : '';
}, 1000);

loadWidgetTheme();
watchSystemTheme();
load();
