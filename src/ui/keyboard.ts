import { store } from '../store/store';
import { loupeView, setLoupeView } from './Loupe';
import { LABEL_KEYS } from './labels';

const { state, actions } = store;

function afterMark() {
  if (state.settings.autoAdvance && state.selection.length <= 1) actions.go(1);
}

let spaceZoom = false;

const REPEATABLE = new Set(['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', ' ', '=', '+', '-', '0', '1', '2', '3', '4', '5', 'u', 'U']);
const TOGGLE_MARKS = new Set(['p', 'P', 'x', 'X', '6', '7', '8', '9', 'v', 'V']);

export function handleKey(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) {
    if (e.key === 'Escape') (t as HTMLInputElement).blur();
    return false;
  }
  if (state.screen !== 'library') return false;
  if (state.dialog) {
    if (e.key === 'Escape') actions.setState('dialog', '');
    return false;
  }
  const mod = e.metaKey || e.ctrlKey;
  const k = e.key;

  if (mod && (k === 'z' || k === 'Z')) {
    const ok = e.shiftKey ? actions.redo() : actions.undo();
    actions.toast(ok ? (e.shiftKey ? '已重做' : '已撤销') : e.shiftKey ? '没有可重做的操作' : '没有可撤销的操作');
    return true;
  }
  if (mod && k === 'a') {
    actions.selectAll();
    return true;
  }
  if (mod) return false;
  // Auto-repeat must not flip toggles on and off (holding P would end in a random state).
  // Toggling marks may repeat only when auto-advance moves to a new photo each time.
  if (e.repeat && !REPEATABLE.has(k) && !(state.settings.autoAdvance && TOGGLE_MARKS.has(k))) return true;

  const cols = state.view === 'grid' ? ((window as any).__gridCols as number) || 1 : 1;
  switch (k) {
    case 'ArrowRight':
      actions.go(1, e.shiftKey);
      return true;
    case 'ArrowLeft':
      actions.go(-1, e.shiftKey);
      return true;
    case 'ArrowDown':
      actions.go(state.view === 'grid' ? cols : 1, e.shiftKey);
      return true;
    case 'ArrowUp':
      actions.go(state.view === 'grid' ? -cols : -1, e.shiftKey);
      return true;
    case 'Home':
      actions.goTo(0);
      return true;
    case 'End':
      actions.goTo(1e9);
      return true;
    case 'PageDown':
      actions.go(cols * 5);
      return true;
    case 'PageUp':
      actions.go(-cols * 5);
      return true;
    case 'Enter':
    case 'e':
    case 'E':
      actions.setView(state.view === 'loupe' && k === 'Enter' ? 'grid' : 'loupe');
      return true;
    case 'g':
    case 'G':
      actions.setView('grid');
      return true;
    case 'c':
    case 'C':
      actions.setView('compare');
      return true;
    case 'Escape':
      if (state.view !== 'grid') actions.setView('grid');
      else actions.clearSelection();
      return true;
    case ' ':
      if (state.view === 'grid') {
        actions.setView('loupe');
        return true;
      }
      if (!e.repeat && loupeView().zoom === 'fit') {
        spaceZoom = true;
        setLoupeView({ zoom: 1, cx: 0.5, cy: 0.5 });
      }
      return true;
    case 'z':
    case 'Z':
      if (state.view === 'grid') actions.setView('loupe');
      setLoupeView((v) => (v.zoom === 'fit' ? { zoom: 1, cx: 0.5, cy: 0.5 } : { zoom: 'fit', cx: 0.5, cy: 0.5 }));
      return true;
    case 'p':
    case 'P':
      actions.setFlag(state.photos[state.current]?.flag === 1 && state.selection.length <= 1 ? 0 : 1);
      afterMark();
      return true;
    case 'x':
    case 'X':
      actions.setFlag(state.photos[state.current]?.flag === -1 && state.selection.length <= 1 ? 0 : -1);
      afterMark();
      return true;
    case 'u':
    case 'U':
      actions.setFlag(0);
      afterMark();
      return true;
    case '0':
    case '1':
    case '2':
    case '3':
    case '4':
    case '5':
      actions.setRating(Number(k));
      afterMark();
      return true;
    case '6':
    case '7':
    case '8':
    case '9':
      actions.toggleLabel(LABEL_KEYS[Number(k) - 6]);
      afterMark();
      return true;
    case 'v':
    case 'V':
      actions.toggleLabel('purple');
      afterMark();
      return true;
    case 'i':
    case 'I':
      actions.setSettings({ showInfo: !state.settings.showInfo });
      return true;
    case 'h':
    case 'H':
      actions.setSettings({ showClipping: !state.settings.showClipping });
      actions.toast(state.settings.showClipping ? '高光/阴影溢出提示：开' : '高光/阴影溢出提示：关');
      return true;
    case 'CapsLock':
    case 'a':
    case 'A':
      actions.setSettings({ autoAdvance: !state.settings.autoAdvance });
      actions.toast(state.settings.autoAdvance ? '自动前进：开' : '自动前进：关');
      return true;
    case 's':
    case 'S':
      actions.setFilter({ stacks: !state.filter.stacks });
      actions.toast(state.filter.stacks ? '连拍折叠：只显示每组推荐' : '连拍折叠：关');
      return true;
    case '?':
      actions.setState('dialog', 'help');
      return true;
    case '=':
    case '+':
      actions.setSettings({ thumbSize: Math.min(480, state.settings.thumbSize + 40) });
      return true;
    case '-':
      actions.setSettings({ thumbSize: Math.max(100, state.settings.thumbSize - 40) });
      return true;
  }
  return false;
}

export function handleKeyUp(e: KeyboardEvent) {
  if (e.key === ' ' && spaceZoom) {
    spaceZoom = false;
    setLoupeView({ zoom: 'fit', cx: 0.5, cy: 0.5 });
  }
}

export const SHORTCUTS: [string, string][] = [
  ['← → ↑ ↓', '上一张 / 下一张（网格中按行移动）'],
  ['Shift + 方向键', '扩展选择'],
  ['Enter / E', '放大视图'],
  ['G / Esc', '回到网格'],
  ['C', '对比视图（选中 2–4 张，或当前与下一张）'],
  ['Space', '网格中：打开放大视图；放大视图中：按住临时 100%'],
  ['Z / 单击图片', '适合屏幕 ↔ 100%'],
  ['⌘/Ctrl + 滚轮', '缩放'],
  ['P', '保留（再按取消）'],
  ['X', '淘汰（再按取消）'],
  ['U', '清除旗标'],
  ['1–5 / 0', '星级 / 清除星级'],
  ['6 7 8 9 / V', '红 黄 绿 蓝 / 紫色标'],
  ['A / Caps Lock', '自动前进开关'],
  ['S', '连拍折叠（只看每组推荐）'],
  ['H', '高光 / 阴影溢出提示'],
  ['I', '信息面板'],
  ['+ / -', '缩略图大小'],
  ['⌘/Ctrl + Z', '撤销；加 Shift 重做'],
  ['⌘/Ctrl + A', '全选'],
  ['?', '快捷键帮助'],
];
