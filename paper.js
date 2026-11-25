/* Browser-only simulated futures wallet. Never places real orders.
   Rules match ZigZag Paper Bot: long on LL only if RSI(14) < 32,
   short on HH only if RSI(14) > 68; exit +TP or HH/LL (LH/HL ignored).
   No stop-loss by default. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.PaperWallet = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var STORAGE_KEY = "zigzag-paper-bot-v2";
  var LEGACY_STORAGE_KEYS = ["zigzag-paper-bot-v1", "zigzag-swing-alert-paper-v1", "adx-alert-paper-v1"];
  var STARTING_BALANCE = 200;
  var TAKER_FEE = 0.0004;
  var MAX_TRADES = 200;
  var BOT_COINS = ["NEARUSDT", "INJUSDT", "RENDERUSDT", "FETUSDT", "ARBUSDT"];
  var DEFAULTS = {
    slPct: 0,
    tpPct: 3,
    leverage: 1,
    margin: 200,
    shorts: true,
    reversalPct: 1.5,
  };
  var RSI_PERIOD = 14;
  var RSI_LONG_MAX = 32;
  var RSI_SHORT_MIN = 68;

  function nowMs() {
    return Date.now();
  }

  function round(x, n) {
    var p = Math.pow(10, n == null ? 8 : n);
    return Math.round(x * p) / p;
  }

  function notionalOf(params) {
    return params.margin * params.leverage;
  }

  function emptyPositions() {
    var pos = {};
    BOT_COINS.forEach(function (c) { pos[c] = null; });
    return pos;
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
    if (!isFinite(slPct) || slPct < 0) slPct = DEFAULTS.slPct;
    slPct = Math.min(50, Math.max(0, slPct));
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
      reversalPct: reversalPct,
    };
  }

  function emptyState() {
    return {
      balance: STARTING_BALANCE,
      positions: emptyPositions(),
      trades: [],
      params: clampParams(DEFAULTS),
      engineOn: false,
      lastProcessed: {},
      lastPrices: {},
      nextTradeId: 1,
    };
  }

  function normalizeLoaded(parsed) {
    var s = emptyState();
    if (typeof parsed.balance === "number" && isFinite(parsed.balance)) s.balance = parsed.balance;
    if (Array.isArray(parsed.trades)) s.trades = parsed.trades.slice(0, MAX_TRADES);
    s.params = clampParams(parsed.params || DEFAULTS);
    s.engineOn = false;
    s.lastProcessed = parsed.lastProcessed && typeof parsed.lastProcessed === "object" ? parsed.lastProcessed : {};
    s.lastPrices = parsed.lastPrices && typeof parsed.lastPrices === "object" ? parsed.lastPrices : {};
    s.nextTradeId = parsed.nextTradeId || (s.trades.length + 1);
    if (parsed.positions && typeof parsed.positions === "object" && !parsed.position) {
      Object.keys(parsed.positions).forEach(function (sym) {
        s.positions[sym] = parsed.positions[sym] || null;
      });
    } else if (parsed.position && parsed.position.symbol) {
      s.positions[parsed.position.symbol] = parsed.position;
    }
    return s;
  }

  function load() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return emptyState();
      return normalizeLoaded(JSON.parse(raw));
    } catch (e) {
      return emptyState();
    }
  }

  function save(state) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        balance: state.balance,
        positions: state.positions,
        trades: state.trades,
        params: state.params,
        lastProcessed: state.lastProcessed,
        lastPrices: state.lastPrices,
        nextTradeId: state.nextTradeId,
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

  function feeFor(notional) {
    return notional * TAKER_FEE;
  }

  function positionPnl(pos, price) {
    if (!pos || !price) return 0;
    var dir = pos.side === "SHORT" ? -1 : 1;
    var gross = (price - pos.entry) * pos.qty * dir;
    var exitFee = feeFor(pos.qty * price);
    return gross - (pos.feeOpen || 0) - exitFee;
  }

  function unrealized(position, price) {
    return positionPnl(position, price);
  }

  function openPositions(state) {
    var list = [];
    var positions = (state && state.positions) || {};
    Object.keys(positions).forEach(function (sym) {
      if (positions[sym]) list.push(positions[sym]);
    });
    return list;
  }

  function equity(state, priceMap) {
    var eq = state.balance;
    openPositions(state).forEach(function (pos) {
      var px = priceMap && priceMap[pos.symbol] != null ? priceMap[pos.symbol] : null;
      if (px == null && state.lastPrices) px = state.lastPrices[pos.symbol];
      eq += unrealized(pos, px);
    });
    return eq;
  }

  function slTpPrices(side, entry, slPct, tpPct) {
    var tp = tpPct / 100;
    var sl = slPct > 0 ? slPct / 100 : 0;
    if (side === "SHORT") {
      return { sl: sl > 0 ? entry * (1 + sl) : null, tp: entry * (1 - tp) };
    }
    return { sl: sl > 0 ? entry * (1 - sl) : null, tp: entry * (1 + tp) };
  }


  function rsiWilder(candles, period) {
    period = period || RSI_PERIOD;
    var points = [];
    if (!candles || candles.length < period + 1) return points;
    var avgGain = 0;
    var avgLoss = 0;
    var i;
    for (i = 1; i <= period; i++) {
      var seed = candles[i].close - candles[i - 1].close;
      if (seed > 0) avgGain += seed;
      else avgLoss -= seed;
    }
    avgGain /= period;
    avgLoss /= period;
    function valueOf(gain, loss) {
      if (loss === 0) return 100;
      if (gain === 0) return 0;
      return 100 - 100 / (1 + gain / loss);
    }
    points.push({ time: candles[period].time, value: valueOf(avgGain, avgLoss) });
    for (i = period + 1; i < candles.length; i++) {
      var change = candles[i].close - candles[i - 1].close;
      var gain = change > 0 ? change : 0;
      var loss = change < 0 ? -change : 0;
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      points.push({ time: candles[i].time, value: valueOf(avgGain, avgLoss) });
    }
    return points;
  }

  function rsiByTime(candles, period) {
    var map = {};
    rsiWilder(candles, period || RSI_PERIOD).forEach(function (p) { map[p.time] = p.value; });
    return map;
  }

  function rsiEntryOk(side, rsi) {
    if (rsi == null || !isFinite(rsi)) return { ok: false, note: "RSI n/a" };
    if (side === "LONG") {
      var okL = rsi < RSI_LONG_MAX;
      return { ok: okL, note: "RSI " + rsi.toFixed(2) + (okL ? " < " : " not < ") + RSI_LONG_MAX };
    }
    if (side === "SHORT") {
      var okS = rsi > RSI_SHORT_MIN;
      return { ok: okS, note: "RSI " + rsi.toFixed(2) + (okS ? " > " : " not > ") + RSI_SHORT_MIN };
    }
    return { ok: false, note: "no side" };
  }

  function entrySide(pivot) {
    if (!pivot) return null;
    if (pivot.label === "LL" && pivot.type === "LOW") return "LONG";
    if (pivot.label === "HH" && pivot.type === "HIGH") return "SHORT";
    return null;
  }

  function structureExitReason(side, pivot) {
    var label = (pivot && pivot.label) || "";
    if (side === "LONG" && pivot.type === "HIGH" && label === "HH") return "HH";
    if (side === "SHORT" && pivot.type === "LOW" && label === "LL") return "LL";
    return null;
  }

  function tpHit(pos, bar) {
    if (pos.side === "LONG") return bar.high >= pos.tp;
    return bar.low <= pos.tp;
  }

  function slHit(pos, bar) {
    if (pos.sl == null) return false;
    if (pos.side === "LONG") return bar.low <= pos.sl;
    return bar.high >= pos.sl;
  }

  function openPosition(state, opts) {
    var params = state.params;
    var symbol = opts.symbol;
    if (state.positions[symbol]) return { ok: false, reason: "Already in a paper position on " + symbol + "." };
    if (opts.side === "SHORT" && !params.shorts) return { ok: false, reason: "Shorts are disabled." };
    var entry = Number(opts.price);
    if (!entry || entry <= 0) return { ok: false, reason: "No entry price." };
    var notional = notionalOf(params);
    var qty = notional / entry;
    var fee = feeFor(notional);
    var levels = slTpPrices(opts.side, entry, params.slPct, params.tpPct);
    var pos = {
      id: "p" + (state.nextTradeId++),
      symbol: symbol,
      tf: opts.tf || "15m",
      side: opts.side,
      entry: entry,
      qty: qty,
      notional: notional,
      margin: params.margin,
      leverage: params.leverage,
      sl: levels.sl,
      tp: levels.tp,
      feeOpen: fee,
      openedAt: nowMs(),
      entryTime: opts.bar && opts.bar.time != null ? opts.bar.time : null,
      reason: opts.reason || "ZigZag",
    };
    if (!state.positions) state.positions = emptyPositions();
    state.positions[symbol] = pos;
    save(state);
    return { ok: true, position: pos };
  }

  function closePosition(state, opts) {
    var symbol = opts.symbol;
    if (!symbol && opts.position) symbol = opts.position.symbol;
    var pos = symbol ? (state.positions || {})[symbol] : null;
    if (!pos) return { ok: false, reason: "No open position." };
    var exit = Number(opts.price);
    if (!exit || exit <= 0) return { ok: false, reason: "No exit price." };
    var pnl = positionPnl(pos, exit);
    state.balance = round(state.balance + pnl, 8);
    var trade = {
      id: pos.id,
      symbol: pos.symbol,
      tf: pos.tf,
      side: pos.side,
      entry: pos.entry,
      exit: exit,
      qty: pos.qty,
      notional: pos.notional,
      margin: pos.margin,
      leverage: pos.leverage,
      pnl: round(pnl, 4),
      reason: pos.reason,
      exitReason: opts.reason || "Close",
      openedAt: pos.openedAt,
      closedAt: nowMs(),
    };
    state.trades.unshift(trade);
    if (state.trades.length > MAX_TRADES) state.trades.length = MAX_TRADES;
    state.positions[symbol] = null;
    save(state);
    return { ok: true, trade: trade };
  }

  function flattenAll(state, priceMap) {
    var results = [];
    openPositions(state).forEach(function (pos) {
      var px = priceMap && priceMap[pos.symbol] != null ? priceMap[pos.symbol] : pos.entry;
      var closed = closePosition(state, { symbol: pos.symbol, price: px, reason: "Manual flatten" });
      if (closed.ok) results.push(closed);
    });
    return results;
  }

  /**
   * Apply TP, optional SL, then structure exits, then entries, on one closed candle.
   * SL (if enabled) is taken first when both SL and TP trade in the same bar.
   * A position opened on this bar is not checked for TP or structure on the same bar.
   * After an exit, only an opposite-side entry on this same candle is taken.
   */
  function processBar(state, symbol, bar, confirmed, tf, rsi) {
    var events = [];
    var params = state.params;
    var position = (state.positions || {})[symbol] || null;
    var exitSide = null;

    if (position) {
      if (slHit(position, bar)) {
        var slClose = closePosition(state, { symbol: symbol, price: position.sl, reason: "Stop loss" });
        if (slClose.ok) {
          events.push({ type: "close", trade: slClose.trade });
          exitSide = slClose.trade.side;
          position = null;
        }
      } else if (tpHit(position, bar)) {
        var tpClose = closePosition(state, { symbol: symbol, price: position.tp, reason: "TP" });
        if (tpClose.ok) {
          events.push({ type: "close", trade: tpClose.trade });
          exitSide = tpClose.trade.side;
          position = null;
        }
      } else {
        var i;
        for (i = 0; i < (confirmed || []).length; i++) {
          var reason = structureExitReason(position.side, confirmed[i]);
          if (!reason) continue;
          var stClose = closePosition(state, { symbol: symbol, price: bar.close, reason: reason });
          if (stClose.ok) {
            events.push({ type: "close", trade: stClose.trade });
            exitSide = stClose.trade.side;
            position = null;
          }
          break;
        }
      }
    }

    if (!((state.positions || {})[symbol])) {
      var j;
      for (j = 0; j < (confirmed || []).length; j++) {
        var pivot = confirmed[j];
        var side = entrySide(pivot);
        if (!side) continue;
        if (exitSide && side === exitSide) continue;
        var check = rsiEntryOk(side, rsi);
        if (!check.ok) {
          events.push({ type: "skip", side: side, symbol: symbol, pivot: pivot, rsi: rsi, reason: check.note });
          continue;
        }
        var opened = openPosition(state, {
          symbol: symbol,
          tf: tf || "15m",
          side: side,
          price: bar.close,
          bar: bar,
          reason: "ZigZag " + (pivot.label || pivot.type) + " " + check.note,
        });
        if (opened.ok) {
          opened.position.entryRsi = rsi;
          events.push({ type: exitSide && side !== exitSide ? "reverse" : "open", position: opened.position, pivot: pivot, rsi: rsi });
        }
        break;
      }
    }
    return events;
  }

  function walkSymbol(state, symbol, candles, pivots, tf) {
    var events = [];
    if (!candles || !candles.length) return events;
    var byConfirm = {};
    (pivots || []).forEach(function (p) {
      var t = p.confirmTime;
      if (t == null) return;
      if (!byConfirm[t]) byConfirm[t] = [];
      byConfirm[t].push(p);
    });
    if (!state.lastProcessed) state.lastProcessed = {};
    if (!state.lastPrices) state.lastPrices = {};
    var startAfter = state.lastProcessed[symbol];
    if (startAfter == null) {
      state.lastProcessed[symbol] = candles[candles.length - 1].time;
      state.lastPrices[symbol] = candles[candles.length - 1].close;
      return events;
    }
    var rsiMap = rsiByTime(candles, RSI_PERIOD);
    var i;
    for (i = 0; i < candles.length; i++) {
      var bar = candles[i];
      if (bar.time <= startAfter) continue;
      events = events.concat(processBar(state, symbol, bar, byConfirm[bar.time] || [], tf, rsiMap[bar.time]));
      state.lastProcessed[symbol] = bar.time;
      state.lastPrices[symbol] = bar.close;
    }
    return events;
  }

  return {
    STORAGE_KEY: STORAGE_KEY,
    LEGACY_STORAGE_KEYS: LEGACY_STORAGE_KEYS,
    STARTING_BALANCE: STARTING_BALANCE,
    TAKER_FEE: TAKER_FEE,
    DEFAULTS: DEFAULTS,
    BOT_COINS: BOT_COINS,
    clampParams: clampParams,
    emptyState: emptyState,
    load: load,
    save: save,
    reset: reset,
    unrealized: unrealized,
    equity: equity,
    slTpPrices: slTpPrices,
    notionalOf: notionalOf,
    entrySide: entrySide,
    structureExitReason: structureExitReason,
    openPositions: openPositions,
    openPosition: openPosition,
    closePosition: closePosition,
    flattenAll: flattenAll,
    processBar: processBar,
    walkSymbol: walkSymbol,
    rsiWilder: rsiWilder,
    rsiByTime: rsiByTime,
    rsiEntryOk: rsiEntryOk,
    RSI_PERIOD: RSI_PERIOD,
    RSI_LONG_MAX: RSI_LONG_MAX,
    RSI_SHORT_MIN: RSI_SHORT_MIN,
    round: round,
  };
});
