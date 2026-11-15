import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea, Popover, Scrollbar, v_virtual_list } from "gpui-base";
import { spaces, panes, focused, terminals, exec, hc, readTextFile, watchFolder, theme, settings, layout, run, shared, setShared } from "herdr";
import { identity, visible, snapshot, readStack, readChange, readPair, readBookmarks, change, squashArgs, filePattern, STACK_LIMIT, DEFAULT_BASE, DEFAULT_ID_LENGTH } from "./jj.js";

const IO = { exec, readTextFile };
// What a jj run does, each step including the ones after it.
const SNAPSHOT = 3, STACK = 2, FILES = 1;
// Workspace root -> the revset its stack starts from, when not DEFAULT_BASE.
const BASES = "jj-changes:bases";
const baseOf = (root) => shared(BASES)?.[root] ?? DEFAULT_BASE;
// A stack row's height: full rows take two lines.
const rowHeight = (full) => (full ? 40 : 28);
// The props of the layout's jj-changes block: `idLength`, the fewest
// characters a change ID shows, and `rows`, "full" or "compact".
function blockProps(node = layout()) {
  const find = (n) => (n?.content?.mod === "jj-changes" ? n : (n?.children ?? []).map(find).find(Boolean));
  return find(node)?.content?.props ?? {};
}

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
// The first argument of a diff pane's argv, which finds the pane again.
const DIFF_MARK = "RANDORI_DIFF=1";
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

// A bookmark on a stack row.
const chip = (name, t) => div().flex_none().max_w(120).truncate().px(4).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(name);

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
    this.baseInput = InputState.new({ placeholder: DEFAULT_BASE });
    this.baseInput.on("change", (_e, cx) => {
      const value = this.baseInput.value();
      if (value === this.baseFilled) return; // the picker's own fill
      this.baseFilled = null; this.baseOwn = value; this.baseText = value.trim();
      this.baseAt = this.baseText && this.baseMatches().length ? 0 : -1;
      cx.notify();
    });
    // Describing a change in place: Enter saves, Shift+Enter adds a line.
    this.describeInput = TextareaState.new({ placeholder: "Describe this change" });
    this.describeInput.set_auto_grow(1, 6);
    this.describeInput.on("submit", (e, cx) => { if (!e?.shift) this.saveDescribe(cx); });
    this.describeInput.on("blur", (_e, cx) => this.endDescribe(cx));
    this.describing = null; this.menuFor = null; this.hovered = null; this.acting = false; this.actError = null;
    // A folder's identity(): jj checkouts and "no jj repo" are kept, other
    // answers only until the folder changes.
    this.ids = {}; this.last = null; this.mode = null;
    this.stack = []; this.sel = []; this.want = 0; this.gen = 0; this.watching = new Set();
    this.hunk = {}; // machine -> Hunk runs there
    this.diffShows = {}; // tab -> commit IDs its Hunk diff pane shows
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
    this.stack = []; this.sel = []; this.files = [];
    this.error = null; this.note = null; this.updated = null; this.gen++;
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
      const props = blockProps(), stack = await readStack(root, on, baseOf(root), props.idLength ?? DEFAULT_ID_LENGTH, IO);
      if (this.ck !== ck) return;
      this.fullRows = props.rows !== "compact";
      this.useStack(stack);
    }
    const gen = this.gen, sel = this.sel;
    if (want >= FILES) {
      const files = await this.readFiles(ck, sel);
      if (this.gen !== gen) return;
      this.files = files.map((f) => ({ path: f.path, status: f.status, add: f.added ?? 0, del: f.removed ?? 0 }));
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
      if (this.sel.length) this.note = "Selected change was rewritten";
      this.sel = at ? [at] : [];
    } else this.sel = sel;
    // A pair runs older to newer: stack order is newest first.
    if (this.sel.length === 2 && stack.indexOf(this.sel[0]) < stack.indexOf(this.sel[1])) this.sel.reverse();
  }

  // Runs one jj edit from a click, one at a time. `args` is the command, or a
  // function that reads what it needs first. The stack rereads after it.
  act(args, cx) {
    const ck = this.ck;
    if (!ck || this.acting) return;
    this.acting = true; this.menuFor = null; this.actError = null;
    cx.spawn(async (cx) => {
      try { await change(ck.root, ck.on, typeof args === "function" ? await args() : args, IO); }
      catch (e) { this.actError = String(e?.message ?? e); }
      finally { this.acting = false; this.request(STACK, cx); cx.notify(); }
    });
    cx.notify();
  }

  squash(c, cx) {
    const { root, on } = this.ck;
    this.act(() => squashArgs(root, on, c, IO), cx);
  }

  startDescribe(c, cx) {
    this.menuFor = null; this.describing = c.commit;
    this.describeInput.set_value((c.text ?? "").trimEnd());
    this.describeInput.focus();
    cx.notify();
  }

  endDescribe(cx) {
    if (!this.describing) return;
    this.describing = null;
    cx.notify();
  }

  saveDescribe(cx) {
    const c = this.stack.find((s) => s.commit === this.describing), text = this.describeInput.value();
    this.endDescribe(cx);
    if (c && text.trim() !== (c.text ?? "").trim()) this.act(["describe", "-r", c.commit, "-m", text], cx);
  }

  // The right-click menu: [label, hint, action]. The base row is where the
  // stack starts, so it only offers its ID.
  menuItems(c, canSquash) {
    const copy = ["Copy change ID", c.change, (cx) => { cx.write_to_clipboard(c.change); this.menuFor = null; cx.notify(); }];
    if (c.base) return [copy];
    return [
      ["Describe", "jj describe", (cx) => this.startDescribe(c, cx)],
      ["New change after", "jj new -A", (cx) => this.act(["new", "--insert-after", c.commit], cx)],
      ...(canSquash ? [["Squash into parent", "jj squash", (cx) => this.squash(c, cx)]] : []),
      ...(c.at ? [] : [["Edit", "jj edit", (cx) => this.act(["edit", c.commit], cx)]]),
      ["Abandon", "jj abandon", (cx) => this.act(["abandon", c.commit], cx)],
      copy,
    ];
  }

  menu(c, t, canSquash) {
    return v_flex().id(`stack-menu-${c.commit}-items`).w(220).p(5).rounded(8).border_1().border_color(t.border).bg(t.popover).shadow_lg().text_size(12.8)
      .children(this.menuItems(c, canSquash).map(([label, hint, action], n) => h_flex().id(`stack-menu-${c.commit}-${n}`).h(29).px(8).gap(9).rounded(6).items_center().cursor_pointer()
        .hover((s) => s.bg(t.hover)).on_click((_e, cx) => action(cx))
        .child(div().flex_1().child(label)).child(div().flex_none().text_size(11).text_color(t.dim).child(hint))));
  }

  readFiles({ root, on }, sel) {
    if (!sel.length) return [];
    if (sel.length === 2) return readPair(root, on, sel[0].commit, sel[1].commit, IO);
    if (sel[0].files) return sel[0].files;
    return readChange(root, on, sel[0].commit, IO);
  }

  // An empty base returns the workspace to DEFAULT_BASE. The selection starts
  // over at `@`, since the old one may not be in the new stack.
  setBase(text, cx) {
    const root = this.ck?.root, base = text.trim(), bases = { ...(shared(BASES) ?? {}) };
    this.editingBase = false;
    if (!root) return;
    if (!base || base === DEFAULT_BASE) delete bases[root]; else bases[root] = base;
    setShared(BASES, bases);
    this.sel = []; this.files = []; this.note = null; this.gen++;
    this.request(STACK, cx);
    cx.notify();
  }

  // The base picker: an input over the newest bookmarks, filtered by what is
  // typed. The chip toggles it.
  editBase(cx) {
    this.editingBase = !this.editingBase;
    if (!this.editingBase) return cx.notify();
    const { root, on } = this.ck, base = baseOf(root);
    this.baseText = ""; this.baseOwn = base; this.baseFilled = base; this.baseAt = -1; this.baseNames = null; this.baseError = null;
    this.baseInput.set_value(base);
    this.baseInput.set_selected_range({ start: 0, end: base.length });
    this.baseInput.focus();
    cx.spawn(async (cx) => {
      try { this.baseNames = await readBookmarks(root, on, IO); }
      catch (e) { this.baseNames = []; this.baseError = String(e?.message ?? e); }
      cx.notify();
    });
    cx.notify();
  }

  baseMatches() {
    const text = this.baseText.toLowerCase();
    return (this.baseNames ?? []).filter((n) => !text || n.toLowerCase().includes(text));
  }

  // As in a browser's address bar: ↑ and ↓ put the highlighted bookmark in
  // the input to apply or edit, and past either end put back what was typed.
  // The first match typing highlights is filled before either key moves on.
  // Escape puts back what was typed, then closes. Enter takes the highlighted
  // bookmark, else the input's text.
  baseKey(e, cx) {
    const shown = this.baseMatches(), n = shown.length;
    if (e.key === "escape" && this.baseInput.value() !== this.baseOwn) this.fillBase(-1, shown);
    else if (e.key === "escape") this.editingBase = false;
    else if (e.key === "enter") return this.setBase(this.baseAt >= 0 ? shown[this.baseAt] : this.baseInput.value(), cx);
    else if ((e.key === "down" || e.key === "up") && this.baseAt >= 0 && this.baseInput.value() !== shown[this.baseAt]) this.fillBase(this.baseAt, shown);
    else if (e.key === "down" && n) this.fillBase(this.baseAt + 1 < n ? this.baseAt + 1 : -1, shown);
    else if (e.key === "up" && n) this.fillBase(this.baseAt > -1 ? this.baseAt - 1 : n - 1, shown);
    else return;
    cx.stop_propagation();
    cx.notify();
  }

  // Highlights row `i` and shows it in the input, or with -1 what was typed.
  fillBase(i, shown) {
    const text = i >= 0 ? shown[i] : this.baseOwn;
    this.baseAt = i; this.baseFilled = text;
    this.baseInput.set_value(text);
    this.baseInput.set_selected_range({ start: text.length, end: text.length });
  }

  // Click selects one change, Shift-click adds a second to diff the pair.
  select(change, shift, cx) {
    const pair = shift && this.sel.length && this.sel[0].commit !== change.commit;
    this.sel = pair ? [this.sel[0], change] : [change];
    if (pair && this.stack.indexOf(this.sel[0]) < this.stack.indexOf(this.sel[1])) this.sel.reverse();
    this.gen++; this.files = []; this.note = null;
    this.request(FILES, cx);
    cx.notify();
  }

  // The selection's diff in the active tab's diff pane. Hunk, where it runs,
  // shows the whole selection for its comments and moves to a clicked file;
  // jj diff in less shows only that file. A live Hunk pane reloads when it
  // shows other commits and otherwise only moves. Any other first splits
  // right of the focused pane, or replaces the old pane. pane.split runs the
  // argv with no shell after it, so q closes the pane.
  openDiff(path, cx) {
    const { root, on } = this.ck ?? {}, sel = this.sel;
    if (!root || !sel.length) return;
    const ids = sel.map((c) => c.change), commits = sel.map((c) => c.commit).join(" ");
    const tab = focused()?.tab;
    cx.spawn(async () => {
      this.hunk[on] ??= await exec("hunk", ["--version"], { on }).then((r) => r.code === 0, () => false);
      const old = panes().find((p) => p.tab === tab && p.terminal && terminals().some((t) => t.address === p.terminal && t.argv?.[1] === DIFF_MARK));
      let argv;
      if (this.hunk[on]) {
        const args = ids.length === 2 ? ["diff", ...ids] : ["show", ids[0]];
        const session = old && await this.hunkSession(old.terminal, on);
        const shown = session && (this.diffShows[tab] === commits
          || (await exec("hunk", ["session", "reload", session, "--source", root, "--", ...args], { on })).code === 0);
        this.diffShows[tab] = commits;
        if (shown) {
          if (path) await exec("hunk", ["session", "navigate", session, "--file", path, "--hunk", "1"], { on });
          return run("pane.focus", { terminal: old.terminal });
        }
        argv = ["hunk", ...args];
      } else {
        // less without -F, so a short diff stays until q.
        argv = ["jj", "--config", "ui.pager=less -R", "diff", ...(ids.length === 2 ? ["--from", ids[0], "--to", ids[1]] : ["-r", ids[0]]), ...(path ? ["--", filePattern(path)] : [])];
      }
      // pane.split takes no folder: sh changes to the checkout and becomes the program.
      run("pane.split", { direction: "right", ...(old && { pane: old.pane }), argv: ["env", DIFF_MARK, "sh", "-c", 'cd "$0" && exec "$@"', root, ...argv] });
      if (old) run("terminal.kill", { terminal: old.terminal });
    });
  }

  // The ID of the Hunk session in terminal `address`, found by its pid. Null
  // when no window has that pid, as when a wrapper started Hunk as a child.
  async hunkSession(address, on) {
    const got = await hc(["get", address, "--json"]);
    const list = got.code === 0 ? await exec("hunk", ["session", "list", "--json"], { on }) : null;
    if (list?.code !== 0) return null;
    const pid = JSON.parse(got.stdout).pid;
    return JSON.parse(list.stdout).sessions.find((s) => s.pid === pid)?.sessionId ?? null;
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

  basePicker(t) {
    const shown = this.baseMatches();
    const empty = this.baseError ?? (this.baseNames === null ? "Loading bookmarks…" : !shown.length ? (this.baseText ? "Enter uses the typed revset" : "No bookmarks") : null);
    return v_flex().id("changes-base-picker").flex_none().p(8).gap(2).border_b(1).border_color(t.border).on_key_down((e, cx) => this.baseKey(e, cx))
      .child(h_flex().gap(8).items_center()
        .child(div().flex_none().text_size(11).text_color(t.dim).child("Base"))
        .child(div().id("changes-base-input").flex_1().min_w(0).h(28).px(8).flex().items_center().rounded(6).border_1().border_color(t.accent).cursor_text().child(Input.new(this.baseInput).h_full().text_size(12).text_color(t.foreground))))
      .children(shown.map((name, i) => div().id(`changes-base-${name}`).h(24).flex_none().px(8).flex().items_center().rounded(6).truncate().text_size(12).cursor_pointer()
        .when(i === this.baseAt, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.setBase(name, cx)).child(name)))
      .when(Boolean(empty), (e) => e.child(div().px(8).py(4).text_size(11).text_color(this.baseError ? t.ansi1 : t.dim).child(empty)))
      .child(div().px(8).pt(2).text_size(10).text_color(t.dim).child("↑↓ to pick and edit | Enter to apply | <empty> for trunk()"));
  }

  // The stack, newest first, ending with the change it starts from, marked
  // base. A selected pair is labelled FROM and TO. `full` rows put the
  // description under the ID, bookmarks and counts, with a line between rows.
  // Hovering a row shows + (jj new -A) and ↓ (jj squash), right-clicking
  // opens its menu, and double-clicking its description edits it.
  stackRow(c, t, full, canSquash) {
    const i = this.sel.findIndex((s) => s.commit === c.commit), pair = this.sel.length === 2, editing = this.describing === c.commit;
    const description = div().flex_1().min_w(0).truncate().text_color(c.description && !c.base ? t.foreground : t.dim).child(c.description || "(no description)")
      .when(!c.base, (e) => e.on_mouse_down("left", (ev, cx) => { if (ev.click_count === 2) this.startDescribe(c, cx); }));
    const button = (id, label, tip, action) => div().id(`stack-${c.commit}-${id}`).flex_none().size(20).flex().items_center().justify_center().rounded(5).text_size(13).text_color(t.muted).cursor_pointer()
      .hover((s) => s.bg(t.raised).text_color(t.foreground)).tooltip(tip)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => { cx.stop_propagation(); action(cx); }).child(label);
    const buttons = h_flex().flex_none().gap(2).when(this.hovered !== c.commit || this.acting, (e) => e.invisible())
      .child(button("new", "+", "New change after this one, and edit it (jj new -A)", (cx) => this.act(["new", "--insert-after", c.commit], cx)))
      .when(canSquash, (e) => e.child(button("squash", "↓", "Squash into its parent (jj squash)", (cx) => this.squash(c, cx))));
    const editor = v_flex().w_full().gap(4).pt(4).pl(pair && i >= 0 ? 40 : 0)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => cx.stop_propagation())
      .on_key_down((e, cx) => { if (e.key === "escape") this.endDescribe(cx); })
      .child(Textarea.new(this.describeInput).w_full())
      .child(div().text_size(10).text_color(t.dim).child("Enter saves, Shift+Enter adds a line, Esc cancels"));
    const top = h_flex().w_full().flex_none().gap(8).items_center()
      .when(pair && i >= 0, (e) => e.child(div().w(32).flex_none().text_size(10).text_color(t.accent).child(i === 0 ? "FROM" : "TO")))
      .child(h_flex().flex_none().text_size(11).text_color(t.dim).when(c.at, (e) => e.child(div().text_color(t.accent).child("@ ")))
        .child(div().text_color(t.ansi5).child(c.prefix)).child(c.change.slice(c.prefix.length)))
      .children(c.bookmarks.slice(0, 2).map((b) => chip(b, t)))
      .when(c.bookmarks.length > 2, (e) => e.child(chip(`+${c.bookmarks.length - 2}`, t)))
      .child(full ? div().flex_1() : description)
      .when(c.base, (e) => e.child(div().flex_none().text_size(10).text_color(t.dim).child("base")))
      .when(c.conflict, (e) => e.child(div().text_size(11).text_color(t.ansi1).child("conflict")))
      .when(c.empty, (e) => e.child(div().text_size(11).text_color(t.dim).child("∅")))
      .when(c.count > 0, (e) => e.child(div().text_size(11).font_bold().text_color(t.working).child(`~${c.count}`)))
      .when(c.added > 0, (e) => e.child(div().text_size(11).text_color(t.ansi2).child(`+${c.added}`))).when(c.removed > 0, (e) => e.child(div().text_size(11).text_color(t.ansi1).child(`−${c.removed}`)))
      .when(!full && !c.base, (e) => e.child(buttons));
    const row = v_flex().id(`stack-${c.commit}`).flex_none().px(8).justify_center().rounded(7).cursor_pointer()
      .when(editing, (e) => e.py(6)).when(!editing, (e) => e.h(rowHeight(full)))
      .when(i >= 0, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).on_click((e, cx) => this.select(c, Boolean(e?.modifiers?.shift), cx))
      .on_hover((hovered, cx) => { if (hovered) this.hovered = c.commit; else if (this.hovered === c.commit) this.hovered = null; cx.notify(); })
      .child(top)
      .when(full && !editing, (e) => e.child(h_flex().w_full().gap(8).items_center().pl(pair && i >= 0 ? 40 : 0).child(description).when(!c.base, (e) => e.child(buttons))))
      .when(editing, (e) => e.child(editor));
    const open = this.menuFor === c.commit;
    return Popover.new(`stack-menu-${c.commit}`).mouse_button("right").open(open)
      .on_open_change((value, cx) => { this.menuFor = value ? c.commit : null; cx.notify(); })
      .trigger(row).when(open, (e) => e.content(this.menu(c, t, canSquash)));
  }

  renderJj(cx) {
    const t = theme(), ck = this.ck, pair = this.sel.length === 2, small = (text, color) => div().flex_none().px(12).py(4).text_size(11).text_color(color).child(text);
    const empty = this.error && !this.stack.length ? "" : !this.updated ? "Loading changes…" : pair ? "No differences" : "No changes";
    return v_flex().id("changes").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().min_w(0).truncate().font_semibold().child(ck ? ck.root.split("/").pop() : "Changes"))
        .when(Boolean(ck), (e) => e.child(div().id("changes-base").flex_none().max_w(160).truncate().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover)).tooltip("The stack starts after this revset. Click to change it").on_click((_e, cx) => this.editBase(cx)).child(baseOf(ck.root))))
        .when(Boolean(this.updated), (e) => e.child(div().flex_none().text_size(11).text_color(t.dim).child(`updated ${this.updated}`)))
        .child(div().flex_1())
        .child(div().id("changes-new").flex_none().h(24).px(8).flex().items_center().rounded(6).border_1().border_color(t.border).text_size(13).text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover)).tooltip("New change on top of @ (jj new)").on_click((_e, cx) => this.act(["new"], cx)).child("+"))
        .when(this.sel.length > 0, (e) => e.child(div().id("changes-open").flex_none().h(24).px(8).flex().items_center().rounded(6).border_1().border_color(t.border).text_size(12).text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.openDiff(null, cx)).child("diff")))
        .when(Boolean(ck), (e) => e.child(div().id("changes-refresh").flex_none().h(24).px(6).flex().items_center().rounded(6).border_1().border_color(t.border).text_size(12).text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover)).tooltip("Refresh").on_click((_e, cx) => this.request(SNAPSHOT, cx)).child(svg("mods/jj-changes/refresh.svg").size(14).text_color(t.muted)))))
      .when(Boolean(this.editingBase), (e) => e.child(this.basePicker(t)))
      .when(Boolean(this.error), (e) => e.child(small(this.error, t.ansi1).py(6).border_b(1).border_color(t.border)))
      .when(Boolean(this.actError), (e) => e.child(small(this.actError, t.ansi1).py(6).border_b(1).border_color(t.border)))
      .when(this.stack.length > 0, (e) => e.child(div().flex_none().h(Math.min(this.stack.length, 6) * (rowHeight(this.fullRows) + (this.fullRows ? 1 : 0)) + 12 + (this.describing ? 96 : 0)).relative().border_b(1).border_color(t.border)
        .child(v_flex().id("changes-stack").absolute().inset_0().overflow_y_scroll().p(6).children(this.stack.flatMap((c, n) => [...(this.fullRows && n ? [div().flex_none().h(1).mx(8).bg(t.border)] : []), this.stackRow(c, t, this.fullRows, !c.base && !this.stack[n + 1]?.base)])))
        .child(Scrollbar.vertical("changes-stack").absolute().inset_0())))
      .when(this.stack.length >= STACK_LIMIT, (e) => e.child(small(`Showing the newest ${STACK_LIMIT} changes`, t.dim)))
      .when(pair, (e) => e.child(small("Edits made after FROM, up to TO. FROM's own edits are excluded.", t.dim)))
      .when(Boolean(this.note), (e) => e.child(small(this.note, t.blocked)))
      .when(Boolean(ck), (e) => e.child(this.fileList(t, empty, (path, cx) => this.openDiff(path, cx))));
  }
}
