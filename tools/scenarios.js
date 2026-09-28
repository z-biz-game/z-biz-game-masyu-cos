// 浏览器里的场景套件，由 tools/playtest.cjs 注入真实页面后跑。六个场景：
// boot / render / play / marks / resume / hint（后两个里 marks→resume 与 hint 有顺序要求，见 verify.sh）。
//
// 这里只认三种证据：DOM 的矩形、画布的像素、真指针事件打进去之后的读数。`.hidden` 说的是代码
// 想干什么，一个 rect 和一个像素才是玩家拿到了什么。这个仓最容易出的事故恰好是「引擎里对、
// 屏幕上错」：珠子画偏一列、参考环偷偷漏到盘上、胜利卡片 display:grid 盖掉了 [hidden] 还在吃点击。
//
// 两批坐标绝不能混：
//   · getImageData 要的是**画布本地 CSS 坐标 × dpr**，一律由 view.cellRect / view.segRect /
//     view.ringPoint 产出（它们和 draw 用的是同一批数）。拿 page/client 坐标去喂，会量到整个
//     盘宽之外的面板底色上，然后「量」出一个绿。
//   · PointerEvent / elementFromPoint 要的是 client 坐标，所以走 clientOf()（加了 getBoundingClientRect
//     偏移）。
//
// window.masyu.engine 就是玩家加载的那张模块图，所以这里绿一次，等于页面那侧的出题器/推理机
// 同时绿一次。引擎常量都在场景函数**内部**取——本文件注入的时机比 app 的模块执行还早。

((w) => {
  const rows = [];
  const ck = (test, cond, detail) => {
    rows.push({ test, pass: !!cond, detail: cond ? '' : String(detail === undefined ? '' : detail) });
  };
  const eq = (test, got, want) => ck(test, String(got) === String(want), `得到 ${got}，想要 ${want}`);
  const report = (extra) => {
    const out = { rows: rows.slice(), fail: rows.filter((r) => !r.pass).length, ...extra };
    rows.length = 0;
    return out;
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // 注入得比 app 的模块执行还早，所以这两个收集器能抓到启动期的异常
  const errs = [];
  w.addEventListener('error', (e) => errs.push(`${e.message} @ ${e.filename || ''}:${e.lineno || 0}`));
  w.addEventListener('unhandledrejection', (e) => errs.push(`rejection: ${e && e.reason}`));
  w.__masyuErrs = errs;

  const A = () => w.masyu;
  const E = () => w.masyu.engine;
  const P = () => w.masyu.palette;
  const $ = (sel) => document.querySelector(sel);
  const text = (sel) => (($.call(document, sel) || {}).textContent || '').trim();
  const num = (sel) => Number(text(sel) || '0');

  const rgb = (hex) => {
    const h = String(hex).replace('#', '');
    const s = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
  };
  const near = (a, b, tol = 12) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
  const far = (a, b, tol = 40) => a.some((v, i) => Math.abs(v - b[i]) > tol);
  // 逐通道的最小间距：theme.js 的色组纪律是「和盘底/网格线/环线都拉开至少 25 的**逐通道**距离」，
  // 那是「每一个通道都 ≥25」，不是「有一个通道 ≥25」——所以这里取 min，不许用 far 蒙。
  const minChan = (a, b) => Math.min(...a.map((v, i) => Math.abs(v - b[i])));
  const show3 = (a) => `[${a[0]},${a[1]},${a[2]}]`;

  // ---- 画布本地坐标取样（CSS 像素 × dpr）------------------------------------
  function sample(lx, ly) {
    const v = A().view;
    const d = v.geo.dpr;
    const x = Math.round(lx * d);
    const y = Math.round(ly * d);
    const p = v.ctx.getImageData(x, y, 1, 1).data;
    return [p[0], p[1], p[2]];
  }
  const cellMid = (cell) => {
    const r = A().view.cellRect(cell);
    return { x: r.cx, y: r.cy };
  };
  function segMid(cell, d) {
    const r = A().view.segRect(cell, d);
    return r ? { x: r.x + r.w / 2, y: r.y + r.h / 2 } : null;
  }
  // 排除叉的取样点：由视图自己报它把叉画在哪（draw 用的就是同一个 markPoint）。
  // 自己按「两格心中点」再算一遍的话，画法一改这条断言还会在旧位置绿着。
  function markMid(cell, d) {
    const m = A().view.markPoint(cell, d);
    return m ? { x: m.x, y: m.y } : null;
  }
  // 一格某一侧的那半张脸：指针落在这一半，命中的就是这一条边（view.hitEdge 的主轴规则）。
  // 0.26 cell 离格心足够远（|dx|>|dy| 稳定成立），又还在格内。
  const HALF = 0.26;
  function halfOf(cell, d) {
    const r = A().view.cellRect(cell);
    const k = r.size;
    const off = k * HALF;
    if (d === E().RIGHT) return { x: r.cx + off, y: r.cy };
    if (d === E().LEFT) return { x: r.cx - off, y: r.cy };
    if (d === E().DOWN) return { x: r.cx, y: r.cy + off };
    return { x: r.cx, y: r.cy - off };
  }

  // ---- 真指针（client 坐标）--------------------------------------------------
  function clientOf(lx, ly) {
    const b = A().view.canvas.getBoundingClientRect();
    return { x: b.left + lx, y: b.top + ly };
  }
  const ptOf = (cell) => {
    const m = cellMid(cell);
    return clientOf(m.x, m.y);
  };
  function pointer(type, x, y, button = 0) {
    A().view.canvas.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        isPrimary: true,
        button,
        buttons: type === 'pointerup' ? 0 : 1,
        clientX: x,
        clientY: y,
      })
    );
  }
  async function dragPath(cells, button = 0) {
    const a = ptOf(cells[0]);
    pointer('pointerdown', a.x, a.y, button);
    await wait(10);
    for (let i = 1; i < cells.length; i++) {
      const p = ptOf(cells[i]);
      pointer('pointermove', p.x, p.y, button);
      await wait(6);
    }
    const z = ptOf(cells[cells.length - 1]);
    pointer('pointerup', z.x, z.y, button);
    await wait(40);
  }
  // 右键落在盘面上一个**画布本地**点：真指针事件，坐标换算成 client 再打。
  async function rightClickAt(lx, ly) {
    const p = clientOf(lx, ly);
    pointer('pointerdown', p.x, p.y, 2);
    await wait(10);
    pointer('pointerup', p.x, p.y, 2);
    await wait(40);
  }
  // 已经落笔的边数（LOOP + CUT）：提示那一条路每一步都必须让它正好 +1，多一分就是偷看了答案。
  function decided(g) {
    let n = 0;
    for (let e = 0; e < g.st.edges.length; e++) if (g.st.edges[e] !== E().UNKNOWN) n++;
    return n;
  }

  // 把 face.segs（引擎 toView 给的 [r,c,'h'|'v']）翻成 "cell:d" 的模型集
  function modelSet(g) {
    const set = new Set();
    for (const [r, c, kind] of g.face.segs) set.add(`${r * g.w + c}:${kind === 'h' ? E().RIGHT : E().DOWN}`);
    return set;
  }
  function allEdges(g) {
    const out = [];
    for (let cell = 0; cell < g.w * g.h; cell++) {
      for (const d of [E().RIGHT, E().DOWN]) if (A().view.segRect(cell, d)) out.push([cell, d]);
    }
    return out;
  }

  const ng = {};

  // ── 1. boot：页面在真实浏览器里活着，而且画了东西 ─────────────────────────
  ng.boot = async () => {
    for (let i = 0; i < 300 && !(A() && A().game); i++) await wait(50);
    await wait(150);
    // 起不来就不算一条断言，算一次 fatal：后面每一条都要读 view，与其全红不如当场说清楚
    if (!A() || !A().game) {
      ck('boot: 页面启动（window.masyu.game 就位）', false, errs.slice(0, 3).join(' | ') || 'window.masyu.game 一直没出现');
      return report({ fatal: true });
    }
    ck('boot: 启动没有未捕获异常/拒绝', errs.length === 0, errs.slice(0, 3).join(' | '));

    const v = A().view;
    const cv = v.canvas;
    const cr = cv.getBoundingClientRect();
    const wr = $('#board-wrap').getBoundingClientRect();
    ck(
      'boot: 画布有非零矩形且整个落在 #board-wrap 里',
      cr.width > 120 && cr.height > 120 && cr.left >= wr.left - 1 && cr.top >= wr.top - 1 && cr.right <= wr.right + 1 && cr.bottom <= wr.bottom + 1,
      `canvas ${Math.round(cr.width)}x${Math.round(cr.height)} @${Math.round(cr.left)},${Math.round(cr.top)} wrap ${Math.round(wr.width)}x${Math.round(wr.height)} @${Math.round(wr.left)},${Math.round(wr.top)}`
    );

    let opaque = 0;
    let total = 0;
    for (let i = 1; i < 20; i++) {
      for (let j = 1; j < 20; j++) {
        const a = v.ctx.getImageData(Math.round((cv.width * i) / 20), Math.round((cv.height * j) / 20), 1, 1).data[3];
        total++;
        if (a > 0) opaque++;
      }
    }
    ck('boot: 画布不是空的（361 点抽样 ≥95% 不透明）', total > 0 && opaque / total >= 0.95, `${opaque}/${total} 不透明`);

    const veil = $('#win-veil');
    const vrects = veil.getClientRects().length;
    ck('boot: 胜利卡片在几何上不存在（display 不是 grid、零矩形）', vrects === 0 && getComputedStyle(veil).display === 'none', `rects=${vrects} display=${getComputedStyle(veil).display}`);
    const over = document.elementFromPoint(Math.round(cr.left + cr.width / 2), Math.round(cr.top + cr.height / 2));
    ck('boot: 盘面中心那一下命中的是 canvas，不是一块藏起来的 veil', over === cv, over ? `${over.tagName}#${over.id}` : 'null');

    const btn = $('#btn-new').getBoundingClientRect();
    const btnUndo = $('#btn-undo').getBoundingClientRect();
    ck('boot: 换一局 / 撤销 两个按钮都有可点的矩形', btn.width > 40 && btn.height > 20 && btnUndo.width > 40 && btnUndo.height > 20, `换一局 ${Math.round(btn.width)}x${Math.round(btn.height)} 撤销 ${Math.round(btnUndo.width)}x${Math.round(btnUndo.height)}`);

    // 指针闸：新增的控件先量命中盒 —— 到不了控件的断言不叫断言，叫愿望。
    // 而且要比矩形：画布中心被 veil 盖住过一次，就是因为只看 rect 不看「这一下命中的是谁」。
    const cutBtn = $('#btn-mode-cut');
    const cr2 = cutBtn.getBoundingClientRect();
    const hit2 = document.elementFromPoint(Math.round(cr2.left + cr2.width / 2), Math.round(cr2.top + cr2.height / 2));
    ck(
      'boot: 「排除叉」按钮有非零命中盒，且中心那一下命中的就是它',
      cr2.width > 30 && cr2.height > 18 && (hit2 === cutBtn || cutBtn.contains(hit2)),
      `矩形 ${Math.round(cr2.width)}x${Math.round(cr2.height)} 中心命中 ${hit2 ? hit2.tagName + '#' + hit2.id : 'null'}`
    );
    const cutsEl = $('#stat-cuts');
    ck('boot: 「已排除」读数挂在面板上（三态的第三条有地方报数）', !!cutsEl && /^\d+$/.test(cutsEl.textContent.trim()), cutsEl ? `内容="${cutsEl.textContent}"` : '没有 #stat-cuts');

    // 「提示」是这一轮新加的动作，命中盒先量：三个动作挤一行很容易挤成半宽或溢出面板。
    const hintBtn = $('#btn-hint');
    const hr = hintBtn.getBoundingClientRect();
    const hitHint = document.elementFromPoint(Math.round(hr.left + hr.width / 2), Math.round(hr.top + hr.height / 2));
    ck(
      'boot: 「提示」按钮有非零命中盒，且中心那一下命中的就是它',
      hr.width > 30 && hr.height > 18 && (hitHint === hintBtn || hintBtn.contains(hitHint)),
      `矩形 ${Math.round(hr.width)}x${Math.round(hr.height)} 中心命中 ${hitHint ? hitHint.tagName + '#' + hitHint.id : 'null'}`
    );

    eq('boot: seed 铭牌写的就是这一局用的原始 seed', text('#stat-seed'), `seed ${A().game.seed}`);

    // 前缀形状（GitHub Pages 的 /z-biz-game-masyu-cos/）唯一的杀手是把路径写死成 "/"。
    // 这里按 document.baseURI 现算一个 URL 再动态 import：写在页面上就验不到。
    let imported = null;
    try {
      imported = await import(new URL('js/engine/loop.js', document.baseURI).href);
    } catch (e) {
      imported = null;
    }
    ck('boot: 按 document.baseURI 动态 import 引擎模块解得开（Pages 前缀形状）', !!imported && typeof imported.edgeIdOf === 'function', `baseURI=${document.baseURI}`);

    return report({ sizeKey: A().game.sizeKey, url: document.baseURI });
  };

  // ── 2. render：画面 == toView 给的题面，而且答案没漏 ───────────────────────
  ng.render = async () => {
    const g = await A().newGame({ seed: 'gate-render-6', sizeKey: '6x6' });
    await wait(80);
    const v = A().view;
    const pal = P();
    if (!g) return report({ fatal: 'newGame 没返回盘面' });

    // (a) 逐颗珠子取盘心像素：黑白画反、整体偏一列，都在这里现形
    let pearlN = 0;
    const pearlBad = [];
    let plainN = 0;
    const plainBad = [];
    for (let r = 0; r < g.h; r++) {
      for (let c = 0; c < g.w; c++) {
        const cell = r * g.w + c;
        const kind = g.face.pearls[r][c];
        const m = cellMid(cell);
        const px = sample(m.x, m.y);
        if (kind) {
          pearlN++;
          const want = rgb(kind === 'black' ? pal.pearlBlack : pal.pearlWhite);
          if (!near(px, want)) pearlBad.push(`R${r + 1}C${c + 1} ${kind} 期望 ${show3(want)} 得到 ${show3(px)}`);
        } else {
          plainN++;
          if (!near(px, rgb(pal.field))) plainBad.push(`R${r + 1}C${c + 1} 期望盘底 ${show3(rgb(pal.field))} 得到 ${show3(px)}`);
        }
      }
    }
    ck(`render: ${pearlN} 颗珠子的盘心像素和 toView 给的那一颗同色（黑=${pal.pearlBlack} 白=${pal.pearlWhite}）`, pearlN > 0 && pearlBad.length === 0, `${pearlBad.slice(0, 3).join(' | ')} 珍珠数=${pearlN} 引擎报=${g.puzzle.pearlCount}`);
    ck(`render: ${plainN} 个空格子的盘心是盘底色（没有凭空的圆）`, plainBad.length === 0, plainBad.slice(0, 3).join(' | '));

    // (b) 参考环是答案：一条都没画的时候，它不许出现在盘上
    const accent = rgb(pal.accent);
    const leak = [];
    for (const [cell, d] of allEdges(g)) {
      const m = segMid(cell, d);
      if (near(sample(m.x, m.y), accent, 40)) leak.push(`R${Math.floor(cell / g.w) + 1}C${(cell % g.w) + 1}:${d}`);
    }
    ck('render: 一条都没画时任何一段都不是环线色（答案没漏到盘上）', leak.length === 0, `漏了 ${leak.length}/${g.face.segs.length} 段：${leak.slice(0, 3).join(' ')}`);

    // (c) 几何自洽：视图寻边的方式必须和 loop.js 说的是同一套
    const k = v.geo.cell;
    const c0 = v.cellRect(0);
    const c1 = v.cellRect(1);
    const cb = v.cellRect(g.w);
    ck('render: 相邻格心正好差一个 cell（横向与纵向）', c1.cx - c0.cx === k && cb.cy - c0.cy === k && k > 0, `cell=${k} 横差=${c1.cx - c0.cx} 纵差=${cb.cy - c0.cy}`);
    let segBad = 0;
    let segN = 0;
    for (const [cell, d] of allEdges(g)) {
      const r = v.segRect(cell, d);
      const a = v.centerOf(cell);
      const b = v.centerOf(E().neighbor(g.w, g.h, cell, d));
      segN++;
      if (Math.abs(r.x + r.w / 2 - (a.x + b.x) / 2) > 0.01 || Math.abs(r.y + r.h / 2 - (a.y + b.y) / 2) > 0.01) segBad++;
    }
    ck(`render: ${segN} 条可能边的包围盒中点 = 两端格心的中点（段是按 loop.js 的方向寻的）`, segN > 0 && segBad === 0, `${segBad}/${segN} 条对不上`);
    const cv = v.canvas;
    const d = v.geo.dpr;
    ck(
      'render: 后备缓冲 = CSS 尺寸 × dpr，且 CSS 尺寸 = 布局矩形',
      cv.width === Math.round(v.geo.w * d) && cv.height === Math.round(v.geo.h * d) && Math.abs(cv.getBoundingClientRect().width - v.geo.w) < 1.5 && Math.abs(cv.getBoundingClientRect().height - v.geo.h) < 1.5,
      `backing ${cv.width}x${cv.height} css ${v.geo.w}x${v.geo.h} rect ${Math.round(cv.getBoundingClientRect().width)}x${Math.round(cv.getBoundingClientRect().height)} dpr=${d}`
    );

    return report({ pearls: pearlN, edges: segN, cell: k, dpr: d, fingerprint: g.puzzle.fingerprint });
  };

  // ── 3. play：真指针画得出来、错得看得见、verify 说了算 ────────────────────
  ng.play = async () => {
    const g = await A().newGame({ seed: 'gate-play-6', sizeKey: '6x6' });
    await wait(80);
    if (!g) {
      ck('play: 页面出得了盘', false, 'newGame 返回空');
      return report({ fatal: true });
    }
    const pal = P();
    const accent = rgb(pal.accent);
    const field = rgb(pal.field);
    const cutC = rgb(pal.cutMark);
    const badC = rgb(pal.badRing);
    const model = modelSet(g);
    // R3C3：左、右、下三条边都还在盘内，所以这一格是构造「度数 3」最省事的支点
    const mid = 2 * g.w + 2;

    await dragPath([mid - 1, mid, mid + 1]);
    eq('play: 真指针拖过 3 格 → 引擎状态里正好 2 条 LOOP 边', String(g.loopEdges().length), '2');
    const drawnBad = [];
    for (const [cell, d] of [[mid - 1, E().RIGHT], [mid, E().RIGHT]]) {
      const m = segMid(cell, d);
      const px = sample(m.x, m.y);
      if (!near(px, accent)) drawnBad.push(`R${Math.floor(cell / g.w) + 1}C${(cell % g.w) + 1}:${d} 期望 ${show3(accent)} 得到 ${show3(px)}`);
    }
    ck('play: 刚拖出来的那两段，段中点像素就是环线色', drawnBad.length === 0, drawnBad.slice(0, 2).join(' | '));
    eq('play: 两个还没接上的端点被数出来了', text('#stat-ends'), '2');

    await dragPath([mid + g.w, mid]);
    const rp = A().view.ringPoint(mid);
    const rpx = sample(rp.x, rp.y);
    const badNow = g.badCells();
    ck(
      'play: 顶出第三条边 → 读数说 1 格度数异常，且那一格的错误圈像素就是错误圈色（错得看得见）',
      num('#stat-bad') === 1 && badNow.length === 1 && badNow[0] === mid && near(rpx, badC),
      `读数=${text('#stat-bad')} 异常格=${badNow} 期望 ${show3(badC)} 得到 ${show3(rpx)} @${Math.round(rp.x)},${Math.round(rp.y)}`
    );

    g.undo();
    A().render();
    await wait(30);
    const rpx2 = sample(rp.x, rp.y);
    ck(
      'play: 撤销一整组 → 异常读数归零、退回 2 段、取样点回到盘底色（错误圈不是画上去就下不来）',
      num('#stat-bad') === 0 && g.loopEdges().length === 2 && near(rpx2, field),
      `读数=${text('#stat-bad')} 段数=${g.loopEdges().length} 得到 ${show3(rpx2)}`
    );

    // ── 三态：右键把指针压着的那**一条**边画成叉，再点一次回没落笔，undo 逐层退回去 ──
    // 这一格现在挂着两条环边：(mid-1)↔mid 和 mid↔(mid+1)。右键落在 mid 的右半边，
    // 就只有 mid↔(mid+1) 这一条变成叉 —— 左边那条必须还是环，否则「右键=擦整格」的老毛病没修掉。
    const hpt = halfOf(mid, E().RIGHT);
    const mv0 = g.moves;
    const st0 = g.undoStack.length;
    await rightClickAt(hpt.x, hpt.y);
    const hp = clientOf(hpt.x, hpt.y);
    const hit = A().view.hitEdge(hp.x, hp.y);
    ck(
      'play: 右键落在 mid 右半边 → hitEdge 交出的正是 (mid, RIGHT) 这一条边（指针闸：命中点寻得到这条边）',
      !!hit && hit.cell === mid && hit.d === E().RIGHT,
      JSON.stringify(hit)
    );
    eq('play: 右键那一下把这条边写成引擎的 CUT（不是 UNKNOWN）', String(E().valOf(g.st, mid, E().RIGHT)), String(E().CUT));
    eq('play: 只动一条边：左边那条环边还是 LOOP', String(E().valOf(g.st, mid - 1, E().RIGHT)), String(E().LOOP));
    eq('play: 画叉也记一步、也进撤销栈（moves 与 undo 组没被旁路）', `${g.moves - mv0}/${g.undoStack.length - st0}`, '1/1');
    const mk = markMid(mid, E().RIGHT);
    const mkPx = sample(mk.x, mk.y);
    ck(
      'play: 叉画得出来 —— 叉中心像素就是叉色，而且已经不是环线色（不是「什么都不画」）',
      near(mkPx, cutC) && far(mkPx, accent),
      `期望 ${show3(cutC)} 得到 ${show3(mkPx)}（环线色 ${show3(accent)}）@${Math.round(mk.x)},${Math.round(mk.y)}`
    );
    eq('play: 「已排除」读数跟着涨到 1', text('#stat-cuts'), '1');

    await rightClickAt(hpt.x, hpt.y);
    const mkPx2 = sample(markMid(mid, E().RIGHT).x, markMid(mid, E().RIGHT).y);
    ck(
      'play: 同一条边再右键一次 → 回 UNKNOWN，像素既不是叉也不是环线',
      E().valOf(g.st, mid, E().RIGHT) === E().UNKNOWN && far(mkPx2, cutC) && far(mkPx2, accent),
      `状态=${E().valOf(g.st, mid, E().RIGHT)} 得到 ${show3(mkPx2)}`
    );
    const mvU = g.moves;
    g.undo();
    A().render();
    await wait(30);
    ck(
      'play: 撤销一次 → 退回的是落笔前那个值 CUT（叉），不是「没落笔」：undo 记录里三态没被压平',
      E().valOf(g.st, mid, E().RIGHT) === E().CUT && g.moves - mvU === 1 && near(sample(markMid(mid, E().RIGHT).x, markMid(mid, E().RIGHT).y), cutC),
      `状态=${E().valOf(g.st, mid, E().RIGHT)} 步数增量=${g.moves - mvU}`
    );
    g.undo();
    A().render();
    await wait(30);
    ck(
      'play: 再撤销一次 → 退回 LOOP，段中点像素回到环线色（UNKNOWN←CUT←LOOP 一路可逆）',
      E().valOf(g.st, mid, E().RIGHT) === E().LOOP && g.undoStack.length === st0 && near(sample(segMid(mid, E().RIGHT).x, segMid(mid, E().RIGHT).y), accent),
      `状态=${E().valOf(g.st, mid, E().RIGHT)} 栈=${g.undoStack.length}/${st0}`
    );

    // 擦掉这支笔（老右键的活现在归它）：一笔拖过去，环边与叉一起回到没落笔。
    // 这一步同时把盘面清干净，好让下面两条拖拽断言从「空盘」起步（不然它们量的是上一笔的余数）。
    A().setMode('erase');
    await dragPath([mid - 1, mid, mid + 1]);
    A().setMode('loop');
    const m0 = segMid(mid, E().RIGHT);
    const px0 = sample(m0.x, m0.y);
    ck(
      'play: 「擦掉」这支笔拖过去 → 环边与叉一起回 UNKNOWN，段中点既不是环线色也不是叉色',
      g.loopEdges().length === 0 && g.cutEdges().length === 0 && far(px0, accent) && far(px0, cutC),
      `段数=${g.loopEdges().length} 叉数=${g.cutEdges().length} 得到 ${show3(px0)}`
    );
    ck('play: 清空之后两个读数一起归零（已画环段 / 已排除）', text('#stat-segs') === '0' && text('#stat-cuts') === '0', `环段=${text('#stat-segs')} 排除=${text('#stat-cuts')}`);

    // 拖拽画环仍然一组撤销（叉上线之后这条也要照样成立）
    const stL = g.undoStack.length;
    const mvL = g.moves;
    await dragPath([mid - 1, mid, mid + 1]);
    eq('play: 一笔拖过两格 = 两条 LOOP = 一步 = 一组撤销', `${g.loopEdges().length}/${g.moves - mvL}/${g.undoStack.length - stL}`, '2/1/1');
    g.undo();
    A().render();
    await wait(30);
    eq('play: 一次 undo 退掉整笔环（回到空盘，一条都不剩）', `${g.loopEdges().length}/${g.cutEdges().length}`, '0/0');

    // 排除叉那支笔拖一笔：经过的两条边一起变叉，仍然是一组撤销
    A().setMode('cut');
    eq('play: 「排除叉」是一支真的笔（模式切得过去，aria-pressed 跟着走）', document.querySelector('#btn-mode-cut').getAttribute('aria-pressed'), 'true');
    eq('play: 切模式本身不落笔（切一下盘面还是零条叉）', String(g.cutEdges().length), '0');
    const stC = g.undoStack.length;
    const mvC = g.moves;
    await dragPath([mid - 1, mid, mid + 1]);
    eq('play: 叉笔一笔拖过两条边 → 引擎里正好两条 CUT', String(g.cutEdges().length), '2');
    eq('play: 一笔叉 = 一步 = 一组撤销', `${g.moves - mvC}/${g.undoStack.length - stC}`, '1/1');
    eq('play: 叉笔那一笔之后「已排除」读数就是 2', text('#stat-cuts'), '2');
    g.undo();
    A().setMode('loop');
    A().render();
    await wait(30);
    eq('play: 一次 undo 退掉整笔叉（两条一起回到没落笔，不留一地没人认领的叉）', `${g.cutEdges().length}/${g.loopEdges().length}`, '0/0');

    // 全清也得是三态的：只扫 LOOP 会留一地没人认领的叉。先量命中盒，再真点下去。
    await rightClickAt(hpt.x, hpt.y);
    await dragPath([mid - 1, mid]);
    eq('play: 全清之前盘上确实同时有环与叉（不然这条清的是空气）', `${g.loopEdges().length}/${g.cutEdges().length}`, '1/1');
    const clr = document.querySelector('#btn-clear');
    const clrRect = clr.getBoundingClientRect();
    const clrHit = document.elementFromPoint(Math.round(clrRect.left + clrRect.width / 2), Math.round(clrRect.top + clrRect.height / 2));
    ck('play: 「全清」按钮的命中盒到得了它自己', clrRect.width > 30 && clrRect.height > 18 && (clrHit === clr || clr.contains(clrHit)), `矩形 ${Math.round(clrRect.width)}x${Math.round(clrRect.height)} 命中 ${clrHit ? clrHit.tagName + '#' + clrHit.id : 'null'}`);
    clr.click();
    await wait(40);
    ck(
      'play: 「全清」扫的是三态（环边与叉一起回到没落笔，两个读数一起归零）',
      g.loopEdges().length === 0 && g.cutEdges().length === 0 && text('#stat-segs') === '0' && text('#stat-cuts') === '0',
      `环段=${g.loopEdges().length}/${text('#stat-segs')} 叉=${g.cutEdges().length}/${text('#stat-cuts')}`
    );

    // 叉不许压住珠子：珠子画在第 6 步、在叉之上，而且叉沿轴只伸到离格心 0.39 cell 之外
    let pearlCell = -1;
    let pearlDir = E().RIGHT;
    for (let r = 0; r < g.h && pearlCell < 0; r++) {
      for (let c = 0; c < g.w; c++) {
        if (!g.face.pearls[r][c]) continue;
        const cell = r * g.w + c;
        for (const d of [E().RIGHT, E().DOWN, E().LEFT, E().UP]) {
          if (E().neighbor(g.w, g.h, cell, d) >= 0) {
            pearlCell = cell;
            pearlDir = d;
            break;
          }
        }
        if (pearlCell >= 0) break;
      }
    }
    if (pearlCell < 0) {
      ck('play: 题面里找得到一颗带邻格的珠子（不然「叉不遮珠」这条没法证）', false, '没有珠子能补叉');
    } else {
      const kindWant = g.face.pearls[Math.floor(pearlCell / g.w)][pearlCell % g.w];
      const cuts0 = g.cutEdges().length;
      const hpp = halfOf(pearlCell, pearlDir);
      await rightClickAt(hpp.x, hpp.y);
      const pPx = sample(cellMid(pearlCell).x, cellMid(pearlCell).y);
      const wantP = rgb(kindWant === 'black' ? pal.pearlBlack : pal.pearlWhite);
      ck(
        `play: 给长着${kindWant === 'black' ? '黑' : '白'}珠的那格补一个叉 → 珠心像素还是那颗珠子（叉不遮珠）`,
        E().valOf(g.st, pearlCell, pearlDir) === E().CUT && g.cutEdges().length === cuts0 + 1 && near(pPx, wantP),
        `状态=${E().valOf(g.st, pearlCell, pearlDir)} 叉数=${g.cutEdges().length}/${cuts0} 珠心 ${show3(pPx)} 想要 ${show3(wantP)}`
      );
      ck(
        'play: 叉色与黑珠/白珠/盘底/网格线/环线**逐通道**都拉开 ≥25（三态各自可读，谁也冒充不了谁）',
        [pal.pearlBlack, pal.pearlWhite, pal.field, pal.gridLine, pal.accent].every((k) => minChan(cutC, rgb(k)) >= 25),
        `叉 ${show3(cutC)} 逐通道最小间距：黑 ${minChan(cutC, rgb(pal.pearlBlack))} 白 ${minChan(cutC, rgb(pal.pearlWhite))} 盘底 ${minChan(cutC, rgb(pal.field))} 网格 ${minChan(cutC, rgb(pal.gridLine))} 环线 ${minChan(cutC, accent)}`
      );
      g.undo();
      A().render();
      await wait(30);
      eq('play: 珠子上那个叉撤得掉（撤完叉数回到画它之前那个数）', String(g.cutEdges().length), String(cuts0));
    }

    // 沿参考环走一整圈：相邻格一笔画（loopOrder 给的就是一条相邻连通的圈），
    // 这是玩家按得出来的最长一次拖拽，不是往引擎里灌答案。
    const order = E().loopOrder(g.w, g.h, g.puzzle.solution);
    await dragPath(order.concat([order[0]]));
    const st = g.status();
    ck(
      'play: 一笔画完整圈 → verify() 判 ok，环长与出题那圈一致',
      st.ok === true && st.length === g.puzzle.loopLength && order.length === g.puzzle.loopLength,
      `${JSON.stringify(st)} order=${order.length} 出题环长=${g.puzzle.loopLength}`
    );

    const veil = $('#win-veil');
    const vr = veil.getBoundingClientRect();
    const cr = A().view.canvas.getBoundingClientRect();
    const over = document.elementFromPoint(Math.round(cr.left + cr.width / 2), Math.round(cr.top + cr.height / 2));
    ck(
      'play: 赢之后胜利卡片真的占住了盘面（矩形非零、盖住画布中心）',
      vr.width > 50 && vr.height > 50 && (over === veil || veil.contains(over)),
      `veil ${Math.round(vr.width)}x${Math.round(vr.height)} 中心命中 ${over ? over.tagName + '#' + over.id : 'null'}`
    );

    // 全场对照：像素集合 == 模型集合，两个方向都不许多、也不许少
    const pxExtra = [];
    const pxMissing = [];
    for (const [cell, d] of allEdges(g)) {
      const m = segMid(cell, d);
      const isLoop = near(sample(m.x, m.y), accent, 40);
      const inModel = model.has(`${cell}:${d}`);
      if (isLoop && !inModel) pxExtra.push(`${cell}:${d}`);
      if (!isLoop && inModel) pxMissing.push(`${cell}:${d}`);
    }
    ck(
      `play: ${g.face.segs.length} 段逐段对照——画出来的像素集合 == toView 给的模型集合（多 ${pxExtra.length} 少 ${pxMissing.length}）`,
      pxExtra.length === 0 && pxMissing.length === 0,
      `多了 ${pxExtra.slice(0, 4).join(' ')} 少了 ${pxMissing.slice(0, 4).join(' ')}`
    );

    // 换一局必须真换：新 seed 是 crypto mint 出来的，像素也跟着换一张
    const before = { seed: g.seed, fp: g.puzzle.fingerprint };
    const g2 = await A().newGame({});
    await wait(80);
    ck(
      'play: 换一局发的是一张新盘（seed 与指纹都换了，随机只发生在选 seed 那一步）',
      g2.seed !== before.seed && g2.puzzle.fingerprint !== before.fp,
      `seed ${before.seed} → ${g2.seed}；指纹 ${before.fp} → ${g2.puzzle.fingerprint}`
    );
    let paintedPearls = 0;
    for (let r = 0; r < g2.h; r++) {
      for (let c = 0; c < g2.w; c++) {
        const m = cellMid(r * g2.w + c);
        const px = sample(m.x, m.y);
        if (near(px, rgb(pal.pearlBlack), 10) || near(px, rgb(pal.pearlWhite), 10)) paintedPearls++;
      }
    }
    eq('play: 新盘上画出来的珠子数 == 新题面 pearlCount（像素跟着模型换，不是留着上一张）', String(paintedPearls), String(g2.puzzle.pearlCount));

    return report({ loopLength: g.puzzle.loopLength, verify: st, seedBefore: before.seed, seedAfter: g2.seed });
  };

  // ── 4/5. marks + resume：存档是三态的，旧存档读得动，续局不许谎报步数 ───────
  // 「画一个叉 → 刷新 → 叉还在、步数不是 0」这条要求里有「刷新」两个字，所以它必须拆成两场：
  //   marks 用真指针把叉画下去、让页面自己存盘，并把期望写进一个**只有 harness 认得**的键；
  //   resume 在下一次真导航（playtest.cjs 每个场景都重新 Page.navigate）之后把它读回来。
  // 期望存在 harness 键里而不是当场现算，正是为了让 resume 那条「步数不是 0」不是自我实现：
  // 那个数字是上一场真走过的步数，这一场只是核对页面有没有把谎话改掉。
  const GATE_KEY = 'masyu.gate.marks'; // app 从不读这个键（它只认 masyu.save.v1）

  ng.marks = async () => {
    const g = await A().newGame({ seed: 'gate-marks-6', sizeKey: '6x6' });
    await wait(80);
    if (!g) {
      ck('marks: 页面出得了盘', false, 'newGame 返回空');
      return report({ fatal: true });
    }
    const pal = P();
    const accent = rgb(pal.accent);
    const cutC = rgb(pal.cutMark);
    const EC = E().edgeCount(g.w, g.h);
    const mid = 2 * g.w + 2;
    const cutCell = mid;
    const cutDir = E().DOWN; // 与拖出来的那两条横边不重叠，叉与环各数各的
    const eLoopA = E().edgeOf(g.st, mid - 1, E().RIGHT);
    const eLoopB = E().edgeOf(g.st, mid, E().RIGHT);
    const eCut = E().edgeOf(g.st, cutCell, cutDir);
    const fp0 = g.puzzle.fingerprint;
    const mv0 = g.moves;

    await dragPath([mid - 1, mid, mid + 1]);
    eq('marks: 拖出来的是两条环边、零个叉（存档之前先得有笔迹）', `${g.loopEdges().length}/${g.cutEdges().length}`, '2/0');
    const hpt = halfOf(cutCell, cutDir);
    await rightClickAt(hpt.x, hpt.y);
    ck('marks: 右键那一下在引擎边数组上写的是 CUT（2），不是「没画」（0）', g.st.edges[eCut] === E().CUT, `得到 ${g.st.edges[eCut]} 想要 ${E().CUT}（边号 ${eCut}/${EC}）`);
    eq('marks: 一笔拖拽 + 一次右键 = 两步（存档要搬的就是这个数）', String(g.moves - mv0), '2');
    const realMoves = g.moves;

    const saved = g.encode();
    const ones = saved.split('').filter((ch) => ch === '1').length;
    const twos = saved.split('').filter((ch) => ch === '2').length;
    ck(`marks: 存档串里 '1' 出现 ${ones} 次、'2' 出现 ${twos} 次（CUT 没被压平成 '0'，长度 = 边数 ${EC}）`, saved.length === EC && ones === 2 && twos === 1, `长度=${saved.length} '1'=${ones} '2'=${twos} 串=${saved}`);
    const charBad = [];
    for (let e = 0; e < EC; e++) {
      const v = g.st.edges[e];
      const wantCh = v === E().CUT ? '2' : v === E().LOOP ? '1' : '0';
      if (saved[e] !== wantCh) charBad.push(`${e}:态${v}→'${saved[e]}' 想要 '${wantCh}'`);
    }
    ck(`marks: ${EC} 条边逐条核对 encode 的字符表（'0'=没落笔 / '1'=环边 / '2'=排除叉）`, charBad.length === 0, charBad.slice(0, 4).join(' | '));

    const r = A().store.resume();
    ck(
      'marks: 页面自己存下的 resume 里就是这张三态串与非零步数（存的是笔迹，不是答案）',
      !!r && r.marks === saved && r.moves === g.moves && r.moves > 0 && r.seed === g.seed,
      r ? `marks="${(r.marks || '').slice(0, 12)}…" moves=${r.moves} seed=${r.seed}` : 'store.resume() 返回空'
    );

    // 旧存档：上一轮发布的只有 '0'/'1' 两个字符。那张表原样嵌在新一里，所以必须照旧读得动。
    let legacy = '';
    for (let e = 0; e < EC; e++) legacy += e === eLoopA || e === eLoopB ? '1' : '0';
    let threw = '';
    try {
      g.decode(legacy);
    } catch (err) {
      threw = String((err && err.message) || err);
    }
    ck(
      `marks: 纯 0/1 的旧存档字符串读得进来且不崩（${legacy.length} 条里 2 个 '1'、0 个 '2'）`,
      threw === '' && g.loopEdges().length === 2 && g.cutEdges().length === 0,
      threw ? `抛了 ${threw}` : `环边=${g.loopEdges().length} 叉=${g.cutEdges().length}`
    );
    ck('marks: 旧串读进来的就是那两条环边，再写回去与原串逐字符相同（字符表不换代）', threw === '' && g.encode() === legacy, `得到 ${g.encode()} 想要 ${legacy}`);
    eq('marks: 没给步数就是从零开始（decode 不许拿上一局的步数冒充，也不许把有步数的说成 0）', `${g.moves}/${g.undoStack.length}`, '0/0');

    try {
      g.decode('2'.repeat(EC));
    } catch (err) {
      threw = String((err && err.message) || err);
    }
    ck('marks: 满盘全是 \'2\' → 读进来是满盘排除叉而不是环（三态的字符谁也冒充不了谁）', threw === '' && g.cutEdges().length === EC && g.loopEdges().length === 0, `叉=${g.cutEdges().length}/${EC} 环=${g.loopEdges().length}`);

    const junkBad = [];
    for (const s of ['01', 'x'.repeat(EC), '2', '0'.repeat(EC + 9), '']) {
      try {
        g.decode(s, 5);
      } catch (err) {
        junkBad.push(`${JSON.stringify(s).slice(0, 12)}→${(err && err.message) || err}`);
      }
    }
    ck(
      'marks: 短串/乱码/超长串都只被读成空盘、一个都不抛（尺寸换过或串被截断也不崩）',
      junkBad.length === 0 && g.loopEdges().length === 0 && g.cutEdges().length === 0,
      `${junkBad.slice(0, 3).join(' | ')} 环=${g.loopEdges().length} 叉=${g.cutEdges().length}`
    );
    eq('marks: 传进来的步数就照着恢复（这一处就是原来那句「刷新一次步数归 0」的谎）', String(g.moves), '5');

    // 续局的正路：main.js 的 newGame({seed, sizeKey, marks, moves})——boot 读存档恢复就走这一条。
    let g2 = null;
    try {
      g2 = await A().newGame({ seed: 'gate-marks-6', sizeKey: '6x6', marks: saved, moves: realMoves });
    } catch (err) {
      ck('marks: 续局入口读三态存档不抛', false, String((err && err.message) || err));
      return report({ fatal: true });
    }
    await wait(80);
    ck(
      'marks: 续局入口把三态整张搬回来了（叉在原来那条边上、两条环边也在、串逐字符相同）',
      g2.st.edges[eCut] === E().CUT && g2.loopEdges().length === 2 && g2.cutEdges().length === 1 && g2.encode() === saved,
      `边 ${eCut}=${g2.st.edges[eCut]} 环=${g2.loopEdges().length} 叉=${g2.cutEdges().length}`
    );
    ck('marks: 同一个 seed 重建出的是同一张盘（题面不经过存储搬运，指纹当然也一样）', g2.puzzle.fingerprint === fp0, `${fp0} → ${g2.puzzle.fingerprint}`);
    eq('marks: 续局恢复的步数就是存下的那 2 步，面板读数也是 2（刷新一次归零那句谎话在这里现形）', `${g2.moves}/${text('#stat-moves')}`, '2/2');
    const mk = markMid(cutCell, cutDir);
    const mkPx = sample(mk.x, mk.y);
    ck('marks: 恢复出来的叉在画面上仍然画得出来（叉中心像素是叉色，也不是环线色）', near(mkPx, cutC) && far(mkPx, accent), `期望 ${show3(cutC)} 得到 ${show3(mkPx)}（环线 ${show3(accent)}）`);

    // 把期望交给下一场（真刷新之后）。写的是 harness 自己的键，app 读不到它。
    localStorage.setItem(
      GATE_KEY,
      JSON.stringify({
        seed: g2.seed,
        sizeKey: g2.sizeKey,
        fp: g2.puzzle.fingerprint,
        moves: g2.moves,
        marks: saved,
        eCut,
        eLoopA,
        eLoopB,
        cutCell,
        cutDir,
        segs: 2,
        cuts: 1,
      })
    );
    return report({ edges: EC, savedMoves: g2.moves, savedMark: saved.slice(eCut, eCut + 1), fingerprint: g2.puzzle.fingerprint });
  };

  ng.resume = async () => {
    for (let i = 0; i < 300 && !(A() && A().state === 'ready'); i++) await wait(50);
    await wait(120);
    const raw = localStorage.getItem(GATE_KEY);
    if (!raw || !A() || !A().game) {
      ck('resume: 上一场 marks 的期望还在（这场靠它核对「刷新之后」，必须连着跑）', false, raw ? '页面没起来' : `${GATE_KEY} 是空的：跑 SCENARIOS="marks resume"`);
      return report({ fatal: true });
    }
    const want = JSON.parse(raw);
    const g = A().game; // 这是 boot() 读存档恢复出来的那一局，不是场景自己 newGame 出来的
    const pal = P();
    const accent = rgb(pal.accent);
    const cutC = rgb(pal.cutMark);
    const errs = w.__masyuErrs || [];

    eq('resume: 刷新之后接着的是同一局（原始 seed 与指纹都没换）', `${g.seed}/${g.puzzle.fingerprint}`, `${want.seed}/${want.fp}`);
    ck('resume: 启动这一路没有未捕获异常（旧存档读进来不崩）', errs.length === 0, errs.slice(0, 3).join(' | '));
    ck('resume: 叉还在 —— 引擎边数组上那一条刷新之后仍然是 CUT', g.st.edges[want.eCut] === E().CUT, `得到 ${g.st.edges[want.eCut]} 想要 ${E().CUT}`);
    const mk = markMid(want.cutCell, want.cutDir);
    const mkPx = sample(mk.x, mk.y);
    ck('resume: 叉还在 —— 画面也仍然把它画出来了（叉中心是叉色，不是环线色）', near(mkPx, cutC) && far(mkPx, accent), `期望 ${show3(cutC)} 得到 ${show3(mkPx)}`);
    ck(
      'resume: 步数不是 0 —— 恢复出来的 moves 与面板读数都等于上一场真走过的那个数',
      want.moves > 0 && g.moves === want.moves && text('#stat-moves') === String(want.moves),
      `game.moves=${g.moves} 读数="${text('#stat-moves')}" 存档里是 ${want.moves}`
    );
    ck('resume: 整张笔迹逐字符搬回来了（存档串 == 恢复后的 encode）', g.encode() === want.marks, `得到 ${g.encode()} 想要 ${want.marks}`);
    eq('resume: 两个读数跟着刷新回来（已画环段 / 已排除）', `${text('#stat-segs')}/${text('#stat-cuts')}`, `${want.segs}/${want.cuts}`);

    // 诚实的那一半：撤销栈确实跨不过刷新，所以「步数」不是「还能撤这么多步」的承诺。
    const mvR = g.moves;
    const undone = g.undo();
    ck('resume: 撤销栈清空是真的（空栈 undo 返回 false、一步都不许多记）', g.undoStack.length === 0 && undone === false && g.moves === mvR, `栈=${g.undoStack.length} undo=${undone} 步数=${mvR}→${g.moves}`);

    // 旧格式（上一轮发布的纯 0/1 串）走的是**同一条续局入口**：把它读崩或读成 0 步，都算没兼容。
    const legacy = want.marks.replace(/2/g, '0');
    let gOld = null;
    let threw = '';
    try {
      gOld = await A().newGame({ seed: want.seed, sizeKey: want.sizeKey, marks: legacy, moves: 7 });
      await wait(60);
    } catch (err) {
      threw = String((err && err.message) || err);
    }
    ck(
      'resume: 纯 0/1 的旧存档经 newGame(marks, moves) 这条路也读得进来（2 条环边、0 个叉、步数照搬 7）',
      threw === '' && !!gOld && gOld.loopEdges().length === want.segs && gOld.cutEdges().length === 0 && gOld.moves === 7 && text('#stat-moves') === '7',
      threw ? `抛了 ${threw}` : `环=${gOld && gOld.loopEdges().length} 叉=${gOld && gOld.cutEdges().length} 步数=${gOld && gOld.moves}/${text('#stat-moves')}`
    );

    // 版本护栏在浏览器这一侧也要走一遍：存档存的是原始 seed，生成器一改版（本轮的门 2）同一个 seed
    // 就重画出另一张盘。指纹对不上时旧笔迹一颗都不许搬过来——搬了就是让玩家在自己没玩过的盘上续命，
    // 而且这句话必须当着玩家说，不是悄悄吃掉。这里用「另一张盘的指纹」冒充旧版生成器画的盘。
    const foreign = A().engine.makePuzzle('gate-fp-foreign', want.sizeKey, { requireBothColors: false });
    A().store.data.resume = {
      seed: want.seed, sizeKey: want.sizeKey, marks: want.marks, moves: want.moves, elapsedMs: 0, fingerprint: foreign.fingerprint,
    };
    A().store.save();
    const gFresh = await A().newGame({ seed: want.seed, sizeKey: want.sizeKey, resumeFrom: A().store.data.resume });
    await wait(60);
    const emptyMarks = /^0+$/.test(gFresh ? gFresh.encode() : 'x');
    ck(
      'resume: 指纹对不上 ⇒ 旧笔迹一颗都不搬（同 seed 的当下那张盘、空笔迹、0 步、读数跟着归零）',
      !!gFresh && foreign.fingerprint !== gFresh.puzzle.fingerprint && gFresh.puzzle.fingerprint === want.fp && emptyMarks && gFresh.moves === 0 && text('#stat-moves') === '0',
      `指纹 ${foreign.fingerprint} vs ${gFresh && gFresh.puzzle.fingerprint} 笔迹全 0=${emptyMarks} 步数=${gFresh && gFresh.moves}/${text('#stat-moves')}`
    );
    ck('resume: 对不上时当着玩家说清「这一局重新开始」（不是悄悄吃掉存档）', text('#state-line').includes('对不上'), `状态行="${text('#state-line')}"`);
    ck('resume: 拒收的原因留在 resumeDiscarded 里（排障看得见是哪种不一致）', !!A().store.resumeDiscarded && A().store.resumeDiscarded.why === '指纹不一致', JSON.stringify(A().store.resumeDiscarded));
    ck('resume: 那份废存档就地换成了诚实的一份（写的是当下这张盘的指纹，下次刷新正常续）', !!A().store.data.resume && A().store.data.resume.fingerprint === gFresh.puzzle.fingerprint && A().store.resume(gFresh.puzzle.fingerprint) !== null, JSON.stringify(A().store.data.resume));

    // 收干净：这两个键都是这一场自己造的，留着下一次跑的场景就会读到上一局的盘。
    localStorage.removeItem(GATE_KEY);
    A().store.clearResume();
    return report({ resumedMoves: mvR, resumedCuts: g.cutEdges().length, seed: g.seed });
  };

  // ── 6. hint：空盘只连点「提示」也要推到 status().ok（本轮最贵的一条门禁）────
  // 一场证三件事，缺一不可：
  //   1) 一次点击落的正是引擎**当场**说的那一条被迫结论（环就一段、排除就一个叉）；
  //   2) 那一笔在 Game 的账上（步数 +1、撤销栈 +1 组、已定边 +1）——撤销与存档继续是真的；
  //   3) 推到底 status().ok 为真，且推出来的 LOOP 边集合与参考环**逐条**对得上。
  // 对账读的是 puzzle.solution —— 那是答案，只许在 harness 里读一次；玩家那条路（按钮 →
  // hint() → Game.setEdgeById）从头到尾没碰过它，所以下面「点击数 == 边数」与「一次一条」才说明
  // 它真的是铅笔一步一步推出来的，不是把答案抄上牌。对账只活在这一场，产品代码里没有一行。
  ng.hint = async () => {
    const g = await A().newGame({ seed: 'gate-hint-6', sizeKey: '6x6' });
    await wait(80);
    if (!g) {
      ck('hint: 页面出得了盘', false, 'newGame 返回空');
      return report({ fatal: true });
    }
    const pal = P();
    const accent = rgb(pal.accent);
    const cutC = rgb(pal.cutMark);
    const EC = E().edgeCount(g.w, g.h);
    const btn = document.querySelector('#btn-hint');
    const rect = btn.getBoundingClientRect();
    const hitBtn = document.elementFromPoint(Math.round(rect.left + rect.width / 2), Math.round(rect.top + rect.height / 2));
    ck(
      'hint: 「提示」按钮点得到（命中盒非零、中心命中的是它自己，不是一块盖上来的 veil）',
      rect.width > 30 && rect.height > 18 && (hitBtn === btn || btn.contains(hitBtn)),
      `矩形 ${Math.round(rect.width)}x${Math.round(rect.height)} 命中 ${hitBtn ? hitBtn.tagName + '#' + hitBtn.id : 'null'}`
    );
    eq('hint: 起点是空盘（一条笔迹都没有，整条路都得铅笔自己推）', `${g.loopEdges().length}/${g.cutEdges().length}/${E().unknownCount(g.st)}`, `0/0/${EC}`);

    const badLand = [];
    const badBook = [];
    const badText = [];
    const rules = new Set();
    const kinds = { loop: 0, cut: 0 };
    let clicks = 0;
    let stalledAt = -1;
    for (let i = 0; i < EC + 6; i++) {
      const d = E().nextDeduction(g.st); // harness 独立问一次：此刻被迫的是哪一条、哪一态
      if (d.stalled) { stalledAt = i; break; }
      const mv0 = g.moves;
      const st0 = g.undoStack.length;
      const dec0 = decided(g);
      btn.click();
      await wait(14);
      // 状态行要在这一击之后、下一击之前读：它是这句话唯一的一次机会
      const line = text('#state-line');
      clicks++;
      rules.add(d.rule);
      kinds[d.value === E().CUT ? 'cut' : 'loop']++;
      if (g.st.edges[d.edge] !== d.value) {
        badLand.push(`第 ${clicks} 次：引擎说边 ${d.edge}=${d.value}，盘上是 ${g.st.edges[d.edge]}`);
        break;
      }
      if (g.moves - mv0 !== 1 || g.undoStack.length - st0 !== 1 || decided(g) !== dec0 + 1) {
        badBook.push(`第 ${clicks} 次：步数 +${g.moves - mv0}、栈 +${g.undoStack.length - st0}、已定边 +${decided(g) - dec0}（三样都该正好 1）`);
        break;
      }
      // 最后那一击同时是「赢了一局」那一击：checkWin 之后状态行归判词，这是它对所有来源的落笔
      // 一视同仁的行为（拖拽赢的也一样），所以这里按 won 分两种话要对。
      const want = A().won ? 'verify() 判定通过' : `${E().RULE_TEXT[d.rule]} —— ${d.why}`;
      if (!line.includes(want)) {
        badText.push(`第 ${clicks} 次（${d.rule}${A().won ? '，同时是最后一击' : ''}）状态行="${line}"，想要含 "${want}"`);
        break;
      }
      if (g.status().ok) break;
    }

    ck(`hint: ${clicks} 次点击、${rules.size} 条规则轮着说话，每一次落的都是引擎当场说的那一条（一次都没落错边/落错态）`, badLand.length === 0 && clicks > 0, badLand.slice(0, 3).join(' | '));
    ck('hint: 提示的落笔全在 Game 的账上（一次点击 = 步数 +1 = 撤销栈 +1 组 = 已定边 +1，没有任何旁路）', badBook.length === 0, badBook.slice(0, 3).join(' | '));
    ck('hint: 状态行印的就是那条规则的 RULE_TEXT 原句（外加引擎那句 why），最后一击交还给 verify() 的判词；没有一句是另编的安慰话', badText.length === 0, badText.slice(0, 2).join(' | '));

    const st = g.status();
    ck(
      `hint: 空盘只连点「提示」就推到 status().ok（中途一次都没推不动，环长 ${st.length} == 出题那圈），而且赢得是 verify() 说的`,
      stalledAt < 0 && st.ok === true && st.length === g.puzzle.loopLength && A().won === true,
      `${JSON.stringify(st)} 点击=${clicks} 中途 stalled@=${stalledAt} won=${A().won}`
    );
    ck(
      `hint: 每一击只落一条结论（点击数 ${clicks} == 落笔数 == 已定边数 == 步数，一次都没有「顺手多落几条」）`,
      decided(g) === clicks && g.moves === clicks && kinds.loop + kinds.cut === clicks,
      `点击=${clicks} 已定边=${decided(g)} 步数=${g.moves} 落笔=${JSON.stringify(kinds)}`
    );

    // 逐条对账：参考环 vs 提示推出来的 LOOP 边集合（用引擎自己的 edgeOf/dirBetween 现算，不复用盘上的值）
    const order = E().loopOrder(g.w, g.h, g.puzzle.solution);
    const refEdges = [];
    for (let i = 0; i < order.length; i++) {
      const a = order[i];
      const b = order[(i + 1) % order.length];
      refEdges.push(E().edgeOf(g.st, a, E().dirBetween(g.w, a, b)));
    }
    const got = g.loopEdges();
    const missing = refEdges.filter((e) => got.indexOf(e) < 0);
    const extra = got.filter((e) => refEdges.indexOf(e) < 0);
    ck(
      `hint: ${refEdges.length} 条逐条对账——提示推出的 LOOP 边集合 == 参考环（多 ${extra.length} 少 ${missing.length}）；对账只在 harness 里做`,
      refEdges.length === g.puzzle.loopLength && new Set(refEdges).size === refEdges.length && missing.length === 0 && extra.length === 0,
      `多了 ${extra.slice(0, 4).join(' ')} 少了 ${missing.slice(0, 4).join(' ')}`
    );
    ck(
      `hint: ${clicks} 击里提示落了 ${kinds.loop} 段环 + ${kinds.cut} 个叉，段数正好等于参考环长（环与叉都真的落过，不是只画环的半个功能）`,
      kinds.loop === order.length && kinds.cut === clicks - order.length && kinds.loop > 0 && kinds.cut > 0,
      JSON.stringify(kinds) + ` 参考环长=${order.length} 点击=${clicks}`
    );
    const cutOnLoop = refEdges.filter((e) => g.st.edges[e] === E().CUT).length;
    ck('hint: 参考环上没有一条被推成排除叉（环与叉不互相冒用，那些叉不是猜出来的）', cutOnLoop === 0, `${cutOnLoop}/${refEdges.length} 条环边被标成了叉`);
    // 停在 ok 的时候为什么还能有没定的边：status() 的语义是「玩家没画的地方就是不在环上」。
    // 这些边必须一条都不在参考环上——否则「赢了」就是靠把环边当成没画蒙过去的。
    const und = [];
    for (let e = 0; e < EC; e++) if (g.st.edges[e] === E().UNKNOWN) und.push(e);
    ck(
      `hint: 赢的时候剩下 ${und.length} 条边没标，它们没有一条在参考环上（没画的就是不在环上，这条语义 status() 与玩家看到的是同一份）`,
      und.length === EC - clicks && und.every((e) => refEdges.indexOf(e) < 0),
      `未定 ${und.slice(0, 6).join(' ')} 里有 ${und.filter((e) => refEdges.indexOf(e) >= 0).length} 条是环边；未定=${und.length} 想要 ${EC - clicks}`
    );

    // 画面也得跟着：结论不只写在数组里
    const pxBadLoop = [];
    for (let i = 0; i < order.length; i++) {
      const a = order[i];
      const b = order[(i + 1) % order.length];
      const d = E().dirBetween(g.w, a, b);
      const m = segMid(a, d);
      if (!m || !near(sample(m.x, m.y), accent, 40)) pxBadLoop.push(`${a}:${d}`);
    }
    ck(`hint: ${order.length} 段推出来的环边在画面上逐段是环线色（玩家不必读数组就知道铅笔连到了哪儿）`, pxBadLoop.length === 0, pxBadLoop.slice(0, 4).join(' '));
    const pxBadCut = [];
    let cutSeen = 0;
    for (const [cell, d] of allEdges(g)) {
      if (E().valOf(g.st, cell, d) !== E().CUT) continue;
      cutSeen++;
      const m = markMid(cell, d);
      const px = sample(m.x, m.y);
      if (!m || !near(px, cutC) || near(px, accent, 40)) pxBadCut.push(`${cell}:${d}`);
    }
    ck(
      `hint: ${cutSeen} 个推出来的排除叉在画面上个个是叉色（赢了的盘上仍然看得见铅笔排除了什么）`,
      pxBadCut.length === 0 && cutSeen === clicks - order.length,
      `画错的 ${pxBadCut.slice(0, 4).join(' ')}；叉数 ${cutSeen} 想要 ${clicks - order.length}`
    );

    // 已经赢了之后再按提示：什么都不该发生（不然步数与笔迹就成了「提示还在替我走」的假账）
    const mvW = g.moves;
    const decW = decided(g);
    btn.click();
    await wait(20);
    ck(
      'hint: 赢了之后再按提示什么都不追加（步数不涨、笔迹不多、状态行还是 verify() 那句判词）',
      g.moves === mvW && decided(g) === decW && A().won === true && text('#state-line').includes('verify() 判定通过'),
      `步数 ${mvW}→${g.moves} 已定边 ${decW}→${decided(g)} won=${A().won} 状态行="${text('#state-line')}"`
    );

    // 提示落的不是「当前那支笔」，是引擎说的那一态：笔尖调到擦掉也得照样落笔
    const gP = await A().newGame({ seed: 'gate-hint-pen', sizeKey: '6x6' });
    await wait(60);
    A().setMode('erase');
    const dp = E().nextDeduction(gP.st);
    btn.click();
    await wait(20);
    ck(
      'hint: 画笔切到「擦掉」时提示照样落引擎那一态（提示不是当前笔的马甲，它写的是结论的值）',
      dp.value !== E().UNKNOWN && gP.st.edges[dp.edge] === dp.value && gP.moves === 1 && decided(gP) === 1,
      `边 ${dp.edge} 想要 ${dp.value} 得到 ${gP.st.edges[dp.edge]}（擦掉那支笔的 kind=${E().UNKNOWN}）步数=${gP.moves}`
    );
    A().setMode('loop');

    // 键盘 H 与按钮必须是同一条路（面板上 .keyhint 就是这么写给人看的）
    const dK = E().nextDeduction(gP.st);
    const mvK = gP.moves;
    const decK = decided(gP);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'h', bubbles: true, cancelable: true }));
    await wait(20);
    ck(
      'hint: 键盘 H 走的就是按钮那条路（一按落一条结论、记一步、印那句话）',
      gP.st.edges[dK.edge] === dK.value && gP.moves === mvK + 1 && decided(gP) === decK + 1 && text('#state-line').includes(E().RULE_TEXT[dK.rule]),
      `边 ${dK.edge}=${gP.st.edges[dK.edge]}（想要 ${dK.value}）步数 ${mvK}→${gP.moves} 已定边 ${decK}→${decided(gP)} 状态行="${text('#state-line')}"`
    );

    // 盘自己打脸那一支：真指针顶出一颗珠子三条例规的环边，这是玩家干得出来的事
    const gX = await A().newGame({ seed: 'gate-hint-6', sizeKey: '6x6' });
    await wait(60);
    const mid = 2 * gX.w + 2;
    await dragPath([mid - 1, mid, mid + 1]);
    await dragPath([mid + gX.w, mid]);
    const dX = E().nextDeduction(gX.st);
    const decX = decided(gX);
    const mvX = gX.moves;
    const stX = gX.undoStack.length;
    btn.click();
    await wait(20);
    ck(
      'hint: 引擎说「盘自己打脸」时提示不落笔、不前进，只把那句矛盾原样交回状态行',
      !!dX.contradiction && text('#state-line').includes(dX.why) && gX.moves === mvX && gX.undoStack.length === stX && decided(gX) === decX && A().won === false,
      `nextDeduction=${JSON.stringify(dX).slice(0, 130)} 状态行="${text('#state-line')}" 步数 ${mvX}→${gX.moves} 栈 ${stX}→${gX.undoStack.length} 已定边 ${decX}→${decided(gX)}`
    );

    // 「推不动了」那一支：把规则唯一的依据（题面珠子）从这一局的引擎状态里拿掉，铅笔就无路可走。
    // 动的是 st.pearls，一条 st.edges 都没动 —— 造的是「没有题面可依据」，不是造结论；
    // 所以下面数的仍然是「提示一格里都没落」。
    const gS = await A().newGame({ seed: 'gate-hint-stall', sizeKey: '6x6' });
    await wait(60);
    gS.st.pearls.fill(0);
    A().render();
    const mvS = gS.moves;
    const stS = gS.undoStack.length;
    btn.click();
    await wait(20);
    ck(
      'hint: 铅笔推不动了就把「推不动」说在状态行上，一格都不落（不猜、不读答案、也不装成赢了）',
      text('#state-line').includes('推不动') && E().nextDeduction(gS.st).stalled === true && gS.moves === mvS && gS.undoStack.length === stS && decided(gS) === 0 && A().won === false && gS.status().ok === false,
      `状态行="${text('#state-line')}" 步数 ${mvS}→${gS.moves} 栈 ${stS}→${gS.undoStack.length} 已定边=${decided(gS)}`
    );

    A().store.clearResume();
    return report({
      clicks,
      edges: EC,
      rules: rules.size,
      loop: g.loopEdges().length,
      cuts: g.cutEdges().length,
      verify: st,
      loopLength: g.puzzle.loopLength,
    });
  };

  w.__ng = ng;
})(window);
