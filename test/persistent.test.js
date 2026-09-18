import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apply } from '../src/index.js';

async function fixture(t, options = {}) {
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-lsp-pool-'));
  await writeFile(join(workspace, 'main.mock'), 'hello');
  let tool, cleanup, mode = 'danger-full-access';
  const handlers = new Map();
  const ctx = {
    // 插件现在注册 lsp 与 lsp_setup 两个工具；这里只固定取只读的 lsp。
    tools: { register(value) { if (value.name === 'lsp') tool = value; } },
    sandboxPolicy: { resolve() { return { mode }; } },
    effect(factory) { cleanup = factory(); },
    on(event, handler) { handlers.set(event, handler); return () => handlers.delete(event); },
  };
  apply(ctx, { timeoutMs: 1000, servers: [{ id: 'mock', command: process.execPath, args: [fileURLToPath(new URL('./mock-server.js', import.meta.url))], languages: { mock: ['.mock'] }, rootMarkers: [] }], ...options });
  assert.ok(tool, '必须注册只读 lsp 工具');
  const session = { id: 'session-a', header: { cwd: workspace } };
  const run = async (args, target = session) => JSON.parse((await tool.execute(args, { agent: { session: target } })).json);
  const hover = async (target = session) => JSON.parse((await run({ operation: 'hover', file: 'main.mock', line: 1, character: 1 }, target)).contents.value);
  t.after(async () => { await cleanup(); await rm(workspace, { recursive: true, force: true }); });
  return { workspace, run, hover, session, cleanup, handlers, restrict() { mode = 'workspace-write'; }, allow() { mode = 'danger-full-access'; } };
}

test('会话常驻：跨调用复用与文件同步、不同会话隔离', async t => {
  const f = await fixture(t);
  const first = await f.hover();
  await writeFile(join(f.workspace, 'main.mock'), 'updated');
  const second = await f.hover();
  assert.equal(first.pid, second.pid);
  assert.equal(second.text, 'updated');
  assert.equal((await f.run({ operation: 'status' })).instances.length, 1);
  const a = await f.hover();
  const b = await f.hover({ id: 'session-b', header: { cwd: f.workspace } });
  assert.notEqual(a.pid, b.pid);
});

test('权限收紧：拒绝新调用并通过事件立即清理', async t => {
  const f = await fixture(t);
  const original = await f.hover();
  f.restrict();
  await assert.rejects(f.hover());
  f.allow();
  assert.notEqual((await f.hover()).pid, original.pid);

  // 收紧权限后，即使没有新调用，sandbox/mode 事件也必须立即回收常驻进程。
  const before = await f.hover();
  f.restrict();
  await f.handlers.get('session/event')(f.session, { type: 'sandbox/mode', data: { mode: 'workspace-write' } });
  f.allow();
  assert.notEqual((await f.hover()).pid, before.pid);
});

test('会话释放与插件卸载的清理与拒绝', async t => {
  const f = await fixture(t);
  const first = await f.hover();
  await f.handlers.get('session/disposed')(f.session);
  const next = { id: 'session-a', header: { cwd: f.workspace } };
  assert.notEqual((await f.hover(next)).pid, first.pid);

  // 卸载后常驻进程被清理，后续调用必须被拒绝。
  await f.cleanup();
  await assert.rejects(f.hover());
});
