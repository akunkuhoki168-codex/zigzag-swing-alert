(function () {
  "use strict";

  var A = window.AdxAlert;
  var Z = window.ZigZag;
  var P = window.PaperWallet;
  var LC = window.LightweightCharts;

  var REST_BASES = [
    "https://fapi.binance.com",
    "https://fapi1.binance.com",
    "https://fapi2.binance.com",
    "https://fapi3.binance.com",
    "https://fapi4.binance.com",
  ];
  var REST_LABELS = ["FAPI", "FAPI1", "FAPI2", "FAPI3", "FAPI4"];
  var WS_TEMPLATES = [
    { label: "FSTREAM", url: function (stream) { return "wss://fstream.binance.com/stream?streams=" + stream; } },
    { label: "FSTREAM-WS", url: function (stream) { return "wss://fstream.binance.com/ws/" + stream.split("/")[0]; } },
    { label: "FSTREAM-MIRROR", url: function (stream) { return "wss://fstream.binancefuture.com/stream?streams=" + stream; } },
  ];
  var LIMIT = 500;
  var RETRIES = 10;
  var RETRY_MS = 1200;

  var params = new URLSearchParams(location.search);
  var symbol = A.normalizeSymbol(params.get("symbol")) || "NEARUSDT";
  var tf = A.normalizeTimeframe(params.get("tf"));
  if (!tf) {
    try { tf = A.normalizeTimeframe(localStorage.getItem(A.TF_STORAGE_KEY)); } catch (e) {}
  }
  if (!tf) tf = A.TF;

  var klines = [];
  var markPrice = null;
  var restSource = "CONNECTING";
  var wsSource = "CONNECTING";
  var loadGen = 0;
  var chart, candleSeries, zzSeries, zzActiveSeries, slLine, tpLine;
  var adxSeries, pdiSeries, mdiSeries, levelSeries, markersApi, zzMarkersApi, adxPane;
  var ws = null;
  var wsRetry = 0;
  var wsTemplateIdx = 0;
  var destroyed = false;
  var paper = P.load();
  var lastClosedOpen = null;

  var el = {
    symbols: document.getElementById("symbols"),
    moreCoins: document.getElementById("moreCoins"),
    timeframes: document.getElementById("timeframes"),
    feedDot: document.getElementById("feedStatusDot"),
    wsBadge: document.getElementById("wsSourceBadge"),
    mark: document.getElementById("liveMarkPrice"),
    toggleBtn: document.getElementById("toggleBotBtn"),
    chart: document.getElementById("chart"),
    msg: document.getElementById("chart-msg"),
    signals: document.getElementById("signals"),
    ledger: document.getElementById("ledger"),
    console: document.getElementById("console"),
    price: document.getElementById("st-price"),
    adx: document.getElementById("st-adx"),
    di: document.getElementById("st-di"),
    sig: document.getElementById("st-sig"),
    trend: document.getElementById("st-trend"),
    trigger: document.getElementById("st-trigger"),
    equity: document.getElementById("st-equity"),
    reversalPct: document.getElementById("reversalPct"),
    reversalLabel: document.getElementById("reversalLabel"),
    slPct: document.getElementById("slPct"),
    tpPct: document.getElementById("tpPct"),
    leverage: document.getElementById("leverage"),
    margin: document.getElementById("margin"),
    shorts: document.getElementById("shorts"),
    structureFilter: document.getElementById("structureFilter"),
    adxFilter: document.getElementById("adxFilter"),
    flattenBtn: document.getElementById("flattenBtn"),
    resetBtn: document.getElementById("resetBtn"),
  };

  function logEngine(msg, kind) {
    var row = document.createElement("div");
    if (kind) row.className = kind;
    var d = new Date();
    var stamp = d.toLocaleTimeString("en-GB", { hour12: false, timeZone: "Asia/Jakarta" });
    row.textContent = stamp + " WIB  " + msg;
    el.console.appendChild(row);
    while (el.console.childNodes.length > 250) el.console.removeChild(el.console.firstChild);
    el.console.scrollTop = el.console.scrollHeight;
  }

  function setFeed(kind, badge) {
    el.feedDot.className = "dot " + (kind || "wait");
    if (badge) {
      wsSource = badge;
      el.wsBadge.textContent = badge;
    }
  }

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  async function fetchKlines(sym, interval) {
    var err;
    var attempt;
    for (attempt = 0; attempt < RETRIES; attempt++) {
      var base = REST_BASES[attempt % REST_BASES.length];
      var label = REST_LABELS[attempt % REST_LABELS.length];
      try {
        var res = await fetch(
          base + "/fapi/v1/klines?symbol=" + encodeURIComponent(sym) + "&interval=" + encodeURIComponent(interval) + "&limit=" + LIMIT,
          { cache: "no-store" }
        );
        if (!res.ok) throw new Error("HTTP " + res.status);
        var data = await res.json();
        if (!Array.isArray(data) || !data.length) throw new Error("empty klines");
        restSource = label;
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
    if (dec == null) {
      var abs = Math.abs(n);
      dec = abs >= 100 ? 2 : abs >= 1 ? 4 : 6;
    }
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

  function applyParamsFromForm() {
    paper.params = P.clampParams({
      slPct: el.slPct.value,
      tpPct: el.tpPct.value,
      leverage: el.leverage.value,
      margin: el.margin.value,
      shorts: el.shorts.checked,
      structureFilter: el.structureFilter.checked,
      adxFilter: el.adxFilter.checked,
      reversalPct: el.reversalPct.value,
    });
    el.reversalPct.value = String(paper.params.reversalPct);
    el.reversalLabel.textContent = paper.params.reversalPct.toFixed(1) + "%";
    P.save(paper);
  }

  function fillFormFromState() {
    var p = paper.params;
    el.reversalPct.value = String(p.reversalPct);
    el.reversalLabel.textContent = p.reversalPct.toFixed(1) + "%";
    el.slPct.value = p.slPct;
    el.tpPct.value = p.tpPct;
    el.leverage.value = p.leverage;
    el.margin.value = p.margin;
    el.shorts.checked = p.shorts;
    el.structureFilter.checked = p.structureFilter;
    el.adxFilter.checked = p.adxFilter;
  }

  function setEngineButton() {
    el.toggleBtn.className = paper.engineOn ? "engine on" : "engine";
    el.toggleBtn.setAttribute("aria-pressed", paper.engineOn ? "true" : "false");
    el.toggleBtn.textContent = paper.engineOn ? "Stop paper engine" : "Start paper engine";
  }

  function buildChart() {
    if (chart) {
      chart.remove();
      chart = null;
    }
    chart = LC.createChart(el.chart, {
      autoSize: true,
      layout: {
        background: { type: "solid", color: "#181a20" },
        textColor: "#848e9c",
        fontSize: 11,
        fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif',
        attributionLogo: false,
        panes: { separatorColor: "#2b3139", separatorHoverColor: "rgba(252,213,53,0.35)", enableResize: true },
      },
      grid: {
        vertLines: { color: "#2b3139" },
        horzLines: { color: "#2b3139" },
      },
      crosshair: { mode: LC.CrosshairMode.Normal },
      rightPriceScale: { borderColor: "#2b3139", scaleMargins: { top: 0.16, bottom: 0.08 } },
      timeScale: {
        borderColor: "#2b3139",
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: function (time) {
          var p = wibParts(time);
          if (tf === "1h" || tf === "4h") return p.day + " " + p.clock;
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

    zzSeries = chart.addSeries(LC.LineSeries, {
      color: "#fcd535",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    }, 0);

    zzActiveSeries = chart.addSeries(LC.LineSeries, {
      color: "#fcd535",
      lineWidth: 2,
      lineStyle: LC.LineStyle.Dashed,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    }, 0);

    adxSeries = chart.addSeries(LC.LineSeries, {
      color: "#fcd535",
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
      color: "#848e9c",
      lineWidth: 1,
      lineStyle: LC.LineStyle.Dashed,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    }, 1);

    slLine = null;
    tpLine = null;
    adxPane = chart.panes()[1];
    sizePanes();
    markersApi = LC.createSeriesMarkers(candleSeries, []);
    zzMarkersApi = LC.createSeriesMarkers(zzSeries, []);
  }

  function sizePanes() {
    if (!chart || !adxPane) return;
    var h = el.chart.clientHeight;
    var adxH = Math.max(90, Math.round(h * 0.3));
    adxPane.setHeight(adxH);
  }

  function updateLevelLines(pos) {
    if (slLine) { try { slLine.remove(); } catch (e) {} slLine = null; }
    if (tpLine) { try { tpLine.remove(); } catch (e) {} tpLine = null; }
    if (!pos || !candleSeries) return;
    slLine = candleSeries.createPriceLine({
      price: pos.sl,
      color: "#f6465d",
      lineWidth: 1,
      lineStyle: LC.LineStyle.Dashed,
      axisLabelVisible: true,
      title: "SL",
    });
    tpLine = candleSeries.createPriceLine({
      price: pos.tp,
      color: "#0ecb81",
      lineWidth: 1,
      lineStyle: LC.LineStyle.Dashed,
      axisLabelVisible: true,
      title: "TP",
    });
  }

  function closedCandles(result) {
    var out = [];
    for (var i = 0; i < result.klines.length; i++) {
      out.push({
        time: Math.floor(Number(result.klines[i][0]) / 1000),
        open: Number(result.klines[i][1]),
        high: result.high[i],
        low: result.low[i],
        close: result.close[i],
      });
    }
    return out;
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
    adxSeries.setData(adxLine);
    pdiSeries.setData(pdiLine);
    mdiSeries.setData(mdiLine);
    levelSeries.setData(levelLine);

    var zz = Z.compute(closedCandles(result), paper.params.reversalPct);
    var zzPts = Z.linePoints(zz);
    var actPts = Z.activePoints(zz);
    zzSeries.setData(zzPts);
    zzActiveSeries.setData(actPts);

    var zzMarks = zz.pivots.filter(function (p) { return p.label; }).map(function (p) {
      var bull = p.label === "HH" || p.label === "HL";
      return {
        time: p.time,
        position: p.type === "LOW" ? "belowBar" : "aboveBar",
        color: bull ? "#0ecb81" : "#f6465d",
        shape: "circle",
        text: p.label,
        size: 0.8,
      };
    });
    zzMarkersApi.setMarkers(zzMarks);

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

    var lastPx = markPrice != null ? markPrice : (data.length ? Number(data[data.length - 1][4]) : null);
    el.price.textContent = fmtPrice(lastPx, dec);
    el.mark.textContent = fmtPrice(lastPx, dec);

    var lastClosed = result.adx.length ? result.adx.length - 1 : -1;
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

    el.trend.textContent = zz.trend;
    el.trend.className = "val " + (zz.trendKind === "up" ? "up" : zz.trendKind === "down" ? "down" : "");
    el.trigger.textContent = zz.trigger != null ? fmtPrice(zz.trigger, dec) : "—";

    renderList(signals, dec);
    onMarketUpdate(result, zz, lastPx, dec);
    el.msg.style.display = "none";
    return signals;
  }

  function renderList(signals, dec) {
    if (!signals.length) {
      el.signals.innerHTML = '<div class="empty">No ADX signals in the last ' + klines.length + " " + tf + " candles.</div>";
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

  function renderLedger(dec) {
    var pos = paper.position;
    var px = markPrice;
    var eq = P.equity(paper, px);
    el.equity.textContent = fmtPrice(eq, 2) + " USDT";
    el.equity.className = "val " + (eq >= P.STARTING_BALANCE ? "up" : "down");
    updateLevelLines(pos && pos.symbol === symbol ? pos : null);

    if (!paper.trades.length && !pos) {
      el.ledger.innerHTML = '<div class="empty">No paper trades yet. Start the engine to simulate entries on confirmed ZigZag pivots.</div>';
      return;
    }
    var html = '<div class="tr-head"><div>Time</div><div>Side</div><div>Symbol</div><div>Exit</div><div>PnL</div></div>';
    if (pos) {
      var u = P.unrealized(pos, px);
      html += '<div class="tr-row">' +
        '<div class="when">OPEN<small>' + A.shortName(pos.symbol) + " " + pos.tf + "</small></div>" +
        '<div><span class="pill ' + pos.side + '">' + pos.side + "</span></div>" +
        '<div class="hide-sm">' + fmtPrice(pos.entry, dec) + " → " + fmtPrice(px, dec) + "</div>" +
        '<div class="hide-sm">SL ' + fmtPrice(pos.sl, dec) + '</div>' +
        '<div class="pnl ' + (u >= 0 ? "pos" : "neg") + '">' + (u >= 0 ? "+" : "") + fmtPrice(u, 2) + "</div>" +
        '<div class="meta">Entry ' + fmtPrice(pos.entry, dec) + " · uPnL " + fmtPrice(u, 2) + "</div>" +
      "</div>";
    }
    html += paper.trades.map(function (tr) {
      var w = A.formatWib(tr.closedAt);
      var pnl = tr.pnl;
      return '<div class="tr-row">' +
        '<div class="when">' + w.time + "<small>" + w.date + "</small></div>" +
        '<div><span class="pill ' + tr.side + '">' + tr.side + "</span></div>" +
        '<div class="hide-sm">' + A.shortName(tr.symbol) + " " + (tr.tf || "") + "</div>" +
        '<div class="hide-sm">' + (tr.exitReason || "") + "</div>" +
        '<div class="pnl ' + (pnl >= 0 ? "pos" : "neg") + '">' + (pnl >= 0 ? "+" : "") + fmtPrice(pnl, 2) + "</div>" +
        '<div class="meta">' + A.shortName(tr.symbol) + " · " + (tr.exitReason || "") + "</div>" +
      "</div>";
    }).join("");
    el.ledger.innerHTML = html;
  }

  function lastAdxRow(result) {
    var i = result.adx.length - 1;
    if (i < 0 || result.adx[i] == null) return null;
    return { adx: result.adx[i], pdi: result.pdi[i], mdi: result.mdi[i], close: result.close[i] };
  }

  function adxAllows(side, row) {
    if (!row) return false;
    if (!(row.adx >= A.ADX_LEVEL)) return false;
    if (side === "LONG") return row.pdi > row.mdi;
    return row.mdi > row.pdi;
  }

  function onMarketUpdate(result, zz, lastPx, dec) {
    var lastBar = result.klines.length ? result.klines[result.klines.length - 1] : null;
    var forming = klines.length ? toCandle(klines[klines.length - 1]) : null;
    var posPx = lastPx;

    if (paper.position) {
      var sameSymbol = paper.position.symbol === symbol;
      var barForPos = sameSymbol ? forming : null;
      var closed = P.manage(paper, posPx, barForPos);
      if (closed && closed.ok) {
        logEngine("Closed " + closed.trade.side + " " + A.shortName(closed.trade.symbol) + " · " + closed.trade.exitReason + " · PnL " + fmtPrice(closed.trade.pnl, 2), closed.trade.pnl >= 0 ? "OK" : "ERR");
      }
    }

    if (paper.engineOn) {
      var closedOpen = lastBar ? Number(lastBar[0]) : null;
      if (closedOpen && closedOpen !== lastClosedOpen) {
        lastClosedOpen = closedOpen;
        maybeEnter(result, zz, lastPx);
      }
    }

    renderLedger(dec);
  }

  function maybeEnter(result, zz, lastPx) {
    if (!zz.pivots.length) return;
    var pivot = zz.pivots[zz.pivots.length - 1];
    var key = P.pivotKey(symbol, tf, pivot);
    if (key === paper.lastPivotKey) return;
    paper.lastPivotKey = key;
    P.save(paper);

    var sig = Z.signalForPivot(pivot);
    if (!sig) return;
    if (paper.position) return;

    var params = paper.params;
    if (sig.side === "SHORT" && !params.shorts) {
      logEngine("Skip short on " + A.shortName(symbol) + " — shorts disabled.", "WARN");
      return;
    }
    if (params.structureFilter && !Z.structureAllows(pivot, params.shorts)) {
      logEngine("Skip " + sig.side + " — structure filter wants HL for longs and LH for shorts (got " + (pivot.label || pivot.type) + ").", "WARN");
      return;
    }
    if (params.adxFilter && !adxAllows(sig.side, lastAdxRow(result))) {
      logEngine("Skip " + sig.side + " — ADX filter (need ADX ≥ 25 and DI in the same direction).", "WARN");
      return;
    }
    var price = result.close[result.close.length - 1] || lastPx;
    var opened = P.openPosition(paper, {
      symbol: symbol,
      tf: tf,
      side: sig.side,
      price: price,
      reason: "ZigZag " + (pivot.label || pivot.type),
    });
    if (!opened.ok) {
      logEngine("Did not open " + sig.side + ": " + opened.reason, "WARN");
      return;
    }
    logEngine("Opened " + sig.side + " " + A.shortName(symbol) + " @ " + fmtPrice(price) + " · " + (pivot.label || pivot.type) + " · " + tf, "OK");
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

  function handleWsMessage(msg) {
    if (msg.stream && msg.data) msg = msg.data;
    if (msg.e === "markPriceUpdate" || msg.e === "markPrice") {
      var mp = Number(msg.p || msg.markPrice);
      if (mp) markPrice = mp;
      if (klines.length) render(klines, true);
      else {
        el.mark.textContent = fmtPrice(markPrice);
        renderLedger(priceDecimals([[0, 0, 0, 0, markPrice]]));
      }
      return;
    }
    var k = msg.k;
    if (!k) return;
    var row = [k.t, k.o, k.h, k.l, k.c, k.v, k.T, k.q, k.n, k.V, k.Q, "0"];
    upsertKline(row);
    if (markPrice == null) markPrice = Number(k.c);
    render(klines, true);
  }

  function connectWs(sym, interval) {
    closeWs();
    var klineStream = sym.toLowerCase() + "@kline_" + interval;
    var markStream = sym.toLowerCase() + "@markPrice@1s";
    var combined = klineStream + "/" + markStream;
    var tmpl = WS_TEMPLATES[wsTemplateIdx % WS_TEMPLATES.length];
    var sock;
    try {
      sock = new WebSocket(tmpl.url(combined));
    } catch (e) {
      setFeed("err", "SOCKET");
      scheduleWs(sym, interval);
      return;
    }
    ws = sock;
    sock.onopen = function () {
      if (ws !== sock) return;
      wsRetry = 0;
      setFeed("live", tmpl.label);
      logEngine("Live feed " + tmpl.label + " · " + A.shortName(sym) + " " + interval, "OK");
    };
    sock.onmessage = function (ev) {
      if (ws !== sock) return;
      try { handleWsMessage(JSON.parse(ev.data)); } catch (e) { /* ignore a bad frame */ }
    };
    sock.onclose = function () {
      if (ws !== sock || destroyed) return;
      setFeed("wait", "RECONNECT");
      wsTemplateIdx = (wsTemplateIdx + 1) % WS_TEMPLATES.length;
      scheduleWs(sym, interval);
    };
    sock.onerror = function () {
      try { sock.close(); } catch (e) {}
    };
  }

  function scheduleWs(sym, interval) {
    wsRetry += 1;
    var wait = Math.min(15000, 1000 * Math.pow(1.6, Math.min(wsRetry, 8)));
    setTimeout(function () {
      if (!destroyed && symbol === sym && tf === interval) connectWs(sym, interval);
    }, wait);
  }

  function closeWs() {
    if (!ws) return;
    var old = ws;
    ws = null;
    old.onopen = old.onmessage = old.onclose = old.onerror = null;
    try { old.close(); } catch (e) {}
  }

  function setUrl() {
    var next = new URL(location.href);
    next.searchParams.set("symbol", symbol);
    next.searchParams.set("tf", tf);
    history.replaceState(null, "", next.pathname + next.search + next.hash);
  }

  function persistTf(interval) {
    tf = interval;
    try { localStorage.setItem(A.TF_STORAGE_KEY, interval); } catch (e) {}
  }

  function highlight() {
    var buttons = el.symbols.querySelectorAll("button");
    var i;
    var inChips = false;
    for (i = 0; i < buttons.length; i++) {
      var on = buttons[i].dataset.symbol === symbol;
      buttons[i].setAttribute("aria-pressed", on ? "true" : "false");
      if (on) inChips = true;
    }
    if (el.moreCoins) {
      el.moreCoins.value = inChips ? "" : symbol;
      el.moreCoins.className = "more" + (inChips ? "" : " active");
    }
    if (el.timeframes) {
      buttons = el.timeframes.querySelectorAll("button");
      for (i = 0; i < buttons.length; i++) {
        buttons[i].setAttribute("aria-pressed", buttons[i].dataset.tf === tf ? "true" : "false");
      }
    }
  }

  async function load(sym, interval, pushUrl) {
    var gen = ++loadGen;
    symbol = sym;
    persistTf(interval);
    highlight();
    if (pushUrl !== false) setUrl();
    setFeed("wait", "LOADING");
    el.msg.textContent = "Loading " + A.shortName(sym) + " " + interval + " candles…";
    el.msg.style.display = "flex";
    closeWs();
    markPrice = null;
    lastClosedOpen = null;
    try {
      var data = await fetchKlines(sym, interval);
      if (gen !== loadGen) return;
      klines = data;
      markPrice = Number(data[data.length - 1][4]);
      setFeed("wait", restSource);
      render(klines, false);
      setFeed("wait", "CONNECTING");
      connectWs(sym, interval);
    } catch (e) {
      if (gen !== loadGen) return;
      el.msg.textContent = "Could not load Binance Futures candles. Retrying with REST mirrors.";
      el.msg.style.display = "flex";
      setFeed("err", "FETCH FAIL");
      logEngine("REST fetch failed for " + A.shortName(sym) + " " + interval + ".", "ERR");
      setTimeout(function () { if (symbol === sym && tf === interval) load(sym, interval, false); }, 4000);
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
        if (sym !== symbol) load(sym, tf);
      });
      el.symbols.appendChild(b);
    });
    el.moreCoins.innerHTML = '<option value="">Top 50…</option>';
    A.ALL_COINS.forEach(function (sym) {
      var opt = document.createElement("option");
      opt.value = sym;
      opt.textContent = A.shortName(sym);
      el.moreCoins.appendChild(opt);
    });
    el.moreCoins.addEventListener("change", function () {
      var sym = el.moreCoins.value;
      if (sym && sym !== symbol) load(sym, tf);
    });
    el.timeframes.innerHTML = "";
    A.TIMEFRAMES.forEach(function (interval) {
      var b = document.createElement("button");
      b.type = "button";
      b.textContent = interval;
      b.dataset.tf = interval;
      b.setAttribute("aria-pressed", interval === tf ? "true" : "false");
      b.addEventListener("click", function () {
        if (interval !== tf) load(symbol, interval);
      });
      el.timeframes.appendChild(b);
    });
  }

  function toggleEngine() {
    paper.engineOn = !paper.engineOn;
    setEngineButton();
    if (paper.engineOn) {
      lastClosedOpen = klines.length ? Number(klines[klines.length - 1][0]) : null;
      if (klines.length > 1) lastClosedOpen = Number((A.compute(klines, true).klines.slice(-1)[0] || [0])[0]);
      logEngine("Paper engine ON · " + A.shortName(symbol) + " " + tf + " · reversal " + paper.params.reversalPct + "% · " + paper.params.leverage + "x. Simulated only.", "WARN");
    } else {
      logEngine("Paper engine OFF. Open simulated positions stay until you flatten or they hit SL/TP.", "WARN");
    }
  }

  function flatten() {
    if (!paper.position) {
      logEngine("No open paper position to flatten.", "WARN");
      return;
    }
    var px = markPrice || (klines.length ? Number(klines[klines.length - 1][4]) : null);
    var closed = P.closePosition(paper, { price: px, reason: "Manual flatten" });
    if (closed.ok) logEngine("Flattened " + closed.trade.side + " " + A.shortName(closed.trade.symbol) + " · PnL " + fmtPrice(closed.trade.pnl, 2), closed.trade.pnl >= 0 ? "OK" : "ERR");
    renderLedger();
  }

  function resetWallet() {
    if (!window.confirm("Reset the paper wallet to 10,000 USDT and clear the trade ledger?")) return;
    var on = paper.engineOn;
    var params = paper.params;
    paper = P.reset(paper);
    paper.engineOn = on;
    paper.params = params;
    P.save(paper);
    fillFormFromState();
    setEngineButton();
    logEngine("Paper wallet reset to 10,000 USDT.", "WARN");
    renderLedger();
  }

  ["reversalPct", "slPct", "tpPct", "leverage", "margin", "shorts", "structureFilter", "adxFilter"].forEach(function (id) {
    var node = el[id];
    var ev = id === "reversalPct" ? "input" : "change";
    node.addEventListener(ev, function () {
      applyParamsFromForm();
      if (id === "reversalPct" && klines.length) render(klines, true);
      else renderLedger();
    });
  });
  el.toggleBtn.addEventListener("click", toggleEngine);
  el.flattenBtn.addEventListener("click", flatten);
  el.resetBtn.addEventListener("click", resetWallet);

  window.addEventListener("resize", sizePanes);
  window.addEventListener("pagehide", function () { destroyed = true; closeWs(); });

  if (!LC || !A || !Z || !P) {
    setFeed("err", "SCRIPT");
    el.msg.textContent = "A required script failed to load.";
    return;
  }

  fillFormFromState();
  setEngineButton();
  buildSwitcher();
  buildChart();
  logEngine("ADX Swing Alert ready. Paper trading only — no API keys, no live orders.", "OK");
  load(symbol, tf, true);
})();
