# dsh-lsp-bridge

Bridge DeepSeek Harness to language servers for code intelligence — read-only queries plus permission-gated rewrites — with model-driven installation and configuration, multi-language discovery, multi-root workspaces, and session-scoped server reuse.

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

### 模型自动安装与配置（推荐）

插件向模型提供 `lsp_setup` 工具，因此**不需要人工扫描或手写配置**。典型流程是让智能体执行一次 `lsp_setup`：

| operation | 行为 | 是否执行程序 |
| --- | --- | --- |
| `status` | 诊断项目与服务器，报告缺什么、可用的安装方案 | 否 |
| `install` | 执行 catalog 允许列表内的安装命令（需 `apply=true`） | 是 |
| `configure` | 把可用服务器写入插件配置 | 否 |
| `verify` | 真实启动服务器完成 `initialize`，报告能力与错误 | 是 |
| `auto` | 串起以上全部步骤（安装需 `apply=true`） | 取决于 `apply` |

它会诊断“服务器存在但运行组件缺失”这类问题。例如只有 `typescript-language-server` 而没有 TypeScript SDK 时，`status` 会给出 `missing-dependency` 与原因，而不是谎报可用；`auto + apply=true` 会把 `typescript@5` 与语言服务器一起装进插件私有目录，并把 `initializationOptions.tsserver.path` 一并写入配置。

安全边界：

- 安装命令完全来自冻结的 `src/catalog.js`，模型只能选择服务器 ID，**不能提供命令、参数、包名或安装路径**。
- 不使用 shell、不使用 `sudo`；每条命令都会出现在工具调用结果中。
- 只有 `install`/`auto` 且显式 `apply=true` 才会执行安装；`status` 与 `verify` 从不安装。
- 安装目录默认 `$DSH_HOME/lsp-bridge`（本机 `~/.dsh/lsp-bridge`），不修改业务工程；可用 `install.directory` 调整，`install.enabled=false` 可整体禁用，`install.managers` 可为某种安装方式指定绝对路径。
- 每次调用都要求目标会话为 `danger-full-access`，绝不自动提权。C/C++ 的 clangd 没有可移植安装方案，只给出人工安装建议。

### 配置与启用

1. Bundle 默认 `servers: []`；安装插件本身不会下载或启动任何语言服务器。推荐直接让智能体执行 `lsp_setup`（见上一节）自动完成，或手工配置。
2. 手工配置时，将 `examples/cordis.patch.yml` 的 **`id: lsp` 配置覆盖**合入 `$DSH_HOME/profiles/web/cordis.patch.yml` 或 `$DSH_HOME/profiles/desktop/cordis.patch.yml` 的顶层数组。默认 `DSH_HOME=~/.dsh`。保留其他插件条目；`config` 是整体替换，不是深合并。
3. 根据需要填写 `servers`。GUI 的 PATH 可能与终端不同，必要时使用服务器命令绝对路径。JSON 示例不会自动读取，应把内容放入配置。
4. 如果以前手动添加过 `insert: ... id: lsp`，迁移时先移除该旧插入，仅保留 Bundle 提供的挂载及 profile 的配置覆盖，避免重复注册工具。
5. 在目标工程会话中使用 `danger-full-access`，先调用 `lsp` 的 `status`，再查询真实文件中的定义。卸载时同时移除 profile 中仅属于本插件的覆盖条目，并重启相应宿主。

`$DSH_HOME/cordis.patch.yml` 可覆盖 profile 层，排查配置时也要检查。仅修改 profile 配置可由宿主 patch 重载处理；源码和 Bundle 安装变更以重启宿主为准。

**验证范围：** 已有协议、生命周期、Bundle 结构及模拟宿主契约测试；尚未修改运行中的 profile，不能把这些测试视为真实 web/Desktop GUI 安装成功。分发与收录检查见 [分发说明](docs/distribution.md)。

## 设置 UI 与自动发现

安装并完整重启 Desktop（或重新启动 Web 宿主）后，进入「设置 → LSP」独立页面。页面分成两个视图：

**服务器列表（默认）**：只显示当前已配置的每个语言服务器。页面会自动做一次只读诊断，并对齐备的服务器做一次短暂启动验证（`initialize` 后立即关闭），因此每张卡片同时标注**配置状态**（可用 / 缺少运行组件 / 未安装 / 未扫描）与**验证状态**（验证通过 / 验证失败 / 未验证）。点击卡片展开查看该服务器的程序路径、启动参数、语言、项目/工作区目录、初始化选项、验证到的能力或失败原因，以及完整配置；也可用「重新扫描并验证」手动刷新，或一键进入 JSON 编辑。

**语言服务器属于项目目录，不属于会话。** 每台服务器的评估目标由它自己的 `roots`/`workspaceFolders` 决定；没有配置根目录时才回落到当前会话的工作区。因此一台配置在别的工程下的服务器（例如 gopls 指向另一个仓库）同样会得到状态与真实验证，不需要切换到那个项目的会话。卡片里会标注「评估目录：…（来自配置的项目根目录）」。

会话只承担两件事：**授权**（能否启动可信程序）与**未声明根目录时的默认目录**；代码查询（读取工作区文件）仍以会话工作区为边界。

**新增配置（右上角「＋ 新增配置」）**：独立的扫描与编辑视图，完成后点「← 返回服务器列表」。

1. 在新增配置视图中选择一个当前活动会话；列表中的目录是服务端会话记录，不接受浏览器提交任意扫描路径。
2. 点击“扫描当前工作区”。插件检查固定 catalog 中的 Go、Rust、TypeScript/JavaScript、Python 和 C/C++ 项目标记与服务器候选，并同时诊断运行组件是否齐备。
3. 查看候选卡片：可用、待选择、未安装、**缺少运行组件**；缺组件时会显示具体原因与将执行的安装命令。扫描不会执行候选、版本命令或安装命令，也不会修改工程文件。
4. 审阅候选卡片并将可用建议加入配置草稿；多候选需要明确选择。查看服务器摘要，需要手动调整时展开“高级配置”编辑完整 JSON。加入草稿不等于保存。
5. 核对草稿后点击“保存配置”。Host 再次校验配置并热替换服务池；保存本身不会启动服务器，下一次语义查询才懒启动。保存不需要额外的信任勾选，但请只配置可信的程序路径与参数。

UI 与 Web/Desktop 共用同一 `platform: web` 客户端 Bundle。自动发现有扫描深度、目录/项目数和时间限制；若结果被截断，界面会明确提示，不能把它当成完整枚举。内置 catalog 以外的语言仍可手工配置。

**扫描与安装是两件事：** 扫描只读、永不安装；安装只发生在智能体显式执行 `lsp_setup` 的 `install`/`auto`（且 `apply=true`）时，命令限于 catalog 允许列表，界面上会展示将要执行的确切命令。缺失且无可移植方案时只给出人工安装建议（例如 clangd）。发现接口只读，任何权限的会话都可以调用；不会自动提权。

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
| `sandbox.redirectCaches` | 受限会话中是否把服务器缓存变量重定向到可写临时目录，默认 true |
| `sandbox.cacheDirectory` | 缓存重定向目标，默认 `os.tmpdir()/dsh-lsp-bridge`，必须为绝对路径 |

### 多目录语义

- `uos` 不是单个 Go module。默认配置使用最近 `go.mod` 定位各项目，避免从顶层直接启动 gopls 导致找不到 module。
- `roots` 不会把独立工程合并成一个工程。只有显式配置 `workspaceFolders` 才将多个目录传给服务，例如 `"workspaceFolders": ["qsl-game-server", "unityroomlib"]`。
- 多根并不自动修复依赖：跨仓定义是否定位到本地共享库仍取决于 go.work / replace、tsconfig project references 等。插件不自动改写这些文件，也不保证每个服务器支持多根。
- 显式 roots 中的目录必须存在；如果仅检出部分 uos 仓库，删去缺失目录或使用通用 rootMarkers 示例。
- 工作区符号只查询选中的一个实例，不自动聚合所有语言和所有项目；明确传入 server + root。
- Vue SFC、Java、C# 等需要对应服务器及其初始化配置。示例中的 TypeScript 服务不等于完整 Vue `.vue` 支持。

## 模型上下文与服务器选择

插件会向模型注入一段很短的上下文，说明当前会话工作区里配置了哪些语言服务器（名称、语言、最近一次扫描/验证结论），并提示优先用 `lsp` 做代码导航、缺组件时用 `lsp_setup`。该片段在每次装配时**同步**生成，只读内存中的配置与最近一次诊断缓存，不做扫描也不启动进程；没有配置服务器时不注入，缓存 10 分钟过期，最多列出 6 个。

`workspaceSymbols` 没有文件可推断语言，因此插件会先按“是否覆盖当前工作区”自动选择服务器，只有多个服务器都覆盖时才要求显式传 `server`。指定 `server` 时始终按指定服务器查询。

冷启动时插件会先做一次**有界预热**：在服务器项目根目录内（深度 ≤ 2、最多 200 个目录项、最多 24 个语言匹配文件，跳过依赖/构建目录与符号链接）打开匹配文件，让服务器建立项目。这解决了 TypeScript 上 `workspace/symbol` 报 `No Project.` 或返回空结果的问题。预热只在实例还没有任何已打开文档时执行，代价一次。

## 安全与生命周期

**语言服务器本质上是本地可执行程序**，可能读取依赖、写缓存、加载插件或运行工具链。仅配置你信任的程序和项目。

写入能力（`rename`、`format`，以及服务器主动发起的 `workspace/applyEdit`）默认是**先预览后写入**：不带 `apply: true` 只返回将要改动的内容，`apply: true` 才落盘。写入始终限制在会话工作区内，并按会话权限判定：

| 会话权限 | 写入行为 |
| --- | --- |
| `danger-full-access` | 允许（仍限定在工作区内），服务器进程不被沙箱包装 |
| `workspace-write` | 允许工作区内的文件；服务器进程同时被会话沙箱约束 |
| `read-only` | 拒绝，并明确提示**需要完全访问权限（danger-full-access）** |

被沙箱或权限挡住时不会静默失败：只读会话、工作区外目标、非文本编辑（创建/重命名/删除文件）都会给出具体原因。

- **权限模型**：语言服务器进程按会话权限处理，且不会因为插件而放宽。
  - `danger-full-access`：按用户授权直接启动（服务器是未被 OS 沙箱隔离的可信程序）。
  - `workspace-write` / `read-only`：服务器 argv 先交给 DSH 沙箱服务（`ctx.sandbox.confine`，macOS 为 seatbelt）包装，因此它只能写会话工作区、`/tmp` 与用户临时目录；插件会把 `GOCACHE`、`GOTMPDIR`、`XDG_CACHE_HOME` 重定向到临时目录（可用 `sandbox.redirectCaches=false` 关闭，或 `sandbox.cacheDirectory` 指定绝对路径）。
  - 部署没有可用沙箱后端时**失败关闭**：绝不退化成无沙箱启动，也不自动提权。`read-only` 会话下沙箱不允许任何写入，部分服务器可能因此启动失败，错误会说明原因。
  - 扫描（只读诊断）在任何权限下都可用；`lsp_setup` 的 `status`/`configure`/`verify` 在受限会话可用，只有真正执行安装命令的步骤要求 `danger-full-access`（安装器在插件内直接执行、不经过会话沙箱）。
- 模型无法通过工具指定 command/env，也不能发送任意 LSP method；写入只能通过 `rename`/`format` 或服务器发起的 `applyEdit`，并受上面的权限与工作区边界约束。
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

测试按主题组织，**同一主题的断言合并在一个用例里**（当前 42 个用例，覆盖模拟 stdio 分帧、多根与独立项目路由、UTF-16 参数、磁盘内容同步、符号/诊断、路径与符号链接边界、扫描限制与 PATH 处理、配置与权限门控、会话常驻与回收、安装/配置/验证流程、客户端契约与双视图）。新增覆盖请并入对应主题的现有用例，不要为同一行为再开一个用例。真实 gopls 测试默认跳过，设置 `LSP_TEST_GOPLS` 才执行。没有为此运行 uos 业务服务或修改其中代码。

实现入口：`src/index.js`（DSH 适配）、`src/pool.js`（会话常驻池与生命周期）、`src/engine.js`（路由与 LSP 会话）、`src/transport.js`（JSON-RPC stdio）；设计见 `docs/design.md`。

常驻相关测试额外覆盖跨调用 PID 一致、不同会话隔离、文件同步、权限事件与周期复查回收、会话释放、插件卸载、空闲回收及满载保护。
