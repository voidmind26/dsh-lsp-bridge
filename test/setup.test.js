import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, realpath, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CATALOG } from '../src/catalog.js';
import {
  MAX_VERIFY_SERVERS, applyInstallPlan, buildInstallPlan, catalogServer, configServersFromDiagnosis, diagnoseDependencies,
  diagnoseWorkspace, initializationOptionsFor, mergeServersIntoConfig, normalizeInstallConfig, verifyDiagnosis,
} from '../src/setup.js';
import { runSetup, validateSetupArgs } from '../src/index.js';

const tsServer = () => catalogServer('typescript-language-server').server;

async function workspaceWith(files = []) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'lsp-setup-')));
  for (const file of files) {
    await mkdir(join(root, file, '..'), { recursive: true });
    await writeFile(join(root, file), '{}');
  }
  return root;
}

/** 注入用的假 spawn：记录调用并按脚本返回退出码与输出。 */
function fakeSpawn({ code = 0, stderr = '', onSpawn } = {}) {
  const calls = [];
  const spawnImpl = (file, args, options) => {
    const call = { file, args, options };
    calls.push(call);
    onSpawn?.(call);
    const listeners = {};
    const stream = (name) => ({ on(event, handler) { call[`${name}${event}`] = handler; return this; } });
    const child = {
      stdout: stream('stdout'), stderr: stream('stderr'),
      on(event, handler) { listeners[event] = handler; return child; },
      kill() { call.killed = true; },
    };
    queueMicrotask(() => {
      if (stderr) call.stderrdata?.(Buffer.from(stderr));
      listeners.close?.(code);
    });
    return child;
  };
  return { spawnImpl, calls };
}

test('安装声明与 install 配置校验：命令只来自 catalog，拒绝非法配置', () => {
  // catalog 是固定的安装命令来源，声明中不得出现 shell 元字符。
  for (const language of CATALOG) for (const server of language.servers) {
    if (!server.install) continue;
    const text = JSON.stringify(server.install);
    assert.doesNotMatch(text, /[;&|`$><\n]/, `${server.id} 的安装声明不得含 shell 元字符`);
    assert.ok(typeof server.install.kind === 'string');
    assert.ok(['npm', 'go', 'cargo', 'venv', 'rustup', 'brew'].includes(server.install.kind));
  }
  assert.equal(catalogServer('clangd').server.install, null, 'clangd 没有可移植安装方案');
  assert.equal(catalogServer('not-a-server'), null);

  // install 配置拒绝相对目录、未知字段与越界超时。
  assert.throws(() => normalizeInstallConfig({ directory: 'relative/path' }), /绝对路径/);
  assert.throws(() => normalizeInstallConfig({ nope: 1 }), /未知配置项/);
  assert.throws(() => normalizeInstallConfig({ timeoutMs: 10 }), /timeoutMs/);
  assert.throws(() => normalizeInstallConfig({ managers: { npm: 'relative' } }), /绝对路径/);
  assert.throws(() => normalizeInstallConfig({ managers: { plain: '/usr/bin/x' } }), /未知安装方式/);
  const config = normalizeInstallConfig({ enabled: false }, { env: { DSH_HOME: '/tmp/dsh-home' } });
  assert.equal(config.directory, '/tmp/dsh-home/lsp-bridge');
  assert.equal(config.enabled, false);
});

const realPath = { PATH: process.env.PATH };

test('安装方案生成：npm 私有前缀与二进制路径、go/rustup，以及 win32/缺管理器/禁用分支', async () => {
  // npm 安装方案落在插件私有前缀，并给出可执行文件与 tsserver 路径。
  const workspace = await workspaceWith(['package.json']);
  const installConfig = normalizeInstallConfig({ directory: join(workspace, 'prefix') });
  const plan = buildInstallPlan(tsServer(), { env: realPath, platform: 'darwin', installConfig });
  assert.equal(plan.available, true);
  assert.equal(plan.kind, 'npm');
  assert.deepEqual(plan.steps.map(step => step.args), [['install', '--prefix', join(workspace, 'prefix', 'typescript-language-server'), '--no-audit', '--no-fund', 'typescript@5', 'typescript-language-server']]);
  assert.equal(plan.binaryPath, join(workspace, 'prefix', 'typescript-language-server', 'node_modules', '.bin', 'typescript-language-server'));

  // Windows 前缀安装只生成 .cmd 包装器，当前明确声明不支持。
  assert.equal(buildInstallPlan(tsServer(), { env: { PATH: 'C:\\bin' }, platform: 'win32', installConfig }).reason, 'unsupported-platform');
  // 找不到包管理器时不猜测命令。
  assert.equal(buildInstallPlan(tsServer(), { env: { PATH: '/nonexistent' }, platform: 'darwin', installConfig }).reason, 'manager-missing');
  // 显式关闭安装能力后不再提供方案。
  assert.equal(buildInstallPlan(tsServer(), { env: realPath, platform: 'darwin', installConfig: normalizeInstallConfig({ directory: join(workspace, 'p2'), enabled: false }) }).reason, 'install-disabled');

  // 当前 PATH 下的真实包管理器可生成 go 与 rustup 方案。
  const go = buildInstallPlan(catalogServer('gopls').server, {});
  assert.equal(go.kind, 'go');
  assert.deepEqual(go.steps.at(-1).args, ['install', 'golang.org/x/tools/gopls@latest']);
  assert.equal(go.steps.at(-1).env.GOBIN, join(go.prefix, 'bin'));
  const rust = buildInstallPlan(catalogServer('rust-analyzer').server, {});
  // 本机可能没有 rustup：此时必须如实返回 manager-missing，而不是伪造命令。
  if (rust.available) assert.deepEqual(rust.steps.at(-1).args, ['component', 'add', 'rust-analyzer']);
  else assert.equal(rust.reason, 'manager-missing');
});

test('依赖诊断区分“服务器在但 SDK 缺失/不兼容”与“具备运行组件”', async () => {
  const bare = await workspaceWith(['package.json']);
  const installConfig = normalizeInstallConfig({ directory: join(bare, '.prefix') });
  const missing = await diagnoseDependencies(tsServer(), { workspace: bare, command: null, installConfig });
  assert.equal(missing.length, 1);
  assert.equal(missing[0].satisfied, false);
  assert.equal(missing[0].id, 'typescript-sdk');
  assert.match(missing[0].reason, /未找到 typescript/);
  assert.equal(initializationOptionsFor(tsServer(), missing), undefined);

  // 包存在但缺少 tsserver 入口（TypeScript 7 的情况）必须判定为不可用。
  const incompatible = await workspaceWith(['package.json', 'node_modules/typescript/package.json']);
  const rejected = await diagnoseDependencies(tsServer(), { workspace: incompatible, command: null, installConfig });
  assert.equal(rejected[0].satisfied, false);
  assert.match(rejected[0].reason, /lib\/tsserver\.js/);
  assert.equal(initializationOptionsFor(tsServer(), rejected), undefined);

  const withSdk = await workspaceWith(['package.json', 'node_modules/typescript/package.json', 'node_modules/typescript/lib/tsserver.js']);
  const satisfied = await diagnoseDependencies(tsServer(), { workspace: withSdk, command: null, installConfig });
  assert.equal(satisfied[0].satisfied, true);
  const options = initializationOptionsFor(tsServer(), satisfied);
  assert.equal(options.tsserver.path, join(await realpath(join(withSdk, 'node_modules', 'typescript')), 'lib', 'tsserver.js'));
});

test('安装计划按步骤执行，失败与取消都不会被当作成功', async () => {
  const workspace = await workspaceWith(['package.json']);
  const plan = buildInstallPlan(tsServer(), { env: realPath, platform: 'darwin', installConfig: normalizeInstallConfig({ directory: join(workspace, 'prefix') }) });
  // 注入 fake spawn 不会创建二进制，因此先放下产物以校验“安装后必须存在可执行文件”。
  await mkdir(join(plan.prefix, 'node_modules', '.bin'), { recursive: true });
  await writeFile(plan.binaryPath, '#!/bin/sh\n');
  await chmod(plan.binaryPath, 0o755);
  const ok = fakeSpawn({ code: 0 });
  const outcome = await applyInstallPlan(plan, { spawnImpl: ok.spawnImpl });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.steps.length, 1);
  assert.equal(ok.calls.length, 1);
  assert.equal(ok.calls[0].options.shell, false, '绝不使用 shell');
  assert.equal(ok.calls[0].options.env.PATH, realPath.PATH);

  const bad = fakeSpawn({ code: 1, stderr: 'EACCES 权限不足' });
  await assert.rejects(applyInstallPlan(plan, { spawnImpl: bad.spawnImpl }), /退出码 1[\s\S]*EACCES/);

  const controller = new AbortController();
  const hanging = fakeSpawn({ onSpawn: () => queueMicrotask(() => controller.abort()) });
  await assert.rejects(applyInstallPlan(plan, { spawnImpl: hanging.spawnImpl, signal: controller.signal }), /取消/);
  assert.equal(hanging.calls[0].killed, true, '取消必须终止子进程');
});

test('配置合并与写入范围：保留未知字段、按 id 覆盖、拒绝非法 JSON、只写依赖齐备的服务器', () => {
  // 配置合并保留未知字段并按 id 覆盖，非法 JSON 直接拒绝。
  const current = JSON.stringify({ extra: true, servers: [{ id: 'gopls', command: '/old', env: { A: '1' } }] });
  const merged = JSON.parse(mergeServersIntoConfig(current, [{ id: 'gopls', command: '/new', args: [] }]));
  assert.equal(merged.extra, true);
  assert.equal(merged.servers[0].command, '/new');
  assert.deepEqual(merged.servers[0].env, { A: '1' }, '未被覆盖的字段必须保留');
  assert.throws(() => mergeServersIntoConfig('{bad', []), /有效 JSON/);
  assert.throws(() => mergeServersIntoConfig('[1,2]', []), /JSON 对象/);

  // 只有依赖齐备的服务器才会写入配置。
  const diagnosis = {
    servers: [
      { serverId: 'gopls', status: 'ready', command: '/bin/gopls', args: [], languages: { go: ['.go'] }, rootMarkers: ['go.mod'], roots: ['/w'], dependencies: [] },
      { serverId: 'typescript-language-server', status: 'missing-dependency', command: '/bin/tls', args: ['--stdio'], languages: {}, rootMarkers: [], roots: [], dependencies: [{ satisfied: false }] },
      { serverId: 'pyright', status: 'ready', command: '/bin/pyright-langserver', args: ['--stdio'], languages: {}, rootMarkers: [], roots: [], dependencies: [], initializationOptions: { python: { analysis: {} } } },
    ],
  };
  const servers = configServersFromDiagnosis(diagnosis);
  assert.deepEqual(servers.map(server => server.id), ['gopls', 'pyright']);
  assert.deepEqual(servers[1].initializationOptions, { python: { analysis: {} } });
  assert.deepEqual(configServersFromDiagnosis(diagnosis, { servers: ['gopls'] }).map(server => server.id), ['gopls']);
});

test('PATH 未提供命令时，插件自己安装的前缀可以补位', async () => {
  const workspace = await workspaceWith(['package.json']);
  const prefix = join(workspace, 'prefix');
  const binary = join(prefix, 'typescript-language-server', 'node_modules', '.bin', 'typescript-language-server');
  await mkdir(join(binary, '..'), { recursive: true });
  await writeFile(binary, '#!/bin/sh\n');
  await chmod(binary, 0o755);
  // 空 PATH：既没有语言服务器，也没有包管理器。
  const diagnosis = await diagnoseWorkspace({ workspace, env: { PATH: '/nonexistent' }, platform: 'darwin', install: { directory: prefix, enabled: false } });
  const entry = diagnosis.servers.find(server => server.serverId === 'typescript-language-server');
  assert.equal(entry.command, binary);
  assert.equal(entry.commandSource, 'plugin');
  assert.equal(entry.status, 'missing-dependency', '命令有了但 tsserver 仍然缺失，不得谎报可用');
  await mkdir(join(prefix, 'typescript-language-server', 'node_modules', 'typescript', 'lib'), { recursive: true });
  await writeFile(join(prefix, 'typescript-language-server', 'node_modules', 'typescript', 'package.json'), '{}');
  await writeFile(join(prefix, 'typescript-language-server', 'node_modules', 'typescript', 'lib', 'tsserver.js'), '// tsserver');
  const healed = await diagnoseWorkspace({ workspace, env: { PATH: '/nonexistent' }, platform: 'darwin', install: { directory: prefix, enabled: false } });
  const healedEntry = healed.servers.find(server => server.serverId === 'typescript-language-server');
  assert.equal(healedEntry.status, 'ready', '命令与运行组件齐备后必须判定为可用');
  assert.equal(healedEntry.initializationOptions.tsserver.path, join(await realpath(join(prefix, 'typescript-language-server', 'node_modules', 'typescript')), 'lib', 'tsserver.js'));
});

test('验证：只针对齐备服务器、逐个报告成败、可被打断、数量上限，且在服务器自己的目标目录内执行', async () => {
  const ready = serverId => ({
    serverId, language: 'go', status: 'ready', command: `/bin/${serverId}`, candidates: [], roots: ['/ws'],
    args: [], languages: { go: ['.go'] }, rootMarkers: ['go.mod'], dependencies: [],
    install: { available: false, reason: 'manager-missing' },
  });
  const blocked = { ...ready('pyright'), status: 'missing-dependency', dependencies: [{ id: 'x', satisfied: false }] };
  const diagnosis = { servers: [ready('gopls'), blocked, { ...ready('rust-analyzer'), command: null }] };
  const probed = [];
  const results = await verifyDiagnosis(diagnosis, {
    workspace: '/ws',
    probe: async ({ server }) => {
      probed.push(server.id);
      return { root: '/ws', capabilities: ['hoverProvider'], positionEncoding: 'utf-16', serverInfo: { name: 'gopls' } };
    },
  });
  assert.deepEqual(probed, ['gopls'], '缺组件与缺命令的服务器不会被启动');
  assert.equal(results.length, 1);
  assert.equal(results[0].serverId, 'gopls');
  assert.equal(results[0].ok, true);
  assert.deepEqual(results[0].capabilities, ['hoverProvider']);
  assert.equal(results[0].positionEncoding, 'utf-16');

  const failing = await verifyDiagnosis({ servers: [ready('typescript-language-server')] }, {
    workspace: '/ws',
    probe: async () => { throw new Error('Could not find a valid TypeScript installation'); },
  });
  assert.equal(failing[0].ok, false);
  assert.match(failing[0].error, /TypeScript installation/);

  // 请求取消后不再继续验证后续服务器。
  const controller = new AbortController();
  controller.abort();
  const aborted = await verifyDiagnosis({ servers: [ready('gopls')] }, { workspace: '/ws', signal: controller.signal, probe: async () => { throw new Error('不应调用'); } });
  assert.deepEqual(aborted, []);

  // 数量上限：一次最多验证 MAX_VERIFY_SERVERS 个。
  const many = { servers: ['a', 'b', 'c', 'd', 'e', 'f'].map(ready) };
  const limited = await verifyDiagnosis(many, { workspace: '/ws', probe: async () => ({ root: '/ws', capabilities: [] }) });
  assert.equal(limited.length, MAX_VERIFY_SERVERS);
  assert.equal(limited.length, 4);

  // 验证在服务器自己的目标目录内执行，而不是会话工作区。
  const workspace = await workspaceWith(['src/keep.txt']);
  const project = await workspaceWith(['service/keep.txt']);
  const projectRoot = join(await realpath(project), 'service');
  const configured = [{ id: 'gopls', command: process.execPath, args: [], languages: { go: ['.go'] }, roots: [projectRoot] }];
  const projectDiagnosis = await diagnoseWorkspace({ workspace, configured });
  const seen = [];
  const projectResults = await verifyDiagnosis(projectDiagnosis, {
    workspace,
    probe: async ({ workspace: probedWorkspace }) => { seen.push(probedWorkspace); return { root: probedWorkspace, capabilities: [] }; },
  });
  assert.deepEqual(seen, [projectRoot], '探针在配置的项目目录内启动，而不是会话工作区');
  assert.equal(projectResults[0].ok, true);
  assert.equal(projectResults[0].root, projectRoot);
});

test('诊断按服务器自己的项目目录进行，不绑定会话工作区', async () => {
  const workspace = await workspaceWith(['src/keep.txt']);
  const outside = await workspaceWith(['other/keep.txt']);
  await mkdir(join(workspace, 'svc'), { recursive: true });
  const outsideRoot = join(await realpath(outside), 'other');
  const configured = [
    // 根目录在工作区内、没有标记文件，但用户显式配置了它。
    { id: 'gopls', command: process.execPath, args: [], languages: { go: ['.go'] }, roots: ['svc'] },
    // 根目录在工作区外：LSP 属于项目而不是会话，因此照样诊断，并标注目标目录来源。
    { id: 'rust-analyzer', command: process.execPath, args: [], languages: { rust: ['.rs'] }, roots: [outsideRoot] },
    // 非 catalog 的自定义服务器：只做命令层面的诊断。
    { id: 'my-custom-lsp', command: process.execPath, args: ['--stdio'], languages: { custom: ['.x'] }, roots: ['svc'] },
    // 既没有显式根目录、工作区里也没有该项目标记：无从评估，不补条目。
    { id: 'pyright', command: process.execPath, args: [], languages: { python: ['.py'] } },
  ];
  const diagnosis = await diagnoseWorkspace({ workspace, configured });
  const byId = new Map(diagnosis.servers.map(entry => [entry.serverId, entry]));
  assert.equal(byId.has('pyright'), false, '无根目录且工作区无标记时不补条目');

  const gopls = byId.get('gopls');
  assert.ok(gopls, '工作区内的显式配置会补出条目');
  assert.equal(gopls.status, 'ready');
  assert.equal(gopls.commandSource, 'config');
  assert.equal(gopls.target, join(await realpath(workspace), 'svc'));
  assert.equal(gopls.targetSource, 'config');

  const rust = byId.get('rust-analyzer');
  assert.ok(rust, '工作区外的项目根目录同样得到状态');
  assert.equal(rust.target, outsideRoot, '目标目录来自配置');
  assert.equal(rust.targetSource, 'config');
  assert.equal(rust.status, 'ready');

  const custom = byId.get('my-custom-lsp');
  assert.ok(custom, '自定义服务器同样补出条目');
  assert.equal(custom.language, 'custom');
  assert.equal(custom.install.available, false);
  assert.equal(custom.install.reason, 'no-portable-installer');
});

test('lsp_setup：参数白名单，以及 auto/install/configure 的成功、降级与失败路径', async () => {
  // 参数只接受 catalog 语义的少量字段。
  assert.doesNotThrow(() => validateSetupArgs({ operation: 'status' }));
  assert.doesNotThrow(() => validateSetupArgs({ operation: 'auto', apply: true, languages: 'go, python' }));
  assert.throws(() => validateSetupArgs({ operation: 'delete' }), /unknown setup operation/);
  assert.throws(() => validateSetupArgs({ operation: 'status', command: 'rm -rf /' }), /unknown argument/);
  assert.throws(() => validateSetupArgs({ operation: 'status', apply: 'yes' }), /apply must be a boolean/);
  assert.throws(() => validateSetupArgs({ operation: 'install', apply: true }), /explicit server/);

  // auto + apply 会依次安装、配置并真实验证，且写入 readback 校验通过的配置。
  const appliedHarness = setupHarness({ servers: installed => [tsEntry(installed)] });
  const appliedResult = await runSetup({
    operation: 'auto', args: { operation: 'auto', apply: true, server: 'typescript-language-server' },
    workspace: '/ws', config: { install: { enabled: true } }, scope: appliedHarness.scope,
    diagnose: appliedHarness.diagnose, install: appliedHarness.install, probe: appliedHarness.probe,
  });
  assert.deepEqual(appliedHarness.events.map(event => event.type), ['install', 'probe']);
  assert.equal(appliedResult.installed[0].ok, true);
  assert.equal(appliedResult.configured.written, true);
  assert.deepEqual(appliedResult.configured.servers, ['typescript-language-server']);
  assert.equal(appliedResult.verification[0].ok, true);
  assert.equal(appliedHarness.writes.length, 1);
  const written = JSON.parse(appliedHarness.writes[0].configJson);
  assert.equal(written.servers.length, 1);
  assert.equal(written.servers[0].initializationOptions.tsserver.path, '/prefix/typescript-language-server/node_modules/typescript/lib/tsserver.js');
  assert.equal(appliedResult.status.servers[0].status, 'ready');

  // 不带 apply 时 auto 只诊断，绝不执行安装命令。
  const dryHarness = setupHarness({ servers: () => [tsEntry(false)] });
  const dryResult = await runSetup({
    operation: 'auto', args: { operation: 'auto' }, workspace: '/ws', config: { install: { enabled: true } }, scope: dryHarness.scope,
    diagnose: dryHarness.diagnose, install: dryHarness.install, probe: dryHarness.probe,
  });
  assert.deepEqual(dryHarness.events, []);
  assert.deepEqual(dryResult.installed, []);
  assert.equal(dryResult.configured.written, false);
  assert.match(dryResult.configured.reason, /运行组件/);
  assert.equal(dryResult.verification[0].ok, false);

  // install 不带 apply 只返回计划；未知 server 直接拒绝。
  const planHarness = setupHarness({ servers: () => [tsEntry(false)] });
  const planResult = await runSetup({
    operation: 'install', args: { operation: 'install', server: 'typescript-language-server' },
    workspace: '/ws', config: { install: { enabled: true } }, scope: planHarness.scope,
    diagnose: planHarness.diagnose, install: planHarness.install, probe: planHarness.probe,
  });
  assert.deepEqual(planHarness.events, []);
  assert.equal(planResult.installPlan.length, 1);
  assert.equal(planResult.installPlan[0].available, true);
  assert.match(planResult.nextActions.join('\n'), /apply=true/);

  await assert.rejects(runSetup({
    operation: 'status', args: { operation: 'status', server: 'gopls' },
    workspace: '/ws', config: { install: { enabled: true } }, scope: planHarness.scope,
    diagnose: planHarness.diagnose, install: planHarness.install, probe: planHarness.probe,
  }), /未发现服务器/);

  // 安装失败与配置写入失败都会被如实报告，不会假装成功。
  const failing = setupHarness({ servers: installed => [tsEntry(installed)] });
  failing.install = async () => { throw Object.assign(new Error('安装命令失败（退出码 1）'), { installSteps: [{ file: '/bin/npm', args: ['install'], code: 1 }] }); };
  const failed = await runSetup({
    operation: 'auto', args: { operation: 'auto', apply: true, server: 'typescript-language-server' },
    workspace: '/ws', config: { install: { enabled: true } }, scope: failing.scope,
    diagnose: failing.diagnose, install: failing.install, probe: failing.probe,
  });
  assert.equal(failed.installed[0].ok, false);
  assert.match(failed.installed[0].error, /退出码 1/);
  assert.equal(failed.verification[0].ok, false);
  assert.equal(failing.writes.length, 0);

  const readback = setupHarness({ servers: () => [tsEntry(true)] });
  readback.scope.get = () => ({ configJson: '{"servers":[{"id":"other"}]}' });
  const mismatch = await runSetup({
    operation: 'configure', args: { operation: 'configure', server: 'typescript-language-server' },
    workspace: '/ws', config: { install: { enabled: true } }, scope: readback.scope,
    diagnose: readback.diagnose, install: readback.install, probe: readback.probe,
  });
  assert.equal(readback.writes.length, 1, '写入确实发生，但因读回不一致必须报失败');
  assert.equal(mismatch.configured.written, false);
  assert.match(mismatch.configured.error, /读回值不一致/);

  // 没有 settings 服务时明确拒绝写配置并给出原因。
  const noScopeHarness = setupHarness({ servers: installed => [tsEntry(installed)] });
  const noScopeResult = await runSetup({
    operation: 'auto', args: { operation: 'auto', apply: true, server: 'typescript-language-server' },
    workspace: '/ws', config: { install: { enabled: true } }, scope: null,
    diagnose: noScopeHarness.diagnose, install: noScopeHarness.install, probe: noScopeHarness.probe,
  });
  assert.equal(noScopeResult.configured.written, false);
  assert.match(noScopeResult.configured.error, /settings/);
});

/** 构造一个可注入的 runSetup 环境。 */
function setupHarness({ servers, needsInstall = true }) {
  const events = [];
  let installedOnce = false;
  const diagnose = async () => ({
    version: 1, workspace: '/ws', complete: true, truncationReasons: [], projects: [],
    install: { enabled: true, directory: '/prefix' },
    servers: servers(installedOnce),
    nextActions: [],
  });
  const install = async (plan) => {
    events.push({ type: 'install', steps: plan.steps });
    installedOnce = true;
    return { ok: true, kind: plan.kind, prefix: plan.prefix, binaryPath: plan.binaryPath, packages: plan.packages, steps: plan.steps.map(step => ({ file: step.file, args: step.args, code: 0 })) };
  };
  const probe = async () => { events.push({ type: 'probe' }); return { root: '/ws', folders: ['/ws'], serverInfo: { name: 'fake' }, capabilities: ['hoverProvider'] }; };
  const writes = [];
  let current = '{\n  "servers": []\n}';
  const scope = {
    get: () => ({ configJson: current }),
    update: async patch => { writes.push(patch); current = patch.configJson; },
    watch: () => () => {},
    replace: async () => {},
  };
  return { diagnose, install, probe, scope, events, writes, needsInstall };
}

const tsEntry = (installed = false) => ({
  serverId: 'typescript-language-server', language: 'tsjs', status: installed ? 'ready' : 'missing-dependency',
  command: installed ? '/prefix/typescript-language-server/node_modules/.bin/typescript-language-server' : null,
  candidates: [], roots: ['/ws'], args: ['--stdio'], languages: { typescript: ['.ts'] }, rootMarkers: ['package.json'],
  dependencies: [{ id: 'typescript-sdk', description: 'TypeScript SDK', satisfied: installed, resolvedPath: installed ? '/prefix/typescript-language-server/node_modules/typescript' : null }],
  install: { available: true, kind: 'npm', manager: { name: 'npm' }, prefix: '/prefix/typescript-language-server', packages: ['typescript', 'typescript-language-server'], steps: [{ file: '/bin/npm', args: ['install', '--prefix', '/prefix/typescript-language-server', 'typescript', 'typescript-language-server'] }] },
  ...(installed ? { initializationOptions: { tsserver: { path: '/prefix/typescript-language-server/node_modules/typescript/lib/tsserver.js' } } } : {}),
});