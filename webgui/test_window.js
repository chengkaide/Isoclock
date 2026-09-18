/* ==========================================================================
 *  test_window.js —— 积分窗口自动识别：JS vs Python 逐位对照
 *
 *  用法:  node webgui/test_window.js
 *
 *  参考值来自 make_window_case.py：它把 Isoclock2.0.py 里 instructure0 的
 *  64 行源码原样 exec 出来跑，逻辑一个字没动。
 *
 *  通道数据由共享公式在两侧各自生成（见 make_window_case.py 顶部说明），
 *  所以 JSON 里只有参数，没有几十万个数字。
 *
 *  判据：逐位相等（0 ULP）。窗口值是 int*|timeinternal| 这类纯乘法与加减，
 *  没有任何超越函数，没有理由不一致。
 * ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, 'src');

const sandbox = { window: {}, console };
vm.createContext(sandbox);
for (const f of ['math.js', 'window.js']) {
  vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), sandbox, { filename: f });
}
const DS = sandbox.window.DS;                 // math.js：成对求和等
const DW = sandbox.window.DS_WINDOW;          // window.js
DW.setNumeric(DS);

const REF = JSON.parse(fs.readFileSync(path.join(SRC, 'window_cases.json'), 'utf8'));
const W = REF.meta.weights;

/* ---------- 与 Python 完全一致的数据生成 ---------- */
function profileOf(shape, n) {
  const p = new Array(n).fill(100);
  if (shape === 'step') {
    const a = Math.trunc(n * 0.15);
    const b = Math.trunc(n * 0.75);
    for (let i = 0; i < n; i++) p[i] = i < a ? 100 : (i < b ? 9000 : 100);
  } else if (shape === 'two_plates') {
    const t = [Math.trunc(n * 0.2), Math.trunc(n * 0.4),
      Math.trunc(n * 0.5), Math.trunc(n * 0.8)];
    for (let i = 0; i < n; i++) {
      p[i] = i < t[0] ? 100 : (i < t[1] ? 8000 : (i < t[2] ? 100 : (i < t[3] ? 9000 : 100)));
    }
  } else if (shape === 'ramp') {
    for (let i = 0; i < n; i++) p[i] = n > 1 ? 100 + Math.floor(i * 8900 / (n - 1)) : 100;
  } else if (shape === 'spike') {
    p[Math.floor(n / 2)] = 900000;
  } else if (shape !== 'flat') {
    throw new Error('未知 shape: ' + shape);
  }
  return p;
}

function channelsOf(shape, n) {
  const prof = profileOf(shape, n);
  const cols = [];
  for (let j = 0; j < W.length; j++) {
    const w = W[j];
    const c = w % 7;
    const col = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      col[i] = w * prof[i] + c * ((i * 13 + j * 5) % 9) / 10.0;
    }
    cols.push(col);
  }
  return cols;
}

/* ---------- 对比 ---------- */
let pass = 0, fail = 0;
const rows = [];

function report(name, ok, detail) {
  if (ok) pass++; else fail++;
  rows.push([ok ? '  ok  ' : ' FAIL ', name, detail]);
}

function main() {
  console.log('积分窗口自动识别：JS vs Python 逐位对照');
  console.log('  参考代码取自 Isoclock2.0.py 第 '
    + REF.meta.source_block_lines.join('-') + ' 行（原样 exec）');
  console.log('  用例 ' + REF.cases.length + ' 个');
  console.log('');

  // 先确认两侧的数据生成器算出的通道一致（不一致就没法比算法）
  let genBad = 0;
  for (const c of REF.cases) {
    const cols = channelsOf(c.shape, c.n);
    if (cols[0].length !== c.n) genBad++;
  }
  report('数据生成器', genBad === 0, `${REF.cases.length} 个用例的通道长度均为 n`);

  for (const c of REF.cases) {
    const cols = channelsOf(c.shape, c.n);
    let got = null, err = null;
    try {
      got = DW.detectSignalWindow({
        n: c.n, channels: cols,
        b0: c.b0, b1: c.b1, timeinternal: c.timeinternal, multi: c.multi,
      });
    } catch (e) {
      err = e;
    }

    if (c.error) {
      const ok = err !== null;
      report(c.name, ok, ok
        ? `两侧都报错（Python ${c.error.split(':')[0]} / JS 抛出）`
        : `Python 报错「${c.error}」，JS 却返回 ${JSON.stringify(got && got.num)}`);
      continue;
    }
    if (err) {
      report(c.name, false, `JS 抛错「${err.message}」，Python 正常返回 ${JSON.stringify(c.num)}`);
      continue;
    }

    const a = got.num, b = c.num;
    if (a.length !== b.length) {
      report(c.name, false, `长度 ${a.length} != ${b.length}`);
      continue;
    }
    let bad = -1;
    for (let i = 0; i < b.length; i++) {
      if (!Object.is(a[i], b[i])) { bad = i; break; }
    }
    report(c.name, bad < 0, bad < 0
      ? `${JSON.stringify(a)}  逐位相等`
      : `第 ${bad} 项 ${a[bad]} != ${b[bad]}（JS ${JSON.stringify(a)} / Python ${JSON.stringify(b)}）`);
  }

  for (const [m, n, d] of rows) console.log(m + n.padEnd(20) + d);
  console.log('');
  console.log(`总计 ${pass + fail} 项：通过 ${pass}，失败 ${fail}`);
  console.log(fail === 0 ? '全部通过。' : '存在失败项，需排查。');
  process.exit(fail === 0 ? 0 : 1);
}

main();
