// Effect runner for `jj-workspace`: probes spaces, runs disk discovery, loads
// workspace lists on demand, and resolves remote $HOME. Owns no model state —
// emits immutable reducer events via `dispatch(ev)`.

import { spaces, panes, focused, layout, home, exec, readTextFile } from "herdr";
import {
  identity,
  workspaces,
  machineOf,
  sameMachine,
  locKey,
  spaceFolders,
  focusFolder,
} from "./jj.js";
import {
  parseSettings,
  worktreesBase,
  DISK_SCAN,
  parseDiskScan,
  resolveDiskCandidates,
} from "./core.js";

function findModProps(node, modName) {
  if (!node || typeof node !== "object") return null;
  if (node.content?.mod === modName) return node.content.props ?? {};
  for (const c of node.children ?? []) {
    const hit = findModProps(c, modName);
    if (hit) return hit;
  }
  return null;
}

export function readLayoutSettings() {
  return parseSettings(findModProps(layout(), "jj-spaces"));
}

// Create-time local bookmark lookup. Fails loudly on jj error so creation never
// silently starts from the wrong revision.
export async function hasLocalBookmark(main, on, name) {
  const m = machineOf(on);
  const r = await exec(
    "jj",
    ["--ignore-working-copy", "bookmark", "list", "-T", 'if(!remote, name ++ "\\n")'],
    { cwd: main, on: m, timeout: 10_000 },
  );
  if (r.code !== 0) {
    throw new Error(r.stderr.trim() || `jj bookmark list exited ${r.code}`);
  }
  for (const line of r.stdout.split("\n")) {
    if (line.trim() === name) return true;
  }
  return false;
}

export class RepoDiscovery {
  constructor({ isClosed, dispatch }) {
    this.isClosed = isClosed;
    this.dispatch = dispatch;
    this.homePromises = new Map();
    this.loadedKeys = new Set();
    this.loadingKeys = new Set();
  }

  emit(ev) {
    if (!this.isClosed()) this.dispatch(ev);
  }

  async ensureHome(on) {
    const m = machineOf(on);
    const k = m ?? "";
    if (this.homePromises.has(k)) return this.homePromises.get(k);
    const p = (async () => {
      let dir = "";
      if (!m) {
        dir = home() || "";
      } else {
        try {
          const r = await exec("sh", ["-c", 'printf %s "$HOME"'], { on: m, timeout: 5_000 });
          if (r.code === 0) dir = r.stdout.trim();
        } catch (e) {
          console.log(`jj-workspace: home(${m}): ${e?.message ?? e}`);
        }
      }
      this.emit({ type: "HomeKnown", on: m, home: dir });
      return dir;
    })();
    this.homePromises.set(k, p);
    return p;
  }

  async ensureRepoLoaded(repo) {
    if (!repo) return;
    if (this.loadedKeys.has(repo.key) || this.loadingKeys.has(repo.key)) return;
    this.loadingKeys.add(repo.key);
    this.emit({ type: "RepoLoading", key: repo.key });
    try {
      const list = await workspaces(repo.main, repo.on, { exec, readTextFile }, { synthesizeDefault: true });
      if (this.isClosed()) return;
      this.loadedKeys.add(repo.key);
      this.emit({ type: "RepoLoaded", key: repo.key, list });
    } catch (e) {
      if (this.isClosed()) return;
      this.emit({ type: "RepoFailed", key: repo.key, message: e?.message || String(e) });
    } finally {
      this.loadingKeys.delete(repo.key);
    }
  }

  async probeSpace(space, allPanes, source, focusDir = "") {
    const on = machineOf(space.machine);
    const dirs = spaceFolders(space, allPanes);
    if (focusDir && !dirs.includes(focusDir)) dirs.unshift(focusDir);
    if (dirs.length === 0) return { repos: [], firstError: "" };

    void this.ensureHome(on);
    const io = { exec, readTextFile };
    const settled = await Promise.allSettled(
      dirs.map(async (dir) => ({ dir, id: await identity(dir, on, io) })),
    );
    if (this.isClosed()) return { repos: [], firstError: "" };

    let firstError = "";
    const found = new Map();
    for (const res of settled) {
      if (res.status !== "fulfilled") {
        if (!firstError) firstError = res.reason?.message || String(res.reason);
        continue;
      }
      const { dir, id } = res.value;
      if (id.error && !firstError) firstError = id.message;
      if (!id.jj) continue;
      const key = locKey(on, id.main);
      if (!found.has(key)) {
        found.set(key, { key, on, main: id.main });
        this.emit({
          type: "RepoFound",
          on,
          main: id.main,
          source,
          order: space.index ?? Number.MAX_SAFE_INTEGER,
          spaceId: space.id,
          mtime: 0,
        });
      }
      if (source === "space" && focusDir && dir === focusDir) {
        this.emit({ type: "FocusResolved", key, root: id.root });
      }
    }
    return { repos: [...found.values()], firstError };
  }

  async scanDisk(on, settings) {
    const m = machineOf(on);
    const userHome = await this.ensureHome(m);
    if (this.isClosed()) return;
    const baseDir = worktreesBase(settings.directory, userHome);
    const patterns = settings.repos ?? [];
    if (!baseDir && patterns.length === 0) return;

    try {
      const r = await exec("sh", ["-c", DISK_SCAN, "sh", baseDir || "", ...patterns], {
        on: m,
        timeout: 10_000,
      });
      if (this.isClosed()) return;
      if (r.code !== 0) {
        console.log(`jj-workspace: scanDisk(${m ?? "local"}) exited ${r.code}: ${r.stderr.trim()}`);
        return;
      }
      const candidates = resolveDiskCandidates(parseDiskScan(r.stdout));
      for (const c of candidates) {
        // Disk repos stay idle until the user selects/scopes into them.
        this.emit({
          type: "RepoFound",
          on: m,
          main: c.main,
          source: "disk",
          order: Number.MAX_SAFE_INTEGER,
          spaceId: null,
          mtime: c.mtime,
        });
      }
    } catch (e) {
      console.log(`jj-workspace: scanDisk(${m ?? "local"}): ${e?.message ?? e}`);
    }
  }

  async start(cfg, settings) {
    const allSpaces = spaces();
    const allPanes = panes();
    const focus = focused();

    // Explicit spaceId fails closed if missing; otherwise use active space.
    const targetSpace = cfg.spaceId
      ? allSpaces.find((s) => s.id === cfg.spaceId) ?? null
      : allSpaces.find((s) => s.active) ?? allSpaces[0] ?? null;

    const targetMachine = machineOf(targetSpace?.machine);
    this.emit({
      type: "TargetResolved",
      spaceId: targetSpace?.id ?? null,
      machine: targetMachine,
      spaceError: cfg.spaceId && !targetSpace ? "That space is no longer open." : null,
    });
    void this.ensureHome(targetMachine);

    // 1. Target space (fast path — completes before TargetLoaded).
    if (targetSpace) {
      const focusDir = cfg.folder || focusFolder(targetSpace, allPanes, focus);
      const { repos, firstError } = await this.probeSpace(targetSpace, allPanes, "space", focusDir);
      if (this.isClosed()) return;
      if (repos.length === 0 && firstError) {
        this.emit({ type: "SpaceError", message: firstError });
      }
      await Promise.allSettled(repos.map((r) => this.ensureRepoLoaded(r)));
      if (this.isClosed()) return;
    }
    this.emit({ type: "TargetLoaded" });

    // 2. Background: other open spaces (load workspaces for cross-repo search)
    //    + disk scan (repo names only, zero upfront disk jj workspace calls).
    this.emit({ type: "BgStarted" });
    const otherSpaces = allSpaces.filter((s) => s.id !== targetSpace?.id);
    const diskMachines = [targetMachine];
    if (!sameMachine(targetMachine, null)) diskMachines.push(null);

    await Promise.allSettled([
      ...otherSpaces.map(async (s) => {
        const { repos } = await this.probeSpace(s, allPanes, "other");
        if (this.isClosed()) return;
        await Promise.allSettled(repos.map((r) => this.ensureRepoLoaded(r)));
      }),
      ...diskMachines.map((m) => this.scanDisk(m, settings)),
    ]);
    this.emit({ type: "BgDone" });
  }
}
