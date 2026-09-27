// 对局状态。这一层**不含任何 Masyu 规则**：它只把玩家的落笔写进引擎自己的那条边数组
// （js/engine/pencil.js 的 state.edges，UNKNOWN/LOOP/CUT 三态），并且只通过 verify() 问一句
// 「这算赢了吗」。UI 里没有第二份记分板，所以画面和判胜不可能各说一套。
//
// 边的下标一律经 loop.js 的 edgeIdOf / neighbor / dirBetween 和 pencil.js 的 edgeOf / valOf
// 拿，本文件不重算任何索引几何——重算一次就多一个「画对了但点偏一格」的来源。

import { createState, verify, edgeOf, valOf, loopDirs, LOOP, CUT, UNKNOWN } from '../engine/pencil.js';
import { dirBetween, UP, RIGHT, DOWN, LEFT } from '../engine/loop.js';
import { toView } from '../engine/generate.js';

export const DIRS = [UP, RIGHT, DOWN, LEFT];
export const DIR_NAME = { [UP]: '上', [RIGHT]: '右', [DOWN]: '下', [LEFT]: '左' };

export class Game {
  constructor(puzzle) {
    if (!puzzle || !puzzle.ok) throw new Error('拿不到题面，开不了局');
    this.puzzle = puzzle;
    this.seed = puzzle.seed;
    this.sizeKey = puzzle.sizeKey;
    this.w = puzzle.w;
    this.h = puzzle.h;
    // 题面的显示形状由引擎的渲染适配器给（round 1 约定的 toView）——视图层不许自己从
    // 原始 Int8Array 里再推一遍珠子在哪。
    this.face = toView(puzzle);
    // 权威状态：pearls 只读，edges 就是玩家画的那支笔。
    this.st = createState({ w: this.w, h: this.h, pearls: puzzle.pearls });
    this.undoStack = [];
    this._group = null;
    this.moves = 0;
  }

  cellRC(cell) {
    return [Math.floor(cell / this.w), cell % this.w];
  }

  cellOf(r, c) {
    return r * this.w + c;
  }

  inside(r, c) {
    return r >= 0 && c >= 0 && r < this.h && c < this.w;
  }

  // 玩家落笔的唯一入口：kind 只有 LOOP（画环）和 UNKNOWN（擦掉）两种，本 round 不做排除叉。
  // 撤销记录也在这里长出来：开着一次手势（beginGesture 到 endGesture）就并进同一组，一次 undo
  // 退一整笔拖拽；没开手势的散点（键盘、右键擦）自己就是一组。
  setEdge(cell, d, kind) {
    const e = edgeOf(this.st, cell, d);
    if (e < 0) return null; // 那里根本没有边（出盘了）
    const prev = this.st.edges[e];
    if (prev === kind) return null;
    this.st.edges[e] = kind;
    const rec = { e, cell, d, prev, kind };
    if (this._group) this._group.push(rec);
    else {
      this.undoStack.push([rec]);
      this.moves++;
    }
    return rec;
  }

  // 一次拖拽 = 一个撤销组。
  beginGesture() {
    this._group = [];
  }

  endGesture() {
    const g = this._group || [];
    this._group = null;
    if (!g.length) return false;
    this.undoStack.push(g);
    this.moves++;
    return true;
  }

  // 擦掉一格引出的全部环边（右键 / 键盘退格走的都是这条）。
  eraseAt(cell) {
    let touched = 0;
    for (const d of DIRS) if (this.setEdge(cell, d, UNKNOWN)) touched++;
    return touched;
  }

  undo() {
    const g = this.undoStack.pop();
    if (!g) return false;
    for (let i = g.length - 1; i >= 0; i--) this.st.edges[g[i].e] = g[i].prev;
    this.moves++;
    return true;
  }

  clearAll() {
    const pairs = [];
    for (let cell = 0; cell < this.w * this.h; cell++) {
      for (const d of [RIGHT, DOWN]) if (valOf(this.st, cell, d) === LOOP) pairs.push([cell, d]);
    }
    for (const [cell, d] of pairs) this.st.edges[edgeOf(this.st, cell, d)] = UNKNOWN;
    this.moves++;
    return pairs.length;
  }

  degree(cell) {
    return loopDirs(this.st, cell).length;
  }

  // 「这一格的环边接不通」——一条环边都不画是一格没参与，画 3 条以上就不是简单环了。
  // 度数 1 不在这里：那是拖到一半的正常开口，由 endpoints() 单独说、画成冷白端点。
  // 这纯粹是计数，不是规则推理；谁赢了仍然只有 verify 说了算。
  badCells() {
    const out = [];
    for (let cell = 0; cell < this.w * this.h; cell++) if (this.degree(cell) >= 3) out.push(cell);
    return out;
  }

  endpoints() {
    const out = [];
    for (let cell = 0; cell < this.w * this.h; cell++) if (this.degree(cell) === 1) out.push(cell);
    return out;
  }

  loopEdges() {
    const out = [];
    for (let cell = 0; cell < this.w * this.h; cell++) {
      for (const d of [RIGHT, DOWN]) {
        const e = edgeOf(this.st, cell, d);
        if (e >= 0 && this.st.edges[e] === LOOP) out.push(e);
      }
    }
    return out;
  }

  // 唯一的判胜入口。玩家只画了环边，没画的地方就是「不在环上」，所以这里把剩下的补成 CUT
  // 再交给引擎复核——判定本身一个字都没写在这里。
  status() {
    const probe = createState({ w: this.w, h: this.h, pearls: this.st.pearls });
    probe.edges.fill(CUT);
    for (let e = 0; e < this.st.edges.length; e++) if (this.st.edges[e] === LOOP) probe.edges[e] = LOOP;
    return verify(probe);
  }

  // 存档：只存原始 seed + 尺寸 + 每条边一个字符。生成器是确定性的，盘面从来不需要经过存储搬运。
  encode() {
    let s = '';
    for (let e = 0; e < this.st.edges.length; e++) s += this.st.edges[e] === LOOP ? '1' : '0';
    return s;
  }

  decode(s) {
    for (let e = 0; e < this.st.edges.length; e++) this.st.edges[e] = s.charCodeAt(e) === 49 ? LOOP : UNKNOWN;
    this.undoStack = [];
    this.moves = 0;
  }

  // 键盘/无障碍读数：这一格现在什么样，全部来自引擎的 valOf/loopDirs。
  cellReport(cell) {
    const [r, c] = this.cellRC(cell);
    const dirs = loopDirs(this.st, cell).map((d) => DIR_NAME[d]);
    const p = this.face.pearls[r][c];
    return `第 ${r + 1} 行第 ${c + 1} 列${p ? `（${p === 'black' ? '黑珠' : '白珠'}）` : ''}，环边 ${dirs.length} 条：${dirs.join('、') || '无'}`;
  }
}

export { dirBetween, UP, RIGHT, DOWN, LEFT, LOOP, CUT, UNKNOWN };
