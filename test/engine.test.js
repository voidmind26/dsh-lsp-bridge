import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LspManager } from '../src/engine.js';
const mock = fileURLToPath(new URL('./mock-server.js', import.meta.url));
async function fixture(t, overrides = {}) {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'dsh-lsp-test-')));
  for (const dir of ['a', 'b']) {
    await mkdir(join(workspace, dir));
    await writeFile(join(workspace, dir, 'project.json'), '{}');
    await writeFile(join(workspace, dir, 'main.mock'), 'hello 中文');
  }
  const manager = new LspManager({ timeoutMs: 1000, servers: [{ id: 'mock', command: process.execPath, args: [mock], languages: { mock: ['.mock'] }, rootMarkers: ['project.json'], ...overrides }] });
  t.after(async () => { await manager.dispose(); await rm(workspace, { recursive: true, force: true }); });
  return { workspace, manager, run: args => manager.execute(args, { workspace }) };
}
const hover = file => ({ operation: 'hover', file, line: 1, character: 1 });
test('nearest project roots, UTF-16 positions, unicode and disk synchronization', async t => {
  const { run, workspace } = await fixture(t);
  const first = JSON.parse((await run({ ...hover('a/main.mock'), character: 3 })).contents.value);
  assert.equal(first.rootUri, pathToFileURL(join(workspace, 'a')).href);
  assert.deepEqual(first.position, { line: 0, character: 2 });
  assert.equal(first.unicode, '中文');
  await writeFile(join(workspace, 'a/main.mock'), 'changed');
  assert.equal(JSON.parse((await run(hover('a/main.mock'))).contents.value).text, 'changed');
  assert.equal(JSON.parse((await run(hover('b/main.mock'))).contents.value).rootUri, pathToFileURL(join(workspace, 'b')).href);
});
test('协议查询：定义/符号/诊断，以及显式 roots 与 workspaceFolders 进入 initialize', async t => {
  const { run } = await fixture(t);
  assert.equal((await run({ ...hover('a/main.mock'), operation: 'definition' }))[0].range.start.line, 0);
  assert.equal((await run({ operation: 'documentSymbols', file: 'a/main.mock' }))[0].name, 'Example');
  const diagnostics = await run({ operation: 'diagnostics', file: 'a/main.mock' });
  assert.equal(diagnostics.source, 'pull');
  assert.equal(diagnostics.diagnostics[0].message, 'mock diagnostic');

  const explicit = await fixture(t, { roots: ['a', 'b'], workspaceFolders: ['a', 'b'] });
  const result = JSON.parse((await explicit.run(hover('a/main.mock'))).contents.value);
  assert.deepEqual(result.folders.map(x => x.uri).sort(), ['a', 'b'].map(x => pathToFileURL(join(explicit.workspace, x)).href).sort());
});
test('工作区符号按覆盖范围自动选择服务器，只有都覆盖时才要求指定', async t => {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'dsh-lsp-symbol-')));
  await writeFile(join(workspace, 'project.json'), '{}');
  await writeFile(join(workspace, 'sample.mock'), 'hello');
  const inside = { id: 'inside', command: process.execPath, args: [mock], languages: { mock: ['.mock'] }, rootMarkers: ['project.json'] };
  // 项目根目录在本工作区之外：不覆盖本工作区。
  const outside = { id: 'outside', command: process.execPath, args: [mock], languages: { other: ['.other'] }, roots: ['/nonexistent-outside-project'] };
  const single = new LspManager({ timeoutMs: 1000, servers: [inside, outside] });
  const both = new LspManager({ timeoutMs: 1000, servers: [inside, { ...inside, id: 'inside-two' }] });
  t.after(async () => { await single.dispose(); await both.dispose(); await rm(workspace, { recursive: true, force: true }); });

  const symbols = await single.execute({ operation: 'workspaceSymbols', query: 'Example' }, { workspace });
  assert.equal(symbols[0].name, 'Example', '只有一个服务器覆盖本工作区时自动选中');
  // 冷实例必须先建立项目：预热会打开项目内匹配语言的文件。
  const status = await single.execute({ operation: 'status' }, { workspace });
  assert.ok(status.instances[0].documents >= 1, '工作区符号前会预热至少一个文件');

  await assert.rejects(both.execute({ operation: 'workspaceSymbols', query: 'Example' }, { workspace }), /Multiple language servers match; specify server: inside, inside-two/);
  const explicit = await both.execute({ operation: 'workspaceSymbols', query: 'Example', server: 'inside-two' }, { workspace });
  assert.equal(explicit[0].name, 'Example', '显式指定时始终按指定服务器查询');
});

test('写入操作：dry-run 不改盘，apply 真正落盘，只读与工作区外按权限拒绝', async t => {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'dsh-lsp-write-')));
  await writeFile(join(workspace, 'main.mock'), 'original name\n');
  await writeFile(join(workspace, 'other.mock'), 'other file\n');
  const records = join(workspace, 'opens.txt');
  await writeFile(records, '');
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'dsh-lsp-outside-')));
  await writeFile(join(outside, 'other.mock'), 'outside name\n');
  const server = { id: 'mock', command: process.execPath, args: [mock, `--record-opens=${records}`], languages: { mock: ['.mock'] }, rootMarkers: [] };
  const deny = new LspManager({ timeoutMs: 1000, servers: [server], writeMode: 'deny' });
  const scoped = new LspManager({ timeoutMs: 1000, servers: [server], writeMode: 'workspace' });
  const full = new LspManager({ timeoutMs: 1000, servers: [server], writeMode: 'full' });
  t.after(async () => { await Promise.all([deny.dispose(), scoped.dispose(), full.dispose()]); await rm(workspace, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); });

  // 只读会话：写入操作直接拒绝，并说明需要完全访问权限。
  await assert.rejects(deny.execute({ operation: 'rename', file: 'main.mock', line: 1, character: 1, newName: 'renamed', apply: true }, { workspace }), /只读权限/);

  // dry-run 只给计划，不动磁盘。
  const planned = await scoped.execute({ operation: 'rename', file: 'main.mock', line: 1, character: 1, newName: 'renamed' }, { workspace });
  assert.equal(planned.applied, false);
  assert.equal(planned.dryRun, true);
  assert.equal(planned.files[0].changed, true);
  assert.equal(await readFile(join(workspace, 'main.mock'), 'utf8'), 'original name\n');

  // apply 真正写入。
  const applied = await scoped.execute({ operation: 'rename', file: 'main.mock', line: 1, character: 1, newName: 'renamed', apply: true }, { workspace });
  assert.equal(applied.applied, true);
  assert.equal(await readFile(join(workspace, 'main.mock'), 'utf8'), 'renamed name\n');
  // rename 前必须预热项目，否则服务器看不到引用目标符号的其它文件，跨文件改名会改坏代码。
  // 这里直接断言 mock 记录到的 didOpen：必须包含目标文件之外的其它文件。
  const opened = await readFile(records, 'utf8');
  assert.match(opened, /main\.mock/, '预热与请求会打开目标文件');
  assert.match(opened, /other\.mock/, 'rename 会预热项目内的其它文件');

  // 工作区外的目标：无论权限如何都不越界，并说明工作区边界。
  await assert.rejects(full.applyEdit({
    workspace,
    dryRun: false,
    edit: { changes: { [pathToFileURL(join(outside, 'other.mock')).href]: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 7 } }, newText: 'changed' }] } },
  }), /工作区之外|不在会话工作区内/);
  assert.equal(await readFile(join(outside, 'other.mock'), 'utf8'), 'outside name\n');

  // 多文件批次是“全或无”：第二个目标越界时，第一个文件也不能被写入。
  const beforeBatch = await readFile(join(workspace, 'main.mock'), 'utf8');
  await assert.rejects(full.applyEdit({
    workspace,
    dryRun: false,
    edit: { documentChanges: [
      { textDocument: { uri: pathToFileURL(join(workspace, 'main.mock')).href }, edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: 'Z' }] },
      { textDocument: { uri: pathToFileURL(join(outside, 'other.mock')).href }, edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: 'Z' }] },
    ] },
  }), /工作区之外|不在会话工作区/);
  assert.equal(await readFile(join(workspace, 'main.mock'), 'utf8'), beforeBatch, '规划阶段发现越界时不得写入任何文件');

  // 服务器主动请求应用编辑：只读会话回传原因而不是静默失败。
  const refused = await deny.applyServerEdit({ changes: { [pathToFileURL(join(workspace, 'main.mock')).href]: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: 'X' }] } }, workspace);
  assert.equal(refused.applied, false);
  assert.match(refused.failureReason, /完全访问权限/);
});

test('服务器发起的 applyEdit：可写会话真正落盘，探针与只读会话一律不写入', async t => {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'dsh-lsp-apply-')));
  const target = join(workspace, 'target.mock');
  const original = 'BEFORE text\n';
  await writeFile(target, original);
  // mock 在 initialize 阶段请求 applyEdit，并等它的响应到达后才回复 initialize，
  // 因此 initialize 返回即代表写入路径已经走完，无需 sleep 等待。
  const server = { id: 'mock', command: process.execPath, args: [mock, `--edit-target=${target}`], languages: { mock: ['.mock'] }, rootMarkers: [] };
  t.after(async () => { await rm(workspace, { recursive: true, force: true }); });

  // 可写会话：服务器请求的编辑被应用。
  const writable = new LspManager({ timeoutMs: 5000, servers: [server], writeMode: 'workspace' });
  try {
    await writable.execute({ operation: 'documentSymbols', file: 'target.mock' }, { workspace });
    assert.equal(await readFile(target, 'utf8'), 'SERVER EDIT text\n', '服务器发起的编辑应落盘');
  } finally { await writable.dispose(); }

  // 只读会话：同一请求被拒绝，文件保持原样。
  await writeFile(target, original);
  const readOnly = new LspManager({ timeoutMs: 5000, servers: [server], writeMode: 'deny' });
  try {
    await readOnly.execute({ operation: 'documentSymbols', file: 'target.mock' }, { workspace });
    assert.equal(await readFile(target, 'utf8'), original, '只读会话不得写入');
  } finally { await readOnly.dispose(); }

  // 验证探针永远只读：即使服务器在 initialize 阶段请求写入也不改文件。
  const { probeLanguageServer } = await import('../src/engine.js');
  await probeLanguageServer({ server, workspace, timeoutMs: 5000 });
  assert.equal(await readFile(target, 'utf8'), original, '探针不得写入');
});

test('受限会话下 confine 包装真实 argv，并向服务器注入缓存环境', async t => {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'dsh-lsp-confine-')));
  await writeFile(join(workspace, 'main.mock'), 'hello');
  const confined = [];
  const manager = new LspManager({
    timeoutMs: 1000,
    servers: [{ id: 'mock', command: process.execPath, args: [mock], languages: { mock: ['.mock'] }, rootMarkers: [] }],
    // 沙箱包装：记录收到的 argv 后原样返回（真实实现返回 sandbox-exec 前缀的 argv）。
    confine: argv => { confined.push(argv); return argv; },
    sandboxEnv: { GOCACHE: '/tmp/dsh-lsp-bridge' },
  });
  t.after(async () => { await manager.dispose(); await rm(workspace, { recursive: true, force: true }); });
  const hover = await manager.execute({ operation: 'hover', file: 'main.mock', line: 1, character: 1 }, { workspace });
  assert.equal(JSON.parse(hover.contents.value).text, 'hello');
  assert.deepEqual(confined, [[process.execPath, mock]], 'confine 收到的是即将执行的完整 argv');
});

test('push-only diagnostics wait for asynchronous notification', async t => {
  const { run } = await fixture(t, { args: [mock, '--push'] });
  const result = await run({ operation: 'diagnostics', file: 'a/main.mock' });
  assert.equal(result.source, 'push');
  assert.equal(result.pending, false);
  assert.equal(result.diagnostics[0].message, 'push diagnostic');
});
test('失败与边界：路径穿越/符号链接/非法位置/未知服务器、超时、缺少可执行文件与服务器崩溃', async t => {
  const { run, workspace } = await fixture(t);
  const outside = await mkdtemp(join(tmpdir(), 'dsh-lsp-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, 'outside.mock'), 'secret');
  await symlink(outside, join(workspace, 'escape'));
  await assert.rejects(run(hover(join(outside, 'outside.mock'))));
  await assert.rejects(run(hover('escape/outside.mock')));
  await assert.rejects(run({ ...hover('a/main.mock'), line: 0 }));
  await assert.rejects(run({ ...hover('a/main.mock'), server: 'missing' }));

  const timeoutFixture = await fixture(t);
  await writeFile(join(timeoutFixture.workspace, 'a/main.mock'), 'HANG');
  await assert.rejects(timeoutFixture.run(hover('a/main.mock')), /timed? ?out|timeout/i);

  const missingFixture = await fixture(t, { command: '/nonexistent/dsh-lsp-server' });
  await assert.rejects(missingFixture.run(hover('a/main.mock')), /ENOENT|spawn|start|executable/i);

  const crashFixture = await fixture(t);
  await writeFile(join(crashFixture.workspace, 'a/main.mock'), 'CRASH');
  await assert.rejects(crashFixture.run(hover('a/main.mock')));
});