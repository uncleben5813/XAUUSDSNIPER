# XAUUSD Trend Following Dashboard V2

A new Vercel-ready XAU/USD dashboard built around H1 trend context and M15 pullback triggers. Trend Following standalone and Trend + SMC are evaluated independently.

## Features
- Twelve Data live price and M5 candle feed, aggregated to closed M15 and H1 bars.
- Interactive candlestick chart with EMA20/50/200 overlays, crosshair, zoom, scroll and structure/sweep markers.
- H1 trend direction, EMA ordering and slope normalized by ATR.
- Pullback zone calculated from EMA20/EMA50 and ATR, rejection and momentum checks.
- Liquidity context: equal highs/lows, swing levels and sweep/reclaim checks.
- Volatility regime and expansion/chasing warning.
- Separate Trend Following and Trend + SMC setup cards with entry, SL, TP1, TP2, R:R, checks, reasons and invalidation.
- Browser-local signal ledger. Outcomes are manually marked; they are not fabricated.

## Deploy to Vercel
1. Import this repository into Vercel.
2. Set `TWELVE_DATA_API_KEY` under Project Settings → Environment Variables.
3. Redeploy after setting the key.
4. Open the deployment URL. The chart uses Lightweight Charts from a CDN, so the client needs internet access.

## Important implementation notes
- API route: `/api/scalp`.
- Signal analysis uses closed M15 candles; H1 provides trend context.
- The feed requests up to 5,000 M5 bars. Actual returned history depends on Twelve Data plan/limits.
- The browser ledger is stored in localStorage on that browser only. It is not a shared database and does not replace a true historical backtest.
- Performance statistics shown in the UI are based only on outcomes manually recorded by the user. No win rate is guaranteed.
- Validate data timestamps, broker spread, slippage, timezone/session handling and out-of-sample performance before live trading.

## Local syntax check
`npm run check`
