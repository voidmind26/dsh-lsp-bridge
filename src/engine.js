import { realpath, stat, open, opendir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { LspTransport, abortError } from './transport.js';
import { applyTextEdits, assertWriteAllowed, editForSingleFile, normalizeWorkspaceEdit, pathFromUri } from './edits.js';

const METHODS = {
  hover: 'textDocument/hover', definition: 'textDocument/definition', references: 'textDocument/references',
  implementation: 'textDocument/implementation', typeDefinition: 'textDocument/typeDefinition',
  documentSymbols: 'textDocument/documentSymbol', workspaceSymbols: 'workspace/symbol',
  rename: 'textDocument/rename', format: 'textDocument/formatting',
};
/** 会写磁盘的操作：需要显式 apply，并受会话权限约束。 */
const WRITE_OPERATIONS = new Set(['rename', 'format']);
const POSITIONAL = new Set(['hover', 'definition', 'references', 'implementation', 'typeDefinition', 'rename']);
// 工作区符号的预热扫描边界：只为了找到一个可打开的文件，不做项目枚举。
const WARMUP_SKIPPED_DIRECTORIES = new Set(['.git', 'node_modules', 'dist', 'build', 'target', 'out', 'coverage', '.next', '.cache', 'vendor']);
const WARMUP_MAX_ENTRIES = 200;
const WARMUP_MAX_DEPTH = 2;
// 每个目录取一个代表文件：TypeScript 的推断项目按目录划分，多开几个目录才能覆盖工作区符号。
const WARMUP_MAX_FILES = 24;
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
    // 受限会话的执行计划由池层解析后注入：confine 包装 argv，sandboxEnv 重定向缓存目录。
    this.confine = typeof config.confine === 'function' ? config.confine : null;
    // 写入模式由池层按会话权限解析：full=完全访问，workspace=只允许工作区内，deny=只读。
    this.writeMode = ['full', 'workspace', 'deny'].includes(config.writeMode) ? config.writeMode : 'workspace';
    this.sandboxEnv = config.sandboxEnv && typeof config.sandboxEnv === 'object' ? config.sandboxEnv : null;
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

  /**
   * 该服务器的项目是否落在当前工作区内：显式根目录必须存在且在工作区内，
   * 否则退回检查工作区根目录的项目标记。两者都无法判断时按“覆盖”处理，
   * 保证工作区符号不会因为无法判断而把服务器排除掉。
   */
  async coversWorkspace(server, workspace) {
    const roots = [...(server.roots ?? []), ...(server.workspaceFolders ?? [])];
    if (roots.length) {
      for (const root of roots) {
        try { await safePath(workspace, root, true); return true; } catch { /* 不在工作区内或不存在 */ }
      }
      return false;
    }
    const markers = server.rootMarkers ?? [];
    if (!markers.length) return true;
    for (const marker of markers) {
      try { await safePath(workspace, path.join(workspace, marker)); return true; } catch { /* 没有该标记 */ }
    }
    return false;
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

  /**
   * 在服务器自己的项目根目录下找一个语言匹配的源文件并打开。
   *
   * 有些服务器（例如 TypeScript 的 tsserver）在没有任何已打开文件时还没有项目，
   * `workspace/symbol` 会直接失败并报告 “No Project.”。这里做一次有界的预热：
   * 最多浏览 200 个目录项、深度 2，只取第一个匹配文件，不做项目枚举。
   */
  async warmupFiles(server, root, signal) {
    const extensions = Object.values(server.languages ?? {}).flat();
    if (!extensions.length) return [];
    const files = [];
    const queue = [{ directory: root, depth: 0 }];
    let visited = 0;
    while (queue.length && visited < WARMUP_MAX_ENTRIES && files.length < WARMUP_MAX_FILES) {
      checkAbort(signal);
      const { directory, depth } = queue.shift();
      let handle;
      try { handle = await opendir(directory); } catch { continue; }
      let entries = [];
      try {
        for await (const entry of handle) {
          checkAbort(signal);
          if (++visited > WARMUP_MAX_ENTRIES) break;
          entries.push(entry);
        }
      } finally { await handle.close?.().catch?.(() => {}); }
      // 目录顺序影响预热覆盖范围，因此按名字排序，保证同样的工作区得到同样的结果。
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        checkAbort(signal);
        if (files.length >= WARMUP_MAX_FILES) break;
        if (entry.isSymbolicLink()) continue;
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (depth < WARMUP_MAX_DEPTH && !entry.name.startsWith('.') && !WARMUP_SKIPPED_DIRECTORIES.has(entry.name)) queue.push({ directory: target, depth: depth + 1 });
          continue;
        }
        if (!entry.isFile()) continue;
        // 同一个目录里的文件未必互相引用（推断项目按文件/目录划分），因此把匹配文件都打开，
        // 而不是只取一个；总量由 WARMUP_MAX_FILES 限制。
        if (extensions.some(extension => entry.name.endsWith(extension))) files.push(target);
      }
    }
    return files;
  }

  /**
   * 冷实例上的工作区符号查询先打开几个代表文件，让服务器建立项目。
   * 有已打开文档时不重复预热：用户自己查过的目录已经在项目里了。
   */
  async warmup(server, instance, workspace, signal) {
    if (instance.documents.size > 0) return 0;
    const candidates = await this.warmupFiles(server, instance.root, signal);
    let opened = 0;
    for (const [index, candidate] of candidates.entries()) {
      const text = await this.readDocument(workspace, candidate);
      checkAbort(signal);
      const uri = this.syncDocument(instance, candidate, this.language(server, candidate), text);
      // 打开文件之外还要等服务器真正处理完并建立项目，否则工作区符号可能得到空结果；
      // 这里只对首个文件发一次请求，其余文件靠 didOpen 计入项目。
      if (index === 0) {
        try { await instance.transport.request('textDocument/documentSymbol', { textDocument: { uri } }, { signal }); }
        catch (error) { if (signal?.aborted) throw error; /* 预热失败不阻断后续查询 */ }
      }
      opened++;
    }
    return opened;
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
      instance.transport = new LspTransport({ ...server, cwd: root, timeoutMs: this.timeoutMs, confine: this.confine,
        env: { ...(this.sandboxEnv ?? {}), ...(server.env ?? {}) },
        onRequest: (method, params) => {
          if (method === 'workspace/applyEdit') return this.applyServerEdit(params?.edit, workspace, signal);
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
          processId: process.pid, clientInfo: { name: 'dsh-lsp-bridge', version: '0.3.0' },
          rootPath: root, rootUri: uriFor(root), workspaceFolders,
          initializationOptions: server.initializationOptions ?? null,
          capabilities: {
            general: { positionEncodings: ['utf-16'] },
            workspace: { applyEdit: this.writeMode !== 'deny', configuration: true, workspaceFolders: true },
            textDocument: { synchronization: { dynamicRegistration: false, didSave: false }, diagnostic: { dynamicRegistration: false }, publishDiagnostics: { versionSupport: true }, hover: { contentFormat: ['plaintext', 'markdown'] } },
          },
        }, { signal });
        instance.capabilities = response?.capabilities || {};
        instance.serverInfo = response?.serverInfo ?? null;
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

  /**
   * 应用语言服务器返回的编辑。
   * dryRun 时只返回计划；真正写入前逐个文件校验权限与路径。
   */
  async applyEdit({ edit, workspace, signal, dryRun }) {
    const files = normalizeWorkspaceEdit(edit);
    const planned = [];
    for (const entry of files) {
      checkAbort(signal);
      const file = pathFromUri(entry.uri);
      if (file === null) throw new Error(`无法解析目标文件 URI：${entry.uri}`);
      // 先判权限（只读会话要给出“需要完全访问权限”的明确提示），再判工作区边界。
      assertWriteAllowed({ mode: this.writeMode, workspace, file });
      let checked;
      try {
        checked = await safePath(workspace, file);
      } catch {
        throw new Error(`目标文件不在会话工作区内：${file}。插件只在会话工作区内应用语言服务器的编辑。`);
      }
      const text = await this.readDocument(workspace, checked);
      const next = applyTextEdits(text, entry.edits);
      planned.push({ uri: entry.uri, file: checked, edits: entry.edits.length, changed: next !== text, next });
    }
    if (dryRun) return { applied: false, dryRun: true, files: planned.map(({ uri, file, edits, changed }) => ({ uri, file, edits, changed })) };
    for (const item of planned) {
      checkAbort(signal);
      if (item.changed) await writeFile(item.file, item.next);
    }
    return { applied: true, dryRun: false, files: planned.map(({ uri, file, edits, changed }) => ({ uri, file, edits, changed })) };
  }

  /** 服务器主动请求应用编辑（例如代码动作）；失败原因会回传给服务器。 */
  async applyServerEdit(edit, workspace, signal) {
    try {
      const result = await this.applyEdit({ edit, workspace, signal, dryRun: false });
      return { applied: result.files.some(item => item.changed) };
    } catch (error) {
      // 只读或工作区外被拒时，把“需要完全访问权限”的原因如实回传。
      if (signal?.aborted) return { applied: false, failureReason: 'LSP request aborted' };
      return { applied: false, failureReason: error.message };
    }
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
    const isWrite = WRITE_OPERATIONS.has(operation);
    if (isWrite && this.writeMode === 'deny') {
      throw new Error(`当前会话是只读权限，${operation} 不会写入磁盘。需要完全访问权限（danger-full-access）才能应用语言服务器的修改。`);
    }
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
    let candidates = this.servers.filter(server => (serverId === undefined || server.id === serverId) && (!file || this.language(server, file)));
    if (candidates.length === 0) throw new Error(serverId ? `No matching server/language: ${serverId}` : `No configured language server matches ${file || 'this request'}`);
    if (candidates.length > 1 && serverId === undefined && !file) {
      // 工作区符号没有文件可推断语言：先按“是否覆盖当前工作区”收窄，
      // 只有多个服务器都覆盖时才要求显式指定，避免让模型平白多猜一次。
      const covering = [];
      for (const candidate of candidates) if (await this.coversWorkspace(candidate, workspace)) covering.push(candidate);
      if (covering.length) candidates = covering;
    }
    if (candidates.length > 1) throw new Error(`Multiple language servers match; specify server: ${candidates.map(server => server.id).join(', ')}`);
    const server = candidates[0];
    const { root, folders } = await this.rootFor(server, workspace, file, input.root);
    const instance = await this.instanceFor(server, workspace, root, folders, signal);
    return queued(instance, async () => {
      if (this.disposed) throw new Error('LSP manager is disposed');
      // 预热必须在打开目标文件之前：warmup 以“已有打开文档”为跳过条件，
      // 而 rename 会先 didOpen 目标文件，晚于它调用就等于没有预热。
      if (operation === 'workspaceSymbols' || operation === 'rename') await this.warmup(server, instance, workspace, signal);
      let uri, text;
      if (file) {
        text = await this.readDocument(workspace, file);
        checkAbort(signal);
        uri = this.syncDocument(instance, file, this.language(server, file), text);
      }
      const params = operation === 'workspaceSymbols'
        ? { query: typeof input.query === 'string' ? input.query : '' }
        : operation === 'format'
          ? { textDocument: { uri }, options: { tabSize: Number.isSafeInteger(input.tabSize) ? input.tabSize : 2, insertSpaces: input.insertSpaces !== false } }
          : { textDocument: { uri } };
      if (POSITIONAL.has(operation)) {
        if (!Number.isSafeInteger(input.line) || input.line < 1 || !Number.isSafeInteger(input.character) || input.character < 1) throw new Error('line and character must be positive 1-based UTF-16 integers');
        const lines = text.split(/\r\n|\n|\r/);
        if (input.line > lines.length || input.character > lines[input.line - 1].length + 1) throw new Error('line/character is outside document bounds');
        params.position = { line: input.line - 1, character: input.character - 1 };
      }
      if (operation === 'references') params.context = { includeDeclaration: true };
      if (operation === 'rename') {
        if (typeof input.newName !== 'string' || !input.newName) throw new Error('rename requires newName');
        params.newName = input.newName;
      }
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
      const response = await instance.transport.request(METHODS[operation], params, { signal });
      if (!isWrite) return response;
      // 格式化的返回是 TextEdit[]，重命名返回 WorkspaceEdit；统一按 WorkspaceEdit 应用。
      const edit = operation === 'format' ? editForSingleFile(uri, response) : response;
      if (edit === null || edit === undefined) return { applied: false, dryRun: input.apply !== true, files: [] };
      const applied = await this.applyEdit({ edit, workspace, signal, dryRun: input.apply !== true });
      return { operation, ...applied };
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

/**
 * 用一次性 manager 真实启动一个服务器，完成 initialize 后立即关闭。
 * 用于安装后验证“能找到程序”确实等于“能工作”；不保留任何常驻实例。
 * 失败时抛出包含服务器 stderr 的错误，便于直接展示原因。
 */
export async function probeLanguageServer({ server, workspace, root, timeoutMs = 15000, signal, confine, env } = {}) {
  const manager = new LspManager({ servers: [server], timeoutMs, maxInstances: 1, confine, sandboxEnv: env });
  try {
    const parsed = manager.servers[0];
    const resolved = await manager.rootFor(parsed, workspace, undefined, root === undefined ? undefined : root);
    const instance = await manager.instanceFor(parsed, workspace, resolved.root, resolved.folders, signal);
    return {
      root: resolved.root,
      folders: resolved.folders,
      serverInfo: instance.serverInfo,
      capabilities: Object.keys(instance.capabilities ?? {}).sort(),
      positionEncoding: instance.capabilities?.positionEncoding ?? null,
    };
  } finally {
    await manager.dispose();
  }
}
