import process from 'node:process';

const uni = process.platform !== 'win32' || Boolean(process.env.WT_SESSION) || process.env.TERM_PROGRAM === 'vscode';

export const S = uni
  ? {
      tick: '✔', cross: '✖', warn: '▲', info: 'ℹ', dot: '●', ring: '○', arrow: '→',
      chevron: '❯', bullet: '•', line: '─', vline: '│', ellipsis: '…', up: '↑', down: '↓',
      play: '▸', pause: '‖', bolt: '⚡', pkg: '◈', globe: '◍', clock: '◔', star: '★',
      corner: '└', tee: '├', block: '█', half: '▌', shade: '░', grad: '▁▂▃▄▅▆▇█',
    }
  : {
      tick: 'v', cross: 'x', warn: '!', info: 'i', dot: '*', ring: 'o', arrow: '->',
      chevron: '>', bullet: '-', line: '-', vline: '|', ellipsis: '...', up: '^', down: 'v',
      play: '>', pause: '||', bolt: '!', pkg: '#', globe: '@', clock: 'o', star: '*',
      corner: '`', tee: '+', block: '#', half: '|', shade: '.', grad: '.:-=+*#%@',
    };

export const BOX = uni
  ? { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│', lt: '├', rt: '┤', tt: '┬', bt: '┴', x: '┼' }
  : { tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|', lt: '+', rt: '+', tt: '+', bt: '+', x: '+' };

export const unicode = uni;
