import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { LspManager } from './engine.js';

// 部署默认权限没有独立变更事件；此间隔也为未发布事件的宿主提供兜底。
export const POLICY_POLL_INTERVAL_MS = 1000;

/** 受限会话中把服务器的缓存目录重定向到可写位置（沙箱只允许写工作区与临时目录）。 */
export const CACHE_DIRECTORY_NAME = 'dsh-lsp-bridge';
const REDIRECTED_CACHE_KEYS = Object.freeze(['GOCACHE', 'GOTMPDIR', 'XDG_CACHE_HOME']);

/** 校验 sandbox 配置：仅在受限会话中使用，danger-full-access 不受影响。 */
export function normalizeSandboxConfig(input = {}, { env = process.env } = {}) {
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!object(input)) throw new TypeError('sandbox 必须是对象');
  const allowed = new Set(['redirectCaches', 'cacheDirectory']);
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw new TypeError(`sandbox: 未知配置项 ${key}`);
  const redirectCaches = input.redirectCaches ?? true;
  if (typeof redirectCaches !== 'boolean') throw new TypeError('sandbox.redirectCaches 必须是布尔值');
  const cacheDirectory = input.cacheDirectory ?? join(tmpdir(), CACHE_DIRECTORY_NAME);
  if (typeof cacheDirectory !== 'string' || !isAbsolute(cacheDirectory)) throw new TypeError('sandbox.cacheDirectory 必须是绝对路径');
  return { redirectCaches, cacheDirectory };
}

/** 受限会话下注入的服务器环境：只补齐管理员没有显式设置的缓存变量。 */
export function sandboxEnvironment(config, { env = process.env } = {}) {
  if (!config.redirectCaches) return null;
  const additions = {};
  for (const key of REDIRECTED_CACHE_KEYS) {
    if (env[key] === undefined) additions[key] = config.cacheDirectory;
  }
  return Object.keys(additions).length ? additions : null;
}

/** 按会话对象身份和 cwd 隔离；同一持久 ID 的重新加载对象不得继承旧权限或进程。 */
export class LspSessionPool {
  constructor(config, resolvePolicy, options = {}) {
    // 旧签名把 createManager 作为第三个位置参数；保持兼容，避免调用方被迫改写。
    const { createManager = value => new LspManager(value), confine = null, sandbox = null, hasSandbox = null } = typeof options === 'function' ? { createManager: options } : options;
    this.config = config;
    this.resolvePolicy = resolvePolicy;
    this.createManager = createManager;
    // 沙箱服务的 confine(argv, policy) 包装函数；缺少它时受限会话失败关闭。
    this.confine = confine;
    // 沙箱服务按需加载，因此用谓词判断“现在是否真的可用”，不可用时失败关闭。
    this.hasSandbox = typeof hasSandbox === 'function' ? hasSandbox : () => typeof confine === 'function';
    this.sandboxConfig = sandbox ?? normalizeSandboxConfig({});
    this.entries = new Set();
    this.closedSessions = new WeakSet();
    this.disposed = false;
    this.timer = setInterval(() => this.sweep(), Math.min(config.idleTimeoutMs, POLICY_POLL_INTERVAL_MS));
    this.timer.unref?.();
  }

  /**
   * 决定这次执行如何在给定会话的权限下运行。
   *
   * danger-full-access：按原有行为直接启动（用户已明确授权无沙箱执行）。
   * 其它模式：必须由沙箱服务包装 argv，让语言服务器接受与会话相同的文件约束；
   * 拿不到沙箱后端时失败关闭，绝不退化成无沙箱启动。
   */
  executionFor(session) {
    if (this.disposed) throw new Error('LSP plugin is disposed');
    if (this.closedSessions.has(session)) throw new Error('LSP session is disposed');
    let policy;
    try { policy = this.resolvePolicy(session); }
    catch (error) {
      this.retireSession(session, error);
      throw error;
    }
    // 写入模式与会话权限一致：完全访问不额外限制；workspace-write 只允许工作区内；read-only 拒绝写入。
    const writeMode = policy?.mode === 'danger-full-access' ? 'full' : policy?.mode === 'read-only' ? 'deny' : 'workspace';
    if (policy?.mode === 'danger-full-access') return { mode: 'danger-full-access', policy, confine: null, env: null, writeMode };
    if (typeof this.confine !== 'function' || !this.hasSandbox()) {
      const error = new Error(`LSP server execution requires an available sandbox backend for the ${policy?.mode ?? 'unknown'} policy, but no sandbox service is loaded. A human must choose danger-full-access, or the deployment must provide a usable sandbox runner. No process was started by this call.`);
      this.retireSession(session, error);
      throw error;
    }
    return { mode: policy?.mode ?? 'unknown', policy, confine: this.confine, env: sandboxEnvironment(this.sandboxConfig), writeMode };
  }

  /** 兼容旧调用点：只做权限判定，不返回执行计划。 */
  checkPermission(session) {
    this.executionFor(session);
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
    try { this.executionFor(session); } catch { /* 已同步退休 */ }
  }

  sweep() {
    if (this.disposed) return;
    const now = Date.now();
    for (const entry of this.entries) {
      if (entry.retired) continue;
      try { this.executionFor(entry.session); } catch { continue; }
      if (entry.active === 0 && now - entry.lastUsed >= this.config.idleTimeoutMs) this.retire(entry);
    }
  }

  async acquire(session, workspace, signal) {
    for (;;) {
      const execution = this.executionFor(session);
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
        entry = {
          session, workspace, controller: new AbortController(), active: 0, lastUsed: Date.now(), retired: false, closing: null,
          mode: execution.mode,
          manager: this.createManager({ ...this.config, confine: execution.confine, sandboxEnv: execution.env, writeMode: execution.writeMode }),
        };
        this.entries.add(entry);
      }
      entry.active++;
      return entry;
    }
  }

  async execute(args, { session, workspace, signal }) {
    const entry = await this.acquire(session, workspace, signal);
    try {
      this.executionFor(session);
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
