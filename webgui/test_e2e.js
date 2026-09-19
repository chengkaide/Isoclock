/* ==========================================================================
 *  test_e2e.js —— 端到端逐字节比对：网页版 vs 桌面版
 *
 *  同一批合成 Thermo 数据，桌面版跑 loaddata + 窗口识别 + dataprocess 出两个 CSV，
 *  网页版跑同一条链（thermo.js → window.js → pipeline.js → report.js）。
 *
 *  三层判据，由外到内，任何一层失败都能立刻定位是哪一段的问题：
 *      ① float→repr 排版   38 个探针，覆盖定点/指数切换边界
 *      ② 输入 CSV 文本     sha256 与 Python 生成的完全相同（否则比对毫无意义）
 *      ③ 输出 CSV          先逐字节，再逐单元格（数值用 === 精确比，字符串按文本比）
 *
 *  用法:  node webgui/test_e2e.js
 * ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const SRC = path.join(__dirname, 'src');
const REF = JSON.parse(fs.readFileSync(path.join(SRC, 'e2e_case.json'), 'utf8'));

/* ---------- 加载模块并接线 ---------- */
const sandbox = { window: {}, console };
vm.createContext(sandbox);
for (const f of ['math.js', 'thermo.js', 'window.js', 'report.js', 'pipeline.js']) {
  vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), sandbox, { filename: f });
}
const DS = sandbox.window.DS;
sandbox.window.DS_WINDOW.setNumeric(DS);
sandbox.window.DS_PIPELINE.attach({
  thermoLoad: sandbox.window.DS_THERMO.thermoLoad,
  thermoSampleName: sandbox.window.DS_THERMO.thermoSampleName,
  detectSignalWindow: sandbox.window.DS_WINDOW.detectSignalWindow,
  nmean: DS.nmean,
  untagInt: DS.untagInt,
  reduceSample: DS.reduceSample,
  buildMeanCpsCsv: sandbox.window.DS_REPORT.buildMeanCpsCsv,
  buildResultAllCsv: sandbox.window.DS_REPORT.buildResultAllCsv,
});
const PL = sandbox.window.DS_PIPELINE;
const RP = sandbox.window.DS_REPORT;
const M = REF.meta;

/* ---------- 与 Python 完全一致的输入生成 ---------- */
function profileOf(shape, n) {
  const p = new Array(n).fill(100);
  const a = Math.trunc(n * 0.25);
  const b = Math.trunc(n * 0.75);
  if (shape === 'step') {
    for (let i = 0; i < n; i++) p[i] = i < a ? 100 : (i < b ? 9000 : 100);
  } else if (shape === 'two_plates') {
    const t1 = Math.trunc(n * 0.5);
    const t2 = Math.trunc(n * 0.6);
    for (let i = 0; i < n; i++) {
      p[i] = i < a ? 100 : (i < t1 ? 8000 : (i < t2 ? 100 : (i < b ? 9000 : 100)));
    }
  } else {
    throw new Error('未知 shape: ' + shape);
  }
  return p;
}

function colOf(j, shape, n) {
  const prof = profileOf(shape, n);
  const w = M.weights[j];
  const c = w % 7;
  const col = new Array(n);
  for (let i = 0; i < n; i++) col[i] = w * prof[i] + c * ((i * 13 + j * 5) % 9);
  return col;
}

function timeText(i) {
  const t = i * 2;
  return Math.floor(t / 100) + '.' + String(t % 100).padStart(2, '0');
}

function makeThermoCsv(sampleName, shape, n) {
  const lines = [];
  lines.push(sampleName + ': synthetic test export');
  for (let k = 1; k <= 12; k++) {
    lines.push('Thermo Fisher iCAP  meta line ' + String(k).padStart(2, '0'));
  }
  lines.push(M.isoname.join(',') + ',Note');
  lines.push(['sec'].concat(new Array(7).fill('cps')).concat(['txt']).join(','));
  const cols = [];
  for (let j = 0; j < 7; j++) cols.push(colOf(j, shape, n));
  for (let i = 0; i < n; i++) {
    const cells = [timeText(i)];
    for (let j = 0; j < 7; j++) cells.push(String(cols[j][i]));
    cells.push('ok');
    lines.push(cells.join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

/* ---------- 比对工具 ---------- */
let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) pass++; else fail++;
  console.log((ok ? '  ok  ' : ' FAIL ') + name.padEnd(22) + detail);
}

function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

function parseCsv(text) {
  return text.split('\r\n').filter((l) => l.length).map((l) => l.split(','));
}

function compareCells(tag, gotText, wantText) {
  const g = parseCsv(gotText), w = parseCsv(wantText);
  if (g.length !== w.length) {
    check(tag + ' 行数', false, `${g.length} != ${w.length}`);
    return;
  }
  let cellBad = 0, numBad = 0, firstBad = null;
  for (let r = 0; r < w.length; r++) {
    if (g[r].length !== w[r].length) {
      check(`${tag} 第${r}行列数`, false, `${g[r].length} != ${w[r].length}`);
      return;
    }
    for (let c = 0; c < w[r].length; c++) {
      const a = g[r][c], b = w[r][c];
      if (a === b) continue;
      cellBad++;
      // 数值层面再判一次：区分"数值错"还是"只是文字排版不同"
      const na = Number(a), nb = Number(b);
      const numeric = Number.isFinite(na) && Number.isFinite(nb) && na === nb;
      if (!numeric) numBad++;
      if (!firstBad) firstBad = `[${r},${c}] js=${a} py=${b}${numeric ? ' (数值相同，仅排版不同)' : ''}`;
    }
  }
  check(tag + ' 单元格', cellBad === 0 && numBad === 0,
    cellBad === 0 ? `${w.length} 行 × ${w[0].length} 列 逐格相同`
      : `${cellBad} 格不同（其中数值不同 ${numBad}），首个 ${firstBad}`);
}

/* ---------- 主流程 ---------- */
function main() {
  console.log('端到端比对：网页版 vs 桌面版（Isoclock2.0.py）');
  console.log(`  Python ${M.python} / NumPy ${M.numpy}   node ${process.version}`);
  console.log(`  ${M.files ? M.files.length : REF.files.length} 个文件 × ${M.n} 点；`
    + `背景窗口 ${M.b0}-${M.b1}s，multi=${M.multi}，stdcor=${M.stdcor}，方法=${M.method}`);
  console.log('');

  /* ① float -> repr 排版 */
  console.log('--- ① float 排版（pyFloatRepr vs Python repr）---');
  let reprBad = 0, firstRepr = null;
  for (const p of M ? REF.repr_probes : []) {
    let v;
    if (p.kind === 'finite') v = p.v;
    else if (p.kind === 'nan') v = NaN;
    else if (p.kind === 'inf') v = Infinity;
    else v = -Infinity;
    const got = RP.pyFloatRepr(v);
    if (got !== p.r) {
      reprBad++;
      if (!firstRepr) firstRepr = `${v} -> js=${JSON.stringify(got)} py=${JSON.stringify(p.r)}`;
    }
  }
  check('repr 探针', reprBad === 0,
    reprBad === 0 ? `${REF.repr_probes.length}/${REF.repr_probes.length} 与 Python repr 逐字相同`
      : `${reprBad} 个不一致，首个 ${firstRepr}`);

  /* ② 输入 CSV 文本 */
  console.log('');
  console.log('--- ② 输入 CSV（哈希必须相同，否则后面比对无意义）---');
  const files = REF.files.map((f) => ({
    file: f.file,
    text: makeThermoCsv(f.sample, f.shape, f.n),
  }));
  for (const f of files) {
    const sha = crypto.createHash('sha256').update(f.text, 'utf8').digest('hex');
    const want = REF.input_sha256[f.file];
    check(f.file, sha === want, sha === want ? 'sha256 一致'
      : `sha256 不同 js=${sha.slice(0, 16)} py=${want.slice(0, 16)}`);
  }

  /* ③ 端到端 */
  console.log('');
  console.log('--- ③ 端到端输出 ---');
  const res = PL.run({
    files,
    isoname: M.isoname,
    b0: M.b0, b1: M.b1, multi: M.multi,
    stdcor: M.stdcor, method: M.method, eleIndex: M.ele_index,
    standardNames: Object.fromEntries(M.standard_names.map((s) => [s, 1])),
    ctx: M.ctx,
  });

  const pairs = [
    ['Mean_Cps.csv', res.meanCpsCsv, REF.expected['Mean_Cps.csv']],
    ['result_all.csv', res.resultAllCsv, REF.expected['result_all.csv']],
  ];
  for (const [tag, got, want] of pairs) {
    const d = firstDiff(got, want);
    check(tag + ' 逐字节', d < 0,
      d < 0 ? `${Buffer.byteLength(got, 'utf8')} 字节完全相同`
        : `第 ${d} 字节起不同 js=${JSON.stringify(got.slice(Math.max(0, d - 20), d + 20))}`
          + ` py=${JSON.stringify(want.slice(Math.max(0, d - 20), d + 20))}`);
  }
  console.log('');
  for (const [tag, got, want] of pairs) compareCells(tag, got, want);

  console.log('');
  console.log(`总计 ${pass + fail} 项：通过 ${pass}，失败 ${fail}`);
  console.log(fail === 0 ? '全部通过。' : '存在失败项，需排查。');
  process.exit(fail === 0 ? 0 : 1);
}

main();
