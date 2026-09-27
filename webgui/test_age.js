/* ==========================================================================
 *  test_age.js —— 年龄层比对：网页版 vs 桌面版
 *
 *  参考值由 make_age_case.py 生成，方式是**调用真实的 Age_Calculate_average() /
 *  Age_Calculate()**，并用一个假 xlwt 把 `worksheet.write(row+1, col, ...)` 全部
 *  截下来 —— 截到的就是原程序写进 .xls 的内容。每次运行有两份参考：
 *
 *      expectedCR  把模块里的 exp/log 换成"正确舍入"版本后的输出
 *      expected    宿主（本机是 MSVC UCRT）exp/log 下的输出，即真实的桌面版结果
 *
 *  为什么要两份：宿主 exp/log 之间本来就允许差 1 ULP（实测 V8 与 MSVC 在约 9.5%
 *  的 exp 自变量上不同），所以"用宿主 exp/log 还能逐位相等"是不可能的事。
 *  网页版改用正确舍入的 exp/log（fp.js），于是：
 *      · 对 expectedCR  应当**逐位相同** —— 这验证的是"移植本身有没有错"
 *      · 对 expected    只允许在 exp/log 相关列上有 ≤1 ULP 级差异 —— 这量的是
 *                       "与桌面版到底差多少"，并给出数字
 *
 *  判据层次：
 *      ① CSV → 数组      解析 result_all.csv / Mean_Cps.csv 与 np.loadtxt 逐值相同
 *      ② 表头            51 列列名逐字相同
 *      ③a 逐位比对       对 expectedCR，Object.is 精确比（连 -0 与 0 都分开）
 *      ③b 与桌面版偏差   受影响的列集合由参考数据自身推出；相对偏差必须 < 1e-9
 *      ④ 反例自证        故意改一个输入，确认判据真的会失败
 *
 *  用法:  node webgui/test_age.js
 * ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, 'src');
const REF = JSON.parse(fs.readFileSync(path.join(SRC, 'age_case.json'), 'utf8'));

/* ---------- 加载模块并接线 ---------- */
const sandbox = { window: {}, console };
vm.createContext(sandbox);
for (const f of ['fp.js', 'math.js', 'age.js']) {
  vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), sandbox, { filename: f });
}
const M = sandbox.window.DS;
const AGE = sandbox.window.DS_AGE;
AGE.attach({
  pwSum: M.pwSum, nnanmean: M.nnanmean, age76Pb: M.age76Pb, sk2model: M.sk2model,
});

/* ---------- 比对工具 ---------- */
let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) pass++; else { fail++; failures.push(name); }
  console.log((ok ? '  ok  ' : ' FAIL ') + name.padEnd(30) + (detail || ''));
}

function decode(v) {
  if (v === 'NaN') return NaN;
  if (v === 'Infinity') return Infinity;
  if (v === '-Infinity') return -Infinity;
  return v;
}

function sameCell(a, b) {
  const x = decode(a), y = decode(b);
  if (typeof x === 'string' || typeof y === 'string') return x === y;
  return Object.is(x, y);
}

function fmt(v) {
  if (typeof v === 'string') return JSON.stringify(v);
  if (Number.isNaN(v)) return 'NaN';
  return String(v);
}

/** 相对偏差：|Δ| / max(|js|, |py|)。两边都是 0 时给 0。 */
function relDiff(a, b) {
  const x = decode(a), y = decode(b);
  if (typeof x === 'string' || typeof y === 'string') return x === y ? 0 : Infinity;
  if (!isFinite(x) || !isFinite(y)) return x === y ? 0 : Infinity;
  const d = Math.abs(x - y);
  if (d === 0) return 0;
  const s = Math.max(Math.abs(x), Math.abs(y));
  return s === 0 ? Infinity : d / s;
}

/* ---------- ① CSV 解析（用 age.js 里的那份，界面也用它）---------- */
const parseResultAll = AGE.parseResultAllCsv;
const parseMeanCps = AGE.parseMeanCpsCsv;

/* ---------- cfg 组装 ---------- */
function cfgOf(run) {
  const ctx = REF.meta.ctx;
  const p = run.params;
  return {
    method: run.method,
    excessV: run.excessV,
    nistStd: run.nist,
    standard: run.standard,
    P382: ctx.P382, a: ctx.a, b: ctx.b, c: ctx.c, Pbc: ctx.Pbc,
    age: p.age,
    radioactivePb: p.Radioactive_Pb,
    commonPb: p.common_Pb,
    commonPb206_208: p.common_Pb206_208,
    commonPb207_208: p.common_Pb207_208,
    commonPb206_204: p.common_Pb206_204,
    commonPb207_204: p.common_Pb207_204,
    commonPb208_204: p.common_Pb208_204,
    radioactiveSPb207_206: p.radioactiveS_Pb207_206,
  };
}

/* ---------- 主流程 ---------- */
function main() {
  console.log('年龄层比对：网页版 vs 桌面版（Isoclock2.0.py）');
  console.log(`  Python ${REF.meta.python} / NumPy ${REF.meta.numpy}   node ${process.version}`);
  console.log(`  原函数行号  Age_Calculate_average ${REF.meta.lines.Age_Calculate_average.join('-')}`
    + `   Age_Calculate ${REF.meta.lines.Age_Calculate.join('-')}`);
  console.log(`  ${REF.tables.name.length} 行样品 × ${REF.runs.length} 次运行`);
  console.log('');

  /* ① CSV 解析 */
  console.log('--- ① CSV → 数组（网页版解析 vs np.loadtxt(usecols=...)）---');
  const got = parseResultAll(REF.resultAllCsv);
  const want = REF.tables;
  // 顺带确认列号表与 np.loadtxt 的 usecols 一致
  if (AGE.USE_COLS_RESULT.join(',')
      !== '3,4,5,6,7,8,9,10,11,12,13,14,15,16,18,19,20,21,22') {
    throw new Error('USE_COLS_RESULT 与 np.loadtxt 的 usecols 不一致');
  }
  let badN = 0, firstN = null;
  for (let i = 0; i < want.name.length; i++) {
    if (got.name[i] !== want.name[i] || got.fileName[i] !== want.fileName[i]) {
      badN++; if (!firstN) firstN = `第 ${i} 行 ${got.name[i]}|${got.fileName[i]}`;
    }
  }
  check('result_all 样品名/文件名', badN === 0,
    badN ? `${badN} 行不同，首个 ${firstN}` : `${want.name.length} 行逐字相同`);

  let badD = 0, firstD = null;
  for (let k = 0; k < 19; k++) {
    for (let i = 0; i < want.name.length; i++) {
      if (!Object.is(got.dateAll[k][i], want.dateAll[k][i])) {
        badD++;
        if (!firstD) firstD = `列${k} 行${i} js=${got.dateAll[k][i]} py=${want.dateAll[k][i]}`;
      }
    }
  }
  check('result_all 19 个数值列', badD === 0,
    badD ? `${badD} 格不同，首个 ${firstD}`
      : `19 × ${want.name.length} = ${19 * want.name.length} 个数值逐位相同`);

  const gotCps = parseMeanCps(REF.meanCpsCsv);
  let badC = 0, firstC = null;
  for (let k = 0; k < 14; k++) {
    for (let i = 0; i < want.name.length; i++) {
      if (!Object.is(gotCps[k][i], want.dateCps[k][i])) {
        badC++;
        if (!firstC) firstC = `列${k} 行${i} js=${gotCps[k][i]} py=${want.dateCps[k][i]}`;
      }
    }
  }
  check('Mean_Cps 14 个数值列', badC === 0,
    badC ? `${badC} 格不同，首个 ${firstC}`
      : `14 × ${want.name.length} = ${14 * want.name.length} 个数值逐位相同`);

  /* 由参考数据自身推出"哪些列受 exp/log 影响" —— 不靠人工列举 */
  const trans = new Set();
  for (const run of REF.runs) {
    for (let r = 0; r < run.expected.length; r++) {
      for (let c = 0; c < 51; c++) {
        if (!sameCell(run.expected[r][c], run.expectedCR[r][c])) trans.add(c);
      }
    }
  }
  // 公式里含 exp / log 的列（按 Isoclock2.0.py 逐列核对）：
  //   17/18 206Pb_238U 年龄与误差、19/20 207Pb_235U、21/22 208Pb_232Th
  //   23/24 207Pb_206Pb（Age76Pb 内部就是 exp 迭代）
  //   26-29 各校正路径的年龄与误差（log 求年龄、exp 反算比值）
  // 其余 39 列只有 + - * / 和 sqrt（IEEE 规定 sqrt 必须正确舍入，所以逐位一致）。
  const EXP_LOG_COLS = [17, 18, 19, 20, 21, 22, 23, 24, 26, 27, 28, 29];
  const transList = [...trans].sort((a, b) => a - b);
  console.log('');
  console.log('--- ② 表头 / ③a 逐位比对（对 expectedCR，全部 51 列）---');
  // 注意：这个集合是"数据相关"的 —— 它取决于 MSVC 的 exp/log 恰好在那几个自变量上
  // 不是正确舍入。所以只能要求它是声明集合的子集，不能要求相等。
  check('两份参考的差异 ⊆ exp/log 列',
    transList.every((c) => EXP_LOG_COLS.indexOf(c) >= 0),
    `本批数据上落在第 ${transList.join(', ')} 列；声明集合共 ${EXP_LOG_COLS.length} 列`);

  // 界面走的就是 buildInput（内部再调那两个解析函数），这里也用同一条路
  const base = AGE.buildInput(REF.resultAllCsv, REF.meanCpsCsv, REF.comments);
  let headBad = 0;
  let worstRel = 0, worstAt = null;
  const badCols = new Set();
  for (const run of REF.runs) {
    const input = Object.assign({}, base, { cfg: cfgOf(run) });
    const res = run.algo === 'avg' ? AGE.averageAge(input) : AGE.linearAge(input);

    const wantHead = AGE.headerFor(run.algo === 'lin', run.method);
    if (res.header.join('|') !== wantHead.join('|')) headBad++;

    if (res.rows.length !== run.expectedCR.length) {
      check(`${run.tag} 行数`, false,
        `${res.rows.length} != ${run.expectedCR.length}`);
      continue;
    }
    // ③a：对 expectedCR 逐格精确比
    let cellBad = 0, firstBad = null;
    for (let r = 0; r < run.expectedCR.length; r++) {
      for (let c = 0; c < 51; c++) {
        if (!sameCell(res.rows[r][c], run.expectedCR[r][c])) {
          cellBad++;
          if (!firstBad) {
            firstBad = `[${r},${c}] js=${fmt(res.rows[r][c])} py=${fmt(run.expectedCR[r][c])}`;
          }
        }
      }
    }
    check(`${run.tag} CR 逐位`, cellBad === 0,
      cellBad === 0 ? `${res.rows.length * 51} 格全部逐位相同`
        : `${cellBad} 格不同，首个 ${firstBad}`);

    // ③b：与桌面版真实输出（宿主 exp/log）比，差异只允许落在 exp/log 相关列
    let offBad = 0, offFirst = null;
    for (let r = 0; r < run.expected.length; r++) {
      for (let c = 0; c < 51; c++) {
        const d = relDiff(res.rows[r][c], run.expected[r][c]);
        if (d === 0) continue;
        badCols.add(c);
        if (d > worstRel) { worstRel = d; worstAt = `${run.tag}[${r},${c}]`; }
        if (!trans.has(c)) {
          offBad++;
          if (!offFirst) {
            offFirst = `[${r},${c}] js=${fmt(res.rows[r][c])} py=${fmt(run.expected[r][c])}`;
          }
        }
      }
    }
    check(`${run.tag} 桌面版偏差`, offBad === 0,
      offBad === 0 ? '差异只出现在 exp/log 相关列'
        : `${offBad} 格落在不含 exp/log 的列，首个 ${offFirst}`);
  }
  check('表头', headBad === 0, headBad ? `${headBad} 次不匹配` : '全部一致');
  check('偏差列 ⊆ exp/log 列', [...badCols].every((c) => trans.has(c)),
    `实际落在第 ${[...badCols].sort((a, b) => a - b).join(', ')} 列`);
  check('与桌面版最大相对偏差 < 1e-9', worstRel < 1e-9,
    `${worstRel.toExponential(3)}（在 ${worstAt}）`);

  /* ④ 反例自证：判据本身必须会 fail */
  console.log('');
  console.log('--- ④ 反例自证（判据必须真的能失败）---');
  const ref = REF.runs.find((r) => r.tag === 'avg-m1');
  const good = AGE.averageAge(Object.assign({}, base, { cfg: cfgOf(ref) }));
  check('对照：原输入应当相同', sameCell(good.rows[0][17], ref.expectedCR[0][17]),
    `js=${fmt(good.rows[0][17])} py=${fmt(ref.expectedCR[0][17])}`);

  const brokenCfg = cfgOf(ref);
  brokenCfg.excessV = ref.excessV + 1e-15;           // 1e-15 的扰动
  const broken = AGE.averageAge(Object.assign({}, base, { cfg: brokenCfg }));
  let diff = 0;
  for (let c = 0; c < 51; c++) {
    if (!sameCell(broken.rows[0][c], ref.expectedCR[0][c])) diff++;
  }
  check('微扰 excess_V 必须被发现', diff > 0, `第 0 行有 ${diff} 格不同`);

  const shifted = base.dateAll.map((col) => col.slice());
  shifted[0][0] = shifted[0][0] * (1 + 1e-15);       // 只动一个输入
  const broken2 = AGE.averageAge(Object.assign({}, base, { dateAll: shifted },
    { cfg: cfgOf(ref) }));
  check('微扰一个输入必须被发现',
    !sameCell(broken2.rows[0][23], ref.expectedCR[0][23]),
    `js=${fmt(broken2.rows[0][23])} py=${fmt(ref.expectedCR[0][23])}`);

  console.log('');
  console.log(`总计 ${pass + fail} 项：通过 ${pass}，失败 ${fail}`);
  if (fail) console.log('失败项：' + failures.join(' / '));
  console.log(fail === 0 ? '全部通过。' : '存在失败项，需排查。');
  process.exit(fail === 0 ? 0 : 1);
}

main();
