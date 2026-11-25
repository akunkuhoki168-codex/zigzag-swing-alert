#!/usr/bin/env python3
"""ZigZag Swing Alert — paper-only Streamlit dashboard for Binance USD-M Futures."""

from __future__ import annotations

import json
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pandas as pd
import plotly.graph_objects as go
import requests
import streamlit as st

import data
import paper
import zigzag as Z

STATE_PATH = Path(__file__).resolve().parent / "state" / "paper.json"
BOT_STATE_PATHS = [
    Path(__file__).resolve().parent.parent / "data" / "paper_state.json",
    Path("/workspace/adx-alert-dashboard/data/paper_state.json"),
    Path("/workspace/zigzag-app/../adx-alert-dashboard/data/paper_state.json"),
]
BOT_STATE_URL = "https://raw.githubusercontent.com/dedkovic441-hub/zigzag-swing-alert/main/data/paper_state.json"
WIB = timezone(timedelta(hours=7))
REFRESH_SEC = 5

st.set_page_config(
    page_title="ZigZag Swing Alert",
    page_icon="⚡",
    layout="wide",
    initial_sidebar_state="expanded",
)


def wib(ts_ms: int | float | None = None, ts_s: int | float | None = None) -> datetime:
    if ts_ms is not None:
        return datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc).astimezone(WIB)
    return datetime.fromtimestamp(float(ts_s or 0), tz=timezone.utc).astimezone(WIB)


def fmt_wib(ts_ms: int | float | None = None, ts_s: int | float | None = None) -> str:
    try:
        return wib(ts_ms=ts_ms, ts_s=ts_s).strftime("%Y-%m-%d %H:%M WIB")
    except (TypeError, ValueError, OSError):
        return "—"


def log(msg: str, kind: str = "info") -> None:
    logs = st.session_state.setdefault("logs", [])
    stamp = datetime.now(WIB).strftime("%H:%M:%S")
    logs.append({"t": stamp, "msg": msg, "kind": kind})
    st.session_state.logs = logs[-250:]


def init_state() -> None:
    if "paper" not in st.session_state:
        st.session_state.paper = paper.load(STATE_PATH)
        st.session_state.logs = st.session_state.get("logs") or []
        st.session_state.last_closed_open = None
        st.session_state.last_symbol_tf = None
        if not st.session_state.logs:
            log("ZigZag Swing Alert ready. Paper trading only — no API keys, no live orders.", "ok")


def persist() -> None:
    paper.save(STATE_PATH, st.session_state.paper)


def load_bot_state() -> tuple[dict | None, str]:
    for path in BOT_STATE_PATHS:
        try:
            if path.exists():
                data_obj = json.loads(path.read_text())
                if isinstance(data_obj, dict) and data_obj.get("schema") == "zigzag-paper-bot-1":
                    return data_obj, str(path)
        except (OSError, json.JSONDecodeError):
            continue
    try:
        res = requests.get(
            BOT_STATE_URL,
            params={"t": int(time.time())},
            timeout=12,
            headers={"User-Agent": "ZigZagSwingAlert/1.0", "Cache-Control": "no-cache"},
        )
        res.raise_for_status()
        data_obj = res.json()
        if isinstance(data_obj, dict) and data_obj.get("schema") == "zigzag-paper-bot-1":
            return data_obj, "GitHub raw"
    except Exception as e:
        return None, str(e)
    return None, "unavailable"


def bot_upnl(pos: dict, price: float | None, config: dict) -> float:
    if not pos or price is None or price <= 0:
        return 0.0
    fee = float(config.get("fee_pct") or 0.04) / 100.0
    qty = float(pos["qty"])
    entry = float(pos["entry"])
    entry_fee = float(pos.get("entry_fee") or float(pos.get("notional") or 0) * fee)
    exit_fee = price * qty * fee
    if pos["side"] == "long":
        return (price - entry) * qty - entry_fee - exit_fee
    return (entry - price) * qty - entry_fee - exit_fee


def add_bot_markers(fig: go.Figure, bot: dict | None, symbol: str) -> None:
    if not bot:
        return
    xs_in, ys_in, txt_in, col_in = [], [], [], []
    xs_out, ys_out, txt_out = [], [], []
    for tr in bot.get("trades") or []:
        if tr.get("symbol") != symbol:
            continue
        if tr.get("entry_time"):
            xs_in.append(wib(ts_s=tr["entry_time"]))
            ys_in.append(tr["entry"])
            txt_in.append(f"BOT {tr['side'].upper()} {tr.get('entry_reason') or ''}")
            col_in.append("#0ecb81" if tr["side"] == "long" else "#f6465d")
        if tr.get("exit_time"):
            xs_out.append(wib(ts_s=tr["exit_time"]))
            ys_out.append(tr["exit"])
            txt_out.append(f"EXIT {tr.get('exit_reason') or ''}")
    pos = (bot.get("positions") or {}).get(symbol)
    if pos and pos.get("entry_time"):
        xs_in.append(wib(ts_s=pos["entry_time"]))
        ys_in.append(pos["entry"])
        txt_in.append(f"BOT {pos['side'].upper()} {pos.get('entry_reason') or ''}")
        col_in.append("#0ecb81" if pos["side"] == "long" else "#f6465d")
        if pos.get("tp") is not None:
            fig.add_hline(
                y=pos["tp"],
                line_dash="dot",
                line_color="#fcd535",
                annotation_text="BOT TP",
                annotation_position="top left",
            )
    if xs_in:
        fig.add_trace(go.Scatter(
            x=xs_in, y=ys_in, mode="markers+text",
            marker=dict(size=12, color=col_in, symbol="triangle-up"),
            text=txt_in, textposition="bottom center",
            textfont=dict(size=10, color="#eaecef"),
            name="Bot entry",
            hovertemplate="%{text} %{y}<extra></extra>",
        ))
    if xs_out:
        fig.add_trace(go.Scatter(
            x=xs_out, y=ys_out, mode="markers+text",
            marker=dict(size=11, color="#fcd535", symbol="square"),
            text=txt_out, textposition="top center",
            textfont=dict(size=10, color="#fcd535"),
            name="Bot exit",
            hovertemplate="%{text} %{y}<extra></extra>",
        ))


def render_bot_panel(bot: dict | None, source: str, symbol: str, last_px: float | None) -> None:
    st.subheader("24/7 Paper Bot")
    st.caption(
        "Official simulated book. Long on confirmed LL only if RSI(14) at that close is below 32; "
        "short on confirmed HH only if RSI(14) is above 68. "
        "A long exits on +1.5% TP or HH (LH is ignored). A short exits on +1.5% TP or LL (HL is ignored). "
        "A same-candle reverse still closes on HH/LL, but the new entry opens only if RSI confirms. "
        "No stop-loss. Runs on GitHub Actions about every five minutes and does not need this app to stay open. "
        "Paper only — no API keys, no real orders."
    )
    if not bot:
        st.warning(f"Could not load bot state ({source}).")
        return
    cfg = bot.get("config") or {}
    positions = bot.get("positions") or {}
    open_rows = []
    eq = float(bot.get("cash") or 0)
    for sym, pos in positions.items():
        if not pos:
            continue
        px = last_px if sym == symbol else (bot.get("last_prices") or {}).get(sym)
        u = bot_upnl(pos, px, cfg)
        eq += u
        open_rows.append({
            "Coin": Z.short_name(sym),
            "Side": pos.get("side"),
            "Entry reason": pos.get("entry_reason"),
            "Entry": pos.get("entry"),
            "Mark": px,
            "TP": pos.get("tp"),
            "uPnL": round(u, 2),
            "Opened (WIB)": fmt_wib(ts_ms=pos.get("entry_close_time")),
        })
    stats = bot.get("stats") or {}
    c1, c2, c3, c4 = st.columns(4)
    start = float(cfg.get("starting_balance") or 200)
    c1.metric("Bot equity", f"{data.fmt_price(eq, 2)} USDT", delta=round(eq - start, 2))
    c2.metric("Win rate", f"{stats.get('win_rate', 0):.1f}%" if stats.get("trades") else "—")
    c3.metric("Open positions", str(len(open_rows)))
    c4.metric("Last bot run", bot.get("last_run_at_wib") or "—")
    note = " · ".join(filter(None, [
        f"Feed {bot.get('data_source') or '—'}" + (f" ({bot.get('data_market')})" if bot.get("data_market") else ""),
        "No stop-loss",
        f"Source {source}",
        bot.get("data_note") or "",
    ]))
    st.caption(note)
    st.markdown("**Open positions**")
    if open_rows:
        st.dataframe(pd.DataFrame(open_rows), use_container_width=True, hide_index=True)
    else:
        st.info("No open bot positions. The book starts flat and only trades newly closed 15m candles.")
    st.markdown("**Bot trade history**")
    trades = list(reversed(bot.get("trades") or []))
    if not trades:
        st.info("No bot trades yet. The first run seeds a flat book from now.")
    else:
        rows = []
        for tr in trades[:80]:
            rows.append({
                "Exit (WIB)": fmt_wib(ts_ms=tr.get("exit_close_time")),
                "Coin": Z.short_name(tr.get("symbol") or ""),
                "Side": tr.get("side"),
                "Entry → Exit": f"{tr.get('entry')} → {tr.get('exit')}",
                "Reason": f"{tr.get('entry_reason') or ''} → {tr.get('exit_reason') or ''}",
                "PnL": tr.get("pnl"),
            })
        st.dataframe(pd.DataFrame(rows), use_container_width=True, hide_index=True, height=280)


def build_chart(all_candles: list, zz: dict, pos: dict | None, dec: int, bot: dict | None = None, symbol: str | None = None) -> go.Figure:
    times = [wib(ts_s=c["time"]) for c in all_candles]
    fig = go.Figure(
        data=[
            go.Candlestick(
                x=times,
                open=[c["open"] for c in all_candles],
                high=[c["high"] for c in all_candles],
                low=[c["low"] for c in all_candles],
                close=[c["close"] for c in all_candles],
                increasing_line_color="#0ecb81",
                increasing_fillcolor="#0ecb81",
                decreasing_line_color="#f6465d",
                decreasing_fillcolor="#f6465d",
                name="Price",
                whiskerwidth=0.8,
            )
        ]
    )
    pivots = zz["pivots"]
    if pivots:
        fig.add_trace(
            go.Scatter(
                x=[wib(ts_s=p["time"]) for p in pivots],
                y=[p["price"] for p in pivots],
                mode="lines",
                line=dict(color="#fcd535", width=2),
                name="ZigZag",
                hovertemplate="%{y}<extra>ZigZag</extra>",
            )
        )
        labeled = [p for p in pivots if p.get("label")]
        if labeled:
            colors = ["#0ecb81" if p["label"] in ("HH", "HL") else "#f6465d" for p in labeled]
            fig.add_trace(
                go.Scatter(
                    x=[wib(ts_s=p["time"]) for p in labeled],
                    y=[p["price"] for p in labeled],
                    mode="markers+text",
                    marker=dict(size=8, color=colors, line=dict(width=0)),
                    text=[p["label"] for p in labeled],
                    textposition=["bottom center" if p["type"] == "LOW" else "top center" for p in labeled],
                    textfont=dict(color=colors, size=11, family="Inter, sans-serif"),
                    name="Structure",
                    hovertemplate="%{text} %{y}<extra></extra>",
                )
            )
    active = zz.get("active")
    if active and active["from"] and active["time"] > active["from"]["time"]:
        fig.add_trace(
            go.Scatter(
                x=[wib(ts_s=active["from"]["time"]), wib(ts_s=active["time"])],
                y=[active["from"]["price"], active["price"]],
                mode="lines",
                line=dict(color="#fcd535", width=2, dash="dash"),
                name="Active leg",
                hovertemplate="%{y}<extra>Active</extra>",
            )
        )
    if pos:
        fig.add_hline(y=pos["sl"], line_dash="dash", line_color="#f6465d", annotation_text="SL", annotation_position="bottom right")
        fig.add_hline(y=pos["tp"], line_dash="dash", line_color="#0ecb81", annotation_text="TP", annotation_position="top right")
    if bot and symbol:
        add_bot_markers(fig, bot, symbol)

    fig.update_layout(
        template="plotly_dark",
        paper_bgcolor="#181a20",
        plot_bgcolor="#0b0e11",
        font=dict(color="#848e9c", size=11),
        height=560,
        margin=dict(l=8, r=8, t=24, b=8),
        xaxis_rangeslider_visible=False,
        xaxis=dict(gridcolor="#2b3139", showgrid=True, title=None),
        yaxis=dict(gridcolor="#2b3139", side="right", tickformat=f".{dec}f"),
        legend=dict(orientation="h", yanchor="bottom", y=1.02, x=0),
        uirevision="zz-chart",
        hovermode="x unified",
    )
    return fig


def maybe_trade(symbol: str, tf: str, closed: list, zz: dict, last_px: float | None) -> None:
    state = st.session_state.paper
    last_bar = closed[-1] if closed else None
    forming = None
    # forming bar is handled by caller via manage()
    if not state.get("engine_on"):
        return
    closed_open = int(last_bar["time"]) * 1000 if last_bar else None
    if not closed_open or closed_open == st.session_state.last_closed_open:
        return
    st.session_state.last_closed_open = closed_open
    if not zz["pivots"]:
        return
    pivot = zz["pivots"][-1]
    key = Z.pivot_key(symbol, tf, pivot)
    if key == state.get("last_pivot_key"):
        return
    state["last_pivot_key"] = key
    sig = Z.signal_for_pivot(pivot)
    if not sig or state.get("position"):
        persist()
        return
    params = state["params"]
    if sig["side"] == "SHORT" and not params["shorts"]:
        log(f"Skip short on {Z.short_name(symbol)} — shorts disabled.", "warn")
        persist()
        return
    if params["structure_filter"] and not Z.structure_allows(pivot, params["shorts"]):
        log(
            f"Skip {sig['side']} — structure filter wants HL for longs and LH for shorts "
            f"(got {pivot.get('label') or pivot['type']}).",
            "warn",
        )
        persist()
        return
    price = last_bar["close"] if last_bar else last_px
    opened = paper.open_position(
        state,
        symbol=symbol,
        tf=tf,
        side=sig["side"],
        price=price,
        reason=f"ZigZag {pivot.get('label') or pivot['type']}",
    )
    if not opened["ok"]:
        log(f"Did not open {sig['side']}: {opened['reason']}", "warn")
    else:
        log(
            f"Opened {sig['side']} {Z.short_name(symbol)} @ {data.fmt_price(price)} · "
            f"{pivot.get('label') or pivot['type']} · {tf}",
            "ok",
        )
    persist()


def main() -> None:
    init_state()
    state = st.session_state.paper
    params = state["params"]

    # ---- sidebar settings (same defaults as the Pages dashboard) ----
    st.sidebar.markdown("### Settings")
    st.sidebar.caption("Paper simulation only. These never place real orders.")
    reversal = st.sidebar.slider("ZigZag reversal %", 0.2, 10.0, float(params["reversal_pct"]), 0.1)
    sl_pct = st.sidebar.number_input("Stop loss %", 0.1, 50.0, float(params["sl_pct"]), 0.1)
    tp_pct = st.sidebar.number_input("Take profit %", 0.1, 100.0, float(params["tp_pct"]), 0.1)
    leverage = st.sidebar.number_input("Leverage", 1, 50, int(params["leverage"]), 1)
    margin = st.sidebar.number_input("Margin (USDT)", 1.0, 10000.0, float(params["margin"]), 1.0)
    shorts = st.sidebar.checkbox("Allow shorts", value=bool(params["shorts"]))
    structure = st.sidebar.checkbox("Structure filter (HL / LH only)", value=bool(params["structure_filter"]))

    new_params = paper.clamp_params({
        "reversal_pct": reversal,
        "sl_pct": sl_pct,
        "tp_pct": tp_pct,
        "leverage": leverage,
        "margin": margin,
        "shorts": shorts,
        "structure_filter": structure,
    })
    if new_params != params:
        state["params"] = new_params
        persist()
        params = new_params

    c1, c2 = st.sidebar.columns(2)
    if c1.button("Flatten paper", use_container_width=True):
        pos = state.get("position")
        if not pos:
            log("No open paper position to flatten.", "warn")
        else:
            # price filled after load; flatten uses last mark stored on position later
            st.session_state["_flatten"] = True
            st.rerun()
    if c2.button("Reset wallet", use_container_width=True):
        st.session_state.paper = paper.reset(state)
        persist()
        log("Paper wallet reset to 200 USDT.", "warn")
        st.rerun()

    # ---- header ----
    left, mid, right = st.columns([2.4, 1.4, 1.2])
    with left:
        st.markdown(
            "<div style='display:flex;align-items:center;gap:10px;flex-wrap:wrap'>"
            "<span style='font-size:1.35rem;font-weight:700;color:#eaecef'>ZigZag Swing Alert</span>"
            "<span style='font-size:11px;font-weight:700;letter-spacing:.04em;color:#fcd535;"
            "border:1px solid rgba(252,213,53,.3);background:rgba(252,213,53,.15);"
            "border-radius:999px;padding:2px 8px'>PAPER MODE</span></div>"
            "<div style='color:#848e9c;font-size:0.8rem;margin-top:2px'>"
            "Non-repainting bar-close ZigZag · Binance USD-M · no real orders</div>",
            unsafe_allow_html=True,
        )
    with mid:
        default_sym = "NEARUSDT" if "NEARUSDT" in Z.ALL_COINS else Z.ALL_COINS[0]
        symbol = st.selectbox(
            "Coin",
            Z.ALL_COINS,
            index=Z.ALL_COINS.index(default_sym),
            format_func=lambda s: Z.short_name(s),
            key="coin",
        )
    with right:
        tf = st.selectbox("Timeframe", Z.TIMEFRAMES, index=Z.TIMEFRAMES.index(Z.DEFAULT_TF), key="tf")

    engine_col, _ = st.columns([1, 3])
    engine_label = "Stop local sandbox" if state.get("engine_on") else "Start local sandbox"
    if engine_col.button(engine_label, type="primary" if not state.get("engine_on") else "secondary"):
        state["engine_on"] = not state.get("engine_on")
        if state["engine_on"]:
            st.session_state.last_closed_open = "pending"
            log(
                f"Local sandbox ON · {Z.short_name(symbol)} {tf} · reversal {params['reversal_pct']}% · "
                f"{params['leverage']}x. This app only, not the 24/7 bot.",
                "warn",
            )
        else:
            log("Paper engine OFF. Open simulated positions stay until you flatten or they hit SL/TP.", "warn")
        persist()
        st.rerun()

    pair = (symbol, tf)
    if st.session_state.last_symbol_tf != pair:
        st.session_state.last_symbol_tf = pair
        if st.session_state.last_closed_open != "pending":
            st.session_state.last_closed_open = None

    @st.fragment(run_every=timedelta(seconds=REFRESH_SEC))
    def live() -> None:
        state = st.session_state.paper
        params = state["params"]
        try:
            rows, src = data.fetch_klines(symbol, tf)
        except Exception as e:
            st.error(f"Could not load Binance Futures candles ({e}). Retrying automatically.")
            return
        mark = data.fetch_mark_price(symbol)
        last_px = mark if mark is not None else float(rows[-1][4])
        dec = data.price_decimals(rows)

        if st.session_state.pop("_flatten", False):
            if state.get("position"):
                closed_pos = paper.close_position(state, price=last_px, reason="Manual flatten")
                if closed_pos["ok"]:
                    tr = closed_pos["trade"]
                    log(
                        f"Flattened {tr['side']} {Z.short_name(tr['symbol'])} · PnL {data.fmt_price(tr['pnl'], 2)}",
                        "ok" if tr["pnl"] >= 0 else "err",
                    )
                persist()

        closed = Z.to_candles(Z.closed_rows(rows))
        all_c = Z.to_candles(rows)
        zz = Z.compute(closed, params["reversal_pct"])

        forming = all_c[-1] if all_c else None
        same_symbol = bool(state.get("position") and state["position"]["symbol"] == symbol)
        closed_trade = paper.manage(state, last_px, forming if same_symbol else None)
        if closed_trade and closed_trade.get("ok"):
            tr = closed_trade["trade"]
            log(
                f"Closed {tr['side']} {Z.short_name(tr['symbol'])} · {tr['exit_reason']} · "
                f"PnL {data.fmt_price(tr['pnl'], 2)}",
                "ok" if tr["pnl"] >= 0 else "err",
            )
            persist()

        if st.session_state.last_closed_open == "pending":
            st.session_state.last_closed_open = closed[-1]["time"] * 1000 if closed else None

        maybe_trade(symbol, tf, closed, zz, last_px)
        state = st.session_state.paper
        bot, bot_src = load_bot_state()

        last_pivot = zz["pivots"][-1] if zz["pivots"] else None
        last_sig = Z.signal_for_pivot(last_pivot)
        eq = paper.equity(state, last_px)

        m1, m2, m3, m4, m5, m6, m7 = st.columns(7)
        m1.metric("Mark price", data.fmt_price(last_px, dec), help=f"Source {src}")
        m2.metric("Last signal", last_sig["signal"] if last_sig else "—")
        m3.metric("Last pivot", data.fmt_price(last_pivot["price"], dec) if last_pivot else "—")
        m4.metric("Structure", (last_pivot.get("label") or last_pivot["type"]) if last_pivot else "—")
        m5.metric("Trend state", zz["trend"])
        m6.metric("Reversal trigger", data.fmt_price(zz["trigger"], dec) if zz["trigger"] is not None else "—")
        m7.metric("Local sandbox equity", f"{data.fmt_price(eq, 2)} USDT")

        st.caption(
            f"Feed {src} · refresh every {REFRESH_SEC}s · default reversal {Z.DEFAULT_REVERSAL:g}% · "
            f"times in Asia/Jakarta (WIB, UTC+7)"
        )
        render_bot_panel(bot, bot_src, symbol, last_px)
        st.plotly_chart(
            build_chart(
                all_c,
                zz,
                state["position"] if same_symbol else None,
                dec,
                bot=bot if tf == "15m" else None,
                symbol=symbol,
            ),
            use_container_width=True,
        )

        sig_col, led_col = st.columns(2)
        with sig_col:
            st.subheader("Recent ZigZag signals")
            if not zz["pivots"]:
                st.info(f"No confirmed ZigZag pivots in the last {len(rows)} {tf} candles.")
            else:
                rows_out = []
                for p in reversed(zz["pivots"]):
                    sig = "long" if p["type"] == "LOW" else "short"
                    rows_out.append({
                        "Time (WIB)": fmt_wib(ts_ms=p.get("confirm_close_time") or p["time"] * 1000),
                        "Signal": f"{sig} (unconfirmed)",
                        "Label": p.get("label") or p["type"],
                        "Pivot": data.fmt_price(p["price"], dec),
                    })
                st.dataframe(pd.DataFrame(rows_out), use_container_width=True, hide_index=True, height=320)

        with led_col:
            st.subheader("Local sandbox ledger")
            pos = state.get("position")
            trades = state.get("trades") or []
            if not pos and not trades:
                st.info("No paper trades yet. Start the engine to simulate entries on confirmed ZigZag pivots.")
            else:
                led_rows = []
                if pos:
                    u = paper.unrealized(pos, last_px if pos["symbol"] == symbol else None)
                    led_rows.append({
                        "Time (WIB)": "OPEN",
                        "Side": pos["side"],
                        "Symbol": f"{Z.short_name(pos['symbol'])} {pos['tf']}",
                        "Exit": "open",
                        "PnL (USDT)": round(u, 2),
                    })
                for tr in trades:
                    led_rows.append({
                        "Time (WIB)": fmt_wib(ts_ms=tr.get("closed_at")),
                        "Side": tr["side"],
                        "Symbol": f"{Z.short_name(tr['symbol'])} {tr.get('tf') or ''}",
                        "Exit": tr.get("exit_reason") or "",
                        "PnL (USDT)": tr.get("pnl"),
                    })
                st.dataframe(pd.DataFrame(led_rows), use_container_width=True, hide_index=True, height=320)

        st.subheader("Engine console")
        logs = st.session_state.get("logs") or []
        if not logs:
            st.caption("No log lines yet.")
        else:
            lines = []
            for item in logs[-80:]:
                lines.append(f"{item['t']} WIB  {item['msg']}")
            st.code("\n".join(lines), language=None)

        st.caption(
            "ZigZag pivots confirm only on bar close, so they do not repaint. "
            "The 24/7 paper bot is the official simulated book and keeps running on GitHub Actions "
            "when this app is closed. The local sandbox is a separate what-if wallet stored on this computer. "
            "This app never sends orders and never asks for an API key."
        )

    live()


if __name__ == "__main__":
    main()
