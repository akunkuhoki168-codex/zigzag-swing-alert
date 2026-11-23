"""Non-repainting bar-close ZigZag with HH/HL/LH/LL labels.

A long is a newly confirmed swing LOW; a short is a newly confirmed swing HIGH.
Confirmation uses a percent reversal from the running extreme and happens only
on a closed candle, so pivots do not repaint.
"""

from __future__ import annotations

from typing import Any

DEFAULT_REVERSAL = 1.5
COINS = ["NEARUSDT", "INJUSDT", "RENDERUSDT", "FETUSDT", "ARBUSDT"]
TOP_COINS = [
    "BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT", "ADAUSDT",
    "AVAXUSDT", "LINKUSDT", "SUIUSDT", "DOTUSDT", "LTCUSDT", "BCHUSDT", "UNIUSDT",
    "ATOMUSDT", "NEARUSDT", "FILUSDT", "APTUSDT", "ARBUSDT", "OPUSDT", "INJUSDT",
    "TIAUSDT", "SEIUSDT", "WLDUSDT", "1000PEPEUSDT", "1000SHIBUSDT", "FETUSDT",
    "RENDERUSDT", "TAOUSDT", "AAVEUSDT", "LDOUSDT", "ONDOUSDT", "ENAUSDT",
    "WIFUSDT", "1000BONKUSDT", "TRXUSDT", "HBARUSDT", "ICPUSDT", "ETCUSDT",
    "XLMUSDT", "TONUSDT", "POLUSDT", "ORDIUSDT", "JUPUSDT", "PENDLEUSDT",
    "STXUSDT", "RUNEUSDT", "GRTUSDT", "ALGOUSDT", "CRVUSDT",
]
ALL_COINS: list[str] = []
_seen: set[str] = set()
for _s in COINS + TOP_COINS:
    if _s not in _seen:
        _seen.add(_s)
        ALL_COINS.append(_s)
TIMEFRAMES = ["1m", "5m", "15m", "1h", "4h"]
DEFAULT_TF = "15m"


def clamp_reversal(pct: float) -> float:
    try:
        n = float(pct)
    except (TypeError, ValueError):
        return DEFAULT_REVERSAL
    return min(10.0, max(0.2, n))


def short_name(symbol: str) -> str:
    return str(symbol).replace("USDT", "")


def closed_rows(klines: list, now_ms: int | None = None) -> list:
    if not klines:
        return []
    import time
    if now_ms is None:
        now_ms = int(time.time() * 1000)
    last_close = int(klines[-1][6])
    if last_close >= now_ms:
        return klines[:-1]
    return klines


def to_candles(rows: list) -> list[dict[str, Any]]:
    out = []
    for row in rows:
        out.append({
            "time": int(row[0]) // 1000,
            "open": float(row[1]),
            "high": float(row[2]),
            "low": float(row[3]),
            "close": float(row[4]),
            "close_time": int(row[6]),
        })
    return out


def _make_pivot(kind: str, index: int, price: float, candle: dict, confirm: dict) -> dict[str, Any]:
    return {
        "type": kind,
        "index": index,
        "price": price,
        "time": candle["time"],
        "close_time": candle["close_time"],
        "confirm_time": confirm["time"],
        "confirm_close_time": confirm["close_time"],
        "label": "",
    }


def _label_structure(pivots: list[dict]) -> None:
    last_high = last_low = None
    for p in pivots:
        if p["type"] == "HIGH":
            if last_high:
                p["label"] = "HH" if p["price"] > last_high["price"] else "LH"
            last_high = p
        else:
            if last_low:
                p["label"] = "HL" if p["price"] > last_low["price"] else "LL"
            last_low = p


def compute(candles: list[dict], reversal: float = DEFAULT_REVERSAL) -> dict[str, Any]:
    dev = clamp_reversal(reversal)
    empty = {
        "pivots": [],
        "active": None,
        "dir": 0,
        "trigger": None,
        "trend": "—",
        "trend_kind": "",
        "reversal_pct": dev,
    }
    if not candles or len(candles) < 2:
        return empty

    pivots: list[dict] = []
    direction = 0
    extreme_high = candles[0]["high"]
    extreme_low = candles[0]["low"]
    last_high_idx = 0
    last_low_idx = 0

    for i in range(1, len(candles)):
        bar = candles[i]
        if direction == 0:
            if bar["high"] >= extreme_high:
                extreme_high = bar["high"]
                last_high_idx = i
            if bar["low"] <= extreme_low:
                extreme_low = bar["low"]
                last_low_idx = i
            if (bar["high"] - extreme_low) / extreme_low * 100 >= dev:
                pivots.append(_make_pivot("LOW", last_low_idx, extreme_low, candles[last_low_idx], bar))
                direction = 1
                extreme_high = bar["high"]
                last_high_idx = i
            elif (extreme_high - bar["low"]) / extreme_high * 100 >= dev:
                pivots.append(_make_pivot("HIGH", last_high_idx, extreme_high, candles[last_high_idx], bar))
                direction = -1
                extreme_low = bar["low"]
                last_low_idx = i
            continue
        if direction == 1:
            if bar["high"] >= extreme_high:
                extreme_high = bar["high"]
                last_high_idx = i
            if (extreme_high - bar["low"]) / extreme_high * 100 >= dev:
                pivots.append(_make_pivot("HIGH", last_high_idx, extreme_high, candles[last_high_idx], bar))
                direction = -1
                extreme_low = bar["low"]
                last_low_idx = i
        else:
            if bar["low"] <= extreme_low:
                extreme_low = bar["low"]
                last_low_idx = i
            if (bar["high"] - extreme_low) / extreme_low * 100 >= dev:
                pivots.append(_make_pivot("LOW", last_low_idx, extreme_low, candles[last_low_idx], bar))
                direction = 1
                extreme_high = bar["high"]
                last_high_idx = i

    _label_structure(pivots)

    active = None
    trigger = None
    last = pivots[-1] if pivots else None
    if last and direction == 1:
        active = {
            "from": last,
            "type": "HIGH",
            "price": extreme_high,
            "index": last_high_idx,
            "time": candles[last_high_idx]["time"],
        }
        trigger = extreme_high * (1 - dev / 100)
    elif last and direction == -1:
        active = {
            "from": last,
            "type": "LOW",
            "price": extreme_low,
            "index": last_low_idx,
            "time": candles[last_low_idx]["time"],
        }
        trigger = extreme_low * (1 + dev / 100)

    return {
        "pivots": pivots,
        "active": active,
        "dir": direction,
        "trigger": trigger,
        "trend": _describe_trend(pivots, direction)[0],
        "trend_kind": _describe_trend(pivots, direction)[1],
        "reversal_pct": dev,
    }


def _last_of_type(pivots: list[dict], kind: str) -> dict | None:
    for p in reversed(pivots):
        if p["type"] == kind and p["label"]:
            return p
    return None


def _describe_trend(pivots: list[dict], direction: int) -> tuple[str, str]:
    high = _last_of_type(pivots, "HIGH")
    low = _last_of_type(pivots, "LOW")
    if high and low:
        if high["label"] == "HH" and low["label"] == "HL":
            return "Uptrend (HH / HL)", "up"
        if high["label"] == "LH" and low["label"] == "LL":
            return "Downtrend (LH / LL)", "down"
        return "Transition", "range"
    if direction == 1:
        return "Up leg (unconfirmed)", "up"
    if direction == -1:
        return "Down leg (unconfirmed)", "down"
    return "Building…", ""


def signal_for_pivot(pivot: dict | None) -> dict | None:
    if not pivot:
        return None
    if pivot["type"] == "LOW":
        return {"side": "LONG", "signal": "long", "pivot": pivot}
    if pivot["type"] == "HIGH":
        return {"side": "SHORT", "signal": "short", "pivot": pivot}
    return None


def structure_allows(pivot: dict | None, shorts_enabled: bool) -> bool:
    if not pivot:
        return False
    if pivot["type"] == "LOW":
        return pivot.get("label") == "HL"
    if pivot["type"] == "HIGH":
        return shorts_enabled and pivot.get("label") == "LH"
    return False


def pivot_key(symbol: str, tf: str, pivot: dict) -> str:
    return f"{symbol}|{tf}|{pivot['type']}|{pivot['time']}"
