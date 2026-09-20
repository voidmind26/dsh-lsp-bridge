import { isAbsolute } from 'node:path';
import z from '@deepseek-ai/schemastery';
import { LspSessionPool, POLICY_POLL_INTERVAL_MS, normalizeSandboxConfig } from './pool.js';
import { probeLanguageServer } from './engine.js';
import { MAX_VERIFY_SERVERS, VERIFY_TIMEOUT_MS, applyInstallPlan, configServersFromDiagnosis, diagnoseWorkspace, mergeServersIntoConfig, normalizeInstallConfig, verifyDiagnosis } from './setup.js';
import { CONTEXT_ORDER, DiagnosisCache, renderLspContext } from './context.js';

export const name = 'dsh-lsp-bridge';
// settings、connection 与 sessions 通过 ctx.inject 可选接入，不能变成部署硬依赖。
export const inject = ['tools', 'sandboxPolicy'];
export const SETTINGS_NAMESPACE = 'dsh-lsp-bridge';
export const DISCOVERY_PATH = '/api/dsh-lsp-bridge/discovery';
export const DISCOVERY_MAX_BODY_BYTES = 16 * 1024;
export const OPERATIONS = ['status', 'hover', 'definition', 'references', 'implementation', 'typeDefinition', 'documentSymbols', 'workspaceSymbols', 'diagnostics', 'rename', 'format'];
/** 会写磁盘的操作：需要 apply=true，并受会话权限约束。 */
export const WRITE_OPERATIONS = new Set(['rename', 'format']);
export const SETUP_OPERATIONS = ['status', 'install', 'configure', 'verify', 'auto'];
export { MAX_VERIFY_SERVERS };
const POSITION_OPERATIONS = new Set(['hover', 'definition', 'references', 'implementation', 'typeDefinition']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0 && !value.includes('\0');
function assert(condition, message) { if (!condition) throw new TypeError(`dsh-lsp-bridge: ${message}`); }
function strings(value, label) { assert(Array.isArray(value) && value.every(nonempty), `${label} must be an array of nonempty strings`); }

/** Validate trusted administrator configuration; model calls cannot supply commands or environment. */
export function validateConfig(input = {}) {
  assert(object(input), 'config must be an object');
  const allowed = new Set(['servers', 'timeoutMs', 'maxInstances', 'maxFileBytes', 'maxOutputChars', 'idleTimeoutMs', 'maxSessions', 'install', 'sandbox']);
  for (const key of Object.keys(input)) assert(allowed.has(key), `unknown config key ${key}`);
  const config = { servers: [], timeoutMs: 15000, maxInstances: 8, maxFileBytes: 1048576, maxOutputChars: 30000, idleTimeoutMs: 300000, maxSessions: 4, ...input };
  try { config.install = normalizeInstallConfig(config.install); }
  catch (error) { assert(false, error.message); }
  try { config.sandbox = normalizeSandboxConfig(config.sandbox); }
  catch (error) { assert(false, error.message); }
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
    operation: { type: 'string', enum: OPERATIONS, description: '语言服务器操作；rename/format 会写入磁盘，需要 apply=true。' },
    file: { type: 'string', description: '相对于调用会话工作区的文件路径，或工作区内的绝对路径；文档操作必填。' },
    line: { type: 'integer', description: '位置操作的行号，从 1 开始。' },
    character: { type: 'integer', description: '位置操作的 UTF-16 字符偏移，从 1 开始。' },
    query: { type: 'string', description: '工作区符号搜索关键字。' },
    server: { type: 'string', description: '可选的已配置服务 ID，用于消除语言匹配歧义。' },
    root: { type: 'string', description: '可选的会话工作区内项目根目录，适用于多根符号查询。' },
    newName: { type: 'string', description: 'rename 的新名称。' },
    apply: { type: 'boolean', description: 'rename/format 是否真正写入；省略或 false 时只返回将要改动的内容。' },
    tabSize: { type: 'integer', description: 'format 的缩进宽度，默认 2。' },
    insertSpaces: { type: 'boolean', description: 'format 是否使用空格缩进，默认 true。' },
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
  if (args.newName !== undefined) assert(nonempty(args.newName), 'newName must be a nonempty string');
  if (args.apply !== undefined) assert(typeof args.apply === 'boolean', 'apply must be a boolean');
  if (args.insertSpaces !== undefined) assert(typeof args.insertSpaces === 'boolean', 'insertSpaces must be a boolean');
  if (args.tabSize !== undefined) assert(Number.isSafeInteger(args.tabSize) && args.tabSize >= 1 && args.tabSize <= 16, 'tabSize must be an integer between 1 and 16');
  if (args.operation === 'rename') assert(nonempty(args.newName), 'rename requires newName');
  return args;
}

export const setupParameters = {
  type: 'object', additionalProperties: false, required: ['operation'],
  properties: {
    operation: { type: 'string', enum: SETUP_OPERATIONS, description: 'status 只诊断不执行；install 执行允许列表安装（需 apply=true）；configure 写入插件配置；verify 真实启动验证；auto 串起全部步骤。' },
    server: { type: 'string', description: 'catalog 中的服务器 ID，例如 typescript-language-server、gopls、pyright；省略时处理工作区内全部已发现服务器。' },
    apply: { type: 'boolean', description: 'install/auto 必须显式传 true 才会运行安装命令；省略或 false 时只诊断并返回计划。' },
    languages: { type: 'string', description: '可选的 catalog 语言 ID，逗号分隔，用于缩小诊断范围。' },
  },
};

/** 模型只能选择 catalog 中的 id，不能提供命令、参数、包名或安装路径。 */
export function validateSetupArgs(args) {
  assert(object(args), 'arguments must be an object');
  for (const key of Object.keys(args)) assert(Object.hasOwn(setupParameters.properties, key), `unknown argument ${key}`);
  assert(SETUP_OPERATIONS.includes(args.operation), 'unknown setup operation');
  if (args.server !== undefined) assert(nonempty(args.server), 'server must be a nonempty string');
  if (args.apply !== undefined) assert(typeof args.apply === 'boolean', 'apply must be a boolean');
  if (args.languages !== undefined) strings(String(args.languages).split(',').map(item => item.trim()).filter(Boolean), 'languages');
  if (args.operation === 'install' && args.server === undefined) assert(false, 'install requires an explicit server');
  return args;
}

function parseLanguages(value) {
  if (value === undefined) return undefined;
  return String(value).split(',').map(item => item.trim()).filter(Boolean);
}

function dependencySummary(entry) {
  return entry.dependencies.map(dependency => ({
    id: dependency.id,
    description: dependency.description,
    satisfied: dependency.satisfied,
    resolvedPath: dependency.resolvedPath,
    reason: dependency.reason ?? null,
  }));
}

/** 面向模型与用户的紧凑诊断视图；完整计划仅在需要时展开。 */
export function statusView(diagnosis) {
  return {
    workspace: diagnosis.workspace,
    complete: diagnosis.complete,
    truncationReasons: diagnosis.truncationReasons,
    projects: diagnosis.projects.map(project => ({ language: project.language, root: project.root, markers: project.markers })),
    servers: diagnosis.servers.map(entry => ({
      serverId: entry.serverId,
      language: entry.language,
      status: entry.status,
      command: entry.command ?? null,
      commandSource: entry.commandSource ?? null,
      // 诊断与验证的目标目录：来自配置的显式根目录，或当前会话工作区。
      target: entry.target ?? null,
      targetSource: entry.targetSource ?? null,
      candidates: entry.candidates ?? [],
      roots: entry.roots,
      dependencies: dependencySummary(entry),
      install: entry.install.available
        ? { available: true, kind: entry.install.kind, manager: entry.install.manager?.name ?? null, prefix: entry.install.prefix, packages: entry.install.packages, steps: entry.install.steps.map(step => ({ file: step.file, args: step.args })) }
        : { available: false, reason: entry.install.reason, installAdvice: entry.installAdvice },
    })),
    install: diagnosis.install,
  };
}

/**
 * 写入插件设置命名空间的 configJson。
 * 只有读回值完全一致才算成功，避免并发修改被静默覆盖。
 */
async function configureServers(scope, text, servers) {
  if (!scope) throw new Error('当前部署没有可用的 settings 服务，插件无法写入配置；请把返回的 JSON 手工写入 profile 配置。');
  const merged = mergeServersIntoConfig(text, servers);
  await scope.update({ configJson: merged });
  const resolved = scope.get()?.configJson;
  if (resolved !== merged) throw new Error('配置写入后读回值不一致，可能存在并发修改；草稿未被覆盖。');
  return merged;
}

function setupTargets(diagnosis, server) {
  return diagnosis.servers.filter(entry => server === undefined || entry.serverId === server);
}

/**
 * 执行一次 lsp_setup 调用。installation 只有在 operation 为 install/auto 且 apply===true 时才会发生。
 */
export async function runSetup({ operation, args, workspace, config, scope, cache, execution = null, signal, probe = probeLanguageServer, diagnose = diagnoseWorkspace, install = applyInstallPlan }) {
  const server = args.server;
  const languages = parseLanguages(args.languages);
  const diagnoseOnce = () => diagnose({ workspace, languages, install: config.install, configured: config.servers, signal });
  let diagnosis = await diagnoseOnce();
  if (server !== undefined && !diagnosis.servers.some(entry => entry.serverId === server)) {
    throw new Error(`工作区内未发现服务器 ${server}；可先用 operation="status" 查看可用服务器。`);
  }

  const result = { operation, workspace, install: diagnosis.install, installed: [], configured: null, verification: [] };
  const entries = () => setupTargets(diagnosis, server);

  if (operation === 'status') return { ...result, status: statusView(diagnosis), nextActions: diagnosis.nextActions };

  if (operation === 'install' || (operation === 'auto' && args.apply === true)) {
    const pending = entries().filter(entry => entry.status === 'missing-command' || entry.status === 'missing-dependency');
    if (operation === 'install' && args.apply !== true) {
      return { ...result, status: statusView(diagnosis), installPlan: pending.map(entry => statusView(diagnosis).servers.find(item => item.serverId === entry.serverId).install), nextActions: ['安装需要显式 apply=true；当前只返回计划。'] };
    }
    for (const entry of pending) {
      if (!entry.install.available) {
        result.installed.push({ serverId: entry.serverId, ok: false, reason: entry.install.reason, installAdvice: entry.installAdvice });
        continue;
      }
      try {
        const outcome = await install(entry.install, { signal });
        result.installed.push({ serverId: entry.serverId, ok: true, kind: outcome.kind, prefix: outcome.prefix, binaryPath: outcome.binaryPath, packages: outcome.packages, steps: outcome.steps.map(step => ({ file: step.file, args: step.args, code: step.code })) });
      } catch (error) {
        result.installed.push({ serverId: entry.serverId, ok: false, error: error.message, steps: (error.installSteps ?? []).map(step => ({ file: step.file, args: step.args, code: step.code })) });
      }
    }
    diagnosis = await diagnoseOnce();
  }

  if (operation === 'configure' || operation === 'auto') {
    const targets = setupTargets(diagnosis, server);
    const servers = configServersFromDiagnosis(diagnosis, { servers: targets.map(entry => entry.serverId) });
    if (!servers.length) {
      result.configured = { written: false, reason: '没有同时具备命令与运行组件的服务器可写入；请先安装或修正配置。', servers: [] };
    } else {
      const base = scope?.get()?.configJson ?? JSON.stringify(config, null, 2);
      try {
        result.configured = { written: true, servers: servers.map(item => item.id), configJson: await configureServers(scope, base, servers) };
      } catch (error) {
        result.configured = { written: false, error: error.message, servers: servers.map(item => item.id) };
      }
    }
  }

  if (operation === 'verify' || operation === 'auto') {
    const scoped = server === undefined ? diagnosis : { ...diagnosis, servers: setupTargets(diagnosis, server) };
    const verification = await verifyDiagnosis(scoped, { workspace, signal, probe, timeoutMs: Math.min(config.timeoutMs, VERIFY_TIMEOUT_MS), confine: execution?.confine ?? null, env: execution?.env ?? null });
    if (verification.length) result.verification.push(...verification);
    else result.verification.push({ ok: false, reason: '没有可验证的服务器：需要已发现的程序且运行组件齐备。' });
  }

  // 让模型的上下文与刚完成的操作保持一致，无需再手动 status 一次。
  cache?.set(workspace, result.verification.length ? { ...diagnosis, verification: result.verification } : diagnosis);

  return {
    ...result,
    status: statusView(diagnosis),
    nextActions: diagnosis.nextActions,
  };
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
  const allowed = new Set(['sessionId', 'refresh', 'languages', 'verify']);
  for (const key of Object.keys(value)) assert(allowed.has(key), `请求体不允许字段 ${key}`);
  assert(nonempty(value.sessionId), 'sessionId 必须是非空字符串');
  if (value.refresh !== undefined) assert(typeof value.refresh === 'boolean', 'refresh 必须是布尔值');
  if (value.languages !== undefined) strings(value.languages, 'languages');
  if (value.verify !== undefined) assert(typeof value.verify === 'boolean', 'verify 必须是布尔值');
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
  // 受限会话下的进程约束来自 sandbox 服务；它可能尚未加载，因此按需读取而不是创建时快照。
  let sandboxService = null;
  if (typeof ctx.inject === 'function') ctx.inject(['sandbox'], sandboxCtx => { sandboxService = sandboxCtx.sandbox; });
  const makePool = value => new LspSessionPool(value, session => ctx.sandboxPolicy.resolve({ session }), {
    confine: (argv, policy) => {
      if (sandboxService === null) {
        const error = new Error('no sandbox service is loaded');
        error.code = 'SANDBOX_UNAVAILABLE';
        throw error;
      }
      return sandboxService.confine(argv, policy).argv;
    },
    sandbox: value.sandbox,
    hasSandbox: () => sandboxService !== null,
  });
  let pool = makePool(config);
  let disposed = false;
  // lsp_setup 写入配置的宿主入口；settings 不可用时保持 null 并如实报告。
  let settingsScope = null;
  // 最近一次诊断/验证结果，供模型上下文与工具复用（只在内存中，带过期）。
  const diagnosisCache = new DiagnosisCache();
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
    settingsScope = scope;
    const activate = value => replacePool(restoreEnvironment(parseSettingsConfig(value.configJson), environmentBase));
    let tail = activate(scope.get());
    const unwatch = scope.watch(next => (tail = tail.catch(() => {}).then(() => activate(next))));
    settingsCtx.effect?.(() => async () => {
      settingsScope = null;
      unwatch();
      await tail.catch(() => {});
      if (!disposed) await replacePool(baseConfig);
    }, 'dsh-lsp-bridge: settings watcher');
  });

  // 把“本工作区有哪些语言服务”注入模型上下文：text 回调同步求值，因此只读内存中的配置与缓存。
  if (typeof ctx.inject === 'function') ctx.inject(['systemPrompt'], promptCtx => {
    promptCtx.systemPrompt.context({
      name: 'dsh-lsp-bridge:servers',
      order: CONTEXT_ORDER,
      text: context => renderLspContext({ session: context?.agent?.session, config, cache: diagnosisCache }),
    });
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
        try {
          // 只读诊断在任何权限下都可以做；验证会启动进程，因此受限会话必须经由会话沙箱约束。
          const diagnosis = await diagnoseWorkspace({ workspace: session.header.cwd, languages: parsed.body.languages, install: config.install, configured: config.servers, signal: request.signal });
          let execution = null;
          if (parsed.body.verify === true) {
            try { execution = pool.executionFor(session); }
            catch (error) { return errorResponse(403, 'sandbox-unavailable', `当前会话（${error.message.includes('danger-full-access') ? '受限权限且没有可用沙箱后端' : '未知权限'}）无法安全地启动语言服务器进行验证。`); }
          }
          const verification = parsed.body.verify === true
            ? await verifyDiagnosis(diagnosis, { workspace: session.header.cwd, signal: request.signal, timeoutMs: Math.min(config.timeoutMs, VERIFY_TIMEOUT_MS), confine: execution.confine, env: execution.env })
            : null;
          const result = verification === null ? diagnosis : { ...diagnosis, verification };
          diagnosisCache.set(session.header.cwd, result);
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
    description: `查询与修改可信配置的语言服务器：悬停、定义、引用、实现、类型定义、文档/工作区符号、诊断，以及 rename/format 这类会写磁盘的操作。rename/format 只在 apply=true 时写入，否则只返回将要改动的内容；写入受会话权限约束（只读会话直接拒绝，workspace-write 只允许工作区内的文件），被拒绝时会说明需要完全访问权限（danger-full-access）。插件会把当前工作区已配置的语言服务自动注入上下文，通常不必先探路。workspaceSymbols 无文件可推断语言时，会先按“是否覆盖当前工作区”自动选择服务器，只有多个都覆盖时才要求显式传 server；冷启动时会先做一次有界预热打开项目文件，避免 TypeScript 报 No Project. 或返回空结果。输入行号与 UTF-16 字符偏移从 1 开始，输出 LSP 范围从 0 开始。按会话对象身份和 cwd 隔离常驻复用；status 展示配置及当前存活实例，不启动服务。不暴露编辑或命令。服务是可信的本地程序：danger-full-access 会话直接启动；受限会话（workspace-write/read-only）会先由 DSH 沙箱包装服务器进程，使其只能写会话工作区与临时目录；部署没有可用沙箱后端时失败关闭，绝不无沙箱启动，也不自动提权。权限收紧/会话销毁事件立即取消并关闭服务；有效权限另以 ${POLICY_POLL_INTERVAL_MS} 毫秒间隔检查。`,
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
      try {
        const result = await pool.execute(args, { session, workspace: session.header.cwd, signal: exec.signal });
        return boundedResult(result, config.maxOutputChars);
      } catch (error) {
        // 程序缺失或缺少运行组件时，直接把模型引向自动安装与配置入口。
        if (/Cannot start language server|Could not find a valid|ENOENT|not found|No such file/i.test(error?.message ?? '')) {
          error.message = `${error.message}\n提示：可调用 lsp_setup（operation="auto", apply=true）自动诊断、安装并配置所需语言服务器。`;
        }
        throw error;
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: `LSP ${args.operation}${args.file ? ` ${args.file}` : ''}`,
      kind: WRITE_OPERATIONS.has(args.operation) && args.apply === true ? 'edit' : 'read',
    }),
  });

  ctx.tools.register({
    name: 'lsp_setup',
    description: `自动准备语言服务器，无需人工扫描或手写配置：诊断工作区项目所需的 LSP 服务器及其运行组件（例如 TypeScript 的 tsserver），按固定允许列表安装缺失组件，把可用服务器写入插件配置，并真实启动一次完成 initialize 验证。你只能提供本目录中的服务器 ID（gopls、rust-analyzer、typescript-language-server、pyright、clangd）；不能提供命令、参数、包名或安装路径。安装命令来自冻结的 catalog（go/npm/rustup/cargo/venv/brew），不经 shell、不使用 sudo；只有 operation=install/auto 且显式 apply=true 才执行安装，status 与 verify 从不安装。安装目录默认 $DSH_HOME/lsp-bridge，可由 config.install 调整，install.enabled=false 可整体禁用。status/configure/verify 在受限会话同样可用（验证会由会话沙箱约束服务器进程）；只有真正执行安装命令的步骤要求 danger-full-access，因为安装器在插件内直接执行、不经过会话沙箱。绝不自动提权。典型用法：先 status 查看缺什么，再 auto + apply=true 一次完成安装、配置与验证。`,
    parameters: setupParameters,
    output: {
      schema: { type: 'object', additionalProperties: false, required: ['json', 'truncated'], properties: { json: { type: 'string' }, truncated: { type: 'boolean' } } },
      render: (_args, value) => [{ type: 'text', text: value.json }],
    },
    isConcurrencySafe: () => false,
    timeoutMs: 900000,
    async execute(args, exec) {
      validateSetupArgs(args);
      const session = exec.agent?.session;
      assert(session && nonempty(session.header?.cwd) && isAbsolute(session.header.cwd), 'an agent session with an absolute workspace is required');
      let policy;
      try { policy = ctx.sandboxPolicy.resolve({ session }); }
      catch { throw new Error('无法核对会话权限，已拒绝执行语言服务器安装。'); }
      // status / configure / verify 不执行安装命令，受限会话同样可用（验证由会话沙箱约束）；
      // 只有真正运行安装命令时才要求完全访问，因为安装器在插件内直接执行。
      const installs = args.operation === 'install' || (args.operation === 'auto' && args.apply === true);
      if (installs && policy?.mode !== 'danger-full-access') {
        throw new Error(`lsp_setup 的安装步骤需要 danger-full-access 会话（当前 ${policy?.mode ?? 'unknown'}）：安装器在插件内直接执行，不经过会话沙箱，也不会自动提权。可以先在受限会话中完成 status/verify。`);
      }
      let execution = null;
      try { execution = pool.executionFor(session); }
      catch (error) {
        if (installs) throw error;
        // 受限会话且没有沙箱后端：诊断仍然可用，只是不能启动服务器。
        execution = { confine: null, env: null };
      }
      const result = await runSetup({ operation: args.operation, args, workspace: session.header.cwd, config, scope: settingsScope, cache: diagnosisCache, execution, signal: exec.signal });
      return boundedResult(result, config.maxOutputChars);
    },
    presentCall: args => ({
      card: 'generic',
      title: `LSP 环境 ${args.operation}${args.server ? ` ${args.server}` : ''}${args.apply === true ? '（含安装）' : ''}`,
      kind: args.operation === 'status' || args.operation === 'verify' ? 'read' : args.operation === 'configure' ? 'edit' : 'execute',
    }),
  });
}
