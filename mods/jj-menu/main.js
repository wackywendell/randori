// Context menus (Herdr's items). Opened as a popup with
// props { tab: "pane" | "tab" | "space" | "global", target }.
// ↑/↓ move, Enter runs, Esc closes. An item is [label, command, args];
// a command "worktree" opens the worktree dialog instead.
//
// A copy of Herdr's `menu`. A jj space gets New and Open jj workspace, which
// open `jj-workspace`, where the shipped menu shows its worktree entries.
// Finish jj workspace shows on spaces and tabs when a terminal is in a linked
// jj workspace.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { run, props, closeOverlay, openOverlay, theme, keys, terminals, spaces, panes, exec, readTextFile } from "herdr";
import { identity } from "./jj.js";

// Where a space is now: its first terminal's live folder, else where it was made.
function place(s) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return panes().find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}

// Unique folders in a space: pane folders in tab order, then space.folder.
function folders(s, all = panes()) {
  if (!s) return [];
  const out = [];
  const seen = new Set();
  const add = (dir) => { if (dir && !seen.has(dir)) { seen.add(dir); out.push(dir); } };
  for (const c of s.tabs ?? []) {
    for (const p of all) if (p.tab === c.id && p.cwd) add(p.cwd);
  }
  add(s.folder);
  return out;
}

// A space's checkout: "main" (a repo's own), "linked" (a worktree), or null.
async function checkout(folder, on) {
  const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: folder, on });
  const common = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: folder, on });
  if (top.code !== 0 || common.code !== 0) return null;
  return common.stdout.trim() === `${top.stdout.trim()}/.git` ? "main" : "linked";
}

// `git`: the shipped checkout() answer. `jj`: the space's first terminal
// folder when it is in a jj repository, else null. `linked`: a terminal of
// the space is in a linked jj workspace.
function items(p, git, jj, linked) {
  p = p ?? {};
  const tg = p.target ?? {};
  switch (p.tab) {
    case "pane": {
      // A kept sub-agent can go back under its parent, still running.
      const all = terminals();
      const term = all.find((t) => t.address === tg.terminal);
      const parent = term?.parent && all.find((t) => t.address === term.parent);
      // Once they go to the program, Shift+right-click still opens this menu.
      const toProgram = term?.labels?.["herdr.right-click"] === "program";
      // A terminal shown outside a tab (a layout terminal block, a window) has
      // no pane to split, zoom or close: its pane is the block's id.
      const inTab = panes().some((pane) => pane.pane === tg.pane);
      return [
        ...(inTab
          ? [
              ["Split right", "pane.split", { direction: "right", pane: tg.pane }],
              ["Split down", "pane.split", { direction: "down", pane: tg.pane }],
              ["Zoom", "pane.zoom", { pane: tg.pane }],
            ]
          : []),
        ...(term
          ? [
              toProgram
                ? ["Use Herdr right-click menu", "terminal.right_click", { terminal: term.address, to: "menu" }]
                : ["Send right-clicks to pane", "terminal.right_click", { terminal: term.address, to: "program" }],
            ]
          : []),
        ...(parent ? [[`Send back to ${parent.name || parent.address}`, "terminal.park", { terminal: term.address }]] : []),
        ...(inTab ? [["Close pane", "pane.close", { pane: tg.pane }]] : []),
      ];
    }
    case "tab":
      return [
        ["Rename", "tab.rename", { id: tg.id }],
        ["New tab", "tab.new", { space: tg.space }],
        ...(linked ? [["Finish jj workspace", "jj-workspace", { space: tg.space, tab: tg.id, action: "finish" }]] : []),
        ["Close", "tab.close", { id: tg.id }],
      ];
    case "space":
      return [
        ["Rename", "space.rename", { id: tg.id }],
        ...(jj ? [["New jj workspace", "jj-workspace", { space: tg.id, folder: jj, action: "new" }], ["Open jj workspace", "jj-workspace", { space: tg.id, folder: jj, action: "open" }]] : []),
        ...(jj && linked ? [["Finish jj workspace", "jj-workspace", { space: tg.id, folder: jj, action: "finish" }]] : []),
        ...(git && !jj ? [["New worktree", "worktree", { space: tg.id, action: "new" }], ["Open worktree", "worktree", { space: tg.id, action: "open" }]] : []),
        ...(git === "linked" && !jj ? [["Remove worktree", "worktree", { space: tg.id, action: "remove" }]] : []),
        ["Close", "space.close", { id: tg.id }],
      ];
    default:
      return [
        ["New space", "space.new", {}],
        ["Keybinds", "app.help", {}],
        ["Theme: graphite", "app.theme", { name: "graphite" }],
        ["Theme: ink", "app.theme", { name: "ink" }],
        ["Theme: moss", "app.theme", { name: "moss" }],
        ["Theme: atom one dark", "app.theme", { name: "atom-one-dark" }],
      ];
  }
}

function menuIcon(command) {
  const name = command.endsWith(".close") ? "x" : command.endsWith(".rename") ? "square-pen" : command.endsWith(".new") ? "plus" : command === "worktree" || command === "jj-workspace" ? "git-branch" : command === "app.help" ? "terminal" : command === "app.theme" ? "settings" : command === "pane.split" ? "panel-right" : command === "pane.zoom" ? "square" : "terminal";
  return `mods/workspace-chrome/${name}.svg`;
}

// The key bound to a command, for the hint on the right.
function shortcut(name, args) {
  // `pane.split:right` binds pane.split with { direction: "right" }.
  const value = args && Object.values(args)[0];
  const k = keys().find((b) => b.section === "global" && (b.action === name || b.action === `${name}:${value}`));
  return k ? k.keys : "";
}

export default class Menu extends View {
  init(_props, cx) {
    this.at = 0;
    this.git = null;
    this.jj = null;
    this.linked = false;
    this.handle = cx.focus_handle();
    this.handle.focus();
    const p = props();
    if (p?.tab === "space") {
      const space = spaces().find((s) => s.id === p.target?.id);
      const allPanes = panes();
      const dirs = space ? folders(space, allPanes) : [];
      if (dirs.length)
        cx.spawn(async (cx) => {
          const tabs = new Set((space.tabs ?? []).map((c) => c.id));
          const termDirs = new Set(allPanes.filter((x) => tabs.has(x.tab) && x.terminal && x.cwd).map((x) => x.cwd));
          const primary = place(space);
          const results = await Promise.all(dirs.map(async (dir) => ({ dir, id: await identity(dir, space.machine, { exec, readTextFile }) })));
          let anyError = false;
          for (const { dir, id } of results) {
            if (id.error) { anyError = true; console.log(`jj-menu: ${dir}: ${id.message}`); }
            if (id.jj && (!this.jj || dir === primary)) this.jj = dir;
            if (id.linked && termDirs.has(dir)) this.linked = true;
          }
          if (!this.jj && !anyError && primary) this.git = await checkout(primary, space.machine).catch(() => null);
          cx.notify();
        });
    } else if (p?.tab === "tab") {
      const space = spaces().find((s) => s.id === p.target?.space);
      const tabDirs = [...new Set(panes().filter((x) => x.tab === p.target?.id && x.terminal && x.cwd).map((x) => x.cwd))];
      if (tabDirs.length)
        cx.spawn(async (cx) => {
          const results = await Promise.all(tabDirs.map(async (dir) => ({ dir, id: await identity(dir, space?.machine, { exec, readTextFile }) })));
          for (const { dir, id } of results) {
            if (id.error) console.log(`jj-menu: ${dir}: ${id.message}`);
            if (id.linked) this.linked = true;
          }
          cx.notify();
        });
    }
  }

  choose(i, cx) {
    const it = items(props(), this.git, this.jj, this.linked)[i];
    if (!it) return;
    closeOverlay(props()?.overlay);
    if (it[1] === "jj-workspace" && it[2].action === "finish") openOverlay({ mod: "jj-workspace", kind: "window", width: 520, height: 360, props: it[2] });
    else if (it[1] === "jj-workspace") openOverlay({ mod: "jj-workspace", kind: "dialog", width: 560, height: 480, props: it[2] });
    else if (it[1] === "worktree") openOverlay({ mod: "worktree", kind: "dialog", ...(it[2].action === "open" ? { width: 560, height: 480 } : { width: 440, height: 260 }), props: it[2] });
    else run(it[1], it[2]);
  }

  render(cx) {
    const t = theme();
    const list = items(props(), this.git, this.jj, this.linked);
    return v_flex()
      .id("menu")
      .track_focus(this.handle)
      .w_full()
      .min_h(0)
      .p(5)
      .bg(t.popover)
      .text_size(12.8)
      .on_key_down((e, cx) => {
        if (e.key === "down") this.at = (this.at + 1) % list.length;
        else if (e.key === "up") this.at = (this.at + list.length - 1) % list.length;
        else if (e.key === "enter") this.choose(this.at, cx);
        else if (e.key === "escape") closeOverlay(props().overlay);
        else return;
        cx.notify();
      })
      .children(
        list.map((it, i) =>
          v_flex()
            .when(i > 0 && (it[1].endsWith(".close") || it[1] === "app.help" || (it[1] === "app.theme" && list[i - 1][1] !== "app.theme")), el => el.child(div().mx(7).my(4).h(1).bg(t.border)))
            .child(h_flex()
            .id(`mi-${i}`)
            .h(31)
            .px(8)
            .gap(9)
            .rounded(7)
            .items_center()
            .justify_between()
            .text_color(t.foreground)
            .when(i === this.at, (el) => el.bg(t.selected))
            .hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => this.choose(i, cx))
            .child(svg(menuIcon(it[1])).size(14).flex_none().text_color(t.muted))
            .child(div().flex_1().child(it[0]))
            .child(div().text_size(11).text_color(t.dim).child(shortcut(it[1], it[2])))),
        ),
      );
  }
}
