import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const file = new URL('../src/client.js', import.meta.url);

async function loadPlugin({ fetch } = {}) {
  const source = await readFile(file, 'utf8');
  let registration;
  const fakeReact = {
    createElement(type, props, ...children) { return { type, props: props || {}, children }; },
    useEffect() {}, useMemo(fn) { return fn(); }, useRef(value) { return { current: value }; },
    useState(value) { return [value, () => {}]; }, useSyncExternalStore(_subscribe, snapshot) { return snapshot(); },
  };
  vm.runInNewContext(source, { fetch, structuredClone, window: { __ModuleLoader__: { load(value) { registration = value; } } } });
  return { plugin: registration.factory(name => { assert.equal(name, 'react'); return fakeReact; }), registration, source };
}

test('客户端产物遵循 ModuleLoader 契约并注册 keyed 设置卡片', async () => {
  const { plugin, registration, source } = await loadPlugin();
  assert.equal(registration.id, 'dsh-lsp-bridge');
  let slot;
  assert.deepEqual(Array.from(plugin.inject), ['slots', 'settingsScope']);
  plugin.apply({
    settingsScope: { bind({ namespace }) { assert.equal(namespace, 'dsh-lsp-bridge'); return {}; } },
    slots: {
      inject(name, factory) { assert.equal(name, 'settings.plugin.item'); factory(); },
      register(options, component) { slot = { options, component }; return () => {}; },
    },
  });
  assert.equal(slot.options.key, 'dsh-lsp-bridge');
  assert.equal(typeof slot.component, 'function');
  assert.match(source, /\/api\/dsh-lsp-bridge\/discovery/);
});

test('真实发现报告生成配置：ready 与人工候选生效，missing 跳过且按 id 合并', async () => {
  const { plugin } = await loadPlugin();
  const report = {
    projects: [{ language: 'go', root: '/repo/go', markers: ['go.mod'] }], executables: [], complete: true,
    plans: [
      { language: 'go', serverId: 'gopls', roots: ['/repo/go'], args: [], languages: { go: ['.go'] }, rootMarkers: ['go.mod'], status: 'ready', command: '/usr/bin/gopls' },
      { language: 'tsjs', serverId: 'typescript-language-server', roots: ['/repo/js'], args: ['--stdio'], languages: { typescript: ['.ts'] }, rootMarkers: ['package.json'], status: 'needs-choice', candidates: ['/a/tsls', '/b/tsls'] },
      { language: 'python', serverId: 'pyright', roots: ['/repo/py'], args: ['--stdio'], languages: { python: ['.py'] }, rootMarkers: ['pyproject.toml'], status: 'missing', installAdvice: 'npm i -g pyright' },
    ],
  };
  const current = JSON.stringify({ extra: 1, servers: [{ id: 'other', command: 'other' }, { id: 'gopls', command: 'old', env: { X: '1' } }] });
  const value = JSON.parse(plugin.testHelpers.suggestedConfig(report, current, { 'tsjs:typescript-language-server': '/b/tsls' }));
  assert.equal(value.extra, 1);
  assert.deepEqual(value.servers.map(server => server.id), ['other', 'gopls', 'typescript-language-server']);
  assert.equal(value.servers[1].command, '/usr/bin/gopls');
  assert.deepEqual(value.servers[1].env, { X: '1' }, '覆盖同 id 建议字段但保留未知现有字段');
  assert.equal(value.servers[2].command, '/b/tsls');
  assert.equal(value.servers.some(server => server.id === 'pyright'), false);
  assert.throws(() => plugin.testHelpers.suggestedConfig(report, '{bad'), /JSON/);
});

test('发现报告渲染项目、候选下拉和安装建议分支', async () => {
  const { plugin } = await loadPlugin();
  const report = {
    complete: false, executables: [{ serverId: 'x', path: '/x' }],
    projects: [{ language: 'tsjs', root: '/repo', markers: ['package.json'] }],
    plans: [
      { language: 'tsjs', serverId: 'tsls', status: 'needs-choice', candidates: ['/a', '/b'] },
      { language: 'python', serverId: 'pyright', status: 'missing', installAdvice: 'npm install --global pyright' },
    ],
  };
  const tree = plugin.testHelpers.DiscoveryReport({ report, choices: {}, onChoose() {} });
  const seen = [];
  (function walk(node) { if (node == null) return; if (typeof node === 'string') seen.push(node); else if (Array.isArray(node)) node.forEach(walk); else { seen.push(node.type); walk(node.children); } })(tree);
  assert.ok(seen.includes('select'));
  assert.ok(seen.some(value => typeof value === 'string' && value.includes('/repo')));
  assert.ok(seen.some(value => typeof value === 'string' && value.includes('npm install --global pyright')));
  assert.ok(seen.some(value => typeof value === 'string' && value.includes('扫描已截断')));
});

test('保存固定 revision 并核对最终快照，静默冲突也视为失败', async () => {
  const { plugin } = await loadPlugin();
  const text = '{"servers":[]}';
  let call;
  const okScope = {
    snapshot: { status: 'ready', value: { configJson: 'old' }, revision: 7 },
    async mutate(ops, revision) { call = { ops, revision }; this.snapshot = { status: 'ready', value: { configJson: text }, revision: 8 }; },
    getSnapshot() { return this.snapshot; },
  };
  await plugin.testHelpers.saveConfig(okScope, text, 7);
  assert.equal(call.revision, 7);
  assert.equal(JSON.stringify(call.ops), JSON.stringify([{ op: 'set', path: ['configJson'], value: text }]));
  const conflictScope = { async mutate() {}, getSnapshot() { return { status: 'ready', value: { configJson: 'server-new' }, revision: 9 }; } };
  await assert.rejects(plugin.testHelpers.saveConfig(conflictScope, text, 7), /版本冲突/);
});

test('GET 与 POST 均透传结构化 error.message', async () => {
  for (const method of ['GET', 'POST']) {
    const { plugin } = await loadPlugin({ fetch: async (_url, init) => ({ ok: false, status: 400, async json() { return { error: { message: `${init.method}-错误` } }; } }) });
    await assert.rejects(plugin.testHelpers.jsonRequest(method, method === 'POST' ? {} : undefined), new RegExp(`${method}-错误`));
  }
});
