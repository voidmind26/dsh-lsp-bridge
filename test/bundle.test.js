import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { validateConfig, inject, apply } from '../src/index.js';

const root = new URL('../', import.meta.url);
test('Bundle 清单、产物入口与客户端发现回退路径', async () => {
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

  const require = createRequire(import.meta.url);
  const path = require.resolve('dsh-lsp-bridge/package.json');
  const resolvedPkg = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(resolvedPkg.name, 'dsh-lsp-bridge');
  assert.equal(resolvedPkg.dsh.client.platform, 'web');
  await access(new URL(resolvedPkg.exports['./client'], pathToFileURL(path)));
});

/** 组装一个最小宿主上下文，返回注册到的工具与清理函数。 */
function hostContext(mode = 'danger-full-access') {
  const tools = new Map();
  const handlers = new Map();
  let dispose = () => {};
  const ctx = {
    tools: { register(value) { tools.set(value.name, value); } },
    sandboxPolicy: { resolve() { return { mode }; } },
    effect(factory) { dispose = factory() ?? (() => {}); },
    on(name, fn) { handlers.set(name, fn); },
  };
  return { ctx, tools, handlers, dispose: () => dispose() };
}

for (const profile of ['web', 'desktop']) {
  test(`${profile} 宿主契约：工具注册、权限门控与 lsp_setup 只读状态`, async () => {
    const host = hostContext();
    assert.deepEqual(inject, ['tools', 'sandboxPolicy']);
    apply(host.ctx, validateConfig({ servers: [] }));
    try {
      assert.deepEqual([...host.tools.keys()].sort(), ['lsp', 'lsp_setup']);
      const exec = { agent: { session: { id: `${profile}-smoke`, header: { cwd: fileURLToPath(root) } } } };
      const result = await host.tools.get('lsp').execute({ operation: 'status' }, exec);
      assert.deepEqual(JSON.parse(result.json).servers, []);
      assert.ok(host.handlers.has('session/disposed'));
      // lsp_setup 的 status 只做只读诊断，不安装也不写配置。
      const setup = JSON.parse((await host.tools.get('lsp_setup').execute({ operation: 'status' }, exec)).json);
      assert.equal(setup.operation, 'status');
      assert.equal(setup.installed.length, 0);
      assert.equal(setup.configured, null);
      assert.equal(setup.install.enabled, true);
      assert.ok(Array.isArray(setup.status.servers));
    } finally { await host.dispose(); }

    const restrictedHost = hostContext('workspace-write');
    apply(restrictedHost.ctx, validateConfig({ servers: [] }));
    try {
      const exec = { agent: { session: { id: `${profile}-restricted`, header: { cwd: fileURLToPath(root) } } } };
      await assert.rejects(restrictedHost.tools.get('lsp_setup').execute({ operation: 'auto', apply: true }, exec), /danger-full-access/);
    } finally { await restrictedHost.dispose(); }
  });
}