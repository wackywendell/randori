// Pure functional core for Finish jj workspace: Herdr snapshot normalization,
// live+launch terminal graph planning, drift detection, overlap refusal, and
// space/pane cleanup planning. Zero Herdr/GPUI globals.

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

export function inside(dir, root) {
  if (!dir || !root) return false;
  const r = root.replace(/\/+$/, "");
  return dir === r || dir.startsWith(`${r}/`);
}

export function isLiveTerminal(t) {
  return Boolean(t) && (!t.state || t.state === "live");
}

// One normalized view of Herdr's spaces, panes, and live terminals.
// Attaches every live terminal's effective folders (both live pane.cwd and
// launch terminal.cwd) and builds the transitive parent -> child graph.
export function snapshotHerdr({ spaces = [], panes = [], terminals = [], spaceId = null }) {
  const spaceById = new Map();
  const spaceByTab = new Map();
  const tabMeta = new Map();
  for (const s of spaces) {
    spaceById.set(s.id, s);
    (s.tabs ?? []).forEach((tab, idx) => {
      spaceByTab.set(tab.id, s);
      tabMeta.set(tab.id, { tab, index: idx + 1, space: s });
    });
  }

  const panesByTerm = new Map();
  for (const p of panes) {
    if (!p.terminal) continue;
    let list = panesByTerm.get(p.terminal);
    if (!list) {
      list = [];
      panesByTerm.set(p.terminal, list);
    }
    list.push(p);
  }

  const liveTerminals = terminals.filter(isLiveTerminal);
  const termByAddr = new Map(liveTerminals.map((t) => [t.address, t]));
  const childrenOf = new Map();
  for (const t of liveTerminals) {
    if (!t.parent || !termByAddr.has(t.parent)) continue;
    let kids = childrenOf.get(t.parent);
    if (!kids) {
      kids = [];
      childrenOf.set(t.parent, kids);
    }
    kids.push(t);
  }

  const liveFoldersOf = (t) => {
    const out = [];
    const seen = new Set();
    const add = (dir) => {
      if (dir && !seen.has(dir)) {
        seen.add(dir);
        out.push(dir);
      }
    };
    for (const p of panesByTerm.get(t.address) ?? []) add(p.cwd);
    add(t.cwd);
    return out;
  };

  const labelOf = (t, parentTerm = null) => {
    const tName = t.name || t.address;
    const tPanes = panesByTerm.get(t.address) ?? [];
    let where = "";
    const inTarget = tPanes.find((p) => spaceByTab.get(p.tab)?.id === spaceId);
    if (inTarget) {
      const m = tabMeta.get(inTarget.tab);
      const tab = m?.tab;
      where = tab?.named && tab?.name ? tab.name : `tab ${tab?.index ?? m?.index ?? 1}`;
    } else if (tPanes.length) {
      const sp = spaceByTab.get(tPanes[0].tab);
      where = sp?.name ? `space ${sp.name}` : "another space";
    } else {
      where = "parked";
    }
    if (parentTerm) {
      const pName = parentTerm.name || parentTerm.address;
      return `${tName} (child of ${pName}${tPanes.length ? `, ${where}` : ""})`;
    }
    return `${tName} (${where})`;
  };

  return {
    spaces,
    panes,
    spaceId,
    targetSpace: spaceId ? spaceById.get(spaceId) ?? null : null,
    spaceById,
    spaceByTab,
    tabMeta,
    panesByTerm,
    liveTerminals,
    termByAddr,
    childrenOf,
    liveFoldersOf,
    labelOf,
  };
}

// Compute every terminal affected by finishing `checkedRoots`:
// - direct: live terminals whose live pane.cwd OR launch terminal.cwd lies in a checked root
// - children: transitive live children whose parent (or ancestor) is direct
// - all: direct + children (deduplicated)
// - rowOf: Map<root, { term, label, isChild }[]> for the confirmation preview
export function planAffected(snapshot, checkedRoots) {
  const direct = [];
  const directSet = new Set();
  const rowOf = new Map(checkedRoots.map((r) => [r, []]));
  const rowSeen = new Map(checkedRoots.map((r) => [r, new Set()]));
  const directRoots = new Map();

  const addToRow = (root, item) => {
    const seen = rowSeen.get(root);
    if (!seen || seen.has(item.term.address)) return;
    seen.add(item.term.address);
    rowOf.get(root).push(item);
  };

  for (const t of snapshot.liveTerminals) {
    const dirs = snapshot.liveFoldersOf(t);
    const matchedRoots = checkedRoots.filter((root) => dirs.some((d) => inside(d, root)));
    if (!matchedRoots.length) continue;
    direct.push(t);
    directSet.add(t.address);
    directRoots.set(t.address, matchedRoots);
    const label = snapshot.labelOf(t, null);
    for (const root of matchedRoots) addToRow(root, { term: t, label, isChild: false });
  }

  const children = [];
  const visited = new Set(directSet);
  const queue = direct.map((t) => ({ term: t, roots: directRoots.get(t.address) ?? [] }));
  while (queue.length) {
    const { term: parent, roots } = queue.shift();
    for (const child of snapshot.childrenOf.get(parent.address) ?? []) {
      if (visited.has(child.address)) continue;
      visited.add(child.address);
      children.push(child);
      const label = snapshot.labelOf(child, parent);
      for (const root of roots) addToRow(root, { term: child, label, isChild: true });
      queue.push({ term: child, roots });
    }
  }

  const all = [...direct, ...children];
  return {
    direct,
    children,
    all,
    addresses: new Set(all.map((t) => t.address)),
    rowOf,
  };
}

// Any terminal present in `live.all` that was not in the user-confirmed set.
export function detectDrift(live, confirmed) {
  if (!confirmed) return live.all;
  return live.all.filter((t) => !confirmed.has(t.address));
}

// Refuse if any checked workspace root strictly contains another known workspace.
// `allKnown` accepts either strings (paths) or `{ name, path }` records.
export function findNestedWorkspace(checkedRows, allKnown) {
  for (const row of checkedRows) {
    for (const item of allKnown) {
      const inner = typeof item === "string" ? item : item?.path;
      const innerName = typeof item === "string" ? "" : item?.name ?? "";
      if (inner && inner !== row.root && inside(inner, row.root)) {
        return { outer: row, inner, innerName };
      }
    }
  }
  return null;
}

// Plan space/pane closing after all affected terminals (direct + children) end.
// Closes the target space only when every pane inside it belongs to an ended
// terminal (never closing non-terminal mod panes or unaffected terminals).
export function planCleanup(snapshot, allAffectedAddresses) {
  const space = snapshot.targetSpace;
  const tabIds = new Set((space?.tabs ?? []).map((c) => c.id));
  const spacePanes = space ? snapshot.panes.filter((p) => tabIds.has(p.tab)) : [];
  const closeSpace = Boolean(space) && spacePanes.every((p) => p.terminal && allAffectedAddresses.has(p.terminal));
  const closePanes = [];
  for (const p of snapshot.panes) {
    if (!p.terminal || !allAffectedAddresses.has(p.terminal)) continue;
    if (closeSpace && tabIds.has(p.tab)) continue;
    closePanes.push(p.pane);
  }
  return { closeSpace, spaceId: space?.id ?? null, closePanes };
}

// Collect unique terminal pane folders in scope (clicked tab or whole space),
// and identify which folders belong to the pre-checked tab (clicked tab or active tab).
export function collectScopeFolders(space, allPanes, tabId) {
  if (!space) return { folders: [], checkFolders: new Set() };
  const tabs = space.tabs ?? [];
  const targetTabId = tabId ?? tabs.find((c) => c.active)?.id ?? tabs[0]?.id ?? null;
  const scopeTabIds = tabId ? new Set([tabId]) : new Set(tabs.map((c) => c.id));
  const folders = [];
  const seen = new Set();
  const checkFolders = new Set();
  const orderedTabs = tabId ? tabs.filter((c) => c.id === tabId) : tabs;
  for (const c of orderedTabs) {
    for (const p of allPanes) {
      if (p.tab !== c.id || !p.terminal || !p.cwd) continue;
      if (!seen.has(p.cwd)) {
        seen.add(p.cwd);
        folders.push(p.cwd);
      }
      if (c.id === targetTabId) checkFolders.add(p.cwd);
    }
  }
  // Fallback if tabId wasn't found in space.tabs (defensive).
  if (tabId && !orderedTabs.length) {
    for (const p of allPanes) {
      if (!scopeTabIds.has(p.tab) || !p.terminal || !p.cwd) continue;
      if (!seen.has(p.cwd)) {
        seen.add(p.cwd);
        folders.push(p.cwd);
      }
      checkFolders.add(p.cwd);
    }
  }
  return { folders, checkFolders };
}
