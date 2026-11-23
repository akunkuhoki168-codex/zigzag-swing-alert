# ADX Swing Alert

Live ADX(14) and non-repainting ZigZag on Binance USD-M Futures, with a paper-only simulated wallet.

**Dashboard:** https://dedkovic441-hub.github.io/adx-alert-dashboard/

The five alert coins — NEAR, INJ, RENDER, FET, and ARB — sit at the front of the symbol list. A Top 50 selector adds other liquid USDT-M contracts. The default timeframe is 15m, matching the alert scanner. Switch among 1m, 5m, 15m, 1h, and 4h, or open a chart with a query such as `?symbol=NEARUSDT&tf=15m`. The last timeframe you pick is remembered in the browser.

An ADX signal fires on a *closed* candle when ADX is at least 25 and rising, and either the DI lines cross or ADX crosses up through 25. ZigZag pivots also confirm only on bar close (they do not repaint). You can optionally take a ZigZag entry only when ADX is at least 25 and the DI direction agrees.

The paper engine, trade ledger, and wallet are a local simulation. This page never places real orders and never asks for an API key.
