# XAUUSD Zone Engine V2

Fresh XAUUSD multi-timeframe technical dashboard designed for mobile/Vercel.

## Core signal rule
- H1 = higher-timeframe context / hold support.
- M15 + M5 must align for a scalp BUY/SELL.
- H1 disagreement does **not** veto an M15+M5 scalp signal; it is shown as `SCALP_ONLY`.
- A qualified zone is required before BUY/SELL is emitted.

## Zone engine
- Support / resistance swing zones
- Supply / demand displacement zones
- Order-block style zones
- Fair Value Gap / imbalance zones
- Liquidity: EQH/EQL, previous day high/low, previous week high/low, range highs/lows
- Liquidity sweep detection
- Displacement detection
- M5 market-structure shift detection
- Zone freshness and touch count
- Multi-source zone merging
- Zone score and A+/A/B/C/D grade
- Nearby-zone ranking

## Trade plan
- Dynamic entry range
- Entry reference
- ATR-based stop loss
- TP1 / TP2 / TP3
- 1:3 reference R:R
- Invalidation text
- Nearby liquidity target

## Technical context
- HH / LH / HL / LL
- BOS
- EMA20 / EMA50
- RSI14
- ATR14
- H1 / M15 / M5
- Session classification
- Weekend/closed-market risk block

## Data
Uses Twelve Data `time_series` and `price` endpoints for XAU/USD. The API caches candles/price in the serverless runtime to reduce repeated requests. Twelve Data documents `time_series` as the endpoint for OHLC time-series data and notes a maximum of 5,000 data points per request. See https://twelvedata.com/docs.

Required Vercel environment variable:
`TWELVE_DATA_API_KEY`

## News filter note
This V2 intentionally does not pretend to have a live economic-news calendar. The risk layer reports session/weekend conditions and leaves `available=false` until a real calendar provider is connected. This avoids displaying fake news data.

## Deploy
1. Upload all files to a new GitHub repository.
2. Import the repository into Vercel.
3. Add `TWELVE_DATA_API_KEY` in Vercel Environment Variables.
4. Redeploy.
5. Open `/api/scalp` to verify the JSON response.
