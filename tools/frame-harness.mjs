#!/usr/bin/env node
/*
 * tools/frame-harness.mjs —— 数链（Electron+Canvas / ESM）的关卡内帧率对拍 + 暂停/静音行为证明。
 *
 * 为什么自己写：官方 cos_frame_probe.js 在本仓打 `结论：无法比对（SyntaxError: Cannot use
 * import statement outside a module）`——它把 index.html 里 `<script type="module" src>` 指向的
 * js/main.js 当经典脚本跑，而本仓是 ESM 模块。按简报 §3，"无法比对"不算通过。
 *
 * 三件事按简报的口径做：
 *   ① 真进关卡：等 window.masyu.state==='playing'，再用真实 pointerdown/move/up 走画布那批监听器
 *      （不是直接调 setEdge，那样量的是引擎不是接线）。
 *   ② 同一虚拟时长分别按 30/60/120Hz 喂 rAF。时钟从 1000ms 起步且只往前走（0 起步会被 fx.last
 *      那个哨兵吃掉一帧，凭空造出假帧率依赖；往回跳会让计时表算出 -1000ms）；每帧时刻按 i 直接算
 *      （不做 += 累加），免得浮点漂移把 simSteps 的边界差一格。落笔周期取 1/3 秒 = 40 个仿真步
 *      = 30/60/120Hz 的整数帧，三档落在同一批仿真步上，比出来的差才是真差。
 *   ③ 随机固定：seed 定值，crypto.getRandomValues 走 LCG 桩，全程不碰 Math.random。
 *
 * 用法: npm run frame            # 本仓，3 虚拟秒
 *       node tools/frame-harness.mjs [repoDir] [virtualSeconds] [--neg]
 *   --neg  阴性对照：把 js/fx.js 的 `this.accum += elapsed` 改成 `+= 1/60`（拷到 /tmp 改，不碰仓）
 */
import fs from 'fs';
import path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';

const argv = process.argv.slice(2);
const NEG = argv.includes('--neg');
const isDuration = (a) => /^\d+(\.\d+)?$/.test(a);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(argv.find((a) => !a.startsWith('--') && !isDuration(a)) || path.join(HERE, '..'));
const VSEC = Number(argv.find((a) => /^\d+(\.\d+)?$/.test(a)) || 3);
const FPS = [30, 60, 120];
const SEED = 'harness-fixed-seed-1';
const SIZE = '6x6';
const STROKE_EVERY = 1 / 3; // 秒。= 40 个 SIM_STEP，同时是 30/60/120Hz 的整数帧（10/20/40）
const T0 = 1000;

/* ---------------------------------------------------------------- 固定随机 */
let lcg = 123456789;
const nextU32 = () => ((lcg = (lcg * 1664525 + 1013904223) >>> 0) >>> 0);

/* ---------------------------------------------------------------- DOM 桩 */
function makeCtx() {
  const noop = () => {};
  return new Proxy(
    {
      canvas: null,
      fillStyle: '', strokeStyle: '', lineWidth: 1, globalAlpha: 1, lineCap: 'butt', lineJoin: 'miter',
      font: '', textAlign: 'left', textBaseline: 'alphabetic',
      measureText: () => ({ width: 10 }),
      createLinearGradient: () => ({ addColorStop: noop }),
      createPattern: () => ({}),
      getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
      createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    },
    { get: (t, k) => (k in t ? t[k] : noop), set: (t, k, v) => ((t[k] = v), true) }
  );
}

const listenersOf = () => {
  const map = new Map();
  return {
    map,
    addEventListener: (t, fn) => {
      if (!map.has(t)) map.set(t, []);
      map.get(t).push(fn);
    },
    removeEventListener: (t, fn) => {
      const a = map.get(t) || [];
      const i = a.indexOf(fn);
      if (i >= 0) a.splice(i, 1);
    },
    __fire: (t, ev) => {
      for (const fn of map.get(t) || []) fn(ev);
    },
  };
};

function makeEl(id, tag = 'DIV') {
  const el = {
    id,
    tagName: tag.toUpperCase(),
    hidden: true,
    textContent: '',
    className: '',
    value: '',
    children: [],
    style: { setProperty: () => {}, removeProperty: () => {} },
    classList: { toggle: () => {}, add: () => {}, remove: () => {}, contains: () => false },
    attrs: new Map(),
    setAttribute(k, v) {
      this.attrs.set(k, String(v));
    },
    getAttribute(k) {
      return this.attrs.has(k) ? this.attrs.get(k) : null;
    },
    hasAttribute(k) {
      return this.attrs.has(k);
    },
    appendChild(c) {
      this.children.push(c);
      return c;
    },
    setPointerCapture: () => {},
    releasePointerCapture: () => {},
    focus: () => {},
    scrollIntoView: () => {},
    getBoundingClientRect() {
      return { left: 0, top: 0, right: this.__w || 400, bottom: this.__h || 400, width: this.__w || 400, height: this.__h || 400 };
    },
    clientWidth: 520,
    clientHeight: 520,
    width: 0,
    height: 0,
    getContext: () => el.__ctx || (el.__ctx = makeCtx()),
    ...listenersOf(),
  };
  return el;
}

const els = new Map();
const byId = (id) => {
  if (!els.has(id)) els.set(id, makeEl(id, id === 'board' || id === 'fx' ? 'CANVAS' : 'DIV'));
  return els.get(id);
};
const board = byId('board');
board.hidden = false;
const doc = {
  baseURI: 'http://localhost:5276/',
  documentElement: makeEl('html'),
  body: makeEl('body'),
  hidden: false,
  fullscreenElement: null,
  getElementById: byId,
  querySelector: (sel) => (sel === '.rules' ? byId('rules') : null),
  createElement: (tag) => makeEl('created-' + tag, tag),
  addEventListener: () => {},
  removeEventListener: () => {},
};

/* 时钟：沙箱从 1000ms 起步，且**只往前走**——每档跑完把 clockBase 停在末尾。
   否则「暂停 2 秒再恢复」那类证明会看到时间倒流，计时表算出 -1000ms。 */
const CLOCK = { t: T0 };
let clockBase = T0;
let createdBase = 0; // 本窗口开始时已建的振荡器数（Sound.created 是模块级累加值）
const RealDate = Date;
class FixedDate extends RealDate {
  constructor(...a) {
    if (a.length === 0) super(CLOCK.t);
    else super(...a);
  }
  static now() {
    return CLOCK.t;
  }
}

const rafQueue = [];
const g = globalThis;
// Node 22 把 navigator / performance 挂成只有 getter 的全局属性，直接赋值会 TypeError。
const put = (k, v) => Object.defineProperty(g, k, { value: v, writable: true, configurable: true });
g.window = g;
g.document = doc;
const winEvents = listenersOf();
g.addEventListener = winEvents.addEventListener;
g.removeEventListener = winEvents.removeEventListener;
put('navigator', { userAgent: 'harness', serviceWorker: undefined, maxTouchPoints: 1 });
g.devicePixelRatio = 2;
g.innerWidth = 900;
g.innerHeight = 900;
put('performance', { now: () => CLOCK.t });
put('Date', FixedDate);
g.requestAnimationFrame = (fn) => {
  rafQueue.push(fn);
  return rafQueue.length;
};
g.cancelAnimationFrame = () => {};
g.matchMedia = (q) => ({ matches: false, media: q, addEventListener: () => {}, addListener: () => {} });
g.Image = class {
  constructor() {
    this.width = 128;
    this.height = 128;
    this.complete = false;
  }
  set src(v) {
    this.__src = v;
    Promise.resolve().then(() => {
      this.complete = true;
      if (this.onload) this.onload({ type: 'load' });
    });
  }
  get src() {
    return this.__src;
  }
};
g.webkitAudioContext = undefined;
g.AudioContext = class {
  constructor() {
    this.state = 'suspended';
    this.destination = {};
    this.currentTime = 0;
    this.suspendCalls = 0;
    this.resumeCalls = 0;
    this.osc = 0;
  }
  createGain() {
    return { gain: { value: 1, setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} }, connect: () => {}, disconnect: () => {} };
  }
  createOscillator() {
    this.osc++;
    return {
      type: '',
      frequency: { setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} },
      connect: () => {},
      disconnect: () => {},
      start: () => {},
      stop: () => {},
      onended: null,
    };
  }
  suspend() {
    this.suspendCalls++;
    this.state = 'suspended';
    return Promise.resolve();
  }
  resume() {
    this.resumeCalls++;
    this.state = 'running';
    return Promise.resolve();
  }
};
const LS = new Map();
g.localStorage = {
  getItem: (k) => (LS.has(k) ? LS.get(k) : null),
  setItem: (k, v) => LS.set(k, String(v)),
  removeItem: (k) => LS.delete(k),
  clear: () => LS.clear(),
};
put('crypto', { getRandomValues: (arr) => arr.map(() => nextU32() & 0xff) });

/* ---------------------------------------------------------------- 喂帧 */
// 帧时刻按序号直接算（clockBase + i*1000/fps），不做 CLOCK.t += step 的累加：
// 累加会让 120Hz 那一档多漂出 1e-12 秒，把 accum 的整步边界推到隔壁去，量出一条假的差异。
// i 从 0 开始：那一帧要么是 fx 的开局哨兵（只记时刻），要么 dt=0 被 frame() 丢掉，
// 于是每个窗口的仿真时长恰好是 seconds——三档喂 91/181/361 帧，仿真都走 3 秒。
function feedFrames(fps, seconds, onFrame) {
  const n = Math.round(seconds * fps);
  for (let i = 0; i <= n; i++) {
    CLOCK.t = clockBase + (i * 1000) / fps;
    const now = CLOCK.t;
    const cbs = rafQueue.splice(0, rafQueue.length);
    for (const cb of cbs) cb(now);
    if (onFrame) onFrame(i, now);
  }
  clockBase = CLOCK.t;
  return n;
}

// 按帧间隔落笔的证明用这个：落笔次数与 fps 无关，才不会出现「30Hz 画了 8 笔、120Hz 画了 9 笔」。
function stroker(startIdx, every) {
  const tap = (i) => {
    if (i > 0 && every && i % every === 0 && strokeAt(startIdx + i / every)) tap.count++;
  };
  tap.count = 0;
  return tap;
}

function strokeAt(idx) {
  // 真实 pointerdown → pointermove → pointerup：走画布那批监听器，不绕到 Game 后面。
  const m = globalThis.masyu;
  const gm = m.game;
  const view = m.view;
  const cellA = (idx * 5 + 1) % (gm.w * gm.h);
  const cellB = cellA + 1 < gm.w * gm.h && (cellA + 1) % gm.w !== 0 ? cellA + 1 : cellA + gm.w;
  if (cellB >= gm.w * gm.h) return false;
  const a = view.centerOf(cellA);
  const b = view.centerOf(cellB);
  const ev = (x, y) => ({ clientX: x, clientY: y, button: 0, pointerId: 1, preventDefault: () => {} });
  board.__fire('pointerdown', ev(a.x, a.y));
  board.__fire('pointermove', ev(b.x, b.y));
  board.__fire('pointerup', ev(b.x, b.y));
  return true;
}

function snapshot(m) {
  const f = m.fx.state();
  const st = m.sound.state();
  const gm = m.game;
  return {
    'fx.clock': +f.clock.toFixed(9),
    'fx.simSteps': f.simSteps,
    'fx.accum': +f.accum.toFixed(9),
    'fx.particles': f.particles,
    'fx.frames': f.frames,
    // created 是模块级累加计数，三档是顺序跑的：比的是「这一档自己建了几个」，不是总数。
    'sound.created': st.created - createdBase,
    'sound.ctxState': st.ctxState,
    'game.moves': gm.moves,
    'game.loopEdges': gm.loopEdges().length,
    'game.cutEdges': gm.cutEdges().length,
    'game.badCells': gm.badCells().length,
    'game.endpoints': gm.endpoints().length,
    'game.edgesFp': Array.from(gm.st.edges).reduce((a, v) => (a * 31 + v + 1) % 1000000007, 7),
    elapsedMs: Math.round(m.elapsedMs),
    won: m.won ? 1 : 0,
    state: m.state,
  };
}

async function freshRun(m, seedOffset) {
  CLOCK.t = clockBase;
  await m.newGame({ seed: `${SEED}-${seedOffset}`, sizeKey: SIZE });
  m.fx.clock = 0;
  m.fx.simSteps = 0;
  m.fx.accum = 0;
  m.fx.frames = 0;
  m.fx.last = 0; // 窗口第一帧只记时刻，不推进仿真
  m.fx.clear();
  // 开声必须在取基线之前做完：setMutedUI 在取消静音的那一下会播一声确认音（js/main.js:544），
  // 放在窗口里就成了「30Hz 比 60/120Hz 多建一个振荡器」的假帧率依赖。
  if (m.sound.muted()) m.toggleMuted();
  createdBase = m.sound.state().created;
  if (m.state !== 'playing') throw new Error(`没进关卡：state=${m.state}`);
}

async function runAt(fps, m) {
  await freshRun(m, 'rate');
  const strokeFrames = Math.round(STROKE_EVERY * fps); // 1/3s = 40 个仿真步，在三档上都是整数帧
  const tap = stroker(1, strokeFrames);
  const n = feedFrames(fps, VSEC, tap);
  return { ...snapshot(m), fps, framesFed: n + 1, strokes: tap.count };
}

/* ---------------------------------------------------------------- 行为证明 */
// 暂停成立的判据不是「有个盖层」，而是三样东西同时停：仿真步数、计时表、声音；恢复反向做一遍，
// 且笔迹一个字节都不动。这里量的是 fx.state() / elapsedMs / Sound.state()，不是文案。
async function pauseProof(m) {
  await freshRun(m, 'pause');
  feedFrames(60, 0.5, stroker(1, 15)); // 只落几笔：够让仿真有活干，不够把盘解完
  const before = m.fx.state();
  m.setPaused(true);
  const veilOn = !document.getElementById('pause-veil').hidden && m.state === 'paused';
  const steps0 = m.fx.state().simSteps;
  const clock0 = m.fx.state().clock;
  const accum0 = m.fx.state().accum;
  const frames0 = m.fx.state().frames;
  const moves0 = m.game.moves;
  const elapsed0 = m.elapsedMs;
  feedFrames(60, 2.0); // 暂停期间照常喂 120 帧 rAF
  const inPause = {
    simSteps: m.fx.state().simSteps - steps0,
    clock: m.fx.state().clock - clock0,
    accum: m.fx.state().accum - accum0,
    frames: m.fx.state().frames - frames0,
    elapsed: m.elapsedMs - elapsed0,
    ctxState: m.sound.state().ctxState,
  };
  strokeAt(7); // 暂停中的落笔必须被输入闸门挡掉
  const afterGated = m.game.moves - moves0;
  m.setPaused(false);
  const resumedCtx = m.sound.state().ctxState;
  feedFrames(60, 1.0, stroker(50, 20));
  const after = m.fx.state();
  const rows = [
    ['盖层 + state=paused', veilOn ? 'true' : 'false', veilOn],
    ['暂停期喂 120 帧 → simSteps 增量', String(inPause.simSteps), inPause.simSteps === 0],
    ['暂停期 → 仿真时钟增量(s)', String(inPause.clock), inPause.clock === 0],
    ['暂停期 → accum 增量', String(inPause.accum), Math.abs(inPause.accum) < 1e-12],
    ['暂停期 → 仍收到 rAF 帧数', String(inPause.frames), inPause.frames >= 120],
    ['暂停期 → 计时表增量(ms)', String(inPause.elapsed), inPause.elapsed === 0],
    ['暂停期 → AudioContext', inPause.ctxState, inPause.ctxState === 'suspended'],
    ['暂停期落笔不改步数', `moves +${afterGated}`, afterGated === 0],
    ['恢复后 1s → simSteps 增量', String(after.simSteps - steps0), after.simSteps - steps0 >= 116],
    ['恢复后 1s → 计时表只 +1s（暂停的 2s 不计）', `+${m.elapsedMs - elapsed0}ms`, m.elapsedMs - elapsed0 > 900 && m.elapsedMs - elapsed0 < 1100],
    ['恢复后 → AudioContext', resumedCtx, resumedCtx === 'running'],
    ['暂停前已有步数', String(before.simSteps), before.simSteps > 0],
    ['恢复后笔迹仍在盘上', `${m.game.loopEdges().length} 段`, m.game.loopEdges().length > 0],
  ];
  return rows;
}

// 静音的判据是「一个振荡器都不建」+「AudioContext 真的 suspend」，不是 gain=0、不是按钮文案。
async function muteProof(m) {
  await freshRun(m, 'mute');
  if (!m.sound.muted()) m.toggleMuted(); // 回到默认静音
  const st0 = m.sound.state();
  const direct = [1, 2, 3, 4, 5].map(() => m.sound.play('loop'));
  feedFrames(60, 1.0, stroker(1, 20)); // 走游戏自己的落笔→pulse→Sound.play 那条路（3 笔）
  const st1 = m.sound.state();
  m.toggleMuted(); // 开声（手势路径）
  strokeAt(99);
  const st2 = m.sound.state();
  m.toggleMuted(); // 再静音：running 的 ctx 必须被真的 suspend
  await new Promise((r) => setImmediate(r));
  const st3 = m.sound.state();
  return [
    ['静音初态 muted', String(st0.muted), st0.muted === true],
    ['静音下 play() 返回值', direct.join(','), direct.every((v) => v === false)],
    ['静音 1s + 3 笔 → 振荡器增量', String(st1.created - st0.created), st1.created - st0.created === 0],
    ['开声落笔 → 振荡器增量', String(st2.created - st1.created), st2.created - st1.created > 0],
    ['开声 → ctxState', st2.ctxState, st2.ctxState === 'running'],
    ['再静音 → ctxState', st3.ctxState, st3.ctxState === 'suspended'],
  ];
}

// reduceMotion 必须是真分支：spawn 直接不产粒子（不是把粒子调小）。
async function motionProof(m) {
  await freshRun(m, 'motion');
  m.fx.reduceMotion = true;
  feedFrames(60, 1.0, stroker(1, 20));
  const rm = m.fx.state();
  const rmState = m.state;
  m.fx.reduceMotion = false;
  feedFrames(60, 1.0, stroker(50, 20));
  const normal = m.fx.state();
  return [
    ['reduceMotion 下粒子数', String(rm.particles), rm.particles === 0],
    ['reduceMotion 下仿真仍推进', String(rm.simSteps), rm.simSteps > 0],
    ['这一路仍在关卡里', rmState, rmState === 'playing'],
    ['关掉 reduceMotion 后有粒子', String(normal.particles), normal.particles > 0],
  ];
}

/* ---------------------------------------------------------------- 比对 */
// 容差只给「被一个仿真步量化」的那几个字段：三档的 dt 都是二进制分数，加几百次之后 accum
// 与 N×SIM_STEP 之间会差 1e-13 秒，最后一格可能落在 359 也可能落在 360。那是浮点表示，
// 不是帧率依赖。阴性对照的偏差是几百步（180/360/720），这点容差挡不住它。
const STEP = 1 / 120;
const TOL = { 'fx.simSteps': 1, 'fx.clock': STEP, 'fx.accum': STEP, 'fx.particles': 6, elapsedMs: 2 };

function compare(rows) {
  const keys = Object.keys(rows[0]).filter((k) => !['fx.frames', 'fps', 'framesFed', 'strokes'].includes(k));
  const lines = [];
  let red = 0;
  for (const k of keys) {
    const vals = rows.map((r) => r[k]);
    const numeric = vals.every((v) => typeof v === 'number');
    const spread = numeric ? Math.max(...vals) - Math.min(...vals) : 0;
    const tol = TOL[k] || 0;
    const ok = numeric ? spread <= tol : vals.every((v) => v === vals[0]);
    if (!ok) red++;
    lines.push(
      `  ${ok ? '同 ' : '✗ '} ${(k + ' ').padEnd(16)} 30/60/120 = ${vals.join(' | ')}${tol ? `  (容差±${tol})` : ''}${numeric && spread > tol ? `  spread=${spread}` : ''}`
    );
  }
  return { lines, red, fields: keys.length };
}

function proofTable(name, rows, out) {
  const bad = rows.filter((r) => !r[2]).length;
  out.push(`\n${name}`);
  for (const [label, val, ok] of rows) out.push(`  ${ok ? '✅' : '❌'} ${label.padEnd(28)} ${val}`);
  out.push(`  → ${name.split(' ')[0]} ${rows.length - bad}/${rows.length}`);
  return bad;
}

/* ---------------------------------------------------------------- 主流程 */
async function main() {
  const out = [];
  let root = REPO;
  if (NEG) {
    // 阴性对照改的是 /tmp 的副本，仓里一个字节都不动
    root = '/tmp/masyu_neg_repo';
    fs.rmSync(root, { recursive: true, force: true });
    fs.cpSync(REPO, root, { recursive: true, filter: (s) => !/\/(node_modules|\.git)(\/|$)/.test(s) });
    const p = path.join(root, 'js/fx.js');
    const src = fs.readFileSync(p, 'utf8');
    const hit = src.replace('this.accum += elapsed;', 'this.accum += 1 / 60;');
    if (hit === src) throw new Error('阴性对照没找到靶子行 this.accum += elapsed');
    fs.writeFileSync(p, hit);
    out.push('阴性对照：js/fx.js 的 `this.accum += elapsed` → `this.accum += 1 / 60`（/tmp 副本，仓未改动）');
  }
  const mod = await import(pathToFileURL(path.join(root, 'js/main.js')).href);
  for (let i = 0; i < 500 && (!globalThis.masyu || globalThis.masyu.state === 'booting'); i++) {
    await new Promise((r) => setImmediate(r));
  }
  const m = globalThis.masyu;
  if (!m) throw new Error('window.masyu 没挂上');

  const rows = [];
  for (const fps of FPS) rows.push(await runAt(fps, m));
  const { lines, red, fields } = compare(rows);
  out.push(`\n[同一虚拟时长 ${VSEC}s / seed=${SEED} / ${FPS.join('/')}Hz] ${NEG ? '阴性对照' : '本仓'}`);
  out.push(lines.join('\n'));
  out.push(
    `  喂帧数 = ${rows.map((r) => r.framesFed).join(' / ')}（rAF 回调数 = ${rows.map((r) => r['fx.frames']).join(' / ')}，不参与比对）；落笔 ${rows.map((r) => r.strokes).join('/')} 笔`
  );
  out.push(`  → 帧率对拍 ${fields - red}/${fields} 字段三档一致${red ? `，${red} 个字段随帧率变化` : ''}`);

  let bad = red;
  bad += proofTable('暂停行为证明', await pauseProof(m), out);
  bad += proofTable('静音行为证明', await muteProof(m), out);
  bad += proofTable('reduceMotion 行为证明', await motionProof(m), out);

  const green = bad === 0;
  if (NEG) {
    // 阴性对照的「通过」定义与本仓相反：它必须变红。红了说明这把尺真的在量 dt 那一步。
    console.log(out.join('\n'));
    console.log(`\n结论（阴性对照）：${green ? '❌ 打了靶子仍三档一致——这把尺量不到帧率依赖，判尺无效' : `✅ 靶子一打就红：${bad} 项随帧率变化（应当红）`}`);
    process.exit(green ? 1 : 0);
  }
  console.log(out.join('\n'));
  console.log(`\n结论：${green ? '✅ 全部通过' : `❌ ${bad} 项不合格`}`);
  process.exit(green ? 0 : 1);
}

main().catch((e) => {
  console.error('HARNESS ERROR', e);
  process.exit(1);
});
