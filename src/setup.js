/**
 * 语言服务器的运行环境诊断、允许列表安装与配置合并。
 *
 * 设计边界：
 * - 安装命令只来自冻结的 catalog；调用方只能选择 serverId，不能提供命令、参数、包名或路径。
 * - 绝不经由 shell 执行，不调用 sudo，不读取调用方传入的任意目录作为安装目标。
 * - `discoverWorkspace` 只读文件系统；只有显式 apply 的 install 步骤才真正运行安装命令。
 * - 依赖诊断不启动任何服务器；真正启动服务器的是 verify（短生命周期探测）。
 */
import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { mkdir, realpath, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { CATALOG } from './catalog.js';
import { discoverWorkspace } from './discovery.js';
import { probeLanguageServer } from './engine.js';

export const INSTALL_TIMEOUT_MS = 300000;
export const MAX_INSTALL_TIMEOUT_MS = 1800000;
export const MAX_PATH_DIRECTORIES = 128;
/** 一次验证最多真实启动的服务器数量，避免一次调用拉起过多进程。 */
export const MAX_VERIFY_SERVERS = 4;
export const VERIFY_TIMEOUT_MS = 20000;
const MAX_STEP_OUTPUT_CHARS = 4000;

/** 每种安装方式使用的包管理器候选；顺序即优先级。 */
const KIND_MANAGERS = Object.freeze({
  npm: Object.freeze(['npm']),
  go: Object.freeze(['go']),
  cargo: Object.freeze(['cargo']),
  venv: Object.freeze(['python3', 'python']),
  rustup: Object.freeze(['rustup']),
  brew: Object.freeze(['brew']),
});

/** 前缀式安装方式的可执行文件相对位置。 */
const KIND_BINARY_DIRECTORY = Object.freeze({
  npm: Object.freeze(['node_modules', '.bin']),
  go: Object.freeze(['bin']),
  cargo: Object.freeze(['bin']),
  venv: Object.freeze(['venv', 'bin']),
});

const SERVER_INDEX = new Map();
for (const language of CATALOG) for (const server of language.servers) SERVER_INDEX.set(server.id, { language, server });

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** catalog 中的服务器定义；调用方只能通过 id 选择。 */
export function catalogServer(serverId) {
  return SERVER_INDEX.get(serverId) ?? null;
}

/** 默认安装根目录：DSH_HOME 优先，其次用户主目录。 */
export function defaultInstallDirectory({ env = process.env, home = homedir() } = {}) {
  const dshHome = typeof env.DSH_HOME === 'string' && isAbsolute(env.DSH_HOME) ? env.DSH_HOME : join(home, '.dsh');
  return join(dshHome, 'lsp-bridge');
}

/**
 * 校验并补全 install 配置。默认开启，但只有在显式 apply 的安装操作里才会执行命令。
 */
export function normalizeInstallConfig(input = {}, { env = process.env, home = homedir() } = {}) {
  if (!isObject(input)) throw new TypeError('install 必须是对象');
  const allowed = new Set(['enabled', 'directory', 'managers', 'timeoutMs']);
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw new TypeError(`install: 未知配置项 ${key}`);
  const directory = input.directory ?? defaultInstallDirectory({ env, home });
  if (typeof directory !== 'string' || !isAbsolute(directory)) throw new TypeError('install.directory 必须是绝对路径');
  const enabled = input.enabled ?? true;
  if (typeof enabled !== 'boolean') throw new TypeError('install.enabled 必须是布尔值');
  const managers = input.managers ?? {};
  if (!isObject(managers)) throw new TypeError('install.managers 必须是对象');
  const normalizedManagers = {};
  for (const [kind, path] of Object.entries(managers)) {
    if (!Object.hasOwn(KIND_MANAGERS, kind)) throw new TypeError(`install.managers: 未知安装方式 ${kind}`);
    if (typeof path !== 'string' || !isAbsolute(path)) throw new TypeError(`install.managers.${kind} 必须是绝对路径`);
    normalizedManagers[kind] = path;
  }
  const timeoutMs = input.timeoutMs ?? INSTALL_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > MAX_INSTALL_TIMEOUT_MS) {
    throw new TypeError(`install.timeoutMs 必须是 1000 到 ${MAX_INSTALL_TIMEOUT_MS} 之间的整数`);
  }
  return { enabled, directory, managers: normalizedManagers, timeoutMs };
}

function executableFileSync(candidate) {
  try {
    if (!statSync(candidate).isFile()) return null;
    accessSync(candidate, constants.X_OK);
    return realpathSync(candidate);
  } catch { return null; }
}

/** 只接受 PATH 中的绝对目录，且不把 Windows 的 .cmd/.bat 包装器当作可直接执行文件。 */
export function findExecutableSync(name, { env = process.env, platform = process.platform } = {}) {
  const filenames = platform === 'win32' ? [`${name}.exe`] : [name];
  const seen = new Set();
  for (const directory of String(env.PATH ?? '').split(delimiter).slice(0, MAX_PATH_DIRECTORIES)) {
    if (!isAbsolute(directory) || seen.has(directory)) continue;
    seen.add(directory);
    for (const filename of filenames) {
      const found = executableFileSync(join(directory, filename));
      if (found) return found;
    }
  }
  return null;
}

async function packageRoot(directory) {
  try {
    const metadata = await stat(join(directory, 'package.json'));
    return metadata.isFile() ? realpath(directory) : null;
  } catch { return null; }
}

/** 依次检查候选 npm 包目录，返回第一个真实存在的包根目录。 */
async function resolveNpmPackage(name, roots) {
  for (const root of roots) {
    const found = await packageRoot(root);
    if (found) return found;
  }
  return null;
}

/**
 * 检查服务器的运行组件。目前只有 npm 包形态（例如 TypeScript 的 tsserver）。
 * 不仅要求包存在，还要求它真的提供服务器需要的入口文件：
 * TypeScript 7 起不再提供 lib/tsserver.js，包存在并不代表可用。
 */
export async function diagnoseDependencies(server, { workspace, command, installConfig }) {
  const dependencies = [];
  for (const requirement of server.requires ?? []) {
    if (requirement.kind !== 'npm-package') {
      dependencies.push({ id: requirement.id, kind: requirement.kind, name: requirement.name, description: requirement.description, satisfied: false, resolvedPath: null, entryPath: null, reason: '不支持的依赖类型' });
      continue;
    }
    const roots = [
      // 插件自己的安装前缀优先，其次是工作区，最后是服务器自身周围可能存在的全局安装。
      join(installConfig.directory, server.id, 'node_modules', requirement.name),
      join(workspace, 'node_modules', requirement.name),
      ...(command ? [
        join(dirname(command), '..', 'node_modules', requirement.name),
        join(dirname(command), '..', 'lib', 'node_modules', requirement.name),
        join(dirname(command), 'node_modules', requirement.name),
      ] : []),
    ];
    const resolvedPath = await resolveNpmPackage(requirement.name, roots);
    if (!resolvedPath) {
      dependencies.push({ id: requirement.id, kind: requirement.kind, name: requirement.name, description: requirement.description, satisfied: false, resolvedPath: null, entryPath: null, reason: `未找到 ${requirement.name}` });
      continue;
    }
    // 入口文件必须真实存在，否则服务器仍然会在初始化时退出。
    let entryPath = null;
    if (requirement.entry) {
      const candidate = join(resolvedPath, requirement.entry);
      const metadata = await stat(candidate).catch(() => null);
      if (!metadata?.isFile()) {
        dependencies.push({ id: requirement.id, kind: requirement.kind, name: requirement.name, description: requirement.description, satisfied: false, resolvedPath, entryPath: null, reason: `${requirement.name} 已安装但不提供 ${requirement.entry}（该版本与语言服务器不兼容）` });
        continue;
      }
      entryPath = candidate;
    }
    dependencies.push({ id: requirement.id, kind: requirement.kind, name: requirement.name, description: requirement.description, satisfied: true, resolvedPath, entryPath, reason: null });
  }
  return dependencies;
}

function setNested(target, path, value) {
  let cursor = target;
  for (const key of path.slice(0, -1)) {
    if (!isObject(cursor[key])) cursor[key] = {};
    cursor = cursor[key];
  }
  cursor[path.at(-1)] = value;
}

/** 由已满足的依赖推导初始化选项，例如 tsserver.path。 */
export function initializationOptionsFor(server, dependencies) {
  let options;
  for (const requirement of server.requires ?? []) {
    if (!requirement.option) continue;
    const dependency = dependencies.find(item => item.id === requirement.id);
    if (!dependency?.satisfied) continue;
    const value = dependency.entryPath ?? dependency.resolvedPath;
    if (!value) continue;
    options ??= {};
    setNested(options, requirement.option, value);
  }
  return options;
}

/**
 * 插件私有前缀中该服务器的可执行文件位置；与是否允许安装无关，
 * 因此“已安装但当前禁用安装”的场景仍能复用既有产物。
 */
export function managedBinaryPath(server, installConfig) {
  const spec = server?.install;
  if (!spec || spec.prefix === false || !spec.binary) return null;
  const layout = KIND_BINARY_DIRECTORY[spec.kind];
  if (!layout) return null;
  return join(installConfig.directory, server.id, ...layout, spec.binary);
}

function resolveManager(kind, { env, platform, installConfig }) {
  const names = KIND_MANAGERS[kind] ?? [];
  const configured = installConfig.managers[kind];
  if (configured !== undefined) {
    const found = executableFileSync(configured);
    return found ? { kind, name: basename(configured), path: found, source: 'config' } : { kind, name: basename(configured), path: configured, source: 'config', missing: true };
  }
  for (const name of names) {
    const found = findExecutableSync(name, { env, platform });
    if (found) return { kind, name, path: found, source: 'path' };
  }
  return { kind, name: names[0] ?? kind, path: null, source: 'path', missing: true };
}

/**
 * 把 catalog 的安装声明编译成固定命令序列。
 * 返回值可直接展示给用户与模型，也用于实际执行。
 */
export function buildInstallPlan(server, { env = process.env, platform = process.platform, installConfig } = {}) {
  const config = installConfig ?? normalizeInstallConfig({}, { env });
  const spec = server.install;
  const base = { serverId: server.id, directory: config.directory, timeoutMs: config.timeoutMs };
  if (!spec) return { ...base, available: false, reason: 'no-portable-installer' };
  if (config.enabled !== true) return { ...base, available: false, kind: spec.kind, reason: 'install-disabled' };
  // Windows 下的前缀安装只生成 .cmd 包装器，不能作为 spawn 的直接目标，因此当前不声明支持。
  if (platform === 'win32') return { ...base, available: false, kind: spec.kind, reason: 'unsupported-platform' };
  const manager = resolveManager(spec.kind, { env, platform, installConfig: config });
  if (manager.missing) return { ...base, available: false, kind: spec.kind, manager, reason: 'manager-missing' };

  const prefix = spec.prefix === false ? null : join(config.directory, server.id);
  const steps = [];
  if (spec.kind === 'npm') {
    steps.push({ file: manager.path, args: ['install', '--prefix', prefix, '--no-audit', '--no-fund', ...spec.packages] });
  } else if (spec.kind === 'go') {
    steps.push({ file: manager.path, args: ['install', `${spec.package}@${spec.version ?? 'latest'}`], env: { GOBIN: join(prefix, 'bin') } });
  } else if (spec.kind === 'cargo') {
    steps.push({ file: manager.path, args: ['install', '--root', prefix, spec.package, ...(spec.version === undefined ? [] : ['--version', spec.version])] });
  } else if (spec.kind === 'venv') {
    steps.push({ file: manager.path, args: ['-m', 'venv', join(prefix, 'venv')] });
    steps.push({ file: join(prefix, 'venv', 'bin', 'pip'), args: ['install', '--disable-pip-version-check', ...spec.packages] });
  } else if (spec.kind === 'rustup') {
    steps.push({ file: manager.path, args: ['component', 'add', spec.component] });
  } else if (spec.kind === 'brew') {
    steps.push({ file: manager.path, args: ['install', spec.formula] });
  } else {
    return { ...base, available: false, kind: spec.kind, manager, reason: 'unsupported-kind' };
  }

  const layout = KIND_BINARY_DIRECTORY[spec.kind];
  const binaryPath = spec.prefix === false || !layout ? null : managedBinaryPath(server, config);
  return {
    ...base, available: true, kind: spec.kind, manager, prefix, binaryPath, steps,
    packages: spec.packages ?? (spec.package ? [spec.package] : spec.component ? [spec.component] : spec.formula ? [spec.formula] : []),
    installAdvice: server.installAdvice,
  };
}

const insideDirectory = (base, target) => {
  const rel = relative(base, target);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
};

/** 已配置服务器可能用绝对路径或 PATH 中的名字指定命令；这里只做只读解析。 */
function resolveConfiguredCommand(command, { env, platform }) {
  if (typeof command !== 'string' || !command) return null;
  if (isAbsolute(command)) return executableFileSync(command);
  return findExecutableSync(basename(command), { env, platform });
}

/**
 * 已配置服务器的诊断条目。
 *
 * 语言服务器属于**项目目录**，不属于会话：一条配置的 `roots`/`workspaceFolders` 就是它的
 * 目标目录，即使该目录不在当前会话工作区内也照样诊断与验证。会话只提供两件事——
 * 授权（能否启动可信程序）与未声明根目录时的默认目录。
 *
 * 目录来自管理员配置而非调用方输入，因此这里读的是配置声明的路径；
 * 没有任何显式根目录、且工作区里也没有该项目标记的服务器不补条目（界面会说明原因）。
 */
async function configuredEntries(workspace, configured, { env, platform, installConfig }) {
  const canonical = await realpath(workspace);
  const entries = [];
  for (const definition of configured ?? []) {
    const catalogEntry = SERVER_INDEX.get(definition.id);
    const server = catalogEntry?.server ?? null;
    const roots = [...(definition.roots ?? []), ...(definition.workspaceFolders ?? [])];
    const resolvedRoots = [];
    for (const root of roots) {
      try { resolvedRoots.push(await realpath(isAbsolute(root) ? root : join(canonical, root))); }
      catch { /* 不存在的目录不参与诊断 */ }
    }
    // 没有显式根目录时，只有工作区里存在该项目标记才认为它适用于这里。
    const markers = definition.rootMarkers ?? catalogEntry?.language.markers ?? [];
    const appliesHere = resolvedRoots.length > 0 || await hasWorkspaceMarker(canonical, markers);
    if (!appliesHere) continue;
    const target = resolvedRoots[0] ?? canonical;
    const command = resolveConfiguredCommand(definition.command, { env, platform });
    // 运行组件按服务器自己的项目目录查找（例如该项目自己的 node_modules）。
    const dependencies = server ? await diagnoseDependencies(server, { workspace: target, command, installConfig }) : [];
    const initializationOptions = server ? initializationOptionsFor(server, dependencies) : undefined;
    const missingDependency = dependencies.some(dependency => !dependency.satisfied);
    entries.push({
      language: catalogEntry?.language.id ?? 'custom',
      serverId: definition.id,
      roots: resolvedRoots.length ? [...new Set(resolvedRoots)].sort() : [canonical],
      // 诊断与验证的目标目录；targetSource 说明它来自配置还是当前会话工作区。
      target,
      targetSource: resolvedRoots.length ? 'config' : 'session',
      workspace: canonical,
      args: [...(definition.args ?? server?.args ?? [])],
      languages: definition.languages ?? server?.languages ?? {},
      rootMarkers: [...markers],
      candidates: [],
      status: missingDependency ? 'missing-dependency' : command ? 'ready' : 'missing-command',
      command,
      commandSource: command ? 'config' : null,
      dependencies,
      install: server ? buildInstallPlan(server, { env, platform, installConfig }) : { available: false, reason: 'no-portable-installer' },
      ...(initializationOptions === undefined ? {} : { initializationOptions }),
      configured: true,
    });
  }
  return entries;
}

/** 工作区根目录是否带有该项目的标记文件。 */
async function hasWorkspaceMarker(workspace, markers) {
  for (const marker of markers ?? []) {
    try {
      const metadata = await stat(join(workspace, marker));
      if (metadata.isFile()) return true;
    } catch { /* 没有该标记 */ }
  }
  return false;
}

/** 扫描工作区并给出带运行组件状态的服务器清单；不执行任何程序。 */
export async function diagnoseWorkspace({ workspace, env = process.env, platform = process.platform, install, languages, configured, signal } = {}) {
  if (typeof workspace !== 'string' || !isAbsolute(workspace)) throw new TypeError('workspace 必须是绝对路径');
  const installConfig = normalizeInstallConfig(install, { env });
  const report = await discoverWorkspace({ workspace, env, platform, languages, signal });
  const canonicalWorkspace = await realpath(workspace);
  const servers = [];
  for (const plan of report.plans) {
    const entry = SERVER_INDEX.get(plan.serverId);
    const server = entry?.server;
    const installPlan = server ? buildInstallPlan(server, { env, platform, installConfig }) : { available: false, reason: 'unknown-server' };
    // PATH 未提供命令时，插件自己安装的前缀可以补位：模型安装完立刻就是可用状态。
    let command = plan.status === 'ready' ? plan.command : null;
    let commandSource = command ? 'path' : null;
    const managedBinary = managedBinaryPath(server, installConfig);
    if (!command && plan.status === 'missing' && managedBinary && executableFileSync(managedBinary)) {
      command = managedBinary;
      commandSource = 'plugin';
    }
    const dependencies = server ? await diagnoseDependencies(server, { workspace, command, installConfig }) : [];
    const initializationOptions = server ? initializationOptionsFor(server, dependencies) : undefined;
    const missingDependency = dependencies.some(dependency => !dependency.satisfied);
    const status = missingDependency ? 'missing-dependency' : command ? 'ready' : plan.status === 'needs-choice' ? 'needs-choice' : 'missing-command';
    servers.push({
      ...plan,
      status,
      command,
      commandSource,
      // 发现出来的服务器以会话工作区为诊断与验证目标。
      target: canonicalWorkspace,
      targetSource: 'session',
      dependencies,
      install: installPlan,
      ...(initializationOptions === undefined ? {} : { initializationOptions }),
    });
  }
  // 配置在别的项目下的服务器不在这里补状态：界面会说明扫描边界。
  const covered = new Set(servers.map(server => server.serverId));
  for (const entry of await configuredEntries(workspace, (configured ?? []).filter(item => !covered.has(item?.id)), { env, platform, installConfig })) {
    servers.push(entry);
  }
  const actionable = servers.filter(server => server.status === 'missing-command' || server.status === 'missing-dependency');
  const blockedReason = server => server.dependencies.filter(dependency => !dependency.satisfied).map(dependency => dependency.reason).filter(Boolean).join('；');
  return {
    version: 1,
    workspace,
    complete: report.complete,
    truncationReasons: report.truncationReasons,
    projects: report.projects,
    servers,
    install: { enabled: installConfig.enabled, directory: installConfig.directory },
    nextActions: actionable.length === 0
      ? ['所有已发现的语言服务器都具备所需运行组件；可执行 verify 做一次真实启动验证。']
      : actionable.map(server => server.install.available
        ? `${server.serverId}：${blockedReason(server) || '缺少可执行程序'}；可调用 lsp_setup（operation="install", server="${server.serverId}", apply=true）安装，随后 configure 并 verify。`
        : `${server.serverId}：${blockedReason(server) || '缺少可执行程序'}，且无可移植安装方案（${server.install.reason}）；请人工处理：${server.installAdvice ?? ''}`),
  };
}

/** 把服务器定义按 id 合并进配置 JSON；解析失败即拒绝，绝不以空配置覆盖。 */
export function mergeServersIntoConfig(currentText, servers) {
  let current;
  try { current = JSON.parse(currentText); }
  catch { throw new TypeError('现有配置不是有效 JSON，已拒绝合并'); }
  if (!isObject(current)) throw new TypeError('现有配置必须是 JSON 对象');
  if (current.servers !== undefined && !Array.isArray(current.servers)) throw new TypeError('现有配置的 servers 必须是数组');
  const merged = [...(current.servers ?? [])];
  for (const server of servers) {
    const index = merged.findIndex(existing => existing?.id === server.id);
    if (index < 0) merged.push(server);
    else merged[index] = { ...merged[index], ...server };
  }
  return JSON.stringify({ ...current, servers: merged }, null, 2);
}

/**
 * 从诊断结果生成可写入配置的服务器定义。
 * 缺少运行组件的条目只有在依赖被满足后才允许写入，避免保存一个必然启动失败的配置。
 */
export function configServersFromDiagnosis(diagnosis, { servers, choices = {} } = {}) {
  const wanted = servers === undefined ? null : new Set(servers);
  const selected = [];
  for (const entry of diagnosis.servers) {
    if (wanted && !wanted.has(entry.serverId)) continue;
    const command = entry.status === 'ready'
      ? entry.command
      : entry.status === 'needs-choice' && (entry.candidates ?? []).includes(choices[entry.serverId]) ? choices[entry.serverId] : null;
    if (!command) continue;
    if (entry.dependencies.some(dependency => !dependency.satisfied)) continue;
    selected.push({
      id: entry.serverId,
      command,
      args: entry.args,
      languages: entry.languages,
      rootMarkers: entry.rootMarkers,
      roots: entry.roots,
      ...(entry.initializationOptions === undefined ? {} : { initializationOptions: entry.initializationOptions }),
    });
  }
  return selected;
}

/**
 * 对“命令与运行组件都齐备”的服务器做一次真实启动验证（initialize 后立即关闭）。
 * 验证是唯一能区分“文件存在”和“真的能用”的手段，因此结果单独返回，不与诊断状态混用。
 * 只验证前 limit 个，避免一次拉起过多进程；请求取消时停止后续验证。
 */
export async function verifyDiagnosis(diagnosis, { workspace, signal, probe = probeLanguageServer, timeoutMs = VERIFY_TIMEOUT_MS, limit = MAX_VERIFY_SERVERS } = {}) {
  const targets = diagnosis.servers
    .filter(entry => entry.command && !entry.dependencies.some(dependency => !dependency.satisfied))
    .slice(0, limit);
  const results = [];
  for (const entry of targets) {
    if (signal?.aborted) break;
    const [definition] = configServersFromDiagnosis(diagnosis, { servers: [entry.serverId] });
    if (!definition) {
      results.push({ serverId: entry.serverId, ok: false, error: '服务器定义不完整，无法验证。' });
      continue;
    }
    try {
      // 用条目自己的目标目录验证：LSP 属于项目，不属于会话。
      const probed = await probe({ server: definition, workspace: entry.target ?? workspace, signal, timeoutMs });
      results.push({ serverId: entry.serverId, ok: true, root: probed.root, serverInfo: probed.serverInfo, capabilities: probed.capabilities, positionEncoding: probed.positionEncoding });
    } catch (error) {
      if (signal?.aborted) break;
      results.push({ serverId: entry.serverId, ok: false, error: error.message });
    }
  }
  return results;
}

function boundedOutput(text) {
  const value = text ?? '';
  return value.length <= MAX_STEP_OUTPUT_CHARS ? value : `…${value.slice(-MAX_STEP_OUTPUT_CHARS)}`;
}

function runStep(step, { spawnImpl, timeoutMs, signal, env }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error('安装已取消'), { name: 'AbortError' }));
    const started = Date.now();
    const child = spawnImpl(step.file, step.args, {
      cwd: step.cwd,
      env: { ...env, ...(step.env ?? {}) },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer;
    const kill = () => { try { child.kill('SIGTERM'); } catch { /* 已退出 */ } setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } }, 1000).unref?.(); };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error); else resolve(value);
    };
    const onAbort = () => { kill(); finish(Object.assign(new Error('安装已取消'), { name: 'AbortError' })); };
    timer = setTimeout(() => { kill(); finish(new Error(`安装步骤超时（${timeoutMs} ms）：${basename(step.file)}`)); }, timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', chunk => { stdout = (stdout + chunk.toString('utf8')).slice(-MAX_STEP_OUTPUT_CHARS * 2); });
    child.stderr?.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-MAX_STEP_OUTPUT_CHARS * 2); });
    child.on('error', error => finish(new Error(`无法执行安装步骤 ${step.file}: ${error.message}`)));
    child.on('close', code => {
      const result = { file: step.file, args: [...step.args], code, stdout: boundedOutput(stdout), stderr: boundedOutput(stderr), elapsedMs: Date.now() - started };
      if (code === 0) return finish(null, result);
      finish(Object.assign(new Error(`安装命令失败（退出码 ${code}）：${basename(step.file)} ${step.args.join(' ')}${stderr.trim() ? `\n${boundedOutput(stderr).trim()}` : ''}`), { stepResult: result }));
    });
  });
}

/** 执行安装方案。只有在调用方显式 apply 时才会到达这里。 */
export async function applyInstallPlan(plan, { signal, spawnImpl = spawn, timeoutMs, env = process.env } = {}) {
  if (!plan?.available) throw new Error(`安装方案不可执行：${plan?.reason ?? 'unknown'}`);
  if (plan.prefix) await mkdir(plan.prefix, { recursive: true });
  const effectiveTimeout = timeoutMs ?? plan.timeoutMs ?? INSTALL_TIMEOUT_MS;
  const steps = [];
  for (const step of plan.steps) {
    try {
      steps.push(await runStep(step, { spawnImpl, timeoutMs: effectiveTimeout, signal, env }));
    } catch (error) {
      if (error.stepResult) steps.push(error.stepResult);
      error.installSteps = steps;
      throw error;
    }
  }
  if (plan.binaryPath && !executableFileSync(plan.binaryPath)) {
    throw Object.assign(new Error(`安装完成但未找到可执行文件：${plan.binaryPath}`), { installSteps: steps });
  }
  return { ok: true, kind: plan.kind, prefix: plan.prefix, binaryPath: plan.binaryPath, packages: plan.packages, steps };
}