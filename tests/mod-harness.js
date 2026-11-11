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

export function load(name, data = {}) {
  const state = { agents: [], terminals: [], spaces: [], panes: [], machines: [], props: {}, focused: { space: 's1' }, active: true, now: 0, ...data };
  const shared = new Map(Object.entries(data.shared ?? {}));
  const storage = new Map();
  const actions = [], tasks = [], timers = [], notifications = [], overlays = [];
  const task = entry => { entry.cancelled = false; entry.cancel = () => { entry.cancelled = true; }; return entry; };
  const cx = { notify() {}, stop_propagation() {}, focus_handle: () => ({ focus() {} }),
    spawn(body, opts) { const t = task({ body, opts }); tasks.push(t); return t; },
    timer: {
      after(ms, body) { const t = task({ at: state.now + ms, body }); timers.push(t); return t; },
      every(ms, body) { const t = task({ every: ms, body }); timers.push(t); return t; },
    },
  };
  let source = readFileSync(new URL(`../mods/${name}/main.js`, import.meta.url), 'utf8');
  const className = source.match(/export default class (\w+)/)[1];
  source = source.replace(/^import .*;\n/gm, '').replace('export default class ', 'class ').replace(/^export /gm, '');
  const Mod = vm.runInNewContext(`${source}\n${className}`, {
    View: class {}, div: element, v_flex: element, h_flex: element, svg: element, image: element,
    InputState: { new: ({ value = '' } = {}) => ({ value: () => value, set_value(next) { value = next; }, on() {}, focus() {} }) },
    Input: { new: element }, ScrollHandle: { new: () => ({ scroll_to_item() {} }) },
    agents: () => state.agents, terminals: () => state.terminals, spaces: () => state.spaces,
    panes: () => state.panes, machines: () => state.machines, props: () => state.props,
    focused: () => state.focused, layout: () => ({ children: [] }), window: () => ({ active: state.active, platform: 'macos' }),
    keys: () => [], settings: () => ({ zoom: 1 }), theme: () => new Proxy({}, { get: () => '#8899aa' }),
    shared: key => shared.get(key), setShared: (key, value) => shared.set(key, value), setAgentOrder() {},
    run: (name, args) => actions.push({ name, args }),
    openOverlay: args => overlays.push(args), closeOverlay: id => overlays.push({ close: id }),
    notify: value => notifications.push(value), knownAgents: async () => [], pickFolder: data.pickFolder ?? (async () => null),
    nextCommand: () => new Promise(() => {}), watchFolder: data.watchFolder ?? (() => new Promise(() => {})),
    exec: data.exec ?? (() => { throw new Error('Unexpected exec'); }),
    Date: class extends Date { static now() { return state.now; } },
    localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) },
  });
  const view = new Mod();
  view.init({}, cx);
  const harness = { state, view, cx, shared, actions, tasks, timers, notifications, overlays, render: () => view.render(cx),
    async drain() {
      for (const t of tasks) if (!t.ran && !t.cancelled && !/nextCommand|watchFolder/.test(t.body.toString())) {
        t.ran = true;
        await t.body(cx);
      }
    },
    async advance(ms) {
      state.now += ms;
      for (const t of timers) if (!t.cancelled && t.at <= state.now) { t.cancel(); t.body(cx); }
      await harness.drain();
    },
  };
  return harness;
}
