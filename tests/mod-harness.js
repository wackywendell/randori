import { readFileSync } from 'node:fs';
import vm from 'node:vm';

export function element() {
  const node = { _children: [], calls: {}, handlers: {} };
  let proxy;
  proxy = new Proxy(node, { get(target, key) {
    if (key in target) return target[key];
    return (...args) => {
      if (key === 'child' || key === 'trigger' || key === 'content') target._children.push(args[0]);
      else if (key === 'children') target._children.push(...args[0]);
      else if (key === 'when') { if (args[0]) args[1](proxy); }
      else if (key.startsWith('on_')) {
        target.handlers[key] = args.at(-1);
        if (typeof args[0] === 'string') target.handlers[`${key}:${args[0]}`] = args.at(-1);
      }
      else target.calls[key] = args;
      return proxy;
    };
  } });
  return proxy;
}
export const nodes = root => typeof root === 'object' && root ? [root, ...root._children.flatMap(nodes)] : [];
export const byId = (root, id) => nodes(root).find(n => n.calls.id?.[0] === id);
export const words = root => typeof root === 'string' ? [root] : (root?._children ?? []).flatMap(words);

// Compiles a mod's entry (`main.js`) and its local `./*.js` modules with
// per-file lexical isolation (each module runs in its own IIFE returning its
// named exports), so missing imports fail with ReferenceError instead of being
// masked by flat concatenation.
function compileMod(name) {
  const read = file => readFileSync(new URL(`../mods/${name}/${file}`, import.meta.url), 'utf8');
  const seen = new Set();
  const order = [];
  const visit = file => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = read(file);
    for (const m of text.matchAll(/^(?:import|export)\s+[\s\S]*?\s+from\s+"\.\/([^"]+\.js)";/gm)) visit(m[1]);
    order.push({ file, text });
  };
  visit('main.js');

  const lines = ['const __mods = Object.create(null);'];
  for (const { file, text } of order) {
    const exportsList = [];
    let defaultName = null;
    const localImports = [];
    let body = text
      .replace(/^import\s+\{([^}]+)\}\s+from\s+"\.\/([^"]+\.js)";\n?/gm, (_m, names, modFile) => {
        const cleaned = names.replace(/\s+/g, ' ').trim();
        localImports.push(`const { ${cleaned} } = __mods[${JSON.stringify(modFile)}];`);
        return '';
      })
      .replace(/^export\s+\{([^}]+)\}\s+from\s+"\.\/([^"]+\.js)";\n?/gm, (_m, names, modFile) => {
        const cleaned = names.replace(/\s+/g, ' ').trim();
        localImports.push(`const { ${cleaned} } = __mods[${JSON.stringify(modFile)}];`);
        for (const item of cleaned.split(',').map(s => s.trim()).filter(Boolean)) {
          const [orig, alias] = item.split(/\s+as\s+/);
          exportsList.push(alias ? `${alias}: ${alias}` : orig);
        }
        return '';
      })
      .replace(/^import\s+[^;]+;\n?/gm, '')
      .replace(/^export\s+\{([^}]*)\};\n?/gm, (_m, names) => {
        for (const item of names.split(',').map(s => s.trim()).filter(Boolean)) {
          const [orig, alias] = item.split(/\s+as\s+/);
          exportsList.push(alias ? `${alias}: ${orig}` : orig);
        }
        return '';
      })
      .replace(/^export\s+default\s+class\s+(\w+)/m, (_m, cls) => {
        defaultName = cls;
        return `class ${cls}`;
      })
      .replace(/^export\s+(?:async\s+)?(function|class|const|let|var)\s+(\w+)/gm, (m, _kw, id) => {
        exportsList.push(id);
        return m.replace(/^export\s+/, '');
      });
    if (defaultName) exportsList.push(`default: ${defaultName}`);
    lines.push(
      `__mods[${JSON.stringify(file)}] = (() => {\n${localImports.join('\n')}\n${body}\nreturn { ${exportsList.join(', ')} };\n})();`,
    );
  }
  lines.push('__mods["main.js"].default');
  return lines.join('\n');
}

// Loads a mod into a sandbox with fake Herdr globals. `data` sets the state
// (spaces, panes, props, layout, ...) and replaces exec, readTextFile or
// watchFolder. Set `reactive: true` to re-render automatically on `cx.notify()`.
// `props()` returns `undefined` inside `cx.spawn` continuations, matching Herdr.
export function load(name, data = {}) {
  const state = { agents: [], terminals: [], spaces: [], panes: [], machines: [], props: {}, focused: { space: 's1' }, active: true, now: 0,
    layout: { children: [] }, home: '/home/u', ...data };
  const shared = new Map(Object.entries(data.shared ?? {}));
  const storage = new Map();
  const actions = [], tasks = [], timers = [], notifications = [], overlays = [], logs = [], inputs = [], watches = [], errors = [];
  const task = entry => { entry.cancelled = false; entry.cancel = () => { entry.cancelled = true; }; return entry; };
  const clipboard = [];
  let inSpawn = false;
  let notifyCount = 0;
  let view = null;
  const cx = {
    notify() {
      notifyCount++;
      if (data.reactive && view) view.render(cx);
    },
    stop_propagation() {},
    write_to_clipboard: text => clipboard.push(text),
    focus_handle: () => ({ focus() {} }),
    spawn(body, opts) { const t = task({ body, opts }); tasks.push(t); return t; },
    timer: {
      after(ms, body) { const t = task({ at: state.now + ms, body }); timers.push(t); return t; },
      every(ms, body) { const t = task({ every: ms, next: state.now + ms, body }); timers.push(t); return t; },
    },
  };
  const src = compileMod(name);
  const Mod = vm.runInNewContext(src, {
    View: class {}, div: element, v_flex: element, h_flex: element, svg: element, image: element,
    InputState: { new: ({ value = '' } = {}) => {
      const on = {};
      let sel = { start: value.length, end: value.length };
      const input = { value: () => value, set_value(next) { value = next; sel = { start: next.length, end: next.length }; on.change?.({}, cx); },
        selected_range: () => sel, set_selected_range(next) { sel = next; }, on(event, body) { on[event] = body; }, focus() {},
        emit(event, next, payload = {}) { if (next !== undefined) { value = next; sel = { start: next.length, end: next.length }; } on[event]?.(payload, cx); } };
      inputs.push(input);
      return input;
    } },
    TextareaState: { new: ({ value = '' } = {}) => {
      const on = {};
      const area = { value: () => value, set_value(next) { value = next; }, set_auto_grow() {}, on(event, body) { on[event] = body; }, focus() { area.focused = true; },
        emit(event, next, payload = {}) { if (next !== undefined) value = next; on[event]?.(payload, cx); } };
      inputs.push(area);
      return area;
    } },
    Textarea: { new: element }, Popover: { new: id => element().id(id) },
    Input: { new: element }, ScrollHandle: { new: () => { const scrolled = []; return { scrolled, scroll_to_item(i) { scrolled.push(i); } }; } }, Scrollbar: { vertical: element }, Checkbox: { new: id => element().id(id) },
    // Every row of a virtual list, as if all were on screen.
    v_virtual_list: (id, count, height, key, rows) => element().id(id).children(rows({ start: 0, end: count })),
    agents: () => state.agents, terminals: () => state.terminals, spaces: () => state.spaces,
    panes: () => state.panes, machines: () => state.machines,
    props: () => (inSpawn ? undefined : state.props),
    checking: () => Boolean(data.checking),
    focused: () => state.focused, layout: () => state.layout, window: () => ({ active: state.active, platform: 'macos' }),
    keys: () => state.keys ?? [], settings: () => ({ zoom: 1 }), theme: () => new Proxy({}, { get: () => '#8899aa' }),
    home: () => state.home, appHome: () => `${state.home}/.config/herdr-app`,
    shared: key => shared.get(key), setShared: (key, value) => shared.set(key, value), setAgentOrder() {},
    run: (name, args) => actions.push({ name, args }),
    openOverlay: args => overlays.push(args), closeOverlay: id => overlays.push({ close: id }),
    notify: value => notifications.push(value), knownAgents: async () => [], pickFolder: data.pickFolder ?? (async () => null),
    nextCommand: () => new Promise(() => {}),
    watchFolder: data.watchFolder ?? (path => new Promise((resolve, reject) => watches.push({ path, resolve, reject }))),
    exec: data.exec ?? (() => { throw new Error('Unexpected exec'); }),
    hc: data.hc ?? (async () => ({ code: 1, stdout: '', stderr: 'no hc in tests' })),
    readTextFile: data.readTextFile ?? (async () => null),
    console: { log: (...args) => logs.push(args.join(' ')) },
    Date: class extends Date { static now() { return state.now; } },
    localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) },
  });
  view = new Mod();
  view.init({}, cx);
  const runInSpawn = fn => {
    inSpawn = true;
    try { return fn(); } finally { inSpawn = false; }
  };
  const harness = {
    state, view, cx, shared, clipboard, actions, tasks, timers, notifications, overlays, logs, inputs, watches,
    get notifyCount() { return notifyCount; },
    render: () => view.render(cx),
    // Starts every spawned task and lets them run until they wait on
    // something that is not ready (a watch, a pending exec).
    async drain() {
      for (let round = 0; round < 20; round++) {
        for (const t of tasks) if (!t.started && !t.cancelled) {
          t.started = true;
          Promise.resolve().then(() => runInSpawn(() => t.body(cx))).catch(e => errors.push(e));
        }
        await new Promise(r => setImmediate(r));
      }
      if (errors.length) throw errors.shift();
    },
    // Moves the clock and runs the timers that come due.
    async advance(ms) {
      state.now += ms;
      for (const t of timers) {
        if (t.cancelled) continue;
        if (t.every) while (t.next <= state.now) { t.next += t.every; t.body(cx); }
        else if (t.at <= state.now) { t.cancel(); t.body(cx); }
      }
      await harness.drain();
    },
    // Resolves the watches on `path` once.
    async fire(path) {
      const due = watches.filter(w => w.path === path);
      watches.splice(0, watches.length, ...watches.filter(w => w.path !== path));
      for (const w of due) w.resolve([path]);
      await harness.drain();
    },
  };
  return harness;
}
