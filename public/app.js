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

const state = {
  data: null,
  usage: null,
  dailyData: null,
  config: null,
  loading: false,
  auto: true,
  nextAt: 0
};

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
    throw new Error((payload && payload.error) || `HTTP ${response.status}`);
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

// Claude 式土色系：赤陶 / 灰蓝 / 鼠尾草绿 / 陶土黄
const USAGE_COLORS = {
  codex: [
    ['#c15f3c', '#e08a6d'],
    ['#a34d31', '#c15f3c'],
    ['#bb8a52', '#d8b184']
  ],
  deepseek: ['#bb8a52', '#d8b184'],
  opencode: ['#7e8f6b', '#a3b392']
};

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
  item.append(el('div', 'ub-value', fmtTokens(value)));
  const meta = el('div', 'ub-meta');
  meta.append(el('span', '', metaLeft));
  meta.append(el('span', 'ub-share', `${share.toFixed(1)}%`));
  item.append(meta);
  const bar = el('div', 'ub-bar');
  const fill = el('i');
  fill.style.width = `${Math.max(2, Math.min(100, share))}%`;
  bar.append(fill);
  item.append(bar);
  return item;
}

function renderUsage(data) {
  usageCardsEl.replaceChildren();
  const channels = data.channels || [];
  const totalTokens = data.totalTokens || channels.reduce((sum, channel) => sum + Number(channel.tokens.total || 0), 0);
  const card = el('article', 'usage-card total usage-summary');
  const top = el('div', 'usage-top');
  top.append(el('span', 'usage-name', '合计'), el('span', 'usage-badge', '全部 Token'));
  card.append(top);
  const totalEl = el('div', 'usage-total usage-total-big', fmtTokens(totalTokens));
  totalEl.append(el('small', '', 'tokens'));
  totalEl.title = `精确值：${Number(totalTokens).toLocaleString('en-US')} tokens（各块按亿四舍五入，逐项相加可能差 0.01）`;
  card.append(totalEl);
  card.append(
    el('div', 'usage-detail', `${channels.length} 个来源 · Codex 双账号 + DeepSeek + OpenCode Go（含历史快照）`)
  );

  const breakdown = el('div', 'usage-breakdown');
  const codex = channels.find((channel) => channel.id === 'codex');
  const staleNote = '';
  // Codex 合成一个盒子：数值 = 两个账号累计之和（快照账号也计入），
  // 小字里拆出各账号，与 OpenCode Go「多个订阅合计」的呈现保持一致。
  const staleAccounts = [];
  if (codex) {
    const accounts = Array.isArray(codex.accounts) ? codex.accounts : [];
    for (const account of accounts) if (account.cached) staleAccounts.push(account);
    if (accounts.length) {
      const total = accounts.reduce((sum, account) => sum + Number(account.lifetimeTokens || 0), 0);
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
          USAGE_COLORS.codex[0],
          total
        )
      );
    } else {
      breakdown.append(
        usageBreakdownItem(
          'Codex',
          codex.tokens.total,
          '官方累计',
          totalTokens ? (codex.tokens.total / totalTokens) * 100 : 0,
          USAGE_COLORS.codex[0],
          codex.tokens.total
        )
      );
    }
  }

  const deepseek = channels.find((channel) => channel.id === 'deepseek');
  if (deepseek) {
    const value = Number(deepseek.tokens.total || 0);
    breakdown.append(
      usageBreakdownItem(
        'DeepSeek',
        value,
        `官方累计 ≈ ¥${Number(deepseek.costCny || 0).toFixed(2)}`,
        totalTokens ? (value / totalTokens) * 100 : 0,
        USAGE_COLORS.deepseek,
        value
      )
    );
  }

  const opencode = channels.find((channel) => channel.id === 'opencode');
  if (opencode) {
    const value = Number(opencode.tokens.total || 0);
    const subs = Array.isArray(opencode.subs) ? opencode.subs : [];
    const realSubs = subs.filter((item) => item.provider);
    const shortName = (name) => {
      const text = String(name || '');
      if (text.includes('谷歌')) return '谷歌';
      if (/github/i.test(text)) return 'Github';
      return text;
    };
    const split = subs.length > 1
      ? subs
          .filter((item) => item.provider)
          .map((item) => `${shortName(item.name)} ${fmtTokens(item.tokens.total)}`)
          .join(' · ')
      : '';
    const metaLeft = `套餐内 ≈ ¥${Number(opencode.costCny || 0).toFixed(2)}${split ? ` · ${split}` : ''}`;
    breakdown.append(
      usageBreakdownItem(
        realSubs.length > 1 ? `OpenCode Go（${realSubs.length} 个订阅合计）` : 'OpenCode Go',
        value,
        metaLeft,
        totalTokens ? (value / totalTokens) * 100 : 0,
        USAGE_COLORS.opencode,
        value
      )
    );
  }
  const other = channels.find((channel) => channel.id === 'opencode-other');
  if (other) {
    const value = Number(other.tokens.total || 0);
    breakdown.append(
      usageBreakdownItem(
        'OpenCode 其它路由',
        value,
        `未计入 Go 订阅 · 套餐外 ≈ ¥${Number(other.costCny || 0).toFixed(2)}`,
        totalTokens ? (value / totalTokens) * 100 : 0,
        ['#c9b79c', '#ddd2bd'],
        value
      )
    );
  }

  if (staleNote) card.append(el('div', 'usage-note', staleNote));
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
  usageUpdatedEl.textContent = `统计于 ${new Date(data.generatedAt).toLocaleTimeString('zh-CN', { hour12: false })} · 来自本机日志`;
}
async function loadUsage(force = false) {
  try {
    const data = await api(`/api/usage${force ? '?refresh=1' : ''}`);
    state.usage = data;
    renderUsage(data);
    if (state.data) render();
  } catch {
    usageUpdatedEl.textContent = 'Token 统计失败';
  }
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

const DAY_MS = 86400000;

function shiftDate(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00');
  return new Date(d.getTime() + days * DAY_MS).toISOString().slice(0, 10);
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
    const weekKeyOf = (dateStr) => {
      const d = new Date(dateStr + 'T00:00:00');
      const offset = (d.getDay() + 6) % 7;
      return new Date(d.getTime() - offset * DAY_MS).toISOString().slice(0, 10);
    };
    series.forEach((entry, index) => {
      const key = weekKeyOf(entry.date);
      weekTotals.set(key, (weekTotals.get(key) || 0) + raw[index]);
    });
    return series.map((entry, index) => ({
      date: entry.date,
      raw: raw[index],
      value: weekTotals.get(weekKeyOf(entry.date)) || 0,
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
  const accounts = (state.config && state.config.providers && state.config.providers.codex && state.config.providers.codex.accounts) || [];
  const hit = accounts.find((account) => account.accountId === accountId);
  if (hit) return hit.name;
  const id = String(accountId || '');
  return id.length > 10 ? id.slice(0, 8) + '…' : id || '未知账号';
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
    for (const [accountId, tokens] of Object.entries(entry.codexByAccount)) {
      if (Number(tokens) > 0) lines.push(`${accountLabel(accountId)}：${fmtTokens(tokens)}`);
    }
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
          ? '<br/><span style="opacity:.75">' + details.map((line) => line.replace(/[&<>]/g, '')).join('<br/>') + '</span>'
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

function heatCellSize(seriesLength) {
  const width = Math.max(420, (dailyRowsEl && dailyRowsEl.clientWidth) || 1200) - 56;
  const weeks = Math.ceil((seriesLength + 7) / 7);
  return Math.max(11, Math.min(22, Math.floor(width / weeks)));
}

function renderDailyRow(metric, series) {
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

  const cell = heatCellSize(series.length);
  const chartEl = el('div', 'hm-chart');
  chartEl.style.height = cell * 7 + 50 + 'px';
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

  row.append(head, chartEl, footer);

  // 等元素进 DOM 后再初始化，否则拿不到宽高
  requestAnimationFrame(() => {
    const echarts = echartsLib();
    if (!echarts || !chartEl.isConnected) return;
    let chart = echarts.getInstanceByDom(chartEl);
    if (!chart) chart = echarts.init(chartEl, null, { renderer: 'canvas' });
    chart.setOption(calendarOption({ series, metric, values, max, cell }), true);
    dailyCharts.push(chart);
  });

  return row;
}

function renderDaily(data) {
  disposeDailyCharts();
  dailyRowsEl.replaceChildren();
  const series = Array.isArray(data.series) ? data.series : [];
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
  if (!dailyFilter || dailyFilter.has(totalMetric.key)) dailyRowsEl.append(renderDailyRow(totalMetric, series));

  // ② 分渠道（可整体折叠）
  const detail = el('div', 'daily-detail');
  detail.id = 'daily-detail';
  const channelMetrics = [
    { key: 'codexTokens', name: 'Codex（官方按天）', color: '#c15f3c', costKey: null },
    {
      key: 'deepseekTokens',
      name: data.deepseekSource === 'official' ? 'DeepSeek（官方按天）' : 'DeepSeek（本机估算）',
      color: '#bb8a52',
      costKey: 'deepseekCostCny',
    },
    { key: 'opencodeTokens', name: 'OpenCode Go（本机估算）', color: '#7e8f6b', costKey: 'opencodeCostCny' },
    {
      key: 'opencodeOtherTokens',
      name: 'OpenCode 其它路由（本机估算）',
      color: '#9c958c',
      costKey: 'opencodeOtherCostCny',
      hideIfZero: true,
    },
  ];
  const visibleChannels = channelMetrics.filter((metric) => {
    const sum = series.reduce((acc, entry) => acc + metricValue(entry, metric), 0);
    if (metric.hideIfZero && sum === 0) return false;
    return !dailyFilter || dailyFilter.has(metric.key);
  });
  for (const metric of visibleChannels) detail.append(renderDailyRow(metric, series));

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
      name: `账号 · ${account.name || id.slice(0, 8)}`,
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
    for (const metric of visibleSources) subWrap.append(renderDailyRow(metric, series));
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

  renderTotalChart(data);
  const modeLabel = dailyMode === 'day' ? '按天' : dailyMode === 'week' ? '按周合计' : '累计总量';
  const history = data.history && data.history.days
    ? `已存档 ${data.history.days} 天${data.history.firstDate ? `（自 ${data.history.firstDate}）` : ''}`
    : '长期存档已开启';
  const rangeLabel = dailyRange === '90' ? '近 90 天' : dailyRange === 'all' ? '全部历史' : '近一年';
  dailyUpdatedEl.textContent = `${rangeLabel} · ${modeLabel} · ${history}`;
}

async function loadDaily(force = false) {
  try {
    const days = dailyRange === 'all' ? 0 : Number(dailyRange) || 371;
    const data = await api(`/api/daily?days=${days}${force ? '&refresh=1' : ''}`);
    state.dailyData = data;
    renderDaily(data);
  } catch {
    dailyUpdatedEl.textContent = '每日用量统计失败';
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
  if (window.usedPercent !== null && window.usedPercent !== undefined) {
    fragment.append(el('span', '', `已用 ${fmtPercent(window.usedPercent)}`));
    const remaining = 100 - Number(window.usedPercent);
    if (Number.isFinite(remaining)) {
      fragment.append(el('span', '', ` · 剩余 ${Math.max(0, Math.round(remaining))}%`));
    }
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
  const head = el('div', 'window-head');
  head.append(el('span', 'wlabel', window.label), el('span', 'wmeta'));
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

  const strip = el('div', 'ds-30d');
  strip.append(el('span', 'ds-30d-label', '累计消费 '));
  strip.append(el('b', '', fmtMoney(provider.spentCny, 'CNY')));
  strip.append(document.createTextNode(` · 估算 ${fmtTokens(provider.lifetimeTokensEstimate)} tokens（按累计消费折算）`));

  const body = el('div', 'ds-body');
  body.append(wrap, strip);
  return body;
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
  nameRow.append(el('span', '', provider.name));
  title.append(nameRow);
  if (provider.plan) title.append(el('div', 'card-plan', provider.plan));

  const actions = el('div', 'card-actions');
  actions.append(statusChip(provider.status));
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
        cardAction('填写 Go Key', () => {
          document.querySelector('#go-panel').open = true;
          document.querySelector('#go-panel').scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 'btn')
      );
    }
  }

  if (provider.kind === 'deepseek-platform') {
    card.append(platformMetrics(provider));
  } else if (provider.windows && provider.windows.length) {
    const body = el('div', 'card-body');
    body.style.display = 'flex';
    body.style.flexDirection = 'column';
    body.style.gap = '12px';
    for (const window of provider.windows) {
      if (window.key === 'balance') body.append(renderBalance(window, provider));
      else body.append(renderWindow(window));
    }
    card.append(body);
  }

  if (provider.kind === 'opencode-go' && provider.subscription) {
    const opencodeChannel = ((state.usage && state.usage.channels) || []).find((channel) => channel.id === 'opencode');
    const subs = (opencodeChannel && opencodeChannel.subs) || [];
    const current = subs.find((item) => item.id === provider.subscription);
    if (current) {
      const channelTotal = Number((opencodeChannel && opencodeChannel.tokens && opencodeChannel.tokens.total) || 0);
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
  for (const provider of list) cardsEl.append(createCard(provider));
  updateTimers();
}

function updateTimers() {
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
    obNameInput.value = current && current !== '额度一念' && current !== '额度一览' && current !== 'Token 使用情况' ? current : '';
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
      const panel = obSelectedPanel && document.getElementById(obSelectedPanel);
      if (panel) { panel.open = true; panel.scrollIntoView({ behavior: reduceMotion?.matches ? 'auto' : 'smooth', block: 'start' }); panel.querySelector('summary')?.focus({ preventScroll: true }); }
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
    const next = input.value.trim().slice(0, 40) || '额度一念';
    const h1 = document.createElement('h1');
    h1.id = 'app-title';
    if (commit && next !== (titleEl ? titleEl.textContent : '')) h1.textContent = next;
    else h1.textContent = titleEl ? titleEl.textContent : '额度一念';
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
    if (config.paths && config.paths.dataDir) dataDirEl.textContent = config.paths.dataDir;
    renderCodexAccounts((config.providers && config.providers.codex && config.providers.codex.accounts) || []);
    renderGoSubscriptions(
      (config.providers && config.providers.opencodeGo && config.providers.opencodeGo.subscriptions) || []
    );
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
    main.append(el('div', 'account-name', account.name || 'Codex 账户'));
    main.append(el('div', 'account-path', account.authPath || ''));
    const actions = el('div', 'account-actions');
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
    main.append(el('div', 'account-path', candidate.path));
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
    if (state.dailyData) renderDaily(state.dailyData);
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

const SOURCE_STACK = [
  { key: 'codexTokens', name: 'Codex', color: '#c15f3c' },
  { key: 'deepseekTokens', name: 'DeepSeek', color: '#bb8a52' },
  { key: 'opencodeTokens', name: 'OpenCode Go', color: '#7e8f6b' },
  { key: 'opencodeOtherTokens', name: '其它路由', color: '#9c958c' }
];

function totalOf(entry) {
  return SOURCE_STACK.reduce((sum, source) => sum + Number(entry[source.key] || 0), 0);
}

/** 天数太多时按周聚合，避免柱子细到看不清。 */
function bucketSeries(series) {
  if (series.length <= 120) {
    return series.map((entry) => ({
      label: entry.date.slice(5),
      date: entry.date,
      values: SOURCE_STACK.map((source) => Number(entry[source.key] || 0)),
      total: totalOf(entry)
    }));
  }
  const buckets = new Map();
  for (const entry of series) {
    const d = new Date(entry.date + 'T00:00:00');
    const offset = (d.getDay() + 6) % 7;
    const monday = new Date(d.getTime() - offset * 86400000).toISOString().slice(0, 10);
    if (!buckets.has(monday)) {
      buckets.set(monday, { label: monday.slice(5), date: monday, values: SOURCE_STACK.map(() => 0), total: 0 });
    }
    const bucket = buckets.get(monday);
    SOURCE_STACK.forEach((source, index) => {
      bucket.values[index] += Number(entry[source.key] || 0);
    });
    bucket.total += totalOf(entry);
  }
  return [...buckets.values()];
}

function renderTotalChart(data) {
  const allSeries = Array.isArray(data && data.series) ? data.series : [];
  const limit = totalRange === 'all' ? allSeries.length : Math.min(Number(totalRange) || 30, allSeries.length);
  const series = allSeries.slice(Math.max(0, allSeries.length - limit));
  if (!totalChartEl) return;
  if (totalChartInstance) {
    totalChartInstance.dispose();
    totalChartInstance = null;
  }
  if (!series.length) {
    if (totalValueEl) totalValueEl.textContent = '—';
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
      : [...SOURCE_STACK.map((item) => ({ name: item.name, color: item.color })), { name: '7 日均线', color: '#9a9386', dashed: true }];
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
        const lines = SOURCE_STACK
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
        ...SOURCE_STACK.map((source, index) => ({
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
  dailyCharts.push(totalChartInstance);
}

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
      await loadDaily(true);
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
    if (state.dailyData) renderDaily(state.dailyData);
  }, 200);
});

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
loadConfig();
load(false);

if (location.hash === '#codex') {
  const panel = document.querySelector('#codex-panel');
  if (panel) panel.open = true;
}
