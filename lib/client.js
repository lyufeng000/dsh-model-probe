window.__ModuleLoader__.load({
  id: 'dsh-model-probe',
  factory: require => {
    const React = require('react');
    const { useState, useEffect, useRef, useMemo } = React;
    const h = React.createElement;
    const styles = `
      .model-probe{color:var(--dsw-alias-label-primary);max-width:1100px;padding:4px 0 24px;font-size:14px}
      .model-probe *{box-sizing:border-box}.model-probe p{line-height:1.6}.model-probe h2{font-size:20px}
      .model-probe .muted{color:var(--dsw-alias-label-secondary)}.model-probe .bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
      .model-probe button{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:inherit;border-radius:7px;padding:7px 12px;cursor:pointer}
      .model-probe button:disabled{opacity:.5;cursor:not-allowed}.model-probe .primary{background:var(--dsw-alias-label-primary,#222);color:var(--dsw-alias-bg-base,#fff)}
      .model-probe .error{color:var(--dsw-alias-state-error-primary);white-space:pre-wrap}.model-probe .table{overflow:auto}
      .model-probe table{border-collapse:collapse;width:100%}.model-probe th,.model-probe td{text-align:left;vertical-align:top;border-bottom:1px solid var(--dsw-alias-border-l1);padding:10px}
      .model-probe input,.model-probe select{background:var(--dsw-alias-bg-base);color:inherit;border:1px solid var(--dsw-alias-border-l2);padding:6px;border-radius:5px}
      .model-probe .badge{display:block;font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:4px}.model-probe code{font-family:monospace;overflow-wrap:anywhere}.model-probe details{margin:12px 0}.model-probe pre{white-space:pre-wrap;overflow-wrap:anywhere}.model-probe .card{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:12px;margin:12px 0}
    `;
    const sourceNames = { vendor: '厂商', catalog: '内置目录', openrouter: 'OpenRouter 估算', manual: '手填' };
    function WritePanel({ row, result, selected, api, revision, onApplied }) {
      const [preview, setPreview] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [status, setStatus] = useState(''), [backups, setBackups] = useState([]);
      const live = useRef(true), generation = useRef(0);
      useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
      useEffect(() => { generation.current++; setPreview(null); }, [revision, result, selected]);
      const prepare = async (action, backupId) => {
        const version = generation.current;
        setBusy(true); setError(''); setPreview(null); setStatus('');
        try { const value = await api('preview', { route: row.route, revision, action, ...(action === 'adopt' ? { models: (result?.models ?? []).filter(model => selected.has(model.id)) } : {}), ...(backupId ? { backupId } : {}) }); if (live.current && version === generation.current) setPreview(value); }
        catch (e) { if (live.current) setError(e.message); }
        finally { if (live.current) setBusy(false); }
      };
      const commit = async () => {
        if (!preview || !window.confirm(`确认${preview.action === 'adopt' ? '用所选模型替换当前列表' : preview.action === 'restore' ? '删除显式列表并恢复内置目录' : '恢复备份中的模型配置'}？\n路由：${row.route}\n新增 ${preview.added.length} 个，移除 ${preview.removed.length} 个。\n其他路由及凭据不会更改。`)) return;
        setBusy(true); setError('');
        try {
          const value = await api(preview.action, { token: preview.token, route: row.route, revision: preview.revision, confirm: true });
          if (live.current) { setPreview(null); setStatus(`配置已保存${value.hotReloaded ? '，模型服务已热更新，无需重启' : ''}。备份：${value.backup.id}${value.warning ? '。' + value.warning : ''}`); setBackups([]); }
          await onApplied();
        } catch (e) { if (live.current) setError(e.message); }
        finally { if (live.current) setBusy(false); }
      };
      const loadBackups = async () => {
        setBusy(true); setError('');
        try { const value = await api('backups', {}); if (live.current) { setBackups(value.filter(item => item.route === row.route)); setStatus(value.some(item => item.route === row.route) ? '' : '此路由暂无可用备份。'); } }
        catch (e) { if (live.current) setError(e.message); }
        finally { if (live.current) setBusy(false); }
      };
      return h('div', { className: 'write-panel' },
        h('p', { className: 'muted' }, '写入官方「模型」页管理的同一处配置；确认后立即应用。所选列表会替换当前列表，而不是追加。写前保存目标路由模型配置备份（全局保留最近 5 份），不复制凭据或整份 YAML。'),
        h('div', { className: 'bar' }, h('button', { type: 'button', className: 'primary', disabled: busy || !selected.size || !result || result.revision !== revision, onClick: () => prepare('adopt') }, `预览写入（${selected.size}）`),
          h('button', { type: 'button', disabled: busy, onClick: () => prepare('restore') }, '恢复内置目录…'),
          h('button', { type: 'button', disabled: busy, onClick: loadBackups }, '查看模型备份')),
        backups.length > 0 && h('ul', null, ...backups.map(backup => h('li', { key: backup.id }, h('code', null, backup.createdAt), ' ', h('button', { type: 'button', disabled: busy, onClick: () => prepare('rollback', backup.id) }, '预览恢复此备份')))),
        error && h('p', { className: 'error', role: 'alert' }, error), status && h('p', { role: 'status' }, status),
        preview && h('section', { className: 'card', 'aria-label': row.route + ' 写入差异预览' }, h('h4', null, '差异预览（5 分钟内有效）'),
          h('p', null, `新增：${preview.added.join('、') || '无'}`), h('p', null, `移除：${preview.removed.join('、') || '无'}`),
          !preview.changed && h('p', null, '模型配置与当前相同。'),
          preview.unresolved?.length > 0 && h('p', { className: 'muted' }, '新模型尚不能从当前服务列表解析：' + preview.unresolved.join('、') + '。写入时仍须通过官方配置校验；未验证推理权限。'),
          preview.clearsOverrides && h('p', { role: 'alert' }, '显式 models 不能与 modelOverrides 并存：本次会清除旧参数覆盖，并将其纳入可恢复备份。'),
          preview.action === 'restore' && h('p', { role: 'alert' }, '恢复内置目录会移除手工声明的目录外模型。此操作删除 models 键，不写入空列表。'),
          h('details', { open: true }, h('summary', null, '目标路由模型配置：之前 → 之后'), h('pre', null, JSON.stringify({ before: preview.before, after: preview.after }, null, 2))),
          preview.sources.length > 0 && h('details', null, h('summary', null, '采用参数的来源'), h('ul', null, ...preview.sources.map(item => h('li', { key: item.id }, item.id + '：' + Object.entries(item.fields).map(([key, source]) => key + '=' + (sourceNames[source] ?? source)).join('，'))))),
          h('div', { className: 'bar' }, h('button', { type: 'button', className: 'primary', disabled: busy || preview.revision !== revision, onClick: commit }, busy ? '正在处理…' : '确认写入 profile'), h('button', { type: 'button', disabled: busy, onClick: () => setPreview(null) }, '取消写入'))));
    }
    function ManualEditor({ row, api, revision, onApplied, result, selected }) {
      const convert = models => models.map(model => ({ id: model.id ?? '', name: model.name ?? '', contextWindow: String(model.contextWindow ?? ''), maxTokens: String(model.maxTokens ?? ''), input: (model.input ?? []).join(',') }));
      const [entries, setEntries] = useState(() => convert(row.declared ?? row.served));
      useEffect(() => { setEntries(convert(row.declared ?? row.served)); }, [revision]);
      const draft = useMemo(() => ({ revision, models: entries.map(entry => ({ id: entry.id, ...(entry.name ? { name: entry.name } : {}), ...(entry.contextWindow !== '' ? { contextWindow: Number(entry.contextWindow) } : {}), ...(entry.maxTokens !== '' ? { maxTokens: Number(entry.maxTokens) } : {}), ...(entry.input ? { input: entry.input.split(',') } : {}) })) }), [entries, revision]);
      const all = useMemo(() => new Set(draft.models.map(model => model.id)), [draft]);
      const change = (index, key, value) => setEntries(previous => previous.map((entry, i) => i === index ? { ...entry, [key]: value } : entry));
      const empty = { id: '', name: '', contextWindow: '', maxTokens: '', input: '' };
      return h('details', { className: 'manual-editor', open: row.manualOnly || undefined }, h('summary', null, '手填 / 修订模型参数'),
        h('p', { className: 'muted' }, '默认载入当前声明。此表会整体替换列表；新增模型请保留原有行。数值须为正整数；留空表示省略，不猜测容量或图片能力。目录外模型通常需要填写上下文和输出上限。这里不验证推理权限，也不接收凭据。'),
        h('div', { className: 'table' }, h('table', null,
          h('thead', null, h('tr', null, ...['模型 ID', '名称（可选）', '上下文（可选）', '输出上限（可选）', '输入模态（可选）', '操作'].map(text => h('th', { key: text }, text)))),
          h('tbody', null, ...entries.map((entry, index) => h('tr', { key: index },
            ...['id', 'name', 'contextWindow', 'maxTokens'].map(key => h('td', { key }, h('input', { type: ['contextWindow', 'maxTokens'].includes(key) ? 'number' : 'text', min: 1, step: 1, value: entry[key], style: { width: key === 'id' ? 180 : 130 }, 'aria-label': `${row.route} 模型 ${index + 1} ${key}`, onChange: event => change(index, key, event.target.value) }))),
            h('td', null, h('select', { value: entry.input, 'aria-label': `${row.route} 模型 ${index + 1} input`, onChange: event => change(index, 'input', event.target.value) }, h('option', { value: '' }, '省略'), h('option', { value: 'text' }, 'text'), h('option', { value: 'image' }, 'image'), h('option', { value: 'text,image' }, 'text + image'), entry.input === 'image,text' && h('option', { value: 'image,text' }, 'image + text（原顺序）'))),
            h('td', null, h('button', { type: 'button', onClick: () => setEntries(previous => previous.filter((_, i) => i !== index)) }, '移除此行'))))))),
        h('div', { className: 'bar' }, h('button', { type: 'button', onClick: () => setEntries(previous => [...previous, { ...empty }]) }, '添加手填模型'),
          h('button', { type: 'button', onClick: () => setEntries(convert(row.declared ?? row.served)) }, '重置为当前模型'),
          result && h('button', { type: 'button', disabled: !selected.size || result.revision !== revision, onClick: () => setEntries(convert(result.models.filter(model => selected.has(model.id)))) }, '载入勾选结果并修订')),
        h(WritePanel, { row, result: draft, selected: all, api, revision, onApplied }));
    }
    function RouteCard({ row, api, revision, onApplied }) {
      const [result, setResult] = useState(row.probe?.result ?? null), [running, setRunning] = useState(row.probe?.status === 'probing');
      const [error, setError] = useState(''), [enrich, setEnrich] = useState(false), [protocol, setProtocol] = useState(''), [base, setBase] = useState(''), [search, setSearch] = useState('');
      const [selected, setSelected] = useState(new Set());
      const live = useRef(true), pending = useRef(false);
      useEffect(() => { setSelected(new Set()); }, [result]);
      useEffect(() => { live.current = true; return () => { live.current = false; if (pending.current) api('cancel', { route: row.route }).catch(() => {}); }; }, []);
      useEffect(() => { if (!pending.current) { setResult(row.probe?.result ?? null); setRunning(row.probe?.status === 'probing'); } }, [row.probe]);
      const run = async () => {
        const confirmEndpoint = base.trim() ? window.confirm('将向你手动指定的地址发送此路由的已有凭据：\n' + base.trim() + '\n请确认这是你信任的模型服务地址。') : false;
        if (base.trim() && !confirmEndpoint) return;
        pending.current = true; setRunning(true); setError(''); setResult(null);
        try { const value = await api('probe', { route: row.route, useOpenRouterEnrich: enrich, ...(protocol ? { api: protocol } : {}), ...(base.trim() ? { baseURL: base.trim(), confirmEndpoint } : {}) }); if (live.current) setResult(value); }
        catch (e) { if (live.current) setError(e.message); }
        finally { pending.current = false; if (live.current) setRunning(false); }
      };
      const cancel = async () => { try { await api('cancel', { route: row.route }); if (!pending.current && live.current) setRunning(false); } catch (e) { if (live.current) setError(e.message); } };
      const field = (model, key) => h('td', null, model[key] === undefined ? '—' : Array.isArray(model[key]) ? model[key].join(' / ') : String(model[key]), model.sources?.[key] && h('small', { className: 'badge' }, sourceNames[model.sources[key]]));
      const models = result?.models.filter(model => model.id.toLowerCase().includes(search.toLowerCase())) ?? [];
      return h('article', { className: 'card' }, h('h3', null, row.route),
        row.codex && !row.manualOnly && h('p', { className: 'muted', role: 'status' }, row.codex.code + '：' + row.codex.message),
        row.manualOnly ? h('p', { className: 'muted', role: 'status' }, '仅支持手填参数 · ' + (row.codex?.code ?? 'CODEX_MANUAL_ONLY') + '：' + (row.codex?.message ?? '请到官方「模型」页检查登录状态。')) : h(React.Fragment, null,
          h('div', { className: 'bar' }, h('button', { type: 'button', className: 'primary', disabled: running, onClick: run }, running ? '正在询问厂商…' : '询问厂商'), running && h('button', { type: 'button', onClick: cancel }, '取消探测'),
            h('label', null, h('input', { type: 'checkbox', checked: enrich, disabled: running, onChange: e => setEnrich(e.target.checked) }), ' 使用 OpenRouter 公共目录补全（估算，默认关闭）')),
          h('details', null, h('summary', null, '临时协议 / 地址覆盖（不会保存）'), h('p', { className: 'muted' }, '只发送模型列表请求。新地址需确认，密钥仍仅在 Host 内使用。'),
            h('label', null, '协议 ', h('select', { value: protocol, disabled: running, onChange: e => setProtocol(e.target.value) }, h('option', { value: '' }, row.api ?? '自动（未知时需手选）'), ...['google-generative-ai', 'openai-completions', 'openai-responses', 'openai-codex-responses', 'anthropic-messages', 'openrouter'].map(value => h('option', { key: value, value }, value)))),
            h('label', null, ' 服务地址 ', h('input', { value: base, disabled: running, placeholder: '留空使用路由配置 / 官方默认地址', onChange: e => setBase(e.target.value), 'aria-label': row.route + ' 临时服务地址' })))),
        error && h('p', { className: 'error', role: 'alert' }, error),
        result && h(React.Fragment, null, h('p', { className: 'muted' }, `共 ${result.models.length} 个；获取时间：${result.fetchedAt}。目录外表示不在当前服务列表，不代表内置目录未知。`),
          result.revision !== revision && h('p', { role: 'alert' }, '配置已变化，当前结果基于旧版本；请重新探测再写入。'),
          result.incomplete && h('p', { role: 'alert' }, '厂商还有后续分页，本次结果不完整；“缺失”不代表模型不可用。'), result.warning && h('p', { role: 'alert' }, result.warning),
          h('div', { className: 'bar' }, h('label', null, '筛选 ID ', h('input', { value: search, onChange: e => setSearch(e.target.value) })),
            h('button', { type: 'button', onClick: () => setSelected(new Set(models.map(model => model.id))) }, `选择全部匹配（${models.length}）`),
            h('button', { type: 'button', onClick: () => setSelected(new Set()) }, '取消全选')),
          h('div', { className: 'table' }, h('table', null, h('thead', null, h('tr', null, ...['ID / 对比', '名称 / 来源', '上下文 / 来源', '输出上限 / 来源', '模态 / 来源'].map(text => h('th', { key: text }, text)))),
            h('tbody', null, ...models.slice(0,200).map(model => h('tr', { key: model.id }, h('td', null, h('input', { type: 'checkbox', checked: selected.has(model.id), 'aria-label': '选择模型 ' + model.id, onChange: e => setSelected(previous => { const next = new Set(previous); if (e.target.checked) next.add(model.id); else next.delete(model.id); return next; }) }), ' ', h('code', null, model.id), h('small', { className: 'badge' }, result.diff.declared.includes(model.id) ? '已声明' : '目录外'), h('small', { className: 'muted' }, model.inCatalog ? '内置已收录' : '内置未收录')), field(model, 'name'), field(model, 'contextWindow'), field(model, 'maxTokens'), field(model, 'input')))))),
          models.length > 200 && h('p', null, `匹配 ${models.length} 个，展示前 200 个；请筛选 ID。`),
          h('p', null, `当前列表中缺失：${result.diff.missing.length ? result.diff.missing.join('、') : '无'}。仅描述列表差异，不代表账户推理权限。`)),
        !row.manualOnly && h(WritePanel, { row, result, selected, api, revision, onApplied }),
        h(ManualEditor, { row, result, selected, api, revision, onApplied }));
    }
    function Section({ api }) {
      const [state, setState] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
      const mounted = useRef(false), serial = useRef(0);
      const refresh = async () => {
        const id = ++serial.current;
        setBusy(true); setError('');
        try { const next = await api('state', {}); if (mounted.current && serial.current === id) setState(next); }
        catch (e) { if (mounted.current && serial.current === id) setError(e.message); }
        finally { if (mounted.current && serial.current === id) setBusy(false); }
      };
      useEffect(() => { mounted.current = true; refresh(); return () => { mounted.current = false; serial.current++; }; }, []);
      return h('section', { className: 'model-probe' }, h('style', null, styles),
        h('h2', null, '模型探测'), h('p', { className: 'muted' }, '按需向厂商询问模型列表，与当前服务列表对比。探测不会发起推理或修改配置；写入须预览并确认，始终不修改凭据。返回列表不保证账户有调用权限。'),
        h('button', { type: 'button', className: 'primary', onClick: refresh, disabled: busy }, busy ? '正在读取…' : '刷新'),
        error && h('p', { className: 'error', role: 'alert' }, error),
        state && h('div', { className: 'table' }, h('table', null,
          h('thead', null, h('tr', null, ...['路由', '凭据引用', '凭据状态', '当前模型'].map(x => h('th', { key: x }, x)))),
          h('tbody', null, ...state.routes.map(row => h('tr', { key: row.route },
            h('td', null, row.route), h('td', null, row.credentialKind === 'record' ? '官方登录记录' : row.credentialRef ?? '未指定'),
            h('td', null, row.credential.configured ? `已配置 · ${row.credential.source ?? '受保护存储'}` : row.credentialKind === 'unknown' ? '未识别默认认证方式' : '未配置'),
            h('td', null, row.available ? `${row.served.length} 个：${row.served.map(x => x.id).join('、')}` : '路由不可用'))))),
          state.routes.length === 0 && h('p', null, '尚未声明 llm-pi-ai provider 路由。')),
        state && state.routes.map(row => h(RouteCard, { key: row.route, row, api, revision: state.revision, onApplied: refresh })));
    }
    return { inject: ['slots', 'connection'], apply(ctx) {
      const api = async (endpoint, payload) => {
        let result;
        try { result = await ctx.connection.rpc.call('/api', `model-probe/${endpoint}`, payload); }
        catch (error) {
          if (/HTTP (404|405)\b/i.test(error.message ?? '')) throw new Error('模型探测 Host 接口未加载。请完全退出并重新打开 DSH（仅刷新页面无效）；若仍失败，请检查插件激活状态。');
          throw new Error('无法读取模型探测服务，请检查连接后重试。');
        }
        if (!result.ok) throw new Error(result.error?.message ?? '模型探测操作失败。');
        if (endpoint === 'state' && result.value?.version !== 1) throw new Error('模型探测 Client/Host 版本不一致，请完全退出并重新打开 DSH。');
        return result.value;
      };
      const face = { api };
      ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'model-probe', order: 18, label: '模型探测', inject: () => face }, Section));
    } };
  }
});
