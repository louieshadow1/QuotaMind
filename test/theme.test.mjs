import test from 'node:test';
import assert from 'node:assert/strict';

import {
  THEME_PRESETS,
  MODULE_KEYS,
  MODULE_VAR_NAMES,
  BASE_THEME_VARS,
  THEME_VARS,
  DEFAULT_MODULE_COLORS,
  DEFAULT_UI_THEME,
  defaultModuleColorsFor,
  isValidHex,
  normalizeHex,
  relativeLuminance,
  contrastRatio,
  resolveTheme
} from '../lib/theme.mjs';

const EXPECTED_PRESET_IDS = ['claude', 'graphite', 'sage', 'midnight', 'sunset'];
const EXPECTED_MODULE_KEYS = ['codex', 'deepseek', 'opencodeGo', 'relay', 'other'];
const EXPECTED_VARS = BASE_THEME_VARS.concat([
  '--accent-strong',
  '--on-accent',
  '--mod-codex',
  '--mod-deepseek',
  '--mod-opencode',
  '--mod-relay',
  '--mod-other'
]);

const presetById = (id) => THEME_PRESETS.find((preset) => preset.id === id);
const onAccentWarning = (warning) => warning.includes('on-accent');

test('THEME_PRESETS：5 套预设且 id 顺序固定', () => {
  assert.equal(THEME_PRESETS.length, 5);
  assert.deepEqual(THEME_PRESETS.map((preset) => preset.id), EXPECTED_PRESET_IDS);
  assert.ok(Object.isFrozen(THEME_PRESETS));
});

test('每套预设的元信息完整（name/description/swatches）', () => {
  for (const preset of THEME_PRESETS) {
    assert.equal(typeof preset.name, 'string');
    assert.ok(preset.name.length > 0, preset.id + ' 缺 name');
    assert.equal(typeof preset.description, 'string');
    assert.ok(preset.description.length > 0, preset.id + ' 缺 description');
    assert.ok(Array.isArray(preset.swatches), preset.id + ' swatches 应为数组');
    assert.ok(preset.swatches.length >= 4, preset.id + ' swatches 至少 4 个');
    for (const swatch of preset.swatches) assert.ok(normalizeHex(swatch), preset.id + ' swatch 非法：' + swatch);
  }
});

test('每套预设 light token 完整且都是合法 hex（仍为 18 项）', () => {
  for (const preset of THEME_PRESETS) {
    const tokens = preset.light;
    assert.equal(Object.keys(tokens).length, 18);
    assert.deepEqual(Object.keys(tokens).sort(), BASE_THEME_VARS.slice().sort(), preset.id + ' light 变量缺失或多余');
    for (const name of BASE_THEME_VARS) {
      assert.ok(normalizeHex(tokens[name]), preset.id + ' light ' + name + ' 不是合法颜色：' + tokens[name]);
    }
  }
});

test('每套预设 dark token 完整且都是合法 hex（仍为 18 项）', () => {
  for (const preset of THEME_PRESETS) {
    const tokens = preset.dark;
    assert.equal(Object.keys(tokens).length, 18);
    assert.deepEqual(Object.keys(tokens).sort(), BASE_THEME_VARS.slice().sort(), preset.id + ' dark 变量缺失或多余');
    for (const name of BASE_THEME_VARS) {
      assert.ok(normalizeHex(tokens[name]), preset.id + ' dark ' + name + ' 不是合法颜色：' + tokens[name]);
    }
  }
});

test('DEFAULT_UI_THEME 与契约一致且被冻结', () => {
  assert.deepEqual(DEFAULT_UI_THEME, {
    preset: 'claude',
    mode: 'light',
    accent: null,
    modules: { codex: null, deepseek: null, opencodeGo: null, relay: null, other: null }
  });
  assert.ok(Object.isFrozen(DEFAULT_UI_THEME));
  assert.deepEqual(Object.keys(DEFAULT_UI_THEME.modules), EXPECTED_MODULE_KEYS);
});

test('MODULE_KEYS 与双模默认模块色（P2-1）', () => {
  assert.deepEqual(MODULE_KEYS, EXPECTED_MODULE_KEYS);
  assert.deepEqual(Object.keys(DEFAULT_MODULE_COLORS), ['light', 'dark']);
  assert.deepEqual(DEFAULT_MODULE_COLORS.light, {
    codex: '#c15f3c', deepseek: '#4f6f9f', opencodeGo: '#6e7f5c', relay: '#5b6b79', other: '#8a8178'
  });
  assert.deepEqual(DEFAULT_MODULE_COLORS.dark, {
    codex: '#e08a6d', deepseek: '#8aa8d6', opencodeGo: '#a3b392', relay: '#8ba3c2', other: '#b8ada1'
  });
  assert.deepEqual(defaultModuleColorsFor('light'), DEFAULT_MODULE_COLORS.light);
  assert.deepEqual(defaultModuleColorsFor('dark'), DEFAULT_MODULE_COLORS.dark);
  assert.deepEqual(defaultModuleColorsFor('auto'), DEFAULT_MODULE_COLORS.light);
  for (const mode of ['light', 'dark']) {
    for (const key of MODULE_KEYS) assert.ok(normalizeHex(DEFAULT_MODULE_COLORS[mode][key]));
  }
});

test('THEME_VARS 与契约变量名一致（18 + accent-strong/on-accent + 5 = 25）', () => {
  assert.equal(THEME_VARS.length, 25);
  assert.deepEqual(THEME_VARS.slice().sort(), EXPECTED_VARS.slice().sort());
  for (const name of ['--paper', '--accent', '--accent-strong', '--accent-ink', '--accent-soft', '--accent-wash', '--on-accent', '--mod-codex', '--mod-opencode']) {
    assert.ok(THEME_VARS.includes(name), '缺少变量 ' + name);
  }
  assert.equal(MODULE_VAR_NAMES.opencodeGo, '--mod-opencode');
});

test('预设明暗模式中的小字、选中标记和焦点都清楚可见', () => {
  const pairs = [
    ['--muted-2', '--paper', 4.5],
    ['--muted', '--surface-2', 4.5],
    ['--muted', '--accent-wash', 4.5],
    ['--accent-ink', '--accent-wash', 3],
    ['--accent-ink', '--surface', 3]
  ];
  for (const preset of THEME_PRESETS) {
    for (const mode of ['light', 'dark']) {
      const tokens = preset[mode];
      for (const [foreground, background, minimum] of pairs) {
        const ratio = contrastRatio(tokens[foreground], tokens[background]);
        assert.ok(ratio >= minimum,
          `${preset.id} ${mode} ${foreground} 对 ${background} 的对比度为 ${ratio}，需达到 ${minimum}:1`);
      }
    }
  }
});

test('P3-1：--slate 全预设统一（light #5b6b79 / dark #8ba3c2）', () => {
  for (const preset of THEME_PRESETS) {
    assert.equal(preset.light['--slate'], '#5b6b79', preset.id + ' light slate 未统一');
    assert.equal(preset.dark['--slate'], '#8ba3c2', preset.id + ' dark slate 未统一');
  }
});

test('P3-2：claude accent-ink 加深后对 accent-soft 对比度 ≥5:1', () => {
  const tokens = presetById('claude').light;
  assert.equal(tokens['--accent-ink'], '#9f4528');
  assert.equal(tokens['--accent-soft'], '#f4e3da');
  assert.ok(contrastRatio(tokens['--accent-ink'], tokens['--accent-soft']) >= 5);
});

test('isValidHex 接受 #rgb / #rrggbb / 大小写 / 空白', () => {
  for (const value of ['#abc', '#ABC', '#a1b2c3', ' #FFF ', '#000000', '#ffffff']) {
    assert.equal(isValidHex(value), true, String(value));
  }
});

test('isValidHex 拒绝非法颜色', () => {
  for (const value of ['abc', '#ab', '#abcd', '#gggggg', '#12345', '', '   ', null, undefined, 123, {}, '#1234567']) {
    assert.equal(isValidHex(value), false, String(value));
  }
});

test('normalizeHex 展开短格式、转小写并去空白', () => {
  assert.equal(normalizeHex('#ABC'), '#aabbcc');
  assert.equal(normalizeHex(' #A1B2C3 '), '#a1b2c3');
  assert.equal(normalizeHex('#fff'), '#ffffff');
  assert.equal(normalizeHex('#123456'), '#123456');
});

test('normalizeHex 非法返回 null', () => {
  for (const value of ['abc', '#12', '#ggg', '', null, undefined, 42]) {
    assert.equal(normalizeHex(value), null, String(value));
  }
});

test('relativeLuminance：白 1、黑 0、非法 null', () => {
  assert.ok(Math.abs(relativeLuminance('#ffffff') - 1) < 1e-9);
  assert.equal(relativeLuminance('#000000'), 0);
  assert.equal(relativeLuminance('not-a-color'), null);
  assert.ok(relativeLuminance('#777777') > 0 && relativeLuminance('#777777') < 1);
});

test('contrastRatio：黑白 21:1、同色 1:1、非法 null', () => {
  assert.ok(Math.abs(contrastRatio('#ffffff', '#000000') - 21) < 0.01);
  assert.ok(Math.abs(contrastRatio('#000000', '#ffffff') - 21) < 0.01);
  assert.ok(Math.abs(contrastRatio('#123456', '#123456') - 1) < 1e-9);
  assert.equal(contrastRatio('#zzz', '#000000'), null);
  assert.equal(contrastRatio('#000000', null), null);
});

test('resolveTheme 默认：claude / light / attrs / 25 个 vars 且无 warning', () => {
  const theme = resolveTheme();
  assert.equal(theme.preset, 'claude');
  assert.equal(theme.mode, 'light');
  assert.deepEqual(theme.attrs, { 'data-preset': 'claude', 'data-mode': 'light' });
  assert.deepEqual(Object.keys(theme.vars).sort(), EXPECTED_VARS.slice().sort());
  assert.equal(theme.vars['--accent'], presetById('claude').light['--accent']);
  assert.equal(theme.vars['--accent-ink'], presetById('claude').light['--accent-ink']);
  assert.notEqual(theme.vars['--accent-strong'], theme.vars['--accent']);
  assert.ok(contrastRatio('#fffaf6', theme.vars['--accent-strong']) >= 4.5);
  assert.equal(theme.vars['--on-accent'], '#fffaf6');
  assert.equal(theme.vars['--mod-codex'], DEFAULT_MODULE_COLORS.light.codex);
  assert.deepEqual(theme.warnings, []);
});

test('resolveTheme mode=dark 切换 dark token 与 dark 默认模块色', () => {
  const theme = resolveTheme({ mode: 'dark' });
  assert.equal(theme.mode, 'dark');
  assert.deepEqual(theme.attrs, { 'data-preset': 'claude', 'data-mode': 'dark' });
  assert.equal(theme.vars['--paper'], presetById('claude').dark['--paper']);
  assert.equal(theme.vars['--mod-codex'], DEFAULT_MODULE_COLORS.dark.codex);
  assert.equal(theme.vars['--mod-deepseek'], DEFAULT_MODULE_COLORS.dark.deepseek);
  assert.equal(theme.vars['--accent-strong'], theme.vars['--accent']);
  assert.equal(theme.vars['--on-accent'], '#262624');
  assert.deepEqual(theme.warnings, []);
});

test('resolveTheme mode=auto 按 systemDark 解析', () => {
  assert.equal(resolveTheme({ mode: 'auto' }, { systemDark: true }).mode, 'dark');
  assert.equal(resolveTheme({ mode: 'auto' }, { systemDark: false }).mode, 'light');
  assert.equal(resolveTheme({ mode: 'auto' }, { systemDark: true }).vars['--paper'], presetById('claude').dark['--paper']);
  assert.equal(resolveTheme({ mode: 'auto' }, { systemDark: false }).vars['--paper'], presetById('claude').light['--paper']);
  assert.equal(resolveTheme({ mode: 'auto' }).mode, 'light');
});

test('resolveTheme 未知 preset 回退 claude 并给 warning', () => {
  const theme = resolveTheme({ preset: 'neon' });
  assert.equal(theme.preset, 'claude');
  assert.deepEqual(theme.attrs, { 'data-preset': 'claude', 'data-mode': 'light' });
  assert.ok(theme.warnings.some((warning) => warning.includes('未知预设')), JSON.stringify(theme.warnings));
  assert.equal(theme.vars['--paper'], presetById('claude').light['--paper']);
});

test('resolveTheme preset=custom 以 claude 为底', () => {
  const theme = resolveTheme({ preset: 'custom' });
  assert.equal(theme.preset, 'custom');
  assert.deepEqual(theme.attrs, { 'data-preset': 'custom', 'data-mode': 'light' });
  assert.equal(theme.vars['--paper'], presetById('claude').light['--paper']);
  assert.equal(theme.vars['--accent'], presetById('claude').light['--accent']);
});

test('resolveTheme accent 覆盖并派生 soft/wash/ink，accent-ink 对 surface ≥4.5（P2-2）', () => {
  const base = resolveTheme();
  for (const accent of ['#ffd166', '#3f6fb5', '#111111']) {
    const themed = resolveTheme({ accent });
    assert.equal(themed.vars['--accent'], normalizeHex(accent));
    assert.ok(normalizeHex(themed.vars['--accent-soft']));
    assert.ok(normalizeHex(themed.vars['--accent-wash']));
    assert.ok(normalizeHex(themed.vars['--accent-ink']));
    const inkRatio = contrastRatio(themed.vars['--accent-ink'], themed.vars['--surface']);
    assert.ok(inkRatio >= 4.5, accent + ' 派生 accent-ink 对比度不足：' + inkRatio);
    assert.ok(
      contrastRatio(themed.vars['--on-accent'], themed.vars['--accent-strong']) >= 4.5,
      accent + ' 的 on-accent/strong 对比度不足'
    );
    assert.ok(!themed.warnings.some((warning) => warning.includes('accent-ink')), JSON.stringify(themed.warnings));
  }
  const derived = resolveTheme({ accent: '#3f6fb5' });
  assert.notEqual(derived.vars['--accent-ink'], base.vars['--accent-ink']);
  assert.deepEqual(base.vars, resolveTheme().vars, '预设常量不应被覆盖污染');
});

test('--accent-strong / --on-accent：light 混黑保白字，dark 用 accent，on-accent ≥4.5', () => {
  for (const preset of THEME_PRESETS) {
    for (const mode of ['light', 'dark']) {
      const theme = resolveTheme({ preset: preset.id, mode });
      const strong = theme.vars['--accent-strong'];
      const onAccent = theme.vars['--on-accent'];
      assert.ok(normalizeHex(strong), preset.id + ' ' + mode + ' accent-strong 非法');
      assert.ok(onAccent === '#fffaf6' || onAccent === '#262624', preset.id + ' ' + mode + ' on-accent 非法：' + onAccent);
      assert.ok(
        contrastRatio(onAccent, strong) >= 4.5,
        preset.id + ' ' + mode + ' on-accent/strong <4.5：' + contrastRatio(onAccent, strong)
      );
      assert.ok(!theme.warnings.some(onAccentWarning), preset.id + ' ' + mode + ' 不应有 on-accent warning');
      if (mode === 'light') {
        assert.notEqual(strong, theme.vars['--accent'], preset.id + ' light accent-strong 应加深');
        assert.ok(contrastRatio('#fffaf6', strong) >= 4.5, preset.id + ' light 白字对 strong <4.5');
        assert.equal(onAccent, '#fffaf6');
      } else {
        assert.equal(strong, theme.vars['--accent'], preset.id + ' dark accent-strong 应等于 accent');
        assert.equal(onAccent, '#262624');
      }
    }
  }
  // dark 中灰 accent：两种候选都不足 4.5，必须 warning 但仍返回最优点
  const gray = resolveTheme({ accent: '#7a7a7a', mode: 'dark' });
  assert.equal(gray.vars['--on-accent'], '#fffaf6');
  assert.ok(gray.warnings.some(onAccentWarning));
});

test('resolveTheme 非法 accent 忽略并 warning', () => {
  const theme = resolveTheme({ accent: 'not-a-color' });
  assert.equal(theme.vars['--accent'], presetById('claude').light['--accent']);
  assert.ok(theme.warnings.some((warning) => warning.includes('无效的强调色')), JSON.stringify(theme.warnings));
});

test('resolveTheme modules 覆盖 --mod-*，light/dark 默认色不同', () => {
  const theme = resolveTheme({ modules: { codex: '#112233', opencodeGo: '#ABC' } });
  assert.equal(theme.vars['--mod-codex'], '#112233');
  assert.equal(theme.vars['--mod-opencode'], '#aabbcc');
  assert.equal(theme.vars['--mod-deepseek'], DEFAULT_MODULE_COLORS.light.deepseek);
  assert.equal(theme.vars['--mod-relay'], DEFAULT_MODULE_COLORS.light.relay);
  const dark = resolveTheme({ mode: 'dark' });
  assert.equal(dark.vars['--mod-relay'], DEFAULT_MODULE_COLORS.dark.relay);
  assert.equal(dark.vars['--mod-other'], DEFAULT_MODULE_COLORS.dark.other);
});

test('P2-3：低对比度模块色给 warning（保留用户值，不拒绝）', () => {
  const theme = resolveTheme({ modules: { codex: '#ffffff' } });
  assert.ok(theme.warnings.some((warning) => warning.includes('模块颜色')), JSON.stringify(theme.warnings));
  assert.equal(theme.vars['--mod-codex'], '#ffffff');
});

test('resolveTheme 非法模块颜色忽略并 warning', () => {
  const theme = resolveTheme({ modules: { relay: 'red' } });
  assert.equal(theme.vars['--mod-relay'], DEFAULT_MODULE_COLORS.light.relay);
  assert.ok(theme.warnings.some((warning) => warning.includes('模块颜色')), JSON.stringify(theme.warnings));
});

test('resolveTheme 非法 mode 回退 light 并 warning', () => {
  const theme = resolveTheme({ mode: 'dusk' });
  assert.equal(theme.mode, 'light');
  assert.ok(theme.warnings.some((warning) => warning.includes('明暗模式')), JSON.stringify(theme.warnings));
});

test('resolveTheme 低对比度 accent 只 warning 不拒绝', () => {
  const theme = resolveTheme({ accent: '#ffffff' });
  assert.equal(theme.vars['--accent'], '#ffffff');
  assert.ok(theme.warnings.some((warning) => warning.includes('强调色与表面色')), JSON.stringify(theme.warnings));
  assert.equal(theme.preset, 'claude');
  assert.equal(theme.mode, 'light');
});

test('resolveTheme 全部预设 × 明暗：默认无 warning（对比度全部达标）', () => {
  for (const preset of THEME_PRESETS) {
    for (const mode of ['light', 'dark']) {
      const theme = resolveTheme({ preset: preset.id, mode });
      assert.deepEqual(theme.warnings, [], preset.id + ' ' + mode + ' 不应有 warning');
      const tokens = { paper: theme.vars['--paper'], surface: theme.vars['--surface'] };
      assert.ok(contrastRatio(theme.vars['--accent-strong'], theme.vars['--on-accent']) >= 4.5);
      if (mode === 'dark') {
        assert.ok(contrastRatio(theme.vars['--muted-2'], tokens.paper) >= 4.5, preset.id + ' dark muted-2');
      } else {
        assert.ok(contrastRatio(theme.vars['--muted-2'], tokens.paper) >= 3, preset.id + ' light muted-2');
      }
    }
  }
});

test('resolveTheme 不修改入参且返回独立对象', () => {
  const input = { preset: 'sage', mode: 'dark', accent: '#123456', modules: { codex: '#654321' } };
  const snapshot = JSON.stringify(input);
  const first = resolveTheme(input);
  const second = resolveTheme(input);
  assert.equal(JSON.stringify(input), snapshot);
  assert.notEqual(first.vars, second.vars);
  assert.notEqual(first.warnings, second.warnings);
  first.vars['--paper'] = '#000000';
  assert.equal(second.vars['--paper'], presetById('sage').dark['--paper']);
});
