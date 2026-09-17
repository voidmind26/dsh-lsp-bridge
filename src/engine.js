import { realpath, stat, open } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { LspTransport, abortError } from './transport.js';

const METHODS = {
  hover: 'textDocument/hover', definition: 'textDocument/definition', references: 'textDocument/references',
  implementation: 'textDocument/implementation', typeDefinition: 'textDocument/typeDefinition',
  documentSymbols: 'textDocument/documentSymbol', workspaceSymbols: 'workspace/symbol',
};
const POSITIONAL = new Set(['hover', 'definition', 'references', 'implementation', 'typeDefinition']);
const inside = (base, target) => { const rel = path.relative(base, target); return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel)); };
const checkAbort = signal => { if (signal?.aborted) throw abortError(); };
const uriFor = file => pathToFileURL(file).href;
// Retain at most 1 MiB of diagnostics per URI and 128 URIs per instance.
function boundedDiagnostics(items) {
  const result = [];
  let bytes = 0;
  for (const item of items.slice(0, 2000)) {
    bytes += Buffer.byteLength(JSON.stringify(item), 'utf8');
    if (bytes > 1024 * 1024) break;
    result.push(item);
  }
  return result;
}
const positive = (value, fallback, name, max) => {
  value ??= fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`${name} must be an integer between 1 and ${max}`);
  return value;
};

async function safePath(workspace, candidate, directory = false) {
  if (typeof candidate !== 'string' || !candidate) throw new Error('Expected a non-empty path');
  const lexical = path.resolve(workspace, candidate);
  let resolved;
  try { resolved = await realpath(lexical); } catch (error) { throw new Error(`Cannot resolve path ${candidate}: ${error.message}`); }
  if (!inside(workspace, resolved)) throw new Error(`Path resolves outside workspace (symlink): ${candidate}`);
  if (directory && !(await stat(resolved)).isDirectory()) throw new Error(`Not a directory: ${candidate}`);
  return resolved;
}

function queued(instance, fn, signal) {
  checkAbort(signal);
  if ((instance.queuedCount || 0) >= 256) throw new Error('Too many queued LSP operations');
  instance.queuedCount = (instance.queuedCount || 0) + 1;
  // Only this promise is raced: the underlying queued task still observes abort before work.
  const task = instance.queue.catch(() => {}).then(() => { checkAbort(signal); return fn(); }).finally(() => { instance.queuedCount--; });
  instance.queue = task.catch(() => {});
  if (!signal) return task;
  return new Promise((resolve, reject) => {
    const cancel = () => reject(abortError());
    signal.addEventListener('abort', cancel, { once: true });
    task.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
    if (signal.aborted) cancel();
  });
}

/**
 * Read-only protocol interface, not a child-process security sandbox. Configured
 * executables/plugins must be trusted: servers may independently read/write files.
 * All client file/root paths use realpath containment; hostile concurrent filesystem
 * mutation is outside this portable check's guarantees (no atomic open-beneath API).
 * Returned LSP locations are data, never followed/read by this client.
 */
export class LspManager {
  constructor(config = {}) {
    if (!config || typeof config !== 'object' || !Array.isArray(config.servers)) throw new Error('LSP config.servers must be an array');
    this.timeoutMs = positive(config.timeoutMs, 15000, 'timeoutMs', 300000);
    this.maxInstances = positive(config.maxInstances, 8, 'maxInstances', 128);
    this.maxFileBytes = positive(config.maxFileBytes, 2 * 1024 * 1024, 'maxFileBytes', 8 * 1024 * 1024);
    const ids = new Set();
    this.servers = config.servers.map(server => {
      if (!server || typeof server.id !== 'string' || !server.id || ids.has(server.id)) throw new Error('Each server needs a unique non-empty id');
      ids.add(server.id);
      if (typeof server.command !== 'string' || !server.command) throw new Error(`Server ${server.id}: command is required`);
      for (const key of ['args', 'rootMarkers', 'roots', 'workspaceFolders']) {
        if (server[key] !== undefined && (!Array.isArray(server[key]) || server[key].some(item => typeof item !== 'string' || !item))) throw new Error(`Server ${server.id}: ${key} must be a string array`);
      }
      if (server.env !== undefined && (!server.env || typeof server.env !== 'object' || Array.isArray(server.env) || Object.values(server.env).some(value => typeof value !== 'string'))) throw new Error(`Server ${server.id}: env must map strings to strings`);
      if (!server.languages || typeof server.languages !== 'object' || Array.isArray(server.languages) || Object.entries(server.languages).some(([id, extensions]) => !id || !Array.isArray(extensions) || extensions.some(ext => typeof ext !== 'string' || !ext))) throw new Error(`Server ${server.id}: languages must map language IDs to extension arrays`);
      if ((server.rootMarkers || []).some(marker => path.isAbsolute(marker) || marker.split(/[\\/]/).includes('..'))) throw new Error(`Server ${server.id}: rootMarkers must stay within each ancestor`);
      return structuredClone(server);
    });
    this.instances = new Map();
    this.disposed = false;
  }

  language(server, file) {
    if (!file) return null;
    for (const [id, extensions] of Object.entries(server.languages)) {
      if (extensions.some(ext => path.basename(file) === ext || file.endsWith(ext.startsWith('.') ? ext : `.${ext}`))) return id;
    }
    return null;
  }

  async rootFor(server, workspace, file, explicit) {
    const roots = await Promise.all((server.roots || []).map(root => safePath(workspace, root, true)));
    const folders = await Promise.all((server.workspaceFolders || []).map(root => safePath(workspace, root, true)));
    let root;
    if (explicit !== undefined) root = await safePath(workspace, explicit, true);
    else if (roots.length || folders.length) {
      const candidates = [...new Set([...roots, ...folders])].filter(candidate => !file || inside(candidate, file)).sort((a, b) => b.length - a.length);
      root = candidates[0];
      if (!root) throw new Error(`File is not covered by configured roots/workspaceFolders for ${server.id}`);
    } else {
      root = workspace;
      let current = file ? path.dirname(file) : workspace;
      outer: while (inside(workspace, current)) {
        for (const marker of server.rootMarkers || []) {
          try {
            await safePath(workspace, path.join(current, marker));
            root = current;
            break outer;
          } catch (error) {
            if (!error.message.includes('ENOENT') && !error.message.includes('ENOTDIR')) throw error;
          }
        }
        if (current === workspace) break;
        current = path.dirname(current);
      }
    }
    if (file && !inside(root, file) && !folders.some(folder => inside(folder, file))) throw new Error('File is outside selected root and workspaceFolders');
    return { root, folders: [...new Set([root, ...folders])] };
  }

  async instanceFor(server, workspace, root, folders, signal) {
    const key = JSON.stringify([workspace, server.id, root, folders]);
    let instance = this.instances.get(key);
    if (instance && !instance.transport.alive) {
      this.instances.delete(key);
      await instance.transport.dispose();
      instance = this.instances.get(key);
    }
    checkAbort(signal);
    if (this.disposed) throw new Error('LSP manager is disposed');
    // No await between checking the bound and reserving the instance slot.
    if (!instance) {
      if (this.instances.size >= this.maxInstances) throw new Error(`LSP instance limit (${this.maxInstances}) reached; dispose the manager or increase maxInstances`);
      instance = { server: server.id, workspace, root, folders, queue: Promise.resolve(), documents: new Map(), diagnostics: new Map(), capabilities: {}, initialized: false };
      const workspaceFolders = folders.map(folder => ({ uri: uriFor(folder), name: path.basename(folder) || folder }));
      instance.transport = new LspTransport({ ...server, cwd: root, timeoutMs: this.timeoutMs,
        onRequest: (method, params) => {
          if (method === 'workspace/applyEdit') return { applied: false, failureReason: 'This LSP client is read-only' };
          if (method === 'workspace/workspaceFolders') return workspaceFolders;
          if (method === 'workspace/configuration') return (params?.items || []).map(item => {
            if (!item.section) return server.settings ?? {};
            return item.section.split('.').reduce((value, name) => value && Object.hasOwn(value, name) ? value[name] : undefined, server.settings) ?? null;
          });
          if (method === 'window/workDoneProgress/create' || method === 'client/registerCapability' || method === 'client/unregisterCapability') return null;
          if (method === 'window/showMessageRequest') return null;
          throw new Error(`Unsupported server request: ${method}`);
        },
        onNotification: (method, params) => {
          if (method !== 'textDocument/publishDiagnostics' || typeof params?.uri !== 'string' || !Array.isArray(params.diagnostics)) return;
          const previous = instance.diagnostics.get(params.uri);
          const document = instance.documents.get(params.uri);
          if (typeof params.version === 'number' && ((document && params.version < document.version) || (previous?.version !== undefined && params.version < previous.version))) return;
          instance.diagnostics.delete(params.uri);
          instance.diagnostics.set(params.uri, { diagnostics: boundedDiagnostics(params.diagnostics), version: params.version });
          while (instance.diagnostics.size > 128) instance.diagnostics.delete(instance.diagnostics.keys().next().value);
          instance.diagnosticWaiters?.get(params.uri)?.resolve(instance.diagnostics.get(params.uri));
        },
      });
      this.instances.set(key, instance);
      instance.ready = (async () => {
        const response = await instance.transport.request('initialize', {
          processId: process.pid, clientInfo: { name: 'dsh-plugin-lsp', version: '0.1.0' },
          rootPath: root, rootUri: uriFor(root), workspaceFolders,
          initializationOptions: server.initializationOptions ?? null,
          capabilities: {
            general: { positionEncodings: ['utf-16'] },
            workspace: { applyEdit: false, configuration: true, workspaceFolders: true },
            textDocument: { synchronization: { dynamicRegistration: false, didSave: false }, diagnostic: { dynamicRegistration: false }, publishDiagnostics: { versionSupport: true }, hover: { contentFormat: ['plaintext', 'markdown'] } },
          },
        }, { signal });
        instance.capabilities = response?.capabilities || {};
        if (instance.capabilities.positionEncoding && instance.capabilities.positionEncoding !== 'utf-16') throw new Error('Language server selected unsupported position encoding (expected utf-16)');
        instance.transport.notify('initialized', {});
        if (server.settings !== undefined) instance.transport.notify('workspace/didChangeConfiguration', { settings: server.settings });
        instance.initialized = true;
      })().catch(async error => {
        if (this.instances.get(key) === instance) this.instances.delete(key);
        await instance.transport.dispose();
        throw error;
      });
    }
    await instance.ready;
    checkAbort(signal);
    return instance;
  }

  waitForDiagnostics(instance, uri, signal) {
    checkAbort(signal);
    const cached = instance.diagnostics.get(uri);
    if (cached) return Promise.resolve(cached);
    if (instance.transport.failure) return Promise.reject(instance.transport.failure);
    return new Promise((resolve, reject) => {
      let timer;
      let finished = false;
      const child = instance.transport.child;
      const finish = (error, value) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        child.removeListener('exit', exit);
        child.removeListener('error', failed);
        instance.diagnosticWaiters.delete(uri);
        if (error) reject(error); else resolve(value);
      };
      const abort = () => finish(abortError());
      const exit = () => finish(instance.transport.failure || new Error('Language server exited while awaiting diagnostics'));
      const failed = error => finish(error);
      instance.diagnosticWaiters ??= new Map();
      instance.diagnosticWaiters.set(uri, { resolve: value => finish(null, value), reject: error => finish(error) });
      signal?.addEventListener('abort', abort, { once: true });
      child.once('exit', exit);
      child.once('error', failed);
      timer = setTimeout(() => finish(null, undefined), this.timeoutMs);
      if (signal?.aborted) abort();
    });
  }

  async readDocument(workspace, file) {
    // Recheck symlink containment immediately before opening; no write handles are used.
    const checked = await safePath(workspace, file);
    const handle = await open(checked, 'r');
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile()) throw new Error(`Not a regular file: ${file}`);
      if (metadata.size > this.maxFileBytes) throw new Error(`File exceeds maxFileBytes (${this.maxFileBytes}): ${file}`);
      const buffer = Buffer.alloc(this.maxFileBytes + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > this.maxFileBytes) throw new Error(`File exceeds maxFileBytes (${this.maxFileBytes}): ${file}`);
      return buffer.subarray(0, length).toString('utf8');
    } finally { await handle.close(); }
  }

  syncDocument(instance, file, languageId, text) {
    const uri = uriFor(file);
    let document = instance.documents.get(uri);
    const sync = instance.capabilities.textDocumentSync;
    const kind = typeof sync === 'number' ? sync : sync?.change;
    if (!document) {
      if (instance.documents.size >= 128) {
        const [oldUri] = instance.documents.keys();
        instance.transport.notify('textDocument/didClose', { textDocument: { uri: oldUri } });
        instance.documents.delete(oldUri);
        instance.diagnostics.delete(oldUri);
      }
      document = { text, version: 1 };
      instance.transport.notify('textDocument/didOpen', { textDocument: { uri, languageId, version: 1, text } });
      instance.documents.set(uri, document);
    } else if (document.text !== text) {
      if (kind === 0 || (typeof sync === 'object' && kind === undefined)) throw new Error('Language server does not support document changes; restart it to reread modified files');
      const change = { text };
      if (kind === 2) {
        const lines = document.text.split(/\r\n|\n|\r/);
        change.range = { start: { line: 0, character: 0 }, end: { line: lines.length - 1, character: lines.at(-1).length } };
        change.rangeLength = document.text.length;
      }
      const version = document.version + 1;
      instance.transport.notify('textDocument/didChange', { textDocument: { uri, version }, contentChanges: [change] });
      instance.documents.set(uri, { text, version });
      instance.diagnostics.delete(uri);
    }
    return uri;
  }

  async execute(input, { workspace = process.cwd(), signal } = {}) {
    if (this.disposed) throw new Error('LSP manager is disposed');
    checkAbort(signal);
    if (!input || typeof input !== 'object') throw new Error('LSP execute requires an argument object');
    const { operation, server: serverId } = input;
    if (operation !== 'status' && operation !== 'diagnostics' && !Object.hasOwn(METHODS, operation)) throw new Error(`Unsupported LSP operation: ${operation}`);
    workspace = await realpath(path.resolve(workspace));
    if (!(await stat(workspace)).isDirectory()) throw new Error('Workspace must be a directory');
    if (operation === 'status') return {
      workspace,
      servers: this.servers.map(server => ({ id: server.id, languages: server.languages })),
      instances: [...this.instances.values()].filter(instance => instance.workspace === workspace).map(instance => ({ server: instance.server, root: instance.root, workspaceFolders: instance.folders, initialized: instance.initialized, alive: instance.transport.alive, documents: instance.documents.size })),
    };
    const needsFile = operation !== 'workspaceSymbols';
    if (needsFile && !input.file) throw new Error(`${operation} requires file`);
    const file = input.file ? await safePath(workspace, input.file) : null;
    const candidates = this.servers.filter(server => (serverId === undefined || server.id === serverId) && (!file || this.language(server, file)));
    if (candidates.length === 0) throw new Error(serverId ? `No matching server/language: ${serverId}` : `No configured language server matches ${file || 'this request'}`);
    if (candidates.length > 1) throw new Error(`Multiple language servers match; specify server: ${candidates.map(server => server.id).join(', ')}`);
    const server = candidates[0];
    const { root, folders } = await this.rootFor(server, workspace, file, input.root);
    const instance = await this.instanceFor(server, workspace, root, folders, signal);
    return queued(instance, async () => {
      if (this.disposed) throw new Error('LSP manager is disposed');
      let uri, text;
      if (file) {
        text = await this.readDocument(workspace, file);
        checkAbort(signal);
        uri = this.syncDocument(instance, file, this.language(server, file), text);
      }
      const params = operation === 'workspaceSymbols' ? { query: typeof input.query === 'string' ? input.query : '' } : { textDocument: { uri } };
      if (POSITIONAL.has(operation)) {
        if (!Number.isSafeInteger(input.line) || input.line < 1 || !Number.isSafeInteger(input.character) || input.character < 1) throw new Error('line and character must be positive 1-based UTF-16 integers');
        const lines = text.split(/\r\n|\n|\r/);
        if (input.line > lines.length || input.character > lines[input.line - 1].length + 1) throw new Error('line/character is outside document bounds');
        params.position = { line: input.line - 1, character: input.character - 1 };
      }
      if (operation === 'references') params.context = { includeDeclaration: true };
      if (operation === 'diagnostics') {
        if (instance.capabilities.diagnosticProvider) {
          const provider = instance.capabilities.diagnosticProvider;
          const report = await instance.transport.request('textDocument/diagnostic', { textDocument: { uri }, ...(provider.identifier ? { identifier: provider.identifier } : {}) }, { signal });
          const items = report?.items ?? instance.diagnostics.get(uri)?.diagnostics ?? [];
          if (!Array.isArray(items)) throw new Error('Language server returned invalid diagnostic items');
          const diagnostics = boundedDiagnostics(items);
          instance.diagnostics.set(uri, { diagnostics, version: instance.documents.get(uri).version });
          while (instance.diagnostics.size > 128) instance.diagnostics.delete(instance.diagnostics.keys().next().value);
          return { uri, diagnostics, source: 'pull', kind: report?.kind ?? 'full', resultId: report?.resultId ?? null };
        }
        // Wait for the first publication, not a fabricated protocol barrier. A quiet
        // server yields pending:true at the deadline rather than a false clean bill.
        const cached = await this.waitForDiagnostics(instance, uri, signal);
        return { uri, diagnostics: cached?.diagnostics ?? [], source: 'push', pending: !cached, version: cached?.version ?? null };
      }
      return await instance.transport.request(METHODS[operation], params, { signal });
    }, signal);
  }

  async dispose() {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    for (const instance of this.instances.values()) {
      for (const waiter of instance.diagnosticWaiters?.values() || []) waiter.reject(new Error('LSP manager is disposed'));
    }
    this.disposePromise = Promise.all([...this.instances.values()].map(instance => instance.transport.dispose())).then(() => { this.instances.clear(); });
    return this.disposePromise;
  }
}
