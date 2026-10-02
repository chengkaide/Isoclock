# -*- coding: utf-8 -*-
"""Isoclock 网页版的桌面外壳 —— Windows / macOS 同一份代码。

为什么要壳
----------
`webgui/isoclock.html` 本身是**单文件、零依赖**的，双击任意浏览器就能用 ——
那已经是最省事的跨平台形态。壳只补三件浏览器给不了的事：

1. 一个真正的应用窗口（标题栏、图标，没有地址栏和标签页）
2. 导出走**系统原生"另存为"**。WebView2 给 blob 下载的默认文件名是一串 GUID、
   没有扩展名，用户拿到 `a1b2c3d4` 这样的文件还得自己改名；原生对话框能带上
   正确文件名和扩展名
3. macOS 上是一个标准 `.app`，可以拖进"应用程序"、有图标、能从访达双击

界面**一行没改**：壳只是把同一个 `isoclock.html` 装进系统自带的 WebView
（Windows 用 WebView2 / EdgeChromium，macOS 用 WKWebView）。
所有计算都在页面里的 JS 完成，壳不参与任何数值运算，也不写任何中间文件
（除了一个用于排错的日志）。

命令行
------
    python packaging/isoclock_desktop.py              正常启动
    python packaging/isoclock_desktop.py --debug      带开发者工具
    python packaging/isoclock_desktop.py --selftest   跑页面内自检后退出，结果写文件
                                                      （给打包产物做自动化验收用）
"""

import os
import sys
import time

# 产品名只在这里定义一次。改名时改这一行 + build_app.py 会跟着走。
APP_NAME = 'Isoclock 网页版'
APP_TAG = 'isoclock-web'          # 用作产物文件名前缀
HTML_NAME = 'isoclock.html'
START_SIZE = (1480, 940)
MIN_SIZE = (1024, 680)
SELFTEST_TIMEOUT = 120            # 秒

_window = None
_webview = None


# ---------------------------------------------------------------- 路径

def resource_dir():
    """打包后是 PyInstaller 解出来的目录；源码运行时是仓库根。"""
    if getattr(sys, 'frozen', False):
        return getattr(sys, '_MEIPASS', os.path.dirname(os.path.abspath(sys.executable)))
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def find_html():
    root = resource_dir()
    for c in (os.path.join(root, HTML_NAME),
              os.path.join(root, 'webgui', HTML_NAME)):
        if os.path.isfile(c):
            return c
    return None


def log_dir():
    """可写的日志目录。

    macOS 上从访达启动 .app 时当前目录是 `/`，Windows 上装在 Program Files
    下时程序目录不可写 —— 所以日志一律放到系统规定的用户目录里。
    """
    if sys.platform == 'darwin':
        base = os.path.expanduser('~/Library/Logs')
    elif os.name == 'nt':
        base = os.environ.get('LOCALAPPDATA') or os.path.expanduser('~')
    else:
        base = os.environ.get('XDG_STATE_HOME') or os.path.expanduser('~/.local/state')
    d = os.path.join(base, 'Isoclock')
    try:
        os.makedirs(d, exist_ok=True)
        return d
    except OSError:
        return os.path.expanduser('~')


LOG_PATH = os.path.join(log_dir(), 'desktop.log')


def log(msg):
    try:
        with open(LOG_PATH, 'a', encoding='utf-8') as fh:
            fh.write('%s  %s\n' % (time.strftime('%Y-%m-%d %H:%M:%S'), msg))
    except OSError:
        pass


# ---------------------------------------------------------------- 出错时看得见

def _alert(title, text):
    """没有控制台，出错必须弹窗 —— 否则用户看到的只是"闪一下就没了"。"""
    log('ALERT %s | %s' % (title, text.replace('\n', ' / ')))
    ok = False
    try:
        wv = _webview
        if wv is not None:
            wv.create_window(title, html=_error_html(title, text))
            wv.start()
            ok = True
    except Exception:
        ok = False
    if ok:
        return
    # 连 webview 都用不了，退到系统自带的最小弹窗
    try:
        if os.name == 'nt':
            import ctypes
            ctypes.windll.user32.MessageBoxW(0, text, title, 0x10)
            return
        if sys.platform == 'darwin':
            import subprocess
            subprocess.run(['osascript', '-e',
                            'display dialog %s with title %s buttons {"好"} default button 1 with icon stop'
                            % (_osa(text), _osa(title))], check=False)
            return
    except Exception:
        pass
    sys.stderr.write('%s\n%s\n' % (title, text))


def _osa(s):
    return '"%s"' % str(s).replace('\\', '\\\\').replace('"', '\\"')


def _error_html(title, text):
    import html
    return ('<!doctype html><meta charset="utf-8">'
            '<body style="font:14px/1.6 -apple-system,Segoe UI,Microsoft YaHei,sans-serif;'
            'padding:40px;max-width:760px;margin:auto;color:#222">'
            '<h2 style="color:#b3261e">%s</h2><pre style="white-space:pre-wrap;'
            'background:#f6f6f6;padding:16px;border-radius:8px">%s</pre>'
            '<p style="color:#666">日志：%s</p></body>'
            % (html.escape(title), html.escape(text), html.escape(LOG_PATH)))


# ---------------------------------------------------------------- 暴露给页面的接口

class Api:
    """页面通过 window.pywebview.api.xxx() 调用。

    只有两个方法，都是"浏览器做不到"的事。**不碰任何数据**：
    页面给什么文本就写什么文本，一个字节都不加工。
    """

    def save_as(self, name, text):
        """把导出内容写到用户选的位置，返回落盘路径（取消返回空串）。

        写盘用 encoding='utf-8' + newline=''：
        页面里的字符串是浏览器 Blob 的原样内容（CSV 里的 CRLF 是 Python csv
        模块的写法），不去动换行，导出的 CSV / JSON 仍与桌面版逐字节相同。
        """
        import webview
        try:
            safe = os.path.basename(str(name or '').strip()) or 'isoclock_export.txt'
            ext = os.path.splitext(safe)[1]
            kinds = ()
            if ext:
                kinds = ('%s 文件 (*%s)' % (ext.lstrip('.').upper(), ext),
                         '所有文件 (*.*)')
            else:
                kinds = ('所有文件 (*.*)',)
            picked = _window.create_file_dialog(
                webview.FileDialog.SAVE, save_filename=safe, file_types=kinds)
            if not picked:
                log('save_as 取消: %s' % safe)
                return ''
            path = picked[0] if isinstance(picked, (list, tuple)) else picked
            with open(path, 'w', encoding='utf-8', newline='') as fh:
                fh.write('' if text is None else str(text))
            log('save_as 写出 %s (%d 字符)' % (path, len('' if text is None else str(text))))
            return path
        except Exception as exc:
            log('save_as 失败: %r' % exc)
            return ''

    def open_external(self, url):
        """把外链交给系统浏览器，别在应用窗口里把页面顶掉。"""
        import webbrowser
        u = str(url or '')
        if not (u.startswith('http://') or u.startswith('https://')):
            return False
        try:
            webbrowser.open(u)
            return True
        except Exception as exc:
            log('open_external 失败 %s: %r' % (u, exc))
            return False


# ---------------------------------------------------------------- 自检

RESULT_FILE = os.path.join(log_dir(), 'selftest_result.txt')


def _run_selftest(window):
    """等页面把标题改成 SELFTEST-OK / SELFTEST-FAIL，把结果落盘。

    无头验收只有这一个办法：打包后的窗口读不到控制台，只能靠页面自己报告。
    """
    title = ''
    deadline = time.time() + SELFTEST_TIMEOUT
    while time.time() < deadline:
        try:
            title = window.evaluate_js('document.title') or ''
        except Exception as exc:
            title = ''
            log('selftest evaluate_js: %r' % exc)
        if str(title).startswith('SELFTEST-'):
            break
        time.sleep(0.5)
    lines = ['title=%s' % (title or 'NO-TITLE'),
             'html=%s' % find_html(),
             'frozen=%s' % getattr(sys, 'frozen', False),
             'python=%s' % sys.version.split()[0]]
    # 把暴露给页面的接口名字也报出来。打包最容易静默坏掉的就是这个：
    # js_api 没接上时页面照常跑，只是导出悄悄退回 blob 下载。
    try:
        api_keys = window.evaluate_js(
            'Object.keys((window.pywebview && window.pywebview.api) || {}).join(",")')
        lines.append('js_api=%s' % (api_keys or '(空)'))
    except Exception as exc:
        lines.append('js_api=ERROR %r' % exc)
    try:
        with open(RESULT_FILE, 'w', encoding='utf-8') as fh:
            fh.write('\n'.join(lines) + '\n')
    except OSError:
        pass
    log('selftest ' + lines[0])
    try:
        window.destroy()
    except Exception:
        pass


# ---------------------------------------------------------------- 启动

def main(argv):
    global _window, _webview
    selftest = '--selftest' in argv
    debug = '--debug' in argv or selftest

    try:
        import webview
    except Exception as exc:
        _webview = None
        _alert('缺少运行库',
               '应用需要的 pywebview 没有装上。\n\n%s' % exc)
        return 2
    _webview = webview

    page = find_html()
    if not page:
        _alert('找不到页面文件',
               '打包产物里没有 %s。\n\n查找过：%s'
               % (HTML_NAME, resource_dir()))
        return 3

    # 兜底：万一原生桥没接上，blob 下载至少也能弹出系统"另存为"
    webview.settings['ALLOW_DOWNLOADS'] = True

    import pathlib
    api = Api()
    _window = webview.create_window(
        APP_NAME,
        url=pathlib.Path(page).as_uri() + ('#selftest' if selftest else ''),
        width=START_SIZE[0], height=START_SIZE[1],
        min_size=MIN_SIZE,
        js_api=api,
        text_select=True,
    )

    try:
        if selftest:
            webview.start(_run_selftest, _window, debug=debug)
        else:
            webview.start(debug=debug)
    except Exception as exc:
        msg = str(exc)
        hint = ''
        if os.name == 'nt' and ('WebView2' in msg or 'webview2' in msg.lower()):
            hint = ('\n\n本机缺少 Microsoft Edge WebView2 运行时。'
                    'Windows 10/11 一般自带；若确实没有，到微软官网装一次'
                    '"WebView2 Runtime"即可（免费、约 2 MB）。')
        _alert('启动失败', msg + hint)
        return 4
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
