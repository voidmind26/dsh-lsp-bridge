import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, validateArgs, validateConfig, Config } from '../src/index.js';

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
