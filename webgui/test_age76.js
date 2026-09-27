/* ==========================================================================
 *  test_age76.js —— age76PbFixed vs Python 参考值（逐位）+ 收敛性质
 *
 *  参考值由 make_age76_case.py 生成（pycr 正确舍入 exp/log）。
 *  跑法：node test_age76.js
 * ========================================================================== */
'use strict';
const fs = require('fs');
const vm = require('vm');

function loadModules(paths) {
  const sb = { window: {}, console };
  vm.createContext(sb);
  for (const p of paths) {
    vm.runInContext(fs.readFileSync(p, 'utf8'), sb, { filename: p });
  }
  return sb.window;
}

let pass = 0;
let fail = 0;
function t(name, ok, note) {
  if (ok) { pass++; console.log('  ok   ' + name + (note ? '  ' + note : '')); }
  else { fail++; console.log('  FAIL ' + name + (note ? '  ' + note : '')); }
}

const w = loadModules(['src/fp.js', 'src/math.js']);
const M = w.DS;
const cases = JSON.parse(fs.readFileSync('src/age76_case.json', 'utf8'));

console.log('test_age76 —— Age76Pb 修正版 vs Python 参考值');
let bad = 0;
let first = '';
for (const c of cases) {
  const r = Buffer.from(c.arg, 'hex').readDoubleBE(0);
  const wantF = Buffer.from(c.fixed, 'hex').readDoubleBE(0);
  const wantL = c.legacy === null ? null : Buffer.from(c.legacy, 'hex').readDoubleBE(0);
  const gotF = M.age76PbFixed(r);
  const gotL = M.age76Pb(r);
  if (!Object.is(gotF, wantF)) { bad++; first = 'fixed(' + r + ')=' + gotF + '≠' + wantF; break; }
  if (wantL !== null && !Object.is(gotL, wantL)) { bad++; first = 'legacy(' + r + ')=' + gotL + '≠' + wantL; break; }
}
t('4557 个自变量逐位一致（修正版 + 原版）', bad === 0, bad ? first : '');

/* 收敛对比：修正版受"判据 ≤5e-5 + 10 轮上限"双重约束（上限是原设计，保留）；
 * 原版则完全不受判据约束（判据失效、恒跑 10 轮），极端时首轮就退出返回 0。
 * 断言：修正版 ≥85% 的点达 5e-5、最坏 ≤1e-4；并报告原版作对照。 */
let worst = 0;
let worstR = 0;
let within = 0;
let counted = 0;
let legWithin = 0;
let legZero = 0;
for (const c of cases) {
  const r = Buffer.from(c.arg, 'hex').readDoubleBE(0);
  const f = M.age76PbFixed(r);
  const l = M.age76Pb(r);
  if (r > 0.0460455 && l === 0) legZero++;          // 原版首轮即退出，返回 0 岁
  if (f === 0) continue;
  counted++;
  const gf = Math.abs(M.rap76(f) - r);
  if (gf <= 0.00005) within++;
  if (gf > worst) { worst = gf; worstR = r; }
  if (l > 0 && Math.abs(M.rap76(l) - r) <= 0.00005) legWithin++;
}
t('修正版 ' + within + '/' + counted + ' 点达 5e-5 判据（最坏 ' + worst.toExponential(2)
  + '），其余受原设计保留的 10 轮上限约束',
  within >= counted * 0.85 && worst <= 0.0001, '@R=' + worstR);
console.log('  对照：原版仅 ' + legWithin + '/' + counted + ' 点达 5e-5，'
  + '另有 ' + legZero + ' 点在阈值之上却直接返回 0 岁');

let legacyDiff = 0;
for (const c of cases) {
  const r = Buffer.from(c.arg, 'hex').readDoubleBE(0);
  const f = M.age76PbFixed(r);
  const l = M.age76Pb(r);
  //  排除"原版直接返回 0"的退化点（判据在首轮就满足、循环一次不跑）——
  //  那是原版缺陷的一部分，量级单独列，不混进"迭代 10 次造成的偏差"里。
  if (f > 0 && l > 0) legacyDiff = Math.max(legacyDiff, Math.abs(f - l));
}
console.log('修正版相对原实现的最大年龄差（两边都非 0 时）：' + legacyDiff.toFixed(1) + ' Ma');
console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
