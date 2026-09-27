// 颜色、间距、动效的唯一来源。样式表通过 applyThemeVars() 读这些值，canvas 读的是同一批对象，
// 所以改一个令牌不可能只改到一边。
//
// Field / Pearl / Loop / Mark 这四组是**被门禁量过的**几何色：tools/scenarios.js 的 render 场景
// 逐颗珠子取盘心像素、play 场景逐条环边取中点像素，两边都比的是这里写的值（容差 12）。
// 所以每一组都必须和「盘底 / 网格线 / 环线」拉开至少 25 的逐通道距离，否则一次改色就能让
// 一个断言在错误的东西上变绿。实测矩阵见 npm run verify 的 render 输出。
export const Palette = {
  bgTop: '#070A14',
  bgBottom: '#121A2C',
  surface: '#0F1526',
  surfaceLift: '#182036',
  line: '#243050',
  lineHeavy: '#6B7FA8',
  ink: '#F2F5FB',
  inkDim: 'rgba(242,245,251,0.62)',
  inkFaint: 'rgba(242,245,251,0.34)',

  // 盘面底色（网格里面那一层）。它离黑珠 #05070D 和白珠 #F2F5FB 都 ≥ 25 通道，
  // 所以「这一格什么都没画」「这里一颗黑珠」「这里一颗白珠」是三块不同的像素。
  field: '#1C2740',
  // 格线只画在格的边界上，盘心取不到它；比 field 暗，用来读网格而不抢环线的戏。
  gridLine: '#0E1424',

  // 琥珀 = 玩家的手：画出来的环段、选中格、键盘光标都是它。
  accent: '#FFC85C',
  accentEdge: '#FFE3A6',
  accentSoft: 'rgba(255,200,92,0.14)',

  info: '#7BB8FF',
  success: '#3DDC91',
  error: '#FF5C7A',
  errorSoft: 'rgba(255,92,122,0.16)',
  warn: '#FFB05C',
  focus: 'rgba(123,184,255,0.16)',
  hint: '#7BB8FF',

  // 珠子：黑珠是实心暗球（环在这一格必须拐），白珠是亮球（环在这一格必须直穿）。
  // 两者的盘心像素相距 200+，所以画反了不可能测不出来。
  pearlBlack: '#05070D',
  pearlWhite: '#F2F5FB',
  pearlRing: '#F2F5FB',
  pearlRingDark: '#05070D',
  // 度数 ≠ 0/2 的格：环在这一格接不通，这一圈是唯一的「你画错了」的视觉证据。
  badRing: '#FF5C7A',
  // 环的端点（度数 1）：还没连上的那一头，用冷白点一下，免得被当成已经闭合。
  capDot: '#7BB8FF',
};

export const Space = { page: 20, card: 16, inner: 12, gutter: 10 };
export const Radius = { card: 18, button: 12, chip: 8, cell: 4 };

export const Font = {
  mono: "'SF Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
  sans: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'PingFang SC', system-ui, sans-serif",
};

export const Motion = {
  tap: 150,
  base: 220,
  line: 260,
  win: 900,
  spring: 'cubic-bezier(0.34, 1.45, 0.64, 1)',
  ease: 'cubic-bezier(0.22, 0.61, 0.36, 1)',
};

// 环线的粗细是**几何**令牌：门禁按它在段中点取样，所以 view 的 lineWidth 和 segRect 的厚度
// 都从这一个数出来（改粗改细都不会让取样点跑出环线之外）。
export const Board = {
  cellMin: 34,
  cellMax: 76,
  pad: 16,
  loopWidth: 0.2,
  pearlR: 0.29,
  ringWidth: 0.11,
  badRingWidth: 0.085,
};

export function applyThemeVars() {
  const root = document.documentElement.style;
  const kebab = (s) => s.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
  for (const [k, v] of Object.entries(Palette)) root.setProperty('--' + kebab(k), v);
  for (const [k, v] of Object.entries(Space)) root.setProperty('--space-' + k, v + 'px');
  for (const [k, v] of Object.entries(Radius)) root.setProperty('--radius-' + k, v + 'px');
  for (const [k, v] of Object.entries(Motion)) {
    if (typeof v === 'number') root.setProperty('--dur-' + kebab(k), v + 'ms');
    else root.setProperty('--ease-' + kebab(k), v);
  }
  root.setProperty('--font-mono', Font.mono);
  root.setProperty('--font-sans', Font.sans);
}

let motionReduced = false;
export function setReduceMotion(v) {
  motionReduced = !!v;
}
export const systemPrefersReducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
export const prefersReducedMotion = () => motionReduced || systemPrefersReducedMotion();
