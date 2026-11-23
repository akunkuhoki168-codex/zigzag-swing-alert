/* Non-repainting, bar-close ZigZag with HH/HL/LH/LL structure labels. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.ZigZag = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var DEFAULT_REVERSAL = 1.5;

  function clampReversal(pct) {
    var n = Number(pct);
    if (!isFinite(n)) return DEFAULT_REVERSAL;
    return Math.min(10, Math.max(0.2, n));
  }

  function movePct(from, to) {
    if (!from) return 0;
    return (Math.abs(to - from) / from) * 100;
  }

  /**
   * candles: [{time, open, high, low, close}] already closed only.
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
          pivots.push(makePivot("LOW", lastLowIdx, extremeLow, candles[lastLowIdx]));
          dir = 1;
          extremeHigh = bar.high;
          lastHighIdx = i;
        } else if ((extremeHigh - bar.low) / extremeHigh * 100 >= dev) {
          pivots.push(makePivot("HIGH", lastHighIdx, extremeHigh, candles[lastHighIdx]));
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
          pivots.push(makePivot("HIGH", lastHighIdx, extremeHigh, candles[lastHighIdx]));
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
          pivots.push(makePivot("LOW", lastLowIdx, extremeLow, candles[lastLowIdx]));
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

  function makePivot(type, index, price, candle) {
    return {
      type: type,
      index: index,
      price: price,
      time: candle.time,
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
      var bullish = (high.label === "HH" || high.label === "HL") && (low.label === "HH" || low.label === "HL");
      var bearish = (high.label === "LH" || high.label === "LL") && (low.label === "LH" || low.label === "LL");
      /* Highs are HH/LH, lows are HL/LL. */
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
    if (pivot.type === "LOW") return { side: "LONG", pivot: pivot };
    if (pivot.type === "HIGH") return { side: "SHORT", pivot: pivot };
    return null;
  }

  function structureAllows(pivot, shortsEnabled) {
    if (!pivot) return false;
    if (pivot.type === "LOW") return pivot.label === "HL";
    if (pivot.type === "HIGH") return shortsEnabled && pivot.label === "LH";
    return false;
  }

  function linePoints(zz) {
    var pts = zz.pivots.map(function (p) {
      return { time: p.time, value: p.price };
    });
    return pts;
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

  return {
    DEFAULT_REVERSAL: DEFAULT_REVERSAL,
    clampReversal: clampReversal,
    movePct: movePct,
    compute: compute,
    signalForPivot: signalForPivot,
    structureAllows: structureAllows,
    linePoints: linePoints,
    activePoints: activePoints,
  };
});
