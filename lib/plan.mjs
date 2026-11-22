/**
 * 计划与额度窗口的纯函数模块（零依赖）。
 *
 * 为什么单独成模块：上游 wham/usage 的 primary_window / secondary_window 只是
 * 槽位名，真正的周期在 limit_window_seconds 里。按槽位硬编码「5 小时 / 每周」
 * 会把 Pro Lite 的 7 天窗口标错，也会把其他计划/自定义周期标错。本模块只依据
 * 秒数派生 key / kind / label，不猜槽位，也不读取当前时间或任何外部状态。
 *
 * 约束：纯函数、零依赖、无 console、不读写磁盘/网络/环境变量。
 */

/**
 * 已知的三个标准窗口周期。
 * key 保持 v1.7 起的旧值（'5h' / 'weekly'），避免前端、存档和历史快照迁移；
 * kind 是新增的语义字段：session（5 小时滚动）/ weekly / monthly。
 */
const KNOWN_WINDOWS = new Map([
  [18000, { kind: 'session', key: '5h', label: '5 小时' }],
  [604800, { kind: 'weekly', key: 'weekly', label: '每周' }],
  [2592000, { kind: 'monthly', key: 'monthly', label: '每月' }]
]);

/**
 * 秒数缺失/非法时的统一兜底。
 * 不抛错：额度采集是「尽量显示」的场景，一个坏窗口不应让整张卡失败；
 * kind 仍归入 custom，保证 UI 只需处理 session/weekly/monthly/custom 四种。
 */
const UNKNOWN_WINDOW = { kind: 'custom', key: 'unknown', label: '未知窗口' };

/**
 * 把上游值收敛为有限数字。
 * 上游偶尔把数字写成字符串（或字段缺失），这里统一处理；空值返回 null，
 * 由调用方区分「0」与「没有值」。
 */
function toFiniteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * 与标准周期「接近」时用「约 …」表达，避免 17999/18001 被误读成标准 5 小时窗口。
 * 容差取标准值的 0.5%（至少 1 秒）：17999/18001、2591999/2592001、604800.5 都会命中。
 */
const NEAR_STANDARD_WINDOWS = [
  { seconds: 18000, label: '约 5 小时' },
  { seconds: 604800, label: '约 7 天' },
  { seconds: 2592000, label: '约 30 天' }
];

/** 保留最多两位小数，避免浮点噪声（如 3.4291666… → 3.43）。 */
function formatApprox(value) {
  return Math.round(value * 100) / 100;
}

/**
 * 自定义周期的人性化标签：接近标准周期用「约 …」，其余按天/小时/分钟/秒。
 * 不再与标准标签（5 小时 / 每周 / 每月）撞名，也不再把 1 秒显示成「0 小时」。
 * 例：17999→'约 5 小时'，2591999→'约 30 天'，86400→'1 天'，5400→'1.5 小时'，90→'1.5 分钟'。
 */
function customLabel(seconds) {
  for (const item of NEAR_STANDARD_WINDOWS) {
    const tolerance = Math.max(1, item.seconds * 0.005);
    if (Math.abs(seconds - item.seconds) <= tolerance) return item.label;
  }
  if (seconds >= 86400) return `${formatApprox(seconds / 86400)} 天`;
  if (seconds >= 3600) return `${formatApprox(seconds / 3600)} 小时`;
  if (seconds >= 60) return `${formatApprox(seconds / 60)} 分钟`;
  return `${formatApprox(seconds)} 秒`;
}

/**
 * 毫秒时间戳 → ISO 字符串；非法值 null。
 * JS Date 的可表示范围是 ±8.64e15 ms，超出后 new Date(ms) 是 Invalid Date，
 * 再调 toISOString() 会抛 RangeError；这里显式判定后返回 null（畸形上游不能弄崩采集）。
 */
function toIso(ms) {
  if (!Number.isFinite(ms)) return null;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * reset_at 归一化：只接受显式传入的时间，绝不读 Date.now()（保持纯函数）。
 * - 数字：< 1e12 视为 epoch 秒，>= 1e12 视为 epoch 毫秒；
 * - 字符串：纯数字按上面的秒/毫秒规则；其余交给 Date.parse，合法则转 ISO；
 * - 空值/0/负数/非法字符串 → null。
 */
function toIsoResetAt(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    return toIso(value < 1e12 ? value * 1000 : value);
  }
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return null;
    if (/^\d+(?:\.\d+)?$/.test(text)) {
      const parsed = Number(text);
      if (!Number.isFinite(parsed) || parsed <= 0) return null;
      return toIso(parsed < 1e12 ? parsed * 1000 : parsed);
    }
    const ms = Date.parse(text);
    return Number.isFinite(ms) ? toIso(ms) : null;
  }
  return null;
}

/**
 * 由窗口秒数派生统一的窗口身份。
 *
 * 18000 → { kind: 'session', key: '5h',    label: '5 小时' }
 * 604800 → { kind: 'weekly', key: 'weekly', label: '每周' }
 * 2592000 → { kind: 'monthly', key: 'monthly', label: '每月' }
 * 其它正数 → { kind: 'custom', key: 'w<秒>', label: '约 …' | '<n> 天/小时/分钟/秒' }
 * 空值/非法 → { kind: 'custom', key: 'unknown', label: '未知窗口' }
 *
 * @param {number|string|null|undefined} limitWindowSeconds 窗口长度（秒）
 * @returns {{kind: string, key: string, label: string}}
 */
export function windowKindFromSeconds(limitWindowSeconds) {
  const seconds = toFiniteNumber(limitWindowSeconds);
  if (seconds === null || seconds <= 0) return { ...UNKNOWN_WINDOW };
  const known = KNOWN_WINDOWS.get(seconds);
  if (known) return { ...known };
  return { kind: 'custom', key: `w${seconds}`, label: customLabel(seconds) };
}

/**
 * 把上游单个窗口原始对象归一化为面板统一窗口对象。
 *
 * 保留三个旧字段（usedPercent / windowSeconds / resetAt），新增 key/kind/label，
 * 前端即可按 kind 渲染周期、按 label 显示文案，不再依赖槽位。
 *
 * @param {{used_percent?: number|string|null, limit_window_seconds?: number|string|null, reset_at?: number|string|null, resets_at?: number|string|null}|null|undefined} rawWindow
 * @returns {{key: string, kind: string, label: string, usedPercent: number|null, windowSeconds: number|null, resetAt: string|null}}
 */
export function describeWindow(rawWindow) {
  const raw = rawWindow && typeof rawWindow === 'object' ? rawWindow : {};
  const seconds = toFiniteNumber(raw.limit_window_seconds);
  // ≤0 / 非数一律视为「没有窗口长度」，不把 0 或 -1 当合法秒数写进数据。
  const windowSeconds = seconds !== null && seconds > 0 ? seconds : null;
  const identity = windowKindFromSeconds(windowSeconds);
  return {
    key: identity.key,
    kind: identity.kind,
    label: identity.label,
    usedPercent: toFiniteNumber(raw.used_percent),
    windowSeconds,
    // 兼容上游偶发使用 resets_at 的写法（adapters 旧代码也是 reset_at ?? resets_at）。
    resetAt: toIsoResetAt(raw.reset_at ?? raw.resets_at)
  };
}

/**
 * 计划元数据表。
 * tier 用与 id 同名的字符串（不是数字）：目前只用于排序/展示分组，具体顺序由
 * 前端决定，避免把「Pro Lite 与 Plus 谁高」这类产品判断固化在后端。
 */
const PLAN_METAS = {
  free: { id: 'free', name: 'Free', tier: 'free', expectedWindows: [], note: '按接口实际窗口显示' },
  plus: { id: 'plus', name: 'Plus', tier: 'plus', expectedWindows: ['5h', 'weekly'], note: '5 小时 + 每周双窗口' },
  pro: { id: 'pro', name: 'Pro', tier: 'pro', expectedWindows: ['weekly'], note: '仅每周窗口' },
  prolite: { id: 'prolite', name: 'Pro Lite', tier: 'prolite', expectedWindows: ['weekly'], note: '该计划仅提供每周额度' },
  go: { id: 'go', name: 'Go', tier: 'go', expectedWindows: [], note: '按接口实际窗口显示' },
  team: { id: 'team', name: '团队', tier: 'team', expectedWindows: [], note: '按接口实际窗口显示' },
  enterprise: { id: 'enterprise', name: '企业', tier: 'enterprise', expectedWindows: [], note: '按接口实际窗口显示' }
};

/**
 * 计划类型归一化：忽略大小写、空格、下划线、连字符。
 * 'PRO LITE' / 'pro_lite' / 'pro-lite' 都归到 'prolite'。
 */
function normalizePlanKey(planType) {
  if (typeof planType !== 'string') return '';
  return planType.trim().toLowerCase().replace(/[\s_-]+/g, '');
}

/** 返回深拷贝，避免调用方修改共享元数据。 */
function clonePlanMeta(meta) {
  return {
    id: meta.id,
    name: meta.name,
    tier: meta.tier,
    expectedWindows: [...meta.expectedWindows],
    note: meta.note
  };
}

/**
 * 计划类型 → 展示元数据。
 *
 * 未识别计划不抛错：id/name 保留上游原值（空值则回退 unknown / 未知计划），
 * tier 统一为 'unknown'，expectedWindows 留空，窗口完全按接口实际返回显示。
 *
 * @param {string|null|undefined} planType 上游 plan_type（如 'plus' / 'prolite'）
 * @returns {{id: string, name: string, tier: string, expectedWindows: string[], note: string}}
 */
export function planMetaFor(planType) {
  const raw = typeof planType === 'string' ? planType.trim() : '';
  const key = normalizePlanKey(raw);
  const known = key ? PLAN_METAS[key] : null;
  if (known) return clonePlanMeta(known);
  return {
    id: raw || 'unknown',
    name: raw || '未知计划',
    tier: 'unknown',
    expectedWindows: [],
    note: '按接口实际窗口显示'
  };
}

/**
 * 该计划「通常应有」的窗口 key 列表（如 ['5h', 'weekly']）。
 * 仅作提示/诊断用，不能拿来覆盖接口真实返回；未知计划返回空数组。
 *
 * @param {string|{expectedWindows?: string[]}|null|undefined} plan 计划类型或 planMeta 对象
 * @returns {string[]}
 */
export function expectedWindowsFor(plan) {
  if (plan && typeof plan === 'object' && Array.isArray(plan.expectedWindows)) {
    return [...plan.expectedWindows];
  }
  return [...planMetaFor(plan).expectedWindows];
}
