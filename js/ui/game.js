// 对局状态。这一层**不含任何 Masyu 规则**：它只把玩家的落笔写进引擎自己的那条边数组
// （js/engine/pencil.js 的 state.edges，UNKNOWN/LOOP/CUT 三态），并且只通过 verify() 问一句
// 「这算赢了吗」。UI 里没有第二份记分板，所以画面和判胜不可能各说一套。
//
// 边的下标一律经 loop.js 的 edgeIdOf / neighbor / dirBetween 和 pencil.js 的 edgeOf / valOf
// 拿，本文件不重算任何索引几何——重算一次就多一个「画对了但点偏一格」的来源。

import { createState, verify, edgeOf, valOf, loopDirs, LOOP, CUT, UNKNOWN } from '../engine/pencil.js';
import { dirBetween, neighbor, UP, RIGHT, DOWN, LEFT } from '../engine/loop.js';
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

  // 玩家落笔的唯一入口：kind 就是引擎的三态 —— LOOP（画环）、CUT（排除叉）、UNKNOWN（擦回没落笔）。
  // 三条路（拖拽、右键、键盘）与提示都从这里过，所以撤销栈和 moves 记的就是玩家干的活，
  // 谁也没有旁路：不在手势里 = 自己就是一组（散点、右键那一下、提示的一条结论），
  // 在手势里 = 并进这一次 beginGesture 到 endGesture 的一组（一整笔拖拽一次撤销退完）。
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

  // 一条边在「叉」和「没落笔」之间来回：右键那一下走的就是这里。
  // LOOP 时也一步变成叉 —— 那是「这条我原先画错了，现在排除」，撤销照旧能退回环边；
  // 已经是叉再点一次才回到 UNKNOWN。两步都在 setEdge 的账上，不另开记分板。
  toggleCut(cell, d) {
    const e = edgeOf(this.st, cell, d);
    if (e < 0) return null;
    return this.setEdge(cell, d, this.st.edges[e] === CUT ? UNKNOWN : CUT);
  }

  // 只有边号、没有 (格, 方向) 的调用方（引擎给的一条结论）走的公开入口。
  // 边号→两端的格子取自引擎自己预计算的 st.edgeCells，方向取自 loop.js 的 dirBetween，
  // 然后再走 setEdge：提示落一笔和玩家拖一笔在撤销栈、moves、渲染上是同一条路。
  setEdgeById(edge, kind) {
    const pair = this.st.edgeCells[edge];
    if (!pair) return null;
    const d = dirBetween(this.w, pair[0], pair[1]);
    if (neighbor(this.w, this.h, pair[0], d) !== pair[1]) return null; // 引擎给的两端不相邻：宁可不写也不写错格
    return this.setEdge(pair[0], d, kind);
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

  // 擦掉一格引出的全部边（环边和叉都算，一律回到 UNKNOWN）：「擦掉」这一笔和键盘退格走的是这条。
  // 右键不在这里——右键是「就动指针压着的那一条边」，见 toggleCut。
  eraseAt(cell) {
    let touched = 0;
    for (const d of DIRS) if (this.setEdge(cell, d, UNKNOWN)) touched++;
    return touched;
  }

  undo() {
    const g = this.undoStack.pop();
    if (!g) return false;
    // 逐条退回落笔前的那个值：三态里的哪一种都照原样退（环退回环、叉退回叉），
    // 不存在「撤销把叉变成没落笔」这种偷偷的第二义。
    for (let i = g.length - 1; i >= 0; i--) this.st.edges[g[i].e] = g[i].prev;
    this.moves++;
    return true;
  }

  // 「全清」= 盘上一点笔迹都不留：环边和叉都在清扫范围内（只扫 LOOP 会留一地没人认领的叉）。
  clearAll() {
    const pairs = [];
    for (let cell = 0; cell < this.w * this.h; cell++) {
      for (const d of [RIGHT, DOWN]) {
        const v = valOf(this.st, cell, d);
        if (v === LOOP || v === CUT) pairs.push([cell, d]);
      }
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

  // 玩家（或提示）排除掉的边。和 loopEdges 一样只是数一数，给状态行和门禁读；胜负与它无关。
  cutEdges() {
    const out = [];
    for (let cell = 0; cell < this.w * this.h; cell++) {
      for (const d of [RIGHT, DOWN]) {
        const e = edgeOf(this.st, cell, d);
        if (e >= 0 && this.st.edges[e] === CUT) out.push(e);
      }
    }
    return out;
  }

  // 唯一的判胜入口。玩家只画了环边，没画的地方就是「不在环上」，所以这里把剩下的补成 CUT
  // 再交给引擎复核——判定本身一个字都没写在这里。
  //
  // 玩家自己标的叉在这里**不需要**被特殊对待：它和补出来的 CUT 是同一种东西（这条边不在环上），
  // 不是第三种状态。所以「玩家多画一个叉」绝不可能改变这里的结论，也就绝不可能在 UI 侧
  // 偷偷长出一块第二记分板。
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
  // 排除叉也得念出来——玩家能用键盘画它，只听「环边 0 条：无」是不够的。
  cellReport(cell) {
    const [r, c] = this.cellRC(cell);
    const dirs = loopDirs(this.st, cell).map((d) => DIR_NAME[d]);
    const cuts = [];
    for (const d of DIRS) if (valOf(this.st, cell, d) === CUT) cuts.push(DIR_NAME[d]);
    const p = this.face.pearls[r][c];
    return `第 ${r + 1} 行第 ${c + 1} 列${p ? `（${p === 'black' ? '黑珠' : '白珠'}）` : ''}，环边 ${dirs.length} 条：${dirs.join('、') || '无'}${
      cuts.length ? `，已排除 ${cuts.length} 条：${cuts.join('、')}` : ''
    }`;
  }
}

export { dirBetween, UP, RIGHT, DOWN, LEFT, LOOP, CUT, UNKNOWN };
