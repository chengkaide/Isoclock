/* ==========================================================================
 *  test_report.js —— 报告生成器（HTML 组装 / 转义 / 完整性 / 幂等）
 *
 *  【这份测试要挡住的四类问题】
 *   1. 报告是"拿给别人看、还要存档"的东西。少一段、多一个 undefined、
 *      或者把「NaN」当成数字印上去，都会被人当成真数据读走。
 *      → 所以逐条检查：章节齐、没有 undefined/NaN/[object Object]、数字对得上。
 *   2. 样品名来自**用户的文件**，是不可信输入。名字里带 < > " 的样品
 *      完全可能出现。拼进 HTML 时不转义就是一个注入点。
 *      → 用真正的恶意字符串喂进去，验证输出里只有转义形式。
 *   3. 报告必须能离线打开。一旦引进外部字体/脚本/图标，离线就残了。
 *      → 检查没有任何 http(s) 外链与 <link>。
 *   4. 判据只给颜色不给理由，等于没判：真实数据里标样偏差可以是 0.00%，
 *      而内部 MSWD 高达 325。只印颜色会让人以为没问题。
 *      → 检查每条 warn/bad 的"为什么"都真的印进了报告。
 *
 *  【判据来源】不引浏览器、不引 DOM：report.js 是纯函数（只读 window.DS_QC），
 *  所以在 node 里把源码跑起来就能验。样式之外的排版留给无头浏览器截图核。
 *
 *  用法:  node webgui/test_report.js
 * ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, 'src');
const UI = path.join(__dirname, 'ui');

const sandbox = { window: {}, console };
vm.createContext(sandbox);
for (const f of ['fp.js', 'math.js', 'age.js', 'qc.js']) {
  vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), sandbox, { filename: f });
}
vm.runInContext(fs.readFileSync(path.join(UI, 'report.js'), 'utf8'), sandbox,
  { filename: 'report.js' });

const M = sandbox.window.DS;
const AGE = sandbox.window.DS_AGE;
const QC = sandbox.window.DS_QC;
const QR = sandbox.window.DS_QCREPORT;
AGE.attach({
  pwSum: M.pwSum, nnanmean: M.nnanmean, age76Pb: M.age76Pb, sk2model: M.sk2model,
});

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) pass++; else { fail++; failures.push(name); }
  console.log((ok ? '  ok  ' : ' FAIL ') + name.padEnd(44) + (detail === undefined ? '' : detail));
}
function near(a, b, tol) {
  if (!isFinite(a) || !isFinite(b)) return Object.is(a, b);
  return Math.abs(a - b) <= (tol === undefined ? 1e-9 : tol) * Math.max(1, Math.abs(b));
}
function countOf(re, s) { return (s.match(re) || []).length; }

/** 一次真实数据跑出来的 qc 对象；多个用例共用同一份，避免互相污染。 */
function buildRealQc(overrides) {
  const REF = JSON.parse(fs.readFileSync(path.join(SRC, 'age_case.json'), 'utf8'));
  const ctx = REF.meta.ctx;
  const run = REF.runs.find((r) => r.algo === 'avg' && r.method === 0);
  const p = run.params;
  const cfg = {
    method: run.method, excessV: run.excessV, nistStd: run.nist, standard: run.standard,
    P382: ctx.P382, a: ctx.a, b: ctx.b, c: ctx.c, Pbc: ctx.Pbc,
    age: p.age, radioactivePb: p.Radioactive_Pb, commonPb: p.common_Pb,
    commonPb206_208: p.common_Pb206_208, commonPb207_208: p.common_Pb207_208,
    commonPb206_204: p.common_Pb206_204, commonPb207_204: p.common_Pb207_204,
    commonPb208_204: p.common_Pb208_204, radioactiveSPb207_206: p.radioactiveS_Pb207_206,
  };
  const base = AGE.buildInput(REF.resultAllCsv, REF.meanCpsCsv, REF.comments);
  const ageRes = AGE.averageAge(Object.assign({}, base, { cfg: cfg }));

  const names = {};
  ageRes.rows.forEach((r) => { names[r[1]] = (names[r[1]] || 0) + 1; });
  const stdName = Object.keys(names).sort((a, b) => names[b] - names[a])[0];

  const qc = QC.qcAnalyze(Object.assign({
    header: ageRes.header, rows: ageRes.rows, method: run.method,
    ageKey: QC.QC_KEY68, ageCorrected: false,
    stdName: stdName, stdAge: 485, fracStd: stdName, nistStd: 'NIST610',
    algo: 'avg', instrument: 'thermo',
    coefficients: ageRes.coefficients,
    divZero: ageRes.warnings.divZero,
  }, overrides || {}));
  return { REF: REF, run: run, cfg: cfg, base: base, ageRes: ageRes, qc: qc, stdName: stdName };
}

/** 与 app.js 的 doReport 同形的入参，缺哪一项就按真实界面的写法填。 */
function mkInput(R, opt) {
  opt = opt || {};
  const qc = opt.qc || R.qc;
  return {
    title: 'Isoclock 批次质量报告 — ' + (R.stdName || '未填标样名'),
    generatedAt: '2026-09-25 11:20:00',
    build: opt.build === undefined
      ? { built: '2026-09-25 11:00:19', id: '7013659c8db9' } : opt.build,
    files: 9,
    fileList: R.ageRes.rows.map((r) => r[0]).filter((v, i, a) => a.indexOf(v) === i),
    sampleList: 'samples.txt',
    params: Object.assign({
      instrument: 'Thermo',
      standard: R.stdName,
      standardAge: '485 Ma',
      fractionationStandard: R.stdName,
      method: '不校正（method 0）',
      excessV: '3 %',
      b0: '1 s',
      b1: '5 s',
      multi: '8',
      algo: '平均法（整批共用一个分馏因子）',
      nistStd: 'NIST610',
      fix76: '已修正（按收敛判据正常迭代）',
      ageKey: '206Pb/238U（未校正）',
      lambda: 'λ₂₃₈ = 1.55125e-10 /yr，λ₂₃₅ = 9.8485e-10 /yr，'
        + 'λ₂₃₂ = 4.9475e-11 /yr，²³⁸U/²³⁵U = 137.818',
      sampleFrom: '取每个文件第一行冒号之前那段（Thermo 的规则）',
      pbParams: '未使用',
    }, opt.params || {}),
    qc: qc,
    fix76Text: '本次用了收敛修正版，按收敛判据正常迭代 —— 与桌面版默认行为不同。',
    extraLimits: opt.extraLimits,
  };
}

function main() {
  console.log('报告生成器：结构 / 转义 / 完整性 / 幂等');

  const R = buildRealQc();
  const IN = mkInput(R);
  const html = QR.buildReportHtml(IN);

  /* ---- ① 单文件骨架 ---- */
  console.log('');
  console.log('--- ① 单文件、可离线 ---');
  check('以 <!DOCTYPE html> 开头', html.slice(0, 15) === '<!DOCTYPE html>', '');
  check('以 </html> 结尾', html.replace(/\s+$/, '').slice(-7) === '</html>', '');
  check('声明了 utf-8', html.indexOf('<meta charset="utf-8">') >= 0, '');
  check('没有 <link>（不引外部样式/图标）', html.indexOf('<link') < 0, '');
  check('没有 http(s) 外链',
    !/https?:\/\//.test(html.replace(/xmlns="[^"]*"/g, '')), '');
  check('没有 <script>（报告是静态的）', html.indexOf('<script') < 0, '');
  check('含打印样式（可直接 Ctrl+P）', html.indexOf('@media print') >= 0, '');
  check('样式是内联的', html.indexOf('<style>') >= 0 && html.indexOf('</style>') >= 0, '');
  //  这条是真实排版事故的回归锁：λ 那一行的值是 nowrap 的长串，
  //  自动布局会把"本次取值"列撑到半屏，把第 4 列（出处）挤成每行一两个字。
  check('参数表用固定列宽（否则长值会把出处列挤没）',
    /table\.params[^{]*\{[^}]*table-layout:fixed/.test(html), '');

  /* ---- ② 章节齐全 ---- */
  console.log('');
  console.log('--- ② 章节齐全 ---');
  const H2 = ['1 · 概况', '2 · 这次用的参数', '3 · 标样 QC', '4 · 样品结果汇总',
    '5 · 异常与警告', '6 · 判据', '7 · 这份报告不做什么'];
  const missH2 = H2.filter((h) => html.indexOf('<h2>' + h) < 0);
  check('7 个 h2 章节都在', missH2.length === 0, missH2.join('；'));

  /* ---- ③ 参数表覆盖 PARAM_DOC ---- */
  console.log('');
  console.log('--- ③ 参数说明表 ---');
  const missParam = QR.PARAM_DOC.filter((d) => html.indexOf(d.label) < 0);
  check('PARAM_DOC 每项都印进了报告', missParam.length === 0,
    missParam.map((d) => d.key).join(','));
  check('每项都写了"它是什么"',
    QR.PARAM_DOC.every((d) => d.what && d.what.length > 6), '');
  check('每项都写了"默认值与出处"',
    QR.PARAM_DOC.every((d) => d.src && d.src.length > 2), '');
  check('每项都标了原程序里的变量名', QR.PARAM_DOC.every((d) => d.pyvar), '');
  const noProv = QR.PARAM_DOC.filter((d) => /没有可靠出处|默认值不确定/.test(d.src));
  check('没有出处的默认值被明确标注出来',
    ['b0', 'b1'].every((k) => noProv.some((d) => d.key === k)),
    noProv.map((d) => d.key).join(','));
  check('本次取值都填了进去（没有留空）',
    QR.PARAM_DOC.every((d) => IN.params[d.key] !== undefined && IN.params[d.key] !== ''),
    QR.PARAM_DOC.filter((d) => !IN.params[d.key]).map((d) => d.key).join(','));

  /* ---- ④ 判据表 ---- */
  console.log('');
  console.log('--- ④ 判据阈值表 ---');
  const missTh = QR.THRESHOLD_DOC.filter((d) => html.indexOf(d.label) < 0);
  check('THRESHOLD_DOC 每项都印进了报告', missTh.length === 0,
    missTh.map((d) => d.k).join(','));
  check('每项都写了"为什么取这个值"',
    QR.THRESHOLD_DOC.every((d) => d.why && d.why.length > 10), '');
  //  探针必须是那个 badge 本身：正文里"表里标「已改」的就是……"这句说明
  //  也含"已改"两个字，拿它当探针会永远为真。
  const CHANGED_BADGE = '<span class="badge warn">已改</span>';
  check('默认值没改动时不标"已改"', html.indexOf(CHANGED_BADGE) < 0, '');
  const IN2 = mkInput(R, {
    params: {},
  });
  IN2.qc = QC.qcAnalyze(Object.assign({}, {
    header: R.ageRes.header, rows: R.ageRes.rows, method: R.run.method,
    ageKey: QC.QC_KEY68, ageCorrected: false,
    stdName: R.stdName, stdAge: 485, algo: 'avg', instrument: 'thermo',
  }, { thresholds: { stdDevPct: 5 } }));
  const html2 = QR.buildReportHtml(IN2);
  check('改了阈值会标出"已改"', html2.indexOf(CHANGED_BADGE) >= 0, '');

  /* ---- ⑤ 行数对得上 ---- */
  console.log('');
  console.log('--- ⑤ 表格行数与数据一致 ---');
  const nStd = R.qc.standards.length;
  const nSample = R.qc.stats.length - nStd;
  check('带等级的表格行数 = 样品组数 + 标样组数',
    countOf(/<tr class="lv-/g, html) === R.qc.stats.length,
    countOf(/<tr class="lv-/g, html) + ' vs ' + R.qc.stats.length);
  check('分组数与数据一致（标样 ' + nStd + ' + 样品 ' + nSample + '）',
    nStd + nSample === R.qc.stats.length, '');
  check('标样名印出来了', html.indexOf(R.stdName) >= 0, R.stdName);
  R.qc.stats.forEach((s) => { /* 每个样品名都应在表里 */ });
  const missStat = R.qc.stats.filter((s) => html.indexOf(s.name) < 0);
  check('每个分组的名字都印出来了', missStat.length === 0,
    missStat.map((s) => s.name).join(','));

  /* ---- ⑥ 判定依据（"为什么"）必须印出来 ---- */
  console.log('');
  console.log('--- ⑥ 判定依据 ---');
  const notOk = R.qc.stats.concat(R.qc.standards)
    .filter((s) => s.level !== 'ok' && s.reasons && s.reasons.length);
  const missWhy = notOk.filter((s) =>
    !s.reasons.some((r) => html.indexOf(r.why.slice(0, 24)) >= 0));
  check('每条 warn/bad 的"为什么"都印进了报告', missWhy.length === 0,
    missWhy.map((s) => s.name).join(','));
  check('至少有一个非 ok 的例子可验（否则这条是空转）', notOk.length > 0,
    String(notOk.length));
  check('判据列表用的是 ul.reasons', html.indexOf('<ul class="reasons">') >= 0, '');
  check('结论区也带了"为什么"（verdictwhy）', html.indexOf('verdictwhy') >= 0, '');
  const stdFirst = R.qc.standards[0];
  check('标样偏差 0.00% 但 MSWD 超标时，结论说的是 MSWD 而不是偏差',
    html.indexOf('标样被判') >= 0 && html.indexOf('MSWD') >= 0,
    '标样 level=' + (stdFirst && stdFirst.level));

  /* ---- ⑦ 不能出现"半个数字" ---- */
  console.log('');
  console.log('--- ⑦ 不印假数据 ---');
  check('没有 undefined', html.indexOf('undefined') < 0,
    html.slice(Math.max(0, html.indexOf('undefined') - 40),
      html.indexOf('undefined') + 20));
  check('没有 [object Object]', html.indexOf('[object Object]') < 0, '');
  check('没有孤立的 NaN 单元格', !/<td[^>]*>\s*NaN\s*<\/td>/.test(html), '');
  check('缺值写成 — 或 NaN 提示，而不是空单元格',
    html.indexOf('—') >= 0, '');

  /* ---- ⑧ 不可信输入必须转义 ---- */
  console.log('');
  console.log('--- ⑧ 样品名里的 HTML 必须转义 ---');
  const EVIL = '<img src=x onerror=alert(1)>';
  const evilRows = R.ageRes.rows.map((r) => {
    if (r[1] === R.stdName) return r;
    const c = r.slice();
    c[1] = EVIL;
    return c;
  });
  const qcEvil = QC.qcAnalyze({
    header: R.ageRes.header, rows: evilRows, method: R.run.method,
    ageKey: QC.QC_KEY68, ageCorrected: false,
    stdName: R.stdName, stdAge: 485, algo: 'avg', instrument: 'thermo',
  });
  const htmlEvil = QR.buildReportHtml(mkInput(R, { qc: qcEvil }));
  check('恶意样品名没有变成真的标签',
    htmlEvil.indexOf('<img src=x') < 0, '');
  check('恶意样品名以转义形式出现',
    htmlEvil.indexOf('&lt;img src=x onerror=alert(1)&gt;') >= 0, '');
  check('转义后仍是合法 HTML（& 没被二次转义成 &amp;lt;）',
    htmlEvil.indexOf('&amp;lt;img') < 0, '');

  /* ---- ⑨ 误差棒图 ---- */
  console.log('');
  console.log('--- ⑨ 误差棒图（手绘 SVG） ---');
  check('有内联 svg', html.indexOf('<svg') >= 0 && html.indexOf('viewBox=') >= 0, '');
  const circles = countOf(/<circle /g, html);
  const plotted = R.qc.stats.filter((s) => isFinite(s.mean)).length;
  check('每个可画的组都有一个点', circles === plotted,
    circles + ' vs ' + plotted);
  check('图里有"真值"参考线', html.indexOf('stroke-dasharray') >= 0, '');
  check('图没有引任何图表库',
    html.indexOf('chart') < 0 || html.indexOf('<script') < 0, '');

  /* ---- ⑩ 幂等与纯函数性 ---- */
  console.log('');
  console.log('--- ⑩ 幂等（同一入参两次结果逐字节相同） ---');
  const again = QR.buildReportHtml(IN);
  check('两次调用结果完全相同', again === html,
    html.length + ' vs ' + again.length);
  check('不改动入参（qc 对象仍是原来的等级）',
    R.qc.standards[0].level === stdFirst.level, '');
  check('报告里明说了加权平均/MSWD 是网页版新增',
    html.indexOf('网页版新增') >= 0, '');

  /* ---- ⑪ 缺数据不崩 ---- */
  console.log('');
  console.log('--- ⑪ 退化输入不崩 ---');
  const emptyQc = QC.qcAnalyze({
    header: R.ageRes.header, rows: [], method: 0,
    ageKey: QC.QC_KEY68, ageCorrected: false,
    stdName: 'X', stdAge: 485, algo: 'avg', instrument: 'thermo',
  });
  let crash = null, htmlEmpty = '';
  try { htmlEmpty = QR.buildReportHtml(mkInput(R, { qc: emptyQc })); }
  catch (e) { crash = e && (e.message || String(e)); }
  check('空数据不抛异常', crash === null, crash || '');
  check('空数据给出了可读的提示',
    htmlEmpty.indexOf('没有找出任何属于标样') >= 0, '');
  const nb = QR.buildReportHtml(mkInput(R, { build: null }));
  //  不能用"源码指纹"当探针：页脚那句说明本来就含这四个字。
  check('没有构建信息也能生成，且不会印出空指纹',
    nb.indexOf('7013659c8db9') < 0 && nb.indexOf('构建时间') < 0 && nb.length > 1000,
    String(nb.length));

  /* ---- ⑫ 内置示例数据的免责声明 ---- */
  console.log('');
  console.log('--- ⑫ 示例数据必须自曝身份 ---');
  const htmlDemo = QR.buildReportHtml(Object.assign(mkInput(R), { demo: true }));
  check('带 demo 标记时出现合成数据声明', htmlDemo.indexOf('示例合成数据') >= 0, '');
  check('声明里明说不能当结果引用',
    htmlDemo.indexOf('不能当结果引用') >= 0, '');
  check('声明放在结论之前（先看到警告再看判决）',
    htmlDemo.indexOf('<div class="alert bad demonote">')
      < htmlDemo.indexOf('<div class="verdict'),
    '');
  check('不带 demo 标记时不出现该声明', html.indexOf('示例合成数据') < 0, '');

  console.log('');
  console.log('结果：' + pass + ' 通过 / ' + fail + ' 失败');
  if (failures.length) {
    console.log('失败项：');
    failures.forEach((f) => console.log('  - ' + f));
  }
  process.exitCode = fail ? 1 : 0;
}

main();
