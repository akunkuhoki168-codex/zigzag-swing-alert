# ZigZag Swing Alert

Non-repainting, bar-close ZigZag alerts on Binance USD-M Futures, with a paper-only simulated wallet.

**Dashboard:** https://dedkovic441-hub.github.io/zigzag-swing-alert/

The coin list includes NEAR, INJ, RENDER, FET, and ARB among other liquid USDT-M contracts, with no separate alert group. The default coin is NEARUSDT. The default timeframe is 15m, matching the alert scanner. Switch among 1m, 5m, 15m, 1h, and 4h, or open a chart with a query such as `?symbol=NEARUSDT&tf=15m`. The last timeframe you pick is remembered in the browser.

A long fires when a swing low is newly confirmed; a short fires when a swing high is newly confirmed. Confirmation uses a 1.5% reversal from the running extreme and happens only on a closed candle, so pivots do not repaint.

## 24/7 paper bot

The Pages chart only updates while a browser tab is open. The official paper book is a GitHub Actions workflow, **Paper bot**, which runs on a `*/5` cron (about every five minutes) plus manual `workflow_dispatch`. It uses the same bar-close ZigZag engine (1.5% reversal, 15m closed candles) on NEAR, INJ, RENDER, FET and ARB.

Rules:

- **Long** on a newly confirmed **LL**, filled at the confirming candle's close. Exit at **+3% take-profit** (checked against the candle high; fill at the TP price) or a newly confirmed swing high, whichever comes first. If the trade is in profit or flat at that close, **HH or LH** exits; if it is in a loss, only an **HH** exits and an LH is ignored.
- **Short** is the opposite: enter on a confirmed **HH**, take-profit at **−3%** on the candle low, and exit on a confirmed swing low (**LL or HL**) when in profit or flat. In a loss, only an **LL** exits and an HL is ignored.
- **No stop-loss.** One position per coin. If an opposite entry confirms on the same candle as an exit, the bot closes and then reverses.
- Starting balance **10,000 USDT**, fixed **1,000 USDT** notional per trade, **0.04%** fee per side. These defaults live in `python/bot.py` (`DEFAULT_CONFIG`) and are stored in `data/paper_state.json`.

The live book starts flat from the first run (no backfilled trades). State is committed back to [`data/paper_state.json`](data/paper_state.json). A one-shot historical simulation of the last ~1000 candles is stored separately in [`data/backtest.json`](data/backtest.json) and is not mixed into the live book.

This bot never places real orders and never uses an API key. If USD-M futures klines are geo-blocked from GitHub-hosted runners, it falls back to `data-api.binance.vision` or another public mirror, and to spot klines only if futures data is unreachable.

The dashboard **Bot** section reads that state (no-cache) and marks bot entries and exits on the chart. The controls lower on the page are a **local browser sandbox**; they stop when the tab is closed and are not the 24/7 bot.

A local Python (Streamlit) version lives in [`python/`](python/), with run instructions in [`python/README.md`](python/README.md). It also reads the same bot state. GitHub Pages cannot run that app.

To run the bot locally:

```bash
python python/bot.py --live --state data/paper_state.json
python python/bot.py --backtest --out data/backtest.json
```
