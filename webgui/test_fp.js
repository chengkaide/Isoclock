/* ==========================================================================
 *  test_fp.js —— fp.js（自实现的正确舍入 exp / log）验收
 *
 *  判据：
 *      ① 正确舍入      src/fp.js 的 crExp / crLog 与参考值（Python decimal 算的
 *                      60 位结果再舍入）逐位相同 —— 覆盖率见夹具
 *      ② 不可被顶掉    crExp / crLog 不是 Math.exp / Math.log 的别名
 *                      （宿主某台机器上恰好更准，也不能因此放行一个"直接用宿主"
 *                       的实现 —— 那样①就失去区分力了）
 *      ③ 偏差有界      crExp 与 Math.exp 的差始终在 1 ULP 以内（不是实现跑飞了）
 *      ④ 边界行为      0 / 1 / ±Inf / NaN 与 Math.exp / Math.log 一致
 *
 *  关于 ②：原来这里是"宿主确有差异（动机成立）"。`Math.exp` / `Math.log` 的
 *  精度**随引擎与机器变** —— macOS 的 JavaScriptCore 和一部分机器上的 WebView2
 *  在这批点上就是与正确舍入一致的。把环境属性写成断言，同一个文件就会在开发机
 *  上过、在 CI 上挂（真踩过）。差异的具体数量仍然打印出来，只是不判通过与否。
 *
 *  用法:  node webgui/test_fp.js
 * ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, 'src');
const CASE = JSON.parse(fs.readFileSync(path.join(SRC, 'fp_case.json'), 'utf8'));

const sandbox = { window: {}, console };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(SRC, 'fp.js'), 'utf8'), sandbox,
  { filename: 'fp.js' });
const FP = sandbox.window.DS_FP;

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) pass++; else { fail++; failures.push(name); }
  console.log((ok ? '  ok  ' : ' FAIL ') + name.padEnd(28) + (detail || ''));
}

const buf = new ArrayBuffer(8);
const f64 = new Float64Array(buf);
const u64 = new BigUint64Array(buf);
const toHex = (x) => { f64[0] = x; return u64[0].toString(16).padStart(16, '0'); };
const fromHex = (h) => { u64[0] = BigInt('0x' + h); return f64[0]; };

/** 两个 double 之间差多少个 ULP（同号时）。 */
function ulpGap(a, b) {
  if (Object.is(a, b)) return 0;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Infinity;
  if (a === 0 || b === 0) return Infinity;
  f64[0] = a; let ia = u64[0];
  f64[0] = b; let ib = u64[0];
  if (ia < ib) { const t = ia; ia = ib; ib = t; }
  return Number(ia - ib);
}

function main() {
  console.log('fp.js：正确舍入的 exp / log');
  console.log(`  参考值由 Python ${CASE.meta.python} 用 decimal(${CASE.meta.decimals} 位) 生成`);
  console.log(`  exp ${CASE.meta.exp_count} 个自变量 / log ${CASE.meta.log_count} 个自变量`);
  console.log('');

  for (const [name, fn, host] of [['crExp', FP.crExp, Math.exp],
    ['crLog', FP.crLog, Math.log]]) {
    const pairs = CASE[name === 'crExp' ? 'exp' : 'log'];
    let bad = 0, first = null;
    let hostDiff = 0, hostFirst = null, maxUlp = 0, maxUlpAt = null;
    for (const [ah, ch] of pairs) {
      const x = fromHex(ah);
      const want = fromHex(ch);
      const got = fn(x);
      if (!Object.is(got, want)) {
        bad++;
        if (!first) first = `x=${x} js=${toHex(got)} ref=${ch}`;
      }
      const h = host === Math.log && x <= 0 ? NaN : host(x);
      if (!Object.is(h, want) && !(Number.isNaN(h) && Number.isNaN(want))) {
        hostDiff++;
        if (!hostFirst) hostFirst = `x=${x} host=${h} cr=${want}`;
      }
      const g = ulpGap(got, want);
      if (g > maxUlp) { maxUlp = g; maxUlpAt = `x=${x}`; }
    }
    check(`${name} 逐位等于正确舍入`, bad === 0,
      bad === 0 ? `${pairs.length} 个点全部逐位相同`
        : `${bad}/${pairs.length} 个点不同，首个 ${first}`);
    /* 宿主更准还是更差，是**环境属性**，不能当判据。
       原先这条写的是 `hostDiff > 0`（"动机成立"），但 `Math.exp` / `Math.log`
       的精度随引擎与机器变：macOS 的 JavaScriptCore 与一部分机器上的
       WebView2 在这批点上就是与正确舍入一致的。写死成断言，结果就是同一个
       文件在开发机上过、在 CI 上挂 —— 挂的不是软件，是机器。
       真正要守住的是：**自实现不是宿主的别名**。宿主越准，上面那条
       "逐位等于正确舍入"就越没有区分力（crExp 直接指到 Math.exp 也能过），
       所以这一条必须独立存在。差异数量只打印出来当参考。 */
    check(`${name} 自实现不是宿主函数的别名`, fn !== host,
      `宿主与正确舍入不同的点：${hostDiff}/${pairs.length}`
      + (hostDiff ? `（首个 ${hostFirst}）` : ' —— 这台机器的宿主本身就够准，属正常'));
    check(`${name} 与正确舍入最远 ${maxUlp} ULP`, maxUlp <= 1,
      `最大 ${maxUlp} ULP @${maxUlpAt}`);
  }

  /* ④ 边界行为与宿主一致 */
  const edge = [
    ['crExp(+Inf)', FP.crExp(Infinity), Math.exp(Infinity)],
    ['crExp(-Inf)', FP.crExp(-Infinity), Math.exp(-Infinity)],
    ['crExp(NaN)', FP.crExp(NaN), Math.exp(NaN)],
    ['crExp(0)', FP.crExp(0), Math.exp(0)],
    ['crExp(710) 溢出', FP.crExp(710), Math.exp(710)],
    ['crExp(-746) 下溢', FP.crExp(-746), Math.exp(-746)],
    ['crLog(1)', FP.crLog(1), Math.log(1)],
    ['crLog(0)', FP.crLog(0), Math.log(0)],
    ['crLog(+Inf)', FP.crLog(Infinity), Math.log(Infinity)],
    ['crLog(NaN)', FP.crLog(NaN), Math.log(NaN)],
    ['crLog(-1) 定义域', FP.crLog(-1), Math.log(-1)],
  ];
  let eBad = 0, eFirst = null;
  for (const [label, a, b] of edge) {
    const ok = (Number.isNaN(a) && Number.isNaN(b)) || Object.is(a, b);
    if (!ok) { eBad++; if (!eFirst) eFirst = `${label}: js=${a} host=${b}`; }
  }
  check('边界行为与宿主一致', eBad === 0,
    eBad === 0 ? `${edge.length} 个边界情形全部一致` : eFirst);

  /* ⑤ dexp / dlog 的切换开关真的生效 */
  const x0 = 1.2345;
  FP.usePlatformExpLog();
  const hostMode = FP.dexp(x0) === Math.exp(x0) && FP.dlog(x0) === Math.log(x0);
  FP.useSelfExpLog();
  const selfMode = FP.dexp(x0) === FP.crExp(x0) && FP.dlog(x0) === FP.crLog(x0);
  check('dexp/dlog 切换开关', hostMode && selfMode,
    hostMode && selfMode ? 'usePlatformExpLog / useSelfExpLog 都生效' : '开关不生效');

  console.log('');
  console.log(`总计 ${pass + fail} 项：通过 ${pass}，失败 ${fail}`);
  if (fail) console.log('失败项：' + failures.join(' / '));
  console.log(fail === 0 ? '全部通过。' : '存在失败项，需排查。');
  process.exit(fail === 0 ? 0 : 1);
}

main();
