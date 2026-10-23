# XAUUSD Trend Following Dashboard — V3

A Vercel serverless dashboard for XAU/USD using Twelve Data candles. The engine evaluates trend on H1 and entries on **closed M15 candles**. BOS, CHoCH and liquidity-sweep markers are shown on the candlestick chart when detected.

## Deploy
1. Import this folder/repository into Vercel.
2. In **Project → Settings → Environment Variables**, add `TWELVE_DATA_API_KEY` with your Twelve Data API key.
3. Redeploy after adding the variable.
4. Open the deployment and click **Refresh**. The API endpoint is `/api/scalp`.

## Requirements
- Vercel Node.js runtime with native `fetch` (Node 18+).
- A Twelve Data plan/key that permits the `time_series` and `price` endpoints and enough M5 history to construct 200 H1 EMA values. The API returns a visible error if data is insufficient or the key/plan fails.
- Browser access to `unpkg.com` for Lightweight Charts 4.2.2.

## Engine rules
- H1 trend filter: EMA 20/50/200 ordering and EMA slope normalized by ATR.
- M15 trigger: pullback zone calculated from EMA20/EMA50 and ATR, rejection candle, and close beyond the prior candle high/low.
- Trend + SMC is scored separately and requires a directional sweep or BOS confirmation.
- BOS/CHoCH/sweep events are based on confirmed swing pivots and the latest closed M15 candle.
- Entry/SL/TP are calculated from the latest closed M15 candle, ATR and swing levels.
- The dashboard's local signal ledger is **not** a historical backtest. It does not prove profitability and does not guarantee a win rate. Validate spread, slippage, and out-of-sample performance before risking funds.

## Verify locally
Run `npm run check` to validate the serverless API JavaScript syntax. For a live feed, deploy to Vercel with a valid key; local checks cannot verify external API credentials.
