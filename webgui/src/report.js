/* ==========================================================================
 *  report.js —— 把结果写成与 Python 完全相同的 CSV 文本
 *
 *  要逐字节比对，光数值一致不够，**浮点的文字表示也必须一致**。
 *  Python 的 `csv.writer` 对 float 调 `str()`，也就是 repr（最短往返表示），
 *  而它的排版规则和 JS 的 `String(x)` 不一样：
 *
 *      repr(1e-5)   = '1e-05'        String(1e-5)  = '0.00001'
 *      repr(1e16)   = '1e+16'        String(1e16)  = '10000000000000000'
 *      repr(5.0)    = '5.0'          String(5)     = '5'
 *      repr(nan)    = 'nan'          String(NaN)   = 'NaN'
 *
 *  所以这里自己实现 pyFloatRepr：先借 JS 拿到**最短往返数字串**（这一步两边
 *  算法等价，都是最短且能往返），再按 CPython 的排版规则重新组装。
 *  CPython 的规则（PyOS_double_to_string 的 'r' 模式）：
 *      decpt > 16 或 decpt <= -4   ->  指数形式，指数至少两位（e+16 / e-05）
 *      否则                        ->  定点形式，整数值补 '.0'
 * ========================================================================== */
'use strict';

/** 拆成 (有效数字串, 小数点位置 decpt)，decpt 表示小数点前有几位。 */
function decompose(x) {
  const s = Math.abs(x).toString();          // JS 给的最短往返表示
  let mant = s;
  let exp = 0;
  const e = s.indexOf('e');
  if (e >= 0) {
    mant = s.slice(0, e);
    exp = parseInt(s.slice(e + 1), 10);
  }
  const dot = mant.indexOf('.');
  let digits, decpt;
  if (dot >= 0) {
    digits = mant.slice(0, dot) + mant.slice(dot + 1);
    decpt = dot + exp;
  } else {
    digits = mant;
    decpt = mant.length + exp;
  }
  // 去掉前导零（"0.0001" -> 数字串 "00001" -> "1"，decpt 相应左移）
  let lead = 0;
  while (lead < digits.length - 1 && digits[lead] === '0') lead++;
  digits = digits.slice(lead);
  decpt -= lead;
  // 去掉尾随零
  digits = digits.replace(/0+$/, '');
  if (digits === '') { digits = '0'; decpt = 1; }
  return { digits, decpt };
}

/** 对应 CPython 的 repr(float)。 */
function pyFloatRepr(x) {
  if (Number.isNaN(x)) return 'nan';
  if (x === Infinity) return 'inf';
  if (x === -Infinity) return '-inf';
  if (x === 0) return Object.is(x, -0) ? '-0.0' : '0.0';
  const neg = x < 0;
  const { digits, decpt } = decompose(x);
  let body;
  if (decpt <= -4 || decpt > 16) {
    let m = digits[0];
    if (digits.length > 1) m += '.' + digits.slice(1);
    const ex = decpt - 1;
    body = m + 'e' + (ex < 0 ? '-' : '+')
      + String(Math.abs(ex)).padStart(2, '0');
  } else if (decpt <= 0) {
    body = '0.' + '0'.repeat(-decpt) + digits;
  } else if (decpt >= digits.length) {
    body = digits + '0'.repeat(decpt - digits.length) + '.0';
  } else {
    body = digits.slice(0, decpt) + '.' + digits.slice(decpt);
  }
  return (neg ? '-' : '') + body;
}

/** 对应 Python str()：str 原样，float 走 repr，int 走十进制。 */
function pyStr(v) {
  // 被标记为 Python int 的值按整数输出（str(1) == '1'，不是 '1.0'）
  if (v !== null && typeof v === 'object' && v.__pyInt !== undefined) {
    return String(v.__pyInt);
  }
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return pyFloatRepr(v);
  return String(v);
}

/**
 * 对应 csv.writer(writerow(...))，默认 dialect：
 *   delimiter=',', quotechar='"', quoting=QUOTE_MINIMAL, lineterminator='\r\n'
 * QUOTE_MINIMAL：字段含分隔符、引号或 \r \n 时才加引号。
 */
function csvRow(fields) {
  const out = [];
  for (let i = 0; i < fields.length; i++) {
    const s = pyStr(fields[i]);
    if (s.indexOf(',') >= 0 || s.indexOf('"') >= 0
      || s.indexOf('\r') >= 0 || s.indexOf('\n') >= 0) {
      out.push('"' + s.replace(/"/g, '""') + '"');
    } else {
      out.push(s);
    }
  }
  return out.join(',') + '\r\n';
}

/* ---- 两个输出文件的表头，与 Isoclock2.0.py 的 dataprocess() 逐字一致 ---- */

const HEADER_MEAN_CPS = [
  ' File Name', ' SamplesName', 'b202', 'b_204', 'b_206', 'b_207', 'b_208',
  'b_232', 'b_238', '202Hg(cps)', '204Pb(cps)', '206Pb(cps)', '207Pb(cps)',
  '208Pb(cps)', '232Th(cps)', '238U(cps)',
];

const HEADER_RESULT_ALL = [
  'No.', 'FilesName', 'SamplesName', '207Pb/206Pb', '2s', '206Pb/238U', '2s',
  '207Pb/235Uc', '2s', '208Pb/232Th', '2s', '208Pb/206Pb', '2s',
  '232Th/206Pb', '2s', '208Pb/204Pb', '2s', 'Trace element ', 'U(cps)',
  'Th(cps)', 'Pb208(cps)', 'Pb207(cps)', 'Pb206(cps)',
];

function buildMeanCpsCsv(rows) {
  let s = csvRow(HEADER_MEAN_CPS);
  for (const r of rows) s += csvRow(r);
  return s;
}

function buildResultAllCsv(rows) {
  let s = csvRow(HEADER_RESULT_ALL);
  for (const r of rows) s += csvRow(r);
  return s;
}

const DS_REPORT = {
  decompose, pyFloatRepr, pyStr, csvRow,
  HEADER_MEAN_CPS, HEADER_RESULT_ALL, buildMeanCpsCsv, buildResultAllCsv,
};
if (typeof window !== 'undefined') {
  window.DS_REPORT = DS_REPORT;
  Object.assign(window.DS = window.DS || {}, DS_REPORT);
}
if (typeof module !== 'undefined' && module.exports) module.exports = DS_REPORT;
