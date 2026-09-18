import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath } from 'node:fs/promises';
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