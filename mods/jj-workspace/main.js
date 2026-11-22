// jj workspace dialog and Finish window:
// { space, folder, action?: "finish", tab, argv, overlay }.
//
// The workspace dialog shows one filter-first list of workspaces grouped by
// repository, with an inline "+ New" row per repository and lazy expansion to
// other spaces. Enter opens the highlighted workspace or creates from the
// repository's main checkout; Shift+Enter opens a new tab in the target space
// when on the same machine. Finish runs in a separate 520x360 window.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, ScrollHandle, Scrollbar, Checkbox } from "gpui-base";
import { run, props, closeOverlay, theme, spaces, panes, terminals, exec, home, readTextFile, layout, notify, focused, shared } from "herdr";
import { identity, joinPath } from "./jj.js";

const IO = { exec, readTextFile };

const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };
const PROJECT_COLORS = ["ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1"];

function repoColor(t, r, spaceList, paneList) {
  const colors = shared("space.colors") ?? {};
  let id = r.spaceId;
  if (!id) {
    const match = spaceList.find((s) => (s.machine ?? null) === (r.on ?? null) && inside(place(s, paneList) || "", r.main));
    id = match?.id;
  }
  let c = id ? colors[id] : null;
  if (!c) {
    let h = 0;
    for (const ch of r.key) h = (h * 31 + ch.charCodeAt(0)) | 0;
    c = PROJECT_COLORS[Math.abs(h) % PROJECT_COLORS.length];
  }
  return c.startsWith("#") ? c : (MARK[c] ?? t[c] ?? t.accent);
}

const repoInitial = (name) => (name?.match(/[A-Za-z0-9]/)?.[0] ?? name?.[0] ?? "?").toUpperCase();

// Static folder prefix before any {repo}/{name} template placeholder.
function worktreesBase(directory, userHome) {
  if (!directory || !userHome) return null;
  const cut = directory.search(/\{[a-z]+\}/);
  const raw = (cut >= 0 ? directory.slice(0, cut) : parent(directory)).replace(/\/+$/, "");
  return raw ? untilde(raw, userHome) : null;
}

// Fast POSIX glob scan: checks immediate children of configured repo folders
// and depth 1-2 of the worktrees base for `.jj` without descending into repos.
// Emits `<mtime>\t<dir>` using each repo's `.jj/repo/op_heads/heads` mtime so
// disk repositories sort by most recent jj activity.
const DISK_SCAN = [
  'wt="$1"; shift',
  'emit() {',
  '  p="$1"; h="$p/.jj/repo/op_heads/heads"',
  '  if [ -f "$p/.jj/repo" ]; then',
  '    r=$(cat "$p/.jj/repo" 2>/dev/null)',
  '    case "$r" in /*) h="$r/op_heads/heads" ;; *) h="$p/.jj/$r/op_heads/heads" ;; esac',
  '  fi',
  '  m=$(stat -f %m "$h" 2>/dev/null || stat -c %Y "$h" 2>/dev/null || echo 0)',
  '  printf "%s\\t%s\\n" "$m" "$p"',
  '}',
  'if [ -n "$wt" ] && [ -d "$wt" ]; then',
  '  for a in "$wt"/* "$wt"/.[!.]*; do',
  '    [ -d "$a" ] || continue',
  '    if [ -d "$a/.jj" ]; then emit "$a"; continue; fi',
  '    for b in "$a"/* "$a"/.[!.]*; do',
  '      [ -d "$b/.jj" ] && emit "$b"',
  '    done',
  '  done',
  'fi',
  'for root in "$@"; do',
  '  [ -d "$root" ] || continue',
  '  [ -d "$root/.jj" ] && emit "$root"',
  '  for d in "$root"/* "$root"/.[!.]*; do',
  '    [ -d "$d/.jj" ] && emit "$d"',
  '  done',
  'done',
].join("\n");

const SOURCE_RANK = { space: 0, other: 1, disk: 2 };

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
const DEFAULTS = { directory: "~/.herdr/worktrees/{repo}/{name}", links: [], miseTrust: true, repos: [] };
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
// A workspace made before jj 0.38 records no folder (root: null): recover `default`
// from repo.main when no other entry claims it; other unrecorded workspaces stay "".
async function workspaces(repo, on) {
  const r = await jj(repo.root, ["--ignore-working-copy", "workspace", "list", "-T", 'json({"name" => name, "root" => root}) ++ "\\n"'], on);
  if (!r.ok) throw new Error(r.err || "jj workspace list failed.");
  const raw = r.out.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const hasMain = raw.some((w) => w.root === repo.main);
  const list = raw.map((w) => {
    const recovered = !w.root && !hasMain && w.name === "default" && Boolean(repo.main);
    const path = recovered ? repo.main : (w.root ?? "");
    return { name: w.name ?? "", path, main: Boolean(path && path === repo.main) };
  });
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
    this.waitingExit = null;
    this.rows = []; // finish: { name, root, main, repoName, checked, removed, error }
    this.multiRepo = false;
    this.confirmed = new Set();
    this.repos = []; // { key, name, main, checkout, on, source: "space" | "other" | "disk", spaceId, list, names, error }
    this.probed = new Set();
    this.focusKey = null;
    this.focusRoot = null;
    this.ready = false;
    this.loadingBg = false;
    this.submitted = false;
    this.text = "";
    this.at = 0; // finish window cursor
    this.selectedKey = null; // pinned picker row key; null follows top/initial row
    this.scroll = ScrollHandle.new();
    this.input = InputState.new({ value: this.text, placeholder: "Name or repo/name" });
    this.input.on("change", (_e, cx) => {
      const prev = this.text;
      const prevCur = this.current();
      const next = this.input.value();
      this.text = next;
      this.error = "";
      // Typing `/` when the highlighted row's repo matches the prefix auto-completes `<repo>/`.
      const trimmed = next.trim();
      if (next.length === prev.length + 1 && next.endsWith("/") && trimmed.indexOf("/") === trimmed.length - 1) {
        const rp = trimmed.slice(0, -1).toLowerCase();
        if (rp && prevCur?.repo && (prevCur.repo.name ?? "").toLowerCase().includes(rp) && trimmed !== `${prevCur.repo.name}/`) {
          this.completeRepo(prevCur.repo, cx);
          return;
        }
      }
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
    if (this.finishing) this.handle.focus();
    else this.input.focus();
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
        await this.probe(targetList, "space", focusDir, cx);
        this.sortRepos();
        this.scrollCurrent();
        this.loadBackground(cx);
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

  // Canonical deterministic repo order:
  // 1. Current space (focused repo first, then tab order)
  // 2. Other spaces (pure sidebar order, then tab order)
  // 3. Disk repositories (most recent jj op_heads mtime first, then alphabetical)
  sortRepos() {
    this.repos.sort((a, b) => {
      const sr = (SOURCE_RANK[a.source] ?? 9) - (SOURCE_RANK[b.source] ?? 9);
      if (sr !== 0) return sr;
      if (a.source === "space") {
        const af = a.key === this.focusKey ? 0 : 1;
        const bf = b.key === this.focusKey ? 0 : 1;
        if (af !== bf) return af - bf;
        return (a.order ?? 0) - (b.order ?? 0);
      }
      if (a.source === "other") return (a.order ?? 0) - (b.order ?? 0);
      if ((b.mtime ?? 0) !== (a.mtime ?? 0)) return (b.mtime ?? 0) - (a.mtime ?? 0);
      return (a.name ?? "").localeCompare(b.name ?? "", undefined, { sensitivity: "base" });
    });
  }

  // Probes unique (folder, machine) pairs in sidebar/tab order, deduplicating repos.
  // For background sources ("other" / "disk"), settles and notifies per repo while
  // keeping canonical deterministic ordering regardless of async completion order.
  async probe(spaceList, source, focusDir, cx) {
    const paneList = panes();
    const pairs = [];
    const batchSeen = new Set();
    const enqueue = (folder, on, spaceId) => {
      if (!folder) return;
      const pk = `${on ?? ""}\0${folder}`;
      if (this.probed.has(pk) || batchSeen.has(pk)) return;
      batchSeen.add(pk);
      this.probed.add(pk);
      pairs.push({ folder, on: on ?? null, spaceId: spaceId ?? null, order: pairs.length });
    };
    for (const s of spaceList) {
      const on = s.machine ?? null;
      for (const dir of folders(s, paneList)) enqueue(dir, on, s.id ?? null);
    }
    if (source === "space" && focusDir) enqueue(focusDir, this.spaceMachine, this.spaceId);
    if (!pairs.length) return;

    const addFromId = (folder, on, spaceId, order, id) => {
      if (id.error) {
        if (source === "space" && !this.error) this.error = id.message;
        else console.log(`jj-workspace: ${folder}: ${id.message}`);
        return null;
      }
      if (!id.jj || !id.main) return null;
      const key = `${on ?? ""}\0${id.main}`;
      let r = this.repos.find((x) => x.key === key);
      if (!r) {
        r = { key, name: base(id.main), main: id.main, checkout: id.root, on, source, spaceId, order, mtime: 0, list: undefined, names: undefined, error: "" };
        this.repos.push(r);
        if (source === "space" && folder === focusDir) { this.focusKey = key; this.focusRoot = id.root; }
        this.sortRepos();
        return r;
      }
      if (r.source === source && order < (r.order ?? Infinity)) {
        r.order = order;
        if (spaceId) r.spaceId = spaceId;
        this.sortRepos();
      } else if (!r.spaceId && spaceId) {
        r.spaceId = spaceId;
      }
      if (source === "space" && folder === focusDir) {
        r.checkout = id.root;
        this.focusKey = key;
        this.focusRoot = id.root;
        this.sortRepos();
      }
      return null;
    };

    if (source === "space") {
      const ids = await Promise.all(pairs.map(async ({ folder, on, spaceId, order }) => ({ folder, on, spaceId, order, id: await identity(folder, on, IO) })));
      const added = [];
      for (const { folder, on, spaceId, order, id } of ids) {
        const r = addFromId(folder, on, spaceId, order, id);
        if (r) added.push(r);
      }
      await Promise.all(added.map((r) => this.loadRepo(r)));
      return;
    }

    await Promise.allSettled(pairs.map(async ({ folder, on, spaceId, order }) => {
      const id = await identity(folder, on, IO);
      const r = addFromId(folder, on, spaceId, order, id);
      if (r) {
        cx?.notify();
        await this.loadRepo(r, cx);
      }
    }));
  }

  // Background discovery of other spaces, the worktrees folder, and configured
  // `repos` folders on local disk. Never blocks initial dialog open.
  loadBackground(cx) {
    const otherSpaces = this.others();
    const cfg = settings();
    const localHome = this.homes[""];
    const wt = worktreesBase(cfg.directory, localHome);
    const roots = (Array.isArray(cfg.repos) ? cfg.repos : []).filter((d) => typeof d === "string" && d.trim()).map((d) => untilde(d.trim(), localHome));
    if (!otherSpaces.length && !wt && !roots.length) return;
    this.loadingBg = true;
    cx.spawn(async (cx) => {
      try {
        await Promise.allSettled([
          otherSpaces.length ? this.probe(otherSpaces, "other", null, cx) : Promise.resolve(),
          wt || roots.length ? this.scanDisk(wt, roots, cx) : Promise.resolve(),
        ]);
      } finally {
        this.loadingBg = false;
        cx.notify();
      }
    });
  }

  async scanDisk(wt, roots, cx) {
    let r;
    try {
      r = await exec("sh", ["-c", DISK_SCAN, "sh", wt || "", ...roots], { timeout: 5_000 });
    } catch {
      return;
    }
    if (r.code !== 0 || !r.stdout?.trim()) return;
    // Parse `<mtime>\t<dir>` (or plain `<dir>`), keeping highest mtime per path.
    const rawEntries = new Map();
    for (const line of r.stdout.trim().split("\n")) {
      if (!line) continue;
      const tab = line.indexOf("\t");
      const mtime = tab >= 0 ? (Number(line.slice(0, tab)) || 0) : 0;
      const dir = tab >= 0 ? line.slice(tab + 1) : line;
      if (!dir) continue;
      if (!rawEntries.has(dir) || mtime > rawEntries.get(dir)) rawEntries.set(dir, mtime);
    }
    // Resolve linked worktrees via `.jj/repo` pointer file so multiple worktrees
    // of an already-known repo produce zero extra jj calls.
    const candidates = new Map();
    const seenMains = new Set(this.repos.filter((x) => !x.on).map((x) => x.main));
    for (const [dir, mtime] of rawEntries) {
      if (seenMains.has(dir)) continue;
      if (this.repos.some((x) => !x.on && (x.list ?? []).some((w) => w.path === dir))) continue;
      const ptr = await readTextFile(`${dir}/.jj/repo`).catch(() => null);
      let target = dir;
      if (typeof ptr === "string" && ptr.trim()) {
        const repoDir = joinPath(`${dir}/.jj`, ptr.trim());
        target = repoDir.replace(/\/\.jj\/repo\/?$/, "");
      }
      if (!target || seenMains.has(target)) continue;
      if (!candidates.has(target) || mtime > candidates.get(target)) candidates.set(target, mtime);
    }
    if (!candidates.size) return;
    await Promise.allSettled([...candidates.entries()].map(async ([folder, mtime]) => {
      const pk = `\0${folder}`;
      if (this.probed.has(pk)) return;
      this.probed.add(pk);
      const id = await identity(folder, null, IO);
      if (id.error || !id.jj || !id.main) return;
      const key = `\0${id.main}`;
      if (this.repos.some((x) => x.key === key)) return;
      const repo = { key, name: base(id.main), main: id.main, checkout: id.root, on: null, source: "disk", spaceId: null, order: 0, mtime, list: undefined, names: undefined, error: "" };
      this.repos.push(repo);
      this.sortRepos();
      cx?.notify();
      await this.loadRepo(repo, cx);
    }));
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

  // Parses `repo/name` when the prefix before the first `/` matches a loaded
  // repo; otherwise treats the input as an unscoped filter / workspace name
  // (preserving slashes in names like `feat/auth` when `feat` is not a repo).
  parseQuery(raw = this.text.trim()) {
    if (!raw) return { mode: "empty", q: "", name: "", scoped: null };
    const slash = raw.indexOf("/");
    if (slash > 0) {
      const rp = raw.slice(0, slash).toLowerCase();
      const np = raw.slice(slash + 1);
      const exact = this.repos.filter((r) => r.name.toLowerCase() === rp);
      const matched = exact.length ? exact : this.repos.filter((r) => r.name.toLowerCase().includes(rp));
      if (matched.length) return { mode: "scoped", q: np.toLowerCase(), name: np, scoped: new Set(matched.map((r) => r.key)) };
    }
    return { mode: "search", q: raw.toLowerCase(), name: raw, scoped: null };
  }

  items() {
    const out = [];
    const parsed = this.parseQuery();
    const bySource = (src) => this.repos.filter((r) => r.source === src);

    const pushRepo = (target, r, ws, createName, showCreate, createFirst = false) => {
      if (!ws.length && !showCreate && !r.error && r.list !== undefined) return;
      target.push({ kind: "header", repo: r });
      if (r.error) target.push({ kind: "repo-error", repo: r });
      else if (r.list === undefined) target.push({ kind: "repo-loading", repo: r });
      const createEntry = showCreate ? { kind: "create", key: `${r.key}\0+new`, repo: r, name: createName, pick: true } : null;
      if (createEntry && createFirst) target.push(createEntry);
      for (const w of ws) target.push({ kind: "ws", key: `${r.key}\0${w.name}`, repo: r, ws: w, pick: true });
      if (createEntry && !createFirst) target.push(createEntry);
    };

    if (parsed.mode === "empty") {
      const addSection = (src, divider) => {
        const entries = [];
        for (const r of bySource(src)) {
          const showCreate = !r.error && r.names !== undefined;
          pushRepo(entries, r, r.list ?? [], "", showCreate);
        }
        if (entries.length) {
          if (divider && out.length) out.push({ kind: "divider", label: divider });
          out.push(...entries);
        }
      };
      addSection("space", null);
      addSection("other", "Other spaces");
      addSection("disk", "Repositories");
      if (this.loadingBg) out.push({ kind: "looking" });
      return out;
    }

    if (parsed.mode === "scoped") {
      for (const r of this.repos) {
        if (!parsed.scoped.has(r.key)) continue;
        const ws = (r.list ?? []).filter((w) => !parsed.q || (w.name ?? "").toLowerCase().includes(parsed.q));
        const showCreate = !r.error && r.names !== undefined && !this.existing(r, parsed.name);
        pushRepo(out, r, ws, parsed.name, showCreate, !parsed.q);
      }
      if (this.loadingBg) out.push({ kind: "looking" });
      return out;
    }

    // Search mode: float matching repos (by repo name or workspace name) above
    // non-matching repos' "+ New <name>" rows.
    const matched = [];
    const createElsewhere = [];
    const q = parsed.q;
    for (const r of this.repos) {
      const repoMatch = (r.name ?? "").toLowerCase().includes(q);
      const wsMatches = (r.list ?? []).filter((w) => (w.name ?? "").toLowerCase().includes(q));
      if (repoMatch || wsMatches.length) {
        const ws = repoMatch && !wsMatches.length ? (r.list ?? []) : wsMatches;
        const createName = repoMatch && !wsMatches.length ? "" : parsed.name;
        const showCreate = !r.error && r.names !== undefined && (!createName || !this.existing(r, createName));
        const createFirst = repoMatch && !wsMatches.length;
        pushRepo(matched, r, ws, createName, showCreate, createFirst);
      } else if (!r.error && r.names !== undefined && !this.existing(r, parsed.name)) {
        pushRepo(createElsewhere, r, [], parsed.name, true);
      }
    }
    out.push(...matched);
    if (createElsewhere.length) {
      if (matched.length) out.push({ kind: "divider", label: "Create elsewhere" });
      out.push(...createElsewhere);
    }
    if (this.loadingBg) out.push({ kind: "looking" });
    return out;
  }

  picks(list = this.items()) {
    return list.filter((e) => e.pick);
  }

  // Default row when nothing is pinned and input is empty: stay within the
  // current space (first other workspace in the focused repo, else the focused
  // repo's "New workspace", else another workspace / "New workspace" in this
  // space). Only fall back to other spaces/disk repos if this space has no jj repo.
  initialIndex(p = this.picks()) {
    if (!p.length) return 0;
    const isOtherWs = (e) => e.kind === "ws" && Boolean(e.ws.path) && (!this.focusRoot || e.ws.path !== this.focusRoot);
    if (this.focusKey) {
      const i = p.findIndex((e) => e.repo?.key === this.focusKey && isOtherWs(e));
      if (i >= 0) return i;
      const c = p.findIndex((e) => e.kind === "create" && e.repo?.key === this.focusKey);
      if (c >= 0) return c;
    }
    const spaceOther = p.findIndex((e) => e.repo?.source === "space" && isOtherWs(e));
    if (spaceOther >= 0) return spaceOther;
    const spaceCreate = p.findIndex((e) => e.repo?.source === "space" && e.kind === "create");
    if (spaceCreate >= 0) return spaceCreate;
    const anyOther = p.findIndex(isOtherWs);
    return anyOther >= 0 ? anyOther : 0;
  }

  // Single selection invariant: if the user pinned a row (`selectedKey`) and it
  // is currently visible in `picks`, stay on it; if hidden (or unpinned), act
  // as row 0 (or initialIndex when empty) while keeping `selectedKey` intact so
  // backspacing brings the pinned row right back.
  resolve(picks = this.picks()) {
    if (!picks.length) return -1;
    if (this.selectedKey) {
      const i = picks.findIndex((e) => e.key === this.selectedKey);
      if (i >= 0) return i;
    }
    return this.text.trim() ? 0 : this.initialIndex(picks);
  }

  current(picks = this.picks()) {
    const i = this.resolve(picks);
    return i >= 0 ? picks[i] : undefined;
  }

  scrollCurrent() {
    const list = this.items();
    const cur = this.current(this.picks(list));
    if (!cur) return;
    const idx = list.indexOf(cur);
    if (idx >= 0) this.scroll.scroll_to_item(idx);
  }

  move(delta) {
    const p = this.picks();
    if (!p.length) return;
    const cur = Math.max(0, this.resolve(p));
    this.selectedKey = p[(cur + delta + p.length) % p.length].key;
    this.scrollCurrent();
  }

  // Inline ghost completion always follows the highlighted row's repo, never a
  // hidden separate match. Only appears when the highlighted repo actually matches
  // the typed query (before `/`). Prefix matches show the remainder (`.dotf` -> `iles/`);
  // mid-string matches show ` → .dotfiles/`.
  ghost() {
    const raw = this.text;
    if (!raw || raw.length >= 40 || raw !== raw.trim() || raw.includes("/")) return null;
    const repo = this.current()?.repo;
    if (!repo) return null;
    const q = raw.toLowerCase();
    if (!(repo.name ?? "").toLowerCase().includes(q)) return null;
    const suffix = repo.name.toLowerCase().startsWith(q)
      ? `${repo.name.slice(raw.length)}/`
      : ` \u2192 ${repo.name}/`;
    return { repo, typed: raw, suffix, fill: `${repo.name}/` };
  }

  // Fills `<repo>/` into the input; `resolve()` naturally keeps `selectedKey`
  // highlighted if visible or falls back to row 0.
  completeRepo(r, cx) {
    if (!r) return;
    const next = `${r.name}/`;
    this.text = next;
    this.input.set_value(next);
    this.input.set_selected_range({ start: next.length, end: next.length });
    this.text = next;
    this.scrollCurrent();
    this.input.focus();
    cx?.notify();
  }

  // The folder and start of the workspace a name would make.
  planned(r = this.selectedRepo(), name = this.parseQuery().name) {
    if (typeof r === "string") { name = r; r = this.selectedRepo(); }
    if (!r) return null;
    const userHome = this.homes[r.on ?? ""] ?? "";
    const directory = settings().directory.replaceAll("{repo}", r.name).replaceAll("{name}", slug(name));
    return { name, path: untilde(directory, userHome), bookmark: Boolean(r.names?.has(name)) };
  }

  previewPath(r, name = "") {
    const userHome = this.homes[r.on ?? ""] ?? "";
    const directory = settings().directory.replaceAll("{repo}", r.name).replaceAll("{name}", slug(name) || "\u2026");
    return tilde(untilde(directory, userHome), userHome);
  }

  enter(cx, asTab = false) {
    if (this.busy) return;
    const cur = this.current();
    if (!cur) return;
    if (cur.kind === "ws") return this.open(cur.ws, cur.repo, asTab, cx);
    if (cur.kind === "create") {
      if (!cur.name) {
        if (this.text.trim() !== `${cur.repo.name}/`) this.completeRepo(cur.repo, cx);
        else this.input.focus();
        return;
      }
      cx.spawn(async (cx) => this.work(cur.repo, cx, asTab, cur.name));
    }
  }

  async work(r = this.selectedRepo(), cx, asTab = false, name) {
    if (r && typeof r.notify === "function") { name = asTab; asTab = Boolean(cx); cx = r; r = this.selectedRepo(); }
    if (this.busy || !r) return;
    if (asTab && !this.canTab(r)) {
      this.error = `Tabs in this space cannot open a workspace on ${r.on}. Press Enter for a new space.`;
      cx.notify();
      return;
    }
    this.busy = true;
    this.error = "";
    cx.notify();
    try { this.error = await this.create(r, asTab, name); }
    catch (error) { this.error = String(error?.message ?? error); }
    if (this.error) console.log(`jj-workspace: ${this.error}`);
    this.busy = false;
    if (!this.error) this.close();
    cx.notify();
  }

  async create(r, asTab = false, rawName) {
    const targetName = typeof rawName === "string" ? rawName.trim() : this.parseQuery().name;
    const { name, path, bookmark } = this.planned(r, targetName);
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
  // for them to go (Herdr re-renders when `terminals()` changes, resolving the
  // waiter on the exact frame they exit; a single 10 s deadline bounds the wait).
  // Closes the target space only when no panes of any kind remain outside the
  // ended terminals; otherwise closes the panes that showed ended terminals.
  async endTerminals(todo, direct, cx) {
    const rowOf = (t) => todo.find((r) => t.cwd && inside(t.cwd, r.root));
    const ends = new Set(direct.map((t) => t.address));
    for (const terminal of ends) run("terminal.kill", { terminal });
    if (terminals().some((t) => ends.has(t.address))) {
      await new Promise((resolve) => {
        let timer;
        const done = () => { this.waitingExit = null; timer?.cancel?.(); resolve(); };
        this.waitingExit = () => { if (!terminals().some((t) => ends.has(t.address))) done(); };
        timer = cx.timer.after(10_000, done);
      });
      const left = terminals().find((t) => ends.has(t.address));
      if (left) {
        throw Object.assign(new Error(`Terminal ${left.name || left.address} in ${tilde(left.cwd, this.userHome)} did not stop.`), { row: rowOf(left) });
      }
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
    if (e.key === "right" && !e.modifiers?.shift && !e.modifiers?.control && !e.modifiers?.alt && !e.modifiers?.platform) {
      const g = this.ghost();
      const sel = this.input.selected_range?.();
      if (g && (!sel || (sel.start === this.text.length && sel.end === this.text.length))) {
        this.completeRepo(g.repo, cx);
        cx.stop_propagation();
        return;
      }
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
    this.waitingExit?.();
    const t = theme();
    if (this.finishing) return this.renderFinish(t);

    const list = this.items();
    const picks = this.picks(list);
    const activePick = this.resolve(picks);
    const cur = activePick >= 0 ? picks[activePick] : undefined;
    const spaceList = spaces();
    const paneList = panes();
    const activeSpace = spaceList.find((s) => s.active);
    const targetNote = this.spaceId && activeSpace && activeSpace.id !== this.spaceId && this.spaceName ? ` (tab in ${this.spaceName})` : "";

    const pill = (label, color, bg = null, bordered = false) =>
      div()
        .flex_none()
        .px(6)
        .py(1)
        .rounded(4)
        .text_size(10.5)
        .text_color(color)
        .when(Boolean(bg), (el) => el.bg(bg))
        .when(bordered, (el) => el.border(1).border_color(t.border))
        .child(label);

    const keycap = (label) =>
      div()
        .px(5)
        .py(1)
        .rounded(4)
        .bg(t.surface)
        .border(1)
        .border_color(t.border)
        .text_size(10.5)
        .text_color(t.muted)
        .child(label);

    let pickIndex = 0;
    const renderEntry = (entry) => {
      if (entry.kind === "divider") {
        return h_flex()
          .flex_none()
          .mt(8)
          .mb(2)
          .pt(8)
          .px(8)
          .border_t(1)
          .border_color(t.border)
          .items_center()
          .child(div().text_size(11).font_semibold().text_color(t.dim).child(entry.label));
      }
      if (entry.kind === "header") {
        const r = entry.repo;
        const userHome = this.homes[r.on ?? ""] ?? "";
        return h_flex()
          .flex_none()
          .px(8)
          .pt(8)
          .pb(3)
          .gap(8)
          .items_center()
          .child(
            h_flex()
              .size(18)
              .flex_none()
              .rounded(5)
              .bg(repoColor(t, r, spaceList, paneList))
              .items_center()
              .justify_center()
              .text_size(10.5)
              .font_bold()
              .text_color("#ffffff")
              .child(repoInitial(r.name)),
          )
          .child(div().flex_none().text_size(12).font_semibold().text_color(t.foreground).child(r.name))
          .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(tilde(r.main, userHome)))
          .when(Boolean(r.on), (el) =>
            el.child(
              h_flex()
                .flex_none()
                .px(6)
                .py(1)
                .gap(4)
                .rounded(4)
                .bg(t.surface)
                .border(1)
                .border_color(t.border)
                .items_center()
                .text_size(10.5)
                .text_color(t.muted)
                .child(svg("mods/workspace-chrome/server.svg").size(10).text_color(t.dim))
                .child(r.on),
            ),
          );
      }
      if (entry.kind === "repo-error") {
        return div().flex_none().px(10).py(4).text_size(11.5).text_color(t.blocked).child(entry.repo.error);
      }
      if (entry.kind === "repo-loading") {
        return div().flex_none().px(10).py(4).text_size(11.5).text_color(t.dim).child("\u2026");
      }
      if (entry.kind === "looking") {
        return h_flex()
          .flex_none()
          .px(10)
          .py(8)
          .gap(6)
          .items_center()
          .text_size(11.5)
          .text_color(t.dim)
          .child(svg("mods/workspace-chrome/spinner.svg").size(11).text_color(t.dim).spin(900))
          .child("Loading other spaces\u2026");
      }

      const i = pickIndex++;
      const on = i === activePick;

      if (entry.kind === "create") {
        const r = entry.repo;
        const name = entry.name || "";
        const plan = name ? this.planned(r, name) : null;
        const label = name ? `New "${name}"` : "New workspace";
        return h_flex()
          .id(`wt-${i}`)
          .flex_none()
          .h(44)
          .pl(6)
          .pr(10)
          .gap(8)
          .items_center()
          .rounded(7)
          .cursor_pointer()
          .when(on, (el) => el.bg(t.selected))
          .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
          .on_click((e, cx) => {
            this.selectedKey = entry.key;
            if (!name) {
              if (this.text.trim() !== `${r.name}/`) this.completeRepo(r, cx);
              else { this.input.focus(); cx.notify(); }
              return;
            }
            cx.spawn(async (cx) => this.work(r, cx, Boolean(e?.modifiers?.shift || e?.shift), name));
          })
          .child(div().w(3).h(20).flex_none().rounded(2).when(on, (el) => el.bg(t.accent)))
          .child(
            h_flex()
              .size(20)
              .flex_none()
              .rounded(5)
              .bg(t.surface)
              .border(1)
              .border_color(t.border)
              .items_center()
              .justify_center()
              .child(svg("mods/workspace-chrome/plus.svg").size(11).text_color(name ? t.accent : t.muted)),
          )
          .child(
            v_flex()
              .flex_1()
              .min_w(0)
              .child(
                h_flex()
                  .gap(6)
                  .items_center()
                  .child(div().flex_1().min_w(0).truncate().text_color(name ? t.foreground : t.muted).child(label))
                  .when(Boolean(plan?.bookmark), (el) => el.child(pill("bookmark", t.accent, t.surface))),
              )
              .child(div().truncate().text_size(11.5).text_color(t.dim).child(this.previewPath(r, name))),
          );
      }

      // entry.kind === "ws"
      const { repo: r, ws: w } = entry;
      const userHome = this.homes[r.on ?? ""] ?? "";
      const found = w.path && whereOpen(w.path, r.list ?? [], r.on, spaceList, paneList);
      return h_flex()
        .id(`wt-${i}`)
        .flex_none()
        .h(44)
        .pl(6)
        .pr(10)
        .gap(8)
        .items_center()
        .rounded(7)
        .cursor_pointer()
        .when(on, (el) => el.bg(t.selected))
        .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
        .on_click((e, cx) => {
          this.selectedKey = entry.key;
          this.open(w, r, Boolean(e?.modifiers?.shift || e?.shift), cx);
        })
        .child(div().w(3).h(20).flex_none().rounded(2).when(on, (el) => el.bg(t.accent)))
        .child(svg("mods/workspace-chrome/branch.svg").size(14).flex_none().text_color(found ? t.accent : t.dim))
        .child(
          v_flex()
            .flex_1()
            .min_w(0)
            .child(
              h_flex()
                .gap(6)
                .items_center()
                .child(div().flex_1().min_w(0).truncate().text_color(w.path ? t.foreground : t.dim).child(w.name))
                .when(w.main, (el) => el.child(pill("root", t.dim, null, true)))
                .when(!w.path, (el) => el.child(pill("unavailable", t.dim, null, true))),
            )
            .child(div().truncate().text_size(11.5).text_color(t.dim).child(w.path ? tilde(w.path, userHome) : "no recorded folder")),
        );
    };

    const userHome = this.homes[this.spaceMachine ?? ""] ?? "";
    const zeroNotice = this.ready && !this.repos.length && !this.loadingBg && !this.error
      ? `${this.folder ? tilde(this.folder, userHome) : "This folder"} is not in a jj repo.`
      : "";

    const renderFooter = () => {
      if (this.busy) {
        return h_flex()
          .items_center()
          .gap(6)
          .child(svg("mods/workspace-chrome/spinner.svg").size(11).text_color(t.dim).spin(900))
          .child("working\u2026");
      }
      if (!this.ready || !cur) return div().child("esc close");
      const items = [];
      if (cur.kind === "create") {
        if (cur.name) {
          items.push(h_flex().items_center().gap(4).child(keycap("\u21b5")).child("create"));
          if (this.canTab(cur.repo)) items.push(h_flex().items_center().gap(4).child(keycap("\u21e7\u21b5")).child(`tab${targetNote}`));
        } else if (this.text.trim() !== `${cur.repo.name}/`) {
          items.push(h_flex().items_center().gap(4).child(keycap("\u21b5")).child(`choose ${cur.repo.name}/`));
        } else {
          items.push(div().child("type a name to create"));
        }
      } else if (cur.kind === "ws") {
        items.push(h_flex().items_center().gap(4).child(keycap("\u21b5")).child("open"));
        if (this.canTab(cur.repo)) items.push(h_flex().items_center().gap(4).child(keycap("\u21e7\u21b5")).child(`tab${targetNote}`));
      }
      return h_flex().items_center().gap(10).children(items);
    };

    const g = this.ghost();

    return v_flex()
      .id("worktree")
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .size_full()
      .p(16)
      .gap(10)
      .bg(t.popover)
      .border(1)
      .border_color(t.border)
      .rounded(10)
      .text_size(13)
      .child(
        h_flex()
          .items_center()
          .child(div().flex_1().text_size(14.5).font_semibold().text_color(t.foreground).child("jj workspace"))
          .child(
            div()
              .id("wt-esc")
              .px(6)
              .py(2)
              .rounded(5)
              .text_size(11)
              .text_color(t.dim)
              .cursor_pointer()
              .hover((s) => s.bg(t.hover).text_color(t.foreground))
              .on_click(() => this.close())
              .child("Esc"),
          ),
      )
      .child(
        h_flex()
          .h(36)
          .flex_none()
          .px(10)
          .gap(8)
          .items_center()
          .rounded(8)
          .border(1)
          .border_color(this.inputFocused ? t.accent : t.border)
          .bg(t.background)
          .child(svg("mods/workspace-chrome/search.svg").size(14).flex_none().text_color(t.dim))
          .child(
            div()
              .relative()
              .flex_1()
              .h_full()
              .overflow_hidden()
              .when(Boolean(g), (el) =>
                el.child(
                  h_flex()
                    .absolute()
                    .inset_0()
                    .items_center()
                    .whitespace_nowrap()
                    .overflow_hidden()
                    .text_size(13)
                    .child(div().text_color("#00000000").child(g.typed))
                    .child(div().text_color(t.dim).child(g.suffix)),
                ),
              )
              .child(Input.new(this.input).size_full().text_size(13).text_color(t.foreground)),
          ),
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
          .pt(8)
          .border_t(1)
          .border_color(t.border)
          .justify_end()
          .text_size(11)
          .text_color(t.dim)
          .child(renderFooter()),
      );
  }
}
