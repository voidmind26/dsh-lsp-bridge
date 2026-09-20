/**
 * 语言服务器写入能力的应用层：把 WorkspaceEdit / TextEdit 安全地落到磁盘。
 *
 * 设计边界：
 * - 只支持文本编辑。文件创建/重命名/删除（CreateFile/RenameFile/DeleteFile）一律拒绝，
 *   不做“部分执行”，避免服务器拿到半套结果。
 * - 每个目标文件都要先通过真实路径校验；权限不足时抛出**明确的“需要完全访问权限”提示**，
 *   而不是让用户看到一句被拒绝。
 * - 编辑按 UTF-16 偏移计算（LSP 的位置语义），降序应用并检测区间重叠；
 *   区间非法或互相冲突时整批拒绝，不做尽力而为的部分写入。
 */
import { isAbsolute, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_EDIT_FILES = 32;
export const MAX_EDITS_PER_FILE = 2000;
export const FULL_ACCESS_HINT = '需要完全访问权限（danger-full-access）才能让语言服务器修改这里的文件。';

/** 写入模式：full 直接允许；workspace 只允许会话工作区内；deny 一律拒绝。 */
export const WRITE_MODES = Object.freeze(['full', 'workspace', 'deny']);

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const insideDirectory = (base, target) => {
  const rel = relative(base, target);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
};

/** file: URI → 绝对路径；非 file URI 返回 null。 */
export function pathFromUri(uri) {
  if (typeof uri !== 'string' || !uri.startsWith('file:')) return null;
  try {
    const path = fileURLToPath(uri);
    return isAbsolute(path) ? path : null;
  } catch { return null; }
}

/**
 * 校验一次写入是否在当前权限下允许。
 * @throws 带“需要完全访问权限”提示的错误
 */
export function assertWriteAllowed({ mode, workspace, file }) {
  if (!WRITE_MODES.includes(mode)) throw new TypeError(`未知写入模式 ${mode}`);
  if (mode === 'deny') {
    throw new Error(`当前会话是只读权限，语言服务器的修改不会写入磁盘。${FULL_ACCESS_HINT}`);
  }
  if (mode === 'workspace' && !insideDirectory(workspace, file)) {
    throw new Error(`目标文件在工作区之外：${file}。${FULL_ACCESS_HINT}`);
  }
}

/** 把 WorkspaceEdit 归一化成 [{uri, file, edits}]，遇到不支持的文件操作直接拒绝。 */
export function normalizeWorkspaceEdit(edit) {
  if (!isObject(edit)) throw new Error('语言服务器返回的 WorkspaceEdit 不是对象');
  const files = [];
  const push = (uri, edits) => {
    if (!Array.isArray(edits)) throw new Error(`WorkspaceEdit 中 ${uri} 的 edits 不是数组`);
    files.push({ uri, edits });
  };
  if (edit.changes !== undefined) {
    if (!isObject(edit.changes)) throw new Error('WorkspaceEdit.changes 不是对象');
    for (const [uri, edits] of Object.entries(edit.changes)) push(uri, edits);
  }
  if (edit.documentChanges !== undefined) {
    if (!Array.isArray(edit.documentChanges)) throw new Error('WorkspaceEdit.documentChanges 不是数组');
    for (const change of edit.documentChanges) {
      if (!isObject(change)) throw new Error('documentChanges 条目不是对象');
      if (typeof change.kind === 'string') {
        throw new Error(`暂不支持文件级操作（${change.kind}），只应用文本编辑；未做任何写入。`);
      }
      if (!isObject(change.textDocument)) throw new Error('documentChanges 条目缺少 textDocument');
      push(change.textDocument.uri, change.edits);
    }
  }
  if (!files.length) throw new Error('WorkspaceEdit 不包含任何文本编辑');
  if (files.length > MAX_EDIT_FILES) throw new Error(`一次修改的文件过多（${files.length} > ${MAX_EDIT_FILES}）；未做任何写入。`);
  return files;
}

function lineStarts(text) {
  const starts = [0];
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code === 10) starts.push(index + 1);
    else if (code === 13) {
      if (text.charCodeAt(index + 1) === 10) index++;
      starts.push(index + 1);
    }
  }
  return starts;
}

function offsetFor(starts, text, position, label) {
  const { line, character } = position ?? {};
  if (!Number.isSafeInteger(line) || !Number.isSafeInteger(character) || line < 0 || character < 0) {
    throw new Error(`${label} 的 line/character 不是非负整数`);
  }
  if (line >= starts.length) throw new Error(`${label} 的行号超出文件范围（${line} >= ${starts.length}）`);
  const start = starts[line];
  const end = line + 1 < starts.length ? starts[line + 1] : text.length;
  const offset = start + character;
  if (offset > end) throw new Error(`${label} 的列号超出该行范围`);
  return offset;
}

/**
 * 按 LSP 语义把 edits 应用到文本。
 * @returns 新文本
 * @throws 区间非法或重叠时
 */
export function applyTextEdits(text, edits) {
  if (typeof text !== 'string') throw new TypeError('text 必须是字符串');
  if (!Array.isArray(edits)) throw new Error('edits 必须是数组');
  if (edits.length > MAX_EDITS_PER_FILE) throw new Error(`单个文件的编辑过多（${edits.length} > ${MAX_EDITS_PER_FILE}）；未做任何写入。`);
  const starts = lineStarts(text);
  const resolved = edits.map((edit, index) => {
    if (!isObject(edit) || !isObject(edit.range)) throw new Error(`第 ${index + 1} 个编辑缺少 range`);
    if (typeof edit.newText !== 'string') throw new Error(`第 ${index + 1} 个编辑缺少 newText`);
    const start = offsetFor(starts, text, edit.range.start, `第 ${index + 1} 个编辑起点`);
    const end = offsetFor(starts, text, edit.range.end, `第 ${index + 1} 个编辑终点`);
    if (end < start) throw new Error(`第 ${index + 1} 个编辑的区间是反向的`);
    return { start, end, newText: edit.newText, index };
  });
  // 降序应用，避免前面的编辑影响后面的偏移；同时检测重叠，冲突则整批拒绝。
  resolved.sort((left, right) => right.start - left.start || right.end - left.end);
  let nextStart = Number.POSITIVE_INFINITY;
  for (const edit of resolved) {
    if (edit.end > nextStart) throw new Error('语言服务器返回了互相重叠的编辑；未做任何写入。');
    nextStart = edit.start;
  }
  let result = text;
  for (const edit of resolved) result = result.slice(0, edit.start) + edit.newText + result.slice(edit.end);
  return result;
}

/** 把 TextEdit[] 包装成与 WorkspaceEdit 相同的形状，便于统一处理。 */
export function editForSingleFile(uri, edits) {
  if (!Array.isArray(edits)) throw new Error('语言服务器返回的编辑不是数组');
  if (!edits.length) return null;
  return { changes: { [uri]: edits } };
}

/** 生成人类可读的摘要，用于 dry-run 结果与日志。 */
export function describeEdit(files) {
  return files.map(entry => ({ uri: entry.uri, edits: entry.edits.length }));
}