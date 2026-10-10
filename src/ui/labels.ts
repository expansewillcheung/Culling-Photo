import type { ColorLabel } from '../core/types';

export const LABEL_COLORS: Record<ColorLabel, string> = {
  '': 'transparent',
  red: 'var(--red)',
  yellow: 'var(--yellow)',
  green: 'var(--green)',
  blue: 'var(--blue)',
  purple: 'var(--purple)',
};

export const LABEL_NAMES: Record<ColorLabel, string> = {
  '': '无',
  red: '红',
  yellow: '黄',
  green: '绿',
  blue: '蓝',
  purple: '紫',
};

export const LABEL_KEYS: ColorLabel[] = ['red', 'yellow', 'green', 'blue', 'purple'];
