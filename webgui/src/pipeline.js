/* ==========================================================================
 *  pipeline.js —— Thermo 数据的端到端流程
 *
 *  串起四步，与桌面版一一对应：
 *      thermoLoad()           <- loaddata() 的 Thermo 分支
 *      detectSignalWindow()   <- instructure0 里的窗口自动识别
 *      切背景 / 信号段 + 均值  <- dataprocess() 的 _load_channels / _mean_cps_row
 *      reduceSample()         <- dataprocess() 的还原与出表
 *
 *  依赖的模块通过 attach() 注入，便于在 Node 下按顺序加载、也便于单独测试。
 * ========================================================================== */
'use strict';

const P = {};                                  // 注入的依赖
function attach(mods) { Object.assign(P, mods); }

/** Python 的 arr[start:stop]（负索引、越界钳制、空切片）。 */
function pySlice(arr, start, stop) {
  const len = arr.length;
  let s = start < 0 ? Math.max(len + start, 0) : Math.min(start, len);
  let e = stop < 0 ? Math.max(len + stop, 0) : Math.min(stop, len);
  if (e < s) e = s;
  const out = new Float64Array(e - s);
  for (let i = s; i < e; i++) out[i - s] = arr[i];
  return out;
}

/** Python 的 int()：向零截断。 */
function pyInt(v) {
  if (!Number.isFinite(v)) throw new Error('cannot convert ' + v + ' to int');
  return Math.trunc(v);
}

const CHANNEL_SUFFIX = [
  ['Hg202', 'y1'], ['Hg204', 'y2'], ['Pb206', 'y3'], ['Pb207', 'y4'],
  ['Pb208', 'y5'], ['Th232', 'y6'], ['U238', 'y7'],
];

/**
 * 第一步：把一批 Thermo CSV 读进来，并算出各自的积分窗口。
 *
 * @param {Array<{file:string,text:string}>} files  顺序即处理顺序
 *        （桌面版用的是 os.listdir 的顺序，不保证稳定，见 README 说明）
 * @param {object} opt  {isoname, b0, b1, multi}
 * @returns {{perFile: object, order: string[], sampleslist: object}}
 */
function loadThermoFiles(files, opt) {
  const isoname = opt.isoname;
  const perFile = {};
  const order = [];
  const sampleslist = {};
  for (const f of files) {
    const ch = P.thermoLoad(f.text, isoname);          // {x,y1..y7}
    const n = ch.x.length;
    // Timeinternal 由数据本身推出：末点减首点再除以点数（与原实现一致）
    const timeinternal = (ch.x[n - 1] - ch.x[0]) / n;
    const channels = [ch.y1, ch.y2, ch.y3, ch.y4, ch.y5, ch.y6, ch.y7];
    const win = P.detectSignalWindow({
      n, channels, b0: opt.b0, b1: opt.b1,
      timeinternal, multi: opt.multi,
    });
    perFile[f.file] = {
      ch, channels, n, timeinternal, num: win.num,
      sample: P.thermoSampleName(f.text),
    };
    order.push(f.file);
    sampleslist[f.file] = perFile[f.file].sample;
  }
  return { perFile, order, sampleslist };
}

/**
 * 第二步：按窗口切出背景段 / 信号段（对应 dataprocess 的 _load_channels）。
 *
 * tiOverride 传入的是**全局** Timeinternal —— 原实现里 Timeinternal 是模块级全局，
 * instructure0 每个文件都会覆盖它，于是 dataprocess 里所有样品都用**最后一个文件**
 * 的值。同一批数据驻留时间通常相同，所以看不出来；但行为确实如此，这里照抄。
 */
function sliceChannels(perFile, file, tiOverride) {
  const e = perFile[file];
  const ti = (tiOverride === undefined) ? e.timeinternal : tiOverride;
  // num = [Numbers, b0, b1, s0, s1]
  const b0 = e.num[1], b1 = e.num[2], s0 = e.num[3], s1 = e.num[4];
  const sb = pyInt(b0 / ti), eb = pyInt(b1 / ti);
  const ss = pyInt(s0 / ti), es = pyInt(s1 / ti);
  const out = {};
  for (const [key, suffix] of CHANNEL_SUFFIX) {
    const v = e.ch[suffix];
    out[key + '_b'] = pySlice(v, sb, eb);
    out[key + '_s'] = pySlice(v, ss, es);
  }
  return out;
}

/** 对应 _mean_cps_row()：背景 7 个通道均值 + 信号 7 个通道均值。 */
function meanCpsRow(file, sig, sampleslist) {
  const row = [file, sampleslist[file]];
  for (const phase of ['_b', '_s']) {
    for (const [key] of CHANNEL_SUFFIX) row.push(P.nmean(sig[key + phase]));
  }
  return row;
}

/**
 * 第三步：跑完整条链，产出两个 CSV 的文本。
 *
 * @param {object} cfg
 *   files          [{file,text}]，顺序即处理顺序
 *   isoname        Thermo 列名
 *   b0, b1, multi  背景窗口（秒）与阈值倍数
 *   stdcor         0 = 标样做 Pb 校正
 *   method         Pb207Corr 的值：0=207Pb / 1=Cal204Pb / 2=208Pb / 3=204Pb
 *   standardNames  标样名集合（对应 Standard_names）
 *   ctx            {Q8,R8,S8,P382,Pbc,Standard_age}
 *   eleIndex       对应 ele.get()
 */
function run(cfg) {
  const loaded = loadThermoFiles(cfg.files, cfg);
  const { perFile, order, sampleslist } = loaded;

  // dataprocess() 开头的窗口自检 —— 注意它会**就地改写** s0/s1。
  // 第一个条件只把样品名记进 wrong_samples（原实现里这个列表也没被用到）；
  // 第二个条件把 s0/s1 都设成原来的 s1。这会影响后面的切片，必须照抄。
  for (const file of order) {
    const m = perFile[file].num;
    if (m[3] - m[2] < 0 || m[4] - m[2] < 0) {
      // 对应 wrong_samples.append(name)：原实现只记录、不处理
    } else if (m[3] + 1 > m[4] - 1) {
      m[3] = m[4];
      m[4] = m[3];
    }
  }

  // Timeinternal 是全局量，最后一个文件的值覆盖前面所有 —— 照抄
  const tiGlobal = order.length ? perFile[order[order.length - 1]].timeinternal : 0;

  const METHOD_BY_ID = { 0: 'std207', 1: 'std_cal204', 2: 'std208', 3: 'std204' };
  const method = METHOD_BY_ID[cfg.method];
  if (!method) throw new Error('未知的 Pb 校正方式: ' + cfg.method);

  const stdSet = cfg.standardNames || {};
  const isStd = (name) => Object.prototype.hasOwnProperty.call(stdSet, sampleslist[name]);

  const meanRows = [];
  const outStd = [];
  const outSamples = [];

  for (const file of order) {
    const sig = sliceChannels(perFile, file, tiGlobal);
    meanRows.push(meanCpsRow(file, sig, sampleslist));
    if (cfg.stdcor === 0 && isStd(file)) {
      outStd.push(P.reduceSample(file, sig, method, cfg.ctx,
        { eleIndex: cfg.eleIndex, samplesMap: sampleslist }));
    } else {
      outSamples.push(P.reduceSample(file, sig, 'sample', cfg.ctx,
        { eleIndex: cfg.eleIndex, samplesMap: sampleslist }));
    }
  }

  // 对应 result_outstd.extend(result_outsamples); sort(key=lambda x: x[0])
  // 稳定排序；Python 里这一列可能是 int（ele==0）也可能是文件名（字符串），
  // 拆掉 int 标记后再比，两种情况都与 Python 的排序一致。
  const all = outStd.concat(outSamples);
  const key = (v) => (P.untagInt ? P.untagInt(v) : v);
  all.sort((a, b) => {
    const x = key(a[0]), y = key(b[0]);
    return x < y ? -1 : (x > y ? 1 : 0);
  });

  return {
    sampleslist,
    num: (() => { const m = {}; for (const f of order) m[f] = perFile[f].num; return m; })(),
    meanCpsCsv: P.buildMeanCpsCsv(meanRows),
    resultAllCsv: P.buildResultAllCsv(all),
    meanRows, resultRows: all,
  };
}

const DS_PIPELINE = { attach, pySlice, pyInt, CHANNEL_SUFFIX, loadThermoFiles,
  sliceChannels, meanCpsRow, run };
if (typeof window !== 'undefined') {
  window.DS_PIPELINE = DS_PIPELINE;
  Object.assign(window.DS = window.DS || {}, DS_PIPELINE);
}
if (typeof module !== 'undefined' && module.exports) module.exports = DS_PIPELINE;
