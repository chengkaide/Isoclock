/* ==========================================================================
 *  test_demo_real.js —— 内置真实示例数据的三道护栏
 *
 *  这套断言里**没有一条**是拿自己的实现自比。三条判据各自独立：
 *
 *  ① 脱敏门禁（能失败的隐私检查）
 *     每个样品名必须落在 {SRM 612, AY-4, S-NN} 里；每个文件第 1 行的
 *     采集时间戳必须已被归零。一旦有人重跑 make_real_demo.py 时放宽了
 *     KEEP_NAMES、或脱敏规则改坏了，真实的产地代号就会进仓库 ——
 *     这里立刻红。
 *     ⚠ 所以**这个文件里不允许出现任何真实代号**（写出来本身就是泄露）。
 *       判据只能写成"名字必须匹配这个白名单"，不能写成"不得等于某某"。
 *
 *  ② 字节门禁
 *     把解出来的 JSON 重新序列化，长度与 sha256 必须与产物里声明的逐字节相同。
 *     掉一段 base64、gzip 头写错、有人手改了一下内嵌数据 —— 都会在这里现形。
 *
 *  ③ 地质门禁（这条最要紧）
 *     AY-4 走**完整管线**（解析 → 窗口 → 分馏校正 → 年龄 → 加权平均）
 *     算出来的年龄，必须落在两个**公开发表**的 ID-TIMS 值的包络内：
 *         Yuan et al. (2011)  158.2 ± 0.4 Ma
 *         Carr et al. (2020)  151.9 ± 2.2 Ma
 *     这两个值本身相差 6.3 Ma（AY-4 的"真值"在文献里就有争议 ——
 *     源方法文档花了一整节讨论它），所以判据取两者中点 ±5 Ma。
 *     它卡得住的是量级错：分馏因子算反、背景窗口取到信号里、普通铅扣错、
 *     U/Pb 比值少乘一个 137.818…… 这些都会让标样偏出几十上百 Ma。
 *     它卡不住的是最后 1~2 Ma 的精度 —— 那本来就不该拿单批数据去主张。
 *
 *  用法:  node webgui/test_demo_real.js
 * ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const SRC = path.join(__dirname, 'src');

/*  demo_real.js 的 decode() 用的是**浏览器**全局量（DecompressionStream /
 *  Response / Blob / atob）。Node 18+ 自己也有这几个，但 vm 沙箱**不继承** ——
 *  必须显式转发。不转发的话，任何想解内置数据的 node 代码都会摔在
 *  "这个浏览器没有 DecompressionStream"上，而报错信息会把人引向错误的方向。
 */
const sandbox = {
  window: {}, console,
  DecompressionStream, Response, Blob, atob, btoa,
  Uint8Array, ArrayBuffer, TextDecoder, TextEncoder, Promise,
};
vm.createContext(sandbox);
for (const f of ['fp.js', 'math.js', 'thermo.js', 'window.js', 'report.js',
                 'pipeline.js', 'age.js', 'qc.js', 'demo_real.js']) {
  vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), sandbox, { filename: f });
}

const W = sandbox.window;
const FP = W.DS_FP, M = W.DS, TH = W.DS_THERMO, RP = W.DS_REPORT;
const WIN = W.DS_WINDOW, PL = W.DS_PIPELINE, AGE = W.DS_AGE, QC = W.DS_QC;
const D = W.DS_DEMO_REAL;

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) pass++; else { fail++; failures.push(name); }
  console.log((ok ? '  ok  ' : ' FAIL ') + name.padEnd(52) + (detail || ''));
}
function near(a, b, tol) {
  if (!isFinite(a) || !isFinite(b)) return false;
  return Math.abs(a - b) <= tol;
}

/* ---- 接线必须与 ui/app.js 第 32-48 行完全一致，否则量出来的不是界面的行为 ---- */
WIN.setNumeric(M);
PL.attach({
  thermoLoad: TH.thermoLoad, agilentLoad: TH.agilentLoad,
  thermoSampleName: TH.thermoSampleName, detectSignalWindow: WIN.detectSignalWindow,
  nmean: M.nmean, untagInt: M.untagInt, reduceSample: M.reduceSample,
  buildMeanCpsCsv: RP.buildMeanCpsCsv, buildResultAllCsv: RP.buildResultAllCsv,
});
AGE.attach({
  pwSum: M.pwSum, nnanmean: M.nnanmean,
  age76Pb: M.age76Pb, age76PbFixed: M.age76PbFixed, sk2model: M.sk2model,
});
const ISONAME = ['Time', '202Hg', '204Pb', '206Pb', '207Pb', '208Pb', '232Th', '238U'];

/*  calAge —— ui/app.js 第 119 行那个闭式（Isoclock2.0.py:3096）。
 *  照抄而不是 import app.js：app.js 一加载就要 document，在 node 里跑不起来。
 *  这里只抄 8 行算术，且下面第 ③ 条判据架在公开文献值上，
 *  所以"抄错了自己也不知道"这个风险不成立 —— 抄错就出不来 157 Ma。 */
function calAge(age) {
  const a = FP.dexp(0.000000000155125 * age * 1000000) - 1;
  const b = FP.dexp(0.00000000098485 * age * 1000000) - 1;
  const c = FP.dexp(0.000000000049475 * age * 1000000) - 1;
  const P382 = 1 / 137.818 * (b / a);
  const Q8 = 18.700 - a * 9.735;
  const R8 = 15.628 - b * (9.735 / 137.818);
  return {
    a, b, c, P382, Q8, R8, S8: 38.630 - c * 36.837, Pbc: R8 / Q8, Standard_age: age,
  };
}

//  公开发表的 AY-4 年龄 —— 判据的来源，**不是**本程序的输出
const LIT = [
  { who: 'Yuan et al. (2011)', age: 158.2, s2: 0.4 },
  { who: 'Carr et al. (2020)', age: 151.9, s2: 2.2 },
];
const LIT_MID = (LIT[0].age + LIT[1].age) / 2;      // 155.05
const LIT_TOL = 5.0;                                 // 比任何一个发表值都宽

function main() {
  console.log('内置真实示例数据：脱敏 / 字节 / 地质 三道护栏');

  if (!D) { check('产物里存在 window.DS_DEMO_REAL', false, '没找到'); return; }
  check('产物里存在 window.DS_DEMO_REAL', true, D.encoding);

  return D.decode().then(function (files) {
    const P = D.params;

    /* ---------- ① 脱敏门禁 ---------- */
    const kept = ['SRM 612', 'AY-4'];
    const allowed = new RegExp('^(?:' + kept.map(esc).join('|') + '|S-\\d\\d)$');
    const names = files.map(function (f) { return f.name; });
    const leaks = [];
    for (const n of names) if (!allowed.test(n)) leaks.push(n);
    check('每个样品名都落在白名单内', leaks.length === 0,
      leaks.length ? '越界 ' + leaks.length + ' 个，例如 ' + JSON.stringify(leaks[0])
                   : names.length + ' 个名字全部合规');

    check('样品代号编号连续且不重复（S-01…S-NN）', (function () {
      const s = names.filter(function (n) { return /^S-\d\d$/.test(n); });
      const uniq = Array.from(new Set(s)).sort();
      if (uniq.length !== s.length) return false;         // 有重复 → 映射失败
      for (let i = 0; i < uniq.length; i++) {
        if (uniq[i] !== 'S-' + String(i + 1).padStart(2, '0')) return false;
      }
      return true;
    })(), Array.from(new Set(names.filter(function (n) { return /^S-/.test(n); })))
      .length + ' 个不同样品号');

    check('标样保留原名', names.indexOf('SRM 612') >= 0 && names.indexOf('AY-4') >= 0,
      'SRM 612 ×' + names.filter(function (n) { return n === 'SRM 612'; }).length
      + '、AY-4 ×' + names.filter(function (n) { return n === 'AY-4'; }).length);

    const ALLOWED_NAMES = new Set(kept.concat(
      names.filter(function (n) { return /^S-\d\d$/.test(n); })));
    const leftover = names.filter(function (n) { return !ALLOWED_NAMES.has(n); });
    check('原始代号一个都没留下（白名单之外无别名）', leftover.length === 0,
      leftover.length ? leftover.length + ' 个' : '0 个');

    const timeRe = /^[^:]*:01\/01\/2020 12:00:00 AM;?\r?$/;
    const badTime = files.filter(function (f) {
      return !timeRe.test(f.text.split('\n')[0]);
    });
    check('每个文件第 1 行的采集时间已归零', badTime.length === 0,
      badTime.length ? badTime.slice(0, 2).map(function (f) { return f.file; }).join('、')
                     : files.length + ' 个文件全部归零');

    const badFile = files.filter(function (f) { return !/^sample_\d\d\.csv$/.test(f.file); });
    check('文件名已改成 sample_NN.csv', badFile.length === 0,
      badFile.length ? badFile[0].file : files.length + ' 个');

    /* ---------- ② 字节门禁 ---------- */
    const raw = JSON.stringify(files);
    const buf = Buffer.from(raw, 'utf8');
    check('重算的明文长度与产物声明一致', buf.length === D.rawBytes,
      buf.length + ' vs ' + D.rawBytes);
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    check('重算的 sha256 与产物声明一致', sha === D.sha256,
      sha.slice(0, 16) + ' vs ' + String(D.sha256).slice(0, 16));

    /* ---------- 读回：真阅读器必须认得出这批文件 ---------- */
    let strict = 0;
    const readFail = [];
    for (const f of files) {
      try {
        const o = TH.thermoLoad(f.text, ISONAME, {});
        if (o.mode === 'strict') strict++; else readFail.push(f.file + ':' + o.mode);
      } catch (e) { readFail.push(f.file + ':' + e.message); }
    }
    check('全部走真阅读器的严格路径', strict === files.length && !readFail.length,
      strict + '/' + files.length + (readFail.length ? ' ' + readFail[0] : ''));

    /* ---------- ③ 地质门禁：AY-4 必须对得上公开文献 ---------- */
    const cal = calAge(P.stdAge);
    const stdSet = {}; stdSet[P.stdName] = P.stdAge;
    const out = PL.run({
      files: files, isoname: ISONAME, b0: P.b0, b1: P.b1, multi: P.multi,
      stdcor: 0, method: P.method, standardNames: stdSet, ctx: cal,
      eleIndex: 2, instrument: P.inst, sampleNames: null,
    });
    const input = AGE.buildInput(out.resultAllCsv, out.meanCpsCsv, null);
    input.fix76 = false;
    input.cfg = {
      method: P.method, excessV: P.excess / 100, nistStd: P.nistStd,
      standard: P.fracStd, P382: cal.P382, a: cal.a, b: cal.b, c: cal.c, Pbc: cal.Pbc,
      age: 100, radioactivePb: 0.048015, commonPb: 0.842185,
      commonPb206_208: 0.48240, commonPb207_208: 0.40628,
      commonPb206_204: 18.5478, commonPb207_204: 15.6207, commonPb208_204: 38.447,
      radioactiveSPb207_206: cal.P382,
    };
    const res = (P.algo === 'avg') ? AGE.averageAge(input) : AGE.linearAge(input);

    //  ⚠ QC_UNCORR_COL / QC_CORR_COL 是 **0 基**（qc.js 第 34 行写明了），
    //    直接拿来当下标，别再减 1 —— 减了就变成读 2s 列，
    //    而 2s 列看着也是"数"，不会报错，只会让年龄静默地错掉。
    const pick = QC.qcDefaultAge(P.method, '206Pb/238U');
    const col = QC.qcAgeCol(P.method, pick.key, pick.corrected);
    check('年龄列由 qc.js 的映射给出（不是硬编码）', typeof col === 'number' && col >= 0,
      pick.key + (pick.corrected ? '（校正后）' : '（未校正）') + ' → 0 基第 ' + col + ' 列');
    check('列映射与表头对得上',
      String(res.header[col]).indexOf(pick.key.replace('/', '_')) >= 0,
      '第 ' + col + ' 列的表头是 "' + res.header[col] + '"');

    const groups = QC.qcGroupBySample(res.rows);
    let std = null;
    for (const g of groups) {
      if (g.name !== P.stdName) continue;
      std = {
        rows: g.rows.length,
        w: QC.qcWavg(g.rows.map(function (r) {
          return { age: +r[col], s2: +r[col + QC.QC_ERR_OFFSET] };
        })),
      };
    }
    if (!std) { check('找到标样 ' + P.stdName, false, '没有这一组'); return; }
    const mean = std.w.mean, se2 = std.w.se * 2, mswd = std.w.mswd;

    for (const L of LIT) {
      check('标样年龄与 ' + L.who + '（' + L.age + ' ± ' + L.s2 + ' Ma）相容',
        near(mean, L.age, Math.max(LIT_TOL, L.s2 + 3)),
        '实测 ' + mean.toFixed(2) + ' Ma，差 ' + (mean - L.age).toFixed(2) + ' Ma');
    }
    check('标样年龄落在两个发表值的中点 ±' + LIT_TOL + ' Ma 内',
      near(mean, LIT_MID, LIT_TOL),
      '实测 ' + mean.toFixed(2) + '，中点 ' + LIT_MID.toFixed(2)
      + '，偏 ' + (mean - LIT_MID).toFixed(2) + ' Ma');
    check('标样内部自洽（MSWD < 2）', mswd < 2,
      'MSWD ' + mswd.toFixed(2) + '，2σ ' + se2.toFixed(2) + ' Ma');
    check('标样参与点数 + 剔除点数 = 文件数',
      std.w.n + std.w.dropped === std.rows,
      std.w.n + ' + ' + std.w.dropped + ' = ' + std.rows);

    /* ---------- 产物里"声明"的标样值，必须就是这里刚量出来的那个 ----------
     *
     * stdMeasured 是给界面日志和文档正文引用的（正文那句"AY-4 出 157.0 ±
     * 1.4 Ma"就是从它来的）。所以它必须与**这次真跑**的结果一致，否则文档
     * 就会拿着一个过期的数往外说 —— 而且没有任何人会发现。
     * 这是本文件里最该有的一条断言。 */
    const M = D.stdMeasured;
    check('产物声明的标样结果与本次实测一致',
      !!M && Math.abs(M.mean - mean) < 1e-6 && Math.abs(M.mswd - mswd) < 1e-6
      && Math.abs(M.se2 - se2) < 1e-6 && M.n === std.w.n,
      M ? ('声明 ' + M.mean.toFixed(2) + ' ± ' + M.se2.toFixed(2) + ' Ma（'
        + M.sigma + '）、MSWD ' + M.mswd.toFixed(2) + '、' + M.n + ' 点 ｜ 实测 '
        + mean.toFixed(2) + ' ± ' + se2.toFixed(2) + '、MSWD ' + mswd.toFixed(2)
        + '、' + std.w.n + ' 点') : '没有 stdMeasured');
    check('产物声明的标样误差口径写着 σ（免得与报告里的 1σ 混）',
      !!M && /σ/.test(String(M.sigma)) && M.unit === 'Ma',
      M ? ('sigma = ' + M.sigma + '，unit = ' + M.unit) : '没有 stdMeasured');

    /* ---------- NaN 清单与产物自己声明的一致 ---------- */
    const nan = res.rows.filter(function (r) {
      return !isFinite(+r[col]) || !isFinite(+r[col + QC.QC_ERR_OFFSET]);
    }).map(function (r) { return String(r[0]); }).sort();
    const declared = ((D.flaws && D.flaws.nanRows) || [])
      .map(function (x) { return x.file; }).sort();
    check('NaN 清单与产物里声明的一致', JSON.stringify(nan) === JSON.stringify(declared),
      nan.length + ' 个：' + nan.join('、'));

    /* ---------- 参数自洽：产物声明的参数就是测试用的参数 ---------- */
    check('产物自带的 params 齐全', ['inst', 'b0', 'b1', 'multi', 'stdName', 'stdAge',
      'fracStd', 'nistStd', 'method', 'algo', 'excess'].every(function (k) {
      return P[k] !== undefined && P[k] !== null && P[k] !== '';
    }), Object.keys(P).length + ' 项');

    //  窗口敏感性：换几组合理窗口，标样不能跟着跳 —— 跳说明卡在刀刃上
    const swings = [];
    for (const [b0, b1] of [[1, 25], [5, 20], [8, 16], [2, 28]]) {
      const o2 = PL.run({
        files: files, isoname: ISONAME, b0: b0, b1: b1, multi: P.multi,
        stdcor: 0, method: P.method, standardNames: stdSet, ctx: cal,
        eleIndex: 2, instrument: P.inst, sampleNames: null,
      });
      const i2 = AGE.buildInput(o2.resultAllCsv, o2.meanCpsCsv, null);
      i2.fix76 = false; i2.cfg = input.cfg;
      const r2 = (P.algo === 'avg') ? AGE.averageAge(i2) : AGE.linearAge(i2);
      const g2 = QC.qcGroupBySample(r2.rows).filter(function (g) {
        return g.name === P.stdName;
      })[0];
      if (g2) {
        swings.push(QC.qcWavg(g2.rows.map(function (r) {
          return { age: +r[col], s2: +r[col + QC.QC_ERR_OFFSET] };
        })).mean);
      }
    }
    const spread = Math.max.apply(null, swings) - Math.min.apply(null, swings);
    check('窗口变化时标样年龄不跳（极差 < 2 Ma）', spread < 2,
      swings.map(function (v) { return v.toFixed(2); }).join(' / ')
      + '，极差 ' + spread.toFixed(3) + ' Ma');

    console.log('');
    console.log('结果：' + pass + ' 通过 / ' + fail + ' 失败');
    if (fail) {
      console.log('失败项：');
      for (const f of failures) console.log('  - ' + f);
      process.exitCode = 1;
    }
  }).catch(function (e) {
    console.log(' FAIL 解码或计算抛异常：' + ((e && e.stack) || e));
    process.exitCode = 1;
  });
}

function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

main();
