/* ==========================================================================
 *  test_math.js —— JS 移植版 vs Python 原版的逐位对照
 *
 *  用法:  node webgui/test_math.js
 *
 *  判据分两档，按"是否触及超越函数"划分：
 *
 *    精确档（要求逐位相等，0 ULP）
 *      sum / mean / std / average / nanmean / nanstd / filter2s / mean2sem
 *      以及只含四则运算与 sqrt 的还原路径（sample / std207 / std_cal204 / std204）
 *      —— 这些没有理由不一致，差一个末位就说明移植错了。
 *
 *    相对容差档（1e-12）
 *      SK2model / Age76Pb / 208Pb 路径 —— 它们用到 exp，而 C libm 的 exp 与
 *      V8 的 Math.exp 允许有 ~1 ULP 的实现差异（IEEE-754 不规定 exp 必须正确舍入）。
 *      这是本移植唯一无法消除的误差源，实测值会打印出来，不做隐瞒。
 * ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, 'src');

/* ---------- 加载 ---------- */
const sandbox = { window: {}, console };
vm.createContext(sandbox);
for (const f of ['data.js', 'math.js']) {
  vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), sandbox, { filename: f });
}
// vm 里顶层 const 不会挂到 sandbox 上，要显式取
const ISO_DATA = vm.runInContext('ISO_DATA', sandbox);
const DS = sandbox.window.DS;

const REF = JSON.parse(fs.readFileSync(path.join(SRC, 'reference.json'), 'utf8'));

/* ---------- 比较工具 ---------- */
/**
 * reduceSample 的 No. 列（eleIndex==0 时）是**标记过的 Python int**，
 * 因为 Python 的 str(1) 是 '1' 而不是 '1.0'。比较前要拆掉标记。
 */
function unwrap(v) {
  if (v !== null && typeof v === 'object' && v.__pyInt !== undefined) return v.__pyInt;
  return v;
}

function same(a, b) {
  if (typeof a === 'string' || typeof b === 'string') return a === b;
  const an = Number.isNaN(a), bn = Number.isNaN(b);
  if (an && bn) return true;
  if (an !== bn) return false;
  return a === b;
}

function rel(a, b) {
  if (typeof a === 'string' || typeof b === 'string') return a === b ? 0 : Infinity;
  if (Number.isNaN(a) && Number.isNaN(b)) return 0;
  if (Number.isNaN(a) || Number.isNaN(b)) return Infinity;
  if (a === b) return 0;
  const d = Math.abs(a - b);
  const s = Math.max(Math.abs(a), Math.abs(b));
  return s === 0 ? 0 : d / s;
}

const results = [];
function record(group, label, ok, detail) {
  results.push({ group, label, ok, detail });
}

/* ---------- 1. NumPy 兼容层：要求逐位相等 ---------- */
function testPrimitives() {
  const P = REF.primitives;
  const specs = [
    ['sum', (x) => DS.nsum(x)],
    ['mean', (x) => DS.nmean(x)],
    ['std', (x) => DS.nstd(x)],
    ['average', (x) => DS.nmean(x)],
  ];
  for (const [key, fn] of specs) {
    let worst = 0, worstAt = null, exact = 0, total = 0;
    for (const c of P[key]) {
      const x = Float64Array.from(c.x);
      const got = fn(x);
      total++;
      if (same(got, c.v)) { exact++; } else {
        const r = rel(got, c.v);
        if (r > worst) { worst = r; worstAt = c.n; }
      }
    }
    record('primitive', key, exact === total,
      `${exact}/${total} 逐位相等` + (exact === total ? '' : `, 最大相对差 ${worst.toExponential(3)} @n=${worstAt}`));
  }

  // nanmean / nanstd / countNan
  let okN = 0;
  for (const c of P.nan) {
    const x = Float64Array.from(c.x.map((v) => (v === null ? NaN : v)));
    const cn = DS.countNan(x);
    const nm = DS.nnanmean(x);
    const ns = DS.nnanstd(x);
    const pass = cn === c.count_nonzero_isnan && same(nm, c.nanmean) && same(ns, c.nanstd);
    if (pass) okN++;
    else {
      record('primitive', `nan n=${c.n}`, false,
        `count ${cn}/${c.count_nonzero_isnan}, nanmean rel ${rel(nm, c.nanmean).toExponential(3)}, nanstd rel ${rel(ns, c.nanstd).toExponential(3)}`);
    }
  }
  if (okN === P.nan.length) {
    record('primitive', 'nanmean/nanstd/countNan', true, `${okN}/${P.nan.length} 逐位相等`);
  }

  // filter2s + mean2sem
  let okF = 0, worstF = 0;
  for (const c of P.filter2s) {
    const x = Float64Array.from(c.x);
    const f = DS.filter2s(x);
    const ms = DS.mean2sem(f);
    let worst = 0;
    for (let i = 0; i < f.length; i++) {
      // 比较过滤后的整个数组：NaN 位置也要对得上
      const want = c.filtered[i] === null ? NaN : c.filtered[i];
      if (same(f[i], want)) continue;
      worst = Math.max(worst, rel(f[i], want));
    }
    worst = Math.max(worst, rel(ms[0], c.mean), rel(ms[1], c.twosem));
    const keptOk = f.length - DS.countNan(f) === c.kept;
    worstF = Math.max(worstF, worst);
    if (worst === 0 && keptOk && same(ms[0], c.mean) && same(ms[1], c.twosem)) okF++;
    else {
      record('primitive', `filter2s+mean2sem n=${c.n}`, false,
        `kept ${f.length - DS.countNan(f)}/${c.kept}, 最大相对差 ${worst.toExponential(3)}`);
    }
  }
  if (okF === P.filter2s.length) {
    record('primitive', 'filter2s + mean2sem', true, `${okF}/${P.filter2s.length} 逐位相等（含 NaN 位置）`);
  }
}

/* ---------- 2. 模型函数：exp 相关，用相对容差 ---------- */
const TOL_EXP = 1e-12;

function testModels() {
  const M = REF.models;

  let worstSk = 0, worstSkAt = null;
  for (const c of M.sk2model) {
    const got = DS.sk2model(c.age);
    for (let i = 0; i < 5; i++) {
      const r = rel(got[i], c.out[i]);
      if (r > worstSk) { worstSk = r; worstSkAt = c.age; }
    }
  }
  record('model', 'SK2model', worstSk <= TOL_EXP,
    `最大相对差 ${worstSk.toExponential(3)} @age=${worstSkAt}（阈值 ${TOL_EXP.toExponential(0)}）`);

  let worstA = 0, worstAAt = null, nA = 0;
  for (const c of M.age76) {
    const got = DS.age76Pb(c.r);
    if (c.error) { record('model', `Age76Pb(${c.r})`, false, `Python 抛 ${c.error}，JS 返回 ${got}`); continue; }
    nA++;
    const r = rel(got, c.age);
    if (r > worstA) { worstA = r; worstAAt = c.r; }
  }
  record('model', `Age76Pb (${nA} 个输入)`, worstA <= TOL_EXP,
    `最大相对差 ${worstA.toExponential(3)} @r=${worstAAt}（阈值 ${TOL_EXP.toExponential(0)}）`);

  let worstC = 0, worstCAt = null;
  for (const c of M.ratio_to_age) {
    const trio = [
      DS.ageFromRatio(c.r, DS.LAM238),
      DS.ageFromRatio(c.r, DS.LAM235),
      DS.ageFromRatio(c.r, DS.LAM232),
    ];
    const want = [c.pb206_u238, c.pb207_u235, c.pb208_th232];
    for (let i = 0; i < 3; i++) {
      const r = rel(trio[i], want[i]);
      if (r > worstC) { worstC = r; worstCAt = c.r; }
    }
  }
  record('model', 'ln(1+r)/λ 年龄换算', worstC <= TOL_EXP,
    `最大相对差 ${worstC.toExponential(3)} @r=${worstCAt}（含 Math.log vs math.log）`);
}

/* ---------- 3. 还原：端到端 23 列 ---------- */
// 纯四则运算的路径要求逐位相等；std208 含 exp，走容差档
const EXACT_METHODS = ['sample', 'std207', 'std_cal204', 'std204'];

function testReduction() {
  const R = REF.reduction;
  const ctx = R.ctx;
  const samplesMap = {};
  const chMap = {};
  for (const s of ISO_DATA.samples) {
    samplesMap[s.file] = s.name;
    const ch = {};
    for (const key of Object.keys(s.ch)) ch[key] = b64ToF64(s.ch[key]);
    chMap[s.file] = ch;
  }

  for (const file of Object.keys(R.rows)) {
    for (const method of Object.keys(R.rows[file])) {
      const want = R.rows[file][method];
      const got = DS.reduceSample(file, chMap[file], method, ctx,
        { eleIndex: R.ele, samplesMap });
      let worst = 0, worstCol = -1, exactCount = 0;
      const badCols = [];
      for (let i = 0; i < want.length; i++) {
        const w = want[i] === 'NaN' ? NaN
          : (want[i] === 'Infinity' ? Infinity
            : (want[i] === '-Infinity' ? -Infinity : want[i]));
        const g = unwrap(got[i]);
        const r = rel(g, w);
        if (same(g, w)) exactCount++;
        else { worst = Math.max(worst, r); badCols.push(i); }
      }
      const exactExpected = EXACT_METHODS.indexOf(method) >= 0;
      const ok = exactExpected ? exactCount === want.length : worst <= TOL_EXP;
      const tag = exactExpected ? '逐位' : '容差';
      if (!ok || badCols.length) {
        record('reduce', `${file} / ${method}`, ok,
          `${exactCount}/${want.length} 逐位` +
          (badCols.length ? `, 最大相对差 ${worst.toExponential(3)} @列${badCols.slice(0, 4).join(',')}` : ''));
      } else {
        record('reduce', `${file} / ${method}`, true,
          `${exactCount}/${want.length} 逐位相等 [${tag}档]`);
      }
    }
  }
}

function b64ToF64(s) {
  const buf = Buffer.from(s, 'base64');
  // slice 会复制到新的 ArrayBuffer，字节偏移归零，天然满足 8 字节对齐
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
  return new Float64Array(ab);
}

/* ---------- 汇总 ---------- */
function main() {
  console.log('Isoclock 数值内核：JS vs Python 逐位对照');
  console.log('  Python ' + REF.meta.python + ' / NumPy ' + REF.meta.numpy
    + '   node ' + process.version);
  console.log('  数据：' + REF.meta.n_bg + ' 背景点 + ' + REF.meta.n_sig + ' 信号点 × '
    + REF.meta.samples.length + ' 路样品');
  console.log('');

  testPrimitives();
  testModels();
  testReduction();

  let pass = 0, fail = 0;
  let lastGroup = null;
  for (const r of results) {
    if (r.group !== lastGroup) {
      console.log('');
      console.log('--- ' + r.group + ' ---');
      lastGroup = r.group;
    }
    // 逐条打印 detail 太吵：失败的必打，reduce 组按样品汇总
    if (r.ok) { pass++; } else { fail++; }
    const mark = r.ok ? '  ok  ' : ' FAIL ';
    if (!r.ok || r.group !== 'reduce') {
      console.log(mark + r.label.padEnd(34) + r.detail);
    }
  }

  // reduce 组单独汇总（3 样品 × 5 路径 = 15 条）
  const red = results.filter((r) => r.group === 'reduce');
  const redOk = red.filter((r) => r.ok).length;
  const redExact = red.filter((r) => r.detail.indexOf('逐位') >= 0 && r.ok).length;
  console.log('');
  console.log('--- reduce 汇总 ---');
  for (const r of red) {
    console.log((r.ok ? '  ok  ' : ' FAIL ') + r.label.padEnd(30) + r.detail);
  }
  console.log('');
  console.log(`还原路径：${redOk}/${red.length} 通过`);
  console.log('');
  console.log(`总计 ${pass + fail} 项：通过 ${pass}，失败 ${fail}`);
  console.log(fail === 0 ? '全部通过。' : '存在失败项，需排查。');
  process.exit(fail === 0 ? 0 : 1);
}

main();
