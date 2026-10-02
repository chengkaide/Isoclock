# packaging —— 把网页版包成桌面程序

把 `webgui/isoclock.html` 包成**双击就能用的桌面程序**：Windows 出 `.exe`，
macOS 出 `.app`。

## 为什么包的是网页版，不是原来的 Tkinter 程序

网页版本身是**单文件、零依赖**的，双击任意浏览器就能用 —— 那已经是最省事的
跨平台形态了。壳只补三件浏览器给不了的事：

1. 一个真正的应用窗口（标题栏、图标，没有地址栏和标签页）
2. 导出走**系统原生"另存为"**。WebView2 给 blob 下载的默认文件名是一串 GUID、
   没有扩展名，用户拿到 `a1b2c3d4` 这样的文件还得自己改名
3. macOS 上是一个标准 `.app`，可以拖进"应用程序"、能从访达双击

**界面一行没改。** 壳把同一个 `isoclock.html` 装进系统自带的 WebView
（Windows 用 WebView2，macOS 用 WKWebView）。所有计算都在页面里的 JS 完成，
壳不碰任何数值，也不写任何中间文件（只有一个用来排错的日志）。

顺带解决了跨平台：原来的 Tkinter 版要带 matplotlib / pandas / scipy，
打包出来几百 MB；这个壳 **9.4 MB**，两个平台同一份代码。

## 构建

```bash
pip install pywebview pyinstaller pillow

python packaging/build_app.py --verify     # 出产物并真跑一次自检
```

> `pillow` 不只是 `make_icon.py` 要：**macOS 上 PyInstaller 要用它把 PNG 转成
> `.icns`**，缺了会在 BUNDLE 阶段直接失败（`ValueError: ... only ('icns',)
> images may be used as icons`）。

| 平台 | 产物 |
|---|---|
| Windows | `dist/IsoclockWeb.exe`（9.4 MB，单文件） |
| macOS | `dist/IsoclockWeb.app` |
|  | `dist/isoclock-web-<版本>-<平台>.zip`（附带的 zip，方便传） |

常用开关：

| 开关 | 作用 |
|---|---|
| `--verify` | 把产物**真的启动一次**，跑页面内自检并读结果。**PyInstaller 最容易坏的地方是"东西没进去"，静态检查看不出来** |
| `--no-build` | 不重建 `webgui/isoclock.html`（默认会重建，保证打进去的是最新的） |
| `--onedir` | Windows 出目录版（启动快，但要发整个文件夹） |
| `--keep-build` | 保留 `build/` 中间目录 |

### macOS 必须在 macOS 上构建

**PyInstaller 不能交叉编译。** Windows 的 `.exe` 只能在 Windows 上构建，
macOS 的 `.app` 只能在 macOS 上构建。本地只有一台 Windows 时，苹果那份交给 CI：

```bash
gh workflow run build-desktop        # 或到 Actions 页手动点 Run workflow
```

`.github/workflows/release.yml` 会在这三台机器上各出一份：

| runner | 产物 | 备注 |
|---|---|---|
| `windows-latest` | `IsoclockWeb.exe` | |
| `macos-latest` | `IsoclockWeb.app` | Apple Silicon (arm64) |
| `macos-13` | `IsoclockWeb.app` | Intel (x64)。这台已被标记弃用，标成"可失败"，挂了不影响发布 |

推一个 `v*` 标签会顺带建 Release 并把三份产物挂上去。

### macOS 首次打开

产物是 **ad-hoc 签名**（`codesign -s -`）。这在 Apple Silicon 上是必须的 ——
arm64 的可执行文件没有签名内核直接拒绝执行。但它**不是开发者签名**，所以从网上
下来的包 Gatekeeper 会拦一次。三个办法，任选：

1. 右键点图标 → **打开** → 再点"打开"（只需一次）
2. 系统设置 → 隐私与安全性 → 拉到下面点"仍要打开"
3. 命令行去掉隔离标记：`xattr -dr com.apple.quarantine IsoclockWeb.app`

## 改名字

产品名只在一个地方定义 —— `packaging/isoclock_desktop.py` 顶部的：

```python
APP_NAME = 'Isoclock 网页版'
APP_TAG  = 'isoclock-web'
```

改这两行，窗口标题、错误弹窗、macOS 的 `CFBundleDisplayName`、zip 文件名
会一起跟着变。（可执行文件名由 `build_app.py` 的 `OUT_NAME` 控制，为跨平台
稳妥起见保持 ASCII。）

## 文件

| 文件 | 作用 |
|---|---|
| `isoclock_desktop.py` | 壳本体。含 `--selftest`（给产物做自动化验收）与 `--debug` |
| `build_app.py` | 跨平台构建 + `--verify` 验收 |
| `make_icon.py` | 生成图标：协和线上三个点，坐标用真实衰变常数画 |
| `test_save_bridge.py` | 落盘路径的 13 项单测 |

## 已知限制

- **Element 的 `.fin`** 是专有二进制，网页版读不了（原桌面版也要先转换）。
- 网页版的**加权平均、MSWD、质量报告里那些阈值**都是新增的，不是原程序的结论；
  报告里写明了这一点。
- CI 上的 `--verify` 会真的开一个 GUI 窗口。如果哪天 GitHub 的 runner 不再提供
  可用的图形会话，这一步会失败 —— 那时把 `release.yml` 里的 `--verify` 去掉即可，
  但**本地构建时请保留它**。
