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
test('definition, symbols and diagnostics use LSP protocol', async t => {
  const { run } = await fixture(t);
  assert.equal((await run({ ...hover('a/main.mock'), operation: 'definition' }))[0].range.start.line, 0);
  assert.equal((await run({ operation: 'documentSymbols', file: 'a/main.mock' }))[0].name, 'Example');
  const diagnostics = await run({ operation: 'diagnostics', file: 'a/main.mock' });
  assert.equal(diagnostics.source, 'pull');
  assert.equal(diagnostics.diagnostics[0].message, 'mock diagnostic');
});
test('push-only diagnostics wait for asynchronous notification', async t => {
  const { run } = await fixture(t, { args: [mock, '--push'] });
  const result = await run({ operation: 'diagnostics', file: 'a/main.mock' });
  assert.equal(result.source, 'push');
  assert.equal(result.pending, false);
  assert.equal(result.diagnostics[0].message, 'push diagnostic');
});
test('explicit roots and workspaceFolders reach initialize', async t => {
  const { run, workspace } = await fixture(t, { roots: ['a', 'b'], workspaceFolders: ['a', 'b'] });
  const result = JSON.parse((await run(hover('a/main.mock'))).contents.value);
  assert.deepEqual(result.folders.map(x => x.uri).sort(), ['a', 'b'].map(x => pathToFileURL(join(workspace, x)).href).sort());
});
test('reject traversal, symlink escape, invalid position and unknown server', async t => {
  const { run, workspace } = await fixture(t);
  const outside = await mkdtemp(join(tmpdir(), 'dsh-lsp-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, 'outside.mock'), 'secret');
  await symlink(outside, join(workspace, 'escape'));
  await assert.rejects(run(hover(join(outside, 'outside.mock'))));
  await assert.rejects(run(hover('escape/outside.mock')));
  await assert.rejects(run({ ...hover('a/main.mock'), line: 0 }));
  await assert.rejects(run({ ...hover('a/main.mock'), server: 'missing' }));
});
test('timeouts reject without hanging the manager', async t => {
  const { run, workspace } = await fixture(t);
  await writeFile(join(workspace, 'a/main.mock'), 'HANG');
  await assert.rejects(run(hover('a/main.mock')), /timed? ?out|timeout/i);
});
test('missing executable gives an actionable failure', async t => {
  const { run } = await fixture(t, { command: '/nonexistent/dsh-lsp-server' });
  await assert.rejects(run(hover('a/main.mock')), /ENOENT|spawn|start|executable/i);
});
test('server crash rejects outstanding requests', async t => {
  const { run, workspace } = await fixture(t);
  await writeFile(join(workspace, 'a/main.mock'), 'CRASH');
  await assert.rejects(run(hover('a/main.mock')));
});
