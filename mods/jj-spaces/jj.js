// jj reads for the jj mods. Every function takes `io`, { exec, readTextFile },
// so Node tests and the benchmark can pass real ones.

// shared:start
// Herdr mods import only from their own folder, so every jj mod keeps a copy
// of this section. `just check-mods` fails when a copy differs from this one.

// An absolute path with `.` and `..` resolved. `rel` may itself be absolute.
export function joinPath(base, rel) {
  const out = [];
  for (const part of (rel.startsWith("/") ? rel : `${base}/${rel}`).split("/")) {
    if (part === "..") out.pop();
    else if (part && part !== ".") out.push(part);
  }
  return `/${out.join("/")}`;
}

// The jj checkout a folder is in: { jj: true, root, repo, main, linked }.
// `repo` is the repository's `.jj/repo` folder, shared by every workspace,
// and `main` the main checkout that holds it. { jj: false, final: true } is
// jj's own "no jj repo". { jj: false } means jj or the folder could not be
// reached, so the caller asks again later. { error, message } is any other
// failure.
export async function identity(folder, on, { exec, readTextFile }) {
  let r;
  try {
    r = await exec("jj", ["--ignore-working-copy", "workspace", "root"], { cwd: folder, on, timeout: 10_000 });
  } catch (e) {
    // Inside a jj checkout, a jj that cannot start is an error to fix, not a Git folder.
    for (let dir = folder; dir; dir = dir.slice(0, dir.lastIndexOf("/"))) {
      if (typeof (await readTextFile(`${dir}/.jj/working_copy/type`, { on }).catch(() => null)) === "string")
        return { error: "no jj", message: `jj could not run${on ? ` on ${on}` : ""}: ${e?.message ?? e}` };
    }
    return { jj: false };
  }
  if (r.code !== 0) {
    if (/There is no jj repo/.test(r.stderr)) return { jj: false, final: true };
    return { error: "error", message: r.stderr.trim() || `jj workspace root exited ${r.code}` };
  }
  const root = r.stdout.replace(/\n$/, "");
  // A linked workspace's .jj/repo is a file naming the main one's; in the
  // main checkout it is a folder, which readTextFile rejects or returns as null.
  const pointer = await readTextFile(`${root}/.jj/repo`, { on }).catch(() => null);
  let repo;
  if (typeof pointer === "string") repo = joinPath(`${root}/.jj`, pointer.trim());
  else if (typeof (await readTextFile(`${root}/.jj/repo/store/type`, { on }).catch(() => null)) === "string") repo = `${root}/.jj/repo`;
  else return { error: "error", message: `${root}/.jj/repo is neither a jj repository nor a link to one.` };
  const main = joinPath(repo, "../..");
  return { jj: true, root, repo, main, linked: root !== main };
}
// Whether a layout shows `mod`: no block above it is hidden and every stack
// above it has the child holding it active. A layout that does not mention
// the mod (an overlay, a window) counts as shown.
export function visible(root, mod) {
  let found = false;
  const walk = (node, ok) => {
    if (!node || typeof node !== "object") return false;
    ok = ok && !node.hidden;
    if (node.content?.mod === mod) {
      found = true;
      return ok;
    }
    return (node.children ?? []).some((c) => walk(c, ok && (node.type !== "stack" || node.active === c.id)));
  };
  const shown = walk(root, true);
  return shown || !found;
}

// Normalize a Herdr machine name: null for the local machine, non-empty string for remote.
export function machineOf(on) {
  return typeof on === "string" && on ? on : null;
}

export function sameMachine(a, b) {
  return machineOf(a) === machineOf(b);
}

export function base(p) {
  if (!p) return "";
  const clean = p.replace(/\/+$/, "");
  if (!clean) return "/";
  return clean.slice(clean.lastIndexOf("/") + 1) || clean;
}

// Panes belonging to `space`, ordered strictly by `space.tabs` order.
export function tabOrderedPanes(space, allPanes) {
  if (!space) return [];
  const byTab = new Map();
  for (const p of allPanes ?? []) {
    if (!p?.tab) continue;
    let list = byTab.get(p.tab);
    if (!list) { list = []; byTab.set(p.tab, list); }
    list.push(p);
  }
  const out = [];
  for (const tab of space.tabs ?? []) {
    const list = byTab.get(tab.id);
    if (list) out.push(...list);
  }
  return out;
}

// Unique non-empty folders in a space: pane folders in tab order, then `space.folder`.
export function spaceFolders(space, allPanes) {
  if (!space) return [];
  const out = [];
  const seen = new Set();
  const add = (dir) => { if (dir && !seen.has(dir)) { seen.add(dir); out.push(dir); } };
  for (const p of tabOrderedPanes(space, allPanes)) add(p.cwd);
  add(space.folder);
  return out;
}

// Primary folder of a space: first pane folder in tab order, else `space.folder`.
export function spacePlace(space, allPanes) {
  for (const p of tabOrderedPanes(space, allPanes)) if (p.cwd) return p.cwd;
  return space?.folder || "";
}

// Focused folder for a space, shared by every entry point (keybinding, space menu, + menu).
export function focusFolder(space, allPanes, focus) {
  if (!space) return "";
  const ordered = tabOrderedPanes(space, allPanes);
  const tabIds = new Set((space.tabs ?? []).map((t) => t.id));
  if (focus && focus.space === space.id) {
    if (focus.pane) {
      const hit = ordered.find((p) => p.pane === focus.pane && p.cwd);
      if (hit) return hit.cwd;
    }
    if (focus.cwd) return focus.cwd;
    if (focus.tab && tabIds.has(focus.tab)) {
      const hit = ordered.find((p) => p.tab === focus.tab && p.cwd);
      if (hit) return hit.cwd;
    }
  }
  const activeTab = (space.tabs ?? []).find((t) => t.active);
  if (activeTab) {
    const hit = ordered.find((p) => p.tab === activeTab.id && p.cwd);
    if (hit) return hit.cwd;
  }
  const focusedPane = ordered.find((p) => p.focused && p.cwd);
  return focusedPane?.cwd || spacePlace(space, allPanes);
}
// shared:end

// One JSON line per change: `@` with its bookmarks and diff totals, the
// others with their bookmarks only.
export const STATUS_TEMPLATE = `if(current_working_copy,
  json({"commit" => commit_id, "at" => true,
        "bookmarks" => local_bookmarks.map(|b| b.name()),
        "empty" => empty, "files" => diff.stat().files().len(),
        "added" => diff.stat().total_added(), "removed" => diff.stat().total_removed()}),
  json({"commit" => commit_id, "at" => false,
        "bookmarks" => local_bookmarks.map(|b| b.name())})) ++ "\\n"`;

export const STATUS_REVSET = "@ | heads(::@ & bookmarks())::@";

// A jj error as the word the sidebar shows.
export function errorWord(stderr) {
  if (/more than one operation/.test(stderr)) return "divergent";
  if (/stale/i.test(stderr)) return "stale";
  return "error";
}

// The status line's data for a checkout: { bookmark, distance, empty, files,
// added, removed }, or { error, message }. `snapshot` lets jj snapshot the
// checkout first; otherwise the read uses the current operation as it is.
export async function readStatus(root, on, snapshot, { exec }) {
  const args = [...(snapshot ? [] : ["--ignore-working-copy"]), "log", "--no-graph", "--limit", "64", "-r", STATUS_REVSET, "-T", STATUS_TEMPLATE];
  const r = await exec("jj", args, { cwd: root, on, timeout: 10_000 });
  if (r.code !== 0) {
    const message = r.stderr.trim() || `jj log exited ${r.code}`;
    return { error: errorWord(message), message };
  }
  const lines = r.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const at = lines.find((l) => l.at);
  if (!at) return { error: "error", message: "jj log returned no working-copy change." };
  const distance = lines.findIndex((l) => l.bookmarks.length > 0);
  return {
    bookmark: distance < 0 ? "" : lines[distance].bookmarks[0],
    distance: Math.max(distance, 0),
    empty: at.empty,
    files: at.files,
    added: at.added,
    removed: at.removed,
  };
}
