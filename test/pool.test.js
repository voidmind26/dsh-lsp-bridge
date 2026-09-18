import test from 'node:test';
import assert from 'node:assert/strict';
import { LspSessionPool } from '../src/pool.js';

function setup(t, maxSessions = 1) {
  const managers = [];
  const pool = new LspSessionPool({ idleTimeoutMs: 60000, maxSessions }, () => ({ mode: 'danger-full-access' }), () => {
    const manager = { disposed: false, async execute() { return managers.length; }, async dispose() { this.disposed = true; } };
    managers.push(manager);
    return manager;
  });
  t.after(() => pool.dispose());
  return { pool, managers, call: (session, args = {}) => pool.execute(args, { session, workspace: '/test' }) };
}

test('池生命周期：空闲回收与重建、容量回收、活动请求不受回收且满载拒绝', async t => {
  // 空闲过期后释放引擎，下次请求重建。
  const idle = setup(t);
  const idleSession = {};
  await idle.call(idleSession);
  const entry = [...idle.pool.entries][0];
  entry.lastUsed = 0;
  idle.pool.sweep();
  await entry.closing;
  assert.equal(idle.managers[0].disposed, true);
  await idle.call(idleSession);
  assert.equal(idle.managers.length, 2);

  // 池容量满时回收最久空闲会话。
  const capacity = setup(t);
  await capacity.call({});
  await capacity.call({});
  assert.equal(capacity.managers.length, 2);
  assert.equal(capacity.managers[0].disposed, true);

  // 活动请求不被空闲回收，且满载时拒绝新会话。
  const active = setup(t);
  const activeSession = {};
  await active.call(activeSession);
  let release;
  active.managers[0].execute = () => new Promise(resolve => { release = resolve; });
  const pending = active.call(activeSession);
  await Promise.resolve();
  const activeEntry = [...active.pool.entries][0];
  activeEntry.lastUsed = 0;
  active.pool.sweep();
  assert.equal(activeEntry.retired, false);
  await assert.rejects(active.call({}), /limit/);
  release('done');
  assert.equal(await pending, 'done');
});

test('权限周期复查无需新工具调用即可回收', async t => {
  const { pool, managers, call } = setup(t);
  await call({});
  pool.resolvePolicy = () => ({ mode: 'workspace-write' });
  pool.sweep();
  await [...pool.entries][0].closing;
  assert.equal(managers[0].disposed, true);
});
