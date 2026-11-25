// Finish a linked jj workspace in a separate confirmation window.
// Choose-one design: shows one checkout (or a single-select list when a space
// or tab holds multiple linked workspaces), names every live terminal on that
// machine inside the checkout, confirms against drift immediately before
// killing, waits for those terminals to exit, and removes the workspace.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, ScrollHandle, Scrollbar } from "gpui-base";
import {
  spaces,
  panes,
  terminals,
  props,
  theme,
  home,
  run,
  exec,
  readTextFile,
  closeOverlay,
  notify,
  checking,
} from "herdr";
import { identity, workspaces, machineOf, sameMachine, addressMachine, base, tilde } from "./jj.js";
import {
  isLiveTerminal,
  snapshotHerdr,
  collectScopeFolders,
  planAffected,
  detectDrift,
  findNestedWorkspace,
  planCleanup,
} from "./core.js";

const EXIT_POLL_MS = 100;
const EXIT_TIMEOUT_MS = 10_000;

export class DriftError extends Error {
  constructor(added, allDirect) {
    const names = added.map((t) => t.address).join(", ");
    super(`New terminal${added.length > 1 ? "s" : ""} (${names}) appeared. Review and press Enter again.`);
    this.name = "DriftError";
    this.added = added;
    this.allDirect = allDirect;
  }
}

async function resolveHome(on) {
  const m = machineOf(on);
  if (!m) return home() || "";
  try {
    const r = await exec("sh", ["-c", 'printf %s "$HOME"'], { on: m, timeout: 5_000 });
    return r.code === 0 ? r.stdout.trim() : "";
  } catch {
    return "";
  }
}

export default class Finish extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.cfg = {
      overlay: p.overlay ?? null,
      spaceId: p.space ?? null,
      tabId: p.tab ?? null,
    };
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.scroll = ScrollHandle.new();

    // Tagged lifecycle phase: "loading" | "error" | "confirm" | "running" | "closed"
    this.phase = "loading";
    this.on = null;
    this.userHome = "";
    this.rows = [];
    this.knownRoots = [];
    this.selectedIndex = 0;
    this.acknowledged = new Set();
    this.error = "";
    this.step = "";
    this.waitHandle = null;

    if (!checking()) {
      cx.spawn(async (cx) => this.prepare(cx));
    }
  }

  get ready() {
    return this.phase === "confirm" || this.phase === "error";
  }

  get busy() {
    return this.phase === "running";
  }

  // User-initiated dismissal. Never called from host close().
  dismiss() {
    if (this.phase === "closed") return;
    if (this.cfg.overlay) closeOverlay(this.cfg.overlay);
  }

  // Host teardown hook invoked by Herdr when the window closes.
  close() {
    this.phase = "closed";
    this.cancelWait();
  }

  cancelWait() {
    if (!this.waitHandle) return;
    const h = this.waitHandle;
    this.waitHandle = null;
    try { h.poll?.cancel?.(); } catch {}
    try { h.deadline?.cancel?.(); } catch {}
    h.resolve(false);
  }

  currentRow() {
    if (this.rows.length === 0) return null;
    const idx = Math.max(0, Math.min(this.selectedIndex, this.rows.length - 1));
    return this.rows[idx] ?? null;
  }

  snapshot() {
    return snapshotHerdr({
      spaces: spaces(),
      panes: panes(),
      terminals: terminals(),
      spaceId: this.cfg.spaceId,
      tabId: this.cfg.tabId,
      machine: this.on,
    });
  }

  planFor(row, snap = this.snapshot()) {
    if (!row) return { direct: [], dependentChildren: [], mustExit: [] };
    return planAffected(snap, row.root, {
      knownRoots: this.knownRoots,
      userHome: this.userHome,
    });
  }

  syncAcknowledged(row = this.currentRow()) {
    const plan = this.planFor(row);
    this.acknowledged = new Set(plan.direct.map((t) => t.address));
    return plan;
  }

  selectIndex(index, cx) {
    if (this.phase !== "confirm" || this.rows.length === 0) return;
    const next = Math.max(0, Math.min(index, this.rows.length - 1));
    if (next === this.selectedIndex) return;
    this.selectedIndex = next;
    this.error = "";
    this.syncAcknowledged();
    this.scroll.scroll_to_item(next);
    cx?.notify?.();
  }

  selectByName(name, cx) {
    const idx = this.rows.findIndex((r) => r.name === name);
    if (idx >= 0) {
      this.selectedIndex = idx;
      this.error = "";
      this.syncAcknowledged();
      cx?.notify?.();
    }
  }

  async prepare(cx) {
    try {
      const initialSnap = snapshotHerdr({
        spaces: spaces(),
        panes: panes(),
        terminals: terminals(),
        spaceId: this.cfg.spaceId,
        tabId: this.cfg.tabId,
      });
      const scope = collectScopeFolders(initialSnap);
      if (!scope.ok) {
        if (this.phase === "closed") return;
        this.phase = "error";
        this.error = scope.error;
        cx.notify();
        return;
      }

      this.on = initialSnap.machine;
      const io = { exec, readTextFile };
      const [userHome, probed] = await Promise.all([
        resolveHome(this.on),
        Promise.allSettled(
          scope.folders.map(async (dir) => ({
            dir,
            id: await identity(dir, this.on, io),
          })),
        ),
      ]);
      if (this.phase === "closed") return;
      this.userHome = userHome;

      const foundByRoot = new Map();
      const mains = new Set();
      let firstErr = "";
      for (const res of probed) {
        if (res.status !== "fulfilled") {
          if (!firstErr) firstErr = res.reason?.message || String(res.reason);
          continue;
        }
        const { id } = res.value;
        if (id.error && !firstErr) firstErr = id.message;
        if (!id.jj) continue;
        mains.add(id.main);
        if (id.linked && !foundByRoot.has(id.root)) {
          foundByRoot.set(id.root, { root: id.root, main: id.main });
        }
      }

      if (foundByRoot.size === 0) {
        this.phase = "error";
        this.error = firstErr || "No linked jj workspace found here.";
        cx.notify();
        return;
      }

      // Fetch real recorded workspace roots (no legacy root synthesis for deletion).
      const mainList = [...mains];
      const settledLists = await Promise.allSettled(
        mainList.map(async (main) => ({
          main,
          list: await workspaces(main, this.on, io, { synthesizeDefault: false }),
        })),
      );
      if (this.phase === "closed") return;

      const listByMain = new Map();
      const allKnownRoots = new Set();
      let listErr = "";
      for (const res of settledLists) {
        if (res.status !== "fulfilled") {
          if (!listErr) listErr = res.reason?.message || String(res.reason);
          continue;
        }
        const { main, list } = res.value;
        listByMain.set(main, list);
        allKnownRoots.add(main);
        for (const w of list) if (w.path) allKnownRoots.add(w.path);
      }

      const rows = [];
      for (const { root, main } of foundByRoot.values()) {
        allKnownRoots.add(root);
        const list = listByMain.get(main);
        const match = list?.find((w) => w.path === root && !w.main);
        if (!match) continue;
        rows.push({
          key: `${main}\0${match.name}`,
          name: match.name,
          root,
          main,
          repoName: base(main),
          isActive: Boolean(scope.activeFolder && (scope.activeFolder === root || scope.activeFolder.startsWith(`${root}/`))),
        });
      }

      if (rows.length === 0) {
        this.phase = "error";
        this.error = listErr || "jj did not report a recorded path for this workspace. Upgrade jj to 0.38+ or remove it manually.";
        cx.notify();
        return;
      }

      rows.sort((a, b) => Number(b.isActive) - Number(a.isActive) || a.repoName.localeCompare(b.repoName) || a.name.localeCompare(b.name));
      this.rows = rows;
      this.knownRoots = [...allKnownRoots];
      this.selectedIndex = 0;
      this.phase = "confirm";
      this.error = "";
      this.syncAcknowledged();
      cx.notify();
    } catch (e) {
      if (this.phase === "closed") return;
      this.phase = "error";
      this.error = e?.message || String(e);
      cx.notify();
    }
  }

  // Wait for every direct terminal address on `this.on` to leave `terminals()`.
  // Bounded active-only poll (no render-path side effects, zero idle timers).
  waitForExit(addresses, timeoutMs, cx) {
    const wanted = new Set(addresses);
    if (wanted.size === 0) return Promise.resolve(true);

    const allGone = () => {
      const live = new Set(
        terminals()
          .filter((t) => isLiveTerminal(t) && sameMachine(addressMachine(t.address), this.on))
          .map((t) => t.address),
      );
      for (const addr of wanted) if (live.has(addr)) return false;
      return true;
    };

    if (allGone()) return Promise.resolve(true);

    return new Promise((resolve) => {
      let settled = false;
      const done = (ok) => {
        if (settled) return;
        settled = true;
        const h = this.waitHandle;
        this.waitHandle = null;
        try { h?.poll?.cancel?.(); } catch {}
        try { h?.deadline?.cancel?.(); } catch {}
        resolve(ok);
      };

      const poll = cx.timer.every(EXIT_POLL_MS, () => {
        if (this.phase === "closed") return done(false);
        if (allGone()) done(true);
      });
      const deadline = cx.timer.after(timeoutMs, () => done(allGone()));
      this.waitHandle = { poll, deadline, resolve: done };
    });
  }

  async finish(cx) {
    if (this.phase !== "confirm") return;
    const row = this.currentRow();
    if (!row) return;

    // Pre-start drift check against what the user reviewed.
    const initialPlan = this.planFor(row);
    const initialAdded = detectDrift(this.acknowledged, initialPlan.direct);
    if (initialAdded.length > 0) {
      this.acknowledged = new Set(initialPlan.direct.map((t) => t.address));
      this.error = new DriftError(initialAdded, initialPlan.direct).message;
      cx.notify();
      return;
    }

    this.phase = "running";
    this.error = "";
    this.step = "Checking workspace…";
    cx.notify();

    const io = { exec, readTextFile };
    try {
      // 1. Fresh recorded workspace list for this repo only.
      const freshList = await workspaces(row.main, this.on, io, { synthesizeDefault: false });
      if (this.phase === "closed") return;
      const stillRecorded = freshList.find((w) => w.name === row.name && w.path === row.root && !w.main);
      if (!stillRecorded) {
        throw new Error(`Workspace "${row.name}" is no longer recorded at ${tilde(row.root, this.userHome)}.`);
      }

      // 2. Refuse if another known workspace lives inside this checkout.
      const freshRoots = new Set(this.knownRoots);
      freshRoots.add(row.main);
      for (const w of freshList) if (w.path) freshRoots.add(w.path);
      const nested = findNestedWorkspace(row.root, freshRoots);
      if (nested) {
        throw new Error(`Cannot finish "${row.name}": another workspace exists inside it (${tilde(nested.inner, this.userHome)}).`);
      }

      // 3. Working-copy lock & accessibility check via jj status.
      const st = await exec("jj", ["status"], { cwd: row.root, on: this.on, timeout: EXIT_TIMEOUT_MS });
      if (this.phase === "closed") return;
      if (st.code !== 0) {
        throw new Error(st.stderr.trim() || `jj status failed in "${row.name}" (exit ${st.code}).`);
      }

      // 4. Final drift check right before dispatching terminal.kill.
      const preKillSnap = this.snapshot();
      const preKillPlan = this.planFor(row, preKillSnap);
      const lateAdded = detectDrift(this.acknowledged, preKillPlan.direct);
      if (lateAdded.length > 0) {
        throw new DriftError(lateAdded, preKillPlan.direct);
      }

      // 5. End every direct terminal inside the checkout and wait for all to exit.
      if (preKillPlan.direct.length > 0) {
        this.step = `Ending ${preKillPlan.direct.length} terminal${preKillPlan.direct.length > 1 ? "s" : ""}…`;
        cx.notify();
        for (const t of preKillPlan.direct) {
          run("terminal.kill", { terminal: t.address });
        }
        const exited = await this.waitForExit(
          preKillPlan.direct.map((t) => t.address),
          EXIT_TIMEOUT_MS,
          cx,
        );
        if (this.phase === "closed") return;
        if (!exited) {
          const live = new Set(
            terminals()
              .filter((t) => isLiveTerminal(t) && sameMachine(addressMachine(t.address), this.on))
              .map((t) => t.address),
          );
          const stuck = preKillPlan.direct.filter((t) => live.has(t.address)).map((t) => t.address);
          throw new Error(`Terminal${stuck.length > 1 ? "s" : ""} ${stuck.join(", ")} did not stop within 10s.`);
        }
      }

      // 6. Remove the workspace (`--` guards names starting with `-`).
      this.step = `Removing ${row.name}…`;
      cx.notify();
      const rm = await exec("jj", ["workspace", "remove", "--", row.name], {
        cwd: row.main,
        on: this.on,
        timeout: 30_000,
      });
      if (this.phase === "closed") return;
      if (rm.code !== 0) {
        throw new Error(rm.stderr.trim() || `jj workspace remove exited ${rm.code}`);
      }

      // 7. Clean up panes (or the space if every pane belonged to this checkout).
      const cleanup = planCleanup(this.snapshot(), row.root, [...freshRoots]);
      if (cleanup.closeSpace && this.cfg.spaceId) {
        run("space.close", { id: this.cfg.spaceId, confirmed: true });
      } else {
        for (const pane of cleanup.closePanes) {
          run("pane.close", { pane });
        }
      }

      notify({
        title: `Finished workspace "${row.name}"`,
        body: `${row.repoName} · ${tilde(row.root, this.userHome)}`,
        level: "success",
      });
      this.dismiss();
    } catch (e) {
      if (this.phase === "closed") return;
      if (e instanceof DriftError) {
        this.acknowledged = new Set(e.allDirect.map((t) => t.address));
      }
      this.error = e?.message || String(e);
      this.step = "";
      this.phase = "confirm";
      cx.notify();
    }
  }

  onKeyDown(e, cx) {
    const mod = e.modifiers ?? {};
    const anyMod = Boolean(mod.control || mod.alt || mod.platform || mod.shift);

    if (e.key === "escape" && !anyMod) {
      cx.stop_propagation();
      if (this.phase !== "running") this.dismiss();
      return;
    }
    if (this.phase !== "confirm" || anyMod) return;

    if (e.key === "down") {
      cx.stop_propagation();
      this.selectIndex((this.selectedIndex + 1) % this.rows.length, cx);
    } else if (e.key === "up") {
      cx.stop_propagation();
      this.selectIndex((this.selectedIndex - 1 + this.rows.length) % this.rows.length, cx);
    } else if (e.key === "enter") {
      cx.stop_propagation();
      cx.spawn(async (cx) => this.finish(cx));
    }
  }

  // Strictly read-only: computes preview from current Herdr state without mutating `this`.
  render(cx) {
    const t = theme();
    const row = this.currentRow();
    const multi = this.rows.length > 1;
    const plan = this.phase === "confirm" || this.phase === "running" ? this.planFor(row) : { direct: [], dependentChildren: [] };
    const newAddrs = new Set(detectDrift(this.acknowledged, plan.direct).map((d) => d.address));
    const singleRepo = this.rows.length > 0 && new Set(this.rows.map((r) => r.main)).size === 1;

    const heading =
      this.phase === "loading"
        ? "Finish jj workspace"
        : singleRepo
          ? `Finish jj workspace · ${this.rows[0].repoName}`
          : "Finish jj workspace";

    return v_flex()
      .id("jj-finish")
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
          .justify_between()
          .gap(8)
          .child(
            h_flex()
              .items_center()
              .gap(8)
              .child(svg("mods/workspace-chrome/branch.svg").size(14).text_color(t.accent))
              .child(div().font_semibold().child(heading)),
          )
          .when(Boolean(this.on), (el) =>
            el.child(div().px(6).py(2).rounded(4).bg(t.surface).text_size(11).text_color(t.muted).child(this.on)),
          ),
      )
      .when(this.phase === "loading", (el) =>
        el.child(div().flex_1().py(16).text_color(t.dim).child("Inspecting jj workspaces…")),
      )
      .when(this.phase === "error", (el) =>
        el.child(div().flex_1().py(8).text_color(t.blocked || t.muted).child(this.error || "Unable to finish workspace.")),
      )
      .when(this.phase === "confirm" || this.phase === "running", (el) =>
        el
          .when(multi, (el) =>
            el.child(
              div()
                .relative()
                .max_h(120)
                .min_h(0)
                .rounded(7)
                .border_1()
                .border_color(t.border)
                .bg(t.surface)
                .child(
                  v_flex()
                    .id("finish-list")
                    .track_scroll(this.scroll)
                    .overflow_y_scroll()
                    .max_h(118)
                    .p(4)
                    .gap(2)
                    .children(
                      this.rows.map((r, i) => {
                        const selected = i === this.selectedIndex;
                        return h_flex()
                          .id(`finish-row-${i}`)
                          .px(8)
                          .py(5)
                          .gap(8)
                          .rounded(5)
                          .items_center()
                          .when(selected, (rowEl) => rowEl.bg(t.selected))
                          .hover((s) => s.bg(t.hover))
                          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
                          .on_click((_e, cx) => {
                            cx.stop_propagation();
                            this.selectIndex(i, cx);
                          })
                          .child(div().w(14).text_color(selected ? t.accent : t.dim).child(selected ? "●" : "○"))
                          .child(
                            div()
                              .flex_1()
                              .min_w(0)
                              .truncate()
                              .child(singleRepo ? r.name : `${r.repoName} / ${r.name}`),
                          )
                          .when(r.isActive, (rowEl) =>
                            rowEl.child(div().text_size(11).text_color(t.dim).child("active")),
                          );
                      }),
                    ),
                )
                .child(Scrollbar.vertical(this.scroll)),
            ),
          )
          .when(Boolean(row), (el) =>
            el.child(
              v_flex()
                .flex_1()
                .min_h(0)
                .gap(8)
                .p(10)
                .rounded(7)
                .border_1()
                .border_color(t.border)
                .bg(t.surface)
                .child(
                  v_flex()
                    .gap(2)
                    .child(
                      h_flex()
                        .items_center()
                        .gap(6)
                        .child(div().font_semibold().child(singleRepo ? row.name : `${row.repoName} / ${row.name}`)),
                    )
                    .child(div().text_size(11.5).text_color(t.muted).truncate().child(tilde(row.root, this.userHome))),
                )
                .child(
                  v_flex()
                    .gap(3)
                    .child(
                      div()
                        .text_size(11.5)
                        .font_semibold()
                        .text_color(t.muted)
                        .child(
                          plan.direct.length > 0
                            ? `Ends ${plan.direct.length} terminal${plan.direct.length > 1 ? "s" : ""}`
                            : "No live terminals in this checkout",
                        ),
                    )
                    .when(plan.direct.length > 0, (listEl) =>
                      listEl.children(
                        plan.direct.map((term, i) =>
                          h_flex()
                            .id(`finish-term-${i}`)
                            .gap(6)
                            .items_center()
                            .text_size(12)
                            .child(div().flex_1().min_w(0).truncate().child(term.label))
                            .when(newAddrs.has(term.address), (badgeEl) =>
                              badgeEl.child(
                                div()
                                  .px(5)
                                  .py(1)
                                  .rounded(4)
                                  .bg(t.blocked || t.accent)
                                  .text_size(10.5)
                                  .text_color(t.accent_foreground || t.foreground)
                                  .child("new"),
                              ),
                            ),
                        ),
                      ),
                    )
                    .when(plan.dependentChildren.length > 0, (childEl) =>
                      childEl.child(
                        div()
                          .text_size(11)
                          .text_color(t.dim)
                          .child(
                            `May also end ${plan.dependentChildren.length} dependent child terminal${plan.dependentChildren.length > 1 ? "s" : ""}: ${plan.dependentChildren.map((c) => c.address).join(", ")}`,
                          ),
                      ),
                    ),
                )
                .child(
                  div()
                    .mt_auto()
                    .text_size(11.5)
                    .text_color(t.dim)
                    .child("Runs jj workspace remove and deletes this checkout folder from disk."),
                ),
            ),
          ),
      )
      .when(Boolean(this.error) && this.phase === "confirm", (el) =>
        el.child(div().text_size(12).text_color(t.blocked || t.accent).child(this.error)),
      )
      .when(this.phase === "running" && Boolean(this.step), (el) =>
        el.child(div().text_size(12).text_color(t.muted).child(this.step)),
      )
      .child(
        h_flex()
          .items_center()
          .justify_between()
          .gap(8)
          .pt(4)
          .child(
            div()
              .text_size(11.5)
              .text_color(t.dim)
              .child(
                this.phase === "running"
                  ? "Finishing workspace…"
                  : this.phase === "confirm"
                    ? `${multi ? "↑↓ choose · " : ""}↵ finish · esc cancel`
                    : "esc close",
              ),
          )
          .child(
            h_flex()
              .gap(8)
              .child(
                div()
                  .id("finish-cancel")
                  .px(10)
                  .py(5)
                  .rounded(6)
                  .border_1()
                  .border_color(t.border)
                  .text_size(12)
                  .text_color(this.phase === "running" ? t.dim : t.foreground)
                  .when(this.phase !== "running", (btn) => btn.hover((s) => s.bg(t.hover)))
                  .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
                  .on_click((_e, cx) => {
                    cx.stop_propagation();
                    if (this.phase !== "running") this.dismiss();
                  })
                  .child("Cancel"),
              )
              .when(this.phase === "confirm" || this.phase === "running", (el) =>
                el.child(
                  div()
                    .id("finish-confirm")
                    .px(12)
                    .py(5)
                    .rounded(6)
                    .bg(this.phase === "running" ? t.surface : t.solid || t.accent)
                    .text_size(12)
                    .font_semibold()
                    .text_color(this.phase === "running" ? t.dim : t.solid_foreground || t.accent_foreground || t.foreground)
                    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
                    .on_click((_e, cx) => {
                      cx.stop_propagation();
                      if (this.phase === "confirm") cx.spawn(async (cx) => this.finish(cx));
                    })
                    .child(this.phase === "running" ? "Finishing…" : "Finish"),
                ),
              ),
          ),
      );
  }
}
