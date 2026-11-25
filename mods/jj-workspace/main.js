// Unified jj workspace dialog matching Herdr's native picker visual language.
// - Non-selectable dim repository headers with compact single-line workspace
//   rows underneath (`default` with a `main` tag for the main checkout).
// - Flat Search filters workspaces across open spaces and reveals matching disk
//   repositories lazily on demand.
// - Typing `<exactRepo>/`, clicking a repo header, or choosing `+ New workspace
//   in <repo>…` locks a Repo Chip in the search bar; Backspace on an empty
//   query or clicking the chip returns to Flat Search.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Input, InputState, ScrollHandle, Scrollbar } from "gpui-base";
import {
  spaces,
  panes,
  props,
  theme,
  run,
  exec,
  closeOverlay,
  notify,
  checking,
} from "herdr";
import { tilde } from "./jj.js";
import {
  emptyModel,
  reduce,
  sortedRepos,
  resolveSlashChip,
  matchingIdleDiskRepos,
  project,
  planCreate,
  buildLinkScript,
} from "./core.js";
import { RepoDiscovery, readLayoutSettings, hasLocalBookmark } from "./discovery.js";

function parseCfg(raw) {
  const p = raw && typeof raw === "object" ? raw : {};
  return {
    overlay: p.overlay ?? null,
    spaceId: p.space ?? null,
    folder: p.folder ?? "",
    argv: Array.isArray(p.argv) ? p.argv : undefined,
    name: typeof p.name === "string" ? p.name : undefined,
  };
}

export default class Workspace extends View {
  init(_props, cx) {
    this.cfg = parseCfg(props());
    this.settings = readLayoutSettings();
    this.phase = "loading"; // "loading" | "ready" | "creating" | "closed"
    this.model = emptyModel();
    this.scopedRepoKey = null;
    this.selection = { mode: "auto" };
    this.lastQuery = "";
    this.actionError = "";
    this.vm = null;

    this.handle = cx.focus_handle();
    this.scroll = ScrollHandle.new();
    this.input = InputState.new({ placeholder: "Filter workspaces or name a new one…" });
    this.input.focus();

    this.input.on("change", (_e, cx) => {
      if (this.phase === "closed" || this.phase === "creating") return;
      this.actionError = "";
      const prevQuery = this.lastQuery;
      const prevCurrent = this.vm?.current ?? null;
      const nextQuery = this.input.value() || "";
      this.lastQuery = nextQuery;

      // Unconditional `/` rule while unscoped: `/` locks the highlighted row's
      // repository into a Repo Chip (bare `/`, `strea/`, `/feat/auth`, or pasted
      // `streams/fix`). Once scoped, `/` is an ordinary literal character.
      if (!this.scopedRepoKey) {
        const hit = resolveSlashChip(
          prevQuery,
          nextQuery,
          prevCurrent,
          this.vm?.focusedRepo ?? null,
          sortedRepos(this.model),
        );
        if (hit) {
          this.enterScope(hit.repo, cx, hit.rest);
          return;
        }
        // Lazily load workspaces only for disk repos matching the current search.
        for (const r of matchingIdleDiskRepos(this.model, nextQuery)) {
          cx.spawn(async () => this.discovery.ensureRepoLoaded(r));
        }
      }

      // Resolve implicit selection once per user edit; background discovery never moves it.
      const preview = this.computeVm(nextQuery, { mode: "auto" });
      if (nextQuery.trim()) {
        const first = preview.picks[0];
        this.selection = first ? { mode: "implicit", key: first.key } : { mode: "auto" };
      } else {
        this.selection = { mode: "auto" };
      }
      this.scrollToCurrent(preview);
      cx.notify();
    });

    this.input.on("submit", (e, cx) => {
      if (this.phase !== "ready") return;
      const shift = Boolean(e?.modifiers?.shift);
      this.activate(shift, cx);
    });

    this.discovery = new RepoDiscovery({
      isClosed: () => this.phase === "closed",
      dispatch: (ev) => {
        this.model = reduce(this.model, ev);
        if (ev.type === "TargetLoaded" && this.phase === "loading") {
          this.phase = "ready";
        }
        cx.notify();
      },
    });

    if (!checking()) {
      cx.spawn(async () => this.discovery.start(this.cfg, this.settings));
    }
  }

  get ready() {
    return this.phase === "ready";
  }

  get busy() {
    return this.phase === "creating";
  }

  // User-initiated dismissal. Never called from host close().
  dismiss() {
    if (this.phase === "closed") return;
    if (this.cfg.overlay) closeOverlay(this.cfg.overlay);
  }

  // Host teardown hook invoked by Herdr when the dialog closes.
  close() {
    this.phase = "closed";
  }

  computeVm(query = this.input.value() || "", selection = this.selection) {
    return project({
      model: this.model,
      query,
      scopedRepoKey: this.scopedRepoKey,
      selection,
      spaces: spaces(),
      panes: panes(),
      settings: this.settings,
    });
  }

  scrollToCurrent(vm = this.vm) {
    if (!vm?.current) return;
    const idx = vm.items.findIndex((it) => it.key === vm.current.key);
    if (idx >= 0) this.scroll.scroll_to_item(idx);
  }

  enterScope(repo, cx, initialQuery = "") {
    this.scopedRepoKey = repo.key;
    this.lastQuery = initialQuery;
    this.actionError = "";
    this.input.set_value(initialQuery);
    if (initialQuery.trim()) {
      const preview = this.computeVm(initialQuery, { mode: "auto" });
      const first = preview.picks[0];
      this.selection = first ? { mode: "implicit", key: first.key } : { mode: "auto" };
    } else {
      this.selection = { mode: "auto" };
    }
    this.input.focus();
    if (repo.load.state === "idle" || repo.load.state === "error") {
      cx.spawn(async () => this.discovery.ensureRepoLoaded(repo));
    }
    cx.notify();
  }

  clearScope(cx) {
    if (!this.scopedRepoKey) return;
    this.scopedRepoKey = null;
    this.selection = { mode: "auto" };
    this.lastQuery = this.input.value() || "";
    this.actionError = "";
    this.input.focus();
    cx.notify();
  }

  activate(shift, cx) {
    const vm = this.vm ?? this.computeVm();
    const item = vm.current;
    if (!item || this.phase !== "ready") return;

    // `+ New workspace in <repo>…` locks the Repo Chip so the user can type a name.
    if (item.kind === "create" && !item.name) {
      this.enterScope(item.repo, cx);
      return;
    }

    const plan = shift ? vm.secondary : vm.primary;
    if (!plan) return;
    if (plan.action === "refuse-tab") {
      this.actionError = plan.refuseReason;
      cx.notify();
      return;
    }

    if (item.kind === "ws") {
      this.openExisting(item, plan, cx);
      return;
    }
    if (item.kind === "create") {
      cx.spawn(async (cx) => this.create(item.repo, item.name, plan, cx));
    }
  }

  openExisting(item, plan, cx) {
    const { repo, ws } = item;
    if (!ws.path) {
      this.actionError = `jj did not report a path for workspace "${ws.name}".`;
      cx?.notify?.();
      return;
    }
    if (plan.action === "switch" && plan.open) {
      run("space.select", { id: plan.open.spaceId });
      if (plan.open.tabId) run("tab.select", { id: plan.open.tabId });
      this.dismiss();
      return;
    }
    const tabOrSpaceName = ws.main ? repo.name : ws.name;
    if (plan.action === "tab") {
      run("tab.new", {
        space: this.model.targetSpaceId,
        folder: ws.path,
        name: tabOrSpaceName,
        ...(this.cfg.argv ? { argv: this.cfg.argv } : {}),
      });
      this.dismiss();
      return;
    }
    run("space.new", {
      name: tabOrSpaceName,
      folder: ws.path,
      ...(repo.on ? { machine: repo.on } : {}),
      ...(this.cfg.argv ? { argv: this.cfg.argv } : {}),
    });
    this.dismiss();
  }

  async create(repo, name, plan, cx) {
    if (this.phase !== "ready") return;
    this.phase = "creating";
    this.actionError = "";
    cx.notify();

    try {
      const userHome = await this.discovery.ensureHome(repo.on);
      if (this.phase === "closed") return;

      const createPlan = planCreate({ repo, name, settings: this.settings, home: userHome });
      const existsBookmark = await hasLocalBookmark(repo.main, repo.on, createPlan.name);
      if (this.phase === "closed") return;

      const mk = await exec("mkdir", ["-p", createPlan.parent], { cwd: repo.main, on: repo.on, timeout: 10_000 });
      if (this.phase === "closed") return;
      if (mk.code !== 0) {
        throw new Error(mk.stderr.trim() || `mkdir -p ${createPlan.parent} exited ${mk.code}`);
      }

      const addArgs = ["workspace", "add", `--name=${createPlan.name}`];
      if (existsBookmark) addArgs.push("-r", createPlan.name);
      addArgs.push("--", createPlan.dest);
      const add = await exec("jj", addArgs, { cwd: repo.main, on: repo.on, timeout: 30_000 });
      if (this.phase === "closed") return;
      if (add.code !== 0) {
        throw new Error(add.stderr.trim() || `jj workspace add exited ${add.code}`);
      }

      // Single round-trip link + optional mise trust script.
      if (createPlan.links.length > 0 || createPlan.miseTrust) {
        const { script, args } = buildLinkScript(createPlan);
        const lr = await exec("sh", ["-c", script, "sh", ...args], {
          cwd: createPlan.dest,
          on: repo.on,
          timeout: 15_000,
        });
        if (this.phase === "closed") return;
        if (lr.code !== 0) {
          notify({
            title: `Workspace "${createPlan.name}" created with setup warning`,
            body: lr.stderr.trim() || `Link/mise setup exited ${lr.code}`,
            level: "warning",
          });
        }
      }

      if (plan.action === "tab" && this.model.targetSpaceId) {
        run("tab.new", {
          space: this.model.targetSpaceId,
          folder: createPlan.dest,
          name: this.cfg.name || createPlan.name,
          ...(this.cfg.argv ? { argv: this.cfg.argv } : {}),
        });
      } else {
        run("space.new", {
          name: this.cfg.name || createPlan.name,
          folder: createPlan.dest,
          ...(repo.on ? { machine: repo.on } : {}),
          ...(this.cfg.argv ? { argv: this.cfg.argv } : {}),
        });
      }
      this.dismiss();
    } catch (e) {
      if (this.phase === "closed") return;
      this.phase = "ready";
      this.actionError = e?.message || String(e);
      this.input.focus();
      cx.notify();
    }
  }

  onKeyDown(e, cx) {
    const mod = e.modifiers ?? {};
    const anyMod = Boolean(mod.control || mod.alt || mod.platform || mod.shift);

    if (e.key === "escape" && !anyMod) {
      cx.stop_propagation();
      if (this.phase !== "creating") this.dismiss();
      return;
    }

    if (this.phase === "creating" || anyMod) return;

    const vm = this.vm;
    if (!vm) return;

    if (e.key === "backspace") {
      if (this.scopedRepoKey && vm.query === "" && (this.input.value() || "") === "") {
        cx.stop_propagation();
        this.clearScope(cx);
      }
      return;
    }

    if (e.key === "down" || e.key === "up") {
      if (vm.picks.length === 0) return;
      cx.stop_propagation();
      const curIdx = vm.current ? vm.picks.findIndex((p) => p.key === vm.current.key) : -1;
      const step = e.key === "down" ? 1 : -1;
      const nextIdx = curIdx < 0 ? 0 : (curIdx + step + vm.picks.length) % vm.picks.length;
      const next = vm.picks[nextIdx];
      this.selection = { mode: "pinned", key: next.key };
      const itemIdx = vm.items.findIndex((it) => it.key === next.key);
      if (itemIdx >= 0) this.scroll.scroll_to_item(itemIdx);
      cx.notify();
    }
  }

  renderRow(it, selected, t, cx) {
    const userHome = this.model.homes.get(it.repo?.on ?? "") ?? "";

    if (it.kind === "divider") {
      return h_flex()
        .id(it.key)
        .px(10)
        .pt(10)
        .pb(3)
        .gap(8)
        .items_center()
        .child(div().text_size(10.5).font_semibold().text_color(t.dim).child(it.label.toUpperCase()))
        .child(div().flex_1().h(1).bg(t.border));
    }

    if (it.kind === "header") {
      return h_flex()
        .id(it.key)
        .px(10)
        .pt(8)
        .pb(3)
        .gap(8)
        .items_center()
        .rounded(6)
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => {
          if (this.phase === "ready") this.enterScope(it.repo, cx);
        })
        .child(div().text_size(11.5).font_semibold().text_color(t.muted).flex_none().child(it.repo.name))
        .when(Boolean(it.repo.on), (el) =>
          el.child(div().px(5).py(0.5).rounded(4).bg(t.surface).text_size(10.5).text_color(t.dim).flex_none().child(it.repo.on)),
        )
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(tilde(it.repo.main, userHome)));
    }

    if (it.kind === "disk-hint") {
      return div()
        .id(it.key)
        .px(10)
        .py(8)
        .text_size(11.5)
        .text_color(t.dim)
        .child(`Type to search ${it.count} other ${it.count === 1 ? "repository" : "repositories"}`);
    }

    if (it.kind === "loading") {
      return div().id(it.key).px(10).py(6).text_size(12).text_color(t.dim).child(it.label);
    }

    if (it.kind === "error") {
      return div().id(it.key).px(10).py(6).text_size(12).text_color(t.blocked || t.muted).child(it.message);
    }

    // Compact native-picker single-line selectable row (h 34, rounded 7).
    const rowBase = h_flex()
      .id(it.key)
      .h(34)
      .pr(10)
      .pl(selected ? 7 : 10)
      .gap(8)
      .rounded(7)
      .items_center()
      .when(selected, (el) => el.bg(t.selected).border_l_3().border_color(t.accent))
      .hover((s) => s.bg(t.hover))
      .on_click((e, cx) => {
        if (this.phase !== "ready") return;
        this.selection = { mode: "pinned", key: it.key };
        this.vm = this.computeVm();
        this.activate(Boolean(e?.modifiers?.shift), cx);
      });

    if (it.kind === "create") {
      if (!it.name) {
        return rowBase
          .child(svg("mods/workspace-chrome/plus.svg").size(14).flex_none().text_color(t.accent))
          .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(`New workspace in ${it.repo.name}…`))
          .when(Boolean(it.repo.on), (el) =>
            el.child(div().px(5).py(0.5).rounded(4).bg(t.surface).text_size(10.5).text_color(t.dim).flex_none().child(it.repo.on)),
          )
          .child(div().text_size(11).text_color(t.dim).flex_none().child("/ or ↵"));
      }
      const planned = planCreate({ repo: it.repo, name: it.name, settings: this.settings, home: userHome });
      return rowBase
        .child(svg("mods/workspace-chrome/plus.svg").size(14).flex_none().text_color(t.accent))
        .child(
          h_flex()
            .flex_1()
            .min_w(0)
            .gap(6)
            .items_center()
            .child(div().font_semibold().truncate().child(`Create "${it.name}"`))
            .when(!this.scopedRepoKey, (el) =>
              el.child(div().text_size(12).text_color(t.muted).flex_none().child(`in ${it.repo.name}`)),
            ),
        )
        .child(div().text_size(11).text_color(t.dim).truncate().child(tilde(planned.dest, userHome)));
    }

    // it.kind === "ws"
    return rowBase
      .child(
        svg("mods/workspace-chrome/branch.svg")
          .size(14)
          .flex_none()
          .text_color(selected ? t.accent : t.muted),
      )
      .child(
        h_flex()
          .flex_1()
          .min_w(0)
          .gap(6)
          .items_center()
          .when(it.showRepo, (el) =>
            el.child(div().text_size(12).text_color(t.muted).flex_none().child(`${it.repo.name} /`)),
          )
          .child(div().truncate().text_color(it.ws.path ? t.foreground : t.dim).child(it.ws.name))
          .when(it.ws.main, (el) =>
            el.child(div().px(5).py(0.5).rounded(4).bg(t.surface).text_size(10.5).text_color(t.dim).flex_none().child("main")),
          )
          .when(Boolean(it.repo.on && it.showRepo), (el) =>
            el.child(div().px(5).py(0.5).rounded(4).bg(t.surface).text_size(10.5).text_color(t.dim).flex_none().child(it.repo.on)),
          ),
      )
      .when(!it.ws.path, (el) =>
        el.child(div().text_size(11).text_color(t.dim).flex_none().child("unavailable")),
      )
      .when(Boolean(it.open), (el) =>
        el.child(
          div()
            .px(6)
            .py(1)
            .rounded(4)
            .bg(t.surface)
            .text_size(11)
            .text_color(t.muted)
            .flex_none()
            .child(it.open.spaceName || "open"),
        ),
      );
  }

  render(cx) {
    const t = theme();
    const vm = this.computeVm();
    this.vm = vm;

    const bannerError = this.actionError || (!vm.query && !vm.scopedRepo ? vm.spaceError : "");

    const footerHints = ["↑↓ select"];
    if (vm.primary?.label) footerHints.push(`↵ ${vm.primary.label}`);
    if (vm.secondary?.label && vm.secondary.action !== "refuse-tab" && vm.secondary.label !== vm.primary?.label) {
      footerHints.push(`⇧↵ ${vm.secondary.label}`);
    }
    if (vm.scopedRepo) footerHints.push("⌫ all repos");
    else if (vm.current?.repo) footerHints.push("/ scope repo");

    return v_flex()
      .id("worktree")
      .track_focus(this.handle)
      .w_full()
      .h_full()
      .min_h(0)
      .p(16)
      .gap(10)
      .bg(t.popover)
      .text_size(13)
      .text_color(t.foreground)
      .on_key_down((e, cx) => this.onKeyDown(e, cx))
      .child(
        h_flex()
          .items_center()
          .child(div().flex_1().text_size(15).font_semibold().text_color(t.foreground).child("jj workspace"))
          .child(
            div()
              .id("wt-esc")
              .px(6)
              .py(2)
              .rounded(5)
              .text_size(11)
              .text_color(t.dim)
              .hover((s) => s.bg(t.hover).text_color(t.foreground))
              .on_click(() => { if (this.phase !== "creating") this.dismiss(); })
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
          .border_1()
          .border_color(t.accent)
          .bg(t.background)
          .child(svg("mods/workspace-chrome/search.svg").size(15).flex_none().text_color(t.dim))
          .when(Boolean(vm.scopedRepo), (el) =>
            el.child(
              h_flex()
                .id("wt-repo-chip")
                .px(7)
                .py(2)
                .gap(5)
                .rounded(5)
                .bg(t.surface)
                .border_1()
                .border_color(t.border)
                .items_center()
                .flex_none()
                .hover((s) => s.bg(t.hover))
                .on_click((_e, cx) => this.clearScope(cx))
                .child(div().text_size(12).font_semibold().text_color(t.foreground).child(vm.scopedRepo.name))
                .when(Boolean(vm.scopedRepo.on), (chipEl) =>
                  chipEl.child(div().text_size(10.5).text_color(t.dim).child(vm.scopedRepo.on)),
                )
                .child(div().text_size(11).text_color(t.dim).child("×")),
            ),
          )
          .child(div().flex_1().min_w(0).h_full().child(Input.new(this.input).w_full().h_full().text_size(12.8).text_color(t.foreground))),
      )
      .when(Boolean(bannerError), (el) =>
        el.child(
          div()
            .id("wt-error")
            .px(10)
            .py(6)
            .rounded(6)
            .bg(t.surface)
            .text_size(12)
            .text_color(t.blocked || t.accent)
            .child(bannerError),
        ),
      )
      .child(
        div()
          .relative()
          .flex_1()
          .min_h(0)
          .child(
            v_flex()
              .id("wt-list")
              .track_scroll(this.scroll)
              .overflow_y_scroll()
              .w_full()
              .h_full()
              .gap(1)
              .when(vm.loading && vm.items.length === 0, (el) =>
                el.child(div().px(10).py(12).text_size(12).text_color(t.dim).child("Loading repositories…")),
              )
              .when(!vm.loading && vm.items.length === 0, (el) =>
                el.child(
                  div()
                    .px(10)
                    .py(12)
                    .text_size(12)
                    .text_color(t.dim)
                    .child(vm.query ? `No matching workspaces or repositories for "${vm.query}".` : "No jj repositories found."),
                ),
              )
              .children(
                vm.items.map((it) =>
                  this.renderRow(it, vm.current?.key === it.key, t, cx),
                ),
              ),
          )
          .child(Scrollbar.vertical(this.scroll)),
      )
      .child(
        h_flex()
          .pt(6)
          .gap(10)
          .items_center()
          .justify_between()
          .border_t_1()
          .border_color(t.border)
          .text_size(11.5)
          .text_color(t.dim)
          .child(
            div().child(
              this.phase === "creating"
                ? "Creating workspace…"
                : footerHints.join(" · "),
            ),
          )
          .when(vm.bgLoading, (el) => el.child(div().text_size(11).text_color(t.dim).child("Scanning…"))),
      );
  }
}
