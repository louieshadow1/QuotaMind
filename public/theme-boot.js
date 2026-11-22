/* quota-board · 首屏配色引导（H5 → R6，零依赖）
 *
 * 作用：在首次绘制前，把上一次应用过的配色（localStorage 'qb-theme-cache'）
 * 写回根元素的 CSS 变量与 data-preset / data-mode，避免深色或自定义配色先闪一下默认白。
 * 之后 app.js 用 /api/theme 的权威结果再校正。
 *
 * 缓存形状容错（不依赖单一来源）：
 *   A) { current:{preset,mode}, vars:{...}, mode:'light|dark' }   ← 当前 app.js 写法
 *   B) { current:{...}, varsLight:{...}, varsDark:{...}, mode }   ← R3 若改双份缓存，按 mode 选
 *   C) { preset, mode, vars }                                      ← H5 早期形状
 *   D) { '--paper':'…' } 平铺                                      ← 兜底
 *
 * 为什么是外链而不是内联：服务端 CSP 是 script-src 'self'，内联 <script> 会被浏览器拒绝。
 * 必须同步加载（head 内、无 defer/async），否则起不到防闪作用。
 * 任何异常都吞掉：配色失败绝不能挡住面板本身。
 */
(function () {
  try {
    var storage = window.localStorage;
    if (!storage) return;
    var raw = storage.getItem('qb-theme-cache');
    if (!raw) return;
    var cache = JSON.parse(raw);
    if (!cache || typeof cache !== 'object' || Array.isArray(cache)) return;

    var root = document.documentElement;
    var theme = cache.current && typeof cache.current === 'object' && !Array.isArray(cache.current) ? cache.current : {};

    var mode = cache.mode;
    if (mode !== 'light' && mode !== 'dark' && mode !== 'auto') mode = theme.mode;
    if (mode === 'auto') {
      mode = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    if (mode !== 'light' && mode !== 'dark') mode = null;

    var vars = cache.vars && typeof cache.vars === 'object' && !Array.isArray(cache.vars) ? cache.vars : null;
    if (!vars && mode && (cache.varsLight || cache.varsDark)) {
      var byMode = mode === 'dark' ? cache.varsDark : cache.varsLight;
      if (byMode && typeof byMode === 'object' && !Array.isArray(byMode)) vars = byMode;
    }
    if (!vars) vars = cache; // 平铺形状

    for (var name in vars) {
      if (!Object.prototype.hasOwnProperty.call(vars, name)) continue;
      if (typeof name !== 'string' || name.slice(0, 2) !== '--') continue;
      var value = vars[name];
      if (typeof value !== 'string' || !value || value.length > 64) continue;
      root.style.setProperty(name, value);
    }

    var preset = cache.preset || theme.preset;
    if (typeof preset === 'string' && /^[a-z]{1,16}$/.test(preset)) {
      root.setAttribute('data-preset', preset);
    }

    if (mode) {
      root.setAttribute('data-mode', mode);
      try {
        root.style.colorScheme = mode;
      } catch (ignored) {
        /* 老浏览器忽略即可 */
      }
    }
  } catch (err) {
    /* 首屏引导失败：保持默认配色，等 app.js 用 /api/theme 校正 */
  }
})();
