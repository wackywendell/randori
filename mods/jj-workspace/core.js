// Pure state model, reducer, projection, disk-scan parser, and creation planner
// for `jj-workspace`. Zero Herdr runtime imports; no input mutation.

import {
  joinPath,
  machineOf,
  sameMachine,
  locKey,
  base,
  inside,
  tilde,
  ownerRoot,
  tabOrderedPanes,
} from "./jj.js";

export {
  joinPath,
  machineOf,
  sameMachine,
  locKey,
  base,
  inside,
  tilde,
  ownerRoot,
  tabOrderedPanes,
};

export const DEFAULT_DIRECTORY = "~/.herdr/worktrees/{repo}/{name}";
const SOURCE_RANK = { space: 0, other: 1, disk: 2 };

// Parse jj-spaces layout props once at the boundary into a typed settings object.
export function parseSettings(raw) {
  const obj = raw && typeof raw === "object" ? raw : {};
  return {
    openIn: obj.openIn === "tab" ? "tab" : "space",
    links: Array.isArray(obj.links) ? obj.links.filter((x) => typeof x === "string") : [],
    miseTrust: obj.miseTrust !== false,
    repos: Array.isArray(obj.repos) ? obj.repos.filter((x) => typeof x === "string" && x.trim()) : [],
    directory: typeof obj.directory === "string" && obj.directory.trim() ? obj.directory.trim() : DEFAULT_DIRECTORY,
  };
}

export function untilde(p, userHome) {
  if (!p) return "";
  if (!userHome) return p;
  if (p === "~") return userHome;
  return p.startsWith("~/") ? `${userHome}${p.slice(1)}` : p;
}

export function slug(name) {
  return String(name ?? "")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "workspace";
}

export function worktreesBase(template, userHome) {
  const raw = template || DEFAULT_DIRECTORY;
  const cut = raw.indexOf("{");
  const prefix = (cut >= 0 ? raw.slice(0, cut) : raw).replace(/\/+$/, "");
  return untilde(prefix, userHome);
}

export function resolveWorktreePath(template, repoMain, name, userHome) {
  const raw = (template || DEFAULT_DIRECTORY)
    .replaceAll("{repo}", base(repoMain))
    .replaceAll("{name}", slug(name));
  const expanded = untilde(raw, userHome);
  return expanded.startsWith("/") ? joinPath("/", expanded) : joinPath(repoMain, expanded);
}

export function miseFile(rel) {
  const b = base(rel);
  return b === "mise.toml" || b === ".mise.toml" || b === "mise.local.toml" || b === ".mise.local.toml";
}

// Parse and normalize a configured link path. Returns `{ rel, isMise }` or null if invalid.
export function normalizeLink(raw) {
  if (typeof raw !== "string") return null;
  const rel = raw.trim();
  if (!rel || rel.startsWith("/") || rel.endsWith("/")) return null;
  const parts = rel.split("/");
  if (parts.some((p) => !p || p === "." || p === "..")) return null;
  return { rel, isMise: miseFile(rel) };
}

// Pure plan for creating a new workspace, its symlinks, and optional mise trust.
export function planCreate({ repo, name, settings, home }) {
  const trimmed = String(name ?? "").trim();
  const dest = resolveWorktreePath(settings.directory, repo.main, trimmed, home);
  const parent = joinPath(dest, "..");
  const seen = new Set();
  const links = [];
  for (const raw of settings.links ?? []) {
    const parsed = normalizeLink(raw);
    if (!parsed || seen.has(parsed.rel)) continue;
    seen.add(parsed.rel);
    links.push({
      rel: parsed.rel,
      src: joinPath(repo.main, parsed.rel),
      dst: joinPath(dest, parsed.rel),
      isMise: parsed.isMise,
    });
  }
  return {
    name: trimmed,
    dest,
    parent,
    links,
    miseTrust: Boolean(settings.miseTrust),
  };
}

// Build a single POSIX `sh -c` invocation for all links + optional `mise trust`.
// Expected skips (missing source in main, or already present in dest) succeed
// silently; real mkdir/ln/mise failures exit non-zero with a clear message.
export function buildLinkScript(plan) {
  const args = [plan.dest, plan.miseTrust ? "1" : "0"];
  for (const l of plan.links) {
    args.push(l.src, l.dst, l.isMise ? "1" : "0");
  }
  const script = `
dest="$1"; shift
want_mise="$1"; shift
linked_mise=0
while [ "$#" -ge 3 ]; do
  src="$1"; dst="$2"; is_mise="$3"; shift 3
  if [ ! -e "$src" ] && [ ! -L "$src" ]; then
    continue
  fi
  if [ -e "$dst" ] || [ -L "$dst" ]; then
    continue
  fi
  parent=$(dirname "$dst")
  mkdir -p "$parent" || exit 1
  ln -s "$src" "$dst" || exit 1
  if [ "$is_mise" = "1" ]; then linked_mise=1; fi
done
if [ "$want_mise" = "1" ]; then
  if [ "$linked_mise" = "1" ] || [ -e "$dest/mise.toml" ] || [ -e "$dest/.mise.toml" ] || [ -e "$dest/mise.local.toml" ] || [ -e "$dest/.mise.local.toml" ]; then
    if command -v mise >/dev/null 2>&1; then
      (cd "$dest" && mise trust) || exit 1
    fi
  fi
fi
exit 0
`;
  return { script, args };
}

// Shell script to discover jj repositories on a machine from configured glob
// patterns + worktrees base (depth 1 and depth 2). Output lines:
//   <checkoutPath>\t<repoPointerOrEmpty>\t<mtimeUnixSec>
export const DISK_SCAN = `
base="$1"; shift
mtime_of() {
  stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || printf 0
}
emit() {
  d="$1"
  [ -d "$d/.jj" ] || return 0
  p=""
  target="$d/.jj/repo/op_heads/heads"
  if [ -f "$d/.jj/repo" ]; then
    p=$(cat "$d/.jj/repo" 2>/dev/null | tr -d '\\r\\n')
    case "$p" in
      /*) rp="$p" ;;
      *) rp="$d/.jj/$p" ;;
    esac
    target="$rp/op_heads/heads"
  fi
  [ -e "$target" ] || target="$d/.jj"
  m=$(mtime_of "$target")
  printf '%s\\t%s\\t%s\\n' "$d" "$p" "$m"
}
for pat in "$@"; do
  case "$pat" in
    *~*)
      case "$pat" in
        "~") pat="$HOME" ;;
        "~/"*) pat="$HOME/\${pat#~/}" ;;
      esac
      ;;
  esac
  case "$pat" in
    *\\**|*\\?*|*\\[*)
      for d in $pat; do
        [ -d "$d/.jj" ] && emit "$d"
      done
      ;;
    *)
      [ -d "$pat/.jj" ] && emit "$pat"
      ;;
  esac
done
if [ -n "$base" ] && [ -d "$base" ]; then
  for r in "$base"/*; do
    [ -d "$r" ] || continue
    if [ -d "$r/.jj" ]; then
      emit "$r"
      continue
    fi
    for w in "$r"/*; do
      [ -d "$w/.jj" ] && emit "$w"
    done
  done
fi
exit 0
`;

export function parseDiskScan(stdout) {
  const out = [];
  for (const line of String(stdout ?? "").split("\n")) {
    if (!line) continue;
    const parts = line.split("\t");
    if (parts.length !== 3) continue;
    const [dir, pointer, rawMtime] = parts;
    if (!dir) continue;
    const mtime = Number(rawMtime) || 0;
    out.push({ dir, pointer: pointer || "", mtime });
  }
  return out;
}

// Collapse scanned checkouts (including linked worktrees pointing back to their
// main checkout) into deduplicated `{ main, mtime }` records.
export function resolveDiskCandidates(entries) {
  const byMain = new Map();
  for (const e of entries ?? []) {
    const main = e.pointer ? joinPath(joinPath(`${e.dir}/.jj`, e.pointer), "../..") : e.dir;
    const prev = byMain.get(main);
    if (!prev || e.mtime > prev.mtime) {
      byMain.set(main, { main, mtime: e.mtime });
    }
  }
  return [...byMain.values()];
}

// ---------------- Immutable Model & Reducer ----------------

export function emptyModel() {
  return {
    targetSpaceId: null,
    targetMachine: null,
    targetLoaded: false,
    focusKey: null,
    focusRoot: null,
    repos: new Map(),
    homes: new Map(),
    bgLoading: false,
    spaceError: null,
  };
}

export function reduce(model, ev) {
  switch (ev.type) {
    case "TargetResolved":
      return {
        ...model,
        targetSpaceId: ev.spaceId ?? null,
        targetMachine: machineOf(ev.machine),
        spaceError: ev.spaceError ?? model.spaceError,
      };
    case "TargetLoaded":
      return { ...model, targetLoaded: true };
    case "FocusResolved":
      return { ...model, focusKey: ev.key ?? null, focusRoot: ev.root ?? null };
    case "SpaceError":
      return { ...model, spaceError: ev.message || null };
    case "HomeKnown": {
      const mKey = machineOf(ev.on) ?? "";
      if (model.homes.get(mKey) === ev.home) return model;
      const homes = new Map(model.homes);
      homes.set(mKey, ev.home || "");
      return { ...model, homes };
    }
    case "BgStarted":
      return model.bgLoading ? model : { ...model, bgLoading: true };
    case "BgDone":
      return model.bgLoading ? { ...model, bgLoading: false } : model;
    case "RepoFound": {
      const on = machineOf(ev.on);
      const key = locKey(on, ev.main);
      const repos = new Map(model.repos);
      const prev = repos.get(key);
      if (prev) {
        const nextSource = SOURCE_RANK[ev.source] < SOURCE_RANK[prev.source] ? ev.source : prev.source;
        const nextOrder =
          ev.source === nextSource && typeof ev.order === "number"
            ? Math.min(prev.order, ev.order)
            : nextSource === ev.source && typeof ev.order === "number"
              ? ev.order
              : prev.order;
        const nextSpaceId = ev.spaceId && (!prev.spaceId || SOURCE_RANK[ev.source] < SOURCE_RANK[prev.source])
          ? ev.spaceId
          : prev.spaceId;
        const nextMtime = Math.max(prev.mtime || 0, ev.mtime || 0);
        repos.set(key, {
          ...prev,
          source: nextSource,
          order: nextOrder,
          spaceId: nextSpaceId,
          mtime: nextMtime,
        });
      } else {
        repos.set(key, {
          key,
          on,
          main: ev.main,
          name: base(ev.main),
          source: ev.source,
          order: typeof ev.order === "number" ? ev.order : Number.MAX_SAFE_INTEGER,
          spaceId: ev.spaceId ?? null,
          mtime: ev.mtime || 0,
          // Open-space repos load workspaces immediately; disk repos load lazily when searched or scoped.
          load: ev.source === "disk" ? { state: "idle" } : { state: "loading" },
        });
      }
      return { ...model, repos };
    }
    case "RepoLoading": {
      const prev = model.repos.get(ev.key);
      if (!prev || prev.load.state === "loading") return model;
      const repos = new Map(model.repos);
      repos.set(ev.key, { ...prev, load: { state: "loading" } });
      return { ...model, repos };
    }
    case "RepoLoaded": {
      const prev = model.repos.get(ev.key);
      if (!prev) return model;
      const repos = new Map(model.repos);
      repos.set(ev.key, { ...prev, load: { state: "ready", list: ev.list } });
      return { ...model, repos };
    }
    case "RepoFailed": {
      const prev = model.repos.get(ev.key);
      if (!prev) return model;
      const repos = new Map(model.repos);
      repos.set(ev.key, { ...prev, load: { state: "error", message: ev.message || "Could not list workspaces" } });
      return { ...model, repos };
    }
    default:
      return model;
  }
}

export function sortedRepos(model) {
  const m = model.targetMachine;
  const focusKey = model.focusKey;
  return [...model.repos.values()].sort((a, b) => {
    const sa = SOURCE_RANK[a.source] ?? 9;
    const sb = SOURCE_RANK[b.source] ?? 9;
    if (sa !== sb) return sa - sb;
    if (a.source === "space") {
      if (a.key === focusKey && b.key !== focusKey) return -1;
      if (b.key === focusKey && a.key !== focusKey) return 1;
      return a.order - b.order || a.name.localeCompare(b.name);
    }
    const ma = sameMachine(a.on, m) ? 0 : 1;
    const mb = sameMachine(b.on, m) ? 0 : 1;
    if (ma !== mb) return ma - mb;
    if (a.source === "other") {
      return a.order - b.order || a.name.localeCompare(b.name);
    }
    return (b.mtime || 0) - (a.mtime || 0) || a.name.localeCompare(b.name);
  });
}

// Unconditional `/` rule while unscoped:
// - Typing `/` (bare `/` on empty input, or trailing `/` after any prefix such
//   as `strea/`) locks `prevCurrent.repo` (or `focusedRepo`) into a Repo Chip
//   and clears the input.
// - Pasting `/rest` locks `prevCurrent.repo ?? focusedRepo` with `rest`.
// - Pasting `repo/rest` locks an exact unambiguous `repo` with `rest`.
// Once a Repo Chip is active, this is not called and `/` is a literal character.
export function resolveSlashChip(prevQuery, nextQuery, prevCurrent, focusedRepo, repos) {
  if (typeof nextQuery !== "string") return null;
  const slash = nextQuery.indexOf("/");
  if (slash < 0) return null;

  const fallback = prevCurrent?.repo ?? focusedRepo ?? null;
  const typedTrailingSlash =
    typeof prevQuery === "string" &&
    nextQuery.length === prevQuery.length + 1 &&
    nextQuery.endsWith("/") &&
    nextQuery.startsWith(prevQuery);

  if (typedTrailingSlash) {
    return fallback ? { repo: fallback, rest: "" } : null;
  }

  const left = nextQuery.slice(0, slash).trim().toLowerCase();
  const rest = nextQuery.slice(slash + 1);
  if (!left) {
    return fallback ? { repo: fallback, rest } : null;
  }
  const exact = [];
  for (const r of repos ?? []) {
    if (r.name.toLowerCase() === left) exact.push(r);
  }
  if (exact.length === 1) return { repo: exact[0], rest };
  return fallback ? { repo: fallback, rest } : null;
}

// Idle disk repositories matching the current search query (to load lazily).
export function matchingIdleDiskRepos(model, query) {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return [];
  const out = [];
  for (const r of sortedRepos(model)) {
    if (r.source === "disk" && r.load.state === "idle" && r.name.toLowerCase().includes(q)) {
      out.push(r);
    }
  }
  return out;
}

// ---------------- Open-Checkout Index & Placement Truth Table ----------------

// Pre-index which checkouts are open in which spaces/tabs, once per render.
// Uses tab-ordered panes + longest-prefix `ownerRoot` so nested checkouts never
// alias their parent checkout, and prefers dedicated single-checkout spaces.
export function indexOpenCheckouts(allSpaces, allPanes, knownRootsByMachine) {
  const out = new Map();
  for (const s of allSpaces ?? []) {
    const on = machineOf(s?.machine);
    const roots = knownRootsByMachine.get(on ?? "") ?? [];
    if (roots.length === 0) continue;

    const ordered = tabOrderedPanes(s, allPanes);
    const matchedOwners = [];
    for (const p of ordered) {
      if (!p.cwd) continue;
      const own = ownerRoot(on, p.cwd, roots);
      if (own) matchedOwners.push({ root: own, tabId: p.tab });
    }
    if (matchedOwners.length === 0 && s.folder) {
      const own = ownerRoot(on, s.folder, roots);
      if (own) matchedOwners.push({ root: own, tabId: s.tabs?.[0]?.id ?? null });
    }
    if (matchedOwners.length === 0) continue;

    const uniqueRoots = new Set(matchedOwners.map((m) => m.root));
    const singleCheckoutSpace = uniqueRoots.size === 1;
    const seenInSpace = new Set();
    for (const { root, tabId } of matchedOwners) {
      if (seenInSpace.has(root)) continue;
      seenInSpace.add(root);
      const k = locKey(on, root);
      const candidate = {
        spaceId: s.id,
        spaceName: s.name || base(s.folder) || s.id,
        tabId,
        dedicated: singleCheckoutSpace,
      };
      const prev = out.get(k);
      if (!prev || (!prev.dedicated && candidate.dedicated)) {
        out.set(k, candidate);
      }
    }
  }
  return out;
}

// Exhaustively testable placement truth table.
export function destination({ isOpen, canTab, shift, openIn }) {
  if (!canTab) {
    if (shift) return "refuse-tab";
    return isOpen ? "switch" : "space";
  }
  if (openIn === "tab") {
    if (shift) return "space";
    return isOpen ? "switch" : "tab";
  }
  if (shift) return "tab";
  return isOpen ? "switch" : "space";
}

export function placementFor(item, { openIndex, targetSpaceExists, targetMachine, openIn, shift }) {
  if (!item) return null;
  if (item.kind === "create" && !item.name) {
    return {
      action: "scope",
      open: null,
      label: shift ? "" : "new in repo",
      refuseReason: "",
    };
  }
  const on = item.repo.on;
  const canTab = Boolean(targetSpaceExists && sameMachine(on, targetMachine));
  const open = item.kind === "ws" && item.ws.path ? openIndex.get(locKey(on, item.ws.path)) ?? null : null;
  const action = destination({ isOpen: Boolean(open), canTab, shift: Boolean(shift), openIn });

  if (action === "refuse-tab") {
    return {
      action,
      open,
      label: "new space only",
      refuseReason: targetSpaceExists
        ? `Cannot open a tab for ${on || "local"} inside a ${targetMachine || "local"} space.`
        : "No open space to add a tab to.",
    };
  }
  if (action === "switch") {
    return { action, open, label: "switch", refuseReason: "" };
  }
  if (action === "tab") {
    return { action, open, label: item.kind === "create" ? "create in tab" : "open in tab", refuseReason: "" };
  }
  return { action, open, label: item.kind === "create" ? "create in space" : "open in space", refuseReason: "" };
}

// ---------------- Pure Projection (`project -> vm`) ----------------

function matchRank(haystack, needle) {
  const h = haystack.toLowerCase();
  if (h === needle) return 0;
  if (h.startsWith(needle)) return 1;
  if (h.includes(needle)) return 2;
  return -1;
}

function hasExactWorkspace(repo, raw) {
  if (repo?.load?.state !== "ready") return false;
  const q = raw.toLowerCase();
  return repo.load.list.some((w) => w.name.toLowerCase() === q);
}

function resolveSelection(picks, selection, focusKey, focusRoot) {
  if (picks.length === 0) return null;
  const mode = selection?.mode ?? "auto";
  if ((mode === "pinned" || mode === "implicit") && selection.key) {
    const exact = picks.find((p) => p.key === selection.key);
    if (exact) return exact;
    return picks[0];
  }
  if (focusKey && focusRoot) {
    const focusedWs = picks.find((p) => p.kind === "ws" && p.repo.key === focusKey && p.ws.path === focusRoot);
    if (focusedWs) return focusedWs;
  }
  const firstWs = picks.find((p) => p.kind === "ws");
  return firstWs || picks[0];
}

function sortRepoWorkspaces(repo, focusKey, focusRoot) {
  return [...repo.load.list].sort((a, b) => {
    const fa = repo.key === focusKey && a.path === focusRoot ? 0 : 1;
    const fb = repo.key === focusKey && b.path === focusRoot ? 0 : 1;
    return fa - fb || Number(b.main) - Number(a.main) || a.name.localeCompare(b.name);
  });
}

// Build the complete display and action view model from immutable inputs.
// Only two selectable row kinds exist: `ws` (existing workspace) and `create`
// (named create or empty-name "New workspace in <repo>…" which locks the chip).
export function project({ model, query = "", scopedRepoKey = null, selection = { mode: "auto" }, spaces = [], panes = [], settings }) {
  const raw = String(query ?? "").trim();
  const q = raw.toLowerCase();
  const repos = sortedRepos(model);
  const scopedRepo = scopedRepoKey ? model.repos.get(scopedRepoKey) ?? null : null;

  const knownRootsByMachine = new Map();
  const addRoot = (on, root) => {
    if (!root) return;
    const mKey = machineOf(on) ?? "";
    let list = knownRootsByMachine.get(mKey);
    if (!list) { list = []; knownRootsByMachine.set(mKey, list); }
    list.push(root);
  };
  for (const r of repos) {
    addRoot(r.on, r.main);
    if (r.load.state === "ready") {
      for (const w of r.load.list) if (w.path && w.path !== r.main) addRoot(r.on, w.path);
    }
  }

  const openIndex = indexOpenCheckouts(spaces, panes, knownRootsByMachine);
  const targetSpaceExists = Boolean(model.targetSpaceId && spaces.some((s) => s.id === model.targetSpaceId));
  const focusedRepo =
    (model.focusKey && model.repos.get(model.focusKey)) ||
    repos.find((r) => r.source === "space") ||
    null;

  const items = [];

  const pushRepoWorkspaces = (r, { showRepo = false, includeNewRow = false, newFirst = false } = {}) => {
    const newRow = includeNewRow ? { kind: "create", key: `new:${r.key}`, repo: r, name: "" } : null;
    if (newRow && newFirst) items.push(newRow);
    if (r.load.state === "loading" || r.load.state === "idle") {
      items.push({ kind: "loading", key: `loading:${r.key}`, label: `Loading ${r.name}…` });
    } else if (r.load.state === "error") {
      items.push({ kind: "error", key: `err:${r.key}`, message: r.load.message });
    } else {
      for (const w of sortRepoWorkspaces(r, model.focusKey, model.focusRoot)) {
        const open = w.path ? openIndex.get(locKey(r.on, w.path)) ?? null : null;
        items.push({
          kind: "ws",
          key: `ws:${r.key}:${w.name}`,
          repo: r,
          ws: w,
          open,
          showRepo,
        });
      }
    }
    if (newRow && !newFirst) items.push(newRow);
  };

  if (scopedRepo) {
    // ---- Scoped Repo Chip mode ----
    if (scopedRepo.load.state === "loading" || scopedRepo.load.state === "idle") {
      items.push({ kind: "loading", key: `loading:${scopedRepo.key}`, label: `Loading ${scopedRepo.name}…` });
    } else if (scopedRepo.load.state === "error") {
      items.push({ kind: "error", key: `err:${scopedRepo.key}`, message: scopedRepo.load.message });
    } else {
      const wsRows = [];
      for (const w of scopedRepo.load.list) {
        if (!q) {
          const isCurrent = scopedRepo.key === model.focusKey && w.path === model.focusRoot;
          wsRows.push({ w, rank: isCurrent ? 0 : w.main ? 1 : 2 });
        } else {
          const rank = matchRank(w.name, q);
          if (rank >= 0) wsRows.push({ w, rank });
        }
      }
      wsRows.sort((a, b) => a.rank - b.rank || Number(b.w.main) - Number(a.w.main) || a.w.name.localeCompare(b.w.name));
      for (const { w } of wsRows) {
        const open = w.path ? openIndex.get(locKey(scopedRepo.on, w.path)) ?? null : null;
        items.push({
          kind: "ws",
          key: `ws:${scopedRepo.key}:${w.name}`,
          repo: scopedRepo,
          ws: w,
          open,
          showRepo: false,
        });
      }
      if (raw && !hasExactWorkspace(scopedRepo, raw)) {
        items.push({
          kind: "create",
          key: `create:${scopedRepo.key}:${raw}`,
          repo: scopedRepo,
          name: raw,
        });
      }
    }
  } else if (!q) {
    // ---- Flat Search mode, empty query ----
    // Plain non-selectable repo headers + compact workspace rows underneath.
    const spaceRepos = repos.filter((r) => r.source === "space");
    const otherRepos = repos.filter((r) => r.source === "other");
    const diskRepos = repos.filter((r) => r.source === "disk");

    for (const r of spaceRepos) {
      items.push({ kind: "header", key: `hdr:${r.key}`, repo: r });
      pushRepoWorkspaces(r);
    }

    if (otherRepos.length > 0) {
      if (items.length > 0) items.push({ kind: "divider", key: "div:other", label: "Other spaces" });
      for (const r of otherRepos) {
        items.push({ kind: "header", key: `hdr:${r.key}`, repo: r });
        pushRepoWorkspaces(r);
      }
    }

    if (diskRepos.length > 0) {
      if (spaceRepos.length > 0 || otherRepos.length > 0) {
        items.push({ kind: "disk-hint", key: "disk-hint", count: diskRepos.length });
      } else {
        for (const r of diskRepos) {
          items.push({ kind: "header", key: `hdr:${r.key}`, repo: r });
          if (r.load.state === "ready") {
            pushRepoWorkspaces(r, { includeNewRow: true });
          } else {
            items.push({ kind: "create", key: `new:${r.key}`, repo: r, name: "" });
          }
        }
      }
    }
  } else {
    // ---- Flat Search mode, non-empty query ----
    const matchedRepos = [];
    const matchedRepoKeys = new Set();
    const wsMatches = [];

    for (let i = 0; i < repos.length; i++) {
      const r = repos[i];
      const rRank = matchRank(r.name, q);
      if (rRank >= 0) {
        matchedRepos.push({ repo: r, rank: rRank, idx: i });
        matchedRepoKeys.add(r.key);
      }
      if (r.load.state === "ready") {
        for (const w of r.load.list) {
          const wRank = matchRank(w.name, q);
          if (wRank >= 0) {
            const focusedBonus = r.key === focusedRepo?.key ? 0 : 1;
            wsMatches.push({ repo: r, ws: w, rank: wRank, focusedBonus, idx: i });
          }
        }
      }
    }

    matchedRepos.sort((a, b) => a.rank - b.rank || a.idx - b.idx);
    wsMatches.sort(
      (a, b) =>
        a.rank - b.rank ||
        a.focusedBonus - b.focusedBonus ||
        a.idx - b.idx ||
        Number(b.ws.main) - Number(a.ws.main) ||
        a.ws.name.localeCompare(b.ws.name),
    );

    // 1. Repositories whose name matched `q` come first: dim header + "+ New workspace in <repo>…" FIRST + their workspaces.
    for (const { repo: r } of matchedRepos) {
      items.push({ kind: "header", key: `hdr:${r.key}`, repo: r });
      pushRepoWorkspaces(r, { showRepo: false, includeNewRow: true, newFirst: true });
    }

    // 2. Direct workspace name matches across other loaded repos.
    for (const m of wsMatches) {
      if (matchedRepoKeys.has(m.repo.key)) continue;
      const open = m.ws.path ? openIndex.get(locKey(m.repo.on, m.ws.path)) ?? null : null;
      items.push({
        kind: "ws",
        key: `ws:${m.repo.key}:${m.ws.name}`,
        repo: m.repo,
        ws: m.ws,
        open,
        showRepo: true,
      });
    }

    // 3. Direct Create "<raw>" in focused repo (row 0 when nothing else matched, e.g. "fix" or "feat/auth").
    if (focusedRepo && focusedRepo.load.state === "ready" && !hasExactWorkspace(focusedRepo, raw)) {
      items.push({
        kind: "create",
        key: `create:${focusedRepo.key}:${raw}`,
        repo: focusedRepo,
        name: raw,
      });
    }
  }

  const picks = items.filter((it) => it.kind === "ws" || it.kind === "create");
  const current = resolveSelection(picks, selection, model.focusKey, model.focusRoot);
  const ctx = {
    openIndex,
    targetSpaceExists,
    targetMachine: model.targetMachine,
    openIn: settings.openIn,
  };
  const primary = current ? placementFor(current, { ...ctx, shift: false }) : null;
  const secondary = current ? placementFor(current, { ...ctx, shift: true }) : null;

  return {
    query: raw,
    scopedRepo,
    focusedRepo,
    items,
    picks,
    current,
    primary,
    secondary,
    openIndex,
    targetSpaceExists,
    loading: !model.targetLoaded,
    bgLoading: model.bgLoading,
    spaceError: model.spaceError,
  };
}
