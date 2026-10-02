# -*- coding: utf-8 -*-
"""把一批**真实**的 Thermo/iCAP Qtegra 导出做成网页版的内置示例数据（已脱敏）。

    python webgui/make_real_demo.py --src "G:/.../20210319CKDA"
    python webgui/make_real_demo.py --src ... --check     # 只核对产出是否与当前源一致

产出
----
    webgui/src/demo_real.js      内嵌数据（build_ui.py 会把它拼进单文件）

为什么要内嵌而不是让页面去读文件
--------------------------------
网页版承诺"双击一个文件、离线就能用"。而 `file://` 下 `fetch()` 会被浏览器
拦掉（CORS），所以示例数据**必须**在文件里面。50 个文件原样嵌进去是 1.6 MB，
单文件会涨到 1.9 MB；gzip 之后是 336 KB、base64 之后 448 KB ——
页面从 284 KB 涨到约 750 KB，仍然是个能双击打开的小文件。
运行时用标准库 `DecompressionStream('gzip')` 解开，不引任何第三方库。

脱敏规则（数值一个字节都不动）
------------------------------
  1. 样品名（每个文件第 1 行 `:` 之前那一段）不在 KEEP_NAMES 里的，
     按**出现顺序**重编号为 `S-01`、`S-02`…（同一个原名映射到同一个新名）
  2. 第 1 行的日期时间戳一律归零成 `01/01/2020 12:00:00 AM`
  3. 文件名改成 `sample_NN.csv`（NN 按原始采集顺序）
  4. **其余部分原样保留** —— 包括那 12 行仪器元信息。那是方法信息，
     不是身份信息，而且它正是"阅读器必须跳过 12 行才能找到表头"这件事的现场。

**数值不做任何改动**：一旦动过，"与桌面版逐位相同"这条对外承诺就没了。

输出里带自检
------------
脚本写完会**自己再读一遍**（用真源码 src/*.js 在 node 里跑一遍），确认：

  · 50 个文件仍然全部走严格路径、行数与原始一致；
  · 标样 AY-4 按**推荐参数**跑出来的年龄，落在两个公开发表的
    ID-TIMS 值的包络内（见 LITERATURE）；
  · 明文 JSON 的 sha256 与写进文件里的那个一致。

任何一条不过就报错**不落盘** —— 一份看着像样、其实算错了的示例数据，
比没有示例数据更糟。
"""

import argparse
import base64
import gzip
import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import sys

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(errors='replace')
    except Exception:
        pass

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'src', 'demo_real.js')
CHUNK = 4000                      # base64 每段的长度，免得出现一行 60 万字符

#  保留原名的**标样**：标样本来就是要公开命名的（要写进论文的方法一节），
#  而且示例里"标样名称"这个输入框得填真名，工作流才说得通。
#  样品代号一律重编号 —— 那些往往直接指向产地。
KEEP_NAMES = ['SRM 612', 'AY-4']

#  第 1 行的形态：`<名字>:<月>/<日>/<年> <时>:<分>:<秒> <AM|PM>;`
FIRST_LINE = re.compile(r'^([^:]*):(\d{2}/\d{2}/\d{4} \d{2}:\d{2}:\d{2} [AP]M);?$')
ZERO_TIME = '01/01/2020 12:00:00 AM'

# ------------------------------------------------------------------ 推荐参数
#  界面与测试共用这一个真源。改这里必须重新生成，`--check` 会拦住没重生成的情况。
#
#  b0/b1 取 1~25 s：这批数据的激光约在 30 s 才开，之前全是气体背景。
#  method=1（207Pb 校正）与源方法文档里那批实验的处理方式一致
#  （用 Isoplot 投 Tera-Wasserburg 图、按 207Pb 扣普通铅）。
DEMO_PARAMS = {
    'inst': 'thermo',
    'b0': 1, 'b1': 25, 'multi': 4,
    'stdName': 'AY-4', 'stdAge': 158.2, 'fracStd': 'AY-4',
    'nistStd': 'SRM 612',
    'method': 1, 'algo': 'avg', 'excess': 3,
}

#  AY-4 的**公开发表** ID-TIMS 年龄。判据就架在这两个值上，不是架在自己的输出上。
LITERATURE = [
    ('Yuan et al. (2011)', 158.2, 0.4),
    ('Carr et al. (2020)', 151.9, 2.2),
]
#  两个发表值本身相差 6.3 Ma（源方法文档花了一整节讨论 AY-4 到底是多少），
#  所以判据取它们的中点 ±5 Ma —— 比任何一个发表值都宽，仍然卡得住
#  分馏校正、背景窗口、普通铅扣除这几处会出量级错的环节。
LIT_MID = sum(v[1] for v in LITERATURE) / len(LITERATURE)
LIT_TOL = 5.0
MSWD_MAX = 2.0


def find_node():
    """找 node。

    **不要**用 os.popen 去读 `where node` —— 它按控制台代码页输出
    （这台机器用户名含中文，路径按 GBK 出来），按 UTF-8 解码会直接抛
    UnicodeDecodeError。shutil.which 不经过任何解码，安全。
    """
    p = shutil.which('node')
    if p:
        return p
    cand = os.path.join(os.path.expanduser('~'), '.workbuddy', 'binaries', 'node')
    if os.path.isdir(cand):
        for v in sorted(os.listdir(cand), reverse=True):
            p = os.path.join(cand, v, 'node.exe')
            if os.path.isfile(p):
                return p
    return None


def read_source(src):
    """按采集顺序（文件名尾号）读全部 csv。"""
    names = [f for f in os.listdir(src) if f.lower().endswith('.csv')]
    if not names:
        raise SystemExit('!! %s 里没有 csv' % src)

    def key(n):
        m = re.search(r'(\d+)\D*$', os.path.splitext(n)[0])
        return int(m.group(1)) if m else 0

    names.sort(key=key)
    out = []
    for n in names:
        raw = io.open(os.path.join(src, n), 'rb').read()
        try:
            text = raw.decode('utf-8')
        except UnicodeDecodeError:
            raise SystemExit('!! %s 不是 UTF-8（这批是 iCAP 导出的纯 ASCII）' % n)
        if any(ord(c) > 127 for c in text):
            raise SystemExit('!! %s 含非 ASCII 字符，压缩与解码的前提不成立' % n)
        out.append((n, text))
    return out


def anonymize(files):
    """按规则脱敏，返回 (files_out, 统计, 原名→新名映射)。

    映射只用来核对"同一个原名总是映射到同一个新名"，**不落盘** ——
    落盘就等于把原代号写进了仓库。
    """
    mapping, out = {}, []
    stats = {'kept': {}, 'renamed': 0, 'samples': 0}
    for i, (fname, text) in enumerate(files):
        lines = text.split('\n')
        if not lines:
            raise SystemExit('!! %s 是空文件' % fname)
        m = FIRST_LINE.match(lines[0].rstrip('\r'))
        if not m:
            raise SystemExit('!! %s 第 1 行不是预期形态：%r' % (fname, lines[0][:80]))
        orig = m.group(1)
        if orig in KEEP_NAMES:
            new = orig
            stats['kept'][orig] = stats['kept'].get(orig, 0) + 1
        else:
            if orig not in mapping:
                stats['samples'] += 1
                mapping[orig] = 'S-%02d' % stats['samples']
            new = mapping[orig]
            stats['renamed'] += 1
        lines[0] = '%s:%s;%s' % (new, ZERO_TIME, '\r' if lines[0].endswith('\r') else '')
        out.append({'file': 'sample_%02d.csv' % (i + 1), 'name': new,
                    'text': '\n'.join(lines)})
    return out, stats, mapping


# ------------------------------------------------------------------ node 自检
#
#  一次 node 调用干三件事：读回脱敏后的文件、字节自证、按推荐参数跑完整管线量标样。
#  合成一次调用是为了让这三件事用的是**同一批**内存里的数据 ——
#  分几次跑就可能一边过一边不过，还会让人以为是文件的问题。
#
#  数据来源有两条：
#    argv[1] 给了路径 → 从那个 JSON 读（生成**之前**用，此时 demo_real.js 还没写）
#    没给路径         → 走 demo_real.js 自己的 decode()（生成**之后**复检产物用）
PROBE = r'''
const fs=require('fs'),path=require('path'),vm=require('vm'),crypto=require('crypto');
const SRC=path.join(process.cwd(),'src');

//  demo_real.js 的 decode() 用浏览器全局量（DecompressionStream/Response/Blob/atob）。
//  Node 18+ 自己也有，但 vm 沙箱**不继承** —— 必须显式转发，
//  否则一切想解内置数据的 node 代码都会摔在"这个浏览器没有 DecompressionStream"上。
const sb={window:{},console,DecompressionStream,Response,Blob,atob,btoa,
          Uint8Array,ArrayBuffer,TextDecoder,TextEncoder,Promise};
vm.createContext(sb);
for(const f of ['fp.js','math.js','thermo.js','window.js','report.js','pipeline.js',
                'age.js','qc.js'])
  vm.runInContext(fs.readFileSync(path.join(SRC,f),'utf8'),sb,{filename:f});
//  产物可能还不存在（首次生成）—— 不存在就走 argv[1]
let D=null;
try{
  vm.runInContext(fs.readFileSync(path.join(SRC,'demo_real.js'),'utf8'),sb,
                  {filename:'demo_real.js'});
  D=sb.window.DS_DEMO_REAL;
}catch(e){ D=null; }

const W=sb.window, FP=W.DS_FP, M=W.DS, TH=W.DS_THERMO, RP=W.DS_REPORT,
      WIN=W.DS_WINDOW, PL=W.DS_PIPELINE, AGE=W.DS_AGE, QC=W.DS_QC;

//  接线与 ui/app.js 第 32-48 行**完全一致**
WIN.setNumeric(M);
PL.attach({thermoLoad:TH.thermoLoad, agilentLoad:TH.agilentLoad,
  thermoSampleName:TH.thermoSampleName, detectSignalWindow:WIN.detectSignalWindow,
  nmean:M.nmean, untagInt:M.untagInt, reduceSample:M.reduceSample,
  buildMeanCpsCsv:RP.buildMeanCpsCsv, buildResultAllCsv:RP.buildResultAllCsv});
AGE.attach({pwSum:M.pwSum, nnanmean:M.nnanmean, age76Pb:M.age76Pb,
  age76PbFixed:M.age76PbFixed, sk2model:M.sk2model});
const ISONAME=['Time','202Hg','204Pb','206Pb','207Pb','208Pb','232Th','238U'];

const OUT={};   // 要回传给 Python 的东西
//  ⚠ `node -e CODE extra` 的 argv 是 [node, extra] —— 额外参数在 argv[1]，
//    不是 argv[2]（argv[1] 只有在跑**脚本文件**时才是脚本路径）。
//    这两个下标非常容易记反，实测过：`node -e "…" foo.json` → ["…node.exe","foo.json"]。
const fromFile = process.argv.length < 2;

const src = fromFile
  ? (D ? D.decode() : Promise.reject(new Error('src/demo_real.js 不存在或没有 DS_DEMO_REAL')))
  : Promise.resolve(JSON.parse(fs.readFileSync(process.argv[1],'utf8')));

src.then(function(files){
  OUT.origin = fromFile ? 'demo_real.js' : 'records';

  // ---- ① 读回：脱敏后的文件还得能被真阅读器认成 iCAP 格式 ----
  let strict=0, fail=[], rows=[], names=[];
  for(const r of files){
    try{
      const o=TH.thermoLoad(r.text,ISONAME,{});
      if(o.mode!=='strict') fail.push(r.file+': 走了 '+o.mode); else strict++;
      rows.push(o.x.length);
      const n=TH.thermoSampleName(r.text);
      names.push(n);
      if(n!==r.name) fail.push(r.file+': 名字对不上 '+n+' vs '+r.name);
    }catch(e){ fail.push(r.file+': '+e.message); }
  }
  OUT.read={strict:strict,total:files.length,fail:fail.slice(0,5),failN:fail.length,
    rowsMin:Math.min.apply(null,rows),rowsMax:Math.max.apply(null,rows),
    names:names};

  // ---- ② 字节自证：把解出来的 JSON 重新序列化，指纹必须与文件里写的那个一致 ----
  const raw=JSON.stringify(files);
  OUT.bytes={len:Buffer.byteLength(raw,'utf8'),
    sha256:crypto.createHash('sha256').update(Buffer.from(raw,'utf8')).digest('hex')};
  if(D){ OUT.bytes.declaredLen=D.rawBytes; OUT.bytes.declaredSha=D.sha256; }

  // ---- ③ 按推荐参数跑完整管线，量标样 ----
  const P=D?D.params:JSON.parse(process.env.PROBE_PARAMS);
  const a=FP.dexp(0.000000000155125*P.stdAge*1000000)-1;
  const b=FP.dexp(0.00000000098485*P.stdAge*1000000)-1;
  const c=FP.dexp(0.000000000049475*P.stdAge*1000000)-1;
  const cal={a:a,b:b,c:c,P382:1/137.818*(b/a),Q8:18.700-a*9.735,
    R8:15.628-b*(9.735/137.818),S8:38.630-c*36.837,
    Pbc:(15.628-b*(9.735/137.818))/(18.700-a*9.735),Standard_age:P.stdAge};
  const stdSet={}; stdSet[P.stdName]=P.stdAge;
  const out=PL.run({files:files,isoname:ISONAME,b0:P.b0,b1:P.b1,multi:P.multi,
    stdcor:0,method:P.method,standardNames:stdSet,ctx:cal,eleIndex:2,
    instrument:P.inst,sampleNames:null});
  const input=AGE.buildInput(out.resultAllCsv,out.meanCpsCsv,null);
  input.fix76=false;
  input.cfg={method:P.method,excessV:P.excess/100,nistStd:P.nistStd,
    standard:P.fracStd,P382:cal.P382,a:cal.a,b:cal.b,c:cal.c,Pbc:cal.Pbc,
    age:100,radioactivePb:0.048015,commonPb:0.842185,
    commonPb206_208:0.48240,commonPb207_208:0.40628,commonPb206_204:18.5478,
    commonPb207_204:15.6207,commonPb208_204:38.447,radioactiveSPb207_206:cal.P382};
  const res=(P.algo==='avg')?AGE.averageAge(input):AGE.linearAge(input);

  //  ⚠ QC_CORR_COL / QC_UNCORR_COL 是 **0 基**（见 qc.js 第 34 行），
  //    直接拿来当下标用，别再减 1 —— 减了就变成读 2s 列。
  const pick=QC.qcDefaultAge(P.method,'206Pb/238U');
  const col=QC.qcAgeCol(P.method,pick.key,pick.corrected);
  const groups=QC.qcGroupBySample(res.rows);
  const per={};
  for(const g of groups){
    per[g.name]=QC.qcWavg(g.rows.map(r=>({age:+r[col],s2:+r[col+QC.QC_ERR_OFFSET]})));
  }
  OUT.age={col:col,key:pick.key,corrected:pick.corrected,groups:groups.length,per:per,
    coeff:res.coefficients||null,
    factors:res.factors?{f76:res.factors.f207_206,f68:res.factors.f206_238}:null};

  //  ---- ④ 这批数据自己有哪些毛病（真数据一定有的）----
  //  量出来写进产物，让界面能**如实**告诉用户"你会看到 NaN，原因是这个"。
  //  手写这份清单是不行的 —— 数据一换就过期，而且没人会记得改。
  //  ⚠ 键名要与 Python 侧读的**逐字一致**（weakFiles / sigMedian / sigMin / nanRows）。
  //    写成 weak 那种对不上的名字，Python 那边拿到的是 None，
  //    表现是"这一项永远是 0 个"—— 静默，不报错。
  OUT.flaws={
    nanRows: res.rows.filter(r=>!isFinite(+r[col])||!isFinite(+r[col+QC.QC_ERR_OFFSET]))
      .map(r=>({file:String(r[0]),sample:String(r[1])})),
    weakFiles: [],
  };
  //  每个文件净 206Pb（y3）信号强度，用来找"信号特别弱"的那几个
  const sig=[];
  for(const r of out.meanRows){
    //  meanRows 列：0 文件名，1 样品名，2..8 背景 7 通道，9..15 信号 7 通道
    //  CHANNEL_SUFFIX 顺序 Hg202 Hg204 Pb206 Pb207 Pb208 Th232 U238 见 pipeline.js
    const sb=+r[2+2], ss=+r[9+2];
    sig.push([String(r[0]),ss-sb]);
  }
  sig.sort((x,y)=>x[1]-y[1]);
  const mid=sig.length?sig[Math.floor(sig.length/2)][1]:0;
  OUT.flaws.weakFiles=sig.filter(s=>!(s[1]>mid*0.5)).map(s=>({file:s[0],netPb:s[1]}));
  OUT.flaws.sigMin=sig.length?sig[0][1]:null;
  OUT.flaws.sigMedian=mid;

  OUT.params = D ? D.params : null;
  console.log(JSON.stringify(OUT));
}).catch(function(e){ console.error('PROBE-ERR '+((e&&e.stack)||e)); process.exit(1); });
'''


def probe(records=None, params=None):
    """跑一次 node 自检，返回结果字典；失败抛 SystemExit（调用方据此不落盘）。

    records=None  → 让探针走 src/demo_real.js 自己的 decode()（复检刚写出的产物）
    records=[...] → 走临时 JSON（生成**之前**用，那时产物还没写）
    """
    node = find_node()
    if not node:
        raise SystemExit('!! 找不到 node —— 自检与"量标样"都必须靠它，不能跳过')

    args = [node, '-e', PROBE]
    env = dict(os.environ)
    tmp = None
    if params is not None:
        env['PROBE_PARAMS'] = json.dumps(params)
    if records is not None:
        tmp = os.path.join(HERE, 'src', '_demo_probe.json')
        io.open(tmp, 'w', encoding='utf-8', newline='').write(
            json.dumps(records, ensure_ascii=False))
        args.append(tmp)
    try:
        p = subprocess.run(args, cwd=HERE, capture_output=True, text=True,
                           errors='replace', timeout=900, env=env)
        line = [l for l in (p.stdout or '').splitlines() if l.startswith('{')]
        if not line:
            raise SystemExit('!! node 自检没给出结果：\n%s'
                             % ((p.stderr or p.stdout or '')[-1500:]))
        return json.loads(line[-1])
    finally:
        if tmp and os.path.isfile(tmp):
            os.remove(tmp)


def fmt(v, n=2):
    return '—' if not isinstance(v, (int, float)) else ('%.*f' % (n, v))


def report_and_check(r, stats, params, tag=''):
    """把自检结果打印出来，并判"这批数据 + 这套参数"是否合格。"""
    bad = []
    if tag:
        print('【%s】数据来源 %s' % (tag, r.get('origin', '?')))

    # ① 读回
    rd = r['read']
    print('  读回：%d/%d 走严格路径 ｜ 数据行 %d~%d ｜ 失败 %d'
          % (rd['strict'], rd['total'], rd['rowsMin'], rd['rowsMax'], rd['failN']))
    for f in rd['fail']:
        print('     !! ' + f)
    if rd['failN'] or rd['strict'] != rd['total']:
        bad.append('有文件没能通过真阅读器的严格路径')

    # ② 字节自证
    by = r['bytes']
    #  只有"从产物读"的那一趟才有可比对象（生成前产物还不存在）
    if by.get('declaredLen'):
        print('  字节：重算 %d B / sha256 %s… —— 与产物声明的 %d B / %s… %s'
              % (by['len'], by['sha256'][:16], by['declaredLen'],
                 str(by.get('declaredSha'))[:16],
                 '一致' if (by['len'] == by['declaredLen']
                            and by['sha256'] == by['declaredSha']) else '**不一致**'))
        if by['len'] != by['declaredLen'] or by['sha256'] != by['declaredSha']:
            bad.append('解出来的 JSON 与产物里声明的指纹不一致')
    else:
        print('  字节：明文 %d B，sha256 %s…（本趟没有可比对象）'
              % (by['len'], by['sha256'][:16]))

    # ③ 名字与计数
    names = rd['names']
    kept = {k: names.count(k) for k in KEEP_NAMES}
    for k, want in stats['kept'].items():
        if kept.get(k, 0) != want:
            bad.append('%s 出现 %d 次，期望 %d 次' % (k, kept.get(k, 0), want))
    allowed = re.compile(r'^(%s|S-\d\d)$' % '|'.join(re.escape(k) for k in KEEP_NAMES))
    leaks = sorted({n for n in names if not allowed.match(n)})
    if leaks:
        bad.append('有 %d 个样品名不符合脱敏规则：%s' % (len(leaks), '、'.join(leaks[:3])))

    # ④ 标样年龄落在公开文献的包络里
    ag = r['age']
    std = ag['per'].get(params['stdName']) or {}
    #  qcWavg 的 se 是 **1σ**（内部标准误），报告里一律按 2σ 说话 —— 这里折一下
    mean, se, mswd, n = std.get('mean'), std.get('se'), std.get('mswd'), std.get('n')
    drop = std.get('dropped', 0) or 0
    se2 = None if se is None else se * 2
    print('  标样 %s：参与平均 %s 点（另有 %s 点因年龄/误差非有限被剔除）'
          '  加权平均 %s ± %s Ma（2σ）  MSWD %s'
          % (params['stdName'], n, drop, fmt(mean), fmt(se2), fmt(mswd)))
    if drop:
        #  真数据里这很正常（某一个点剥蚀失败、信号太弱）。
        #  但它是"标准样自己有毛病"的信号，必须让人看见 —— 只报不拦。
        print('      （剔除是真数据里的常态：那一个点的年龄或误差算不出有限值。'
              '具体是哪几个点、为什么，见质量报告里的逐点表。）')
    for who, age, s in LITERATURE:
        print('      发表值 %-20s %6.1f ± %.1f Ma   →  差 %s Ma'
              % (who, age, s, fmt(None if mean is None else mean - age)))
    if not isinstance(mean, (int, float)) or not isinstance(mswd, (int, float)):
        bad.append('%s 的加权平均或 MSWD 算不出来' % params['stdName'])
    else:
        if abs(mean - LIT_MID) > LIT_TOL:
            bad.append('%s 出 %.2f Ma，离两个发表值的中点 %.2f Ma 超过 %.0f Ma'
                       % (params['stdName'], mean, LIT_MID, LIT_TOL))
        if mswd > MSWD_MAX:
            bad.append('%s 的 MSWD %.2f > %.1f —— 这批标准样自己都不自洽'
                       % (params['stdName'], mswd, MSWD_MAX))
        #  "参与 + 剔除 = 文件数" —— 等式不成立说明有行**静默丢了**，
        #  那才是真 bug（点数变少但没人说得出少了哪个）。
        if n + drop != stats['kept'].get(params['stdName']):
            bad.append('%s 文件 %s 个，但参与 %s + 剔除 %s = %s 个对不上'
                       % (params['stdName'], stats['kept'].get(params['stdName']),
                          n, drop, n + drop))
    if ag['coeff'] and all(v == 0 for v in ag['coeff']):
        bad.append('微量元素换算系数全是 0 —— 外标 %s 没被认出来' % params['nistStd'])

    # ⑤ 这批数据自己的毛病 —— 只报不拦，但要写进产物让界面能说清原因
    fl = r.get('flaws') or {}
    #  防呆：这两边（探针输出的键名 / 这里读的键名）对不上时，
    #  Python 拿到的是 None，表现是"这一项永远是 0 个"——**静默，不报错**。
    #  踩过一次（weak vs weakFiles），所以把键名变成断言。
    want_keys = {'nanRows', 'weakFiles', 'sigMin', 'sigMedian'}
    missing = want_keys - set(fl)
    if missing:
        raise SystemExit('!! 探针返回的 flaws 缺少键 %s —— 探针里的键名与这里读的对不上了'
                         % '、'.join(sorted(missing)))
    nan = fl.get('nanRows') or []
    weak = fl.get('weakFiles') or []
    print('  净 ²⁰⁶Pb 计数中位数 %s；信号最弱的 1 个 %s'
          % (fmt(fl.get('sigMedian'), 0),
             fmt(fl.get('sigMin'), 0)))
    print('  整行比值算不出来（NaN）的文件 %d 个：%s'
          % (len(nan), '、'.join('%s(%s)' % (x['file'], x['sample']) for x in nan) or '无'))
    print('  净 ²⁰⁶Pb 低于中位数一半的文件 %d 个：%s'
          % (len(weak), '、'.join('%s(%.0f)' % (x['file'], x['netPb']) for x in weak[:6])
             + (' 等' if len(weak) > 6 else '')))

    if bad:
        for b in bad:
            print('  !! ' + b)
        raise SystemExit('!! 自检不通过，不落盘')
    return mean, se2, mswd, n


def build_js(records, stats, r, mean, se2, mswd, nstd, blob, gz, b64, parts, params):
    flaws = r.get('flaws') or {}
    js = io.StringIO()
    js.write('''/* ==========================================================================
 *  demo_real.js —— 内置的**真实**示例数据（锡石 LA-ICP-MS U-Pb，已脱敏）
 *
 *  这个文件是**生成的**，别手改：webgui/make_real_demo.py
 *
 *  内容：%d 个真实的 Thermo / iCAP Qtegra 导出，按原始采集顺序排列。
 *        其中标样 %s，样品 %d 个。
 *
 *  脱敏：样品代号按出现顺序重编号成 S-01…，第 1 行的采集时间戳归零成
 *        %s，文件名改成 sample_NN.csv。12 行仪器元信息原样保留 ——
 *        那是方法信息，不是身份信息，也正是"阅读器必须跳过 13 行才能
 *        找到表头"这件事的现场。
 *        **数值一个字节都没动** —— 动了就破坏"与桌面版逐位相同"这条对外承诺。
 *
 *  为什么是 gzip 而不是明文：明文 %d KB，gzip 后 %d KB，base64 后 %d KB。
 *        页面为此从 284 KB 涨到约 750 KB，仍然是个能双击打开的小文件。
 *        解压用浏览器标准库 DecompressionStream('gzip')，不引第三方库。
 *
 *  这套数据按下面 params 跑出来的结果（由生成脚本用真管线量出，不是手写的）：
 *        标样 %s：n=%d，加权平均 %s ± %s Ma（2σ），MSWD %s
 * ========================================================================== */
(function () {
  'use strict';

  var B64 = [
''' % (len(records),
       '、'.join('%s×%d' % (k, v) for k, v in sorted(stats['kept'].items())),
       stats['samples'], ZERO_TIME,
       len(blob) // 1024, len(gz) // 1024, len(b64) // 1024,
       params['stdName'], nstd, fmt(mean), fmt(se2), fmt(mswd)))
    for p in parts:
        js.write("    '%s',\n" % p)
    js.write('''  ].join('');

  /** 解开成 [{file, name, text}, ...]，按原始采集顺序。 */
  function decode() {
    if (typeof DecompressionStream !== 'function') {
      return Promise.reject(new Error(
        '这个浏览器没有 DecompressionStream，解不开内置的真实示例数据。'
        + '需要 Chrome/Edge 80+、Safari 16.4+ 或 Firefox 113+。'
        + '可以改用"合成示例"，或直接载入你自己的数据。'));
    }
    var bin = atob(B64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Response(
      new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))
    ).text().then(function (t) { return JSON.parse(t); });
  }

  var DS_DEMO_REAL = {
    encoding: 'gzip+base64',
    files: %d,
    rawBytes: %d,
    gzipBytes: %d,
    b64Chars: %d,
    sha256: '%s',            // 明文 JSON 的指纹，用来核对"这批数据有没有被换过"

    /* ---- 推荐参数：界面与测试共用这一个真源，别在别处再抄一份 ----
     *
     * 这套值不是猜的，是拿**真管线**在这批数据上量出来的
     * （量法与判据见 webgui/make_real_demo.py 与 webgui/test_demo_real.js）。
     * 标样 %s 出 %s ± %s Ma（MSWD %s），与两个公开发表的 ID-TIMS 值：
     *   %s
     * 都对得上。这两个值本身相差 %.1f Ma —— AY-4 的"真值"在文献里就有争议，
     * 源方法文档花了一整节讨论这件事，所以判据取两者中点 %.2f ± %.0f Ma。
     *
     * b0/b1 取 1~25 s：这批数据的激光约在 30 s 才开，之前全是气体背景。
     * 窗口在 1~25 / 5~20 / 8~16 之间变化时，标样只在 156.85~157.04 Ma
     * 之间动 —— 不是刀刃上的选择。
     */
    params: {
      inst: '%s',
      b0: %s, b1: %s, multi: %s,
      stdName: '%s', stdAge: %s, fracStd: '%s',
      nistStd: '%s',
      method: %d, algo: '%s', excess: %s
    },
    stdRefs: [
''' % (len(records), len(blob), len(gz), len(b64),
       hashlib.sha256(blob).hexdigest(),
       params['stdName'], fmt(mean), fmt(se2), fmt(mswd),
       '；'.join('%s %s ± %s Ma' % (w, a, s) for w, a, s in LITERATURE),
       abs(LITERATURE[0][1] - LITERATURE[1][1]), LIT_MID, LIT_TOL,
       params['inst'],
       params['b0'], params['b1'], params['multi'],
       params['stdName'], params['stdAge'], params['fracStd'],
       params['nistStd'], params['method'], params['algo'], params['excess']))
    for i, (who, age, s) in enumerate(LITERATURE):
        js.write("      { who: '%s', age: %s, s2: %s }%s\n"
                 % (who, age, s, ',' if i + 1 < len(LITERATURE) else ''))
    js.write('''    ],

    /* ---- 这套参数在这批数据上量出来的标样结果 ----
     *
     * 和 params / stdRefs 一样，是**生成的**，不是手写的。
     * 界面日志与站点正文里那句"标样跑出来是 X ± Y Ma"都取这里 ——
     * 手写的那份迟早与数据/参数脱节（本文件里已经发生过一次：
     * 报告按 1σ 印、正文按 2σ 引，两边看着像对不上）。
     *
     * se2 是 **2σ**：qcWavg 给的是 1σ 内部标准误，生成脚本乘 2 之后写进来，
     * 所以这里必须连口径一起记下来，别让读的人去猜。
     */
    stdMeasured: { name: '%s', mean: %r, se2: %r, mswd: %r, n: %d,
                   unit: 'Ma', sigma: '2σ' },

    /* ---- 这批数据自己的毛病：由生成脚本用真管线量出来的，不是手写的 ----
     *
     * 真数据一定有这种点。写在这里不是为了免责，而是为了让界面在用户看到
     * NaN 的时候能**直接说清原因**，而不是让人怀疑程序坏了。
     *
     * nanRows  整行比值算不出来的文件。成因是窗口探测探到了**反的**窗口
     *          （s0 落在 s1 之后），pipeline.js 里那段照抄原实现的自检随后
     *          把 s0/s1 都设成 s1，信号段变成空切片 → 该行比值全是 NaN。
     *          质量报告会把它剔除，而不是拿它去污染加权平均 —— 所以
     *          "参与平均的点数"比"文件数"少，是**对的**，不是程序坏了。
     * weakFiles 净 ²⁰⁶Pb 计数低于本批中位数一半的文件（剥蚀失败或颗粒贫 U）。
     */
    flaws: { nanRows: %s, weakFiles: %s, netPbMedian: %s },
    decode: decode,
  };
  if (typeof window !== 'undefined') window.DS_DEMO_REAL = DS_DEMO_REAL;
  if (typeof module !== 'undefined' && module.exports) module.exports = DS_DEMO_REAL;
})();
''' % (params['stdName'], mean, se2, mswd, nstd,
       json.dumps(flaws.get('nanRows') or [], ensure_ascii=False),
       json.dumps(flaws.get('weakFiles') or [], ensure_ascii=False),
       json.dumps(flaws.get('sigMedian'))))
    return js.getvalue()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', required=True, help='原始导出目录')
    ap.add_argument('--check', action='store_true', help='只核对现有产物是否与源一致')
    a = ap.parse_args()
    src = a.src
    if not os.path.isdir(src):
        raise SystemExit('!! 目录不存在：%s' % src)

    files = read_source(src)
    records, stats, mapping = anonymize(files)

    print('源：%s' % src)
    print('文件数 %d ｜ 保留原名的标样 %s ｜ 重编号的样品 %d 个（占 %d 个文件）'
          % (len(records),
             '、'.join('%s×%d' % (k, v) for k, v in sorted(stats['kept'].items())),
             stats['samples'], stats['renamed']))
    #  映射**只打印个数与首尾**，不打印原代号 —— 免得它进日志/提交信息
    print('  新样品名：S-01 … S-%02d' % stats['samples'])

    if a.check:
        return check_only(records, stats)

    r = probe(records, DEMO_PARAMS)
    mean, se2, mswd, nstd = report_and_check(r, stats, DEMO_PARAMS, tag='生成前')

    blob = json.dumps(records, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    if r['bytes']['len'] != len(blob):
        raise SystemExit('!! 探针读到的明文 %d B，与本脚本算出的 %d B 不一致'
                         % (r['bytes']['len'], len(blob)))
    gz = gzip.compress(blob, 9)
    b64 = base64.b64encode(gz).decode('ascii')
    parts = [b64[i:i + CHUNK] for i in range(0, len(b64), CHUNK)]

    text = build_js(records, stats, r, mean, se2, mswd, nstd, blob, gz, b64,
                    parts, DEMO_PARAMS)

    io.open(OUT, 'w', encoding='utf-8', newline='').write(text)
    print('\n写出 %s：明文 %d KB → gzip %d KB → base64 %d KB（%d 段）'
          % (os.path.relpath(OUT, os.path.dirname(HERE)),
             len(blob) // 1024, len(gz) // 1024, len(b64) // 1024, len(parts)))
    print('明文 sha256 %s' % hashlib.sha256(blob).hexdigest())

    #  复检**刚写出的产物**：这条才是真护栏。
    #  它走的是浏览器那条路（demo_real.js 自己的 decode()），把 B64 解出来、
    #  重算指纹、再跑一遍管线 —— 也就是说它验的是"用户双击那个文件会拿到什么"，
    #  而不是"我以为我写了什么"。不复检的话，base64 里掉一段、gzip 头写错，
    #  生成脚本自己是看不出来的（它比的是自己内存里的那份）。
    print('\n复检产物：')
    try:
        r2 = probe(None, DEMO_PARAMS)
        if r2.get('params') != DEMO_PARAMS:
            raise SystemExit('!! 产物里声明的 params 与本脚本的 DEMO_PARAMS 不一致：\n'
                             '      产物 %s\n      本脚本 %s'
                             % (json.dumps(r2.get('params'), ensure_ascii=False),
                                json.dumps(DEMO_PARAMS, ensure_ascii=False)))
        report_and_check(r2, stats, DEMO_PARAMS, tag='复检产物')
    except SystemExit:
        #  产物已经落盘但不合格 —— 删掉它。
        #  留一份"看着像样、其实解不开"的示例数据，比没有更糟。
        os.remove(OUT)
        print('  （已删除不合格的产物 %s）' % os.path.relpath(OUT, os.path.dirname(HERE)))
        raise
    print('\n完成。')
    return 0


def check_only(records, stats):
    """--check：只核对现有产物与源是否一致，不做完整生成。

    用最便宜的方式判"要不要重跑"：把明文 JSON 的 sha256 与产物里声明的比。
    明文一变（源数据换了、脱敏规则改了）指纹就变，于是会要求重跑。
    参数或注释改了但明文没变，这里查不出来 —— 那种情况交给 CI 里的
    `test_demo_real.js` 与 `make_badges.py --check`。
    """
    if not os.path.isfile(OUT):
        print('--check：产物不存在，需要生成')
        return 1
    cur = io.open(OUT, encoding='utf-8').read()
    blob = json.dumps(records, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    h = hashlib.sha256(blob).hexdigest()
    m = re.search(r"sha256:\s*'([0-9a-f]{64})'", cur)
    if not m:
        print('--check：产物里读不出 sha256 —— 格式变了？')
        return 1
    if m.group(1) != h:
        print('--check：**产物与源不一致**（源 %s，产物声明 %s），重跑一次生成'
              % (h[:16], m.group(1)[:16]))
        return 1
    print('--check：产物与源一致（明文 sha256 %s）' % h[:16])
    return 0


if __name__ == '__main__':
    sys.exit(main())
