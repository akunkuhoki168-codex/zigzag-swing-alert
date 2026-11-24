"""Public Binance USD-M Futures REST helpers. No API key required."""

from __future__ import annotations

import time
from typing import Any

import requests

# USD-M first. fapi.binance.com often returns 451 from US networks;
# data-api.binance.vision and api.binance.com are spot fallbacks.
ENDPOINTS = [
    ("https://fapi.binance.com", "/fapi/v1/klines", "FAPI"),
    ("https://fapi1.binance.com", "/fapi/v1/klines", "FAPI1"),
    ("https://fapi2.binance.com", "/fapi/v1/klines", "FAPI2"),
    ("https://fapi3.binance.com", "/fapi/v1/klines", "FAPI3"),
    ("https://fapi4.binance.com", "/fapi/v1/klines", "FAPI4"),
    ("https://www.binance.com", "/fapi/v1/klines", "WWW-FAPI"),
    ("https://data-api.binance.vision", "/fapi/v1/klines", "VISION-FAPI"),
    ("https://data-api.binance.vision", "/api/v3/klines", "VISION-SPOT"),
    ("https://api.binance.com", "/api/v3/klines", "SPOT"),
]
REST_BASES = [e[0] for e in ENDPOINTS if e[1].startswith("/fapi")]
LIMIT = 500
TIMEOUT = 12


def fetch_klines(symbol: str, interval: str, limit: int = LIMIT) -> tuple[list, str]:
    err: Exception | None = None
    for attempt in range(len(ENDPOINTS) + 3):
        base, path, label = ENDPOINTS[attempt % len(ENDPOINTS)]
        url = f"{base}{path}"
        try:
            res = requests.get(
                url,
                params={"symbol": symbol, "interval": interval, "limit": limit},
                timeout=TIMEOUT,
                headers={"User-Agent": "ZigZagSwingAlert/1.0"},
                allow_redirects=True,
            )
            if res.status_code == 451:
                raise RuntimeError("HTTP 451 geo-blocked")
            res.raise_for_status()
            data = res.json()
            if not isinstance(data, list) or not data:
                raise ValueError("empty klines")
            return data, label
        except Exception as e:
            err = e
            time.sleep(0.4)
    raise err or RuntimeError("klines fetch failed")


def fetch_mark_price(symbol: str) -> float | None:
    for base in REST_BASES:
        try:
            res = requests.get(
                f"{base}/fapi/v1/premiumIndex",
                params={"symbol": symbol},
                timeout=TIMEOUT,
                headers={"User-Agent": "ZigZagSwingAlert/1.0"},
            )
            res.raise_for_status()
            body = res.json()
            return float(body["markPrice"])
        except Exception:
            continue
    return None


def fmt_price(n: float | None, dec: int | None = None) -> str:
    if n is None:
        return "—"
    if dec is None:
        absn = abs(n)
        dec = 2 if absn >= 100 else 4 if absn >= 1 else 6
    return f"{n:,.{dec}f}"


def price_decimals(rows: list) -> int:
    d = 2
    for row in rows:
        s = str(row[4])
        if "." in s:
            d = max(d, len(s.split(".", 1)[1]))
    return min(d, 8)
