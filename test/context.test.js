import test from 'node:test';
import assert from 'node:assert/strict';
import { CONTEXT_ORDER, DiagnosisCache, MAX_CONTEXT_SERVERS, renderLspContext } from '../src/context.js';

const session = cwd => ({ header: { id: 's1', cwd } });
const servers = ids => ids.map(id => ({ id, command: `/bin/${id}`, languages: { [id]: ['.x'] } }));

test('上下文注入：触发条件、缓存命中与过期、按工作区隔离、数量上限与验证标注', () => {
  // 只有同时具备会话、工作区与已配置服务器时才注入。
  assert.equal(renderLspContext(), '');
  assert.equal(renderLspContext({ session: session('/w') }), '');
  assert.equal(renderLspContext({ session: session('/w'), config: { servers: [] } }), '');
  assert.equal(renderLspContext({ session: { header: {} }, config: { servers: servers(['a']) } }), '');
  assert.ok(Number.isFinite(CONTEXT_ORDER));

  // 缓存命中时使用真实诊断与验证状态，过期后回到未扫描。
  let now = 1000;
  const cache = new DiagnosisCache({ ttlMs: 100, now: () => now });
  cache.set('/w', {
    servers: [
      { serverId: 'gopls', status: 'ready' },
      { serverId: 'pyright', status: 'missing-dependency' },
      { serverId: 'clangd', status: 'missing-command' },
    ],
    verification: [{ serverId: 'gopls', ok: true }],
  });
  const cachedText = renderLspContext({ session: session('/w'), config: { servers: servers(['gopls', 'pyright', 'clangd']) }, cache });
  assert.match(cachedText, /- gopls（gopls）：可用/);
  assert.match(cachedText, /- pyright（pyright）：缺少运行组件/);
  assert.match(cachedText, /- clangd（clangd）：未安装该语言服务器/);
  assert.match(cachedText, /最近一次真实验证：gopls=通过。/);

  now += 101;
  const stale = renderLspContext({ session: session('/w'), config: { servers: servers(['gopls']) }, cache });
  assert.match(stale, /本次未在本工作区扫描到/);
  assert.equal(stale.includes('最近一次真实验证'), false);

  // 服务器数量设上限，并如实标注验证失败。
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  const limitCache = new DiagnosisCache();
  limitCache.set('/w', { servers: ids.map(serverId => ({ serverId, status: 'ready' })), verification: [{ serverId: 'a', ok: false }] });
  const limitedText = renderLspContext({ session: session('/w'), config: { servers: servers(ids) }, cache: limitCache });
  assert.equal(limitedText.includes('- g.'.replace('g.', 'g ')), false);
  assert.match(limitedText, /…另有 1 个已配置服务器/);
  assert.match(limitedText, new RegExp(`- f（f）`), '上限内最后一个仍然列出');
  assert.equal(limitedText.split('\n').filter(line => line.startsWith('- ')).length, MAX_CONTEXT_SERVERS + 1);
  assert.match(limitedText, /最近一次真实验证：a=失败。/);

  // 缓存按工作区隔离，clear 后全部失效。
  const isolated = new DiagnosisCache();
  isolated.set('/w1', { servers: [{ serverId: 'gopls', status: 'ready' }] });
  assert.equal(isolated.get('/w2'), null);
  assert.equal(isolated.get('/w1').servers.length, 1);
  isolated.clear();
  assert.equal(isolated.get('/w1'), null);
});

test('上下文列出服务器、语言与未扫描状态，并给出使用指引', () => {
  const text = renderLspContext({ session: session('/Users/voidmind/Documents/DSHplugins'), config: { servers: servers(['gopls']) } });
  assert.match(text, /\[dsh-lsp-bridge\] 工作区 DSHplugins 的语言服务：/);
  assert.match(text, /- gopls（gopls）：本次未在本工作区扫描到（可能属于其它项目）/);
  assert.match(text, /lsp 工具/);
  assert.match(text, /lsp_setup/);
});