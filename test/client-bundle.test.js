import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const file = new URL('../src/client.js', import.meta.url);

async function loadPlugin({ fetch, states = [], effects = false } = {}) {
  const source = await readFile(file, 'utf8');
  let registration;
  let stateIndex = 0;
  const fakeReact = {
    createElement(type, props, ...children) { return { type, props: props || {}, children }; },
    // 默认不执行副作用，保证渲染测试是纯函数；需要挂载行为的用例显式开启。
    useEffect(fn) { if (effects) fn(); },
    useMemo(fn) { return fn(); }, useRef(value) { return { current: value }; },
    useState(value) { const index = stateIndex++; return [index in states ? states[index] : typeof value === 'function' ? value() : value, () => {}]; }, useSyncExternalStore(_subscribe, snapshot) { return snapshot(); },
  };
  vm.runInNewContext(source, { fetch, structuredClone, window: { __ModuleLoader__: { load(value) { registration = value; } } } });
  return { plugin: registration.factory(name => { assert.equal(name, 'react'); return fakeReact; }), registration, source };
}

/** 展开函数组件，收集元素节点与文本；visibleOnly 跳过 hidden 的折叠正文。 */
function render(node, { visibleOnly = false } = {}) {
  const elements = [];
  const text = [];
  (function walk(value) {
    if (value == null) return;
    if (typeof value === 'string') return text.push(value);
    if (Array.isArray(value)) return value.forEach(walk);
    if (typeof value.type === 'function') return walk(value.type({ ...value.props, children: value.children }));
    elements.push(value);
    if (visibleOnly && value.props?.hidden === true) return;
    walk(value.children);
  })(node);
  return { elements, text: text.join('\n') };
}

function buttonLabel(node) {
  const children = Array.isArray(node.children) ? node.children.flat(Infinity) : [node.children];
  return children.filter(value => typeof value === 'string').join('');
}

/** 渲染设置页；states 按状态声明顺序注入初值。 */
async function renderSettings({ states, configJson = '{"servers":[]}' } = {}) {
  const { plugin } = await loadPlugin({ states });
  let component;
  const scope = {
    subscribe() { return () => {}; },
    getSnapshot() { return { status: 'ready', writable: true, revision: 0, value: { configJson } }; },
  };
  plugin.apply({
    settingsScope: { bind() { return scope; } },
    slots: { inject(_name, factory) { factory(); }, register(_options, value) { component = value; return () => {}; } },
  });
  return render(component({ scope }), { visibleOnly: true });
}

test('客户端产物遵循 ModuleLoader 契约并注册独立 LSP 设置页', async () => {
  const { plugin, registration, source } = await loadPlugin();
  assert.equal(registration.id, 'dsh-lsp-bridge');
  let slot;
  assert.deepEqual(Array.from(plugin.inject), ['slots', 'settingsScope']);
  plugin.apply({
    settingsScope: { bind({ namespace }) { assert.equal(namespace, 'dsh-lsp-bridge'); return {}; } },
    slots: {
      inject(name, factory) { assert.equal(name, 'settings.section'); factory(); },
      register(options, component) { slot = { options, component }; return () => {}; },
    },
  });
  assert.equal(slot.options.id, 'dsh-lsp-bridge');
  assert.equal(slot.options.label, 'LSP');
  assert.equal(typeof slot.component, 'function');
  assert.match(source, /\/api\/dsh-lsp-bridge\/discovery/);
});

test('真实发现报告生成配置：ready 与人工候选生效，缺组件与未安装跳过并按 id 合并', async () => {
  const { plugin } = await loadPlugin();
  const report = {
    projects: [{ language: 'go', root: '/repo/go', markers: ['go.mod'] }], complete: true,
    servers: [
      { language: 'go', serverId: 'gopls', roots: ['/repo/go'], args: [], languages: { go: ['.go'] }, rootMarkers: ['go.mod'], status: 'ready', command: '/usr/bin/gopls', candidates: [], dependencies: [], targetSource: 'config' },
      { language: 'tsjs', serverId: 'typescript-language-server', roots: ['/repo/js'], args: ['--stdio'], languages: { typescript: ['.ts'] }, rootMarkers: ['package.json'], status: 'ready', command: '/a/tsls', candidates: [], dependencies: [], initializationOptions: { tsserver: { path: '/a/node_modules/typescript/lib/tsserver.js' } } },
      { language: 'python', serverId: 'pyright', roots: ['/repo/py'], args: ['--stdio'], languages: { python: ['.py'] }, rootMarkers: ['pyproject.toml'], status: 'missing-command', candidates: [], dependencies: [], installAdvice: 'npm i -g pyright' },
      { language: 'rust', serverId: 'rust-analyzer', roots: ['/repo/rs'], args: [], languages: { rust: ['.rs'] }, rootMarkers: ['Cargo.toml'], status: 'missing-dependency', candidates: [], dependencies: [{ id: 'typescript-sdk', satisfied: false }] },
      { language: 'cpp', serverId: 'clangd', roots: ['/repo/c'], args: [], languages: { c: ['.c'] }, rootMarkers: ['CMakeLists.txt'], status: 'needs-choice', candidates: ['/x/clangd', '/y/clangd'], dependencies: [] },
    ],
  };
  const current = JSON.stringify({ extra: 1, servers: [{ id: 'other', command: 'other' }, { id: 'gopls', command: 'old', env: { X: '1' } }] });
  const value = JSON.parse(plugin.testHelpers.suggestedConfig(report, current, { 'cpp:clangd': '/y/clangd' }));
  assert.equal(value.extra, 1);
  assert.deepEqual(value.servers.map(server => server.id), ['other', 'gopls', 'typescript-language-server', 'clangd']);
  assert.equal(value.servers[1].command, '/usr/bin/gopls');
  assert.deepEqual(value.servers[1].env, { X: '1' }, '覆盖同 id 建议字段但保留未知现有字段');
  assert.deepEqual(value.servers[2].initializationOptions, { tsserver: { path: '/a/node_modules/typescript/lib/tsserver.js' } }, '运行组件路径必须写进配置');
  // 项目根不落盘：扫描到的根只是当前会话的事实（换机器即失效，还会缩小多仓查询范围）。
  assert.deepEqual(value.servers[1].roots, ['/repo/go'], '配置里本来就有 roots 时原样保留');
  assert.deepEqual(value.servers[2].roots, [], '扫描到的项目根不写进配置（写入空数组以清掉旧值）');
  assert.equal(value.servers[3].command, '/y/clangd');
  assert.equal(value.servers.some(server => server.id === 'pyright'), false, '未安装的服务器不写入');
  assert.equal(value.servers.some(server => server.id === 'rust-analyzer'), false, '缺运行组件时不得写入必然失败的配置');
  assert.throws(() => plugin.testHelpers.suggestedConfig(report, '{bad'), /JSON/);
});

test('发现报告：摘要、折叠候选卡与展开/收起全部', async () => {
  const { plugin } = await loadPlugin();
  const entries = [
    { language: 'cpp', serverId: 'clangd', status: 'needs-choice', candidates: ['/a', '/b'], roots: ['/repo'], dependencies: [] },
    { language: 'python', serverId: 'pyright', status: 'missing-command', roots: ['/repo'], dependencies: [], installAdvice: 'npm install --global pyright', install: { available: false, reason: 'no-portable-installer' } },
    { language: 'tsjs', serverId: 'typescript-language-server', status: 'missing-dependency', roots: ['/repo'], dependencies: [{ id: 'typescript-sdk', description: 'TypeScript SDK（tsserver）', satisfied: false, reason: '未找到 typescript' }], install: { available: true, kind: 'npm', manager: 'npm', prefix: '/prefix/tls', steps: [{ file: '/bin/npm', args: ['install', '--prefix', '/prefix/tls', 'typescript'] }] } },
  ];
  const report = { complete: false, projects: [{ language: 'tsjs', root: '/repo', markers: ['package.json'] }], servers: entries };
  const visible = render(plugin.testHelpers.DiscoveryReport({ report, choices: {}, onChoose() {} }), { visibleOnly: true });
  assert.ok(visible.text.includes('扫描已截断'));
  assert.ok(visible.text.includes('1 个项目'), '摘要给出项目数量');
  assert.ok(visible.text.includes('缺少运行组件'), '折叠摘要显示状态');
  assert.ok(!visible.text.includes('/prefix/tls'), '折叠时不铺开安装路径');

  // 展开后才出现下拉、组件原因与确切命令。
  const choice = render(plugin.testHelpers.ServerCard({ entry: entries[0], choices: {}, onChoose() {}, open: true, onToggle() {} }), { visibleOnly: true });
  assert.ok(choice.elements.some(node => node.type === 'select'));
  const missing = render(plugin.testHelpers.ServerCard({ entry: entries[1], choices: {}, onChoose() {}, open: true, onToggle() {} }), { visibleOnly: true });
  assert.ok(missing.text.includes('npm install --global pyright'));
  const dependency = render(plugin.testHelpers.ServerCard({ entry: entries[2], choices: {}, onChoose() {}, open: true, onToggle() {} }), { visibleOnly: true });
  assert.ok(dependency.text.includes('TypeScript SDK（tsserver）'));
  assert.ok(dependency.text.includes('未找到 typescript'));
  assert.ok(dependency.text.includes('/bin/npm install --prefix /prefix/tls typescript'), '安装方案必须展示确切的命令');
  assert.ok(dependency.text.includes('不使用 sudo'));

  const { plugin: allPlugin } = await loadPlugin();
  const allReport = { complete: true, projects: [], servers: [{ language: 'go', serverId: 'gopls', status: 'ready', command: '/bin/gopls', roots: [], dependencies: [] }] };
  const tree = allPlugin.testHelpers.DiscoveryReport({ report: allReport, choices: {}, onChoose() {} });
  const labels = render(tree).elements.filter(node => node.type === 'button').map(buttonLabel);
  assert.ok(labels.includes('展开全部'));
  assert.ok(labels.includes('收起全部'));
});

test('折叠卡片与长路径省略：默认折叠、展开才显示细节', async () => {
  const { plugin } = await loadPlugin();
  const entry = {
    language: 'tsjs', serverId: 'typescript-language-server', status: 'missing-dependency', roots: ['/repo'],
    dependencies: [{ id: 'typescript-sdk', description: 'TypeScript SDK（tsserver）', satisfied: false, reason: '未找到 typescript' }],
    install: { available: true, kind: 'npm', manager: 'npm', prefix: '/prefix/tls', steps: [{ file: '/bin/npm', args: ['install', '--prefix', '/prefix/tls', 'typescript@5'] }] },
  };
  const collect = node => {
    const seen = [];
    (function walk(value) {
      if (value == null) return;
      if (typeof value === 'string') return seen.push(value);
      if (Array.isArray(value)) return value.forEach(walk);
      if (typeof value.type === 'function') return walk(value.type({ ...value.props, children: value.children }));
      seen.push(value.type); walk(value.children);
    })(node);
    return seen;
  };

  // 折叠：头部是可访问的展开控制，正文被 hidden 隐藏。
  const collapsed = render(plugin.testHelpers.ServerCard({ entry, choices: {}, onChoose() {}, open: false, onToggle() {} }));
  const head = collapsed.elements.find(node => node.type === 'button');
  assert.equal(head.props['aria-expanded'], false);
  assert.equal(head.props['aria-controls'], 'lsp-server-typescript-language-server');
  const body = collapsed.elements.find(node => node.type === 'div' && node.props.id === 'lsp-server-typescript-language-server');
  assert.equal(body.props.hidden, true, '折叠时细节不展示');
  assert.ok(render(plugin.testHelpers.ServerCard({ entry, choices: {}, onChoose() {}, open: false, onToggle() {} }), { visibleOnly: true }).text.includes('缺少运行组件'), '摘要仍然显示状态');

  // 展开：显示组件原因与确切的安装命令。
  const expanded = render(plugin.testHelpers.ServerCard({ entry, choices: {}, onChoose() {}, open: true, onToggle() {} }), { visibleOnly: true });
  const expandedBody = expanded.elements.find(node => node.type === 'div' && node.props.id === 'lsp-server-typescript-language-server');
  assert.equal(expandedBody.props.hidden, false);
  assert.ok(expanded.text.includes('/bin/npm install --prefix /prefix/tls typescript@5'));
  assert.ok(expanded.text.includes('未找到 typescript'));
  assert.ok(expanded.text.includes('/repo'));

  // 会话与服务器摘要省略长路径，完整值仍可取用。
  const { plugin: pathPlugin } = await loadPlugin();
  assert.equal(pathPlugin.testHelpers.sessionLabel({ cwd: '/Users/voidmind/Documents/GolandProjects/uos', id: '3f9a1c77-0d2e-4b6a-9d21-8f0e1a2b3c4d' }), 'uos · 3f9a1c77');
  assert.equal(pathPlugin.testHelpers.sessionLabel({ cwd: '/tmp/ws/', id: 'abcdefghij' }), 'ws · abcdefgh');
  assert.equal(pathPlugin.testHelpers.shortPath('C:\\work\\proj'), 'proj');

  const pathEntry = {
    language: 'tsjs', serverId: 'typescript-language-server', status: 'missing-dependency', roots: ['/repo'],
    dependencies: [{ id: 'typescript-sdk', description: 'TypeScript SDK', satisfied: false, reason: '未找到 typescript' }],
    install: { available: false, reason: 'manager-missing' },
  };
  const pathCollapsed = render(pathPlugin.testHelpers.ServerCard({ entry: pathEntry, choices: {}, onChoose() {}, open: false, onToggle() {} }), { visibleOnly: true });
  assert.ok(!pathCollapsed.text.includes('/repo'), '折叠摘要不出现根目录路径');
  const pathExpanded = render(pathPlugin.testHelpers.ServerCard({ entry: pathEntry, choices: {}, onChoose() {}, open: true, onToggle() {} }), { visibleOnly: true });
  assert.ok(pathExpanded.text.includes('未找到 typescript'));
  assert.ok(pathExpanded.text.includes('项目范围：/repo'), '项目范围是服务器的属性，放在卡片细节里');
});

test('三视图：默认只显示服务器列表，新增语言服务器与编辑配置 JSON 各自独立', async () => {
  const tree = await renderSettings();
  const labels = tree.elements.filter(node => node.type === 'button').map(buttonLabel);
  assert.ok(labels.includes('＋ 新增语言服务器'), '提供独立的新增入口');
  assert.ok(labels.includes('编辑配置 JSON'), 'JSON 编辑有独立入口，不在新增页面里');
  assert.ok(!labels.includes('重新扫描'), '列表视图不显示扫描控件');
  assert.ok(!labels.includes('← 返回服务器列表'));
  assert.equal(tree.elements.some(node => node.type === 'select'), false, '列表视图不显示会话选择');
  assert.equal(tree.elements.some(node => node.type === 'textarea'), false, '列表视图不显示 JSON 编辑器');
  assert.ok(tree.text.includes('尚未配置语言服务器'));
  const save = tree.elements.find(node => node.type === 'button' && buttonLabel(node).includes('保存配置'));
  assert.ok(save, '明确提供保存入口');
  assert.equal(save.props.disabled, true, '没有修改时不允许保存');

  const draft = '{"servers":[{"id":"mock","command":"/bin/mock","languages":{"mock":[".mock"]}}]}';
  // 状态顺序：draft、dirty、sessions、sessionId、report、choices、openServers、error、busy、notice、view
  const addTree = await renderSettings({ states: [draft, false, [], '', null, {}, {}, '', false, '', 'add'], configJson: draft });
  const addLabels = addTree.elements.filter(node => node.type === 'button').map(buttonLabel);
  assert.ok(addLabels.includes('← 返回服务器列表'), '可以返回列表');
  assert.ok(addLabels.includes('重新扫描'), '新增视图提供扫描');
  assert.ok(addTree.elements.some(node => node.type === 'select' && node.props['aria-label'] === '扫描范围会话'), '会话只是扫描范围，带无障碍标签');
  assert.ok(addTree.text.includes('新增语言服务器'));
  assert.ok(addTree.text.includes('选择语言服务器'), '新增视图先选服务器，而不是先看目录');
  assert.ok(addTree.text.includes('加入配置'), '加入配置是新增视图的落点');
  assert.equal(addTree.elements.some(node => node.type === 'textarea'), false, '新增视图不再承载 JSON 编辑');
  assert.ok(addTree.text.includes('草稿里的服务器：mock'), '加入后能看到草稿里有哪些服务器');

  // JSON 编辑是独立视图：只有它出现文本域。
  const jsonTree = await renderSettings({ states: [draft, false, [], '', null, {}, {}, '', false, '', 'json'], configJson: draft });
  const jsonLabels = jsonTree.elements.filter(node => node.type === 'button').map(buttonLabel);
  assert.ok(jsonLabels.includes('← 返回服务器列表'));
  assert.ok(jsonTree.elements.some(node => node.type === 'textarea'), 'JSON 视图提供文本域');
  assert.ok(jsonTree.text.includes('编辑配置 JSON'));
  assert.equal(jsonLabels.includes('重新扫描'), false, 'JSON 视图不掺扫描');
});

test('列表卡片：服务器设置详情、验证状态与评估目录标注', async () => {
  const configJson = JSON.stringify({ servers: [
    { id: 'gopls', command: '/Users/voidmind/go/bin/gopls', args: [], languages: { go: ['.go'] }, rootMarkers: ['go.mod'], roots: ['/Users/voidmind/Documents/GolandProjects/uos'] },
    { id: 'typescript-language-server', command: '/prefix/tls/bin/tls', args: ['--stdio'], languages: { typescript: ['.ts'], javascript: ['.js'] } },
  ] });
  // openServers 注入为展开第一项。
  const tree = await renderSettings({ states: [configJson, false, [], '', null, {}, { 0: true, 1: true }, '', false, ''], configJson });
  const labels = tree.elements.filter(node => node.type === 'button').map(buttonLabel);
  assert.ok(labels.includes('＋ 新增语言服务器'));
  assert.ok(tree.text.includes('服务器（2）'));
  assert.ok(tree.text.includes('未扫描'), '未扫描过的服务器如实标注');
  const cards = tree.elements.filter(node => node.type === 'article');
  assert.equal(cards.length, 2, '每个服务器一张卡片');
  assert.ok(tree.text.includes('程序路径'), '展开后显示程序路径');
  assert.ok(tree.text.includes('/Users/voidmind/go/bin/gopls'));
  assert.ok(tree.text.includes('语言：go'));
  assert.ok(tree.text.includes('项目根目录（固定评估）：/Users/voidmind/Documents/GolandProjects/uos'));
  // 没有配置根目录的服务器必须如实说明“随工作区自动判定”，而不是留空让人以为没生效。
  assert.ok(tree.text.includes('项目根目录：未固定，随当前会话工作区与最近的项目标记自动判定'));
  assert.ok(labels.includes('编辑配置 JSON'), '从详情可直接进入 JSON 编辑');

  const statusConfigJson = JSON.stringify({ servers: [
    { id: 'gopls', command: '/bin/gopls', args: [], languages: { go: ['.go'] } },
    { id: 'typescript-language-server', command: '/bin/tls', args: ['--stdio'], languages: { typescript: ['.ts'] } },
    { id: 'pyright', command: '/bin/pyright-langserver', args: ['--stdio'], languages: { python: ['.py'] } },
  ] });
  // 状态顺序：…、openServers(idx 6)、…、view(10)、verification(11)
  const statusVerification = {
    gopls: { ok: true, root: '/ws', serverInfo: { name: 'gopls' }, capabilities: ['hoverProvider', 'definitionProvider'], positionEncoding: 'utf-16' },
    'typescript-language-server': { ok: false, error: 'Could not find a valid TypeScript installation' },
  };
  const statusTree = await renderSettings({ states: [statusConfigJson, false, [], '', null, {}, { 0: true, 1: true, 2: true }, '', false, '', 'list', statusVerification], configJson: statusConfigJson });
  assert.ok(statusTree.text.includes('验证通过'), '验证通过的服务器有标注');
  assert.ok(statusTree.text.includes('验证失败'), '验证失败的服务器有标注');
  assert.ok(statusTree.text.includes('未验证'), '未参与验证的服务器如实标注');
  // 能力检查只报人话：常用能力列一行，协议里的完整清单收进折叠区。
  assert.ok(statusTree.text.includes('验证通过 · 支持 悬停、定义 · utf-16'), '能力摘要一眼能读');
  assert.ok(statusTree.text.includes('全部能力（2）'), '完整能力清单折叠保留');
  assert.ok(statusTree.text.includes('hoverProvider'));
  assert.equal(statusTree.text.includes('服务器信息：'), false, '不再把 serverInfo 原样倒进界面');
  assert.ok(statusTree.text.includes('服务器：gopls'));
  assert.ok(statusTree.text.includes('Could not find a valid TypeScript installation'), '失败原因直接可见');
  assert.ok(statusTree.text.includes('尚未验证：本次未启动该服务器'));
  assert.ok(statusTree.text.includes('/ws'));

  const targetConfigJson = JSON.stringify({ servers: [
    {
      id: 'gopls', command: '/Users/voidmind/go/bin/gopls', args: [], languages: { go: ['.go'] },
      roots: ['/Users/voidmind/Documents/GolandProjects/G_Ocean/G-Ocean-web'],
    },
    { id: 'typescript-language-server', command: '/bin/tls', args: ['--stdio'], languages: { typescript: ['.ts'] } },
  ] });
  const targetSessions = [{ id: 's-current', cwd: '/Users/voidmind/Documents/DSHplugins' }];
  const targetReport = {
    complete: true, projects: [],
    servers: [
      { serverId: 'gopls', language: 'go', status: 'ready', command: '/Users/voidmind/go/bin/gopls', candidates: [], roots: ['/Users/voidmind/Documents/GolandProjects/G_Ocean/G-Ocean-web'], dependencies: [], target: '/Users/voidmind/Documents/GolandProjects/G_Ocean/G-Ocean-web', targetSource: 'config' },
      // 没有配置根目录的服务器：评估目录来自会话工作区，界面要标成自动判定。
      { serverId: 'typescript-language-server', language: 'tsjs', status: 'ready', command: '/bin/tls', candidates: [], roots: [], dependencies: [], target: '/Users/voidmind/Documents/DSHplugins', targetSource: 'session' },
    ],
    sandboxWarning: '受限会话的沙箱只允许写会话工作区与临时目录，但缓存目标在可写范围之外：GOCACHE=/Users/voidmind/Library/Caches/go-build（来自环境变量）。',
  };
  // states：draft、dirty、sessions、sessionId、report、choices、openServers、error、busy、notice、view、verification
  const targetVerification = { gopls: { ok: true, root: '/Users/voidmind/Documents/GolandProjects/G_Ocean/G-Ocean-web', capabilities: ['definitionProvider'] } };
  const targetTree = await renderSettings({ states: [targetConfigJson, false, targetSessions, 's-current', targetReport, {}, { 0: true, 1: true }, '', false, '', 'list', targetVerification], configJson: targetConfigJson });
  assert.ok(targetTree.text.includes('评估目录：/Users/voidmind/Documents/GolandProjects/G_Ocean/G-Ocean-web（来自配置的项目根目录）'), '标注真实评估目标');
  assert.ok(targetTree.text.includes('评估目录：/Users/voidmind/Documents/DSHplugins（随工作区与项目标记自动判定）'), '没有配置根目录时如实标注自动判定');
  assert.ok(targetTree.text.includes('沙箱缓存提示：'), '缓存目标不可写时在页面上给出原因');
  assert.ok(targetTree.text.includes('验证通过'), '其它项目的服务器也能验证');
  assert.ok(targetTree.text.includes('支持 定义'), '能力摘要只列常用能力');
  const targetLabels = targetTree.elements.filter(node => node.type === 'button').map(buttonLabel);
  assert.equal(targetLabels.includes('切到该项目会话并验证'), false, '不再需要靠切换会话来验证');
});

test('页面自动扫描请求与保存不再需要勾选确认', async () => {
  const calls = [];
  const sessions = [{ id: 'session-1', cwd: '/Users/voidmind/Documents/DSHplugins' }];
  const { plugin } = await loadPlugin({
    effects: true,
    fetch: async (_url, init) => {
      const method = init?.method ?? 'GET';
      calls.push({ method, body: init?.body ? JSON.parse(init.body) : undefined });
      if (method !== 'POST') return { ok: true, status: 200, async json() { return { sessions }; } };
      return { ok: true, status: 200, async json() { return { complete: true, projects: [], servers: [], verification: [{ serverId: 'gopls', ok: true, capabilities: [] }] }; } };
    },
  });
  let component;
  const scope = {
    subscribe: () => () => {},
    getSnapshot: () => ({ status: 'ready', writable: true, revision: 0, value: { configJson: '{"servers":[]}' } }),
  };
  plugin.apply({
    settingsScope: { bind: () => scope },
    slots: { inject(_name, factory) { factory(); }, register(_options, value) { component = value; return () => {}; } },
  });
  component({ scope });
  // 等待自动扫描的异步链（GET 列表 → POST 扫描）。
  for (let attempt = 0; attempt < 20 && calls.length < 2; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[1].method, 'POST');
  assert.deepEqual(calls[1].body, { sessionId: 'session-1', refresh: true, verify: true }, '打开页面即请求扫描与验证');

  const draft = '{"servers":[{"id":"mock","command":"/bin/mock","languages":{"mock":[".mock"]}}]}';
  // 状态顺序：draft、dirty、sessions、sessionId、report、choices、openServers、error、busy、notice
  const { plugin: savePlugin } = await loadPlugin({ states: [draft, true, [], '', null, {}, {}, '', false, ''] });
  let saveComponent;
  const saveScope = {
    subscribe: () => () => {},
    getSnapshot: () => ({ status: 'ready', writable: true, revision: 3, value: { configJson: draft } }),
  };
  savePlugin.apply({
    settingsScope: { bind: () => saveScope },
    slots: { inject(_name, factory) { factory(); }, register(_options, value) { saveComponent = value; return () => {}; } },
  });
  const tree = render(saveComponent({ scope: saveScope }), { visibleOnly: true });
  assert.equal(tree.elements.some(node => node.type === 'input' && node.props.type === 'checkbox'), false, '不再有信任勾选框');
  const save = tree.elements.find(node => node.type === 'button' && buttonLabel(node).includes('保存配置'));
  assert.ok(save, '保存按钮存在');
  assert.equal(save.props.disabled, false, '有未保存修改即可直接保存');
  assert.ok(tree.text.includes('未经 OS 沙箱隔离'), '风险提示仍然保留，只是不再阻断保存');
});

test('保存的 revision 校验与请求错误透传', async () => {
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

  for (const method of ['GET', 'POST']) {
    const { plugin: errorPlugin } = await loadPlugin({ fetch: async (_url, init) => ({ ok: false, status: 400, async json() { return { error: { message: `${init.method}-错误` } }; } }) });
    await assert.rejects(errorPlugin.testHelpers.jsonRequest(method, method === 'POST' ? {} : undefined), new RegExp(`${method}-错误`));
  }
});