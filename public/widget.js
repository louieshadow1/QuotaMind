const listEl = document.querySelector('#w-list');
const usageEl = document.querySelector('#w-usage');
const updatedEl = document.querySelector('#w-updated');
const refreshBtn = document.querySelector('#w-refresh');
const nextEl = document.querySelector('#w-next');

let nextAt = 0;
let loading = false;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function fmtPercent(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  return `${Math.round(Number(value))}%`;
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
    return { label: provider.plan ? `Codex · ${provider.plan}` : 'Codex', cls: '' };
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
  const metaWrap = el('div', 'w-meta');
  metaWrap.append(el('div', 'w-name', provider.name || '未命名'));
  metaWrap.append(el('div', 'w-tag', meta.label));
  head.append(avatar, metaWrap, el('span', `w-status ${statusClass(provider.status)}`));
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
  const used = main ? Number(main.usedPercent) : null;
  const remaining = used === null ? null : Math.max(0, 100 - used);
  const level = levelClass(remaining);

  const card = el('article', `w-card ${level}`.trim());
  card.append(header(provider, meta));

  if (main) {
    const mainRow = el('div', 'w-main');
    const remainWrap = el('div', 'w-remain-wrap');
    remainWrap.append(el('div', 'w-remain', remaining === null ? '—' : `${Math.round(remaining)}%`));
    remainWrap.append(el('div', 'w-remain-label', '剩余'));
    mainRow.append(remainWrap);
    const reset = el('div', 'w-reset');
    reset.append(resetSpan(main.resetAt));
    mainRow.append(reset);
    card.append(mainRow, bar(used));
  }

  const rows = el('div', 'w-rows');
  for (const window of windows.slice(1, 4)) {
    const row = el('div', 'w-row');
    row.append(el('span', '', window.label));
    const mini = el('span', 'w-mini');
    const fill = el('i', fillClass(Number(window.usedPercent) || 0));
    fill.style.width = `${Math.max(0, Math.min(100, Number(window.usedPercent) || 0))}%`;
    mini.append(fill);
    row.append(mini);
    const right = el('span', '');
    right.append(document.createTextNode(`剩余 ${fmtPercent(100 - Number(window.usedPercent || 0))} · `));
    right.append(resetSpan(window.resetAt));
    row.append(right);
    rows.append(row);
  }
  if (rows.childNodes.length) card.append(rows);

  const chips = el('div', 'w-chips');
  if (provider.plan) chips.append(el('span', 'w-chip', provider.plan));
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
  const used = window ? Number(window.usedPercent) : null;
  const remaining = used === null ? null : Math.max(0, 100 - used);
  const card = el('article', `w-card ${levelClass(remaining)}`.trim());
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

load();
