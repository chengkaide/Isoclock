/* ==========================================================================
 *  test_agilent_e2e.js —— Agilent 数据的**整条链**验证
 *
 *  为什么单独有这个文件：`test_agilent.js` 只测读取器本身（9/9 通过），
 *  但"读取器对"不代表"链路通"。界面上漏把仪器传给轻量解析那一步时，
 *  Agilent 的数据会在文件列表里全部显示"解析失败"，于是标样筛选为空、
 *  平均法直接 return —— 读取器测试全绿也发现不了。这个文件补的就是这一段。
 *
 *  判据里最硬的一条是**双格式一致性**：同一组计数率分别写成 Thermo 格式与
 *  Agilent 格式，两条读取路径给出的两个 CSV 应逐字节相同、年龄表应逐位相同。
 *  它不依赖 Python 参考值，却能把"两条路走岔了"直接抓出来。
 *
 *  用法:  node webgui/test_agilent_e2e.js
 * ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, 'src');

/* ---------- 加载模块并接线（顺序与 ui/app.js、test_e2e.js 一致）---------- */
const sandbox = { window: {}, console };
vm.createContext(sandbox);
for (const f of ['fp.js', 'math.js', 'thermo.js', 'window.js', 'report.js',
  'pipeline.js', 'age.js']) {
  vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), sandbox, { filename: f });
}
const W = sandbox.window;
const DS = W.DS, TH = W.DS_THERMO, RP = W.DS_REPORT;
const PL = W.DS_PIPELINE, AGE = W.DS_AGE, FP = W.DS_FP;
W.DS_WINDOW.setNumeric(DS);
PL.attach({
  thermoLoad: TH.thermoLoad,
  agilentLoad: TH.agilentLoad,
  thermoSampleName: TH.thermoSampleName,
  detectSignalWindow: W.DS_WINDOW.detectSignalWindow,
  nmean: DS.nmean,
  untagInt: DS.untagInt,
  reduceSample: DS.reduceSample,
  buildMeanCpsCsv: RP.buildMeanCpsCsv,
  buildResultAllCsv: RP.buildResultAllCsv,
});
AGE.attach({
  pwSum: DS.pwSum, nnanmean: DS.nnanmean,
  age76Pb: DS.age76Pb, age76PbFixed: DS.age76PbFixed, sk2model: DS.sk2model,
});

/* ---------- 计数工具 ---------- */
let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) pass++; else fail++;
  console.log((ok ? '  ok  ' : ' FAIL ') + name.padEnd(38) + (detail || ''));
}

/* ---------- 标样年龄 → 反推"目标比值" → 用它造数据 ----------
 * 各通道的**净**计数率（信号段 − 背景段）之比，直接取 485 Ma 应有的比值：
 *     206Pb/238U = a(485)，207Pb/206Pb = P382(485)，208Pb/232Th = c(485)
 * 这样做有两个好处：
 *   ① 标样法的校正因子 f 落在 0 附近（合理区间）。若比值与标称年龄差得远，
 *      f 会大于 1，`n6*(1-f)` 变成负数，206Pb/238U 就是负的，看着像"算法坏了"；
 *   ② 年龄层算出来的年龄应当就是 485 Ma 上下 —— 测试于是能验"数量对不对"，
 *      而不只是"有没有 NaN"。
 */
const N = 60;
const B0 = 2, B1 = 6, MULTI = 4;
const SIG_A = 20, SIG_B = 50;
const STD_AGE = 485;

/** 标样年龄折算出的那套常数（与 ui/app.js 的 calAge 同一套写法）。 */
function calAge(age) {
  const a = FP.dexp(0.000000000155125 * age * 1000000) - 1;
  const b = FP.dexp(0.00000000098485 * age * 1000000) - 1;
  const c = FP.dexp(0.000000000049475 * age * 1000000) - 1;
  const Q8 = 18.700 - a * 9.735;
  const R8 = 15.628 - b * (9.735 / 137.818);
  return { a, b, c, Q8, R8, S8: 38.630 - c * 36.837,
    P382: 1 / 137.818 * (b / a), Pbc: R8 / Q8, Standard_age: age };
}

const CAL = calAge(STD_AGE);
const BG = 50;                   // 背景段计数率（所有通道相同，便于反推）
const U_NET = 100000;
const TH_NET = 20000;
const NET = [
  3000,                          // 202Hg
  5000,                          // 204Pb
  U_NET * CAL.a,                 // 206Pb：使 206Pb/238U = a(485)
  U_NET * CAL.a * CAL.P382,      // 207Pb：使 207Pb/206Pb = P382(485)
  TH_NET * CAL.c,                // 208Pb：使 208Pb/232Th = c(485)
  TH_NET,                        // 232Th
  U_NET,                         // 238U
];

function colOf(j) {
  const out = new Array(N);
  for (let i = 0; i < N; i++) {
    const inSig = (i >= SIG_A && i < SIG_B);
    const base = inSig ? (BG + NET[j]) : BG;
    //  × (1 + 0.02*(i%3)) 是必须的：每段**完美恒定**时，2σ 过滤的条件
    //  `|x-avg| < 2*sd` 退化成 `0 < 0`，整列会被当成离群点全部剔除、均值变 NaN。
    //  2% 的周期性起伏让 sd 有实在的值，又保证所有点都在 mean±2σ 以内。
    out[i] = base * (1 + 0.02 * (i % 3));
  }
  return out;
}
const COLS = [];
for (let j = 0; j < 7; j++) COLS.push(colOf(j));

/**
 * 时间列。步长 0.9 s 是有讲究的：
 *   窗口下标 = int(秒 / timeinternal)，timeinternal 又约等于步长，
 *   于是 int(s0/ti) ≈ 起点下标 + 1/ti。步长 ≤ 1 s 才能让 1/ti ≥ 1，
 *   切片起点才**落进平台内**（步长 2 s 时切片会沾上平台前的那个背景点，
 *   而净信号是"信号减背景均值"，那一点恰好为 0 → 比值 0/0 → 整列 NaN）。
 */
function timeText(i) {
  return (i * 0.9).toFixed(4);
}

/* ---------- 两种格式的文件构造 ---------- */

/** Thermo：前 13 行是元信息（第 1 行放样品名），第 14 行列名，第 15 行单位。 */
function thermoFile(sample, which) {
  const lines = [sample + ': synthetic test export'];
  for (let k = 1; k <= 12; k++) {
    lines.push('Thermo Fisher iCAP  meta line ' + String(k).padStart(2, '0'));
  }
  lines.push(TH.THERMO_ISONAME.join(',') + ',Note');
  lines.push(['sec'].concat(new Array(7).fill('cps')).concat(['txt']).join(','));
  for (let i = 0; i < N; i++) {
    const cells = [timeText(i)];
    for (let j = 0; j < 7; j++) cells.push(String(COLS[j][i]));
    cells.push('ok');
    lines.push(cells.join(','));
  }
  void which;
  return lines.join('\r\n') + '\r\n';
}

/** Agilent：前 3 行是元信息，第 4 行列名，第 5 行单位（对应 skiprows=3）。 */
function agilentFile(which) {
  const lines = [];
  for (let k = 1; k <= 3; k++) lines.push('Agilent 7500  meta line ' + k);
  lines.push(['时间 [s]', '202', '204Pb', '206Pb', '207Pb', '208Pb', '232Th', '238U']
    .join(','));
  lines.push(['sec'].concat(new Array(7).fill('cps')).join(','));
  for (let i = 0; i < N; i++) {
    const cells = [timeText(i)];
    for (let j = 0; j < 7; j++) cells.push(String(COLS[j][i]));
    lines.push(cells.join(','));
  }
  void which;
  return lines.join('\r\n') + '\r\n';
}

/* ---------- 标样 / 样品清单 ---------- */
const STD_NAME = 'MAD-NEW';
const STD_FILES = ['STD1', 'STD2', 'STD3', 'STD4'];
const SMP_FILES = ['S1', 'S2', 'S3', 'S4'];
const ALL = STD_FILES.concat(SMP_FILES);

//  Thermo：样品名写在每个文件的第一行
const THERMO_FILES = ALL.map((k) => ({
  file: k + '.csv',
  text: thermoFile(k.indexOf('STD') === 0 ? STD_NAME : k),
}));
//  Agilent：文件里没有样品名，得靠清单
const AGILENT_FILES = ALL.map((k) => ({ file: k + '.csv', text: agilentFile() }));
const SAMPLE_LIST = {};
ALL.forEach((k) => { SAMPLE_LIST[k] = k.indexOf('STD') === 0 ? STD_NAME : k; });

const AGE_CFG = {
  method: 0, excessV: 0.05, nistStd: 'NIST610', standard: STD_NAME,
  age: 100, radioactivePb: 0.048015, commonPb: 0.842185,
  commonPb206_208: 0.48240, commonPb207_208: 0.40628,
  commonPb206_204: 18.5478, commonPb207_204: 15.6207,
  commonPb208_204: 38.447, radioactiveSPb207_206: 0,
};

/** 跑一整条链：读取 → 窗口 → 还原 → 两个 CSV → 年龄表。 */
function runChain(files, inst, sampleNames) {
  const stdSet = {}; stdSet[STD_NAME] = STD_AGE;
  const cal = CAL;
  const out = PL.run({
    files,
    isoname: inst === 'agilent' ? TH.AGILENT_ISONAME : TH.THERMO_ISONAME,
    b0: B0, b1: B1, multi: MULTI,
    stdcor: 0, method: 0, standardNames: stdSet,
    ctx: cal, eleIndex: 2, instrument: inst,
    sampleNames: sampleNames || null,
  });
  const input = AGE.buildInput(out.resultAllCsv, out.meanCpsCsv, null);
  input.fix76 = true;
  const cfg = Object.assign({}, AGE_CFG);
  cfg.P382 = cal.P382; cfg.a = cal.a; cfg.b = cal.b; cfg.c = cal.c; cfg.Pbc = cal.Pbc;
  cfg.radioactiveSPb207_206 = cal.P382;      // 平均法 method 0 用不到，给个确定值
  input.cfg = cfg;
  return { out, age: AGE.averageAge(input) };
}

/** 逐位比较两张年龄表。 */
function cmpAge(tag, a, b) {
  if (a.header.join('\u0001') !== b.header.join('\u0001')) {
    const i = a.header.findIndex((h, k) => h !== b.header[k]);
    check(tag + ' 表头', false, `第 ${i} 列 js=${a.header[i]} py=${b.header[i]}`);
    return;
  }
  let bad = 0, first = null;
  for (let r = 0; r < a.rows.length; r++) {
    for (let c = 0; c < a.rows[r].length; c++) {
      const x = a.rows[r][c], y = b.rows[r][c];
      const same = (typeof x === 'string' || typeof y === 'string') ? x === y : Object.is(x, y);
      if (!same) { bad++; if (!first) first = `[${r},${c}] ${x} vs ${y}`; }
    }
  }
  check(tag, bad === 0,
    bad ? `${bad} 格不同，首个 ${first}`
      : `${a.rows.length} 行 × 51 列逐位相同`);
}

/* ====================================================================== */
function main() {
  console.log('Agilent 端到端：读取 → 积分窗口 → 还原 → 年龄层');
  console.log(`  ${ALL.length} 个文件 × ${N} 点，背景 ${B0}-${B1}s，阈值 ${MULTI} 倍`);
  console.log('');

  /* --- ① 两条链都能跑通，且样品名正确 --- */
  console.log('--- ① 样品名与标样筛选 ---');
  const therm = runChain(THERMO_FILES, 'thermo', null);
  const agiList = runChain(AGILENT_FILES, 'agilent', SAMPLE_LIST);

  const wantNames = {};
  ALL.forEach((k) => { wantNames[k + '.csv'] = SAMPLE_LIST[k]; });
  check('Thermo 样品名（读第一行）',
    JSON.stringify(therm.out.sampleslist) === JSON.stringify(wantNames),
    JSON.stringify(therm.out.sampleslist));
  check('Agilent 样品名（来自清单）',
    JSON.stringify(agiList.out.sampleslist) === JSON.stringify(wantNames),
    JSON.stringify(agiList.out.sampleslist));
  check('Agilent 清单命中来源标记',
    Object.values(agiList.out.sampleFrom).every((v) => v === 'list'),
    JSON.stringify(agiList.out.sampleFrom));

  const stdCount = Object.values(agiList.out.sampleslist)
    .filter((n) => n === STD_NAME).length;
  check('标样筛选（Agilent）', stdCount === STD_FILES.length, `命中 ${stdCount} 个标样文件`);
  check('年龄表行数（Agilent）', agiList.age.rows.length === ALL.length,
    `${agiList.age.rows.length} 行`);

  /* --- ② 双格式一致性：两条路必须走出同一组数字 --- */
  console.log('');
  console.log('--- ② 同一组计数率，两种格式的结果必须一致 ---');
  check('Mean_Cps.csv 逐字节',
    therm.out.meanCpsCsv === agiList.out.meanCpsCsv,
    therm.out.meanCpsCsv === agiList.out.meanCpsCsv
      ? `${Buffer.byteLength(therm.out.meanCpsCsv, 'utf8')} 字节相同`
      : '两条链的 Mean_Cps.csv 不同');
  check('result_all.csv 逐字节',
    therm.out.resultAllCsv === agiList.out.resultAllCsv,
    therm.out.resultAllCsv === agiList.out.resultAllCsv
      ? `${Buffer.byteLength(therm.out.resultAllCsv, 'utf8')} 字节相同`
      : '两条链的 result_all.csv 不同');
  cmpAge('年龄表逐位（Agilent vs Thermo）', agiList.age, therm.age);

  /* --- ③ 数值不是"全 NaN 地通过了" --- */
  console.log('');
  console.log(`--- ③ 结果非退化，且数量对得上（数据按 ${STD_AGE} Ma 造）---`);
  let finiteAge = 0, nearStd = 0, worstAge = 0;
  for (const r of agiList.age.rows) {
    if (Number.isFinite(r[17]) && Number.isFinite(r[23])) finiteAge++;
    if (Number.isFinite(r[17])) {
      worstAge = Math.max(worstAge, Math.abs(r[17] - STD_AGE));
      if (Math.abs(r[17] - STD_AGE) < 5) nearStd++;
    }
  }
  check('年龄列有真实数值', finiteAge === ALL.length,
    `${finiteAge}/${ALL.length} 行的 206Pb/238U 与 207Pb/206Pb 年龄都有限`);
  check(`206Pb/238U 年龄回到 ${STD_AGE} Ma`, nearStd === ALL.length,
    `${nearStd}/${ALL.length} 行在 ±5 Ma 内（最大偏离 ${worstAge.toFixed(3)} Ma）`);
  const f68 = agiList.age.factors.f206_238;
  check('分馏因子是接近 1 的正数', Number.isFinite(f68) && f68 > 0.5 && f68 < 2,
    'f206_238 = ' + f68.toPrecision(8));

  /* --- ④ 清单缺失/不匹配时的兜底 --- */
  console.log('');
  console.log('--- ④ 没有清单、清单对不上时的行为 ---');
  const agiNoList = runChain(AGILENT_FILES, 'agilent', null);
  check('无清单时退回取文件名（不是读第一行）',
    Object.values(agiNoList.out.sampleFrom).every((v) => v === 'file'),
    JSON.stringify(Object.values(agiNoList.out.sampleFrom)));
  const firstName = agiNoList.out.sampleslist['STD1.csv'];
  check('退回取到的名字＝文件名的第一个点之前', firstName === 'STD1',
    JSON.stringify(firstName));
  //  这条是兜底的要害：Agilent 每个文件的前几行是**同一串**仪器元信息，
  //  若照 Thermo 的规则读第一行，10 个文件会拿到同一个样品名 ——
  //  年龄层会把它们当成同一样品的重复测量并成一个，结果悄悄错掉且不报错。
  const uniqNames = new Set(Object.values(agiNoList.out.sampleslist));
  check('无清单时每个文件的样品名互不相同', uniqNames.size === ALL.length,
    uniqNames.size + '/' + ALL.length + ' 个不同名字');
  check('Thermo 无清单时仍按第一行取名（与桌面版一致）',
    Object.values(therm.out.sampleFrom).every((v) => v === 'head'),
    JSON.stringify(Object.values(therm.out.sampleFrom)));

  const partial = Object.assign({}, SAMPLE_LIST);
  delete partial.S1;                                   // 故意让 S1 在清单里查不到
  const agiPartial = runChain(AGILENT_FILES, 'agilent', partial);
  check('清单部分缺失时逐个兜底',
    agiPartial.out.sampleFrom['S1.csv'] === 'file'
    && agiPartial.out.sampleFrom['S2.csv'] === 'list',
    'S1=' + agiPartial.out.sampleFrom['S1.csv']
      + ' S2=' + agiPartial.out.sampleFrom['S2.csv']);

  /* --- ⑤ listKey 的规则（照抄 Python 的 split('.')[0]）--- */
  console.log('');
  console.log('--- ⑤ 清单键的规则 ---');
  const keyCases = [['MAD-NEW-1.csv', 'MAD-NEW-1'], ['MAD.NEW.1.csv', 'MAD'],
    ['a.csv', 'a'], ['noext', 'noext'], ['x.y', 'x']];
  let keyBad = 0, keyFirst = null;
  for (const [inp, want] of keyCases) {
    const got = PL.listKey(inp);
    if (got !== want) { keyBad++; if (!keyFirst) keyFirst = `${inp} -> ${got} (期望 ${want})`; }
  }
  check('listKey 忠实于文件名.split(\'.\')[0]', keyBad === 0,
    keyBad ? keyFirst : keyCases.length + ' 个探针全部符合');

  /* --- ⑥ 缺列的情形（没有 202 / 204 通道）--- */
  console.log('');
  console.log('--- ⑥ 缺通道 ---');
  const noHg = agilentFile().split('\r\n').map((l) => l).join('\r\n');
  //  去掉 202 与 204Pb 两列（表头与数据行同时去）
  const noHgLines = [];
  for (const line of noHg.split('\r\n')) {
    const cells = line.split(',');
    if (cells.length === 8) {
      noHgLines.push([cells[0], cells[3], cells[4], cells[5], cells[6], cells[7]].join(','));
    } else { noHgLines.push(line); }
  }
  const noHgText = noHgLines.join('\r\n');
  let noHgOk = false, how = '';
  try {
    const ch = TH.agilentLoad(noHgText, TH.AGILENT_ISONAME);
    const zeros = [ch.y1, ch.y2].every((a) => a.every((v) => v === 0));
    noHgOk = zeros && ch.y3.length === N;
    how = '缺的 202/204 补零，其余 ' + ch.y3.length + ' 点照读';
  } catch (e) { how = String(e && e.message || e); }
  check('缺 202/204 时补零不报错', noHgOk, how);

  /* --- ⑦ 回归哨兵：仪器必须传下去 ---
   * 这一条把"轻量解析漏传仪器"那个 bug 钉住：Thermo 的列名里没有 206/207/238
   * 这套数字列名，所以拿 Thermo 读取器读 Agilent 文件一定失败。界面因此必须
   * 把当前仪器传给解析这一步，否则整批文件会全部显示"解析失败"。 */
  console.log('');
  console.log('--- ⑦ 回归哨兵 ---');
  let wrongInstThrew = false, msg = '';
  try { TH.thermoLoad(AGILENT_FILES[0].text, TH.THERMO_ISONAME); }
  catch (e) { wrongInstThrew = true; msg = String(e && e.message || e).slice(0, 60); }
  check('用错读取器会失败（故仪器必须传参）', wrongInstThrew, msg);
  check('Agilent 读取器能读同一个文件',
    TH.agilentLoad(AGILENT_FILES[0].text, TH.AGILENT_ISONAME).x.length === N,
    N + ' 点');

  console.log('');
  console.log(`总计 ${pass + fail} 项：通过 ${pass}，失败 ${fail}`);
  console.log(fail === 0 ? '全部通过。' : '存在失败项，需排查。');
  process.exit(fail === 0 ? 0 : 1);
}

main();
