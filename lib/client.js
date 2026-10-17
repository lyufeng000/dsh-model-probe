window.__ModuleLoader__.load({
  id: 'dsh-live-model-probe',
  factory: () => {
    // Native operations read this getter synchronously from onClick. Never turn
    // normal discovery (including mount effects) into vendor network requests.
    function hookRefresh(remote, connection) {
      const service = remote?.llm;
      const previous = service && Object.getOwnPropertyDescriptor(service, 'discoverModels');
      let depth = 0, active = true, result;
      const controller = new AbortController();
      if (!previous?.configurable || !connection?.rpc?.call) return { run: source => source.click(), dispose() {} };
      const getter = function () {
        // Keep Cordis' caller-context getter intact; do not cache its function.
        const original = previous.get ? previous.get.call(this) : previous.value;
        return (...args) => {
          if (!active || depth === 0 || args[0] !== 'llm-pi-ai') return original(...args);
          return result = (async () => {
            try { return await connection.rpc.call('/api', 'model-probe/refreshDiscovery', args[1] ?? {}, controller.signal); }
            catch { return { ok: false, error: { code: 'gateway/internal', message: '刷新失败，请检查连接后重试。' } }; }
          })();
        };
      };
      Object.defineProperty(service, 'discoverModels', { configurable: true, enumerable: previous.enumerable, get: getter });
      return {
        run(source) { result = undefined; depth++; try { source.click(); return result; } finally { depth--; } },
        dispose() {
          active = false; controller.abort();
          if (Object.getOwnPropertyDescriptor(service, 'discoverModels')?.get === getter) Object.defineProperty(service, 'discoverModels', previous);
        }
      };
    }
    function mountPickerRefresh(doc, runRefresh = source => source.click(), previousOwner = null) {
      const win = doc.defaultView, marker = 'data-model-probe-picker-refresh';
      const entries = new Map();
      let owner = previousOwner, disposed = false, queued = false;
      const text = element => element?.textContent?.trim() ?? '';
      const isSource = button => /^(获取可用模型|Fetch available models)$/.test(text(button));
      const rows = dialog => [...(dialog?.querySelectorAll('li label') ?? [])].map(label => ({
        id: text(label.querySelector('span')), checkbox: label.querySelector('input[type="checkbox"]')
      })).filter(row => row.id && row.checkbox);
      const snapshot = entry => { for (const row of rows(entry.dialog)) entry.selections.set(row.id, row.checkbox.checked); };
      const schedule = () => {
        if (queued || disposed) return;
        queued = true; win.queueMicrotask(() => { queued = false; if (!disposed) scan(); });
      };
      const entryFor = event => {
        const dialog = event.target?.closest?.('[role="dialog"]');
        return [...entries.values()].find(entry => dialog && entry.dialog === dialog);
      };
      const remember = event => {
        const button = event.target?.closest?.('button');
        if (button && isSource(button)) owner = button;
        const entry = entryFor(event);
        if (entry && !entry.restoring && /^(取消全选|Deselect all)$/.test(text(button))) {
          // Native deselect-all clears its entire Set, including filtered rows.
          for (const id of entry.selections.keys()) entry.selections.set(id, false);
        } else if (entry && !entry.restoring && /^(全选|Select all)$/.test(text(button))) {
          for (const row of rows(entry.dialog)) entry.selections.set(row.id, true);
        }
      };
      const rememberChoice = event => {
        const entry = entryFor(event);
        if (!entry || entry.restoring || event.target?.type !== 'checkbox') return;
        const id = text(event.target.closest('label')?.querySelector('span'));
        if (id) entry.selections.set(id, event.target.checked);
      };
      const rememberQuery = event => {
        const entry = entryFor(event);
        if (entry && !entry.restoring && event.target?.type === 'search') entry.query = event.target.value;
      };
      function create(source) {
        const button = doc.createElement('button');
        button.type = 'button'; button.setAttribute(marker, '');
        button.textContent = '刷新 / 重试'; button.setAttribute('aria-label', '刷新 / 重试模型列表');
        button.className = source.className; button.style.whiteSpace = 'nowrap';
        const entry = { button, owner: source, dialog: null, pending: false, restoring: false, selections: new Map(), query: '', timer: null };
        entries.set(source, entry);
        button.addEventListener('click', () => {
          if (entry.pending || !source.isConnected || source.disabled) return;
          snapshot(entry); entry.query = entry.dialog?.querySelector('input[type="search"]')?.value ?? '';
          entry.pending = true; entry.sawBusy = false; owner = source;
          button.disabled = true; button.textContent = '刷新中…'; button.title = '正在重新获取厂商模型列表';
          const finish = () => {
            if (disposed || !entries.has(source)) return;
            // Let native await/React commit finish before restoring controlled inputs.
            win.clearTimeout(entry.timer);
            entry.timer = win.setTimeout(() => { entry.settled = true; schedule(); }, 0);
          };
          const request = runRefresh(source);
          if (request?.then) request.then(finish, finish);
          schedule();
        });
        return entry;
      }
      function scan() {
        for (const [source, entry] of entries) if (!source.isConnected) {
          win.clearTimeout(entry.timer); entry.button.remove(); entries.delete(source);
        }
        for (const source of doc.querySelectorAll('button')) if (isSource(source) && !entries.has(source)) create(source);
        const dialog = [...doc.querySelectorAll('[role="dialog"]')].find(item => /^(选择要添加的模型|Choose models to add)$/.test(text(item.querySelector('h1,h2,h3,[data-dialog-title]'))));
        for (const entry of entries.values()) {
          const nextDialog = entry.owner === owner ? dialog ?? null : null;
          if (entry.dialog !== nextDialog) {
            if (!entry.pending) { entry.selections.clear(); entry.query = ''; }
            entry.dialog = nextDialog;
          }
          const search = entry.dialog?.querySelector('input[type="search"]');
          const target = search?.parentElement ?? entry.owner.parentElement;
          if (target && entry.button.parentElement !== target) target.append(entry.button);
          if (entry.pending) {
            entry.sawBusy ||= Boolean(entry.owner.disabled);
            if (!entry.owner.disabled && (entry.settled || entry.sawBusy)) {
              entry.pending = false; entry.settled = false; entry.restoring = true;
              win.clearTimeout(entry.timer);
              // Success resets the native filter to empty, so hidden old choices
              // are restored too. Failures leave the old list and query untouched.
              for (const row of rows(entry.dialog)) if (entry.selections.has(row.id) && row.checkbox.checked !== entry.selections.get(row.id)) row.checkbox.click();
              if (search && search.value !== entry.query) {
                Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value').set.call(search, entry.query);
                search.dispatchEvent(new win.Event('input', { bubbles: true }));
              }
              const failure = entry.owner.closest('section')?.querySelector('p[class*="error"]');
              entry.button.title = text(failure) || '已重新获取；原有勾选已保留，未添加或保存模型。';
              entry.timer = win.setTimeout(() => { entry.restoring = false; schedule(); }, 0);
            }
          } else if (!entry.restoring) snapshot(entry);
          const disabled = entry.pending || Boolean(entry.owner.disabled);
          if (entry.button.disabled !== disabled) entry.button.disabled = disabled;
          const label = entry.pending ? '刷新中…' : '刷新 / 重试';
          if (entry.button.textContent !== label) entry.button.textContent = label;
        }
      }
      doc.addEventListener('click', remember, true); doc.addEventListener('change', rememberChoice, true); doc.addEventListener('input', rememberQuery, true);
      const observer = new win.MutationObserver(schedule);
      observer.observe(doc.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['disabled'] });
      scan();
      return () => {
        disposed = true; observer.disconnect();
        doc.removeEventListener('click', remember, true); doc.removeEventListener('change', rememberChoice, true); doc.removeEventListener('input', rememberQuery, true);
        for (const entry of entries.values()) { win.clearTimeout(entry.timer); entry.button.remove(); }
        entries.clear();
        return owner;
      };
    }
    return {
      inject: ['remote', 'remote.llm', 'connection'],
      mountPickerRefresh, hookRefresh,
      apply(ctx) {
        ctx.effect(() => {
          const previousOwner = window.__modelProbePickerDispose?.();
          const refresh = hookRefresh(ctx.remote, ctx.get?.('connection'));
          const unmount = mountPickerRefresh(document, refresh.run, previousOwner);
          const dispose = () => { const source = unmount(); refresh.dispose(); return source; };
          window.__modelProbePickerDispose = dispose;
          return () => { dispose(); if (window.__modelProbePickerDispose === dispose) delete window.__modelProbePickerDispose; };
        });
      }
    };
  }
});
