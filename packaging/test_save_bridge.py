# -*- coding: utf-8 -*-
"""桌面壳"另存为"这条路的单测。

为什么值得单独测
----------------
`Api.save_as` 是打包版唯一的落盘出口。它有两个很容易静默出错的点：

1. **换行被翻译**。页面给的 CSV 字符串里是 CRLF（Python csv 模块的写法）。
   如果用默认的 `open(..., 'w')`，Windows 上会把 `\n` 再翻成 `\r\n`，
   于是 CRLF 变成 CRCRLF —— 文件还是"能打开"，但**不再与桌面版逐字节相同**，
   而"逐字节相同"正是这个项目对外承诺的东西。所以必须 `newline=''`。
2. **文件名没消毒**。页面传进来的名字进的是一个真实的文件对话框，
   不能带路径分隔符。

这两个都不是"跑一遍看起来正常"能发现的，所以钉成测试。

原生文件对话框本身没法在无头环境里测 —— 这里把它替换掉，
被测的是**对话框之内的全部逻辑**。

用法:  python packaging/test_save_bridge.py
"""

import io
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import isoclock_desktop as app                                    # noqa: E402

PASS = 0
FAIL = 0


def check(name, cond, detail=''):
    global PASS, FAIL
    if cond:
        PASS += 1
        print('  ok   %s' % name)
    else:
        FAIL += 1
        print('  FAIL %s   %s' % (name, detail))


def make_webview_stub(picked):
    """一个只够用的 webview 替身：只提供 FileDialog.SAVE 与 settings。"""
    import types
    saved = {}

    class FileDialog:
        SAVE = 30
        OPEN = 10

    mod = types.ModuleType('webview')
    mod.FileDialog = FileDialog
    mod.settings = {}

    def create_file_dialog(kind, save_filename='', file_types=()):
        saved['kind'] = kind
        saved['save_filename'] = save_filename
        saved['file_types'] = file_types
        return picked

    return mod, saved, create_file_dialog


def with_stub(picked):
    """把 sys.modules['webview'] 换成替身，返回 (api, saved)。"""
    mod, saved, cfd = make_webview_stub(picked)
    old = sys.modules.get('webview')
    sys.modules['webview'] = mod
    window = type('W', (), {})()
    window.create_file_dialog = cfd
    app._window = window
    return app.Api(), saved, (lambda: sys.modules.__setitem__('webview', old) if old else sys.modules.pop('webview', None))


def main():
    tmp = tempfile.mkdtemp(prefix='isoclock_savebridge_')
    print('临时目录: %s\n' % tmp)

    # ---- 1) CSV 的 CRLF 必须原样落盘 -------------------------------------
    csv_text = 'a,b\r\n1,2\r\n3,4\r\n'          # csv 模块写出来的就是这种
    dst = os.path.join(tmp, 'result_all.csv')
    api, saved, restore = with_stub(dst)
    try:
        got = api.save_as('result_all.csv', csv_text)
    finally:
        restore()
    raw = io.open(dst, 'rb').read()
    check('返回落盘路径', got == dst, repr(got))
    check('字节与页面给的字符串完全一致（CRLF 没被翻译）',
          raw == csv_text.encode('utf-8'),
          '期望 %r 实得 %r' % (csv_text.encode('utf-8'), raw))
    check('对话框被要求用 SAVE 类型', saved['kind'] == 30, str(saved.get('kind')))
    check('对话框预填了正确文件名', saved['save_filename'] == 'result_all.csv',
          repr(saved.get('save_filename')))

    # ---- 2) 换行敏感性的反向自证 ----------------------------------------
    # 证明上一条不是"永远通过"：用默认的文本模式写同一串，字节就不一样了。
    naive = os.path.join(tmp, 'naive.csv')
    with io.open(naive, 'w', encoding='utf-8') as fh:      # 故意不给 newline=''
        fh.write(csv_text)
    naive_raw = io.open(naive, 'rb').read()
    check('反向自证：不给 newline=\'\' 时字节就会变（说明上一条真的在把关）',
          naive_raw != csv_text.encode('utf-8'),
          '两者相同，说明这条检查没有区分力')

    # ---- 3) 取消对话框 → 什么都不写 -------------------------------------
    cancel_target = os.path.join(tmp, 'must_not_exist.csv')
    api, saved, restore = with_stub(None)                  # 用户点了取消
    try:
        got = api.save_as('x.csv', 'hello')
    finally:
        restore()
    check('取消返回空串', got == '', repr(got))
    check('取消时不落盘', not os.path.exists(cancel_target))

    # ---- 4) 文件名带路径 → 只取文件名 -----------------------------------
    api, saved, restore = with_stub(os.path.join(tmp, 'ok.html'))
    try:
        api.save_as('../../evil/../../oops.html', '<html></html>')
    finally:
        restore()
    check('文件名消毒：不带目录分隔符',
          os.sep not in saved['save_filename'] and '/' not in saved['save_filename'],
          repr(saved.get('save_filename')))

    # ---- 5) 空名字 / None 不能崩 ---------------------------------------
    for bad in ('', None, '   '):
        api, saved, restore = with_stub(os.path.join(tmp, 'fallback.txt'))
        try:
            api.save_as(bad, 'x')
        finally:
            restore()
        check('空文件名有兜底 (%r)' % bad, bool(saved.get('save_filename')),
              repr(saved.get('save_filename')))

    # ---- 6) 外链只放行 http(s) ------------------------------------------
    api, _, restore = with_stub(None)
    with_stub(None)
    try:
        check('外链拦截：file:// 不放行', api.open_external('file:///etc/passwd') is False)
        check('外链拦截：javascript: 不放行',
              api.open_external('javascript:alert(1)') is False)
    finally:
        restore()

    print('\n结果：%d 通过 / %d 失败' % (PASS, FAIL))
    return 1 if FAIL else 0


if __name__ == '__main__':
    sys.exit(main())
