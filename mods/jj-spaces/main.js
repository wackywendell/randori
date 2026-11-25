// Workspace spaces: stable colored avatars, worktrees under their checkout,
// grouped by machine when more than one is known. After a space's name, the repo
// its first terminal is in now, only where unusual: branch, ahead/behind. A space
// you aren't on ends with a mark for its agents (see glyph). Click to switch,
// right-click for its menu, drag to reorder.
//
// A copy of Herdr's `spaces`. jj workspaces nest under their main checkout,
// and a space working in one jj repository shows a status line from jj in
// place of a branch: nearest bookmark and distance, files and lines changed
// in @. Folders jj does not know keep the shipped Git code.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, machines, panes, run, openOverlay, exec, hc, theme, shared, setShared, watchFolder, window, layout, readTextFile } from "herdr";
import { identity, readStatus, visible, spacePlace, base } from "./jj.js";

const IO = { exec, readTextFile };
// Where file watches cannot reach (another machine, a refused watch), visible
// jj status lines are read this often.
const JJ_FALLBACK = 30000;

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

const rowHeight = ({ tree }) => (tree ? 28 : 30);
const RAIL_CELL = 32;
const railCell = (el) => h_flex().flex_none().justify_center().child(el);
const where = (s, ps) => JSON.stringify([s.machine ?? null, spacePlace(s, ps)]);
// The first terminal of the tab a space shows, whose checkout its jj status line gives.
function shownWhere(s, ps) {
  const tab = (s.tabs ?? []).find((c) => c.active)?.id;
  const cwd = ps.find((p) => p.tab === tab && p.cwd)?.cwd;
  return cwd ? JSON.stringify([s.machine ?? null, cwd]) : where(s, ps);
}
// Changes made outside Herdr (an editor's save, a commit in another app): looked
// for this often, in repos the list shows, while the window is in front.
const FALLBACK = 60000;

// What a stored color name looks like on an avatar (the same in every mod
// that draws space avatars): one strong color per hue, light and dark alike.
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };

// A filled dot when an agent in the space needs you, a hollow one while one
// works, nothing when all are idle. The shown space has none: its agents are in view.
export function glyph(status) {
  return status === "blocked" || status === "done" ? "●" : status === "working" ? "○" : "";
}

const marked = (w) => !w.active && Boolean(glyph(w.status));
const mark = (w, t) => div().flex_none().text_size(10).text_color(tone(t, w.status)).child(glyph(w.status));

export function tone(t, status) {
  return t[status] ?? t.unknown;
}

export default class Spaces extends View {
  init(_props, cx) {
    this.git = {}; // where() -> { name, branch, ahead, behind, repo, linked }, null: not a repo
    this.checked = {}; // where() -> when it was last looked at
    this.unsure = new Set(); // where()s git couldn't answer for (a machine away)
    this.pending = new Set(); // where()s to look at next
    this.busy = {}; // pane -> an agent working or a program in front of its shell
    this.ready = {}; // machine -> its layout was readable at the last look
    this.at = {}; // space -> its where() at the last look
    this.places = new Set(); // where()s and jj shownWhere()s of the spaces at the last look
    this.watching = new Set(); // local repos' git folders
    this.ids = {}; // where() -> identity(), kept once jj answered for certain
    this.probing = {}; // where() -> its identity() in flight
    this.jjPending = new Map(); // where() -> snapshot first, for the jj status loop
    this.jjRunning = false;
    this.opWatch = new Set(); // local jj repos whose op_heads are watched
    this.unwatched = new Set(); // jj repo keys read on JJ_FALLBACK instead
    this.hidden = false; // the sidebar was hidden at the last look
    this.statusShown = false; // status lines were drawn at the last look
    // Spaces made while this runs wait (at most a moment) for their git, so a
    // worktree appears under its repo instead of jumping there.
    this.shown = new Set(spaces().map((s) => s.id));
    this.born = {};
    this.pressed = null;
    this.over = null;
    this.machines = [];
    this.reconnecting = JSON.parse(localStorage.getItem("machines.reconnecting") ?? "{}");
    for (const state of Object.values(this.reconnecting)) state.busy = false;
    this.folded = new Set(JSON.parse(localStorage.getItem("machines.folded") ?? "[]"));
    this.settleTimer = null;
    this.refreshMachines(cx);
    cx.timer.every(15000, cx => this.refreshMachines(cx));
    // Event-driven via render(cx) for space/tab/pane/layout changes; 30 s
    // fallback covers unwatched/remote repos, Git repos, and hidden sidebar.
    this.checkNew(cx);
    cx.timer.every(JJ_FALLBACK, (cx) => this.checkNew(cx));
  }

  checkNew(cx, fromRender = false) {
    // A hidden sidebar starts no command, and looks at everything once shown again.
    if (!visible(layout(), "jj-spaces")) { this.hidden = true; return; }
    const now = Date.now();
    const sp = spaces();
    for (const s of sp) if (!this.shown.has(s.id)) this.born[s.id] ??= now;
    const ps = panes();
    const due = this.due(now, sp, ps);
    if (this.hidden) for (const k of Object.keys(this.git)) due.add(k);
    this.hidden = false;
    // Status lines are drawn only in the wide sidebar; widening reads them all once.
    const statusShown = !narrow();
    if (statusShown && !this.statusShown) for (const k of Object.keys(this.git)) if (this.git[k]?.jj) this.queue(k, false);
    this.statusShown = statusShown;
    this.probePanes(sp, ps, cx);
    if (due.size) this.refreshGit(due, cx);
    this.runJj(cx);
    const settling = sp.some((s) => !this.shown.has(s.id)) || Boolean(this.ordering);
    if (settling && !this.settleTimer) {
      this.settleTimer = cx.timer.after(250, (cx) => {
        this.settleTimer = null;
        this.checkNew(cx);
      });
    }
    if (!fromRender && (sp.some((s) => !this.shown.has(s.id)) || this.orderingDue(now))) cx.notify();
  }

  // Places whose git could have changed: new ones (a new space, a cd), where a
  // command or an agent's turn just ended (a checkout, a commit, edits), those on
  // a machine that is back, and repos in view whose fallback is due.
  due(now, sp, ps) {
    // Moved there: what it knew of that place may be old.
    const at = {};
    for (const s of sp) at[s.id] = where(s, ps);
    // A space's active tab in another jj checkout gives its status line, so that is read too.
    const shownJj = sp.map((s) => shownWhere(s, ps)).filter((k) => this.ids[k]?.jj);
    const keys = new Set([...Object.values(at), ...shownJj].filter((k) => JSON.parse(k)[1]));
    // Operations skip places no space shows; one shown again is read once.
    for (const k of keys) if (!this.places.has(k) && this.git[k]?.jj) this.queue(k, false);
    this.places = keys;
    const due = new Set([...keys].filter((k) => !(k in this.git)));
    for (const [id, k] of Object.entries(at)) if (this.at[id] && this.at[id] !== k && keys.has(k)) due.add(k);
    this.at = at;
    const spaceOf = {};
    for (const s of sp) for (const t of s.tabs ?? []) spaceOf[t.id] = s;
    const busy = {};
    for (const p of ps) {
      if (!p.terminal || !spaceOf[p.tab]) continue;
      busy[p.pane] = p.status === "working" || !(p.program?.shell || p.program?.agent);
      if (this.busy[p.pane] && !busy[p.pane]) {
        // In jj, only this space's checkout: its snapshot records an operation
        // when it finds edits, and the op_heads watch refreshes the rest.
        const own = JSON.stringify([spaceOf[p.tab].machine ?? null, p.cwd]);
        const k = this.git[own]?.jj ? own : at[spaceOf[p.tab].id];
        if (this.git[k]?.jj) this.queue(k, true);
        else this.sameRepo(k, keys).forEach((k) => due.add(k));
      }
    }
    this.busy = busy;
    for (const m of machines()) {
      const ready = m.layout === "ready";
      if (ready && this.ready[m.name] === false) for (const k of keys) if (JSON.parse(k)[0] === m.name) due.add(k);
      this.ready[m.name] = ready;
    }
    if (window()?.active) {
      for (const k of keys) {
        const g = this.git[k];
        if (g?.jj) {
          // jj follows op_heads; only unwatched repos are read on the 30 s fallback.
          if (this.unwatched.has(g.repo) && now - (this.checked[k] ?? 0) >= JJ_FALLBACK - 1000) this.queue(k, false);
          continue;
        }
        const asks = this.git[k] || this.unsure.has(k);
        if (asks && !this.folded.has(JSON.parse(k)[0]) && now - (this.checked[k] ?? 0) >= FALLBACK - 1000) due.add(k);
      }
    }
    return due;
  }

  // Every terminal folder of every space gets its identity, so a space
  // working in two jj repositories can go without a status line.
  probePanes(sp, ps, cx) {
    const machineOf = {};
    for (const s of sp) for (const t of s.tabs ?? []) machineOf[t.id] = s.machine ?? null;
    for (const p of ps) {
      if (!p.terminal || !p.cwd || !(p.tab in machineOf)) continue;
      const k = JSON.stringify([machineOf[p.tab], p.cwd]);
      if (k in this.ids || k in this.probing) continue;
      cx.spawn(async (cx) => { await this.ident(k); cx.notify(); });
    }
  }

  // A place's identity(), asked once at a time and kept once jj is certain.
  ident(key) {
    if (key in this.ids) return Promise.resolve(this.ids[key]);
    this.probing[key] ??= (async () => {
      const [on, cwd] = JSON.parse(key);
      const id = await identity(cwd, on, IO);
      if (id.error) console.log(`jj-spaces: ${cwd}: ${id.message}`);
      if (id.jj || id.final) this.ids[key] = id;
      delete this.probing[key];
      return id;
    })();
    return this.probing[key];
  }

  queue(key, snapshot) {
    this.jjPending.set(key, Boolean(this.jjPending.get(key)) || snapshot);
  }

  // The jj status loop: one read at a time, snapshots first, only while status
  // lines are drawn. A request during a read waits in jjPending for the next.
  runJj(cx) {
    if (this.jjRunning || !this.jjPending.size || this.hidden || !this.statusShown) return;
    this.jjRunning = true;
    cx.spawn(async (cx) => {
      while (this.jjPending.size && !this.hidden && this.statusShown) {
        const entries = [...this.jjPending];
        const [key, snapshot] = entries.find(([, s]) => s) ?? entries[0];
        this.jjPending.delete(key);
        const g = this.git[key];
        // A place no space is at any more, such as a finished workspace, is not read.
        if (!g?.jj || !g.root || !this.places.has(key)) continue;
        this.checked[key] = Date.now();
        try { g.status = await readStatus(g.root, JSON.parse(key)[0], snapshot, IO); }
        catch (e) { g.status = { error: "error", message: String(e?.message ?? e) }; }
        if (g.status.error) console.log(`jj-spaces: ${g.root}: ${g.status.message}`);
        cx.notify();
      }
      this.jjRunning = false;
    });
  }

  // One watch per local jj repo: jj rewrites op_heads/heads after every operation.
  watchOps(repo, cx) {
    if (this.opWatch.has(repo)) return;
    this.opWatch.add(repo);
    const mine = JSON.stringify([null, repo]);
    cx.spawn(async (cx) => {
      try {
        for (;;) {
          await watchFolder(`${repo}/op_heads/heads`);
          for (const k of Object.keys(this.git)) if (this.git[k]?.jj && this.git[k].repo === mine) this.queue(k, false);
          this.runJj(cx);
        }
      } catch (e) {
        console.log(`jj-spaces: watching ${repo}: ${e?.message ?? e}`);
        this.unwatched.add(mine);
      }
    });
  }

  // `key` and the other places in its repo (a commit there moves their ahead/behind).
  sameRepo(key, keys) {
    const repo = this.git[key]?.repo;
    return [key, ...(repo ? [...keys].filter((k) => this.git[k]?.repo === repo) : [])];
  }

  refreshMachines(cx) {
    cx.spawn(async cx => {
      try { const r = await hc(["machine", "ls", "--json"]); if (r.code === 0) this.machines = (JSON.parse(r.stdout).machines ?? []).filter((m) => !m.temporary); } catch {}
      cx.notify();
    });
  }

  rebuilt(machine) {
    return machine?.state === "unreachable" && /^a different core answers there \("[^"]+"\)$/.test(machine.why ?? "");
  }

  reconnect(machine, cx) {
    const name = machine.name;
    if (this.reconnecting[name]?.busy) return;
    const state = this.reconnecting[name] ??= { machine, removed: false };
    state.busy = true;
    state.error = null;
    localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
    cx.notify();
    cx.spawn(async cx => {
      try {
        const ask = async args => {
          const r = await hc([...args, "--json"]);
          if (r.code !== 0) {
            let error;
            try { error = JSON.parse(r.stdout || r.stderr).error?.message; } catch {}
            throw new Error(error || r.stderr || r.stdout || "Couldn't connect.");
          }
        };
        if (!state.removed) {
          await ask(["machine", "rm", name]);
          state.removed = true;
          localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
        }
        const args = ["machine", "add"];
        if (machine.via) args.push("--via", machine.target);
        else args.push(machine.target);
        args.push("--name", name);
        if (machine.session) args.push("--session", machine.session);
        if (machine.temporary) args.push("--temp");
        await ask(args);
        this.folded.delete(name);
        localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
        delete this.reconnecting[name];
      } catch (e) {
        state.error = String(e.message ?? e);
        state.busy = false;
      }
      localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
      this.refreshMachines(cx);
      cx.notify();
    });
  }

  // One look at a time, each place once however often it was asked for meanwhile.
  refreshGit(keys, cx) {
    for (const k of keys) this.pending.add(k);
    if (this.refreshing) return;
    this.refreshing = true;
    cx.spawn(async (cx) => {
      while (this.pending.size) {
        const keys = [...this.pending];
        this.pending.clear();
        await Promise.all(keys.map((key) => this.check(key, cx)));
      }
      const used = new Set(Object.values(this.git).filter((g) => g && !g.jj).map((g) => JSON.parse(g.repo)).filter(([on]) => !on).map(([, repo]) => repo));
      for (const repo of this.watching) if (!used.has(repo)) this.watching.delete(repo);
      this.refreshing = false;
      this.runJj(cx);
      cx.notify();
    });
  }

  // One place's git: branch, ahead/behind, its repo.
  async check(key, cx) {
    const [on, cwd] = JSON.parse(key);
    this.checked[key] = Date.now();
    this.unsure.delete(key);
    const id = await this.ident(key);
    if (id.jj || id.error) {
      // Nesting reads `repo` and `linked`, as for a git worktree.
      const repo = id.jj ? JSON.stringify([on, id.repo]) : null;
      const old = this.git[key];
      this.git[key] = { jj: true, repo, linked: Boolean(id.linked), root: id.root, name: id.jj ? base(id.main) : "",
        status: id.error ? id : old?.jj && old.root === id.root ? old.status : undefined };
      if (id.jj) {
        if (on) this.unwatched.add(repo);
        else this.watchOps(id.repo, cx);
        this.queue(key, false);
      }
      return;
    }
    try {
      // Ref-only reads avoid scanning the worktree or waking its index watch.
      // Two reads: a folder name may itself contain a newline.
      const [r, common] = await Promise.all([
        exec("git", ["rev-parse", "--path-format=absolute", "--show-toplevel"], { cwd, on }),
        exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, on }),
      ]);
      if (r.code !== 0 || common.code !== 0) {
        // Only git's own "no" is remembered as no repo; anything else is asked again.
        if (!/not a git repository/i.test(r.code !== 0 ? r.stderr : common.stderr)) this.unsure.add(key);
        this.git[key] = null;
        return;
      }
      // The repo's own .git folder names it; a worktree's top differs from it.
      const top = r.stdout.replace(/\n$/, ""), repo = common.stdout.replace(/\n$/, "");
      const [branch, counts] = await Promise.all([
        exec("git", ["symbolic-ref", "-q", "HEAD"], { cwd, on }),
        exec("git", ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"], { cwd, on }),
      ]);
      const name = repo.endsWith("/.git") ? base(repo.slice(0, -5)) : base(repo).replace(/\.git$/, "");
      const [ahead, behind] = counts.code === 0 ? counts.stdout.trim().split(/\s+/).map(Number) : [0, 0];
      const info = { name, branch: branch.code === 0 ? branch.stdout.trim().replace(/^refs\/heads\//, "") : "(detached)", ahead, behind, repo: JSON.stringify([on, repo]), linked: repo !== `${top}/.git` };
      this.git[key] = info;
      if (!on) this.watch(repo, cx);
    } catch {
      // Couldn't ask (the machine is away): keep what it showed, look again later.
      this.git[key] ??= null;
      this.unsure.add(key);
    }
  }

  watch(repo, cx) {
    if (this.watching.has(repo)) return;
    this.watching.add(repo);
    cx.spawn(async (cx) => {
      try {
        while (this.watching.has(repo)) {
          await watchFolder(repo);
          const mine = JSON.stringify([null, repo]);
          if (this.watching.has(repo)) this.refreshGit(Object.keys(this.git).filter((k) => this.git[k]?.repo === mine), cx);
        }
      } catch { this.watching.delete(repo); }
    });
  }

  menu(w) {
    // A popup is as tall as its items; height is only the most.
    openOverlay({ mod: "jj-menu", kind: "popup", width: 200, height: 260, props: { tab: "space", target: { id: w.id } } });
  }

  orderingDue(now) {
    return this.ordering && now - this.ordering.at >= 1000
      && this.ordering.machines.every(name => machines().some(m => m.name === name && m.layout === "ready"));
  }

  // Spaces in order, each worktree space moved under its main checkout's.
  ordered() {
    const sp = spaces(), ps = panes();
    const ready = (w) => this.shown.has(w.id) || where(w, ps) in this.git || Date.now() - (this.born[w.id] ??= Date.now()) > 1500;
    for (const w of sp) if (!this.shown.has(w.id) && ready(w)) this.shown.add(w.id);
    const list = sp.map((w, i) => {
      const g = this.git[where(w, ps)] ?? null, shown = this.git[shownWhere(w, ps)];
      return { w, i, g, jg: shown?.jj ? shown : g?.jj ? g : null };
    });
    const mains = new Set(list.filter((r) => r.g && !r.g.linked).map((r) => r.g.repo));
    const nested = (r) => r.g?.linked && mains.has(r.g.repo);
    const out = [];
    const placed = new Set(); // repos whose worktrees are listed (under the first of its spaces)
    for (const r of list) {
      if (nested(r)) continue;
      out.push({ ...r, tree: null });
      if (!r.g || r.g.linked || placed.has(r.g.repo)) continue;
      placed.add(r.g.repo);
      const kids = list.filter((k) => nested(k) && k.g.repo === r.g.repo);
      kids.forEach((k, n) => out.push({ ...k, tree: n === kids.length - 1 ? "└─" : "├─" }));
    }
    // Simulate the batch so later indexes include earlier moves. An attempted
    // write can lose a sync conflict: allow the echo to settle before retrying.
    const order = sp.map(w => w.id);
    const target = out.map(r => r.w.id);
    const key = JSON.stringify([order, target, machines()]);
    if (order.every((id, i) => id === target[i])) {
      this.ordering = null;
    } else if (this.ordering?.key !== key || this.orderingDue(Date.now())) {
      const moved = new Set();
      this.ordering = { key, at: Date.now(), machines: [] };
      for (let i = 0; i < out.length; i++) {
        const from = order.indexOf(out[i].w.id);
        if (from === i) continue;
        run("space.move", { id: out[i].w.id, index: i + 1 });
        moved.add(out[i].w.machine ?? null);
        order.splice(i, 0, order.splice(from, 1)[0]);
      }
      this.ordering.machines = [...moved];
    }
    return out.filter(r => this.shown.has(r.w.id));
  }

  // The rows, under a header per machine once one isn't this computer.
  grouped(t, collapsed) {
    const rows = this.ordered();
    const draw = (r) => (collapsed ? this.compact(r, t) : this.row(r, t));
    const remote = [...new Set([...rows.map(r => r.w.machine).filter(Boolean), ...this.machines.map(m => m.name), ...Object.keys(this.reconnecting)])].sort();
    const loading = m => {
      const layout = machines().find(k => k.name === m)?.layout;
      return layout === "loading" || (!layout && this.machines.some(k => k.name === m && k.state === "connected"))
        || spaces().some(s => (s.machine ?? null) === m && !this.shown.has(s.id));
    };
    const loadingRow = m => h_flex().id(`machine-loading-${m ?? "local"}`).h(28).flex_none().px(collapsed ? 0 : 8).items_center().when(collapsed, el => el.justify_center()).text_size(12).text_color(t.dim).child(collapsed ? "…" : "Loading…");
    if (!remote.length) return loading(null) && !rows.length ? [loadingRow(null)] : rows.map(draw);
    const machineNames = [null, ...remote];
    return machineNames.flatMap((m) => {
      const mine = rows.filter((r) => (r.w.machine ?? null) === m);
      const repair = this.reconnecting[m];
      const machine = this.machines.find(k => k.name === m) ?? repair?.machine;
      const connected = !m || machine?.state === "connected";
      const rebuilt = this.rebuilt(machine) || !!repair;
      const login = machine?.state === "needs_login" ? `hc machine login ${m}` : null;
      const folded = this.folded.has(m);
      const icon = svg(`mods/workspace-chrome/${m ? "server" : "monitor"}.svg`).size(13).flex_none();
      const badge = div().absolute().right(-3).bottom(-2).size(6).rounded(3).border_1().border_color(t.chrome).bg(connected ? t.ansi2 : t.dim);
      const head = h_flex().id(`machine-${m ?? "local"}`).h(26).flex_none().px(collapsed ? 0 : 8).gap(7).items_center().text_size(11).text_color(t.dim)
        .when(collapsed, el => el.mt(4).w(RAIL_CELL).justify_center().rounded(6).tooltip(login ? `${m} needs a login: run ${login}. Click for Copy.` : m ? `${m} · ${connected ? "connected" : (machine?.state ?? "asleep").replace(/_/g, " ")}` : "This computer"))
        .cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => {
          if (collapsed && login) { run("app.settings", { section: "machines" }); return; }
          folded ? this.folded.delete(m) : this.folded.add(m);
          localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
          cx.notify();
        })
        .when(!collapsed, el => el.child(icon))
        .when(collapsed, el => el.child(div().relative().flex_none().child(icon).when(Boolean(m), el => el.child(badge))))
        .when(!collapsed, el => el.child(div().flex_1().truncate().child(m ?? "This computer"))
          .when(!connected && !rebuilt && !login, el => el.child(div().flex_none().child((machine?.state ?? "asleep").replace(/_/g, " "))))
          .when(rebuilt, el => el.child(h_flex().flex_none().gap(3).items_center()
            .child(div().max_w(140).truncate().child(repair?.error || "rebuilt ·"))
            .child(div().id(`machine-connect-${m}`).text_color(repair?.error ? t.blocked : t.muted)
              .hover(s => s.text_color(t.foreground))
              .tooltip(repair?.error || "This machine was rebuilt or replaced. Click to connect to the new one.")
              .on_click((_e, cx) => { cx.stop_propagation(); this.reconnect(machine, cx); })
              .child(repair?.busy ? "Connecting…" : "Connect"))))
          .when(connected, el => el.child(div().id(`machine-add-${m ?? "local"}`).flex_none().px(4).rounded(4).hover(s => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => { cx.stop_propagation(); run("space.new", { machine: m ?? "" }); }).child("+")))
          .child(div().size(6).rounded(3).flex_none().bg(connected ? t.ansi2 : t.dim))
          .child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(11).flex_none()));
      const empty = h_flex().id(`machine-new-${m ?? "local"}`).h(28).flex_none().px(collapsed ? 0 : 8).gap(7).items_center().rounded(7)
        .text_size(12).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => run("space.new", { machine: m ?? "" }))
        .when(collapsed, el => el.w(RAIL_CELL).rounded(6).justify_center().tooltip(`New space on ${m ?? "this computer"}`)
          .child(h_flex().size(18).rounded(5).border_1().border_color(t.dim).items_center().justify_center()
            .child(svg("mods/workspace-chrome/plus.svg").size(10))))
        .when(!collapsed, el => el.child(svg("mods/workspace-chrome/plus.svg").size(12)).child("New space there"));
      if (!collapsed && rebuilt) return [head];
      const cell = collapsed ? railCell : (el) => el;
      const guidance = !collapsed && login ? [v_flex().px(8).pb(6).gap(3).flex_none()
        .child(div().text_size(11).text_color(t.blocked).child("needs a login: run"))
        .child(h_flex().gap(5).items_center()
          .child(div().flex_1().min_w(0).truncate().tooltip(login).text_size(11).text_color(t.muted).child(login))
          .child(div().id(`machine-login-copy-${m}`).flex_none().px(5).py(2).rounded(4)
            .text_size(11).text_color(t.foreground).bg(t.raised).cursor_pointer().hover(s => s.bg(t.hover))
            .on_click((_e, cx) => { cx.stop_propagation(); cx.write_to_clipboard(login); this.copiedLogin = login; cx.notify(); })
            .child(this.copiedLogin === login ? "Copied" : "Copy")))] : [];
      return [cell(head), ...guidance, ...(folded ? [] : mine.length ? mine.map(draw) : [loading(m) ? loadingRow(m) : cell(empty)])];
    });
  }

  // Only what's unusual, after the name: "herdr \u00b7 spike \u21912 \u21931". The repo or
  // branch goes when the name already says it (a worktree is named after its branch),
  // and master/main go: nearly every space is on one.
  gitTail(g, tree, name, t) {
    const raw = g.branch ?? "detached";
    const same = (a) => a.toLowerCase() === name.toLowerCase();
    const branch = same(raw) || raw === "master" || raw === "main" ? "" : raw;
    const repo = tree || same(g.name) ? "" : g.name;
    const where = [repo, branch].filter(Boolean).join(" \u00b7 ");
    return h_flex()
      .flex_1()
      .min_w(0)
      .gap(5)
      .justify_end()
      .items_center()
      .text_size(11.5)
      .text_color(t.dim)
      .when(Boolean(where), (el) => el.child(div().min_w(0).truncate().child(where)))
      .when(g.ahead > 0, (el) => el.child(div().flex_none().text_color(t.ansi2).child(`\u2191${g.ahead}`)))
      .when(g.behind > 0, (el) => el.child(div().flex_none().text_color(t.ansi1).child(`\u2193${g.behind}`)));
  }

  // The jj status of the space's active tab after its name: "master~4 ~3 +120 -8",
  // "∅" for an empty @, or one dim word with jj's message as its tooltip. As for
  // git, the repo's name comes first unless the space's name or nesting says it.
  // The bookmark is cut from the left when the row is narrow.
  jjTail(jg, g, tree, name, id, t) {
    const s = jg.status;
    const said = (tree && jg.repo === g?.repo) || jg.name.toLowerCase() === name.toLowerCase();
    const el = h_flex().flex_1().min_w(0).gap(5).justify_end().items_center().text_size(11.5).text_color(t.dim)
      .when(!said && Boolean(jg.name), (el) => el.child(div().min_w(0).truncate().child(jg.name)));
    if (!s) return el;
    if (s.error) return el.child(div().id(`jj-status-${id}`).flex_none().tooltip(s.message).child(s.error));
    const bookmark = s.bookmark ? (s.distance ? `${s.bookmark}~${s.distance}` : s.bookmark) : "";
    return el
      .when(Boolean(bookmark), (el) => el.child(div().min_w(0).overflow_hidden().whitespace_nowrap().text_ellipsis_start().child(bookmark)))
      .when(s.empty, (el) => el.child(div().flex_none().child("\u2205")))
      .when(!s.empty, (el) => el
        .child(div().flex_none().font_bold().text_color(t.working).child(`~${s.files}`))
        .child(div().flex_none().text_color(t.ansi2).child(`+${s.added}`))
        .child(div().flex_none().text_color(t.ansi1).child(`-${s.removed}`)));
  }

  row({ w, i, g, jg, tree }, t) {
    const on = w.active;
    const fromIndex = this.pressed === null ? -1 : spaces().findIndex(s => s.id === this.pressed);
    const colors = shared("space.colors") ?? {};
    const color = colors[w.id] ?? "ansi6";
    const fill = color.startsWith("#") ? color : (MARK[color] ?? t[color]);
    return v_flex()
      .relative()
      .id(`space-${w.id}`)
      .px(8)
      .h(rowHeight({ tree }))
      .flex_none()
      .justify_center()
      .rounded(8)
      .when(on, (el) => el.bg(t.selected))
      .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
      .when(this.pressed === w.id && this.over !== w.id, (el) => el.opacity(0.5))
      .when(this.pressed !== null && this.over === w.id && this.pressed !== w.id, (el) => el.child(
        div().absolute().left(0).right(0).h(2).bg(t.accent)
          .when(fromIndex < i, line => line.bottom(0))
          .when(fromIndex > i, line => line.top(0)),
      ))
      .on_mouse_down("left", () => {
        this.pressed = w.id;
        this.over = w.id;
      })
      .on_mouse_move((_e, cx) => {
        const source = spaces().find(s => s.id === this.pressed);
        const over = source && (source.machine ?? null) === (w.machine ?? null) ? w.id : null;
        if (this.pressed !== null && this.over !== over) {
          this.over = over;
          cx.notify();
        }
      })
      .on_mouse_up("left", (_e, cx) => {
        const from = this.pressed;
        const over = this.over;
        this.pressed = null;
        this.over = null;
        if (from !== null && over === w.id && from !== w.id) {
          const index = spaces().findIndex(s => s.id === w.id);
          if (index !== -1) run("space.move", { id: from, index: index + 1 });
        } else if (from === w.id) run("space.select", { id: w.id });
        cx.notify();
      })
      .on_mouse_down("right", () => this.menu(w))
      .child(
        h_flex()
          .gap(9)
          .items_center()
          .when(Boolean(tree), el => el.pl(22).child(svg("mods/workspace-chrome/branch.svg").size(13).text_color(t.dim)))
          .when(!tree, el => el.child(h_flex().size(18).flex_none().rounded(5).bg(fill).items_center().justify_center().text_size(10.5).font_bold().text_color("#ffffff").child([...w.name][0]?.toUpperCase() ?? "?")))
          .child(div().flex_shrink(0).max_w(150).truncate().text_color(t.foreground).child(w.name))
          .child(jg ? this.jjTail(jg, g, tree, w.name, w.id, t) : g ? this.gitTail(g, tree, w.name, t) : div().flex_1())
          .when(marked(w), (el) => el.child(mark(w, t))),
      );
  }

  compact({ w, i }, t) {
    return railCell(h_flex()
      .id(`space-${w.id}`)
      .relative()
      .w(RAIL_CELL)
      .h(26)
      .rounded(6)
      .justify_center()
      .items_center()
      .when(w.active, (el) => el.bg(t.selected))
      .when(!w.active, (el) => el.hover((s) => s.bg(t.hover)))
      .on_click(() => run("space.select", { id: w.id }))
      .child(div().text_color(w.active ? t.foreground : t.muted).child(String(i + 1)))
      .when(marked(w), (el) => el.child(mark(w, t).absolute().right(5))));
  }

  render(cx) {
    this.checkNew(cx, true);
    const t = theme();
    const collapsed = narrow();
    const palette = ["ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1"];
    const sp = spaces();
    const ids = new Set(sp.map(p => p.id));
    const kept = Object.fromEntries(Object.entries(shared("space.colors") ?? {}).filter(([id]) => ids.has(id)));
    let changed = Object.keys(kept).length !== Object.keys(shared("space.colors") ?? {}).length;
    for (const p of sp) {
      if (kept[p.id] || p.name === "~") continue;
      const uses = c => Object.values(kept).filter(v => v === c).length;
      kept[p.id] = palette.reduce((best, c) => uses(c) < uses(best) ? c : best);
      changed = true;
    }
    if (changed) setShared("space.colors", kept);
    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
      .child(h_flex().h(31).pl(16).pr(10).items_center().justify_between().text_size(11.5).text_color(t.dim)
        .when(collapsed, el => el.pl(0).pr(0).justify_center())
        .when(!collapsed, el => el.child("Spaces"))
        .child(div().id("space-new").size(26).flex_none().flex().items_center().justify_center().rounded(6).hover(s => s.bg(t.hover).text_color(t.foreground))
          .on_click(() => run("space.new")).child(svg("mods/workspace-chrome/plus.svg").size(14))))
      .child(v_flex().flex_1().min_h(0).px(collapsed ? 0 : 8).pb(14).overflow_y_scrollbar().mode("always")
        .on_mouse_up("left", (_e, cx) => { this.pressed = null; cx.notify(); })
        .children(this.grouped(t, collapsed)));
  }
}
