/* Non-repainting, bar-close ZigZag with HH/HL/LH/LL structure labels. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.ZigZag = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var DEFAULT_REVERSAL = 1.5;
  var COINS = ["NEARUSDT", "INJUSDT", "RENDERUSDT", "FETUSDT", "ARBUSDT"];
  var TOP_COINS = [
    "BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT", "ADAUSDT", "AVAXUSDT", "LINKUSDT", "SUIUSDT",
    "DOTUSDT", "LTCUSDT", "BCHUSDT", "UNIUSDT", "ATOMUSDT", "NEARUSDT", "FILUSDT", "APTUSDT", "ARBUSDT", "OPUSDT",
    "INJUSDT", "TIAUSDT", "SEIUSDT", "WLDUSDT", "1000PEPEUSDT", "1000SHIBUSDT", "FETUSDT", "RENDERUSDT", "TAOUSDT", "AAVEUSDT",
    "LDOUSDT", "ONDOUSDT", "ENAUSDT", "WIFUSDT", "1000BONKUSDT", "TRXUSDT", "HBARUSDT", "ICPUSDT", "ETCUSDT", "XLMUSDT",
    "TONUSDT", "POLUSDT", "ORDIUSDT", "JUPUSDT", "PENDLEUSDT", "STXUSDT", "RUNEUSDT", "GRTUSDT", "ALGOUSDT", "CRVUSDT"
  ];
  var ALL_COINS = (function () {
    var seen = {};
    var out = [];
    COINS.concat(TOP_COINS).forEach(function (s) {
      if (!seen[s]) { seen[s] = true; out.push(s); }
    });
    return out;
  })();
  var TIMEFRAMES = ["1m", "5m", "15m", "1h", "4h"];
  var TF = "15m";
  var TF_STORAGE_KEY = "zigzag-swing-alert-tf";
  var TF_STORAGE_KEY_LEGACY = "adx-alert-tf";

  function clampReversal(pct) {
    var n = Number(pct);
    if (!isFinite(n)) return DEFAULT_REVERSAL;
    return Math.min(10, Math.max(0.2, n));
  }

  function closedKlines(klines, dropOpen) {
    var k = klines || [];
    if (dropOpen && k.length) {
      var lastClose = Number(k[k.length - 1][6]);
      if (lastClose >= Date.now()) k = k.slice(0, -1);
    }
    return k;
  }

  function rowsToCandles(rows) {
    return (rows || []).map(function (row) {
      return {
        time: Math.floor(Number(row[0]) / 1000),
        open: Number(row[1]),
        high: Number(row[2]),
        low: Number(row[3]),
        close: Number(row[4]),
        closeTime: Number(row[6]),
      };
    });
  }

  /**
   * candles: [{time, open, high, low, close, closeTime?}] already closed only.
   * reversalPct: percent move from the running extreme that confirms a pivot.
   */
  function compute(candles, reversalPct) {
    var dev = clampReversal(reversalPct);
    var empty = {
      pivots: [],
      active: null,
      dir: 0,
      trigger: null,
      trend: "—",
      trendKind: "",
      reversalPct: dev,
    };
    if (!candles || candles.length < 2) return empty;

    var pivots = [];
    var dir = 0;
    var extremeHigh = candles[0].high;
    var extremeLow = candles[0].low;
    var lastHighIdx = 0;
    var lastLowIdx = 0;
    var i, bar, last;

    for (i = 1; i < candles.length; i++) {
      bar = candles[i];
      if (dir === 0) {
        if (bar.high >= extremeHigh) {
          extremeHigh = bar.high;
          lastHighIdx = i;
        }
        if (bar.low <= extremeLow) {
          extremeLow = bar.low;
          lastLowIdx = i;
        }
        if ((bar.high - extremeLow) / extremeLow * 100 >= dev) {
          pivots.push(makePivot("LOW", lastLowIdx, extremeLow, candles[lastLowIdx], bar));
          dir = 1;
          extremeHigh = bar.high;
          lastHighIdx = i;
        } else if ((extremeHigh - bar.low) / extremeHigh * 100 >= dev) {
          pivots.push(makePivot("HIGH", lastHighIdx, extremeHigh, candles[lastHighIdx], bar));
          dir = -1;
          extremeLow = bar.low;
          lastLowIdx = i;
        }
        continue;
      }
      if (dir === 1) {
        if (bar.high >= extremeHigh) {
          extremeHigh = bar.high;
          lastHighIdx = i;
        }
        if ((extremeHigh - bar.low) / extremeHigh * 100 >= dev) {
          pivots.push(makePivot("HIGH", lastHighIdx, extremeHigh, candles[lastHighIdx], bar));
          dir = -1;
          extremeLow = bar.low;
          lastLowIdx = i;
        }
      } else {
        if (bar.low <= extremeLow) {
          extremeLow = bar.low;
          lastLowIdx = i;
        }
        if ((bar.high - extremeLow) / extremeLow * 100 >= dev) {
          pivots.push(makePivot("LOW", lastLowIdx, extremeLow, candles[lastLowIdx], bar));
          dir = 1;
          extremeHigh = bar.high;
          lastHighIdx = i;
        }
      }
    }

    labelStructure(pivots);

    var active = null;
    var trigger = null;
    last = pivots.length ? pivots[pivots.length - 1] : null;
    if (last && dir === 1) {
      active = {
        from: last,
        type: "HIGH",
        price: extremeHigh,
        index: lastHighIdx,
        time: candles[lastHighIdx].time,
      };
      trigger = extremeHigh * (1 - dev / 100);
    } else if (last && dir === -1) {
      active = {
        from: last,
        type: "LOW",
        price: extremeLow,
        index: lastLowIdx,
        time: candles[lastLowIdx].time,
      };
      trigger = extremeLow * (1 + dev / 100);
    }

    var trendInfo = describeTrend(pivots, dir);
    return {
      pivots: pivots,
      active: active,
      dir: dir,
      trigger: trigger,
      trend: trendInfo.label,
      trendKind: trendInfo.kind,
      reversalPct: dev,
    };
  }

  function makePivot(type, index, price, candle, confirmCandle) {
    return {
      type: type,
      index: index,
      price: price,
      time: candle.time,
      closeTime: candle.closeTime,
      confirmTime: confirmCandle ? confirmCandle.time : candle.time,
      confirmCloseTime: confirmCandle ? confirmCandle.closeTime : candle.closeTime,
      label: "",
    };
  }

  function labelStructure(pivots) {
    var lastHigh = null;
    var lastLow = null;
    for (var i = 0; i < pivots.length; i++) {
      var p = pivots[i];
      if (p.type === "HIGH") {
        if (lastHigh) p.label = p.price > lastHigh.price ? "HH" : "LH";
        lastHigh = p;
      } else {
        if (lastLow) p.label = p.price > lastLow.price ? "HL" : "LL";
        lastLow = p;
      }
    }
  }

  function lastOfType(pivots, type) {
    for (var i = pivots.length - 1; i >= 0; i--) {
      if (pivots[i].type === type && pivots[i].label) return pivots[i];
    }
    return null;
  }

  function describeTrend(pivots, dir) {
    var high = lastOfType(pivots, "HIGH");
    var low = lastOfType(pivots, "LOW");
    if (high && low) {
      if (high.label === "HH" && low.label === "HL") {
        return { label: "Uptrend (HH / HL)", kind: "up" };
      }
      if (high.label === "LH" && low.label === "LL") {
        return { label: "Downtrend (LH / LL)", kind: "down" };
      }
      return { label: "Transition", kind: "range" };
    }
    if (dir === 1) return { label: "Up leg (unconfirmed)", kind: "up" };
    if (dir === -1) return { label: "Down leg (unconfirmed)", kind: "down" };
    return { label: "Building…", kind: "" };
  }

  /* A newly confirmed pivot is a signal. Long on confirmed LOW, short on confirmed HIGH. */
  function signalForPivot(pivot) {
    if (!pivot) return null;
    if (pivot.type === "LOW") return { side: "LONG", signal: "long", pivot: pivot };
    if (pivot.type === "HIGH") return { side: "SHORT", signal: "short", pivot: pivot };
    return null;
  }

  function structureAllows(pivot, shortsEnabled) {
    if (!pivot) return false;
    if (pivot.type === "LOW") return pivot.label === "HL";
    if (pivot.type === "HIGH") return shortsEnabled && pivot.label === "LH";
    return false;
  }

  function linePoints(zz) {
    return zz.pivots.map(function (p) {
      return { time: p.time, value: p.price };
    });
  }

  function activePoints(zz) {
    if (!zz.active || !zz.active.from) return [];
    var a = zz.active;
    if (a.time <= a.from.time) return [];
    return [
      { time: a.from.time, value: a.from.price },
      { time: a.time, value: a.price },
    ];
  }

  function pivotKey(symbol, tf, pivot) {
    return symbol + "|" + tf + "|" + pivot.type + "|" + pivot.time;
  }

  function formatWib(closeTimeMs) {
    var d = new Date(closeTimeMs + 1 + 7 * 3600 * 1000);
    var y = d.getUTCFullYear();
    var mo = String(d.getUTCMonth() + 1).padStart(2, "0");
    var da = String(d.getUTCDate()).padStart(2, "0");
    var hh = String(d.getUTCHours()).padStart(2, "0");
    var mm = String(d.getUTCMinutes()).padStart(2, "0");
    return { date: y + "-" + mo + "-" + da, time: hh + ":" + mm, label: hh + ":" + mm, full: y + "-" + mo + "-" + da + " " + hh + ":" + mm };
  }

  function normalizeSymbol(raw) {
    if (!raw) return "NEARUSDT";
    var s = String(raw).trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!s) return "NEARUSDT";
    if (ALL_COINS.indexOf(s) !== -1) return s;
    if (ALL_COINS.indexOf(s + "USDT") !== -1) return s + "USDT";
    return null;
  }

  function normalizeTimeframe(raw) {
    if (!raw) return null;
    var s = String(raw).trim().toLowerCase();
    if (s === "15" || s === "15min") s = "15m";
    if (s === "5" || s === "5min") s = "5m";
    if (s === "1" || s === "1min") s = "1m";
    if (s === "60" || s === "60m") s = "1h";
    if (s === "240" || s === "240m") s = "4h";
    return TIMEFRAMES.indexOf(s) !== -1 ? s : null;
  }

  function shortName(symbol) {
    return String(symbol).replace(/USDT$/, "").replace(/^1000/, "1000");
  }

  function readSavedTf() {
    try {
      return normalizeTimeframe(localStorage.getItem(TF_STORAGE_KEY)) ||
        normalizeTimeframe(localStorage.getItem(TF_STORAGE_KEY_LEGACY));
    } catch (e) {
      return null;
    }
  }

  return {
    DEFAULT_REVERSAL: DEFAULT_REVERSAL,
    COINS: COINS,
    TOP_COINS: TOP_COINS,
    ALL_COINS: ALL_COINS,
    TIMEFRAMES: TIMEFRAMES,
    TF: TF,
    TF_STORAGE_KEY: TF_STORAGE_KEY,
    clampReversal: clampReversal,
    closedKlines: closedKlines,
    rowsToCandles: rowsToCandles,
    compute: compute,
    signalForPivot: signalForPivot,
    structureAllows: structureAllows,
    linePoints: linePoints,
    activePoints: activePoints,
    pivotKey: pivotKey,
    formatWib: formatWib,
    normalizeSymbol: normalizeSymbol,
    normalizeTimeframe: normalizeTimeframe,
    shortName: shortName,
    readSavedTf: readSavedTf,
  };
});
