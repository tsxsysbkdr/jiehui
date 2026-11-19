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
const { Game, EMPTY, CHAMPIONS, ITEMS, itemOf } = require('./engine.js');

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
    champPick: [null, null],
    game: null,
    bids: [null, null],
    version: 1,
    listeners: [],
    rematch: [false, false]
  };
  rooms.set(id, r);
  return r;
}

// 两人到齐、并且都选了弈士才开局（选人界面留着，只是现在只有一个能选）
function startIfReady(r) {
  if (r.game) return;
  if (r.seatOf[0] == null || r.seatOf[1] == null) return;
  if (!r.champPick[0] || !r.champPick[1]) return;
  r.game = new Game({ champs: r.champPick.slice() });
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
    return {
      v: r.version, room: r.id, seat: seat, both: both,
      need: both ? (r.champPick[seat] ? null : 'champ') : null,
      picking: true,
      myPick: r.champPick[seat],
      oppPicked: !!r.champPick[opp],
      champs: CHAMPIONS,
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
  else if (g.phase === 'order') need = g.auctionWinner === seat ? 'order' : null;
  else if (g.phase === 'open-first') need = g.first === seat ? 'place' : null;
  else if (g.phase === 'open-second') need = (1 - g.first) === seat ? 'second' : null;
  else if (g.phase === 'hidden') need = g.pending.hidden[seat] == null ? 'hidden' : null;

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
    roundMode: g.roundMode,
    cells: g.cells.slice(),
    coins: g.coins.slice(),
    ashCount: g.ashCount,
    jied: g.jieCount.slice(),
    first: g.first,
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
    over: g.over,
    winner: g.winner,
    endReason: g.endReason,
    blobs: [g.blobs(0), g.blobs(1)],
    champ: [g.champ[0], g.champ[1]],
    log: g.roundLog.slice(),
    items: [g.items[0].slice(), g.items[1].slice()],
    shop: ITEMS,
    rematch: r.rematch.slice()
  };

  // 劫 = 落子覆盖：把「能覆盖的敌方老子」的格子告诉前端，让它们可点
  if (need === 'place' || need === 'second') {
    v.jieTargets = g.jieTargetsFor(seat);
  }
  if (need === 'second') v.anchors = g.anchors();
  return v;
}

// ── 动作 ────────────────────────────────────────────────────
function act(r, seat, a) {
  // 选弈士（v8 只有一个「无锋」，但流程留着）
  if (a.type === 'champ') {
    if (r.game) return '已经开局';
    if (!CHAMPIONS.some((c) => c.id === a.id)) return '没有这个弈士';
    if (r.champPick[seat]) return '你已经选好了';
    r.champPick[seat] = a.id;
    startIfReady(r);
    bump(r);
    return null;
  }

  if (!r.game) return '还在选弈士';
  const g = r.game;

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
    try { g.useItem(seat, a.id); } catch (e) {
      return e.message === '只能暗轮用' ? '这件道具只能在暗轮用' : '你没有这件道具';
    }
    bump(r);
    return null;
  }

  if (g.over) {
    if (a.type === 'rematch') {
      r.rematch[seat] = true;
      if (r.rematch[0] && r.rematch[1]) {
        // 回到选人界面（v8 只有一个「无锋」，但流程保留）
        r.game = null;
        r.bids = [null, null];
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

  if (a.type === 'bid') {
    if (g.phase !== 'auction') return '现在不是出价阶段';
    if (r.bids[seat] != null) return '你已经出过价了';
    const amt = Math.max(0, Math.min(g.coins[seat], a.amount | 0));
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
      if (e.message === 'must exceed') return '加价必须高于 ' + g.tieBid + ' 币';
      return e.message;
    }
  } else if (a.type === 'raise') {
    if (g.phase !== 'raise') return '现在不是加价阶段';
    if (g.auctionTurn !== seat) return '还不到你';
    try { g.raiseOrPass(seat, a.amount == null ? null : a.amount | 0); }
    catch (e) {
      if (e.message === 'must exceed') return '加价必须高于 ' + g.auctionHi + ' 币';
      return e.message;
    }
  } else if (a.type === 'order') {
    if (g.phase !== 'order') return '现在不是选序阶段';
    if (g.auctionWinner !== seat) return '只有赢下竞拍的人能选';
    g.applyOrder(a.choice === 'first' ? 'first' : 'second');
  } else if (a.type === 'jie') {
    // v8：劫不再是独立动作，改成「落子覆盖」。这里保留兼容，转成 place。
    return act(r, seat, { type: 'place', cell: a.cell });
  } else if (a.type === 'place') {
    const cell = a.cell | 0;
    if (cell < 0 || cell >= g.cells.length) return '格子无效';
    if (g.phase === 'open-first') {
      if (g.first !== seat) return '现在不是你先手';
      const isJie = g.isJieTarget(cell, seat);
      if (!isJie && g.cells[cell] !== EMPTY) return '这格已经有子了';
      g.openPlaceFirst(cell);
    } else if (g.phase === 'open-second') {
      if ((1 - g.first) !== seat) return '现在不是你的回合';
      const isJie = g.isJieTarget(cell, seat);
      if (!isJie) {
        if (g.cells[cell] !== EMPTY) return '这格已经有子了';
        const an = g.anchors();
        if (an.length > 0 && an.indexOf(cell) === -1) return '必须贴着落子（或者去盖掉对方无保护的子）';
      }
      g.openSecond({ type: 'place', cell: cell });
    } else if (g.phase === 'hidden') {
      if (g.pending.hidden[seat] != null) return '你已落子';
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
