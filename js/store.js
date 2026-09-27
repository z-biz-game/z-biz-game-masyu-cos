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

  resume() {
    const r = this.data.resume;
    if (!r || typeof r.marks !== 'string' || !r.seed) return null;
    return r;
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
