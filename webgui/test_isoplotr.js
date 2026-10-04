/* ==========================================================================
 *  test_isoplotr.js —— IsoplotR 接入层的单测
 *
 *  这一套**不联网、不起浏览器**：验的是"我们送给 IsoplotR 的东西对不对、
 *  它回来的东西我们读得对不对"。真正跑 R 的那部分在浏览器里验
 *  （见 ui/selftest.js 的接线断言与 G:/_isohtml/isoplotr/ 下的探针记录）。
 *
 *  判据的来源分两类，分得很清楚：
 *
 *   ① 有**外部真值**的，一律拿真值比，不拿自己比：
 *      · format=1 的列定义来自 IsoplotR 的 ?read.data 文档原文
 *        （"X=07/35, err[X], Y=06/38, err[Y] (, rho[X,Y])"）——
 *        这里把它硬编码成本文件里的 EXPECT_SPEC，与模块里的 HEADER 顺序对照。
 *      · 列号 36/37/38/39/40/33/34 来自 src/age.js 的 row 数组，并且用
 *        **内置的 49 个真实样品跑完整管线**回过头核了一遍（下面 §G）：
 *        n=49 行的比值全部可用（窗口识别修正后不再有 NaN 行），
 *        只有 2 行因 ρ 写成 ±1 被剔 —— 那 2 行都属于标样 AY-4。
 *      · 95% 置信区间 = 1.96σ，来自实测：AY-4 的 $age["s[t]"]=0.645，
 *        而图（oerr=3 默认）上印的是 1.26 → 1.26/0.645 = 1.953。
 *
 *   ② 没有外部真值的（比如"空串不能当 0"），写成**能失败的反例**：
 *      故意构造会让错误实现通过、正确实现不通过的那一行。
 *
 *  用法:  node webgui/test_isoplotr.js
 * ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HERE = __dirname;
const SRC = path.join(HERE, 'src');
const UI = path.join(HERE, 'ui');

let pass = 0, fail = 0;
const failures = [];
function t(name, ok, detail) {
  if (ok) pass++; else { fail++; failures.push(name); }
  console.log((ok ? '  ok  ' : ' FAIL ') + name.padEnd(58) + (detail || ''));
}
function near(a, b, tol) {
  if (!isFinite(a) || !isFinite(b)) return false;
  return Math.abs(a - b) <= tol;
}
function bad(name, detail) { t(name, false, detail); }

/* ---------- 加载模块 ----------
 * isoplotr.js 是 ui/ 下的模块（与 report.js/selftest.js/app.js 同类），
 * 但它不碰 document，所以能直接在 vm 里跑。它末尾会被 build_ui.py 内联进
 * 一个 <script>，顶层没有声明会与 src/ 下的模块撞名（都有 DS_ / 前缀或
 * 包在 IIFE 里），这里单独一个沙箱只是为了让它拿到 window。 */
const sandbox = {
  window: {}, console,
  DecompressionStream, Response, Blob, atob, btoa,
  Uint8Array, ArrayBuffer, TextDecoder, TextEncoder, Promise, fetch,
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(UI, 'isoplotr.js'), 'utf8'), sandbox,
  { filename: 'isoplotr.js' });

const ISO = sandbox.window.DS_ISOPLOTR;

console.log('IsoplotR 接入层：表构造 / R 代码 / 结果解析 / 口径');

if (!ISO) {
  bad('ui/isoplotr.js 导出了 window.DS_ISOPLOTR', '没找到');
  console.log(`总计 ${pass + fail} 项：通过 ${pass}，失败 ${fail}`);
  process.exit(1);
}
t('ui/isoplotr.js 导出了 window.DS_ISOPLOTR', true, Object.keys(ISO).length + ' 个导出');

/* ======================================================================
 *  §A 列号与表头 —— 与 IsoplotR 的 format=1 逐字对照
 * ==================================================================== */

//  IsoplotR ?read.data 原文（method='U-Pb' 的 format=1 一条），照录。
const EXPECT_SPEC = 'X=07/35, err[X], Y=06/38, err[Y] (, rho[X,Y])';
t('HEADER_SPEC 与 ?read.data 的 format=1 原文一致',
  ISO.HEADER_SPEC === EXPECT_SPEC, ISO.HEADER_SPEC);

const hdr = ISO.HEADER.split(',');
t('HEADER 是 5 列，顺序 = X, errX, Y, errY, rho',
  hdr.length === 5 && /07|235/i.test(hdr[0]) && /err/i.test(hdr[1])
  && /238/i.test(hdr[2]) && /err/i.test(hdr[3]) && /rho/i.test(hdr[4]),
  hdr.join(' | '));

//  age.js 的行布局（0 基）：[33]207Pb/206Pb [34]2s [36]207Pb/235U [37]2s
//                            [38]206Pb/238U [39]2s [40]rho
t('COL 的列号 = age.js 的行布局',
  ISO.COL.X === 36 && ISO.COL.sX === 37 && ISO.COL.Y === 38 && ISO.COL.sY === 39
  && ISO.COL.rho === 40 && ISO.COL.Z === 33 && ISO.COL.sZ === 34
  && ISO.COL.name === 1 && ISO.COL.file === 0,
  `X=${ISO.COL.X} sX=${ISO.COL.sX} Y=${ISO.COL.Y} sY=${ISO.COL.sY} rho=${ISO.COL.rho}`);

t('HEADER 的第 1 列就是 COL.X 那一列（不是别的列）',
  ISO.COL.X === 36 && ISO.COL.Y === 38,
  '若 age.js 的 row 数组改了，这里会先红，而不是让错列的数字静默进图');

/* ======================================================================
 *  §B buildTable
 * ==================================================================== */

/** 造一行 51 列的年龄表行：只有 name / X,sX,Y,sY,rho 有值，其余填空。 */
function mkRow(name, X, sX, Y, sY, rho) {
  const r = new Array(51).fill('');
  r[0] = 'sample_NN.csv';
  r[1] = name;
  r[ISO.COL.X] = X; r[ISO.COL.sX] = sX;
  r[ISO.COL.Y] = Y; r[ISO.COL.sY] = sY;
  r[ISO.COL.rho] = rho;
  return r;
}
const R1 = mkRow('AY-4', 0.1686972924, 0.005508557741, 0.02485926312, 0.000811742052, 0.8184680773);
const R2 = mkRow('AY-4', 0.1706029510, 0.005567996065, 0.02514008131, 0.000820500894, 0.8117179709);
const R3 = mkRow('S-01', 0.2254962, 0.0111, 0.02670448, 0.000845, 0.3045);
const BAD_NAN = mkRow('S-06', NaN, NaN, NaN, NaN, NaN);
const BAD_EMPTY = mkRow('S-16', '', '', '', '', '');     // 空串：+'' === 0 的陷阱
const BAD_RHO = mkRow('S-27', 0.2, 0.01, 0.0262, 0.00085, 1.0);   // |ρ| ≥ 1
const BAD_SIG = mkRow('S-28', 0.2, 0, 0.0262, 0.00085, 0.3);      // sX ≤ 0

let tab = ISO.buildTable([], {});
t('空表：只有表头，n=0', tab.lines.length === 1 && tab.n === 0 && tab.lines[0] === ISO.HEADER,
  'lines=' + tab.lines.length);

tab = ISO.buildTable([R1, R2, R3], {});
t('三行合法：n=3，skip 全 0',
  tab.n === 3 && tab.skipped === 0 && tab.badRho === 0 && tab.lines.length === 4,
  `n=${tab.n} skipped=${tab.skipped} badRho=${tab.badRho}`);

(function () {
  const cells = tab.lines[1].split(',');
  const okCols = cells.length === 5
    && cells[0] === (0.1686972924).toPrecision(10)
    && cells[1] === (0.005508557741).toPrecision(10)
    && cells[2] === (0.02485926312).toPrecision(10)
    && cells[3] === (0.000811742052).toPrecision(10)
    && cells[4] === (0.8184680773).toPrecision(10);
  t('第 1 行 5 个数按 X,sX,Y,sY,rho 的顺序落位', okCols, tab.lines[1]);
})();

t('字符串数字也认（年龄表里 2s 列有时是字符串）',
  ISO.buildTable([mkRow('a', '0.168', '0.0055', '0.0248', '0.00081', '0.82')], {}).n === 1);

t('空串不算数（+"" === 0 会让错误实现把缺值当成 0）',
  ISO.buildTable([BAD_EMPTY], {}).n === 0
  && ISO.buildTable([BAD_EMPTY], {}).skipped === 1,
  'n=' + ISO.buildTable([BAD_EMPTY], {}).n
  + '；正确实现必须把它算缺，而不是当成 X=0 的真数据');

t('NaN 行被剔除并计数', ISO.buildTable([R1, BAD_NAN], {}).n === 1
  && ISO.buildTable([R1, BAD_NAN], {}).skipped === 1);

t('|ρ| ≥ 1 单独计数（badRho），不混进 skipped',
  (function () {
    const x = ISO.buildTable([R1, BAD_RHO], {});
    return x.n === 1 && x.badRho === 1 && x.skipped === 0;
  })(), '非正定协方差送进 IsoplotR 会炸，所以必须在这里挡住，而且要让人知道挡了几个');

/*  这条是本模块最贵的一个坑（2026-10-02 实测，接进来之后唯一一个
    "图能出、数看着也正常、但其实全错"的问题）：
    年龄表里 AY-4 有两个点 ρ = 0.99999999999999889 / 0.99999999999999933。
    按**原始值**判 |ρ| < 1 ⇒ 放行；写文件时按 10 位有效数字 ⇒ "1.000000000"
    ⇒ R 收到的相关系数精确等于 1 ⇒ 协方差退化 ⇒ L-BFGS-B 失败，
    而 badRho 计数是 0，界面上一点提示都没有。
    所以判据必须作用在**真正交出去的那个数**上。 */
const RHO_NEAR1 = mkRow('S-29', 0.2, 0.01, 0.0262, 0.00085, 0.99999999999999933);
t('ρ 舍入到写出精度后成为 1 的行，同样要挡住（这条曾经漏掉过）',
  (function () {
    const x = ISO.buildTable([R1, RHO_NEAR1], {});
    return x.n === 1 && x.badRho === 1 && x.skipped === 0;
  })(),
  '0.99999999999999933 的 toPrecision(10) 就是 "1.000000000"，R 拿到的是精确 1');
t('asWritten：判据用的是舍入之后的数（0.9999999999 仍然是合法的）',
  ISO.asWritten(0.99999999999999933) === 1
  && ISO.asWritten(0.9999999999) === 0.9999999999
  && ISO.asWritten(0.9999999999) < 1,
  'asWritten(0.99999999999999933) = ' + ISO.asWritten(0.99999999999999933));
t('写出去的那 5 个数与判定用的是同一份（rowUsable 的 cells）',
  (function () {
    const cells = ISO.rowUsable(R1).cells;
    const line = ISO.buildTable([R1], {}).lines[1];
    return Array.isArray(cells) && cells.join(',') === line;
  })(), '两份格式化就是两份可能对不上的数 —— 这个坑刚踩过');
t('每一行的第 5 列（写出去的 ρ）都严格 |ρ| < 1',
  ISO.buildTable([R1, R2, R3, BAD_RHO, RHO_NEAR1, BAD_SIG, BAD_NAN], {}).lines.slice(1)
    .every((l) => Math.abs(Number(l.split(',')[4])) < 1));

t('σ ≤ 0 的行被剔除', ISO.buildTable([R1, BAD_SIG], {}).n === 1
  && ISO.buildTable([R1, BAD_SIG], {}).skipped === 1);

t('按样品筛选：只留该样品，其余计入 others',
  (function () {
    const x = ISO.buildTable([R1, R2, R3], { sample: 'S-01' });
    return x.n === 1 && x.others === 2 && x.sample === 'S-01';
  })());

t("sample='*' 与不传等价（都是全部）",
  ISO.buildTable([R1, R3], { sample: '*' }).n === 2
  && ISO.buildTable([R1, R3], {}).n === 2
  && ISO.buildTable([R1, R3], { sample: '*' }).others === 0);

t('两端空白不影响样品匹配', ISO.buildTable([mkRow(' AY-4 ', 0.17, 0.005, 0.025, 0.0008, 0.8)],
  { sample: 'AY-4' }).n === 1);

/* ---- 标样 vs 样品（isoplotr.js 文件头 ⑬）--------------------------------
 *
 * 这一组是**领域口径**，不是代码技巧：内置这批数据是"一个文件一个测点"
 * （32 个样品各 1 点，而标样 AY-4 有 15 个文件、SRM 612 有 2 个）。
 * 只按点数排序，AY-4 会被顶到第一位 —— 于是最自然的操作恰好是拿**标样**
 * 去拟合"样品年龄"，而标样是拿来做 QC 的（它的年龄要跟②里填的真值比）。
 * 数值上完全正常（14 个近谐和点能出很漂亮的 157.29 Ma），错的是"这些点是什么"。
 * 所以下面每条都钉住"哪一类点进表"。 */

t('standardNames：从 cfg 认标样（stdName + nistStd + fracStd，去重、去空白）',
  (function () {
    const a = ISO.standardNames({ stdName: 'AY-4', nistStd: 'SRM 612', fracStd: 'AY-4' });
    const b = ISO.standardNames({ stdName: ' AY-4 ' });
    const c = ISO.standardNames({});
    return a.length === 2 && a[0] === 'AY-4' && a[1] === 'SRM 612'
      && b.length === 1 && b[0] === 'AY-4'
      && Array.isArray(c) && c.length === 0 && ISO.standardNames(null).length === 0;
  })(), '同名（fracStd===stdName）只算一次；认不出来就返回空数组 —— 不按名字模式猜');

t('drop：合并选时把标样行排除，并单独计数（dropped）',
  (function () {
    const x = ISO.buildTable([R1, R2, R3], { sample: '*', drop: ['AY-4'] });
    return x.n === 1 && x.dropped === 2 && x.others === 0;
  })(), 'dropped 与 skipped/others 分开报 —— 界面上那句"另有 N 行是标样"靠它');

t('drop 只在合并选时生效：点名看某个标样照样画得出来',
  (function () {
    const x = ISO.buildTable([R1, R2, R3], { sample: 'AY-4', drop: ['AY-4'] });
    return x.n === 2 && x.dropped === 0 && x.others === 1;
  })(), '用户明确点了标样，就不能因为他同时在 drop 名单里而画不出来');

t('drop 传空 / 不传时行为不变（旧调用方不受影响）',
  ISO.buildTable([R1, R3], { sample: '*' }).n === 2
  && ISO.buildTable([R1, R3], { sample: '*', drop: [] }).n === 2
  && ISO.buildTable([R1, R3], { sample: '*', drop: null }).dropped === 0);

/* ======================================================================
 *  §C sampleNames
 * ==================================================================== */
(function () {
  const g = ISO.sampleNames([R1, R2, R3, BAD_NAN, BAD_RHO]);
  const by = {};
  g.forEach((x) => { by[x.name] = x; });
  t('分组：顺序按首次出现，rows 与 usable 分开报',
    g.length === 4 && by['AY-4'].rows === 2 && by['AY-4'].usable === 2
    && by['S-06'].rows === 1 && by['S-06'].usable === 0
    && by['S-27'].rows === 1 && by['S-27'].usable === 0,
    g.map((x) => x.name + ':' + x.usable + '/' + x.rows).join(' '));
})();

/* ======================================================================
 *  §D rCode —— 口径全部在这里，所以逐条钉
 * ==================================================================== */
const CODE = ISO.rCode({ csv: '/tmp/a.csv', svg: '/tmp/a.svg', type: 1, showAge: 2, commonPb: 0 });

t('rCode 用 format=1', /format=1/.test(CODE));
t('rCode 里没有 format=3（它会把我们给的 rho 换掉）',
  !/format=3/.test(CODE),
  '实测后果：MSWD 109.94 → 181.92，差 65%；format=3 触发 "Redundant ratios…" 警告');
t('rCode 用 ierr=2（2σ 绝对，与 age.js 的 2s 同口径）',
  /ierr=2/.test(CODE), '不要折半 —— ierr=2 就是 2σ');
t('rCode 带 header=TRUE', /header=TRUE/.test(CODE));
t('rCode 的参数按传入值落位（type/show.age/common.Pb）',
  /type=1/.test(CODE) && /show\.age=2/.test(CODE) && /common\.Pb=0/.test(CODE));
t('rCode 缺省：type=1 / show.age=0 / common.Pb=0',
  (function () {
    const c = ISO.rCode({ csv: '/tmp/a.csv', svg: '/tmp/a.svg' });
    return /type=1/.test(c) && /show\.age=0/.test(c) && /common\.Pb=0/.test(c);
  })(), '缺省不写 undefined —— R 里 undefined 是个"找不到的对象"');
t('rCode 里没有 JS 的 undefined 被拼进去（探针踩过这个坑）',
  (function () {
    //  真正的回归点在"参数插值"这几处：漏传一个参数，JS 就把 undefined
    //  原样拼进 R 代码，R 报 object 'undefined' not found —— 报错信息里
    //  看不出是哪个参数漏了。所以这里只查插值位，不去查 is.null 之类的 R 语法。
    const c = ISO.rCode({ csv: '/tmp/a.csv', svg: '/tmp/a.svg' });
    return !/=\s*undefined/.test(c) && !/\(\s*undefined/.test(c)
      && !/undefined\s*[,)]/.test(c);
  })(), "踩过：探针里漏传 commonPb，R 报 object 'undefined' not found，而报错里看不出漏了谁");
t('rCode 每段包在 tryCatch 里', /tryCatch/.test(CODE) && /error\s*=\s*function/.test(CODE));
t('rCode 拟合失败时退回 show.age=0（不留空面板）',
  /if \(is\.null\(o\) && 2 > 0\)/.test(CODE) && /show\.age=0/.test(CODE)
  && /拟合失败，已退回只画点/.test(CODE));
t('rCode 把 R 的错误原文带回来（error= 一行）',
  /paste0\("error="/.test(CODE));
t('rCode 装了包还要 library()（只装不挂会 could not find function）',
  /library\(IsoplotR\)/.test(CODE));
t('rCode 里没有 </script（要内联进单文件页面）',
  CODE.toLowerCase().indexOf('</script') < 0);

/*  R 的"顶层 if/else 跨行"陷阱。这一段**不能用 Node 验**（这里没有 R），
    所以退一步查结构：只要有一行以 else 开头，R 就会把上一行判为完整语句、
    然后报 `unexpected 'else'`，整段脚本一行都不执行（连图都不出）。
    实测撞过：f1 的定义被拆成两行 ⇒ 点按钮毫无反应，只有一句 parse 错。 */
t('rCode 的任何一行都不以 else 开头（R 顶层 if/else 跨行会 parse 失败）',
  CODE.split('\n').every((ln) => !/^\s*else\b/.test(ln)),
  '报错形态：Error in parse(text = expr) : :4:3: unexpected \'else\'');
t('rCode 里 f1 的定义只占一行',
  (function () {
    const hit = CODE.split('\n').filter((ln) => ln.indexOf('f1 <- function') === 0);
    return hit.length === 1 && /"NA"/.test(hit[0]) && /else/.test(hit[0]);
  })(), '拆行就等于把 if 与 else 分开，见上一条');
t('rCode 的每一行都非空',
  CODE.split('\n').every((ln) => ln.trim().length > 0));

/*  mswd / p.value / df 的形态随 show.age 变（1 → 有名字的向量，≥2 → 标量），
    脚本里必须走"按长度分两路"的那个 helper，而不是只 for (k in names(...))。 */
t('rCode 用 putv 取 mswd/p/df（标量与向量两种形态都覆盖）',
  /putv\("mswd", o\$mswd\)/.test(CODE) && /putv\("p", o\$p\.value\)/.test(CODE)
  && /putv\("df", o\$df\)/.test(CODE) && /length\(v\) == 1/.test(CODE),
  'show.age≥2 时这三个是标量，names() 为 NULL —— 只写循环会一个都取不回来');
t('rCode 不再对 mswd/p/df 只用 names() 循环',
  !/for \(k in names\(o\$mswd\)\)/.test(CODE)
  && !/for \(k in names\(o\$p\.value\)\)/.test(CODE)
  && !/for \(k in names\(o\$df\)\)/.test(CODE));

t('rCode 挡住路径注入',
  (function () {
    try { ISO.rCode({ csv: '/tmp/a.csv"; system("x"); #', svg: '/tmp/a.svg' }); return false; }
    catch (e) { return /非法字符/.test(e.message); }
  })());

t('rCode 挡住非数字参数',
  (function () {
    try { ISO.rCode({ csv: '/tmp/a.csv', svg: '/tmp/a.svg', type: 'x' }); return false; }
    catch (e) { return /不是数字/.test(e.message); }
  })());

t('rCode 的 CSV 内容不会被拼进 R 代码（走 writeLines 的文件路径）',
  ISO.rCode({ csv: '/tmp/a.csv', svg: '/tmp/a.svg' }).indexOf('Pb207U235') < 0,
  '表内容只经虚拟文件系统进去，R 代码里只有路径');

/* ======================================================================
 *  §E parseResult
 * ==================================================================== */
const SAMPLE_TXT = [
  'n=45', 'error=',
  'par:t[l]=161.808', 's:t[l]=0.4921696', 'disp:t[l]=0.7498098',
  'par:t[u]=5213.916', 's:t[u]=6.987257',
  'par:a0=1.00337', 'par:b0=NA',
  'model=1',
].join('\n');
let pr = ISO.parseResult(SAMPLE_TXT);
t('parseResult：n 与 model 是标量',
  pr.n === 45 && pr.model === 1, 'n=' + pr.n + ' model=' + pr.model);
t('parseResult：par/s/disp 分桶',
  near(pr.par['t[l]'], 161.808, 1e-9) && near(pr.s['t[l]'], 0.4921696, 1e-9)
  && near(pr.disp['t[l]'], 0.7498098, 1e-9),
  't[l]=' + pr.par['t[l]'] + ' ± ' + pr.s['t[l]']);
t('parseResult：NA → NaN（不是 0）',
  isNaN(pr.par.b0), 'b0=' + pr.par.b0 + '；当成 0 会在界面上印出"截距 0"');

const TXT1 = [
  'n=14', 'error=',
  'age:t=157.3075', 'age:s[t]=0.4970411', 'age:disp[t]=0.6509453',
  'mswd:equivalence=0.6758404', 'mswd:concordance=0.003674266', 'mswd:combined=0.6509453',
  'p:combined=0.9159583', 'df:combined=27',
].join('\n');
pr = ISO.parseResult(TXT1);
t('parseResult：age 桶（s[t] 里的方括号不影响分桶）',
  near(pr.age.t, 157.3075, 1e-9) && near(pr.age['s[t]'], 0.4970411, 1e-9),
  'age=' + pr.age.t + ' ± ' + pr.age['s[t]']);
t('parseResult：mswd/p/df 桶',
  near(pr.mswd.combined, 0.6509453, 1e-9) && near(pr.p.combined, 0.9159583, 1e-9)
  && pr.df.combined === 27);

pr = ISO.parseResult('n=14\nerror=拟合失败，已退回只画点：non-finite value supplied by optim\n');
t('parseResult：错误原文原样保留（含中文与冒号）',
  pr.error === '拟合失败，已退回只画点：non-finite value supplied by optim', pr.error);

pr = ISO.parseResult('n=43\nmswd=2.261639\np=4.4e-6\ndf=43\nmodel=1');
t('parseResult：标量形式的 mswd / p / df（show.age≥2 就是这么回来的）',
  near(pr.mswd, 2.261639, 1e-9) && near(pr.p, 4.4e-6, 1e-12) && pr.df === 43,
  'mswd=' + pr.mswd + ' p=' + pr.p + ' df=' + pr.df);

pr = ISO.parseResult('');
t('parseResult：空文本不炸，n 是 NaN', isNaN(pr.n) && Object.keys(pr.par).length === 0);

/* ======================================================================
 *  §F summarise —— 口径必须写在每一行上
 * ==================================================================== */
let su = ISO.summarise(ISO.parseResult(TXT1), { type: 1, showAge: 1 });
let get = (s, k) => { const r = s.rows.find((x) => x.k === k); return r ? r.v : null; };
t('show.age=1：给出谐和年龄与 1σ',
  get(su, '谐和年龄') === '157.31 Ma' && String(get(su, '　1σ')).indexOf('0.497') > 0,
  get(su, '谐和年龄') + ' ' + get(su, '　1σ'));
t('show.age=1：同时给出 95% 置信区间，且 = 1.96×1σ',
  (function () {
    const a = get(su, '　1σ');
    const b = get(su, '　95% 置信区间');
    return /0.974/.test(b) && /图上印的就是这个/.test(
      (su.rows.find((x) => x.k === '　95% 置信区间') || {}).note || '');
  })(), get(su, '　95% 置信区间') + '（1σ 是 ' + get(su, '　1σ') + '，差 1.96 倍）');
t('show.age=1：MSWD / p / 自由度各有三项且用中文区分',
  !!get(su, '　MSWD（等价）') && !!get(su, '　MSWD（合并）') && !!get(su, '　自由度（合并）'));
t('show.age=1：ok=true 且没有"拟合失败"的说明', su.ok === true && su.notes.length >= 1);

su = ISO.summarise(ISO.parseResult(SAMPLE_TXT), { type: 1, showAge: 2 });
t('show.age=2 type=1：上/下交点各自成行',
  get(su, '下交点年龄') === '161.81 Ma' && get(su, '上交点年龄') === '5213.9 Ma',
  get(su, '下交点年龄') + ' / ' + get(su, '上交点年龄')
  + '（按量级分档：<1000 Ma 给 0.01 Ma，≥1000 Ma 给 0.1 Ma，不印假精度）');
t('show.age=2：提醒"混了不同样品的整批数据不要看这个数"',
  su.notes.some((n) => /混了不同样品/.test(n)));
t('show.age=2：MSWD / p / 自由度的标量形式也认（脚本按长度分两路取）',
  (function () {
    const s2 = ISO.summarise(
      ISO.parseResult('n=43\nmswd=2.261639\np=4.4e-6\ndf=43\nmodel=1'),
      { type: 1, showAge: 2 });
    const g = (k) => { const r = s2.rows.find((x) => x.k === k); return r ? r.v : null; };
    return g('MSWD') === '2.262' && g('自由度') === '43' && !!g('p 值');
  })(),
  'show.age≥2 时 IsoplotR 返回的 mswd/p.value/df 是**标量**（names() 为 NULL），'
  + '只写 for (k in names(...)) 就一个都取不回来 —— 实测踩过：交点年龄出来了、MSWD 是空的');

su = ISO.summarise(ISO.parseResult('n=14\nerror=non-finite value supplied by optim'), { showAge: 2 });
t('拟合失败：ok=false 且原文出现在说明里',
  su.ok === false && su.notes.some((n) => /non-finite value supplied by optim/.test(n)),
  su.notes.join(' ｜ ').slice(0, 90));
su = ISO.summarise(ISO.parseResult('n=1'), { showAge: 2 });
t('点数太少（n=1）时明确说出来', su.notes.some((n) => /几何上就不成立/.test(n)));

/* ======================================================================
 *  §G 拿内置的 49 个真实样品核一遍列号（不是拿自己比，是拿真数据比）
 * ==================================================================== */
(function () {
  try {
    for (const f of ['fp.js', 'math.js', 'thermo.js', 'window.js', 'report.js',
                     'pipeline.js', 'age.js', 'qc.js', 'demo_real.js']) {
      vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), sandbox, { filename: f });
    }
  } catch (e) {
    bad('§G 加载 src/ 模块', String(e && e.message));
    return;
  }
  const W = sandbox.window;
  const FP = W.DS_FP, M = W.DS, TH = W.DS_THERMO, RP = W.DS_REPORT;
  const WIN = W.DS_WINDOW, PL = W.DS_PIPELINE, AGE = W.DS_AGE, QC = W.DS_QC;
  const D = W.DS_DEMO_REAL;
  if (!D) { bad('§G 内置真实示例数据存在', '没有 window.DS_DEMO_REAL'); return; }

  WIN.setNumeric(M);
  PL.attach({
    thermoLoad: TH.thermoLoad, agilentLoad: TH.agilentLoad,
    thermoSampleName: TH.thermoSampleName, detectSignalWindow: WIN.detectSignalWindow,
    nmean: M.nmean, untagInt: M.untagInt, reduceSample: M.reduceSample,
    buildMeanCpsCsv: RP.buildMeanCpsCsv, buildResultAllCsv: RP.buildResultAllCsv,
  });
  AGE.attach({
    pwSum: M.pwSum, nnanmean: M.nnanmean, age76Pb: M.age76Pb,
    age76PbFixed: M.age76PbFixed, sk2model: M.sk2model,
  });
  const ISONAME = ['Time', '202Hg', '204Pb', '206Pb', '207Pb', '208Pb', '232Th', '238U'];
  function calAge(age) {
    const a = FP.dexp(0.000000000155125 * age * 1000000) - 1;
    const b = FP.dexp(0.00000000098485 * age * 1000000) - 1;
    const c = FP.dexp(0.000000000049475 * age * 1000000) - 1;
    const P382 = 1 / 137.818 * (b / a);
    const Q8 = 18.700 - a * 9.735;
    const R8 = 15.628 - b * (9.735 / 137.818);
    return { a, b, c, P382, Q8, R8, S8: 38.630 - c * 36.837, Pbc: R8 / Q8, Standard_age: age };
  }

  return D.decode().then(function (files) {
    const P = D.params, cal = calAge(P.stdAge);
    const stdSet = {}; stdSet[P.stdName] = P.stdAge;
    const out = PL.run({
      files: files, isoname: ISONAME, b0: P.b0, b1: P.b1, multi: P.multi,
      stdcor: 0, method: P.method, standardNames: stdSet, ctx: cal,
      eleIndex: 2, instrument: P.inst, sampleNames: null,
    });
    const input = AGE.buildInput(out.resultAllCsv, out.meanCpsCsv, null);
    input.fix76 = false;
    input.cfg = {
      method: P.method, excessV: P.excess / 100, nistStd: P.nistStd,
      standard: P.fracStd, P382: cal.P382, a: cal.a, b: cal.b, c: cal.c, Pbc: cal.Pbc,
      age: 100, radioactivePb: 0.048015, commonPb: 0.842185,
      commonPb206_208: 0.48240, commonPb207_208: 0.40628,
      commonPb206_204: 18.5478, commonPb207_204: 15.6207, commonPb208_204: 38.447,
      radioactiveSPb207_206: cal.P382,
    };
    const res = AGE.averageAge(input);

    const tb = ISO.buildTable(res.rows, {});
    //  两个类别要分开报，否则"少了几个点"就说不清到底少在哪：
    //    missing  —— 比值列整行 NaN（窗口识别探到空切片的那几个文件）
    //    badrho   —— ρ 舍入到写出精度后成为 ±1（AY-4 有 2 个点命中）
    //  missing 必须**恰好**是产物里 flaws.nanRows 声明的那几个文件 ——
    //  这样"少了几个点"就不是一个孤立的数字，而是能与产物对上号的清单。
    //  窗口识别修正后这份清单是空的（49 行比值全部可用），断开的是别的环节时
    //  这里会立刻红。
    const dropped = [], rhoOut = [];
    res.rows.forEach(function (r) {
      const u = ISO.rowUsable(r);
      if (u.ok) return;
      if (u.why === 'badrho' || u.why === 'norho') rhoOut.push(String(r[0]));
      else dropped.push(String(r[0]));
    });
    const declared = ((D.flaws && D.flaws.nanRows) || []).map((x) => x.file).sort();
    t('§G 真实数据：49 行全部有值，只剔 2 行 ρ=1（与产物声明的 NaN 清单一致）',
      res.rows.length === 49 && tb.n === 47 && tb.skipped === 0 && tb.badRho === 2
      && JSON.stringify(dropped.sort()) === JSON.stringify(declared),
      `49 行 → ${tb.n} 点：比值缺 [${dropped.join('、')}]，`
      + `ρ 写出即 ±1 [${rhoOut.join('、')}]`);

    t('§G 表里第 1 行第 1 个数 = 年龄表那一行的第 36 列（列号没数错）',
      (function () {
        const first = res.rows.find((r) => ISO.rowUsable(r).ok);
        return tb.lines[1].split(',')[0] === Number(first[36]).toPrecision(10);
      })(), '若列号错位（例如取了 34 的 2s），这里立刻红');

    t('§G 真实数据的 ρ 是有内容的（不是全 0 —— 不传就退化成轴对齐椭圆）',
      (function () {
        const rhos = [];
        res.rows.forEach(function (r) {
          if (ISO.rowUsable(r).ok) rhos.push(Number(r[40]));
        });
        const mn = Math.min.apply(null, rhos), mx = Math.max.apply(null, rhos);
        return rhos.length === 47 && mn > 0 && mx < 1 && (mx - mn) > 0.5;
      })(), '实测 0.0231 ~ 0.9216；被剔掉的两个是 0.9999999999999989 那几个');

    const grp = ISO.sampleNames(res.rows);
    const ay4 = grp.filter((g) => g.name === P.stdName)[0];
    t('§G 样品分组：AY-4 有 ' + (ay4 ? ay4.usable : '?') + ' 个可用点（15 行里剔 0 缺值 + 2 个 ρ=1）',
      !!ay4 && ay4.rows === 15 && ay4.usable === 13,
      grp.length + ' 组；单点样品 ' + grp.filter((g) => g.usable === 1).length + ' 个');

    /*  默认选中的必须是「全部样品」而不是标样（用户 2026-10-02 指出）。
     *  这批数据一个文件一个测点：32 个样品各 1 点，标样 AY-4 有 15 个文件、
     *  SRM 612 有 2 个 —— 49 = 32 + 15 + 2。所以"选样品作图"只有选**全部**
     *  才有 32 个点可看；按点数排序会把 AY-4 顶到第一位，而它是 QC 样。 */
    const stdNames = ISO.standardNames({ stdName: P.stdName, nistStd: P.nistStd });
    const tSmp = ISO.buildTable(res.rows, { sample: '*', drop: stdNames });
    t('§G 真实数据：默认「全部样品」= 32 个样品测点，全部可用，标样被排掉',
      JSON.stringify(stdNames) === JSON.stringify([P.stdName, P.nistStd])
      && tSmp.n === 32 && tSmp.skipped === 0 && tSmp.badRho === 0
      && tSmp.dropped === 17 && tSmp.others === 0,
      `样品 ${tSmp.n} 点（无缺值）；排掉标样 ${tSmp.dropped} 行`
      + `（${P.stdName} 15 + ${P.nistStd} 2）；含标样时是 ${tb.n} 点 —— 两个数不能混报`);

    t('§G 真实数据：ρ=±1 被剔的那两个点属于标样，不在样品那 32 点里',
      rhoOut.length === 2 && rhoOut.every(function (f) {
        const r = res.rows.filter((x) => String(x[0]) === f)[0];
        return r && String(r[1]).trim() === P.stdName;
      }), '被 ρ 饱和剔掉的是 [' + rhoOut.join('、') + ']，都属于 ' + P.stdName
      + ' ⇒ 默认的样品视图里 badRho 是 0（界面上不会再无端报"剔了 2 行"）');

    t('§G 真实数据：每个样品只有 1 个测点（所以"选单个样品"出不了年龄）',
      grp.filter((g) => stdNames.indexOf(g.name) < 0).length === 32
      && grp.filter((g) => stdNames.indexOf(g.name) < 0).every((g) => g.rows === 1),
      '32 个样品各 1 行；单个样品在图上就是一个点（IsoplotR 拟合会报 '
      + 'Cannot fit a straight line）—— 所以默认必须是"全部样品"');

    /*  交叉验证：IsoplotR 的谐和年龄与 Isoclock 自己的加权平均
     *  —— 两条完全独立的路径，对得上才说明接进来的不是个摆设。
     *  两侧的来源都要写清楚，否则这条断言就成了"拿我的实现验证我的实现"：
     *   · Isoclock 侧：产物声明的 stdMeasured（test_demo_real.js 已钉住它
     *     等于本次实测），AY-4 = 157.06 ± 1.39 Ma（2σ，MSWD 0.70，15 点）。
     *   · IsoplotR 侧：浏览器里真跑出来的 concordia age。**这里的两个数是
     *     2026-10-04 在无头 Edge 里实测的**（G:/_isohtml/probe_iso_val.py），
     *     不是从某次探针手抄的旧值：窗口识别修正之后 AY-4 是 13 个点
     *     （2 个 ρ→1 的点被剔），t = 157.36 Ma，s[t] = 0.645 Ma (1σ)，
     *     MSWD(combined) = 0.378。
     *  口径：Isoclock 的 2s 是 2σ，IsoplotR 的 s[t] 是 1σ ⇒ 统一到 2σ 再比。 */
    const M2 = D.stdMeasured;
    const isoAge = 157.36, isoS = 0.645;
    const d = Math.abs(M2.mean - isoAge);
    const dfree = Math.sqrt(Math.pow(M2.se2 / 2, 2) + Math.pow(isoS, 2));
    t('§G 交叉验证：Isoclock 加权平均与 IsoplotR 谐和年龄相容',
      d < 1.5,
      M2.mean.toFixed(2) + ' ± ' + M2.se2.toFixed(2) + ' Ma(2σ, Isoclock) ｜ '
      + isoAge.toFixed(4) + ' ± ' + isoS.toFixed(5) + ' Ma(1σ, IsoplotR) ｜ 差 '
      + d.toFixed(3) + ' Ma（合成 1σ ' + dfree.toFixed(3) + '）');
  }).catch(function (e) {
    bad('§G 真实数据那一段没跑完', String((e && e.stack) || e));
  });
})().then(function () {
  /* ==================================================================
   *  §H svgDataUri
   * ================================================================== */
  const uri = ISO.svgDataUri('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  t('svgDataUri：前缀是 data:image/svg+xml',
    uri.indexOf('data:image/svg+xml;charset=utf-8,') === 0);
  t('svgDataUri：能被还原（含 < & " 这些需要转义的字符）',
    decodeURIComponent(uri.slice(uri.indexOf(',') + 1))
    === '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  t('svgDataUri：用 <img> 装，避免两张图的内联 symbol id 撞车', true,
    'IsoplotR 的 SVG 用 <symbol id="glyph0-1"> 定义字形，内联进同一份文档必然撞 id');

  /* ==================================================================
   *  §I 「更多选项」的实参表（rArgs）—— 逐项对齐 IsoplotR 原版
   *
   *  判据来源（都是外部真值，不是拿自己比）：
   *    · 控件与取值 ← pvermees/IsoplotRgui 的 inst/www/options/concordia.html
   *    · R 侧写法   ← cran/IsoplotR 的 R/concordia.R 与 R/discfilter.R
   *      （anchor=c(2,年龄)、cutoff.disc=discfilter(option=,before=,cutoff=)、
   *       discfilter 那串按 option 分的默认上下限）
   *
   *  两条规矩各配了能失败的断言：
   *    (a) **留空 = 不传** —— 用 IsoplotR 自己的默认值，而不是我们另编一个；
   *    (b) **只有校验过的东西能进 R 代码** —— 数字、受控布尔、#RRGGBB。
   * ================================================================== */
  const BASE_OPT = { csv: '/tmp/a.csv', svg: '/tmp/a.svg' };
  const RA = (o) => ISO.rArgs(Object.assign({}, BASE_OPT, o));

  t('§I 一个更多选项都不给时，实参表恰好是原来的四项',
    RA({}).join(',') === 'type=1,show.age=0,common.Pb=0,sigdig=3',
    RA({}).join(', '));
  t('§I 默认时更多选项一个都不出现（留空 = 不传 = 用原版默认值）',
    !RA({}).some((s) => /anchor|cutoff\.disc|tlim|xlim|ylim|ticks|exterr|shownumbers|ellipse/.test(s)));
  /*  这一条是**浏览器里实测撞出来的**：界面上 sigdig 那格默认是空的，
   *  于是传下来一个空串；把"空串"和"填错了"混成一个含义，整张图就会报
   *  "作图参数不是数字"。空串必须等于"没填 ⇒ 用默认值"，非数字才报错。 */
  t('§I 主参数留空 = 用默认值（空串不能被当成"非数字"）',
    RA({ type: '', showAge: '', commonPb: '', sigdig: '' }).join(',')
      === 'type=1,show.age=0,common.Pb=0,sigdig=3',
    RA({ type: '', showAge: '', commonPb: '', sigdig: '' }).join(', '));
  t('§I 主参数填了非数字仍然要报错（留空与填错是两回事）',
    (function () {
      try { RA({ showAge: 'abc' }); return false; }
      catch (e) { return /不是数字/.test(e.message); }
    })());

  //  —— anchor ——
  t('§I anchor=2 → anchor=c(2,年龄)（原版 anchor[1] 选模式、anchor[2] 是年龄）',
    RA({ showAge: 2, anchor: 2, anchorAge: '260' }).indexOf('anchor=c(2,260)') >= 0);
  t('§I anchor=2 却没填年龄 → 整个 anchor 不传（半截参数不能进 R）',
    !RA({ showAge: 2, anchor: 2 }).some((s) => s.indexOf('anchor') === 0));
  t('§I anchor=1 / 3 → 标量 anchor=1 / anchor=3',
    RA({ showAge: 3, anchor: 1 }).indexOf('anchor=1') >= 0
    && RA({ showAge: 3, anchor: 3 }).indexOf('anchor=3') >= 0);
  t('§I anchor 只在 show.age≥2 时传（原版 GUI 也只在那档显示这一栏）',
    !RA({ showAge: 1, anchor: 3 }).some((s) => s.indexOf('anchor') === 0)
    && !RA({ showAge: 0, anchor: 2, anchorAge: '260' }).some((s) => s.indexOf('anchor') === 0));

  //  —— 不谐和度过滤 ——
  t('§I 过滤：cutoff.disc=discfilter(option=,before=,cutoff=)（照抄 GUI 的写法）',
    RA({ discFilter: 1, discOpt: 4, discCutoff: '-1.6,4.7' })
      .indexOf('cutoff.disc=discfilter(option=4,before=TRUE,cutoff=c(-1.6,4.7))') >= 0);
  t('§I 过滤：上下限留空就不传 cutoff（改用 R 里按判据分的那套默认值）',
    RA({ discFilter: 1, discOpt: 5 }).indexOf('cutoff.disc=discfilter(option=5,before=TRUE)') >= 0);
  t('§I 过滤：档位为 0（不过滤）时整段不出现',
    !RA({ discFilter: 0, discOpt: 3 }).some((s) => s.indexOf('cutoff.disc') === 0));
  t('§I 过滤：判据只认 1~5，越界要吵出来而不是悄悄退回某一档',
    (function () {
      try { RA({ discFilter: 1, discOpt: 9 }); return false; }
      catch (e) { return /判据/.test(e.message); }
    })(), '悄悄退回某一档会让人以为过滤生效了');
  t('§I 过滤：上下限只填一格不生效（不做半截参数）',
    RA({ discFilter: 1, discOpt: 1, discCutoff: ',5' }).join(',').indexOf('cutoff=c(') < 0
    && RA({ discFilter: 1, discOpt: 1, discCutoff: '1,' }).join(',').indexOf('cutoff=c(') < 0);

  //  —— 坐标与刻度 ——
  t('§I tlim / xlim / ylim → c(min,max)',
    RA({ tlim: '100,300', xlim: '0,0.06', ylim: '0,0.06' }).join(',')
      .indexOf('tlim=c(100,300),xlim=c(0,0.06),ylim=c(0,0.06)') >= 0);
  t('§I ticks 给一个数就是标量、给一串就是年龄向量（原版两种都收）',
    RA({ ticks: '5' }).indexOf('ticks=5') >= 0
    && RA({ ticks: '249,250,251' }).indexOf('ticks=c(249,250,251)') >= 0);
  t('§I 坐标格式不对（半截 / 非数字 / 多一个逗号）一律当作没填',
    !RA({ tlim: '100', xlim: 'a,b', ylim: '1,2,3' }).some((s) => /^(tlim|xlim|ylim)=/.test(s))
    && !RA({ ticks: '1,2,' }).some((s) => s.indexOf('ticks=') === 0));

  //  —— 勾选框 ——
  t('§I exterr / show.numbers 只在勾上时传 TRUE（原版的默认是 FALSE）',
    RA({ exterr: true, shownumbers: 'true' }).join(',').indexOf('exterr=TRUE,shownumbers=TRUE') >= 0
    && !RA({ exterr: false, shownumbers: 0 }).some((s) => /^(exterr|shownumbers)/.test(s)));

  //  —— 椭圆样式 ——
  t('§I 填色写成 8 位十六进制 #RRGGBBAA（IsoplotR 的椭圆就吃这个写法）',
    RA({ fill: '#ff0000', fillAlpha: '0.5' }).indexOf('ellipse.fill="#FF000080"') >= 0);
  t('§I 填色给了、透明度没给 → 用原版默认的 0.5（它默认填色的末两位就是 80）',
    RA({ fill: '#00ff00' }).indexOf('ellipse.fill="#00FF0080"') >= 0);
  t('§I 透明度超出 0~1 会被夹住（不生成非法颜色）',
    RA({ fill: '#00ff00', fillAlpha: '2' }).indexOf('ellipse.fill="#00FF00FF"') >= 0
    && RA({ fill: '#00ff00', fillAlpha: '-1' }).indexOf('ellipse.fill="#00FF0000"') >= 0);
  t('§I 描边色单独成参数',
    RA({ stroke: '#333333' }).indexOf('ellipse.stroke="#333333"') >= 0);
  t('§I 颜色只认 #RRGGBB；red / #12 / #RRGGBBAA 一律不传',
    !RA({ fill: 'red', stroke: '#12' }).some((s) => s.indexOf('ellipse.') === 0)
    && !RA({ fill: '#ff000080' }).some((s) => s.indexOf('ellipse.fill') === 0),
    '多给一位就会拼出 #RRGGBBAA+AA 这种非法颜色');

  //  —— (b) 只有校验过的东西能进 R 代码 ——
  t('§I 注入样本喂进去之后，实参表里没有分号、引号展开、也没有 system(',
    (function () {
      const dirty = RA({
        showAge: 2, anchor: 2, anchorAge: '260); system("rm -rf /"); #',
        tlim: '1);system("x");#', ylim: '0,1);system("y");#',
        ticks: '5\nsystem("z")', discFilter: 1, discOpt: 1,
        discCutoff: '0,1);system("w");#',
        fill: 'red;system("v")', stroke: '#12;system("u")'
      });
      const s = dirty.join(' ');
      return dirty.every((x) => /^[a-zA-Z.]+=[A-Za-z0-9_.,()"#=+-]*$/.test(x))
        && s.indexOf('system') < 0 && s.indexOf(';') < 0;
    })(), '数值项经 Number() 过滤、颜色经正则过滤，其余一概丢掉');
  t('§I 必填的数字项（sigdig）被注入时直接报错，不静默',
    (function () {
      try { RA({ sigdig: '3);cat(1);#' }); return false; }
      catch (e) { return /不是数字/.test(e.message); }
    })());
  t('§I 更多选项进 R 代码后，concordia() 那一行不多出一个分号或单引号',
    (function () {
      const c = ISO.rCode(Object.assign({}, BASE_OPT, {
        showAge: 2, anchor: 2, anchorAge: '260',
        discFilter: 1, discOpt: 2, discCutoff: '-3,12',
        tlim: '100,300', xlim: '0,0.06', ylim: '0,0.06',
        ticks: '249,250,251', exterr: true, shownumbers: true,
        fill: '#ff0000', fillAlpha: '0.35', stroke: '#333333'
      }));
      const call = c.split('\n').filter((l) => l.indexOf('concordia(d,') >= 0)[0] || '';
      return call.indexOf(';') < 0 && call.indexOf("'") < 0
        && /ellipse\.fill="#FF000059"/.test(call) && /anchor=c\(2,260\)/.test(call);
    })());
  t('§I 拟合失败退回只画点时，其余参数原样保留（只把 show.age 换成 0）',
    (function () {
      const c = ISO.rCode(Object.assign({}, BASE_OPT, { showAge: 2, tlim: '100,300' }));
      const fb = c.split('\n').filter((l) => l.indexOf('try(concordia(d,') >= 0)[0] || '';
      return /tlim=c\(100,300\)/.test(fb) && /show\.age=0/.test(fb) && !/show\.age=2/.test(fb);
    })());

  //  —— 契约：rArgs 读的键与 RARG_KEYS 必须互相覆盖 ——
  const RA_SRC = ISO.rArgs.toString();
  const USED_KEYS = [];
  (function () {
    const re = /\ba\.([A-Za-z_][A-Za-z0-9_]*)/g;
    let m;
    while ((m = re.exec(RA_SRC))) if (USED_KEYS.indexOf(m[1]) < 0) USED_KEYS.push(m[1]);
  })();
  const MISSING_KEYS = USED_KEYS.filter((k) => ISO.RARG_KEYS.indexOf(k) < 0);
  const UNUSED_KEYS = ISO.RARG_KEYS.filter((k) => USED_KEYS.indexOf(k) < 0);
  t('§I RARG_KEYS 覆盖 rArgs 读的每一个键',
    MISSING_KEYS.length === 0,
    '缺：' + (MISSING_KEYS.join('、') || '无') + '（app.js 照这张表整份透传；'
    + '漏一个的症状是"界面填了、图没变"）');
  t('§I RARG_KEYS 里没有多余（改了名却忘了删）的键',
    UNUSED_KEYS.length === 0, '多余：' + (UNUSED_KEYS.join('、') || '无'));

  //  —— 候选值必须与原版一致 ——
  t('§I 三个下拉的取值与原版一致（anchor 0~3 / 过滤档 0·1 / 判据 1~5）',
    ISO.ANCHORS.map((o) => o.v).join(',') === '0,1,2,3'
    && ISO.DISCFILTERS.map((o) => o.v).join(',') === '0,1'
    && ISO.DISCOPT.map((o) => o.v).join(',') === '1,2,3,4,5',
    '过滤档只有两档：原版第二档「按校正后的比值过滤」要求数据格式 ≥4，'
    + '我们的表是 5 列 U-Pb（format=1）');
  t('§I discfilter 的默认上下限照抄 R 里那串 if-else',
    JSON.stringify(ISO.DISC_DEFAULT) === JSON.stringify(
      { 1: [-48, 140], 2: [-5, 15], 3: [-0.36, 0.96], 4: [-1.6, 4.7], 5: [-2, 5.8] }),
    JSON.stringify(ISO.DISC_DEFAULT));

  console.log('');
  console.log(`总计 ${pass + fail} 项：通过 ${pass}，失败 ${fail}`);
  if (fail) {
    console.log('失败项：');
    for (const f of failures) console.log('  - ' + f);
    process.exitCode = 1;
  }
});
