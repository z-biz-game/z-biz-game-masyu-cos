// Canvas 渲染层。它读 Game 手里那份引擎状态来画，自己不判断任何东西——没有哪条边在这里被
// 宣布「对」，也没有哪一格在这里被宣布「赢」——所以画面不可能和判胜用的 verify 打架。
//
// 布局（格边长、盘面原点、DPR）也住在这里，因为 hitCell 必须回答「玩家点的那一下是哪一格」，
// 用的必须是 draw 刚刚用过的那批数字。这两处分家就会出现「盘画对了、点击偏一格」的事故。
//
// 一条硬约束：环是画在**格心之间**的段上，所以每条边的下标都经 loop.js 的 neighbor /
// dirBetween / edgeIdOf 与 pencil.js 的 valOf 拿。这个文件里没有任何一处自己算边号。

import { Palette, Board, Radius } from '../theme.js';
import { neighbor, dirBetween, RIGHT, DOWN, UP, LEFT } from '../engine/loop.js';
import { valOf, LOOP, CUT } from '../engine/pencil.js';

const LOOP_DIRS = [RIGHT, DOWN]; // 每条无向边只从这两侧各画一次，免得重复描线

export function layoutFor(w, h, availW, availH) {
  const pad = Board.pad;
  const size = Math.max(0, Math.min((availW - pad * 2) / w, (availH - pad * 2) / h));
  const cell = Math.max(Board.cellMin, Math.min(Board.cellMax, Math.floor(size)));
  return { cell, boardW: cell * w, boardH: cell * h, pad };
}

export class BoardView {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { willReadFrequently: true });
    this.geo = { cell: 0, x: 0, y: 0, w: 0, h: 0, dpr: 1 };
    this.game = null;
  }

  // 后备缓冲按设备像素定尺寸，而每个绘制调用都留在 CSS 像素里：顶部一次 setTransform，
  // 就免得把这个文件里每个常数都乘二。
  resize(game, availW, availH) {
    const l = layoutFor(game.w, game.h, availW, availH);
    const dpr = Math.max(1, Math.round(window.devicePixelRatio || 1));
    const size = { w: l.boardW + l.pad * 2, h: l.boardH + l.pad * 2 };
    this.canvas.style.width = `${size.w}px`;
    this.canvas.style.height = `${size.h}px`;
    this.canvas.width = Math.round(size.w * dpr);
    this.canvas.height = Math.round(size.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.geo = { cell: l.cell, x: l.pad, y: l.pad, w: size.w, h: size.h, dpr, pad: l.pad };
    this.game = game;
    return this.geo;
  }

  // ---- 几何读数（CSS 像素，画布本地）-------------------------------------------
  // 门禁取样只许用这几个函数产出的坐标，再乘 geo.dpr：page/client 坐标里带着画布自己的
  // getBoundingClientRect 偏移，喂给 getImageData 会量到整个盘宽之外的面板底色上。

  centerOf(cell) {
    const { cell: k, x, y } = this.geo;
    const w = this.game.w;
    return { x: (cell % w) * k + x + k / 2, y: (((cell / w) | 0) * k) + y + k / 2 };
  }

  cellRect(cell) {
    const { cell: k, x, y } = this.geo;
    const w = this.game.w;
    const px = (cell % w) * k + x;
    const py = (((cell / w) | 0) * k) + y;
    return { x: px, y: py, w: k, h: k, size: k, cx: px + k / 2, cy: py + k / 2 };
  }

  // 一条环边的**包围盒**：中点 (x+w/2, y+h/2) 就是画笔经过的那一点，厚度取 lineWidth，
  // 所以环线粗细改了也不会让取样点跑出线外。
  segRect(cell, d) {
    const nb = neighbor(this.game.w, this.game.h, cell, d);
    if (nb < 0) return null;
    const a = this.centerOf(cell);
    const b = this.centerOf(nb);
    const t = Math.max(2, this.geo.cell * Board.loopWidth);
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    const w = Math.abs(b.x - a.x);
    const h = Math.abs(b.y - a.y);
    return {
      x: w > 0 ? x : x - t / 2,
      y: h > 0 ? y : y - t / 2,
      w: w > 0 ? w : t,
      h: h > 0 ? h : t,
      cell: nb,
      d,
    };
  }

  // 排除叉的**画法**（中心 + 半臂长 + 线宽）：中心就是这条边的中点，和 segRect 用的是同一批
  // 数，所以门禁按它取样必然落在画出来的那两笔上。draw 与取样只有这一个来源。
  markPoint(cell, d) {
    const nb = neighbor(this.game.w, this.game.h, cell, d);
    if (nb < 0) return null;
    const a = this.centerOf(cell);
    const b = this.centerOf(nb);
    const k = this.geo.cell;
    return {
      x: (a.x + b.x) / 2,
      y: (a.y + b.y) / 2,
      arm: Math.max(3, k * Board.cutArm),
      width: Math.max(1.5, k * Board.cutWidth),
    };
  }

  // 度数异常那一格的错误圈上的一点（45°，避开设在格心的珠子和沿轴走的环线）。
  ringPoint(cell) {
    const { cell: k } = this.geo;
    const c = this.centerOf(cell);
    const r = k * 0.42 * Math.SQRT1_2;
    return { x: c.x + r, y: c.y + r };
  }

  pearlR() {
    return this.geo.cell * Board.pearlR;
  }

  // 指针的 client 坐标 → 格号。画布外的点返回 -1。
  hitCell(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const { cell, x, y } = this.geo;
    const g = this.game;
    if (!cell || !g) return -1;
    const px = clientX - rect.left - x;
    const py = clientY - rect.top - y;
    const gx = Math.floor(px / cell);
    const gy = Math.floor(py / cell);
    if (gx < 0 || gy < 0 || gx >= g.w || gy >= g.h) return -1;
    return gy * g.w + gx;
  }

  // 指针的 client 坐标 → 这一格里**那一条边**。规则是「落在哪一半就动哪一条」：主轴（|dx| 与
  // |dy| 谁大）决定横竖，符号决定朝哪。正好点在格心时 dx=dy=0 → 记作 RIGHT，是确定的、可测的。
  // 出盘的方向（那里根本没有边）返回 null，由调用方什么也不做。
  // hitCell 与 hitEdge 读的是 draw 刚刚用过的同一批 geo，所以不可能「画对了点偏一格」。
  hitEdge(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const { cell, x, y } = this.geo;
    const g = this.game;
    if (!cell || !g) return null;
    const px = clientX - rect.left - x;
    const py = clientY - rect.top - y;
    const gx = Math.floor(px / cell);
    const gy = Math.floor(py / cell);
    if (gx < 0 || gy < 0 || gx >= g.w || gy >= g.h) return null;
    const hitCellNo = gy * g.w + gx;
    const dx = px - (gx * cell + cell / 2);
    const dy = py - (gy * cell + cell / 2);
    const d = Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? RIGHT : LEFT) : (dy >= 0 ? DOWN : UP);
    return neighbor(g.w, g.h, hitCellNo, d) < 0 ? null : { cell: hitCellNo, d };
  }

  // 两格之间那条边的方向（不相邻返回 -1）——交给引擎的 dirBetween 判，这里不算。
  dirFromTo(from, to) {
    const g = this.game;
    if (from < 0 || to < 0 || from === to) return -1;
    return neighbor(g.w, g.h, from, dirBetween(g.w, from, to)) === to ? dirBetween(g.w, from, to) : -1;
  }

  draw(game, { preview = [], cursor = -1, won = false } = {}) {
    this.game = game;
    if (!this.geo.cell) return;
    const { ctx, geo } = this;
    const k = geo.cell;
    const st = game.st;
    ctx.clearRect(0, 0, geo.w, geo.h);

    // 1) 盘面底色（环、珠子、错误圈都画在它上面，所以它是「这一格什么都没画」的参照色）
    roundRect(ctx, 0, 0, geo.w, geo.h, Radius.card);
    ctx.fillStyle = Palette.surface;
    ctx.fill();
    const bx = geo.x - k * 0.5;
    const by = geo.y - k * 0.5;
    roundRect(ctx, bx, by, k * game.w + k, k * game.h + k, Radius.cell);
    ctx.fillStyle = Palette.field;
    ctx.fill();

    // 2) 网格线：格与格之间的分隔，只画在边界上
    ctx.strokeStyle = Palette.gridLine;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let c = 1; c < game.w; c++) {
      const x = Math.round(geo.x + c * k) + 0.5;
      ctx.moveTo(x, geo.y);
      ctx.lineTo(x, geo.y + k * game.h);
    }
    for (let r = 1; r < game.h; r++) {
      const y = Math.round(geo.y + r * k) + 0.5;
      ctx.moveTo(geo.x, y);
      ctx.lineTo(geo.x + k * game.w, y);
    }
    ctx.stroke();

    // 3) 玩家画下的环段（引擎说 LOOP 才画，这里不判断任何事）
    const lw = Math.max(2, k * Board.loopWidth);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = Palette.accent;
    ctx.lineWidth = lw;
    for (let cell = 0; cell < game.w * game.h; cell++) {
      for (const d of LOOP_DIRS) {
        if (valOf(st, cell, d) !== LOOP) continue;
        const a = this.centerOf(cell);
        const b = this.centerOf(neighbor(game.w, game.h, cell, d));
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }

    // 拖拽中的预览：同一个画法、半透明，松手才真的进状态
    if (preview.length) {
      ctx.globalAlpha = won ? 1 : 0.55;
      for (const [cell, d] of preview) {
        const nb = neighbor(game.w, game.h, cell, d);
        if (nb < 0) continue;
        const a = this.centerOf(cell);
        const b = this.centerOf(nb);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    ctx.lineCap = 'butt';

    // 3½) 被排除的边（引擎三态里的 CUT）：在边的中点上画一个小叉。
    //     它是「这条边不在环上」的形状证据，不是「这里什么都没画」的同义词 —— 未落笔的边在
    //     这一层一条都不该出现（draw 只认 valOf 给的 CUT，别的什么都不认）。
    //     两条臂沿 45°，所以中点两侧都不会盖到格心的珠子或端点冷白；珠子还在第 6 步之上。
    for (let cell = 0; cell < game.w * game.h; cell++) {
      for (const d of LOOP_DIRS) {
        if (valOf(st, cell, d) !== CUT) continue;
        const m = this.markPoint(cell, d);
        if (!m) continue;
        ctx.strokeStyle = Palette.cutMark;
        ctx.lineWidth = m.width;
        ctx.lineCap = 'round';
        const a = m.arm * Math.SQRT1_2; // 半臂在 x/y 上的投影
        ctx.beginPath();
        ctx.moveTo(m.x - a, m.y - a);
        ctx.lineTo(m.x + a, m.y + a);
        ctx.moveTo(m.x - a, m.y + a);
        ctx.lineTo(m.x + a, m.y - a);
        ctx.stroke();
        ctx.lineCap = 'butt';
      }
    }

    // 4) 环的端点（度数 1）：一个冷白点，说明这一头还没接上
    ctx.fillStyle = Palette.capDot;
    for (let cell = 0; cell < game.w * game.h; cell++) {
      if (game.degree(cell) !== 1) continue;
      const c = this.centerOf(cell);
      ctx.beginPath();
      ctx.arc(c.x, c.y, Math.max(2, k * 0.085), 0, Math.PI * 2);
      ctx.fill();
    }

    // 5) 度数异常的格：既不是 0 也不是 2，环在这一格接不通。圈是形状证据，色是附加证据。
    for (const cell of game.badCells()) {
      const c = this.centerOf(cell);
      ctx.fillStyle = Palette.errorSoft;
      ctx.beginPath();
      ctx.arc(c.x, c.y, k * 0.46, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = Palette.badRing;
      ctx.lineWidth = Math.max(2, k * Board.badRingWidth);
      ctx.beginPath();
      ctx.arc(c.x, c.y, k * 0.42, 0, Math.PI * 2);
      ctx.stroke();
    }

    // 6) 珠子。题面形状来自引擎的 toView（'black' | 'white' | null），不是这里数出来的。
    //    画在环之上，所以「这一格有珠子」永远压得过环线。
    for (let r = 0; r < game.h; r++) {
      for (let c = 0; c < game.w; c++) {
        const kind = game.face.pearls[r][c];
        if (!kind) continue;
        const p = this.centerOf(r * game.w + c);
        const rad = this.pearlR();
        ctx.beginPath();
        ctx.arc(p.x, p.y, rad, 0, Math.PI * 2);
        ctx.fillStyle = kind === 'black' ? Palette.pearlBlack : Palette.pearlWhite;
        ctx.fill();
        ctx.lineWidth = Math.max(1.5, k * Board.ringWidth);
        ctx.strokeStyle = kind === 'black' ? Palette.pearlRing : Palette.pearlRingDark;
        ctx.stroke();
      }
    }

    // 7) 键盘光标：虚线圈，指针玩家看不到它（sel 只在键盘操作时移动）
    if (cursor >= 0) {
      const c = this.centerOf(cursor);
      ctx.strokeStyle = Palette.info;
      ctx.lineWidth = Math.max(2, k * 0.06);
      ctx.setLineDash([Math.max(4, k * 0.2), Math.max(3, k * 0.14)]);
      ctx.beginPath();
      ctx.arc(c.x, c.y, k * 0.34, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // 给 harness 用：这一条边此刻应当是什么颜色，由取色逻辑自己回答，免得测试里另抄一份调色板。
  // 三态给三个答案：LOOP 是环线色、CUT 是叉色、没落笔的边中点落在网格线上（gridLine），
  // 那里绝不是盘底 field —— 所以「未落笔」的证据只能是「既不是 accent 也不是叉色」，别写反。
  colorOfSegment(cell, d) {
    const v = valOf(this.game.st, cell, d);
    return v === LOOP ? Palette.accent : v === CUT ? Palette.cutMark : Palette.gridLine;
  }
  colorOfPearl(kind) {
    return kind === 'black' ? Palette.pearlBlack : kind === 'white' ? Palette.pearlWhite : Palette.field;
  }
  badColor() {
    return Palette.badRing;
  }
}

function roundRect(ctx, x, y, w, h, r) {
  const k = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + k, y);
  ctx.arcTo(x + w, y, x + w, y + h, k);
  ctx.arcTo(x + w, y + h, x, y + h, k);
  ctx.arcTo(x, y + h, x, y, k);
  ctx.arcTo(x, y, x + w, y, k);
  ctx.closePath();
}
