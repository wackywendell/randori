import { View, div } from 'gpui-kit';
import { v_flex, h_flex, InputState, Input } from 'gpui-base';
import { props, spaces, panes, machines, terminals, theme, exec, run, pickFolder, closeOverlay, notify } from 'herdr';

const local = on => on ?? null;
function failure(result) {
  try { return JSON.parse(result.stderr).error; } catch { return result.stderr || 'Workspace operation failed'; }
}

export default class Workspace extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.action = p.action ?? 'new';
    this.on = spaces().find(s => s.id === p.space)?.machine ?? p.machine ?? null;
    this.destination = p.space ?? null;
    this.folder = InputState.new({ value: p.folder ?? '', placeholder: 'Absolute repository or workspace folder' });
    this.name = InputState.new({ placeholder: 'Workspace or bookmark name' });
    this.spaceName = InputState.new({ placeholder: 'Organizational space name' });
    for (const input of [this.folder, this.name, this.spaceName]) input.on('change', (_e, cx) => cx.notify());
    this.folder.on('submit', (_e, cx) => this.chooseRepository(this.folder.value().trim(), cx));
    this.name.on('submit', (_e, cx) => this.go(cx));
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.step = 'repository';
    this.error = '';
    this.busy = false;
    this.closed = false;
  }

  close() { this.closed = true; }

  start(cx, job) {
    if (this.busy) return;
    this.busy = true;
    this.error = '';
    cx.spawn(async cx => {
      try { await job(); } catch (error) { this.error = String(error.message ?? error); }
      this.busy = false;
      if (!this.closed) cx.notify();
    });
    cx.notify();
  }

  async ask(args, cwd = this.repo?.root) {
    const result = await exec('herdr-jj', [...args, '--cwd', cwd], { on: this.on, cwd: this.repo?.main, timeout: 600_000 });
    if (this.closed) throw new Error('Dialog closed');
    if (result.code !== 0) throw new Error(failure(result));
    return JSON.parse(result.stdout);
  }

  reset(action, cx) {
    if (this.busy) return;
    this.action = action;
    this.step = 'repository';
    this.repo = this.workspace = this.plan = this.scope = null;
    this.error = '';
    cx.notify();
  }

  chooseRepository(folder, cx) {
    if (!folder) return;
    this.start(cx, async () => {
      if (!folder.startsWith('/')) throw new Error('Enter an absolute folder path.');
      const repo = await this.ask(['probe'], folder);
      if (!repo) throw new Error('Choose a jj repository. Git worktrees use the existing Git tools.');
      this.folder.set_value(folder);
      this.repo = repo;
      this.plan = this.workspace = this.scope = null;
      if (this.action === 'remove' && this.on) throw new Error('Remote removal is not supported; no terminals or files were changed.');
      if (this.action === 'new') this.step = 'create';
      else {
        this.list = await this.ask(['list']);
        this.step = 'workspaces';
      }
    });
  }

  chooseWorkspace(workspace, cx) {
    if (!workspace.root || (this.action === 'remove' && workspace.main)) return;
    this.start(cx, async () => {
      const repo = await this.ask(['probe'], workspace.root);
      if (!repo || repo.repo !== this.repo.repo || repo.root !== workspace.root) throw new Error('Checkout identity changed. Choose the repository again.');
      if (this.action === 'remove' && !repo.linked) throw new Error('The main checkout cannot be removed.');
      this.workspace = workspace;
      this.step = this.action === 'remove' ? 'scope' : 'destination';
    });
  }

  scopes() {
    return spaces().filter(s => !s.machine).flatMap(s => [
      ...s.tabs.map(tab => ({ kind: 'tab', id: tab.id, label: `Tab “${tab.name}” in “${s.name}”`,
        detail: panes().filter(p => p.tab === tab.id && p.cwd).map(p => p.cwd).join(', ') || 'No terminal folder reported' })),
      { kind: 'space', id: s.id, label: `Entire space “${s.name}”`, detail: `ALL ${s.tabs.length} tabs, including any other repositories` },
    ]);
  }

  chooseScope(scope, cx) {
    this.start(cx, async () => {
      const plan = await this.ask(['remove-plan', `--${scope.kind}`, scope.id], this.workspace.root);
      if (plan.root !== this.workspace.root || plan.repo !== this.repo.repo || plan.scope.kind !== scope.kind || plan.scope.id !== scope.id) throw new Error('Removal target changed. Select it again.');
      this.scope = scope;
      this.plan = plan;
      this.step = 'confirm';
    });
  }

  destinationReady() {
    return this.destination === 'new-space' ? Boolean(this.spaceName.value().trim())
      : spaces().some(s => s.id === this.destination && local(s.machine) === local(this.on));
  }

  open(root, name) {
    if (!this.destinationReady()) throw new Error('Choose where to open the workspace.');
    if (this.destination === 'new-space') run('space.new', { name: this.spaceName.value().trim(), folder: root, tab: name, machine: this.on ?? '' });
    else run('tab.new', { name, space: this.destination, folder: root });
    closeOverlay(props().overlay);
  }

  go(cx) {
    if (this.busy) return;
    if (this.step === 'confirm' && this.plan) {
      this.busy = true;
      const plan = this.plan;
      const args = ['remove', `--${plan.scope.kind}`, plan.scope.id, '--yes', '--approval', plan.approval, '--cwd', plan.root,
        ...(plan.excluded.length ? ['--discard-excluded'] : [])];
      const cwd = this.repo.main;
      const overlay = props().overlay;
      // Closing a mod copy cancels even owner-null tasks. Keep the dialog
      // alive through scope closure, then report before releasing its task.
      cx.spawn(async () => {
        try {
          const result = await exec('herdr-jj', args, { cwd, timeout: 600_000 });
          if (result.code !== 0) throw new Error(failure(result));
          notify({ title: 'Workspace removed', body: plan.root, level: 'success' });
        } catch (error) {
          notify({ title: 'Workspace removal stopped', body: String(error.message ?? error), level: 'error', timeout: 0 });
        }
        closeOverlay(overlay);
      });
      cx.notify();
    } else if (this.step === 'create' && this.destinationReady() && this.name.value().trim()) {
      const name = this.name.value().trim();
      this.start(cx, async () => {
        const result = await this.ask(['create', name]);
        this.open(result.root, name.replace(/\//g, '-'));
      });
    } else if (this.step === 'destination' && this.destinationReady()) {
      this.start(cx, async () => {
        const repo = await this.ask(['probe'], this.workspace.root);
        if (!repo || repo.root !== this.workspace.root || repo.repo !== this.repo.repo) throw new Error('Checkout identity changed. Select it again.');
        this.open(repo.root, this.workspace.name);
      });
    }
  }

  render(cx) {
    const t = theme();
    const button = (id, text, action, enabled = true) => div().id(id).px(10).py(6).rounded(5).bg(t.selected).text_color(enabled ? t.foreground : t.dim)
      .when(enabled, el => el.cursor_pointer().on_click(action)).child(text);
    const input = state => Input.new(state).h(32).px(8).border(1).border_color(t.input).rounded(5).flex_none();
    const text = value => div().flex_none().child(value);
    const sameMachine = s => local(s.machine) === local(this.on);
    const folders = [...new Set(panes().filter(p => p.terminal && p.cwd && spaces().some(s => sameMachine(s) && s.tabs.some(tab => tab.id === p.tab))).map(p => p.cwd))];
    const choices = [...new Set([null, ...machines().map(m => m.name), ...spaces().map(s => local(s.machine))])];
    const canGo = this.step === 'confirm' || (this.step === 'create' && this.destinationReady() && this.name.value().trim()) || (this.step === 'destination' && this.destinationReady());
    return v_flex().id('jj-workspace').track_focus(this.handle).size_full().min_h(0).p(16).gap(10).bg(t.popover).text_color(t.foreground).text_size(13)
      .on_key_down((e, cx) => {
        if (e.key === 'escape') { cx.stop_propagation(); if (!this.busy) closeOverlay(props().overlay); }
        if (e.key === 'enter' && this.step === 'confirm') this.go(cx);
      })
      .child(text('jj workspaces').font_semibold())
      .child(h_flex().gap(6).children([['new', 'Create'], ['open', 'Open'], ['remove', 'Remove']].map(([action, label]) =>
        button(`jj-action-${action}`, this.action === action ? `● ${label}` : label, (_e, cx) => this.reset(action, cx), !this.busy))))
      .child(v_flex().id('jj-body').flex_1().min_h(0).overflow_y_scrollbar().gap(8)
        .when(this.step === 'repository', el => el
          .child(text('Choose the repository explicitly. A space can contain several checkouts.'))
          .child(h_flex().gap(6).flex_wrap().children(choices.map((on, i) => button(`jj-machine-${i}`, `${local(this.on) === local(on) ? '● ' : ''}${on ?? 'This computer'}`, (_e, cx) => { this.on = on; cx.notify(); }, !this.busy))))
          .child(input(this.folder))
          .child(h_flex().gap(6)
            .child(button('jj-use-folder', 'Use folder', (_e, cx) => this.chooseRepository(this.folder.value().trim(), cx), !this.busy && Boolean(this.folder.value().trim())))
            .when(!this.on, el => el.child(button('jj-browse', 'Browse…', (_e, cx) => this.start(cx, async () => {
              const folder = await pickFolder({ prompt: 'Choose jj repository' });
              if (!this.closed && folder) this.folder.set_value(folder);
            }), !this.busy))))
          .child(text('Terminal folders (choose one, or enter another path above):').text_color(t.dim))
          .children(folders.map((folder, i) => button(`jj-folder-${i}`, folder, (_e, cx) => this.chooseRepository(folder, cx), !this.busy))))
        .when(this.step !== 'repository', el => el.child(text(`${this.on ?? 'This computer'} · Repository: ${this.repo?.main}`))
          .when(this.repo?.root !== this.repo?.main, el => el.child(text(`From checkout: ${this.repo?.root}`))))
        .when(this.step === 'create', el => el.child(input(this.name)).child(text('Creates ../workspaces/<name> with shared project configuration. Existing owned workspaces are reused.')))
        .when(this.step === 'workspaces', el => el.child(text(this.action === 'remove' ? 'Choose the exact linked checkout to remove:' : 'Choose the workspace to open:'))
          .children((this.list ?? []).map((w, i) => button(`jj-workspace-${i}`, `${w.name}${w.main ? ' (main)' : ''} · ${w.root ?? 'checkout unavailable'}`,
            (_e, cx) => this.chooseWorkspace(w, cx), !this.busy && Boolean(w.root) && !(this.action === 'remove' && w.main)))))
        .when(this.step === 'create' || this.step === 'destination', el => el
          .when(Boolean(this.workspace), el => el.child(text(`Checkout: ${this.workspace?.root}`)))
          .child(text('Open as a new tab in:'))
          .children(spaces().filter(sameMachine).map(s => button(`jj-destination-${s.id}`, `${this.destination === s.id ? '● ' : ''}${s.name}`,
            (_e, cx) => { this.destination = s.id; cx.notify(); }, !this.busy)))
          .child(button('jj-destination-new', `${this.destination === 'new-space' ? '● ' : ''}New organizational space`, (_e, cx) => { this.destination = 'new-space'; cx.notify(); }, !this.busy))
          .when(this.destination === 'new-space', el => el.child(input(this.spaceName))))
        .when(this.step === 'scope', el => el.child(text(`Checkout: ${this.workspace?.root}`)).child(text('Choose exactly what to close. Nothing closes until the final confirmation.'))
          .children(this.scopes().map((scope, i) => v_flex().gap(2).flex_none()
            .child(button(`jj-scope-${i}`, scope.label, (_e, cx) => this.chooseScope(scope, cx), !this.busy))
            .child(text(scope.detail).text_size(11).text_color(t.dim)))))
        .when(this.step === 'confirm', el => el
          .child(text(`Delete checkout: ${this.plan?.root}`))
          .child(text(`Close: ${this.scope?.label} · ${this.scope?.detail}`))
          .child(text('Stops the listed terminals, takes a final snapshot, forgets the workspace and deletes its checkout. Snapshotted work stays in the shared repository.'))
          .child(v_flex().id('jj-terminals').max_h(120).flex_none().overflow_y_scrollbar()
            .children((this.plan?.terminals ?? []).map(id => text(`${terminals().find(t => t.address === id)?.name || 'Terminal'} · ${id}`))))
          .when(Boolean(this.plan?.excluded.length), el => el
            .child(text(`${this.plan?.excluded.length} files are outside the current snapshot. Any still excluded after the final snapshot are deleted without jj recovery.`).text_color(t.blocked))
            .child(v_flex().id('jj-excluded').h(140).flex_none().overflow_y_scrollbar()
              .children((this.plan?.excluded ?? []).map((f, i) => text(JSON.stringify(f.path)).id(`jj-excluded-${i}`).text_size(11))))))
        .when(Boolean(this.error), el => el.child(text(this.error).text_color(t.blocked))))
      .child(h_flex().justify_end().gap(8)
        .when(this.step !== 'repository', el => el.child(button('jj-back', 'Change repository', (_e, cx) => this.reset(this.action, cx), !this.busy)))
        .child(button('jj-cancel', 'Cancel', () => closeOverlay(props().overlay), !this.busy))
        .when(Boolean(canGo), el => el.child(button('jj-go', this.step === 'confirm' ? 'Remove and delete checkout' : this.step === 'create' ? 'Create and open tab' : 'Open tab', (_e, cx) => this.go(cx), !this.busy)))
        .when(this.busy, el => el.child('Working…')));
  }
}
