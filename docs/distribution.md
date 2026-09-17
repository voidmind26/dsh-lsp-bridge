# Bundle 分发与收录检查

## 依据

对照 [awesome-dsh-plugin 贡献指南](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md)。这是该目录的收录规范，不代表收录即经过安全审计。

## 本包满足的结构

- `package.json` 声明 `dsh.bundle.patch: ./cordis.patch.yml`。
- 包根的 patch 使用包名 `dsh-plugin-lsp` 挂载 `lsp`，不绑定个人绝对路径或 profile 名称。
- `main` 与 `exports["."]` 指向真实服务端 Cordis 插件；已有工具实现和测试，不是只有依赖的聚合包。
- `files` 包含源码、Bundle patch、示例与文档，纯 ESM JavaScript 无需构建，无安装期脚本。
- 没有前端 UI，因此不声明 `dsh.client` 或虚构截图。
- 本实现没有导入官方 `@deepseek-ai/*` 包，也没有把官方包声明为 dependencies。当前不需要为不存在的模块依赖增加 peerDependencies；以后引入官方包时应使用 peerDependencies，并明确覆盖所支持版本的 prerelease 分支。
- web 和 desktop 使用同一个服务端 Bundle，区别仅在安装所用 CLI 和 profile。

## 发布前仍需人工完成

本地实现通过不等于满足全部收录条件。尚未创建或确认 GitHub 发布仓库，所以不能验证以下事项：

- 仓库真实 URL、维护者及 `repository` 元数据；确认后才能填入 package.json，不能伪造。
- 仓库创建满 1 天，处于活跃维护状态。
- GitHub topic 包含 `dsh-plugin`（package.json keywords 不能替代仓库 topic）。
- 授权方式：当前 `UNLICENSED`，对外发布前由作者明确许可。
- 在目标 web / desktop 实例完成真实安装、工具调用及卸载验证。
- 在列表中核对是否已有重复条目，选择贴切类别（建议 `dev`）。

## 收录条目模板

仓库地址确定后，向列表仓库仅添加 `data/plugins/<owner>__<repo>.yml`，不要手工修改其生成的 README。以下是待替换的文档模板，不是可直接提交的真实条目：

```yaml
url: https://github.com/OWNER/REPO
name: OWNER/REPO
category: dev
description:
  en: 'Read-only multi-language LSP queries with session-scoped server reuse and multi-root project configuration for DeepSeek Harness.'
  zh: '为 DeepSeek Harness 提供只读多语言 LSP 查询，支持会话级服务器复用与多根项目配置。'
```

英文描述是对方收录格式的必填字段，保留中英文描述；其余项目文档使用中文。若最终采用 monorepo，按贡献指南改为子目录 URL、`owner/repo#subname` 名称和对应文件名。

## 分发产物

在插件目录执行 `npm pack` 即可生成包含所有运行时代码的 `.tgz`，不依赖安装时编译。发布 npm 不是收录必需条件。也可将打包产物附到 GitHub Release；若使用可选 `tarball` 字段，必须是真实 GitHub Release HTTPS `.tgz` 地址。不要将版本化文件名放到会随发布变化的 `latest/download/` 地址中。

本项目不自动发布 npm、不创建 GitHub 仓库、不添加 topic、不提交收录 PR。
