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

/* ==========================================================================
 *  兼容读取 —— 真实文件里"表头在第几行""列名怎么写"都不固定
 *
 *  桌面版有两处硬编码：
 *      · 表头行固定取原始第 14 行（`_read_header_row(path, 13)`）；
 *      · 列名按 'Time' / '202Hg' / '204Pb' / … **精确相等**匹配（而且不 strip）。
 *  标准导出上没问题。但换一版 Qtegra/iCAP 软件、或中间用 Excel 另存过一次，
 *  表头行数或列名写法就可能变（'Time [s]'、'238U(cps)'、多一行说明、
 *  表头被一行注释顶后一行……），此时桌面版直接报"列名未找到"。
 *
 *  这里加一条**兜底**路径，原则是"标准文件一个字节都不动"：
 *
 *      ① 先走严格路径（与桌面版逐位一致）。成功就结束 —— 标准文件走的就是这条。
 *      ② 严格路径失败，才在前 40 行里找"哪一行同时含 Time 与 206/207/238"。
 *         找到就把那一行当表头，数据从「表头行 + 2」开始（跳过单位行），
 *         列名按归一化后的变体匹配。
 *      ③ 找不到就报错，错误信息带上第一行内容，便于判断是不是选错了文件。
 *
 *  三处**故意的收紧**，都是为了不让"误读成功"溜过去：
 *      · 兼容探测要求候选行**同时**匹配 Time 与 206/207/238 ——
 *        纯数据行不可能同时含这些字样，所以不会把数据行误认成表头；
 *      · 列名归一化时**不剥离 '#'**，于是一行被注释掉的表头（'#Time,…'）
 *        仍然匹配不上，与桌面版"表头被顶后就报错"的行为保持一致；
 *      · 变体匹配要求"质量数 + 元素标识"**同时**出现，所以纯数字列名
 *        （'202'、'238'，那是 Agilent 的命名）不会被当成 Thermo 的写法变体 ——
 *        否则 Thermo 读取器连 Agilent 文件也能读，"选错仪器"就从一个响亮的
 *        报错变成一个安静的错误结果。
 *
 *  `opt.compat === false` 可强制回到严格路径 —— `test_thermo.js` 用它来钉住
 *  "与 Python 逐位一致（含报错）"。要证明兼容路径没读错，用的是另一套判据：
 *  **同一组数值，写成标准文件与写成各种变形文件，读出来必须逐位相同**
 *  （见 test_thermo_compat.js）。
 * ========================================================================== */

/** 兼容探测最多往上找多少行。标准是 14 行，留足余量。 */
const THERMO_COMPAT_MAXROW = 40;

/**
 * 列名归一化：去 BOM、去所有空白（含不换行空格）、去括号/方括号里的单位、
 * 转小写。**不动 '#'** —— 被注释掉的表头必须继续匹配不上。
 */
function normColName(s) {
  return String(s)
    .replace(/^\uFEFF/, '')
    .replace(/[\s\u00a0]+/g, '')
    .replace(/[（(][^)）]*[)）]/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .toLowerCase();
}

/** 各质量数对应的元素标识。变体匹配要求它同时出现，见 colMatches。 */
const THERMO_MASS_ELEM = {
  202: 'hg', 204: 'pb', 206: 'pb', 207: 'pb', 208: 'pb', 232: 'th', 238: 'u',
};

/**
 * 一个列名是否匹配某个通道。
 * @param {string} name 表头里的原始列名
 * @param {string} key  标准列名（isoname 里的那一个）
 * @param {string} mass 该通道的质量数（Time 传 null）
 *
 * **变体匹配要求"质量数 + 元素标识"同时出现**，这是一处有意的收紧：
 * 纯数字列名（'202'、'238'）是 **Agilent 那一套命名**，不是 Thermo 的写法变体。
 * 如果 Thermo 读取器连它也能读，那么"仪器选错了"就会从"整批解析失败"
 * 悄悄变成"读出一份看起来正常的数"（两套读取器在缺列补零、注释行规则上并不一样）。
 * `test_agilent_e2e.js` 里那条回归哨兵、「仪器必须传参」盯的就是这件事。
 *
 * 所以 '202Hg' / '202Hg(cps)' / '202hg' / ' 202Hg ' 都算 Thermo 的写法变体，
 * 而 '202' 不算。
 *
 * Time 那一列则**只认 'Time' 的等价写法**（大小写、带单位、带空格），
 * 中文的 '时间 [s]' **不认** —— 因为那正是原实现给 **Agilent** 那一支写死的列名
 * （见下面 agilentLoad 的 isoname）。两条合起来，就保证了"用 Thermo 读取器读
 * Agilent 文件"一定失败，而不是安静地读出一份数。
 */
function colMatches(name, key, mass) {
  const n = normColName(name);
  if (!n || n.charAt(0) === '#') return false;   // 注释掉的表头行不算数
  if (n === normColName(key)) return true;
  if (!mass) return false;                        // Time 只认与标准列名等价的写法
  const elem = THERMO_MASS_ELEM[mass];
  if (n.indexOf(mass) < 0) return false;
  return !elem || n.indexOf(elem) >= 0;
}

/**
 * 在一行表头里找一个通道的列号。两级：
 *   ① 精确相等 —— 与桌面版 `_column_index` 同一个口径，标准文件命中这一层；
 *   ② 归一化变体 —— 兼容路径才用。
 * 找不到返回 -1。
 */
function findThermoCol(header, key, mass, allowVariant) {
  const i = header.indexOf(key);
  if (i >= 0) return i;
  if (!allowVariant) return -1;
  for (let j = 0; j < header.length; j++) {
    if (colMatches(header[j], key, mass)) return j;
  }
  return -1;
}

/** isoname 里哪些位置是必需列（Time 与 206/207/208/232/238），哪些可缺（202/204）。 */
const THERMO_COL_MASS = [null, '202', '204', '206', '207', '208', '232', '238'];
function thermoColNeeded(k) { return k === 0 || k >= 3; }

/**
 * 定出这次读取要用哪一行作表头、各通道在哪一列。
 *
 * @returns {{header:string[], headerRow:number, dataSkip:number,
 *            positions:(number|null)[], mode:'strict'|'compat', notes:string[]}}
 */
function thermoAcquire(text, isoname, compat) {
  //  ---- ① 严格路径：与桌面版完全一致 ----
  const strictHeader = thermoReadHeader(text, THERMO_SKIPROWS);
  const strictPos = [];
  let strictOk = true;
  for (let k = 0; k < 8; k++) {
    const i = findThermoCol(strictHeader, isoname[k], THERMO_COL_MASS[k], false);
    if (i >= 0) { strictPos.push(i); continue; }
    if (thermoColNeeded(k)) { strictOk = false; break; }
    strictPos.push(null);                       // 202Hg / 204Pb 可缺
  }
  if (strictOk) {
    return { header: strictHeader, headerRow: THERMO_SKIPROWS,
      dataSkip: THERMO_DATA_SKIP, positions: strictPos, mode: 'strict', notes: [] };
  }
  if (!compat) {
    //  严格模式如实抛错，错误信息与改动前逐字一致（test_thermo.js 比的是行为）
    let miss = null;
    for (let k = 0; k < 8; k++) {
      if (thermoColNeeded(k) && strictHeader.indexOf(isoname[k]) < 0) {
        miss = isoname[k]; break;
      }
    }
    throw new Error('Thermo 列名未找到: ' + JSON.stringify(miss)
      + '（表头为 ' + JSON.stringify(strictHeader) + '）');
  }

  //  ---- ② 兼容路径：逐行试，找一行能当表头的 ----
  const raw = splitLines(text);
  const limit = Math.min(raw.length, THERMO_COMPAT_MAXROW);
  for (let r = 0; r < limit; r++) {
    const header = raw[r].replace(/[\r\n]+$/, '').split(',');
    const pos = [];
    let ok = true;
    for (let k = 0; k < 8; k++) {
      const i = findThermoCol(header, isoname[k], THERMO_COL_MASS[k], true);
      if (i >= 0) { pos.push(i); continue; }
      if (thermoColNeeded(k)) { ok = false; break; }
      pos.push(null);
    }
    if (!ok) continue;
    const notes = ['Thermo 兼容读取'];
    if (r !== THERMO_SKIPROWS) {
      notes.push('表头行在第 ' + (r + 1) + ' 行（标准导出是第 14 行）');
    }
    const variant = [];
    for (let k = 0; k < 8; k++) {
      if (pos[k] !== null && header[pos[k]] !== isoname[k]) {
        variant.push(isoname[k] + '→' + header[pos[k]]);
      }
    }
    if (variant.length) notes.push('列名写法不同：' + variant.join('、'));
    return { header: header, headerRow: r, dataSkip: r + 2,
      positions: pos, mode: 'compat', notes: notes };
  }

  throw new Error('Thermo：前 ' + limit + ' 行里找不到可用的表头行'
    + '（需要同一行里同时出现 ' + isoname[0] + ' 与 ' + isoname[7] + '）。'
    + '第一行是 ' + JSON.stringify(raw.length ? raw[0] : '')
    + '。请确认选的是仪器导出的原始 CSV。');
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
 *
 * opt.compat === false 时只走严格路径（与桌面版行为一致，含报错）；
 * 默认走"先严格、失败再兼容"。多返回的 notes / mode / headerRow / dataSkip
 * 只是给界面与报告用的诊断信息，数值不受影响。
 */
function thermoLoad(text, isoname, opt) {
  const compat = !(opt && opt.compat === false);
  const plan = thermoAcquire(text, isoname, compat);
  const cols = thermoReadColumns(text, plan.dataSkip, plan.positions);
  const x = cols[0];
  const y1 = cols[1] !== null ? cols[1] : zerosLike(x);
  const y2 = cols[2] !== null ? cols[2] : zerosLike(x);
  return {
    x, y1, y2, y3: cols[3], y4: cols[4], y5: cols[5], y6: cols[6], y7: cols[7],
    notes: plan.notes, mode: plan.mode,
    headerRow: plan.headerRow, dataSkip: plan.dataSkip,
  };
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

/* ==========================================================================
 *  Agilent（对应 loaddata() mode 1 / _load_agilent）
 *
 *  isoname 由桌面版 instructure1() 给定：
 *      ['时间 [s]', '202', '204', '206', '207', '208', '232', '238']
 *  匹配规则：
 *      · 第 0 列作时间，不看列名；
 *      · isoname[1]（202）按**原列名精确**匹配（可选）；
 *      · isoname[2..7] 按**只留数字**的口径匹配：列名 204Pb → '204'（可选）。
 *  表头行位置自动探测：原实现先按"列名行在原始第 4 行"（skiprows=3）读，
 *  出错退到第 3 行（skiprows=2）；数据区从列名行 + 1 行单位之后开始。
 *  缺失通道的处理与原实现一致：202Hg / 204Pb 补零；208 或 232 缺任何一个，
 *  两个通道一起补零并给出 '232Th Not found!' 提示。
 * ========================================================================== */

const AGILENT_COMMENT = '          ';       // 原实现传给 loadtxt 的 comments（10 个空格）
const AGILENT_ISONAME = ['时间 [s]', '202', '204', '206', '207', '208', '232', '238'];

/** 只保留数字字符，对应 _column_index(digits_only=True) 的口径。 */
function digitsOnly(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charAt(i);
    if (c >= '0' && c <= '9') out += c;
  }
  return out;
}

/** digits_only 口径的列查找。optional 时找不到返回 null。 */
function agilentColumnIndex(header, key, optional) {
  const table = header.map(digitsOnly);
  const i = table.indexOf(key);
  if (i >= 0) return i;
  if (optional) return null;
  throw new Error('Agilent 列名未找到: ' + JSON.stringify(key)
    + '（表头为 ' + JSON.stringify(header) + '）');
}

/** 206/207/238 三个下游必需的列是否都能找到（用于表头行位置探测）。 */
function agilentHasKeys(header, isoname) {
  return [3, 4, 7].every(function (k) {
    return agilentColumnIndex(header, isoname[k], true) !== null;
  });
}

/**
 * 对应 _read_selected_columns(..., comments='          ')。
 * 与 Thermo 的差别：comments 是 10 个空格 —— **整行**以它开头的才算注释，
 * 不做行内截断；空行照旧丢弃。
 */
function agilentReadColumns(text, dataSkip, positions) {
  const raw = splitLines(text);
  const rows = [];
  for (let i = dataSkip; i < raw.length; i++) {
    let line = raw[i];
    if (line.indexOf(AGILENT_COMMENT) === 0) continue;
    line = line.trim();
    if (!line) continue;
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

/**
 * 对应 loaddata(name, isoname) 且 ele.get() == 1（Agilent）。
 * 返回 { x, y1..y7, notes }，通道顺序与 Thermo 相同：
 *   y1=202Hg  y2=204Pb  y3=206Pb  y4=207Pb  y5=208Pb  y6=232Th  y7=238U
 * notes 里是原实现的 logging 提示（如 '232Th Not found!'）。
 *
 * 与原实现的两点差异（都朝更严格的方向）：
 *   ① 表头行探测从"靠 ValueError 触发"改成显式检查 206/207/238 是否找得到；
 *   ② 206/207/238 缺列时直接报错 —— 原实现会返回 None，
 *      到下游计算才崩，错误信息看不出是缺了列。
 */
function agilentLoad(text, isoname) {
  let header = thermoReadHeader(text, 3);
  if (!agilentHasKeys(header, isoname)) header = thermoReadHeader(text, 2);
  if (!agilentHasKeys(header, isoname)) {
    throw new Error('Agilent：在第 3、4 行都找不到 206/207/238 列'
      + '（按只留数字的口径）。请确认导出的是原始 CSV 而不是再加工的表格。');
  }
  const positions = [0, thermoColumnIndex(header, isoname[1], true)];
  for (let k = 2; k < 8; k++) {
    positions.push(agilentColumnIndex(header, isoname[k], true));
  }
  // 数据区起点 = 列名行 + 1 行单位。列名行在原始第 3 或 4 行 → skiprows=2 或 3
  const skip = (thermoReadHeader(text, 2).join() === header.join()) ? 2 : 3;
  const cols = agilentReadColumns(text, skip + 2, positions);
  const x = cols[0];
  const y1 = cols[1] !== null ? cols[1] : zerosLike(x);
  const y2 = cols[2] !== null ? cols[2] : zerosLike(x);
  if (cols[3] === null || cols[4] === null || cols[7] === null) {
    throw new Error('Agilent：206/207/238 列至少缺一个 —— 原实现在这里会'
      + '拿到空值并在后续计算里报错，这里提前指出，便于检查导出设置。');
  }
  const notes = [];
  let y5;
  let y6;
  if (cols[5] === null || cols[6] === null) {
    notes.push('232Th Not found!');
    y5 = zerosLike(x);
    y6 = zerosLike(x);
  } else {
    y5 = cols[5];
    y6 = cols[6];
  }
  return { x, y1, y2, y3: cols[3], y4: cols[4], y5, y6, y7: cols[7], notes };
}

const DS_THERMO = {
  THERMO_SKIPROWS, THERMO_DATA_SKIP, THERMO_COMMENT, THERMO_ISONAME,
  THERMO_COMPAT_MAXROW, THERMO_COL_MASS, THERMO_MASS_ELEM, thermoColNeeded,
  AGILENT_COMMENT, AGILENT_ISONAME,
  splitLines, thermoReadHeader, thermoColumnIndex, thermoReadColumns,
  thermoLoad, thermoSampleName, firstCsvField, zerosLike,
  normColName, colMatches, findThermoCol, thermoAcquire,
  digitsOnly, agilentColumnIndex, agilentHasKeys, agilentReadColumns, agilentLoad,
};
if (typeof window !== 'undefined') {
  window.DS_THERMO = DS_THERMO;
  Object.assign(window.DS = window.DS || {}, DS_THERMO);
}
if (typeof module !== 'undefined' && module.exports) module.exports = DS_THERMO;
