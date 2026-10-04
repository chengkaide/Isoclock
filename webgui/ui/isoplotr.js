/* ==========================================================================
 *  isoplotr.js —— 可选的 IsoplotR 谐和图模块
 *
 *  这是本软件里**唯一**需要联网的部分，也是唯一不在"单文件 754 KB、离线可开"
 *  这句话覆盖范围内的部分。所以它的设计原则与别的模块相反：
 *
 *      · 平时完全不加载 —— 页面上只是一个标签页与一个按钮；不点它，
 *        不下载任何字节，也不影响"离线可用"。
 *      · 点了才去 CDN 取 webR（WebAssembly 版 R）与 IsoplotR（R 包），
 *        首次合计约 16 MB（浏览器缓存之后就只有 IsoplotR 那 0.7 MB 的重装）。
 *      · 数据**不出本机**：只在本页的浏览器内存里传给 wasm 里的 R。
 *
 *  为什么要有它：report.js 里原本写着"不做谐和图，那是另一个工具的事"，
 *  而 docs/index.src.html 又说谐和图"这套软件最后要交代的就是这张图"。
 *  这个模块就是把那个缺口补上 —— 自己重写一遍 Ludwig(1998) 的 discordia
 *  不现实（那正是 IsoplotR 十年积累的地方），接进来才诚实。
 *
 *  ----------------------------------------------------------------------
 *  与 IsoplotR 的对接口径（全部本机实测，不是查文档抄的）
 *  ----------------------------------------------------------------------
 *  ① 用 read.data 的 method="U-Pb", format=1
 *        format=1 的列定义是：X=07/35, err[X], Y=06/38, err[Y] (, rho[X,Y])
 *      —— 正好是 age.js 第 36/37/38/39/40 列（0 基），一列不多一列不少。
 *
 *      **不要用 format=3。** 它多要一个 Z=07/06，而 Z 与 X、Y 是冗余的
 *      （X = Y·Z·137.818），IsoplotR 会据此判断我们给的相关系数"不可能"，
 *      把它**换掉**并打一条警告：
 *          "Redundant ratios of U-Pb data format lead to impossible
 *           correlation coefficients. These were replaced with alternative
 *           values assuming zero Tera-Wasserburg correlations."
 *      实测后果（内置 49 个真实样品，45 个可用点，type=1, show.age=1）：
 *          format=1 → 164.086 Ma，MSWD(combined) 109.94
 *          format=3 → 164.974 Ma，MSWD(combined) 181.92
 *          最大相对差 65.5%
 *      也就是说 format=3 会把用户真实的误差相关性丢掉 —— 误差椭圆的形状是错的。
 *
 *  ② ierr=2 就是"2σ 绝对"，与 age.js 的 '2s' 列同一个口径，**不用折半**。
 *      （ierr：1=1σ 绝对、2=2σ 绝对、3=1σ 相对%、4=2σ 相对%。）
 *
 *  ③ rho 必须带上。Isoclock 的 rho 列就是 ρ(²⁰⁷Pb/²³⁵U, ²⁰⁶Pb/²³⁸U)：
 *     它由 ρ = (w²+s²-o²)/(2ws) 从三个比值的相对误差反解出来（age.js 的
 *     rhoOf），正是 IsoplotR 要的那个量。真实数据上它落在 0.05~0.92，
 *     不传就按 0 处理，椭圆会变成一个与真实形状不符的轴对齐椭圆。
 *
 *  ④ 结果字段（`age()` 与 `concordia()` 的返回值结构完全不同，别混）：
 *        concordia(show.age=1) → $age = c(t=, s[t]=, disp[t]=)，
 *                                $mswd/$p.value/$df 各有 equivalence/concordance/combined
 *        concordia(show.age≥2) → $par + $err（err 有两行：s=1σ、disp=1σ·√MSWD），
 *                                $mswd/$p.value/$df 是标量
 *      **没有 $err 这种东西挂在 age 上** —— 这里猜错过一次。
 *
 *  ⑤ 图上印的数与返回值口径不同：concordia() 默认 oerr=3，图上印的是
 *     **95% 置信区间**（1.96σ），而 $err["s",] 是 1σ 标准误。实测
 *     AY-4：$age["s[t]"]=0.4970，图上印 0.974 —— 差 1.96 倍。
 *     我们的汇总表两个都写出来，并注明各自口径。
 *
 *  ⑥ show.age≥2 的 discordia 拟合**会真失败**，不是理论上会：
 *         · AY-4（14 个近谐和点）→ "non-finite value supplied by optim"
 *         · SRM 612（2 点）      → "f() values at end points not of opposite sign"
 *         · 单点                  → "Cannot fit a straight line through these data"
 *     根因是地质的：一组本来谐和的点画不出有意义的 discordia（上交点趋于无穷）。
 *     所以整段拟合包在 tryCatch 里：失败就退回只画点，并把 R 的原文带回界面。
 *     这不是"容错"，是不许把失败藏起来。
 *
 *  ⑦ 体积与耗时（本机无头 Edge，走真 CDN，实测）：
 *        import webr.mjs          0.7 s
 *        init（R.wasm 12.3 MB gz）47.4 s
 *        installPackages(IsoplotR) 10.8 s
 *        首次合计                 ≈ 59 s      ← 界面必须如实说明，不能假装很快
 *        之后每次作图：show.age=1 约 0.5~1.3 s、show.age=2 约 3.3 s
 *      VFS 里 IsoplotR 0.77 MB、MASS 1.05 MB。
 *
 *  ⑧ 入口必须是 CDN 的 `webr.mjs`，**不要**用 npm 包里的 `webr.mjs`：
 *         https://webr.r-wasm.org/v0.6.0/webr.mjs  sha256 4c04d324…  ← 浏览器构建
 *         npm webr@0.6.0  dist/webr.js              sha256 4c04d324…  ← 同一份字节
 *         npm webr@0.6.0  dist/webr.mjs             sha256 09e64017…  ← 给打包器用的
 *      官方 CDN 把浏览器构建命名成了 .mjs；npm 里那个 .mjs 第一行就是
 *      `import { createRequire } from 'module'`，浏览器直接加载会报
 *      "Failed to resolve module specifier"。（这两个名字曾经把整个可行性判断
 *      带偏过一次，所以在这里钉死。）
 *
 *  ⑨ `file://` 双击打开也能用（实测 0.7 s import / 49.2 s init）：
 *     webR 检测到跨源时走 XHR + Blob URL 建 worker，CDN 的
 *     `Access-Control-Allow-Origin: *` 允许 file:// 读取。原先担心
 *     `location.origin` 是 "null" 会让它内部 `new URL(baseUrl, origin)`
 *     抛异常 —— 实测 Edge 下 `location.origin` 是 `"file://"`，不抛。
 *     测试时**不要**给浏览器加 `--disable-web-security`，那等于换了个浏览器。
 *
 *  ⑩ SVG 是自包含的：script 标签 0 个、style 标签 0 个、外链 0 个、
 *     文字全部转成了字形轮廓（text 元素为 0，所以别靠数文字节点判断图是不是空的）。
 *     但它用 symbol 元素 + id="glyph0-1" 定义字形 —— 两张图内联进同一份文档会
 *     id 撞车。所以一律以 data URI 塞进 img 元素，天然隔离。
 *     ⚠ 这一段刻意不写出尖括号的标签名：build_ui.py 会数产物里 script 标签的
 *       开闭数量，而源码的**注释里**写一个尖括号标签名就会被算进去，
 *       构建直接报"数量对不上"。
 *
 *  ⑪ 生成的 R 脚本里，`if (...) X` 与后面的 `else Y` **必须写在同一行**。
 *     R 在顶层把 `f1 <- function(x) if (cond) "NA"` 判为一个**完整语句**，
 *     下一行开头的 `else` 于是成了"没有 if 的 else"，整段脚本一行都不执行：
 *         Error in parse(text = expr) : :4:3: unexpected 'else'
 *     表现是"点按钮没反应、图不出、日志里只有一句 parse 错"。
 *     这一条单测挡不住（Node 里没有 R），所以在渲染路径上也加了兜底：
 *     R 回来的文本里带 error= 就会显示到界面上，不会静默。
 *
 *  ⑫ ρ 的判据必须作用在"**真正写出去的那个数**"上（这是接进来之后唯一
 *     一个"图能出、数看着也正常、但其实全错"的坑，2026-10-02 实测）：
 *       年龄表里 AY-4 有两个点 ρ = 0.99999999999999889 / 0.99999999999999933。
 *       按原始值判 `|ρ| < 1` ⇒ 放行；写文件时按 10 位有效数字 ⇒ "1.000000000"
 *       ⇒ R 收到的相关系数**精确等于 1** ⇒ 协方差矩阵退化
 *       ⇒ concordia(show.age=1) 报 `L-BFGS-B needs finite values of 'fn'`，
 *         而 badRho 计数是 0，界面上没有任何提示。
 *     修法是三处用同一个数：先 asWritten() 舍到 10 位有效数字 → 用它判合法性
 *     → 写出去的就是它（见 SIGDIG / rowUsable 的 cells）。
 *     ρ=1 不是"测坏了"，而是原实现 rhoOf 里那个 min(|t|, w/s) 夹逼饱和到 1
 *     （w/s 在两个比值相对误差相当时就是 1）—— 年龄表也照印，所以这是**原实现
 *     的口径**，不是我们引入的。IsoplotR 那边 ρ=1 就是非法输入，只能剔掉并
 *     如实报数；界面上会写明剔了几个、为什么。
 *
 *  ⑬ 作图的**主体是样品，不是标样**（2026-10-02 用户指出，这一条是领域口径）：
 *       这批内置数据是**一个文件一个测点** —— 32 个样品各 1 点，而标样
 *       AY-4 有 15 个文件、SRM 612 有 2 个。于是"按点数排序、点最多的排前面"
 *       就会把 AY-4 顶到第一位，最自然的操作恰好是拿标样去拟合"样品年龄"——
 *       而 AY-4 是 QC 样：它的谐和年龄要跟②里填的真值（158.2 Ma）比，
 *       用来判断本批的分馏校正/再现性，**不是**待测样品的年龄。
 *       ⇒ `standardNames(cfg)` 从配置里认标样；界面上把它们分到 optgroup
 *         「标样（QC 用）」，默认选择是**不含标样的全部样品**；
 *         `buildTable` 的 `drop` 只在合并选时生效（单点某个标样仍可画）。
 *       单看代码是发现不了这个错的 —— 它数值上完全正常（14 个近谐和点能拟合出
 *       157.29 Ma，很漂亮），错的是"这 14 个点是什么"。
 *
 *  ⑭ 选项**逐项对齐原版**而已（2026-10-04）。界面上的"更多选项"面板对应的是
 *     IsoplotR 自己的图形界面（pvermees/IsoplotRgui，
 *     inst/www/options/concordia.html），参数名、取值、默认值全部照抄，不自己发明：
 *       · anchor      → `anchor=模式` 或 `anchor=c(2,年龄)`（anchor[1] 选模式、
 *                       anchor[2] 是年龄；只有 show.age≥2 用得上，原版 GUI 也是
 *                       只在选 discordia 时才显示这一栏）
 *       · 不谐和度过滤 → `cutoff.disc=discfilter(option=,before=,cutoff=)`
 *       · ticks       → 一个数（刻度条数）或一串年龄
 *       · 椭圆样式     → `ellipse.fill="#RRGGBBAA"` / `ellipse.stroke="#RRGGBB"`
 *       三条规矩：
 *        (a) **留空就是不传这个参数** —— 让它用 IsoplotR 自己的默认值，而不是我们
 *            另编一个。用户没动过的项，行为必须与没有这个面板时逐位相同。
 *        (b) **只有经过校验的东西才能进 R 代码**：数字、受控布尔、正则校验过的
 *            十六进制颜色。界面上的任意字符串绝不直接拼进 R（那就是代码注入）。
 *        (c) 原版能选而我们做不到的，**要在界面上写明原因**，不能悄悄缺两项：
 *            type=3（U-Th-Pb 图）只对 7/8 号数据格式开放，我们要的是 ²⁰⁸Pb/²³²Th 列；
 *            椭圆配色的那些 ramp 是给"按变量上色"（levels）用的，我们没有这一列。
 * ========================================================================== */
(function () {
  'use strict';

  /* ------------------------------------------------------------------
   *  常量
   * ------------------------------------------------------------------ */
  var CDN = 'https://webr.r-wasm.org/v0.6.0/';
  var WEBR_ENTRY = CDN + 'webr.mjs';
  var PKG = 'IsoplotR';

  //  age.js 的 51 列行布局（0 基）。这几个列号是读 src/age.js 的 row 数组数出来的，
  //  并用内置的 49 个真实样品核过：n=49 行里 [33][34][36][37][38][39][40] **全部有限**
  //  （积分窗口修正后不再有"整行算不出比值"的文件；剩下的 NaN 只在 ²⁰⁸Pb/²³²Th
  //  那一族列上，与这里的五个量无关）。另有两行（sample_24 / sample_48）的 ρ 恰好
  //  写成 ±1，交给 IsoplotR 会被它按退化协方差剔掉 —— 那是它自己的判据，
  //  见 test_isoplotr.js 的 §G。
  var COL = { file: 0, name: 1, Z: 33, sZ: 34, X: 36, sX: 37, Y: 38, sY: 39, rho: 40 };

  //  read.data(format=1) 的表头。顺序即列序，改了就是另一个 format。
  var HEADER = 'Pb207U235,errPb207U235,Pb206U238,errPb206U238,rhoXY';
  var HEADER_SPEC = 'X=07/35, err[X], Y=06/38, err[Y] (, rho[X,Y])';

  //  图形与拟合选项（值就是 IsoplotR 的参数值，界面上的下拉直接拿它当 value）
  var TYPES = [
    { v: 1, label: 'Wetherill（²⁰⁶Pb/²³⁸U – ²⁰⁷Pb/²³⁵U）',
      note: '最常用。纵轴 ²⁰⁶Pb/²³⁸U、横轴 ²⁰⁷Pb/²³⁵U —— 与图解版里那几张朝向一致。' },
    { v: 2, label: 'Tera-Wasserburg（²³⁸U/²⁰⁶Pb – ²⁰⁷Pb/²⁰⁶Pb）',
      note: '不校正普通铅时的标准画法。' }
  ];

  var AGES = [
    { v: 0, label: '只画图（不拟合）',
      note: '最快，也不会失败 —— 只有点、误差椭圆与谐和线。' },
    { v: 1, label: '谐和年龄（concordia age）',
      note: '把数据当作一组谐和点做最大似然拟合，出年龄与 MSWD。' },
    { v: 2, label: 'discordia 交点（Ludwig 1998）',
      note: '拟合一条割线，出上/下交点年龄。数据本身谐和时会失败。' },
    { v: 3, label: 'discordia 交点（忽略分析误差）',
      note: '同上，但不看分析误差，只看几何。' },
    { v: 4, label: 'discordia 交点（含过离散项）',
      note: '在 2 的基础上加一个地质离散度项 w。' }
  ];

  var CPB = [
    { v: 0, label: '不校正普通铅' },
    { v: 1, label: '用设定的普通铅比值（²⁰⁷Pb/²⁰⁶Pb = 1.106）' },
    { v: 2, label: '用等时线截距作普通铅' },
    { v: 3, label: 'Stacey–Kramers 两阶段模型' }
  ];

  //  —— 以下三组是"更多选项"面板用的，逐项照抄 IsoplotRgui 的 concordia 表单 ——

  //  锚定（anchor）。原版的 anchor 是**向量**：anchor[1] 选模式，anchor=2 时
  //  anchor[2] 才是那个年龄。只有 show.age≥2（discordia）用得上。
  var ANCHORS = [
    { v: 0, label: '不锚定（原版默认）',
      note: '让 discordia 自由拟合，上下交点都由数据定。' },
    { v: 1, label: '固定普通铅成分（用设定值）',
      note: 'anchor=1：把普通铅的 ²⁰⁷Pb/²⁰⁶Pb 钉在设定值上，只拟合年龄。' },
    { v: 2, label: '强制交点落在指定年龄',
      note: 'anchor=c(2,年龄)：把上交点（Tera-Wasserburg 时是下交点）钉在你填的'
        + '年龄上，再拟合另一头。右边要填那个年龄。' },
    { v: 3, label: '锚到 Stacey–Kramers 地幔线',
      note: 'anchor=3：把非放射成因组分锚在 Stacey–Kramers 地幔演化成分上。' }
  ];

  //  不谐和度过滤的档位。原版第一档是「校正前 / 校正后」二选一，而"校正后"
  //  要求数据格式 ≥4（得能给出逐点的普通铅校正量）；我们的表是 format=1，
  //  所以那一档在界面上不出现 —— 这是**如实缺一项**，不是漏写（见文件头 ⑭(c)）。
  var DISCFILTERS = [
    { v: 0, label: '不过滤（原版默认）' },
    { v: 1, label: '按普通铅校正前的比值过滤',
      note: 'before=TRUE：先用原始比值判不谐和度，再谈校正。' }
  ];

  //  过滤判据（discfilter 的 option），5 档与原版一字不差。
  var DISCOPT = [
    { v: 1, label: 't：²⁰⁶Pb/²³⁸U 与 ²⁰⁷Pb/²⁰⁶Pb 年龄之差（Ma）' },
    { v: 2, label: 'r：同上，取相对值（%）' },
    { v: 3, label: 'sk：沿 Stacey–Kramers 地幔连线的普通铅百分比' },
    { v: 4, label: 'a：到 Tera-Wasserburg 谐和线的对数比距离（%）' },
    { v: 5, label: 'c：到单点谐和年龄成分的对数比距离（%）' }
  ];

  //  discfilter() 在 cutoff 缺省时各自的上下限（照抄 R 里那串 if-else）。
  //  界面上拿它当 placeholder：留空就真的是这套默认值，不是我们另编的。
  var DISC_DEFAULT = { 1: [-48, 140], 2: [-5, 15], 3: [-0.36, 0.96],
                       4: [-1.6, 4.7], 5: [-2, 5.8] };

  //  render() 把界面上来的选项**原样透传**给 rArgs() 时认的 key。
  //  这是这份清单唯一的一份拷贝 —— 加参数只改这里；漏了某个 key 的症状是
  //  "界面填了、图没变"，单看代码看不出来，所以测试里有一条断言钉住它：
  //  rArgs() 源码里出现的每一个 `a.xxx` 都必须在这张表里（见 test_isoplotr.js §H）。
  var RARG_KEYS = ['type', 'showAge', 'commonPb', 'sigdig', 'anchor', 'anchorAge',
                   'discFilter', 'discOpt', 'discCutoff', 'tlim', 'xlim', 'ylim',
                   'ticks', 'exterr', 'shownumbers', 'fill', 'fillAlpha', 'stroke'];

  /* ------------------------------------------------------------------
   *  纯函数（可在 node 里单测，不碰网络）
   * ------------------------------------------------------------------ */

  /** 数值化：空串 / null / 非数字一律 NaN（注意 +'' 是 0，不能直接用 +）。 */
  function numOr(v) {
    if (v === '' || v === null || v === undefined) return NaN;
    var n = typeof v === 'number' ? v : Number(v);
    return isFinite(n) ? n : NaN;
  }

  /**
   * 送进 CSV 的有效数字位数。
   *
   * ⚠ 这个常数是**判据的一部分**，不能只当成"打印格式"。
   * 踩过的坑（2026-10-02，实测）：年龄表里 AY-4 有两个点的
   *     ρ = 0.99999999999999889 / 0.99999999999999933
   * 过滤时按**原始值**判 `|ρ| < 1` ⇒ 放行；写文件时按 10 位有效数字
   * 截成字符串 ⇒ "1.000000000" ⇒ R 拿到的相关系数**精确等于 1**
   * ⇒ 协方差矩阵退化 ⇒ concordia(show.age=1) 报
   *     L-BFGS-B needs finite values of 'fn'
   * 而且 badRho 计数是 0，界面上一点提示都没有。
   * 结论：**判据必须作用在真正交出去的那个数上**，所以这里先舍入、
   * 再用舍入后的值判、最后把同一个字符串写出去（三处同一个数）。
   */
  var SIGDIG = 10;

  /** 一个数"写进 CSV 时会变成什么"（数），供判据使用。 */
  function asWritten(v) {
    var n = numOr(v);
    return isFinite(n) ? Number(n.toPrecision(SIGDIG)) : NaN;
  }

  /**
   * 按样品统计点数。
   *
   * 返回 [{ name, rows, usable }]：
   *   rows   —— 该样品在年龄表里占几行
   *   usable —— 其中有多少行能进 IsoplotR 的表
   *             （三比值都有限、sX/sY > 0、且**写出去之后**的 |ρ| < 1）
   * 两个数分开报，是因为"这个样品有 15 行"与"这个样品能拟合 14 点"是两件事，
   * 界面上要显示的是后者 —— 否则用户会对着一个点不动的按钮猜为什么。
   */
  function sampleNames(rows) {
    var seen = {}, order = [];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (!r) continue;
      var nm = String(r[COL.name] === undefined ? '' : r[COL.name]).trim();
      if (!nm) continue;
      if (!seen[nm]) { seen[nm] = { name: nm, rows: 0, usable: 0 }; order.push(nm); }
      seen[nm].rows++;
      if (rowUsable(r).ok) seen[nm].usable++;
    }
    return order.map(function (k) { return seen[k]; });
  }

  /**
   * 一行够不够格进表。返回 { ok, why, cells }，why 只用于统计口径。
   *
   * `cells` 是**实际要写出去的 5 个字符串**，由本函数一次算定 ——
   * 这样"判它合不合法"与"写出去的是什么"就是同一个数，不可能再错位。
   */
  function rowUsable(r) {
    var X = asWritten(r[COL.X]), sX = asWritten(r[COL.sX]);
    var Y = asWritten(r[COL.Y]), sY = asWritten(r[COL.sY]);
    var rho = asWritten(r[COL.rho]);
    if (!(isFinite(X) && isFinite(sX) && isFinite(Y) && isFinite(sY))) {
      return { ok: false, why: 'missing' };
    }
    if (!isFinite(rho)) return { ok: false, why: 'norho' };
    //  |ρ| ≥ 1 的协方差矩阵不是正定的，IsoplotR 建椭圆时会炸。
    //  宁可在这里剔掉并**如实报数**，也不要送给它一个非法矩阵。
    //  注意 rho 已经过 asWritten：判的就是"写出去之后"的值（见 SIGDIG 那段）。
    if (Math.abs(rho) >= 1) return { ok: false, why: 'badrho' };
    if (sX <= 0 || sY <= 0) return { ok: false, why: 'badsigma' };
    return { ok: true, why: '',
             cells: [X, sX, Y, sY, rho].map(function (v) {
               return v.toPrecision(SIGDIG);
             }) };
  }

  /**
   * 从配置里取「标样名」集合。
   *
   * 为什么必须把标样单独拎出来（2026-10-02 用户指出）：这批数据是**一个文件
   * 一个测点** —— 32 个样品各 1 点，而标样 AY-4 有 15 个文件、SRM 612 有 2 个。
   * 只按 `r[COL.name]` 分组的话，AY-4 会被当成"点最多的那个样品"排到最前面，
   * 于是最自然的操作（选第一个）恰好是拿**标样**去拟合谐和年龄 ——
   * 而标样是用来检验本批再现性的 QC 样（要跟②里填的真值比），
   * 不是待测样品的年龄。谐和图该看的是**样品**（这里是 32 个点）。
   *
   * 真源是 cfg（②里填的那些），不猜名字：识别不出来就返回空数组，
   * 界面照旧全部列出来 —— 宁可不错分，也不要按名字模式去猜。
   *
   * 读的字段：stdName（U-Pb 分馏标样）、nistStd（微量元素外标）、
   *           fracStd（分馏校正用的标样，通常与 stdName 同一个）。
   */
  function standardNames(cfg) {
    cfg = cfg || {};
    var out = [], seen = {};
    [cfg.stdName, cfg.nistStd, cfg.fracStd].forEach(function (v) {
      var s = (v === undefined || v === null) ? '' : String(v).trim();
      if (!s || seen[s]) return;
      seen[s] = 1;
      out.push(s);
    });
    return out;
  }

  /**
   * 把年龄表的行转成 IsoplotR 的 format=1 表。
   *
   * opts: { sample: '*' | 样品名, drop: [要排除的样品名] }
   * 返回 { lines, n, skipped, badRho, dropped, rhoFiles, sample, header, headerSpec }
   *   lines[0] 是表头，其余每行 5 个数（X, errX, Y, errY, rho）
   *   dropped  —— 因在 drop 名单里而被排除的行数（界面用来报"另有 N 行是标样"）。
   *               `drop` **只在合并选（sample='*'）时生效**：用户明确点名要看
   *               某个标样时当然要照画，不能因为他同时被列在 drop 里就画不出来。
   *   rhoFiles —— 因 ρ 写出即 ±1 而被剔掉的那几行的**文件名**。
   *   光有计数不够用：用户看到"剔了 2 行"第一反应是"哪两行、要不要紧"，
   *   而他能拿来核对的就是文件名。
   */
  function buildTable(rows, opts) {
    opts = opts || {};
    var want = (opts.sample === undefined || opts.sample === null
      || opts.sample === '' || opts.sample === '*') ? null : String(opts.sample).trim();
    var drop = {};
    if (want === null && opts.drop) {
      for (var d = 0; d < opts.drop.length; d++) {
        var dn = String(opts.drop[d] === undefined ? '' : opts.drop[d]).trim();
        if (dn) drop[dn] = 1;
      }
    }
    var lines = [HEADER];
    var n = 0, skipped = 0, badRho = 0, others = 0, dropped = 0, rhoFiles = [];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (!r) continue;
      var nm = String(r[COL.name] === undefined ? '' : r[COL.name]).trim();
      if (want !== null && nm !== want) {
        others++;
        continue;
      }
      if (drop[nm]) { dropped++; continue; }
      var u = rowUsable(r);
      if (!u.ok) {
        if (u.why === 'badrho') {
          badRho++;
          rhoFiles.push(String(r[COL.file] === undefined ? '' : r[COL.file]));
        } else skipped++;
        continue;
      }
      //  cells 是 rowUsable 算定的、且已经过合法性判定的那 5 个字符串。
      //  这里**直接用它**，不再自己 toPrecision 一遍 —— 两份格式化就是两份
      //  可能对不上的数（这正是 SIGDIG 那段记的坑）。
      lines.push(u.cells.join(','));
      if (u.why === '') n++;
    }
    return { lines: lines, n: n, skipped: skipped, badRho: badRho, dropped: dropped,
             rhoFiles: rhoFiles, others: others, sample: want === null ? '*' : want,
             header: HEADER, headerSpec: HEADER_SPEC };
  }

  /** 一个 R 字符串字面量（CSV 行只含数字与逗号，转义只是保险）。 */
  function rStr(s) {
    return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  }

  /** 虚拟文件系统里的路径要挡一下，免得把内容拼进 R 代码里。 */
  function safePath(p) {
    if (!/^[A-Za-z0-9_\/.\-]+$/.test(String(p))) {
      throw new Error('路径含非法字符：' + p);
    }
    return String(p);
  }

  /**
   * 把界面上的选项整理成 R 调用的实参表（形如 ['type=1', 'show.age=2', ...]）。
   *
   * **这是整个模块里唯一允许"拼出 R 代码"的地方**（见文件头 ⑭），所以每一条都
   * 只由已经过校验的东西拼出来：数字、受控布尔、正则校验过的十六进制颜色。
   * 界面上来的任意字符串绝不直接进 R —— 那等于把用户输入当代码执行。
   *
   * 另一条同样重要的规矩：**没填就不生成这个参数**。留空必须是"用 IsoplotR
   * 自己的默认值"，而不是我们另编一个 —— 否则用户没动过的项也被我们改掉了，
   * 行为就不再与"没有这个面板"时逐位相同。
   */
  function rArgs(a) {
    /** 数值化；空 / 空白 / 非数字一律 null（null 的含义是"这一项没填"）。 */
    function n1(v) {
      if (v === null || v === undefined || String(v).trim() === '') return null;
      var n = Number(String(v).trim());
      return isFinite(n) ? n : null;
    }
    /**
     * 有默认值的那几项：**留空 = 用默认值**，但填了非数字就是调用方的错，
     * 要吵出来（NaN）。这两个含义必须分开 —— 混成一个就会踩到"界面上那格
     * 留空，于是空串被当成非数字、整张图报'作图参数不是数字'"（实测撞过：
     * sigdig 那格默认是空的）。
     */
    function numd(v, dflt) {
      if (v === null || v === undefined || String(v).trim() === '') return dflt;
      var n = Number(String(v).trim());
      return isFinite(n) ? n : NaN;
    }
    /** "a,b,c" → [a,b,c]；want>=0 时个数必须正好是 want，否则当作没填。 */
    function nList(v, want) {
      if (v === null || v === undefined || String(v).trim() === '') return null;
      var p = String(v).split(','), out = [];
      if (want >= 0 && p.length !== want) return null;
      for (var i = 0; i < p.length; i++) {
        var n = n1(p[i]);
        if (n === null) return null;
        out.push(n);
      }
      return out.length ? out : null;
    }
    /** 只认 #RRGGBB（#RRGGBBAA 不接受，透明度走单独的输入框）。 */
    function hx(v) {
      return /^#[0-9a-fA-F]{6}$/.test(String(v)) ? String(v).toUpperCase() : null;
    }
    function tf(v) { return v === true || v === 1 || v === '1' || v === 'true'; }

    var ty = numd(a.type, 1);
    var sa = numd(a.showAge, 0);
    var cp = numd(a.commonPb, 0);
    //  作图的 sigdig 默认 3（IsoplotR 自己的默认是 2，这里保持本软件既有行为，
    //  界面上那格写明了"原版默认 2"）。别拿文件头的 SIGDIG 当它 ——
    //  那个 SIGDIG 是 ρ 的 10 位有效数字，两码事（见文件头 ⑫）。
    var sd = numd(a.sigdig, 3);
    [ty, sa, cp, sd].forEach(function (v) {
      if (!isFinite(v)) throw new Error('作图参数不是数字');
    });
    var out = ['type=' + ty, 'show.age=' + sa, 'common.Pb=' + cp, 'sigdig=' + sd];

    //  anchor：只有 discordia（show.age≥2）用得上，原版 GUI 也是只在那一档显示。
    var an = n1(a.anchor) || 0;
    if (an > 0 && sa >= 2) {
      var aAge = n1(a.anchorAge);
      if (an === 2) {
        if (aAge !== null) out.push('anchor=c(2,' + aAge + ')');
      } else {
        out.push('anchor=' + an);
      }
    }

    //  cutoff.disc = discfilter(option=, before=, cutoff=) —— 与 GUI 里的写法一致。
    //  cutoff 留空就整个不传，用 R 里那套按 option 分的默认上下限。
    var df = n1(a.discFilter) || 0;
    if (df > 0) {
      var opt = n1(a.discOpt);
      if (opt === null) opt = 1;
      //  判据只认 DISCOPT 里那 5 档。这一条防的是"调用方把参数接错了"，所以
      //  要**吵**出来而不是悄悄退回某一档 —— 悄悄退回会让人以为过滤生效了。
      if (!DISCOPT.some(function (o) { return o.v === opt; })) {
        throw new Error('不谐和度判据只能是 1~5，收到 ' + opt);
      }
      var dv = ['option=' + opt, 'before=' + (df === 1 ? 'TRUE' : 'FALSE')];
      var dcut = nList(a.discCutoff, 2);
      if (dcut) dv.push('cutoff=c(' + dcut[0] + ',' + dcut[1] + ')');
      out.push('cutoff.disc=discfilter(' + dv.join(',') + ')');
    }

    //  坐标范围：都是 [min,max] 两个数，格式不对就当作没填（不许半截参数进 R）。
    [['tlim', a.tlim], ['xlim', a.xlim], ['ylim', a.ylim]].forEach(function (p) {
      var v = nList(p[1], 2);
      if (v) out.push(p[0] + '=c(' + v[0] + ',' + v[1] + ')');
    });

    //  ticks：一个数 = 刻度条数；一串数 = 指定这些年龄上放刻度（原版两种都收）。
    var tk = nList(a.ticks, -1);
    if (tk) out.push(tk.length === 1 ? 'ticks=' + tk[0] : 'ticks=c(' + tk.join(',') + ')');

    if (tf(a.exterr)) out.push('exterr=TRUE');
    if (tf(a.shownumbers)) out.push('shownumbers=TRUE');

    //  椭圆样式。填色写成 8 位十六进制 #RRGGBBAA；透明度没填时用原版自己那套
    //  默认的 0.5（它的默认填色就是 #00FF0080 / #FF000080，末两位正是 80）。
    var fc = hx(a.fill);
    if (fc) {
      var al = n1(a.fillAlpha);
      if (al === null) al = 0.5;
      if (al < 0) al = 0; else if (al > 1) al = 1;
      var aa = Math.round(al * 255).toString(16).toUpperCase();
      if (aa.length < 2) aa = '0' + aa;
      out.push('ellipse.fill="' + fc + aa + '"');
    }
    var sc = hx(a.stroke);
    if (sc) out.push('ellipse.stroke="' + sc + '"');
    return out;
  }

  /**
   * 生成 R 代码。这是**唯一**一处与 IsoplotR 打交道的地方，所以口径全写在这里：
   *   format=1 + ierr=2 + header=TRUE  ← 见文件头 ①②
   *   实参表由 rArgs() 生成，没填的项不出现 ← 见文件头 ⑭
   *   整段包在 tryCatch 里，失败退回 show.age=0 并带回原文 ← 见文件头 ⑥
   *   结果摘成 key=value 纯文本，界面自己解析，不依赖 R 对象序列化
   */
  function rCode(a) {
    var csv = safePath(a.csv), svg = safePath(a.svg);
    var w = a.w || 7, h = a.h || 6, ps = a.ps || 11;

    //  这些值会原样进 R 代码，所以必须是纯数字
    [w, h, ps].forEach(function (v) {
      if (!isFinite(v)) throw new Error('作图参数不是数字');
    });

    var A = rArgs(a);
    var args = A.join(', ');
    //  退回"只画点"时，把实参表里的 show.age 换成 0，其余原样保留。
    var args0 = A.map(function (p) {
      return p.indexOf('show.age=') === 0 ? 'show.age=0' : p;
    }).join(', ');
    //  退回的分支要不要执行，看的就是实参表里那个 show.age —— 不另算一遍。
    var sa = 0;
    A.forEach(function (p) {
      if (p.indexOf('show.age=') === 0) sa = Number(p.slice('show.age='.length));
    });

    var L = [];
    L.push('suppressPackageStartupMessages(library(' + PKG + '))');
    L.push('d <- read.data(' + rStr(csv) + ', method="U-Pb", format=1, ierr=2, header=TRUE)');
    //  ⚠ 这个函数定义**必须写在一行里**。拆成两行会踩 R 的经典坑：
    //    `f1 <- function(x) if (cond) "NA"` 本身就已经是**完整的语句**，
    //    下一行开头的 `else` 于是变成"没有 if 的 else" ——
    //    报错长这样：`Error in parse(text = expr): :4:3: unexpected 'else'`，
    //    而且整段脚本**一行都不会执行**（连图都不出）。实测撞过。
    L.push('f1 <- function(x) if (length(x) != 1 || !is.finite(x)) "NA" else '
      + 'format(signif(x, 8), scientific = FALSE, trim = TRUE)');
    L.push('kv <- c(paste0("n=", nrow(d$x)))');
    L.push('msg <- ""');
    L.push('o <- NULL');
    L.push('svg(' + rStr(svg) + ', width=' + w + ', height=' + h + ', pointsize=' + ps + ')');
    L.push('o <- tryCatch(concordia(d, ' + args + '),');
    L.push('              error = function(e) { msg <<- conditionMessage(e); NULL })');
    L.push('dev.off()');
    //  失败也要给一张图：退回只画点（show.age=0）。不能把面板留空。
    L.push('if (is.null(o) && ' + sa + ' > 0) {');
    L.push('  msg <- paste0("拟合失败，已退回只画点：", msg)');
    L.push('  svg(' + rStr(svg) + ', width=' + w + ', height=' + h + ', pointsize=' + ps + ')');
    L.push('  try(concordia(d, ' + args0 + '), silent = TRUE)');
    L.push('  dev.off()');
    L.push('}');
    //  错误原文里可能有换行 —— [[:space:]] 不需要反斜杠转义，比 [\r\n] 稳
    L.push('kv <- c(kv, paste0("error=", gsub("[[:space:]]+", " ", msg)))');
    L.push('if (!is.null(o)) {');
    L.push('  if (!is.null(o$par)) for (k in names(o$par)) {');
    L.push('    kv <- c(kv, paste0("par:", k, "=", f1(o$par[[k]])))');
    L.push('    if (!is.null(o$err) && k %in% colnames(o$err)) {');
    L.push('      if ("s"    %in% rownames(o$err)) kv <- c(kv, paste0("s:",    k, "=", f1(o$err["s",    k])))');
    L.push('      if ("disp" %in% rownames(o$err)) kv <- c(kv, paste0("disp:", k, "=", f1(o$err["disp", k])))');
    L.push('    }');
    L.push('  }');
    L.push('  if (!is.null(o$age))     for (k in names(o$age))     kv <- c(kv, paste0("age:", k, "=", f1(o$age[[k]])))');
    //  ⚠ mswd / p.value / df 的形态**随 show.age 变**：
    //    show.age=1 → 是有名字的向量（equivalence / concordance / combined）
    //    show.age≥2 → 是**标量**（names() 是 NULL）
    //  最初只写了 `for (k in names(...))`，于是 show.age≥2 时这三个数一个都取不回来：
    //  discordia 的交点年龄出来了，MSWD 却是空的 —— 而 MSWD 恰恰是判断
    //  "点是不是真在一条线上"的唯一依据（实测：全部 43 点 t[l]=161.83 Ma，
    //  但 MSWD 有多大看不到）。所以下面按"长度是不是 1"分两路走：
    //  标量出 `mswd=`，向量出 `mswd:combined=`。
    L.push('  putv <- function(pre, v) {');
    L.push('    if (is.null(v)) return(invisible(NULL))');
    L.push('    if (length(v) == 1) return(kv <<- c(kv, paste0(pre, "=", f1(v))))');
    L.push('    for (k in names(v)) kv <<- c(kv, paste0(pre, ":", k, "=", f1(v[[k]])))');
    L.push('  }');
    L.push('  putv("mswd", o$mswd)');
    L.push('  putv("p", o$p.value)');
    L.push('  putv("df", o$df)');
    L.push('  if (!is.null(o$model))   kv <- c(kv, paste0("model=", f1(o$model)))');
    L.push('}');
    L.push('paste(kv, collapse="\\n")');
    return L.join('\n');
  }

  /**
   * 解析 R 回来的 key=value 文本。
   * 键形如 n / error / model / par:t[l] / s:t[l] / disp:t[l] / age:t /
   * age:s[t] / mswd:combined / p:combined / df:combined。
   * NA 与空串都变成 NaN —— 界面靠 isFinite 判断"这项有没有"。
   */
  function parseResult(text) {
    var out = { n: NaN, error: '', model: NaN,
                par: {}, s: {}, disp: {}, age: {}, mswd: {}, p: {}, df: {} };
    var lines = String(text === null || text === undefined ? '' : text).split('\n');
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i];
      if (!ln) continue;
      var eq = ln.indexOf('=');
      if (eq < 0) continue;
      var k = ln.slice(0, eq), v = ln.slice(eq + 1);
      var col = k.indexOf(':');
      if (col < 0) {
        if (k === 'error') { out.error = v === 'NA' ? '' : v; }
        else {
          var nv = (v === 'NA' || v === '') ? NaN : Number(v);
          if (k in out && typeof out[k] === 'number') out[k] = nv;
          else out[k] = nv;
        }
        continue;
      }
      var bucket = k.slice(0, col), name = k.slice(col + 1);
      if (!out[bucket] || typeof out[bucket] !== 'object') out[bucket] = {};
      out[bucket][name] = (v === 'NA' || v === '') ? NaN : Number(v);
    }
    return out;
  }

  /** 95% 置信区间的倍数。IsoplotR 的 oerr=3 用的就是正态 0.975 分位。 */
  var Z95 = 1.959964;

  function fnum(v, d) {
    if (!isFinite(v)) return '—';
    var a = Math.abs(v);
    if (a === 0) return '0';
    if (a >= 1e5 || a < 1e-4) return v.toExponential(3);
    return v.toFixed(d === undefined ? (a < 1 ? 3 : (a < 100 ? 2 : 1)) : d);
  }

  /**
   * 把解析结果整理成界面要显示的几行。
   *
   * 口径（这里最容易出错，所以每一行都带着自己的口径字样）：
   *   · 图上印的数 —— concordia() 默认 oerr=3，是 **95% 置信区间**（1.96σ）
   *   · $err["s",] / $age["s[t]"] —— **1σ** 标准误
   *   · $err["disp",] / $age["disp[t]"] —— 1σ 再乘 √MSWD（过离散修正后）
   *   · Isoclock 年龄表里的 2s 是 **2σ**，所以与这里的 1σ 差 2 倍，别直接比
   */
  function summarise(res, opts) {
    opts = opts || {};
    var ty = Number(opts.type || 1), sa = Number(opts.showAge === undefined ? 0 : opts.showAge);
    var rows = [], notes = [];

    rows.push({ k: '数据点数', v: isFinite(res.n) ? String(res.n) : '—',
                note: '交给 IsoplotR 的行数' });

    if (sa === 1) {
      var t = res.age.t, s = res.age['s[t]'], dp = res.age['disp[t]'];
      if (isFinite(t)) {
        rows.push({ k: '谐和年龄', v: fnum(t, 2) + ' Ma' });
        rows.push({ k: '　1σ', v: isFinite(s) ? '± ' + fnum(s) + ' Ma' : '—',
                    note: 'o$age["s[t]"]' });
        rows.push({ k: '　过离散修正后 1σ', v: isFinite(dp) ? '± ' + fnum(dp) + ' Ma' : '—',
                    note: '1σ × √MSWD' });
        rows.push({ k: '　95% 置信区间', v: isFinite(s) ? '± ' + fnum(s * Z95) + ' Ma' : '—',
                    note: '≈1.96σ —— 图上印的就是这个' });
      }
      var ms = ['equivalence', 'concordance', 'combined'];
      var zh = { equivalence: '等价', concordance: '谐和', combined: '合并' };
      ms.forEach(function (k) {
        if (isFinite(res.mswd[k])) {
          rows.push({ k: '　MSWD（' + zh[k] + '）', v: fnum(res.mswd[k], 3) });
        }
      });
      ms.forEach(function (k) {
        if (isFinite(res.p[k])) {
          rows.push({ k: '　p 值（' + zh[k] + '）', v: fnum(res.p[k], 3) });
        }
      });
      ms.forEach(function (k) {
        if (isFinite(res.df[k])) {
          rows.push({ k: '　自由度（' + zh[k] + '）', v: String(res.df[k]) });
        }
      });
      notes.push('谐和年龄把数据当作一组**谐和**点来拟合；若数据真丢了铅，'
        + '这个年龄会被拉偏，那时才该看 discordia 交点。');
    } else if (sa >= 2) {
      var keys = Object.keys(res.par);
      keys.forEach(function (k) {
        if (!isFinite(res.par[k])) return;
        var label = k;
        if (k === 't[l]') label = ty === 1 ? '下交点年龄' : '下交点年龄';
        else if (k === 't[u]') label = '上交点年龄';
        else if (k === 't') label = (ty === 2 ? '下交点年龄' : '交点年龄');
        else if (k === 'a0') label = '²⁰⁷Pb/²⁰⁶Pb 截距';
        else if (k === 'b0') label = '²⁰⁶Pb/²⁰⁴Pb 截距';
        else if (k === 'w') label = '过离散项 w';
        var isAge = (k === 't' || k === 't[l]' || k === 't[u]');
        //  年龄的位数分档：<1000 Ma 给到 0.01 Ma（交点年龄的有效位本来就在这个量级），
        //  ≥1000 Ma 给到 0.1 Ma。统一 toFixed(3) 会印出 "5213.916 Ma" 这种假精度。
        var vd = isAge ? (Math.abs(res.par[k]) >= 1000 ? 1 : 2) : 3;
        rows.push({ k: label, v: fnum(res.par[k], vd) + (isAge ? ' Ma' : '') });
        if (isFinite(res.s[k])) {
          rows.push({ k: '　1σ', v: '± ' + fnum(res.s[k], 3) + (isAge ? ' Ma' : ''),
                      note: 'o$err["s",]' });
        }
        if (isFinite(res.s[k])) {
          rows.push({ k: '　95% 置信区间', v: '± ' + fnum(res.s[k] * Z95, 3) + (isAge ? ' Ma' : ''),
                      note: '图上印的是这个' });
        }
      });
      if (isFinite(res.mswd.combined)) {
        rows.push({ k: 'MSWD', v: fnum(res.mswd.combined, 3) });
      } else if (isFinite(res.mswd)) {
        rows.push({ k: 'MSWD', v: fnum(res.mswd, 3) });
      }
      if (isFinite(res.p.combined)) rows.push({ k: 'p 值', v: fnum(res.p.combined, 3) });
      else if (isFinite(res.p)) rows.push({ k: 'p 值', v: fnum(res.p, 3) });
      if (isFinite(res.df.combined)) rows.push({ k: '自由度', v: String(res.df.combined) });
      else if (isFinite(res.df)) rows.push({ k: '自由度', v: String(res.df) });
      notes.push('交点年龄假设数据沿一条割线分布（铅丢失/普通铅两端混合）。'
        + '**混了不同样品的整批数据不要看这个数** —— 它只是几何外推。');
      notes.push('MSWD 明显大于 1（或 p 值远小于 0.05）说明点不在一条线上，'
        + '交点年龄不可信；这时改用 show.age=4（含过离散项）看它会宽多少。');
    }

    if (res.error) notes.push('IsoplotR 报错：' + res.error);
    if (isFinite(res.n) && res.n < 3 && sa >= 2) {
      notes.push('只有 ' + res.n + ' 个点，discordia 拟合在几何上就不成立。');
    }
    return { rows: rows, notes: notes, ok: !res.error && !(isNaN(res.n)) };
  }

  /** SVG 文本 → data URI（用 <img> 隔离，避免两张图的内联 id 撞车）。 */
  function svgDataUri(svg) {
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(String(svg));
  }

  /* ------------------------------------------------------------------
   *  加载与作图（要联网，不放进单测）
   * ------------------------------------------------------------------ */

  var st = { webR: null, loading: null, ready: false, isoplotr: '', rver: '', t0: 0 };

  function now() { return (window.performance || Date).now(); }

  function elapsed() { return st.t0 ? ((now() - st.t0) / 1000).toFixed(1) + ' s' : ''; }

  /**
   * 把 R 的字符串向量写进虚拟文件系统。
   * R 只认 c("a","b")，不认 JSON 数组 —— 这个坑踩过一次（unexpected '['）。
   */
  function putLines(webR, path, lines) {
    var rvec = 'c(' + lines.map(function (l) { return rStr(l); }).join(', ') + ')';
    return webR.evalRVoid('writeLines(' + rvec + ', ' + rStr(safePath(path)) + ')');
  }

  /**
   * 按需加载 webR + IsoplotR。同一个页面只加载一次（后续调用复用同一个 Promise）。
   * onProgress(text) 会被反复调用，文本里带耗时，方便界面显示"到底卡在哪一步"。
   */
  function load(onProgress) {
    var say = function (s) { if (onProgress) onProgress(s); };
    if (st.ready) return Promise.resolve(st.result);
    if (st.loading) return st.loading;
    st.t0 = now();

    st.loading = Promise.resolve().then(function () {
      say('正在从 CDN 取 webR 运行时（' + WEBR_ENTRY + '）…');
      //  动态 import：不点这个按钮，浏览器就不会下载它的任何一个字节。
      //  入口必须是 CDN 的 webr.mjs（就是 npm 里的 webr.js 那份浏览器构建），
      //  细节见文件头的 ⑧。
      return import(/* webpackIgnore: true */ WEBR_ENTRY);
    }).then(function (mod) {
      if (!mod || typeof mod.WebR !== 'function') {
        throw new Error('CDN 回来的模块里没有 WebR —— 入口可能被换成了打包器用的那份 webr.mjs');
      }
      say('webR 模块已到（' + elapsed() + '），正在初始化 R 运行时'
        + '（首次要下载约 12 MB 的 R.wasm，耐心等）…');
      st.webR = new mod.WebR();
      return st.webR.init();
    }).then(function () {
      return st.webR.evalRString('R.version.string');
    }).then(function (v) {
      st.rver = String(v).replace('R version ', '').replace(/\s*\(.*\)\s*$/, '');
      say('R ' + st.rver + ' 已就绪（' + elapsed() + '），正在安装 ' + PKG
        + ' 包（约 0.7 MB）…');
      return st.webR.installPackages([PKG]);
    }).then(function () {
      //  installPackages 只装不挂 —— 不 library() 的话后面每一个函数都报
      //  "could not find function"（踩过：整页只剩这一条报错）。
      return st.webR.evalRVoid('suppressPackageStartupMessages(library(' + PKG + '))');
    }).then(function () {
      return st.webR.evalRString('as.character(packageVersion("' + PKG + '"))');
    }).then(function (v) {
      st.isoplotr = String(v).trim();
      st.ready = true;
      st.result = { r: st.rver, isoplotr: st.isoplotr, seconds: (now() - st.t0) / 1000 };
      say('IsoplotR ' + st.isoplotr + ' 已就绪（总耗时 ' + elapsed()
        + '）。之后的作图会在浏览器缓存里，快得多。');
      return st.result;
    }).catch(function (e) {
      st.loading = null;                  // 允许重试
      throw e;
    });
    return st.loading;
  }

  /**
   * 出一张图。会先确保运行时已加载。
   * 返回 { svg, raw, result, summary, seconds, args }
   *   args 是这一次真正传进 R 的实参表 —— 界面上原样列出来，好留痕/复现。
   */
  function render(table, opts, onProgress) {
    opts = opts || {};
    var say = function (s) { if (onProgress) onProgress(s); };
    var argsList = [];              // 这一次真正传进 R 的实参表，回给界面做留痕
    return load(onProgress).then(function () {
      say('正在作图（' + table.n + ' 个点，' + AGES.filter(function (a) {
        return a.v === Number(opts.showAge || 0);
      }).map(function (a) { return a.label; })[0] + '）…');
      var stamp = 'iso' + Date.now();
      var csv = '/tmp/' + stamp + '.csv';
      var svg = '/tmp/' + stamp + '.svg';
      return putLines(st.webR, csv, table.lines).then(function () {
        var t = now();
        //  选项原样透传：传进来的 key 就是 rArgs() 认的那些，**不再一处一处抄**。
        //  抄一份就一定会漏一项，而漏掉的那项照样能出图，最难发现。
        var ra = { csv: csv, svg: svg };
        RARG_KEYS.forEach(function (k) {
          if (opts[k] !== undefined && opts[k] !== null) ra[k] = opts[k];
        });
        argsList = rArgs(ra);
        return st.webR.evalRString(rCode(ra))
          .then(function (raw) { return { raw: raw, ms: now() - t }; });
      }).then(function (o) {
        return st.webR.FS.readFile(svg).then(function (buf) {
          //  ⚠ 浏览器里 FS.readFile 回来的是 Uint8Array，不是字符串（踩过：
          //     下一步 svg.match is not a function）
          var text = (typeof buf === 'string') ? buf : new TextDecoder().decode(buf);
          var result = parseResult(o.raw);
          var summary = summarise(result, { type: opts.type, showAge: opts.showAge });
          say('图已出（' + (o.ms / 1000).toFixed(1) + ' s，' + Math.round(text.length / 1024) + ' KB）'
            + (result.error ? ' —— 但拟合失败了，见下方说明' : ''));
          return { svg: text, raw: o.raw, result: result, summary: summary,
                   seconds: o.ms / 1000, args: argsList };
        });
      });
    });
  }

  var API = {
    CDN: CDN, WEBR_ENTRY: WEBR_ENTRY, PKG: PKG,
    COL: COL, HEADER: HEADER, HEADER_SPEC: HEADER_SPEC, SIGDIG: SIGDIG,
    TYPES: TYPES, AGES: AGES, CPB: CPB, Z95: Z95,
    ANCHORS: ANCHORS, DISCFILTERS: DISCFILTERS, DISCOPT: DISCOPT,
    DISC_DEFAULT: DISC_DEFAULT, RARG_KEYS: RARG_KEYS,
    numOr: numOr, asWritten: asWritten, rowUsable: rowUsable, sampleNames: sampleNames,
    standardNames: standardNames,
    buildTable: buildTable, rArgs: rArgs, rCode: rCode, parseResult: parseResult,
    summarise: summarise, svgDataUri: svgDataUri, fnum: fnum, rStr: rStr,
    load: load, render: render,
    isReady: function () { return st.ready; },
    runtime: function () { return st.ready ? st.result : null; },
    _state: st
  };

  if (typeof window !== 'undefined') window.DS_ISOPLOTR = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();
