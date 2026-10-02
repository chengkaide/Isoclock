# -*- coding: utf-8 -*-
"""跨平台打包脚本：Windows → .exe，macOS → .app。

**PyInstaller 不能交叉编译。** Windows 的 .exe 只能在 Windows 上构建，
macOS 的 .app 只能在 macOS 上构建（需要 Xcode 命令行工具）。所以：

    本机 Windows   python packaging/build_app.py            -> dist/IsoclockWeb.exe
    macOS          python3 packaging/build_app.py           -> dist/IsoclockWeb.app
    本地不想装环境  .github/workflows/release.yml           -> CI 上两台机器各出一份

依赖（两条路都要）:
    pip install pywebview pyinstaller

脚本自己会做的事：
    1. 重建 webgui/isoclock.html（除非 --no-build），保证打进去的页面是当前的
    2. 缺图标就生成（packaging/make_icon.py）
    3. 调 PyInstaller
    4. 打印产物路径、体积、sha256
    5. --verify：把产物**真的跑一遍**页面内自检，读它写出来的结果（验收用）

用法:
    python packaging/build_app.py
    python packaging/build_app.py --verify
    python packaging/build_app.py --no-build --keep-build
"""

import argparse
import hashlib
import os
import shutil
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

# Windows 控制台在英文版系统上是 cp1252，中文版是 cp936 —— 前者编不出中文，
# `print` 直接抛 UnicodeEncodeError 把构建脚本打断（CI 上就是这么挂的）。
# 这里只放宽 errors，**保留控制台自己的编码**（强行改成 utf-8 会让中文控制台
# 显示成乱码），编不出来的字符退化成 '?'，不再致命。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(errors='replace')
    except Exception:
        pass

from isoclock_desktop import APP_NAME, APP_TAG, HTML_NAME, RESULT_FILE  # noqa: E402

VERSION = '2.1'
OUT_NAME = 'IsoclockWeb'            # 产物主名（避免空格与非 ASCII，跨平台最稳）
PLATFORM = 'win64' if os.name == 'nt' else ('macos' if sys.platform == 'darwin' else sys.platform)


def sh(cmd, **kw):
    print('  $ ' + ' '.join(cmd))
    return subprocess.run(cmd, cwd=ROOT, check=True, **kw)


def step(n, text):
    print('\n[%d] %s' % (n, text))


def build_webgui():
    """重建单文件页面 —— 打进去的必须是最新的。"""
    script = os.path.join(ROOT, 'webgui', 'build_ui.py')
    if not os.path.isfile(script):
        raise SystemExit('!! 找不到 webgui/build_ui.py')
    sh([sys.executable, script])


def ensure_icon():
    want = os.path.join(HERE, 'icons', 'icon.ico' if os.name == 'nt' else 'icon.png')
    if not os.path.isfile(want):
        sh([sys.executable, os.path.join(HERE, 'make_icon.py')])
    return want


def pyinstaller_args(icon, onefile):
    page = os.path.join(ROOT, 'webgui', HTML_NAME)
    if not os.path.isfile(page):
        raise SystemExit('!! 找不到 %s，先跑 build_ui.py' % page)

    args = [
        sys.executable, '-m', 'PyInstaller',
        '--noconfirm', '--clean',
        '--name', OUT_NAME,
        '--windowed',                       # 不要控制台窗口
        '--icon', icon,
        '--distpath', os.path.join(ROOT, 'dist'),
        '--workpath', os.path.join(ROOT, 'build'),
        '--specpath', os.path.join(ROOT, 'build'),
        # 页面作为数据文件带进去；运行期靠 sys._MEIPASS 找到它
        '--add-data', '%s%s.' % (page, os.pathsep),
        # pywebview 的平台后端是运行期才 import 的，PyInstaller 静态分析看不到
        '--collect-submodules', 'webview.dom',
    ]
    if os.name == 'nt':
        # Windows 走 WinForms + WebView2；clr/pythonnet 也必须显式带上
        for m in ('webview.platforms.winforms', 'webview.platforms.edgechromium',
                  'clr', 'pythonnet'):
            args += ['--hidden-import', m]
    elif sys.platform == 'darwin':
        args += ['--hidden-import', 'webview.platforms.cocoa']
        # 目标是 .app 包（onedir 形态）；macOS 上不能 onefile 出 .app
    if onefile and os.name == 'nt':
        args.append('--onefile')
    args.append(os.path.join(HERE, 'isoclock_desktop.py'))
    return args


def patch_macos_plist(app_dir):
    """把访达里显示的名字改成中文产品名（bundle 目录名保持 ASCII）。"""
    import plistlib
    plist = os.path.join(app_dir, 'Contents', 'Info.plist')
    if not os.path.isfile(plist):
        return
    with open(plist, 'rb') as fh:
        info = plistlib.load(fh)
    info['CFBundleDisplayName'] = APP_NAME
    info['CFBundleName'] = APP_NAME
    info['CFBundleShortVersionString'] = VERSION
    info['CFBundleVersion'] = VERSION
    info['LSMinimumSystemVersion'] = info.get('LSMinimumSystemVersion', '10.13')
    with open(plist, 'wb') as fh:
        plistlib.dump(info, fh)
    print('  Info.plist: CFBundleDisplayName = %s' % APP_NAME)


def sign_macos(app_dir):
    """ad-hoc 签名（`codesign -s -`）。

    **Apple Silicon 上这一步不是可选项**：arm64 的可执行文件必须带签名，
    哪怕是 ad-hoc 的，否则内核直接拒绝执行（表现是"打不开，没有任何提示"）。
    PyInstaller 会给它生成的二进制做 ad-hoc 签名，但整个 .app 包的外层
    也补一次更稳。

    这**不是**开发者签名 —— 从网上下载的包仍然会被 Gatekeeper 拦一次，
    用户需要右键"打开"或在"隐私与安全性"里放行（README 里写了）。
    """
    if not shutil.which('codesign'):
        print('  !! 没有 codesign（缺 Xcode 命令行工具），跳过签名。'
              'Apple Silicon 上产物可能无法启动。')
        return
    for target in (app_dir, os.path.join(app_dir, 'Contents', 'MacOS', OUT_NAME)):
        if os.path.exists(target):
            try:
                sh(['codesign', '--force', '--deep', '--sign', '-', target])
            except subprocess.CalledProcessError as exc:
                print('  !! 签名失败（exit %s），产物仍可尝试运行' % exc.returncode)


def make_zip(path):
    base = os.path.join(ROOT, 'dist', '%s-%s-%s' % (APP_TAG, VERSION, PLATFORM))
    if os.path.isdir(path):
        out = shutil.make_archive(base, 'zip', root_dir=ROOT, base_dir=os.path.relpath(path, ROOT))
    else:
        out = shutil.make_archive(base, 'zip', root_dir=os.path.dirname(path),
                                  base_dir=os.path.basename(path))
    return out


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as fh:
        for blk in iter(lambda: fh.read(1 << 20), b''):
            h.update(blk)
    return h.hexdigest()


def verify(artifact):
    """把产物真的启动一次，跑页面内自检。

    打包最容易坏的地方是"东西没进去"：页面文件、webview 后端、clr。
    静态检查看不出来，只有真跑一次才知道。
    """
    step(5, '验收：真跑一次页面内自检')
    if os.path.isdir(artifact):
        exe = os.path.join(artifact, 'Contents', 'MacOS', OUT_NAME)
    else:
        exe = artifact
    if not os.path.isfile(exe):
        print('  !! 找不到可执行文件 %s' % exe)
        return False
    if os.path.isfile(RESULT_FILE):
        os.remove(RESULT_FILE)
    print('  $ %s --selftest' % exe)
    try:
        subprocess.run([exe, '--selftest'], timeout=240, check=False)
    except subprocess.TimeoutExpired:
        print('  !! 自检超时')
        return False
    if not os.path.isfile(RESULT_FILE):
        print('  !! 没有写出结果文件 %s\n     说明程序在启动阶段就崩了 —— 看 desktop.log' % RESULT_FILE)
        return False
    txt = open(RESULT_FILE, encoding='utf-8').read().strip()
    print('  ' + txt.replace('\n', '\n  '))
    ok = 'SELFTEST-OK' in txt
    print('  => %s' % ('通过' if ok else '不通过'))
    return ok


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--no-build', action='store_true', help='不重建 webgui/isoclock.html')
    ap.add_argument('--keep-build', action='store_true', help='保留 build/ 中间目录')
    ap.add_argument('--no-zip', action='store_true', help='不打包 zip')
    ap.add_argument('--verify', action='store_true', help='构建完真跑一次自检')
    ap.add_argument('--onedir', action='store_true',
                    help='Windows 出目录版（启动快，但要发整个文件夹）')
    a = ap.parse_args()

    t0 = time.time()
    print('%s v%s  —  %s / Python %s'
          % (APP_NAME, VERSION, PLATFORM, sys.version.split()[0]))

    step(1, '重建单文件页面')
    if a.no_build:
        print('  --no-build，跳过')
    else:
        build_webgui()

    step(2, '图标')
    icon = ensure_icon()
    print('  %s' % os.path.relpath(icon, ROOT))

    step(3, 'PyInstaller')
    try:
        sh(pyinstaller_args(icon, onefile=not a.onedir))
    except subprocess.CalledProcessError as exc:
        raise SystemExit('!! PyInstaller 失败（exit %s）' % exc.returncode)

    step(4, '产物')
    if os.name == 'nt':
        artifact = os.path.join(ROOT, 'dist', OUT_NAME + '.exe') if not a.onedir \
            else os.path.join(ROOT, 'dist', OUT_NAME)
    elif sys.platform == 'darwin':
        artifact = os.path.join(ROOT, 'dist', OUT_NAME + '.app')
    else:
        artifact = os.path.join(ROOT, 'dist', OUT_NAME)
    if not os.path.exists(artifact):
        raise SystemExit('!! 没找到产物 %s' % artifact)
    if sys.platform == 'darwin':
        patch_macos_plist(artifact)
        sign_macos(artifact)

    def size_of(p):
        if os.path.isfile(p):
            return os.path.getsize(p)
        tot = 0
        for r, _, fs in os.walk(p):
            for f in fs:
                tot += os.path.getsize(os.path.join(r, f))
        return tot

    print('  %s' % artifact)
    print('  %6.1f MB' % (size_of(artifact) / 1048576.0))
    if os.path.isfile(artifact):
        print('  sha256 %s' % sha256(artifact)[:32])

    ok = True
    if a.verify:
        ok = verify(artifact)
    if not a.no_zip:
        z = make_zip(artifact)
        print('  zip  %s  (%.1f MB)  sha256 %s'
              % (os.path.relpath(z, ROOT), os.path.getsize(z) / 1048576.0,
                 sha256(z)[:32]))

    if not a.keep_build:
        shutil.rmtree(os.path.join(ROOT, 'build'), ignore_errors=True)

    print('\n完成，用时 %.1f 秒。' % (time.time() - t0))
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
