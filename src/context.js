/**
 * 把“当前工作区有哪些语言服务可用”注入模型上下文。
 *
 * 约束：
 * - `systemPrompt.context` 的 text 回调在每次装配时**同步**求值，因此这里只读内存状态，
 *   绝不做文件系统扫描或启动进程；代价恒定且不产生副作用。
 * - 诊断/验证结果来自缓存（界面扫描或 lsp_setup 调用时写入），过期即忽略，
 *   避免把旧结论当成现状。
 * - 没有任何已配置服务器时返回空字符串，不占用上下文。
 */
import { basename } from 'node:path';

/** 紧随 sandbox / approval 等策略上下文之后。 */
export const CONTEXT_ORDER = 130;
export const DIAGNOSIS_TTL_MS = 10 * 60 * 1000;
export const MAX_CONTEXT_SERVERS = 6;

const STATUS_TEXT = {
  ready: '可用',
  'needs-choice': '需要选择程序路径',
  'missing-command': '未安装该语言服务器',
  'missing-dependency': '缺少运行组件',
};

/** 按工作区缓存最近一次诊断（含验证结果）。 */
export class DiagnosisCache {
  constructor({ ttlMs = DIAGNOSIS_TTL_MS, now = Date.now } = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.entries = new Map();
  }

  set(workspace, value) {
    if (typeof workspace !== 'string' || !workspace) return;
    this.entries.set(workspace, { value, at: this.now() });
  }

  get(workspace) {
    const entry = this.entries.get(workspace);
    if (!entry) return null;
    if (this.now() - entry.at > this.ttlMs) {
      this.entries.delete(workspace);
      return null;
    }
    return entry.value;
  }

  clear() {
    this.entries.clear();
  }
}

/** 把一条服务器状态渲染成人类可读的一行。 */
function serverLine(server, entry) {
  const languages = Object.keys(server?.languages ?? {}).join('/') || '未声明语言';
  let state;
  if (!entry) state = '本次未在本工作区扫描到（可能属于其它项目）';
  else state = STATUS_TEXT[entry.status] ?? entry.status;
  return `- ${server?.id}（${languages}）：${state}`;
}

/**
 * 同步渲染上下文片段；`session` 与 `config` 缺失时返回空字符串。
 * @returns 供 systemPrompt 使用的纯文本，或空字符串表示不注入。
 */
export function renderLspContext({ session, config, cache } = {}) {
  const cwd = session?.header?.cwd;
  if (typeof cwd !== 'string' || !cwd) return '';
  const configured = config?.servers ?? [];
  if (!configured.length) return '';
  const diagnosis = cache?.get(cwd) ?? null;
  const byId = new Map((diagnosis?.servers ?? []).map(entry => [entry.serverId, entry]));

  const lines = configured.slice(0, MAX_CONTEXT_SERVERS).map(server => serverLine(server, byId.get(server?.id)));
  if (configured.length > MAX_CONTEXT_SERVERS) lines.push(`- …另有 ${configured.length - MAX_CONTEXT_SERVERS} 个已配置服务器`);

  const verification = diagnosis?.verification ?? [];
  const verified = verification.length
    ? `最近一次真实验证：${verification.map(item => `${item.serverId}=${item.ok ? '通过' : '失败'}`).join('、')}。`
    : null;

  return [
    `[dsh-lsp-bridge] 工作区 ${basename(cwd)} 的语言服务：`,
    ...lines,
    verified,
    '代码导航优先用 lsp 工具（定义/引用/悬停/符号/诊断，行列从 1 开始且按 UTF-16 计）；缺组件或未安装时用 lsp_setup 自动安装并写回配置。',
  ].filter(Boolean).join('\n');
}