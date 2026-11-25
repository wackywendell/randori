// Pure functional core for jj-workspace: path/slug/template helpers, disk scan
// script and strict parser, repo dedup/promotion/ordering, query parsing,
// filter-first list construction, selection resolution, ghost/slash completion,
// and tagged placement decisions. Zero Herdr/GPUI globals.

import { joinPath } from "./jj.js";

export const DEFAULTS = {
  directory: "~/.herdr/worktrees/{repo}/{name}",
  links: [],
  miseTrust: true,
  repos: [],
  openIn: "space",
};

export const SOURCE_RANK = { space: 0, other: 1, disk: 2 };

export function base(path) {
  if (!path) return "";
  return path.replace(/\/+$/, "").split("/").pop() || "";
}

export function tilde(path, userHome) {
  if (!path) return "";
  const h = (userHome ?? "").replace(/\/+$/, "");
  if (!h) return path;
  if (path === h) return "~";
  if (path.startsWith(`${h}/`)) return `~${path.slice(h.length)}`;
  return path;
}

export function untilde(path, userHome) {
  if (!path) return "";
  const h = (userHome ?? "").replace(/\/+$/, "");
  if (!h) return path;
  if (path === "~") return h;
  if (path.startsWith("~/")) return `${h}${path.slice(1)}`;
  return path;
}

export function inside(dir, root) {
  if (!dir || !root) return false;
  const r = root.replace(/\/+$/, "");
  return dir === r || dir.startsWith(`${r}/`);
}

// First alphanumeric character (uppercased) for the repository avatar chip.
export function repoInitial(name) {
  const m = String(name ?? "").match(/[A-Za-z0-9]/);
  return (m ? m[0] : "?").toUpperCase();
}

// Safe directory slug for a workspace name. If every character is stripped
// (e.g. "!!!", ".."), fall back to a deterministic hash so the path is never empty.
export function slug(name) {
  const raw = String(name ?? "");
  const clean = raw
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (clean && clean !== "." && clean !== "..") return clean;
  if (!raw.trim()) return "";
  let h = 2166136261;
  for (let i = 0; i < raw.length; i++) {
    h ^= raw.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return `ws-${h.toString(16).padStart(6, "0").slice(0, 6)}`;
}

// Single pure path-template resolver shared by row previews and workspace creation.
export function resolveWorktreePath({ template, repoMain, repoName, wsName, home, rawName = false }) {
  const tpl = template || DEFAULTS.directory;
  const raw = tpl
    .replaceAll("{repo}", repoName || base(repoMain))
    .replaceAll("{name}", rawName ? wsName : slug(wsName));
  const expanded = untilde(raw, home);
  const unresolvedTilde = expanded === "~" || expanded.startsWith("~/");
  if (unresolvedTilde) return { path: expanded, unresolvedTilde: true };
  const path = expanded.startsWith("/") ? joinPath("/", expanded) : joinPath(repoMain, expanded);
  return { path, unresolvedTilde: false };
}

// Validate a relative `links` entry: reject empty, absolute, tilde, or `..` traversal.
export function validateLink(rel) {
  if (typeof rel !== "string") return false;
  const s = rel.trim();
  if (!s || s.startsWith("/") || s.startsWith("~")) return false;
  const parts = s.split("/");
  return parts.every((p) => p !== "" && p !== "." && p !== "..");
}

// A linked file is trusted with `mise trust` if its basename is a mise config.
export function miseFile(rel) {
  const n = rel.split("/").pop() ?? "";
  return /^(?:mise(?:\.[^/]+)?\.toml|\.mise(?:\.[^/]+)?\.toml)$/.test(n);
}

// Tab name when opening a checkout as a tab: repo name for main checkout,
// workspace name for linked workspaces.
export function tabLabel(repo, wsName, isMain = false) {
  return isMain || wsName === "default" ? repo.name : wsName;
}

export function repoKey(on, main) {
  return `${on ?? ""}\0${main}`;
}

export function probeKey(on, dir) {
  return `${on ?? ""}\0${dir}`;
}

// Prefix row keys by kind so a workspace literally named `+new` cannot collide
// with the repo's create row.
export function rowKey(kind, rKey, wsName = "") {
  return kind === "create" ? `create\0${rKey}` : `ws\0${rKey}\0${wsName}`;
}

// Base folder for the worktrees path template (everything before the first
// `{...}` segment). Returns "" if the template has no usable prefix or home is missing.
export function worktreesBase(template, userHome) {
  const raw = untilde(template || DEFAULTS.directory, userHome);
  if (!raw || raw.startsWith("~")) return "";
  const idx = raw.indexOf("{");
  const head = idx >= 0 ? raw.slice(0, idx) : raw;
  const dir = idx >= 0 ? head.replace(/\/[^/]*$/, "") : head.replace(/\/+$/, "");
  return dir.replace(/\/+$/, "");
}

// POSIX shell scan of worktrees base (depth 2: <base>/<repo>/<ws>) and
// configured `repos` patterns. Every pattern in `repos` is expanded strictly
// (exact paths like `~/.dotfiles` match only that path; `*` / `*/*` globs expand
// via POSIX pathname expansion with `IFS=""` to preserve spaces in paths).
//
// Emits strictly 3 tab-separated fields per jj checkout: `<mtime>\t<dir>\t<ptr>`
// where `<ptr>` is `.jj/repo` content for linked workspaces (empty for mains).
//
// Portability: tries GNU `stat -c %Y` BEFORE BSD `stat -f %m`. On GNU
// coreutils, `stat -f %m` prints a 5-line filesystem status report to stdout
// before exiting non-zero, whereas BSD `stat -c` outputs nothing on stderr/stdout
// when `-c` is unsupported and cleanly falls through to `stat -f %m`.
export const DISK_SCAN = `
emit() {
  d="$1"
  [ -d "$d/.jj" ] || return
  h="$d/.jj/repo/op_heads/heads"
  [ -e "$h" ] || h="$d/.jj"
  m=$(stat -c %Y "$h" 2>/dev/null || stat -f %m "$h" 2>/dev/null || echo 0)
  p=""
  [ -f "$d/.jj/repo" ] && IFS= read -r p < "$d/.jj/repo" 2>/dev/null
  printf '%s\\t%s\\t%s\\n' "$m" "$d" "$p"
}
base="$1"
shift
if [ -n "$base" ] && [ -d "$base" ]; then
  for r in "$base"/*; do
    [ -d "$r" ] || continue
    for w in "$r"/*; do
      [ -d "$w" ] || continue
      emit "$w"
    done
  done
fi
IFS=""
for pat in "$@"; do
  case "$pat" in
    "~") pat="$HOME" ;;
    "~/"*) pat="$HOME/\${pat#~/}" ;;
  esac
  while [ "\${pat%/}" != "$pat" ] && [ "$pat" != "/" ]; do pat="\${pat%/}"; done
  [ -n "$pat" ] || continue
  case "$pat" in
    *'*'*|*'?'*|*'['*)
      for d in $pat; do
        [ -d "$d" ] && emit "$d"
      done
      ;;
    *)
      [ -d "$pat" ] && emit "$pat"
      ;;
  esac
done
exit 0
`;

// Parse DISK_SCAN stdout strictly: require 3 tab-separated fields with numeric
// mtime and non-empty dir. Stray stdout lines are dropped rather than treated
// as paths. Returns Map<dir, { mtime, ptr }>.
export function parseDiskScan(stdout) {
  const byDir = new Map();
  for (const line of String(stdout ?? "").split("\n")) {
    if (!line) continue;
    const parts = line.split("\t");
    if (parts.length !== 3) continue;
    const mtime = Number(parts[0]);
    const dir = parts[1];
    const ptr = parts[2].trim();
    if (!Number.isFinite(mtime) || !dir) continue;
    const prev = byDir.get(dir);
    if (!prev || mtime > prev.mtime) byDir.set(dir, { mtime, ptr });
  }
  return byDir;
}

// Collapse scanned checkouts into deduplicated main-checkout candidates with
// max mtime across linked worktrees, filtering out repos already known on `machine`.
export function resolveDiskCandidates(byDir, existingRepos, machine) {
  const known = new Set(existingRepos.filter((r) => (r.on ?? null) === (machine ?? null)).map((r) => r.main));
  const candidates = new Map();
  for (const [dir, { mtime, ptr }] of byDir) {
    const main = ptr ? joinPath(joinPath(`${dir}/.jj`, ptr), "../..") : dir;
    if (known.has(main)) continue;
    const prev = candidates.get(main);
    if (prev === undefined || mtime > prev) candidates.set(main, mtime);
  }
  return candidates;
}

// Parse picker overlay props once synchronously in init().
export function parseProps(raw) {
  const p = raw ?? {};
  return {
    overlay: p.overlay,
    spaceId: p.space ?? null,
    folder: p.folder ?? null,
    machine: p.machine ?? null,
    argv: p.argv,
  };
}

// Where a space is now: its first terminal's live folder, else its launch folder.
export function place(space, allPanes) {
  if (!space) return null;
  const tabs = new Set((space.tabs ?? []).map((c) => c.id));
  return allPanes.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || space.folder || null;
}

// Unique folders in a space: pane folders in tab order, then space.folder.
export function folders(space, allPanes) {
  if (!space) return [];
  const out = [];
  const seen = new Set();
  const add = (dir) => {
    if (dir && !seen.has(dir)) {
      seen.add(dir);
      out.push(dir);
    }
  };
  for (const c of space.tabs ?? []) {
    for (const p of allPanes) if (p.tab === c.id && p.cwd) add(p.cwd);
  }
  add(space.folder);
  return out;
}

// Locate an already-open space/tab for `(repoOn, path)`:
// prefers a dedicated space whose first terminal is inside `path`, carrying the
// matching tab so switching selects that tab if another tab is currently active;
// otherwise finds any space/tab containing a terminal inside `path`.
export function whereOpen(allSpaces, allPanes, repoOn, path) {
  if (!path) return null;
  const on = repoOn ?? null;
  let secondary = null;
  for (const s of allSpaces) {
    if ((s.machine ?? null) !== on) continue;
    const tabs = s.tabs ?? [];
    const tabById = new Map(tabs.map((c) => [c.id, c]));
    const firstTerm = allPanes.find((p) => tabById.has(p.tab) && p.cwd);
    const firstDir = firstTerm?.cwd || s.folder;
    if (firstDir && inside(firstDir, path)) {
      const matchedTab = firstTerm ? tabById.get(firstTerm.tab) ?? null : null;
      return { space: s, tab: matchedTab, dedicated: true };
    }
    if (!secondary) {
      for (const c of tabs) {
        if (allPanes.some((p) => p.tab === c.id && p.cwd && inside(p.cwd, path))) {
          secondary = { space: s, tab: c, dedicated: false };
          break;
        }
      }
    }
  }
  return secondary;
}

// Single owner for inserting/deduplicating repos. Promotes an existing entry
// when a higher-priority source settles later (e.g., `disk` -> `other` -> `space`)
// and updates both `order` and `spaceId` deterministically when an earlier-sidebar
// `other` space resolves after a later one.
export function upsertRepo(repos, candidate) {
  const key = repoKey(candidate.on, candidate.main);
  const existing = repos.find((r) => r.key === key);
  if (existing) {
    if (SOURCE_RANK[candidate.source] < SOURCE_RANK[existing.source]) {
      existing.source = candidate.source;
      if (candidate.spaceId !== undefined) existing.spaceId = candidate.spaceId;
      if (candidate.order !== undefined) existing.order = candidate.order;
    } else if (
      candidate.source === existing.source &&
      candidate.order !== undefined &&
      candidate.order < existing.order
    ) {
      existing.order = candidate.order;
      if (candidate.spaceId !== undefined) existing.spaceId = candidate.spaceId;
    }
    if (candidate.mtime !== undefined && candidate.mtime > existing.mtime) {
      existing.mtime = candidate.mtime;
    }
    return { repo: existing, added: false };
  }
  const repo = {
    key,
    name: base(candidate.main),
    main: candidate.main,
    checkout: candidate.checkout ?? candidate.main,
    on: candidate.on ?? null,
    source: candidate.source,
    spaceId: candidate.spaceId ?? null,
    order: candidate.order ?? Number.MAX_SAFE_INTEGER,
    mtime: candidate.mtime ?? 0,
    state: "loading", // "loading" | "ready" | "error"
    list: [],
    names: new Set(),
    error: "",
  };
  repos.push(repo);
  return { repo, added: true };
}

// Deterministic repo ordering:
// 1. Source section: current space (0) -> other spaces (1) -> disk repos (2)
// 2. Within current space: focused repo first, then tab order
// 3. Within other spaces: current machine first, then sidebar order
// 4. Within disk repos: current machine first, then newest mtime, then alphabetical
export function sortRepos(repos, { focusKey, curMachine }) {
  const cur = curMachine ?? null;
  repos.sort((a, b) => {
    const sr = SOURCE_RANK[a.source] - SOURCE_RANK[b.source];
    if (sr !== 0) return sr;
    if (a.source === "space") {
      if (a.key === focusKey && b.key !== focusKey) return -1;
      if (b.key === focusKey && a.key !== focusKey) return 1;
      return a.order - b.order;
    }
    const am = (a.on ?? null) === cur ? 0 : 1;
    const bm = (b.on ?? null) === cur ? 0 : 1;
    if (am !== bm) return am - bm;
    if (a.source === "other") return a.order - b.order;
    if (b.mtime !== a.mtime) return b.mtime - a.mtime;
    return a.name.localeCompare(b.name);
  });
}

// Parse query text into empty, repo-scoped (`repo/name`), or unscoped filter.
// Only treats `repo/` as scoped when `repo` matches a loaded repo name
// (case-insensitive), keeping git-style names like `feat/auth` literal.
export function parseQuery(text, repos) {
  const raw = String(text ?? "").trim();
  if (!raw) return { mode: "empty", q: "", name: "", scoped: null };
  const slash = raw.indexOf("/");
  if (slash > 0) {
    const rp = raw.slice(0, slash).trim().toLowerCase();
    const np = raw.slice(slash + 1).trim();
    const matched = repos.filter((r) => r.name.toLowerCase() === rp);
    if (matched.length) {
      return {
        mode: "scoped",
        q: np.toLowerCase(),
        name: np,
        scoped: new Set(matched.map((r) => r.key)),
      };
    }
  }
  return { mode: "filter", q: raw.toLowerCase(), name: raw, scoped: null };
}

// Decide whether typing `/` after `prevText` should auto-complete to `<repo>/`.
// Skips completion if `rp` already exact-matches ANY loaded repo name (so
// typing `randori/` is never hijacked by `randori-docs/`).
export function shouldAutoCompleteSlash({ prevText, nextText, prevCurrent, repos }) {
  if (!nextText.endsWith("/") || nextText.length !== prevText.length + 1) return null;
  if (prevText.includes("/")) return null;
  const rp = prevText.trim().toLowerCase();
  if (!rp || !prevCurrent?.repo) return null;
  if (repos.some((r) => r.name.toLowerCase() === rp)) return null;
  if (!prevCurrent.repo.name.toLowerCase().includes(rp)) return null;
  return prevCurrent.repo;
}

// Build flat render items (dividers, headers, loading/error lines, workspaces,
// and inline create rows) for the unified filter-first list.
export function buildItems({ repos, text, loadingBg }) {
  const pq = parseQuery(text, repos);
  const out = [];

  const pushSection = (target, section, r, matches, createName, showCreate, createFirst = false) => {
    const createEntry = showCreate ? { kind: "create", key: rowKey("create", r.key), repo: r, name: createName } : null;
    target.push({ kind: "header", key: `hdr\0${r.key}`, repo: r, section });
    if (r.state === "error") {
      target.push({ kind: "repo-error", key: `err\0${r.key}`, repo: r });
      return;
    }
    if (r.state === "loading") {
      target.push({ kind: "repo-loading", key: `load\0${r.key}`, repo: r });
      return;
    }
    if (createFirst && createEntry) target.push(createEntry);
    for (const w of matches) target.push({ kind: "ws", key: rowKey("ws", r.key, w.name), repo: r, ws: w });
    if (!createFirst && createEntry) target.push(createEntry);
  };

  if (pq.mode === "empty") {
    let seenOther = false;
    let seenDisk = false;
    for (const r of repos) {
      if (r.source === "other" && !seenOther) {
        seenOther = true;
        out.push({ kind: "divider", key: "div\0other", label: "Other spaces" });
      }
      if (r.source === "disk" && !seenDisk) {
        seenDisk = true;
        out.push({ kind: "divider", key: "div\0disk", label: "Repositories" });
      }
      pushSection(out, r.source, r, r.list, "", r.state === "ready");
    }
    if (loadingBg) out.push({ kind: "looking", key: "looking" });
    return out;
  }

  if (pq.mode === "scoped") {
    for (const r of repos) {
      if (!pq.scoped.has(r.key)) continue;
      const matches = pq.q ? r.list.filter((w) => w.name.toLowerCase().includes(pq.q)) : r.list;
      const exact = Boolean(pq.name && r.list.some((w) => w.name === pq.name));
      pushSection(out, r.source, r, matches, pq.name, r.state === "ready" && !exact, !pq.q);
    }
    return out;
  }

  // Unscoped filter: matching repos first (repo-name match with no workspace
  // match floats the repo's workspaces below an empty `New workspace` row so
  // `/` or `→` completion keeps rows stable); non-matching ready repos appear
  // under `Create elsewhere` so a typed name can be created in any loaded repo.
  const matched = [];
  const createElsewhere = [];
  for (const r of repos) {
    const repoMatch = r.name.toLowerCase().includes(pq.q);
    const wsMatches = r.list.filter((w) => w.name.toLowerCase().includes(pq.q));
    if (repoMatch || wsMatches.length) {
      const ws = repoMatch && !wsMatches.length ? r.list : wsMatches;
      const createName = repoMatch && !wsMatches.length ? "" : pq.name;
      const showCreate = r.state === "ready" && (!createName || !r.list.some((w) => w.name === createName));
      pushSection(matched, r.source, r, ws, createName, showCreate, repoMatch && !wsMatches.length);
    } else if (r.state === "ready" && !r.list.some((w) => w.name === pq.name)) {
      pushSection(createElsewhere, r.source, r, [], pq.name, true);
    }
  }
  out.push(...matched);
  if (createElsewhere.length) {
    if (matched.length) out.push({ kind: "divider", key: "div\0elsewhere", label: "Create elsewhere" });
    out.push(...createElsewhere);
  }
  if (loadingBg) out.push({ kind: "looking", key: "looking" });
  return out;
}

// Default pick index when nothing is pinned and input is empty: stay within
// the current space (first other workspace in focused repo, else focused repo's
// create row, else another workspace/create in this space).
export function initialIndex(picks, { focusKey, focusRoot }) {
  if (!picks.length) return 0;
  const isOtherWs = (e) => e.kind === "ws" && Boolean(e.ws.path) && (!focusRoot || e.ws.path !== focusRoot);
  if (focusKey) {
    const i = picks.findIndex((e) => e.repo?.key === focusKey && isOtherWs(e));
    if (i >= 0) return i;
    const c = picks.findIndex((e) => e.kind === "create" && e.repo?.key === focusKey);
    if (c >= 0) return c;
  }
  const spaceOther = picks.findIndex((e) => e.repo?.source === "space" && isOtherWs(e));
  if (spaceOther >= 0) return spaceOther;
  const spaceCreate = picks.findIndex((e) => e.repo?.source === "space" && e.kind === "create");
  if (spaceCreate >= 0) return spaceCreate;
  const anyOther = picks.findIndex(isOtherWs);
  return anyOther >= 0 ? anyOther : 0;
}

export function resolveSelection(picks, { selectedKey, text, focusKey, focusRoot }) {
  if (!picks.length) return -1;
  if (selectedKey !== null) {
    const i = picks.findIndex((e) => e.key === selectedKey);
    if (i >= 0) return i;
  }
  return String(text ?? "").trim() ? 0 : initialIndex(picks, { focusKey, focusRoot });
}

// Inline ghost completion suffix when the typed unscoped query matches the
// currently highlighted repository's name.
export function computeGhost({ text, current }) {
  const raw = String(text ?? "");
  const q = raw.trim().toLowerCase();
  if (!q || raw.includes("/") || !current?.repo) return null;
  const name = current.repo.name;
  const low = name.toLowerCase();
  if (!low.includes(q)) return null;
  if (low.startsWith(q)) {
    return { repo: current.repo, suffix: `${name.slice(q.length)}/`, full: `${name}/`, kind: "prefix" };
  }
  return { repo: current.repo, suffix: ` \u2192 ${name}/`, full: `${name}/`, kind: "substring" };
}

// Single source of truth for Enter / Shift+Enter / click placement AND footer
// hint text. Returns a tagged action object:
//   { kind: "complete", repo, label }
//   { kind: "switch", repo, ws, loc, label }
//   { kind: "tab", repo, ws?, name, create, label }
//   { kind: "space", repo, ws?, name, create, label }
//   { kind: "refuse", reason }
//   { kind: "none", label }
export function placement(entry, shift, ctx) {
  if (!entry) return { kind: "none", label: "" };
  const r = entry.repo;
  const targetSpace = ctx.spaces.find((s) => s.id === ctx.spaceId);
  const canTab = Boolean(ctx.spaceId && (r.on ?? null) === (ctx.spaceMachine ?? null));
  const inactiveSpace = Boolean(targetSpace && !targetSpace.active);
  const tabHint = inactiveSpace && ctx.spaceName ? `new tab in ${ctx.spaceName}` : "new tab";
  const defaultTab = ctx.openIn === "tab";

  if (entry.kind === "create") {
    if (!entry.name) {
      if (ctx.text.trim().toLowerCase() !== `${r.name.toLowerCase()}/`) {
        return { kind: "complete", repo: r, label: `choose ${r.name}/` };
      }
      return { kind: "none", label: "type a name to create" };
    }
    if (!canTab) {
      if (shift) {
        const where = r.on || "local";
        return {
          kind: "refuse",
          reason: `Tabs in this space cannot open a workspace on ${where}. Press Enter for a new space.`,
        };
      }
      return { kind: "space", repo: r, name: entry.name, create: true, label: "new space" };
    }
    const wantTab = shift ? !defaultTab : defaultTab;
    return wantTab
      ? { kind: "tab", repo: r, name: entry.name, create: true, label: tabHint }
      : { kind: "space", repo: r, name: entry.name, create: true, label: "new space" };
  }

  // Existing workspace row.
  const ws = entry.ws;
  if (!ws.path) return { kind: "none", label: "unavailable" };
  const loc = whereOpen(ctx.spaces, ctx.panes, r.on, ws.path);

  if (loc) {
    if (!shift) return { kind: "switch", repo: r, ws, loc, label: "switch" };
    if (canTab) return { kind: "tab", repo: r, ws, name: tabLabel(r, ws.name, ws.main), create: false, label: tabHint };
    const where = r.on || "local";
    return {
      kind: "refuse",
      reason: `Tabs in this space cannot open a workspace on ${where}. Press Enter to switch.`,
    };
  }

  if (!canTab) {
    if (shift) {
      const where = r.on || "local";
      return {
        kind: "refuse",
        reason: `Tabs in this space cannot open a workspace on ${where}. Press Enter for a new space.`,
      };
    }
    return { kind: "space", repo: r, ws, name: ws.name, create: false, label: "new space" };
  }
  const wantTab = shift ? !defaultTab : defaultTab;
  return wantTab
    ? { kind: "tab", repo: r, ws, name: tabLabel(r, ws.name, ws.main), create: false, label: tabHint }
    : { kind: "space", repo: r, ws, name: ws.name, create: false, label: "new space" };
}
