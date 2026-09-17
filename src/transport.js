import { spawn } from 'node:child_process';

export function abortError() {
  const error = new Error('LSP request aborted');
  error.name = 'AbortError';
  return error;
}

/** Bounded, dependency-free Content-Length JSON-RPC over a child process. */
export class LspTransport {
  constructor({ command, args = [], env, cwd, timeoutMs = 15000, onRequest, onNotification }) {
    this.timeoutMs = timeoutMs;
    this.onRequest = onRequest;
    this.onNotification = onNotification;
    this.pending = new Map();
    this.inboundRequests = 0;
    this.nextId = 1;
    this.buffer = Buffer.alloc(0);
    this.bodyLength = null;
    this.maxMessageBytes = 16 * 1024 * 1024;
    this.stderr = '';
    this.failure = null;
    this.closing = false;
    this.child = spawn(command, args, { cwd, env: { ...process.env, ...env }, shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.exited = new Promise(resolve => { this.resolveExit = resolve; });
    this.child.on('error', error => {
      this.fail(new Error(`Cannot start language server ${command}: ${error.message}`));
      if (!this.child.pid) this.resolveExit();
    });
    this.child.on('exit', (code, signal) => {
      this.fail(new Error(`Language server exited (${signal || code})${this.stderr ? `: ${this.stderr.trim()}` : ''}`));
      this.resolveExit();
    });
    this.child.stdin.on('error', error => this.fail(new Error(`Language server stdin: ${error.message}`)));
    this.child.stdout.on('error', error => this.fail(error));
    this.child.stderr.on('error', () => {});
    this.child.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk.toString('utf8')).slice(-8192); });
    this.child.stdout.on('data', chunk => this.receive(chunk));
  }

  get alive() { return !this.failure && !this.closing; }

  fail(error) {
    if (this.failure) return;
    this.failure = error;
    this.buffer = Buffer.alloc(0);
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
    if (this.child.exitCode === null && this.child.signalCode === null && this.child.pid) {
      this.child.kill('SIGTERM');
      this.killTimer = setTimeout(() => this.child.kill('SIGKILL'), 1000);
      this.killTimer.unref();
      this.exited.then(() => clearTimeout(this.killTimer));
    }
  }

  send(message) {
    if (this.failure) throw this.failure;
    const body = Buffer.from(JSON.stringify(message), 'utf8');
    if (body.length > this.maxMessageBytes) throw new Error('Outgoing LSP message exceeds 16 MiB');
    if (this.child.stdin.writableLength + body.length > this.maxMessageBytes * 2) throw new Error('Language server input queue is full');
    this.child.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
  }

  notify(method, params) { this.send({ jsonrpc: '2.0', method, params }); }

  request(method, params, { signal, timeoutMs = this.timeoutMs } = {}) {
    if (signal?.aborted) return Promise.reject(abortError());
    if (this.failure) return Promise.reject(this.failure);
    if (this.pending.size >= 256) return Promise.reject(new Error('Too many pending LSP requests'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      let timer;
      const finish = (callback, value) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        this.pending.delete(id);
        callback(value);
      };
      const cancelWith = error => {
        if (!this.pending.has(id)) return;
        finish(reject, error);
        try { this.notify('$/cancelRequest', { id }); } catch { /* already dead */ }
      };
      const cancel = () => cancelWith(abortError());
      this.pending.set(id, { resolve: value => finish(resolve, value), reject: error => finish(reject, error) });
      signal?.addEventListener('abort', cancel, { once: true });
      timer = setTimeout(() => cancelWith(new Error(`LSP ${method} timed out after ${timeoutMs} ms`)), timeoutMs);
      try { this.send({ jsonrpc: '2.0', id, method, params }); } catch (error) { finish(reject, error); }
    });
  }

  receive(chunk) {
    if (this.failure) return;
    try {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      while (this.buffer.length) {
        if (this.bodyLength === null) {
          const end = this.buffer.indexOf('\r\n\r\n');
          if (end < 0) {
            if (this.buffer.length > 8192) throw new Error('LSP header exceeds 8 KiB');
            return;
          }
          if (end > 8192) throw new Error('LSP header exceeds 8 KiB');
          const headers = this.buffer.subarray(0, end).toString('ascii').split('\r\n');
          const lengths = headers.filter(line => /^Content-Length:/i.test(line));
          if (lengths.length !== 1 || !/^Content-Length:\s*\d+\s*$/i.test(lengths[0])) throw new Error('Invalid LSP Content-Length header');
          this.bodyLength = Number(lengths[0].split(':')[1].trim());
          if (!Number.isSafeInteger(this.bodyLength) || this.bodyLength < 1 || this.bodyLength > this.maxMessageBytes) throw new Error('LSP response exceeds 16 MiB or has invalid length');
          this.buffer = this.buffer.subarray(end + 4);
        }
        if (this.buffer.length < this.bodyLength) return;
        const message = JSON.parse(this.buffer.subarray(0, this.bodyLength).toString('utf8'));
        this.buffer = this.buffer.subarray(this.bodyLength);
        this.bodyLength = null;
        this.dispatch(message);
      }
    } catch (error) { this.fail(new Error(`Invalid language server protocol: ${error.message}`)); }
  }

  dispatch(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0') throw new Error('Expected a JSON-RPC 2.0 object');
    if (typeof message.method === 'string') {
      if (Object.hasOwn(message, 'id')) {
        if (++this.inboundRequests > 256) throw new Error('Too many concurrent server requests');
        Promise.resolve().then(() => this.onRequest?.(message.method, message.params)).then(result => {
          if (!this.failure) this.send({ jsonrpc: '2.0', id: message.id, result: result ?? null });
        }, error => {
          if (!this.failure) this.send({ jsonrpc: '2.0', id: message.id, error: { code: error.code || -32601, message: error.message } });
        }).catch(error => this.fail(error)).finally(() => { this.inboundRequests--; });
      } else {
        Promise.resolve().then(() => this.onNotification?.(message.method, message.params)).catch(() => {});
      }
      return;
    }
    const entry = this.pending.get(message.id);
    if (!entry) return;
    if (message.error) {
      const error = new Error(`LSP error ${message.error.code}: ${message.error.message}`);
      error.code = message.error.code;
      entry.reject(error);
    } else if (Object.hasOwn(message, 'result')) entry.resolve(message.result);
    else throw new Error('JSON-RPC response lacks result or error');
  }

  async dispose() {
    if (this.disposePromise) return this.disposePromise;
    this.closing = true;
    this.disposePromise = (async () => {
      if (!this.failure) {
        try { await this.request('shutdown', null, { timeoutMs: Math.min(this.timeoutMs, 1500) }); } catch { /* force fallback */ }
        try { this.notify('exit'); } catch { /* already dead */ }
      }
      let timer;
      await Promise.race([this.exited, new Promise(resolve => { timer = setTimeout(resolve, 500); })]);
      clearTimeout(timer);
      if (this.child.exitCode === null && this.child.signalCode === null && this.child.pid) {
        this.child.kill('SIGTERM');
        await Promise.race([this.exited, new Promise(resolve => { timer = setTimeout(resolve, 500); })]);
        clearTimeout(timer);
        if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL');
      }
      this.fail(new Error('Language server disposed'));
      this.child.stdin.destroy();
      this.child.stdout.destroy();
      this.child.stderr.destroy();
    })();
    return this.disposePromise;
  }
}
