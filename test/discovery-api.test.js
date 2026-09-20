import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { apply, DISCOVERY_PATH } from '../src/index.js';

function host({ workspace, mode = 'danger-full-access' }) {
  let route;
  const session = { id: 'session-1', header: { id: 'session-1', cwd: workspace } };
  const cleanups = [];
  const ctx = {
    tools: { register: () => {} },
    sandboxPolicy: { resolve: () => ({ mode }) },
    effect: factory => { cleanups.push(factory()); },
    inject: (services, callback) => {
      if (services.includes('connection')) callback({
        connection: { fetch: { register: value => { route = value; return () => { route = undefined; }; } } },
        sessions: { get: id => id === session.id ? session : undefined, list: () => [session] },
        effect: factory => { cleanups.push(factory()); },
      });
    },
  };
  apply(ctx, {});
  return { route, cleanups };
}

async function body(response) { return response.json(); }

test('发现 API：GET/POST 注册、会话绑定、权限门控与请求体校验', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-lsp-api-'));
  try {
    await writeFile(join(workspace, 'go.mod'), 'module example.test/api\n');
    const { route, cleanups } = host({ workspace });
    assert.equal(route.path, DISCOVERY_PATH);
    assert.deepEqual(route.methods, ['GET', 'POST']);
    assert.equal(route.requestBody, 'buffered');

    const listed = await route.fetch(new Request(`http://localhost${DISCOVERY_PATH}`));
    assert.equal(listed.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await body(listed), { sessions: [{ id: 'session-1', cwd: workspace }] });

    const discovered = await route.fetch(new Request(`http://localhost${DISCOVERY_PATH}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session-1', languages: ['go'], refresh: true }),
    }));
    assert.equal(discovered.status, 200);
    const payload = await body(discovered);
    assert.equal(payload.projects[0].root, await realpath(workspace));
    // 只读诊断必须同时给出运行组件状态与安装计划，但不执行任何命令。
    assert.equal(payload.servers[0].serverId, 'gopls');
    assert.ok(Array.isArray(payload.servers[0].dependencies));
    assert.ok(payload.servers[0].install.available === true || typeof payload.servers[0].install.reason === 'string');
    assert.equal(typeof payload.install.directory, 'string');
    await Promise.all(cleanups.map(cleanup => cleanup()));

    const allowed = host({ workspace });
    const extra = await allowed.route.fetch(new Request(`http://localhost${DISCOVERY_PATH}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session-1', cwd: '/tmp', command: 'evil' }),
    }));
    assert.equal(extra.status, 400);
    assert.match(JSON.stringify(await body(extra)), /invalid-request/);
    const media = await allowed.route.fetch(new Request(`http://localhost${DISCOVERY_PATH}`, { method: 'POST', body: '{}' }));
    assert.equal(media.status, 415);
    // verify 必须是布尔值；默认（未传）不做任何启动验证。
    const badVerify = await allowed.route.fetch(new Request(`http://localhost${DISCOVERY_PATH}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session-1', verify: 'yes' }),
    }));
    assert.equal(badVerify.status, 400);
    const noVerify = await allowed.route.fetch(new Request(`http://localhost${DISCOVERY_PATH}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session-1', verify: false }),
    }));
    assert.equal(noVerify.status, 200);
    assert.equal('verification' in await body(noVerify), false, '默认响应不包含验证结果，也不启动服务器');

    // 只读诊断在任何权限下都可以进行。
    const restricted = host({ workspace, mode: 'workspace-write' });
    const scanned = await restricted.route.fetch(new Request(`http://localhost${DISCOVERY_PATH}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 'session-1' }),
    }));
    assert.equal(scanned.status, 200);
    const scannedBody = await body(scanned);
    // 验证会启动进程：受限会话且没有沙箱后端时不启动任何服务器，但扫描状态仍然返回
    // （诊断先入缓存，模型上下文不会因此退化成“未扫描到”）。
    const refused = await restricted.route.fetch(new Request(`http://localhost${DISCOVERY_PATH}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 'session-1', verify: true }),
    }));
    assert.equal(refused.status, 200);
    const refusedBody = await body(refused);
    assert.deepEqual(refusedBody.verification, []);
    assert.equal(refusedBody.verificationRefused.code, 'sandbox-unavailable', '对外 code 必须稳定');
    assert.match(refusedBody.verificationRefused.message, /沙箱|完全访问/);
    // 拒绝验证不能把诊断结果一起丢掉：应与普通扫描结果完全一致且非空。
    assert.ok(scannedBody.servers.length > 0, '前置条件：扫描应发现服务器');
    assert.deepEqual(refusedBody.servers, scannedBody.servers);
    await Promise.all([...allowed.cleanups, ...restricted.cleanups].map(cleanup => cleanup()));
  } finally { await rm(workspace, { recursive: true, force: true }); }
});