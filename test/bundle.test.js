import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { validateConfig, inject, apply } from '../src/index.js';

const root = new URL('../', import.meta.url);
test('Bundle 清单包含可分发入口与挂载文件', async () => {
  const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
  assert.ok(pkg.files.includes('cordis.patch.yml'));
  assert.equal(pkg.exports['.'], `./${pkg.main}`);
  await access(new URL(pkg.main, root));
  const patch = await readFile(new URL(pkg.dsh.bundle.patch, root), 'utf8');
  assert.match(patch, /- insert:/);
  assert.match(patch, /id: lsp/);
  assert.match(patch, new RegExp(`name: ${pkg.name}`));
  assert.match(patch, /servers: \[\]/);
  assert.doesNotMatch(patch, /\/Users\/|\/Applications\/|profile:/);
  assert.equal(pkg.dsh.client.platform, 'web');
  assert.ok(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-settings'));
  assert.equal(pkg.exports['./client'], './lib/client.js');
  await access(new URL('lib/client.js', root));
  for (const key of ['preinstall', 'install', 'postinstall', 'prepare']) assert.equal(pkg.scripts[key], undefined);
  assert.ok(!Object.keys(pkg.dependencies ?? {}).some(name => name.startsWith('@deepseek-ai/')));
});

for (const profile of ['web', 'desktop']) {
  test(`${profile} 宿主契约使用相同 Bundle 配置与服务端工具`, async () => {
    let tool, dispose;
    const handlers = new Map();
    const ctx = {
      tools: { register(value) { tool = value; } },
      sandboxPolicy: { resolve() { return { mode: 'danger-full-access' }; } },
      effect(factory) { dispose = factory(); },
      on(name, fn) { handlers.set(name, fn); },
    };
    assert.deepEqual(inject, ['tools', 'sandboxPolicy']);
    apply(ctx, validateConfig({ servers: [] }));
    try {
      const result = await tool.execute({ operation: 'status' }, { agent: { session: { id: `${profile}-smoke`, header: { cwd: fileURLToPath(root) } } } });
      assert.equal(tool.name, 'lsp');
      assert.deepEqual(JSON.parse(result.json).servers, []);
      assert.ok(handlers.has('session/disposed'));
    } finally { await dispose(); }
  });
}
