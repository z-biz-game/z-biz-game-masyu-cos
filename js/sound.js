// 音效。静音**不是**把 master gain 设成 0——那是假静音：振荡器照建、AudioContext 照跑，
// 只是听不见，而且 CPU 还在为听不见的东西付账。这里是两件事一起做：
//   ① muted 时 play() 在建任何节点之前就返回（created 计数器不涨，探针能断言这一点）；
//   ② muted 时把 AudioContext 真的 suspend()，resume() 只在取消静音之后调。
//
// 暂停是第三条独立的路：Suspended 由暂停引起、但取消静音不该把暂停中的声音放出来，
// 所以 resumeFromPause() 只在「未静音」时才真的 resume()。
//
// 浏览器的手势策略：AudioContext 只能在用户手势里建/解锁，所以 unlock() 只由输入回调调用，
// boot 时不建（否则每个新玩家的控制台一条 The AudioContext was not allowed to start 警告）。

import { Store } from './store.js';

// 默认静音：这一版之前这游戏一个音都没有，第一次开嗓不该发生在玩家没点「开声」之前。
let muted = Store.setting('sound') !== true;
let ctx = null;
let master = null;
let created = 0; // 建过的振荡器节点总数——静音态必须恒不增长

const VOICES = {
  loop: { from: 523.25, to: 783.99, dur: 0.09, type: 'triangle', gain: 0.16 },
  cut: { from: 392.0, to: 261.63, dur: 0.08, type: 'square', gain: 0.09 },
  erase: { from: 293.66, to: 196.0, dur: 0.07, type: 'sine', gain: 0.08 },
  bad: { from: 165.0, to: 110.0, dur: 0.16, type: 'sawtooth', gain: 0.1 },
  hint: { from: 659.25, to: 880.0, dur: 0.12, type: 'sine', gain: 0.12 },
  win: { from: 523.25, to: 1046.5, dur: 0.5, type: 'triangle', gain: 0.18 },
};

export const Sound = {
  muted() {
    return muted;
  },
  created() {
    return created;
  },
  state() {
    return { muted, ctxState: ctx ? ctx.state : 'none', created };
  },

  // 只能在用户手势里调：建 ctx（一次）+ 把 suspended 的 ctx 拉回 running。
  unlock() {
    if (muted) return null;
    if (!ctx) {
      const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
      if (!AC) return null;
      try {
        ctx = new AC();
        master = ctx.createGain();
        master.gain.value = 0.9;
        master.connect(ctx.destination);
      } catch {
        ctx = null;
        master = null;
        return null;
      }
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  },

  play(name) {
    if (muted) return false; // ①：静音态一个节点都不建
    const c = Sound.unlock();
    if (!c || !master) return false;
    const v = VOICES[name] || VOICES.loop;
    const t = c.currentTime;
    const osc = c.createOscillator();
    const g = c.createGain();
    created++;
    osc.type = v.type;
    osc.frequency.setValueAtTime(v.from, t);
    osc.frequency.exponentialRampToValueAtTime(v.to, t + v.dur);
    g.gain.setValueAtTime(v.gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + v.dur);
    osc.connect(g);
    g.connect(master);
    osc.start(t);
    osc.stop(t + v.dur + 0.02);
    osc.onended = () => {
      try {
        osc.disconnect();
        g.disconnect();
      } catch {
        /* 已经断开了：这一层不负责回收顺序 */
      }
    };
    return true;
  },

  setMuted(next) {
    muted = !!next;
    Store.setSetting('sound', !muted);
    if (muted && ctx && ctx.state === 'running') ctx.suspend().catch(() => {}); // ②：真停
    else if (!muted && ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
    return muted;
  },

  toggleMuted() {
    return Sound.setMuted(!muted);
  },

  // 暂停/恢复：只在「未静音」时才把声音放回来，否则取消静音之前它就该一直停着。
  suspendForPause() {
    if (ctx && ctx.state === 'running') {
      ctx.suspend().catch(() => {});
      return true;
    }
    return false;
  },

  resumeFromPause() {
    if (!muted && ctx && ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
      return true;
    }
    return false;
  },
};
