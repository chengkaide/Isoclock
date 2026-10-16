/* ==========================================================================
 *  splash.js —— 启动界面（开屏）
 *
 *  打开页面时盖在最上面的一屏：一个标志、一句标语、三条承诺，约 1.4 s 后自动
 *  淡出；这期间点一下、按一下键、滚一下滚轮、碰一下屏幕，都会立刻进主界面。
 *
 *  为什么要有它
 *  ------------
 *  这是个"仪器"：单文件、离线、双击即用。可双击之后第一眼看到的是一个参数
 *  很多的工作台 —— 它是什么、它保证什么，得自己往下读才看得见。开屏只做一件
 *  事：在数字开始跑之前，把这两句话说完。
 *
 *  三条约束（与这个项目其他决定同源）
 *  ----------------------------------
 *  ① **不做仪式感绑架**：任何输入都立刻跳过，而且**不写任何本地存储**。
 *     "记住你看过"要在 file:// 下依赖各浏览器行为不一致的 localStorage ——
 *     同一份文件换个目录还会再弹一次，省下 1.4 s 却换来一个不可预测的行为，
 *     不划算。
 *  ② **不挡路**：#selftest（无头自检）与 #nosplash 下**根本不建这个 DOM**。
 *     自检、截图、桌面壳（packaging/isoclock_desktop.py 就是带 #selftest 打开的）
 *     所以都不受影响。这条本身也是一条自检项。
 *  ③ **不引外链**：标志是内联 SVG，颜色写在 style.css 里，字体用系统字体。
 *     开屏只是这一页上的一层，不是另一个页面 —— 单文件离线这条不能破。
 *
 *  标志（logo）怎么来的
 *  --------------------
 *  "Isoclock" = isochron + clock。所以标志是一个**表盘**（虚线圆环 + 四个刻度）
 *  里面画一条**谐和线**（Wetherill 图里那条凹曲线）与三个落在线上的数据点。
 *  曲线是一条二次贝塞尔 M24 72 Q30 34 72 24：控制点在中点连线的左上侧，
 *  于是曲线朝左上凸 —— 与站点首页那张谐和图的形状一致（不是随手画的弧）。
 *  三个点取 t = 0.25 / 0.5 / 0.75，坐标由脚本实算（贝塞尔弧长 72.6334）：
 *
 *      t=0.25 → (29.25, 54.75)    t=0.50 → (39.00, 41.00)    t=0.75 → (53.25, 30.75)
 *
 *  动画用它来"画"出来：stroke-dasharray 76（略大于弧长，见上）从 76 走到 0，
 *  三个点随后依次弹出，表盘缓慢自转。
 * ========================================================================== */
(function () {
  'use strict';

  var SLOGAN_ZH = '每一个计数，都算数。';
  var SLOGAN_EN = 'Every count counts.';
  var SUB = 'LA-ICP-MS U–Th–Pb 定年数据归算';
  var CHIPS = ['与桌面版逐位一致', '零依赖单文件', '不上传任何数据'];

  var DWELL = 1400;   // 自动进入前停留多久（ms）。CSS 里那条进度条走同一个数。
  var FADE = 380;     // 淡出时长（ms），必须与 style.css 里 #splash 的 transition 一致。

  var LOGO =
    '<svg class="sp-mark" viewBox="0 0 96 96" width="96" height="96" ' +
      'aria-hidden="true" focusable="false">' +
      //  表盘：虚线圆环（像表圈上的分钟刻度）
      '<circle class="sp-ring" cx="48" cy="48" r="43" fill="none" stroke="#3a5c8a" ' +
        'stroke-width="1.6" stroke-dasharray="2 6.2" stroke-linecap="round"/>' +
      //  12 / 3 / 6 / 9 四个实刻度 —— 有这四个才读得出"这是个钟面"
      '<g class="sp-ticks" stroke="#5c7ea8" stroke-width="2" stroke-linecap="round">' +
        '<line x1="48" y1="5" x2="48" y2="11"/>' +
        '<line x1="48" y1="85" x2="48" y2="91"/>' +
        '<line x1="5" y1="48" x2="11" y2="48"/>' +
        '<line x1="85" y1="48" x2="91" y2="48"/>' +
      '</g>' +
      //  谐和线（朝左上凸）与三个数据点
      '<path class="sp-curve" d="M24 72 Q30 34 72 24" fill="none" stroke="#5ea1ff" ' +
        'stroke-width="3.2" stroke-linecap="round"/>' +
      '<circle class="sp-dot d1" cx="29.25" cy="54.75" r="3.4" fill="#34d399"/>' +
      '<circle class="sp-dot d2" cx="39" cy="41" r="4.2" fill="#34d399"/>' +
      '<circle class="sp-dot d3" cx="53.25" cy="30.75" r="2.8" fill="#34d399"/>' +
    '</svg>';

  var el = null, timer = null, entered = false;

  /** 三种"不要开屏"的入口。
   *  #selftest  —— 页面内自检（无头浏览器只读 <title>，开屏会白占 1.4 s）
   *  #api       —— 程序接口模式：智能体/脚本要的是 window.DS_API，不看界面
   *  #nosplash  —— 手工排查用：想直接看主界面就往地址栏加它
   *  __noSplash —— 截图脚本（G:/_isohtml/mkinject.py）要拍的是主界面 */
  function shouldSkip() {
    if (window.__noSplash === true) return true;
    var h = String(location.hash || '');
    return /(^|[#&])selftest\b/.test(h) || /(^|[#&])nosplash\b/.test(h)
      || /(^|[#&])api\b/.test(h);
  }

  var skipped = shouldSkip();

  var reduced = false;
  try {
    reduced = !!(window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch (e) { reduced = false; }

  /** 只造节点、不挂载 —— 自检要能单独验它的内容。 */
  function build() {
    var d = document.createElement('div');
    d.id = 'splash';
    d.className = reduced ? 'reduced' : '';
    d.tabIndex = -1;
    d.setAttribute('role', 'dialog');
    d.setAttribute('aria-modal', 'true');
    d.setAttribute('aria-label', 'Isoclock 启动界面');
    //  进度条的长度＝停留时长：只在这里给值，CSS 那边只读不写，
    //  免得"条走完了开屏还在"或反过来。
    d.style.setProperty('--sp-dwell', DWELL + 'ms');
    d.innerHTML = [
      '<div class="sp-box">',
      '  <div class="sp-logo">' + LOGO + '</div>',
      '  <div class="sp-name">Isoclock</div>',
      '  <div class="sp-sub">' + SUB + '</div>',
      '  <div class="sp-rule"></div>',
      '  <p class="sp-slogan">' + SLOGAN_ZH + '</p>',
      '  <p class="sp-slogan-en" lang="en">' + SLOGAN_EN + '</p>',
      '  <ul class="sp-chips">' + CHIPS.map(function (c) {
        return '<li>' + c + '</li>';
      }).join('') + '</ul>',
      '  <div class="sp-bar"><i></i></div>',
      '  <div class="sp-hint">点击任意处，或按任意键进入</div>',
      '</div>'
    ].join('\n');
    return d;
  }

  function mount() {
    if (el || skipped) return null;
    if (!document.body) return null;
    el = build();
    document.body.appendChild(el);
    el.addEventListener('click', dismiss);
    el.addEventListener('wheel', dismiss, { passive: true });
    el.addEventListener('touchstart', dismiss, { passive: true });
    //  键盘挂在 window 上：焦点万一没落在开屏上（比如浏览器把焦点放回了
    //  工具栏），按键也不该被吞掉。
    window.addEventListener('keydown', dismiss, true);
    try { el.focus(); } catch (e) { /* 拿不到焦点也不影响：还有自动淡出 */ }
    timer = setTimeout(dismiss, reduced ? Math.round(DWELL * 0.5) : DWELL);
    return el;
  }

  function dismiss() {
    //  没挂过（或已退场）就什么都不做；用 #splash 兜底是为了让自检能
    //  单独造一个节点、走一次真实的退场路径。
    var node = el || document.getElementById('splash');
    if (!node || entered) return;
    entered = true;
    if (timer) { clearTimeout(timer); timer = null; }
    window.removeEventListener('keydown', dismiss, true);
    node.classList.add('out');
    node.setAttribute('aria-hidden', 'true');
    node.style.pointerEvents = 'none';   // 淡出的这 380 ms 里不许再挡住点击
    setTimeout(function () {
      if (node.parentNode) node.parentNode.removeChild(node);
    }, reduced ? 0 : FADE);
    if (el === node) el = null;
  }

  if (!skipped) {
    if (document.body) mount();
    else document.addEventListener('DOMContentLoaded', mount);
  }

  window.DS_SPLASH = {
    zh: SLOGAN_ZH, en: SLOGAN_EN, sub: SUB, chips: CHIPS,
    dwell: DWELL, reduced: reduced,
    build: build, mount: mount, dismiss: dismiss, shouldSkip: shouldSkip,
    skipped: skipped,
    node: function () { return el || document.getElementById('splash'); }
  };
})();
