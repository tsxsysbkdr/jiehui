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
  // 阴阳子（v2）：第二阶段双撞不再成灰，而是一颗「既是黑也是白」的子。
  // 双方算连通块都算它、都能靠它产币、都能杀它（收益跟普通杀一样）。
  var YINYANG = 4;

  var DEFAULTS = {
    size: 9,
    // 模式：决定打几轮、起手多少币。规则本身一个字不改。
    //   quick    极简   5 轮，起手币用弈士自带的
    //   standard 标准  20 轮，起手币用弈士自带的
    //   rich     富翁  10 轮，起手 99 币 —— 用来测道具，也当个爽局
    mode: 'standard',
    totalRounds: 20,
    quickRounds: 5,
    quick: false,          // 兼容旧调用：quick:true 等于 mode:'quick'
    startCoins: null,      // null = 用弈士自带的起手币
    richCoins: 99,
    // ── 两套资源（v11）──────────────────────────────────
    // 气：只用来竞拍先手，每轮双方各 +1，上限跟弈士走，用掉就销毁（不转给对手）。
    // 币：只用来买盾和道具，每打过一个明轮按当时的最大连通块结算。
    startCoins: 2,        // 无锋起手 2 币（原来是 6）
    coinPerRound: 0,      // 币不再每轮白给
    coinFromBlob: true,   // 明轮结束：币 += 当时自己的最大连通块
    startQi: 0,           // 无锋起手 0 气
    qiPerRound: 1,        // 每进入一次竞拍双方各 +1（第 1 轮也是），到上限就浪费
    killQi: 1,            // 杀一次额外 +1 气
    shieldPrice: 2,       // 盾：护一个子，挡一次杀
    shieldOpens: 1,       // 盾活过几个明轮（1 = 下一个明轮结束就没了）
    // 明轮后手「必须贴着一手落」的限制。v9 起默认关掉：想落哪就落哪。
    // 引擎里 anchors() 整套还在，以后做成弈士技能时把这里打开即可。
    anchorRule: false,
    anchorSelf: true,
    champs: ['wufeng', 'wufeng']
  };

  // 三种模式。进房间先选模式，再选弈士。
  // markStage2：势 > 它 就进第二阶段（棋盘泛红、双撞变阴阳子）。
  // markLunhui：势 > 它 就触发轮回（清场、势归 0、双方各得一次币）。
  // jingLimit：这个模式每人最多买几本经。
  var MODES = [
    { id: 'quick', name: '极简', rounds: 5, coins: null, markStage2: 10, markLunhui: 20, jingLimit: 1,
      desc: '5 轮就打完。试手感、试新东西用这个。' },
    { id: 'standard', name: '标准', rounds: 20, coins: null, markStage2: 10, markLunhui: 20, jingLimit: 1,
      desc: '20 轮。正经一局。' },
    { id: 'rich', name: '混沌', rounds: 10, coins: 99, markStage2: 5, markLunhui: 10, jingLimit: 3,
      desc: '10 轮，双方起手 99 币。没有盾，暗轮一次暗选两子。纯爽。' }
  ];
  function modeOf(id) {
    for (var i = 0; i < MODES.length; i++) if (MODES[i].id === id) return MODES[i];
    return MODES[1];
  }

  // 弈士。平衡靠起手币与气上限，不改数值。
  // skills[].when：'open' 明轮轮到自己落子之前发动 / 'hidden' 暗轮里发动。
  // skills[].cd：冷却轮数，明轮暗轮都算一轮。用掉的那一轮不扣，往后每轮结束扣 1。
  // skills[].stage2：只在第二阶段可用（v2）。
  var CHAMPIONS = [
    {
      id: 'wufeng', name: '无锋', tag: '', coins: 2, qiCap: 5,
      skills: [{
        id: 'jimie', name: '寂灭', cd: 0, when: 'open', once: true, stage2: true, qi: 0,
        desc: '第二阶段才能用，本局一次：明轮里轮到你落子之前发动，耗尽全部币和气（0 币 0 气也能放），三道神雷各劈棋盘随机一格，劈中的东西直接变空白 —— 劫灰、带盾的子、自己的子、对方的子、阴阳子、连角落都可能。势不因此改变。'
      }],
      desc: '一把无锋的刀，用不上。'
    },
    {
      id: 'guaiseng', name: '怪僧', tag: '', coins: 2, qiCap: 5,
      skills: [{
        id: 'fuchen', name: '拂尘', cd: 3, when: 'open',
        desc: '明轮里轮到你落子之前发动：把任意一格劫灰，挪到另一个空位去。冷却 3 轮（明暗都算）。'
      }],
      desc: '手里一把拂尘，专扫灰。'
    },
    {
      id: 'shanren', name: '山人', tag: '', coins: 2, qiCap: 5,
      skills: [{
        id: 'tuna', name: '吐纳', cd: 2, when: 'hidden',
        desc: '暗轮里发动：气 +1。冷却 2 轮（明暗都算）。'
      }, {
        id: 'fusheng', name: '复生', cd: 0, when: 'hidden', once: true, stage2: true, qi: 0,
        desc: '第二阶段才能用，本局一次：暗轮里发动，气上限 +1 并立刻回 2 点气；同时点一格空白处挂个绿 ×（只有自己看得见），那格自己不能落。对方要是落在上面，那颗子立刻变成你的（当轮保护还在）。绿 × 再顶一轮，到期没人踩就散了。'
      }],
      desc: '吐一口浊气，多一分底气。'
    },
    {
      // 书缘：三个分支，平 / 垂 各一次、每次 1 气；荒 是「替代」路线 ——
      // 不单独计次，而是清空全部气（至少 4）并吃掉一个还没用过的分支。
      // 三者都要先选（arm），只有这一手真的**杀成了**才生效；没杀成就作废、不消耗。
      id: 'shuyuan', name: '书缘', tag: '', coins: 2, qiCap: 5,
      skills: [
        {
          id: 'ping', name: '平', cd: 0, when: 'open', once: true, qi: 1,
          desc: '明轮先手落子前选它：这一手如果杀成了，以新灰为中心横着三格封成禁入点，对手这一手不能再往那落子、也杀不动。只用一次，不触发不消耗。'
        },
        {
          id: 'chui', name: '垂', cd: 0, when: 'open', once: true, qi: 1,
          desc: '明轮先手落子前选它：这一手如果杀成了，以新灰为中心竖着三格封成禁入点。只用一次，不触发不消耗。'
        },
        {
          id: 'huang', name: '荒', cd: 0, when: 'open', once: false, qi: 4,
          desc: '平或垂的替代：清空全部气（至少 4 点），把新灰周围三乘三全封成禁入点。不单独计次，用掉一次平或垂。'
        },
        {
          id: 'muli', name: '暮礼', cd: 0, when: 'open', once: false, stage2: true, qi: 0,
          desc: '平和垂都用光、并且进了第二阶段，才轮到它。明轮先手落子前发动（不耗气），声明上 / 下 / 左 / 右一个方向：这一手如果杀成了，以新灰为中心朝那个方向封一格给对手禁入。每轮最多一次，不触发不消耗。'
        }
      ],
      desc: '一笔落定，划地为界。'
    }
  ];
  var CHAMP_BY_ID = {};
  for (var _ci = 0; _ci < CHAMPIONS.length; _ci++) CHAMP_BY_ID[CHAMPIONS[_ci].id] = CHAMPIONS[_ci];
  function champOf(id) { return CHAMP_BY_ID[id] || CHAMP_BY_ID.wufeng; }

  // 商店。when：'any' 随时可买 / 'hidden' 仅暗轮可用。
  // limit：每人最多买几个（不填 = 不限）。
  var ITEMS = [
    {
      id: 'shield', name: '盾', price: 2, when: 'hidden',
      desc: '护住自己的一颗子，挡下一次杀。只能在暗轮落子前用。'
    },
    {
      id: 'dan', name: '丹', price: 3, when: 'any', limit: 5,
      desc: '气上限永久 +1，并且立刻得 1 点气。随时可买随时可吃，每人最多五颗。'
    },
    {
      id: 'jing', name: '经', price: 10, when: 'any', limit: 1,
      desc: '读一卷经，得一个技能「覆」—— 暗轮里清空全部气（至少 4），点一格：点空格是盲猜对面落在哪，猜中那子碎；点对面一颗子则直接盯上它，结算时它碎（盾也挡不住）。只有一次机会。'
    }
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
    // 阴阳子「既是黑也是白」：算连通块时双方都把它当自己的子（v2）。
    function mine(v) { return v === want || v === YINYANG; }
    var vis = new Uint8Array(n), stack = new Int32Array(n), out = [];
    for (var i = 0; i < n; i++) {
      if (!mine(cells[i]) || vis[i]) continue;
      var sp = 0; stack[sp++] = i; vis[i] = 1;
      var sz = 0;
      while (sp) {
        var c = stack[--sp]; sz++;
        var nb = nbrs(size, c);
        for (var k = 0; k < nb.length; k++) {
          var j = nb[k];
          if (!vis[j] && mine(cells[j])) { vis[j] = 1; stack[sp++] = j; }
        }
      }
      out.push(sz);
    }
    out.sort(function (a, b) { return b - a; });
    return out;
  }

  // 最大连通块具体是哪些格子。并列时只取最先扫到的那一块（结算特效要用）。
  function blobCellsLargest(cells, size, p) {
    var n = size * size, want = p + 1;
    function mine(v) { return v === want || v === YINYANG; }
    var vis = new Uint8Array(n), stack = new Int32Array(n);
    var best = [], bestSize = 0;
    for (var i = 0; i < n; i++) {
      if (!mine(cells[i]) || vis[i]) continue;
      var sp = 0; stack[sp++] = i; vis[i] = 1;
      var cur = [];
      while (sp) {
        var c = stack[--sp]; cur.push(c);
        var nb = nbrs(size, c);
        for (var k = 0; k < nb.length; k++) {
          var j = nb[k];
          if (!vis[j] && mine(cells[j])) { vis[j] = 1; stack[sp++] = j; }
        }
      }
      if (cur.length > bestSize) { bestSize = cur.length; best = cur; }
    }
    return best;
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
    // 兼容旧调用：传了 quick:true 就当 mode:'quick'（老测试脚本还在用）。
    if (this.o.quick && this.o.mode === 'standard') this.o.mode = 'quick';
    var md = modeOf(this.o.mode);
    this.o.mode = md.id;
    // 模式只决定「打几轮」和「起手币」，别的规则一个字都不改
    this.o.totalRounds = md.rounds;
    this.size = this.o.size;
    var n = this.size * this.size;
    this.cells = new Array(n).fill(EMPTY);
    this.placedAt = new Array(n).fill(0);
    this.coins = new Array(2);
    this.qi = new Array(2);
    this.champ = [champOf(this.o.champs[0]), champOf(this.o.champs[1])];
    // 起手币：富翁模式固定给一大笔（99），其他模式用弈士自带的。
    var startC = (md.coins != null) ? md.coins : this.champ[0].coins;
    var startC1 = (md.coins != null) ? md.coins : this.champ[1].coins;
    this.coins[0] = startC;
    this.coins[1] = startC1;
    this.qiCap = [this.champ[0].qiCap, this.champ[1].qiCap];
    this.qi[0] = Math.min(this.o.startQi, this.qiCap[0]);
    this.qi[1] = Math.min(this.o.startQi, this.qiCap[1]);
    // 第 1 轮一开局就是竞拍阶段，所以按「每进入竞拍 +1」立即发（无锋 0 → 1）。
    this.qi[0] = Math.min(this.qiCap[0], this.qi[0] + this.o.qiPerRound);
    this.qi[1] = Math.min(this.qiCap[1], this.qi[1] + this.o.qiPerRound);
    // 盾：[{cell, p, roundsLeft}]。只能在自己暗轮落子前用，护一颗自己的老子。
    // 「随时可买」= 买回来进道具栏存着；「只有暗轮能用」= 唯一的生效时机。
    // 位置：暗轮里只有自己看得见，进明轮双方才看得见（server.view 按座位发）。
    // 一个暗轮里每方想罩几块就罩几块，只看手里有没有盾、币够不够。
    this.shields = [];
    this.shieldUsedThisHidden = false;   // 兼容旧字段（现在恒为 false，不再限制）
    this.round = 1;
    this.roundMode = 'pending';   // 'pending'（竞拍中，结果未定）| 'open' | 'hidden'
    this.ashCount = 0;
    // ── 势（v2）────────────────────────────────────────────
    // 杀成灰 +1、暗轮双撞 +1、混沌局双撞 +2。跟劫灰数量彻底解耦：
    // 灰被拂尘挪走、被寂灭劈掉、被轮回清空，势都不会跟着少。
    this.mark = 0;
    this.markSeq = 0;
    this.markLog = [];             // 势的变化流水 {id, d, why, mark}
    this.lunhuiCount = 0;
    this.lunhuiSeq = 0;
    this.lunhuiFx = [];            // 轮回特效流水 {id, mark0, coins}
    // 夺完之后胜者必须先调势（−N / 0 / +N）才能落子，N = 本轮实际花掉的气。
    this.markN = 0;
    this.markDone = [true, true];
    // 5×5 框：先手这一手定下的框，只约束后手这一手。
    this.frame = null;
    // 拂尘升级：触发过轮回之后才有充能（上限 3），null = 还没升级。
    this.fuchenCharge = [null, null];
    // 拂尘充能的冷却：攒满 3 轮才多 1 点（明轮暗轮都在走）。
    this.fuchenCd = [0, 0];
    // 复生：绿 × {cell, roundsLeft}，只自己可见、只禁自己。
    this.greenFu = [null, null];
    this.greenSeq = 0;
    this.greenFx = [];             // 绿 × 命中变子的流水 {id, cell, p}
    // 覆：一个暗轮里可以连押好几格（v2）。
    this.fuMarks = [[], []];       // 待结算的押注 [{cell, mode}]
    this.fuCharges = [0, 0];       // 读了几本经 = 还能押几次
    this.fuMaxSeen = [0, 0];       // 曾经拥有过几次（决定角标显不显示）
    this.muliUsedRound = [0, 0];   // 暮礼：这一轮是否已经用过（存轮次号）
    this.jimieUsed = [false, false];
    this.fushengUsed = [false, false];
    this.jimieSeq = 0;
    this.jimieFx = [];             // 寂灭三雷的流水 {id, cells, p}
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
    this.gaveFirst = false;    // 本轮先手是否已经把先动让出去了
    this.pending = { openFirst: null, hidden: [null, null], hidden2: [null, null], passed: [false, false] };
    this.items = [[], []];
    // 技能冷却：skillCdUntil[p][k] = 到第几轮才能再用（round >= 它才行）。
    // 用绝对轮次而不是倒计时，是因为明轮、暗轮同属一轮，「明暗都计数」就是按轮数走。
    this.skillCdUntil = [[], []];
    for (var _sp = 0; _sp < 2; _sp++) {
      for (var _sk = 0; _sk < this.champ[_sp].skills.length; _sk++) this.skillCdUntil[_sp][_sk] = 0;
    }
    this.skillUsed = [0, 0];
    this.fxSeq = 0;
    this.fx = [];              // 成灰/结算事件流水，给前端放特效（只增不清）
    this.modeSeq = 0;
    this.modeLog = [];         // 阶段切换流水：开始 / 夺（竞拍）/ 明 / 暗
    this.incomeSeq = 0;
    this.incomeFx = [];        // 明轮结算赚钱的流水（哪些块发了多少币）
    this.moveSeq = 0;
    this.moveFx = [];          // 拂尘挪灰的流水：{from, to}，前端据此放移动特效
    // 正辩（书缘）：禁入点 / 预先选定的杀招 / 覆
    this.zone = [];            // 禁入点 [{cells:[...], p, kind, center}] —— p 设的，封的是对手
    this.zoneSeq = 0;
    this.zoneFx = [];          // 金框特效流水 {id, cells, kind}
    this.arm = [null, null];   // 明轮先手预选的杀招：'ping' | 'chui' | 'huang' | 'muli' | null
    this.onceUsed = [[], []];  // once 类技能已用过的 id 列表（平 / 垂各一次）
    // 覆（v2）：一个暗轮里可以连押好几格，押注放着等暗轮结算。
    this.fuList = [[], []];    // 盘面上挂着的红 ×（只自己可见），给前端画
    this.fuSeq = 0;
    this.fuFx = [];            // 覆生效时的碎裂特效流水 {id, cell, p, color}
    this.danBought = [0, 0];
    this.jingBought = [0, 0];
    this.phase = 'auction';
    // 开局：先闪「对弈开始」，紧跟着才是「夺」（前端排队播，不重叠）
    this._flash('start');
    this._flash('duo');
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

    // ── 势 / 阶段（v2）──────────────────────────────────────
    stage: function () {
      var md = modeOf(this.o.mode);
      return this.mark > md.markStage2 ? 2 : 1;
    },
    inStage2: function () { return this.stage() === 2; },
    markMax: function () { return modeOf(this.o.mode).markLunhui; },
    _gainMark: function (n, why) {
      if (!n) return this.mark;
      var before = this.mark;
      this.mark += n;
      if (this.mark < 0) this.mark = 0;          // 势最低 0
      this.markSeq++;
      this.markLog.push({ id: this.markSeq, d: this.mark - before, why: why || '', mark: this.mark });
      return this.mark;
    },
    // 重新数一遍盘上的劫灰（寂灭、轮回会清灰，ashCount 得跟着对）。
    _recountAsh: function () {
      var n = 0;
      for (var i = 0; i < this.cells.length; i++) if (this.cells[i] === ASH) n++;
      this.ashCount = n;
      return n;
    },

    // ── 轮回（v2）─────────────────────────────────────────
    // 势越过上限 → 立刻结算：清灰、清阴阳子、解禁入、双方各按最大块得一次币、势归 0。
    _tryLunhui: function () {
      if (this.mark <= this.markMax()) return false;
      var before = this.mark;
      // 得币用的是「清灰之前」的盘面
      var big = [this.score(0), this.score(1)];
      this.lunhuiCount++;
      this.lunhuiSeq++;
      // 清场前的盘面快照：前端要靠它把「灰和阴阳子还在」的样子画出来，
      // 再让碧波自上而下扫过去一层层抹掉（用户 m06298 要求别一下全没了）。
      this.lunhuiFx.push({
        id: this.lunhuiSeq, mark0: before, coins: big.slice(),
        board: this.cells.slice()
      });
      // 清场：灰、阴阳子全部消失，回到空白
      for (var i = 0; i < this.cells.length; i++) {
        if (this.cells[i] === ASH || this.cells[i] === YINYANG) {
          this.cells[i] = EMPTY;
          this.placedAt[i] = 0;
        }
      }
      this._recountAsh();
      this.zone = [];
      // 注意：这里**不要**清 5×5 框。先手杀成灰 → 以新灰为中心设框 → 势刚好越线
      // 在这里触发轮回。如果顺手把框清了，后手这一手就没有框了，
      // 界面上的绿框折角也会跟着消失（用户 m06750 报的就是这个）。
      // 双方各按自己当前最大连通块得一次币（跟明轮结算一模一样）
      if (this.o.coinFromBlob) {
        this.coins[0] += big[0];
        this.coins[1] += big[1];
        this.lastIncome = big.slice();
        this.incomeSeq++;
        this.incomeFx.push({
          id: this.incomeSeq,
          cells: [blobCellsLargest(this.cells, this.size, 0), blobCellsLargest(this.cells, this.size, 1)],
          coins: big.slice()
        });
      }
      this.mark = 0;
      // 拂尘升级：触发过轮回的怪僧，充能上限 3，此刻充到 2
      for (var p = 0; p < 2; p++) {
        var src = this.champ[p].skills || [];
        for (var s = 0; s < src.length; s++) {
          if (src[s].id === 'fuchen') {
            this.fuchenCharge[p] = 2;
            this.fuchenCd[p] = 3;      // 之后每 3 轮才再涨 1 点
          }
        }
      }
      this._flash('lunhui');
      this.roundLog.push({ t: 'lunhui', mark0: before, coins: big });
      return true;
    },

    // ── 5×5 框（v2）────────────────────────────────────────
    // 竞拍胜者自己先落子 / 先杀成灰 → 以那一格为中心圈 5×5，
    // 后手这一手只能框里落空格、或者框里杀敌子（杀也受限）。
    // 胜者点了让先 → 这一轮不设框。技能不受框限制。
    _setFrame: function (center) {
      var s = this.size, x = center % s, y = (center / s) | 0;
      this.frame = {
        center: center,
        r0: Math.max(0, y - 2), r1: Math.min(s - 1, y + 2),
        c0: Math.max(0, x - 2), c1: Math.min(s - 1, x + 2)
      };
      return this.frame;
    },
    inFrame: function (cell) {
      if (!this.frame) return true;
      var s = this.size, x = cell % s, y = (cell / s) | 0, f = this.frame;
      return y >= f.r0 && y <= f.r1 && x >= f.c0 && x <= f.c1;
    },
    frameCells: function () {
      var out = [];
      if (!this.frame) return out;
      var s = this.size, f = this.frame;
      for (var y = f.r0; y <= f.r1; y++) for (var x = f.c0; x <= f.c1; x++) out.push(y * s + x);
      return out;
    },
    // 框只约束「后手这一手」。
    _frameRestricts: function (p) {
      if (!this.frame) return false;
      if (this.phase !== 'open-second') return false;
      return p === 1 - this.first;
    },
    // 兜底：框里既没有空格、也没有可杀的敌子 → 后手可以全盘自由落子。
    // 只判空格是不够的：框被塞满但里面还站着一颗能杀的敌子，后手照样有事可做，
    // 这时候放开全盘等于 5×5 直接作废（用户 m05919 认定是 bug）。
    _frameDead: function () {
      if (!this.frame) return true;
      var fc = this.frameCells();
      var p = 1 - this.first;
      for (var i = 0; i < fc.length; i++) {
        if (this.cells[fc[i]] === EMPTY) return false;
        if (this.isKillTarget(fc[i], p)) return false;
      }
      return true;
    },

    // 阶段切换流水：'start'（开局）/ 'duo'（进竞拍）/ 'ming'（进明轮）/ 'an'（进暗轮）。
    // 前端按 id 去重后**排队**闪大字（一次一个，不重叠），解决「切换太突兀」。
    _flash: function (kind) {
      this.modeSeq++;
      this.modeLog.push({ id: this.modeSeq, kind: kind });
    },

    // ── 竞拍：暗出首价，用「气」出价（气用完就销毁，不转给对手）──
    resolveBid: function (bids) {
      if (this.phase !== 'auction') throw new Error('phase:' + this.phase);
      var b = [
        Math.max(0, Math.min(this.qi[0], bids[0] | 0)),
        Math.max(0, Math.min(this.qi[1], bids[1] | 0))
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
        amt = Math.max(0, Math.min(this.qi[p], amount | 0));
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
      var amt = Math.max(0, Math.min(this.qi[p], amount | 0));
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
      // 气直接销毁：抢位置要真花掉，放弃才真省下。
      // （原来「赢家付给输家」会让故意输竞拍反而赚钱，换成气也一样。）
      this.qi[w] -= price;
      this.bidLoss[1 - w] += 1;
      this.roundLog.push({ t: 'won', p: w, price: price });
      // 不再有单独的「选先后手」阶段：赢家直接就是先手，界面上给他一个
      // 「让对方先走」的按钮（giveFirst），想后动再点它。
      this.first = w;
      // v2：胜者必须先定势（−N / 0 / +N，N = 本轮实际花掉的气）才能落子。
      this.markN = price;
      this.markDone = [true, true];
      this.markDone[w] = false;   // 只有胜者有权调势
      this.phase = 'open-first';
      this._flash('ming');
      return { won: w, price: price, first: this.first, markN: price };
    },

    // 胜者定势：d 只能是 -N / 0 / +N（N = 本轮实际花掉的气）。
    // 势最低 0；往上越过轮回线就地触发轮回。
    chooseMark: function (p, d) {
      if (this.phase !== 'open-first') throw new Error('phase:' + this.phase);
      if (this.first !== p) throw new Error('not your turn');
      if (this.markDone[p]) throw new Error('已经定过了');
      d = d | 0;
      var N = this.markN;
      if (d !== 0 && d !== N && d !== -N) throw new Error('只能 -' + N + ' / 0 / +' + N);
      this.markDone[p] = true;
      this.roundLog.push({ t: 'mark', p: p, d: d });
      if (d) this._gainMark(d, 'choose');
      if (d > 0) this._tryLunhui();
      return this.mark;
    },

    // 没人抢下先手：本轮直接打暗轮（不是取消暗轮 —— 暗轮打完照样回竞拍）
    // 注意：这一轮没有进明轮，所以不发币；气在进入竞拍时已经发过了。
    _toHidden: function () {
      this.roundMode = 'hidden';
      this.auctionWinner = null;
      this.first = null;
      this.phase = 'hidden';
      this.pending.hidden = [null, null];
      this.pending.hidden2 = [null, null];
      this.pending.passed = [false, false];
      this._flash('an');
      return { hidden: true };
    },

    // 先手把「先动」让给对手（原来靠选序，现在靠这个按钮）。
    // v2：必须先定势才能让先（势的处置权永远在竞拍胜者手里）。
    giveFirst: function (p) {
      if (this.phase !== 'open-first') throw new Error('phase:' + this.phase);
      if (this.first !== p) throw new Error('not your turn');
      if (!this.markDone[p]) throw new Error('先定势');
      if (this.pending.openFirst != null) throw new Error('already placed');
      if (this.gaveFirst) throw new Error('已经让过了');
      this.gaveFirst = true;
      this.first = 1 - p;
      this.frame = null;          // 让先 → 这一轮不设 5×5 框
      this.roundLog.push({ t: 'give', p: p });
      return this.first;
    },

    // 兼容旧调用（测试脚本还在用）：'second' = 让对方先走。
    applyOrder: function (choice) {
      if (choice === 'second') {
        try { return this.giveFirst(this.first); } catch (e) { return this.first; }
      }
      return this.first;
    },

    // 过：明轮里放弃自己这一手。先进/后手都能过；两人都过这轮就空着结束。
    passTurn: function (p) {
      if (this.phase === 'open-first') {
        if (this.first !== p) throw new Error('not your turn');
        this.roundLog.push({ t: 'pass', p: p, mode: 'open' });
        this.phase = 'open-second';
        return null;
      }
      if (this.phase === 'open-second') {
        if ((1 - this.first) !== p) throw new Error('not your turn');
        this.roundLog.push({ t: 'pass', p: p, mode: 'open' });
        return this._endRound();
      }
      throw new Error('phase:' + this.phase);
    },

    // ── 正辩：禁入点 ────────────────────────────────────────
    // 封的是「设禁入点那一方的对手」；明轮结束就解封。
    isForbidden: function (cell, p) {
      // 覆 押下的那几格：只有自己不能落（自己的禁入点），防止自己撞自己出 bug。
      // 对面落进去照旧 —— 猜中/盯上都会碎。一个暗轮里可以押好几格。
      for (var fi = 0; fi < this.fuMarks[p].length; fi++) {
        if (this.fuMarks[p][fi].cell === cell) return true;
      }
      // 复生的绿 ×：只禁自己，不禁对方（否则对方永远撞不上）。
      if (this.greenFu[p] && this.greenFu[p].cell === cell) return true;
      for (var i = 0; i < this.zone.length; i++) {
        var z = this.zone[i];
        if (z.p === p) continue;                       // 自己设的自己能落
        if (z.cells.indexOf(cell) >= 0) return true;
      }
      return false;
    },
    zoneOf: function (p) {
      var out = [];
      for (var i = 0; i < this.zone.length; i++) if (this.zone[i].p === p) out = out.concat(this.zone[i].cells);
      return out;
    },
    // 平 = 中心左右三格 / 垂 = 中心上下三格 / 荒 = 中心 3×3 / 暮礼 = 中心朝 dir 一格
    _zoneCells: function (center, kind, dir) {
      var s = this.size, x = center % s, y = (center / s) | 0, out = [];
      function add(nx, ny) {
        if (nx < 0 || ny < 0 || nx >= s || ny >= s) return;
        out.push(ny * s + nx);
      }
      if (kind === 'ping') { add(x - 1, y); add(x, y); add(x + 1, y); }
      else if (kind === 'chui') { add(x, y - 1); add(x, y); add(x, y + 1); }
      else if (kind === 'muli') {
        if (dir === 'up') add(x, y - 1);
        else if (dir === 'down') add(x, y + 1);
        else if (dir === 'left') add(x - 1, y);
        else if (dir === 'right') add(x + 1, y);
        // 贴边：出界就是空的 —— 技能照用、没作用
      }
      else {
        for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) add(x + dx, y + dy);
      }
      return out;
    },
    _openZone: function (p, center, kind, dir) {
      var cells = this._zoneCells(center, kind, dir);
      // 出界后可能是空数组（暮礼贴边）：空禁入点没意义，不记录，但技能算用掉。
      if (cells.length) {
        this.zone.push({ cells: cells, p: p, kind: kind, center: center, dir: dir || null });
        this.zoneSeq++;
        this.zoneFx.push({ id: this.zoneSeq, cells: cells, kind: kind, center: center, p: p, dir: dir || null });
        this.roundLog.push({ t: 'zone', p: p, kind: kind, cells: cells, dir: dir || null });
      }
      return cells;
    },
    // 杀成之后兑现预选的杀招（平 / 垂 / 荒 / 暮礼）。没预选就什么也不做。
    _settleArm: function (p, ashCell) {
      var a = this.arm[p];
      if (!a) return null;
      this.arm[p] = null;
      var sk = null, list = this.skillsOf(p);
      for (var i = 0; i < list.length; i++) if (list[i].id === a.id) sk = list[i];
      if (!sk) return null;
      var cost = a.id === 'huang' ? this.qi[p] : (sk.qi || 0);   // 荒：清空全部
      if (this.qi[p] < (a.id === 'huang' ? 4 : cost)) return null;
      this.qi[p] -= cost;
      if (sk.once) this.onceUsed[p].push(a.id);
      // 荒 是平的替代：吃掉一个分支。吃哪个由玩家在「挂上」时自己选（a.eat），
      // 没选就退回默认顺序（先平后垂），避免老调用完全不能跑。
      if (a.id === 'huang') {
        var spare = a.eat || null;
        if (!spare) {
          if (this.onceUsed[p].indexOf('ping') < 0) spare = 'ping';
          else if (this.onceUsed[p].indexOf('chui') < 0) spare = 'chui';
        }
        if (spare) this.onceUsed[p].push(spare);
      }
      if (a.id === 'muli') this.muliUsedRound[p] = this.round;
      return this._openZone(p, ashCell, a.id, a.dir || null);
    },

    // ── 杀：落子覆盖敌方不受保护的子，那格成灰 ──────────────
    // 受保护 = 本明轮先手当轮刚下的那颗（placedAt === round），或者盖了盾。
    isShielded: function (cell) {
      for (var i = 0; i < this.shields.length; i++) if (this.shields[i].cell === cell) return true;
      return false;
    },
    shieldOf: function (p) {
      var out = [];
      for (var i = 0; i < this.shields.length; i++) if (this.shields[i].p === p) out.push(this.shields[i].cell);
      return out;
    },
    isKillTarget: function (cell, byP) {
      var owner = 1 - byP;
      var v = this.cells[cell];
      // 阴阳子谁都能杀，而且不受「老子」保护（当轮刚生成的也能杀）。
      if (v === YINYANG) {
        if (this.isShielded(cell)) return false;
        if (this.isForbidden(cell, byP)) return false;
        return true;
      }
      if (v !== owner + 1) return false;
      if (!(this.placedAt[cell] > 0 && this.placedAt[cell] < this.round)) return false;
      if (this.isShielded(cell)) return false;   // 有盾就杀不动
      if (this.isForbidden(cell, byP)) return false;  // 禁入点里杀也失效
      return true;
    },
    // 当前玩家所有可劫的格子（就是可以覆盖的敌方老子的格）
    killTargetsFor: function (p) {
      var out = [];
      for (var i = 0; i < this.cells.length; i++) if (this.isKillTarget(i, p)) out.push(i);
      return out;
    },

    // 气：加但不超过上限，溢出直接浪费（没有「憋着」这回事）。
    _gainQi: function (p, n) {
      var before = this.qi[p];
      this.qi[p] = Math.min(this.qiCap[p], this.qi[p] + (n || 1));
      return this.qi[p] - before;
    },

    // kind: 'kill'（明轮落子盖杀敌子）| 'jie'（暗轮两人撞在同一格，无妄之灾）
    _makeAsh: function (cell, kind) {
      this.cells[cell] = ASH;
      this.placedAt[cell] = 0;
      this.ashCount++;
      // 特效流水：前端只看 fx 里比自己见过的序号更新的事件
      this.fxSeq++;
      this.fx.push({ id: this.fxSeq, cell: cell, kind: kind || 'jie' });
      // v2：成灰 → 势 +1（混沌局双撞要 +2，由调用方另补差额）
      this._gainMark(1, kind || 'jie');
    },

    // 第二阶段的双撞：不变灰，变一颗阴阳子（既是黑也是白）。
    _makeYinyang: function (cell) {
      this.cells[cell] = YINYANG;
      this.placedAt[cell] = 0;
      this.fxSeq++;
      this.fx.push({ id: this.fxSeq, cell: cell, kind: 'yinyang' });
      this._gainMark(1, 'yinyang');
    },

    // ── 落子 ──────────────────────────────────────────────
    // 先手：任意空格，或者任意可杀的敌方子所在格（后者成灰）
    openPlaceFirst: function (cell) {
      if (this.phase !== 'open-first') throw new Error('phase:' + this.phase);
      var p = this.first;
      // v2：夺完之后胜者必须先定势，才能落子 / 让先。
      if (!this.markDone[p]) throw new Error('先定势');
      if (this.isKillTarget(cell, p)) {
        this._makeAsh(cell, 'kill');
        this.killCount[p]++;
        this._gainQi(p, this.o.killQi);
        this.roundLog.push({ t: 'kill', p: p, cell: cell, victim: 1 - p });
        // v2：先手这一手是杀 → 5×5 框以「被烧成灰那格」为中心
        this._setFrame(cell);
        // 杀成了 → 兑现预选的杀招（平 / 垂 / 荒 / 暮礼），划出禁入点
        this._settleArm(p, cell);
        // 这一手没落子（把对方的子烧了），所以没有「这一手」可以贴 ——
        // 后手因此不受贴点约束，anchors() 返回空数组即视作自由落子。
        this.pending.openFirst = null;
        this.phase = 'open-second';
        // 势可能被这一杀推过轮回线 → 立刻结算，后手照常落
        this._tryLunhui();
        return cell;
      }
      if (this.isForbidden(cell, p)) throw new Error('那是禁入点');
      if (this.cells[cell] !== EMPTY) throw new Error('occupied');
      // 踩中对方的绿 ×：这格直接被对方抢走，自己这一手算白下（没落子）。
      if (this._greenFuOpen(cell, p)) {
        this._setFrame(cell);
        this.pending.openFirst = null;
        this.phase = 'open-second';
        this._tryLunhui();
        return cell;
      }
      this.cells[cell] = p + 1;
      this.placedAt[cell] = this.round;
      this.pending.openFirst = cell;
      // v2：先手自己落子 → 5×5 框以这格为中心
      this._setFrame(cell);
      this.roundLog.push({ t: 'place', p: p, cell: cell, mode: 'open' });
      this.phase = 'open-second';
      return cell;
    },

    // 明轮后手合法落点：贴对手这一手 ∪ 贴自己的子；再加上所有可杀的敌子格
    // anchorRule 关掉时返回全部空格（想落哪就落哪）。
    // v2：先手这一手定下的 5×5 框只约束后手这一手（框里没空格了才放开全盘）。
    anchors: function (p) {
      if (p == null) p = 1 - this.first;
      var useFrame = this._frameRestricts(p) && !this._frameDead();
      if (!this.o.anchorRule) {
        var all = [];
        for (var i = 0; i < this.cells.length; i++) {
          if (this.cells[i] !== EMPTY) continue;
          if (this.isForbidden(i, p)) continue;
          if (useFrame && !this.inFrame(i)) continue;
          all.push(i);
        }
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
        for (var j = 0; j < this.cells.length; j++) {
          if (this.cells[j] !== p + 1) continue;
          var nb = nbrs(s, j, 1);
          for (var k = 0; k < nb.length; k++) {
            var q = nb[k];
            if (this.cells[q] === EMPTY && !this.isForbidden(q, p) && !seen[q]) { seen[q] = 1; out.push(q); }
          }
        }
      }
      if (useFrame) out = out.filter(this.inFrame, this);
      return out;
    },

    // 后手能点的所有格子：贴点里的空格 + 可杀的敌子格（杀不受贴约束）
    // v2：框生效时，杀也只能在框里杀。
    secondOptions: function () {
      var p = 1 - this.first;
      var a = this.anchors(p), j = this.killTargetsFor(p);
      if (this._frameRestricts(p) && !this._frameDead()) j = j.filter(this.inFrame, this);
      return a.concat(j);
    },

    openSecond: function (action) {
      if (this.phase !== 'open-second') throw new Error('phase:' + this.phase);
      if (typeof action === 'number') action = { cell: action };   // 容错：也接受直接传格号
      var p = 1 - this.first;
      var cell = action.cell;
      var frameOn = this._frameRestricts(p) && !this._frameDead();
      if (this.isKillTarget(cell, p)) {
        if (frameOn && !this.inFrame(cell)) throw new Error('只能在框里');
        this._makeAsh(cell, 'kill');
        this.killCount[p]++;
        this._gainQi(p, this.o.killQi);
        this.roundLog.push({ t: 'kill', p: p, cell: cell, victim: this.first });
        this._settleArm(p, cell);
        this._tryLunhui();
        return this._endRound();
      }
      if (this.isForbidden(cell, p)) throw new Error('那是禁入点');
      if (frameOn && !this.inFrame(cell)) throw new Error('只能在框里');
      var anchors = this.anchors(p);
      var free = anchors.length === 0;
      if (!free && anchors.indexOf(cell) === -1) throw new Error('must anchor');
      if (this.cells[cell] !== EMPTY) throw new Error('occupied');
      // 踩中对方的绿 ×：这格被对方抢走，自己这一手算白下，这一轮照常结束。
      if (this._greenFuOpen(cell, p)) return this._endRound();
      this.cells[cell] = p + 1;
      this.placedAt[cell] = this.round;
      this.roundLog.push({ t: 'place', p: p, cell: cell, mode: 'open', free: free });
      return this._endRound();
    },

    // ── 暗轮 ──────────────────────────────────────────────
    // 混沌局每方要暗选两子（hiddenSubmit2），其他模式一子。
    hiddenSubmit: function (p, cell) {
      if (this.phase !== 'hidden') throw new Error('phase:' + this.phase);
      if (this.cells[cell] !== EMPTY) throw new Error('occupied');
      // 覆押下的那一格是自己这边的禁入点：自己的子不能落进去（不然自己踩自己的猜）。
      if (this.isForbidden(cell, p)) throw new Error('那是禁入点');
      if (this.pending.hidden[p] != null || this.pending.passed[p]) throw new Error('already submitted');
      this.pending.hidden[p] = cell;
      // 混沌局：第一子先存着，等第二子一起提交。
      if (this.isChaos()) return null;
      return this._resolveHidden();
    },

    // 混沌局第二子：两子都落定才算这一方提交完。
    hiddenSubmit2: function (p, cell) {
      if (this.phase !== 'hidden') throw new Error('phase:' + this.phase);
      if (!this.isChaos()) throw new Error('这个模式只落一子');
      if (this.pending.hidden[p] == null) throw new Error('先选第一子');
      if (this.pending.hidden2[p] != null) throw new Error('already submitted');
      if (cell === this.pending.hidden[p]) throw new Error('两子不能同一格');
      if (this.cells[cell] !== EMPTY) throw new Error('occupied');
      if (this.isForbidden(cell, p)) throw new Error('那是禁入点');
      this.pending.hidden2[p] = cell;
      return this._resolveHidden();
    },

    isChaos: function () { return this.o.mode === 'rich'; },
    // 这一方暗轮是否已经交完（普通模式一子，混沌两子）。
    hiddenDone: function (p) {
      if (this.pending.passed[p]) return true;
      if (this.pending.hidden[p] == null) return false;
      if (this.isChaos() && this.pending.hidden2[p] == null) return false;
      return true;
    },

    // 暗轮也能「过」：这一轮不落子。两人都过 → 这一轮空着过去。
    // 一方过一方落 → 落的人白得一子（没有对撞风险），所以「过」是要付代价的。
    passHidden: function (p) {
      if (this.phase !== 'hidden') throw new Error('phase:' + this.phase);
      if (this.pending.hidden[p] != null || this.pending.passed[p]) throw new Error('already submitted');
      this.pending.passed[p] = true;
      this.roundLog.push({ t: 'pass', p: p, mode: 'hidden' });
      return this._resolveHidden();
    },

    _resolveHidden: function () {
      if (!this.hiddenDone(0) || !this.hiddenDone(1)) return null;
      var chaos = this.isChaos();
      // 每方这一手落的格子（混沌局两个；被覆打掉的置 null）
      var a = this.pending.hidden[0], b = this.pending.hidden[1];
      var a2 = chaos ? this.pending.hidden2[0] : null;
      var b2 = chaos ? this.pending.hidden2[1] : null;

      // ── 覆：一个暗轮能押好几格，逐格兑现。 ──
      //  'guess'：盲猜对方这一手落在哪 → 猜中那子当场碎掉（连盾），猜空就白花。
      //  'kill' ：直接盯上对方一颗子 → 不论对方这手落在哪，那子都碎（连盾）。
      for (var fp = 0; fp < 2; fp++) {
        var marks = this.fuMarks[fp];
        if (!marks.length) continue;
        this.fuMarks[fp] = [];
        this.fuList[fp] = [];
        var opCells = chaos ? [this.pending.hidden[1 - fp], this.pending.hidden2[1 - fp]]
                            : [this.pending.hidden[1 - fp]];
        for (var mi = 0; mi < marks.length; mi++) {
          var guess = marks[mi].cell, mode = marks[mi].mode;
          var opHit = false;
          for (var oi = 0; oi < opCells.length; oi++) if (opCells[oi] != null && opCells[oi] === guess) opHit = true;
          var hit = (mode === 'kill') || opHit;
          if (hit) {
            var victimColor = this.cells[guess];   // 先记下颜色，下面就把格子清空了
            // 打掉的是这一手落的子：从 pending 里剔除（fp 是押注方，被打的是对手那一手）
            if (fp === 0) { if (b === guess) b = null; if (b2 === guess) b2 = null; }
            else { if (a === guess) a = null; if (a2 === guess) a2 = null; }
            if (this.cells[guess] === (1 - fp) + 1) {
              this.cells[guess] = EMPTY;
              this.placedAt[guess] = 0;
            }
            // 有盾也一起打掉
            for (var si = this.shields.length - 1; si >= 0; si--) {
              if (this.shields[si].cell === guess) this.shields.splice(si, 1);
            }
            this.fuSeq++;
            // 记下被碎掉那颗子的颜色（1=黑 2=白），前端照着同色碎，别一律按黑子画
            this.fuFx.push({ id: this.fuSeq, cell: guess, p: fp, color: victimColor });
            this.roundLog.push({ t: 'fu', p: fp, cell: guess, hit: true, mode: mode });
          } else {
            this.roundLog.push({ t: 'fu', p: fp, cell: guess, hit: false, mode: mode });
          }
        }
      }

      // ── 双撞判定 ──
      // 普通模式：两人同格 → 劫。第二阶段变阴阳子，否则成灰。
      // 混沌局：两两比对，撞几格都算，但整轮只 +2（用户 m04661）。
      var mine0 = [a, a2].filter(function (v) { return v != null; });
      var mine1 = [b, b2].filter(function (v) { return v != null; });
      var collisions = [];
      for (var i0 = 0; i0 < mine0.length; i0++) {
        if (mine1.indexOf(mine0[i0]) >= 0) collisions.push(mine0[i0]);
      }
      if (collisions.length) {
        var stage2 = this.inStage2();
        for (var ci = 0; ci < collisions.length; ci++) {
          var ccell = collisions[ci];
          if (stage2) this._makeYinyang(ccell);   // 阴阳子不产生劫灰
          else this._makeAsh(ccell, 'jie');
          this.jieTotal++;
          this.roundLog.push({ t: 'jie', cell: ccell, yinyang: stage2 });
        }
        // 混沌局整轮只 +2：撞 1 格 → 补 +1；撞 2 格 → 各已 +1，正好 +2，不补。
        if (chaos) {
          var extra = 2 - collisions.length;
          if (extra > 0) this._gainMark(extra, 'chaos-jie');
        }
        // 撞掉的格子从各自那一手里剔除
        for (var k0 = 0; k0 < mine0.length; k0++) {
          if (collisions.indexOf(mine0[k0]) >= 0) {
            if (a === mine0[k0]) a = null;
            if (a2 === mine0[k0]) a2 = null;
          }
        }
        for (var k1 = 0; k1 < mine1.length; k1++) {
          if (collisions.indexOf(mine1[k1]) >= 0) {
            if (b === mine1[k1]) b = null;
            if (b2 === mine1[k1]) b2 = null;
          }
        }
      }

      // 其余各归各
      if (a != null) {
        this.cells[a] = BLACK; this.placedAt[a] = this.round;
        this.roundLog.push({ t: 'place', p: 0, cell: a, mode: 'hidden' });
      }
      if (a2 != null) {
        this.cells[a2] = BLACK; this.placedAt[a2] = this.round;
        this.roundLog.push({ t: 'place', p: 0, cell: a2, mode: 'hidden' });
      }
      if (b != null) {
        this.cells[b] = WHITE; this.placedAt[b] = this.round;
        this.roundLog.push({ t: 'place', p: 1, cell: b, mode: 'hidden' });
      }
      if (b2 != null) {
        this.cells[b2] = WHITE; this.placedAt[b2] = this.round;
        this.roundLog.push({ t: 'place', p: 1, cell: b2, mode: 'hidden' });
      }
      // ── 复生的绿 ×：对方踩中 → 那颗子变成我的 ──
      // 必须放在「各归各」之后：先把对方的子写进格子，再整格改成我的，
      // 否则随后那次写入会把子又盖回对方颜色。
      this._greenFuHit([[a, a2], [b, b2]]);
      this.pending.hidden = [null, null];
      this.pending.hidden2 = [null, null];
      this.pending.passed = [false, false];
      this._tryLunhui();
      return this._endRound();
    },

    // 明轮踩中绿 ×：当场就变子。
    // （暗轮那套要等两人都提交完才结算，是为了不泄露对方落在哪；明轮没有保密问题，
    //   规格 SPEC_v2.md:242 要求「立刻抢过来」。之前只在暗轮结算里判，明轮等于白挂。）
    _greenFuOpen: function (cell, byP) {
      var owner = 1 - byP;
      var g = this.greenFu[owner];
      if (!g || g.cell !== cell) return false;
      this.cells[cell] = owner + 1;
      this.placedAt[cell] = this.round;      // 带当轮保护，本轮杀不动
      this.greenSeq++;
      this.greenFx.push({ id: this.greenSeq, cell: cell, p: owner });
      this.roundLog.push({ t: 'greenfu', p: owner, cell: cell });
      this.greenFu[owner] = null;            // 命中后绿 × 消失
      return true;
    },

    // 绿 × 命中：谁踩中，那格就变成挂 × 那位的子（带当轮保护）。
    // cellsByP[0] / cellsByP[1] = 各方这一手落的格子列表。
    _greenFuHit: function (cellsByP) {
      for (var owner = 0; owner < 2; owner++) {
        var g = this.greenFu[owner];
        if (!g) continue;
        var oppCells = cellsByP[1 - owner], mine = cellsByP[owner];
        for (var j = 0; j < oppCells.length; j++) {
          var c = oppCells[j];
          if (c == null || c !== g.cell) continue;
          if (mine.indexOf(c) >= 0) continue;   // 两人同格 → 那是双撞，不归谁
          this.cells[c] = owner + 1;
          this.placedAt[c] = this.round;        // 带当轮保护，本轮杀不动
          this.greenSeq++;
          this.greenFx.push({ id: this.greenSeq, cell: c, p: owner });
          this.roundLog.push({ t: 'greenfu', p: owner, cell: c });
          this.greenFu[owner] = null;           // 命中后绿 × 消失
          break;
        }
      }
    },

    // ── 商店（随时可买；盾只有暗轮能用）──────────────────────
    buy: function (p, id) {
      if (this.over) throw new Error('game over');
      var it = itemOf(id);
      if (!it) throw new Error('no such item');
      // v2：混沌局不卖盾（暗轮一次暗选两子，盾没意义）
      if (id === 'shield' && this.isChaos()) throw new Error('混沌局没有盾');
      // 经：上限跟模式走（混沌 3 本，其他 1 本）
      if (id === 'jing') {
        var lim = modeOf(this.o.mode).jingLimit != null ? modeOf(this.o.mode).jingLimit : it.limit;
        if (this.jingBought[p] >= lim) throw new Error('买到底了');
      } else if (it.limit) {
        var had = id === 'dan' ? this.danBought[p] : 0;
        if (had >= it.limit) throw new Error('买到底了');
      }
      if (this.coins[p] < it.price) throw new Error('not enough coins');
      this.coins[p] -= it.price;
      this.items[p].push(id);
      if (id === 'dan') this.danBought[p]++;
      if (id === 'jing') this.jingBought[p]++;
      this.roundLog.push({ t: 'buy', p: p, item: id, price: it.price });
      return this.items[p].length;
    },

    // 用道具。盾：暗轮落子前，罩自己一颗老子（placedAt < round），一个暗轮只能罩一块。
    useItem: function (p, id, cell) {
      if (this.over) throw new Error('game over');
      var it = itemOf(id);
      if (!it) throw new Error('no such item');
      var k = this.items[p].indexOf(id);
      if (k < 0) throw new Error('not owned');
      if (it.when === 'hidden' && this.phase !== 'hidden') throw new Error('只能暗轮用');

      if (id === 'shield') {
        // 每方每轮想罩几块就罩几块：有盾、币够、这颗子还没罩，就允许。
        if (this.pending.hidden[p] != null) throw new Error('你已经暗落完了，不能再罩盾');
        if (cell == null) throw new Error('要点一颗自己的子');
        // 阴阳子既是自己的也是对方的 → 双方都能罩（先罩先得，两人同时罩效果一样）。
        var isYY = this.cells[cell] === YINYANG;
        if (this.cells[cell] !== p + 1 && !isYY) throw new Error('只能罩自己的子');
        // 阴阳子的 placedAt 恒为 0（它不是谁落的子），要单独放行，否则永远罩不上。
        if (!isYY && !(this.placedAt[cell] > 0 && this.placedAt[cell] < this.round)) throw new Error('刚落的子不能罩盾');
        if (this.isShielded(cell)) throw new Error('这颗子已经有盾了');
        this.items[p].splice(k, 1);
        this.shields.push({ cell: cell, p: p, roundsLeft: this.o.shieldOpens });
        this.roundLog.push({ t: 'shield', p: p, cell: cell });
        return cell;
      }

      // 丹：气上限永久 +1，并且立刻得 1 点气。随时可吃。
      if (id === 'dan') {
        this.items[p].splice(k, 1);
        this.qiCap[p] += 1;
        this.qi[p] = Math.min(this.qiCap[p], this.qi[p] + 1);
        this.roundLog.push({ t: 'use', p: p, item: 'dan', qiCap: this.qiCap[p] });
        return this.qiCap[p];
      }

      // 经：读一卷经 → 覆的可押次数 +1（v2：混沌局最多 3 次）。随时可读。
      if (id === 'jing') {
        this.items[p].splice(k, 1);
        this.fuCharges[p] += 1;
        if (this.fuCharges[p] > this.fuMaxSeen[p]) this.fuMaxSeen[p] = this.fuCharges[p];
        this.roundLog.push({ t: 'use', p: p, item: 'jing', charges: this.fuCharges[p] });
        return this.fuCharges[p];
      }

      this.items[p].splice(k, 1);
      this.roundLog.push({ t: 'use', p: p, item: id });
      return null;
    },

    itemCount: function (p, id) {
      var n = 0;
      for (var i = 0; i < this.items[p].length; i++) if (this.items[p][i] === id) n++;
      return n;
    },

    // ── 弈士技能 ──────────────────────────────────────────
    // 冷却按「轮」算：明轮、暗轮各算一轮（同一轮里明暗不重复计）。
    // skillCdUntil 存的是「最早能再用的轮次」，所以看的是 round >= 它。
    // k 是 skillsOf(p) 里的下标，而技能用掉之后会从列表里消失、下标会往前挪，
    // 所以冷却不能按下标存 —— 先按 id 找回它在原始技能表里的位置。
    _skSlot: function (p, sk) {
      if (!sk) return -1;
      var src = this.champ[p].skills || [];
      for (var i = 0; i < src.length; i++) if (src[i].id === sk.id) return i;
      return -1;
    },
    skillWait: function (p, k) {
      var slot = this._skSlot(p, this.skillsOf(p)[k]);
      var until = slot < 0 ? 0 : ((this.skillCdUntil[p] || [])[slot] || 0);
      var w = until - this.round;
      return w > 0 ? w : 0;
    },
    // 这个玩家现在**拥有**的技能列表。
    // 用掉的分支直接从列表里消失（不标「用完」）：平用掉就没平，垂用掉就没垂，
    // 两支都用光，荒跟着一起没 —— 技能栏里剩下的就是你还能用的。
    // v2：stage2 技能（寂灭 / 复生 / 暮礼）只在第二阶段出现；暮礼还要平和垂都光。
    skillsOf: function (p) {
      var src = this.champ[p].skills || [];
      var used = this.onceUsed[p];
      var bothGone = used.indexOf('ping') >= 0 && used.indexOf('chui') >= 0;
      var s2 = this.inStage2();
      var out = [];
      for (var j = 0; j < src.length; j++) {
        var s0 = src[j];
        if ((s0.id === 'ping' || s0.id === 'chui') && used.indexOf(s0.id) >= 0) continue;
        if (s0.id === 'huang' && bothGone) continue;
        if (s0.stage2 && !s2) continue;
        if (s0.id === 'muli' && !bothGone) continue;
        if (s0.id === 'jimie' && this.jimieUsed[p]) continue;
        if (s0.id === 'fusheng' && this.fushengUsed[p]) continue;
        // 拂尘升级后：充能用光就整个按钮消失（跟「用完即消失」一个口径，不标「用完」）。
        if (s0.id === 'fuchen' && this.fuchenCharge[p] != null && this.fuchenCharge[p] <= 0) continue;
        out.push(s0);
      }
      // 覆：读了经才有，每本给一次押注。次数为 0 时整个按钮消失。
      if (this.fuCharges[p] > 0) {
        out.push({
          id: 'fu', name: '覆', cd: 0, when: 'hidden', qi: 4, once: true,
          charges: this.fuCharges[p], showBadge: this.fuMaxSeen[p] > 1,
          desc: '暗轮里扣 4 点气（气不够 4 点就用不了），点一格：点空格是盲猜对面落在哪，猜中那子碎；点对面一颗子则直接盯上它，结算时它碎（盾也挡不住）。同一个暗轮里可以连押好几格，每格各扣 4 点气。'
        });
      }
      // 拂尘升级：触发过轮回之后充能制（上限 3），显示次数角标。
      if (this.fuchenCharge[p] != null) {
        for (var f = 0; f < out.length; f++) {
          if (out[f].id === 'fuchen') {
            out[f].charge = this.fuchenCharge[p];
            out[f].chargeMax = 3;
            out[f].showBadge = true;
          }
        }
      }
      return out;
    },
    // 现在这个技能能不能发动：没终局、冷却好了、没被用掉、气够、并且在它允许的阶段、轮到自己。
    canUseSkill: function (p, k) {
      if (this.over) return false;
      var sk = this.skillsOf(p)[k];
      if (!sk) return false;
      // 用掉就没了：平 / 垂 各一次；寂灭 / 复生 各一次
      if ((sk.id === 'ping' || sk.id === 'chui') && this.onceUsed[p].indexOf(sk.id) >= 0) return false;
      if (sk.id === 'jimie' && this.jimieUsed[p]) return false;
      if (sk.id === 'fusheng' && this.fushengUsed[p]) return false;
      if (sk.stage2 && !this.inStage2()) return false;
      // 荒 要吃掉一个还没用过的分支，两支都用光就用不出荒
      if (sk.id === 'huang') {
        if (this.onceUsed[p].indexOf('ping') >= 0 && this.onceUsed[p].indexOf('chui') >= 0) return false;
      }
      // 暮礼：正辩两支都得用光，并且这一轮还没用过
      if (sk.id === 'muli') {
        if (this.onceUsed[p].indexOf('ping') < 0 || this.onceUsed[p].indexOf('chui') < 0) return false;
        if (this.muliUsedRound[p] === this.round) return false;
      }
      // 覆：得有次数（气也会被清空，所以气不够也放不了）
      if (sk.id === 'fu' && this.fuCharges[p] <= 0) return false;
      // 拂尘升级后：充能 0 就放不了
      if (sk.id === 'fuchen' && this.fuchenCharge[p] != null && this.fuchenCharge[p] <= 0) return false;
      // 寂灭：无门槛（0 币 0 气也能放）
      if (sk.id === 'jimie') {
        if (sk.when === 'open') {
          if (this.phase === 'open-first') return this.first === p;
          if (this.phase === 'open-second') return (1 - this.first) === p;
          return false;
        }
      }
      // 气不够就是「就绪但是灰的」
      var need = (sk.id === 'huang' || sk.id === 'fu') ? 4 : (sk.qi || 0);
      if (this.qi[p] < need) return false;
      if (this.skillWait(p, k) > 0) return false;
      if (sk.when === 'open') {
        // 明轮：轮到自己落子、且这一手还没落（先手是 open-first，后手是 open-second）
        if (this.phase === 'open-first') return this.first === p;
        if (this.phase === 'open-second') return (1 - this.first) === p;
        return false;
      }
      if (sk.when === 'hidden') {
        if (this.phase !== 'hidden') return false;
        return this.pending.hidden[p] == null && !this.pending.passed[p];
      }
      return false;
    },
    _spendSkill: function (p, k) {
      var sk = this.skillsOf(p)[k];
      if (!sk) return;
      var slot = this._skSlot(p, sk);
      // 拂尘升级后走「充能」而不是冷却：手里还有几点就能接着扫，
      // 用完一点就少一点，靠充能慢慢涨回来。如果这里再压一道 3 轮冷却，
      // 就会出现「角标显示还有 3 次、状态写着还 1 轮、按钮却是灰的」
      // 这种自相矛盾（用户 m06811 报的就是这个）。
      if (sk.id === 'fuchen' && this.fuchenCharge[p] != null) {
        this.skillUsed[p]++;
        return;
      }
      if (slot >= 0) this.skillCdUntil[p][slot] = this.round + (sk.cd || 0);
      this.skillUsed[p]++;
    },

    // 拂尘：把一格劫灰挪到另一个空位。
    // arg = { from: 劫灰所在的格, to: 要挪到的空格 }
    useSkill: function (p, k, arg) {
      if (this.over) throw new Error('game over');
      if (!this.canUseSkill(p, k)) throw new Error('现在不能发动');
      var sk = this.skillsOf(p)[k];
      // 正辩三支 + 暮礼：发动 = 先「挂上」，等这一手真杀成了才兑现（不杀不消耗）。
      // 荒 还要在这时选定「吃掉哪一支」（arg.eat = 'ping' | 'chui'），
      // 玩家想自己决定吃哪个，所以不自动挑 —— 由前端弹一次选择。
      // 暮礼 要选方向（arg.dir = 'up' | 'down' | 'left' | 'right'）。
      if (sk.id === 'ping' || sk.id === 'chui' || sk.id === 'huang' || sk.id === 'muli') {
        var armObj = { id: sk.id };
        if (sk.id === 'huang') {
          arg = arg || {};
          var eat = arg.eat;
          if (eat !== 'ping' && eat !== 'chui') throw new Error('荒要先选吃掉平还是垂');
          if (this.onceUsed[p].indexOf(eat) >= 0) throw new Error('那一支已经用掉了');
          armObj.eat = eat;
        }
        if (sk.id === 'muli') {
          arg = arg || {};
          var dir = arg.dir;
          if (dir !== 'up' && dir !== 'down' && dir !== 'left' && dir !== 'right') throw new Error('暮礼要先选一个方向');
          armObj.dir = dir;
        }
        this.arm[p] = armObj;
        this.roundLog.push({ t: 'arm', p: p, skill: sk.id, eat: armObj.eat || null, dir: armObj.dir || null });
        return sk.id;
      }
      // 覆：多种用法 —— ①点空格盲猜对方这一手；②点对方一颗子，暗轮结算时抹除（连盾）。
      // 两种都画 ×，× 只有自己看得见，暗轮结算就消失。× 相当于自己的禁入点。
      // v2：同一个暗轮能连押好几格，每押一次扣一次「覆」的次数。
      if (sk.id === 'fu') {
        arg = arg || {};
        if (arg.cell == null) throw new Error('要选一格');
        if (this.fuCharges[p] <= 0) throw new Error('覆已经用完了');
        var marked = this.cells[arg.cell];
        var mode;
        if (marked === EMPTY) {
          mode = 'guess';
        } else if (marked === (1 - p) + 1) {
          mode = 'kill';    // 子先留着，暗轮结算才碎（对方这期间还可能给它套盾）
        } else {
          throw new Error('只能点空格或对方的子');
        }
        // 同一格不能押两次
        for (var fj = 0; fj < this.fuMarks[p].length; fj++) {
          if (this.fuMarks[p][fj].cell === arg.cell) throw new Error('这格已经押过了');
        }
        this.fuMarks[p].push({ cell: arg.cell, mode: mode });
        this.fuList[p].push(arg.cell);
        this.fuCharges[p] -= 1;                   // 每押一格扣一次
        // 每押一格固定扣 4 气（用户 m05919：统一只扣 4，不清空、不随模式变）。
        this.qi[p] -= Math.min(this.qi[p], 4);
        this.roundLog.push({ t: 'fuCast', p: p, cell: arg.cell, mode: mode, left: this.fuCharges[p] });
        return arg.cell;
      }
      // 寂灭（无锋）：耗尽全部币和气，三道雷各劈一格，劈中的东西直接变空白。
      if (sk.id === 'jimie') {
        if (this.jimieUsed[p]) throw new Error('这一局用过了');
        this.jimieUsed[p] = true;
        this.coins[p] = 0;
        this.qi[p] = 0;
        var n = this.cells.length, hits = [];
        for (var t = 0; t < 3; t++) {
          var cc = Math.floor(Math.random() * n);
          this.cells[cc] = EMPTY;
          this.placedAt[cc] = 0;
          // 盾也被劈掉
          for (var s2 = this.shields.length - 1; s2 >= 0; s2--) {
            if (this.shields[s2].cell === cc) this.shields.splice(s2, 1);
          }
          hits.push(cc);
        }
        this._recountAsh();
        this.jimieSeq++;
        this.jimieFx.push({ id: this.jimieSeq, cells: hits, p: p });
        this.roundLog.push({ t: 'skill', p: p, skill: 'jimie', cells: hits });
        this._spendSkill(p, k);
        return hits;
      }
      // 复生（山人）：气上限 +1、立刻 +2 气；同时点一格空白挂绿 ×（只自己可见、只禁自己）。
      if (sk.id === 'fusheng') {
        if (this.fushengUsed[p]) throw new Error('这一局用过了');
        arg = arg || {};
        if (arg.cell == null) throw new Error('要点一格空白');
        if (this.cells[arg.cell] !== EMPTY) throw new Error('只能点空白处');
        this.fushengUsed[p] = true;
        this.qiCap[p] += 1;
        this.qi[p] = Math.min(this.qiCap[p], this.qi[p] + 2);
        // 绿 × 再顶一轮：这一轮 + 下一轮
        this.greenFu[p] = { cell: arg.cell, until: this.round + 1 };
        this.roundLog.push({ t: 'skill', p: p, skill: 'fusheng', cell: arg.cell, qiCap: this.qiCap[p] });
        this._spendSkill(p, k);
        return arg.cell;
      }
      if (sk.id === 'fuchen') {
        arg = arg || {};
        var from = arg.from, to = arg.to;
        if (from == null || to == null) throw new Error('要选一格劫灰和一个空位');
        if (this.cells[from] !== ASH) throw new Error('那不是劫灰');
        if (this.cells[to] !== EMPTY) throw new Error('要挪到空格上');
        this.cells[from] = EMPTY;
        this.placedAt[from] = 0;
        this.cells[to] = ASH;
        this.placedAt[to] = 0;
        // 灰的总数不变（挪，不是消），所以 ashCount 不动。
        this.moveSeq++;
        this.moveFx.push({ id: this.moveSeq, from: from, to: to, p: p });
        this.roundLog.push({ t: 'skill', p: p, skill: 'fuchen', from: from, to: to });
        // 升级后是充能制：用一次扣一格，并且冷却重新从 3 轮起算。
        // （之前漏了扣减 → 充能永远不减，拂尘变无限次。）
        if (this.fuchenCharge[p] != null) {
          this.fuchenCharge[p] -= 1;
          this.fuchenCd[p] = 3;
          this.roundLog.push({ t: 'charge', p: p, skill: 'fuchen', left: this.fuchenCharge[p] });
        }
        this._spendSkill(p, k);
        return to;
      }
      if (sk.id === 'tuna') {
        var got = this._gainQi(p, 1);
        this.roundLog.push({ t: 'skill', p: p, skill: 'tuna', got: got });
        this._spendSkill(p, k);
        return got;
      }
      throw new Error('这个技能还没做');
    },

    // ── 轮次转移 ──────────────────────────────────────────
    // 唯一的循环：明轮打完 → 必进暗轮；暗轮打完 → 必回竞拍。
    // 竞拍没人抢先手 → 本轮直接是暗轮，打完照样回竞拍。没有奇偶、没有漂移。
    _endRound: function () {
      var wasOpen = this.roundMode === 'open';
      var n0 = this.blobs(0), n1 = this.blobs(1);
      var big = [n0.length ? n0[0] : 0, n1.length ? n1[0] : 0];
      this.history.push(this.roundLog.slice());
      // 明轮结束：后手落子收手的那一刻，双方同时按各自最大连通块结算币。
      if (wasOpen && this.o.coinFromBlob) {
        this.coins[0] += big[0];
        this.coins[1] += big[1];
        this.lastIncome = big.slice();
        // 结算特效用：赚钱的那块具体是哪些格子（并列只取一块）。
        this.incomeSeq++;
        this.incomeFx.push({
          id: this.incomeSeq,
          cells: [blobCellsLargest(this.cells, this.size, 0), blobCellsLargest(this.cells, this.size, 1)],
          coins: big.slice()
        });
        this.roundLog.push({ t: 'income', coins: big.slice() });
      }
      // 盾：护过这一个明轮就到期（没过期是因为中间又进了暗轮，顺延）。
      if (wasOpen) {
        for (var i = this.shields.length - 1; i >= 0; i--) {
          this.shields[i].roundsLeft--;
          if (this.shields[i].roundsLeft <= 0) this.shields.splice(i, 1);
        }
        // 正辩的禁入点：封到本明轮结束就解封。
        this.zone = [];
        // 预选但没杀成的杀招：作废，不消耗（用户要求）。
        this.arm = [null, null];
      }
      if (this.round >= this.o.totalRounds) { this._finish('rounds'); return this.summary(); }
      this.round++;
      this.roundLog = [];
      this.pending = { openFirst: null, hidden: [null, null], hidden2: [null, null], passed: [false, false] };
      this.first = null;
      this.gaveFirst = false;
      this.frame = null;            // 5×5 框一轮一清
      this.markN = 0;
      this.markDone = [true, true];
      // 复生绿 × 到期检查：顶过这一轮就散
      for (var gp = 0; gp < 2; gp++) {
        if (this.greenFu[gp] && this.round > this.greenFu[gp].until) this.greenFu[gp] = null;
      }
      // 拂尘升级后的充能：冷却 3 轮（明暗都在走），满了就 +1，上限 3。
      for (var cp = 0; cp < 2; cp++) {
        if (this.fuchenCharge[cp] == null) continue;
        if (this.fuchenCharge[cp] >= 3) continue;
        this.fuchenCd[cp] -= 1;
        if (this.fuchenCd[cp] <= 0) {
          this.fuchenCharge[cp] += 1;
          this.fuchenCd[cp] = 3;
        }
      }
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
        this.pending.hidden = [null, null];
        this.pending.hidden2 = [null, null];
        this.pending.passed = [false, false];
        this._flash('an');
      } else {
        // 进入竞拍：双方各 +1 气（到上限就浪费）。第 1 轮在构造函数里已经发过。
        this._gainQi(0, this.o.qiPerRound);
        this._gainQi(1, this.o.qiPerRound);
        this.roundMode = 'pending';
        this.phase = 'auction';
        this._flash('duo');
      }
      return null;
    },

    // 认输：直接判负，不用打完。对手赢。
    resign: function (p) {
      if (this.over) throw new Error('game over');
      this.over = true;
      this.endReason = 'resign';
      this.finalBlobs = [this.blobs(0), this.blobs(1)];
      this.finalScore = [this.finalBlobs[0][0] || 0, this.finalBlobs[1][0] || 0];
      this.winner = 1 - p;
      this.phase = 'over';
      this.roundLog.push({ t: 'resign', p: p });
      this._flash('zhong');
      return this.summary();
    },

    _finish: function (reason) {
      this.over = true;
      this.endReason = reason;
      this.finalBlobs = [this.blobs(0), this.blobs(1)];
      this.finalScore = [this.finalBlobs[0][0] || 0, this.finalBlobs[1][0] || 0];
      this.winner = compareBlobs(this.finalBlobs[0], this.finalBlobs[1]) > 0 ? 0
        : compareBlobs(this.finalBlobs[1], this.finalBlobs[0]) > 0 ? 1 : -1;
      this.phase = 'over';
      // 终局大字：跟开局那条「对弈开始」对称，势均力敌就叫「和局」
      this._flash(this.winner === -1 ? 'he' : 'zhong');
    },

    summary: function () {
      return {
        over: this.over, reason: this.endReason, winner: this.winner,
        score: this.finalScore || [this.score(0), this.score(1)],
        blobs: this.finalBlobs || [this.blobs(0), this.blobs(1)],
        ash: this.ashCount, rounds: this.round,
        coins: this.coins.slice(), qi: this.qi.slice(), qiCap: this.qiCap.slice(),
        kill: this.killCount.slice(),
        jie: this.jieCount.slice(),
        items: [this.items[0].slice(), this.items[1].slice()],
        shields: [this.shieldOf(0), this.shieldOf(1)],
        champ: [this.champ[0].id, this.champ[1].id],
        skillWaits: [this._waitsOf(0), this._waitsOf(1)]
      };
    },
    _waitsOf: function (p) {
      var out = [];
      var list = this.skillsOf(p);
      for (var k = 0; k < list.length; k++) out.push(this.skillWait(p, k));
      return out;
    }
  };

  return {
    Game: Game,
    EMPTY: EMPTY, BLACK: BLACK, WHITE: WHITE, ASH: ASH, YINYANG: YINYANG,
    blobsSizes: blobsSizes,
    blobCellsLargest: blobCellsLargest,
    compareBlobs: compareBlobs,
    CHAMPIONS: CHAMPIONS,
    champOf: champOf,
    ITEMS: ITEMS,
    itemOf: itemOf,
    MODES: MODES,
    modeOf: modeOf,
    DEFAULTS: DEFAULTS
  };
});
