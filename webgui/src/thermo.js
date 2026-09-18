/* ==========================================================================
 *  thermo.js —— Thermo 原始文件的读取（对应 Isoclock2.0.py 的 loaddata() mode 0）
 *
 *  为什么只做 Thermo：实验室用的就是 Thermo，而且它的入口最干净 ——
 *  扫描目录里的 *.csv、不需要 LIST 文件（Agilent 与 Element 都要一个 Excel 清单）。
 *
 *  【重要更正】Isoclock2.0.py 第 120-125 行那段注释把仪器编号写反了：
 *      注释说  ele==0 是 Element、ele==2 是 Thermo
 *      实际是  ele==0 → instructure0() → Thermo（扫描 *.csv、不弹 LIST 对话框）
 *              ele==2 → instructure2() → Element（扫描 *.FIN/.FIN2、要 LIST 文件）
 *  依据是 main() 里 Radiobutton 的绑定（3388-3390）与 samplelist() 的分派
 *  （3371-3379），以及两个面板各自的文件扫描逻辑。注释是被改错过的那一方。
 *
 *  数据区起点的三行关系（实测 numpy 1.24.2）：
 *      列名行 = 原始第 14 行   → _read_header_row(path, 13)  按 0 基取 raw[13]
 *      数据起点 = 原始第 16 行 → np.loadtxt(..., skiprows=13+2=15)
 *  skiprows 按**原始行**计数（其中若混有 '#' 行，它同样占一个配额）；
 *  配额用完之后的剩余行里，再按 comments='#' 截断并丢弃空行。
 * ========================================================================== */
'use strict';

const THERMO_SKIPROWS = 13;                 // 列名行之前的行数（原始行）
const THERMO_DATA_SKIP = THERMO_SKIPROWS + 2; // 数据起点（列名行 + 单位行之后）
const THERMO_COMMENT = '#';

/** 按 \r\n / \n / \r 切行，保留空行（行号必须与 Python 的 readlines 一致）。 */
function splitLines(text) {
  const out = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 10) {                       // \n
      out.push(text.slice(start, i));
      start = i + 1;
    } else if (c === 13) {                // \r
      out.push(text.slice(start, i));
      if (i + 1 < text.length && text.charCodeAt(i + 1) === 10) i++;
      start = i + 1;
    }
  }
  if (start < text.length) out.push(text.slice(start));
  return out;
}

/**
 * 对应 _read_header_row(path, skiprows)：**不做注释过滤**，直接取原始第 skiprows+1 行。
 * 只 rstrip 掉 CR/LF，逗号切分后**不 strip**（列名带空格就匹配不上，这是原行为）。
 */
function thermoReadHeader(text, skiprows) {
  const raw = splitLines(text);
  if (raw.length <= skiprows) return [];
  return raw[skiprows].replace(/[\r\n]+$/, '').split(',');
}

/**
 * 对应 _column_index(header, key, digits_only=False, optional=False)。
 * 精确相等匹配；optional=True 时找不到返回 null（而不是抛错）。
 */
function thermoColumnIndex(header, key, optional) {
  const i = header.indexOf(key);
  if (i >= 0) return i;
  if (optional) return null;
  throw new Error('Thermo 列名未找到: ' + JSON.stringify(key)
    + '（表头为 ' + JSON.stringify(header) + '）');
}

/**
 * 对应 _read_selected_columns(path, skiprows, comments, positions)。
 *
 * positions 里 null 表示该通道不存在（其列不读取，后续列的下标相应前移）。
 * 返回长度与 positions 相同的数组，未读取的位置为 null。
 */
function thermoReadColumns(text, skiprows, positions) {
  const raw = splitLines(text);
  const rows = [];
  for (let i = skiprows; i < raw.length; i++) {
    let line = raw[i];
    const c = line.indexOf(THERMO_COMMENT);   // comments='#'：截断到行内第一个 #
    if (c >= 0) line = line.slice(0, c);
    line = line.trim();
    if (!line) continue;                      // 空行（含被截断后变空的注释行）丢弃
    rows.push(line.split(','));
  }
  const real = positions.filter((p) => p !== null);
  const out = new Array(positions.length).fill(null);
  let j = 0;
  for (let k = 0; k < positions.length; k++) {
    if (positions[k] === null) continue;
    const col = real[j++];
    const arr = new Float64Array(rows.length);
    for (let r = 0; r < rows.length; r++) {
      const cell = rows[r][col];
      if (cell === undefined) {
        throw new Error('第 ' + (r + 1) + ' 个数据行缺少第 ' + col + ' 列');
      }
      const v = Number(cell);
      // 对应 numpy 的 "could not convert string to float"
      if (!Number.isFinite(v) && !(cell.trim() === 'nan' || cell.trim() === 'NaN'
        || cell.trim() === 'inf' || cell.trim() === '-inf')) {
        throw new Error('第 ' + (r + 1) + ' 行第 ' + col + ' 列无法解析为 float：'
          + JSON.stringify(cell));
      }
      arr[r] = v;
    }
    out[k] = arr;
  }
  return out;
}

/** 乘以 0 得到与 x 等长的全零数组（对应 `x * 0`）。 */
function zerosLike(x) {
  return new Float64Array(x.length);
}

/**
 * 对应 loaddata(name, isoname) 且 ele.get() == 0（Thermo）。
 *
 * isoname = ['Time','202Hg','204Pb','206Pb','207Pb','208Pb','232Th','238U']
 * 返回 { x, y1..y7 }，顺序与原返回元组一致：
 *   y1=202Hg  y2=204Pb  y3=206Pb  y4=207Pb  y5=208Pb  y6=232Th  y7=238U
 *
 * 注意 y2 在下游被当作 "Hg204" 通道使用（历史命名），实际存的是 204 质量的总计数，
 * 原实现没有做 Hg 干扰扣除。
 */
function thermoLoad(text, isoname) {
  const header = thermoReadHeader(text, THERMO_SKIPROWS);
  const positions = [
    thermoColumnIndex(header, isoname[0], false),
    thermoColumnIndex(header, isoname[1], true),    // 202Hg 可选
    thermoColumnIndex(header, isoname[2], true),    // 204Pb 可选
  ];
  for (let k = 3; k < 8; k++) {
    positions.push(thermoColumnIndex(header, isoname[k], false));
  }
  const cols = thermoReadColumns(text, THERMO_DATA_SKIP, positions);
  const x = cols[0];
  const y1 = cols[1] !== null ? cols[1] : zerosLike(x);
  const y2 = cols[2] !== null ? cols[2] : zerosLike(x);
  return { x, y1, y2, y3: cols[3], y4: cols[4], y5: cols[5], y6: cols[6], y7: cols[7] };
}

/**
 * 取一行的第 0 个 CSV 字段，对应 Python `csv.reader` 的单字段解析：
 * 双引号包裹时取引号内的内容，`""` 转义为一个引号，引号后的内容丢弃。
 * 不能简单地 split(',')[0] —— 名字里带逗号（如 `"MAD-NEW, 1": note`）就会切错。
 */
function firstCsvField(line) {
  if (line.charAt(0) === '"') {
    let out = '';
    let i = 1;
    while (i < line.length) {
      const ch = line.charAt(i);
      if (ch === '"') {
        if (line.charAt(i + 1) === '"') { out += '"'; i += 2; continue; }
        break;                                   // 结束引号
      }
      out += ch;
      i++;
    }
    return out;
  }
  const c = line.indexOf(',');
  return c >= 0 ? line.slice(0, c) : line;
}

/**
 * 样品名取自文件**第一行**（对应 instructure0 里 1928-1937 的那段）：
 *   csv.reader 读第一行 -> 取第 0 个字段 -> str() -> 按 ':' 切开取 [0]
 *
 * Thermo 不需要 LIST 文件，样品名就是这样从文件头里自动提取的。
 * **注意**：冒号之前的整段都是名字。第一行写 `Sample MAD-NEW-1: note`，
 * 名字就是 `Sample MAD-NEW-1`（不是 `MAD-NEW-1`）—— 想让样品名是 `91500`，
 * 第一行就得写成 `91500: ...`。
 */
function thermoSampleName(text) {
  const raw = splitLines(text);
  if (!raw.length) return '';
  return firstCsvField(raw[0]).split(':')[0];
}

/** Thermo 默认的表头列名。 */
const THERMO_ISONAME = ['Time', '202Hg', '204Pb', '206Pb', '207Pb', '208Pb',
  '232Th', '238U'];

const DS_THERMO = {
  THERMO_SKIPROWS, THERMO_DATA_SKIP, THERMO_COMMENT, THERMO_ISONAME,
  splitLines, thermoReadHeader, thermoColumnIndex, thermoReadColumns,
  thermoLoad, thermoSampleName, firstCsvField, zerosLike,
};
if (typeof window !== 'undefined') {
  window.DS_THERMO = DS_THERMO;
  Object.assign(window.DS = window.DS || {}, DS_THERMO);
}
if (typeof module !== 'undefined' && module.exports) module.exports = DS_THERMO;
