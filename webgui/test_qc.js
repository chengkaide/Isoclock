/* ==========================================================================
 *  test_qc.js —— 质量统计（加权平均 / MSWD / 列映射 / 判据分级）
 *
 *  【为什么没有 Python 参考值可比】qc.js 是新加的：桌面版 Isoclock 只输出
 *  逐点年龄，从不做归组统计。所以这套测试的判据是**按定义手算**的独立值 ——
 *  期望值不是用 qcWavg 自己算一遍再比回去，而是照着 Wendt & Carl (1991) 的
 *  定义在测试里另写一遍（权重、加权均值、χ²/(n-1)），两者的实现路径不同，
 *  这样才抓得住"索引错位""忘了把 2s 折成 1σ"这类实现 bug。
 *
 *  特意钉住的一条：**年龄表的 2s 列是 2σ，内部必须折成 1σ**。
 *  忘了折的话 MSWD 会小 4 倍、误差小 2 倍 —— 数字看着更"漂亮"，全是假的。
 *
 *  用法:  node webgui/test_qc.js
 * ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, 'src');

const sandbox = { window: {}, console };
vm.createContext(sandbox);
for (const f of ['fp.js', 'math.js', 'age.js', 'qc.js']) {
  vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), sandbox, { filename: f });
}
const M = sandbox.window.DS;
const AGE = sandbox.window.DS_AGE;
const QC = sandbox.window.DS_QC;
AGE.attach({
  pwSum: M.pwSum, nnanmean: M.nnanmean, age76Pb: M.age76Pb, sk2model: M.sk2model,
});

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) pass++; else { fail++; failures.push(name); }
  console.log((ok ? '  ok  ' : ' FAIL ') + name.padEnd(42) + (detail || ''));
}
function near(a, b, tol) {
  if (!isFinite(a) || !isFinite(b)) return Object.is(a, b);
  return Math.abs(a - b) <= (tol === undefined ? 1e-9 : tol) * Math.max(1, Math.abs(b));
}

/**
 * 按定义独立算一遍加权平均 —— 故意不走 qcWavg。
 * σ 传 1σ（测试里自己从 2s 折好了再传进来）。
 */
function refWavg(pairs) {
  const w = pairs.map((p) => 1 / (p.s1 * p.s1));
  const sw = w.reduce((a, b) => a + b, 0);
  const mean = pairs.reduce((a, p, i) => a + w[i] * p.age, 0) / sw;
  const chi2 = pairs.reduce((a, p, i) => a + Math.pow((p.age - mean) / p.s1, 2), 0);
  const dof = pairs.length - 1;
  return { mean, se: Math.sqrt(1 / sw), chi2, dof, mswd: dof > 0 ? chi2 / dof : NaN };
}

function main() {
  console.log('质量统计：按定义手算的独立值比对');
  console.log('');

  /* ---- ① 等权重：可以直接手算 ---- */
  console.log('--- ① 等权重加权平均（可手算）---');
  // 2s = 2 → 1σ = 1，四个点的权重都是 1
  //   μ = (100+101+99+100.5)/4 = 100.125
  //   se = 1/√4 = 0.5
  //   χ² = 0.125² + 0.875² + 1.125² + 0.375² = 2.1875 ; dof=3
  const w1 = QC.qcWavg([
    { age: 100, s2: 2 }, { age: 101, s2: 2 }, { age: 99, s2: 2 }, { age: 100.5, s2: 2 },
  ]);
  check('n = 4', w1.n === 4, String(w1.n));
  check('加权平均 = 100.125', near(w1.mean, 100.125), String(w1.mean));
  check('标准误 = 0.5', near(w1.se, 0.5), String(w1.se));
  check('χ² = 2.1875', near(w1.chi2, 2.1875), String(w1.chi2));
  check('MSWD = 2.1875/3', near(w1.mswd, 2.1875 / 3), String(w1.mswd));
  check('MSWD<1 时不放大误差', near(w1.seExt, w1.se), String(w1.seExt));

  /* ---- ② 2σ → 1σ 的折算（这条最关键）---- */
  console.log('');
  console.log('--- ② 2s 是 2σ，必须折成 1σ ---');
  // 同一组年龄，把"误差"从 2s=2 改成 2s=4（即 1σ 从 1 变 2）：
  //   权重整体 ÷4 → 均值不变、se 变 2 倍、χ² ÷4、MSWD ÷4。
  // 如果实现里忘了除以 2，这两组结果会相同 —— 那就说明折算没做。
  const w2 = QC.qcWavg([
    { age: 100, s2: 4 }, { age: 101, s2: 4 }, { age: 99, s2: 4 }, { age: 100.5, s2: 4 },
  ]);
  check('均值不受误差尺度影响', near(w2.mean, 100.125), String(w2.mean));
  check('se 变 2 倍', near(w2.se, 1.0), String(w2.se));
  check('MSWD 变 1/4', near(w2.mswd, 2.1875 / 3 / 4), String(w2.mswd));
  check('两组 MSWD 确实不同（说明折算了）',
    !near(w1.mswd, w2.mswd, 1e-6), w1.mswd.toFixed(6) + ' vs ' + w2.mswd.toFixed(6));

  /* ---- ③ 不等权重：与独立实现比 ---- */
  console.log('');
  console.log('--- ③ 不等权重，与独立实现比 ---');
  const cases3 = [
    [{ age: 100, s2: 1 }, { age: 200, s2: 10 }],
    [{ age: 423.4, s2: 21.17 }, { age: 425.1, s2: 19.8 }, { age: 421.0, s2: 25.3 }],
    [{ age: 1.5, s2: 0.2 }, { age: 2.5, s2: 0.02 }],
  ];
  let bad3 = 0;
  for (const cs of cases3) {
    const got = QC.qcWavg(cs);
    const ref = refWavg(cs.map((c) => ({ age: c.age, s1: c.s2 / 2 })));
    const ok = near(got.mean, ref.mean) && near(got.se, ref.se)
      && near(got.chi2, ref.chi2) && near(got.mswd, ref.mswd);
    if (!ok) {
      bad3++;
      check('不等权重 ' + JSON.stringify(cs.map((c) => c.age)),
        false, 'μ ' + got.mean + '/' + ref.mean + '  se ' + got.se + '/' + ref.se
          + '  MSWD ' + got.mswd + '/' + ref.mswd);
    }
  }
  check('三组不等权重全部一致', bad3 === 0, cases3.length + ' 组');

  /* ---- ④ 过散时的误差放大 ---- */
  console.log('');
  console.log('--- ④ MSWD>1 时按 √MSWD 放大误差 ---');
  // 2s=1 → 1σ=0.5；三个点 100/110/120 → μ=110，se=1/√12，MSWD=400
  const w4 = QC.qcWavg([
    { age: 100, s2: 1 }, { age: 110, s2: 1 }, { age: 120, s2: 1 },
  ]);
  check('μ = 110', near(w4.mean, 110), String(w4.mean));
  check('MSWD = 400', near(w4.mswd, 400), String(w4.mswd));
  check('se = 1/√12', near(w4.se, 1 / Math.sqrt(12)), String(w4.se));
  check('seExt = se×√MSWD', near(w4.seExt, w4.se * 20), String(w4.seExt));

  /* ---- ⑤ 剔除与计数 ---- */
  console.log('');
  console.log('--- ⑤ 无效点要剔除并计数 ---');
  const w5 = QC.qcWavg([
    { age: 100, s2: 2 }, { age: NaN, s2: 2 }, { age: 101, s2: NaN },
    { age: 99, s2: 0 }, { age: 100, s2: -1 },
  ]);
  check('只剩 1 个有效点', w5.n === 1, String(w5.n));
  check('剔除了 4 个', w5.dropped === 4, String(w5.dropped));
  check('单点时 MSWD 为 NaN（dof=0）', Number.isNaN(w5.mswd), String(w5.mswd));
  const w5b = QC.qcWavg([]);
  check('空输入不崩且 n=0', w5b.n === 0 && Number.isNaN(w5b.mean), '');

  /* ---- ⑥ MSWD 判据上限 ---- */
  console.log('');
  console.log('--- ⑥ MSWD 上限：自动与固定 ---');
  check('n=2 → 1+2√2', near(QC.qcMswdLimit(2, 0), 1 + 2 * Math.sqrt(2)), String(QC.qcMswdLimit(2, 0)));
  check('n=5 → 1+2√(2/4)', near(QC.qcMswdLimit(5, 0), 1 + 2 * Math.sqrt(0.5)), String(QC.qcMswdLimit(5, 0)));
  check('n=1 → 无穷（无从判断）', QC.qcMswdLimit(1, 0) === Infinity, '');
  check('给了固定值就用固定值', QC.qcMswdLimit(5, 2.5) === 2.5, '');
  check('点数越多判据越紧', QC.qcMswdLimit(50, 0) < QC.qcMswdLimit(5, 0),
    QC.qcMswdLimit(50, 0).toFixed(3) + ' < ' + QC.qcMswdLimit(5, 0).toFixed(3));

  /* ---- ⑦ 标准残差 ---- */
  console.log('');
  console.log('--- ⑦ 单点标准残差 (x-μ)/σ ---');
  const z = QC.qcStdResiduals([{ age: 100, s2: 2 }, { age: 101, s2: 2 }], 100);
  check('与均值重合 → z=0', near(z[0], 0), String(z[0]));
  check('偏离 1 个 1σ → z=1（2s=2 时 σ=1）', near(z[1], 1), String(z[1]));

  /* ---- ⑧ 列映射 ---- */
  console.log('');
  console.log('--- ⑧ 年龄列映射 ---');
  check('method 0 没有校正后 206Pb/238U', QC.qcAgeCol(0, QC.QC_KEY68, true) === null,
    String(QC.qcAgeCol(0, QC.QC_KEY68, true)));
  check('method 1 校正后 206Pb/238U 在第 28 列（0基）',
    QC.qcAgeCol(1, QC.QC_KEY68, true) === 28, String(QC.qcAgeCol(1, QC.QC_KEY68, true)));
  check('method 1 校正后 207Pb/235U 在第 26 列',
    QC.qcAgeCol(1, QC.QC_KEY75, true) === 26, String(QC.qcAgeCol(1, QC.QC_KEY75, true)));
  check('method 4 校正后 206Pb/238U 在第 26 列（顺序不同）',
    QC.qcAgeCol(4, QC.QC_KEY68, true) === 26, String(QC.qcAgeCol(4, QC.QC_KEY68, true)));
  check('method 4 校正后 208Pb/232Th 在第 28 列',
    QC.qcAgeCol(4, QC.QC_KEY82, true) === 28, String(QC.qcAgeCol(4, QC.QC_KEY82, true)));
  check('207Pb/206Pb 永远没有校正列',
    [1, 2, 3, 4].every((m) => QC.qcAgeCol(m, QC.QC_KEY76, true) === null), '');
  check('未校正列与校正方式无关',
    [0, 1, 4].every((m) => QC.qcAgeCol(m, QC.QC_KEY68, false) === 17), '');
  const d0 = QC.qcDefaultAge(0, QC.QC_KEY68);
  const d1 = QC.qcDefaultAge(1, QC.QC_KEY68);
  const d76 = QC.qcDefaultAge(1, QC.QC_KEY76);
  check('method 0 默认退到未校正', d0.corrected === false, JSON.stringify(d0));
  check('method 1 默认用校正后', d1.corrected === true, JSON.stringify(d1));
  check('选了 207Pb/206Pb 就用未校正',
    d76.key === QC.QC_KEY76 && d76.corrected === false, JSON.stringify(d76));

  /* ---- ⑨ 表头自检：能发现表头与内容不一致 ---- */
  console.log('');
  console.log('--- ⑨ 表头自检 ---');
  const good = AGE.headerFor(false, 1);
  const lay = QC.qcCheckLayout(good, 1);
  check('正确的表头没有 problems', lay.problems.length === 0, lay.problems.join('；'));
  check('指出了第 26 列表头与内容不一致', lay.notes.length > 0
    && lay.notes.join('').indexOf('备注') >= 0, lay.notes.join(' ').slice(0, 60));
  const shuffled = good.slice();
  const tmp = shuffled[17]; shuffled[17] = shuffled[19]; shuffled[19] = tmp;
  check('把第 18/20 列对调后能报出来',
    QC.qcCheckLayout(shuffled, 1).problems.length > 0, '');
  const h0 = AGE.headerFor(false, 0);
  check('method 0 不要求校正列', QC.qcCheckLayout(h0, 0).problems.length === 0, '');

  /* ---- ⑩ 端到端：拿真实年龄表跑一遍 ---- */
  console.log('');
  console.log('--- ⑩ 端到端（用 age_case.json 的真实年龄表）---');
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
  const firstName = Object.keys(names).sort((a, b) => names[b] - names[a])[0];

  const qc = QC.qcAnalyze({
    header: ageRes.header, rows: ageRes.rows, method: run.method,
    ageKey: QC.QC_KEY68, ageCorrected: false,
    stdName: firstName, stdAge: 485, fracStd: firstName, nistStd: 'NIST610',
    algo: 'avg', instrument: 'thermo',
    coefficients: ageRes.coefficients,
    divZero: ageRes.warnings.divZero,
  });
  check('分组数 = 数据里的样品数', qc.stats.length === Object.keys(names).length,
    qc.stats.length + ' vs ' + Object.keys(names).length);
  check('每组的 n 与数据一致',
    qc.stats.every((s) => s.n === names[s.name]), '');
  check('summry.nRows = 行数', qc.summary.nRows === ageRes.rows.length, String(qc.summary.nRows));
  check('有效点数 ≤ 总行数', qc.summary.nUsed <= qc.summary.nRows,
    qc.summary.nUsed + ' ≤ ' + qc.summary.nRows);
  check('识别出了标样', qc.standards.length === 1
    && qc.standards[0].name === firstName, JSON.stringify(qc.standards.map((s) => s.name)));

  // 标样的均值必须与独立实现一致
  const stdRows = ageRes.rows.filter((r) => r[1] === firstName);
  const refStd = refWavg(stdRows.map((r) => ({ age: r[17], s1: r[18] / 2 })));
  check('标样均值与独立实现一致', near(qc.standards[0].mean, refStd.mean, 1e-12),
    qc.standards[0].mean + ' vs ' + refStd.mean);
  check('标样 MSWD 与独立实现一致', near(qc.standards[0].mswd, refStd.mswd, 1e-12),
    qc.standards[0].mswd + ' vs ' + refStd.mswd);

  /* ---- ⑪ 判据真的会失败（反向自证）---- */
  console.log('');
  console.log('--- ⑪ 反向自证：判据必须能失败 ---');
  // 1) 标样名对不上 → 必须报 bad
  const qcNoStd = QC.qcAnalyze({
    header: ageRes.header, rows: ageRes.rows, method: run.method,
    ageKey: QC.QC_KEY68, ageCorrected: false,
    stdName: '这个名字不存在', stdAge: 485, algo: 'avg', instrument: 'thermo',
  });
  check('标样名对不上 → 有 bad 级异常',
    qcNoStd.anomalies.some((a) => a.level === 'bad'), '');
  check('标样名对不上 → 总等级 bad', qcNoStd.summary.level === 'bad', qcNoStd.summary.level);

  // 2) 标样真值改到离测出值很远 → 必须判不合格
  const qcFar = QC.qcAnalyze({
    header: ageRes.header, rows: ageRes.rows, method: run.method,
    ageKey: QC.QC_KEY68, ageCorrected: false,
    stdName: firstName, stdAge: 100, algo: 'avg', instrument: 'thermo',
  });
  check('标样偏差巨大 → 标样判 bad', qcFar.standards[0].level === 'bad',
    '偏差 ' + qcFar.standards[0].devPct.toFixed(1) + '%');

  // 3) 真值就取测出值 → 偏差≈0 → "偏差"这一条不应再触发。
  //    注意：这一组标样（MAD-NEW）的 MSWD 本来就远超上限（真实数据就是这么散），
  //    所以总等级仍会是 warn。要断言的是"降级的原因换人了"，而不是"等级变成 ok" ——
  //    否则测出来的其实是 MSWD，不是偏差判据。
  const qcFit = QC.qcAnalyze({
    header: ageRes.header, rows: ageRes.rows, method: run.method,
    ageKey: QC.QC_KEY68, ageCorrected: false,
    stdName: firstName, stdAge: qc.standards[0].mean, algo: 'avg', instrument: 'thermo',
  });
  check('真值取测出值 → 偏差≈0', Math.abs(qcFit.standards[0].devPct) < 1e-9,
    qcFit.standards[0].devPct.toExponential(2) + '%');
  check('真值取测出值 → 不再因偏差判 bad', qcFit.standards[0].level !== 'bad',
    qcFit.standards[0].level);
  check('真值取测出值 → 警告来自 MSWD，不是偏差',
    qcFit.standards[0].reasons.some((r) => r.why.indexOf('MSWD') >= 0)
      && !qcFit.standards[0].reasons.some((r) => r.why.indexOf('与真值') >= 0),
    qcFit.standards[0].reasons.map((r) => r.level + ':' + r.why.slice(0, 14)).join(' | '));

  // 4) 阈值必须真的接进判据 —— 用一对 A/B，只有阈值不同：
  //    真值故意偏离测出值 0.5%，于是"偏差=0.5%"是已知的。
  //    上限给 2%（默认）不该因偏差报警；改成 0.1% 就必须报。
  //    （不能拿"偏差恰好为 0"的例子来试阈值：0 ≤ 任何非负上限，永远不触发。）
  const trueOff = qc.standards[0].mean * 1.005;
  const mk = (thr) => QC.qcAnalyze({
    header: ageRes.header, rows: ageRes.rows, method: run.method,
    ageKey: QC.QC_KEY68, ageCorrected: false,
    stdName: firstName, stdAge: trueOff, algo: 'avg', instrument: 'thermo',
    thresholds: thr,
  });
  const qcLoose = mk({ stdDevPct: 2.0 });
  const qcTight = mk({ stdDevPct: 0.1 });
  check('偏差确实是 0.5%', near(qcLoose.standards[0].devPct, -0.4975, 1e-3),
    qcLoose.standards[0].devPct.toFixed(4) + '%');
  check('上限 2% 时不因偏差报警',
    !qcLoose.standards[0].reasons.some((r) => r.why.indexOf('与真值') >= 0), '');
  check('上限 0.1% 时因偏差报警（阈值真的生效）',
    qcTight.standards[0].reasons.some((r) => r.why.indexOf('与真值') >= 0),
    qcTight.standards[0].reasons.map((r) => r.why.slice(0, 16)).join(' | '));

  // 5) 不变量：凡是判了 warn / bad 的，都必须给出"为什么"。
  //    没有这一条，报告里就会出现"偏差 0.0000% 却标着警告"这种看不出原因的行。
  const allReasons = qc.stats.concat(qc.standards);
  const noWhy = allReasons.filter((s) => s.level !== 'ok'
    && !(s.reasons && s.reasons.length
      && s.reasons.every((r) => r.why && r.why.length > 4)));
  check('判了 warn/bad 的都写了原因', noWhy.length === 0,
    noWhy.map((s) => s.name + ':' + s.level).join(','));
  const leakWhy = allReasons.filter((s) => (s.reasons || []).some((r) => r.why === undefined));
  check('每条原因都有文字', leakWhy.length === 0,
    leakWhy.map((s) => s.name).join(','));

  // 6) 全部年龄置 NaN → 必须报 bad
  const nanRows = ageRes.rows.map((r) => {
    const c = r.slice();
    c[17] = NaN; c[18] = NaN;
    return c;
  });
  const qcNan = QC.qcAnalyze({
    header: ageRes.header, rows: nanRows, method: run.method,
    ageKey: QC.QC_KEY68, ageCorrected: false,
    stdName: firstName, stdAge: 485, algo: 'avg', instrument: 'thermo',
  });
  check('年龄全 NaN → 有 bad 级异常',
    qcNan.anomalies.some((a) => a.level === 'bad' && a.kind === '年龄缺失'), '');
  check('年龄全 NaN → 每个样品都是 bad',
    qcNan.stats.every((s) => s.level === 'bad'), '');

  /* ---- ⑫ 阈值默认值与说明一致性 ---- */
  console.log('');
  console.log('--- ⑫ 阈值文档与默认值一致 ---');
  const docKeys = QC.QC_THRESHOLD_DOC.map((d) => d.k).sort().join(',');
  const defKeys = Object.keys(QC.QC_DEFAULT_THRESHOLDS).sort().join(',');
  check('文档覆盖全部阈值', docKeys === defKeys, docKeys + ' vs ' + defKeys);
  check('文档里的默认值与代码一致', QC.QC_THRESHOLD_DOC.every(
    (d) => d.def === QC.QC_DEFAULT_THRESHOLDS[d.k]), '');
  check('每条文档都写了"为什么"', QC.QC_THRESHOLD_DOC.every(
    (d) => d.what && d.why && d.why.length > 10), '');

  console.log('');
  console.log('结果：' + pass + ' 通过 / ' + fail + ' 失败');
  if (fail) {
    console.log('失败项：');
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
}

main();
