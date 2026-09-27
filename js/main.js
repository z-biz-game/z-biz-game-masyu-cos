// 接线：DOM、指针、键盘、时钟、存档，以及验收 harness 驱动的 window.masyu 那层门面。
//
// window.masyu.engine 挂的就是页面自己 import 的那张模块图（不是为测试另抄一份），所以
// 门禁在浏览器里绿一次，等于玩家那侧的出题器/推理机同时绿一次。
//
// 这里没有一条 Masyu 规则：落笔写进引擎的边数组，赢不赢问 verify()，画什么由 render/board.js
// 读同一批数字。唯一留在这层的判断是「指针这一下落在哪一格、连着上一格的方向是什么」，
// 而那也要经 view.dirFromTo → loop.js 的 dirBetween/neighbor。

import { Palette, Space, applyThemeVars, setReduceMotion } from './theme.js';
import { Store } from './store.js';
import { makePuzzle, toView, SIZES, parseSize } from './engine/generate.js';
import { edgeIdOf, edgeCount, neighbor, dirBetween, checkLoop, loopOrder, UP, RIGHT, DOWN, LEFT, BLACK, WHITE } from './engine/loop.js';
import { createState, verify, solveWithRules, RULE_ORDER, RULE_TEXT, edgeOf, valOf, unknownCount, LOOP, CUT, UNKNOWN } from './engine/pencil.js';
import { BoardView } from './render/board.js';
import { Game } from './ui/game.js';

const VERSION = '0.1.0';
const DEFAULT_SIZE = '6x6';
const $ = (id) => document.getElementById(id);

applyThemeVars();
setReduceMotion(Store.setting('reduceMotion') === true);

const canvas = $('board');
const wrap = $('board-wrap');
const veil = $('win-veil');
const stateLine = $('state-line');
const srCell = $('sr-cell');
const sizeSelect = $('size-select');
const verifyLine = $('verify-line');

const view = new BoardView(canvas);
let game = null;
// 三支笔，对着引擎的三态：画环=LOOP、排除叉=CUT、擦掉=UNKNOWN。
// 「排除叉」是一支真的笔，不是「擦掉」的别名：它把一条边写成 CUT，画出来是一个小叉。
let mode = 'loop'; // 'loop' | 'cut' | 'erase'
const PEN = { loop: LOOP, cut: CUT, erase: UNKNOWN };
let drag = null;
let cursor = -1; // 键盘光标
let anchor = -1; // 键盘连线锚点
let won = false;

// ── 时钟 ────────────────────────────────────────────────────────────────
let startedAt = 0;
let baseElapsed = 0;
const clock = () => baseElapsed + (startedAt ? Date.now() - startedAt : 0);
function startClock() {
  if (!startedAt) startedAt = Date.now();
}
function fmt(ms) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
setInterval(() => {
  $('stat-time').textContent = fmt(clock());
}, 500);

// ── seed ────────────────────────────────────────────────────────────────
// 「换一局」必须真的换一局。日期当默认 seed 是两个隔壁仓刚踩过的坑：那个按钮叫换一局，
// 结果一整天都在发同一张盘。所以随机只发生在**选 seed**这一步，生成器内部一点随机都不许有。
let seedCounter = 0;
function mintSeed() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  seedCounter++;
  return `m${seedCounter.toString(36)}-${hex}`;
}

// ── 渲染 ────────────────────────────────────────────────────────────────
function avail() {
  const w = Math.max(280, wrap.clientWidth || 520);
  const h = Math.max(280, Math.min(w, window.innerHeight - 220));
  return { w, h };
}

function render() {
  if (!game) return;
  const preview = [];
  if (anchor >= 0 && cursor >= 0 && anchor !== cursor) {
    const d = view.dirFromTo(anchor, cursor);
    if (d >= 0) preview.push([anchor, d]);
  }
  view.draw(game, { preview, cursor, won });
  paintStats();
}

function paintStats() {
  const p = game.puzzle;
  const bad = game.badCells();
  const ends = game.endpoints();
  const segs = game.loopEdges();
  const cuts = game.cutEdges();
  $('stat-seed').textContent = `seed ${game.seed}`;
  $('stat-black').textContent = String(p.black);
  $('stat-white').textContent = String(p.white);
  $('stat-segs').textContent = String(segs.length);
  $('stat-cuts').textContent = String(cuts.length);
  $('stat-ends').textContent = String(ends.length);
  const badEl = $('stat-bad');
  badEl.textContent = String(bad.length);
  badEl.classList.toggle('bad', bad.length > 0);
  $('stat-moves').textContent = String(game.moves);
  $('stat-time').textContent = fmt(clock());
  const v = game.status();
  const vEl = $('stat-verify');
  vEl.textContent = v.ok ? `闭环 ${v.length} 格` : '未成';
  vEl.classList.toggle('good', !!v.ok);
  vEl.classList.remove('bad');
  verifyLine.textContent = v.ok
    ? `verify() → { ok: true, length: ${v.length} }`
    : `verify() → ${v.why}`;
  if (!won) {
    stateLine.className = 'state-line' + (bad.length ? ' bad' : '');
    stateLine.textContent = bad.length
      ? `${bad.length} 格引出了 3 条以上的环边 —— 那里不可能接成一条环。${v.why || ''}`
      : segs.length === 0
        ? '拖拽相邻两格连一段环；右键落在哪条边上就把那条边画成排除叉。黑珠那格必须拐，白珠那格必须直穿。'
        : `已画 ${segs.length} 段、排除 ${cuts.length} 条，${ends.length} 个没接上的端点。引擎说：${v.why || '成环了'}`;
  }
}

// ── 判胜：唯一的入口是引擎的 verify，UI 不给自己记账 ─────────────────────
function checkWin() {
  if (won) return true;
  const v = game.status();
  if (!v.ok) return false;
  won = true;
  veil.hidden = false;
  $('win-meta').textContent = `环长 ${v.length} 格 · ${game.puzzle.pearlCount} 颗珠 · ${game.moves} 步 · ${fmt(clock())}`;
  stateLine.className = 'state-line good';
  stateLine.textContent = `verify() 判定通过：一条 ${v.length} 格的闭环，每颗珠子都服帖。`;
  Store.recordSolve(clock(), game.moves);
  Store.clearResume();
  render();
  return true;
}

function hideVeil() {
  veil.hidden = true;
}

// ── 开局 ────────────────────────────────────────────────────────────────
let busy = false;
async function generate(seed, sizeKey) {
  busy = true;
  $('btn-new').disabled = true;
  $('btn-new').textContent = '生成中…';
  stateLine.className = 'state-line';
  stateLine.textContent = '正在出题：铅笔要零猜测推得完、计数器要说唯一——两道门都过了才发给你。';
  // 生成器是同步的（6x6 实测几百毫秒），让出一帧好让「生成中」真的看得见
  await new Promise((r) => setTimeout(r, 0));
  const p = makePuzzle(seed, sizeKey, { requireBothColors: false });
  busy = false;
  $('btn-new').disabled = false;
  $('btn-new').textContent = '换一局';
  return p;
}

async function newGame({ seed = mintSeed(), sizeKey = game ? game.sizeKey : DEFAULT_SIZE, marks = null, moves = 0, elapsedMs = 0 } = {}) {
  const p = await generate(seed, sizeKey);
  if (!p.ok) {
    stateLine.className = 'state-line bad';
    stateLine.textContent = `这个 seed 出不了盘（${p.status}）：换一个。`;
    return null;
  }
  game = new Game(p);
  // 存档的字符串长度必须正好对上这张盘的边数——对不上就不搬（尺寸换过、串被截断都算）。
  // 步数只在笔迹真的搬过来之后才跟着搬：盘是空的却说「这局走了 12 步」又是另一句谎话。
  if (typeof marks === 'string' && marks.length === edgeCount(p.w, p.h)) game.decode(marks, moves);
  won = false;
  hideVeil();
  // 键盘光标只在真的用键盘之后才出现：一个刚用鼠标点开游戏的玩家不该先看见一圈虚线
  cursor = -1;
  anchor = -1;
  baseElapsed = elapsedMs || 0;
  startedAt = Date.now();
  relayout();
  render();
  persist();
  return game;
}

function relayout() {
  if (!game) return;
  const a = avail();
  view.resize(game, a.w, a.h);
}

function persist() {
  if (!game || won) return;
  Store.saveResume(game, clock());
}

function setMode(next) {
  // 判「这个笔名认不认」用 in，不用取值真假：擦掉那支笔的 kind 就是 UNKNOWN=0，
  // 写成 PEN[next] ? next : 'loop' 会把「擦掉」当成没认出来、悄悄退回画环。
  mode = next in PEN ? next : 'loop';
  $('btn-mode-loop').setAttribute('aria-pressed', String(mode === 'loop'));
  $('btn-mode-cut').setAttribute('aria-pressed', String(mode === 'cut'));
  $('btn-mode-erase').setAttribute('aria-pressed', String(mode === 'erase'));
  canvas.style.cursor = mode === 'erase' ? 'cell' : 'crosshair';
}

// ── 指针 ────────────────────────────────────────────────────────────────
// 拖拽走的是「相邻格心」：每一段都问 view 要方向，view 再问 loop.js。
// 不相邻的两格（甩太快）只会挪锚点，不会凭空长出一条斜边。
// 左键是**铺笔**：经过的每一条边都写成当前那支笔（loop→LOOP、cut→CUT、erase→UNKNOWN），
// 一整笔拖拽是一组撤销。右键是**就动指针压着的那一条边**：叉 ↔ 没落笔（LOOP 先变叉），
// 一次点击一组撤销一步。
canvas.addEventListener('pointerdown', (ev) => {
  if (!game) return;
  const cell = view.hitCell(ev.clientX, ev.clientY);
  if (cell < 0) return;
  ev.preventDefault();
  try {
    canvas.setPointerCapture(ev.pointerId);
  } catch {
    /* 合成事件没有真的 pointerId：下面的 move/up 仍然按 clientX/Y 走同一条路 */
  }
  startClock();
  if (ev.button === 2) {
    const hit = view.hitEdge(ev.clientX, ev.clientY);
    if (hit) game.toggleCut(hit.cell, hit.d); // 不在手势里：setEdge 自己就是一组
    render();
    persist();
    return;
  }
  const kind = PEN[mode];
  game.beginGesture();
  drag = { cells: [cell], kind };
  cursor = cell;
  if (mode === 'erase') game.eraseAt(cell);
  else if (mode === 'cut') {
    const hit = view.hitEdge(ev.clientX, ev.clientY);
    if (hit) game.setEdge(hit.cell, hit.d, CUT);
  }
  render();
});

canvas.addEventListener('pointermove', (ev) => {
  if (!game || !drag) return;
  const cell = view.hitCell(ev.clientX, ev.clientY);
  if (cell < 0) return;
  const last = drag.cells[drag.cells.length - 1];
  if (cell === last) return;
  const d = view.dirFromTo(last, cell);
  if (d < 0) return; // 不相邻：只挪笔，不连线
  drag.cells.push(cell);
  game.setEdge(last, d, drag.kind);
  cursor = cell;
  render();
});

async function endDrag() {
  if (!drag) return;
  drag = null;
  game.endGesture();
  render();
  await checkWin();
  persist();
}
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);
canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());

// ── 键盘 ────────────────────────────────────────────────────────────────
window.addEventListener('keydown', async (ev) => {
  if (!game) return;
  if (ev.target && /INPUT|SELECT|TEXTAREA/.test(ev.target.tagName)) return;
  const k = ev.key;
  const w = game.w;
  const h = game.h;
  const move = (dr, dc) => {
    if (cursor < 0) cursor = 0;
    const r = Math.min(h - 1, Math.max(0, Math.floor(cursor / w) + dr));
    const c = Math.min(w - 1, Math.max(0, (cursor % w) + dc));
    cursor = r * w + c;
    anchor = -1;
    srCell.textContent = game.cellReport(cursor);
  };
  if (k === 'ArrowUp') move(-1, 0);
  else if (k === 'ArrowDown') move(1, 0);
  else if (k === 'ArrowLeft') move(0, -1);
  else if (k === 'ArrowRight') move(0, 1);
  else if (k === 'Enter' || k === ' ') {
    ev.preventDefault();
    startClock();
    if (cursor < 0) cursor = 0; // 纯键盘进场的玩家可能还没碰过方向键
    if (anchor < 0) {
      anchor = cursor;
      srCell.textContent = `锚在第 ${Math.floor(cursor / w) + 1} 行第 ${cursor % w + 1} 列`;
    } else if (anchor !== cursor) {
      const d = view.dirFromTo(anchor, cursor);
      game.beginGesture();
      if (d >= 0) {
        // 叉那支笔在键盘上是**翻**的：同一条边回车一次画叉、光标挪回来再回车一次擦回没落笔
        //（左键拖拽那支是铺笔，经过哪条写哪条，不翻转——一次拖拽翻一堆边会把人绕晕）。
        if (mode === 'cut') game.toggleCut(anchor, d);
        else game.setEdge(anchor, d, PEN[mode]);
      }
      game.endGesture();
      anchor = cursor;
      render();
      await checkWin();
      persist();
    }
  } else if (k === 'Escape') {
    anchor = -1;
    hideVeil();
  } else if (k === 'Backspace' || k === 'Delete') {
    ev.preventDefault();
    startClock();
    // eraseAt 不在拖拽组里时自己就把这一步压进撤销栈了，别再 undo 一次抵消掉
    game.eraseAt(cursor);
    render();
    persist();
  } else if (k === 'z' || k === 'Z') {
    game.undo();
    render();
    persist();
  } else if (k === 'e' || k === 'E') {
    // 三支笔轮着切：画环 → 排除叉 → 擦掉 → 画环
    const order = ['loop', 'cut', 'erase'];
    setMode(order[(order.indexOf(mode) + 1) % order.length]);
    srCell.textContent = `画笔：${mode === 'loop' ? '画环' : mode === 'cut' ? '排除叉' : '擦掉'}`;
  } else if (k === 'n' || k === 'N') {
    await newGame({});
    return;
  } else return;
  render();
});

// ── 按钮 ────────────────────────────────────────────────────────────────
$('btn-new').addEventListener('click', () => newGame({}));
$('btn-again').addEventListener('click', () => newGame({}));
$('btn-close-veil').addEventListener('click', () => hideVeil());
$('btn-undo').addEventListener('click', async () => {
  if (!game) return;
  game.undo();
  render();
  persist();
});
$('btn-clear').addEventListener('click', () => {
  if (!game) return;
  game.clearAll();
  won = false;
  hideVeil();
  render();
  persist();
});
$('btn-mode-loop').addEventListener('click', () => setMode('loop'));
$('btn-mode-cut').addEventListener('click', () => setMode('cut'));
$('btn-mode-erase').addEventListener('click', () => setMode('erase'));
$('btn-motion').addEventListener('click', (ev) => {
  const next = !(ev.currentTarget.getAttribute('aria-pressed') === 'true');
  ev.currentTarget.setAttribute('aria-pressed', String(next));
  ev.currentTarget.textContent = next ? '动效 减' : '动效 全';
  setReduceMotion(next);
  Store.setSetting('reduceMotion', next);
});
$('btn-reset').addEventListener('click', () => {
  Store.reset();
  newGame({});
});

for (const s of SIZES) {
  const o = document.createElement('option');
  o.value = s;
  o.textContent = s;
  sizeSelect.appendChild(o);
}
sizeSelect.value = DEFAULT_SIZE;
sizeSelect.addEventListener('change', async () => {
  const { w } = parseSize(sizeSelect.value);
  // 尺寸一换就是新一局：不同 w×h 的边数组长度不同，旧存档的笔迹没法搬过去
  await newGame({ sizeKey: sizeSelect.value });
});

window.addEventListener('resize', () => {
  relayout();
  render();
});
window.addEventListener('pagehide', persist);

// ── 门面 ────────────────────────────────────────────────────────────────
window.masyu = {
  version: VERSION,
  state: 'booting',
  engine: {
    makePuzzle, toView, parseSize, SIZES, verify, createState, solveWithRules, RULE_ORDER, RULE_TEXT,
    edgeIdOf, edgeCount, neighbor, dirBetween, checkLoop, loopOrder,
    edgeOf, valOf, unknownCount,
    UP, RIGHT, DOWN, LEFT, LOOP, CUT, UNKNOWN, BLACK, WHITE,
  },
  view,
  get game() {
    return game;
  },
  get won() {
    return won;
  },
  get mode() {
    return mode;
  },
  setMode,
  newGame,
  mintSeed,
  checkWin,
  render,
  relayout,
  hideVeil,
  store: Store,
  palette: Palette,
  space: Space,
};

// ── 启动 ────────────────────────────────────────────────────────────────
(async function boot() {
  setMode('loop');
  const r = Store.resume();
  let started = null;
  if (r) {
    // 续局要把存下的步数一并交回去：只搬笔迹不搬步数，画面就会显示「0 步」，
    // 而盘上明明已经画了十几段。moves 是存档里就有的字段，不是这里现编的数字。
    started = await newGame({ seed: r.seed, sizeKey: r.sizeKey, marks: r.marks, moves: r.moves, elapsedMs: r.elapsedMs });
  }
  if (!started) await newGame({});
  window.masyu.state = 'ready';
})();
