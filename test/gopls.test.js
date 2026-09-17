import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LspManager } from '../src/engine.js';

test('real gopls resolves a definition in an isolated Go module', { skip: !process.env.LSP_TEST_GOPLS, timeout: 60000 }, async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-lsp-gopls-'));
  await writeFile(join(workspace, 'go.mod'), 'module example.com/lsp-smoke\n\ngo 1.22\n');
  await writeFile(join(workspace, 'main.go'), 'package main\n\nfunc answer() int { return 42 }\n\nfunc main() { _ = answer() }\n');
  const manager = new LspManager({ timeoutMs: 45000, servers: [{ id: 'go', command: process.env.LSP_TEST_GOPLS, args: ['serve'], languages: { go: ['.go'] }, rootMarkers: ['go.mod'] }] });
  t.after(async () => { await manager.dispose(); await rm(workspace, { recursive: true, force: true }); });
  const result = await manager.execute({ operation: 'definition', file: 'main.go', line: 5, character: 19 }, { workspace });
  const location = Array.isArray(result) ? result[0] : result;
  assert.ok(location, 'definition must exist');
  assert.equal((location.range ?? location.targetSelectionRange).start.line, 2);
});
