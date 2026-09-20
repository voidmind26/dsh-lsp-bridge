import test from 'node:test';
import assert from 'node:assert/strict';
import { LspSessionPool } from '../src/pool.js';

function setup(t, maxSessions = 1, mode = { value: 'danger-full-access' }) {
  const managers = [];
  const plans = [];
  const pool = new LspSessionPool({ idleTimeoutMs: 60000, maxSessions }, () => ({ mode: mode.value }), {
    // 受限会话需要沙箱后端；这里用直通包装（DSH 契约：返回 { argv }），只验证执行计划与生命周期。
    sandboxConfine: argv => ({ argv }),
    hasSandbox: () => true,
    createManager: value => {
      plans.push(value.writeMode);
      const manager = { disposed: false, async execute() { return managers.length; }, async dispose() { this.disposed = true; } };
      managers.push(manager);
      return manager;
    },
  });
  t.after(() => pool.dispose());
  return { pool, managers, plans, mode, call: (session, args = {}) => pool.execute(args, { session, workspace: '/test' }) };
}

test('没有可用沙箱后端时，受限会话在创建实例之前就失败关闭', async t => {
  const created = [];
  const pool = new LspSessionPool({ idleTimeoutMs: 60000, maxSessions: 1 }, () => ({ mode: 'workspace-write' }), {
    sandboxConfine: argv => ({ argv }),
    hasSandbox: () => false,
    createManager: () => { created.push(true); throw new Error('不应创建实例'); },
  });
  t.after(() => pool.dispose());
  await assert.rejects(pool.execute({}, { session: {}, workspace: '/test' }), (error) => {
    assert.equal(error.code, 'SANDBOX_UNAVAILABLE', '失败关闭必须带稳定错误码');
    assert.match(error.message, /sandbox backend/);
    return true;
  });
  assert.deepEqual(created, [], '拒绝时不得创建任何实例');

  // 沙箱服务返回非法 argv（例如忘了返回 { argv }）时必须拒绝，而不是把坏 argv 交给 spawn。
  const bogus = new LspSessionPool({ idleTimeoutMs: 60000, maxSessions: 1 }, () => ({ mode: 'workspace-write' }), {
    sandboxConfine: () => ({}),
    hasSandbox: () => true,
    // 由假 manager 真正调用池传入的 confine，才能触发解包与校验。
    createManager: value => ({ disposed: false, async execute() { value.confine(['/bin/x']); return null; }, async dispose() {} }),
  });
  t.after(() => bogus.dispose());
  await assert.rejects(bogus.execute({}, { session: {}, workspace: '/test' }), /非法的 argv/);

  // 完全没有 confine 函数时同样拒绝。
  const bare = new LspSessionPool({ idleTimeoutMs: 60000, maxSessions: 1 }, () => ({ mode: 'read-only' }), {
    createManager: () => { created.push(true); return {}; },
  });
  t.after(() => bare.dispose());
  await assert.rejects(bare.execute({}, { session: {}, workspace: '/test' }), /sandbox backend/);
  assert.deepEqual(created, []);
});

test('权限模式变化会换掉实例，不让旧执行计划继续生效', async t => {
  const mode = { value: 'danger-full-access' };
  const { pool, managers, plans, call } = setup(t, 1, mode);
  const session = {};
  await call(session);
  assert.deepEqual(plans, ['full'], '完全访问下创建的实例不带写入限制');

  // 收紧到 workspace-write：轮询兜底路径（没有 session/event）也必须换实例。
  mode.value = 'workspace-write';
  for (const entry of pool.entries) entry.lastUsed = 0;
  pool.sweep();
  await Promise.resolve();
  await call(session);
  assert.equal(managers[0].disposed, true, '旧实例被退休');
  assert.deepEqual(plans, ['full', 'workspace'], '新实例按新权限创建');

  // 再收紧到 read-only：写入模式必须变成 deny。
  mode.value = 'read-only';
  for (const entry of pool.entries) entry.lastUsed = 0;
  pool.sweep();
  await Promise.resolve();
  await call(session);
  assert.deepEqual(plans, ['full', 'workspace', 'deny']);
});

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
