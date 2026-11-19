// 劫灰 · 规则引擎 v8（浏览器 / Node 通用）
// v8 变更（用户 m01004 / m01012 的反馈）：
//   1. **暗轮固定存在，不再靠竞拍决定**：明轮打完必进暗轮，暗轮打完必回竞拍。
//      没有奇偶排期，只有这两种转移。竞拍同价且都不加价 → 本轮跳过明轮直接打暗轮，
//      暗轮打完照样回竞拍。
//   2. **劫 = 落子覆盖**：明轮落子时，落点若是敌方**不受保护**的子（不是本明轮先手
//      当轮刚下的那颗），就把那颗子杀掉、该格成劫灰 —— 死的就是这一格，自己不放子。
//      不再有单独的「劫」按钮和次数限制。
//   3. 劫灰改暗红色（界面）。
//   4. 选人界面保留，只是目前只有一个「无锋」。
//   5. 商店：随时可买，暗轮才能用。
// 计分不变：连通块序列字典序。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Jiehui = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var EMPTY = 0, BLACK = 1, WHITE = 2, ASH = 3;

  var DEFAULTS = {
    size: 9,
    totalRounds: 20,
    startCoins: 6,
    coinPerRound: 1,
    // 明轮后手「必须贴着一手落」的限制。v9 起默认关掉：想落哪就落哪。
    // 引擎里 anchors() 整套还在，以后做成弈士技能时把这里打开即可。
    anchorRule: false,
    anchorSelf: true,
    champs: ['wufeng', 'wufeng']
  };

  // 选人留着，只是现在只有一个能选。以后加人：平衡靠起手币，不改数值。
  var CHAMPIONS = [
    { id: 'wufeng', name: '无锋', tag: '空白', coins: 6, desc: '没有任何技能。纯靠手上的子说话。' }
  ];
  var CHAMP_BY_ID = {};
  for (var _ci = 0; _ci < CHAMPIONS.length; _ci++) CHAMP_BY_ID[CHAMPIONS[_ci].id] = CHAMPIONS[_ci];
  function champOf(id) { return CHAMP_BY_ID[id] || CHAMP_BY_ID.wufeng; }

  // 商店。when：'any' 随时 / 'hidden' 仅暗轮。
  var ITEMS = [
    { id: 'shell', name: '空壳', price: 1, when: 'hidden', desc: '什么用也没有。买来就是为了把线路跑通。' }
  ];
  var ITEM_BY_ID = {};
  for (var _ii = 0; _ii < ITEMS.length; _ii++) ITEM_BY_ID[ITEMS[_ii].id] = ITEMS[_ii];
  function itemOf(id) { return ITEM_BY_ID[id] || null; }

  var NB_CACHE = {};
  function nbrs(size, i, r) {
    r = r || 1;
    var k = size + ':' + i + ':' + r;
    if (NB_CACHE[k]) return NB_CACHE[k];
    var x = i % size, y = (i / size) | 0, out = [];
    for (var dy = -r; dy <= r; dy++) {
      for (var dx = -r; dx <= r; dx++) {
        if (!dx && !dy) continue;
        var nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
        out.push(ny * size + nx);
      }
    }
    return (NB_CACHE[k] = out);
  }

  function blobsSizes(cells, size, p) {
    var n = size * size, want = p + 1;
    var vis = new Uint8Array(n), stack = new Int32Array(n), out = [];
    for (var i = 0; i < n; i++) {
      if (cells[i] !== want || vis[i]) continue;
      var sp = 0; stack[sp++] = i; vis[i] = 1;
      var sz = 0;
      while (sp) {
        var c = stack[--sp]; sz++;
        var nb = nbrs(size, c);
        for (var k = 0; k < nb.length; k++) {
          var j = nb[k];
          if (!vis[j] && cells[j] === want) { vis[j] = 1; stack[sp++] = j; }
        }
      }
      out.push(sz);
    }
    out.sort(function (a, b) { return b - a; });
    return out;
  }

  function compareBlobs(a, b) {
    var n = Math.max(a.length, b.length);
    for (var i = 0; i < n; i++) {
      var x = a[i] || 0, y = b[i] || 0;
      if (x !== y) return x - y;
    }
    return 0;
  }

  function Game(opts) {
    this.o = Object.assign({}, DEFAULTS, opts || {});
    this.size = this.o.size;
    var n = this.size * this.size;
    this.cells = new Array(n).fill(EMPTY);
    this.placedAt = new Array(n).fill(0);
    this.coins = new Array(2);
    this.champ = [champOf(this.o.champs[0]), champOf(this.o.champs[1])];
    this.coins[0] = this.champ[0].coins;
    this.coins[1] = this.champ[1].coins;
    this.round = 1;
    this.roundMode = 'pending';   // 'pending'（竞拍中，结果未定）| 'open' | 'hidden'
    this.ashCount = 0;
    this.killCount = [0, 0];   // 明轮：落子盖掉对手一子 = 「杀」
    this.jieCount = [0, 0];    // 兼容旧字段，v9 起不再自增
    this.jieTotal = 0;         // 暗轮两人撞在同一格 = 「劫」（无妄之灾，不算谁的）
    this.bidLoss = [0, 0];
    this.over = false;
    this.winner = null;
    this.endReason = null;
    this.roundLog = [];
    this.history = [];
    this.auctionWinner = null;
    this.auctionHi = 0;
    this.auctionHiBy = null;
    this.auctionTurn = null;
    this.tieBid = null;
    this.tieRaise = [null, null];
    this.first = null;
    this.pending = { openFirst: null, hidden: [null, null] };
    this.items = [[], []];
    this.fxSeq = 0;
    this.fx = [];              // 成灰事件流水，给前端放「杀／劫」特效（只增不清）
    this.phase = 'auction';
  }

  Game.prototype = {
    constructor: Game,

    isOpenRound: function () { return this.roundMode === 'open'; },
    at: function (x, y) {
      if (x < 0 || y < 0 || x >= this.size || y >= this.size) return -1;
      return this.cells[y * this.size + x];
    },
    counts: function () {
      var c = [0, 0];
      for (var i = 0; i < this.cells.length; i++) {
        if (this.cells[i] === BLACK) c[0]++;
        else if (this.cells[i] === WHITE) c[1]++;
      }
      return c;
    },
    blobs: function (p) { return blobsSizes(this.cells, this.size, p); },
    score: function (p) { var b = this.blobs(p); return b.length ? b[0] : 0; },
    emptyCells: function () {
      var r = [];
      for (var i = 0; i < this.cells.length; i++) if (this.cells[i] === EMPTY) r.push(i);
      return r;
    },

    // ── 竞拍：暗出首价 ────────────────────────────────────
    resolveBid: function (bids) {
      if (this.phase !== 'auction') throw new Error('phase:' + this.phase);
      var b = [
        Math.max(0, Math.min(this.coins[0], bids[0] | 0)),
        Math.max(0, Math.min(this.coins[1], bids[1] | 0))
      ];
      if (b[0] === b[1]) {
        this.tieBid = b[0];
        this.tieRaise = [null, null];
        this.roundLog.push({ t: 'bid-tie', bids: b });
        this.phase = 'tie-raise';
        return { tie: true, hi: b[0], bids: b };
      }
      var w = b[0] > b[1] ? 0 : 1;
      this.auctionHi = b[w];
      this.auctionHiBy = w;
      this.auctionTurn = 1 - w;
      this.roundLog.push({ t: 'bid', bids: b, hi: b[w], by: w });
      this.phase = 'raise';
      return { tie: false, hi: b[w], by: w, turn: 1 - w, bids: b };
    },

    // 同价后双方各暗选一次：amount = null 表示不加价。
    submitTieRaise: function (p, amount) {
      if (this.phase !== 'tie-raise') throw new Error('phase:' + this.phase);
      if (this.tieRaise[p] !== null) throw new Error('already');
      var amt = 0;
      if (amount != null) {
        amt = Math.max(0, Math.min(this.coins[p], amount | 0));
        if (amt <= this.tieBid) throw new Error('must exceed');
      }
      this.tieRaise[p] = amt;
      if (this.tieRaise[0] === null || this.tieRaise[1] === null) return null;

      var a = this.tieRaise[0], b2 = this.tieRaise[1];
      this.tieRaise = [null, null];
      var ra = a > 0, rb = b2 > 0;
      if (!ra && !rb) {
        // 都不加价 → 本轮跳过明轮，直接打暗轮
        this.roundLog.push({ t: 'auction-none' });
        return this._toHidden();
      }
      if (ra && !rb) return this._auctionDone(0, a);
      if (!ra && rb) return this._auctionDone(1, b2);
      if (a === b2) {
        this.tieBid = a;
        this.roundLog.push({ t: 'bid-tie', bids: [a, b2] });
        return { again: true, hi: a };
      }
      var w = a > b2 ? 0 : 1;
      this.auctionHi = w === 0 ? a : b2;
      this.auctionHiBy = w;
      this.auctionTurn = 1 - w;
      this.roundLog.push({ t: 'bid', bids: [a, b2], hi: this.auctionHi, by: w });
      this.phase = 'raise';
      return { toRaise: true, hi: this.auctionHi, by: w, turn: this.auctionTurn };
    },

    // 轮流加价：amount = null 表示放弃。
    raiseOrPass: function (p, amount) {
      if (this.phase !== 'raise') throw new Error('phase:' + this.phase);
      if (this.auctionTurn !== p) throw new Error('not your turn');
      if (amount == null) {
        this.roundLog.push({ t: 'pass', p: p });
        return this._auctionDone(this.auctionHiBy, this.auctionHi);
      }
      var amt = Math.max(0, Math.min(this.coins[p], amount | 0));
      if (amt <= this.auctionHi) throw new Error('must exceed');
      this.auctionHi = amt;
      this.auctionHiBy = p;
      this.auctionTurn = 1 - p;
      this.roundLog.push({ t: 'raise', p: p, amount: amt });
      return { raise: true, hi: amt, by: p, turn: this.auctionTurn };
    },

    _auctionDone: function (w, price) {
      this.roundMode = 'open';
      this.auctionWinner = w;
      this.auctionHi = price;
      this.auctionHiBy = w;
      this.auctionTurn = null;
      this.coins[w] -= price;
      this.coins[1 - w] += price;
      this.bidLoss[1 - w] += 1;
      this.roundLog.push({ t: 'won', p: w, price: price });
      this.phase = 'order';
      return { won: w, price: price };
    },

    // 没人抢下先手：本轮直接打暗轮（不是取消暗轮 —— 暗轮打完照样回竞拍）
    _toHidden: function () {
      this.roundMode = 'hidden';
      this.auctionWinner = null;
      this.first = null;
      this.phase = 'hidden';
      return { hidden: true };
    },

    applyOrder: function (choice) {
      if (this.phase !== 'order') throw new Error('phase:' + this.phase);
      var w = this.auctionWinner;
      this.first = choice === 'first' ? w : 1 - w;
      this.roundLog.push({ t: 'order', first: this.first });
      this.phase = 'open-first';
      return this.first;
    },

    // ── 劫：落子覆盖敌方不受保护的子，那格成灰 ──────────────
    // 受保护 = 本明轮先手当轮刚下的那颗（placedAt === round）。
    isKillTarget: function (cell, byP) {
      var owner = 1 - byP;
      return this.cells[cell] === owner + 1 &&
        this.placedAt[cell] > 0 &&
        this.placedAt[cell] < this.round;
    },
    // 当前玩家所有可劫的格子（就是可以覆盖的敌方老子的格）
    killTargetsFor: function (p) {
      var out = [];
      for (var i = 0; i < this.cells.length; i++) if (this.isKillTarget(i, p)) out.push(i);
      return out;
    },

    // kind: 'kill'（明轮落子盖杀敌子）| 'jie'（暗轮两人撞在同一格，无妄之灾）
    _makeAsh: function (cell, kind) {
      this.cells[cell] = ASH;
      this.placedAt[cell] = 0;
      this.ashCount++;
      // 特效流水：前端只看 fx 里比自己见过的序号更新的事件
      this.fxSeq++;
      this.fx.push({ id: this.fxSeq, cell: cell, kind: kind || 'jie' });
    },

    // ── 落子 ──────────────────────────────────────────────
    // 先手：任意空格，或者任意可杀的敌方子所在格（后者成灰）
    openPlaceFirst: function (cell) {
      if (this.phase !== 'open-first') throw new Error('phase:' + this.phase);
      var p = this.first;
      if (this.isKillTarget(cell, p)) {
        this._makeAsh(cell, 'kill');
        this.killCount[p]++;
        this.roundLog.push({ t: 'kill', p: p, cell: cell, victim: 1 - p });
        // 这一手没落子（把对方的子烧了），所以没有「这一手」可以贴 ——
        // 后手因此不受贴点约束，anchors() 返回空数组即视作自由落子。
        this.pending.openFirst = null;
        this.phase = 'open-second';
        return cell;
      }
      if (this.cells[cell] !== EMPTY) throw new Error('occupied');
      this.cells[cell] = p + 1;
      this.placedAt[cell] = this.round;
      this.pending.openFirst = cell;
      this.roundLog.push({ t: 'place', p: p, cell: cell, mode: 'open' });
      this.phase = 'open-second';
      return cell;
    },

    // 明轮后手合法落点：贴对手这一手 ∪ 贴自己的子；再加上所有可杀的敌子格
    // anchorRule 关掉时返回全部空格（想落哪就落哪）。
    anchors: function () {
      if (!this.o.anchorRule) {
        var all = [];
        for (var i = 0; i < this.cells.length; i++) if (this.cells[i] === EMPTY) all.push(i);
        return all;
      }
      var f = this.pending.openFirst;
      if (f == null) return [];
      var s = this.size, fx = f % s, fy = (f / s) | 0;
      var seen = {}, out = [];
      for (var y = 0; y < s; y++) {
        for (var x = 0; x < s; x++) {
          var i = y * s + x;
          if (this.cells[i] !== EMPTY) continue;
          var ok = (x === fx || y === fy || (Math.abs(x - fx) <= 1 && Math.abs(y - fy) <= 1));
          if (ok && !seen[i]) { seen[i] = 1; out.push(i); }
        }
      }
      if (this.o.anchorSelf) {
        var p = 1 - this.first;
        for (var j = 0; j < this.cells.length; j++) {
          if (this.cells[j] !== p + 1) continue;
          var nb = nbrs(s, j, 1);
          for (var k = 0; k < nb.length; k++) {
            var q = nb[k];
            if (this.cells[q] === EMPTY && !seen[q]) { seen[q] = 1; out.push(q); }
          }
        }
      }
      return out;
    },

    // 后手能点的所有格子：贴点里的空格 + 可杀的敌子格（杀不受贴约束）
    secondOptions: function () {
      var p = 1 - this.first;
      var a = this.anchors(), j = this.killTargetsFor(p);
      return a.concat(j);
    },

    openSecond: function (action) {
      if (this.phase !== 'open-second') throw new Error('phase:' + this.phase);
      var p = 1 - this.first;
      var cell = action.cell;
      if (this.isKillTarget(cell, p)) {
        this._makeAsh(cell, 'kill');
        this.killCount[p]++;
        this.roundLog.push({ t: 'kill', p: p, cell: cell, victim: this.first });
        return this._endRound();
      }
      var anchors = this.anchors();
      var free = anchors.length === 0;
      if (!free && anchors.indexOf(cell) === -1) throw new Error('must anchor');
      if (this.cells[cell] !== EMPTY) throw new Error('occupied');
      this.cells[cell] = p + 1;
      this.placedAt[cell] = this.round;
      this.roundLog.push({ t: 'place', p: p, cell: cell, mode: 'open', free: free });
      return this._endRound();
    },

    // ── 暗轮 ──────────────────────────────────────────────
    hiddenSubmit: function (p, cell) {
      if (this.phase !== 'hidden') throw new Error('phase:' + this.phase);
      if (this.cells[cell] !== EMPTY) throw new Error('occupied');
      if (this.pending.hidden[p] != null) throw new Error('already submitted');
      this.pending.hidden[p] = cell;
      if (this.pending.hidden[0] == null || this.pending.hidden[1] == null) return null;
      var a = this.pending.hidden[0], b = this.pending.hidden[1];
      if (a === b) {
        // 暗轮两人撞在同一格 = 「劫」，无妄之灾，两边都没得着，所以不记给谁
        this._makeAsh(a, 'jie');
        this.jieTotal++;
        this.roundLog.push({ t: 'jie', cell: a });
      } else {
        this.cells[a] = BLACK;
        this.placedAt[a] = this.round;
        this.cells[b] = WHITE;
        this.placedAt[b] = this.round;
        this.roundLog.push({ t: 'place', p: 0, cell: a, mode: 'hidden' });
        this.roundLog.push({ t: 'place', p: 1, cell: b, mode: 'hidden' });
      }
      this.pending.hidden = [null, null];
      return this._endRound();
    },

    // ── 商店（随时可买）────────────────────────────────────
    buy: function (p, id) {
      if (this.over) throw new Error('game over');
      var it = itemOf(id);
      if (!it) throw new Error('no such item');
      if (this.coins[p] < it.price) throw new Error('not enough coins');
      this.coins[p] -= it.price;
      this.items[p].push(id);
      this.roundLog.push({ t: 'buy', p: p, item: id, price: it.price });
      return this.items[p].length;
    },

    useItem: function (p, id) {
      if (this.over) throw new Error('game over');
      var it = itemOf(id);
      if (!it) throw new Error('no such item');
      var k = this.items[p].indexOf(id);
      if (k < 0) throw new Error('not owned');
      if (it.when === 'hidden' && this.phase !== 'hidden') throw new Error('只能暗轮用');
      this.items[p].splice(k, 1);
      this.roundLog.push({ t: 'use', p: p, item: id });
      return null;
    },

    itemCount: function (p, id) {
      var n = 0;
      for (var i = 0; i < this.items[p].length; i++) if (this.items[p][i] === id) n++;
      return n;
    },

    // ── 轮次转移 ──────────────────────────────────────────
    // 唯一的循环：明轮打完 → 必进暗轮；暗轮打完 → 必回竞拍。
    // 竞拍没人抢先手 → 本轮直接是暗轮，打完照样回竞拍。没有奇偶、没有漂移。
    _endRound: function () {
      var wasOpen = this.roundMode === 'open';
      this.history.push(this.roundLog.slice());
      if (this.round >= this.o.totalRounds) { this._finish('rounds'); return this.summary(); }
      this.round++;
      this.roundLog = [];
      this.pending = { openFirst: null, hidden: [null, null] };
      this.first = null;
      this.auctionWinner = null;
      this.auctionHi = 0;
      this.auctionHiBy = null;
      this.auctionTurn = null;
      this.tieBid = null;
      this.tieRaise = [null, null];
      this.coins[0] += this.o.coinPerRound;
      this.coins[1] += this.o.coinPerRound;
      if (wasOpen) {
        this.roundMode = 'hidden';
        this.phase = 'hidden';
      } else {
        this.roundMode = 'pending';
        this.phase = 'auction';
      }
      return null;
    },

    _finish: function (reason) {
      this.over = true;
      this.endReason = reason;
      this.finalBlobs = [this.blobs(0), this.blobs(1)];
      this.finalScore = [this.finalBlobs[0][0] || 0, this.finalBlobs[1][0] || 0];
      this.winner = compareBlobs(this.finalBlobs[0], this.finalBlobs[1]) > 0 ? 0
        : compareBlobs(this.finalBlobs[1], this.finalBlobs[0]) > 0 ? 1 : -1;
      this.phase = 'over';
    },

    summary: function () {
      return {
        over: this.over, reason: this.endReason, winner: this.winner,
        score: this.finalScore || [this.score(0), this.score(1)],
        blobs: this.finalBlobs || [this.blobs(0), this.blobs(1)],
        ash: this.ashCount, rounds: this.round, coins: this.coins.slice(),
        kill: this.killCount.slice(),
        jie: this.jieCount.slice(),
        items: [this.items[0].slice(), this.items[1].slice()],
        champ: [this.champ[0].id, this.champ[1].id]
      };
    }
  };

  return {
    Game: Game,
    EMPTY: EMPTY, BLACK: BLACK, WHITE: WHITE, ASH: ASH,
    blobsSizes: blobsSizes,
    compareBlobs: compareBlobs,
    CHAMPIONS: CHAMPIONS,
    champOf: champOf,
    ITEMS: ITEMS,
    itemOf: itemOf,
    DEFAULTS: DEFAULTS
  };
});
