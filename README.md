# dsh-file-handover（递文件）

**把一个本地文件交给系统"打开文件"对话框** —— 网页上传、微信发文件、Photoshop 打开，
凡是"点一下、再在对话框里选文件"的地方，都由它代劳。

> 由来：AI 会点按钮、会打字，但**不会在文件选择器里选文件** —— 这是 GUI 自动化的最后一块空白。
> 我是在给自己做"发抖音"的时候撞上它的：投稿页的上传按钮点得响，弹出的系统对话框却进不去。

---

## 它做什么（五步，每步都回读）

| 步 | 动作 | 为什么要这样 |
| --- | --- | --- |
| ① 等 | 轮询等 `#32770` 文件对话框出现（默认 30 秒） | 实测从点击到弹窗**可以超过 15 秒**，抢跑只会拿到空 |
| ② 认 | 在候选窗口里找**带文件名控件**（automation id `1148`）的那个 | 只认结构、不认标题 —— 跨语言，也绕开 `.ps1` 编码坑 |
| ③ 填 | **剪贴板粘贴**（全选 → 清空 → 粘贴）；另有 Win32 `SetWindowText` 与 UIA `ValuePattern` 两条备用路 | 打字不可信：这台机器的**中文输入法**会把打进去的 `\` `:` 变成全角标点和候选词（实测读回 `谢谢D：、但是、workspace、…`），剪贴板不过 IME |
| ④ 校 | **读回来逐字比对**，不一致就再来一轮（默认 3 轮） | 实测第 1、2 轮读回都是脏的，**第 3 轮才一致** —— 单次尝试真的不可信 |
| ⑤ 确认 | 按控件 id 找按钮（`1`=打开/保存、`2`=取消）并点击 | 盲发 Enter 不可靠，也挡不住输入法 |

**失败会带现场**：它把"看到过的每个候选窗口"和"每次尝试读回的实际值"一起返回，
所以排错不用猜。

## 安全边界

- **目标必须显式**：要交付的文件（`path`）必须是**绝对路径**；它**不会**自己去找"最像的对话框"。
- **默认不按标题过滤**：标题随语言/版本变化，是脆弱信号；要过滤就用 `expectTitle` 显式给。
- **不动手也能看**：`dryRun` 只探测（找对话框、报结构），不填不点。
- **只点它自己的对话框**：确认按钮只在①选中的那个对话框内部查找。

## 安装

市场收录后在 DSH 里搜 `dsh-file-handover` 安装。手动安装：

```powershell
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-file-handover" -Target "D:\dsh\projects\dsh-file-handover"
# profile 的 package.json：dependencies 加 "dsh-file-handover": "link:D:/dsh/projects/dsh-file-handover"
# 并把 "dsh-file-handover" 加进 dsh.profile.bundles（漏了不加载）→ 重启 DSH
```

## 用法

### 工具

```
handover_file  path=<绝对路径>                        # 单个文件
handover_file  paths=[<绝对路径>, <绝对路径>, ...]      # 多选（v0.2.0，最多 12 个）
handover_file  path=... [timeoutSec] [dryRun] [expectTitle] [maxAttempts] [click]
```

**多选**（v0.2.0）：对话框支持多选时（网页的多图上传、微信发多个文件、系统"打开"框），
给 `paths` 数组即可。插件把路径按 `"a" "b" "c"` 的格式填进去，**逐个回读**——
少一个就算失败，不会出现"以为交了三个、实际只进了一个"。

典型配合（以网页上传为例）：

1. 用浏览器工具**真实点击**页面的"上传/选择文件"按钮（程序化 `input.click()` 不会弹出系统对话框）；
2. 调 `handover_file` 递文件（单个用 `path`，多个用 `paths`）；
3. 用浏览器工具**回读页面**，确认它真的收到了那些文件（名字/字节数）。

### 命令

```powershell
dsh-file-handover handover --path "D:\videos\a.mp4"
dsh-file-handover probe    --path "D:\videos\a.mp4"
dsh-file-handover handover --path "D:\a.mp4" --expect-title "Open" --no-click
```

退出码：`0` 已交付 / `1` 未完成 / `2` 用法错误。

## 它怎么实现的

宿主侧（Node）只做编排：校验参数、检查文件、起一个 **PowerShell** 子进程、解析它返回的 JSON。
真正碰 GUI 的是包内的 `lib/handover.ps1`（`UIAutomationClient` + `EnumWindows`）。

两个刻意的选择：

- **用 PowerShell 而不是原生模块**：Node 没有内置 Win32/UIA 绑定，而原生模块（ffi/winax）
  不能塞进一个纯 JS 插件。PowerShell 是 Windows 上唯一"零依赖"就能调 UIA 的通道。
- **脚本全 ASCII**：`.ps1` 若为无 BOM 的 UTF-8，Windows PowerShell 会按 GBK 读，
  脚本里的中文会变乱码、**所有按标题匹配的逻辑会静默失效**（实测：`打开` → `鎵撳紑`）。
  自测里有一条硬断言守着这个文件必须全 ASCII。

## 一次真实的实测记录（为什么上面那些边界长这样）

在一张真实的网页上传页上递一个 1MB 文件，这台机器上实际发生的事：

1. **第 1 轮**填完读回：
   `谢谢D：、但是、workspace、——test、upload-payload。斌谢谢D：D:\dsh\workspace\_test\upload-payload.bin`
   —— 中文输入法把打进去的字符变成了候选词和全角标点，而"全选"没生效，内容还在往后追加。
2. **第 2 轮**：`谢谢D：、但D:\dsh\workspace\_test\upload-payload.bin` —— 清空只生效了一半。
3. **第 3 轮**：✅ 逐字一致 → 才点确认 → 页面确认收到 `upload-payload.bin:1000000`。

所以这三件事不是设计洁癖，是被逼出来的：**③ 走剪贴板**（绕开输入法）、**④ 必须回读**（一次永远不算数）、
**⑤ 只认控件 id**（标题随语言变，认不起）。

## 0.1.2：两处"看起来成功"的修正（2026-10-17 真机事故）

1. **文件名框少走了一级**：现代文件对话框的结构是
   `dialog > ComboBoxEx32 > ComboBox > Edit`，而旧代码只找了 `ComboBoxEx32 > Edit`，
   于是 `FindFileEdit` 返回 0 —— **整条 win32 路径被静默跳过**，直接掉到"猜焦点"的剪贴板路径。
2. **回读不到就点确认**：剪贴板路径读不回文件名时，旧代码仍把这次填充算作"已填"并点了确认。
   真机后果：粘贴其实落在了**地址栏**（对话框跳到了目标文件夹），确认后对话框关了、**页面一个文件也没收到**，
   而工具回执写的是"成功"。现在：**回读不到 = 失败**，不点确认，把对话框留着让人看。

## 已知限制

- **仅 Windows**：依赖 `EnumWindows` / UI Automation / `powershell.exe`。
- **只认系统原生文件对话框**（窗口类 `#32770`）：应用自己画的（自绘）选择器不适用。
- **冷启动有开销**：每次调用会起一个 PowerShell 进程（数百毫秒到两秒）。
- **它不负责"触发"**：打开对话框的那一下（点按钮、快捷键、菜单）要由调用方先做 ——
  这样"目标显式"才守得住。

## 自测

```powershell
node test/smoke.mjs   # 不碰真实 GUI：PowerShell 用假 spawn 顶替；含干活脚本的静态检查
```

## License

MIT
