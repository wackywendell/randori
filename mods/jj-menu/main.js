// Context menus (Herdr's items). Opened as a popup with
// props { tab: "pane" | "tab" | "space" | "global", target }.
// ↑/↓ move, Enter runs, Esc closes. An item is [key, label, command, args].
//
// A copy of Herdr's `menu`. A jj space gets jj workspace…, which opens
// `jj-workspace`, where the shipped menu shows its worktree entries.
// Finish jj workspace shows on spaces and tabs when a terminal is in a linked
// jj workspace, opening `jj-finish`.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import {
  run,
  props,
  closeOverlay,
  openOverlay,
  theme,
  keys,
  terminals,
  spaces,
  panes,
  exec,
  readTextFile,
  checking,
} from "herdr";
import { identity, spaceFolders, spacePlace, tabOrderedPanes } from "./jj.js";

// A space's Git checkout: "main" (a repo's own), "linked" (a worktree), or null.
async function checkout(folder, on) {
  const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: folder, on });
  const common = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: folder, on });
  if (top.code !== 0 || common.code !== 0) return null;
  return common.stdout.trim() === `${top.stdout.trim()}/.git` ? "main" : "linked";
}

// Each item: [key, label, command, args]. Stable keys ensure async jj rows
// splicing above Close never shift the user's highlight.
function items(p, git, jj, linked) {
  p = p ?? {};
  const tg = p.target ?? {};
  switch (p.tab) {
    case "pane": {
      const all = terminals();
      const term = all.find((t) => t.address === tg.terminal);
      const parent = term?.parent && all.find((t) => t.address === term.parent);
      const toProgram = term?.labels?.["herdr.right-click"] === "program";
      const inTab = panes().some((pane) => pane.pane === tg.pane);
      return [
        ...(inTab
          ? [
              ["split-right", "Split right", "pane.split", { direction: "right", pane: tg.pane }],
              ["split-down", "Split down", "pane.split", { direction: "down", pane: tg.pane }],
              ["zoom", "Zoom", "pane.zoom", { pane: tg.pane }],
            ]
          : []),
        ...(term
          ? [
              toProgram
                ? ["rc-menu", "Use Herdr right-click menu", "terminal.right_click", { terminal: term.address, to: "menu" }]
                : ["rc-program", "Send right-clicks to pane", "terminal.right_click", { terminal: term.address, to: "program" }],
            ]
          : []),
        ...(parent ? [["park", `Send back to ${parent.name || parent.address}`, "terminal.park", { terminal: term.address }]] : []),
        ...(inTab ? [["close", "Close pane", "pane.close", { pane: tg.pane }]] : []),
      ];
    }
    case "tab":
      return [
        ["rename", "Rename", "tab.rename", { id: tg.id }],
        ["new", "New tab", "tab.new", { space: tg.space }],
        ...(linked ? [["jj-finish", "Finish jj workspace", "jj-finish", { space: tg.space, tab: tg.id }]] : []),
        ["close", "Close", "tab.close", { id: tg.id }],
      ];
    case "space":
      return [
        ["rename", "Rename", "space.rename", { id: tg.id }],
        ...(jj ? [["jj-workspace", "jj workspace\u2026", "jj-workspace", { space: tg.id }]] : []),
        ...(jj && linked ? [["jj-finish", "Finish jj workspace", "jj-finish", { space: tg.id }]] : []),
        ...(git && !jj
          ? [
              ["wt-new", "New worktree", "worktree", { space: tg.id, action: "new" }],
              ["wt-open", "Open worktree", "worktree", { space: tg.id, action: "open" }],
            ]
          : []),
        ...(git === "linked" && !jj ? [["wt-remove", "Remove worktree", "worktree", { space: tg.id, action: "remove" }]] : []),
        ["close", "Close", "space.close", { id: tg.id }],
      ];
    default:
      return [
        ["new-space", "New space", "space.new", {}],
        ["help", "Keybinds", "app.help", {}],
        ["theme-graphite", "Theme: graphite", "app.theme", { name: "graphite" }],
        ["theme-ink", "Theme: ink", "app.theme", { name: "ink" }],
        ["theme-moss", "Theme: moss", "app.theme", { name: "moss" }],
        ["theme-atom", "Theme: atom one dark", "app.theme", { name: "atom-one-dark" }],
      ];
  }
}

function menuIcon(command) {
  const name = command.endsWith(".close")
    ? "x"
    : command.endsWith(".rename")
      ? "square-pen"
      : command.endsWith(".new")
        ? "plus"
        : command === "worktree" || command === "jj-workspace" || command === "jj-finish"
          ? "git-branch"
          : command === "app.help"
            ? "terminal"
            : command === "app.theme"
              ? "settings"
              : command === "pane.split"
                ? "panel-right"
                : command === "pane.zoom"
                  ? "square"
                  : "terminal";
  return `mods/workspace-chrome/${name}.svg`;
}

// The key bound to a command, for the hint on the right.
function shortcut(name, args) {
  if (name === "jj-workspace") {
    const k = keys().find((b) => b.section === "global" && b.action === "mod.open:jj-workspace");
    return k ? k.keys : "";
  }
  const value = args && Object.values(args)[0];
  const k = keys().find((b) => b.section === "global" && (b.action === name || b.action === `${name}:${value}`));
  return k ? k.keys : "";
}

export default class Menu extends View {
  init(_props, cx) {
    this.cfg = props() ?? {};
    this.closed = false;
    this.selectedKey = null;
    this.git = null;
    this.jj = null;
    this.linked = false;
    this.handle = cx.focus_handle();
    this.handle.focus();

    if (checking()) return;

    const p = this.cfg;
    if (p.tab === "space") {
      const space = spaces().find((s) => s.id === p.target?.id);
      const allPanes = panes();
      const dirs = space ? spaceFolders(space, allPanes) : [];
      if (dirs.length) {
        cx.spawn(async (cx) => {
          const ordered = tabOrderedPanes(space, allPanes);
          const termDirs = new Set(ordered.filter((x) => x.terminal && x.cwd).map((x) => x.cwd));
          const primary = spacePlace(space, allPanes);
          const results = await Promise.all(
            dirs.map(async (dir) => ({ dir, id: await identity(dir, space.machine, { exec, readTextFile }) })),
          );
          if (this.closed) return;
          let anyError = false;
          for (const { dir, id } of results) {
            if (id.error) { anyError = true; console.log(`jj-menu: ${dir}: ${id.message}`); }
            if (id.jj && (!this.jj || dir === primary)) this.jj = dir;
            if (id.linked && termDirs.has(dir)) this.linked = true;
          }
          if (!this.jj && !anyError && primary) {
            this.git = await checkout(primary, space.machine).catch(() => null);
            if (this.closed) return;
          }
          cx.notify();
        });
      }
    } else if (p.tab === "tab") {
      const space = spaces().find((s) => s.id === p.target?.space);
      const tabDirs = [...new Set(panes().filter((x) => x.tab === p.target?.id && x.terminal && x.cwd).map((x) => x.cwd))];
      if (tabDirs.length) {
        cx.spawn(async (cx) => {
          const results = await Promise.all(
            tabDirs.map(async (dir) => ({ dir, id: await identity(dir, space?.machine, { exec, readTextFile }) })),
          );
          if (this.closed) return;
          for (const { dir, id } of results) {
            if (id.error) console.log(`jj-menu: ${dir}: ${id.message}`);
            if (id.linked) this.linked = true;
          }
          cx.notify();
        });
      }
    }
  }

  close() {
    this.closed = true;
  }

  dismiss() {
    if (this.closed) return;
    if (this.cfg.overlay) closeOverlay(this.cfg.overlay);
  }

  choose(it) {
    if (!it) return;
    const [, , command, args] = it;
    this.dismiss();
    if (command === "jj-finish") {
      openOverlay({ mod: "jj-finish", kind: "window", key: "jj-finish", width: 520, height: 360, props: args });
    } else if (command === "jj-workspace") {
      openOverlay({ mod: "jj-workspace", kind: "dialog", width: 560, height: 480, props: args });
    } else if (command === "worktree") {
      openOverlay({
        mod: "worktree",
        kind: "dialog",
        ...(args.action === "open" ? { width: 560, height: 480 } : { width: 440, height: 260 }),
        props: args,
      });
    } else {
      run(command, args);
    }
  }

  render(cx) {
    const t = theme();
    const list = items(this.cfg, this.git, this.jj, this.linked);
    const activeIdx = this.selectedKey ? list.findIndex((it) => it[0] === this.selectedKey) : -1;
    const idx = activeIdx >= 0 ? activeIdx : list.length > 0 ? 0 : -1;
    const activeKey = idx >= 0 ? list[idx][0] : null;

    return v_flex()
      .id("menu")
      .track_focus(this.handle)
      .w_full()
      .min_h(0)
      .p(5)
      .bg(t.popover)
      .text_size(12.8)
      .on_key_down((e, cx) => {
        const mod = e.modifiers ?? {};
        if (mod.control || mod.alt || mod.platform || mod.shift) return;
        if (e.key === "escape") {
          cx.stop_propagation();
          this.dismiss();
          return;
        }
        if (list.length === 0) return;
        if (e.key === "down") {
          this.selectedKey = list[(idx + 1) % list.length][0];
        } else if (e.key === "up") {
          this.selectedKey = list[(idx - 1 + list.length) % list.length][0];
        } else if (e.key === "enter") {
          this.choose(list[idx]);
          return;
        } else {
          return;
        }
        cx.notify();
      })
      .children(
        list.map((it, i) => {
          const [key, label, command, args] = it;
          return v_flex()
            .when(
              i > 0 &&
                (command.endsWith(".close") ||
                  command === "app.help" ||
                  (command === "app.theme" && list[i - 1][2] !== "app.theme")),
              (el) => el.child(div().mx(7).my(4).h(1).bg(t.border)),
            )
            .child(
              h_flex()
                .id(`mi-${key}`)
                .h(31)
                .px(8)
                .gap(9)
                .rounded(7)
                .items_center()
                .justify_between()
                .text_color(t.foreground)
                .when(key === activeKey, (el) => el.bg(t.selected))
                .hover((s) => s.bg(t.hover))
                .on_click(() => this.choose(it))
                .child(svg(menuIcon(command)).size(14).flex_none().text_color(t.muted))
                .child(div().flex_1().child(label))
                .child(div().text_size(11).text_color(t.dim).child(shortcut(command, args))),
            );
        }),
      );
  }
}
