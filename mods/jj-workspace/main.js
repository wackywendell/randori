// Workspace dialog: { space, folder, action: "new" | "open" | "finish" };
// optional { tab, argv }.
//
// A copy of Herdr's `worktree` dialog for jj. New workspace runs
// `jj workspace add`, links the configured local files from the main checkout,
// trusts linked mise files and opens a space on the checkout. Open workspace
// lists the repository's workspaces and selects or opens a space on one.
// Finish workspace ends the terminals in the checked linked workspaces and
// runs `jj workspace remove` on each.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, Checkbox } from "gpui-base";
import { run, props, closeOverlay, theme, spaces, panes, terminals, exec, home, readTextFile, layout, notify } from "herdr";
import { identity } from "./jj.js";

const IO = { exec, readTextFile };

// Where a space is now: its first terminal's live folder, else where it was made.
function place(s, all = panes()) {
  if (!s) return null;
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return all.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder || null;
}

// The settings on the jj-spaces layout block, over these defaults.
const DEFAULTS = { directory: "~/.herdr/worktrees/{repo}/{name}", links: [], miseTrust: true };
function settings(root = layout()) {
  const find = (node) => node?.content?.mod === "jj-spaces" ? node : (node?.children ?? []).map(find).find(Boolean);
  return { ...DEFAULTS, ...(find(root)?.content?.props ?? {}) };
}

// Home as ~.
const tilde = (path, userHome) => (userHome && path.startsWith(userHome) ? `~${path.slice(userHome.length)}` : path);
const untilde = (path, userHome) => (path === "~" || path.startsWith("~/") ? `${userHome}${path.slice(1)}` : path);
const slug = (branch) => branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
const base = (path) => path.replace(/\/+$/, "").split("/").pop();
const parent = (path) => path.replace(/\/[^/]*$/, "") || "/";
const inside = (p, dir) => p === dir || p.startsWith(dir + "/");

// Linked mise configuration: mise.toml, .mise.toml, mise.<env>.toml and
// .mise.<env>.toml, and anything under .mise/, mise/ or .config/mise/.
export const miseFile = (path) => /(^|\/)\.?mise(\.[^./]+)?\.toml$/.test(path) || /^(\.mise|mise|\.config\/mise)\//.test(path);

// The space showing a checkout: its first terminal is in it (the deepest checkout wins).
function spaceOf(path, all, on, spaceList, paneList) {
  return spaceList.find((s) => (s.machine ?? null) === (on ?? null) && (() => {
    const at = place(s, paneList);
    if (!at || !inside(at, path)) return false;
    return !all.some((c) => c.path !== path && c.path.length > path.length && inside(at, c.path));
  })());
}

async function jj(cwd, args, on, timeout) {
  const r = await exec("jj", args, { cwd, on, ...(timeout === undefined ? {} : { timeout }) });
  return { ok: r.code === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? r.stdout ?? "").trim() };
}

// Every workspace of a repo, the main checkout first: { name, path, main }.
// A workspace made before jj 0.38 records no folder: its path is "".
async function workspaces(repo, on) {
  const r = await jj(repo.root, ["--ignore-working-copy", "workspace", "list", "-T", 'json({"name" => name, "root" => root}) ++ "\\n"'], on);
  if (!r.ok) throw new Error(r.err || "jj workspace list failed.");
  const list = r.out.split("\n").filter(Boolean).map((l) => JSON.parse(l)).map((w) => ({ name: w.name, path: w.root, main: w.root === repo.main }));
  return list.sort((a, b) => b.main - a.main || a.name.localeCompare(b.name));
}

async function bookmarks(repo, on) {
  const r = await jj(repo.root, ["--ignore-working-copy", "bookmark", "list", "-T", 'if(!remote && present, name ++ "\\n")'], on);
  if (!r.ok) throw new Error(r.err || "jj bookmark list failed.");
  return new Set(r.out.split("\n").filter(Boolean));
}

// Commands that succeed or fail without output we need.
async function ok(command, args, on) {
  try { return (await exec(command, args, { on })).code === 0; } catch { return false; }
}

export default class Workspace extends View {
  init(_props, cx) {
    this.on = this.space()?.machine;
    this.userHome = this.on ? null : home();
    this.opening = props()?.action === "open";
    this.finishing = props()?.action === "finish";
    this.rows = []; // finish: { name, root, checked, removed, error }
    this.text = "";
    this.list = undefined; // open: the workspaces, once read
    this.names = new Set(); // new: the local bookmarks
    this.at = 0;
    this.input = InputState.new({ value: this.text, placeholder: this.opening ? "filter workspaces" : "workspace name" });
    this.input.on("change", (_e, cx) => { this.text = this.input.value(); this.error = ""; this.at = 0; cx.notify(); });
    this.input.on("submit", (_e, cx) => this.go(cx));
    this.inputFocused = true;
    this.input.on("focus", (_e, cx) => { this.inputFocused = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.inputFocused = false; cx.notify(); });
    this.handle = cx.focus_handle();
    this.handle.focus(); // the root is mounted from the first frame: keep the keyboard here while loading
    if (!this.finishing) this.input.focus();
    this.busy = false;
    this.error = "";
    this.repo = undefined; // undefined: looking, null: not in jj
    cx.spawn(async (cx) => {
      try {
        if (this.on) {
          const result = await exec("sh", ["-c", 'printf %s "$HOME"'], { on: this.on });
          if (result.code !== 0 || !result.stdout.trim()) throw new Error("Could not find the remote home folder.");
          this.userHome = result.stdout.trim();
        }
        this.folder = props()?.folder || place(this.space()) || this.userHome;
        if (this.finishing) {
          this.repo = await this.prepare();
          return cx.notify();
        }
        const id = await identity(this.folder, this.on, IO);
        if (id.error) throw new Error(id.message);
        const repo = id.jj ? { ...id, name: base(id.main) } : null;
        if (repo && this.opening) this.list = await workspaces(repo, this.on);
        if (repo && !this.opening) this.names = await bookmarks(repo, this.on);
        // The repo is set last: Enter does nothing until what it uses is known.
        this.repo = repo;
        cx.notify();
        // The list (and with it the filter input) only mounts once loading is
        // done, so the keyboard must move there now.
        this.handle.focus();
        cx.timer.after(100, () => this.input.focus());
      } catch (error) {
        console.log(`jj-workspace: ${error?.message ?? error}`);
        this.repo = null;
        this.error = String(error?.message ?? error);
        cx.notify();
      }
    });
  }

  space() {
    const p = props() ?? {};
    return spaces().find((s) => s.id === p.space) ?? (p.folder ? { folder: p.folder, machine: p.machine ?? null, name: "" } : undefined);
  }

  close() {
    closeOverlay(props().overlay);
  }

  go(cx) {
    if (this.busy || !this.repo || this.opening) return;
    cx.spawn(async (cx) => this.work(cx));
  }

  async work(cx) {
    if (this.busy || !this.repo) return;
    this.busy = true;
    this.error = "";
    cx.notify();
    try { this.error = await this.create(); }
    catch (error) { this.error = String(error?.message ?? error); }
    if (this.error) console.log(`jj-workspace: ${this.error}`);
    this.busy = false;
    if (!this.error) this.close();
    cx.notify();
  }

  // The folder and start of the workspace a name would make.
  planned(name = this.text.trim()) {
    const directory = settings().directory.replaceAll("{repo}", this.repo.name).replaceAll("{name}", slug(name));
    return { name, path: untilde(directory, this.userHome), bookmark: this.names.has(name) };
  }

  async create() {
    const { name, path, bookmark } = this.planned();
    if (!name) return "Type a workspace name.";
    const { links, miseTrust } = settings();
    const add = ["workspace", "add", "--name", name, ...(bookmark ? ["-r", JSON.stringify(name)] : []), path];
    // jj workspace add makes only the last folder of the path.
    if (!(await ok("mkdir", ["-p", parent(path)], this.on))) return `Could not make ${parent(path)}.`;
    const r = await jj(this.repo.root, add, this.on, 600_000);
    if (!r.ok) return r.err || "jj workspace add failed.";
    const problems = [];
    const linked = [];
    for (const rel of links) {
      const source = `${this.repo.main}/${rel}`, target = `${path}/${rel}`;
      if (!(await ok("test", ["-e", source], this.on))) { problems.push(`${rel}: not in the main checkout`); continue; }
      if ((await ok("test", ["-e", target], this.on)) || (await ok("test", ["-L", target], this.on))) { problems.push(`${rel}: already in the new checkout`); continue; }
      if (!(await ok("mkdir", ["-p", parent(target)], this.on)) || !(await ok("ln", ["-s", source, target], this.on))) { problems.push(`${rel}: could not link`); continue; }
      linked.push(rel);
    }
    const trust = linked.filter(miseFile);
    if (miseTrust && trust.length && (await ok("mise", ["--version"], this.on))) {
      for (const rel of trust) if (!(await ok("mise", ["trust", `${path}/${rel}`], this.on))) problems.push(`${rel}: mise trust failed`);
    }
    if (problems.length) {
      console.log(`jj-workspace: ${problems.join("; ")}`);
      notify({ title: "New workspace", body: problems.join("\n"), level: "warning" });
    }
    const p = props();
    // Leave spaces unnamed so they follow the checkout folder and nest under the repo.
    run("space.new", { folder: path, machine: this.on ?? "", tab: p.tab, argv: p.argv });
    return "";
  }

  // Finish: the linked workspaces the space's terminals work in, in tab
  // order. The first is checked, so the first terminal's workspace is
  // checked when it is linked.
  async prepare() {
    const s = this.space();
    if (!s?.id) throw new Error("The space is gone.");
    this.spaceId = s.id;
    const all = panes();
    const folders = (s.tabs ?? []).flatMap((c) => all.filter((p) => p.tab === c.id && p.terminal && p.cwd).map((p) => p.cwd));
    let main = null;
    for (const folder of new Set(folders)) {
      const id = await identity(folder, this.on, IO);
      if (id.error) throw new Error(id.message);
      if (!id.jj || !id.linked || this.rows.some((r) => r.root === id.root)) continue;
      if (main && id.main !== main) throw new Error("This space's terminals work in more than one jj repository.");
      main = id.main;
      this.rows.push({ root: id.root, checked: false, removed: false, error: "" });
    }
    if (!main) throw new Error("No terminal of this space works in a linked jj workspace.");
    const list = await workspaces({ root: main, main }, this.on);
    for (const r of this.rows) {
      r.name = list.find((w) => w.path === r.root)?.name;
      if (!r.name) throw new Error(`jj lists no workspace at ${tilde(r.root, this.userHome)}.`);
    }
    this.rows[0].checked = true;
    return { main, name: base(main) };
  }

  // Other spaces with a terminal in a checkout, whose terminals end too.
  sharing(root) {
    const all = panes();
    return spaces()
      .filter((s) => s.id !== this.spaceId && (s.machine ?? null) === (this.on ?? null))
      .filter((s) => (s.tabs ?? []).some((c) => all.some((p) => p.tab === c.id && p.terminal && p.cwd && inside(p.cwd, root))))
      .map((s) => s.name);
  }

  // Check, end terminals, remove. The first failure stops the run and shows
  // beside its workspace; Enter starts again with the names not yet removed.
  async finish(cx) {
    const todo = this.rows.filter((r) => r.checked && !r.removed);
    if (this.busy || !this.repo || !todo.length) return;
    this.busy = true;
    for (const r of this.rows) r.error = "";
    cx.notify();
    let at = todo[0];
    try {
      const list = await workspaces({ root: this.repo.main, main: this.repo.main }, this.on);
      for (const r of todo) {
        at = r;
        if (!list.some((w) => w.name === r.name && w.path === r.root)) throw new Error(`jj no longer lists ${r.name}. Its folder ${tilde(r.root, this.userHome)} remains.`);
      }
      for (const r of todo) {
        at = r;
        // jj waits for a held lock without limit, so this one is bounded.
        const st = await jj(r.root, ["status"], this.on, 10_000);
        if (!st.ok) throw new Error(st.err || "jj status did not finish within 10 seconds.");
      }
      await this.endTerminals(todo, cx);
      for (const r of todo) {
        at = r;
        const rm = await jj(this.repo.main, ["workspace", "remove", r.name], this.on, 600_000);
        if (!rm.ok) throw new Error(rm.err || "jj workspace remove failed.");
        r.removed = true;
        cx.notify();
      }
    } catch (error) {
      at = error?.row ?? at;
      at.error = String(error?.message ?? error);
      console.log(`jj-workspace: ${at.name}: ${at.error}`);
    }
    this.busy = false;
    if (!this.rows.some((r) => r.error)) this.close();
    cx.notify();
  }

  // Kills every terminal in the checked checkouts and waits up to 10 seconds
  // for them to go. Closes the space when none of its terminals are left,
  // else the panes that showed them. A terminal that stays names its row.
  async endTerminals(todo, cx) {
    const mine = (t) => (this.on ? t.address.startsWith(`${this.on}/`) : !t.address.includes("/"));
    const rowOf = (t) => todo.find((r) => t.cwd && inside(t.cwd, r.root));
    const ends = new Set(terminals().filter((t) => mine(t) && rowOf(t)).map((t) => t.address));
    for (const terminal of ends) run("terminal.kill", { terminal });
    for (let waited = 0; ; waited += 200) {
      const left = terminals().find((t) => ends.has(t.address));
      if (!left) break;
      if (waited >= 10_000) {
        throw Object.assign(new Error(`Terminal ${left.name || left.address} in ${tilde(left.cwd, this.userHome)} did not stop.`), { row: rowOf(left) });
      }
      await new Promise((resolve) => cx.timer.after(200, resolve));
    }
    const s = spaces().find((c) => c.id === this.spaceId);
    const tabs = new Set((s?.tabs ?? []).map((c) => c.id));
    const all = panes();
    const closing = Boolean(s) && !all.some((p) => tabs.has(p.tab) && p.terminal && !ends.has(p.terminal));
    if (closing) run("space.close", { id: s.id, confirmed: true });
    for (const p of all) if (p.terminal && ends.has(p.terminal) && !(closing && tabs.has(p.tab))) run("pane.close", { pane: p.pane });
  }

  shown() {
    const f = this.text.trim().toLowerCase();
    return (this.list ?? []).filter((c) => !f || `${c.name} ${c.path}`.toLowerCase().includes(f));
  }

  open(c) {
    if (!c?.path) return;
    this.close();
    const s = spaceOf(c.path, this.list, this.on, spaces(), panes());
    if (s) run("space.select", { id: s.id });
    else run("space.new", { folder: c.path, machine: this.on ?? "" });
  }

  key(e, cx) {
    if (e.key === "escape") return this.close();
    if (this.finishing) {
      const n = this.rows.length;
      if (e.key === "enter") cx.spawn(async (cx) => this.finish(cx));
      else if ((e.key === "space" || e.key === " ") && n && !this.busy) this.toggle(this.rows[this.at]);
      else if ((e.key === "down" || e.key === "up") && n) this.at = (this.at + (e.key === "down" ? 1 : n - 1)) % n;
      else return;
      cx.stop_propagation();
      return cx.notify();
    }
    if (this.opening) {
      const n = this.shown().length;
      if (e.key === "enter") this.open(this.shown()[this.at]);
      else if ((e.key === "down" || e.key === "up") && n) this.at = (this.at + (e.key === "down" ? 1 : n - 1)) % n;
      else return;
      cx.stop_propagation();
      return cx.notify();
    }
  }

  renderOpen(t) {
    const r = this.repo;
    const rows = this.shown();
    const all = this.list ?? [];
    const spaceList = spaces();
    const paneList = panes();
    const row = (c, i) => {
      const on = i === this.at;
      const there = c.path && spaceOf(c.path, all, this.on, spaceList, paneList);
      return v_flex()
        .id(`wt-${i}`)
        .flex_none()
        .h(44)
        .px(10)
        .justify_center()
        .rounded(7)
        .cursor_pointer()
        .when(on, (el) => el.bg(t.selected))
        .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
        .on_click(() => this.open(c))
        .child(
          h_flex()
            .gap(8)
            .items_center()
            .child(div().flex_1().min_w(0).truncate().text_color(c.path ? t.foreground : t.dim).child(c.name))
            .when(c.main, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child("main checkout")))
            .when(Boolean(there), (el) => el.child(div().flex_none().text_size(11).text_color(t.accent).child("open")))
            .when(!c.path, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child("unavailable"))),
        )
        .child(div().truncate().text_size(11.5).text_color(t.dim).child(c.path ? tilde(c.path, this.userHome ?? "") : "jj recorded no folder for this workspace"));
    };
    const count = rows.length === all.length ? `${all.length} workspaces` : `${rows.length}/${all.length} workspaces`;
    return v_flex()
      .id("worktree")
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .size_full()
      .p(16)
      .gap(10)
      .bg(t.popover)
      .text_size(13)
      .child(h_flex().child(div().flex_1().font_semibold().text_color(t.foreground).child(`Open workspace${r ? ` of ${r.name}` : ""}`)).child(div().text_size(11).text_color(t.dim).child(r ? count : "")))
      .when(r === undefined, (el) => el.child(div().text_color(t.muted).child("\u2026")))
      .when(r === null && !this.error, (el) => el.child(div().text_color(t.muted).child(`${this.folder ? tilde(this.folder, this.userHome ?? "") : "This folder"} is not in a jj repository.`)))
      .when(Boolean(this.error), (el) => el.child(div().text_color(t.blocked).child(this.error)))
      .when(Boolean(r && this.list), (el) =>
        el
          .child(Input.new(this.input).h(32).px(10).items_center().rounded(6).border(1).border_color(this.inputFocused ? t.accent : t.input).bg(t.background).text_color(t.foreground))
          .child(
            div()
              .relative()
              .flex_1()
              .min_h(0)
              .child(
                v_flex()
                  .id("wt-list")
                  .size_full()
                  .overflow_y_scroll()
                  .children(rows.map(row))
                  .when(rows.length === 0, (el) => el.child(div().p(10).text_color(t.dim).child("No matching workspaces."))),
              )
              .child(Scrollbar.vertical("wt-list").absolute().inset_0()),
          ),
      )
      .child(h_flex().justify_end().text_size(11).text_color(t.dim).child("\u2191\u2193 choose \u00b7 \u21b5 open \u00b7 esc close"));
  }

  toggle(r) {
    if (r && !r.removed) r.checked = !r.checked;
  }

  renderFinish(t) {
    const r = this.repo;
    const row = (w, i) => {
      const others = w.checked && !w.removed ? this.sharing(w.root) : [];
      return h_flex()
        .id(`finish-${i}`)
        .flex_none()
        .px(10)
        .py(6)
        .gap(10)
        .items_start()
        .rounded(7)
        .when(i === this.at, (el) => el.bg(t.selected))
        .child(
          Checkbox.new(`finish-check-${i}`)
            .checked(w.checked)
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .on_change((_checked, cx) => { if (!this.busy) this.toggle(w); this.at = i; cx.notify(); })
            .flex_none()
            .mt(2)
            .size(14)
            .rounded(3)
            .border(1)
            .border_color(w.checked ? t.accent : t.border)
            .when(w.checked, (el) => el.bg(t.accent))
            .items_center()
            .justify_center()
            .text_size(10)
            .text_color(t.background)
            .child(w.checked ? "\u2713" : ""),
        )
        .child(
          v_flex()
            .flex_1()
            .min_w(0)
            .child(h_flex().gap(8).child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(w.name)).when(w.removed, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child("removed"))))
            .child(div().truncate().text_size(11.5).text_color(t.dim).child(tilde(w.root, this.userHome)))
            .when(others.length > 0, (el) => el.child(div().text_size(11.5).text_color(t.muted).child(`Its terminals in ${others.join(", ")} end too.`)))
            .when(Boolean(w.error), (el) => el.child(div().text_size(11.5).text_color(t.blocked).child(w.error))),
        );
    };
    return v_flex()
      .id("worktree")
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .size_full()
      .p(16)
      .gap(10)
      .bg(t.popover)
      .text_size(13)
      .child(div().font_semibold().text_color(t.foreground).child(`Finish workspace${r ? ` of ${r.name}` : ""}`))
      .when(r === undefined && !this.error, (el) => el.child(div().text_color(t.muted).child("\u2026")))
      .when(Boolean(this.error), (el) => el.child(div().text_color(t.blocked).child(this.error)))
      .when(Boolean(r), (el) =>
        el
          .child(div().text_color(t.muted).child("Ends the terminals working in the checked folders and deletes the folders. Edits jj tracks stay in the repository. Files jj does not track, including ignored files, are deleted."))
          .child(
            div()
              .relative()
              .flex_1()
              .min_h(0)
              .child(v_flex().id("finish-list").size_full().overflow_y_scroll().children(this.rows.map(row)))
              .child(Scrollbar.vertical("finish-list").absolute().inset_0()),
          ),
      )
      .when(!r, (el) => el.child(div().flex_1()))
      .child(
        h_flex()
          .justify_end()
          .text_size(11)
          .text_color(t.dim)
          .gap(6)
          .when(this.busy, (el) => el.child(div().frames(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], 90)))
          .child(this.busy ? "working…" : r ? "space check \u00b7 \u21b5 finish \u00b7 esc cancel" : "esc close"),
      );
  }

  render(cx) {
    const t = theme();
    if (this.finishing) return this.renderFinish(t);
    if (this.opening) return this.renderOpen(t);
    const r = this.repo;
    const plan = r && this.planned();
    const detail =
      r === undefined
        ? "\u2026"
        : r === null
          ? this.error ? "" : `${this.folder ? tilde(this.folder, this.userHome) : "This folder"} is not in a jj repository.`
          : `${tilde(plan.path, this.userHome)}, ${plan.bookmark ? `starts on bookmark ${plan.name}` : "starts from this checkout's parent"}.`;
    return v_flex()
      .id("worktree")
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .size_full()
      .p(16)
      .gap(10)
      .bg(t.popover)
      .text_size(13)
      .child(div().font_semibold().text_color(t.foreground).child(`New workspace${r ? ` of ${r.name}` : ""}`))
      .when(Boolean(r), (el) =>
        el.child(
          Input.new(this.input)
            .h(32)
            .px(10)
            .items_center()
            .rounded(6)
            .border(1)
            .border_color(this.inputFocused ? t.accent : t.input)
            .bg(t.background)
            .text_color(t.foreground),
        ),
      )
      .when(Boolean(detail), (el) => el.child(div().text_color(t.muted).child(detail)))
      .when(Boolean(this.error), (el) => el.child(div().text_color(t.blocked).child(this.error)))
      .child(div().flex_1())
      .child(
        h_flex()
          .justify_end()
          .text_size(11)
          .text_color(t.dim)
          .gap(6)
          .when(this.busy, (el) => el.child(div().frames(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], 90)))
          .child(this.busy ? "working…" : !r ? "esc close" : "↵ create · esc cancel"),
      );
  }
}
