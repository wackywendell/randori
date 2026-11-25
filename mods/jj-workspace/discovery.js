// Herdr IO and background repository discovery for jj-workspace.
// Owns initial target-space probing, other-space probing, disk scanning,
// remote home caching, and per-repo workspace/bookmark loading with
// cancellation checks after every await.

import { exec, readTextFile, home, spaces, panes, layout, focused } from "herdr";
import { identity } from "./jj.js";
import {
  DEFAULTS,
  DISK_SCAN,
  untilde,
  parseDiskScan,
  resolveDiskCandidates,
  worktreesBase,
  place,
  folders,
  probeKey,
  upsertRepo,
  sortRepos,
} from "./core.js";

export const IO = { exec, readTextFile };
export const ok = (r) => r && r.code === 0;
export const jj = (cwd, on, args, timeout = 30_000) => exec("jj", args, { cwd, on, timeout });

export function readSettings(root = layout()) {
  const find = (node) => {
    if (!node || typeof node !== "object") return null;
    if (node.content?.mod === "jj-spaces") return node.content.props ?? {};
    for (const c of node.children ?? []) {
      const hit = find(c);
      if (hit) return hit;
    }
    return null;
  };
  return { ...DEFAULTS, ...(find(root) ?? {}) };
}

export function resolveTargetSpace(cfg, allSpaces = spaces(), f = focused()) {
  if (cfg.spaceId) return allSpaces.find((s) => s.id === cfg.spaceId) ?? null;
  if (f?.space) {
    const hit = allSpaces.find((s) => s.id === f.space);
    if (hit) return hit;
  }
  return allSpaces.find((s) => s.focused) ?? allSpaces.find((s) => s.active) ?? allSpaces[0] ?? null;
}

export function resolveFocusFolder(cfg, space, allPanes = panes(), f = focused()) {
  if (cfg.folder) return cfg.folder;
  if (!space) return null;
  const tabs = new Set((space.tabs ?? []).map((c) => c.id));
  if (f?.pane) {
    const hit = allPanes.find((p) => p.pane === f.pane && tabs.has(p.tab) && p.cwd);
    if (hit) return hit.cwd;
  }
  if (f?.tab && tabs.has(f.tab)) {
    const hit = allPanes.find((p) => p.tab === f.tab && p.cwd);
    if (hit) return hit.cwd;
  }
  const activeTab = (space.tabs ?? []).find((c) => c.active);
  if (activeTab) {
    const hit = allPanes.find((p) => p.tab === activeTab.id && p.cwd);
    if (hit) return hit.cwd;
  }
  const fp = allPanes.find((p) => tabs.has(p.tab) && p.focused && p.cwd);
  return fp?.cwd || place(space, allPanes);
}

// `jj workspace list`: [{ name, path, main }]. Uses `root` (jj 0.38+) with fallback.
export async function workspaces(main, on) {
  let r = await jj(main, on, ["--ignore-working-copy", "workspace", "list", "-T", 'json({"name" => name, "root" => root}) ++ "\\n"'], 10_000);
  if (!ok(r) && /No such method|doesn't have a method|Method `root`|unknown keyword|root/i.test(r.stderr)) {
    r = await jj(main, on, ["--ignore-working-copy", "workspace", "list", "-T", 'json({"name" => name, "root" => ""}) ++ "\\n"'], 10_000);
  }
  if (!ok(r)) throw new Error(r.stderr.trim() || `jj workspace list exited ${r.code}`);
  const out = [];
  for (const line of r.stdout.split("\n")) {
    if (!line.trim()) continue;
    const w = JSON.parse(line);
    const p = w.root || (w.name === "default" ? main : "");
    out.push({ name: w.name, path: p, main: p === main });
  }
  out.sort((a, b) => (b.main ? 1 : 0) - (a.main ? 1 : 0) || a.name.localeCompare(b.name));
  return out;
}

export async function bookmarks(main, on) {
  const r = await jj(main, on, ["--ignore-working-copy", "bookmark", "list", "-T", 'if(!remote, name ++ "\\n")'], 10_000);
  if (!ok(r)) return new Set();
  return new Set(r.stdout.split("\n").map((s) => s.trim()).filter(Boolean));
}

export class RepoDiscovery {
  constructor({ isClosed, onUpdate, onSpaceError }) {
    this.isClosed = isClosed;
    this.onUpdate = onUpdate;
    this.onSpaceError = onSpaceError;
    this.repos = [];
    this.probed = new Set();
    this.homes = new Map();
    this.focusKey = null;
    this.focusRoot = null;
    this.spaceMachine = null;
    this.loadingBg = false;
  }

  async homeOf(machine) {
    if (!machine) return home() || "";
    if (this.homes.has(machine)) return this.homes.get(machine);
    try {
      const r = await exec("sh", ["-c", 'printf %s "$HOME"'], { cwd: "/", on: machine, timeout: 10_000 });
      const val = ok(r) ? r.stdout.trim() : "";
      if (val) this.homes.set(machine, val);
      return val;
    } catch (e) {
      console.log(`jj-workspace: remote home on ${machine}: ${e?.message ?? e}`);
      return "";
    }
  }

  sort() {
    sortRepos(this.repos, { focusKey: this.focusKey, curMachine: this.spaceMachine });
  }

  addRepo(candidate) {
    const { repo, added } = upsertRepo(this.repos, candidate);
    this.sort();
    return { repo, added };
  }

  async loadRepo(r) {
    if (this.isClosed()) return;
    try {
      const [list, names] = await Promise.all([workspaces(r.main, r.on), bookmarks(r.main, r.on)]);
      if (this.isClosed()) return;
      r.list = list;
      r.names = names;
      r.error = "";
      r.state = "ready";
    } catch (e) {
      if (this.isClosed()) return;
      r.error = e?.message ?? String(e);
      r.state = "error";
      console.log(`jj-workspace: ${r.name}: ${r.error}`);
    }
    this.onUpdate();
  }

  async probe(pairs, source, focusDir = null) {
    const fresh = [];
    for (const item of pairs) {
      const pk = probeKey(item.on, item.folder);
      if (this.probed.has(pk)) continue;
      this.probed.add(pk);
      fresh.push(item);
    }
    if (!fresh.length) return;
    const loaders = [];
    await Promise.allSettled(
      fresh.map(async ({ folder, on, spaceId, order }) => {
        if (this.isClosed()) return;
        const id = await identity(folder, on, IO);
        if (this.isClosed()) return;
        if (id.error) {
          console.log(`jj-workspace: ${folder}: ${id.message}`);
          if (source === "space") this.onSpaceError(id.message);
          return;
        }
        if (!id.jj) return;
        const { repo, added } = this.addRepo({
          main: id.main,
          checkout: id.root,
          on,
          source,
          spaceId,
          order,
        });
        // Match the focused folder strictly (not `inside`) so an outer checkout
        // in another tab never overwrites a nested inner focused checkout.
        if (source === "space" && focusDir && folder === focusDir) {
          this.focusKey = repo.key;
          this.focusRoot = id.root;
          this.sort();
        }
        if (added) loaders.push(this.loadRepo(repo));
        this.onUpdate();
      }),
    );
    await Promise.allSettled(loaders);
  }

  async scanDisk(machine, template, reposCfg) {
    if (this.isClosed()) return;
    const h = await this.homeOf(machine);
    if (this.isClosed()) return;
    const baseDir = worktreesBase(template, h);
    const patterns = Array.isArray(reposCfg)
      ? reposCfg
          .filter((p) => typeof p === "string" && p.trim())
          .map((p) => untilde(p.trim(), h).replace(/\/+$/, ""))
          .filter(Boolean)
      : [];
    if (!baseDir && !patterns.length) return;

    let res;
    try {
      res = await exec("sh", ["-c", DISK_SCAN, "sh", baseDir, ...patterns], {
        cwd: h || "/",
        on: machine,
        timeout: 15_000,
      });
    } catch (e) {
      console.log(`jj-workspace: disk scan${machine ? ` on ${machine}` : ""}: ${e?.message ?? e}`);
      return;
    }
    if (this.isClosed()) return;
    if (!ok(res)) {
      console.log(`jj-workspace: disk scan${machine ? ` on ${machine}` : ""} exited ${res?.code}: ${res?.stderr?.trim() ?? ""}`);
      return;
    }

    const byDir = parseDiskScan(res.stdout);
    const candidates = resolveDiskCandidates(byDir, this.repos, machine);
    const loaders = [];
    await Promise.allSettled(
      [...candidates.entries()].map(async ([dir, mtime]) => {
        if (this.isClosed()) return;
        const pk = probeKey(machine, dir);
        if (this.probed.has(pk)) return;
        this.probed.add(pk);
        const id = await identity(dir, machine, IO);
        if (this.isClosed()) return;
        if (id.error) {
          console.log(`jj-workspace: ${dir}: ${id.message}`);
          return;
        }
        if (!id.jj) return;
        const { repo, added } = this.addRepo({
          main: id.main,
          checkout: id.main,
          on: machine,
          source: "disk",
          mtime,
        });
        if (added) loaders.push(this.loadRepo(repo));
        this.onUpdate();
      }),
    );
    await Promise.allSettled(loaders);
  }

  async loadInitial(space, focusDir) {
    this.spaceMachine = space?.machine ?? null;
    const allPanes = panes();
    const pairs = [];
    const seen = new Set();
    const add = (folder) => {
      if (folder && !seen.has(folder)) {
        seen.add(folder);
        pairs.push({ folder, on: this.spaceMachine, spaceId: space?.id ?? null, order: pairs.length });
      }
    };
    add(focusDir);
    for (const dir of folders(space, allPanes)) add(dir);
    await this.probe(pairs, "space", focusDir);
  }

  async loadBackground(space) {
    if (this.isClosed()) return;
    this.loadingBg = true;
    this.onUpdate();
    try {
      const allSpaces = spaces();
      const allPanes = panes();
      const others = [];
      let order = 0;
      for (const s of allSpaces) {
        if (space && s.id === space.id) continue;
        for (const dir of folders(s, allPanes)) {
          others.push({ folder: dir, on: s.machine ?? null, spaceId: s.id, order: order++ });
        }
      }
      const settings = readSettings();
      const scanMachines = this.spaceMachine ? [this.spaceMachine, null] : [null];
      await Promise.allSettled([
        this.probe(others, "other"),
        ...scanMachines.map((m) => this.scanDisk(m, settings.directory, settings.repos)),
      ]);
    } finally {
      this.loadingBg = false;
      if (!this.isClosed()) this.onUpdate();
    }
  }
}
