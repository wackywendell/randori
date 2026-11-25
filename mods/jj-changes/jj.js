// jj reads for the changes panel. Every function takes `io`, { exec,
// readTextFile }, so Node tests and the benchmark can pass real ones.

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

// One change's files, as a list of JSON strings parsed again by `parse`.
const FILE_LIST = `diff.stat().files().map(|f| json({"path" => f.path(),
    "status" => f.status_char(), "added" => f.lines_added(),
    "removed" => f.lines_removed()}))`;
// A jj template string literal.
const quote = (text) => `"${text.replace(/[\\"]/g, "\\$&")}"`;
// `change` is at least `idLength` characters, with its shortest unique
// prefix apart.
const fields = (idLength) => `"commit" => commit_id, "change" => change_id.shortest(${idLength}),
    "description" => description, "empty" => empty,
    "conflict" => conflict, "at" => current_working_copy, "bookmarks" => bookmarks`;
// Each file's "added removed" from one diff.stat(), which jj computes again
// on every call. `parse` turns them, or `@`'s file list, into count and totals.
const STATS = `"lines" => diff.stat().files().map(|f| stringify(f.lines_added() ++ " " ++ f.lines_removed()))`;

// One JSON line with a change's files.
export const CHANGE_TEMPLATE = `json({"files" => ${FILE_LIST}}) ++ "\\n"`;
// One JSON line per change. Only `@` computes its file list. `base` is true on
// the row the stack starts from, which skips its line totals: trunk() can be a
// commit of thousands of files.
export function stackTemplate(base, idLength) {
  const isBase = `self.contained_in(${quote(`::(${base})`)})`;
  return `if(current_working_copy, json({${fields(idLength)}, "base" => ${isBase}, "files" => ${FILE_LIST}}),
    if(${isBase}, json({${fields(idLength)}, "base" => true}), json({${fields(idLength)}, "base" => false, ${STATS}}))) ++ "\\n"`;
}
export const DEFAULT_BASE = "trunk()";
export const DEFAULT_ID_LENGTH = 6;
// The changes after `base` up to `@` and any above `@`, then the change they
// start from, which is `base` itself when it is an ancestor of `@`. `base` is
// any revset; jj reports one that does not parse or resolve.
export const stackRevset = (base) => `@:: | ((${base}).. & first_ancestors(@)) | heads(::@ & ::(${base}))`;
export const STACK_LIMIT = 100;

const fail = (r, what) => new Error(r.stderr.trim() || `${what} exited ${r.code}`);
const parse = (line) => {
  const change = JSON.parse(line);
  if (change.files) change.files = change.files.map((f) => JSON.parse(f));
  if (typeof change.description === "string") { change.text = change.description; change.description = change.description.split("\n")[0]; }
  const lines = change.lines?.map((l) => l.split(" ").map(Number)) ?? (change.at ? change.files?.map((f) => [f.added, f.removed]) : null);
  if (lines) {
    change.count = lines.length;
    change.added = lines.reduce((n, [a]) => n + a, 0);
    change.removed = lines.reduce((n, [, r]) => n + r, 0);
    delete change.lines;
  }
  if (change.change) { change.prefix = change.change.prefix; change.change = change.change.prefix + change.change.rest; }
  // Git's own remote mirrors the local bookmarks.
  if (change.bookmarks) change.bookmarks = change.bookmarks.filter((b) => b.remote !== "git").map((b) => (b.remote ? `${b.name}@${b.remote}` : b.name));
  return change;
};
const jj = async (root, on, args, io, timeout = 10_000) => {
  const r = await io.exec("jj", args, { cwd: root, on, timeout });
  if (r.code !== 0) throw fail(r, `jj ${args.find((a) => !a.startsWith("-"))}`);
  return r.stdout;
};

// Snapshots the checkout, as any jj command does, recording an operation
// when it finds edits.
export async function snapshot(root, on, io) {
  await jj(root, on, ["util", "snapshot"], io);
}

// The stack from `base` to `@` and above, newest first: { commit, change,
// prefix, description (its first line), text (all of it), empty, conflict, at,
// bookmarks, base, count, added, removed }, with `files` on `@`.
export async function readStack(root, on, base, idLength, io) {
  const out = await jj(root, on, ["--ignore-working-copy", "log", "--no-graph", "--limit", String(STACK_LIMIT), "-r", stackRevset(base), "-T", stackTemplate(base, idLength)], io);
  return out.split("\n").filter(Boolean).map(parse);
}

// Runs one jj command that changes the repository, such as new, squash or
// describe. It snapshots first, as any jj command does.
export async function change(root, on, args, io) {
  await jj(root, on, args, io, 30_000);
}

// Squashes a stack change into its parent. With both descriptions set, jj
// would open an editor starting with both joined; this passes that text
// instead. With one empty, jj keeps the other without asking.
export async function squashArgs(root, on, c, io) {
  const out = await jj(root, on, ["--ignore-working-copy", "log", "--no-graph", "-r", `${c.commit}-`, "-T", 'json(description) ++ "\\n"'], io);
  const parents = out.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const texts = [parents.length === 1 ? parents[0] : "", c.text ?? ""].map((s) => s.trim());
  return ["squash", "-r", c.commit, ...(texts.every(Boolean) ? ["-m", texts.join("\n\n")] : [])];
}

// Up to 20 bookmark names, local and remote, newest commit first, such as
// "main" and "main@origin". Git's own remote is left out.
export async function readBookmarks(root, on, io) {
  const out = await jj(root, on, ["--ignore-working-copy", "bookmark", "list", "--all-remotes", "--sort", "committer-date-", "-T", 'if(!remote || remote != "git", name ++ if(remote, "@" ++ remote) ++ "\n")'], io);
  return out.split("\n").filter(Boolean).slice(0, 20);
}

// One change's files: [{ path, status, added, removed }].
export async function readChange(root, on, commit, io) {
  const out = await jj(root, on, ["--ignore-working-copy", "log", "--no-graph", "-r", commit, "-T", CHANGE_TEMPLATE], io);
  return parse(out.split("\n")[0]).files;
}

// The files that differ between two commits: [{ path, status }].
export async function readPair(root, on, from, to, io) {
  const out = await jj(root, on, ["--ignore-working-copy", "diff", "--from", from, "--to", to, "-T", 'json({"path" => path, "status" => status_char}) ++ "\\n"'], io);
  return out.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

// A fileset naming exactly one path from the checkout's root, for jj and
// Hunk's `-- path`, which passes it to jj: plain paths are parsed as filesets.
export const filePattern = (path) => `root-file:"${path.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
