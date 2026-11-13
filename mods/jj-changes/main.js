import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, v_virtual_list } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings, layout } from "herdr";
import { identity, visible, snapshot, readStack, readChange, readPair, readDiff, STACK_LIMIT } from "./jj.js";

const IO = { exec, readTextFile };
// What a jj run does, each step including the ones after it.
const SNAPSHOT = 4, STACK = 3, FILES = 2, DIFF = 1;
const clock = () => { const d = new Date(Date.now()); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
const key = () => JSON.stringify(location());
// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie):
// the folder watch would see it, and every refresh would start the next one.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const countLines = (text) => text ? text.split("\n").length - Number(text.endsWith("\n")) : 0;

// Text draws a tab as nothing: pad each to the next 4-column stop.
const untab = (text) => text.replace(/[^\t]*\t/g, (s) => s.slice(0, -1).padEnd((s.length - 1) - (s.length - 1) % 4 + 4));

// Numbers each diff line once, so a frame only draws the rows on screen.
function diffRows(lines) {
  let old = 0, next = 0;
  return lines.map((line) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) { old = +match[1]; next = +match[2]; return { kind: "@", text: line }; }
    const kind = line[0];
    if (kind === "-") return { kind, number: old++, text: untab(line.slice(1)) || " " };
    if (kind === "+") return { kind, number: next++, text: untab(line.slice(1)) || " " };
    if (kind === " ") { old++; return { kind, number: next++, text: untab(line.slice(1)) || " " }; }
    return { kind: "", text: line };
  });
}

export default class Changes extends View {
  init(_props, cx) {
    this.files = []; this.rows = []; this.diffWidth = 0; this.message = ""; this.handle = cx.focus_handle();
    this.input = InputState.new({ placeholder: "Commit message" });
    this.input.on("change", (_e, cx) => {
      const hadMessage = Boolean(this.message.trim());
      this.message = this.input.value();
      if (hadMessage !== Boolean(this.message.trim())) cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.commit(cx));
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    // A folder's identity(): jj checkouts and "no jj repo" are kept, other
    // answers only until the folder changes.
    this.ids = {}; this.last = null; this.mode = null;
    this.stack = []; this.sel = []; this.want = 0; this.gen = 0; this.watching = new Set();
    // Only reads the layout: being shown again snapshots and reads once.
    cx.timer.every(1000, (cx) => this.checkShown(cx));
  }

  // Sends the focused folder to jj's code or the shipped Git code, once its
  // identity is known. Until then the panel shows nothing and runs nothing.
  route(cx) {
    const { cwd, on } = location(), context = key(), was = this.mode;
    const id = this.ids[context] ?? (this.last?.context === context ? this.last.id : undefined);
    if (cwd && !id) { this.mode = null; this.probe(context, cwd, on, cx); return; }
    if (id?.jj) { this.mode = "jj"; this.checkout(id, on, was !== "jj", cx); return; }
    if (id?.error) { this.mode = "error"; this.ck = null; this.error = id.message; return; }
    this.mode = "git";
    // The shipped code starts over on a new context.
    if (was !== "git") this.context = null;
    if (!this.gitTimer) this.gitTimer = cx.timer.every(10000, (cx) => { if (this.mode === "git") this.refresh(cx); });
    this.refresh(cx);
  }

  probe(context, cwd, on, cx) {
    if (this.probing === context) return;
    this.probing = context;
    cx.spawn(async (cx) => {
      const id = await identity(cwd, on, IO);
      if (id.error) console.log(`jj-changes: ${cwd}: ${id.message}`);
      if (id.jj || id.final) this.ids[context] = id;
      this.last = { context, id };
      if (this.probing === context) this.probing = null;
      if (key() === context) this.route(cx);
      cx.notify();
    });
  }

  // `fresh`: the panel showed something else, so it starts over.
  checkout(id, on, fresh, cx) {
    if (!fresh && this.ck?.root === id.root && this.ck.on === on) return;
    this.ck = { root: id.root, repo: id.repo, on };
    this.stack = []; this.sel = []; this.files = []; this.open = null; this.closed = false; this.setLines([]);
    this.error = null; this.note = null; this.cut = false; this.updated = null; this.gen++;
    if (on === null) this.watchOps(id.repo, cx);
    this.request(SNAPSHOT, cx);
  }

  checkShown(cx) {
    const shown = visible(layout(), "jj-changes");
    if (shown && !this.shown && this.mode === "jj") { this.shown = true; this.request(SNAPSHOT, cx); }
    this.shown = shown;
  }

  // jj rewrites op_heads/heads after every operation, in any workspace.
  watchOps(repo, cx) {
    if (this.watching.has(repo)) return;
    this.watching.add(repo);
    cx.spawn(async (cx) => {
      try {
        for (;;) {
          await watchFolder(`${repo}/op_heads/heads`);
          if (this.mode === "jj" && this.ck?.repo === repo) this.request(STACK, cx);
        }
      } catch (e) { console.log(`jj-changes: watching ${repo}: ${e?.message ?? e}`); }
    });
  }

  // The jj loop: one command at a time, only while shown. A request during a
  // run raises `want`, and the loop runs again once the current run ends.
  request(what, cx) {
    this.want = Math.max(this.want, what);
    if (this.running) return;
    this.running = true;
    cx.spawn(async (cx) => {
      try {
        while (this.want && this.shown && this.mode === "jj") {
          const want = this.want, ck = this.ck;
          this.want = 0;
          try { await this.step(want, ck); }
          catch (e) {
            if (this.ck !== ck) continue;
            this.error = String(e?.message ?? e);
            console.log(`jj-changes: ${ck.root}: ${this.error}`);
          }
          cx.notify();
        }
      } finally { this.running = false; cx.notify(); }
    });
  }

  async step(want, ck) {
    const { root, on } = ck;
    if (want >= SNAPSHOT) await snapshot(root, on, IO);
    if (want >= STACK) {
      const stack = await readStack(root, on, IO);
      if (this.ck !== ck) return;
      this.useStack(stack);
    }
    const gen = this.gen, sel = this.sel;
    if (want >= FILES) {
      const files = await this.readFiles(ck, sel);
      if (this.gen !== gen) return;
      this.files = files.map((f) => ({ path: f.path, status: f.status, add: f.added ?? 0, del: f.removed ?? 0 }));
      if (this.open && !this.files.some((f) => f.path === this.open)) this.open = null;
      // The first file's diff shows until you pick another.
      if (!this.open && !this.closed && this.files.length) this.open = this.files[0].path;
      if (!this.open) this.setLines([]);
    }
    const open = this.open;
    if (open) {
      const range = sel.length === 2 ? ["--from", sel[0].commit, "--to", sel[1].commit] : ["-r", sel[0].commit];
      const { lines, cut } = await readDiff(root, on, range, open, IO);
      if (this.gen !== gen || this.open !== open) return;
      this.cut = cut;
      this.setLines(lines.length ? lines.map(line => line.length > 4000 ? line.slice(0, 4000) + "… (line truncated)" : line) : ["No text diff available"]);
    }
    this.error = null;
  }

  // Keeps the selection on the same commits, following `@` as it is
  // rewritten. A selected change that was rewritten or is gone clears it.
  useStack(stack) {
    this.stack = stack; this.updated = clock();
    const at = stack.find((c) => c.at);
    const sel = this.sel.map((s) => s.at ? at : stack.find((c) => c.commit === s.commit));
    if (sel.some((c) => !c) || !sel.length) {
      if (this.sel.length) { this.note = "Selected change was rewritten"; this.open = null; this.closed = false; }
      this.sel = at ? [at] : [];
    } else this.sel = sel;
    // A pair runs older to newer: stack order is newest first.
    if (this.sel.length === 2 && stack.indexOf(this.sel[0]) < stack.indexOf(this.sel[1])) this.sel.reverse();
  }

  readFiles({ root, on }, sel) {
    if (!sel.length) return [];
    if (sel.length === 2) return readPair(root, on, sel[0].commit, sel[1].commit, IO);
    if (sel[0].files) return sel[0].files;
    return readChange(root, on, sel[0].commit, IO);
  }

  // Click selects one change, Shift-click adds a second to diff the pair.
  select(change, shift, cx) {
    const pair = shift && this.sel.length && this.sel[0].commit !== change.commit;
    this.sel = pair ? [this.sel[0], change] : [change];
    if (pair && this.stack.indexOf(this.sel[0]) < this.stack.indexOf(this.sel[1])) this.sel.reverse();
    this.gen++; this.files = []; this.open = null; this.closed = false; this.cut = false; this.note = null; this.setLines([]);
    this.request(FILES, cx);
    cx.notify();
  }

  pickJj(path, cx) {
    this.open = this.open === path ? null : path; this.closed = !this.open;
    this.cut = false; this.setLines([]);
    if (this.open) this.request(DIFF, cx);
    cx.notify();
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === root) {
          await watchFolder(root);
          if (this.watched === root && this.mode === "git") this.refresh(cx);
        }
      } catch { this.watched = null; }
    });
  }

  refresh(cx) {
    if (this.loading || this.busy) return;
    const { cwd, on } = location(), context = key();
    if (context !== this.context) {
      this.context = context; this.root = null; this.files = []; this.open = null;
      this.setLines([]); this.message = ""; this.input.set_value(""); this.error = null; this.note = null; this.watched = null; this.closed = false; this.limited = false;
    }
    if (!cwd) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        if (key() !== context) return;
        if (top.code !== 0) { this.root = null; this.files = []; this.setLines([]); this.open = null; this.error = "Not a git repository"; return; }
        const root = top.stdout.trim(), git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
        const status = await git(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]);
        if (status.code !== 0) throw new Error(status.stderr);
        const head = await git(["rev-parse", "--verify", "HEAD"]);
        const stats = {};
        const results = head.code === 0 ? [await git(["diff", "HEAD", "--numstat", "-z", "--no-renames"])] : [await git(["diff", "--cached", "--numstat", "-z", "--no-renames"]), await git(["diff", "--numstat", "-z", "--no-renames"])];
        for (const result of results) {
          if (result.code !== 0) throw new Error(result.stderr);
          for (const entry of result.stdout.split("\0")) {
            const [a, d, ...parts] = entry.split("\t");
            if (!parts.length) continue;
            const path = parts.join("\t"), old = stats[path] ?? { add: 0, del: 0 };
            stats[path] = { add: old.add + (Number(a) || 0), del: old.del + (Number(d) || 0), binary: a === "-" };
          }
        }
        const files = [];
        const entries = status.stdout.split("\0").filter(Boolean);
        for (const entry of entries.slice(0, 1000)) {
          const xy = entry.slice(0, 2), path = entry.slice(3), fresh = xy === "??";
          const conflict = xy.includes("U") || xy === "AA" || xy === "DD";
          const s = conflict ? "U" : xy.includes("D") ? "D" : fresh || xy.includes("A") ? "A" : "M";
          const stat = stats[path] ?? { add: 0, del: 0 };
          files.push({ path, status: s, fresh, ...stat });
        }
        if (key() !== context) return;
        this.root = root; this.on = on; this.hasHead = head.code === 0; this.files = files; this.limited = entries.length > 1000; this.error = null;
        this.watch(root, cx);
        if (this.open && !files.some((f) => f.path === this.open)) { this.open = null; this.setLines([]); }
        // The first file's diff shows until you pick another.
        if (!this.open && !this.closed && files.length) this.open = files[0].path;
        if (this.open) {
          try { await this.load(this.open, context); }
          catch { if (key() === context) this.setLines(["Cannot preview this diff (too large or unreadable)"]); }
        }
      } catch (e) { if (key() === context) this.error = String(e); }
      finally { this.loading = false; cx.notify(); }
    });
  }

  async load(path, context) {
    const file = this.files.find((f) => f.path === path), root = this.root, on = this.on;
    if (!file) return;
    let lines;
    if (file.fresh || (!this.hasHead && file.status === "A")) {
      const text = await readTextFile(`${root}/${path}`, { on }).catch(() => null);
      if (text === null) lines = ["Cannot preview this file (binary, too large, or unreadable)"];
      else if (text.includes("\0")) lines = ["Binary file · no text diff"];
      else {
        file.add = countLines(text);
        lines = [`@@ -0,0 +1,${file.add} @@`, ...text.slice(0, 400000).replace(/\n$/, "").split("\n").slice(0, 1500).map(l => `+${l}`)];
      }
    } else {
      const r = await exec("git", [...READ, "diff", ...(this.hasHead ? ["HEAD"] : []), "--no-ext-diff", "--no-textconv", "--no-color", "--", path], { cwd: root, on });
      if (r.code !== 0) throw new Error(r.stderr);
      const all = r.stdout.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
      lines = first < 0 ? [file.binary ? "Binary file changed" : "No text diff available"] : all.slice(first);
    }
    if (key() === context && this.open === path) this.setLines(lines.slice(0, 1500).map(line => line.length > 4000 ? line.slice(0, 4000) + "… (line truncated)" : line));
  }

  setLines(lines) {
    this.rows = diffRows(lines);
    this.diffWidth = Math.max(300, ...this.rows.map(row => (row.text.length + 1) * 7 + 50));
  }

  pick(path, cx) {
    this.open = this.open === path ? null : path; this.setLines([]); this.note = null;
    this.closed = !this.open;
    const context = this.context;
    if (this.open) cx.spawn(async (cx) => {
      try { await this.load(path, context); }
      catch (e) { if (key() === context && this.open === path) this.note = `Cannot preview this diff (too large or unreadable): ${e}`; }
      cx.notify();
    });
    cx.notify();
  }

  commit(cx) {
    if (!this.message.trim() || !this.root || this.busy || this.loading || this.context !== key()) return;
    const root = this.root, on = this.on, context = this.context, message = this.message.trim();
    this.busy = true; this.note = null;
    cx.spawn(async (cx) => {
      try {
        for (const args of [["add", "-A"], ["commit", "-m", message]]) {
          const r = await exec("git", args, { cwd: root, on });
          if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        }
        if (key() === context) { this.message = ""; this.input.set_value(""); }
      } catch (e) { if (key() === context) this.note = `Commit failed: ${e}`; }
      finally { this.busy = false; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  diffRow({ kind, number, text }, t) {
    if (kind === "@") return div().w_full().px(12).h(20).flex_none().truncate().bg(t.raised).text_color(t.dim).child(text);
    return h_flex().w_full().h(20).flex_none().gap(10).when(kind === "+", (e) => e.bg(t.ansi2 + "18")).when(kind === "-", (e) => e.bg(t.ansi1 + "18"))
      .child(div().w(30).flex_none().text_right().text_color(t.dim).child(number === undefined ? "" : String(number)))
      .child(div().flex_1().min_w(0).truncate().child(text));
  }

  render(cx) {
    const context = key();
    if (context !== this.seen) { this.seen = context; this.last = null; this.route(cx); }
    this.checkShown(cx);
    if (this.mode === "git") return this.renderGit(cx);
    if (this.mode === "jj" || this.mode === "error") return this.renderJj(cx);
    return div();
  }

  // The changed files, of Git's checkout or a jj selection. `pick` opens one.
  fileList(t, empty, pick) {
    // overflow_y_scrollbar() wraps the list, so its flex sizing never reached the panel's layout.
    return div().flex_1().min_h(44).max_h(this.files.length * 28 + 12).relative().border_b(1).border_color(t.border)
        .child(v_flex().id("changes-list").absolute().inset_0().overflow_y_scroll().p(6).children(this.files.map((f) => {
        const parts = f.path.split("/"), name = parts.pop();
        return h_flex().id(`change-${f.path}`).h(28).flex_none().px(8).gap(8).items_center().rounded(7).cursor_pointer().when(this.open === f.path, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).on_click((_e, cx) => pick(f.path, cx))
          .child(div().w(14).text_size(11).text_color(f.status === "A" ? t.ansi2 : f.status === "D" ? t.ansi1 : f.status === "U" ? t.ansi1 : t.blocked).child(f.status))
          .child(h_flex().flex_1().min_w(0).child(div().text_color(t.dim).truncate().child(parts.length ? parts.join("/") + "/" : "")).child(div().max_w(260).min_w(0).truncate().child(name)))
          .when(f.add > 0, (e) => e.child(div().text_size(11).text_color(t.ansi2).child(`+${f.add}`))).when(f.del > 0, (e) => e.child(div().text_size(11).text_color(t.ansi1).child(`−${f.del}`)));
      })).when(!this.files.length, (e) => e.child(div().p(8).text_color(t.dim).child(empty))))
        .child(Scrollbar.vertical("changes-list").absolute().inset_0());
  }

  diffPane(t) {
    return div().flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(11)
        .child(div().id("changes-diff-x").size_full().overflow_x_scrollbar()
          .child(div().w_full().min_w(this.diffWidth).h_full().child(v_virtual_list("changes-diff", this.rows.length, 20, (i) => String(i),
            (range) => this.rows.slice(range.start, range.end).map((row) => this.diffRow(row, t))).size_full())))
        .child(Scrollbar.vertical("changes-diff").viewport_from_layout().absolute().inset_0())
        .when(!this.open && this.files.length > 0, (e) => e.child(div().absolute().top(6).px(12).text_color(t.dim).child("Select a file to view its changes")));
  }

  renderGit(cx) {
    if (key() !== this.context) this.refresh(cx);
    const t = theme(), add = this.files.reduce((n, f) => n + f.add, 0), del = this.files.reduce((n, f) => n + f.del, 0);
    const enabled = Boolean(this.message.trim() && this.root && !this.busy && !this.loading);
    return v_flex().id("changes").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape" && this.typing) { this.typing = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); }
      })
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Changes"))
        .child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(`${this.files.length} files`))
        .child(div().flex_1()).child(div().text_size(11).text_color(t.ansi2).child(`+${add}`)).child(div().text_size(11).text_color(t.ansi1).child(`−${del}`)))
      .child(this.fileList(t, this.error || (this.loading ? "Loading changes…" : this.root ? "No uncommitted changes" : "No folder"), (path, cx) => this.pick(path, cx)))
      .when(this.limited, el => el.child(div().px(12).py(4).text_size(11).text_color(t.dim).child("Showing the first 1,000 changed files")))
      .child(this.diffPane(t))
      .when(Boolean(this.note), (e) => e.child(div().px(10).pb(8).text_size(11).text_color(t.ansi1).child(this.note)))
      .child(h_flex().flex_none().p(10).gap(8).border_t(1).border_color(t.border)
        .child(div().id("commit-message").flex_1().min_w(0).h(32).px(10).flex().items_center().rounded(8).border_1().border_color(this.typing ? t.accent : t.border).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.input).h_full().text_size(12).text_color(t.foreground)))
        .child(div().id("commit").h(32).px(14).flex().items_center().rounded(8).bg(enabled ? t.solid : t.raised).text_color(enabled ? t.solid_foreground : t.dim).text_size(12).when(enabled, (e) => e.cursor_pointer()).on_click((_e, cx) => this.commit(cx)).child(this.busy ? "Committing…" : "Commit")));
  }

  // The stack, newest first. A selected pair is labelled FROM and TO.
  stackRow(c, t) {
    const i = this.sel.findIndex((s) => s.commit === c.commit), pair = this.sel.length === 2;
    return h_flex().id(`stack-${c.commit}`).h(28).flex_none().px(8).gap(8).items_center().rounded(7).cursor_pointer()
      .when(i >= 0, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).on_click((e, cx) => this.select(c, Boolean(e?.modifiers?.shift), cx))
      .when(pair && i >= 0, (e) => e.child(div().w(32).flex_none().text_size(10).text_color(t.accent).child(i === 0 ? "FROM" : "TO")))
      .child(div().flex_none().text_size(11).text_color(c.at ? t.accent : t.dim).child(`${c.at ? "@ " : ""}${c.change.slice(0, 8)}`))
      .child(div().flex_1().min_w(0).truncate().text_color(c.description ? t.foreground : t.dim).child(c.description || "(no description)"))
      .when(c.conflict, (e) => e.child(div().text_size(11).text_color(t.ansi1).child("conflict")))
      .when(c.empty, (e) => e.child(div().text_size(11).text_color(t.dim).child("∅")))
      .when(c.added > 0, (e) => e.child(div().text_size(11).text_color(t.ansi2).child(`+${c.added}`))).when(c.removed > 0, (e) => e.child(div().text_size(11).text_color(t.ansi1).child(`−${c.removed}`)));
  }

  renderJj(cx) {
    const t = theme(), ck = this.ck, pair = this.sel.length === 2, small = (text, color) => div().flex_none().px(12).py(4).text_size(11).text_color(color).child(text);
    const empty = this.error && !this.stack.length ? "" : !this.updated ? "Loading changes…" : pair ? "No differences" : "No changes";
    return v_flex().id("changes").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().min_w(0).truncate().font_semibold().child(ck ? ck.root.split("/").pop() : "Changes"))
        .when(Boolean(this.updated), (e) => e.child(div().flex_none().text_size(11).text_color(t.dim).child(`updated ${this.updated}`)))
        .child(div().flex_1())
        .when(Boolean(ck), (e) => e.child(div().id("changes-refresh").flex_none().h(24).px(8).flex().items_center().rounded(6).text_size(12).text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.request(SNAPSHOT, cx)).child("Refresh"))))
      .when(Boolean(this.error), (e) => e.child(small(this.error, t.ansi1).py(6).border_b(1).border_color(t.border)))
      .when(this.stack.length > 0, (e) => e.child(div().flex_none().h(Math.min(this.stack.length, 6) * 28 + 12).relative().border_b(1).border_color(t.border)
        .child(v_flex().id("changes-stack").absolute().inset_0().overflow_y_scroll().p(6).children(this.stack.map((c) => this.stackRow(c, t))))
        .child(Scrollbar.vertical("changes-stack").absolute().inset_0())))
      .when(this.stack.length >= STACK_LIMIT, (e) => e.child(small(`Showing the newest ${STACK_LIMIT} changes`, t.dim)))
      .when(pair, (e) => e.child(small("Edits made after FROM, up to TO. FROM's own edits are excluded.", t.dim)))
      .when(Boolean(this.note), (e) => e.child(small(this.note, t.blocked)))
      .when(Boolean(ck), (e) => e.child(this.fileList(t, empty, (path, cx) => this.pickJj(path, cx))))
      .when(this.cut, (e) => e.child(small("Diff cut short at 5,000 lines or 1 MiB", t.blocked)))
      .when(Boolean(ck), (e) => e.child(this.diffPane(t)));
  }
}
