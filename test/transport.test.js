import test from 'node:test';
import assert from 'node:assert/strict';
import { LspTransport } from '../src/transport.js';

test('沙箱 confine 的契约：非法返回值与抛错都在启动进程之前失败关闭', () => {
  // 返回空数组 / 含非字符串：必须在 spawn 之前拒绝，而不是带着坏 argv 去启动。
  assert.throws(() => new LspTransport({ command: 'x', args: [], confine: () => [] }), /非空的字符串数组/);
  assert.throws(() => new LspTransport({ command: 'x', args: [], confine: () => [null] }), /非空的字符串数组/);
  assert.throws(() => new LspTransport({ command: 'x', args: [], confine: () => 'not-an-array' }), /非空的字符串数组/);
  // confine 自身抛错（例如沙箱后端不可用）：包装成可读错误并保留原始 code。
  const unavailable = Object.assign(new Error('no runner'), { code: 'SANDBOX_UNAVAILABLE' });
  assert.throws(() => new LspTransport({ command: 'x', args: [], confine: () => { throw unavailable; } }), (error) => {
    assert.match(error.message, /沙箱不可用/);
    assert.equal(error.code, 'SANDBOX_UNAVAILABLE');
    return true;
  });
});
