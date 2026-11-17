# ADX Swing Alert

Live ADX(14) alerts on five Binance USD-M Futures mid-caps: NEAR, INJ, RENDER, FET, and ARB.

**Dashboard:** https://dedkovic441-hub.github.io/adx-alert-dashboard/

A signal fires on a *closed* candle when ADX is at least 25 and rising, and either the DI lines cross or ADX crosses up through 25. These are ADX alerts, not the zigzag swing signals from the other ADX Swing project.

The default timeframe is 15m, matching the alert scanner. Switch among 1m, 5m, 15m, 1h, and 4h, or open a chart directly with a query, for example `?symbol=NEARUSDT&tf=15m`. The last timeframe you pick is remembered in the browser.
