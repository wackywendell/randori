// jj reads for the jj mods. Every function takes `io`, { exec, readTextFile },
// so Node tests can pass fakes. A copy of the shared section of
// mods/jj-spaces/jj.js.

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

// workspaces:start
// Shared only by the workspace-lifecycle mods (jj-workspace and jj-finish).
// `just check-mods` fails when copies differ.

// Machine prefix of a Herdr terminal address ("retriever/t7" -> "retriever", "t7" -> null).
export function addressMachine(address) {
  if (typeof address !== "string") return null;
  const i = address.indexOf("/");
  return i > 0 ? address.slice(0, i) : null;
}

// Stable map key for a (machine, path) location.
export function locKey(on, p) {
  return `${machineOf(on) ?? ""}\0${p ?? ""}`;
}

export function inside(dir, root) {
  if (!dir || !root) return false;
  if (root === "/") return dir.startsWith("/");
  return dir === root || dir.startsWith(`${root}/`);
}

// Segment-bounded home-directory shortening.
export function tilde(p, userHome) {
  if (!p) return "";
  if (!userHome) return p;
  if (p === userHome) return "~";
  return p.startsWith(`${userHome}/`) ? `~${p.slice(userHome.length)}` : p;
}

// Longest containing root on the same machine, or null. Prevents nested checkouts
// from aliasing their parent checkout. `roots` entries are strings (assumed same
// machine) or `{ on, root }` objects.
export function ownerRoot(on, folder, roots) {
  if (!folder || !roots) return null;
  const m = machineOf(on);
  let best = null;
  for (const entry of roots) {
    const root = typeof entry === "string" ? entry : entry?.root;
    const em = typeof entry === "string" ? m : machineOf(entry?.on);
    if (!root || em !== m) continue;
    if (inside(folder, root) && (!best || root.length > best.length)) best = root;
  }
  return best;
}

// `jj workspace list`: [{ name, path, main }], sorted main-first then by name.
// When `synthesizeDefault` is true (picker), pre-0.38 jj without `root` falls
// back to naming "default" at `main`. Finish passes `synthesizeDefault: false`
// so destructive removal never guesses unrecorded roots.
export async function workspaces(main, on, { exec }, { synthesizeDefault = true } = {}) {
  const m = machineOf(on);
  let r = await exec(
    "jj",
    ["--ignore-working-copy", "workspace", "list", "-T", 'json({"name" => name, "root" => root}) ++ "\\n"'],
    { cwd: main, on: m, timeout: 10_000 },
  );
  if (
    synthesizeDefault &&
    r.code !== 0 &&
    /No such method|doesn't have a method|Method `root`|Keyword `root`|unknown keyword/i.test(r.stderr)
  ) {
    r = await exec(
      "jj",
      ["--ignore-working-copy", "workspace", "list", "-T", 'json({"name" => name, "root" => ""}) ++ "\\n"'],
      { cwd: main, on: m, timeout: 10_000 },
    );
  }
  if (r.code !== 0) {
    throw new Error(r.stderr.trim() || `jj workspace list exited ${r.code}`);
  }
  const out = [];
  for (const line of r.stdout.split("\n")) {
    if (!line.trim()) continue;
    const w = JSON.parse(line);
    const p = w.root || (synthesizeDefault && w.name === "default" ? main : "");
    out.push({ name: w.name, path: p, main: p === main });
  }
  out.sort((a, b) => Number(b.main) - Number(a.main) || a.name.localeCompare(b.name));
  return out;
}
// workspaces:end
