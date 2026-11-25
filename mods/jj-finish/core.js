// Pure planning and safety logic for `jj-finish`. No Herdr runtime imports.
// Every snapshot and affected-terminal calculation is scoped strictly to one
// machine so Finish can never target or close terminals on another machine.

import {
  machineOf,
  sameMachine,
  addressMachine,
  inside,
  ownerRoot,
  tilde,
  base,
  tabOrderedPanes,
} from "./jj.js";

export { machineOf, sameMachine, addressMachine, inside, ownerRoot, tilde, base, tabOrderedPanes };

export function isLiveTerminal(t) {
  return Boolean(t?.address) && (!t.state || t.state === "live");
}

// Machine-scoped Herdr snapshot. Fails closed when an explicit spaceId or tabId
// is missing — never falls back to another space or tab.
export function snapshotHerdr({ spaces = [], panes = [], terminals = [], spaceId = null, tabId = null, machine } = {}) {
  const spaceById = new Map();
  for (const s of spaces) if (s?.id) spaceById.set(s.id, s);

  const targetSpace = spaceId ? spaceById.get(spaceId) ?? null : null;
  const targetTab = tabId && targetSpace ? (targetSpace.tabs ?? []).find((t) => t.id === tabId) ?? null : null;
  const targetMachine = machine !== undefined ? machineOf(machine) : machineOf(targetSpace?.machine);

  const tabSpace = new Map();
  const tabMeta = new Map();
  for (const s of spaces) {
    if (!sameMachine(s?.machine, targetMachine)) continue;
    for (const c of s.tabs ?? []) {
      tabSpace.set(c.id, s);
      tabMeta.set(c.id, { spaceId: s.id, spaceName: s.name || base(s.folder) || s.id, tabId: c.id, tabName: c.name || c.id });
    }
  }

  const machinePanes = [];
  const paneByTerminal = new Map();
  for (const p of panes) {
    if (!p?.tab || !tabSpace.has(p.tab)) continue;
    machinePanes.push(p);
    if (p.terminal) {
      const meta = tabMeta.get(p.tab);
      paneByTerminal.set(p.terminal, {
        ...meta,
        pane: p.pane,
        cwd: p.cwd || "",
        machine: targetMachine,
      });
    }
  }

  const liveTerminals = [];
  const liveByAddress = new Map();
  const childrenByAddress = new Map();
  for (const t of terminals) {
    if (!isLiveTerminal(t)) continue;
    if (!sameMachine(addressMachine(t.address), targetMachine)) continue;
    liveTerminals.push(t);
    liveByAddress.set(t.address, t);
  }
  for (const t of liveTerminals) {
    if (!t.parent || !liveByAddress.has(t.parent)) continue;
    let kids = childrenByAddress.get(t.parent);
    if (!kids) { kids = []; childrenByAddress.set(t.parent, kids); }
    kids.push(t);
  }

  return {
    machine: targetMachine,
    spaceId,
    tabId,
    targetSpace,
    targetTab,
    panes: machinePanes,
    paneByTerminal,
    liveTerminals,
    liveByAddress,
    childrenByAddress,
  };
}

// Collect unique terminal folders in the clicked space or tab scope.
// Fails closed if the clicked space or tab no longer exists.
export function collectScopeFolders(snap) {
  if (!snap?.targetSpace) {
    return { ok: false, error: "This space is no longer open.", folders: [], activeFolder: "" };
  }
  if (snap.tabId && !snap.targetTab) {
    return { ok: false, error: "This tab is no longer open.", folders: [], activeFolder: "" };
  }
  const out = [];
  const seen = new Set();
  const add = (dir) => { if (dir && !seen.has(dir)) { seen.add(dir); out.push(dir); } };

  let activeFolder = "";
  if (snap.tabId) {
    for (const p of snap.panes) {
      if (p.tab === snap.tabId && p.terminal && p.cwd) {
        if (!activeFolder) activeFolder = p.cwd;
        add(p.cwd);
      }
    }
  } else {
    const ordered = tabOrderedPanes(snap.targetSpace, snap.panes);
    const activeTab = (snap.targetSpace.tabs ?? []).find((t) => t.active);
    if (activeTab) {
      const hit = ordered.find((p) => p.tab === activeTab.id && p.terminal && p.cwd);
      if (hit) activeFolder = hit.cwd;
    }
    for (const p of ordered) {
      if (p.terminal && p.cwd) {
        if (!activeFolder) activeFolder = p.cwd;
        add(p.cwd);
      }
    }
    add(snap.targetSpace.folder);
  }
  return { ok: true, folders: out, activeFolder };
}

function liveFoldersOf(snap, t) {
  const dirs = [];
  const pane = snap.paneByTerminal.get(t.address);
  if (pane?.cwd) dirs.push(pane.cwd);
  if (t.cwd && !dirs.includes(t.cwd)) dirs.push(t.cwd);
  return dirs;
}

function matchesRoot(machine, dir, root, knownRoots) {
  if (!dir || !root) return false;
  if (knownRoots && knownRoots.length > 0) {
    return ownerRoot(machine, dir, knownRoots) === root;
  }
  return inside(dir, root);
}

// Human-readable terminal description for the confirmation preview.
export function describeTerminal(snap, t, userHome = "") {
  const pane = snap.paneByTerminal.get(t.address);
  const name = t.name || t.program?.name || (Array.isArray(t.argv) ? base(t.argv[0]) : "") || t.address;
  const hostPrefix = snap.machine ? `${snap.machine} · ` : "";
  if (pane) {
    const where = pane.tabName && pane.tabName !== pane.spaceName
      ? `${pane.spaceName} / ${pane.tabName}`
      : pane.spaceName;
    return `${hostPrefix}${name} (${t.address}) · ${where}`;
  }
  const parent = t.parent ? snap.liveByAddress.get(t.parent) : null;
  const where = parent
    ? `background child of ${parent.name || parent.address}`
    : (t.cwd ? tilde(t.cwd, userHome) : "background");
  return `${hostPrefix}${name} (${t.address}) · ${where}`;
}

// Plan live terminals affected by finishing ONE workspace root on `snap.machine`.
// - `direct`: live terminals on this machine whose live pane cwd or launch cwd is
//   owned by `root`. Finish sends `terminal.kill` to each and waits for all of
//   them to exit before `jj workspace remove`.
// - `dependentChildren`: live descendant terminals outside `root` that Herdr's
//   `terminal.kill` walk does not spare (no pane and no `herdr.space` label).
//   Disclosed transparently in the confirmation preview, never waited on as a
//   blocker because Core intentionally keeps `--outlive-parent` children alive.
export function planAffected(snap, root, { knownRoots = null, userHome = "" } = {}) {
  if (!snap || !root) return { direct: [], dependentChildren: [], mustExit: [] };

  const direct = [];
  const directSet = new Set();
  for (const t of snap.liveTerminals) {
    const dirs = liveFoldersOf(snap, t);
    if (dirs.some((d) => matchesRoot(snap.machine, d, root, knownRoots))) {
      directSet.add(t.address);
      direct.push({
        address: t.address,
        label: describeTerminal(snap, t, userHome),
        inPane: snap.paneByTerminal.has(t.address),
      });
    }
  }

  const dependentChildren = [];
  const visited = new Set(directSet);
  const queue = [...directSet];
  while (queue.length > 0) {
    const cur = queue.shift();
    for (const child of snap.childrenByAddress.get(cur) ?? []) {
      if (visited.has(child.address)) continue;
      visited.add(child.address);
      // Match Herdr's documented terminal.kill branch-sparing rule:
      // stop walking any branch whose child has a pane or a herdr.space label.
      if (snap.paneByTerminal.has(child.address) || child.labels?.["herdr.space"]) continue;
      dependentChildren.push({
        address: child.address,
        label: describeTerminal(snap, child, userHome),
      });
      queue.push(child.address);
    }
  }

  return {
    direct,
    dependentChildren,
    mustExit: direct,
  };
}

// Return direct terminals not present in the user's acknowledged address set.
export function detectDrift(acknowledged, currentDirect) {
  const ack = acknowledged instanceof Set ? acknowledged : new Set(acknowledged ?? []);
  return (currentDirect ?? []).filter((t) => !ack.has(t.address));
}

// Refuse finishing `root` when another known workspace lives inside it.
export function findNestedWorkspace(root, otherRoots) {
  if (!root) return null;
  for (const other of otherRoots ?? []) {
    if (!other || other === root) continue;
    if (inside(other, root)) return { outer: root, inner: other };
  }
  return null;
}

// Post-removal UI cleanup for the target space on `snap.machine`.
// Requires a non-empty pane list before closing the space (never vacuous `every([])`).
export function planCleanup(snap, root, knownRoots = null) {
  if (!snap?.targetSpace || !root) return { closeSpace: false, closePanes: [] };
  const spacePanes = tabOrderedPanes(snap.targetSpace, snap.panes);
  if (spacePanes.length === 0) return { closeSpace: false, closePanes: [] };

  const affected = [];
  for (const p of spacePanes) {
    if (p.cwd && matchesRoot(snap.machine, p.cwd, root, knownRoots)) {
      affected.push(p.pane);
    }
  }
  if (affected.length === 0) return { closeSpace: false, closePanes: [] };
  if (affected.length === spacePanes.length) {
    return { closeSpace: true, closePanes: [] };
  }
  return { closeSpace: false, closePanes: affected };
}
