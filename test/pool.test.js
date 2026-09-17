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

test('空闲过期释放引擎并在下次请求重建', async t => {
  const { pool, managers, call } = setup(t);
  const session = {};
  await call(session);
  const entry = [...pool.entries][0];
  entry.lastUsed = 0;
  pool.sweep();
  await entry.closing;
  assert.equal(managers[0].disposed, true);
  await call(session);
  assert.equal(managers.length, 2);
});

test('池容量满时回收最久空闲会话', async t => {
  const { managers, call } = setup(t);
  await call({});
  await call({});
  assert.equal(managers.length, 2);
  assert.equal(managers[0].disposed, true);
});

test('活动请求不被空闲回收且满载拒绝新会话', async t => {
  const { pool, managers, call } = setup(t);
  const session = {};
  await call(session);
  let release;
  managers[0].execute = () => new Promise(resolve => { release = resolve; });
  const pending = call(session);
  await Promise.resolve();
  const entry = [...pool.entries][0];
  entry.lastUsed = 0;
  pool.sweep();
  assert.equal(entry.retired, false);
  await assert.rejects(call({}), /limit/);
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
