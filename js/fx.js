// 一次性反馈层：落笔的涟漪与胜利的那圈火星。它只吃 dt，不认识任何 Masyu 规则，
// 也不写引擎一个字节——所以它永远不可能变成第二记分板。
//
// 为什么是**定步长累加器**而不是「记得乘 dt」：阻尼、寿命、透明度都是乘法/指数，
// 逐帧 dt 直接喂进去，30Hz 与 120Hz 会积出两条不同的曲线（那是这一类改造最常见的假完成）。
// 于是 elapsed 只进 accum，仿真每次只走 SIM_STEP 这一格；帧率只决定「这一帧补跑几步」，
// 不决定粒子末态。同一虚拟时长 ⇒ 同一 simSteps ⇒ 同一批数字。
//
// reduceMotion 是真分支：spawn() 直接不产粒子（不是把粒子调小），标题/胜利动效退化成静图。

const SIM_STEP = 1 / 120;
// 每 60Hz 一帧的阻尼与衰减率。定步长里按 Math.pow(k, SIM_STEP * 60) 取——注意 k 本身是
// 「每 60Hz 帧」的口径，直接 *= 0.965 就还是那个只在 60Hz 成立的写法。
const DRAG_PER_60 = 0.90;
const LIFE_FADE_PER_60 = 0.55;
const MAX_PARTICLES = 220;
const SPRITE_FRAMES = 4;

export { SIM_STEP };

export class Fx {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas ? canvas.getContext('2d') : null;
    this.particles = [];
    this.accum = 0;
    this.clock = 0; // 已推进的仿真时长（秒）——只有 frame() 喂它，暂停时不喂
    this.simSteps = 0;
    this.frames = 0;
    this.last = 0;
    this.running = false;
    this.paused = false;
    this.reduceMotion = false;
    this.sprite = null;
    this.raf = null;
  }

  // 粒子贴图条（art/fx-sprites.png，4 帧 128px）。取不到就退回画圆环——那只是少了一张图，
  // 不是少了一个反馈：涟漪仍然按同一批数字推进。
  loadSprite(src) {
    return new Promise((resolve) => {
      if (typeof Image !== 'function' || !src) return resolve(false);
      const img = new Image();
      img.onload = () => {
        this.sprite = img;
        resolve(true);
      };
      img.onerror = () => resolve(false);
      img.src = src;
    });
  }

  resize(cssW, cssH, dpr) {
    if (!this.canvas) return;
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
    if (this.ctx) this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = cssW;
    this.h = cssH;
  }

  start() {
    if (this.running || typeof requestAnimationFrame !== 'function') return;
    this.running = true;
    this.last = 0;
    const tick = (now) => {
      this.frame(now);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop() {
    this.running = false;
    if (this.raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.raf);
    this.raf = null;
  }

  // now 是 rAF 的时间戳（毫秒）。沙箱里从 1000ms 起步，所以 last===0 当哨兵：
  // 第一帧只记时刻、不推进仿真——否则凭空多喂一帧，量出一条假的帧率依赖。
  frame(now) {
    this.frames++;
    const last = this.last;
    if (!last) {
      this.last = now;
      return;
    }
    let dt = (now - last) / 1000; // 这一帧过了多久（秒）——它只进 accum，不进仿真本身
    this.last = now;
    if (!(dt > 0)) return;
    if (dt > 0.25) dt = 0.25; // 切后台回来的那一大坨不补跑（补跑=一瞬间放完所有涟漪）
    if (this.paused) return; // 暂停期间仿真不推进：accum 连喂都不喂
    this.step(dt);
    this.draw();
  }

  // 把 elapsed 拆成整数个 SIM_STEP。这一行是整个仓里唯一还在吃「帧 dt」的地方，
  // 所以它也是帧率对拍的阴性对照靶子（改成 accum += 1/60 必然换）。
  step(elapsed) {
    this.accum += elapsed;
    let guard = 0;
    while (this.accum >= SIM_STEP && guard++ < 600) {
      this.sim(SIM_STEP);
      this.accum -= SIM_STEP;
    }
  }

  sim(s) {
    this.clock += s;
    this.simSteps++;
    const drag = Math.pow(DRAG_PER_60, s * 60);
    const fade = Math.pow(LIFE_FADE_PER_60, s * 60);
    const list = this.particles;
    for (let i = list.length - 1; i >= 0; i--) {
      const p = list[i];
      p.x += p.vx * s;
      p.y += p.vy * s;
      p.vx *= drag;
      p.vy *= drag;
      p.r += p.grow * s;
      p.alpha *= fade;
      p.age += s;
      if (p.age >= p.life || p.alpha < 0.012) list.splice(i, 1);
    }
  }

  // 落笔处的一圈涟漪（sprite 帧按寿命推进）+ 几颗向外散开的火星。
  spawn(x, y, kind = 'loop') {
    if (this.reduceMotion || !this.canvas) return 0;
    const accent = kind === 'cut' ? '#8298C4' : kind === 'bad' ? '#FF5C7A' : '#FFC85C';
    const n = kind === 'win' ? 10 : 5;
    if (this.particles.length + n > MAX_PARTICLES) this.particles.splice(0, this.particles.length + n - MAX_PARTICLES);
    this.particles.push({
      x, y, vx: 0, vy: 0, r: 6, grow: 92, life: 0.52, age: 0, alpha: 0.9, kind, color: accent, ring: true,
    });
    for (let i = 0; i < n; i++) {
      const a = (Math.PI * 2 * i) / n + (kind === 'win' ? 0.4 : 0);
      const sp = kind === 'win' ? 150 : 88;
      this.particles.push({
        x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, r: 2.6, grow: 0,
        life: 0.7, age: 0, alpha: 0.85, kind, color: accent, ring: false,
      });
    }
    return n + 1;
  }

  clear() {
    this.particles.length = 0;
    this.accum = 0;
    if (this.ctx && this.w) this.ctx.clearRect(0, 0, this.w, this.h);
  }

  draw() {
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.clearRect(0, 0, this.w, this.h);
    if (!this.particles.length) return;
    const sheet = this.sprite;
    for (const p of this.particles) {
      const t = Math.min(1, p.age / p.life);
      ctx.globalAlpha = Math.max(0, p.alpha * (1 - t));
      if (p.ring) {
        const d = p.r * 2;
        if (sheet) {
          const fi = Math.min(SPRITE_FRAMES - 1, Math.floor(t * SPRITE_FRAMES));
          ctx.drawImage(sheet, fi * 128, 0, 128, 128, p.x - p.r, p.y - p.r, d, d);
        } else {
          ctx.strokeStyle = p.color;
          ctx.lineWidth = Math.max(1, 5 * (1 - t));
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
          ctx.stroke();
        }
      } else {
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r * (1 - t * 0.5), 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  state() {
    return {
      clock: this.clock,
      simSteps: this.simSteps,
      accum: this.accum,
      particles: this.particles.length,
      frames: this.frames,
      paused: this.paused,
      reduceMotion: this.reduceMotion,
    };
  }
}
