/**
 * 自动发现使用的固定语言服务器目录。
 *
 * 安装建议仅作为纯文本返回，发现过程不会执行其中的任何命令，也不会修改配置。
 */
export const CATALOG = Object.freeze([
  Object.freeze({
    id: 'go',
    name: 'Go',
    markers: Object.freeze(['go.mod', 'go.work']),
    languages: Object.freeze({ go: Object.freeze(['.go']) }),
    servers: Object.freeze([
      Object.freeze({
        id: 'gopls',
        commands: Object.freeze(['gopls']),
        args: Object.freeze([]),
        installAdvice: '安装 Go 后运行：go install golang.org/x/tools/gopls@latest',
      }),
    ]),
  }),
  Object.freeze({
    id: 'rust',
    name: 'Rust',
    markers: Object.freeze(['Cargo.toml']),
    languages: Object.freeze({ rust: Object.freeze(['.rs']) }),
    servers: Object.freeze([
      Object.freeze({
        id: 'rust-analyzer',
        commands: Object.freeze(['rust-analyzer']),
        args: Object.freeze([]),
        installAdvice: '使用 rustup 安装：rustup component add rust-analyzer',
      }),
    ]),
  }),
  Object.freeze({
    id: 'tsjs',
    name: 'TypeScript/JavaScript',
    markers: Object.freeze(['package.json', 'tsconfig.json', 'jsconfig.json']),
    languages: Object.freeze({
      typescript: Object.freeze(['.ts', '.mts', '.cts']),
      typescriptreact: Object.freeze(['.tsx']),
      javascript: Object.freeze(['.js', '.mjs', '.cjs']),
      javascriptreact: Object.freeze(['.jsx']),
    }),
    servers: Object.freeze([
      Object.freeze({
        id: 'typescript-language-server',
        commands: Object.freeze(['typescript-language-server']),
        args: Object.freeze(['--stdio']),
        installAdvice: '使用 npm 安装：npm install --global typescript typescript-language-server',
      }),
    ]),
  }),
  Object.freeze({
    id: 'python',
    name: 'Python',
    markers: Object.freeze(['pyproject.toml', 'pyrightconfig.json', 'setup.py', 'setup.cfg', 'requirements.txt', 'Pipfile']),
    languages: Object.freeze({ python: Object.freeze(['.py', '.pyi']) }),
    servers: Object.freeze([
      Object.freeze({
        id: 'pyright',
        commands: Object.freeze(['pyright-langserver']),
        args: Object.freeze(['--stdio']),
        installAdvice: '使用 npm 安装：npm install --global pyright',
      }),
    ]),
  }),
  Object.freeze({
    id: 'cpp',
    name: 'C/C++',
    markers: Object.freeze(['compile_commands.json', 'compile_flags.txt', 'CMakeLists.txt', '.clangd']),
    languages: Object.freeze({
      c: Object.freeze(['.c', '.h']),
      cpp: Object.freeze(['.cc', '.cpp', '.cxx', '.hh', '.hpp', '.hxx']),
    }),
    servers: Object.freeze([
      Object.freeze({
        id: 'clangd',
        commands: Object.freeze(['clangd']),
        args: Object.freeze([]),
        installAdvice: '安装 LLVM/Clang 工具链中提供的 clangd；例如 macOS 使用 Homebrew：brew install llvm，Debian/Ubuntu：sudo apt install clangd',
      }),
    ]),
  }),
]);
