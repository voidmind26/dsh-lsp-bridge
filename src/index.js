import { isAbsolute } from 'node:path';
import { LspSessionPool, POLICY_POLL_INTERVAL_MS } from './pool.js';

export const name = 'dsh-lsp-bridge';
export const inject = ['tools', 'sandboxPolicy'];
export const OPERATIONS = ['status', 'hover', 'definition', 'references', 'implementation', 'typeDefinition', 'documentSymbols', 'workspaceSymbols', 'diagnostics'];
const POSITION_OPERATIONS = new Set(['hover', 'definition', 'references', 'implementation', 'typeDefinition']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0 && !value.includes('\0');
function assert(condition, message) { if (!condition) throw new TypeError(`dsh-lsp-bridge: ${message}`); }
function strings(value, label) { assert(Array.isArray(value) && value.every(nonempty), `${label} must be an array of nonempty strings`); }

/** Validate trusted administrator configuration; model calls cannot supply commands or environment. */
export function validateConfig(input = {}) {
  assert(object(input), 'config must be an object');
  const allowed = new Set(['servers', 'timeoutMs', 'maxInstances', 'maxFileBytes', 'maxOutputChars', 'idleTimeoutMs', 'maxSessions']);
  for (const key of Object.keys(input)) assert(allowed.has(key), `unknown config key ${key}`);
  const config = { servers: [], timeoutMs: 15000, maxInstances: 8, maxFileBytes: 1048576, maxOutputChars: 30000, idleTimeoutMs: 300000, maxSessions: 4, ...input };
  const ranges = { timeoutMs: [1, 300000], maxInstances: [1, 128], maxFileBytes: [1, 8 * 1024 * 1024], maxOutputChars: [256, Number.MAX_SAFE_INTEGER], idleTimeoutMs: [1, 2147483647], maxSessions: [1, 128] };
  for (const [key, [min, max]] of Object.entries(ranges)) assert(Number.isSafeInteger(config[key]) && config[key] >= min && config[key] <= max, `${key} must be an integer between ${min} and ${max}`);
  assert(Array.isArray(config.servers), 'servers must be an array');
  const ids = new Set();
  config.servers = config.servers.map((server, index) => {
    const label = `servers[${index}]`;
    assert(object(server), `${label} must be an object`);
    const keys = new Set(['id', 'command', 'args', 'env', 'languages', 'rootMarkers', 'roots', 'workspaceFolders', 'initializationOptions', 'settings']);
    for (const key of Object.keys(server)) assert(keys.has(key), `${label}: unknown key ${key}`);
    assert(nonempty(server.id) && !ids.has(server.id), `${label}.id must be nonempty and unique`);
    ids.add(server.id);
    assert(nonempty(server.command), `${label}.command must be nonempty`);
    for (const key of ['args', 'rootMarkers', 'roots', 'workspaceFolders']) if (server[key] !== undefined) strings(server[key], `${label}.${key}`);
    if (server.env !== undefined) assert(object(server.env) && Object.entries(server.env).every(([key, value]) => nonempty(key) && !key.includes('=') && typeof value === 'string' && !value.includes('\0')), `${label}.env must map valid environment names to strings`);
    assert(object(server.languages) && Object.keys(server.languages).length > 0, `${label}.languages must map language IDs to extension arrays`);
    for (const [language, extensions] of Object.entries(server.languages)) {
      assert(nonempty(language), `${label}: language ID must be nonempty`);
      strings(extensions, `${label}.languages.${language}`);
      assert(extensions.length > 0, `${label}.languages.${language} must not be empty`);
    }
    return { ...server, args: [...(server.args ?? [])], languages: Object.fromEntries(Object.entries(server.languages).map(([id, extensions]) => [id, [...extensions]])) };
  });
  return config;
}

// Cordis accepts Standard Schema directly; no Schemastery/runtime peer dependency is needed.
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-lsp-bridge',
    validate(value) {
      try { return { value: validateConfig(value) }; }
      catch (error) { return { issues: [{ message: error.message }] }; }
    },
  },
};

export const parameters = {
  type: 'object', additionalProperties: false, required: ['operation'],
  properties: {
    operation: { type: 'string', enum: OPERATIONS, description: '只读语言服务器操作。' },
    file: { type: 'string', description: '相对于调用会话工作区的文件路径，或工作区内的绝对路径；文档操作必填。' },
    line: { type: 'integer', description: '位置操作的行号，从 1 开始。' },
    character: { type: 'integer', description: '位置操作的 UTF-16 字符偏移，从 1 开始。' },
    query: { type: 'string', description: '工作区符号搜索关键字。' },
    server: { type: 'string', description: '可选的已配置服务 ID，用于消除语言匹配歧义。' },
    root: { type: 'string', description: '可选的会话工作区内项目根目录，适用于多根符号查询。' },
  },
};

export function validateArgs(args) {
  assert(object(args), 'arguments must be an object');
  for (const key of Object.keys(args)) assert(Object.hasOwn(parameters.properties, key), `unknown argument ${key}`);
  assert(OPERATIONS.includes(args.operation), 'unknown operation');
  for (const key of ['file', 'server', 'root']) if (args[key] !== undefined) assert(nonempty(args[key]), `${key} must be a nonempty string`);
  if (args.query !== undefined) assert(typeof args.query === 'string', 'query must be a string');
  for (const key of ['line', 'character']) if (args[key] !== undefined) assert(Number.isSafeInteger(args[key]) && args[key] >= 1, `${key} must be a positive safe integer`);
  if (!['status', 'workspaceSymbols'].includes(args.operation)) assert(nonempty(args.file), 'this operation requires file');
  if (POSITION_OPERATIONS.has(args.operation)) for (const key of ['line', 'character']) assert(Number.isSafeInteger(args[key]) && args[key] >= 1, `this operation requires one-based ${key}`);
  if (args.operation === 'workspaceSymbols') assert(typeof args.query === 'string', 'workspaceSymbols requires query (may be empty)');
  return args;
}

/** Bound the canonical value too, not only its model-facing render (PTC sees value). */
function boundedResult(value, limit) {
  const text = JSON.stringify(value ?? null);
  if (text.length <= limit) return { json: text, truncated: false };
  let preview = text.slice(0, limit - 160);
  if (/[\uD800-\uDBFF]$/.test(preview)) preview = preview.slice(0, -1);
  let json = JSON.stringify({ truncated: true, originalCharacters: text.length, preview });
  while (json.length > limit) {
    preview = preview.slice(0, Math.max(0, Math.floor(preview.length * 0.8)));
    if (/[\uD800-\uDBFF]$/.test(preview)) preview = preview.slice(0, -1);
    json = JSON.stringify({ truncated: true, originalCharacters: text.length, preview });
  }
  return { json, truncated: true };
}

export function apply(ctx, input = {}) {
  const config = validateConfig(input);
  const pool = new LspSessionPool(config, session => ctx.sandboxPolicy.resolve({ session }));
  // 已核对 dsh-session 的真实事件签名；测试/精简宿主没有 on 时由轮询兜底。
  if (typeof ctx.on === 'function') {
    ctx.on('session/event', (session, event) => pool.policyChanged(session, event));
    ctx.on('session/disposed', session => pool.sessionDisposed(session));
  }
  ctx.effect(() => () => pool.dispose(), 'dsh-lsp-bridge: language server lifetime');
  ctx.tools.register({
    name: 'lsp',
    description: `查询可信配置的语言服务器：悬停、定义、引用、实现、类型定义、文档/工作区符号和诊断。输入行号与 UTF-16 字符偏移从 1 开始，输出 LSP 范围从 0 开始。按会话对象身份和 cwd 隔离常驻复用；status 展示配置及当前存活实例，不启动服务。空闲 ${config.idleTimeoutMs} 毫秒后回收，最多 ${config.maxSessions} 个会话工作区，每个最多 ${config.maxInstances} 个服务实例；活动请求不会因空闲或容量被回收。不暴露编辑或命令。服务是未经 OS 沙箱隔离的可信程序，每次调用要求 danger-full-access，绝不自动提权。权限收紧/会话销毁事件立即取消并关闭服务；有效权限另以 ${POLICY_POLL_INTERVAL_MS} 毫秒间隔检查，未收到事件的权限变化存在最多一个轮询周期加事件循环调度与进程退出的延迟。`,
    parameters,
    output: {
      schema: { type: 'object', additionalProperties: false, required: ['json', 'truncated'], properties: { json: { type: 'string' }, truncated: { type: 'boolean' } } },
      render: (_args, value) => [{ type: 'text', text: value.json }],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      validateArgs(args);
      const session = exec.agent?.session;
      assert(session && nonempty(session.header?.cwd) && isAbsolute(session.header.cwd), 'an agent session with an absolute workspace is required');
      const result = await pool.execute(args, { session, workspace: session.header.cwd, signal: exec.signal });
      return boundedResult(result, config.maxOutputChars);
    },
    presentCall: args => ({ card: 'generic', title: `LSP ${args.operation}${args.file ? ` ${args.file}` : ''}`, kind: 'read' }),
  });
}
