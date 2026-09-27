// 浏览器里的场景套件，由 tools/playtest.cjs 注入真实页面后跑。三个场景：boot / render / play。
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

  w.__ng = ng;
})(window);
