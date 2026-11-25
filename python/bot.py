#!/usr/bin/env python3
"""24/7 paper-only ZigZag swing bot. No API keys, no real orders.

Rules (bar-close confirmed ZigZag, default 1.5% reversal, 15m closed candles):

  LONG  entry: newly confirmed pivot labelled LL, filled at the confirming
               candle's close, only if Wilder RSI(14) at that close is below 32.
  LONG  exit:  take-profit (default +1.5% from entry, checked against candle
               highs; fill at the TP price) or a newly confirmed HH,
               whichever comes first. LH is ignored at all times. There is
               no stop-loss.

  SHORT is the mirror: enter on a confirmed HH only if RSI(14) is above 68,
               take-profit at -1.5% (checked
               against candle lows). Exit on a confirmed LL. HL is ignored
               at all times.

  One position per coin. No new entry while a position is open, except:
  if an opposite entry signal confirms on the same candle as an exit
  (for example a long closes on an HH, which is also a short entry),
  close first, then open the reverse. Same-side re-entry on the exit
  candle is not taken.

This module is used by the GitHub Actions paper bot and can be run locally:

  python python/bot.py --live
  python python/bot.py --backtest
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import zigzag as Z  # noqa: E402

try:
    import requests
except ImportError:  # pragma: no cover
    requests = None  # type: ignore

SCHEMA = "zigzag-paper-bot-1"
WIB = timezone(timedelta(hours=7))
DEFAULT_STATE = HERE.parent / "data" / "paper_state.json"
DEFAULT_BACKTEST = HERE.parent / "data" / "backtest.json"
KLINE_LIMIT = 1500
BACKTEST_BARS = 1000
TIMEOUT = 15

DEFAULT_CONFIG: dict[str, Any] = {
    "coins": ["NEARUSDT", "INJUSDT", "RENDERUSDT", "FETUSDT", "ARBUSDT"],
    "timeframe": "15m",
    "reversal_pct": 1.5,
    "take_profit_pct": 1.5,
    "starting_balance": 200.0,
    "notional": 200.0,
    "fee_pct": 0.04,  # percent, per side
    "stop_loss": False,
    "rsi_period": 14,
    "rsi_long_max": 32.0,
    "rsi_short_min": 68.0,
}

# USD-M first, then public mirrors, then spot as a last resort.
# fapi.binance.com often returns 451 from US GitHub-hosted runners.
FUTURES_ENDPOINTS = [
    ("https://fapi.binance.com", "/fapi/v1/klines", "usd-m", "fapi.binance.com"),
    ("https://fapi1.binance.com", "/fapi/v1/klines", "usd-m", "fapi1.binance.com"),
    ("https://fapi2.binance.com", "/fapi/v1/klines", "usd-m", "fapi2.binance.com"),
    ("https://fapi3.binance.com", "/fapi/v1/klines", "usd-m", "fapi3.binance.com"),
    ("https://fapi4.binance.com", "/fapi/v1/klines", "usd-m", "fapi4.binance.com"),
    ("https://www.binance.com", "/fapi/v1/klines", "usd-m", "www.binance.com"),
    ("https://data-api.binance.vision", "/fapi/v1/klines", "usd-m", "data-api.binance.vision/fapi"),
]
SPOT_ENDPOINTS = [
    ("https://data-api.binance.vision", "/api/v3/klines", "spot", "data-api.binance.vision"),
    ("https://api.binance.com", "/api/v3/klines", "spot", "api.binance.com"),
    ("https://api1.binance.com", "/api/v3/klines", "spot", "api1.binance.com"),
]


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def iso(dt: datetime | None = None) -> str:
    return (dt or now_utc()).strftime("%Y-%m-%dT%H:%M:%SZ")


def iso_wib(dt: datetime | None = None) -> str:
    return (dt or now_utc()).astimezone(WIB).strftime("%Y-%m-%d %H:%M:%S WIB")


def clamp_config(raw: dict | None = None) -> dict[str, Any]:
    src = dict(DEFAULT_CONFIG)
    if raw:
        src.update(raw)
    coins = src.get("coins") or list(DEFAULT_CONFIG["coins"])
    coins = [str(c).upper() for c in coins if str(c).strip()]
    if not coins:
        coins = list(DEFAULT_CONFIG["coins"])
    def fnum(key: str, lo: float, hi: float) -> float:
        try:
            n = float(src[key])
        except (TypeError, ValueError, KeyError):
            n = float(DEFAULT_CONFIG[key])
        return min(hi, max(lo, n))
    return {
        "coins": coins,
        "timeframe": str(src.get("timeframe") or "15m"),
        "reversal_pct": fnum("reversal_pct", 0.2, 10.0),
        "take_profit_pct": fnum("take_profit_pct", 0.1, 100.0),
        "starting_balance": fnum("starting_balance", 100.0, 10_000_000.0),
        "notional": fnum("notional", 10.0, 1_000_000.0),
        "fee_pct": fnum("fee_pct", 0.0, 1.0),
        "stop_loss": False,
        "rsi_period": int(round(fnum("rsi_period", 2.0, 100.0))),
        "rsi_long_max": fnum("rsi_long_max", 0.0, 100.0),
        "rsi_short_min": fnum("rsi_short_min", 0.0, 100.0),
    }


def empty_state(config: dict | None = None) -> dict[str, Any]:
    cfg = clamp_config(config)
    return {
        "schema": SCHEMA,
        "mode": "paper",
        "no_real_orders": True,
        "no_stop_loss": True,
        "rules": (
            "Long on confirmed LL only if RSI(14) at the confirming close is below "
            "32. Exit at +TP% (on candle high) or a confirmed HH, whichever comes "
            "first. LH is ignored at all times. Short is the mirror: enter on HH "
            "only if RSI(14) is above 68, TP on candle low, exit only on a confirmed "
            "LL. HL is ignored at all times. No stop-loss. One position per coin. "
            "Reverse if an opposite entry confirms on the same candle as an exit "
            "and RSI also confirms that entry (HH closes a long and may open a "
            "short; LL is the mirror)."
        ),
        "config": cfg,
        "data_source": None,
        "data_market": None,
        "data_note": None,
        "started_at": iso(),
        "started_at_wib": iso_wib(),
        "last_run_at": None,
        "last_run_at_wib": None,
        "cash": cfg["starting_balance"],
        "equity": cfg["starting_balance"],
        "realized_pnl": 0.0,
        "positions": {c: None for c in cfg["coins"]},
        "trades": [],
        "last_processed": {c: None for c in cfg["coins"]},
        "last_prices": {},
        "errors": {},
        "events": [],
        "stats": empty_stats(),
    }


def empty_stats() -> dict[str, Any]:
    return {
        "trades": 0,
        "wins": 0,
        "losses": 0,
        "flats": 0,
        "win_rate": 0.0,
        "open": 0,
        "gross_pnl": 0.0,
    }


def load_state(path: Path) -> dict[str, Any]:
    if not path.exists():
        return empty_state()
    try:
        raw = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return empty_state()
    if not isinstance(raw, dict) or raw.get("schema") != SCHEMA:
        return empty_state()
    state = empty_state(raw.get("config"))
    # Preserve runtime fields from disk.
    for key in (
        "started_at", "started_at_wib", "last_run_at", "last_run_at_wib",
        "data_source", "data_market", "data_note", "cash", "equity",
        "realized_pnl", "trades", "last_processed", "last_prices",
        "errors", "events", "stats", "positions",
    ):
        if key in raw:
            state[key] = raw[key]
    # Make sure every configured coin has a slot.
    for c in state["config"]["coins"]:
        state["positions"].setdefault(c, None)
        state["last_processed"].setdefault(c, None)
    return state


def save_state(path: Path, state: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(state, indent=2) + "\n")
    tmp.replace(path)


def fee_rate(config: dict) -> float:
    return float(config["fee_pct"]) / 100.0


def tp_price(side: str, entry: float, config: dict) -> float:
    pct = float(config["take_profit_pct"]) / 100.0
    if side == "long":
        return entry * (1.0 + pct)
    return entry * (1.0 - pct)


def position_pnl(side: str, entry: float, exit_px: float, qty: float, entry_fee: float, config: dict) -> tuple[float, float]:
    exit_fee = exit_px * qty * fee_rate(config)
    if side == "long":
        gross = (exit_px - entry) * qty
    else:
        gross = (entry - exit_px) * qty
    return gross - entry_fee - exit_fee, exit_fee


def unrealized(pos: dict | None, price: float | None, config: dict) -> float:
    if not pos or price is None or price <= 0:
        return 0.0
    pnl, _ = position_pnl(pos["side"], pos["entry"], price, pos["qty"], pos["entry_fee"], config)
    return pnl


def is_profit_or_flat(side: str, entry: float, close: float) -> bool:
    if side == "long":
        return close >= entry
    return close <= entry



def rsi_wilder(candles: list, period: int = 14) -> list[dict]:
    """Wilder's RSI on closed-candle closes. First value is at index `period`."""
    points: list[dict] = []
    if not candles or period < 1 or len(candles) < period + 1:
        return points
    avg_gain = 0.0
    avg_loss = 0.0
    for i in range(1, period + 1):
        change = float(candles[i]["close"]) - float(candles[i - 1]["close"])
        if change > 0:
            avg_gain += change
        else:
            avg_loss -= change
    avg_gain /= period
    avg_loss /= period

    def value_of(gain: float, loss: float) -> float:
        if loss == 0:
            return 100.0
        if gain == 0:
            return 0.0
        return 100.0 - 100.0 / (1.0 + gain / loss)

    points.append({"time": candles[period]["time"], "value": value_of(avg_gain, avg_loss)})
    for i in range(period + 1, len(candles)):
        change = float(candles[i]["close"]) - float(candles[i - 1]["close"])
        gain = change if change > 0 else 0.0
        loss = -change if change < 0 else 0.0
        avg_gain = (avg_gain * (period - 1) + gain) / period
        avg_loss = (avg_loss * (period - 1) + loss) / period
        points.append({"time": candles[i]["time"], "value": value_of(avg_gain, avg_loss)})
    return points


def rsi_at(candles: list, time: int, period: int = 14) -> float | None:
    for pt in rsi_wilder(candles, period):
        if int(pt["time"]) == int(time):
            return float(pt["value"])
    return None


def rsi_entry_ok(side: str, rsi: float | None, config: dict) -> tuple[bool, str]:
    """LONG only if RSI < rsi_long_max; SHORT only if RSI > rsi_short_min."""
    long_max = float(config.get("rsi_long_max") if config.get("rsi_long_max") is not None else 32)
    short_min = float(config.get("rsi_short_min") if config.get("rsi_short_min") is not None else 68)
    if rsi is None:
        return False, "RSI n/a"
    if side == "long":
        ok = rsi < long_max
        cmp = "<" if ok else "not <"
        return ok, f"RSI {rsi:.2f} {cmp} {long_max:g}"
    if side == "short":
        ok = rsi > short_min
        cmp = ">" if ok else "not >"
        return ok, f"RSI {rsi:.2f} {cmp} {short_min:g}"
    return False, "no side"

def entry_side(pivot: dict | None) -> str | None:
    if not pivot:
        return None
    if pivot.get("label") == "LL" and pivot.get("type") == "LOW":
        return "long"
    if pivot.get("label") == "HH" and pivot.get("type") == "HIGH":
        return "short"
    return None


def structure_exit_reason(side: str, entry: float, close: float, pivot: dict) -> str | None:
    """Structure exits: long only on HH, short only on LL. LH and HL are ignored."""
    label = pivot.get("label") or ""
    if side == "long" and pivot.get("type") == "HIGH" and label == "HH":
        return "HH"
    if side == "short" and pivot.get("type") == "LOW" and label == "LL":
        return "LL"
    return None  # LH and HL ignored at all times


def tp_hit(pos: dict, bar: dict) -> bool:
    if pos["side"] == "long":
        return bar["high"] >= pos["tp"]
    return bar["low"] <= pos["tp"]


def _open_position(symbol: str, bar: dict, pivot: dict, config: dict) -> dict[str, Any]:
    side = entry_side(pivot)
    if not side:
        raise ValueError("pivot is not an entry signal")
    entry = float(bar["close"])
    notional = float(config["notional"])
    qty = notional / entry
    entry_fee = notional * fee_rate(config)
    return {
        "symbol": symbol,
        "side": side,
        "entry": entry,
        "qty": qty,
        "notional": notional,
        "entry_fee": entry_fee,
        "entry_time": int(bar["time"]),
        "entry_close_time": int(bar["close_time"]),
        "entry_reason": pivot["label"],
        "tp": tp_price(side, entry, config),
        "pivot_time": int(pivot["time"]),
        "pivot_price": float(pivot["price"]),
    }


def _close_position(pos: dict, exit_px: float, reason: str, bar: dict, config: dict, trade_id: int) -> dict[str, Any]:
    pnl, exit_fee = position_pnl(pos["side"], pos["entry"], exit_px, pos["qty"], pos["entry_fee"], config)
    move = (exit_px - pos["entry"]) / pos["entry"] * 100.0
    if pos["side"] == "short":
        move = -move
    return {
        "id": trade_id,
        "symbol": pos["symbol"],
        "side": pos["side"],
        "entry": pos["entry"],
        "exit": exit_px,
        "qty": pos["qty"],
        "notional": pos["notional"],
        "entry_time": pos["entry_time"],
        "exit_time": int(bar["time"]),
        "entry_close_time": pos["entry_close_time"],
        "exit_close_time": int(bar["close_time"]),
        "entry_reason": pos["entry_reason"],
        "exit_reason": reason,
        "pnl": round(pnl, 8),
        "pnl_pct": round(move, 6),
        "fees": round(pos["entry_fee"] + exit_fee, 8),
        "tp": pos["tp"],
    }


def process_bar(
    position: dict | None,
    bar: dict,
    confirmed: list[dict],
    symbol: str,
    config: dict,
    next_trade_id: int,
    rsi: float | None = None,
) -> tuple[dict | None, list[dict], list[str]]:
    """Apply TP, then structure exits, then entries, on one closed candle.

    A position opened on this bar is not checked for TP or structure on
    the same bar (entry is at the close; intra-bar action already happened).
    After an exit, only an opposite-side entry on this same candle is taken.
    """
    trades: list[dict] = []
    events: list[str] = []
    opened_this_bar = False
    exit_side: str | None = None

    if position:
        if tp_hit(position, bar):
            tr = _close_position(position, position["tp"], "TP", bar, config, next_trade_id)
            next_trade_id += 1
            trades.append(tr)
            events.append(
                f"CLOSE {position['side']} {symbol} TP @ {position['tp']:.6f} pnl={tr['pnl']:.2f}"
            )
            exit_side = position["side"]
            position = None
        else:
            for pivot in confirmed:
                reason = structure_exit_reason(position["side"], position["entry"], bar["close"], pivot)
                if not reason:
                    continue
                tr = _close_position(position, float(bar["close"]), reason, bar, config, next_trade_id)
                next_trade_id += 1
                trades.append(tr)
                events.append(
                    f"CLOSE {position['side']} {symbol} {reason} @ {bar['close']:.6f} pnl={tr['pnl']:.2f}"
                )
                exit_side = position["side"]
                position = None
                break

    if position is None and not opened_this_bar:
        for pivot in confirmed:
            side = entry_side(pivot)
            if not side:
                continue
            if exit_side and side == exit_side:
                # Just closed this side on this candle; do not immediately re-enter.
                continue
            ok, note = rsi_entry_ok(side, rsi, config)
            if not ok:
                events.append(
                    f"SKIP {side} {symbol} {pivot['label']} {note}"
                )
                continue
            position = _open_position(symbol, bar, pivot, config)
            if rsi is not None:
                position["entry_rsi"] = round(float(rsi), 4)
            opened_this_bar = True
            tag = "REVERSE " if exit_side and side != exit_side else ""
            events.append(
                f"{tag}OPEN {side} {symbol} {pivot['label']} @ {bar['close']:.6f} {note}"
            )
            break

    return position, trades, events


def walk(
    symbol: str,
    candles: list[dict],
    config: dict,
    *,
    start_after_time: int | None,
    position: dict | None,
    next_trade_id: int,
    zigzag_candles: list[dict] | None = None,
) -> dict[str, Any]:
    """Replay closed candles after start_after_time (exclusive).

    ZigZag is computed on zigzag_candles (defaults to candles) so a live or
    backtest window can use extra warmup history for structure labels.
    """
    series = zigzag_candles if zigzag_candles is not None else candles
    zz = Z.compute(series, config["reversal_pct"])
    by_confirm: dict[int, list[dict]] = {}
    for p in zz["pivots"]:
        by_confirm.setdefault(int(p["confirm_time"]), []).append(p)
    rsi_period = int(config.get("rsi_period") or 14)
    rsi_by_time = {int(pt["time"]): float(pt["value"]) for pt in rsi_wilder(series, rsi_period)}

    trades: list[dict] = []
    events: list[str] = []
    last_time = start_after_time
    acted = 0
    for bar in candles:
        t = int(bar["time"])
        if start_after_time is not None and t <= start_after_time:
            continue
        acted += 1
        confirmed = by_confirm.get(t, [])
        position, new_trades, ev = process_bar(
            position, bar, confirmed, symbol, config, next_trade_id,
            rsi=rsi_by_time.get(t),
        )
        next_trade_id += len(new_trades)
        trades.extend(new_trades)
        events.extend(ev)
        last_time = t
    last_bar = candles[-1] if candles else None
    return {
        "position": position,
        "trades": trades,
        "events": events,
        "last_time": last_time,
        "last_close_time": int(last_bar["close_time"]) if last_bar else None,
        "last_price": float(last_bar["close"]) if last_bar else None,
        "acted": acted,
        "pivots": zz["pivots"],
    }


def recompute_stats(state: dict) -> dict[str, Any]:
    trades = state.get("trades") or []
    wins = sum(1 for t in trades if t.get("pnl", 0) > 0)
    losses = sum(1 for t in trades if t.get("pnl", 0) < 0)
    flats = sum(1 for t in trades if t.get("pnl", 0) == 0)
    n = len(trades)
    open_n = sum(1 for p in (state.get("positions") or {}).values() if p)
    gross = sum(float(t.get("pnl") or 0) for t in trades)
    decided = wins + losses
    return {
        "trades": n,
        "wins": wins,
        "losses": losses,
        "flats": flats,
        "win_rate": round((wins / decided) * 100.0, 2) if decided else 0.0,
        "open": open_n,
        "gross_pnl": round(gross, 8),
    }


def mark_equity(state: dict) -> float:
    cfg = state["config"]
    eq = float(state["cash"])
    for pos in (state.get("positions") or {}).values():
        if not pos:
            continue
        px = (state.get("last_prices") or {}).get(pos["symbol"])
        eq += unrealized(pos, px, cfg)
    return round(eq, 8)


def apply_result(state: dict, symbol: str, result: dict) -> list[str]:
    cfg = state["config"]
    for tr in result["trades"]:
        state["trades"].append(tr)
        state["cash"] = round(float(state["cash"]) + float(tr["pnl"]), 8)
        state["realized_pnl"] = round(float(state["realized_pnl"]) + float(tr["pnl"]), 8)
    if len(state["trades"]) > 2000:
        state["trades"] = state["trades"][-2000:]
    state["positions"][symbol] = result["position"]
    if result["last_time"] is not None:
        state["last_processed"][symbol] = result["last_time"]
    if result["last_price"] is not None:
        state["last_prices"][symbol] = result["last_price"]
    state["equity"] = mark_equity(state)
    state["stats"] = recompute_stats(state)
    return result["events"]


# ----- market data -----------------------------------------------------------

def _get_json(url: str, params: dict) -> Any:
    if requests is None:
        import urllib.parse
        import urllib.request
        q = urllib.parse.urlencode(params)
        req = urllib.request.Request(
            f"{url}?{q}",
            headers={"User-Agent": "ZigZagSwingAlert/1.0"},
        )
        with urllib.request.urlopen(req, timeout=TIMEOUT) as res:
            if res.status == 451:
                raise RuntimeError("HTTP 451")
            return json.load(res)
    res = requests.get(
        url,
        params=params,
        timeout=TIMEOUT,
        headers={"User-Agent": "ZigZagSwingAlert/1.0"},
        allow_redirects=True,
    )
    if res.status_code == 451:
        raise RuntimeError("HTTP 451 geo-blocked")
    res.raise_for_status()
    return res.json()


def fetch_klines(
    symbol: str,
    interval: str,
    limit: int = KLINE_LIMIT,
    *,
    prefer_market: str | None = None,
) -> tuple[list, dict[str, str]]:
    """Fetch klines, preferring USD-M futures, falling back to spot."""
    err: Exception | None = None
    if prefer_market == "spot":
        chain = SPOT_ENDPOINTS + FUTURES_ENDPOINTS
    else:
        chain = FUTURES_ENDPOINTS + SPOT_ENDPOINTS
    for base, path, market, label in chain:
        url = base + path
        try:
            data = _get_json(url, {"symbol": symbol, "interval": interval, "limit": int(limit)})
            if not isinstance(data, list) or not data:
                raise ValueError("empty klines")
            note = None
            if market == "spot":
                note = (
                    "USD-M futures klines were unreachable; using spot klines "
                    "from this public endpoint. Spot and futures prices can differ."
                )
            return data, {"label": label, "market": market, "note": note or f"USD-M klines from {label}."}
        except Exception as e:
            err = e
            time.sleep(0.25)
    raise err or RuntimeError("klines fetch failed")


def closed_candles(raw: list) -> list[dict[str, Any]]:
    return Z.to_candles(Z.closed_rows(raw))


# ----- live / backtest runners ----------------------------------------------

def next_id(state: dict) -> int:
    trades = state.get("trades") or []
    if not trades:
        return 1
    return int(max(t.get("id") or 0 for t in trades)) + 1


def run_live(state_path: Path, *, force_seed: bool = False) -> dict[str, Any]:
    state = load_state(state_path)
    cfg = state["config"]
    summary: dict[str, Any] = {
        "action": "updated",
        "seeded": [],
        "processed": {},
        "events": [],
        "errors": {},
        "equity": state["equity"],
        "open": 0,
        "data_source": None,
        "data_market": None,
    }
    seeded_any = False
    source_label = None
    source_market = None
    source_note = None

    for symbol in cfg["coins"]:
        try:
            raw, meta = fetch_klines(symbol, cfg["timeframe"], KLINE_LIMIT)
        except Exception as e:
            msg = str(e)
            state["errors"][symbol] = msg
            summary["errors"][symbol] = msg
            continue
        source_label = meta["label"]
        source_market = meta["market"]
        source_note = meta.get("note")
        candles = closed_candles(raw)
        if not candles:
            state["errors"][symbol] = "no closed candles"
            summary["errors"][symbol] = "no closed candles"
            continue
        last = candles[-1]
        prev = state["last_processed"].get(symbol)
        if force_seed or prev is None:
            state["last_processed"][symbol] = int(last["time"])
            state["last_prices"][symbol] = float(last["close"])
            state["positions"][symbol] = None
            state["errors"].pop(symbol, None)
            summary["seeded"].append(symbol)
            seeded_any = True
            continue
        result = walk(
            symbol,
            candles,
            cfg,
            start_after_time=int(prev),
            position=state["positions"].get(symbol),
            next_trade_id=next_id(state),
        )
        ev = apply_result(state, symbol, result)
        state["errors"].pop(symbol, None)
        summary["processed"][symbol] = result["acted"]
        summary["events"].extend(ev)

    state["data_source"] = source_label
    state["data_market"] = source_market
    state["data_note"] = source_note
    state["last_run_at"] = iso()
    state["last_run_at_wib"] = iso_wib()
    state["equity"] = mark_equity(state)
    state["stats"] = recompute_stats(state)
    # Keep a short event log for the dashboard.
    if summary["events"]:
        stamp = state["last_run_at_wib"]
        for ev in summary["events"]:
            state["events"].append(f"{stamp}  {ev}")
        state["events"] = state["events"][-200:]
    if seeded_any and not any(state["last_processed"].get(c) is None for c in cfg["coins"]):
        # First complete seed: start flat from now, no historical fills.
        summary["action"] = "seeded"
    summary["equity"] = state["equity"]
    summary["open"] = state["stats"]["open"]
    summary["data_source"] = source_label
    summary["data_market"] = source_market
    summary["data_note"] = source_note
    summary["cash"] = state["cash"]
    summary["stats"] = state["stats"]
    save_state(state_path, state)
    return summary


def summarize_backtest(trades: list[dict], positions: dict, last_prices: dict, config: dict) -> dict[str, Any]:
    by: dict[str, list[dict]] = {c: [] for c in config["coins"]}
    for t in trades:
        by.setdefault(t["symbol"], []).append(t)
    coins = {}
    for sym in config["coins"]:
        rows = by.get(sym) or []
        wins = sum(1 for t in rows if t["pnl"] > 0)
        losses = sum(1 for t in rows if t["pnl"] < 0)
        decided = wins + losses
        pos = positions.get(sym)
        u = unrealized(pos, last_prices.get(sym), config) if pos else 0.0
        coins[sym] = {
            "trades": len(rows),
            "wins": wins,
            "losses": losses,
            "win_rate": round((wins / decided) * 100.0, 2) if decided else 0.0,
            "realized_pnl": round(sum(t["pnl"] for t in rows), 4),
            "open": None if not pos else {
                "side": pos["side"],
                "entry": pos["entry"],
                "entry_reason": pos["entry_reason"],
                "unrealized": round(u, 4),
            },
            "exit_reasons": _count_reasons(rows),
        }
    decided_all = sum(c["wins"] + c["losses"] for c in coins.values())
    wins_all = sum(c["wins"] for c in coins.values())
    return {
        "schema": "zigzag-paper-backtest-1",
        "mode": "backtest",
        "note": (
            "Historical simulation only. These trades are not part of the live "
            "paper book and were not written to paper_state.json."
        ),
        "config": config,
        "no_stop_loss": True,
        "bars_per_coin": BACKTEST_BARS,
        "generated_at": iso(),
        "generated_at_wib": iso_wib(),
        "totals": {
            "trades": sum(c["trades"] for c in coins.values()),
            "wins": wins_all,
            "losses": sum(c["losses"] for c in coins.values()),
            "win_rate": round((wins_all / decided_all) * 100.0, 2) if decided_all else 0.0,
            "realized_pnl": round(sum(c["realized_pnl"] for c in coins.values()), 4),
            "starting_balance": config["starting_balance"],
        },
        "coins": coins,
    }


def _count_reasons(rows: list[dict]) -> dict[str, int]:
    out: dict[str, int] = {}
    for t in rows:
        k = t.get("exit_reason") or "?"
        out[k] = out.get(k, 0) + 1
    return out


def run_backtest(out_path: Path | None = None, config: dict | None = None) -> dict[str, Any]:
    cfg = clamp_config(config)
    # Shared cash book so the summary resembles a 200 starting balance,
    # but per-coin stats stay independent in the report.
    positions: dict[str, Any] = {c: None for c in cfg["coins"]}
    last_prices: dict[str, float] = {}
    trades: list[dict] = []
    errors: dict[str, str] = {}
    source = None
    market = None
    note = None
    next_trade = 1
    window: dict[str, Any] = {}

    for symbol in cfg["coins"]:
        try:
            raw, meta = fetch_klines(symbol, cfg["timeframe"], KLINE_LIMIT)
        except Exception as e:
            errors[symbol] = str(e)
            continue
        source = meta["label"]
        market = meta["market"]
        note = meta.get("note")
        candles = closed_candles(raw)
        if len(candles) < 50:
            errors[symbol] = f"not enough closed candles ({len(candles)})"
            continue
        trade_bars = candles[-BACKTEST_BARS:] if len(candles) > BACKTEST_BARS else candles
        # Warmup: compute ZigZag on the full fetched history so labels at the
        # start of the trade window have prior swings.
        start_after = int(trade_bars[0]["time"]) - 1
        result = walk(
            symbol,
            trade_bars,
            cfg,
            start_after_time=start_after,
            position=None,
            next_trade_id=next_trade,
            zigzag_candles=candles,
        )
        # Re-number is already sequential via next_trade_id.
        for tr in result["trades"]:
            tr["id"] = next_trade
            next_trade += 1
            trades.append(tr)
        positions[symbol] = result["position"]
        if result["last_price"] is not None:
            last_prices[symbol] = result["last_price"]
        window[symbol] = {
            "warmup_candles": len(candles),
            "traded_candles": len(trade_bars),
            "first_time": trade_bars[0]["time"],
            "last_time": trade_bars[-1]["time"],
            "first_close_wib": datetime.fromtimestamp(
                trade_bars[0]["close_time"] / 1000, tz=timezone.utc
            ).astimezone(WIB).strftime("%Y-%m-%d %H:%M WIB"),
            "last_close_wib": datetime.fromtimestamp(
                trade_bars[-1]["close_time"] / 1000, tz=timezone.utc
            ).astimezone(WIB).strftime("%Y-%m-%d %H:%M WIB"),
        }

    report = summarize_backtest(trades, positions, last_prices, cfg)
    report["data_source"] = source
    report["data_market"] = market
    report["data_note"] = note
    report["errors"] = errors
    report["window"] = window
    report["trades"] = trades
    if out_path:
        save_state(out_path, report)
    return report


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="ZigZag paper bot (no real orders)")
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--live", action="store_true", help="Process newly closed candles and update paper state")
    g.add_argument("--backtest", action="store_true", help="Simulate the last ~1000 candles; do not touch live state")
    p.add_argument("--state", type=Path, default=DEFAULT_STATE)
    p.add_argument("--out", type=Path, default=DEFAULT_BACKTEST, help="Backtest output path")
    p.add_argument("--seed", action="store_true", help="Reset live last-processed to now and stay flat")
    args = p.parse_args(argv)

    if args.backtest:
        report = run_backtest(args.out)
        totals = report["totals"]
        print(json.dumps({
            "action": "backtest",
            "out": str(args.out),
            "data_source": report.get("data_source"),
            "data_market": report.get("data_market"),
            "data_note": report.get("data_note"),
            "errors": report.get("errors"),
            "totals": totals,
            "coins": {
                s: {k: v for k, v in row.items() if k != "open"} | ({"open": row["open"]} if row.get("open") else {})
                for s, row in report["coins"].items()
            },
        }, indent=2))
        return 0 if not report.get("errors") else 1

    summary = run_live(args.state, force_seed=args.seed)
    print(json.dumps(summary, indent=2))
    return 0 if not summary.get("errors") else 1


if __name__ == "__main__":
    raise SystemExit(main())
