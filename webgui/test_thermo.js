/* ==========================================================================
 *  test_thermo.js —— Thermo 读取器：JS vs Python 逐位对照
 *
 *  用法:  node webgui/test_thermo.js
 *
 *  读取是纯解析，没有任何数学运算，所以判据是**逐位相等**（0 ULP），不留容差。
 *  数值来自 make_thermo_case.py 调用的**真实 loaddata()**，不是重写的公式。
 * ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, 'src');

const sandbox = { window: {}, console };
vm.createContext(sandbox);
for (const f of ['thermo.js']) {
  vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), sandbox, { filename: f });
}
const DS = sandbox.window.DS_THERMO;

const REF = JSON.parse(fs.readFileSync(path.join(SRC, 'thermo_cases.json'), 'utf8'));

let pass = 0, fail = 0;
const rows = [];

function report(name, ok, detail) {
  if (ok) pass++; else fail++;
  rows.push([ok ? '  ok  ' : ' FAIL ', name, detail]);
}

const CH = ['x', 'y1', 'y2', 'y3', 'y4', 'y5', 'y6', 'y7'];

function main() {
  console.log('Thermo 读取器：JS vs Python 逐位对照');
  console.log('  用例 ' + REF.cases.length + ' 个，每个 ' + REF.meta.n_data
    + ' 个数据点；列名行在第 ' + (REF.meta.header_lines + 1) + " 行");
  console.log('');

  for (const c of REF.cases) {
    let got = null, err = null;
    try {
      got = DS.thermoLoad(c.csv, REF.meta.isoname);
    } catch (e) {
      err = e;
    }

    if (c.error) {
      // Python 抛了异常，JS 也必须抛（保持行为一致：宁可报错，不要静默出错数据）
      const ok = err !== null;
      report(c.name, ok,
        ok ? `两侧都报错（Python ${c.error} / JS 抛出）`
           : `Python 报 ${c.error}，但 JS 未报错 -> 会静默产出错误数据！`);
      continue;
    }

    if (err) {
      report(c.name, false, `JS 抛错 ${err.message.slice(0, 70)}，Python 正常返回`);
      continue;
    }

    let mism = 0, firstBad = null, total = 0;
    for (const k of CH) {
      const want = c.channels[k];
      const gotArr = got[k];
      if (!gotArr || gotArr.length !== want.length) {
        report(c.name, false, `通道 ${k} 长度 ${gotArr ? gotArr.length : 'null'}`
          + ` != ${want.length}`);
        mism = -1;
        break;
      }
      for (let i = 0; i < want.length; i++) {
        total++;
        const w = want[i];
        const g = gotArr[i];
        const eq = (w === null) ? Number.isNaN(g) : (g === w);
        if (!eq) { mism++; if (!firstBad) firstBad = `${k}[${i}] py=${w} js=${g}`; }
      }
    }
    if (mism === -1) continue;
    report(c.name, mism === 0,
      mism === 0
        ? `${total}/${total} 个数值逐位相等（8 通道）`
        : `${mism}/${total} 处不一致，首个：${firstBad}`);
  }

  // 样品名提取：参考值由真实的 csv.reader 产生（make_thermo_case.py）
  console.log('');
  console.log('--- 样品名提取（Thermo 无 LIST 文件，名字取自文件第一行）---');
  for (const c of REF.sample_names) {
    const got = DS.thermoSampleName(c.line + '\n' + 'x'.repeat(10));
    const ok = got === c.name;
    report('sampleName', ok,
      JSON.stringify(c.line) + ' -> ' + JSON.stringify(got)
      + (ok ? '' : '  期望 ' + JSON.stringify(c.name)));
  }

  for (const [mark, name, detail] of rows) {
    console.log(mark + name.padEnd(20) + detail);
  }
  console.log('');
  console.log(`总计 ${pass + fail} 项：通过 ${pass}，失败 ${fail}`);
  console.log(fail === 0 ? '全部通过。' : '存在失败项，需排查。');
  process.exit(fail === 0 ? 0 : 1);
}

main();
