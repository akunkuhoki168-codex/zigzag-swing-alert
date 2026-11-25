(function () {
  "use strict";

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
  var symbol = Z.normalizeSymbol(params.get("symbol")) || "NEARUSDT";
  var tf = Z.normalizeTimeframe(params.get("tf")) || Z.readSavedTf() || Z.TF;

  var klines = [];
  var markPrice = null;
  var restSource = "CONNECTING";
  var wsSource = "CONNECTING";
  var loadGen = 0;
  var chart, candleSeries, zzSeries, zzActiveSeries, rsiSeries, slLine, tpLine, zzMarkersApi;
  var ws = null;
  var wsRetry = 0;
  var wsTemplateIdx = 0;
  var destroyed = false;
  var paper = P.load();
  var lastClosedOpen = null;

  var el = {
    coinSelect: document.getElementById("coinSelect"),
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
    sig: document.getElementById("st-sig"),
    pivot: document.getElementById("st-pivot"),
    label: document.getElementById("st-label"),
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
    flattenBtn: document.getElementById("flattenBtn"),
    resetBtn: document.getElementById("resetBtn"),
    botStatus: document.getElementById("botStatus"),
    botEquity: document.getElementById("bot-equity"),
    botWinrate: document.getElementById("bot-winrate"),
    botOpen: document.getElementById("bot-open"),
    botLastrun: document.getElementById("bot-lastrun"),
    botMeta: document.getElementById("botMeta"),
    botPositions: document.getElementById("botPositions"),
    botTrades: document.getElementById("botTrades"),
  };

  var BOT_STATE_URLS = ["data/paper_state.json"];
  var botState = null;
  var botTpLine = null;
  var ENGINE_TF = "15m";
  var engineTimer = null;


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
  }

  function setEngineButton() {
    el.toggleBtn.className = paper.engineOn ? "engine on" : "engine";
    el.toggleBtn.setAttribute("aria-pressed", paper.engineOn ? "true" : "false");
    el.toggleBtn.textContent = paper.engineOn ? "Stop local sandbox" : "Start local sandbox";
  }

  function rsiWilder(candles, period) {
    period = period || 14;
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

  function latestRsiTitle(points) {
    if (!points.length) return "RSI 14";
    return "RSI 14: " + points[points.length - 1].value.toFixed(2);
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
        panes: { separatorColor: "#2b3139", separatorHoverColor: "rgba(72, 80, 92, 0.35)" },
      },
      grid: {
        vertLines: { color: "#2b3139" },
        horzLines: { color: "#2b3139" },
      },
      crosshair: { mode: LC.CrosshairMode.Normal },
      rightPriceScale: { borderColor: "#2b3139", scaleMargins: { top: 0.14, bottom: 0.08 } },
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
    });

    zzSeries = chart.addSeries(LC.LineSeries, {
      color: "#fcd535",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });

    zzActiveSeries = chart.addSeries(LC.LineSeries, {
      color: "#fcd535",
      lineWidth: 2,
      lineStyle: LC.LineStyle.Dashed,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });

    rsiSeries = chart.addSeries(LC.LineSeries, {
      color: "#a78bfa",
      lineWidth: 2,
      title: "RSI 14",
      priceLineVisible: false,
      lastValueVisible: true,
      priceFormat: { type: "price", precision: 2, minMove: 0.01 },
      autoscaleInfoProvider: function () {
        return { priceRange: { minValue: 0, maxValue: 100 } };
      },
    }, 1);
    rsiSeries.createPriceLine({
      price: 70, color: "#848e9c", lineWidth: 1,
      lineStyle: LC.LineStyle.Dashed, axisLabelVisible: true, title: "70",
    });
    rsiSeries.createPriceLine({
      price: 68, color: "#fcd535", lineWidth: 1,
      lineStyle: LC.LineStyle.Dotted, axisLabelVisible: true, title: "68",
    });
    rsiSeries.createPriceLine({
      price: 32, color: "#fcd535", lineWidth: 1,
      lineStyle: LC.LineStyle.Dotted, axisLabelVisible: true, title: "32",
    });
    rsiSeries.createPriceLine({
      price: 30, color: "#848e9c", lineWidth: 1,
      lineStyle: LC.LineStyle.Dashed, axisLabelVisible: true, title: "30",
    });
    var panes = chart.panes();
    if (panes.length > 1) {
      panes[0].setStretchFactor(3);
      panes[1].setStretchFactor(1);
    }

    slLine = null;
    tpLine = null;
    zzMarkersApi = LC.createSeriesMarkers(zzSeries, []);
  }

  function updateLevelLines(pos) {
    if (slLine) { try { slLine.remove(); } catch (e) {} slLine = null; }
    if (tpLine) { try { tpLine.remove(); } catch (e) {} tpLine = null; }
    if (!pos || !candleSeries) return;
    if (pos.sl != null) {
      slLine = candleSeries.createPriceLine({
        price: pos.sl, color: "#f6465d", lineWidth: 1,
        lineStyle: LC.LineStyle.Dashed, axisLabelVisible: true, title: "SL",
      });
    }
    if (pos.tp != null) {
    tpLine = candleSeries.createPriceLine({
      price: pos.tp, color: "#0ecb81", lineWidth: 1,
      lineStyle: LC.LineStyle.Dashed, axisLabelVisible: true, title: "TP",
    });
    }
  }


  function botStateUrls() {
    var t = Date.now();
    return BOT_STATE_URLS.map(function (u) {
      return u + (u.indexOf("?") >= 0 ? "&" : "?") + "t=" + t;
    });
  }

  function botUpnl(pos, px) {
    if (!pos || px == null || !px) return 0;
    var cfg = (botState && botState.config) || {};
    var fee = (Number(cfg.fee_pct) || 0.04) / 100;
    var qty = Number(pos.qty);
    var entry = Number(pos.entry);
    var entryFee = Number(pos.entry_fee) || (Number(pos.notional) || 0) * fee;
    var exitFee = px * qty * fee;
    if (pos.side === "long") return (px - entry) * qty - entryFee - exitFee;
    return (entry - px) * qty - entryFee - exitFee;
  }

  function botMarkFor(sym) {
    if (sym === symbol && markPrice != null) return markPrice;
    if (botState && botState.last_prices && botState.last_prices[sym] != null) {
      return botState.last_prices[sym];
    }
    return null;
  }

  function renderBot() {
    if (!el.botEquity) return;
    if (!botState) {
      el.botStatus.textContent = "Bot state unavailable";
      el.botStatus.className = "bot-live err";
      return;
    }
    var stats = botState.stats || {};
    var cfg = botState.config || {};
    var cash = Number(botState.cash || 0);
    var eq = cash;
    var positions = botState.positions || {};
    var openList = [];
    Object.keys(positions).forEach(function (sym) {
      var pos = positions[sym];
      if (!pos) return;
      var px = botMarkFor(sym);
      var u = botUpnl(pos, px);
      eq += u;
      openList.push({ pos: pos, px: px, u: u });
    });
    var start = Number(cfg.starting_balance) || 200;
    el.botEquity.textContent = fmtPrice(eq, 2) + " USDT";
    el.botEquity.className = "val " + (eq >= start ? "up" : "down");
    var wr = stats.win_rate;
    el.botWinrate.textContent = (stats.trades ? wr.toFixed(1) + "%  (" + (stats.wins || 0) + "/" + stats.trades + ")" : "—");
    el.botOpen.textContent = String(openList.length);
    el.botLastrun.textContent = botState.last_run_at_wib || "—";
    var status = botState.last_run_at_wib
      ? "Last run " + botState.last_run_at_wib
      : "Seeded, waiting for the next closed 15m candle";
    el.botStatus.textContent = status;
    el.botStatus.className = "bot-live ok";
    var market = botState.data_market || "";
    var src = botState.data_source || "";
    var note = botState.data_note || "";
    el.botMeta.textContent = [
      src ? ("Feed " + src + (market ? " · " + market : "")) : "",
      "No stop-loss",
      "Starting " + fmtPrice(start, 0) + " USDT",
      "Notional " + fmtPrice(cfg.notional || 200, 0) + " USDT",
      "Fee " + (cfg.fee_pct != null ? cfg.fee_pct : 0.04) + "%/side",
      "Reversal " + (cfg.reversal_pct != null ? cfg.reversal_pct : 1.5) + "%",
      "TP " + (cfg.take_profit_pct != null ? cfg.take_profit_pct : 3) + "%",
      note
    ].filter(Boolean).join(" · ");

    if (!openList.length) {
      el.botPositions.innerHTML = '<div class="empty">No open bot positions. The book starts flat and only trades newly closed 15m candles.</div>';
    } else {
      var html = '<div class="bot-headrow"><div>Coin</div><div>Side</div><div>Reason</div><div>Entry</div><div>Mark</div><div>TP</div><div>uPnL</div></div>';
      html += openList.map(function (row) {
        var pos = row.pos;
        var dec = 4;
        var w = Z.formatWib(pos.entry_close_time);
        var ucls = row.u >= 0 ? "pos" : "neg";
        return '<div class="bot-row">' +
          '<div class="when">' + Z.shortName(pos.symbol) + "<small>" + w.date + " " + w.time + " WIB</small></div>" +
          '<div><span class="pill ' + String(pos.side).toUpperCase() + '">' + pos.side + "</span></div>" +
          '<div class="hide-sm">' + (pos.entry_reason || "") + "</div>" +
          '<div class="hide-sm">' + fmtPrice(pos.entry, dec) + "</div>" +
          '<div class="hide-sm">' + fmtPrice(row.px, dec) + "</div>" +
          '<div class="hide-sm">' + fmtPrice(pos.tp, dec) + "</div>" +
          '<div class="pnl ' + ucls + '">' + (row.u >= 0 ? "+" : "") + fmtPrice(row.u, 2) + "</div>" +
          '<div class="meta">' + (pos.entry_reason || "") + " · " + fmtPrice(pos.entry, dec) + " → " + fmtPrice(row.px, dec) + "</div>" +
        "</div>";
      }).join("");
      el.botPositions.innerHTML = html;
    }

    var trades = (botState.trades || []).slice().reverse();
    if (!trades.length) {
      el.botTrades.innerHTML = '<div class="empty">No bot trades yet. The first run seeds a flat book from now, so history starts with the next qualifying 15m close.</div>';
    } else {
      var html = '<div class="bot-headrow"><div>Exit (WIB)</div><div>Coin</div><div>Side</div><div>Entry → Exit</div><div>Reason</div><div></div><div>PnL</div></div>';
      html += trades.slice(0, 80).map(function (tr) {
        var w = Z.formatWib(tr.exit_close_time);
        var dec = 4;
        var reason = (tr.entry_reason || "") + " → " + (tr.exit_reason || "");
        return '<div class="bot-row">' +
          '<div class="when">' + w.time + "<small>" + w.date + "</small></div>" +
          '<div class="hide-sm">' + Z.shortName(tr.symbol) + "</div>" +
          '<div><span class="pill ' + String(tr.side).toUpperCase() + '">' + tr.side + "</span></div>" +
          '<div class="hide-sm">' + fmtPrice(tr.entry, dec) + " → " + fmtPrice(tr.exit, dec) + "</div>" +
          '<div class="hide-sm">' + reason + "</div>" +
          '<div></div>' +
          '<div class="pnl ' + (tr.pnl >= 0 ? "pos" : "neg") + '">' + (tr.pnl >= 0 ? "+" : "") + fmtPrice(tr.pnl, 2) + "</div>" +
          '<div class="meta">' + Z.shortName(tr.symbol) + " · " + reason + "</div>" +
        "</div>";
      }).join("");
      el.botTrades.innerHTML = html;
    }
    updateBotTpLine();
  }

  function botMarkers() {
    var marks = [];
    if (!botState) return marks;
    var trades = botState.trades || [];
    trades.forEach(function (tr) {
      if (tr.symbol !== symbol) return;
      if (tr.entry_time) {
        marks.push({
          time: tr.entry_time,
          position: tr.side === "long" ? "belowBar" : "aboveBar",
          color: tr.side === "long" ? "#0ecb81" : "#f6465d",
          shape: tr.side === "long" ? "arrowUp" : "arrowDown",
          text: "BOT " + String(tr.side).toUpperCase() + " " + (tr.entry_reason || ""),
          size: 1,
        });
      }
      if (tr.exit_time) {
        marks.push({
          time: tr.exit_time,
          position: tr.side === "long" ? "aboveBar" : "belowBar",
          color: "#fcd535",
          shape: "square",
          text: "EXIT " + (tr.exit_reason || ""),
          size: 1,
        });
      }
    });
    var pos = botState.positions && botState.positions[symbol];
    if (pos && pos.entry_time) {
      marks.push({
        time: pos.entry_time,
        position: pos.side === "long" ? "belowBar" : "aboveBar",
        color: pos.side === "long" ? "#0ecb81" : "#f6465d",
        shape: pos.side === "long" ? "arrowUp" : "arrowDown",
        text: "BOT " + String(pos.side).toUpperCase() + " " + (pos.entry_reason || ""),
        size: 1,
      });
    }
    return marks;
  }

  function updateBotTpLine() {
    if (botTpLine) { try { botTpLine.remove(); } catch (e) {} botTpLine = null; }
    if (!candleSeries || !botState) return;
    var pos = botState.positions && botState.positions[symbol];
    if (!pos || pos.tp == null) return;
    botTpLine = candleSeries.createPriceLine({
      price: pos.tp, color: "#fcd535", lineWidth: 1,
      lineStyle: LC.LineStyle.Dotted, axisLabelVisible: true, title: "BOT TP",
    });
  }

  async function fetchBotState() {
    var urls = botStateUrls();
    var i, err;
    for (i = 0; i < urls.length; i++) {
      try {
        var res = await fetch(urls[i], { cache: "no-store" });
        if (!res.ok) throw new Error("HTTP " + res.status);
        var data = await res.json();
        if (!data || data.schema !== "zigzag-paper-bot-1") throw new Error("unexpected schema");
        botState = data;
        renderBot();
        return data;
      } catch (e) {
        err = e;
      }
    }
    if (el.botStatus) {
      el.botStatus.textContent = "Could not load bot state";
      el.botStatus.className = "bot-live err";
    }
    return null;
  }

  function render(data, keepRange) {
    var closedRows = Z.closedKlines(data, true);
    var dec = priceDecimals(data);
    candleSeries.applyOptions({
      priceFormat: { type: "price", precision: dec, minMove: Math.pow(10, -dec) },
    });

    var candles = data.map(toCandle);
    var range = keepRange ? chart.timeScale().getVisibleLogicalRange() : null;
    candleSeries.setData(candles);

    var zz = Z.compute(Z.rowsToCandles(closedRows), paper.params.reversalPct);
    zzSeries.setData(Z.linePoints(zz));
    zzActiveSeries.setData(Z.activePoints(zz));

    var rsiPoints = rsiWilder(candles, 14);
    rsiSeries.setData(rsiPoints);
    rsiSeries.applyOptions({ title: latestRsiTitle(rsiPoints) });
    var rsiMap = {};
    rsiPoints.forEach(function (pt) { rsiMap[pt.time] = pt.value; });

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
    var rsiBlocks = zz.pivots.filter(function (p) {
      var sig = Z.signalForPivot(p);
      if (!sig) return false;
      var rsi = rsiMap[p.confirmTime];
      var side = sig.side;
      var check = P.rsiEntryOk(side, rsi);
      return !check.ok;
    }).map(function (p) {
      var rsi = rsiMap[p.confirmTime];
      var note = P.rsiEntryOk(Z.signalForPivot(p).side, rsi).note;
      return {
        time: p.confirmTime || p.time,
        position: p.type === "LOW" ? "belowBar" : "aboveBar",
        color: "#848e9c",
        shape: "square",
        text: "RSI block",
        size: 0.7,
      };
    });
    zzMarkersApi.setMarkers(zzMarks.concat(rsiBlocks, botMarkers()));
    updateBotTpLine();
    if (botState) renderBot();

    if (range) chart.timeScale().setVisibleLogicalRange(range);
    else {
      var visible = Math.min(120, candles.length);
      chart.timeScale().setVisibleLogicalRange({ from: candles.length - visible, to: candles.length + 2 });
    }

    var lastPx = markPrice != null ? markPrice : (data.length ? Number(data[data.length - 1][4]) : null);
    el.price.textContent = fmtPrice(lastPx, dec);
    el.mark.textContent = fmtPrice(lastPx, dec);

    var lastPivot = zz.pivots.length ? zz.pivots[zz.pivots.length - 1] : null;
    var lastSig = Z.signalForPivot(lastPivot);
    if (lastSig) {
      var lastRsi = lastPivot ? rsiMap[lastPivot.confirmTime] : null;
      var lastCheck = P.rsiEntryOk(lastSig.side, lastRsi);
      if (lastCheck.ok) {
        el.sig.textContent = lastSig.signal;
        el.sig.className = "val " + lastSig.signal;
      } else {
        el.sig.textContent = lastSig.signal + " blocked";
        el.sig.className = "val";
      }
    } else {
      el.sig.textContent = "—";
      el.sig.className = "val";
    }
    el.pivot.textContent = lastPivot ? fmtPrice(lastPivot.price, dec) : "—";
    el.label.textContent = lastPivot && lastPivot.label ? lastPivot.label : (lastPivot ? lastPivot.type : "—");
    if (lastPivot && lastPivot.label) {
      el.label.className = "val " + ((lastPivot.label === "HH" || lastPivot.label === "HL") ? "up" : "down");
    } else {
      el.label.className = "val";
    }

    el.trend.textContent = zz.trend;
    el.trend.className = "val " + (zz.trendKind === "up" ? "up" : zz.trendKind === "down" ? "down" : "");
    el.trigger.textContent = zz.trigger != null ? fmtPrice(zz.trigger, dec) : "—";

    renderList(zz.pivots, dec, rsiMap);
    onMarketUpdate(closedRows, zz, lastPx, dec);
    el.msg.style.display = "none";
  }

  function renderList(pivots, dec, rsiMap) {
    if (!pivots.length) {
      el.signals.innerHTML = '<div class="empty">No confirmed ZigZag pivots in the last ' + klines.length + " " + tf + " candles.</div>";
      return;
    }
    rsiMap = rsiMap || {};
    var rows = pivots.slice().reverse();
    var html = '<div class="sig-head"><div>Time (WIB)</div><div>Signal</div><div>Label</div><div>Pivot</div></div>';
    html += rows.map(function (p) {
      var closeMs = p.confirmCloseTime || (p.confirmTime ? p.confirmTime * 1000 : p.time * 1000);
      var w = Z.formatWib(closeMs);
      var sig = Z.signalForPivot(p);
      var rsi = rsiMap[p.confirmTime];
      var dir, cls, label;
      if (sig) {
        var check = P.rsiEntryOk(sig.side, rsi);
        if (check.ok) {
          dir = sig.signal;
          cls = sig.side;
          label = dir + " · " + check.note;
        } else {
          dir = sig.signal + " blocked";
          cls = "BLOCK";
          label = dir + " · " + check.note;
        }
      } else {
        dir = "—";
        cls = "";
        label = (p.label || p.type) + (rsi != null ? " · RSI " + Number(rsi).toFixed(2) : "");
      }
      return (
        '<div class="sig-row">' +
          '<div class="when">' + w.time + "<small>" + w.date + "</small></div>" +
          '<div><span class="dir ' + cls + '">' + dir + "</span></div>" +
          '<div class="hide-sm">' + (p.label || p.type) + (rsi != null && sig ? " · RSI " + Number(rsi).toFixed(2) : "") + "</div>" +
          '<div class="hide-sm">' + fmtPrice(p.price, dec) + "</div>" +
          '<div class="meta">' + label + " · " + fmtPrice(p.price, dec) + "</div>" +
        "</div>"
      );
    }).join("");
    el.signals.innerHTML = html;
  }

  function priceMap() {
    var map = {};
    var src = paper.lastPrices || {};
    Object.keys(src).forEach(function (sym) { map[sym] = src[sym]; });
    if (markPrice != null) map[symbol] = markPrice;
    return map;
  }

  function logPaperEvents(events) {
    (events || []).forEach(function (ev) {
      if (ev.type === "skip") {
        var pv = ev.pivot || {};
        logEngine("RSI blocked " + String(ev.side || "").toLowerCase() + " " + Z.shortName(ev.symbol) + " " + (pv.label || "") + " · " + (ev.reason || "RSI filter"), "WARN");
        return;
      }
      if (ev.type === "close") {
        var tr = ev.trade;
        logEngine("Closed " + tr.side + " " + Z.shortName(tr.symbol) + " · " + tr.exitReason + " · PnL " + fmtPrice(tr.pnl, 2), tr.pnl >= 0 ? "OK" : "ERR");
      } else if (ev.type === "open" || ev.type === "reverse") {
        var pos = ev.position;
        var tag = ev.type === "reverse" ? "Reversed into " : "Opened ";
        logEngine(tag + pos.side + " " + Z.shortName(pos.symbol) + " @ " + fmtPrice(pos.entry) + " · " + (pos.reason || "") + " · " + (pos.tf || ENGINE_TF), "OK");
      }
    });
  }

  function walkClosed(sym, closedRows) {
    var candles = Z.rowsToCandles(closedRows);
    var zz = Z.compute(candles, paper.params.reversalPct);
    var events = P.walkSymbol(paper, sym, candles, zz.pivots, ENGINE_TF);
    if (events.length) {
      logPaperEvents(events);
      P.save(paper);
    } else {
      P.save(paper);
    }
    return events;
  }

  async function tickEngineCoins() {
    if (!paper.engineOn) return;
    var i, sym, rows, closedRows;
    for (i = 0; i < Z.COINS.length; i++) {
      sym = Z.COINS[i];
      try {
        if (sym === symbol && tf === ENGINE_TF && klines.length) rows = klines;
        else rows = await fetchKlines(sym, ENGINE_TF);
      } catch (e) {
        logEngine("Could not refresh " + Z.shortName(sym) + " 15m for the sandbox.", "WARN");
        continue;
      }
      closedRows = Z.closedKlines(rows, true);
      walkClosed(sym, closedRows);
    }
  }

  function startEngineTimer() {
    stopEngineTimer();
    tickEngineCoins();
    engineTimer = setInterval(function () {
      if (paper.engineOn) tickEngineCoins();
    }, 60000);
  }

  function stopEngineTimer() {
    if (engineTimer) {
      clearInterval(engineTimer);
      engineTimer = null;
    }
  }

  function renderLedger(dec) {
    var opens = P.openPositions(paper);
    var pxMap = priceMap();
    var eq = P.equity(paper, pxMap);
    el.equity.textContent = fmtPrice(eq, 2) + " USDT";
    el.equity.className = "val " + (eq >= P.STARTING_BALANCE ? "up" : "down");
    var visible = null;
    opens.forEach(function (p) { if (p.symbol === symbol) visible = p; });
    updateLevelLines(visible);

    if (!paper.trades.length && !opens.length) {
      el.ledger.innerHTML = '<div class="empty">No paper trades yet. Start the sandbox to simulate the bot rules on confirmed LL / HH pivots.</div>';
      return;
    }
    var html = '<div class="tr-head"><div>Time</div><div>Side</div><div>Symbol</div><div>Exit</div><div>PnL</div></div>';
    opens.forEach(function (pos) {
      var px = pxMap[pos.symbol];
      var u = P.unrealized(pos, px);
      var slTxt = pos.sl != null ? "SL " + fmtPrice(pos.sl, dec) : "SL off";
      html += '<div class="tr-row">' +
        '<div class="when">OPEN<small>' + Z.shortName(pos.symbol) + " " + (pos.tf || ENGINE_TF) + "</small></div>" +
        '<div><span class="pill ' + pos.side + '">' + pos.side + "</span></div>" +
        '<div class="hide-sm">' + fmtPrice(pos.entry, dec) + " → " + fmtPrice(px, dec) + "</div>" +
        '<div class="hide-sm">' + slTxt + "</div>" +
        '<div class="pnl ' + (u >= 0 ? "pos" : "neg") + '">' + (u >= 0 ? "+" : "") + fmtPrice(u, 2) + "</div>" +
        '<div class="meta">Entry ' + fmtPrice(pos.entry, dec) + " · uPnL " + fmtPrice(u, 2) + "</div>" +
      "</div>";
    });
    html += paper.trades.map(function (tr) {
      var w = Z.formatWib(tr.closedAt);
      var pnl = tr.pnl;
      return '<div class="tr-row">' +
        '<div class="when">' + w.time + "<small>" + w.date + "</small></div>" +
        '<div><span class="pill ' + tr.side + '">' + tr.side + "</span></div>" +
        '<div class="hide-sm">' + Z.shortName(tr.symbol) + " " + (tr.tf || "") + "</div>" +
        '<div class="hide-sm">' + (tr.exitReason || "") + "</div>" +
        '<div class="pnl ' + (pnl >= 0 ? "pos" : "neg") + '">' + (pnl >= 0 ? "+" : "") + fmtPrice(pnl, 2) + "</div>" +
        '<div class="meta">' + Z.shortName(tr.symbol) + " · " + (tr.exitReason || "") + "</div>" +
      "</div>";
    }).join("");
    el.ledger.innerHTML = html;
  }

  function onMarketUpdate(closedRows, zz, lastPx, dec) {
    if (paper.engineOn && tf === ENGINE_TF && Z.COINS.indexOf(symbol) !== -1) {
      var lastBar = closedRows.length ? closedRows[closedRows.length - 1] : null;
      var closedOpen = lastBar ? Number(lastBar[0]) : null;
      if (closedOpen && closedOpen !== lastClosedOpen) {
        lastClosedOpen = closedOpen;
        walkClosed(symbol, closedRows);
      }
    }
    renderLedger(dec);
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
      logEngine("Live feed " + tmpl.label + " · " + Z.shortName(sym) + " " + interval, "OK");
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
    try { localStorage.setItem(Z.TF_STORAGE_KEY, interval); } catch (e) {}
  }

  function highlight() {
    if (el.coinSelect) el.coinSelect.value = symbol;
    if (el.timeframes) {
      var buttons = el.timeframes.querySelectorAll("button");
      for (var i = 0; i < buttons.length; i++) {
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
    el.msg.textContent = "Loading " + Z.shortName(sym) + " " + interval + " candles…";
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
      logEngine("REST fetch failed for " + Z.shortName(sym) + " " + interval + ".", "ERR");
      setTimeout(function () { if (symbol === sym && tf === interval) load(sym, interval, false); }, 4000);
    }
  }

  function addOption(select, sym) {
    var opt = document.createElement("option");
    opt.value = sym;
    opt.textContent = Z.shortName(sym);
    select.appendChild(opt);
  }

  function buildSwitcher() {
    var select = el.coinSelect;
    select.innerHTML = "";
    Z.COINS.forEach(function (sym) { addOption(select, sym); });
    select.value = symbol;
    select.addEventListener("change", function () {
      var sym = select.value;
      if (sym && sym !== symbol) load(sym, tf);
    });
    el.timeframes.innerHTML = "";
    Z.TIMEFRAMES.forEach(function (interval) {
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
      var closed = Z.closedKlines(klines, true);
      lastClosedOpen = closed.length ? Number(closed[closed.length - 1][0]) : null;
      logEngine("Local sandbox ON · ZigZag Paper Bot rules · 15m · reversal " + paper.params.reversalPct + "% · notional " + P.notionalOf(paper.params) + " USDT · SL " + (paper.params.slPct > 0 ? paper.params.slPct + "%" : "off") + ". This tab only, not the 24/7 book.", "WARN");
      startEngineTimer();
    } else {
      stopEngineTimer();
      logEngine("Sandbox OFF. Open simulated positions stay until you flatten or they hit TP or HH/LL.", "WARN");
    }
  }

  function flatten() {
    var opens = P.openPositions(paper);
    if (!opens.length) {
      logEngine("No open paper position to flatten.", "WARN");
      return;
    }
    var results = P.flattenAll(paper, priceMap());
    results.forEach(function (closed) {
      if (closed.ok) logEngine("Flattened " + closed.trade.side + " " + Z.shortName(closed.trade.symbol) + " · PnL " + fmtPrice(closed.trade.pnl, 2), closed.trade.pnl >= 0 ? "OK" : "ERR");
    });
    renderLedger();
  }

  function resetWallet() {
    if (!window.confirm("Reset the paper wallet to 200 USDT and clear the trade ledger?")) return;
    var on = paper.engineOn;
    var params = paper.params;
    paper = P.reset(paper);
    paper.engineOn = on;
    paper.params = params;
    P.save(paper);
    fillFormFromState();
    setEngineButton();
    logEngine("Paper wallet reset to 200 USDT.", "WARN");
    renderLedger();
  }

  ["reversalPct", "slPct", "tpPct", "leverage", "margin", "shorts"].forEach(function (id) {
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

  window.addEventListener("pagehide", function () { destroyed = true; closeWs(); });

  if (!LC || !Z || !P) {
    setFeed("err", "SCRIPT");
    el.msg.textContent = "A required script failed to load.";
    return;
  }

  fillFormFromState();
  setEngineButton();
  buildSwitcher();
  buildChart();
  logEngine("ZigZag Paper Bot ready. The official 24/7 book runs on this box even when this tab is closed. The local sandbox is this browser only. No API keys, no live orders.", "OK");
  fetchBotState().then(function () {
    if (klines.length) render(klines, true);
  });
  setInterval(function () {
    fetchBotState().then(function () {
      if (klines.length && zzMarkersApi) render(klines, true);
    });
  }, 60000);
  load(symbol, tf, true);
})();
