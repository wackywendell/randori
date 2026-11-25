// Unified filter-first jj workspace dialog (`jj-workspace`).
// One overlay for opening existing workspaces and creating new ones across the
// target space, other spaces, and disk repositories.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Input, InputState, ScrollHandle, Scrollbar } from "gpui-base";
import {
  run,
  props,
  closeOverlay,
  theme,
  spaces,
  panes,
  shared,
  home,
  exec,
  notify,
  checking,
} from "herdr";
import { joinPath } from "./jj.js";
import {
  tilde,
  inside,
  folders,
  miseFile,
  repoInitial,
  resolveWorktreePath,
  validateLink,
  parseProps,
  shouldAutoCompleteSlash,
  buildItems,
  resolveSelection,
  computeGhost,
  placement,
  whereOpen,
} from "./core.js";
import {
  ok,
  jj,
  readSettings,
  resolveTargetSpace,
  resolveFocusFolder,
  RepoDiscovery,
} from "./discovery.js";

export { miseFile };

const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };
const PALETTE = ["ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1"];

function repoColor(t, repo, spaceList, paneList) {
  const colors = shared("space.colors") ?? {};
  const sid = repo.spaceId
    || spaceList.find((s) => (s.machine ?? null) === (repo.on ?? null) && folders(s, paneList).some((f) => inside(f, repo.main)))?.id;
  const pick = sid && colors[sid];
  if (pick) return pick.startsWith("#") ? pick : (MARK[pick] ?? t[pick] ?? t.accent);
  let hash = 0;
  for (const ch of repo.name || "?") hash = ((hash * 31) + ch.charCodeAt(0)) | 0;
  const c = PALETTE[Math.abs(hash) % PALETTE.length];
  return MARK[c] ?? t.accent;
}

export default class Workspace extends View {
  init(_props, cx) {
    this.cfg = parseProps(props());
    this.closed = false;
    this.loaded = false;
    this.creating = false;
    this.space = null;
    this.focusDir = null;
    this.text = "";
    this.settingText = false;
    this.selectedKey = null;
    this.spaceError = "";
    this.actionError = "";
    this.scroll = ScrollHandle.new();

    this.discovery = new RepoDiscovery({
      isClosed: () => this.closed,
      onUpdate: () => { if (!this.closed) cx.notify(); },
      onSpaceError: (msg) => { if (!this.spaceError) this.spaceError = msg; },
    });

    this.handle = cx.focus_handle();
    this.input = InputState.new({ value: this.text, placeholder: "Name or repo/name" });
    this.input.focus();

    this.input.on("change", (_e, cx) => {
      if (this.settingText || this.closed) return;
      const prev = this.text;
      const next = this.input.value() ?? "";
      this.actionError = "";
      const prevCur = this.current();
      this.text = next;
      const autoRepo = shouldAutoCompleteSlash({
        prevText: prev,
        nextText: next,
        prevCurrent: prevCur,
        repos: this.repos,
      });
      if (autoRepo) {
        this.completeRepo(autoRepo, cx);
        return;
      }
      this.scrollToSelection();
      cx.notify();
    });

    // Sole Enter owner (matches Herdr's shipped `picker`). GPUI bubbles Enter
    // to `#worktree`'s `on_key_down` after QuickJS drains microtasks, so `key()`
    // intentionally does not handle Enter.
    this.input.on("submit", (e, cx) => {
      if (this.closed || this.creating) return;
      const shift = Boolean(e?.shift);
      const entry = this.current();
      if (!entry) return;
      this.activate(entry, shift, cx);
    });

    if (checking()) return;
    cx.spawn(async (cx) => this.load(cx));
  }

  get ready() {
    return this.loaded;
  }

  get busy() {
    return this.creating;
  }

  get repos() {
    return this.discovery.repos;
  }

  get error() {
    return this.actionError || this.spaceError;
  }

  set error(v) {
    this.actionError = v ?? "";
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    closeOverlay(this.cfg.overlay);
  }

  async load(cx) {
    try {
      this.space = resolveTargetSpace(this.cfg);
      this.focusDir = resolveFocusFolder(this.cfg, this.space);
      await this.discovery.loadInitial(this.space, this.focusDir);
      if (this.closed) return;
    } catch (e) {
      if (this.closed) return;
      this.spaceError = e?.message ?? String(e);
      console.log(`jj-workspace: ${this.spaceError}`);
    }
    this.loaded = true;
    cx.notify();
    cx.spawn(async () => this.discovery.loadBackground(this.space));
  }

  items() {
    return buildItems({
      repos: this.repos,
      text: this.text,
      loadingBg: this.discovery.loadingBg,
    });
  }

  picks(list = this.items()) {
    return list.filter((e) => e.kind === "ws" || e.kind === "create");
  }

  selectedIndex(p = this.picks()) {
    return resolveSelection(p, {
      selectedKey: this.selectedKey,
      text: this.text,
      focusKey: this.discovery.focusKey,
      focusRoot: this.discovery.focusRoot,
    });
  }

  current(p = this.picks()) {
    const i = this.selectedIndex(p);
    return i >= 0 ? p[i] : null;
  }

  ghost(cur = this.current()) {
    return computeGhost({ text: this.text, current: cur });
  }

  scrollToSelection(list = this.items()) {
    const cur = this.current(this.picks(list));
    if (!cur) return;
    const idx = list.findIndex((e) => e.key === cur.key);
    if (idx >= 0) this.scroll.scroll_to_item(idx);
  }

  setText(next, cx) {
    this.text = next;
    this.actionError = "";
    this.settingText = true;
    try {
      this.input.set_value(next);
      this.input.set_selected_range({ start: next.length, end: next.length });
    } finally {
      this.settingText = false;
    }
    this.input.focus();
    this.scrollToSelection();
    cx.notify();
  }

  completeRepo(r, cx) {
    this.setText(`${r.name}/`, cx);
  }

  placementCtx(settings = readSettings()) {
    return {
      text: this.text,
      spaceId: this.space?.id ?? null,
      spaceMachine: this.space?.machine ?? null,
      spaceName: this.space?.name ?? "",
      openIn: settings.openIn,
      spaces: spaces(),
      panes: panes(),
    };
  }

  cachedHomeOf(machine) {
    if (!machine) return home() || "";
    return this.discovery.homes.get(machine) ?? "";
  }

  planned(r, name = this.text.trim(), settings = readSettings(), rawName = false) {
    return resolveWorktreePath({
      template: settings.directory,
      repoMain: r.main,
      repoName: r.name,
      wsName: name,
      home: this.cachedHomeOf(r.on),
      rawName,
    }).path;
  }

  previewPath(r, name, settings = readSettings()) {
    const h = this.cachedHomeOf(r.on);
    return tilde(this.planned(r, name || "\u2026", settings, !name), h);
  }

  key(e, cx) {
    if (this.closed || this.creating) return;
    if (e.key === "escape") {
      this.close();
      return;
    }
    if (e.key === "up" || e.key === "down") {
      const list = this.items();
      const p = this.picks(list);
      if (!p.length) return;
      const cur = this.selectedIndex(p);
      const next = e.key === "down" ? (cur + 1) % p.length : (cur - 1 + p.length) % p.length;
      this.selectedKey = p[next].key;
      this.scrollToSelection(list);
      cx.notify();
      return;
    }
    if (e.key === "right") {
      const g = this.ghost();
      if (!g) return;
      const sel = this.input.selected_range?.();
      const atEnd = !sel || (sel.start === this.text.length && sel.end === this.text.length);
      if (!atEnd) return;
      this.completeRepo(g.repo, cx);
    }
  }

  activate(entry, shift, cx) {
    if (this.closed || this.creating) return;
    const act = placement(entry, shift, this.placementCtx());
    switch (act.kind) {
      case "none":
        return;
      case "complete":
        this.completeRepo(act.repo, cx);
        return;
      case "refuse":
        this.actionError = act.reason;
        cx.notify();
        return;
      case "switch":
        run("space.select", { id: act.loc.space.id });
        if (act.loc.tab && !act.loc.tab.active && (act.loc.space.tabs?.length ?? 0) > 1) {
          run("tab.select", { id: act.loc.tab.id });
        }
        this.close();
        return;
      case "tab":
        if (act.create) {
          cx.spawn(async (cx) => this.create(act.repo, act.name, "tab", cx));
        } else {
          run("tab.new", { space: this.space.id, folder: act.ws.path, name: act.name, ...(this.cfg.argv ? { argv: this.cfg.argv } : {}) });
          this.close();
        }
        return;
      case "space":
        if (act.create) {
          cx.spawn(async (cx) => this.create(act.repo, act.name, "space", cx));
        } else {
          run("space.new", { folder: act.ws.path, machine: act.repo.on ?? "", ...(this.cfg.argv ? { argv: this.cfg.argv } : {}) });
          this.close();
        }
        return;
    }
  }

  // Convenience entry point for app-trial.js: create the typed workspace name
  // in `r` using the current placement rules.
  async work(r, cx) {
    const name = this.text.trim();
    if (!name) return;
    const act = placement({ kind: "create", key: "", repo: r, name }, false, this.placementCtx());
    if (act.kind === "tab" || act.kind === "space") await this.create(r, name, act.kind, cx);
    else this.activate({ kind: "create", key: "", repo: r, name }, false, cx);
  }

  async create(r, name, mode, cx) {
    if (this.closed || this.creating) return;
    this.creating = true;
    this.actionError = "";
    cx.notify();
    try {
      const settings = readSettings();
      const userHome = await this.discovery.homeOf(r.on);
      if (this.closed) return;
      const resolved = resolveWorktreePath({
        template: settings.directory,
        repoMain: r.main,
        repoName: r.name,
        wsName: name,
        home: userHome,
      });
      if (resolved.unresolvedTilde) {
        throw new Error(`Could not resolve home directory${r.on ? ` on ${r.on}` : ""} for ${settings.directory}.`);
      }
      const dest = resolved.path;
      const parent = dest.slice(0, dest.lastIndexOf("/")) || "/";
      const mk = await exec("mkdir", ["-p", parent], { cwd: r.main, on: r.on, timeout: 10_000 });
      if (!ok(mk)) throw new Error(mk.stderr.trim() || `mkdir -p ${parent} exited ${mk.code}`);

      const addArgs = ["workspace", "add", `--name=${name}`];
      if (r.names?.has(name)) addArgs.push("-r", `"${name.replace(/["\\]/g, "\\$&")}"`);
      addArgs.push("--", dest);
      const add = await jj(r.main, r.on, addArgs, 60_000);
      if (!ok(add)) throw new Error(add.stderr.trim() || `jj workspace add exited ${add.code}`);

      const problems = [];
      const linkedMise = [];
      const links = Array.isArray(settings.links) ? settings.links : [];
      for (const rel of links) {
        if (!validateLink(rel)) {
          problems.push(`${rel}: invalid link path`);
          continue;
        }
        const src = joinPath(r.main, rel);
        const dst = joinPath(dest, rel);
        const srcExists =
          ok(await exec("test", ["-e", src], { cwd: r.main, on: r.on, timeout: 5_000 }).catch(() => null)) ||
          ok(await exec("test", ["-L", src], { cwd: r.main, on: r.on, timeout: 5_000 }).catch(() => null));
        if (!srcExists) continue;
        const dstExists =
          ok(await exec("test", ["-e", dst], { cwd: dest, on: r.on, timeout: 5_000 }).catch(() => null)) ||
          ok(await exec("test", ["-L", dst], { cwd: dest, on: r.on, timeout: 5_000 }).catch(() => null));
        if (dstExists) continue;
        const dstParent = dst.slice(0, dst.lastIndexOf("/")) || dest;
        if (dstParent !== dest) {
          const dmk = await exec("mkdir", ["-p", dstParent], { cwd: dest, on: r.on, timeout: 10_000 });
          if (!ok(dmk)) {
            problems.push(`${rel}: could not create folder (${dmk.stderr?.trim() || `exit ${dmk.code}`})`);
            continue;
          }
        }
        const lr = await exec("ln", ["-s", src, dst], { cwd: dest, on: r.on, timeout: 10_000 });
        if (!ok(lr)) problems.push(`${rel}: could not link (${lr.stderr?.trim() || `exit ${lr.code}`})`);
        else if (miseFile(rel)) linkedMise.push({ rel, dst });
      }

      if (settings.miseTrust !== false && linkedMise.length) {
        const hasMise = await exec("mise", ["--version"], { cwd: dest, on: r.on, timeout: 5_000 }).catch(() => null);
        if (ok(hasMise)) {
          for (const { rel, dst } of linkedMise) {
            const tr = await exec("mise", ["trust", dst], { cwd: dest, on: r.on, timeout: 10_000 }).catch((e) => ({ code: 1, stderr: e?.message ?? String(e) }));
            if (!ok(tr)) problems.push(`${rel}: mise trust failed (${tr.stderr?.trim() || `exit ${tr.code}`})`);
          }
        }
      }

      if (problems.length) {
        console.log(`jj-workspace: ${problems.join("; ")}`);
        notify({ title: "New jj workspace", body: problems.join("\n"), level: "warning" });
      }

      if (mode === "tab") {
        run("tab.new", { space: this.space.id, folder: dest, name, ...(this.cfg.argv ? { argv: this.cfg.argv } : {}) });
      } else {
        run("space.new", { folder: dest, machine: r.on ?? "", ...(this.cfg.argv ? { argv: this.cfg.argv } : {}) });
      }
      this.close();
    } catch (e) {
      this.actionError = e?.message ?? String(e);
      console.log(`jj-workspace: ${this.actionError}`);
    } finally {
      this.creating = false;
      if (!this.closed) cx.notify();
    }
  }

  render(cx) {
    const t = theme();
    const settings = readSettings();
    const spaceList = spaces();
    const paneList = panes();
    const list = this.items();
    const p = this.picks(list);
    const activePick = this.selectedIndex(p);
    const cur = activePick >= 0 ? p[activePick] : null;
    const ctx = this.placementCtx(settings);
    const remoteSpace = Boolean(this.space?.machine);

    const pill = (label, color, bg = null, bordered = false) =>
      div()
        .flex_none()
        .px(6)
        .py(1)
        .rounded(4)
        .text_size(10.5)
        .text_color(color)
        .when(Boolean(bg), (el) => el.bg(bg))
        .when(bordered, (el) => el.border(1).border_color(t.border))
        .child(label);

    const keycap = (label) =>
      div()
        .px(5)
        .py(1)
        .rounded(4)
        .bg(t.surface)
        .border(1)
        .border_color(t.border)
        .text_size(10.5)
        .text_color(t.muted)
        .child(label);

    let pickIndex = 0;
    const renderEntry = (entry) => {
      if (entry.kind === "divider") {
        return h_flex()
          .flex_none()
          .mt(8)
          .mb(2)
          .pt(8)
          .px(8)
          .border_t(1)
          .border_color(t.border)
          .items_center()
          .child(div().text_size(11).font_semibold().text_color(t.dim).child(entry.label));
      }
      if (entry.kind === "header") {
        const r = entry.repo;
        const userHome = this.cachedHomeOf(r.on);
        return h_flex()
          .flex_none()
          .px(8)
          .pt(8)
          .pb(3)
          .gap(8)
          .items_center()
          .child(
            h_flex()
              .size(18)
              .flex_none()
              .rounded(5)
              .bg(repoColor(t, r, spaceList, paneList))
              .items_center()
              .justify_center()
              .text_size(10.5)
              .font_bold()
              .text_color("#ffffff")
              .child(repoInitial(r.name)),
          )
          .child(div().flex_none().text_size(12).font_semibold().text_color(t.foreground).child(r.name))
          .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(tilde(r.main, userHome)))
          .when(Boolean(r.on || remoteSpace), (el) =>
            el.child(
              h_flex()
                .flex_none()
                .px(6)
                .py(1)
                .gap(4)
                .rounded(4)
                .bg(t.surface)
                .border(1)
                .border_color(t.border)
                .items_center()
                .text_size(10.5)
                .text_color(t.muted)
                .when(Boolean(r.on), (el) => el.child(svg("mods/workspace-chrome/server.svg").size(10).text_color(t.dim)))
                .child(r.on || "local"),
            ),
          );
      }
      if (entry.kind === "repo-error") {
        return div().flex_none().px(10).py(4).text_size(11.5).text_color(t.blocked).child(entry.repo.error);
      }
      if (entry.kind === "repo-loading") {
        return div().flex_none().px(10).py(4).text_size(11.5).text_color(t.dim).child("\u2026");
      }
      if (entry.kind === "disk-hint") {
        const noun = entry.count === 1 ? "other repository" : "other repositories";
        return h_flex()
          .flex_none()
          .mt(8)
          .pt(8)
          .px(10)
          .pb(4)
          .border_t(1)
          .border_color(t.border)
          .items_center()
          .text_size(11.5)
          .text_color(t.dim)
          .child(`Type to search ${entry.count} ${noun}`);
      }
      if (entry.kind === "looking") {
        return h_flex()
          .flex_none()
          .px(10)
          .py(8)
          .gap(6)
          .items_center()
          .text_size(11.5)
          .text_color(t.dim)
          .child(svg("mods/workspace-chrome/spinner.svg").size(11).text_color(t.dim).spin(900))
          .child("Loading repositories\u2026");
      }

      const i = pickIndex++;
      const on = i === activePick;

      if (entry.kind === "create") {
        const r = entry.repo;
        const name = entry.name || "";
        const hasBookmark = Boolean(name && r.names?.has(name));
        const label = name ? `New "${name}"` : "New workspace";
        return h_flex()
          .id(`wt-${i}`)
          .flex_none()
          .h(44)
          .pl(6)
          .pr(10)
          .gap(8)
          .items_center()
          .rounded(7)
          .cursor_pointer()
          .when(on, (el) => el.bg(t.selected))
          .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
          .on_click((e, cx) => {
            this.selectedKey = entry.key;
            this.input.focus();
            this.activate(entry, Boolean(e?.modifiers?.shift || e?.shift), cx);
          })
          .child(div().w(3).h(20).flex_none().rounded(2).when(on, (el) => el.bg(t.accent)))
          .child(
            h_flex()
              .size(20)
              .flex_none()
              .rounded(5)
              .bg(t.surface)
              .border(1)
              .border_color(t.border)
              .items_center()
              .justify_center()
              .child(svg("mods/workspace-chrome/plus.svg").size(11).text_color(name ? t.accent : t.muted)),
          )
          .child(
            v_flex()
              .flex_1()
              .min_w(0)
              .child(
                h_flex()
                  .gap(6)
                  .items_center()
                  .child(div().flex_1().min_w(0).truncate().text_color(name ? t.foreground : t.muted).child(label))
                  .when(hasBookmark, (el) => el.child(pill("bookmark", t.accent, t.surface))),
              )
              .child(div().truncate().text_size(11.5).text_color(t.dim).child(this.previewPath(r, name, settings))),
          );
      }

      // entry.kind === "ws"
      const { repo: r, ws: w } = entry;
      const userHome = this.cachedHomeOf(r.on);
      const found = w.path && whereOpen(spaceList, paneList, r.on, w.path);
      return h_flex()
        .id(`wt-${i}`)
        .flex_none()
        .h(44)
        .pl(6)
        .pr(10)
        .gap(8)
        .items_center()
        .rounded(7)
        .cursor_pointer()
        .when(on, (el) => el.bg(t.selected))
        .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
        .on_click((e, cx) => {
          this.selectedKey = entry.key;
          this.input.focus();
          this.activate(entry, Boolean(e?.modifiers?.shift || e?.shift), cx);
        })
        .child(div().w(3).h(20).flex_none().rounded(2).when(on, (el) => el.bg(t.accent)))
        .child(svg("mods/workspace-chrome/branch.svg").size(14).flex_none().text_color(found ? t.accent : t.dim))
        .child(
          v_flex()
            .flex_1()
            .min_w(0)
            .child(
              h_flex()
                .gap(6)
                .items_center()
                .child(div().flex_1().min_w(0).truncate().text_color(w.path ? t.foreground : t.dim).child(w.name))
                .when(w.main, (el) => el.child(pill("root", t.dim, null, true)))
                .when(!w.path, (el) => el.child(pill("unavailable", t.dim, null, true))),
            )
            .child(div().truncate().text_size(11.5).text_color(t.dim).child(w.path ? tilde(w.path, userHome) : "no recorded folder")),
        );
    };

    const spaceHome = this.cachedHomeOf(this.space?.machine ?? null);
    const bannerError = this.actionError || this.spaceError;
    const zeroNotice = this.loaded && !this.repos.length && !this.discovery.loadingBg && !bannerError
      ? `${this.focusDir ? tilde(this.focusDir, spaceHome) : "This folder"} is not in a jj repo.`
      : "";

    const renderFooter = () => {
      if (this.creating) {
        return h_flex()
          .items_center()
          .gap(6)
          .child(svg("mods/workspace-chrome/spinner.svg").size(11).text_color(t.dim).spin(900))
          .child("working\u2026");
      }
      if (!this.loaded || !cur) return div().child("esc close");
      const primary = placement(cur, false, ctx);
      const secondary = placement(cur, true, ctx);
      if (primary.kind === "none") return div().child(primary.label || "esc close");
      const footerItems = [h_flex().items_center().gap(4).child(keycap("\u21b5")).child(primary.label)];
      if (secondary.kind !== "none" && secondary.kind !== "refuse" && secondary.label && secondary.label !== primary.label) {
        footerItems.push(h_flex().items_center().gap(4).child(keycap("\u21e7\u21b5")).child(secondary.label));
      }
      return h_flex().items_center().gap(10).children(footerItems);
    };

    const g = this.ghost(cur);

    return v_flex()
      .id("worktree")
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .size_full()
      .p(16)
      .gap(10)
      .bg(t.popover)
      .border(1)
      .border_color(t.border)
      .rounded(10)
      .text_size(13)
      .child(
        h_flex()
          .items_center()
          .child(div().flex_1().text_size(14.5).font_semibold().text_color(t.foreground).child("jj workspace"))
          .child(
            div()
              .id("wt-esc")
              .px(6)
              .py(2)
              .rounded(5)
              .text_size(11)
              .text_color(t.dim)
              .cursor_pointer()
              .hover((s) => s.bg(t.hover).text_color(t.foreground))
              .on_click(() => { if (!this.busy) this.close(); })
              .child("Esc"),
          ),
      )
      .child(
        h_flex()
          .h(36)
          .flex_none()
          .px(10)
          .gap(8)
          .items_center()
          .rounded(9)
          .bg(t.background)
          .border(1)
          .border_color(t.accent)
          .child(svg("mods/workspace-chrome/search.svg").size(15).flex_none().text_color(t.dim))
          .child(
            div()
              .relative()
              .flex_1()
              .h_full()
              .min_w(0)
              .when(Boolean(g), (el) =>
                el.child(
                  h_flex()
                    .absolute()
                    .inset_0()
                    .items_center()
                    .overflow_hidden()
                    .text_size(12.8)
                    .child(div().flex_none().text_color("#00000000").child(this.text))
                    .child(div().flex_none().text_color(t.dim).child(g.suffix)),
                ),
              )
              .child(Input.new(this.input).size_full().text_size(12.8).text_color(t.foreground)),
          ),
      )
      .when(!this.loaded && !bannerError, (el) =>
        el.child(
          h_flex()
            .flex_none()
            .px(4)
            .gap(6)
            .items_center()
            .text_size(12)
            .text_color(t.muted)
            .child(svg("mods/workspace-chrome/spinner.svg").size(11).text_color(t.dim).spin(900))
            .child("Loading workspaces\u2026"),
        ),
      )
      .when(Boolean(bannerError), (el) => el.child(div().px(4).text_size(12).text_color(t.blocked).child(bannerError)))
      .when(Boolean(zeroNotice), (el) => el.child(div().px(4).text_size(12).text_color(t.muted).child(zeroNotice)))
      .child(
        div()
          .relative()
          .flex_1()
          .min_h(0)
          .child(
            v_flex()
              .id("wt-list")
              .size_full()
              .overflow_y_scroll()
              .track_scroll(this.scroll)
              .children(list.map(renderEntry)),
          )
          .child(Scrollbar.vertical("wt-list").absolute().inset_0()),
      )
      .child(
        h_flex()
          .flex_none()
          .pt(8)
          .border_t(1)
          .border_color(t.border)
          .items_center()
          .text_size(11)
          .text_color(t.dim)
          .child(div().flex_1().child(renderFooter()))
          .child(h_flex().items_center().gap(4).child(keycap("\u2191\u2193")).child("select")),
      );
  }
}
