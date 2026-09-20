import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, validateArgs, validateConfig, Config, SETTINGS_NAMESPACE } from '../src/index.js';

test('配置校验、Standard Schema 契约与 settings 热替换', async () => {
  assert.equal(validateConfig({}).servers.length, 0);
  assert.ok(Config['~standard'].validate({ unexpected: true }).issues);
  assert.throws(() => validateConfig({ servers: [{ id: 'a', command: 'a', languages: {} }] }));
  assert.throws(() => validateArgs({ operation: 'hover', file: 'x.go', line: 0, character: 1 }));
  assert.equal(validateArgs({ operation: 'hover', file: 'x.go', line: 1, character: 1 }).line, 1);
  // 写入操作的参数约束：rename 需要 newName，apply/tabSize 类型受限。
  assert.equal(validateArgs({ operation: 'rename', file: 'x.js', line: 1, character: 1, newName: 'y', apply: true }).newName, 'y');
  assert.throws(() => validateArgs({ operation: 'rename', file: 'x.js', line: 1, character: 1 }), /rename requires newName/);
  assert.throws(() => validateArgs({ operation: 'format', file: 'x.js', apply: 'yes' }), /apply must be a boolean/);
  assert.throws(() => validateArgs({ operation: 'format', file: 'x.js', tabSize: 99 }), /tabSize/);

  let tool, settingsRegistration, watcher;
  const cleanups = [];
  const ctx = {
    tools: { register: value => { if (value.name === 'lsp') tool = value; } },
    sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access' }) },
    effect: factory => { cleanups.push(factory()); },
    inject: (services, callback) => {
      if (services.length !== 1 || services[0] !== 'settings') return;
      callback({
        settings: { register: (namespace, schema, options) => {
          settingsRegistration = { namespace, schema, options };
          const value = schema(options.base);
          return { get: () => value, watch: callback => { watcher = callback; return () => {}; } };
        } },
        effect: factory => { cleanups.push(factory()); },
      });
    },
  };
  apply(ctx, { maxOutputChars: 1000 });
  assert.equal(settingsRegistration.namespace, SETTINGS_NAMESPACE);
  assert.throws(() => settingsRegistration.options.validate({ configJson: '{"servers":[{"id":"x","command":"cwd","languages":{}}]}' }));
  await watcher({ configJson: JSON.stringify({ maxOutputChars: 256, servers: [{ id: 'x'.repeat(500), command: 'never-run', languages: { x: ['.x'] } }] }) });
  const result = await tool.execute({ operation: 'status' }, { agent: { session: { header: { cwd: process.cwd() } } } });
  assert.equal(result.truncated, true);
  await Promise.all(cleanups.filter(value => typeof value === 'function').map(value => value()));
});

test('工具注册：受限会话按沙箱可用性放行或失败关闭、全权限输出有界', async () => {
  // 没有沙箱后端：受限会话失败关闭，绝不退化成无沙箱启动。
  let tool, cleanup;
  const ctx = {
    tools: { register: value => { if (value.name === 'lsp') tool = value; } },
    sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) },
    effect: factory => { cleanup = factory(); },
  };
  apply(ctx, {});
  assert.equal(tool.name, 'lsp');
  assert.deepEqual(tool.parameters.required, ['operation']);
  await assert.rejects(tool.execute({ operation: 'status' }, { agent: { session: { header: { cwd: process.cwd() } } } }), /sandbox backend/);
  await cleanup();

  // 提供沙箱服务后，受限会话可以执行只读操作（进程启动由 confine 包装）。
  let confinedTool, confinedCleanup;
  const confinedCtx = {
    tools: { register: value => { if (value.name === 'lsp') confinedTool = value; } },
    sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) },
    effect: factory => { confinedCleanup = factory(); },
    inject: (services, callback) => {
      if (services.includes('sandbox')) callback({ sandbox: { confine: argv => argv } });
    },
  };
  apply(confinedCtx, { servers: [{ id: 'sample', command: 'not-started', languages: { example: ['.example'] } }] });
  const confined = await confinedTool.execute({ operation: 'status' }, { agent: { session: { header: { cwd: process.cwd() } } } });
  assert.equal(JSON.parse(confined.json).servers[0].id, 'sample');
  await confinedCleanup();

  let fullTool, fullCleanup;
  const fullCtx = {
    tools: { register: value => { if (value.name === 'lsp') fullTool = value; } },
    sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access' }) },
    effect: factory => { fullCleanup = factory(); },
  };
  apply(fullCtx, { maxOutputChars: 256, servers: [{ id: 'x'.repeat(500), command: 'not-started', languages: { example: ['.example'] } }] });
  const result = await fullTool.execute({ operation: 'status' }, { agent: { session: { header: { cwd: process.cwd() } } } });
  assert.equal(result.truncated, true);
  assert.ok(result.json.length <= 256);
  assert.doesNotThrow(() => JSON.parse(result.json));
  assert.equal(fullTool.output.render({}, result)[0].type, 'text');
  await fullCleanup();
});