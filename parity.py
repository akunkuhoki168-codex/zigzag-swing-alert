#!/usr/bin/env python3
"""CPython reference: exact scan.py ADX math on a kline cache written by parity.mjs."""
import json, sys, time
from datetime import datetime, timezone, timedelta
from pathlib import Path

N = 14
WIB = timezone(timedelta(hours=7))
cache = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).parent / ".parity-klines.json")

def wilder(x, n):
    out = [None] * len(x)
    s = sum(x[1:n + 1])
    out[n] = s
    for i in range(n + 1, len(x)):
        s = s - s / n + x[i]
        out[i] = s
    return out

def adx_full(raw):
    k = raw
    if int(k[-1][6]) >= int(time.time() * 1000):
        k = k[:-1]
    h = [float(c[2]) for c in k]
    l = [float(c[3]) for c in k]
    c_ = [float(c[4]) for c in k]
    tr = [0]
    pdm = [0]
    mdm = [0]
    for i in range(1, len(k)):
        tr.append(max(h[i] - l[i], abs(h[i] - c_[i - 1]), abs(l[i] - c_[i - 1])))
        up = h[i] - h[i - 1]
        dn = l[i - 1] - l[i]
        pdm.append(up if up > dn and up > 0 else 0)
        mdm.append(dn if dn > up and dn > 0 else 0)
    a, p, m = wilder(tr, N), wilder(pdm, N), wilder(mdm, N)
    pdi = [None] * len(k)
    mdi = [None] * len(k)
    dx = [None] * len(k)
    for i in range(N, len(k)):
        pdi[i] = 100 * p[i] / a[i]
        mdi[i] = 100 * m[i] / a[i]
        dx[i] = 100 * abs(pdi[i] - mdi[i]) / (pdi[i] + mdi[i]) if pdi[i] + mdi[i] else 0
    ad = [None] * len(k)
    ad[2 * N - 1] = sum(dx[N:2 * N]) / N
    for i in range(2 * N, len(k)):
        ad[i] = (ad[i - 1] * (N - 1) + dx[i]) / N
    sigs = []
    for j in range(1, len(ad)):
        if ad[j] is None or ad[j - 1] is None:
            continue
        if ad[j] >= 25 and ad[j] > ad[j - 1]:
            if pdi[j] > mdi[j] and (pdi[j - 1] <= mdi[j - 1] or ad[j - 1] < 25):
                sigs.append((j, "LONG", c_[j], ad[j], pdi[j], mdi[j], int(k[j][6])))
            if mdi[j] > pdi[j] and (mdi[j - 1] <= pdi[j - 1] or ad[j - 1] < 25):
                sigs.append((j, "SHORT", c_[j], ad[j], pdi[j], mdi[j], int(k[j][6])))
    return k, ad, pdi, mdi, sigs

def wib(ms):
    return datetime.fromtimestamp((ms + 1) / 1000, timezone.utc).astimezone(WIB).strftime("%Y-%m-%d %H:%M")

store = json.loads(cache.read_text())
out = {}
for s, raw in store.items():
    k, ad, pdi, mdi, sigs = adx_full(raw)
    rows = []
    for j, sig, close, ax, p, m, t in sigs:
        rows.append({"index": j, "signal": sig, "close": close, "adx": ax, "pdi": p, "mdi": m, "closeTime": t, "wib": wib(t)})
        print(f"{s} {sig} {wib(t)} WIB close={close} ADX={ax:.1f} +DI={p:.1f} -DI={m:.1f}")
    out[s] = rows
    if s == "NEARUSDT":
        found = any(r["signal"] == "SHORT" and r["wib"] == "2026-11-17 13:03" for r in rows)
        print("NEAR 13:03 WIB SHORT:", "FOUND" if found else "NOT IN RANGE")
Path("/tmp/parity-python.json").write_text(json.dumps(out))
print("wrote /tmp/parity-python.json")
