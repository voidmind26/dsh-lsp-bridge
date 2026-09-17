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
    const button = { border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, padding: '6px 12px', font: 'inherit', cursor: 'pointer', background: 'var(--dsw-alias-bg-layer-3)', color: 'var(--dsw-alias-label-primary)' };

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

    const planKey = plan => `${plan.language}:${plan.serverId}`;
    function selectedServers(report, choices = {}) {
      return report.plans.flatMap(plan => {
        const command = plan.status === 'ready' ? plan.command : plan.status === 'needs-choice' && (plan.candidates || []).includes(choices[planKey(plan)]) ? choices[planKey(plan)] : null;
        return command ? [{ id: plan.serverId, command, args: plan.args, languages: plan.languages, rootMarkers: plan.rootMarkers, roots: plan.roots }] : [];
      });
    }

    function suggestedConfig(report, currentText, choices = {}) {
      // JSON 无效时停止合并，绝不以空配置替换用户原有数据。
      const current = parseConfig(currentText);
      const servers = [...(current.servers || [])];
      for (const server of selectedServers(report, choices)) {
        const index = servers.findIndex(existing => existing.id === server.id);
        if (index < 0) servers.push(server);
        else servers[index] = { ...servers[index], ...server };
      }
      return JSON.stringify({ ...current, servers }, null, 2);
    }

    function DiscoveryReport({ report, choices, onChoose }) {
      return h('div', null,
        h('p', null, `发现 ${report.projects.length} 个项目，${report.executables.length} 个可用服务器候选${report.complete ? '' : '（扫描已截断）'}`),
        h('ul', null, report.projects.map(project => h('li', { key: `${project.language}:${project.root}` }, `${project.language} · ${project.root} · ${project.markers.join(', ')}`))),
        h('ul', null, report.plans.map(plan => h('li', { key: planKey(plan) },
          `${plan.language} / ${plan.serverId}：${({ ready: '可用', 'needs-choice': '请选择程序', missing: '未安装' })[plan.status] || plan.status}`,
          plan.status === 'ready' ? h('code', null, ` ${plan.command}`) : null,
          plan.status === 'needs-choice' ? h('select', { 'aria-label': `${plan.serverId} 程序候选`, value: choices[planKey(plan)] || '', onChange: event => onChoose(planKey(plan), event.target.value) },
            h('option', { value: '' }, '请选择可信程序（不自动选择）'),
            plan.candidates.map(candidate => h('option', { key: candidate, value: candidate }, candidate))) : null,
          plan.status === 'missing' ? h('p', null, `安装建议（仅供参考，不会执行）：${plan.installAdvice}`) : null))));
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
      const [trusted, setTrusted] = useState(false);
      const [error, setError] = useState('');
      const [busy, setBusy] = useState(false);
      const [notice, setNotice] = useState('');
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
      useEffect(() => { void refreshSessions(); return () => { request.current++; sessionRequest.current++; }; }, []);
      const parsed = useMemo(() => { try { return { value: parseConfig(draft) }; } catch (err) { return { error: err.message }; } }, [draft]);
      const writable = snapshot.status === 'ready' && snapshot.writable;
      function edit(text) {
        editor.current.dirty = true;
        setDirty(true); setDraft(text); setNotice(''); setTrusted(false);
      }
      function switchSession(id) {
        selectedSession.current = id;
        request.current++;
        setSessionId(id); setReport(null); setChoices({}); setTrusted(false); setBusy(false); setError('');
      }
      async function refreshSessions() {
        const token = ++sessionRequest.current;
        setError('');
        try {
          const value = await jsonRequest('GET');
          if (token !== sessionRequest.current) return;
          const list = value.sessions || [];
          setSessions(list);
          switchSession(list.some(item => item.id === selectedSession.current) ? selectedSession.current : list[0]?.id || '');
        } catch (err) { if (token === sessionRequest.current) setError(err.message); }
      }
      async function discover() {
        if (!sessionId) return;
        const token = ++request.current;
        setBusy(true); setError(''); setReport(null); setChoices({}); setTrusted(false);
        try {
          const value = await jsonRequest('POST', { sessionId, refresh: true });
          if (token === request.current) setReport(value);
        } catch (err) { if (token === request.current) setError(err.message); }
        finally { if (token === request.current) setBusy(false); }
      }
      function updateServer(index, field, value) {
        try {
          const config = parseConfig(draft);
          const next = field === 'args' ? JSON.parse(value) : value;
          if (field === 'args' && (!Array.isArray(next) || next.some(arg => typeof arg !== 'string'))) throw new Error('args 必须是字符串数组');
          config.servers[index] = { ...config.servers[index], [field]: next };
          edit(JSON.stringify(config, null, 2)); setError('');
        } catch (err) { setError(err.message); }
      }
      async function save() {
        if (!writable || parsed.error || !trusted || busy) return;
        const text = JSON.stringify(parsed.value, null, 2);
        setBusy(true); setError(''); setNotice('');
        try {
          await saveConfig(scope, text, editor.current.revision);
          editor.current = { dirty: false, revision: scope.getSnapshot().revision };
          setDraft(text); setDirty(false); setTrusted(false); setNotice('配置已保存。');
        } catch (err) { setError(err.message); }
        finally { setBusy(false); }
      }
      function discard() {
        editor.current = { dirty: false, revision: snapshot.revision };
        setDraft(stored); setDirty(false); setTrusted(false); setNotice(''); setError('');
      }
      return h('li', { style: { border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 12, padding: 16, display: 'flex', flexDirection: 'column', gap: 12 } },
        h('strong', null, 'dsh-lsp-bridge'),
        h('p', null, '发现项目与语言服务器，只生成建议；不会自动安装或启动程序。保存后，语言工具调用可能执行所配置的程序，请确认其可信。'),
        h('div', null,
          h('select', { 'aria-label': '工作区会话', value: sessionId, disabled: busy, onChange: event => switchSession(event.target.value), style: button },
            sessions.length ? sessions.map(session => h('option', { key: session.id, value: session.id }, `${session.cwd} · ${session.id}`)) : h('option', { value: '' }, '没有活动会话')),
          h('button', { type: 'button', style: button, disabled: busy, onClick: refreshSessions }, '刷新会话列表'),
          h('button', { type: 'button', style: button, disabled: busy || !sessionId, onClick: discover }, '扫描当前工作区')),
        report ? h(DiscoveryReport, { report, choices, onChoose: (key, value) => { setChoices(previous => ({ ...previous, [key]: value })); setTrusted(false); } }) : null,
        report ? h('div', null,
          h('p', null, '按服务器 id 合并：保留其他服务器；同 id 的程序、参数、语言与项目根配置将被建议覆盖，其余字段保留。'),
          h('button', { type: 'button', style: button, disabled: busy || Boolean(parsed.error) || !selectedServers(report, choices).length, onClick: () => { try { edit(suggestedConfig(report, draft, choices)); } catch (err) { setError(err.message); } } }, '合并可用建议到草稿（尚未保存）')) : null,
        !parsed.error ? h('fieldset', { disabled: busy }, h('legend', null, '服务器表单'),
          (parsed.value.servers || []).map((server, index) => h('div', { key: index },
            ['id', 'command', 'args'].map(field => h('label', { key: field, style: { display: 'block' } }, `${index + 1}. ${field} `,
              h('input', { 'aria-label': `服务器 ${index + 1} ${field}`, key: `${field}:${JSON.stringify(server[field])}`, defaultValue: field === 'args' ? JSON.stringify(server.args || []) : server[field] || '', onBlur: event => updateServer(index, field, event.target.value), style: { ...button, width: '75%' } })))))) : null,
        h('label', null, '完整配置 JSON（可编辑所有配置项）', h('textarea', { value: draft, disabled: busy, onChange: event => edit(event.target.value), spellCheck: false, rows: 16, style: { ...button, width: '100%', boxSizing: 'border-box', fontFamily: 'monospace' } })),
        parsed.error ? h('p', { role: 'alert' }, `JSON 无效：${parsed.error}`) : null,
        h('label', null, h('input', { type: 'checkbox', checked: trusted, disabled: busy, onChange: event => setTrusted(event.target.checked) }), '我已核对程序路径与参数，信任这些程序，并允许后续语言工具调用执行它们。'),
        !writable ? h('p', null, '当前部署的设置不可写或尚未加载。') : null,
        error ? h('p', { role: 'alert' }, error) : null,
        notice ? h('p', { role: 'status' }, notice) : null,
        h('div', null,
          h('button', { type: 'button', style: button, disabled: busy || !dirty, onClick: discard }, '放弃修改'),
          h('button', { type: 'button', style: button, disabled: busy || !dirty || !writable || !trusted || Boolean(parsed.error), onClick: save }, busy ? '处理中…' : '保存配置')));
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
      ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({ name: 'settings.plugin.item', key: NS, inject: () => ({ scope }) }, LspSettingsCard));
    };
    exports.testHelpers = { suggestedConfig, selectedServers, DiscoveryReport, saveConfig, jsonRequest };
    return exports;
  },
});
