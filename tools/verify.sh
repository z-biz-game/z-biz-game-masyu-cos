#!/usr/bin/env bash
# One-shot browser verification: real Chrome, real DOM, real pixels, scripted scenarios.
#
#   bash tools/verify.sh                     # boot+render+play+marks+resume+hint，再一次 Pages 前缀冒烟
#   SCENARIOS="render" bash tools/verify.sh
#   SCENARIOS="marks resume" bash tools/verify.sh   # 两场连跑：marks 写期望，resume 跨真刷新读它
#   SHOTS=2 bash tools/verify.sh             # 顺手往 tools/shots/ 落两张 PNG
#   BASE_URL=https://z-biz-game.github.io/z-biz-game-masyu-cos/ bash tools/verify.sh
#
# 生命周期归这个脚本所有：它起服务器、用自己的 --user-data-dir 拉 Chrome、跑场景、把两个都收掉，
# 任何一个断言红了它就得是非零。
#
# Do NOT add --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader: software
# rasterisation saturates every core and, with no CDP client attached, Chrome will not exit
# on its own.
set -u
HERE=$(cd "$(dirname "$0")/.." && pwd)
# 5276 / 9376：本仓在 z-biz-game 端口表里占的那一对。server.cjs 的 fallback、package.json 的
# dev 脚本和这里的默认值必须是同一批数——三处任何一个漂了，一个忘关的别人家的服务器就会
# 被当成本仓的盘面来测，然后门禁在别人家的 DOM 上变绿。
HTTP=${HTTP_PORT:-5276}
PORT=${CDP_PORT:-9376}
BASE=${BASE_URL:-http://127.0.0.1:$HTTP/}
CHROME=${CHROME_BIN:-}
if [ -z "$CHROME" ]; then
  for c in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
           "/Applications/Chromium.app/Contents/MacOS/Chromium" \
           google-chrome chromium chromium-browser; do
    if command -v "$c" >/dev/null 2>&1 || [ -x "$c" ]; then CHROME=$c; break; fi
  done
fi
[ -x "$CHROME" ] || { echo "no Chrome found; set CHROME_BIN" >&2; exit 2; }

port_busy() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | tail -n +2 | grep -q .
  elif command -v nc >/dev/null 2>&1; then
    nc -z -w1 127.0.0.1 "$1" 2>/dev/null
  else
    return 1
  fi
}

LOCAL=0
case "$BASE" in "http://127.0.0.1:$HTTP/"*) LOCAL=1 ;; esac
# 预检：这两个号必须是空的。一次「ALL GREEN」曾经整局跑在别的会话留下来的 headless Chrome 上，
# 视口形状都不对。宁可现在停下，也不要去猜那份 DOM 是谁的。
if [ "$LOCAL" = 1 ]; then
  for p in $HTTP $PORT; do
    if port_busy "$p"; then echo "port $p is already listening — refusing to guess whose DOM this is (free it or set HTTP_PORT/CDP_PORT)" >&2; exit 2; fi
  done
fi
SPID=0
PSPID=0
if [ "$LOCAL" = 1 ]; then
  node "$HERE/server.cjs" "$HTTP" >/tmp/masyu-server.log 2>&1 &
  SPID=$!
  disown   # 收尾时 bash 不该把「Terminated: 15」当成测试输出喷出来
  for i in $(seq 1 40); do
    curl -fsS -m 1 "http://127.0.0.1:$HTTP/" >/dev/null 2>&1 && break
    sleep 0.25
  done
fi
# 预检二：把要测的字节证明是本仓的。js/main.js 只会说「有个 app」，数链 和 masyu 说的是哪一个。
SERVED=$(curl -fsS -m 3 "$BASE" 2>/dev/null || true)
case "$SERVED" in *js/main.js*) ;; *) echo "nothing served at $BASE (see /tmp/masyu-server.log)" >&2; exit 2 ;; esac
echo "$SERVED" | grep -q 数链 || { echo "port $HTTP is serving a different app, not 数链 Masyu" >&2; exit 2; }
echo "$SERVED" | grep -qi masyu || { echo "port $HTTP is serving a different app, not 数链 Masyu" >&2; exit 2; }

UDD=$(mktemp -d)
"$CHROME" --headless=new --remote-debugging-port=$PORT --user-data-dir=$UDD \
  --window-size=900,980 --no-first-run --no-default-browser-check about:blank >/tmp/masyu-chrome.log 2>&1 &
CPID=$!
disown
cleanup() {
  [ "$SPID" != 0 ] && kill $SPID 2>/dev/null
  [ "$PSPID" != 0 ] && kill $PSPID 2>/dev/null
  kill -9 $CPID 2>/dev/null
  rm -rf $UDD
}
trap cleanup EXIT
# The watchdog redirects its fds: a background subshell inherits this script's stdout, and
# inside a pipeline it would hold the write end open long after the tests finished.
( sleep ${WD_TIMEOUT:-420}; cleanup ) </dev/null >/dev/null 2>&1 & WD=$!
disown

# A fresh --user-data-dir binds DevTools later than a warm profile: wait on the endpoint.
for i in $(seq 1 120); do
  curl -fsS -m 1 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fsS -m 2 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1 || {
  echo "devtools never bound on :$PORT" >&2; exit 3; }

export CDP_PORT=$PORT
export BASE_URL=$BASE
cd "$HERE"
node tools/playtest.cjs open "$BASE" | head -5

BOOT=""
for i in $(seq 1 120); do
  BOOT=$(node tools/playtest.cjs eval "(()=>{const a=window.masyu;return a&&a.game?a.version:'NOAPP:'+(a?a.state:'nomasyu')})()" nonav 2>&1 | tail -1 | tr -d '\n" ')
  case "$BOOT" in NOAPP*|nomasyu*|"ERROR"*) sleep 0.5 ;; "") sleep 0.5 ;; *) break ;; esac
done
echo "boot: masyu $BOOT at $BASE"
case "$BOOT" in NOAPP*|nomasyu*|ERROR*|"") echo "window.masyu.game never appeared at $BASE" >&2; exit 4 ;; esac

FAILED=0
# marks → resume 是一对，顺序不能换：前一场用真指针画叉并让页面存盘，后一场在**下一次真导航**
# 之后核对「叉还在、步数不是 0」。同一个 Chrome profile 里 localStorage 是留得住的，
# 所以「刷新」这一步不需要假的模拟。
# hint 放最后：它会赢一局，而赢会 clearResume——排在前面就会把 resume 那场的存档吃掉。
for s in ${SCENARIOS:-boot render play marks resume hint}; do
  echo "=== $s ==="
  node tools/playtest.cjs scenario "$s" 2>/tmp/masyu-$s.console.log | tail -1 | sed 's/^RESULT //' | python3 -c "
import sys, json
raw = sys.stdin.read().strip()
if not raw:
    print('  NO RESULT (see /tmp/masyu-$s.console.log)'); sys.exit(1)
try:
    d = json.loads(raw)
except Exception as e:
    print('  UNPARSED:', raw[:300]); sys.exit(1)
for r in d['rows']:
    if not r['pass']: print('  FAIL %-58s %s' % (r['test'], r['detail']))
extra = {k: v for k, v in d.items() if k not in ('rows', 'fail')}
if not d['rows']:
    print('  NO CHECKS RUN — a scenario that asserts nothing cannot be green'); sys.exit(1)
print('  %d checks, %d failed  %s' % (len(d['rows']), d['fail'], extra if extra else ''))
sys.exit(1 if d['fail'] else 0)
" || FAILED=1
  if [ -s /tmp/masyu-$s.console.log ]; then
    echo "  --- console ---"
    sed 's/^/  /' /tmp/masyu-$s.console.log | tail -12
  fi
done

if [ -n "${SHOTS:-}" ]; then
  mkdir -p tools/shots
  # board：半圈环（玩家打到一半、还没连上的样子）。win：整圈灌进引擎状态再走 checkWin——
  # 只有那条路会出胜利卡片，所以卡片里写的环长是 verify 给的，不是文案。
  # 整段包在 IIFE 里：Runtime.evaluate 顶层的 const 会留在这个 tab 的词法作用域里，
  # 第二次跑就变成「已经声明过」。
  node tools/playtest.cjs eval "(()=>{const a=window.masyu;return a.newGame({seed:'shot-board',sizeKey:'6x6'}).then(g=>{const o=a.engine.loopOrder(g.w,g.h,g.puzzle.solution);g.beginGesture();for(let i=1;i<Math.floor(o.length/2);i++)g.setEdge(o[i-1],a.view.dirFromTo(o[i-1],o[i]),1);g.endGesture();a.render();return 'ok'})})()" nonav >/dev/null 2>&1
  sleep 1
  node tools/playtest.cjs shot tools/shots/board-$SHOTS.png >/dev/null
  node tools/playtest.cjs eval "(()=>{const a=window.masyu;return a.newGame({seed:'shot-win',sizeKey:'6x6'}).then(g=>{const o=a.engine.loopOrder(g.w,g.h,g.puzzle.solution);g.beginGesture();for(let i=1;i<=o.length;i++){const x=o[i-1],y=o[i%o.length];g.setEdge(x,a.view.dirFromTo(x,y),1)}g.endGesture();a.checkWin();return 'ok'})})()" nonav >/dev/null 2>&1
  sleep 1.4
  node tools/playtest.cjs shot tools/shots/win-$SHOTS.png >/dev/null
  echo "shots: $(ls tools/shots/*-$SHOTS.png 2>/dev/null | tr '\n' ' ')"
fi

# ── Pages 前缀形状：GitHub Pages 把部署目录挂在 /<仓库名>/ 下面 ────────────────
# 站点根换成一个**只装 z-biz-game-masyu-cos 符号链接**的临时目录，于是相对路径必须一格不差，
# 而写死的 "/css/game.css" 会像在线上一样 404——本地替它兜底就等于门禁在给被测对象打补丁。
# 换根不换端口：还是那个 5276，所以本仓的端口对仍然只在三个地方各写一次。
if [ "$LOCAL" = 1 ]; then
  echo "=== pages-prefix ==="
  PROOT=$(mktemp -d)
  ln -s "$HERE" "$PROOT/z-biz-game-masyu-cos"
  PRE="http://127.0.0.1:$HTTP/z-biz-game-masyu-cos/"
  kill $SPID 2>/dev/null
  SPID=0
  node "$HERE/server.cjs" "$HTTP" "$PROOT" >/tmp/masyu-prefix-server.log 2>&1 &
  PSPID=$!
  disown
  for i in $(seq 1 40); do
    curl -fsS -m 1 "$PRE" >/dev/null 2>&1 && break
    sleep 0.25
  done
  PRESERVED=$(curl -fsS -m 3 "$PRE" 2>/dev/null || true)
  case "$PRESERVED" in *js/main.js*) ;; *) echo "  FAIL 前缀形状下拿不到本仓 index.html：$PRE（见 /tmp/masyu-prefix-server.log）" >&2; FAILED=1 ;; esac
  if [ -n "$PRESERVED" ]; then
    # open 而不是 eval：eval 默认会把 tab 导航回 BASE（根路径），那这一段就又在测一次根、
    # 前缀从来没被访问过——一个永远不会红的门禁。open 会先关掉本 origin 的旧 tab。
    node tools/playtest.cjs open "$PRE" >/dev/null 2>&1
    PREOUT=$(node tools/playtest.cjs eval "(async()=>{
      const a=window.masyu;
      if(!a||!a.game) return 'NOAPP at='+location.pathname;
      const m=await import(new URL('js/engine/pencil.js', document.baseURI).href).catch(()=>({verify:0}));
      const app=getComputedStyle(document.getElementById('app'));
      const cr=a.view.canvas.getBoundingClientRect();
      const cssOk=app.maxWidth!=='none'&&getComputedStyle(document.getElementById('board-wrap')).position==='relative';
      const g=await a.newGame({seed:'prefix-probe',sizeKey:'6x6'});
      return [
        'PREFIX-'+(g?'BOARDED':'NOBOARD'),
        'at='+(location.pathname==='/z-biz-game-masyu-cos/'?'PREFIXED':'NOT-PREFIXED'),
        'css='+(cssOk?'OK':'MISSING'),
        'canvas='+Math.round(cr.width)+'x'+Math.round(cr.height),
        'engine='+(m&&typeof m.verify==='function'?'OK':'FAIL'),
        'pearls='+(g?g.puzzle.pearlCount:'-'),
      ].join(' ');
    })()" nonav 2>&1 | tail -2 | tr '\n' ' ')
    echo "  $PREOUT"
    case "$PREOUT" in *PREFIX-BOARDED*at=PREFIXED*css=OK*engine=OK*) ;; *) echo "  FAIL pages-prefix 冒烟没过：前缀下的 css/动态 import/盘面有一样不对" >&2; FAILED=1 ;; esac
  fi
  rm -f "$PROOT/z-biz-game-masyu-cos"
  rmdir "$PROOT" 2>/dev/null
fi

kill $WD 2>/dev/null
[ $FAILED -eq 0 ] && echo "=== ALL GREEN ===" || echo "=== FAILURES ABOVE ==="
exit $FAILED
