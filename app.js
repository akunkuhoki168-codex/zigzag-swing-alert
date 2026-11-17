(function () {
  "use strict";

  var A = window.AdxAlert;
  var LC = window.LightweightCharts;
  var KLINES_URL = "https://fapi.binance.com/fapi/v1/klines";
  var WS_URL = "wss://fstream.binance.com/ws";
  var LIMIT = 500;
  var RETRIES = 8;
  var RETRY_MS = 1500;

  var symbol = A.normalizeSymbol(new URLSearchParams(location.search).get("symbol")) || "NEARUSDT";
  var klines = [];
  var chart, candleSeries, adxSeries, pdiSeries, mdiSeries, levelSeries, markersApi, adxPane;
  var ws = null;
  var wsRetry = 0;
  var unsubRange = null;
  var destroyed = false;

  var el = {
    symbols: document.getElementById("symbols"),
    status: document.getElementById("status"),
    statusText: document.getElementById("status-text"),
    chart: document.getElementById("chart"),
    msg: document.getElementById("chart-msg"),
    signals: document.getElementById("signals"),
    price: document.getElementById("st-price"),
    adx: document.getElementById("st-adx"),
    di: document.getElementById("st-di"),
    sig: document.getElementById("st-sig"),
  };

  function setStatus(kind, text) {
    el.status.className = "status " + kind;
    el.statusText.textContent = text;
  }

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  async function fetchKlines(sym) {
    var err;
    for (var attempt = 0; attempt < RETRIES; attempt++) {
      try {
        var res = await fetch(KLINES_URL + "?symbol=" + encodeURIComponent(sym) + "&interval=1m&limit=" + LIMIT, { cache: "no-store" });
        if (!res.ok) throw new Error("HTTP " + res.status);
        var data = await res.json();
        if (!Array.isArray(data) || !data.length) throw new Error("empty klines");
        return data;
      } catch (e) {
        err = e;
        await sleep(RETRY_MS);
      }
    }
    throw err;
  }

  function priceDecimals(rows) {
    var d = 2;
    for (var i = 0; i < rows.length; i++) {
      var s = String(rows[i][4]);
      var p = s.indexOf(".");
      if (p !== -1) d = Math.max(d, s.length - p - 1);
    }
    return Math.min(d, 8);
  }

  function fmtPrice(n, dec) {
    if (n == null || isNaN(n)) return "—";
    return Number(n).toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec });
  }

  function toCandle(row) {
    return {
      time: Math.floor(Number(row[0]) / 1000),
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
    };
  }

  function wibParts(utcSeconds) {
    var d = new Date((utcSeconds + 7 * 3600) * 1000);
    var hh = String(d.getUTCHours()).padStart(2, "0");
    var mm = String(d.getUTCMinutes()).padStart(2, "0");
    var mo = d.getUTCMonth() + 1;
    var da = d.getUTCDate();
    return { hh: hh, mm: mm, mo: mo, da: da, clock: hh + ":" + mm, day: da + "/" + mo };
  }

  function buildChart() {
    if (chart) {
      if (unsubRange) unsubRange();
      unsubRange = null;
      chart.remove();
      chart = null;
    }
    chart = LC.createChart(el.chart, {
      autoSize: true,
      layout: {
        background: { type: "solid", color: "#12161c" },
        textColor: "#8b949e",
        fontSize: 11,
        fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif',
        attributionLogo: false,
        panes: { separatorColor: "#1e2530", separatorHoverColor: "rgba(240,193,75,0.35)", enableResize: true },
      },
      grid: {
        vertLines: { color: "#1e2530" },
        horzLines: { color: "#1e2530" },
      },
      crosshair: { mode: LC.CrosshairMode.Normal },
      rightPriceScale: { borderColor: "#1e2530", scaleMargins: { top: 0.12, bottom: 0.08 } },
      timeScale: {
        borderColor: "#1e2530",
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: function (time) {
          var p = wibParts(time);
          return p.clock;
        },
      },
      localization: {
        timeFormatter: function (time) {
          var p = wibParts(time);
          return p.day + " " + p.clock + " WIB";
        },
      },
    });

    candleSeries = chart.addSeries(LC.CandlestickSeries, {
      upColor: "#0ecb81",
      downColor: "#f6465d",
      wickUpColor: "#0ecb81",
      wickDownColor: "#f6465d",
      borderVisible: false,
    }, 0);

    adxSeries = chart.addSeries(LC.LineSeries, {
      color: "#f0c14b",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
      title: "ADX",
      priceFormat: { type: "price", precision: 1, minMove: 0.1 },
    }, 1);
    pdiSeries = chart.addSeries(LC.LineSeries, {
      color: "#0ecb81",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
      title: "+DI",
      priceFormat: { type: "price", precision: 1, minMove: 0.1 },
    }, 1);
    mdiSeries = chart.addSeries(LC.LineSeries, {
      color: "#f6465d",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
      title: "−DI",
      priceFormat: { type: "price", precision: 1, minMove: 0.1 },
    }, 1);
    levelSeries = chart.addSeries(LC.LineSeries, {
      color: "#8b949e",
      lineWidth: 1,
      lineStyle: LC.LineStyle.Dashed,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    }, 1);

    adxPane = chart.panes()[1];
    sizePanes();
    markersApi = LC.createSeriesMarkers(candleSeries, []);
  }

  function sizePanes() {
    if (!chart || !adxPane) return;
    var h = el.chart.clientHeight;
    var adxH = Math.max(90, Math.round(h * 0.32));
    adxPane.setHeight(adxH);
  }

  function render(data, keepRange) {
    var result = A.compute(data, true);
    var closed = result.klines;
    var dec = priceDecimals(data);
    candleSeries.applyOptions({
      priceFormat: { type: "price", precision: dec, minMove: Math.pow(10, -dec) },
    });

    var candles = data.map(toCandle);
    var range = keepRange ? chart.timeScale().getVisibleLogicalRange() : null;
    candleSeries.setData(candles);

    var adxLine = [];
    var pdiLine = [];
    var mdiLine = [];
    var levelLine = [];
    for (var i = 0; i < result.adx.length; i++) {
      if (result.adx[i] == null) continue;
      var t = Math.floor(Number(closed[i][0]) / 1000);
      adxLine.push({ time: t, value: result.adx[i] });
      pdiLine.push({ time: t, value: result.pdi[i] });
      mdiLine.push({ time: t, value: result.mdi[i] });
      levelLine.push({ time: t, value: 25 });
    }
    /* If the last REST/WS bar is still forming, show it on the price chart only. */
    adxSeries.setData(adxLine);
    pdiSeries.setData(pdiLine);
    mdiSeries.setData(mdiLine);
    levelSeries.setData(levelLine);

    var signals = A.findSignals(result);
    var markers = signals.map(function (s) {
      var long = s.signal === "LONG";
      return {
        time: Math.floor(s.openTime / 1000),
        position: long ? "belowBar" : "aboveBar",
        color: long ? "#0ecb81" : "#f6465d",
        shape: long ? "arrowUp" : "arrowDown",
        text: s.signal + " (unconfirmed)",
        size: 1,
      };
    });
    markersApi.setMarkers(markers);

    if (range) chart.timeScale().setVisibleLogicalRange(range);
    else {
      var visible = Math.min(120, candles.length);
      chart.timeScale().setVisibleLogicalRange({ from: candles.length - visible, to: candles.length + 2 });
    }

    var lastClosed = result.adx.length ? result.adx.length - 1 : -1;
    var lastPx = data.length ? Number(data[data.length - 1][4]) : null;
    el.price.textContent = fmtPrice(lastPx, dec);
    if (lastClosed >= 0 && result.adx[lastClosed] != null) {
      el.adx.textContent = A.round1(result.adx[lastClosed]).toFixed(1);
      el.di.textContent = A.round1(result.pdi[lastClosed]).toFixed(1) + " / " + A.round1(result.mdi[lastClosed]).toFixed(1);
    } else {
      el.adx.textContent = "—";
      el.di.textContent = "—";
    }
    if (signals.length) {
      var last = signals[signals.length - 1];
      el.sig.textContent = last.signal;
      el.sig.className = "val " + last.signal.toLowerCase();
    } else {
      el.sig.textContent = "—";
      el.sig.className = "val";
    }

    renderList(signals, dec);
    el.msg.style.display = "none";
    return signals;
  }

  function renderList(signals, dec) {
    if (!signals.length) {
      el.signals.innerHTML = '<div class="empty">No ADX signals in the last ' + klines.length + ' one-minute candles.</div>';
      return;
    }
    var rows = signals.slice().reverse();
    var html = '<div class="sig-head"><div>Time (WIB)</div><div>Signal</div><div>Close</div><div>ADX</div><div>+DI</div><div>−DI</div></div>';
    html += rows.map(function (s) {
      var w = A.formatWib(s.closeTime);
      return (
        '<div class="sig-row">' +
          '<div class="when">' + w.time + "<small>" + w.date + "</small></div>" +
          '<div><span class="dir ' + s.signal + '">' + s.signal + " (unconfirmed)</span></div>" +
          '<div class="hide-sm">' + fmtPrice(s.close, dec) + "</div>" +
          '<div class="hide-sm">' + A.round1(s.adx).toFixed(1) + "</div>" +
          '<div class="hide-sm">' + A.round1(s.pdi).toFixed(1) + "</div>" +
          '<div class="hide-sm">' + A.round1(s.mdi).toFixed(1) + "</div>" +
          '<div class="meta">' + fmtPrice(s.close, dec) + " · ADX " + A.round1(s.adx).toFixed(1) +
            " · +DI " + A.round1(s.pdi).toFixed(1) + " · −DI " + A.round1(s.mdi).toFixed(1) + "</div>" +
        "</div>"
      );
    }).join("");
    el.signals.innerHTML = html;
  }

  function upsertKline(row) {
    if (!klines.length) {
      klines.push(row);
      return;
    }
    var lastOpen = Number(klines[klines.length - 1][0]);
    var open = Number(row[0]);
    if (open === lastOpen) klines[klines.length - 1] = row;
    else if (open > lastOpen) {
      klines.push(row);
      if (klines.length > LIMIT + 5) klines = klines.slice(-LIMIT);
    }
  }

  function connectWs(sym) {
    closeWs();
    var stream = sym.toLowerCase() + "@kline_1m";
    var sock;
    try {
      sock = new WebSocket(WS_URL + "/" + stream);
    } catch (e) {
      setStatus("err", "Socket error");
      scheduleWs(sym);
      return;
    }
    ws = sock;
    sock.onopen = function () {
      if (ws !== sock) return;
      wsRetry = 0;
      setStatus("live", "Live");
    };
    sock.onmessage = function (ev) {
      if (ws !== sock) return;
      try {
        var msg = JSON.parse(ev.data);
        var k = msg.k;
        if (!k) return;
        var row = [k.t, k.o, k.h, k.l, k.c, k.v, k.T, k.q, k.n, k.V, k.Q, "0"];
        upsertKline(row);
        render(klines, true);
      } catch (e) { /* ignore a bad frame */ }
    };
    sock.onclose = function () {
      if (ws !== sock || destroyed) return;
      setStatus("wait", "Reconnecting");
      scheduleWs(sym);
    };
    sock.onerror = function () {
      try { sock.close(); } catch (e) {}
    };
  }

  function scheduleWs(sym) {
    wsRetry += 1;
    var wait = Math.min(15000, 1000 * Math.pow(1.6, Math.min(wsRetry, 8)));
    setTimeout(function () {
      if (!destroyed && symbol === sym) connectWs(sym);
    }, wait);
  }

  function closeWs() {
    if (!ws) return;
    var old = ws;
    ws = null;
    old.onopen = old.onmessage = old.onclose = old.onerror = null;
    try { old.close(); } catch (e) {}
  }

  function setUrl(sym) {
    var next = new URL(location.href);
    next.searchParams.set("symbol", sym);
    history.replaceState(null, "", next.pathname + next.search + next.hash);
  }

  function highlight() {
    var buttons = el.symbols.querySelectorAll("button");
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].setAttribute("aria-pressed", buttons[i].dataset.symbol === symbol ? "true" : "false");
    }
  }

  async function load(sym, pushUrl) {
    symbol = sym;
    highlight();
    if (pushUrl !== false) setUrl(sym);
    setStatus("wait", "Loading");
    el.msg.textContent = "Loading " + A.shortName(sym) + " candles…";
    el.msg.style.display = "flex";
    closeWs();
    try {
      klines = await fetchKlines(sym);
      render(klines, false);
      setStatus("wait", "Connecting");
      connectWs(sym);
    } catch (e) {
      el.msg.textContent = "Could not load Binance Futures candles. Retrying may help if fapi is briefly blocked.";
      el.msg.style.display = "flex";
      setStatus("err", "Fetch failed");
      setTimeout(function () { if (symbol === sym) load(sym, false); }, 4000);
    }
  }

  function buildSwitcher() {
    el.symbols.innerHTML = "";
    A.COINS.forEach(function (sym) {
      var b = document.createElement("button");
      b.type = "button";
      b.textContent = A.shortName(sym);
      b.dataset.symbol = sym;
      b.setAttribute("aria-pressed", sym === symbol ? "true" : "false");
      b.addEventListener("click", function () {
        if (sym !== symbol) load(sym);
      });
      el.symbols.appendChild(b);
    });
  }

  window.addEventListener("resize", sizePanes);
  window.addEventListener("pagehide", function () { destroyed = true; closeWs(); });

  if (!LC || !A) {
    setStatus("err", "Script error");
    el.msg.textContent = "Chart library failed to load.";
    return;
  }
  buildSwitcher();
  buildChart();
  load(symbol, true);
})();
