// 劫灰 · 联机服务（零依赖，Node 内置 http + 长轮询）
//
// 为什么不用 WebSocket：手机房里两个人、回合制、每步一次请求，
// 长轮询足够，而且不用装任何东西 —— 双击 run.bat 就能开。
//
// 启动：  node server.js      或  run.bat
// 手机：  同一 WiFi 下打开终端打印的 http://192.168.x.x:7788
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Game, EMPTY, CHAMPIONS, ITEMS, itemOf, MODES } = require('./engine.js');

// 选人界面只给名字：技能说明一律不下发，玩家自己摸索（用户 m03244）。
const CHAMP_PICK = CHAMPIONS.map((c) => ({ id: c.id, name: c.name }));
// 模式按钮：名字 + 一句话，规则细节不下发（进游戏自己看规则面板）。
const MODE_PICK = MODES.map((m) => ({ id: m.id, name: m.name, rounds: m.rounds, coins: m.coins, desc: m.desc }));

// 本地用 JIEHUI_PORT（默认 7788）；Render 等云平台会注入 PORT，优先用它
const PORT = Number(process.env.PORT || process.env.JIEHUI_PORT || 7788);
const rooms = new Map();
const ALPHA = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

function rid() {
  let s = '';
  for (let i = 0; i < 4; i++) s += ALPHA[(Math.random() * ALPHA.length) | 0];
  return s;
}

function mkRoom() {
  let id;
  do { id = rid(); } while (rooms.has(id));
  const r = {
    id,
    seatOf: [null, null],
    // 进房间后的流程：先选模式（双方都选成一样才往下走），再选弈士。
    modePick: [null, null],
    champPick: [null, null],
    quick: false,          // 兼容旧字段，现在由 modePick 决定
    game: null,
    bids: [null, null],
    version: 1,
    listeners: [],
    rematch: [false, false]
  };
  rooms.set(id, r);
  return r;
}

// 双方选成同一个模式才算定下来，然后才允许选弈士。
function modeAgreed(r) {
  return r.modePick[0] != null && r.modePick[0] === r.modePick[1];
}

// 两人到齐、模式说定了、并且都选了弈士才开局
function startIfReady(r) {
  if (r.game) return;
  if (r.seatOf[0] == null || r.seatOf[1] == null) return;
  if (!modeAgreed(r)) return;
  if (!r.champPick[0] || !r.champPick[1]) return;
  r.game = new Game({ champs: r.champPick.slice(), mode: r.modePick[0] });
  r.bids = [null, null];
  r.rematch = [false, false];
}

function bump(r) {
  r.version++;
  const ls = r.listeners;
  r.listeners = [];
  for (let i = 0; i < ls.length; i++) { try { ls[i](); } catch (e) { /* 已断 */ } }
}

function seatFor(r, token) {
  if (!token) return -1;
  for (let i = 0; i < 2; i++) {
    if (r.seatOf[i] === token) return i;
  }
  for (let i = 0; i < 2; i++) {
    if (r.seatOf[i] === null) { r.seatOf[i] = token; return i; }
  }
  return -1;
}

// ── 每个玩家看到的局面（对手暗出的位置 / 暗出的价必须藏住）────────
function view(r, seat) {
  const opp = 1 - seat;
  const both = r.seatOf[0] != null && r.seatOf[1] != null;

  if (!r.game) {
    const agreed = modeAgreed(r);
    return {
      v: r.version, room: r.id, seat: seat, both: both,
      // 流程两步：先定模式（两人选成一样），再选弈士。按钮按阶段出现。
      step: agreed ? 'champ' : 'mode',
      need: !both ? null : (agreed ? (r.champPick[seat] ? null : 'champ') : 'mode'),
      picking: true,
      myPick: r.champPick[seat],
      oppPicked: !!r.champPick[opp],
      myMode: r.modePick[seat],
      oppMode: r.modePick[opp],
      modeAgreed: agreed,
      mode: agreed ? r.modePick[0] : null,
      modes: MODE_PICK,
      quick: r.modePick[0] === 'quick',
      champs: CHAMP_PICK,
      shop: ITEMS, items: [[], []], coins: [0, 0],
      over: false,
      rematch: r.rematch.slice()
    };
  }

  const g = r.game;
  let need = null;
  if (g.over) need = 'over';
  else if (!both) need = null;
  else if (g.phase === 'auction') need = r.bids[seat] == null ? 'bid' : null;
  else if (g.phase === 'tie-raise') need = g.tieRaise[seat] === null ? 'tie' : null;
  else if (g.phase === 'raise') need = g.auctionTurn === seat ? 'raise' : null;
  else if (g.phase === 'open-first') need = g.first === seat ? 'place' : null;
  else if (g.phase === 'open-second') need = (1 - g.first) === seat ? 'second' : null;
  else if (g.phase === 'hidden') need = (g.pending.hidden[seat] == null && !g.pending.passed[seat]) ? 'hidden' : null;

  const v = {
    v: r.version,
    room: r.id,
    seat: seat,
    both: both,
    picking: false,
    need: need,
    phase: g.phase,
    round: g.round,
    totalRounds: g.o.totalRounds,
    mode: g.o.mode,
    quick: g.o.mode === 'quick',
    roundMode: g.roundMode,
    cells: g.cells.slice(),
    coins: g.coins.slice(),
    qi: g.qi.slice(),
    qiCap: g.qiCap.slice(),
    // 盾：自己的随时看得见；**对手的只在明轮看得见**。
    // 暗轮里对手偷偷罩了一颗子，那是他那半边的信息 —— 等这一轮过去（进明轮）才亮出来。
    // 换句话说：对面只知道「你用了盾」（道具数会少一件），但不知道罩在哪。
    shields: [
      (seat === 0 || g.phase !== 'hidden') ? g.shieldOf(0) : [],
      (seat === 1 || g.phase !== 'hidden') ? g.shieldOf(1) : []
    ],
    shieldUsedThisHidden: g.shieldUsedThisHidden,
    lastIncome: g.lastIncome || null,            // 上一个明轮结算的币，给界面弹一下
    ashCount: g.ashCount,
    kills: g.killCount.slice(),      // 明轮「杀」的次数，各自记
    jies: g.jieTotal,                // 暗轮「劫」的总次数（无妄之灾，不算谁的）
    scores: [g.blobs(0)[0] || 0, g.blobs(1)[0] || 0],   // 实时计分：当前最大连通块
    jied: g.jieCount.slice(),
    first: g.first,
    lastCell: g.pending.openFirst,   // 本明轮先手刚落的那一子，前端给它一圈脉冲
    auctionWinner: g.auctionWinner,
    auctionHi: g.auctionHi,
    auctionHiBy: g.auctionHiBy,
    auctionTurn: g.auctionTurn,
    tieBid: g.tieBid,
    tieMine: g.tieRaise[seat],
    tieOppIn: g.tieRaise[opp] !== null,
    myBid: r.bids[seat],
    oppBidIn: r.bids[opp] != null,
    oppHiddenIn: g.pending.hidden[opp] != null,
    myPassedHidden: !!g.pending.passed[seat],
    over: g.over,
    winner: g.winner,
    endReason: g.endReason,
    blobs: [g.blobs(0), g.blobs(1)],
    champ: [g.champ[0], g.champ[1]],
    log: g.roundLog.slice(),
    fx: g.fx.slice(-8),
    modeFx: g.modeLog.slice(-4),     // 阶段切换：夺 / 明 / 暗，前端闪一下大字
    incomeFx: g.incomeFx.slice(-2),  // 明轮结算：哪些块发了多少币，前端在那些子上闪金币
    canGive: (g.phase === 'open-first' && g.first === seat && g.pending.openFirst == null && !g.gaveFirst) ? true : false,
    items: [g.items[0].slice(), g.items[1].slice()],
    // 商店：带上「已买几个 / 上限」，前端据此把按钮置灰
    shop: ITEMS.map((it) => Object.assign({}, it, {
      bought: it.id === 'dan' ? g.danBought[seat] : it.id === 'jing' ? g.jingBought[seat] : 0,
      left: it.limit ? Math.max(0, it.limit - (it.id === 'dan' ? g.danBought[seat] : it.id === 'jing' ? g.jingBought[seat] : 0)) : -1
    })),
    // 技能栏：只发「自己这个弈士」的技能，附带冷却与此刻能不能发动。
    // 对手的技能不发 —— 选人界面不写技能说明，让玩家自己摸索。
    skills: g.skillsOf(seat).map((sk, k) => ({
      id: sk.id, name: sk.name, cd: sk.cd, when: sk.when,
      qi: sk.id === 'huang' || sk.id === 'fu' ? 4 : (sk.qi || 0),
      // 气够不够 / 这一手时机到不到，是两件事：气够但现在不是时候 → 显示成灰的就绪，
      // 不能写「缺气」，那会让人误以为在攒气。
      enough: g.qi[seat] >= (sk.id === 'huang' || sk.id === 'fu' ? 4 : (sk.qi || 0)),
      wait: g.skillWait(seat, k),
      ready: g.canUseSkill(seat, k),
      used: (sk.id === 'ping' || sk.id === 'chui') ? g.onceUsed[seat].indexOf(sk.id) >= 0 : (sk.id === 'fu' ? g.fuUsed[seat] : false)
    })),
    arm: g.arm[seat] ? g.arm[seat].id : null,   // 已经预选但还没杀成的杀招（平/垂/荒 的 id）
    armEat: g.arm[seat] ? (g.arm[seat].eat || null) : null,   // 荒 吃掉的是哪一支
    myUsedOnce: g.onceUsed[seat].slice(),   // 自己用掉的平/垂（前端据此决定荒还能吃哪支）
    moveFx: g.moveFx.slice(-4),
    zone: g.zone,                    // 禁入点：{cells, p, kind, center}
    zoneFx: g.zoneFx.slice(-3),      // 金框特效流水
    fuFx: g.fuFx.slice(-3),          // 覆生效的碎裂流水
    myFu: g.fu[seat],                // 我覆押下的格（自己看得见，对手看不见）
    myFuMode: g.fuTarget[seat],      // 'guess' 盲猜 / 'kill' 直接盯上一颗子
    fuLeft: g.fuOwned[seat] && !g.fuUsed[seat] ? 1 : 0,
    // 对手的技能：名字和冷却属于公开信息（打牌看得见对面剩几张），
    // 但介绍不给 —— 想弄明白对面在干什么，得自己从对局里看出来。
    skillsOpp: g.skillsOf(1 - seat).map((sk, k) => ({
      id: sk.id, name: sk.name, wait: g.skillWait(1 - seat, k),
      used: (sk.id === 'ping' || sk.id === 'chui') ? g.onceUsed[1 - seat].indexOf(sk.id) >= 0 : (sk.id === 'fu' ? g.fuUsed[1 - seat] : false)
    })),
    rematch: r.rematch.slice()
  };

  // 暗轮：自己已经悄悄落下的那子，自己要看得到（对手看不到 —— 这正是 view 按人分的原因）。
  // 结算前它还没写进 cells，所以这里单独补一份给自己。
  if (g.phase === 'hidden' && g.pending.hidden[seat] != null) {
    const own = g.pending.hidden[seat];
    v.cells[own] = seat + 1;
    v.myHidden = own;
  }

  // 杀 = 落子覆盖：把「能覆盖的敌方老子」的格子告诉前端，让它们可点
  if (need === 'place' || need === 'second') {
    v.killTargets = g.killTargetsFor(seat);
  }
  // 禁入点：自己设的那几个格子前端要打金框
  v.forbidden = g.zoneOf(0).concat(g.zoneOf(1));
  v.forbiddenMine = g.zoneOf(seat);
  v.forbiddenOpp = g.zoneOf(1 - seat);
  if (need === 'second' && g.o.anchorRule) v.anchors = g.anchors(seat);
  return v;
}

// ── 动作 ────────────────────────────────────────────────────
function act(r, seat, a) {
  // 选模式（第一步）：双方各自选，选成一样才算定下来，之后才出现选弈士按钮
  if (a.type === 'mode') {
    if (r.game) return '已经开局，不能改模式了';
    if (!MODES.some((m) => m.id === a.id)) return '没有这个模式';
    r.modePick[seat] = a.id;
    startIfReady(r);
    bump(r);
    return null;
  }

  // 选弈士（第二步）
  if (a.type === 'champ') {
    if (r.game) return '已经开局';
    if (!modeAgreed(r)) return '先把模式说定';
    if (!CHAMPIONS.some((c) => c.id === a.id)) return '没有这个弈士';
    if (r.champPick[seat]) return '你已经选好了';
    r.champPick[seat] = a.id;
    startIfReady(r);
    bump(r);
    return null;
  }

  // 极简模式开关（兼容旧前端）：等价于在极简/标准之间切
  if (a.type === 'quick') {
    if (r.game) return '已经开局，不能改模式了';
    r.modePick[seat] = a.on ? 'quick' : 'standard';
    startIfReady(r);
    bump(r);
    return null;
  }

  const g = r.game;
  if (!g) return '还在选弈士';

  // 商店任何阶段都能买（只要没终局）
  if (a.type === 'buy') {
    if (g.over) return '对局已结束';
    const it = itemOf(a.id);
    if (!it) return '没有这件道具';
    if (g.coins[seat] < it.price) return '币不够';
    try { g.buy(seat, a.id); } catch (e) { return e.message; }
    bump(r);
    return null;
  }
  if (a.type === 'use') {
    if (g.over) return '对局已结束';
    try { g.useItem(seat, a.id, a.cell); } catch (e) {
      const m = e.message;
      if (m === '只能暗轮用') return '这件道具只能在暗轮用';
      if (m === 'not owned') return '你没有这件道具';
      return m;
    }
    bump(r);
    return null;
  }

  if (g.over) {
    if (a.type === 'rematch') {
      r.rematch[seat] = true;
      if (r.rematch[0] && r.rematch[1]) {
        // 回到最前面：先重新定模式，再选弈士（模式可能想换个新的）
        r.game = null;
        r.bids = [null, null];
        r.modePick = [null, null];
        r.champPick = [null, null];
        r.rematch = [false, false];
      }
      bump(r);
      return null;
    }
    return '对局已结束';
  }
  const both = r.seatOf[0] != null && r.seatOf[1] != null;
  if (!both) return '等待对手加入';

  // 认输：任何时候都能点，直接判负。
  if (a.type === 'resign') {
    try { g.resign(seat); } catch (e) { return e.message; }
    bump(r);
    return null;
  }

  if (a.type === 'bid') {
    if (g.phase !== 'auction') return '现在不是出价阶段';
    if (r.bids[seat] != null) return '你已经出过价了';
    const amt = Math.max(0, Math.min(g.qi[seat], a.amount | 0));
    r.bids[seat] = amt;
    if (r.bids[0] != null && r.bids[1] != null) {
      const b = r.bids.slice();
      r.bids = [null, null];
      g.resolveBid(b);
    }
  } else if (a.type === 'tie') {
    if (g.phase !== 'tie-raise') return '现在不是加价阶段';
    if (g.tieRaise[seat] !== null) return '你已经选过了';
    try { g.submitTieRaise(seat, a.amount == null ? null : a.amount | 0); }
    catch (e) {
      if (e.message === 'must exceed') return '加价必须高于 ' + g.tieBid + ' 气';
      return e.message;
    }
  } else if (a.type === 'raise') {
    if (g.phase !== 'raise') return '现在不是加价阶段';
    if (g.auctionTurn !== seat) return '还不到你';
    try { g.raiseOrPass(seat, a.amount == null ? null : a.amount | 0); }
    catch (e) {
      if (e.message === 'must exceed') return '加价必须高于 ' + g.auctionHi + ' 气';
      return e.message;
    }
  } else if (a.type === 'order') {
    // v12：不再有独立的「选先后手」阶段 —— 赢家默认先手。
    // 想把先动让给对手，用 give。这里保留兼容：choice==='second' 等价于 give。
    if (a.choice === 'second') {
      try { g.giveFirst(seat); } catch (e) { return e.message; }
    } else if (g.phase !== 'open-first' || g.first !== seat) {
      return '现在不是你走';
    }
  } else if (a.type === 'give') {
    try { g.giveFirst(seat); } catch (e) {
      const m = e.message;
      if (m === 'not your turn') return '只有先手能让';
      if (m === 'already placed') return '已经落子了';
      if (m === '已经让过了') return '这一轮已经让过了';
      return m;
    }
  } else if (a.type === 'pass') {
    try {
      if (g.phase === 'hidden') g.passHidden(seat);
      else g.passTurn(seat);
    } catch (e) { return e.message; }
  } else if (a.type === 'skill') {
    const k = a.k | 0;
    const sk = g.skillsOf(seat)[k];
    if (!sk) return '没有这个技能';
    try {
      g.useSkill(seat, k, {
        from: a.from == null ? null : (a.from | 0),
        to: a.to == null ? null : (a.to | 0),
        cell: a.cell == null ? null : (a.cell | 0),
        eat: a.eat || null
      });
    } catch (e) {
      const m = e.message;
      if (m === '现在不能发动') {
        const w = g.skillWait(seat, k);
        return w > 0 ? ('还要等 ' + w + ' 轮') : '现在不能发动这个技能';
      }
      if (m === '要选一格劫灰和一个空位') return '先点一格劫灰，再点一个空位';
      if (m === '那不是劫灰') return '那不是劫灰';
      if (m === '要挪到空格上') return '只能挪到空着的位置';
      if (m === '要选一格') return '点一个空格，猜对面会落哪';
      if (m === '只能点空格') return '只能点一个空格';
      if (m === '荒要先选吃掉平还是垂') return '荒要先选吃掉平还是垂';
      if (m === '那一支已经用掉了') return '那一支已经用掉了';
      return m;
    }
  } else if (a.type === 'jie') {
    // v8：劫不再是独立动作，改成「落子覆盖」。这里保留兼容，转成 place。
    return act(r, seat, { type: 'place', cell: a.cell });
  } else if (a.type === 'place') {
    const cell = a.cell | 0;
    if (cell < 0 || cell >= g.cells.length) return '格子无效';
    if (g.phase === 'open-first') {
      if (g.first !== seat) return '现在不是你先手';
      const isKill = g.isKillTarget(cell, seat);
      if (!isKill && g.cells[cell] !== EMPTY) return '这格已经有子了';
      g.openPlaceFirst(cell);
    } else if (g.phase === 'open-second') {
      if ((1 - g.first) !== seat) return '现在不是你的回合';
      const isKill = g.isKillTarget(cell, seat);
      if (!isKill) {
        if (g.cells[cell] !== EMPTY) return '这格已经有子了';
        if (g.o.anchorRule) {
          const an = g.anchors();
          if (an.length > 0 && an.indexOf(cell) === -1) return '必须贴着落子（或者去盖掉对方无保护的子）';
        }
      }
      g.openSecond({ type: 'place', cell: cell });
    } else if (g.phase === 'hidden') {
      if (g.pending.hidden[seat] != null) return '你已落子';
      if (g.pending.passed[seat]) return '这一轮你已经过了';
      if (g.cells[cell] !== EMPTY) return '这格已经有子了';
      g.hiddenSubmit(seat, cell);
    } else {
      return '现在不能落子';
    }
  } else {
    return '未知动作';
  }
  bump(r);
  return null;
}

// ── HTTP ────────────────────────────────────────────────────
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function body(req, cb) {
  let d = '';
  req.on('data', (c) => { d += c; if (d.length > 1e6) req.destroy(); });
  req.on('end', () => {
    try { cb(null, d ? JSON.parse(d) : {}); } catch (e) { cb(e); }
  });
}

const INDEX = path.join(__dirname, 'index.html');

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;

  if (p === '/' || p === '/index.html') {
    fs.readFile(INDEX, (e, buf) => {
      if (e) { res.writeHead(500); res.end('index.html 缺失'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(buf);
    });
    return;
  }

  if (p === '/api/join' && req.method === 'POST') {
    body(req, (e, d) => {
      if (e) return json(res, 400, { error: 'bad json' });
      const token = String(d.token || '');
      const want = String(d.room || '').toUpperCase();
      let r = want ? rooms.get(want) : null;
      let created = false;
      if (!r) {
        if (want) return json(res, 404, { error: '房间不存在：' + want });
        r = mkRoom();
        created = true;
      }
      const seat = seatFor(r, token);
      if (seat < 0) return json(res, 409, { error: '房间已满' });
      startIfReady(r);
      bump(r);
      json(res, 200, { room: r.id, seat, created, view: view(r, seat) });
    });
    return;
  }

  if (p === '/api/state' && req.method === 'GET') {
    const r = rooms.get(String(u.searchParams.get('room') || '').toUpperCase());
    const token = u.searchParams.get('token') || '';
    if (!r) return json(res, 404, { error: '房间不存在' });
    const seat = seatFor(r, token);
    if (seat < 0) return json(res, 409, { error: '房间已满或无权' });
    const since = Number(u.searchParams.get('v') || 0);
    let done = false, timer = null;
    const reply = () => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      json(res, 200, view(r, seat));
    };
    if (r.version > since) return reply();
    timer = setTimeout(reply, 20000);
    r.listeners.push(reply);
    req.on('close', () => { done = true; if (timer) clearTimeout(timer); });
    return;
  }

  if (p === '/api/act' && req.method === 'POST') {
    body(req, (e, d) => {
      if (e) return json(res, 400, { error: 'bad json' });
      const r = rooms.get(String(d.room || '').toUpperCase());
      if (!r) return json(res, 404, { error: '房间不存在' });
      const seat = seatFor(r, String(d.token || ''));
      if (seat < 0) return json(res, 409, { error: '座位无效' });
      const err = act(r, seat, d.action || {});
      if (err) return json(res, 400, { error: err, view: view(r, seat) });
      json(res, 200, { ok: true, view: view(r, seat) });
    });
    return;
  }

  res.writeHead(404); res.end('not found');
});

function lanIPs() {
  const out = [];
  const nis = os.networkInterfaces();
  for (const k of Object.keys(nis)) {
    for (const a of nis[k] || []) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
  }
  return out;
}

server.listen(PORT, '0.0.0.0', () => {
  const ips = lanIPs();
  console.log('');
  console.log('  劫灰 · 已开桌');
  console.log('  ─────────────────────────────────');
  console.log('  本机      http://localhost:' + PORT);
  for (const ip of ips) console.log('  手机      http://' + ip + ':' + PORT);
  console.log('  ─────────────────────────────────');
  console.log('  同一 WiFi 下手机打开上面「手机」那行。');
  console.log('  第一个打开的人自动建房，把地址发给朋友即可。');
  console.log('');
});

module.exports = { server, rooms, view, act, mkRoom };
