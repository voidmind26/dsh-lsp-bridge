import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import {
  MAX_EDIT_FILES, MAX_EDITS_PER_FILE, applyTextEdits, assertWriteAllowed, editForSingleFile, normalizeWorkspaceEdit, pathFromUri,
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
  // 同一文件重复出现时先合并，避免两次写入互相覆盖。
  const merged = normalizeWorkspaceEdit({
    documentChanges: [
      { textDocument: { uri: pathToFileURL(uri).href }, edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: 'a' }] },
      { textDocument: { uri: pathToFileURL(uri).href }, edits: [{ range: { start: { line: 0, character: 2 }, end: { line: 0, character: 3 } }, newText: 'b' }] },
    ],
  });
  assert.equal(merged.length, 1, '同一文件只产生一个写入条目');
  assert.equal(merged[0].edits.length, 2, '两次编辑都保留');
  assert.equal(applyTextEdits('xyz', merged[0].edits), 'ayb');
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
  // 规范：character 超过行长时 clamp 到行长，而不是报错或落到下一行。
  assert.equal(applyTextEdits('abc', [{ range: { start: { line: 0, character: 9 }, end: { line: 0, character: 9 } }, newText: 'x' }]), 'abcx');
  // 行终止符不属于该行内容：(0,2)-(0,3) 在 'ab\ncd' 上被 clamp 成空区间，不能吃掉换行。
  assert.equal(applyTextEdits('ab\ncd', [{ range: { start: { line: 0, character: 2 }, end: { line: 0, character: 3 } }, newText: '' }]), 'ab\ncd');
  assert.equal(applyTextEdits('a\n', [{ range: { start: { line: 1, character: 1 }, end: { line: 1, character: 1 } }, newText: '!' }]), 'a\n!');
  // 同一位置的多个插入必须保持数组顺序（LSP 规范）。
  assert.equal(applyTextEdits('xyz', [
    { range: { start: { line: 0, character: 2 }, end: { line: 0, character: 2 } }, newText: 'A' },
    { range: { start: { line: 0, character: 2 }, end: { line: 0, character: 2 } }, newText: 'B' },
  ]), 'xyABz');
  assert.equal(applyTextEdits('xyz', [
    { range: { start: { line: 0, character: 1 }, end: { line: 0, character: 1 } }, newText: 'A' },
    { range: { start: { line: 0, character: 1 }, end: { line: 0, character: 1 } }, newText: 'B' },
    { range: { start: { line: 0, character: 1 }, end: { line: 0, character: 2 } }, newText: 'R' },
  ]), 'xABRz');
  assert.throws(() => applyTextEdits('abc', [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } }]), /缺少 newText/);
  assert.throws(() => applyTextEdits('abc', [{ range: { start: { line: 0, character: 2 }, end: { line: 0, character: 1 } }, newText: 'x' }]), /反向/);
  // 上限保护：文件数与单文件编辑数都必须拒绝，避免一次写入海量改动。
  const manyFiles = Object.fromEntries(Array.from({ length: MAX_EDIT_FILES + 1 }, (_, index) => [pathToFileURL(`/tmp/f${index}.js`).href, []]));
  assert.throws(() => normalizeWorkspaceEdit({ changes: manyFiles }), /文件过多/);
  const manyEdits = Array.from({ length: MAX_EDITS_PER_FILE + 1 }, () => ({ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: '' }));
  assert.throws(() => applyTextEdits('abc', manyEdits), /编辑过多/);
});

test('写入权限：只读拒绝、工作区模式只允许工作区内、完全访问不额外限制', () => {
  // 断言字面提示语，而不是用被测模块导出的常量构造期望值（否则改文案测试照样通过）。
  assert.throws(() => assertWriteAllowed({ mode: 'deny', workspace: '/ws', file: '/ws/a.js' }), /只读权限[\s\S]*需要完全访问权限/);
  assert.doesNotThrow(() => assertWriteAllowed({ mode: 'workspace', workspace: '/ws', file: '/ws/a.js' }));
  assert.doesNotThrow(() => assertWriteAllowed({ mode: 'workspace', workspace: '/ws', file: '/ws' }));
  // 工作区外是边界问题，提权也解决不了，因此提示里不能出现“需要完全访问权限”。
  assert.throws(() => assertWriteAllowed({ mode: 'workspace', workspace: '/ws', file: '/other/a.js' }), /工作区之外[\s\S]*而不是提升权限/);
  assert.throws(() => assertWriteAllowed({ mode: 'full', workspace: '/ws', file: '/other/a.js' }), /工作区之外/);
  assert.throws(() => assertWriteAllowed({ mode: 'workspace', workspace: '/ws', file: '/other/a.js' }), (error) => !/完全访问权限/.test(error.message));
  assert.throws(() => assertWriteAllowed({ mode: 'nope', workspace: '/ws', file: '/ws/a.js' }), /未知写入模式/);
});