// 存档。所有东西挂在同一个键下，所以「清空存档」是一行。
//
// 进行中的对局存的是 (原始 seed, 尺寸, 玩家画下的笔迹, 步数/耗时)，不是题面或答案的副本——
// 生成器只吃 seed，所以同一个 seed 在任何一台机器上都画同一张盘，恢复一局只有几百字节。
// 存原始 seed 而不是 generate.js 内部派生过的那一个：内部值一变，旧存档就重建不出同一张盘。
//
// marks 是「每条边一个字符」的三态串（'0' 没落笔 / '1' 环边 / '2' 排除叉，见 js/ui/game.js 的
// MARK_CHAR）。上一轮发布的串只有 '0'/'1'——它是这张表的一个子集，Game.decode 照旧读得动，
// 所以这里不需要版本号、也没有迁移脚本。moves 是玩家真走过的步数：续局必须把它交回去，
// 只搬笔迹不搬步数的话，刷新一次画面就谎称「这局还没动过」。

const KEY = 'masyu.save.v1';

const defaults = () => ({
  settings: { sound: false, reduceMotion: false },
  resume: null,
  totals: { solved: 0, moves: 0, ms: 0 },
});

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaults();
    const parsed = JSON.parse(raw);
    const base = defaults();
    return {
      ...base,
      ...parsed,
      settings: { ...base.settings, ...(parsed.settings || {}) },
      totals: { ...base.totals, ...(parsed.totals || {}) },
    };
  } catch {
    return defaults();
  }
}

export const Store = {
  data: load(),
  // 指纹对账失败时 resume() 把原因写在这里（内存里，不进 localStorage），认账时就清掉。
  resumeDiscarded: null,

  save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch {
      /* 隐私模式 / 配额超了 —— 游戏照样能玩，只是记不住事 */
    }
  },

  setting(name) {
    return this.data.settings[name];
  },
  setSetting(name, value) {
    this.data.settings[name] = value;
    this.save();
  },

  saveResume(game, elapsedMs) {
    this.data.resume = {
      seed: game.seed,
      sizeKey: game.sizeKey,
      marks: game.encode(),
      moves: game.moves,
      elapsedMs,
      w: game.w,
      h: game.h,
      fingerprint: game.puzzle.fingerprint,
      at: Date.now(),
    };
    this.save();
  },

  // 「同一个 seed 重建出同一张盘」这句话只在**同一版生成器**里成立：生成器一改（本轮就是挖珠
  // 加了门 2），同一个 seed 就是另一张盘，把旧笔迹贴上去等于让玩家在一盘自己从没玩过的题面上续命。
  // 所以 saveResume 写下的 fingerprint 在这里读回来对账：
  //   传了 freshFingerprint 且与存档里那条不一致（或存档里压根没有指纹）⇒ 这份存档就地作废、
  //   返回 null，并把作废的原因留在 resumeDiscarded 里给 UI 说给玩家听——绝不让它留着反复骗人。
  //   不传参数就是「只看形状、不对账」（排障与门禁读档用），出货路径必须传。
  resume(freshFingerprint = null) {
    const r = this.data.resume;
    if (!r || typeof r.marks !== 'string' || !r.seed) return null;
    if (freshFingerprint === null) return r;
    if (typeof r.fingerprint !== 'string' || r.fingerprint !== freshFingerprint) {
      this.resumeDiscarded = {
        why: typeof r.fingerprint !== 'string' ? '存档里没有指纹' : '指纹不一致',
        seed: r.seed,
        sizeKey: r.sizeKey,
        saved: r.fingerprint || null,
        fresh: freshFingerprint,
        moves: r.moves,
      };
      this.data.resume = null;
      this.save();
      return null;
    }
    this.resumeDiscarded = null; // 认账了：上一次的作废原因不许再挂着
    return r;
  },

  // 只校验形状、不做指纹对账的读档：boot 用它决定「这一局要不要拿存档里的 seed 重画」。
  pendingResume() {
    return this.resume();
  },

  clearResume() {
    this.data.resume = null;
    this.save();
  },

  recordSolve(elapsedMs, moves) {
    const t = this.data.totals;
    t.solved++;
    t.moves += moves;
    t.ms += elapsedMs;
    this.save();
  },

  totals() {
    return this.data.totals;
  },

  reset() {
    this.data = defaults();
    this.save();
  },
};
