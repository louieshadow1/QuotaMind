import test from 'node:test';
import assert from 'node:assert/strict';

import {
  windowKindFromSeconds,
  describeWindow,
  planMetaFor,
  expectedWindowsFor
} from '../lib/plan.mjs';

const UNKNOWN_WINDOW = { kind: 'custom', key: 'unknown', label: '未知窗口' };

test('windowKindFromSeconds: 18000 / 604800 / 2592000 映射到 session / weekly / monthly', () => {
  assert.deepEqual(windowKindFromSeconds(18000), { kind: 'session', key: '5h', label: '5 小时' });
  assert.deepEqual(windowKindFromSeconds(604800), { kind: 'weekly', key: 'weekly', label: '每周' });
  assert.deepEqual(windowKindFromSeconds(2592000), { kind: 'monthly', key: 'monthly', label: '每月' });
});

test('windowKindFromSeconds: 自定义周期用 w<sec> 与人性化 label', () => {
  assert.deepEqual(windowKindFromSeconds(86400), { kind: 'custom', key: 'w86400', label: '1 天' });
  assert.deepEqual(windowKindFromSeconds(432000), { kind: 'custom', key: 'w432000', label: '5 天' });
  assert.deepEqual(windowKindFromSeconds(3600), { kind: 'custom', key: 'w3600', label: '1 小时' });
  assert.deepEqual(windowKindFromSeconds(5400), { kind: 'custom', key: 'w5400', label: '1.5 小时' });
  assert.deepEqual(windowKindFromSeconds(12345), { kind: 'custom', key: 'w12345', label: '3.43 小时' });
});

test('windowKindFromSeconds: 接近标准周期用「约 …」避免撞名', () => {
  assert.deepEqual(windowKindFromSeconds(17999), { kind: 'custom', key: 'w17999', label: '约 5 小时' });
  assert.deepEqual(windowKindFromSeconds(18001), { kind: 'custom', key: 'w18001', label: '约 5 小时' });
  assert.deepEqual(windowKindFromSeconds(2591999), { kind: 'custom', key: 'w2591999', label: '约 30 天' });
  assert.deepEqual(windowKindFromSeconds(2592001), { kind: 'custom', key: 'w2592001', label: '约 30 天' });
  assert.deepEqual(windowKindFromSeconds(604800.5), { kind: 'custom', key: 'w604800.5', label: '约 7 天' });
});

test('windowKindFromSeconds: 小周期按分钟/秒显示，不出现「0 小时」', () => {
  assert.deepEqual(windowKindFromSeconds(1), { kind: 'custom', key: 'w1', label: '1 秒' });
  assert.deepEqual(windowKindFromSeconds(1.5), { kind: 'custom', key: 'w1.5', label: '1.5 秒' });
  assert.deepEqual(windowKindFromSeconds(60), { kind: 'custom', key: 'w60', label: '1 分钟' });
  assert.deepEqual(windowKindFromSeconds(90), { kind: 'custom', key: 'w90', label: '1.5 分钟' });
});

test('windowKindFromSeconds: 标准周期标签保持不变', () => {
  assert.deepEqual(windowKindFromSeconds(18000), { kind: 'session', key: '5h', label: '5 小时' });
  assert.deepEqual(windowKindFromSeconds(604800), { kind: 'weekly', key: 'weekly', label: '每周' });
  assert.deepEqual(windowKindFromSeconds(2592000), { kind: 'monthly', key: 'monthly', label: '每月' });
});

test('windowKindFromSeconds: 空值/非法值统一返回未知窗口且不抛错', () => {
  for (const value of [null, undefined, '', '   ', 'abc', NaN, 0, -18000, Infinity, false, {}, []]) {
    assert.deepEqual(windowKindFromSeconds(value), UNKNOWN_WINDOW);
  }
});

test('windowKindFromSeconds: 接受数字字符串，且返回新对象', () => {
  assert.deepEqual(windowKindFromSeconds('604800'), { kind: 'weekly', key: 'weekly', label: '每周' });
  const first = windowKindFromSeconds(18000);
  first.label = '改坏';
  assert.deepEqual(windowKindFromSeconds(18000), { kind: 'session', key: '5h', label: '5 小时' });
});

test('describeWindow: 超大 reset_at 返回 null 而不抛 RangeError', () => {
  for (const resetAt of [8.64e15 + 1, 1e18, '1000000000000000000']) {
    assert.equal(
      describeWindow({ used_percent: 10, limit_window_seconds: 18000, reset_at: resetAt }).resetAt,
      null
    );
  }
  // 恰好 8.64e15 仍合法，按上限内处理
  assert.equal(
    describeWindow({ reset_at: 8.64e15 }).resetAt,
    '+275760-09-13T00:00:00.000Z'
  );
});

test('describeWindow: windowSeconds ≤ 0 或非数时归一为 null', () => {
  for (const seconds of [0, -1, -18000, 'abc', null, undefined, NaN, Infinity]) {
    const window = describeWindow({ used_percent: 10, limit_window_seconds: seconds });
    assert.equal(window.windowSeconds, null);
    assert.equal(window.kind, 'custom');
    assert.equal(window.key, 'unknown');
    assert.equal(window.label, '未知窗口');
  }
});

test('describeWindow: 解析完整窗口（epoch 秒 reset_at）', () => {
  assert.deepEqual(
    describeWindow({ used_percent: 42, limit_window_seconds: 604800, reset_at: 1700000000 }),
    {
      key: 'weekly',
      kind: 'weekly',
      label: '每周',
      usedPercent: 42,
      windowSeconds: 604800,
      resetAt: '2023-11-14T22:13:20.000Z'
    }
  );
});

test('describeWindow: reset_at 支持 ISO / epoch 毫秒 / 数字字符串并统一为 ISO', () => {
  assert.equal(
    describeWindow({ limit_window_seconds: 18000, reset_at: '2026-11-20T12:00:00+08:00' }).resetAt,
    '2026-11-20T04:00:00.000Z'
  );
  assert.equal(
    describeWindow({ limit_window_seconds: 18000, reset_at: 1700000000000 }).resetAt,
    '2023-11-14T22:13:20.000Z'
  );
  assert.equal(
    describeWindow({ limit_window_seconds: 18000, reset_at: '1700000000' }).resetAt,
    '2023-11-14T22:13:20.000Z'
  );
});

test('describeWindow: reset_at 非法/缺失/0 返回 null，resets_at 作为别名', () => {
  assert.equal(describeWindow({ reset_at: 'not-a-date' }).resetAt, null);
  assert.equal(describeWindow({ reset_at: null }).resetAt, null);
  assert.equal(describeWindow({ reset_at: 0 }).resetAt, null);
  assert.equal(describeWindow({}).resetAt, null);
  assert.equal(
    describeWindow({ resets_at: '2026-11-20T04:00:00.000Z' }).resetAt,
    '2026-11-20T04:00:00.000Z'
  );
});

test('describeWindow: 空对象/非对象返回统一未知窗口', () => {
  const expected = { ...UNKNOWN_WINDOW, usedPercent: null, windowSeconds: null, resetAt: null };
  assert.deepEqual(describeWindow({}), expected);
  assert.deepEqual(describeWindow(null), expected);
  assert.deepEqual(describeWindow(undefined), expected);
});

test('describeWindow: 保留 0%，非法 used_percent 归一为 null', () => {
  assert.equal(describeWindow({ used_percent: 0, limit_window_seconds: 18000 }).usedPercent, 0);
  assert.equal(describeWindow({ used_percent: '0', limit_window_seconds: 18000 }).usedPercent, 0);
  assert.equal(describeWindow({ used_percent: 'abc', limit_window_seconds: 18000 }).usedPercent, null);
  assert.equal(describeWindow({ used_percent: NaN, limit_window_seconds: 18000 }).usedPercent, null);
});

test('describeWindow: limit_window_seconds 缺失时不猜槽位，返回未知窗口', () => {
  const window = describeWindow({ used_percent: 10, reset_at: 1700000000 });
  assert.equal(window.key, 'unknown');
  assert.equal(window.kind, 'custom');
  assert.equal(window.label, '未知窗口');
  assert.equal(window.windowSeconds, null);
  assert.equal(window.usedPercent, 10);
  assert.equal(window.resetAt, '2023-11-14T22:13:20.000Z');
});

test('describeWindow: 不修改入参', () => {
  const raw = { used_percent: 23, limit_window_seconds: 18000, reset_at: 1700000000 };
  const before = { ...raw };
  describeWindow(raw);
  assert.deepEqual(raw, before);
});

test('planMetaFor: plus / pro / prolite / go 元数据符合契约', () => {
  assert.deepEqual(planMetaFor('plus'), {
    id: 'plus',
    name: 'Plus',
    tier: 'plus',
    expectedWindows: ['5h', 'weekly'],
    note: '5 小时 + 每周双窗口'
  });
  assert.deepEqual(planMetaFor('pro'), {
    id: 'pro',
    name: 'Pro',
    tier: 'pro',
    expectedWindows: ['weekly'],
    note: '仅每周窗口'
  });
  assert.deepEqual(planMetaFor('prolite'), {
    id: 'prolite',
    name: 'Pro Lite',
    tier: 'prolite',
    expectedWindows: ['weekly'],
    note: '该计划仅提供每周额度'
  });
  assert.deepEqual(planMetaFor('go'), {
    id: 'go',
    name: 'Go',
    tier: 'go',
    expectedWindows: [],
    note: '按接口实际窗口显示'
  });
});

test('planMetaFor: free / team / enterprise 元数据', () => {
  assert.deepEqual(planMetaFor('free'), {
    id: 'free',
    name: 'Free',
    tier: 'free',
    expectedWindows: [],
    note: '按接口实际窗口显示'
  });
  assert.deepEqual(planMetaFor('team'), {
    id: 'team',
    name: '团队',
    tier: 'team',
    expectedWindows: [],
    note: '按接口实际窗口显示'
  });
  assert.deepEqual(planMetaFor('enterprise'), {
    id: 'enterprise',
    name: '企业',
    tier: 'enterprise',
    expectedWindows: [],
    note: '按接口实际窗口显示'
  });
});

test('planMetaFor: 归一化大小写/空白/下划线/连字符', () => {
  const plus = planMetaFor('plus');
  for (const alias of ['PLUS', ' Plus ', 'pLuS']) assert.deepEqual(planMetaFor(alias), plus);
  const prolite = planMetaFor('prolite');
  for (const alias of ['PRO LITE', 'pro_lite', 'pro-lite', ' ProLite ']) {
    assert.deepEqual(planMetaFor(alias), prolite);
  }
});

test('planMetaFor: 未知计划保留原值，空值回退未知计划', () => {
  assert.deepEqual(planMetaFor('mystery'), {
    id: 'mystery',
    name: 'mystery',
    tier: 'unknown',
    expectedWindows: [],
    note: '按接口实际窗口显示'
  });
  const fallback = {
    id: 'unknown',
    name: '未知计划',
    tier: 'unknown',
    expectedWindows: [],
    note: '按接口实际窗口显示'
  };
  assert.deepEqual(planMetaFor(null), fallback);
  assert.deepEqual(planMetaFor(undefined), fallback);
  assert.deepEqual(planMetaFor(''), fallback);
});

test('planMetaFor: 每次返回深拷贝，调用方修改不影响后续', () => {
  const first = planMetaFor('plus');
  first.name = '被改了';
  first.expectedWindows.push('monthly');
  assert.deepEqual(planMetaFor('plus'), {
    id: 'plus',
    name: 'Plus',
    tier: 'plus',
    expectedWindows: ['5h', 'weekly'],
    note: '5 小时 + 每周双窗口'
  });
});

test('expectedWindowsFor: 按计划返回字符串 key 列表', () => {
  assert.deepEqual(expectedWindowsFor('plus'), ['5h', 'weekly']);
  assert.deepEqual(expectedWindowsFor('pro'), ['weekly']);
  assert.deepEqual(expectedWindowsFor('prolite'), ['weekly']);
  assert.deepEqual(expectedWindowsFor('go'), []);
  assert.deepEqual(expectedWindowsFor('free'), []);
  assert.deepEqual(expectedWindowsFor('mystery'), []);
  assert.deepEqual(expectedWindowsFor(null), []);
});

test('expectedWindowsFor: 接受 planMeta 对象且返回拷贝', () => {
  const meta = planMetaFor('plus');
  assert.deepEqual(expectedWindowsFor(meta), ['5h', 'weekly']);
  const windows = expectedWindowsFor('plus');
  windows.push('monthly');
  assert.deepEqual(expectedWindowsFor('plus'), ['5h', 'weekly']);
});
