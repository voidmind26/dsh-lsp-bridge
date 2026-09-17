import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, validateArgs, validateConfig, Config, SETTINGS_NAMESPACE } from '../src/index.js';

test('configuration validation and Standard Schema contract', () => {
  assert.equal(validateConfig({}).servers.length, 0);
  assert.ok(Config['~standard'].validate({ unexpected: true }).issues);
  assert.throws(() => validateConfig({ servers: [{ id: 'a', command: 'a', languages: {} }] }));
  assert.throws(() => validateArgs({ operation: 'hover', file: 'x.go', line: 0, character: 1 }));
  assert.equal(validateArgs({ operation: 'hover', file: 'x.go', line: 1, character: 1 }).line, 1);
});

test('adapter registers raw DSH tool and denies restricted execution', async () => {
  let tool, cleanup;
  const ctx = {
    tools: { register: value => { tool = value; } },
    sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) },
    effect: factory => { cleanup = factory(); },
  };
  apply(ctx, {});
  assert.equal(tool.name, 'lsp');
  assert.deepEqual(tool.parameters.required, ['operation']);
  await assert.rejects(tool.execute({ operation: 'status' }, { agent: { session: { header: { cwd: process.cwd() } } } }), /denied|restricted/i);
  await cleanup();
});

test('full access status produces schema-compatible output and bounded rendering', async () => {
  let tool, cleanup;
  const ctx = {
    tools: { register: value => { tool = value; } },
    sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access' }) },
    effect: factory => { cleanup = factory(); },
  };
  apply(ctx, { maxOutputChars: 256, servers: [{ id: 'x'.repeat(500), command: 'not-started', languages: { example: ['.example'] } }] });
  const result = await tool.execute({ operation: 'status' }, { agent: { session: { header: { cwd: process.cwd() } } } });
  assert.equal(result.truncated, true);
  assert.ok(result.json.length <= 256);
  assert.doesNotThrow(() => JSON.parse(result.json));
  assert.equal(tool.output.render({}, result)[0].type, 'text');
  await cleanup();
});

test('settings 保存前拒绝无效 JSON，保存后替换工具使用的 pool', async () => {
  let tool, settingsRegistration, watcher;
  const cleanups = [];
  const ctx = {
    tools: { register: value => { tool = value; } },
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
