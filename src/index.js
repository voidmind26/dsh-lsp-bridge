import { isAbsolute } from 'node:path';
import z from '@deepseek-ai/schemastery';
import { discoverWorkspace } from './discovery.js';
import { LspSessionPool, POLICY_POLL_INTERVAL_MS } from './pool.js';

export const name = 'dsh-lsp-bridge';
// settings、connection 与 sessions 通过 ctx.inject 可选接入，不能变成部署硬依赖。
export const inject = ['tools', 'sandboxPolicy'];
export const SETTINGS_NAMESPACE = 'dsh-lsp-bridge';
export const DISCOVERY_PATH = '/api/dsh-lsp-bridge/discovery';
export const DISCOVERY_MAX_BODY_BYTES = 16 * 1024;
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

// Cordis 插件配置使用 Standard Schema；设置命名空间另使用宿主 Schemastery schema。
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

function parseSettingsConfig(configJson) {
  let parsed;
  try { parsed = JSON.parse(configJson); }
  catch { throw new TypeError('dsh-lsp-bridge: configJson 必须是有效 JSON'); }
  const config = validateConfig(parsed);
  assert(config.servers.every(server => server.env === undefined), 'UI 不支持编辑 env；请仅在部署配置中设置环境变量。');
  return config;
}

export function settingsValue(input) {
  const config = validateConfig(input);
  config.servers = config.servers.map(({ env, ...server }) => server);
  return { configJson: JSON.stringify(config, null, 2) };
}

// JSON 是普通设置文本，不提供机密字段脱敏；禁止在 UI 存放凭据，env 仅由部署配置提供。
function settingsSchema() {
  return z.object({ configJson: z.string().default(JSON.stringify(validateConfig({}), null, 2)).description('可信服务配置 JSON；请勿填写凭据。env 仅支持部署配置，界面保存会保留原 env。') });
}

function restoreEnvironment(config, base) {
  config.servers = config.servers.map(server => {
    const original = base.servers.find(item => item.id === server.id);
    if (!original?.env) return server;
    assert(server.command === original.command && JSON.stringify(server.args) === JSON.stringify(original.args), '含部署 env 的服务不允许在 UI 修改启动命令或参数。');
    return { ...server, env: { ...original.env } };
  });
  return config;
}

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

function jsonResponse(value, status = 200) {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
}

function errorResponse(status, code, message) {
  return jsonResponse({ error: { code, message } }, status);
}

function discoveryBody(value) {
  assert(object(value), '请求体必须是 JSON 对象');
  const allowed = new Set(['sessionId', 'refresh', 'languages']);
  for (const key of Object.keys(value)) assert(allowed.has(key), `请求体不允许字段 ${key}`);
  assert(nonempty(value.sessionId), 'sessionId 必须是非空字符串');
  if (value.refresh !== undefined) assert(typeof value.refresh === 'boolean', 'refresh 必须是布尔值');
  if (value.languages !== undefined) strings(value.languages, 'languages');
  return value;
}

async function readDiscoveryBody(request) {
  const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (mediaType !== 'application/json') return { response: errorResponse(415, 'unsupported-media-type', '请求体必须使用 application/json。') };
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > DISCOVERY_MAX_BODY_BYTES)) {
    return { response: errorResponse(400, 'invalid-request', '请求体超过 16 KiB 限制。') };
  }
  const reader = request.body?.getReader();
  const chunks = [];
  let size = 0;
  try {
    if (reader) for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > DISCOVERY_MAX_BODY_BYTES) {
        await reader.cancel();
        return { response: errorResponse(400, 'invalid-request', '请求体超过 16 KiB 限制。') };
      }
      chunks.push(value);
    }
  } catch { return { response: errorResponse(400, 'invalid-request', '无法读取请求体。') }; }
  finally { reader?.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return { body: discoveryBody(JSON.parse(new TextDecoder().decode(bytes))) }; }
  catch { return { response: errorResponse(400, 'invalid-request', '请求体不是有效的发现请求。') }; }
}

function liveSessions(sessions) {
  const values = typeof sessions.list === 'function' ? sessions.list() : [];
  return values.flatMap(session => {
    const id = session?.header?.id;
    const cwd = session?.header?.cwd;
    return nonempty(id) && nonempty(cwd) && isAbsolute(cwd) ? [{ id, cwd }] : [];
  });
}

export function apply(ctx, input = {}) {
  const baseConfig = validateConfig(input);
  let config = baseConfig;
  const retiring = new Set();
  const environmentBase = structuredClone(baseConfig);
  const makePool = value => new LspSessionPool(value, session => ctx.sandboxPolicy.resolve({ session }));
  let pool = makePool(config);
  let disposed = false;
  const replacePool = nextConfig => {
    if (disposed) return Promise.resolve();
    if (JSON.stringify(nextConfig) === JSON.stringify(config)) return Promise.resolve();
    const nextPool = makePool(nextConfig);
    const previous = pool;
    config = nextConfig;
    pool = nextPool;
    const closing = previous.dispose();
    retiring.add(closing);
    closing.then(() => retiring.delete(closing), () => retiring.delete(closing));
    return closing;
  };

  // 事件闭包始终解引用当前池，设置热替换后不会继续操作旧实例。
  if (typeof ctx.on === 'function') {
    ctx.on('session/event', (session, event) => pool.policyChanged(session, event));
    ctx.on('session/disposed', session => pool.sessionDisposed(session));
  }
  ctx.effect(() => async () => {
    disposed = true;
    await Promise.allSettled([pool.dispose(), ...retiring]);
  }, 'dsh-lsp-bridge: language server lifetime');

  // settings 是可选 Host 能力；无该服务时保持原有 composition 配置行为。
  if (typeof ctx.inject === 'function') ctx.inject(['settings'], settingsCtx => {
    const scope = settingsCtx.settings.register(SETTINGS_NAMESPACE, settingsSchema(), {
      base: settingsValue(baseConfig),
      applies: 'live',
      validate: value => restoreEnvironment(parseSettingsConfig(value.configJson), environmentBase),
    });
    const activate = value => replacePool(restoreEnvironment(parseSettingsConfig(value.configJson), environmentBase));
    let tail = activate(scope.get());
    const unwatch = scope.watch(next => (tail = tail.catch(() => {}).then(() => activate(next))));
    settingsCtx.effect?.(() => async () => {
      unwatch();
      await tail.catch(() => {});
      if (!disposed) await replacePool(baseConfig);
    }, 'dsh-lsp-bridge: settings watcher');
  });

  // connection 自带 Host/Origin 与浏览器认证围栏；只在 sessions 同时存在时注册 UI API。
  if (typeof ctx.inject === 'function') ctx.inject(['connection', 'sessions'], hostCtx => {
    hostCtx.effect(() => hostCtx.connection.fetch.register({
      path: DISCOVERY_PATH,
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      async fetch(request) {
        if (request.method === 'GET') return jsonResponse({ sessions: liveSessions(hostCtx.sessions) });
        const parsed = await readDiscoveryBody(request);
        if (parsed.response) return parsed.response;
        const session = hostCtx.sessions.get(parsed.body.sessionId);
        if (!session || !nonempty(session.header?.cwd) || !isAbsolute(session.header.cwd)) {
          return errorResponse(404, 'session-not-found', '找不到可用于发现的活动会话。');
        }
        let policy;
        try { policy = ctx.sandboxPolicy.resolve({ session }); }
        catch { return errorResponse(500, 'policy-failure', '无法核对会话权限。'); }
        if (policy?.mode !== 'danger-full-access') {
          return errorResponse(403, 'danger-full-access-required', '自动发现目前仅允许 danger-full-access 会话；不会自动提权。');
        }
        try {
          const result = await discoverWorkspace({ workspace: session.header.cwd, languages: parsed.body.languages, signal: request.signal });
          return jsonResponse(result);
        } catch (error) {
          if (request.signal.aborted) return errorResponse(400, 'request-aborted', '自动发现请求已取消。');
          if (error instanceof TypeError || error instanceof RangeError) {
            return errorResponse(400, 'invalid-request', '自动发现参数无效。');
          }
          return errorResponse(500, 'discovery-failed', '自动发现失败。');
        }
      },
    }), 'dsh-lsp-bridge: discovery API');
  });

  ctx.tools.register({
    name: 'lsp',
    description: `查询可信配置的语言服务器：悬停、定义、引用、实现、类型定义、文档/工作区符号和诊断。输入行号与 UTF-16 字符偏移从 1 开始，输出 LSP 范围从 0 开始。按会话对象身份和 cwd 隔离常驻复用；status 展示配置及当前存活实例，不启动服务。不暴露编辑或命令。服务是未经 OS 沙箱隔离的可信程序，每次调用要求 danger-full-access，绝不自动提权。权限收紧/会话销毁事件立即取消并关闭服务；有效权限另以 ${POLICY_POLL_INTERVAL_MS} 毫秒间隔检查。`,
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
