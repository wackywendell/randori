# Design: Layout-Driven Panel and Menu Composition in Randori

- **Author**: Wendell Smith
- **Date**: 2026-11-15
- **Status**: Draft

## The Problem

`randori` ships six `herdr-app` mods (`jj-spaces`, `jj-changes`, `jj-tabs`, `jj-menu`, `jj-new-menu`, `jj-workspace`) and a reference layout. In `herdr-app`, users customize their workspace by combining mods from Herdr's shipped set, personal dotfiles, and independent mod packages into a single layout JSON tree.

Today, three aspects of `randori` get in the way of clean, package-neutral composition:

1. **Reference layout named `jj-tui` instead of `jj`:**
   The repository's reference layout is currently named `layouts/jj-tui.json` (and `layouts/jj-tui.svg`), even though it has nothing to do with a TUI—it is simply Herdr's standard `main.json` layout with the `jj-*` mods enabled (`jj-spaces`, `jj-tabs`, `jj-changes`, `jj-menu`). Naming it `jj-tui` leaks personal dotfiles naming into the standalone `randori` package.
2. **Hardcoded `panel-body` buttons and allowlist in `jj-tabs`:**
   In `mods/jj-tabs/main.js`, the right-hand side panel toggle buttons are hardcoded to two specific IDs (`"files"` and `"changes"`) and gated on `shared("workspace.panels") ?? ["files", "changes"]`:
   ```js
   const enabled = shared("workspace.panels") ?? ["files", "changes"];
   this.syncPanel(space, panel, body, enabled);
   ...
   .when(enabled.includes("files"), el => el.child(panelButton("files", "Files", "mods/files/file.svg")))
   .when(enabled.includes("changes"), el => el.child(panelButton("changes", "Changes", "mods/changes/changes.svg")))
   ```
   Furthermore, Herdr's first-run welcome flow writes `"workspace.panels": ["files", "changes"]` into `shared.json`. As a consequence, when a user adds any other panel block to the `panel-body` stack in their layout JSON, `jj-tabs` refuses to render a button for it and `syncPanel` refuses to restore it when switching spaces. The user is forced to fork `jj-tabs` just to add a button for another panel.
3. **Hardcoded overlay menu mod names in `jj-tabs`:**
   The only difference between Herdr's stock `tabs` mod and `jj-tabs` is two string literals: `"jj-menu"` (for tab right-click) and `"jj-new-menu"` (for the `+` button). While the layout already sets `"terminal_menu": "jj-menu"` at the layout root, `jj-tabs` ignores `layout().terminal_menu` and `props()` and hardcodes both overlay mod names.

## Overview

Rename the standalone reference layout to `layouts/jj.json` and make `jj-tabs` layout-driven so that adding, removing, or reordering panels and menu mods in a layout JSON file requires zero JavaScript edits or forked tab-bar mods:

1. **Rename Reference Layout from `jj-tui` to `jj` and Drop `layouts/jj-tui.svg`:**
   Rename `layouts/jj-tui.json` to `layouts/jj.json`, delete `layouts/jj-tui.svg`, and omit the optional `"preview"` field (matching Herdr's shipped `main.json` so Herdr's Settings screen renders its native theme-aware layout wireframe) across the repository (`Justfile`, `README.md`, `scripts/app-trial.js`, `tests/mods.test.js`, and `design/`).
2. **Derive Panel Buttons from `panel-body` in `layout()`:**
   `jj-tabs` already inspects `const body = find(root, "panel-body")` on every render. Instead of hardcoding only `"files"` and `"changes"`, `jj-tabs` will inspect `body?.children ?? []`:
   - Built-in panel IDs (`"files"` and `"changes"`) keep their existing default labels (`"Files"`, `"Changes"`), icons (`"mods/files/file.svg"`, `"mods/changes/changes.svg"`), and `shared("workspace.panels")` toggle compatibility.
   - Any additional non-hidden block child in `panel-body` is automatically included in the enabled panel list and rendered as a `panelButton` in stack order, reading its display label from `child.content?.props?.label` (falling back to a capitalized `child.id`) and an optional `child.content?.props?.icon` (which may be an `.svg` asset path, a Unicode symbol/character, or omitted entirely).
3. **Respect Layout Menu Slots in `jj-tabs`:**
   Read the context-menu mod from `props()?.menu ?? root?.terminal_menu ?? "jj-menu"` and the new-tab menu mod from `props()?.newMenu ?? "jj-new-menu"`, preserving `layouts/jj.json`'s exact behavior by default while allowing layout authors to override either menu slot declaratively in JSON.
4. **Separate Mod Installation from Layout Installation:**
   Provide `just install-mods` alongside `just install` so users who maintain their own layout JSON in dotfiles can install or update `randori`'s `mods/jj-*` without copying reference layouts if desired.

## Goals

- Name `randori`'s reference layout `layouts/jj.json` (`"name": "jj"`), reflecting that it is Herdr's standard layout with `jj` mods enabled.
- Allow any layout using `jj-tabs` to mount additional panel mods in `panel-body` solely by adding a child block to the layout JSON. The open panel stays open as you switch spaces and tabs, as in Herdr's own tab bar, so no panel state is kept per space.
- Preserve 100% backward compatibility with Herdr's `shared("workspace.panels")` setting for the built-in `"files"` and `"changes"` panels.
- Keep `randori` completely agnostic of specific external mod packages; all composition happens through standard `herdr-app` layout nodes and block `props`.
- Maintain low complexity: ~15 lines of pure helper logic in `mods/jj-tabs/main.js`, covered by unit tests in `tests/mods.test.js`.

## Operating Assumptions, Failure Boundaries & Non-Goals

### Operating Assumptions

- **Runtime environment:** `herdr-app` 0.1.15+ running on macOS; `layout()` synchronously returns the active window's layout tree, including the `"panel-body"` stack node and its `children` array.
- **No cross-mod imports:** Mods cannot import code from sibling mod folders; discovery of panel metadata must read only from the layout tree (`layout()`), `props()`, and `shared()`.
- **Built-in panel preferences:** Herdr's Settings / Welcome UI manages `shared("workspace.panels")` as an array of built-in panel IDs (`["files", "changes"]`). Custom blocks explicitly placed into `panel-body` by a layout author are intended to be shown unless the block itself has `hidden: true`.

### Failure Boundaries

- **Missing `panel-body` or `panel` node in layout:** If a layout omits `panel` or `panel-body`, `jj-tabs` renders zero panel buttons and runs no layout command (existing behavior preserved).
- **Missing block `props`:** If a custom child in `panel-body` omits `content.props.label` or `content.props.icon`, `jj-tabs` falls back deterministically to capitalizing `child.id` and rendering the button without an icon (or rendering `icon` as a text/Unicode glyph if it does not end in `.svg`).

### Non-Goals

- Adding `herdr-app` layout inheritance, JSON templating, or build-time layout generators to `randori`.
- Changing `jj-spaces`, `jj-changes`, or `jj-workspace` behavior or VCS semantics.
- Referencing or coupling to any specific third-party mod name inside `randori`.

## Technical Plan

### 1. Reference Layout Rename (`layouts/jj-tui.json` → `layouts/jj.json`) & Preview Removal

Rename `layouts/jj-tui.json` to `layouts/jj.json` and delete `layouts/jj-tui.svg`:
- Remove `"preview": "layouts/jj-tui.svg"` from `layouts/jj.json` so `herdr-app`'s Settings view draws its built-in theme-aware layout preview (the same as `main.json`).
- Update `Justfile` (`install-mods` copies `mods/jj-*`; `install` runs `install-mods` and copies `layouts/jj.json`).
- Update `scripts/app-trial.js`, `tests/mods.test.js`, `README.md`, and `design/jj-workspace-lifecycle.md` to reference `layouts/jj.json` and `layout.switch '{"name":"jj"}'`.

### 2. Layout-Driven Panel Discovery in `mods/jj-tabs/main.js`

In `herdr-app`, the right-hand side panel is a `column` (`id: "panel"`) containing a `stack` (`id: "panel-body"`). Each panel view is a child `block` of `panel-body`:

```
panel (column, hidden: true/false)
└── panel-body (stack, active: "<id>")
    ├── { "id": "files",   "type": "block", "content": { "mod": "files" } }
    ├── { "id": "changes", "type": "block", "content": { "mod": "jj-changes" } }
    └── { "id": "<id>",    "type": "block", "content": { "mod": "<mod>", "props": { "label": "...", "icon": "..." } } }
```

Add a pure helper `panelItems(body, workspacePanels)` in `mods/jj-tabs/main.js`:

```js
const BUILTIN_PANELS = Object.freeze({
  __proto__: null,
  files: { label: "Files", icon: "mods/files/file.svg" },
  changes: { label: "Changes", icon: "mods/changes/changes.svg" },
});

function panelItems(body, enabledBuiltins = ["files", "changes"]) {
  if (!Array.isArray(body?.children) || body.children.length === 0) return [];
  const out = [];
  for (const child of body.children) {
    if (!child?.id || child.hidden) continue;
    const builtin = Object.hasOwn(BUILTIN_PANELS, child.id) ? BUILTIN_PANELS[child.id] : null;
    if (builtin && !enabledBuiltins.includes(child.id)) continue;
    const itemProps = child.content?.props ?? {};
    const label =
      typeof itemProps.label === "string" && itemProps.label.trim()
        ? itemProps.label.trim()
        : builtin?.label ?? child.id.charAt(0).toUpperCase() + child.id.slice(1);
    const icon =
      typeof itemProps.icon === "string" && itemProps.icon.trim()
        ? itemProps.icon.trim()
        : builtin?.icon ?? null;
    out.push({ id: child.id, label, icon });
  }
  return out;
}
```

During `Tabs.render()`:
1. Compute `const panels = panel && body ? panelItems(body, shared("workspace.panels") ?? ["files", "changes"]) : [];`.
2. In `panelButton(id, label, icon)`, render `svg(icon).size(14)` when `icon` ends with `".svg"`, render `div().text_size(12).child(icon)` when `icon` is a non-empty symbol/glyph string, and omit the icon child when `icon` is `null`. Render `.children(panels.map(p => panelButton(p.id, p.label, p.icon)))` after the `+` new-tab button.

When `body.children` contains only `files` and `changes` (as in `layouts/jj.json`), `panelItems` produces the exact same two buttons and respects `shared("workspace.panels")`. When a layout adds another block to `panel-body`, `jj-tabs` automatically renders its toggle button in the order declared in `panel-body.children`.

### 3. Layout-Driven Menu Slots in `mods/jj-tabs/main.js`

Instead of hardcoding `"jj-menu"` and `"jj-new-menu"` in `Tabs.render()`:
- Resolve `const menuMod = props()?.menu ?? root?.terminal_menu ?? "jj-menu";` for tab right-click context menus.
- Resolve `const newMenuMod = props()?.newMenu ?? "jj-new-menu";` for the `+` new-tab button.

In `layouts/jj.json`, both default to `"jj-menu"` and `"jj-new-menu"` with zero config changes, while allowing custom layouts to override either mod via layout JSON.


## Alternatives Considered

### 1. Require Users to Add Custom Panel IDs to `shared("workspace.panels")`
- **Mechanism:** Gate every child of `panel-body` (including non-built-in panels) on `shared("workspace.panels").includes(child.id)`, requiring users to manually edit `~/.config/herdr-app/shared.json` whenever they add a panel block to their layout JSON.
- **Rejected by author:** Herdr's first-run Welcome screen initializes `shared("workspace.panels")` to `["files", "changes"]` and provides no UI for adding third-party panel IDs. Requiring a separate hidden state edit in `shared.json` after already declaring the block in `panel-body` is a footgun; only the built-in `"files"` and `"changes"` panels should be filtered by `shared("workspace.panels")`, while custom blocks declared in `panel-body` are enabled by their presence in the layout (unless `child.hidden` is true).

### 2. Hardcode Known Third-Party Panel Names inside `jj-tabs`
- **Mechanism:** Add explicit `.when(enabled.includes("<other-mod>"), ...)` lines inside `mods/jj-tabs/main.js` for specific external mod packages.
- **Rejected by author:** Couples `randori` to specific external repositories and requires modifying `randori` whenever any new panel mod is created. Reading `panel-body.children` and each block's `content.props.{label,icon}` makes `jj-tabs` open to any panel mod without naming it in `randori`.

### 3. Build a Layout-Merging Generator Script Instead of Layout-Driven Discovery
- **Mechanism:** Keep `jj-tabs` static and provide a build script that merges partial layout fragments and generates a custom `jj-tabs` mod per user.
- **Rejected by author:** Adds build-time machinery and generated code for something `jj-tabs` can compute in ~15 lines at render time from `layout()`, which it already reads on every frame.


## Detailed Implementation

1. **Rename `./layouts/jj-tui.json` → `./layouts/jj.json` and delete `./layouts/jj-tui.svg`**:
   - **What changes:** Rename `./layouts/jj-tui.json` to `./layouts/jj.json`, remove its `"preview"` field, and delete `./layouts/jj-tui.svg`.
   - **Why:** Names the reference layout for what it is—Herdr's standard layout with `jj` mods enabled—and lets Herdr's Settings screen render its native theme-aware wireframe preview instead of maintaining a static dark-mode SVG.

2. **Modify `./mods/jj-tabs/main.js`**:
   - **What changes:**
     - Add `panelItems(body, enabledBuiltins)` (and export it for direct unit testing) to derive the active layout's panel list from `body?.children ?? []`: filtering built-in `"files"` and `"changes"` against `shared("workspace.panels") ?? ["files", "changes"]`, automatically including any additional non-hidden child block in `panel-body`, and reading `child.content?.props?.label` (fallback: capitalized `child.id`) and optional `child.content?.props?.icon` (`.svg` asset path, Unicode symbol string, or `null`).
     - Render `.children(panels.map(p => panelButton(p.id, p.label, p.icon)))`.
     - Keep no per-space panel memory. Switching spaces or tabs runs no `layout.show`, `layout.hide` or `layout.select`, so whichever panel is open stays open, as in Herdr.
     - Resolve the right-click context menu mod via `props()?.menu ?? root?.terminal_menu ?? "jj-menu"` and the `+` new-tab menu mod via `props()?.newMenu ?? "jj-new-menu"`.
   - **Why:** Allows any layout using `jj-tabs` to add, remove, or reorder panel mods in `panel-body` and customize menu mods purely through layout JSON without forking `jj-tabs`.

3. **Modify `./Justfile`**:
   - **What changes:** Add `install-mods` (copies `mods/jj-*` into `${HERDR_APP_HOME:-$HOME/.config/herdr-app}/mods/`) and update `install` to depend on `install-mods` and copy `layouts/jj.json` into `${HERDR_APP_HOME:-$HOME/.config/herdr-app}/layouts/`.
   - **Why:** Updates `install` for the `layouts/jj.*` rename and allows users with custom dotfiles layouts to install only the `jj-*` mods via `just install-mods`.

4. **Modify `./tests/mods.test.js` and `./scripts/app-trial.js`**:
   - **What changes:**
     - Update layout path references in `./tests/mods.test.js` and `./scripts/app-trial.js` from `layouts/jj-tui.json` / `jj-tui` to `layouts/jj.json` / `jj`.
     - Add unit tests in `./tests/mods.test.js` verifying that `jj-tabs` renders custom `panel-body` child blocks with their `props.label` and `props.icon`, runs no layout command when switching spaces, and respects `terminal_menu` / `props().newMenu` overrides.
   - **Why:** Verifies backward compatibility with `layouts/jj.json` and tests layout-driven composition with third-party panels and menus.

5. **Modify `./README.md` and `./design/jj-workspace-lifecycle.md`**:
   - **What changes:** Update references from `jj-tui` to `jj` (`layouts/jj.json`), document `just install-mods`, and document how `jj-tabs` discovers additional `panel-body` stack blocks (`id`, `props.label`, `props.icon`) and menu mod slots in custom layouts.
   - **Why:** Keeps user and contributor documentation accurate after the layout rename and `jj-tabs` generalization.
