import { View, div } from 'gpui-kit';
import { v_flex, h_flex } from 'gpui-base';
import { spaces, theme, run, openOverlay } from 'herdr';

const glyph = status => ({ blocked: '!', done: '●', working: '◌', idle: '○' })[status] ?? '·';

export default class JJSpaces extends View {
  init() { this.pressed = null; }

  render() {
    const t = theme(), all = spaces();
    const groups = [...new Set(all.map(s => s.machine ?? null))];
    const row = space => h_flex().id(`jj-space-${space.id}`).h(34).px(9).gap(8).items_center().rounded(7).flex_none()
      .bg(space.active ? t.selected : t.chrome).hover(el => el.bg(t.hover))
      .on_mouse_down('left', () => { this.pressed = space.id; })
      .on_mouse_up('left', () => {
        const source = all.find(s => s.id === this.pressed);
        this.pressed = null;
        if (source && source.id !== space.id && source.machine === space.machine) run('space.move', { id: source.id, index: space.index });
        else run('space.select', { id: space.id });
      })
      .on_mouse_down('right', () => openOverlay({ mod: 'jj-menu', kind: 'popup', width: 240, props: { tab: 'space', target: { id: space.id } } }))
      .child(div().text_color(t[space.status] ?? t.dim).child(glyph(space.status)))
      .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(space.name));
    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
      .on_mouse_up('left', () => { this.pressed = null; })
      .child(h_flex().h(31).px(16).gap(10).items_center().text_color(t.dim)
        .child(div().flex_1().child('Spaces'))
        .child(div().id('jj-workspaces').cursor_pointer().on_click(() => openOverlay({ mod: 'jj-workspace', kind: 'dialog', modal: true, width: 720, height: 680 })).child('Workspaces…'))
        .child(div().id('jj-space-new').cursor_pointer().on_click(() => run('space.new')).child('+')))
      .child(v_flex().flex_1().min_h(0).px(8).overflow_y_scrollbar()
        .children(groups.flatMap(machine => [
          ...(groups.length > 1 ? [div().px(9).py(6).text_size(11).text_color(t.dim).child(machine ?? 'This computer')] : []),
          ...all.filter(s => (s.machine ?? null) === machine).map(row),
        ])));
  }
}
