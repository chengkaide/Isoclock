/* ==========================================================================
 *  test_thermo_compat.js —— Thermo 兼容读取（表头行探测 + 列名变体）
 *
 *  背景：桌面版的 Thermo 读取器有两处硬编码 —— 表头固定取原始第 14 行、
 *  列名按 'Time'/'238U' 之类**精确相等**匹配。换一版 Qtegra/iCAP 软件、
 *  或者中间用 Excel 另存过一次，这两处就可能对不上，桌面版会直接报
 *  "列名未找到"。网页版加了一条兜底路径（先严格、失败才自适应探测）。
 *
 *  【判据】这套测试**不比对任何 Python 参考值** —— 因为兼容路径本身就是
 *  "超出桌面版能力"的那部分，没有参考可比。改用两条自洽的判据：
 *
 *    ① 同一组数值，写成各种变形文件，读出来必须与标准文件**逐位相同**。
 *       数值一致是硬要求；差一位就说明列找错了。
 *    ② 变形文件在**严格模式**下必须失败。这一条是①的反面保障：
 *       如果某个变形连严格模式都能读，那它就不该出现在"兼容救活了什么"
 *       的清单里，说明用例构造错了，或者兼容路径把不该救的也救了。
 *
 *  另外单独验两件事：
 *    · 标准文件在默认模式下 mode 必须是 'strict' —— 走兜底就等于改了行为；
 *    · 重排列顺序这种**严格模式本来就能读**的情形，两种模式结果必须一致。
 *
 *  用法:  node webgui/test_thermo_compat.js
 * ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, 'src');
const sandbox = { window: {}, console };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(SRC, 'thermo.js'), 'utf8'), sandbox,
  { filename: 'thermo.js' });
const TH = sandbox.window.DS_THERMO;
const ISO = TH.THERMO_ISONAME;

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) pass++; else { fail++; failures.push(name); }
  console.log((ok ? '  ok  ' : ' FAIL ') + name.padEnd(40) + (detail || ''));
}

/* --------------------------------------------------------------------------
 *  造文件
 * ----------------------------------------------------------------------- */

const N = 21;
const META = 'Thermo Fisher / iCAP  meta ';
const SAMPLE_LINE = 'Sample MAD-NEW-1: some instrument note';
const STD_NAMES = ['Time', '202Hg', '204Pb', '206Pb', '207Pb', '208Pb', '232Th', '238U'];

/** 第 r 行第 k 个通道的值：列列不同、行行不同，逐位比对才有意义。 */
function cell(r, k) { return (1000 * k + r * 7.25 + 0.000001 * k * k).toFixed(6); }

/**
 * 造一个 Thermo 形状的文件。
 * @param {object} o
 *   meta      元信息行数（标准 13）
 *   names     列名数组（默认标准列名）
 *   order     列顺序，0=时间、1..7 对应 202Hg…238U（默认原序）
 *   commentAt 在第 commentAt 个元信息行之后插一行 '#' 注释（-1 不插）
 *   blankLine 在第 blankLine 个元信息行之后插一个空行（-1 不插）
 */
function build(o) {
  o = o || {};
  const meta = o.meta === undefined ? 13 : o.meta;
  const names = o.names || STD_NAMES;
  const order = o.order || [0, 1, 2, 3, 4, 5, 6, 7];
  const head = [];
  for (let i = 0; i < meta; i++) head.push(META + (i + 1));
  if (head.length) head[0] = SAMPLE_LINE;
  if (o.commentAt >= 0) head.splice(o.commentAt, 0, '# a comment line inside the header region');
  if (o.blankLine >= 0) head.splice(o.blankLine, 0, '');
  const L = head.concat();
  L.push(order.map(function (k) { return names[k]; }).join(','));
  L.push(order.map(function () { return 'unit'; }).join(','));
  for (let r = 0; r < N; r++) {
    const raw = [(r * 0.02).toFixed(6)];
    for (let k = 1; k <= 7; k++) raw.push(cell(r, k));
    L.push(order.map(function (k) { return raw[k]; }).join(','));
  }
  return L.join('\n');
}

/** 读一次。strict=true 时强制走桌面版那条严格路径。 */
function read(text, strict) {
  return TH.thermoLoad(text, ISO, strict ? { compat: false } : undefined);
}

const KEYS = ['x', 'y1', 'y2', 'y3', 'y4', 'y5', 'y6', 'y7'];

/** 逐位比两套通道。相同返回 null，不同返回第一处差异的描述。 */
function diff(a, b) {
  for (const k of KEYS) {
    if (a[k].length !== b[k].length) return k + ' 长度不同 ' + a[k].length + ' vs ' + b[k].length;
    for (let i = 0; i < a[k].length; i++) {
      if (!Object.is(a[k][i], b[k][i])) {
        return k + '[' + i + '] ' + a[k][i] + ' ≠ ' + b[k][i];
      }
    }
  }
  return null;
}

function throws(fn) {
  try { fn(); return null; } catch (e) { return e.message; }
}

/* --------------------------------------------------------------------------
 *  跑
 * ----------------------------------------------------------------------- */

function main() {
  console.log('Thermo 兼容读取：变形文件 vs 标准文件，逐位对照');
  console.log('  数据 ' + N + ' 点；标准文件表头在第 14 行，数据从第 16 行起');
  console.log('');

  const STD = build({});
  const base = read(STD);
  if (base.x.length !== N) {
    console.log('基准读取就错了：期望 ' + N + ' 点，得到 ' + base.x.length + ' 点');
    process.exit(1);
  }

  /* ---- ① 标准文件必须走严格路径 ---- */
  console.log('--- ① 标准文件不能走兜底 ---');
  check('标准文件 mode = strict', base.mode === 'strict',
    '实际 mode=' + base.mode + '（走兜底就等于改了标准文件的行为）');
  check('标准文件表头行 = 第 14 行', base.headerRow === TH.THERMO_SKIPROWS,
    'headerRow=' + base.headerRow);
  const baseStrict = read(STD, true);
  check('标准文件：默认模式 = 严格模式', diff(base, baseStrict) === null, diff(base, baseStrict) || '');

  /* ---- ② 变形文件：严格模式必须读不出来 ---- */
  console.log('');
  console.log('--- ② 这些变形在严格模式（= 桌面版行为）下必须失败 ---');
  const variants = [
    { tag: '列名带单位', o: { names: ['Time [s]', '202Hg(cps)', '204Pb(cps)', '206Pb(cps)',
      '207Pb(cps)', '208Pb(cps)', '232Th(cps)', '238U(cps)'] } },
    { tag: '列名全小写', o: { names: ['time', '202hg', '204pb', '206pb', '207pb',
      '208pb', '232th', '238u'] } },
    { tag: '列名前后带空格', o: { names: [' Time ', ' 202Hg ', ' 204Pb ', ' 206Pb ',
      ' 207Pb ', ' 208Pb ', ' 232Th ', ' 238U '] } },
    { tag: '表头被注释顶后一行', o: { commentAt: 5 } },
    { tag: '元信息只有 7 行', o: { meta: 7 } },
    { tag: '元信息有 20 行', o: { meta: 20 } },
    { tag: '元信息里还夹了个空行', o: { blankLine: 4 } },
  ];
  for (const v of variants) {
    const msg = throws(function () { read(build(v.o), true); });
    check(v.tag + ' · 严格模式失败', msg !== null, msg ? msg.slice(0, 46) : '没报错，用例构造有问题');
  }

  /* ---- ③ 变形文件：默认模式必须读出与标准完全相同的数 ---- */
  console.log('');
  console.log('--- ③ 默认模式读出，必须与标准文件逐位相同 ---');
  for (const v of variants) {
    let got = null, err = null;
    try { got = read(build(v.o)); } catch (e) { err = e; }
    if (err) {
      check(v.tag + ' · 读出', false, '抛错 ' + err.message.slice(0, 50));
      continue;
    }
    const d = diff(base, got);
    check(v.tag + ' · 逐位相同', d === null, d || ('mode=' + got.mode + ' 表头第 '
      + (got.headerRow + 1) + ' 行'));
  }

  /* ---- ④ 严格模式本来就能读的情形，两种模式必须一致 ---- */
  console.log('');
  console.log('--- ④ 严格模式原本就能读的，兼容路径不能改变结果 ---');
  const alsoOk = [
    { tag: '列顺序重排', o: { order: [7, 3, 0, 5, 1, 6, 2, 4] } },
    { tag: '列顺序完全颠倒', o: { order: [7, 6, 5, 4, 3, 2, 1, 0] } },
  ];
  for (const v of alsoOk) {
    const txt = build(v.o);
    const s = read(txt, true);
    const c = read(txt);
    check(v.tag + ' · 两模式结果一致', diff(s, c) === null && c.mode === 'strict',
      diff(s, c) || ('mode=' + c.mode));
  }

  /* ---- ⑤ 反例：该失败的必须失败 ---- */
  console.log('');
  console.log('--- ⑤ 真正读不了的文件，两种模式都必须报错 ---');
  const bad = [
    { tag: '缺 238U 列', txt: build({ names: ['Time', '202Hg', '204Pb', '206Pb',
      '207Pb', '208Pb', '232Th'] }) },
    { tag: '缺 206Pb 列', txt: build({ names: ['Time', '202Hg', '204Pb', '207Pb',
      '208Pb', '232Th', '238U'] }) },
    { tag: '表头行被 # 注释掉', txt: build({ names: ['#Time', '202Hg', '204Pb',
      '206Pb', '207Pb', '208Pb', '232Th', '238U'] }) },
    { tag: '根本不是仪器文件', txt: 'hello,world\n1,2\n3,4\n' },
    { tag: '空文件', txt: '' },
    //  **这条与 test_agilent_e2e.js 的回归哨兵是同一件事**：Agilent 导出的列名是
    //  纯数字（'202'/'238'），不属于 Thermo 的写法变体。如果兼容路径把它也读进来，
    //  "仪器选错"就会从"整批解析失败"变成"安静地读出一份数"—— 两套读取器在
    //  缺列补零、注释行规则上并不一样，静默读偏比报错危险得多。
    { tag: 'Agilent 那套纯数字列名（选错仪器）', txt: build({ names: ['时间 [s]', '202',
      '204', '206', '207', '208', '232', '238'] }) },
    //  真实 Agilent 导出的后六列**也带元素标识**（'204Pb'、'206Pb'…），所以光靠
    //  "质量数+元素标识"那条挡不住它。挡住它的是**时间列**：'时间 [s]' 是原实现
    //  写给 Agilent 那一支的列名，Thermo 的变体只认 'Time' 的等价写法。
    { tag: 'Agilent 真实列名（时间列写中文）', txt: build({ names: ['时间 [s]', '202',
      '204Pb', '206Pb', '207Pb', '208Pb', '232Th', '238U'] }) },
  ];
  for (const b of bad) {
    const m1 = throws(function () { read(b.txt); });
    const m2 = throws(function () { read(b.txt, true); });
    check(b.tag + ' · 默认模式报错', m1 !== null, m1 ? m1.slice(0, 44) : '没报错！');
    check(b.tag + ' · 严格模式报错', m2 !== null, m2 ? m2.slice(0, 44) : '没报错！');
  }

  /* ---- ⑥ 列名归一化的单元断言 ---- */
  console.log('');
  console.log('--- ⑥ 列名归一化 ---');
  const nm = TH.normColName;
  const cases = [
    ['Time', 'time'], ['Time [s]', 'time'], [' Time ', 'time'], ['时间', '时间'],
    ['238U(cps)', '238u'], ['238U [cps]', '238u'], ['\uFEFF238U', '238u'],
    ['202Hg', '202hg'], ['#Time', '#time'],
  ];
  let nmBad = 0;
  for (const [src, want] of cases) {
    if (nm(src) !== want) { nmBad++; check('normColName(' + JSON.stringify(src) + ')',
      false, nm(src) + ' ≠ ' + want); }
  }
  check('归一化用例全对', nmBad === 0, nmBad ? nmBad + ' 个不符' : cases.length + ' 个');
  check('注释掉的表头匹配不上 Time', TH.colMatches('#Time', 'Time', null) === false, '');
  check('注释掉的表头匹配不上 238U', TH.colMatches('#238U', '238U', '238') === false, '');
  check('"238U(cps)" 匹配 238U', TH.colMatches('238U(cps)', '238U', '238') === true, '');
  check('"232Th" 不会匹配 238', TH.colMatches('232Th', '238U', '238') === false, '');
  check('纯数字列名不算 Thermo 变体（202）',
    TH.colMatches('202', '202Hg', '202') === false, '');
  check('纯数字列名不算 Thermo 变体（238）',
    TH.colMatches('238', '238U', '238') === false, '');
  check('带元素标识的才认（202Hg）',
    TH.colMatches('202Hg', '202Hg', '202') === true, '');
  check('中文时间不认（那是 Agilent 的列名）',
    TH.colMatches('时间 [s]', 'Time', null) === false, '');
  check('"Time [s]" 认（Thermo 的写法变体）',
    TH.colMatches('Time [s]', 'Time', null) === true, '');

  /* ---- ⑦ 兼容读取要留下痕迹 ---- */
  console.log('');
  console.log('--- ⑦ 走了兼容路径的文件必须能被界面标出来 ---');
  const compatOnly = build({ names: ['Time [s]', '202Hg(cps)', '204Pb(cps)', '206Pb(cps)',
    '207Pb(cps)', '208Pb(cps)', '232Th(cps)', '238U(cps)'] });
  const cr = read(compatOnly);
  check('mode 标成 compat', cr.mode === 'compat', 'mode=' + cr.mode);
  check('notes 里说明了原因', Array.isArray(cr.notes) && cr.notes.length > 0
    && cr.notes[0].indexOf('兼容') >= 0, JSON.stringify(cr.notes));
  check('严格模式读不出它（说明兜底确实被用上了）',
    throws(function () { read(compatOnly, true); }) !== null, '');
  check('标准文件的 notes 为空', base.notes.length === 0, JSON.stringify(base.notes));

  console.log('');
  console.log('结果：' + pass + ' 通过 / ' + fail + ' 失败');
  if (fail) {
    console.log('失败项：');
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
}

main();
