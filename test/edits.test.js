import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import {
  FULL_ACCESS_HINT, applyTextEdits, assertWriteAllowed, editForSingleFile, normalizeWorkspaceEdit, pathFromUri,
} from '../src/edits.js';

const uri = '/tmp/example.js';

test('WorkspaceEdit 归一化：changes 与 documentChanges 都支持，文件级操作直接拒绝', () => {
  const changes = normalizeWorkspaceEdit({ changes: { [pathToFileURL(uri).href]: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: 'x' }] } });
  assert.equal(changes.length, 1);
  assert.equal(changes[0].edits.length, 1);
  const documentChanges = normalizeWorkspaceEdit({ documentChanges: [{ textDocument: { uri: pathToFileURL(uri).href }, edits: [] }] });
  assert.equal(documentChanges.length, 1);
  assert.throws(() => normalizeWorkspaceEdit({ documentChanges: [{ kind: 'create', uri: pathToFileURL(uri).href }] }), /文件级操作/);
  assert.throws(() => normalizeWorkspaceEdit({}), /不包含任何文本编辑/);
  assert.equal(editForSingleFile('file:///x.js', []), null);
  assert.equal(pathFromUri('untitled:Untitled-1'), null);
  assert.equal(pathFromUri(pathToFileURL(uri).href), uri);
});

test('按 UTF-16 应用编辑：多行、CRLF、降序不互相影响，重叠与越界整批拒绝', () => {
  assert.equal(applyTextEdits('const a = 1;\n', [{ range: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } }, newText: 'b' }]), 'const b = 1;\n');
  // 同一行两处编辑按降序应用，前面的替换不影响后面的偏移。
  assert.equal(applyTextEdits('let x = 1 + 2;', [
    { range: { start: { line: 0, character: 8 }, end: { line: 0, character: 9 } }, newText: '10' },
    { range: { start: { line: 0, character: 12 }, end: { line: 0, character: 13 } }, newText: '20' },
  ]), 'let x = 10 + 20;');
  // CRLF 下第二行起点按 \r\n 计算。
  assert.equal(applyTextEdits('a\r\nb\r\n', [{ range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } }, newText: 'B' }]), 'a\r\nB\r\n');
  // 代理对按 UTF-16 计数：'中文' 每个字符占 1 个 UTF-16 码元。
  assert.equal(applyTextEdits('中文 x', [{ range: { start: { line: 0, character: 3 }, end: { line: 0, character: 4 } }, newText: 'Y' }]), '中文 Y');
  assert.throws(() => applyTextEdits('abc', [
    { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } }, newText: 'x' },
    { range: { start: { line: 0, character: 1 }, end: { line: 0, character: 3 } }, newText: 'y' },
  ]), /重叠/);
  assert.throws(() => applyTextEdits('abc', [{ range: { start: { line: 0, character: 0 }, end: { line: 5, character: 0 } }, newText: 'x' }]), /超出文件范围/);
  assert.throws(() => applyTextEdits('abc', [{ range: { start: { line: 0, character: 9 }, end: { line: 0, character: 9 } }, newText: 'x' }]), /列号超出/);
  assert.throws(() => applyTextEdits('abc', [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } }]), /缺少 newText/);
});

test('写入权限：只读拒绝、工作区模式只允许工作区内、完全访问不额外限制', () => {
  assert.throws(() => assertWriteAllowed({ mode: 'deny', workspace: '/ws', file: '/ws/a.js' }), new RegExp(FULL_ACCESS_HINT.replace(/[()]/g, '\\$&')));
  assert.doesNotThrow(() => assertWriteAllowed({ mode: 'workspace', workspace: '/ws', file: '/ws/a.js' }));
  assert.doesNotThrow(() => assertWriteAllowed({ mode: 'workspace', workspace: '/ws', file: '/ws' }));
  assert.throws(() => assertWriteAllowed({ mode: 'workspace', workspace: '/ws', file: '/other/a.js' }), /工作区之外[\s\S]*完全访问权限/);
  assert.doesNotThrow(() => assertWriteAllowed({ mode: 'full', workspace: '/ws', file: '/other/a.js' }));
  assert.throws(() => assertWriteAllowed({ mode: 'nope', workspace: '/ws', file: '/ws/a.js' }), /未知写入模式/);
});