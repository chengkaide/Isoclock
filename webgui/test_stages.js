/* ==========================================================================
 *  test_stages.js —— 过程量（src/stages.js）的判据
 *
 *  用法:  node webgui/test_stages.js
 *
 *  这一套测的不是新算法（这个模块**一个数都不新算**），而是它有没有
 *  忠实搬运已有的中间量，以及那张表自己是不是自洽的：
 *      ① 列定义：数量、分组齐全、没有重名列，单位都在
 *      ② 每一格都能追回到来源 —— 均值追 meanRows、净计数 5 通道追 result_all、
 *         比值与年龄逐列追 ageRes.rows，全是**逐位相等**
 *      ③ 补出来的两列（²⁰²Hg / ²⁰⁴Pb）确实等于"信号均值 − 背景均值"
 *      ④ 窗口列与 pipeline 的切片钳制规则一致（含越界的那种情形）
 *      ⑤ 行数、索引、文件名唯一性 —— 表跟年龄表一行对一行
 *      ⑥ meta 里的全局量（分馏因子、微量元素系数）与 ageRes 逐位相等
 *      ⑦ CSV：BOM、`#` 段、表头列数与数据列数一致、浮点走 Python repr
 *      ⑧ sampleChain 的分段与 GROUPS 一致，且校正列随 method 变
 *
 *  数据用内置的那 49 个真实文件 —— 与 test_api.js 同源，跑的是真管线。
 * ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HERE = __dirname;
const SRC = path.join(HERE, 'src');

const sandbox = {
  window: {}, console,
  DecompressionStream: globalThis.DecompressionStream,
  Blob: globalThis.Blob, Response: globalThis.Response,
  atob: globalThis.atob, TextDecoder: globalThis.TextDecoder,
};
vm.createContext(sandbox);
for (const f of ['fp.js', 'math.js', 'thermo.js', 'window.js', 'report.js',
                 'pipeline.js', 'age.js', 'qc.js', 'stages.js', 'demo_real.js']) {
  vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), sandbox, { filename: f });
}
for (const f of ['api.js']) {
  vm.runInContext(fs.readFileSync(path.join(HERE, 'ui', f), 'utf8'), sandbox,
    { filename: 'ui/' + f });
}

const API = sandbox.window.DS_API;
const ST = sandbox.window.DS_STAGES;
const RP = sandbox.window.DS_REPORT;
const QC = sandbox.window.DS_QC;
const DS = sandbox.window.DS;

let pass = 0, fail = 0;
const rows = [];
function t(name, ok, detail) {
  if (ok) pass++; else fail++;
  rows.push([ok, name, detail === undefined ? '' : String(detail)]);
  return ok;
}
/** 逐位相等（NaN 视作相等 —— 真数据里本来就有 NaN 格）。 */
function bitEq(a, b) { return Object.is(a, b) || (Number.isNaN(a) && Number.isNaN(b)); }

async function main() {
  if (!ST) { console.log('DS_STAGES 没挂上 —— 加载失败'); process.exit(1); }
  if (!API) { console.log('DS_API 没挂上 —— 加载失败'); process.exit(1); }

  /* ---------------------------------------------------------------- ① */
  t('过程量模块存在，且是 api.js 要求的必需模块之一',
    !!ST && API.capabilities().ready === true,
    '缺少的模块：' + API.capabilities().missingModules.join('、'));
  t('capabilities() 报出过程量的分组（顺序即列的顺序）',
    API.capabilities().stageGroups.length === Object.keys(ST.GROUPS).length,
    API.capabilities().stageGroups.map((g) => g.value).join(' -> '));

  /* ---------------------------------------------------------------- 数据 */
  const DD = sandbox.window.DS_DEMO_REAL;
  const files = await DD.decode();
  const params = Object.assign({}, DD.params, { method: 1 });   // 用有校正列的那一档
  const C = API.compute(params, files, { keepRaw: true });       // 顶层就带全部中间量
  const SRC = C.out || C;
  if (!C.ok) {
    console.log('算不通：' + C.errors.map((e) => e.message).join('；'));
    process.exit(1);
  }
  const model = ST.buildStages(SRC, C.ageRes, C.cfg,
    { QC: QC, untagInt: DS.untagInt, buildId: 'abc', generatedAt: '2026-01-01 00:00:00' });

  /* ---------------------------------------------------------------- ② */
  const cols = model.columns;
  const wantCols = 3 + 8 + 14 + 7 + 14 + 8 + 4 + 3;             // 见下
  t('列数 = 标识3 + 窗口8 + 均值14 + 净计数7 + 比值14 + 年龄8 + 校正4 + 微量元素3',
    cols.length === wantCols, cols.length + ' 列（要 ' + wantCols + '）');
  const keys = cols.map((c) => c.key);
  t('没有重名的列', new Set(keys).size === keys.length,
    keys.length + ' 列 / ' + new Set(keys).size + ' 个不同键');
  t('每个分组都有列，且顺序按 id→win→cnt→net→ratio→age→trace',
    JSON.stringify([...new Set(cols.map((c) => c.g))]) ===
      JSON.stringify(['id', 'win', 'cnt', 'net', 'ratio', 'age', 'trace']),
    [...new Set(cols.map((c) => c.g))].join(','));
  t('带单位的列在表头里印了单位（cps / ppm / s）',
    ST.colHeader(cols.find((c) => c.key === 'n_Pb206')) === '²⁰⁶Pb (cps)'
    && ST.colHeader(cols.find((c) => c.key === 'U')) === 'U (ppm)'
    && ST.colHeader(cols.find((c) => c.key === 'ti')) === '采样间隔 (s)'
    && ST.colHeader(cols.find((c) => c.key === 'sample')) === '样品名');
  t('每个分组都有口径说明（不然表里的数没人知道是怎么来的）',
    Object.keys(ST.GROUPS).every((g) => typeof ST.GROUP_NOTE[g] === 'string'
      && ST.GROUP_NOTE[g].length > 10),
    Object.keys(ST.GROUPS).join(','));

  /* ---------------------------------------------------------------- 行数/索引 */
  t('行数与年龄表一行对一行',
    model.rows.length === C.ageRes.rows.length,
    model.rows.length + ' 行 / 年龄表 ' + C.ageRes.rows.length + ' 行');
  t('每一行都有对应 byFile 索引，且指向的就是那一行（不是副本）',
    C.ageRes.rows.every((r, i) => model.byFile[r[0]] && model.byFile[r[0]].index === i
      && model.byFile[r[0]].row === model.rows[i]));
  t('文件名在表里唯一（byFile 不会互相覆盖）',
    Object.keys(model.byFile).length === model.rows.length,
    Object.keys(model.byFile).length + ' 个键');
  t('样品名来源也搬进来了（' + Object.keys(ST.SAMPLE_FROM_TEXT).join('/') + '）',
    Object.keys(model.byFile).every((f) =>
      Object.keys(ST.SAMPLE_FROM_TEXT).indexOf(model.byFile[f].sampleFrom) >= 0),
    Array.from(new Set(Object.keys(model.byFile).map((f) => model.byFile[f].sampleFrom)))
      .join(','));

  /* ---------------------------------------------------------------- ③ 逐位搬运 */
  const ci = {};
  cols.forEach((c, i) => { ci[c.key] = i; });
  const meanByFile = ST.indexMeanRows(SRC.meanRows);
  const resByFile = ST.indexResultRows(SRC.resultRows);

  let badCnt = 0, badMean = 0;
  for (const r of C.ageRes.rows) {
    const file = r[0];
    const row = model.byFile[file].row;
    const mr = meanByFile[file];
    const rr = resByFile[file];
    ST.STAGE_CHANNELS.forEach((c, i) => {
      if (!bitEq(row[ci['b_' + c.key]], mr[2 + i])) badCnt++;
      if (!bitEq(row[ci['s_' + c.key]], mr[9 + i])) badCnt++;
      //  五通道净计数必须就是 result_all 那一列的原值
      if (c.netCol !== null && !bitEq(row[ci['n_' + c.key]], rr[c.netCol])) badCnt++;
    });
    //  比值 / 年龄 / 微量元素逐列追
    for (const x of ST.STAGE_RATIOS) {
      if (!bitEq(row[ci['r' + x.c]], r[x.c]) || !bitEq(row[ci['r' + x.c + '_2s']], r[x.c + 1])) badMean++;
    }
    for (const x of ST.STAGE_AGES) {
      if (!bitEq(row[ci['age' + x.c]], r[x.c]) || !bitEq(row[ci['age' + x.c + '_2s']], r[x.c + 1])) badMean++;
    }
    if (!bitEq(row[ci.U], r[47]) || !bitEq(row[ci.Th], r[48]) || !bitEq(row[ci.Pb], r[49])) badMean++;
    //  序号取 result_all 的 No.（可能带 int 标记）
    if (!bitEq(row[ci.no], DS.untagInt(rr[0]))) badMean++;
  }
  t('21 个均值列与 5 个净计数列逐位取自 Mean_Cps / result_all',
    badCnt === 0, badCnt ? badCnt + ' 格对不上' : '49 行 × 26 格全部逐位相等');
  t('比值 + 年龄 + 微量元素 + 序号逐位取自年龄表',
    badMean === 0, badMean ? badMean + ' 格对不上' : '49 行逐位相等');

  /* ---------------------------------------------------------------- ④ 补出来的两列 */
  let bad补 = 0;
  for (const r of C.ageRes.rows) {
    const row = model.byFile[r[0]].row;
    for (const k of ['Hg202', 'Hg204']) {
      const want = row[ci['s_' + k]] - row[ci['b_' + k]];
      if (!bitEq(row[ci['n_' + k]], want)) bad补++;
    }
  }
  t('²⁰²Hg / ²⁰⁴Pb 的净计数 = 信号均值 − 背景均值（这两列 result_all 里没有）',
    bad补 === 0, bad补 ? bad补 + ' 格对不上' : '98 格全部相等');
  t('五通道净计数的来源与另两列不同 —— 列定义里标了出来',
    ST.STAGE_CHANNELS.filter((c) => c.netCol === null).map((c) => c.key)
      .join(',') === 'Hg202,Hg204',
    '补出来的：' + ST.STAGE_CHANNELS.filter((c) => c.netCol === null)
      .map((c) => c.key).join(','));

  /* ---------------------------------------------------------------- ⑤ 窗口 */
  const badWin = [];
  for (const r of C.ageRes.rows) {
    const file = r[0];
    const row = model.byFile[file].row;
    const num = SRC.num[file];
    const idx = SRC.idx[file];
    if (row[ci.n] !== num[0]) badWin.push(file + ':n');
    if (!bitEq(row[ci.ti], idx.ti)) badWin.push(file + ':ti');
    if (row[ci.b0] !== num[1] || row[ci.b1] !== num[2]) badWin.push(file + ':b');
    if (row[ci.s0] !== num[3] || row[ci.s1] !== num[4]) badWin.push(file + ':s');
    if (row[ci.nb] !== ST.sliceLen(num[0], idx.sb, idx.eb)) badWin.push(file + ':nb');
    if (row[ci.ns] !== ST.sliceLen(num[0], idx.ss, idx.es)) badWin.push(file + ':ns');
  }
  t('窗口的 8 列都与 pipeline 的 num / idx 一致（含切片钳制后的点数）',
    badWin.length === 0, badWin.length ? badWin.slice(0, 5).join(' ') : '49 行全对');
  t('采样间隔与切片实际用的那一份一致（全局 Timeinternal）',
    SRC.tiGlobal !== undefined
    && C.ageRes.rows.every((r) => model.byFile[r[0]].row[ci.ti] === SRC.tiGlobal),
    'tiGlobal = ' + SRC.tiGlobal);

  /* sliceLen 的钳制规则必须与 pySlice 逐条一致 —— 直接对几个边界值验 */
  const clamp = [
    [10, 2, 5, 3], [10, -3, 10, 3], [10, 0, 99, 10], [10, 5, 2, 0],
    [10, 99, 99, 0], [0, 0, 5, 0], [10, -20, 2, 2],
  ];
  const PL = sandbox.window.DS_PIPELINE;
  t('sliceLen() 与 pipeline.pySlice() 的长度逐条一致（含负索引/越界/空段）',
    clamp.every(([len, s, e, want]) =>
      ST.sliceLen(len, s, e) === want
      && PL.pySlice(new Float64Array(len), s, e).length === want),
    clamp.map(([l, s, e]) => l + '[' + s + ':' + e + ']').join(' '));

  t('背景窗与信号窗取的都不是零个点（真数据上窗口识别正常）',
    model.rows.every((r) => r[ci.nb] > 0 && r[ci.ns] > 0),
    '最小背景 ' + Math.min(...model.rows.map((r) => r[ci.nb]))
    + ' 点，最小信号 ' + Math.min(...model.rows.map((r) => r[ci.ns])) + ' 点');

  /* ---------------------------------------------------------------- ⑥ meta */
  const metaOf = (k) => { const x = model.meta.find((m) => m.k === k); return x && x.v; };
  t('meta 里有分馏因子，且与 ageRes.factors 逐位相等',
    bitEq(metaOf('分馏因子 f(206/238)'), C.ageRes.factors.f206_238)
    && bitEq(metaOf('分馏因子 f(207/206)'), C.ageRes.factors.f207_206)
    && bitEq(metaOf('分馏因子 f(207/235)'), C.ageRes.factors.f207_235)
    && bitEq(metaOf('分馏因子 f(208/232)'), C.ageRes.factors.f208_232),
    'f(206/238) = ' + metaOf('分馏因子 f(206/238)'));
  t('meta 里有标样比值的相对 2s（分馏因子分子的那一侧）',
    bitEq(metaOf('标样 206Pb/238U 的相对 2s'), C.ageRes.factors.std_68_2s)
    && bitEq(metaOf('标样 207Pb/235U 的相对 2s'), C.ageRes.factors.std_75_2s),
    'std_68_2s = ' + metaOf('标样 206Pb/238U 的相对 2s')
    + '，std_75_2s = ' + metaOf('标样 207Pb/235U 的相对 2s'));
  t('meta 里有微量元素系数，且与 ageRes.coefficients 逐位相等',
    bitEq(metaOf('微量元素系数 U238'), C.ageRes.coefficients[0])
    && bitEq(metaOf('微量元素系数 Th232'), C.ageRes.coefficients[1])
    && bitEq(metaOf('微量元素系数 Pb'), C.ageRes.coefficients[2]),
    'U/Th/Pb = ' + [0, 1, 2].map((i) => C.ageRes.coefficients[i]).join(' / '));
  t('meta 里印了构建指纹与生成时间（表要能自证是哪一版算的）',
    metaOf('构建指纹') === 'abc' && metaOf('生成时间') === '2026-01-01 00:00:00');
  t('meta 里的 Ɛ 换算成百分数印出（界面上填的就是百分数）',
    /%/.test(metaOf('外挂误差 Ɛ')), metaOf('外挂误差 Ɛ'));
  t('meta 里说明 Ɛ 不改年龄（这条口径必须印在表上）',
    /不改变年龄/.test(metaOf('外挂误差 Ɛ')));

  /* ---------------------------------------------------------------- ⑦ CSV */
  const csv = ST.stagesCsv(model, { fmt: RP.pyFloatRepr });
  t('CSV 以 UTF-8 BOM 开头（Excel 双击打开时中文表头不乱码）',
    csv.charAt(0) === '\ufeff', '首字符码位 U+' + csv.charCodeAt(0).toString(16));
  t('CSV 用 CRLF 换行（与另外几个导出一致）',
    csv.indexOf('\r\n') > 0 && csv.split('\r\n').length === csv.split('\n').length,
    '行数 ' + csv.split('\r\n').length);

  //  拆行前先摘掉 BOM —— 否则第一行会被当成数据行，后面全部错位
  const lines = csv.replace(/^\ufeff/, '').split('\r\n').filter((l) => l.length);
  const hash = lines.filter((l) => l.charAt(0) === '#');
  const data = lines.filter((l) => l.charAt(0) !== '#');
  t('CSV 的数据行 = 一行表头 + 全部样品行',
    data.length === model.rows.length + 1,
    data.length + ' 行（表头 1 + 数据 ' + model.rows.length + '）');
  t('CSV 的元信息段把 meta 全部印进去了（一条不落）',
    model.meta.every((m) => hash.some((l) => l.indexOf(m.k) >= 0)),
    hash.length + ' 条 # 行');
  t('CSV 的元信息段里也印了每个分组的口径（表离开页面也说得清）',
    Object.keys(ST.GROUPS).every((g) =>
      hash.some((l) => l.indexOf(ST.GROUPS[g]) > 0)));

  /* 列数与每行的字段数 —— 用与写 CSV 相同的那套引号规则去拆 */
  function splitCsvLine(line) {
    const out = [];
    let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line.charAt(i);
      if (q) {
        if (ch === '"') { if (line.charAt(i + 1) === '"') { cur += '"'; i++; } else q = false; }
        else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',') { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out;
  }
  const head = splitCsvLine(data[0]);
  t('表头字段数 = 列定义数', head.length === cols.length,
    head.length + ' / ' + cols.length);
  t('表头每一格就等于列标签（带单位）',
    head.every((h, i) => h === ST.colHeader(cols[i])),
    head.slice(0, 3).join(' | '));
  const body = data.slice(1).map(splitCsvLine);
  t('每个数据行的字段数都与表头相同（没有错位）',
    body.every((b) => b.length === head.length),
    '最大 ' + Math.max(...body.map((b) => b.length)) + ' / 最小 '
      + Math.min(...body.map((b) => b.length)));

  /* 浮点排版必须走 Python repr —— 与另外两个 CSV 同一套。
   * 判据取"能原样读回"：repr 是最短往返表示，Number() 读回来必须逐位相等； */
  let roundTrip = 0, badNum = 0;
  model.rows.forEach((r, i) => {
    r.forEach((v, k) => {
      if (typeof v !== 'number' || !isFinite(v)) return;
      roundTrip++;
      const cell = body[i][k];
      if (!(cell === RP.pyFloatRepr(v)) || Number(cell) !== v) badNum++;
    });
  });
  t('CSV 里每个有限数都能用 Number() 原样读回（Python repr 是往返表示）',
    badNum === 0 && roundTrip > 1000,
    roundTrip + ' 个有限数，' + badNum + ' 个读不回');
  t('CSV 里没有 JS 的 "NaN"/"Infinity" 字样（Python 印的是 nan / inf）',
    csv.indexOf('NaN') < 0 && csv.indexOf('Infinity') < 0,
    (csv.match(/NaN|Infinity/g) || []).join(','));
  const nanCells = model.rows.reduce((a, r) =>
    a + r.filter((v) => typeof v === 'number' && Number.isNaN(v)).length, 0);
  const nanText = body.reduce((a, b) => a + b.filter((c) => c === 'nan').length, 0);
  t('CSV 里 nan 的个数与 model.rows 里 NaN 的个数相同（一格不多一格不少）',
    nanCells === nanText, '模型 ' + nanCells + ' 个 / 文本 ' + nanText + ' 个');

  /* 改一行一个值，CSV 必须跟着变 —— 说明它真的是从 rows 拼的，不是另算一份 */
  const row0 = model.rows[0];
  const csvCell0 = splitCsvLine(data[1])[ci.age17];
  t('CSV 第 1 行第 17 个年龄列与 model.rows[0] 同源',
    csvCell0 === RP.pyFloatRepr(row0[ci.age17]),
    csvCell0 + ' == repr(' + row0[ci.age17] + ')');

  /* ---------------------------------------------------------------- ⑧ sampleChain */
  const file0 = C.ageRes.rows[0][0];
  const chain = ST.sampleChain(model, file0);
  t('sampleChain() 给出全部分段，顺序与 GROUPS 一致',
    chain.map((s) => s.group).join(',') === Object.keys(ST.GROUPS).join(','),
    chain.map((s) => s.group).join(','));
  t('每个分段的标题与口径说明都来自 GROUPS / GROUP_NOTE（不另写一套）',
    chain.every((s) => s.title === ST.GROUPS[s.group] && s.note === ST.GROUP_NOTE[s.group]));
  t('每个分段都有条目', chain.every((s) => s.items.length > 0),
    chain.map((s) => s.items.length).join('/'));
  t('净计数分段给七个通道都留了出处（补出来的那两列标明了）',
    chain.find((s) => s.group === 'net').items.filter(
      (i) => /网页版按均值相减补出/.test(i.value)).length === 2);
  t('比值分段印的是"值 ± 2s"两个数（不是只给一个）',
    chain.find((s) => s.group === 'ratio').items.every((i) => / ± /.test(i.value)),
    chain.find((s) => s.group === 'ratio').items[0].value);
  t('窗口分段印了背景段/信号段各取了几个点',
    chain.find((s) => s.group === 'win').items.some((i) => i.name === '背景段取点数')
    && chain.find((s) => s.group === 'win').items.some((i) => i.name === '信号段取点数'));
  t('method=1 时年龄分段里有两条"校正后"（207Pb 校正是 207/235 与 206/238）',
    chain.find((s) => s.group === 'age').items.filter(
      (i) => i.name.indexOf('校正后') === 0).length === 2
    && chain.find((s) => s.group === 'age').items.filter(
      (i) => i.name.indexOf('校正后') === 0).every((i) => !/—\s*$/.test(i.value)),
    chain.find((s) => s.group === 'age').items.map((i) => i.name).join(' / '));
  t('未知文件名返回空数组，不抛异常', ST.sampleChain(model, '不存在.csv').length === 0);

  /* method 0 时没有校正列；method 4 的校正列换成另一对 */
  const m0 = ST.columnsFor(0, { QC: QC });
  const m4 = ST.columnsFor(4, { QC: QC });
  t('method 0 没有"校正后"列（原程序那条路径不做校正）',
    !m0.some((c) => c.key.indexOf('corr') === 0),
    m0.length + ' 列');
  t('method 4 的校正列键是 206Pb/238U 与 208Pb/232Th（与 qc.js 一致）',
    m4.filter((c) => c.key.indexOf('corr') === 0 && c.key.indexOf('_2s') < 0)
      .map((c) => c.label).join(',') === '校正后 206Pb/238U,校正后 208Pb/232Th',
    m4.filter((c) => c.key.indexOf('corr') === 0 && c.key.indexOf('_2s') < 0)
      .map((c) => c.label).join(','));
  t('method 0/4 的列数差异只来自校正列（其余列一致）',
    m4.length === m0.length + 4, m0.length + ' -> ' + m4.length);

  /* ---------------------------------------------------------------- api 门面 */
  const st2 = API.stages(C, { keepByFile: true, csv: true, generatedAt: '2026-01-01 00:00:00' });
  t('DS_API.stages() 走同一段代码：列数与行数与直接调用一致',
    st2.ok && st2.columns.length === model.columns.length
    && st2.rows.length === model.rows.length,
    st2.ok ? st2.rows.length + ' 行 × ' + st2.columns.length + ' 列' : st2.errors[0].message);
  t('DS_API.stages() 的 csv 就是它返回的那张表的 CSV 序列化（不是另算一份）',
    st2.csv === ST.stagesCsv({ columns: st2.columns, rows: st2.rows, meta: st2.meta },
      { fmt: RP.pyFloatRepr }),
    st2.csv.length + ' 字符');
  t('DS_API.stages() 不传 keepByFile 时就不带 byFile（给智能体的返回要瘦）',
    API.stages(C, {}).byFile === undefined);
  t('DS_API.stages() 缺结果时返回 NO_RESULT 而不是抛异常',
    API.stages(null, {}).errors[0].code === 'NO_RESULT');
  t('DS_API.sampleChain() 与 ST.sampleChain() 同一份',
    API.sampleChain(st2, file0).length === chain.length);
  const runS = API.run(params, files, { stages: true, quality: false, generatedAt: 'x' });
  t('DS_API.run({stages:true}) 把过程量表附在结果里',
    runS.ok && runS.stages && runS.stages.rows.length === model.rows.length,
    runS.ok ? (runS.stages ? runS.stages.rows.length + ' 行' : '没附上') : '跑不通');
  t('不显式要就不附（默认返回的体积不变）',
    API.run(params, files, { quality: false }).stages === undefined);

  /* ---------------------------------------------------------------- 结果 */
  console.log('');
  for (const [ok, name, detail] of rows) {
    console.log('  ' + (ok ? 'ok ' : 'FAIL') + '  ' + name
      + (detail ? '\n          ' + detail : ''));
  }
  console.log('');
  console.log('总计 ' + rows.length + ' 项：通过 ' + pass + '，失败 ' + fail);
  if (!fail) console.log('全部通过。');
  process.exit(fail ? 1 : 0);
}

main();
