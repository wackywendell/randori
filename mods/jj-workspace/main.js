// jj workspace dialog and Finish window:
// { space, folder, action?: "finish", tab, argv, overlay }.
//
// The workspace dialog shows one filter-first list of workspaces grouped by
// repository, with an inline "+ New" row per repository and lazy expansion to
// other spaces. Enter opens the highlighted workspace or creates from the
// repository's main checkout; Shift+Enter opens a new tab in the target space
// when on the same machine. Finish runs in a separate 520x360 window.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, ScrollHandle, Scrollbar, Checkbox } from "gpui-base";
import { run, props, closeOverlay, theme, spaces, panes, terminals, exec, home, readTextFile, layout, notify, focused } from "herdr";
import { identity } from "./jj.js";

const IO = { exec, readTextFile };

// Where a space is now: its first terminal's live folder, else where it was made.
function place(s, all = panes()) {
  if (!s) return null;
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return all.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder || null;
}

// Unique folders in a space: pane folders in tab order, then space.folder.
function folders(s, all = panes()) {
  if (!s) return [];
  const out = [];
  const seen = new Set();
  const add = (dir) => { if (dir && !seen.has(dir)) { seen.add(dir); out.push(dir); } };
  for (const c of s.tabs ?? []) {
    for (const p of all) if (p.tab === c.id && p.cwd) add(p.cwd);
  }
  add(s.folder);
  return out;
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

// Human label for a tab, handling live TabInfo (named: false, name: "2", index: 2)
// as well as minimal test fixtures without name/named/index.
function tabLabel(tab, index) {
  return tab?.named !== false && tab?.name && !/^(tb)?\d+$/.test(tab.name) ? tab.name : `tab ${tab?.index ?? index + 1}`;
}

// Where a checkout is open across every terminal pane on `on`.
// Deepest known checkout wins. Prefers a dedicated space (whose first terminal
// is in `path`), else the first matching tab in any space on `on`.
function whereOpen(path, all, on, spaceList, paneList) {
  if (!path) return null;
  const matches = (at) => {
    if (!at || !inside(at, path)) return false;
    return !all.some((c) => c.path && c.path !== path && c.path.length > path.length && inside(at, c.path));
  };
  const onSpaces = spaceList.filter((s) => (s.machine ?? null) === (on ?? null));
  for (const s of onSpaces) {
    if (matches(place(s, paneList))) return { space: s, tab: null, dedicated: true };
  }
  for (const s of onSpaces) {
    for (const c of s.tabs ?? []) {
      if (paneList.some((p) => p.tab === c.id && p.cwd && matches(p.cwd))) return { space: s, tab: c, dedicated: false };
    }
  }
  return null;
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
    this.p = props() ?? {};
    const s = this.space();
    this.spaceId = s?.id ?? null;
    this.spaceMachine = s?.machine ?? null;
    this.spaceName = s?.name ?? "";
    this.on = this.spaceMachine;
    this.homes = { "": home() };
    this.homeTasks = new Map();
    this.userHome = this.on ? null : this.homes[""];
    this.finishing = this.p.action === "finish";
    this.rows = []; // finish: { name, root, main, repoName, checked, removed, error }
    this.multiRepo = false;
    this.confirmed = new Set();
    this.repos = []; // { key, name, main, checkout, on, other, list, names, error }
    this.probed = new Set();
    this.focusKey = null;
    this.focusRoot = null;
    this.ready = false;
    this.expanded = false;
    this.expanding = false;
    this.submitted = false;
    this.text = "";
    this.at = 0;
    this.scroll = ScrollHandle.new();
    this.input = InputState.new({ value: this.text, placeholder: "Name" });
    this.input.on("change", (_e, cx) => {
      this.text = this.input.value();
      this.error = "";
      this.at = 0;
      this.scrollCurrent();
      cx.notify();
    });
    this.input.on("submit", (e, cx) => {
      // Prevent the same Enter keydown from double-firing on #worktree's on_key_down.
      this.submitted = true;
      Promise.resolve().then(() => { this.submitted = false; });
      this.enter(cx, Boolean(e?.shift));
    });
    this.inputFocused = true;
    this.input.on("focus", (_e, cx) => { this.inputFocused = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.inputFocused = false; cx.notify(); });
    this.handle = cx.focus_handle();
    this.handle.focus();
    if (!this.finishing) this.input.focus();
    this.busy = false;
    this.error = "";
    this.repo = undefined; // finish: undefined loading, null error, { main, name } ready
    this.folder = this.focusFolder(s) || this.userHome;

    cx.spawn(async (cx) => {
      try {
        if (this.finishing) {
          if (this.on) this.userHome = await this.homeOf(this.on);
          this.folder = this.focusFolder(s) || this.userHome;
          this.repo = await this.prepare();
          this.confirmed = this.affectedTerminals(this.rows.filter((r) => r.checked && !r.removed).map((r) => r.root)).addresses;
          return;
        }
        const focusDir = this.focusFolder(s);
        this.folder = focusDir || (this.on ? await this.homeOf(this.on) : this.homes[""]);
        const targetList = s ? [s] : [];
        await this.probe(targetList, false, focusDir, cx);
        this.at = this.initialIndex();
        this.scrollCurrent();
        this.handle.focus();
        cx.timer.after(100, () => this.input.focus());
      } catch (error) {
        console.log(`jj-workspace: ${error?.message ?? error}`);
        if (this.finishing) this.repo = null;
        this.error = String(error?.message ?? error);
      } finally {
        this.ready = true;
        cx.notify();
      }
    });
  }

  space() {
    const p = this.p ?? props() ?? {};
    const list = spaces();
    if (p.space) return list.find((s) => s.id === p.space) ?? (p.folder ? { folder: p.folder, machine: p.machine ?? null, name: "" } : undefined);
    const f = focused();
    return list.find((s) => s.id === f?.space) ?? list.find((s) => s.active) ?? (p.folder ? { folder: p.folder, machine: p.machine ?? null, name: "" } : undefined);
  }

  focusFolder(s) {
    const p = this.p ?? props() ?? {};
    if (p.folder) return p.folder;
    if (!s) return null;
    const tabs = new Set((s.tabs ?? []).map((c) => c.id));
    const all = panes();
    const f = focused();
    const fp = (f?.pane && all.find((x) => x.pane === f.pane && tabs.has(x.tab))) || all.find((x) => tabs.has(x.tab) && x.focused);
    return fp?.cwd || place(s, all);
  }

  async homeOf(on) {
    const k = on ?? "";
    if (k in this.homes) return this.homes[k];
    if (this.homeTasks.has(k)) return this.homeTasks.get(k);
    const task = (async () => {
      const result = await exec("sh", ["-c", 'printf %s "$HOME"'], { on });
      if (result.code !== 0 || !result.stdout.trim()) throw new Error(`Could not find the remote home folder on ${on}.`);
      this.homes[k] = result.stdout.trim();
      return this.homes[k];
    })();
    this.homeTasks.set(k, task);
    try { return await task; }
    finally { this.homeTasks.delete(k); }
  }

  others() {
    return spaces().filter((s) => s.id !== this.spaceId);
  }

  // Loads home, workspaces, and bookmarks for one discovered repository.
  async loadRepo(r, cx) {
    try {
      const [_, list, names] = await Promise.all([
        this.homeOf(r.on),
        workspaces({ root: r.checkout, main: r.main }, r.on),
        bookmarks({ root: r.checkout, main: r.main }, r.on),
      ]);
      r.list = list;
      r.names = names;
    } catch (error) {
      r.list = [];
      r.names = new Set();
      r.error = String(error?.message ?? error);
      console.log(`jj-workspace: ${r.name}: ${r.error}`);
    }
    cx?.notify();
  }

  // Probes unique (folder, machine) pairs in tab order, deduplicating repos.
  // When `other` is true, settles and notifies per folder/repo so a slow remote
  // machine does not stall reachable local spaces.
  async probe(spaceList, other, focusDir, cx) {
    const paneList = panes();
    const pairs = [];
    const batchSeen = new Set();
    const enqueue = (folder, on) => {
      if (!folder) return;
      const pk = `${on ?? ""}\0${folder}`;
      if (this.probed.has(pk) || batchSeen.has(pk)) return;
      batchSeen.add(pk);
      this.probed.add(pk);
      pairs.push({ folder, on: on ?? null });
    };
    for (const s of spaceList) {
      const on = s.machine ?? null;
      for (const dir of folders(s, paneList)) enqueue(dir, on);
    }
    if (!other && focusDir) enqueue(focusDir, this.spaceMachine);
    if (!pairs.length) return;

    const addFromId = (folder, on, id) => {
      if (id.error) {
        if (!this.error) this.error = id.message;
        return null;
      }
      if (!id.jj || !id.main) return null;
      const key = `${on ?? ""}\0${id.main}`;
      let r = this.repos.find((x) => x.key === key);
      if (!r) {
        r = { key, name: base(id.main), main: id.main, checkout: id.root, on, other, list: undefined, names: undefined, error: "" };
        this.repos.push(r);
        if (!other && folder === focusDir) { this.focusKey = key; this.focusRoot = id.root; }
        return r;
      }
      if (!other && folder === focusDir) {
        r.checkout = id.root;
        this.focusKey = key;
        this.focusRoot = id.root;
      }
      return null;
    };

    if (!other) {
      const ids = await Promise.all(pairs.map(async ({ folder, on }) => ({ folder, on, id: await identity(folder, on, IO) })));
      const added = [];
      for (const { folder, on, id } of ids) {
        const r = addFromId(folder, on, id);
        if (r) added.push(r);
      }
      await Promise.all(added.map((r) => this.loadRepo(r)));
      return;
    }

    await Promise.allSettled(pairs.map(async ({ folder, on }) => {
      const id = await identity(folder, on, IO);
      const r = addFromId(folder, on, id);
      if (r) {
        cx?.notify();
        await this.loadRepo(r, cx);
      } else if (id.error) {
        cx?.notify();
      }
    }));
  }

  expand(cx) {
    if (this.expanded || this.expanding) return;
    const before = this.repos.length;
    this.expanding = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await this.probe(this.others(), true, null, cx);
      } catch (error) {
        console.log(`jj-workspace: ${error?.message ?? error}`);
        if (!this.error) this.error = String(error?.message ?? error);
      } finally {
        this.expanding = false;
        this.expanded = true;
        const p = this.picks();
        if (this.repos.length > before) {
          const firstNew = this.repos[before];
          const idx = p.findIndex((e) => e.repo?.key === firstNew.key);
          this.at = idx >= 0 ? idx : Math.min(this.at, Math.max(0, p.length - 1));
          this.scrollCurrent();
        } else {
          this.at = Math.min(this.at, Math.max(0, p.length - 1));
        }
        cx.notify();
        this.input.focus();
      }
    });
  }

  close() {
    closeOverlay((this.p ?? props())?.overlay);
  }

  selectedRepo() {
    return this.current()?.repo ?? this.repos.find((r) => r.key === this.focusKey) ?? this.repos[0] ?? null;
  }

  canTab(r) {
    return Boolean(r && this.spaceId) && (r.on ?? null) === (this.spaceMachine ?? null);
  }

  existing(r, name = this.text.trim()) {
    if (!r || !name || !r.list) return null;
    return r.list.find((w) => w.name === name) ?? null;
  }

  items() {
    const out = [];
    const localRepos = this.repos.filter((r) => !r.other);
    const otherRepos = this.repos.filter((r) => r.other);
    const otherCount = this.others().length;
    const trimmed = this.text.trim();
    const f = trimmed.toLowerCase();
    const showHeaders = this.repos.length > 1 || this.expanded;

    const appendGroup = (group, divider) => {
      const entries = [];
      for (const r of group) {
        const ws = (r.list ?? []).filter((w) => !f || `${r.name} ${w.name} ${w.path}`.toLowerCase().includes(f));
        const showCreate = !r.error && r.names !== undefined && !this.existing(r, trimmed);
        if (!ws.length && !showCreate && !r.error && r.list !== undefined) continue;
        if (showHeaders) entries.push({ kind: "header", repo: r });
        if (r.error) entries.push({ kind: "repo-error", repo: r });
        else if (r.list === undefined) entries.push({ kind: "repo-loading", repo: r });
        for (const w of ws) entries.push({ kind: "ws", key: `${r.key}\0${w.name}`, repo: r, ws: w, pick: true });
        if (showCreate) entries.push({ kind: "create", key: `${r.key}\0+new`, repo: r, pick: true });
      }
      if (entries.length) {
        if (divider) out.push({ kind: "divider", label: divider });
        out.push(...entries);
      }
    };

    appendGroup(localRepos, null);
    appendGroup(otherRepos, "Other spaces");
    if (this.expanding) out.push({ kind: "looking" });
    else if (!this.expanded && otherCount > 0) out.push({ kind: "more", count: otherCount, pick: true });
    return out;
  }

  picks(list = this.items()) {
    return list.filter((e) => e.pick);
  }

  // Initial selection: prefer the first available workspace in the focused repo
  // that isn't the checkout we're already sitting in, else any other workspace,
  // else the focused repo's "+ New" row, else 0.
  initialIndex() {
    const p = this.picks();
    if (!p.length) return 0;
    const isOtherWs = (e) => e.kind === "ws" && Boolean(e.ws.path) && (!this.focusRoot || e.ws.path !== this.focusRoot);
    if (this.focusKey) {
      const i = p.findIndex((e) => e.repo?.key === this.focusKey && isOtherWs(e));
      if (i >= 0) return i;
    }
    const anyOther = p.findIndex(isOtherWs);
    if (anyOther >= 0) return anyOther;
    if (this.focusKey) {
      const c = p.findIndex((e) => e.kind === "create" && e.repo?.key === this.focusKey);
      if (c >= 0) return c;
    }
    return 0;
  }

  current() {
    const p = this.picks();
    if (p.length) return p[Math.min(this.at, p.length - 1)];
    return undefined;
  }

  scrollCurrent() {
    const list = this.items();
    const picks = this.picks(list);
    if (!picks.length) return;
    const cur = picks[Math.min(this.at, picks.length - 1)];
    const idx = list.indexOf(cur);
    if (idx >= 0) this.scroll.scroll_to_item(idx);
  }

  move(delta) {
    const p = this.picks();
    if (!p.length) return;
    this.at = (Math.min(this.at, p.length - 1) + delta + p.length) % p.length;
    this.scrollCurrent();
  }

  // The folder and start of the workspace a name would make.
  planned(r = this.selectedRepo(), name = this.text.trim()) {
    if (typeof r === "string") { name = r; r = this.selectedRepo(); }
    if (!r) return null;
    const userHome = this.homes[r.on ?? ""] ?? "";
    const directory = settings().directory.replaceAll("{repo}", r.name).replaceAll("{name}", slug(name));
    return { name, path: untilde(directory, userHome), bookmark: Boolean(r.names?.has(name)) };
  }

  previewPath(r, name = this.text.trim()) {
    const userHome = this.homes[r.on ?? ""] ?? "";
    const directory = settings().directory.replaceAll("{repo}", r.name).replaceAll("{name}", slug(name) || "\u2026");
    return tilde(untilde(directory, userHome), userHome);
  }

  enter(cx, asTab = false) {
    if (this.busy) return;
    const cur = this.current();
    if (!cur) return;
    if (cur.kind === "more") return this.expand(cx);
    if (cur.kind === "ws") return this.open(cur.ws, cur.repo, asTab, cx);
    if (cur.kind === "create") {
      if (!this.text.trim()) { this.input.focus(); return; }
      cx.spawn(async (cx) => this.work(cur.repo, cx, asTab));
    }
  }

  async work(r = this.selectedRepo(), cx, asTab = false) {
    if (r && typeof r.notify === "function") { asTab = Boolean(cx); cx = r; r = this.selectedRepo(); }
    if (this.busy || !r) return;
    if (asTab && !this.canTab(r)) {
      this.error = `Tabs in this space cannot open a workspace on ${r.on}. Press Enter for a new space.`;
      cx.notify();
      return;
    }
    this.busy = true;
    this.error = "";
    cx.notify();
    try { this.error = await this.create(r, asTab); }
    catch (error) { this.error = String(error?.message ?? error); }
    if (this.error) console.log(`jj-workspace: ${this.error}`);
    this.busy = false;
    if (!this.error) this.close();
    cx.notify();
  }

  async create(r, asTab = false) {
    const { name, path, bookmark } = this.planned(r);
    if (!name) return "Type a jj workspace name.";
    const { links, miseTrust } = settings();
    const add = ["workspace", "add", "--name", name, ...(bookmark ? ["-r", JSON.stringify(name)] : []), path];
    // jj workspace add makes only the last folder of the path. Run from the main
    // checkout so new workspaces start from the main repo's @- rather than a
    // stacked linked workspace.
    if (!(await ok("mkdir", ["-p", parent(path)], r.on))) return `Could not make ${parent(path)}.`;
    const res = await jj(r.main, add, r.on, 600_000);
    if (!res.ok) return res.err || "jj workspace add failed.";
    const problems = [];
    const linked = [];
    for (const rel of links) {
      const source = `${r.main}/${rel}`, target = `${path}/${rel}`;
      if (!(await ok("test", ["-e", source], r.on))) { problems.push(`${rel}: not in the main checkout`); continue; }
      if ((await ok("test", ["-e", target], r.on)) || (await ok("test", ["-L", target], r.on))) { problems.push(`${rel}: already in the new checkout`); continue; }
      if (!(await ok("mkdir", ["-p", parent(target)], r.on)) || !(await ok("ln", ["-s", source, target], r.on))) { problems.push(`${rel}: could not link`); continue; }
      linked.push(rel);
    }
    const trust = linked.filter(miseFile);
    if (miseTrust && trust.length && (await ok("mise", ["--version"], r.on))) {
      for (const rel of trust) if (!(await ok("mise", ["trust", `${path}/${rel}`], r.on))) problems.push(`${rel}: mise trust failed`);
    }
    if (problems.length) {
      console.log(`jj-workspace: ${problems.join("; ")}`);
      notify({ title: "New jj workspace", body: problems.join("\n"), level: "warning" });
    }
    const p = this.p ?? props() ?? {};
    if (asTab) {
      run("tab.new", { space: this.spaceId, folder: path, name, ...(p.argv ? { argv: p.argv } : {}) });
    } else {
      // Leave spaces unnamed so they follow the checkout folder and nest under the repo.
      run("space.new", { folder: path, machine: r.on ?? "", ...(p.tab !== undefined ? { tab: p.tab } : {}), ...(p.argv !== undefined ? { argv: p.argv } : {}) });
    }
    return "";
  }

  open(w, r, asTab = false, cx) {
    if (!w?.path || !r) return;
    if (asTab) {
      if (!this.canTab(r)) {
        this.error = `Tabs in this space cannot open a workspace on ${r.on}. Press Enter for a new space.`;
        cx?.notify();
        return;
      }
      const p = this.p ?? props() ?? {};
      this.close();
      run("tab.new", { space: this.spaceId, folder: w.path, name: w.main ? r.name : w.name, ...(p.argv ? { argv: p.argv } : {}) });
      return;
    }
    this.close();
    const found = whereOpen(w.path, r.list ?? [], r.on, spaces(), panes());
    if (found) {
      run("space.select", { id: found.space.id });
      if (!found.dedicated && found.tab) run("tab.select", { id: found.tab.id });
    } else {
      run("space.new", { folder: w.path, machine: r.on ?? "" });
    }
  }

  // Finish: linked workspaces in the clicked tab (when props().tab is set) or
  // across the whole space (sidebar right-click), supporting multiple repos.
  async prepare() {
    const s = this.space();
    if (!s?.id) throw new Error("The space is gone.");
    this.spaceId = s.id;
    const p = this.p ?? props() ?? {};
    const all = panes();
    const tabs = s.tabs ?? [];
    const activeTab = tabs.find((c) => c.active) ?? (tabs.every((c) => c.active === undefined) ? tabs[0] : null);
    const targetTabId = p.tab || activeTab?.id || null;
    const scopeTabs = p.tab ? tabs.filter((c) => c.id === p.tab) : tabs;
    const scopeFolders = [];
    for (const c of scopeTabs) {
      for (const pane of all) if (pane.tab === c.id && pane.terminal && pane.cwd) scopeFolders.push(pane.cwd);
    }
    const targetTabFolders = new Set(targetTabId ? all.filter((x) => x.tab === targetTabId && x.terminal && x.cwd).map((x) => x.cwd) : []);
    const precheck = new Set();
    for (const folder of new Set(scopeFolders)) {
      const id = await identity(folder, this.on, IO);
      if (id.error) throw new Error(id.message);
      if (!id.jj || !id.linked) continue;
      if (targetTabFolders.has(folder)) precheck.add(id.root);
      if (this.rows.some((r) => r.root === id.root)) continue;
      this.rows.push({ root: id.root, main: id.main, repoName: base(id.main), checked: false, removed: false, error: "" });
    }
    if (!this.rows.length) {
      throw new Error(p.tab ? "No terminal of this tab works in a linked jj workspace." : "No terminal of this space works in a linked jj workspace.");
    }
    const mains = [...new Set(this.rows.map((r) => r.main))];
    const lists = new Map(await Promise.all(mains.map(async (main) => [main, await workspaces({ root: main, main }, this.on)])));
    for (const r of this.rows) {
      r.name = lists.get(r.main).find((w) => w.path === r.root)?.name;
      if (!r.name) throw new Error(`jj lists no workspace at ${tilde(r.root, this.userHome)}.`);
      r.checked = p.tab ? true : precheck.has(r.root);
    }
    this.multiRepo = mains.length > 1;
    return { main: mains[0], name: base(mains[0]) };
  }

  // Unified affected-terminal derivation for preview and pre-kill verification:
  // direct terminals whose cwd is inside any checked root plus transitive child
  // terminals owned via Herdr Core `parent`.
  affectedTerminals(roots) {
    if (!roots.length) return { direct: [], children: [], all: [], addresses: new Set(), labels: [] };
    const mine = (t) => (this.on ? t.address.startsWith(`${this.on}/`) : !t.address.includes("/"));
    const allTerms = terminals().filter(mine);
    const direct = [];
    const addresses = new Set();
    for (const t of allTerms) {
      if (t.cwd && roots.some((root) => inside(t.cwd, root))) {
        direct.push(t);
        addresses.add(t.address);
      }
    }
    const children = [];
    let added = true;
    while (added) {
      added = false;
      for (const t of allTerms) {
        if (!addresses.has(t.address) && t.parent && addresses.has(t.parent)) {
          addresses.add(t.address);
          children.push(t);
          added = true;
        }
      }
    }
    const byAddr = new Map(allTerms.map((t) => [t.address, t]));
    const spaceList = spaces();
    const paneList = panes();
    const tabCtx = new Map();
    for (const s of spaceList) {
      (s.tabs ?? []).forEach((c, i) => tabCtx.set(c.id, { space: s, tab: c, index: i }));
    }
    const where = (t) => {
      const p = paneList.find((x) => x.terminal === t.address);
      const ctx = p ? tabCtx.get(p.tab) : null;
      if (!ctx) return "parked";
      if (ctx.space.id === this.spaceId) return tabLabel(ctx.tab, ctx.index);
      return `space ${ctx.space.name || ctx.space.id}`;
    };
    const labels = [
      ...direct.map((t) => `${t.name || t.address} (${where(t)})`),
      ...children.map((t) => {
        const pt = byAddr.get(t.parent);
        return `${t.name || t.address} (child of ${pt?.name || t.parent})`;
      }),
    ];
    return { direct, children, all: [...direct, ...children], addresses, labels };
  }

  // Check, verify & end terminals, remove. The first failure stops the run and
  // shows beside its workspace; Enter starts again with the names not yet removed.
  async finish(cx) {
    const todo = this.rows.filter((r) => r.checked && !r.removed);
    if (this.busy || !this.repo || !todo.length) return;
    const confirmed = new Set(this.confirmed.size ? this.confirmed : this.affectedTerminals(todo.map((r) => r.root)).addresses);
    this.busy = true;
    for (const r of this.rows) r.error = "";
    cx.notify();
    let at = todo[0];
    try {
      const mains = [...new Set(todo.map((r) => r.main))];
      const lists = new Map();
      for (const main of mains) {
        at = todo.find((r) => r.main === main);
        lists.set(main, await workspaces({ root: main, main }, this.on));
      }
      const allKnown = [...lists.values()].flat().filter((w) => w.path);
      for (const r of todo) {
        at = r;
        if (!lists.get(r.main).some((w) => w.name === r.name && w.path === r.root)) {
          throw new Error(`jj no longer lists ${r.name}. Its folder ${tilde(r.root, this.userHome)} remains.`);
        }
        const inner = allKnown.find((w) => w.path !== r.root && inside(w.path, r.root));
        if (inner) throw new Error(`${r.name} contains workspace ${inner.name}. Finish ${inner.name} first.`);
      }
      for (const r of todo) {
        at = r;
        // jj waits for a held lock without limit, so this one is bounded.
        const st = await jj(r.root, ["status"], this.on, 10_000);
        if (!st.ok) throw new Error(st.err || "jj status did not finish within 10 seconds.");
      }
      const live = this.affectedTerminals(todo.map((r) => r.root));
      const surprise = live.all.find((t) => !confirmed.has(t.address));
      if (surprise) {
        at = todo.find((r) => surprise.cwd && inside(surprise.cwd, r.root)) ?? todo[0];
        throw new Error(`New terminal ${surprise.name || surprise.address} appeared. Review the list and press Enter again.`);
      }
      await this.endTerminals(todo, live.direct, cx);
      for (const r of todo) {
        at = r;
        const rm = await jj(r.main, ["workspace", "remove", r.name], this.on, 600_000);
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

  // Kills direct terminals in the checked checkouts and waits up to 10 seconds
  // for them to go (Herdr Core ends non-outliving children). Closes the target
  // space only when no panes of any kind remain outside the ended terminals;
  // otherwise closes the panes that showed ended terminals.
  async endTerminals(todo, direct, cx) {
    const rowOf = (t) => todo.find((r) => t.cwd && inside(t.cwd, r.root));
    const ends = new Set(direct.map((t) => t.address));
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
    const closing = Boolean(s) && !all.some((p) => tabs.has(p.tab) && !(p.terminal && ends.has(p.terminal)));
    if (closing) run("space.close", { id: s.id, confirmed: true });
    for (const p of all) if (p.terminal && ends.has(p.terminal) && !(closing && tabs.has(p.tab))) run("pane.close", { pane: p.pane });
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
    if (e.key === "enter") {
      if (this.submitted) return;
      this.enter(cx, Boolean(e?.modifiers?.shift || e?.shift));
      cx.stop_propagation();
      return cx.notify();
    }
    if (e.key === "down" || e.key === "up") {
      this.move(e.key === "down" ? 1 : -1);
      cx.stop_propagation();
      return cx.notify();
    }
  }

  toggle(r) {
    if (r && !r.removed) r.checked = !r.checked;
  }

  renderFinish(t) {
    const r = this.repo;
    const checkedRoots = this.rows.filter((w) => w.checked && !w.removed).map((w) => w.root);
    this.confirmed = this.affectedTerminals(checkedRoots).addresses;
    const row = (w, i) => {
      const aff = w.checked && !w.removed ? this.affectedTerminals([w.root]) : null;
      const title = this.multiRepo ? `${w.repoName} / ${w.name}` : w.name;
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
            .child(h_flex().gap(8).child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(title)).when(w.removed, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child("removed"))))
            .child(div().truncate().text_size(11.5).text_color(t.dim).child(tilde(w.root, this.userHome)))
            .when(Boolean(aff && aff.labels.length > 0), (el) => el.child(div().text_size(11.5).text_color(t.muted).child(`Ends ${aff.labels.join(", ")}.`)))
            .when(Boolean(w.error), (el) => el.child(div().text_size(11.5).text_color(t.blocked).child(w.error))),
        );
    };
    const heading = r && !this.multiRepo ? `Finish jj workspace of ${r.name}` : "Finish jj workspace";
    return v_flex()
      .id("worktree")
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .size_full()
      .p(16)
      .gap(10)
      .bg(t.popover)
      .text_size(13)
      .child(div().font_semibold().text_color(t.foreground).child(heading))
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

    const list = this.items();
    const picks = this.picks(list);
    const activePick = picks.length ? Math.min(this.at, picks.length - 1) : -1;
    const cur = this.current();
    const spaceList = spaces();
    const paneList = panes();
    const otherCount = this.others().length;
    const activeSpace = spaceList.find((s) => s.active);
    const targetNote = this.spaceId && activeSpace && activeSpace.id !== this.spaceId && this.spaceName ? ` (tab in ${this.spaceName})` : "";
    const trimmed = this.text.trim();

    let pickIndex = 0;
    const renderEntry = (entry) => {
      if (entry.kind === "divider") {
        return div().flex_none().px(10).pt(8).pb(2).text_size(11).text_color(t.dim).child(entry.label);
      }
      if (entry.kind === "header") {
        const r = entry.repo;
        return h_flex()
          .flex_none()
          .px(10)
          .pt(6)
          .pb(2)
          .gap(8)
          .items_center()
          .child(div().flex_1().min_w(0).truncate().text_size(11.5).font_semibold().text_color(t.muted).child(r.name))
          .when(Boolean(r.on), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(r.on)));
      }
      if (entry.kind === "repo-error") {
        return div().flex_none().px(10).py(4).text_size(11.5).text_color(t.blocked).child(entry.repo.error);
      }
      if (entry.kind === "repo-loading") {
        return div().flex_none().px(10).py(4).text_size(11.5).text_color(t.dim).child("\u2026");
      }
      if (entry.kind === "looking") {
        return div().flex_none().px(10).py(8).text_size(12).text_color(t.muted).child("Loading\u2026");
      }

      const i = pickIndex++;
      const on = i === activePick;

      if (entry.kind === "more") {
        const label = `${entry.count} other space${entry.count === 1 ? "" : "s"}`;
        return h_flex()
          .id(`wt-${i}`)
          .flex_none()
          .h(36)
          .px(10)
          .items_center()
          .rounded(7)
          .cursor_pointer()
          .when(on, (el) => el.bg(t.selected))
          .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
          .on_click((_e, cx) => { this.at = i; this.expand(cx); })
          .child(div().flex_1().text_size(12).text_color(t.muted).child(label))
          .child(div().flex_none().text_size(11).text_color(t.dim).child("\u21b5"));
      }

      if (entry.kind === "create") {
        const r = entry.repo;
        const plan = trimmed ? this.planned(r, trimmed) : null;
        const label = trimmed ? `+ New "${trimmed}"` : "+ New workspace";
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
          .on_click((e, cx) => {
            this.at = i;
            if (!trimmed) { this.input.focus(); cx.notify(); return; }
            cx.spawn(async (cx) => this.work(r, cx, Boolean(e?.modifiers?.shift || e?.shift)));
          })
          .child(
            h_flex()
              .gap(8)
              .items_center()
              .child(div().flex_1().min_w(0).truncate().text_color(trimmed ? t.foreground : t.muted).child(label))
              .when(Boolean(plan?.bookmark), (el) => el.child(div().flex_none().text_size(11).text_color(t.accent).child("bookmark"))),
          )
          .child(div().truncate().text_size(11.5).text_color(t.dim).child(this.previewPath(r, trimmed)));
      }

      // entry.kind === "ws"
      const { repo: r, ws: w } = entry;
      const userHome = this.homes[r.on ?? ""] ?? "";
      const found = w.path && whereOpen(w.path, r.list ?? [], r.on, spaceList, paneList);
      const badge = found ? (found.dedicated ? "open" : `open in ${found.space.name || found.space.id}`) : "";
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
        .on_click((e, cx) => {
          this.at = i;
          this.open(w, r, Boolean(e?.modifiers?.shift || e?.shift), cx);
        })
        .child(
          h_flex()
            .gap(8)
            .items_center()
            .child(div().flex_1().min_w(0).truncate().text_color(w.path ? t.foreground : t.dim).child(w.name))
            .when(w.main, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child("main")))
            .when(Boolean(badge), (el) => el.child(div().flex_none().text_size(11).text_color(t.accent).child(badge)))
            .when(!w.path, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child("unavailable"))),
        )
        .child(div().truncate().text_size(11.5).text_color(t.dim).child(w.path ? tilde(w.path, userHome) : "no recorded folder"));
    };

    const userHome = this.homes[this.spaceMachine ?? ""] ?? "";
    const zeroNotice = this.ready && !this.repos.length && !this.expanding
      ? (this.expanded
          ? "No jj repos in other spaces."
          : otherCount > 0
            ? "No jj repo in this space."
            : this.error ? "" : `${this.folder ? tilde(this.folder, userHome) : "This folder"} is not in a jj repo.`)
      : "";

    const footerHint = () => {
      if (this.busy) return "working\u2026";
      if (!this.ready) return "esc close";
      if (cur?.kind === "more") return "\u21b5 show other spaces";
      if (cur?.kind === "create") {
        if (!trimmed) return "type a name to create";
        const tabPart = this.canTab(cur.repo) ? ` \u00b7 \u21e7\u21b5 tab${targetNote}` : "";
        return `\u21b5 create${tabPart}`;
      }
      if (cur?.kind === "ws") {
        const tabPart = this.canTab(cur.repo) ? ` \u00b7 \u21e7\u21b5 tab${targetNote}` : "";
        return `\u21b5 open${tabPart}`;
      }
      return "esc close";
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
      .child(div().font_semibold().text_color(t.foreground).child("jj workspace"))
      .child(
        Input.new(this.input)
          .h(32)
          .px(10)
          .items_center()
          .rounded(6)
          .border(1)
          .border_color(this.inputFocused ? t.accent : t.input)
          .bg(t.background)
          .text_color(t.foreground),
      )
      .when(Boolean(zeroNotice), (el) => el.child(div().text_color(t.muted).child(zeroNotice)))
      .when(Boolean(this.error), (el) => el.child(div().text_color(t.blocked).child(this.error)))
      .when(list.length > 0, (el) =>
        el.child(
          div()
            .relative()
            .flex_1()
            .min_h(0)
            .child(
              v_flex()
                .id("wt-list")
                .track_scroll(this.scroll)
                .size_full()
                .overflow_y_scroll()
                .children(list.map(renderEntry)),
            )
            .child(Scrollbar.vertical("wt-list").absolute().inset_0()),
        ),
      )
      .when(list.length === 0, (el) => el.child(div().flex_1()))
      .child(
        h_flex()
          .justify_end()
          .text_size(11)
          .text_color(t.dim)
          .gap(6)
          .when(this.busy, (el) => el.child(div().frames(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], 90)))
          .child(footerHint()),
      );
  }
}
