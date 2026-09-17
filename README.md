# dsh-lsp-bridge

Bridge DeepSeek Harness to language servers for read-only code intelligence, with multi-language configuration, multi-root workspace support, and session-scoped server reuse.

为 DeepSeek Harness 的 LLM 提供通用 LSP 查询工具 `lsp`。支持按语言配置多个 stdio 语言服务器、独立项目根目录和显式多根工作区，并在 Web 与 Desktop 的插件设置中提供自动发现和配置界面。Node.js ≥22，无安装期构建。

## 能力

| operation | 用途 | 额外必需参数 |
| --- | --- | --- |
| `status` | 查看配置的服务；不启动语言服务器 | 无 |
| `hover` | 类型与文档 | file、line、character |
| `definition` | 跳转定义 | file、line、character |
| `typeDefinition` | 类型定义 | file、line、character |
| `implementation` | 实现位置 | file、line、character |
| `references` | 引用，包含声明 | file、line、character |
| `documentSymbols` | 文档符号 | file |
| `workspaceSymbols` | 所选项目/多根工作区的符号 | query；建议显式 server、root |
| `diagnostics` | 单文件诊断，优先 pull，否则等待 push | file |

具体能力取决于服务器。输入 **line / character 从 1 开始，character 按 UTF-16 计数**；输出保留原始 LSP URI 与 **从 0 开始** 的 range。`server` 用于消除多个语言服务的匹配歧义；路径相对于当前会话工作目录，也可用其内部的绝对路径。

```json
{"operation":"definition","file":"qsl-game-server/main.go","line":20,"character":8,"server":"go"}
```

以上行列只是参数示例，应替换成目标符号的真实位置。

```json
{"operation":"workspaceSymbols","server":"go","root":"unityroomlib","query":"Router"}
```

输出值是 `{ "json": "...", "truncated": false }`，GUI/LLM 文本呈现为 json 内的内容。超长结果变为带 truncated 标记的预览，不可把预览视为完整结果。

## 安装：web 与 Desktop

本包是服务端 **Bundle 插件**：`package.json` 声明 `dsh.bundle.patch`，包根 `cordis.patch.yml` 通过包名挂载，不绑定个人路径或 profile。无需浏览器组件，也不需要编译。已核对 DSH 0.1.5-rc.2 / Desktop 2.0.10 的接口；其他版本需验证。

### web profile

已安装 DSH CLI，且 PATH 中可用 `pnpm` 时，在本插件目录执行：

```sh
dsh plugin --profile web add github:voidmind26/dsh-lsp-bridge
```

应使用已经初始化的 web profile；安装后重启原有 web 进程并刷新页面，不要另起替代服务器。卸载：`dsh plugin --profile web remove dsh-lsp-bridge`。

### Desktop profile（本机 macOS）

普通 DSH CLI 会拒绝保留的 `desktop` profile，应使用 Desktop 自带入口。下面的函数可操作 web 和 desktop，但请只选择你实际使用的 profile：

```sh
dsh_packaged() {
  ELECTRON_RUN_AS_NODE=1 '/Applications/DSH Desktop.app/Contents/MacOS/DSH Desktop' \
    --expose-internals '/Applications/DSH Desktop.app/Contents/Resources/app/lib/desktop-cli.js' "$@"
}
# 在本插件目录执行；需 PATH 中可用 pnpm。
dsh_packaged plugin --profile desktop add github:voidmind26/dsh-lsp-bridge
# 如果使用 Desktop 自带 CLI 管理 web：
# dsh_packaged plugin --profile web add .
```

该命令面向 Desktop 已创建的现有 profile；不要用它代替首次启动 Desktop 初始化。应用安装路径不同时调整命令。安装后重启 Desktop，再刷新原有 GUI。卸载：`dsh_packaged plugin --profile desktop remove dsh-lsp-bridge`。其他操作系统需使用其 Desktop 提供的 CLI 入口，此处不声明已验证。

### 配置与启用

1. Bundle 默认 `servers: []`，安装不会下载或启动语言服务器。先安装可信的语言服务器。
2. 将 `examples/cordis.patch.yml` 的 **`id: lsp` 配置覆盖**合入 `$DSH_HOME/profiles/web/cordis.patch.yml` 或 `$DSH_HOME/profiles/desktop/cordis.patch.yml` 的顶层数组。默认 `DSH_HOME=~/.dsh`。保留其他插件条目；`config` 是整体替换，不是深合并。
3. 根据需要填写 `servers`。GUI 的 PATH 可能与终端不同，必要时使用服务器命令绝对路径。JSON 示例不会自动读取，应把内容放入配置。
4. 如果以前手动添加过 `insert: ... id: lsp`，迁移时先移除该旧插入，仅保留 Bundle 提供的挂载及 profile 的配置覆盖，避免重复注册工具。
5. 在目标工程会话中使用 `danger-full-access`，先调用 `lsp` 的 `status`，再查询真实文件中的定义。卸载时同时移除 profile 中仅属于本插件的覆盖条目，并重启相应宿主。

`$DSH_HOME/cordis.patch.yml` 可覆盖 profile 层，排查配置时也要检查。仅修改 profile 配置可由宿主 patch 重载处理；源码和 Bundle 安装变更以重启宿主为准。

**验证范围：** 已有协议、生命周期、Bundle 结构及模拟宿主契约测试；尚未修改运行中的 profile，不能把这些测试视为真实 web/Desktop GUI 安装成功。分发与收录检查见 [分发说明](docs/distribution.md)。

## 设置 UI 与自动发现

安装并重新加载宿主后，进入「设置 → 插件 → 可配置」，打开 `dsh-lsp-bridge` 卡片：

1. 选择一个当前活动会话；列表中的目录是服务端会话记录，不接受浏览器提交任意扫描路径。
2. 点击“扫描当前工作区”。插件检查固定 catalog 中的 Go、Rust、TypeScript/JavaScript、Python 和 C/C++ 项目标记与服务器候选。
3. 查看可用候选、多候选提示及缺失服务器的安装建议。扫描不会执行候选、版本命令或安装命令，也不会修改工程文件。
4. 确认信任候选程序后，将建议合入配置编辑器；多候选需要明确选择。可以继续编辑完整 JSON。
5. 点击保存后，Host 再次校验配置并热替换服务池；保存本身不会启动服务器，下一次语义查询才懒启动。

UI 与 Web/Desktop 共用同一 `platform: web` 客户端 Bundle。自动发现有扫描深度、目录/项目数和时间限制；若结果被截断，界面会明确提示，不能把它当成完整枚举。内置 catalog 以外的语言仍可手工配置。

缺失时只给出命令文本或安装说明，插件不会代替用户运行 `go install`、`npm install`、`rustup`、Homebrew 或系统包管理器。当前发现接口与语言服务器启动一样要求目标会话为 `danger-full-access`，不会自动提权。

## 通用配置

见 `examples/generic.config.json`（Go、Python、TypeScript/JavaScript）及 `examples/uos.config.json`（uos 独立 Go module 与前端工程）。支持任何兼容 stdio LSP 的服务器，**不代表插件自动下载服务器或配置其语言 SDK**。

| 字段 | 说明 |
| --- | --- |
| `servers[].id` | 唯一服务标识 |
| `command` / `args` | 可信程序与参数，不通过 shell 执行 |
| `env` | 在进程环境上覆盖的字符串环境变量；勿提交凭据 |
| `languages` | LSP languageId 到扩展名数组，如 `{"go":[".go"]}` |
| `rootMarkers` | 向工作区边界逐级查找最近项目标记；找不到则使用会话根目录 |
| `roots` | 显式项目根目录列表，按覆盖文件的最深目录选择 |
| `workspaceFolders` | 显式发送给服务器的多根目录；相对路径以会话工作目录解析 |
| `initializationOptions` | 原样传给 initialize |
| `settings` | didChangeConfiguration 配置与 workspace/configuration 查询的数据源 |
| `timeoutMs` | 单次协议请求超时，默认 15000，最高 300000 毫秒 |
| `maxInstances` | 单个引擎最多实例数，默认 8，最高 128 |
| `idleTimeoutMs` | 会话引擎空闲回收时间，默认 300000 毫秒 |
| `maxSessions` | 常驻会话引擎数量上限，默认 4 |
| `maxFileBytes` | 文件读取上限，插件默认 1 MiB，最高 8 MiB |
| `maxOutputChars` | 工具 JSON 输出字符上限，默认 30000，最小 256 |

### 多目录语义

- `uos` 不是单个 Go module。默认配置使用最近 `go.mod` 定位各项目，避免从顶层直接启动 gopls 导致找不到 module。
- `roots` 不会把独立工程合并成一个工程。只有显式配置 `workspaceFolders` 才将多个目录传给服务，例如 `"workspaceFolders": ["qsl-game-server", "unityroomlib"]`。
- 多根并不自动修复依赖：跨仓定义是否定位到本地共享库仍取决于 go.work / replace、tsconfig project references 等。插件不自动改写这些文件，也不保证每个服务器支持多根。
- 显式 roots 中的目录必须存在；如果仅检出部分 uos 仓库，删去缺失目录或使用通用 rootMarkers 示例。
- 工作区符号只查询选中的一个实例，不自动聚合所有语言和所有项目；明确传入 server + root。
- Vue SFC、Java、C# 等需要对应服务器及其初始化配置。示例中的 TypeScript 服务不等于完整 Vue `.vue` 支持。

## 安全与生命周期

**只暴露只读 LSP 操作，不意味着语言服务器进程被沙箱隔离。** 语言服务器本质上是本地可执行程序，可能读取依赖、写缓存、加载插件或运行工具链。仅配置你信任的程序和项目。

- 当前适配层每次调用检查会话有效 sandbox policy，仅允许 `danger-full-access`；受限会话直接拒绝，不自动提权或修改设置。
- 模型无法通过工具指定 command/env，不能发送任意 LSP method 或执行 WorkspaceEdit。
- 文件与根目录经 realpath 工作区检查，拒绝路径穿越与符号链接逃逸。但这不限制服务器自行读取依赖，也不是对抗并发文件替换攻击的 OS 沙箱。
- **按会话与工作目录常驻复用引擎**，同一语言、项目根目录的后续调用复用语言服务器，避免重复初始化；不同会话隔离。`status.instances` 可查看当前会话已启动的实例。
- 空闲超过 `idleTimeoutMs`（默认 5 分钟）回收会话引擎；活动请求不因空闲超时被回收。`maxSessions`（默认 4）限制会话池容量，`maxInstances` 限制每个引擎的服务器实例数。
- 监听 DSH 的 `session/event` 权限变更及 `session/disposed` 释放事件。权限收紧时取消相关请求、关闭服务；插件卸载关闭所有服务。每次调用仍检查有效权限，并每秒复查常驻会话权限以覆盖缺少专用事件的默认策略变化。该复查不是操作系统级即时权限撤销。
- 关闭一个 GUI 标签页不一定等于 DSH 释放会话；未收到释放事件时，由空闲超时负责回收。
- 超时针对各协议请求，不是整个索引任务的总时限。支持调用取消与插件卸载清理。
- 推送型诊断超时未收到时表示“尚无诊断结果”，不应解读为代码无错误。仅同步当前请求文档的磁盘内容，不提供编辑器未保存 buffer 或文件系统全局监听。

## 开发与验证

```sh
npm run build:client
npm run check
npm test
# 可选真实 Go LSP 集成验证，仅在临时 Go module 内运行：
LSP_TEST_GOPLS=/Users/voidmind/go/bin/gopls npm test
```

测试覆盖模拟 stdio 分帧、多根与独立项目路由、UTF-16 参数、磁盘内容同步、符号/诊断、路径边界、超时、进程退出、配置与权限门控。真实 gopls 测试默认跳过，设置环境变量才执行。没有为此运行 uos 业务服务或修改其中代码。

实现入口：`src/index.js`（DSH 适配）、`src/pool.js`（会话常驻池与生命周期）、`src/engine.js`（路由与 LSP 会话）、`src/transport.js`（JSON-RPC stdio）；设计见 `docs/design.md`。

常驻相关测试额外覆盖跨调用 PID 一致、不同会话隔离、文件同步、权限事件与周期复查回收、会话释放、插件卸载、空闲回收及满载保护。
