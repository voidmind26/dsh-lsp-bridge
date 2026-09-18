window.__ModuleLoader__.load({
  id: 'dsh-lsp-bridge',
  factory: (require) => {
    const exports = {};
    const React = require('react');
    const { useEffect, useMemo, useRef, useState, useSyncExternalStore } = React;
    const h = React.createElement;
    const NS = 'dsh-lsp-bridge';
    const API = '/api/dsh-lsp-bridge/discovery';
    const EMPTY = '{\n  "servers": []\n}';
    /** 目录与 id 只用于摘要展示：路径取最后一段，id 截断，完整值另行提供。 */
    const shortPath = value => { const text = String(value ?? '').replace(/[\\/]+$/, ''); return text.split(/[\\/]/).pop() || text; };
    const shortId = value => String(value ?? '').slice(0, 8);
    const sessionLabel = session => `${shortPath(session?.cwd)} · ${shortId(session?.id)}`;
    const serverLanguages = server => server?.languages && typeof server.languages === 'object' ? Object.keys(server.languages) : [];
    const css = `
      .lsp-settings{max-width:960px;margin:0 auto;color:var(--dsw-alias-label-primary);font:inherit;display:flex;flex-direction:column;gap:24px;padding-bottom:24px}
      .lsp-settings *{box-sizing:border-box}.lsp-settings h2,.lsp-settings h3,.lsp-settings p{margin:0}
      .lsp-settings .lsp-header,.lsp-settings .lsp-row{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
      .lsp-settings h2{font-size:22px;font-weight:600;line-height:1.5}.lsp-settings h3{font-size:15px;font-weight:600}
      .lsp-settings .lsp-muted{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.7}
      .lsp-settings .lsp-ellipsis{display:block;min-width:0;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .lsp-settings .lsp-section{border:1px solid var(--dsw-alias-border-l2);border-radius:16px;padding:20px;display:flex;flex-direction:column;gap:16px;min-width:0}
      .lsp-settings .lsp-step{display:flex;align-items:center;gap:10px}.lsp-settings .lsp-number{display:grid;place-items:center;width:26px;height:26px;border-radius:50%;background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l2);font-size:12px;flex-shrink:0}
      .lsp-settings .lsp-controls{display:flex;gap:8px;align-items:end;flex-wrap:wrap}.lsp-settings .lsp-field{display:flex;flex-direction:column;gap:8px;min-width:0;flex:1 1 240px;font-size:13px}
      .lsp-settings button,.lsp-settings select{border:1px solid var(--dsw-alias-border-l2);border-radius:9px;padding:9px 12px;min-height:38px;font:inherit;font-size:13px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary)}
      .lsp-settings button{cursor:pointer}.lsp-settings button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}.lsp-settings button:disabled{opacity:.45;cursor:not-allowed}
      .lsp-settings .lsp-primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);border-color:transparent}
      .lsp-settings :is(button,select,textarea,input,summary):focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:3px}
      .lsp-settings select{width:100%;min-width:0;text-overflow:ellipsis}.lsp-settings .lsp-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr));gap:12px}
      .lsp-settings .lsp-card{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:14px;display:flex;flex-direction:column;gap:10px;min-width:0}
      .lsp-settings .lsp-card-head{display:flex;align-items:center;gap:10px;width:100%;text-align:left;padding:2px;margin:-2px;background:none;border:0;min-height:0;font:inherit;color:inherit;cursor:pointer;border-radius:8px}
      .lsp-settings .lsp-card-head:hover:not(:disabled){background:none;color:var(--dsw-alias-brand-primary)}
      .lsp-settings .lsp-card-title{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
      .lsp-settings .lsp-card-title strong{overflow-wrap:anywhere}
      .lsp-settings .lsp-card-title .lsp-muted{display:block;min-width:0;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .lsp-settings .lsp-chevron{color:var(--dsw-alias-label-tertiary);flex-shrink:0;width:12px}
      .lsp-settings .lsp-card-body{display:flex;flex-direction:column;gap:10px;min-width:0}
      .lsp-settings [hidden]{display:none !important}
      .lsp-settings .lsp-badges{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;flex-shrink:0}
      .lsp-settings .lsp-badge{display:inline-flex;align-items:center;gap:5px;font-size:11px;line-height:1.5;padding:3px 8px;border-radius:6px;background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l2);white-space:nowrap}
      .lsp-settings .lsp-success{color:var(--dsw-alias-state-success-primary)}.lsp-settings .lsp-warning{color:var(--dsw-alias-state-warn-label)}
      .lsp-settings .lsp-code{display:block;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;line-height:1.7;overflow-wrap:anywhere;white-space:pre-wrap}
      .lsp-settings .lsp-code.lsp-ellipsis{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .lsp-settings .lsp-inset{padding:12px;border-radius:9px;background:var(--dsw-alias-bg-layer-3);display:flex;flex-direction:column;gap:6px}
      .lsp-settings details{min-width:0}.lsp-settings summary{cursor:pointer;font-size:13px;line-height:1.7}.lsp-settings details[open]>summary{margin-bottom:12px}
      .lsp-settings .lsp-projects{margin:0;padding-left:20px;display:flex;flex-direction:column;gap:10px}.lsp-settings .lsp-empty{border:1px dashed var(--dsw-alias-border-l2);padding:20px;border-radius:12px}
      .lsp-settings textarea{width:100%;min-height:280px;resize:vertical;padding:14px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:12px/1.8 ui-monospace,SFMono-Regular,Consolas,monospace;tab-size:2}
      .lsp-settings .lsp-footer{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;border-top:1px solid var(--dsw-alias-border-l2);padding-top:16px}.lsp-settings .lsp-actions{display:flex;gap:8px;flex-wrap:wrap}
      .lsp-settings .lsp-alert{padding:12px 14px;border-radius:9px;background:var(--dsw-alias-bg-layer-3);font-size:13px;line-height:1.7;overflow-wrap:anywhere}.lsp-settings .lsp-error{color:var(--dsw-alias-state-error-primary)}
      @media(max-width:600px){.lsp-settings{gap:16px}.lsp-settings .lsp-section{padding:14px}.lsp-settings .lsp-controls>*{flex:1 1 100%}.lsp-settings .lsp-footer{align-items:stretch}.lsp-settings .lsp-actions{width:100%}.lsp-settings .lsp-actions button{flex:1}}
    `;
    const badge = (text, tone = '') => h('span', { className: `lsp-badge ${tone}` }, text);
    const step = (number, title, subtitle) => h('div', null,
      h('div', { className: 'lsp-step' }, h('span', { className: 'lsp-number', 'aria-hidden': true }, number), h('h3', null, title)),
      h('p', { className: 'lsp-muted', style: { marginTop: 8 } }, subtitle));

    async function jsonRequest(method, body) {
      const response = await fetch(API, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
      const value = await response.json().catch(() => ({}));
      if (!response.ok || value.error) throw new Error(value.error?.message || (typeof value.error === 'string' ? value.error : `请求失败：HTTP ${response.status}`));
      return value;
    }

    function parseConfig(text) {
      const value = JSON.parse(text);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('配置必须是 JSON 对象');
      if (value.servers !== undefined && !Array.isArray(value.servers)) throw new Error('servers 必须是数组');
      return value;
    }

    const planKey = entry => `${entry.language}:${entry.serverId}`;
    const STATUS_TEXT = { ready: '可用', 'needs-choice': '待选择', 'missing-command': '未安装', 'missing-dependency': '缺少运行组件' };
    const unsatisfied = entry => (entry.dependencies || []).some(dependency => !dependency.satisfied);

    /** 只挑选真正可写入配置的服务器：有命令且运行组件齐备。 */
    function selectedServers(report, choices = {}) {
      return (report.servers || []).flatMap(entry => {
        const command = entry.status === 'ready' ? entry.command : entry.status === 'needs-choice' && (entry.candidates || []).includes(choices[planKey(entry)]) ? choices[planKey(entry)] : null;
        if (!command || unsatisfied(entry)) return [];
        return [{ id: entry.serverId, command, args: entry.args, languages: entry.languages, rootMarkers: entry.rootMarkers, roots: entry.roots, ...(entry.initializationOptions === undefined ? {} : { initializationOptions: entry.initializationOptions }) }];
      });
    }

    function suggestedConfig(report, currentText, choices = {}) {
      // JSON 无效时停止合并，绝不以空配置替换用户原有数据。
      const current = parseConfig(currentText);
      const servers = [...(current.servers || [])];
      for (const server of selectedServers(report, choices)) {
        const index = servers.findIndex(existing => existing?.id === server.id);
        if (index < 0) servers.push(server);
        else servers[index] = { ...servers[index], ...server };
      }
      return JSON.stringify({ ...current, servers }, null, 2);
    }

    /** 折叠卡片：默认只显示一行摘要，展开后才渲染细节，避免一页铺满所有信息。 */
    function DisclosureCard({ title, badges = [], summary, open, onToggle, id, children }) {
      return h('article', { className: 'lsp-card' },
        h('button', { type: 'button', className: 'lsp-card-head', 'aria-expanded': open, 'aria-controls': id, onClick: onToggle },
          h('span', { className: 'lsp-chevron', 'aria-hidden': true }, open ? '▾' : '▸'),
          h('span', { className: 'lsp-card-title' },
            h('strong', null, title),
            summary ? h('span', { className: 'lsp-muted' }, summary) : null),
          h('span', { className: 'lsp-badges' }, badges)),
        h('div', { className: 'lsp-card-body', id, hidden: !open }, children));
    }

    /** 验证状态：只有真实启动并完成 initialize 才算“验证通过”。 */
    const verifyBadge = item => item
      ? badge(item.ok ? '验证通过' : '验证失败', item.ok ? 'lsp-success' : 'lsp-error')
      : badge('未验证', '');

    /** 验证结果详情，放进展开正文。 */
    function VerificationDetail({ item }) {
      if (!item) return h('p', { className: 'lsp-muted' }, '尚未验证：本次未启动该服务器（缺少程序或运行组件时不会验证）。');
      if (!item.ok) return h('div', { className: 'lsp-inset' },
        h('p', { className: 'lsp-muted' }, '验证失败（服务器启动或 initialize 未通过）'),
        h('code', { className: 'lsp-code' }, item.error || '未知错误'));
      return h('div', { className: 'lsp-inset' },
        h('p', { className: 'lsp-muted' }, `验证通过 · ${(item.capabilities || []).length} 项能力${item.positionEncoding ? ` · ${item.positionEncoding}` : ''}`),
        item.serverInfo ? h('p', { className: 'lsp-muted' }, `服务器信息：${JSON.stringify(item.serverInfo)}`) : null,
        item.root ? h('code', { className: 'lsp-code lsp-ellipsis', title: item.root }, `项目根目录：${item.root}`) : null,
        (item.capabilities || []).length ? h('p', { className: 'lsp-muted' }, `能力：${item.capabilities.join('、')}`) : null);
    }

    /** 安装计划摘要：让用户看到将要执行的确切命令，而不是一句“自动安装”。 */
    function InstallPlan({ entry }) {
      const plan = entry.install || {};
      if (!plan.available) {
        return h('div', { className: 'lsp-inset' },
          h('p', { className: 'lsp-muted' }, plan.reason === 'no-portable-installer' ? '没有可移植的自动安装方案，需人工安装' : '当前环境无法自动安装'),
          entry.installAdvice ? h('code', { className: 'lsp-code' }, entry.installAdvice) : null);
      }
      return h('div', { className: 'lsp-inset' },
        h('p', { className: 'lsp-muted' }, `自动安装方案 · ${plan.kind}${plan.manager ? ` (${plan.manager})` : ''}，安装到插件私有目录：${plan.prefix || plan.directory}。不修改业务工程，也不使用 sudo。`),
        h('ul', { className: 'lsp-projects' }, (plan.steps || []).map((step, index) => h('li', { key: index },
          h('code', { className: 'lsp-code' }, `${step.file} ${step.args.join(' ')}`)))));
    }

    /** 每张候选卡片给出“能不能用、缺什么、下一步做什么”；细节由展开控制。 */
    function ServerCard({ entry, choices, onChoose, open, onToggle, verification }) {
      const missing = unsatisfied(entry);
      const tone = entry.status === 'ready' ? 'lsp-success' : 'lsp-warning';
      const summary = `${entry.language} · ${(entry.roots || []).length} 个项目根目录${entry.status === 'ready' && entry.commandSource === 'plugin' ? ' · 插件安装' : ''}`;
      return h(DisclosureCard, {
        id: `lsp-server-${entry.serverId}`, title: entry.serverId,
        badges: [badge(STATUS_TEXT[entry.status] || entry.status, tone), verifyBadge(verification)],
        summary, open, onToggle,
      },
      entry.status === 'ready' ? h('code', { className: 'lsp-code' }, entry.command) : null,
      entry.status === 'needs-choice' ? h('label', { className: 'lsp-field' }, '选择可信的程序路径',
        h('select', { 'aria-label': `${entry.serverId} 程序候选`, value: choices[planKey(entry)] || '', onChange: event => onChoose(planKey(entry), event.target.value) },
          h('option', { value: '' }, '请选择程序（不自动选择）'),
          (entry.candidates || []).map(candidate => h('option', { key: candidate, value: candidate }, candidate))),
        choices[planKey(entry)] ? h('code', { className: 'lsp-code' }, choices[planKey(entry)]) : null) : null,
      (entry.dependencies || []).length ? h('div', { className: 'lsp-inset' },
        h('p', { className: 'lsp-muted' }, '运行组件'),
        (entry.dependencies || []).map(dependency => h('div', { key: dependency.id },
          h('p', { className: 'lsp-muted' }, `${dependency.satisfied ? '✓ ' : ''}${dependency.description || dependency.id}`),
          dependency.satisfied
            ? (dependency.resolvedPath ? h('code', { className: 'lsp-code lsp-ellipsis', title: dependency.resolvedPath }, dependency.resolvedPath) : null)
            : h('p', { className: 'lsp-muted' }, dependency.reason || '缺少该组件')))) : null,
      entry.status === 'missing-command' || missing ? h(InstallPlan, { entry }) : null,
      entry.status === 'ready' || entry.status === 'needs-choice' ? null : h('p', { className: 'lsp-muted' }, '可让智能体直接执行自动安装：调用 lsp_setup（operation="auto", apply=true）。'),
      (entry.roots || []).length ? h('p', { className: 'lsp-muted lsp-ellipsis', title: (entry.roots || []).join('\n') }, `项目根目录：${(entry.roots || []).join('、')}`) : null);
    }

    function DiscoveryReport({ report, choices, onChoose, verification = {} }) {
      const servers = report.servers || [];
      const [expanded, setExpanded] = useState({});
      const usable = servers.filter(entry => entry.status === 'ready' && !unsatisfied(entry)).length;
      const allOpen = servers.length > 0 && servers.every(entry => expanded[planKey(entry)]);
      const setAll = value => setExpanded(Object.fromEntries(servers.map(entry => [planKey(entry), value])));
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 16 } },
        h('div', { className: 'lsp-row' },
          h('p', { className: 'lsp-muted' }, `发现 ${(report.projects || []).length} 个项目，${servers.length} 个语言服务器，其中 ${usable} 个可直接使用`),
          h('div', { className: 'lsp-actions' },
            h('button', { type: 'button', disabled: allOpen || !servers.length, onClick: () => setAll(true) }, '展开全部'),
            h('button', { type: 'button', disabled: !servers.some(entry => expanded[planKey(entry)]), onClick: () => setAll(false) }, '收起全部'),
            badge(report.complete ? '扫描完成' : '扫描已截断', report.complete ? 'lsp-success' : 'lsp-warning'))),
        !report.complete ? h('p', { className: 'lsp-muted' }, '扫描达到限制，以下不是完整结果。可选择范围更小的工作区重新扫描，或在高级 JSON 中补充配置。') : null,
        h('div', { className: 'lsp-grid' }, servers.map(entry => h(ServerCard, {
          key: planKey(entry), entry, choices, onChoose, verification: verification[entry.serverId],
          open: Boolean(expanded[planKey(entry)]),
          onToggle: () => setExpanded(previous => ({ ...previous, [planKey(entry)]: !previous[planKey(entry)] })),
        }))),
        !servers.length ? h('p', { className: 'lsp-empty lsp-muted' }, '未发现支持的项目类型。你仍可在高级 JSON 中手工配置其他语言服务器。') : null,
        h('details', null, h('summary', null, `查看项目路径（${(report.projects || []).length}）`),
          h('ul', { className: 'lsp-projects' }, (report.projects || []).map(project => h('li', { key: `${project.language}:${project.root}` },
            h('code', { className: 'lsp-code' }, project.root), h('p', { className: 'lsp-muted' }, `${project.language} · ${project.markers.join(', ')}`))))));
    }

    function LspSettingsCard({ scope }) {
      const snapshot = useSyncExternalStore(scope.subscribe.bind(scope), scope.getSnapshot.bind(scope));
      const stored = snapshot.value?.configJson || EMPTY;
      const [draft, setDraft] = useState(stored);
      const [dirty, setDirty] = useState(false);
      const [sessions, setSessions] = useState([]);
      const [sessionId, setSessionId] = useState('');
      const [report, setReport] = useState(null);
      const [choices, setChoices] = useState({});
      const [openServers, setOpenServers] = useState({});
      const [error, setError] = useState('');
      const [busy, setBusy] = useState(false);
      const [notice, setNotice] = useState('');
      // 'list' 只看已配置的服务器；'add' 是独立的扫描与编辑视图。
      const [view, setView] = useState('list');
      const [verification, setVerification] = useState({});
      const editor = useRef({ dirty: false, revision: snapshot.revision });
      const request = useRef(0);
      const sessionRequest = useRef(0);
      const selectedSession = useRef('');
      useEffect(() => {
        // describe 或其他客户端更新不得覆盖本地脏草稿；保留编辑起点用于 CAS。
        if (!editor.current.dirty) {
          setDraft(stored);
          editor.current.revision = snapshot.revision;
        }
      }, [stored, snapshot.revision]);
      // 打开设置页即自动扫描一次并做一次短暂验证，避免用户先看到“未扫描”。
      useEffect(() => { void refreshSessions({ autoScan: true }); return () => { request.current++; sessionRequest.current++; }; }, []);
      const parsed = useMemo(() => { try { return { value: parseConfig(draft) }; } catch (err) { return { error: err.message }; } }, [draft]);
      const writable = snapshot.status === 'ready' && snapshot.writable;
      function edit(text) {
        if (text === draft) return;
        const changed = text !== stored;
        editor.current.dirty = changed;
        if (!changed) editor.current.revision = snapshot.revision;
        setDirty(changed); setDraft(text); setNotice('');
      }
      function switchSession(id) {
        selectedSession.current = id;
        request.current++;
        setSessionId(id); setReport(null); setChoices({}); setBusy(false); setError('');
      }
      async function refreshSessions({ autoScan = false } = {}) {
        const token = ++sessionRequest.current;
        setError('');
        try {
          const value = await jsonRequest('GET');
          if (token !== sessionRequest.current) return;
          const list = value.sessions || [];
          setSessions(list);
          const next = list.some(item => item.id === selectedSession.current) ? selectedSession.current : list[0]?.id || '';
          switchSession(next);
          if (autoScan && next) await discover(next, { verify: true });
        } catch (err) { if (token === sessionRequest.current) setError(err.message); }
      }
      async function discover(target = sessionId, { verify = true } = {}) {
        if (!target) return;
        const token = ++request.current;
        setBusy(true); setError(''); setReport(null); setChoices({});
        if (verify) setVerification({});
        try {
          const value = await jsonRequest('POST', { sessionId: target, refresh: true, verify });
          if (token !== request.current) return;
          setReport(value);
          setVerification(Object.fromEntries((value.verification ?? []).map(item => [item.serverId, item])));
        } catch (err) { if (token === request.current) setError(err.message); }
        finally { if (token === request.current) setBusy(false); }
      }
      async function save() {
        if (!dirty || !writable || parsed.error || busy) return;
        const text = JSON.stringify(parsed.value, null, 2);
        setBusy(true); setError(''); setNotice('');
        try {
          await saveConfig(scope, text, editor.current.revision);
          editor.current = { dirty: false, revision: scope.getSnapshot().revision };
          setDraft(text); setDirty(false); setNotice('配置已保存。');
        } catch (err) { setError(err.message); }
        finally { setBusy(false); }
      }
      function discard() {
        editor.current = { dirty: false, revision: snapshot.revision };
        setDraft(stored); setDirty(false); setNotice(''); setError('');
      }
      const servers = parsed.value?.servers || [];
      const activeCwd = sessions.find(session => session.id === sessionId)?.cwd ?? '';
      const selectedCount = report ? selectedServers(report, choices).length : 0;
      // 最近一次扫描按 id 关联，列表页可直接看到每个服务器的状态。
      const scanned = new Map((report?.servers ?? []).map(entry => [entry.serverId, entry]));
      const sessionCwd = sessions.find(session => session.id === sessionId)?.cwd ?? '';
      const saveReason = busy ? '正在处理，请稍候。' : !writable ? '设置尚未就绪或当前部署不可写。' : parsed.error ? '请先修正高级配置 JSON 中的错误。' : !dirty ? '暂无待保存的修改。' : '可以保存；保存本身不会启动语言服务器。';

      /** 单个服务器的设置详情：默认折叠，展开后查看路径、项目与完整配置。 */
      function serverCard(server, index) {
        const entry = scanned.get(server?.id);
        const item = verification[server?.id];
        // 语言服务器属于项目目录而不是会话：诊断/验证的目标目录由配置决定，没有配置根目录时才回落到会话工作区。
        const target = entry?.target ?? (Array.isArray(server?.roots) && server.roots.length ? server.roots[0] : sessionCwd);
        const statusText = entry ? STATUS_TEXT[entry.status] || entry.status : '未扫描';
        const tone = entry?.status === 'ready' ? 'lsp-success' : entry ? 'lsp-warning' : '';
        return h(DisclosureCard, {
          key: index, id: `lsp-config-${index}`,
          title: typeof server?.id === 'string' ? server.id : `服务器 ${index + 1}`,
          summary: serverLanguages(server).join('、') || '未配置语言',
          badges: [badge(statusText, tone), verifyBadge(item)],
          open: Boolean(openServers[index]),
          onToggle: () => setOpenServers(previous => ({ ...previous, [index]: !previous[index] })),
        },
        h('p', { className: 'lsp-muted lsp-ellipsis', title: target || '' }, `评估目录：${target || '未确定'}${entry?.targetSource === 'config' ? '（来自配置的项目根目录）' : ''}`),
        VerificationDetail({ item }),
        !entry ? h('p', { className: 'lsp-muted' }, '本次扫描没有评估它：可能是没有显式根目录，且当前工作区里也没有对应项目。为它配置 roots 后即可扫描与验证。') : null,
        h('p', { className: 'lsp-muted' }, '程序路径'),
        h('code', { className: 'lsp-code' }, typeof server?.command === 'string' ? server.command : '尚未设置程序路径'),
        h('p', { className: 'lsp-muted' }, `启动参数：${JSON.stringify(server?.args ?? [])}`),
        h('p', { className: 'lsp-muted' }, `语言：${serverLanguages(server).join('、') || '未配置'}`),
        (server?.roots || []).length ? h('p', { className: 'lsp-muted lsp-ellipsis', title: server.roots.join('\n') }, `项目根目录：${server.roots.join('、')}`) : null,
        (server?.workspaceFolders || []).length ? h('p', { className: 'lsp-muted lsp-ellipsis', title: server.workspaceFolders.join('\n') }, `工作区目录：${server.workspaceFolders.join('、')}`) : null,
        server?.initializationOptions ? h('p', { className: 'lsp-muted' }, `初始化选项：${JSON.stringify(server.initializationOptions)}`) : null,
        entry?.dependencies?.length ? h('p', { className: 'lsp-muted' }, `运行组件：${entry.dependencies.map(dependency => `${dependency.satisfied ? '✓' : '✗'} ${dependency.description || dependency.id}`).join('；')}`) : null,
        h('details', null, h('summary', null, '查看完整配置'), h('code', { className: 'lsp-code' }, JSON.stringify(server, null, 2))),
        h('div', { className: 'lsp-actions' }, h('button', { type: 'button', disabled: busy, onClick: () => setView('add') }, '编辑配置 JSON')));
      }

      /** 列表视图：进入设置先只看到所有已配置的服务器。 */
      const listSection = h('section', { className: 'lsp-section' },
        h('div', { className: 'lsp-row' },
          h('div', null,
            h('h3', null, `服务器（${servers.length}）`),
            h('p', { className: 'lsp-muted' }, dirty ? '包含未保存的修改' : busy ? '正在扫描并验证…' : '来自当前配置')),
          h('button', { type: 'button', disabled: busy || !sessionId, onClick: () => { void discover(); } }, '重新扫描并验证')),
        !parsed.error && servers.length
          ? h('div', { className: 'lsp-grid' }, servers.map(serverCard))
          : !parsed.error ? h('p', { className: 'lsp-empty lsp-muted' }, '尚未配置语言服务器。点击右上角「＋ 新增配置」扫描工作区，或直接写入 JSON。') : null,
        servers.length ? h('p', { className: 'lsp-muted' }, '每台服务器的评估目录由它自己的项目根目录决定（没有配置根目录时才用当前会话工作区）；因此验证不依赖某个会话，扫描一次即可覆盖不同项目的服务器。') : null);

      /** 新增/编辑视图：扫描、候选审阅与完整 JSON。 */
      const addSections = [
        h('section', { className: 'lsp-section', key: 'scan' },
          step('1', '工作区扫描', '选择活动会话，查找项目、语言服务器及其运行组件。扫描只读：不启动程序，也不安装软件。'),
          h('div', { className: 'lsp-controls' },
            h('label', { className: 'lsp-field' }, '工作区会话',
              h('select', { 'aria-label': '工作区会话', value: sessionId, disabled: busy, onChange: event => { const next = event.target.value; switchSession(next); void discover(next, { verify: true }); } },
                sessions.length ? sessions.map(session => h('option', { key: session.id, value: session.id, title: `${session.cwd}\n${session.id}` }, sessionLabel(session))) : h('option', { value: '' }, '没有活动会话'))),
            h('button', { type: 'button', disabled: busy, onClick: () => { void refreshSessions(); } }, '刷新会话'),
            h('button', { type: 'button', className: 'lsp-primary', disabled: busy || !sessionId, onClick: () => { void discover(); } }, '扫描当前工作区')),
          h('p', { className: 'lsp-muted' }, sessions.length ? '扫描要求所选会话为 danger-full-access；不会自动提权。扫描目录不决定保存范围，配置由当前 Host 共用。' : '先打开一个工程会话，再刷新列表。也可以直接在下方高级配置 JSON 中手工添加。'),
          activeCwd ? h('p', { className: 'lsp-muted lsp-ellipsis', title: `${activeCwd}\n${sessionId}` }, `当前会话目录：${activeCwd}`) : null),
        h('section', { className: 'lsp-section', key: 'candidates' },
          step('2', '候选审阅', '检查程序路径、运行组件与项目范围。缺组件的服务器可以让智能体自动安装并写回配置。'),
          report ? h('fieldset', { disabled: busy, style: { border: 0, padding: 0, margin: 0, minWidth: 0 } }, h('legend', { className: 'lsp-muted', style: { marginBottom: 12 } }, '语言服务器候选'), h(DiscoveryReport, { report, choices, verification, onChoose: (key, value) => { setChoices(previous => ({ ...previous, [key]: value })); } })) : h('p', { className: 'lsp-empty lsp-muted' }, '尚未扫描。扫描完成后，可用服务器与待选择的程序会显示在这里。'),
          report ? h('div', { className: 'lsp-inset' },
            h('p', { className: 'lsp-muted' }, '按服务器 id 合并：保留其他服务器；同 id 的程序、参数、语言与项目根配置会被建议覆盖，其余字段保留。也可在会话中让智能体调用 lsp_setup 自动完成安装、配置与验证。'),
            h('div', { className: 'lsp-row' }, h('p', { className: 'lsp-muted' }, `${selectedCount} 项建议可加入 · 加入后仍需保存`),
              h('button', { type: 'button', disabled: busy || Boolean(parsed.error) || !selectedCount, onClick: () => { try { edit(suggestedConfig(report, draft, choices)); setError(''); } catch (err) { setError(err.message); } } }, '合并可用建议到草稿')),
            parsed.error ? h('p', { className: 'lsp-muted' }, '草稿 JSON 无效，修正后才能合并建议。') : null) : null),
        h('section', { className: 'lsp-section', key: 'json' },
          step('3', '高级配置 JSON', '在此新增或调整服务器。请勿填写凭据；env 仅支持部署配置。服务器配置最终由 Host 校验。'),
          h('textarea', { 'aria-label': '完整配置 JSON', value: draft, disabled: busy, onChange: event => edit(event.target.value), spellCheck: false, rows: 16 }),
          h('p', { className: 'lsp-muted' }, '与「＋ 新增配置」等价的手工方式：直接加入 servers 条目即可。保存后返回列表可查看每个服务器的设置。')),
      ];

      return h('div', { className: 'lsp-settings', 'aria-busy': busy },
        h('style', null, css),
        h('header', { className: 'lsp-header' },
          h('div', null,
            h('h2', null, view === 'add' ? '新增 LSP 配置' : 'LSP 语言服务'),
            h('p', { className: 'lsp-muted' }, view === 'add'
              ? '扫描工作区、审阅候选并编辑配置 JSON；保存或放弃在页面底部。'
              : `为智能体连接代码语义能力 · 已配置 ${servers.length} 个语言服务器 · 点击卡片查看设置`)),
          h('div', { className: 'lsp-actions' },
            view === 'add'
              ? h('button', { type: 'button', disabled: busy, onClick: () => setView('list') }, '← 返回服务器列表')
              : h('button', { type: 'button', className: 'lsp-primary', disabled: busy, onClick: () => setView('add') }, '＋ 新增配置'),
            badge(dirty ? '有未保存的修改' : snapshot.status === 'ready' ? '配置已同步' : '等待设置就绪', dirty ? 'lsp-warning' : ''))),
        view === 'add' ? addSections : listSection,
        parsed.error ? h('p', { className: 'lsp-alert lsp-error', role: 'alert' }, `JSON 无效：${parsed.error}`) : null,
        h('p', { className: 'lsp-muted' }, '保存后，语言工具调用会执行所配置的程序。语言服务器是未经 OS 沙箱隔离的本地程序，请只配置可信路径与参数。'),
        error ? h('p', { className: 'lsp-alert lsp-error', role: 'alert' }, error) : null,
        notice ? h('p', { className: 'lsp-alert lsp-success', role: 'status' }, notice) : null,
        h('footer', { className: 'lsp-footer' }, h('p', { className: 'lsp-muted', role: 'status' }, saveReason),
          h('div', { className: 'lsp-actions' },
            h('button', { type: 'button', disabled: busy || !dirty, onClick: discard }, '放弃修改'),
            h('button', { type: 'button', className: 'lsp-primary', title: saveReason, disabled: busy || !dirty || !writable || Boolean(parsed.error), onClick: save }, '保存配置'))));
    }

    async function saveConfig(scope, text, revision) {
      await scope.mutate([{ op: 'set', path: ['configJson'], value: text }], revision);
      // mutate 的 Promise 会等待成功镜像或失败后的 describe 恢复；只有服务端值一致才算保存成功。
      const snapshot = scope.getSnapshot();
      if (snapshot.status !== 'ready' || snapshot.value?.configJson !== text) throw new Error('配置未保存：可能发生版本冲突，请保留草稿，检查最新配置后重试。');
    }

    exports.inject = ['slots', 'settingsScope'];
    exports.apply = function apply(ctx) {
      const scope = ctx.settingsScope.bind({ namespace: NS });
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: NS,
        order: 25,
        label: 'LSP',
        inject: () => ({ scope }),
      }, LspSettingsCard));
    };
    exports.testHelpers = { suggestedConfig, selectedServers, DiscoveryReport, ServerCard, DisclosureCard, InstallPlan, sessionLabel, shortPath, saveConfig, jsonRequest };
    return exports;
  },
});
