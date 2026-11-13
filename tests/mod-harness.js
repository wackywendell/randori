import { readFileSync } from 'node:fs';
import vm from 'node:vm';

export function element() {
  const node = { _children: [], calls: {}, handlers: {} };
  let proxy;
  proxy = new Proxy(node, { get(target, key) {
    if (key in target) return target[key];
    return (...args) => {
      if (key === 'child') target._children.push(args[0]);
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

// A mod's source with its imports removed. `./jj.js` is inlined, as Herdr
// would load it from the mod's own folder.
function source(name) {
  const read = file => readFileSync(new URL(`../mods/${name}/${file}`, import.meta.url), 'utf8');
  let main = read('main.js');
  const jj = /^import .* from "\.\/jj\.js";\n/m.test(main) ? read('jj.js') : '';
  main = main.replace(/^import .*;\n/gm, '');
  return `${jj}\n${main}`.replace('export default class ', 'class ').replace(/^export /gm, '');
}

// Loads a mod into a sandbox with fake Herdr globals. `data` sets the state
// (spaces, panes, props, layout, ...) and replaces exec, readTextFile or
// watchFolder. Without a watchFolder, watches wait for `fire(path)`.
export function load(name, data = {}) {
  const state = { agents: [], terminals: [], spaces: [], panes: [], machines: [], props: {}, focused: { space: 's1' }, active: true, now: 0,
    layout: { children: [] }, home: '/home/u', ...data };
  const shared = new Map(Object.entries(data.shared ?? {}));
  const storage = new Map();
  const actions = [], tasks = [], timers = [], notifications = [], overlays = [], logs = [], inputs = [], watches = [], errors = [];
  const task = entry => { entry.cancelled = false; entry.cancel = () => { entry.cancelled = true; }; return entry; };
  const cx = { notify() {}, stop_propagation() {}, focus_handle: () => ({ focus() {} }),
    spawn(body, opts) { const t = task({ body, opts }); tasks.push(t); return t; },
    timer: {
      after(ms, body) { const t = task({ at: state.now + ms, body }); timers.push(t); return t; },
      every(ms, body) { const t = task({ every: ms, next: state.now + ms, body }); timers.push(t); return t; },
    },
  };
  const src = source(name);
  const className = src.match(/^class (\w+) extends View/m)[1];
  const Mod = vm.runInNewContext(`${src}\n${className}`, {
    View: class {}, div: element, v_flex: element, h_flex: element, svg: element, image: element,
    InputState: { new: ({ value = '' } = {}) => {
      const on = {};
      const input = { value: () => value, set_value(next) { value = next; }, on(event, body) { on[event] = body; }, focus() {},
        emit(event, next) { if (next !== undefined) value = next; on[event]?.({}, cx); } };
      inputs.push(input);
      return input;
    } },
    Input: { new: element }, ScrollHandle: { new: () => ({ scroll_to_item() {} }) }, Scrollbar: { vertical: element }, Checkbox: { new: id => element().id(id) },
    // Every row of a virtual list, as if all were on screen.
    v_virtual_list: (id, count, height, key, rows) => element().id(id).children(rows({ start: 0, end: count })),
    agents: () => state.agents, terminals: () => state.terminals, spaces: () => state.spaces,
    panes: () => state.panes, machines: () => state.machines, props: () => state.props,
    focused: () => state.focused, layout: () => state.layout, window: () => ({ active: state.active, platform: 'macos' }),
    keys: () => [], settings: () => ({ zoom: 1 }), theme: () => new Proxy({}, { get: () => '#8899aa' }),
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
  const view = new Mod();
  view.init({}, cx);
  const harness = { state, view, cx, shared, actions, tasks, timers, notifications, overlays, logs, inputs, watches, render: () => view.render(cx),
    // Starts every spawned task and lets them run until they wait on
    // something that is not ready (a watch, a pending exec).
    async drain() {
      for (let round = 0; round < 20; round++) {
        for (const t of tasks) if (!t.started && !t.cancelled) {
          t.started = true;
          Promise.resolve().then(() => t.body(cx)).catch(e => errors.push(e));
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
