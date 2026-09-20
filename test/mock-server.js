import { pathToFileURL } from 'node:url';
import { appendFileSync } from 'node:fs';
const flag = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const recordOpens = flag('record-opens');
const editTarget = flag('edit-target');
let pendingInitialize = null;
let buffer = Buffer.alloc(0);
const documents = new Map();
let initialization;
function send(message) {
  const body = Buffer.from(JSON.stringify(message));
  // Split headers and UTF-8 bodies to exercise streaming framing.
  const wire = Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
  process.stdout.write(wire.subarray(0, 9));
  process.stdout.write(wire.subarray(9));
}
function handle(m) {
  // 客户端对 workspace/applyEdit 的响应到达后，才回复 initialize（确定性屏障）。
  if (m.id === 9001 && pendingInitialize !== null) {
    const id = pendingInitialize;
    pendingInitialize = null;
    send({ jsonrpc: '2.0', id, result: { capabilities: { textDocumentSync: 1 } } });
    return;
  }
  let result = null;
  if (m.method === 'initialize') {
    initialization = m.params;
    // --edit-target=<path>：初始化阶段就主动请求客户端应用一次编辑。
    // 在收到该请求的响应之前不回复 initialize，测试因此有确定性屏障，不需要 sleep。
    if (editTarget) {
      pendingInitialize = m.id;
      send({ jsonrpc: '2.0', id: 9001, method: 'workspace/applyEdit', params: { edit: { changes: { [pathToFileURL(editTarget).href]: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } }, newText: 'SERVER EDIT' }] } } } });
      setTimeout(() => { if (pendingInitialize !== null) { send({ jsonrpc: '2.0', id: pendingInitialize, result: { capabilities: { textDocumentSync: 1 } } }); pendingInitialize = null; } }, 2000).unref?.();
      return;
    }
    result = { capabilities: { positionEncoding: 'utf-16', textDocumentSync: 1, hoverProvider: true, definitionProvider: true, referencesProvider: true, documentSymbolProvider: true, workspaceSymbolProvider: true, diagnosticProvider: { interFileDependencies: false, workspaceDiagnostics: false } } };
    if (process.argv.includes('--push')) delete result.capabilities.diagnosticProvider;
  } else if (m.method === 'textDocument/didOpen') {
    documents.set(m.params.textDocument.uri, m.params.textDocument.text);
    if (recordOpens) appendFileSync(recordOpens, `${m.params.textDocument.uri}\n`);
    if (process.argv.includes('--push')) setTimeout(() => send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: m.params.textDocument.uri, version: 1, diagnostics: [{ message: 'push diagnostic', severity: 2, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }] } }), 30);
  }
  else if (m.method === 'textDocument/didChange') documents.set(m.params.textDocument.uri, m.params.contentChanges.at(-1).text);
  else if (m.method === 'textDocument/hover') {
    const text = documents.get(m.params.textDocument.uri);
    if (text?.includes('HANG')) return;
    if (text?.includes('CRASH')) process.exit(2);
    result = { contents: { kind: 'plaintext', value: JSON.stringify({ pid: process.pid, text, position: m.params.position, rootUri: initialization.rootUri, folders: initialization.workspaceFolders, unicode: '中文' }) } };
  } else if (m.method === 'textDocument/definition' || m.method === 'textDocument/references') result = [{ uri: m.params.textDocument.uri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } } }];
  else if (m.method === 'textDocument/documentSymbol') result = [{ name: 'Example', kind: 12, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } } }];
  else if (m.method === 'workspace/symbol') result = [{ name: m.params.query, kind: 12, location: { uri: pathToFileURL('/mock').href, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } } }];
  else if (m.method === 'textDocument/diagnostic') result = { kind: 'full', items: [{ severity: 2, message: 'mock diagnostic', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }] };
  else if (m.method === 'textDocument/rename') {
    // 把首个标识符替换为新名称，用于验证写入能力。
    const text = documents.get(m.params.textDocument.uri) ?? '';
    const length = (text.match(/^[A-Za-z_$][\w$]*/) ?? [''])[0].length;
    result = { changes: { [m.params.textDocument.uri]: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: length } }, newText: m.params.newName }] } };
  } else if (m.method === 'textDocument/formatting') result = [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: '// formatted\n' }];
  else if (m.method === 'workspace/applyEdit') result = { applied: true };
  else if (m.method === 'exit') process.exit(0);
  if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, result });
}
process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const split = buffer.indexOf('\r\n\r\n');
    if (split < 0) return;
    const size = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, split).toString())[1]);
    if (buffer.length < split + 4 + size) return;
    const message = JSON.parse(buffer.subarray(split + 4, split + 4 + size).toString());
    buffer = buffer.subarray(split + 4 + size);
    handle(message);
  }
});
