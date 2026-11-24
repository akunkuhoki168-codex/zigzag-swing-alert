# ZigZag Swing Alert (Python)

A paper-only Streamlit app for non-repainting, bar-close ZigZag on Binance USD-M Futures.

The public GitHub Pages site is unchanged and still served at
<https://dedkovic441-hub.github.io/zigzag-swing-alert/>. Pages cannot run Python, so this
app is the local version.

## What it does

- Live Binance USD-M candlesticks (public REST, no API key) with auto-refresh
- ZigZag overlay and HH / HL / LH / LL structure labels
- Coin dropdown of liquid USDT-M contracts, including NEAR, INJ, RENDER, FET and ARB (default NEARUSDT)
- Timeframes: 1m, 5m, 15m, 1h, 4h (default 15m)
- Paper wallet with stop-loss, take-profit, margin, leverage, a shorts toggle, a structure filter, a trade ledger and an engine console

Default ZigZag reversal is **1.5%**, matching the existing dashboard and the 15m alert scanner. There are no live or testnet modes and no signed orders.

## Run it on your own PC

You need Python 3.10 or newer.

```bash
git clone https://github.com/dedkovic441-hub/zigzag-swing-alert.git
cd zigzag-swing-alert/python
python3 -m venv .venv
# Windows: py -m venv .venv

source .venv/bin/activate
# Windows: .venv\Scripts\activate

pip install -r requirements.txt
streamlit run app.py
```

Your browser should open a local page (usually <http://localhost:8501>). The paper wallet is stored in `state/paper.json` on that machine and is not uploaded anywhere.

If you already have this folder as `/workspace/zigzag-app`, the same commands work from there.

```bash
cd /workspace/zigzag-app
source .venv/bin/activate
streamlit run app.py
```

## Settings

| Setting | Default |
| --- | --- |
| Reversal | 1.5% |
| Stop loss | 1.5% |
| Take profit | 3% |
| Leverage | 5x |
| Margin | 100 USDT |
| Starting balance | 10,000 USDT |
| Shorts | on |
| Structure filter (HL / LH only) | off |
| Default coin | NEARUSDT |
| Default timeframe | 15m |
