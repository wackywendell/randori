// Finish jj workspace — dedicated window overlay with explicit 4-phase state
// machine (loading | error | confirm | running), read-only render(), live+launch
// terminal tracking, transitive child handling, and bounded lock checks.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, Checkbox, Scrollbar } from "gpui-base";
import {
  run,
  props,
  closeOverlay,
  theme,
  spaces,
  panes,
  terminals,
  home,
  exec,
  readTextFile,
  checking,
} from "herdr";
import { identity } from "./jj.js";
import {
  base,
  tilde,
  snapshotHerdr,
  planAffected,
  detectDrift,
  findNestedWorkspace,
  planCleanup,
  collectScopeFolders,
  isLiveTerminal,
} from "./core.js";

const IO = { exec, readTextFile };
const ok = (r) => r && r.code === 0;
const jj = (cwd, on, args, timeout = 30_000) => exec("jj", args, { cwd, on, timeout });

// `jj workspace list`: [{ name, path }]. Uses `root` (jj 0.38+) with fallback.
async function workspaces(main, on) {
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
    out.push({ name: w.name, path: p });
  }
  return out;
}

export default class Finish extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.cfg = {
      overlay: p.overlay,
      spaceId: p.space ?? null,
      tabId: p.tab ?? null,
    };
    this.phase = "loading"; // "loading" | "error" | "confirm" | "running"
    this.closed = false;
    this.space = null;
    this.on = null;
    this.rows = [];
    this.at = 0;
    this.multiRepo = false;
    this.confirmed = null; // Set<string> | null — mutated ONLY on explicit transitions, NEVER in render()
    this.error = "";
    this.waitingExit = null; // { targets: Set<string>, resolve } | null
    this.exitTimer = null;
    this.exitPoll = null;

    this.handle = cx.focus_handle();
    this.handle.focus();
    if (checking()) return;
    cx.spawn(async (cx) => this.prepare(cx));
  }

  get ready() {
    return this.phase !== "loading";
  }

  get busy() {
    return this.phase === "running";
  }

  // Backward-compatible alias for inspection/tests.
  get previewed() {
    return this.confirmed;
  }

  snapshot() {
    return snapshotHerdr({
      spaces: spaces(),
      panes: panes(),
      terminals: terminals(),
      spaceId: this.space?.id ?? this.cfg.spaceId,
    });
  }

  checkedRoots() {
    return this.rows.filter((w) => w.checked && !w.removed).map((w) => w.root);
  }

  // Explicit transition: capture the currently affected terminals as confirmed.
  syncConfirmed() {
    if (this.phase !== "confirm") return;
    this.confirmed = planAffected(this.snapshot(), this.checkedRoots()).addresses;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.clearWait(false);
    closeOverlay(this.cfg.overlay);
  }

  clearWait(exited) {
    if (this.exitTimer) {
      this.exitTimer.cancel();
      this.exitTimer = null;
    }
    if (this.exitPoll) {
      this.exitPoll.cancel();
      this.exitPoll = null;
    }
    if (this.waitingExit) {
      const done = this.waitingExit.resolve;
      this.waitingExit = null;
      done(exited);
    }
  }

  checkWaitingExit() {
    if (!this.waitingExit) return;
    const live = new Set(terminals().filter(isLiveTerminal).map((t) => t.address));
    if ([...this.waitingExit.targets].every((a) => !live.has(a))) {
      this.clearWait(true);
    }
  }

  async prepare(cx) {
    try {
      const allSpaces = spaces();
      const space = allSpaces.find((s) => s.id === this.cfg.spaceId) ?? allSpaces.find((s) => s.active) ?? allSpaces[0] ?? null;
      if (!space) throw new Error("No target space found.");
      this.space = space;
      this.on = space.machine ?? null;

      const { folders, checkFolders } = collectScopeFolders(space, panes(), this.cfg.tabId);
      const probed = await Promise.all(
        folders.map(async (dir) => ({ dir, id: await identity(dir, this.on, IO) })),
      );
      if (this.closed) return;

      const found = [];
      const seenRoot = new Set();
      let firstError = "";
      for (const { dir, id } of probed) {
        if (id.error) {
          console.log(`jj-finish: ${dir}: ${id.message}`);
          if (!firstError) firstError = id.message;
          continue;
        }
        if (!id.linked) continue;
        if (seenRoot.has(id.root)) {
          if (checkFolders.has(dir)) {
            const existing = found.find((w) => w.root === id.root);
            if (existing) existing.checked = true;
          }
          continue;
        }
        seenRoot.add(id.root);
        found.push({
          root: id.root,
          main: id.main,
          repoName: base(id.main),
          name: "",
          checked: checkFolders.has(dir),
          removed: false,
          error: "",
        });
      }

      if (!found.length) {
        this.error = firstError || (this.cfg.tabId ? "This tab has no linked jj workspaces." : "This space has no linked jj workspaces.");
        this.phase = "error";
        cx.notify();
        return;
      }

      const mains = [...new Set(found.map((w) => w.main))];
      this.multiRepo = mains.length > 1;
      const lists = new Map();
      await Promise.all(
        mains.map(async (main) => {
          lists.set(main, await workspaces(main, this.on));
        }),
      );
      if (this.closed) return;

      const rows = [];
      for (const w of found) {
        const hit = (lists.get(w.main) ?? []).find((x) => x.path === w.root);
        if (!hit) continue;
        w.name = hit.name;
        rows.push(w);
      }
      if (!rows.length) {
        this.error = "No matching jj workspaces were found in jj workspace list.";
        this.phase = "error";
        cx.notify();
        return;
      }

      this.rows = rows;
      this.phase = "confirm";
      this.syncConfirmed();
    } catch (e) {
      if (this.closed) return;
      this.error = e?.message ?? String(e);
      console.log(`jj-finish: ${this.error}`);
      this.phase = "error";
    }
    cx.notify();
  }

  toggle(index, cx) {
    if (this.phase !== "confirm") return;
    const row = this.rows[index];
    if (!row || row.removed) return;
    row.checked = !row.checked;
    this.error = "";
    this.syncConfirmed();
    cx.notify();
  }

  key(e, cx) {
    if (this.closed || this.phase === "running") return;
    if (e.key === "escape") {
      this.close();
      return;
    }
    if (this.phase !== "confirm") return;
    if ((e.key === "up" || e.key === "down") && this.rows.length) {
      this.at = e.key === "down" ? (this.at + 1) % this.rows.length : (this.at - 1 + this.rows.length) % this.rows.length;
      cx.notify();
      return;
    }
    if (e.key === "space" && this.rows.length) {
      this.toggle(this.at, cx);
      return;
    }
    if (e.key === "enter") {
      cx.spawn(async (cx) => this.finish(cx));
    }
  }

  async finish(cx) {
    if (this.closed || this.phase !== "confirm") return;
    const todo = this.rows.filter((w) => w.checked && !w.removed);
    if (!todo.length) return;

    // Pre-flight drift check against the explicitly confirmed set.
    const roots = todo.map((w) => w.root);
    const preLive = planAffected(this.snapshot(), roots);
    const preDrift = detectDrift(preLive, this.confirmed);
    if (preDrift.length) {
      const names = preDrift.map((t) => t.name || t.address).join(", ");
      this.error = `New terminal ${names} appeared. Review and press Enter again.`;
      this.confirmed = preLive.addresses;
      cx.notify();
      return;
    }

    this.phase = "running";
    this.error = "";
    for (const w of todo) w.error = "";
    cx.notify();

    try {
      // 1. Fetch fresh workspace lists for ALL repos in this.rows (so unchecked
      //    sibling workspaces in other repos are included in the overlap check).
      const allMains = [...new Set(this.rows.map((w) => w.main))];
      const fresh = new Map();
      await Promise.all(
        allMains.map(async (main) => {
          fresh.set(main, await workspaces(main, this.on));
        }),
      );
      for (const w of todo) {
        const hit = (fresh.get(w.main) ?? []).find((x) => x.name === w.name && x.path === w.root);
        if (!hit) {
          throw new Error(`jj no longer lists ${w.name}. Its folder ${w.root} remains.`);
        }
      }
      const allKnown = [...fresh.values()].flat().filter((x) => x.path);
      const nested = findNestedWorkspace(todo, allKnown);
      if (nested) {
        const who = nested.innerName || tilde(nested.inner, home());
        throw new Error(`${nested.outer.name} contains workspace ${who}. Finish ${who} first.`);
      }

      // 2. Bounded lock check in every checked checkout before ending anything.
      for (const w of todo) {
        const st = await jj(w.root, this.on, ["status"], 10_000);
        if (!ok(st)) {
          throw new Error(st.stderr.trim() || `jj status failed in ${w.name} (exit ${st.code})`);
        }
      }

      // 3. Re-verify live terminals immediately before killing.
      const snapBeforeKill = this.snapshot();
      const liveBeforeKill = planAffected(snapBeforeKill, roots);
      const drift = detectDrift(liveBeforeKill, this.confirmed);
      if (drift.length) {
        const names = drift.map((t) => t.name || t.address).join(", ");
        this.confirmed = liveBeforeKill.addresses;
        throw new Error(`New terminal ${names} appeared. Review and press Enter again.`);
      }

      // 4. Kill direct terminals, wait for direct + children to exit, close panes/space.
      if (liveBeforeKill.all.length) {
        await this.endTerminals(snapBeforeKill, liveBeforeKill, cx);
      }

      // 5. Sequentially remove each checked workspace from its own main checkout.
      for (const w of todo) {
        const r = await jj(w.main, this.on, ["workspace", "remove", w.name], 600_000);
        if (!ok(r)) {
          w.error = r.stderr.trim() || `jj workspace remove exited ${r.code}`;
          console.log(`jj-finish: ${w.name}: ${w.error}`);
          throw new Error(w.error);
        }
        w.removed = true;
        cx.notify();
      }

      this.close();
      return;
    } catch (e) {
      this.error = e?.message ?? String(e);
      console.log(`jj-finish: ${this.error}`);
      this.phase = "confirm";
      // Re-arm confirmation for retry unless drift already updated it above.
      if (!/appeared\. Review and press Enter again\.$/.test(this.error)) {
        this.syncConfirmed();
      }
      cx.notify();
    }
  }

  async endTerminals(snap, live, cx) {
    for (const t of live.direct) {
      run("terminal.kill", { terminal: t.address });
    }
    const targets = new Set(live.all.map((t) => t.address));
    const allExited = () => {
      const nowLive = new Set(terminals().filter(isLiveTerminal).map((t) => t.address));
      return [...targets].every((a) => !nowLive.has(a));
    };
    const exited = await new Promise((resolve) => {
      if (allExited()) {
        resolve(true);
        return;
      }
      this.waitingExit = { targets, resolve };
      // Reactive `render(cx)` wakes immediately when the window repaints; a
      // bounded 100 ms check (cancelled as soon as terminals exit) covers
      // detached `kind: "window"` overlays that Herdr does not repaint on
      // background terminal exits. Zero timers run outside this kill-wait.
      this.exitPoll = cx.timer.every(100, () => this.checkWaitingExit());
      this.exitTimer = cx.timer.after(10_000, () => this.clearWait(allExited()));
    });
    if (!exited) {
      const stillLive = terminals().filter((t) => isLiveTerminal(t) && targets.has(t.address));
      const left = stillLive[0];
      const where = left?.cwd ? ` in ${left.cwd}` : "";
      throw new Error(`Terminal ${left?.name || left?.address || ""}${where} did not stop.`);
    }
    // Use fresh pane/space layout for cleanup planning after terminals exit.
    const cleanup = planCleanup(this.snapshot(), live.addresses);
    if (cleanup.closeSpace && cleanup.spaceId) {
      run("space.close", { id: cleanup.spaceId, confirmed: true });
    }
    for (const pane of cleanup.closePanes) {
      run("pane.close", { pane });
    }
  }

  render(cx) {
    // Reactive exit check while waiting on killed terminals.
    if (this.waitingExit) this.checkWaitingExit();

    const t = theme();
    const userHome = home();
    const busy = this.phase === "running";
    const checked = this.rows.filter((w) => w.checked && !w.removed);
    // Strictly read-only preview computation — NEVER mutates this.confirmed!
    const hasRows = this.phase === "confirm" || this.phase === "running";
    const live = hasRows ? planAffected(this.snapshot(), checked.map((w) => w.root)) : null;

    const row = (w, i) => {
      const title = this.multiRepo ? `${w.repoName} / ${w.name}` : w.name;
      const terms = w.checked && !w.removed && live ? live.rowOf.get(w.root) ?? [] : [];
      const hasNew = Boolean(this.confirmed && terms.some((item) => !this.confirmed.has(item.term.address)));
      return h_flex()
        .id(`finish-${i}`)
        .flex_none()
        .px(10)
        .py(6)
        .gap(10)
        .items_start()
        .rounded(7)
        .when(i === this.at, (el) => el.bg(t.selected))
        .child(
          Checkbox.new(`finish-check-${i}`)
            .checked(w.checked && !w.removed)
            .disabled(busy || w.removed)
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .on_change((_checked, cx) => {
              this.at = i;
              this.toggle(i, cx);
            })
            .flex_none()
            .mt(2)
            .size(14)
            .rounded(3)
            .border(1)
            .border_color(w.checked && !w.removed ? t.accent : t.border)
            .when(w.checked && !w.removed, (el) => el.bg(t.accent))
            .items_center()
            .justify_center()
            .text_size(10)
            .text_color(t.background)
            .child(w.checked && !w.removed ? "\u2713" : ""),
        )
        .child(
          v_flex()
            .flex_1()
            .min_w(0)
            .child(
              h_flex()
                .gap(8)
                .child(div().flex_1().min_w(0).truncate().text_color(w.removed ? t.muted : t.foreground).child(title))
                .when(w.removed, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child("removed"))),
            )
            .child(div().truncate().text_size(11.5).text_color(t.dim).child(tilde(w.root, userHome)))
            .when(terms.length > 0, (el) =>
              el.child(
                h_flex()
                  .gap(6)
                  .items_center()
                  .child(div().text_size(11.5).text_color(t.muted).child(`Ends ${terms.map((item) => item.label).join(", ")}.`))
                  .when(hasNew, (el) =>
                    el.child(div().px(4).py(1).rounded(3).bg(t.surface).text_size(10.5).text_color(t.blocked).child("new")),
                  ),
              ),
            )
            .when(Boolean(w.error), (el) => el.child(div().text_size(11.5).text_color(t.blocked).child(w.error))),
        );
    };

    const heading = hasRows && !this.multiRepo && this.rows[0]?.repoName
      ? `Finish jj workspace of ${this.rows[0].repoName}`
      : "Finish jj workspace";

    return v_flex()
      .id("worktree")
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .size_full()
      .p(16)
      .gap(10)
      .bg(t.popover)
      .text_size(13)
      .child(div().font_semibold().text_color(t.foreground).child(heading))
      .when(this.phase === "loading", (el) => el.child(div().text_color(t.muted).child("\u2026")))
      .when(Boolean(this.error), (el) => el.child(div().text_color(t.blocked).child(this.error)))
      .when(hasRows, (el) =>
        el
          .child(
            div()
              .text_color(t.muted)
              .child(
                "Ends the terminals working in the checked folders and deletes the folders. Edits jj tracks stay in the repository. Files jj does not track, including ignored files, are deleted.",
              ),
          )
          .child(
            div()
              .relative()
              .flex_1()
              .min_h(0)
              .child(v_flex().id("finish-list").size_full().overflow_y_scroll().children(this.rows.map(row)))
              .child(Scrollbar.vertical("finish-list").absolute().inset_0()),
          ),
      )
      .when(!hasRows, (el) => el.child(div().flex_1()))
      .child(
        h_flex()
          .justify_end()
          .text_size(11)
          .text_color(t.dim)
          .gap(6)
          .when(busy, (el) => el.child(div().frames(["\u280b", "\u2819", "\u2839", "\u2838", "\u283c", "\u2834", "\u2826", "\u2827", "\u2807", "\u280f"], 90)))
          .child(busy ? "working\u2026" : hasRows ? "space check \u00b7 \u21b5 finish \u00b7 esc cancel" : "esc close"),
      );
  }
}
