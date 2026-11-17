/* ADX(14) + DMI with Wilder smoothing. Must stay in lockstep with the 1-minute ADX scanner (Wilder ADX/DMI). */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.AdxAlert = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var COINS = ["NEARUSDT", "INJUSDT", "RENDERUSDT", "FETUSDT", "ARBUSDT"];
  var TF = "1m";
  var N = 14;
  var ADX_LEVEL = 25;

  function wilder(x, n) {
    var out = new Array(x.length);
    var i;
    for (i = 0; i < x.length; i++) out[i] = null;
    var s = 0;
    for (i = 1; i <= n; i++) s += x[i];
    out[n] = s;
    for (i = n + 1; i < x.length; i++) {
      s = s - s / n + x[i];
      out[i] = s;
    }
    return out;
  }

  /* klines: Binance arrays. If dropOpen is true, strip a still-forming last bar (REST + live). */
  function compute(klines, dropOpen) {
    var k = klines;
    if (dropOpen && k.length) {
      var lastClose = Number(k[k.length - 1][6]);
      if (lastClose >= Date.now()) k = k.slice(0, -1);
    }
    var len = k.length;
    var h = new Array(len);
    var l = new Array(len);
    var c = new Array(len);
    var i;
    for (i = 0; i < len; i++) {
      h[i] = Number(k[i][2]);
      l[i] = Number(k[i][3]);
      c[i] = Number(k[i][4]);
    }
    var tr = [0];
    var pdm = [0];
    var mdm = [0];
    for (i = 1; i < len; i++) {
      tr.push(Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])));
      var up = h[i] - h[i - 1];
      var dn = l[i - 1] - l[i];
      pdm.push(up > dn && up > 0 ? up : 0);
      mdm.push(dn > up && dn > 0 ? dn : 0);
    }
    var a = wilder(tr, N);
    var p = wilder(pdm, N);
    var m = wilder(mdm, N);
    var pdi = new Array(len);
    var mdi = new Array(len);
    var dx = new Array(len);
    for (i = 0; i < len; i++) {
      pdi[i] = null;
      mdi[i] = null;
      dx[i] = null;
    }
    for (i = N; i < len; i++) {
      pdi[i] = (100 * p[i]) / a[i];
      mdi[i] = (100 * m[i]) / a[i];
      dx[i] = pdi[i] + mdi[i] ? (100 * Math.abs(pdi[i] - mdi[i])) / (pdi[i] + mdi[i]) : 0;
    }
    var ad = new Array(len);
    for (i = 0; i < len; i++) ad[i] = null;
    if (len >= 2 * N) {
      var s = 0;
      for (i = N; i < 2 * N; i++) s += dx[i];
      ad[2 * N - 1] = s / N;
      for (i = 2 * N; i < len; i++) ad[i] = (ad[i - 1] * (N - 1) + dx[i]) / N;
    }
    return { klines: k, close: c, high: h, low: l, pdi: pdi, mdi: mdi, adx: ad };
  }

  /* Signal on a closed candle: ADX >= 25 and rising, plus a fresh DI cross or ADX crossing up through 25. */
  function isSignal(adx, pdi, mdi, j) {
    if (j < 1) return null;
    if (adx[j] == null || adx[j - 1] == null || pdi[j] == null || mdi[j] == null) return null;
    if (!(adx[j] >= ADX_LEVEL && adx[j] > adx[j - 1])) return null;
    if (pdi[j] > mdi[j] && (pdi[j - 1] <= mdi[j - 1] || adx[j - 1] < ADX_LEVEL)) return "LONG";
    if (mdi[j] > pdi[j] && (mdi[j - 1] <= pdi[j - 1] || adx[j - 1] < ADX_LEVEL)) return "SHORT";
    return null;
  }

  function findSignals(result) {
    var adx = result.adx;
    var pdi = result.pdi;
    var mdi = result.mdi;
    var close = result.close;
    var klines = result.klines;
    var out = [];
    for (var j = 1; j < adx.length; j++) {
      var sig = isSignal(adx, pdi, mdi, j);
      if (!sig) continue;
      var closeTime = Number(klines[j][6]);
      out.push({
        index: j,
        signal: sig,
        close: close[j],
        adx: adx[j],
        adxPrev: adx[j - 1],
        pdi: pdi[j],
        mdi: mdi[j],
        openTime: Number(klines[j][0]),
        closeTime: closeTime,
      });
    }
    return out;
  }

  /* Same window as scan.py: only the last 5 closed candles, last match wins. */
  function latestScanSignal(result) {
    var adx = result.adx;
    var pdi = result.pdi;
    var mdi = result.mdi;
    var start = adx.length - 5;
    var sig = null;
    var i = adx.length - 1;
    for (var j = start; j < adx.length; j++) {
      if (j < 1 || adx[j] == null || adx[j - 1] == null) continue;
      if (adx[j] >= ADX_LEVEL && adx[j] > adx[j - 1]) {
        if (pdi[j] > mdi[j] && (pdi[j - 1] <= mdi[j - 1] || adx[j - 1] < ADX_LEVEL)) {
          sig = "LONG";
          i = j;
        }
        if (mdi[j] > pdi[j] && (mdi[j - 1] <= pdi[j - 1] || adx[j - 1] < ADX_LEVEL)) {
          sig = "SHORT";
          i = j;
        }
      }
    }
    if (!sig) return null;
    return {
      index: i,
      signal: sig,
      close: result.close[i],
      lastClose: result.close[result.close.length - 1],
      adx: adx[i],
      adxPrev: adx[i - 1],
      pdi: pdi[i],
      mdi: mdi[i],
      openTime: Number(result.klines[i][0]),
      closeTime: Number(result.klines[i][6]),
    };
  }

  function round1(x) {
    return Math.round(x * 10) / 10;
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
    if (COINS.indexOf(s) !== -1) return s;
    if (COINS.indexOf(s + "USDT") !== -1) return s + "USDT";
    return null;
  }

  function shortName(symbol) {
    return String(symbol).replace(/USDT$/, "");
  }

  return {
    COINS: COINS,
    TF: TF,
    N: N,
    ADX_LEVEL: ADX_LEVEL,
    wilder: wilder,
    compute: compute,
    isSignal: isSignal,
    findSignals: findSignals,
    latestScanSignal: latestScanSignal,
    round1: round1,
    formatWib: formatWib,
    normalizeSymbol: normalizeSymbol,
    shortName: shortName,
  };
});
