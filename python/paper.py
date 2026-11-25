"""Browser-less simulated futures wallet. Never places real orders."""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

STARTING_BALANCE = 200.0
TAKER_FEE = 0.0004
MAX_TRADES = 200
DEFAULTS = {
    "sl_pct": 1.5,
    "tp_pct": 1.5,
    "leverage": 1,
    "margin": 200.0,
    "shorts": True,
    "structure_filter": False,
    "reversal_pct": 1.5,
}


def clamp_params(raw: dict | None = None) -> dict[str, Any]:
    raw = raw or {}
    def num(key, default, lo, hi, integer=False):
        try:
            v = float(raw.get(key, default))
        except (TypeError, ValueError):
            v = default
        v = min(hi, max(lo, v))
        return int(round(v)) if integer else v

    return {
        "sl_pct": num("sl_pct", DEFAULTS["sl_pct"], 0.1, 50),
        "tp_pct": num("tp_pct", DEFAULTS["tp_pct"], 0.1, 100),
        "leverage": num("leverage", DEFAULTS["leverage"], 1, 50, integer=True),
        "margin": num("margin", DEFAULTS["margin"], 1, 10_000),
        "shorts": bool(raw.get("shorts", DEFAULTS["shorts"])),
        "structure_filter": bool(raw.get("structure_filter", DEFAULTS["structure_filter"])),
        "reversal_pct": num("reversal_pct", DEFAULTS["reversal_pct"], 0.2, 10),
    }


def empty_state() -> dict[str, Any]:
    return {
        "balance": STARTING_BALANCE,
        "position": None,
        "trades": [],
        "params": clamp_params(DEFAULTS),
        "engine_on": False,
        "last_pivot_key": "",
    }


def load(path: Path) -> dict[str, Any]:
    state = empty_state()
    try:
        raw = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return state
    if not isinstance(raw, dict):
        return state
    if isinstance(raw.get("balance"), (int, float)):
        state["balance"] = float(raw["balance"])
    if raw.get("position") and raw["position"].get("symbol"):
        state["position"] = raw["position"]
    if isinstance(raw.get("trades"), list):
        state["trades"] = raw["trades"][:MAX_TRADES]
    state["params"] = clamp_params(raw.get("params") or DEFAULTS)
    state["engine_on"] = bool(raw.get("engine_on", False))
    state["last_pivot_key"] = raw.get("last_pivot_key") or ""
    return state


def save(path: Path, state: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "balance": state["balance"],
        "position": state["position"],
        "trades": state["trades"],
        "params": state["params"],
        "engine_on": state.get("engine_on", False),
        "last_pivot_key": state.get("last_pivot_key", ""),
    }
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(payload, indent=2))
    tmp.replace(path)


def reset(state: dict) -> dict[str, Any]:
    params = clamp_params(state.get("params") if state else DEFAULTS)
    engine = bool(state.get("engine_on")) if state else False
    nxt = empty_state()
    nxt["params"] = params
    nxt["engine_on"] = engine
    return nxt


def unrealized(position: dict | None, price: float | None) -> float:
    if not position or not price:
        return 0.0
    direction = -1 if position["side"] == "SHORT" else 1
    return (price - position["entry"]) * position["qty"] * direction


def equity(state: dict, price: float | None) -> float:
    return state["balance"] + unrealized(state.get("position"), price)


def sl_tp_prices(side: str, entry: float, sl_pct: float, tp_pct: float) -> tuple[float, float]:
    sl, tp = sl_pct / 100, tp_pct / 100
    if side == "SHORT":
        return entry * (1 + sl), entry * (1 - tp)
    return entry * (1 - sl), entry * (1 + tp)


def open_position(state: dict, *, symbol: str, tf: str, side: str, price: float, reason: str) -> dict:
    params = state["params"]
    if state.get("position"):
        return {"ok": False, "reason": "Already in a paper position."}
    if side == "SHORT" and not params["shorts"]:
        return {"ok": False, "reason": "Shorts are disabled."}
    if not price or price <= 0:
        return {"ok": False, "reason": "No entry price."}
    if state["balance"] < params["margin"]:
        return {"ok": False, "reason": "Not enough paper balance for margin."}
    notional = params["margin"] * params["leverage"]
    qty = notional / price
    fee = notional * TAKER_FEE
    if state["balance"] < params["margin"] + fee:
        return {"ok": False, "reason": "Balance cannot cover margin and fee."}
    sl, tp = sl_tp_prices(side, price, params["sl_pct"], params["tp_pct"])
    state["balance"] -= params["margin"] + fee
    state["position"] = {
        "id": f"p{int(time.time() * 1000)}",
        "symbol": symbol,
        "tf": tf,
        "side": side,
        "entry": price,
        "qty": qty,
        "margin": params["margin"],
        "leverage": params["leverage"],
        "sl": sl,
        "tp": tp,
        "fee_open": fee,
        "opened_at": int(time.time() * 1000),
        "reason": reason,
    }
    return {"ok": True, "position": state["position"]}


def close_position(state: dict, *, price: float, reason: str) -> dict:
    pos = state.get("position")
    if not pos:
        return {"ok": False, "reason": "No open position."}
    if not price or price <= 0:
        return {"ok": False, "reason": "No exit price."}
    pnl = unrealized(pos, price)
    fee = pos["qty"] * price * TAKER_FEE
    state["balance"] += pos["margin"] + pnl - fee
    trade = {
        "id": pos["id"],
        "symbol": pos["symbol"],
        "tf": pos["tf"],
        "side": pos["side"],
        "entry": pos["entry"],
        "exit": price,
        "qty": pos["qty"],
        "margin": pos["margin"],
        "leverage": pos["leverage"],
        "pnl": round(pnl - fee - pos.get("fee_open", 0), 4),
        "reason": pos.get("reason") or "",
        "exit_reason": reason,
        "opened_at": pos["opened_at"],
        "closed_at": int(time.time() * 1000),
    }
    state["trades"].insert(0, trade)
    state["trades"] = state["trades"][:MAX_TRADES]
    state["position"] = None
    return {"ok": True, "trade": trade}


def manage(state: dict, price: float | None, bar: dict | None = None) -> dict | None:
    pos = state.get("position")
    if not pos:
        return None
    high = float(bar["high"]) if bar else price
    low = float(bar["low"]) if bar else price
    last = price if price is not None else (float(bar["close"]) if bar else None)
    if last is None or high is None or low is None:
        return None
    liq_move = 1 / pos["leverage"]
    if pos["side"] == "SHORT":
        liq = pos["entry"] * (1 + liq_move * 0.9)
        if high >= liq:
            return close_position(state, price=liq, reason="Liquidation")
        if high >= pos["sl"]:
            return close_position(state, price=pos["sl"], reason="Stop loss")
        if low <= pos["tp"]:
            return close_position(state, price=pos["tp"], reason="Take profit")
    else:
        liq = pos["entry"] * (1 - liq_move * 0.9)
        if low <= liq:
            return close_position(state, price=liq, reason="Liquidation")
        if low <= pos["sl"]:
            return close_position(state, price=pos["sl"], reason="Stop loss")
        if high >= pos["tp"]:
            return close_position(state, price=pos["tp"], reason="Take profit")
    return None
