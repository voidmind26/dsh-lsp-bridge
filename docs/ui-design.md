# 设置 UI 与自动发现设计

## 目标与范围

Web 和 Desktop 共用一个客户端插件。在「设置 → 插件 → 可配置」提供 `dsh-lsp-bridge` 卡片：选择活动会话、扫描语言服务器和项目标记、审阅候选与安装建议、编辑配置并显式保存。缺失服务器只展示安装建议，不执行安装命令。

## 宿主契约

- Bundle 保留服务端入口，新增 `exports["./client"]` 与 `dsh.client.platform: web`。
- 浏览器使用 `window.__ModuleLoader__.load` 注册 factory，React 来自宿主；通过 `settingsScope` 和 keyed `settings.plugin.item` 注册设置卡片。
- 配置命名空间为 `dsh-lsp-bridge`；UI 保存 `configJson`，Host 在写前解析并校验。配置保存后关闭旧服务池，后续工具调用使用新配置，不自动启动语言服务器。
- UI 使用已有 `settingsScope` 的修订号控制，保存后核对宿主读回值；失败保留草稿。
- 自定义发现接口走 `connection.fetch.register`，不是无认证的裸 HTTP route，因此共享 Web/桌面通信边界。

## 发现接口

路径 `/api/dsh-lsp-bridge/discovery`：

- GET：列出当前已加载会话的 id/cwd，供选择扫描对象。不会为了扫描恢复冷会话。
- POST：只接受 sessionId、refresh 和 languages；服务端从 sessions.get 解析真实 cwd，拒绝客户端提交任意路径或命令。
- 只读扫描不启动任何候选、不运行版本命令、不下载依赖、不修改项目文件。
- 当前沿用 danger-full-access 门控；扫描并不证明语言服务器可信，启用配置前仍需用户确认。

## 扫描与候选

固定目录包含 Go、Rust、TypeScript/JavaScript、Python、C/C++。通用 JSON 配置仍支持其他语言。

从绝对 PATH 目录、常见安装目录和工作区项目固定局部目录检查候选文件。识别 canonical 可执行文件路径，局部候选需要特别审阅。项目扫描不跟随目录符号链接，跳过依赖/构建目录，受深度、目录/项目数量和时间预算限制；截断必须向用户说明。

多个 Go module 默认仍是独立 root，不擅自创建 go.work 或改写依赖关系。发现结果是建议，不直接生效。多候选由用户选择，不自动安装或执行候选。

## 构建与验证

客户端使用可读、无 JSX 的 JavaScript 源文件 `src/client.js`，`npm run build:client` 生成 `lib/client.js`，无需额外打包器。运行产物入库，以便 GitHub 源安装不依赖构建脚本。React 是宿主提供的模块，不内联第二份 React。

测试覆盖发现限制、路径边界、配置校验与池替换、认证路由注册契约、会话绑定、客户端加载/草稿和建议转换。模拟宿主测试不等于真实 GUI 安装验收；新增客户端入口需要重新加载插件启动图和刷新现有 GUI，不承诺没有 watcher 时自动热更新。
