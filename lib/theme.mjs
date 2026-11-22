/**
 * 外观主题的纯函数模块（零依赖，前后端共用的事实来源）。
 *
 * 设计目标：
 * 1. 5 套配色预设，每套都有完整的 light / dark 两套 CSS 变量 token；
 * 2. 用户可覆盖强调色（accent）与各模块颜色（modules），并支持 auto 明暗；
 * 3. 所有派生（accent-soft / accent-wash / accent-ink）在服务端一次算好，
 *    前端 applier 只需把 vars 写进 document.documentElement.style。
 *
 * 约束：纯函数、零依赖、无 console、不读写磁盘/网络/环境变量；
 * 返回对象均为新建对象（预设常量已冻结），调用方修改不会污染全局。
 */

/** 预设定义（light / dark 各 18 个基础 CSS 变量，键名带 '--'）。 */
const PRESET_DEFINITIONS = [
  {
    id: 'claude',
    name: '暖纸赤陶',
    description: '米白纸面，配一点赤陶红。',
    swatches: ['#f6f4ee', '#c96442', '#7e8f6b', '#b8892f', '#1f1e1d'],
    light: {
      '--paper': '#f6f4ee',
      '--paper-tint': '#efebe1',
      '--surface': '#fffefb',
      '--surface-2': '#faf8f2',
      '--ink': '#1f1e1d',
      '--ink-soft': '#3c3934',
      '--muted': '#6f6a60',
      '--muted-2': '#6f685c',
      '--line': '#e4dfd2',
      '--line-strong': '#d5cfc0',
      '--accent': '#c96442',
      '--accent-ink': '#9f4528',
      '--accent-soft': '#f4e3da',
      '--accent-wash': '#fbeee7',
      '--sage': '#7e8f6b',
      '--ochre': '#b8892f',
      '--brick': '#b0483c',
      '--slate': '#5b6b79'
    },
    dark: {
      '--paper': '#262624',
      '--paper-tint': '#2d2c29',
      '--surface': '#30302e',
      '--surface-2': '#353430',
      '--ink': '#f3f0e9',
      '--ink-soft': '#dcd7cd',
      '--muted': '#a9a49a',
      '--muted-2': '#a89f91',
      '--line': '#423f3a',
      '--line-strong': '#514d46',
      '--accent': '#d97757',
      '--accent-ink': '#e79072',
      '--accent-soft': '#45322b',
      '--accent-wash': '#3a2c26',
      '--sage': '#8aa87c',
      '--ochre': '#d3a24f',
      '--brick': '#d97b6c',
      '--slate': '#8ba3c2'
    }
  },
  {
    id: 'graphite',
    name: '石墨灰',
    description: '石墨灰底，配低饱和蓝灰。',
    swatches: ['#eff1f2', '#586578', '#a2b3c9', '#6b8f7a', '#b08a3e'],
    light: {
      '--paper': '#eff1f2',
      '--paper-tint': '#e4e7ea',
      '--surface': '#fbfcfd',
      '--surface-2': '#f1f3f5',
      '--ink': '#20252b',
      '--ink-soft': '#3d4752',
      '--muted': '#54616e',
      '--muted-2': '#5f6b76',
      '--line': '#dce1e7',
      '--line-strong': '#c3cbd3',
      '--accent': '#586578',
      '--accent-ink': '#3d4d62',
      '--accent-soft': '#e0e7f0',
      '--accent-wash': '#edf1f6',
      '--sage': '#6b8f7a',
      '--ochre': '#b08a3e',
      '--brick': '#b4544a',
      '--slate': '#5b6b79'
    },
    dark: {
      '--paper': '#191c21',
      '--paper-tint': '#20242a',
      '--surface': '#252a31',
      '--surface-2': '#2b3139',
      '--ink': '#f2f4f7',
      '--ink-soft': '#d8e0e9',
      '--muted': '#aeb8c5',
      '--muted-2': '#9aa6b5',
      '--line': '#38414b',
      '--line-strong': '#515d6a',
      '--accent': '#a2b3c9',
      '--accent-ink': '#c8d7ed',
      '--accent-soft': '#384254',
      '--accent-wash': '#2e3744',
      '--sage': '#8fb39b',
      '--ochre': '#d0a85e',
      '--brick': '#d97f74',
      '--slate': '#8ba3c2'
    }
  },
  {
    id: 'sage',
    name: '鼠尾草绿',
    description: '淡绿纸面，配柔和的草木绿。',
    swatches: ['#eef3ea', '#56765b', '#7e9a6d', '#b08a3e', '#232d23'],
    light: {
      '--paper': '#eef3ea',
      '--paper-tint': '#e4edde',
      '--surface': '#fbfdf8',
      '--surface-2': '#f2f7ef',
      '--ink': '#232d23',
      '--ink-soft': '#3d4c3b',
      '--muted': '#5b6a56',
      '--muted-2': '#5e6f58',
      '--line': '#dbe6d6',
      '--line-strong': '#c3d2bb',
      '--accent': '#56765b',
      '--accent-ink': '#35553d',
      '--accent-soft': '#dcebd9',
      '--accent-wash': '#eaf3e6',
      '--sage': '#7e9a6d',
      '--ochre': '#b08a3e',
      '--brick': '#b15b4e',
      '--slate': '#5b6b79'
    },
    dark: {
      '--paper': '#19231b',
      '--paper-tint': '#202c23',
      '--surface': '#253229',
      '--surface-2': '#2b3a2f',
      '--ink': '#eef5e9',
      '--ink-soft': '#d6e5d0',
      '--muted': '#abbba4',
      '--muted-2': '#a1b096',
      '--line': '#394b3c',
      '--line-strong': '#526854',
      '--accent': '#a5c494',
      '--accent-ink': '#c6deb9',
      '--accent-soft': '#3c503d',
      '--accent-wash': '#2e4232',
      '--sage': '#96b884',
      '--ochre': '#d3a85c',
      '--brick': '#d9796b',
      '--slate': '#8ba3c2'
    }
  },
  {
    id: 'midnight',
    name: '午夜蓝',
    description: '浅色像晴空，深色像夜幕。',
    swatches: ['#101a2d', '#93b7f4', '#7fb69b', '#d9b062', '#eff5ff'],
    light: {
      '--paper': '#edf3fb',
      '--paper-tint': '#e2ebf8',
      '--surface': '#fbfdff',
      '--surface-2': '#f0f6fe',
      '--ink': '#19263c',
      '--ink-soft': '#344760',
      '--muted': '#526382',
      '--muted-2': '#526887',
      '--line': '#d7e3f4',
      '--line-strong': '#bdcde7',
      '--accent': '#3a67ad',
      '--accent-ink': '#294f90',
      '--accent-soft': '#dceafa',
      '--accent-wash': '#eaf2fd',
      '--sage': '#5e8f7c',
      '--ochre': '#b08a3e',
      '--brick': '#b4544a',
      '--slate': '#5b6b79'
    },
    dark: {
      '--paper': '#101a2d',
      '--paper-tint': '#151f36',
      '--surface': '#192742',
      '--surface-2': '#21314e',
      '--ink': '#eff5ff',
      '--ink-soft': '#d5e2f8',
      '--muted': '#a9bbd8',
      '--muted-2': '#a2b4d1',
      '--line': '#324567',
      '--line-strong': '#465d88',
      '--accent': '#93b7f4',
      '--accent-ink': '#bcd4ff',
      '--accent-soft': '#30466d',
      '--accent-wash': '#233657',
      '--sage': '#7fb69b',
      '--ochre': '#d9b062',
      '--brick': '#e08a7c',
      '--slate': '#8ba3c2'
    }
  },
  {
    id: 'sunset',
    name: '晚霞玫瑰',
    description: '微粉纸面，深色带一点梅紫。',
    swatches: ['#fbf0ef', '#a9546c', '#7e8f6b', '#c08a2e', '#38252d'],
    light: {
      '--paper': '#fbf0ef',
      '--paper-tint': '#f5e3e5',
      '--surface': '#fffbfb',
      '--surface-2': '#fdf3f3',
      '--ink': '#38252d',
      '--ink-soft': '#573e49',
      '--muted': '#755763',
      '--muted-2': '#785864',
      '--line': '#efd9df',
      '--line-strong': '#ddbfc9',
      '--accent': '#a9546c',
      '--accent-ink': '#893953',
      '--accent-soft': '#f5dde4',
      '--accent-wash': '#faebef',
      '--sage': '#7e8f6b',
      '--ochre': '#c08a2e',
      '--brick': '#b8433c',
      '--slate': '#5b6b79'
    },
    dark: {
      '--paper': '#261a23',
      '--paper-tint': '#2e202c',
      '--surface': '#352632',
      '--surface-2': '#3d2b3a',
      '--ink': '#f9eff5',
      '--ink-soft': '#ead5e2',
      '--muted': '#cab0bf',
      '--muted-2': '#bea1b3',
      '--line': '#533b4e',
      '--line-strong': '#735069',
      '--accent': '#eb9caf',
      '--accent-ink': '#f8b9ca',
      '--accent-soft': '#573a4e',
      '--accent-wash': '#483043',
      '--sage': '#9aab85',
      '--ochre': '#dcb05e',
      '--brick': '#e08273',
      '--slate': '#8ba3c2'
    }
  }
];

/** 递归冻结，防止调用方修改共享预设常量。 */
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

export const THEME_PRESETS = deepFreeze(PRESET_DEFINITIONS);

/** 模块键（与 config.ui.theme.modules 的键一致）。 */
export const MODULE_KEYS = deepFreeze(['codex', 'deepseek', 'opencodeGo', 'relay', 'other']);

/** 模块键 → CSS 变量名。opencodeGo 对应契约里的 --mod-opencode。 */
export const MODULE_VAR_NAMES = deepFreeze({
  codex: '--mod-codex',
  deepseek: '--mod-deepseek',
  opencodeGo: '--mod-opencode',
  relay: '--mod-relay',
  other: '--mod-other'
});

/** 基础主题变量（预设 light/dark 必须全部提供）。 */
export const BASE_THEME_VARS = deepFreeze([
  '--paper',
  '--paper-tint',
  '--surface',
  '--surface-2',
  '--ink',
  '--ink-soft',
  '--muted',
  '--muted-2',
  '--line',
  '--line-strong',
  '--accent',
  '--accent-ink',
  '--accent-soft',
  '--accent-wash',
  '--sage',
  '--ochre',
  '--brick',
  '--slate'
]);

/** resolveTheme 输出的完整变量名清单（基础 18 + accent-strong/on-accent 2 + 模块 5 = 25）。 */
export const THEME_VARS = deepFreeze(
  BASE_THEME_VARS.concat(['--accent-strong', '--on-accent'], MODULE_KEYS.map((key) => MODULE_VAR_NAMES[key]))
);

/**
 * 默认模块色：模块未自定义时使用。
 * light/dark 双套：深色底需要更亮的模块色才能达到 ≥3:1（H9 P2-1）。
 */
export const DEFAULT_MODULE_COLORS = deepFreeze({
  light: {
    codex: '#c15f3c',
    deepseek: '#4f6f9f',
    opencodeGo: '#6e7f5c',
    relay: '#5b6b79',
    other: '#8a8178'
  },
  dark: {
    codex: '#e08a6d',
    deepseek: '#8aa8d6',
    opencodeGo: '#a3b392',
    relay: '#8ba3c2',
    other: '#b8ada1'
  }
});

/** 按明暗模式取默认模块色。 */
export function defaultModuleColorsFor(mode) {
  return DEFAULT_MODULE_COLORS[mode === 'dark' ? 'dark' : 'light'];
}

/** 默认主题（config.ui.theme 缺省值）。 */
export const DEFAULT_UI_THEME = deepFreeze({
  preset: 'claude',
  mode: 'light',
  accent: null,
  modules: {
    codex: null,
    deepseek: null,
    opencodeGo: null,
    relay: null,
    other: null
  }
});

const HEX_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** 是否合法 CSS 十六进制颜色（#rgb 或 #rrggbb，允许首尾空白、大小写）。 */
export function isValidHex(value) {
  return typeof value === 'string' && HEX_PATTERN.test(value.trim());
}

/** 归一化为小写 #rrggbb；非法返回 null。 */
export function normalizeHex(value) {
  if (!isValidHex(value)) return null;
  const raw = value.trim().toLowerCase().slice(1);
  if (raw.length === 3) return '#' + raw[0] + raw[0] + raw[1] + raw[1] + raw[2] + raw[2];
  return '#' + raw;
}

function toRgb(hex) {
  const normalized = normalizeHex(hex);
  if (!normalized) return null;
  return [
    parseInt(normalized.slice(1, 3), 16),
    parseInt(normalized.slice(3, 5), 16),
    parseInt(normalized.slice(5, 7), 16)
  ];
}

function toHex(rgb) {
  return '#' + rgb
    .map((channel) => Math.max(0, Math.min(255, Math.round(channel))).toString(16).padStart(2, '0'))
    .join('');
}

/** 颜色混合：以 weightTo 的比例把 to 混入 from（0=全 from，1=全 to）。 */
function mixHex(from, to, weightTo) {
  const a = toRgb(from);
  const b = toRgb(to);
  if (!a || !b) return from;
  return toHex(a.map((channel, index) => channel * (1 - weightTo) + b[index] * weightTo));
}

/**
 * light 模式的 --accent-strong：把 accent 向黑混合，直到近白字 #fffaf6 对它的对比度 ≥4.5。
 * 用于主按钮/accent 实底（保证白字可读）；dark 模式直接用 accent 本身。
 */
function deriveAccentStrong(accent, mode) {
  if (mode === 'dark') return accent;
  for (let weight = 0.05; weight <= 1.0001; weight += 0.05) {
    const candidate = mixHex(accent, '#000000', Math.min(1, weight));
    if (contrastRatio('#fffaf6', candidate) >= 4.5) return candidate;
  }
  return '#000000';
}

/**
 * 主按钮文字色 --on-accent：优先近白 #fffaf6（对 accent-strong ≥4.5），
 * 不够则退近黑 #262624；两者都不足时取更优者并给 warning。
 */
function pickOnAccent(accentStrong) {
  const light = '#fffaf6';
  const dark = '#262624';
  const lightRatio = contrastRatio(accentStrong, light) ?? 0;
  if (lightRatio >= 4.5) return { color: light, ratio: lightRatio };
  const darkRatio = contrastRatio(accentStrong, dark) ?? 0;
  if (darkRatio >= 4.5) return { color: dark, ratio: darkRatio };
  return lightRatio >= darkRatio
    ? { color: light, ratio: lightRatio }
    : { color: dark, ratio: darkRatio };
}

/**
 * 自定义 accent 的文字色派生：light 逐步混黑、dark 逐步混白，直到对 surface ≥4.5。
 * 达到目标立即返回；全程达不到则返回对比度最高的候选（由调用方给 warning）。
 */
function deriveAccentInk(accent, surface, mode) {
  const target = mode === 'dark' ? '#ffffff' : '#000000';
  let best = accent;
  let bestRatio = contrastRatio(accent, surface) ?? 0;
  for (let weight = 0.1; weight <= 1.0001; weight += 0.05) {
    const candidate = mixHex(accent, target, Math.min(1, weight));
    const ratio = contrastRatio(candidate, surface) ?? 0;
    if (ratio > bestRatio) {
      best = candidate;
      bestRatio = ratio;
    }
    if (ratio >= 4.5) return { color: candidate, ratio };
  }
  return { color: best, ratio: bestRatio };
}

/** WCAG 相对亮度（0–1）；非法颜色返回 null。 */
export function relativeLuminance(hex) {
  const rgb = toRgb(hex);
  if (!rgb) return null;
  const [r, g, b] = rgb.map((channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 对比度（1–21）；任一颜色非法返回 null。 */
export function contrastRatio(hexA, hexB) {
  const lumA = relativeLuminance(hexA);
  const lumB = relativeLuminance(hexB);
  if (lumA === null || lumB === null) return null;
  const lighter = Math.max(lumA, lumB);
  const darker = Math.min(lumA, lumB);
  return (lighter + 0.05) / (darker + 0.05);
}

const PRESET_MAP = new Map(THEME_PRESETS.map((preset) => [preset.id, preset]));

/**
 * 解析用户主题为可直接写到 :root 的变量表。
 *
 * - preset 未知（且非 'custom'）回退 claude 并给 warning；
 * - 'custom' 以 claude token 为底，只应用用户 accent/modules 覆盖；
 * - mode 'auto' 按 systemDark 解析为 light/dark；
 * - accent 覆盖时派生 --accent-soft / --accent-wash（与 paper 混合）与 --accent-ink
 *   （light 逐步混黑 / dark 逐步混白，直到对 surface ≥4.5）；
 * - 始终派生 --accent-strong（light 混黑到白字 ≥4.5；dark 用 accent）；
 * - 始终派生 --on-accent（优先近白、对 --accent-strong 保证 ≥4.5）；
 * - modules 非空覆盖 --mod-*，否则按 light/dark 取默认模块色；
 * - 对比度不足只给 warning，不拒绝（用户可能故意选择低对比度）；
 *   覆盖 muted-2、模块色、accent-ink、on-accent 四类检查。
 *
 * @param {{preset?: string, mode?: string, accent?: string|null, modules?: object}} [theme]
 * @param {{systemDark?: boolean}} [options]
 * @returns {{preset: string, mode: string, attrs: object, vars: object, warnings: string[]}}
 */
export function resolveTheme(theme, options) {
  const warnings = [];
  const input = theme && typeof theme === 'object' && !Array.isArray(theme) ? theme : {};
  const systemDark = Boolean(options && options.systemDark === true);

  const requestedPreset = typeof input.preset === 'string' ? input.preset.trim().toLowerCase() : '';
  let presetId = 'claude';
  let preset = PRESET_MAP.get('claude');
  if (requestedPreset === 'custom') {
    presetId = 'custom';
  } else if (requestedPreset && PRESET_MAP.has(requestedPreset)) {
    presetId = requestedPreset;
    preset = PRESET_MAP.get(requestedPreset);
  } else if (requestedPreset) {
    warnings.push('未知预设 "' + input.preset + '"，已回退 claude');
  }

  const rawMode = typeof input.mode === 'string' ? input.mode.trim().toLowerCase() : '';
  let mode;
  if (rawMode === 'auto') {
    mode = systemDark ? 'dark' : 'light';
  } else if (rawMode === 'light' || rawMode === 'dark') {
    mode = rawMode;
  } else {
    mode = 'light';
    if (rawMode) warnings.push('无效的明暗模式 "' + input.mode + '"，已回退 light');
  }

  const moduleColors = defaultModuleColorsFor(mode);
  const vars = {};
  for (const name of BASE_THEME_VARS) vars[name] = preset[mode][name];
  for (const key of MODULE_KEYS) vars[MODULE_VAR_NAMES[key]] = moduleColors[key];

  const rawAccent = input.accent;
  if (rawAccent !== null && rawAccent !== undefined && rawAccent !== '') {
    const accent = normalizeHex(rawAccent);
    if (!accent) {
      warnings.push('无效的强调色 "' + String(rawAccent) + '"，已忽略');
    } else {
      vars['--accent'] = accent;
      vars['--accent-soft'] = mixHex(accent, vars['--paper'], 0.85);
      vars['--accent-wash'] = mixHex(accent, vars['--paper'], 0.93);
      vars['--accent-ink'] = deriveAccentInk(accent, vars['--surface'], mode).color;
    }
  }

  const modulesInput = input.modules && typeof input.modules === 'object' && !Array.isArray(input.modules)
    ? input.modules
    : {};
  for (const key of MODULE_KEYS) {
    const varName = MODULE_VAR_NAMES[key];
    const raw = modulesInput[key];
    if (raw === null || raw === undefined || raw === '') {
      vars[varName] = moduleColors[key];
      continue;
    }
    const color = normalizeHex(raw);
    if (!color) {
      warnings.push('无效的模块颜色 ' + key + ' "' + String(raw) + '"，已忽略');
      vars[varName] = moduleColors[key];
      continue;
    }
    vars[varName] = color;
  }

  vars['--accent-strong'] = deriveAccentStrong(vars['--accent'], mode);
  const onAccent = pickOnAccent(vars['--accent-strong']);
  vars['--on-accent'] = onAccent.color;
  if (onAccent.ratio < 4.5) {
    warnings.push('on-accent 与强调色对比度偏低（' + onAccent.ratio.toFixed(2) + ':1，建议 ≥4.5:1）');
  }

  const accentRatio = contrastRatio(vars['--accent'], vars['--surface']);
  if (accentRatio !== null && accentRatio < 3) {
    warnings.push('强调色与表面色对比度偏低（' + accentRatio.toFixed(2) + ':1，建议 ≥3:1）');
  }
  const inkRatio = contrastRatio(vars['--ink'], vars['--surface']);
  if (inkRatio !== null && inkRatio < 4.5) {
    warnings.push('正文色与表面色对比度偏低（' + inkRatio.toFixed(2) + ':1，建议 ≥4.5:1）');
  }
  const muted2Ratio = contrastRatio(vars['--muted-2'], vars['--paper']);
  if (muted2Ratio !== null && muted2Ratio < 3) {
    warnings.push('muted-2 与 paper 对比度偏低（' + muted2Ratio.toFixed(2) + ':1，建议 ≥3:1）');
  }
  const accentInkRatio = contrastRatio(vars['--accent-ink'], vars['--surface']);
  if (accentInkRatio !== null && accentInkRatio < 4.5) {
    warnings.push('accent-ink 与表面色对比度偏低（' + accentInkRatio.toFixed(2) + ':1，建议 ≥4.5:1）');
  }
  for (const key of MODULE_KEYS) {
    const ratio = contrastRatio(vars[MODULE_VAR_NAMES[key]], vars['--surface']);
    if (ratio !== null && ratio < 3) {
      warnings.push('模块颜色 ' + key + ' 与表面色对比度偏低（' + ratio.toFixed(2) + ':1，建议 ≥3:1）');
    }
  }

  return {
    preset: presetId,
    mode,
    attrs: { 'data-preset': presetId, 'data-mode': mode },
    vars,
    warnings
  };
}
