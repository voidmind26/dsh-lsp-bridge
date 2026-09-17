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

test('发现 API 注册同一路径 GET/POST，并把 cwd 绑定到活动会话', async () => {
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
    assert.equal((await body(discovered)).projects[0].root, await realpath(workspace));
    await Promise.all(cleanups.map(cleanup => cleanup()));
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('发现 API 拒绝伪造 cwd/command、错误媒体类型与非 DFA 会话', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-lsp-api-'));
  try {
    const allowed = host({ workspace });
    const extra = await allowed.route.fetch(new Request(`http://localhost${DISCOVERY_PATH}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session-1', cwd: '/tmp', command: 'evil' }),
    }));
    assert.equal(extra.status, 400);
    assert.match(JSON.stringify(await body(extra)), /invalid-request/);
    const media = await allowed.route.fetch(new Request(`http://localhost${DISCOVERY_PATH}`, { method: 'POST', body: '{}' }));
    assert.equal(media.status, 415);

    const restricted = host({ workspace, mode: 'workspace-write' });
    const denied = await restricted.route.fetch(new Request(`http://localhost${DISCOVERY_PATH}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 'session-1' }),
    }));
    assert.equal(denied.status, 403);
    assert.match((await body(denied)).error.message, /danger-full-access/);
    await Promise.all([...allowed.cleanups, ...restricted.cleanups].map(cleanup => cleanup()));
  } finally { await rm(workspace, { recursive: true, force: true }); }
});
