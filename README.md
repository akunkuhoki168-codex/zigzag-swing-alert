# ZigZag Swing Alert

Non-repainting, bar-close ZigZag alerts on Binance USD-M Futures, with a paper-only simulated wallet.

**Dashboard:** https://dedkovic441-hub.github.io/zigzag-swing-alert/

The five alert coins — NEAR, INJ, RENDER, FET, and ARB — sit at the front of the symbol list. A Top 50 selector adds other liquid USDT-M contracts. The default timeframe is 15m, matching the alert scanner. Switch among 1m, 5m, 15m, 1h, and 4h, or open a chart with a query such as `?symbol=NEARUSDT&tf=15m`. The last timeframe you pick is remembered in the browser.

A long fires when a swing low is newly confirmed; a short fires when a swing high is newly confirmed. Confirmation uses a 1.5% reversal from the running extreme and happens only on a closed candle, so pivots do not repaint.

The paper engine, trade ledger, and wallet are a local simulation. This page never places real orders and never asks for an API key.
