/* ==========================================================================
 *  test_agilent.js —— Agilent 读取器 vs 真实 Python 参考值（逐位比对）
 *
 *  参考值由 make_agilent_case.py 调用真实的 _load_agilent 生成。
 *  跑法：node test_agilent.js
 * ========================================================================== */
'use strict';
const fs = require('fs');
const vm = require('vm');

function loadModule(path) {
  const sb = { window: {}, console };
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(path, 'utf8'), sb, { filename: path });
  return sb.window;
}

let pass = 0;
let fail = 0;
function t(name, ok, note) {
  if (ok) { pass++; console.log('  ok   ' + name + (note ? '  ' + note : '')); }
  else { fail++; console.log('  FAIL ' + name + (note ? '  ' + note : '')); }
}

const w = loadModule('src/thermo.js');
const THERMO = w.DS_THERMO;
const cases = JSON.parse(fs.readFileSync('src/agilent_cases.json', 'utf8'));

console.log('test_agilent —— Agilent 读取器 vs Python 参考值');
for (const c of cases) {
  let res;
  try {
    res = THERMO.agilentLoad(c.csv, c.isoname);
  } catch (e) {
    t(c.name, false, '抛错: ' + e.message);
    continue;
  }
  let bad = 0;
  let first = '';
  for (const key of ['x', 'y1', 'y2', 'y3', 'y4', 'y5', 'y6', 'y7']) {
    const want = c.hex[key];
    const got = res[key];
    if (got.length !== want.length) { bad++; first = key + ' 长度 ' + got.length + '≠' + want.length; break; }
    for (let i = 0; i < want.length; i++) {
      const g = Buffer.from(want[i], 'hex').readDoubleBE(0);
      if (!Object.is(g, got[i])) { bad++; first = key + '[' + i + '] ' + got[i] + '≠' + g; break; }
    }
    if (bad) break;
  }
  t(c.name + ' 逐位一致', bad === 0, bad ? first : res.x.length + ' 点 × 8 通道');
  t(c.name + ' 提示', JSON.stringify(res.notes || []) === JSON.stringify(c.notes),
    'notes=' + JSON.stringify(res.notes));
}

/* 缺 206/207/238 必须报错（原实现会拿到 None 在下游崩，这里提前指出） */
const broken = 'a,b,c\r\n1,2,3\r\n';
let threw = false;
try { THERMO.agilentLoad(broken, cases[0].isoname); } catch (e) { threw = true; }
t('缺必需列时明确报错', threw);

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
