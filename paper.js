/* Browser-only simulated futures wallet. Never places real orders. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.PaperWallet = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var STORAGE_KEY = "zigzag-swing-alert-paper-v1";
  var LEGACY_STORAGE_KEY = "adx-alert-paper-v1";
  var STARTING_BALANCE = 10000;
  var TAKER_FEE = 0.0004;
  var MAX_TRADES = 200;
  var DEFAULTS = {
    slPct: 1.5,
    tpPct: 3,
    leverage: 5,
    margin: 100,
    shorts: true,
    structureFilter: false,
    reversalPct: 1.5,
  };

  function nowMs() {
    return Date.now();
  }

  function round(x, n) {
    var p = Math.pow(10, n == null ? 8 : n);
    return Math.round(x * p) / p;
  }

  function clampParams(raw) {
    raw = raw || {};
    var leverage = Math.round(Number(raw.leverage));
    if (!isFinite(leverage)) leverage = DEFAULTS.leverage;
    leverage = Math.min(50, Math.max(1, leverage));
    var margin = Number(raw.margin);
    if (!isFinite(margin)) margin = DEFAULTS.margin;
    margin = Math.min(10000, Math.max(1, margin));
    var slPct = Number(raw.slPct);
    if (!isFinite(slPct)) slPct = DEFAULTS.slPct;
    slPct = Math.min(50, Math.max(0.1, slPct));
    var tpPct = Number(raw.tpPct);
    if (!isFinite(tpPct)) tpPct = DEFAULTS.tpPct;
    tpPct = Math.min(100, Math.max(0.1, tpPct));
    var reversalPct = Number(raw.reversalPct);
    if (!isFinite(reversalPct)) reversalPct = DEFAULTS.reversalPct;
    reversalPct = Math.min(10, Math.max(0.2, reversalPct));
    return {
      slPct: slPct,
      tpPct: tpPct,
      leverage: leverage,
      margin: margin,
      shorts: raw.shorts !== false,
      structureFilter: !!raw.structureFilter,
      reversalPct: reversalPct,
    };
  }

  function emptyState() {
    return {
      balance: STARTING_BALANCE,
      position: null,
      trades: [],
      params: clampParams(DEFAULTS),
      engineOn: false,
      lastPivotKey: "",
    };
  }

  function load() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY) || localStorage.getItem(LEGACY_STORAGE_KEY);
      if (!raw) return emptyState();
      var parsed = JSON.parse(raw);
      var s = emptyState();
      if (typeof parsed.balance === "number" && isFinite(parsed.balance)) s.balance = parsed.balance;
      if (parsed.position && parsed.position.symbol) s.position = parsed.position;
      if (Array.isArray(parsed.trades)) s.trades = parsed.trades.slice(0, MAX_TRADES);
      s.params = clampParams(parsed.params || DEFAULTS);
      s.engineOn = false;
      s.lastPivotKey = parsed.lastPivotKey || "";
      return s;
    } catch (e) {
      return emptyState();
    }
  }

  function save(state) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        balance: state.balance,
        position: state.position,
        trades: state.trades,
        params: state.params,
        lastPivotKey: state.lastPivotKey,
      }));
    } catch (e) { /* ignore quota / private mode */ }
  }

  function reset(state) {
    var params = state && state.params ? clampParams(state.params) : clampParams(DEFAULTS);
    var next = emptyState();
    next.params = params;
    save(next);
    return next;
  }

  function unrealized(position, price) {
    if (!position || !price) return 0;
    var dir = position.side === "SHORT" ? -1 : 1;
    return (price - position.entry) * position.qty * dir;
  }

  function equity(state, price) {
    return state.balance + unrealized(state.position, price);
  }

  function feeFor(notional) {
    return notional * TAKER_FEE;
  }

  function slTpPrices(side, entry, slPct, tpPct) {
    var sl = slPct / 100;
    var tp = tpPct / 100;
    if (side === "SHORT") {
      return { sl: entry * (1 + sl), tp: entry * (1 - tp) };
    }
    return { sl: entry * (1 - sl), tp: entry * (1 + tp) };
  }

  function pivotKey(symbol, tf, pivot) {
    return symbol + "|" + tf + "|" + pivot.type + "|" + pivot.time;
  }

  function canOpen(state, side, params) {
    if (state.position) return "Already in a paper position.";
    if (side === "SHORT" && !params.shorts) return "Shorts are disabled.";
    if (state.balance < params.margin) return "Not enough paper balance for margin.";
    return null;
  }

  function openPosition(state, opts) {
    var params = state.params;
    var block = canOpen(state, opts.side, params);
    if (block) return { ok: false, reason: block };
    var entry = Number(opts.price);
    if (!entry || entry <= 0) return { ok: false, reason: "No entry price." };
    var notional = params.margin * params.leverage;
    var qty = notional / entry;
    var fee = feeFor(notional);
    if (state.balance < params.margin + fee) return { ok: false, reason: "Balance cannot cover margin and fee." };
    var levels = slTpPrices(opts.side, entry, params.slPct, params.tpPct);
    state.balance -= params.margin + fee;
    state.position = {
      id: "p" + nowMs(),
      symbol: opts.symbol,
      tf: opts.tf,
      side: opts.side,
      entry: entry,
      qty: qty,
      margin: params.margin,
      leverage: params.leverage,
      sl: levels.sl,
      tp: levels.tp,
      feeOpen: fee,
      openedAt: nowMs(),
      reason: opts.reason || "ZigZag",
    };
    save(state);
    return { ok: true, position: state.position };
  }

  function closePosition(state, opts) {
    var pos = state.position;
    if (!pos) return { ok: false, reason: "No open position." };
    var exit = Number(opts.price);
    if (!exit || exit <= 0) return { ok: false, reason: "No exit price." };
    var pnl = unrealized(pos, exit);
    var notional = pos.qty * exit;
    var fee = feeFor(notional);
    var returned = pos.margin + pnl - fee;
    state.balance += returned;
    var trade = {
      id: pos.id,
      symbol: pos.symbol,
      tf: pos.tf,
      side: pos.side,
      entry: pos.entry,
      exit: exit,
      qty: pos.qty,
      margin: pos.margin,
      leverage: pos.leverage,
      pnl: round(pnl - fee - pos.feeOpen, 4),
      reason: pos.reason,
      exitReason: opts.reason || "Close",
      openedAt: pos.openedAt,
      closedAt: nowMs(),
    };
    state.trades.unshift(trade);
    if (state.trades.length > MAX_TRADES) state.trades.length = MAX_TRADES;
    state.position = null;
    save(state);
    return { ok: true, trade: trade };
  }

  /**
   * Check SL, TP, or isolated liquidation against a price or a closed/forming bar.
   * If a bar is given, a wick through the level exits. If both SL and TP trade in
   * the same bar, the stop is taken (conservative).
   */
  function manage(state, price, bar) {
    var pos = state.position;
    if (!pos) return null;
    var high = bar ? Number(bar.high) : price;
    var low = bar ? Number(bar.low) : price;
    var last = price != null ? price : (bar ? Number(bar.close) : null);
    if (last == null) return null;

    var liqMove = 1 / pos.leverage;
    var liq = pos.side === "SHORT" ? pos.entry * (1 + liqMove * 0.9) : pos.entry * (1 - liqMove * 0.9);

    if (pos.side === "LONG") {
      if (low <= liq) return closePosition(state, { price: liq, reason: "Liquidation" });
      if (low <= pos.sl) return closePosition(state, { price: pos.sl, reason: "Stop loss" });
      if (high >= pos.tp) return closePosition(state, { price: pos.tp, reason: "Take profit" });
    } else {
      if (high >= liq) return closePosition(state, { price: liq, reason: "Liquidation" });
      if (high >= pos.sl) return closePosition(state, { price: pos.sl, reason: "Stop loss" });
      if (low <= pos.tp) return closePosition(state, { price: pos.tp, reason: "Take profit" });
    }
    return null;
  }

  return {
    STORAGE_KEY: STORAGE_KEY,
    STARTING_BALANCE: STARTING_BALANCE,
    TAKER_FEE: TAKER_FEE,
    DEFAULTS: DEFAULTS,
    clampParams: clampParams,
    emptyState: emptyState,
    load: load,
    save: save,
    reset: reset,
    unrealized: unrealized,
    equity: equity,
    slTpPrices: slTpPrices,
    pivotKey: pivotKey,
    canOpen: canOpen,
    openPosition: openPosition,
    closePosition: closePosition,
    manage: manage,
    round: round,
  };
});
