import { LspManager } from './engine.js';

// 部署默认权限没有独立变更事件；此间隔也为未发布事件的宿主提供兜底。
export const POLICY_POLL_INTERVAL_MS = 1000;

/** 按会话对象身份和 cwd 隔离；同一持久 ID 的重新加载对象不得继承旧权限或进程。 */
export class LspSessionPool {
  constructor(config, resolvePolicy, createManager = value => new LspManager(value)) {
    this.config = config;
    this.resolvePolicy = resolvePolicy;
    this.createManager = createManager;
    this.entries = new Set();
    this.closedSessions = new WeakSet();
    this.disposed = false;
    this.timer = setInterval(() => this.sweep(), Math.min(config.idleTimeoutMs, POLICY_POLL_INTERVAL_MS));
    this.timer.unref?.();
  }

  checkPermission(session) {
    if (this.disposed) throw new Error('LSP plugin is disposed');
    if (this.closedSessions.has(session)) throw new Error('LSP session is disposed');
    let policy;
    try { policy = this.resolvePolicy(session); }
    catch (error) {
      this.retireSession(session, error);
      throw error;
    }
    if (policy?.mode !== 'danger-full-access') {
      const error = new Error(`LSP server execution denied under ${policy?.mode ?? 'unknown'} policy. This plugin launches trusted language servers without an OS sandbox; it cannot run in restricted sessions. A human must explicitly choose danger-full-access before use. No process was started by this call.`);
      this.retireSession(session, error);
      throw error;
    }
  }

  // 先标记不可租用，再取消；关闭中的条目仍占配额，直到 dispose 真正完成。
  retire(entry, reason = new Error('LSP session retired')) {
    if (entry.closing) return entry.closing;
    entry.retired = true;
    entry.controller.abort(reason);
    entry.closing = Promise.resolve().then(() => entry.manager.dispose()).then(() => {
      this.entries.delete(entry);
    });
    // 周期/事件回收是 fire-and-forget；失败时保留退休槽，禁止越过进程上限。
    entry.closing.catch(() => {});
    return entry.closing;
  }

  retireSession(session, reason) {
    return Promise.allSettled([...this.entries].filter(entry => entry.session === session).map(entry => this.retire(entry, reason)));
  }

  sessionDisposed(session) {
    this.closedSessions.add(session);
    return this.retireSession(session, new Error('LSP session disposed'));
  }

  policyChanged(session, event) {
    if (event?.type !== 'sandbox/mode') return;
    // 不依赖其他 session/event 监听器更新 projection 的先后顺序。
    if (event.data?.mode !== 'danger-full-access') {
      return this.retireSession(session, new Error('LSP session permissions tightened'));
    }
    try { this.checkPermission(session); } catch { /* 已同步退休 */ }
  }

  sweep() {
    if (this.disposed) return;
    const now = Date.now();
    for (const entry of this.entries) {
      if (entry.retired) continue;
      try { this.checkPermission(entry.session); } catch { continue; }
      if (entry.active === 0 && now - entry.lastUsed >= this.config.idleTimeoutMs) this.retire(entry);
    }
  }

  async acquire(session, workspace, signal) {
    for (;;) {
      this.checkPermission(session);
      signal?.throwIfAborted();
      this.sweep();
      let entry = [...this.entries].find(item => !item.retired && item.session === session && item.workspace === workspace);
      if (!entry && this.entries.size >= this.config.maxSessions) {
        const idle = [...this.entries].filter(item => !item.retired && item.active === 0).sort((a, b) => a.lastUsed - b.lastUsed)[0];
        if (idle) await this.retire(idle);
        else {
          const closing = [...this.entries].filter(item => item.retired).map(item => item.closing);
          if (!closing.length) throw new Error(`LSP session limit (${this.config.maxSessions}) reached; all sessions are active`);
          await Promise.race(closing);
        }
        // await 期间可能发生权限变更、卸载、其他请求抢占，必须重新检查。
        continue;
      }
      if (!entry) {
        entry = { session, workspace, manager: this.createManager(this.config), controller: new AbortController(), active: 0, lastUsed: Date.now(), retired: false, closing: null };
        this.entries.add(entry);
      }
      entry.active++;
      return entry;
    }
  }

  async execute(args, { session, workspace, signal }) {
    const entry = await this.acquire(session, workspace, signal);
    try {
      this.checkPermission(session);
      if (entry.retired) throw new Error('LSP session was retired');
      const combined = signal ? AbortSignal.any([signal, entry.controller.signal]) : entry.controller.signal;
      combined.throwIfAborted();
      return await entry.manager.execute(args, { workspace, signal: combined });
    } finally {
      entry.active--;
      entry.lastUsed = Date.now();
    }
  }

  dispose() {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    clearInterval(this.timer);
    this.disposePromise = Promise.allSettled([...this.entries].map(entry => this.retire(entry, new Error('LSP plugin disposed'))));
    return this.disposePromise;
  }
}
