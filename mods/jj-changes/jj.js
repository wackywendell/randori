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
  } catch {
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
// shared:end

// One change's files, as a list of JSON strings parsed again by `parse`.
const FILE_LIST = `diff.stat().files().map(|f| json({"path" => f.path(),
    "status" => f.status_char(), "added" => f.lines_added(),
    "removed" => f.lines_removed()}))`;
const FIELDS = `"commit" => commit_id, "change" => change_id.short(),
    "description" => description.first_line(), "empty" => empty,
    "conflict" => conflict, "at" => current_working_copy,
    "added" => diff.stat().total_added(), "removed" => diff.stat().total_removed()`;

// One JSON line per change, with its files.
export const CHANGE_TEMPLATE = `json({${FIELDS}, "files" => ${FILE_LIST}}) ++ "\\n"`;
// One JSON line per change. Only `@` computes its file list.
export const STACK_TEMPLATE = `if(current_working_copy, json({${FIELDS}, "files" => ${FILE_LIST}}), json({${FIELDS}})) ++ "\\n"`;
export const STACK_REVSET = "@ | (trunk().. & first_ancestors(@))";
export const STACK_LIMIT = 100;
// A diff shows at most this much.
export const DIFF_LINES = 5000;
export const DIFF_BYTES = 1 << 20;

const fail = (r, what) => new Error(r.stderr.trim() || `${what} exited ${r.code}`);
const parse = (line) => {
  const change = JSON.parse(line);
  if (change.files) change.files = change.files.map((f) => JSON.parse(f));
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

// The changes from trunk() to `@`, newest first: { commit, change,
// description, empty, conflict, at, added, removed }, with `files` on `@`.
export async function readStack(root, on, io) {
  const out = await jj(root, on, ["--ignore-working-copy", "log", "--no-graph", "--limit", String(STACK_LIMIT), "-r", STACK_REVSET, "-T", STACK_TEMPLATE], io);
  return out.split("\n").filter(Boolean).map(parse);
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

// One file's diff in Git's format, from its first hunk: { lines, cut }.
// `range` is ["-r", commit] or ["--from", older, "--to", newer]. `cut`
// says the diff passed DIFF_LINES or DIFF_BYTES and was shortened.
export async function readDiff(root, on, range, path, io) {
  const pattern = `root-file:"${path.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
  let out = await jj(root, on, ["--ignore-working-copy", "diff", "--git", ...range, "--", pattern], io);
  let cut = out.length > DIFF_BYTES;
  if (cut) out = out.slice(0, DIFF_BYTES);
  const all = out.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
  if (first < 0) return { lines: [], cut: false };
  const lines = all.slice(first);
  if (lines.length > DIFF_LINES) cut = true;
  return { lines: lines.slice(0, DIFF_LINES), cut };
}
