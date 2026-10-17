import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
export const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
export function loadModule(extra = {}) {
  let module;
  const window = { __ModuleLoader__: { load(entry) { assert.equal(entry.id, 'dsh-live-model-probe'); module = entry.factory(); } } };
  vm.runInNewContext(source, { window, AbortController, ...extra });
  return { module, window };
}
export function fixture({ open = false, unrelated = false } = {}) {
  let changed, observerOff = false, added = 0, calls = 0, failure = '', labels = [];
  const listeners = new Map(), buttons = [];
  class Input { constructor(value = '') { this._value = value; this.type = 'search'; } get value() { return this._value; } set value(value) { this._value = value; } }
  class MutationObserver { constructor(fn) { changed = fn; } observe() {} disconnect() { observerOff = true; } }
  const win = { MutationObserver, queueMicrotask, setTimeout, clearTimeout, HTMLInputElement: Input, Event: class { constructor(type) { this.type = type; } } };
  const parent = () => ({ append(button) { button.isConnected = true; button.parentElement = this; } });
  const head = parent(), toolbar = parent();
  const owner = { textContent: '获取可用模型', className: 'native-button', parentElement: head, isConnected: true, disabled: false,
    closest: () => ({ querySelector: () => failure ? { textContent: failure } : null }),
    click() { calls++; this.disabled = true; changed(); } };
  const search = new Input(); search.parentElement = toolbar; search.closest = () => dialog;
  search.dispatchEvent = event => listeners.get(event.type)?.({ target: search });
  const dialog = { isConnected: open,
    querySelector(selector) { return selector.includes('h1') ? { textContent: unrelated ? '其他弹窗' : '选择要添加的模型' } : search; },
    querySelectorAll: () => labels };
  const doc = { defaultView: win, body: {},
    addEventListener(type, fn) { listeners.set(type, fn); }, removeEventListener(type) { listeners.delete(type); },
    querySelectorAll: selector => selector === 'button' ? [owner, ...buttons] : dialog.isConnected ? [dialog] : [],
    createElement(tag) { assert.equal(tag, 'button', 'only one button, never a page/card/status panel'); added++;
      const events = new Map(), button = { isConnected: false, textContent: '', style: {}, disabled: false,
        setAttribute() {}, addEventListener(type, fn) { events.set(type, fn); },
        click() { if (!this.disabled) events.get('click')?.(); }, remove() { this.isConnected = false; this.parentElement = null; } };
      buttons.push(button); return button;
    } };
  const { module, window } = loadModule({ document: doc });
  const dispose = module.mountPickerRefresh(doc);
  function setRows(models) { labels = models.map(({ id, checked = true }) => {
    const span = { textContent: id }, label = { querySelector: selector => selector === 'span' ? span : checkbox };
    const checkbox = { type: 'checkbox', checked, closest: selector => selector === 'label' ? label : dialog,
      click() { this.checked = !this.checked; listeners.get('change')?.({ target: this }); } };
    return label;
  }); }
  const flush = async () => { changed?.(); await new Promise(resolve => setTimeout(resolve, 5)); };
  return { module, window, doc, owner, dialog, search, head, toolbar, buttons, setRows, flush, dispose,
    get added() { return added; }, get calls() { return calls; }, get observerOff() { return observerOff; }, get listenerCount() { return listeners.size; },
    row(id) { return labels.find(label => label.querySelector('span').textContent === id)?.querySelector('input'); },
    query(value) { search.value = value; search.dispatchEvent({ type: 'input' }); },
    async open(models) { listeners.get('click')({ target: { closest: selector => selector === 'button' ? owner : null } }); dialog.isConnected = true; setRows(models); await flush(); },
    async close() { dialog.isConnected = false; await flush(); },
    async finish(models, error = '') { failure = error; setRows(models); if (!error) search.value = ''; owner.disabled = false; await flush(); }
  };
}
