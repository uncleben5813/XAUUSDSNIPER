# XAUUSD Zone Engine — Fresh V1

Fresh standalone XAUUSD analysis dashboard built for Vercel + Twelve Data.

## Included engine

- H1 market structure for context / hold
- M15 directional scalp context
- M5 entry confirmation
- M15 + M5 alignment rule
- Support / Resistance swing zones
- Supply / Demand zones
- Order-block-style origin zones from displacement
- FVG / imbalance detection
- Liquidity map: H1/M15 highs/lows, previous day high/low, equal highs/lows
- Zone scoring and grading
- Zone freshness
- Liquidity sweep detection
- Displacement detection
- Dynamic entry / SL / TP1 / TP2 / TP3 plan
- RR display
- News-risk interface that fails non-blocking if calendar data is unavailable
- Light mobile-first dashboard
- 15-second frontend refresh
- Twelve Data candle request is cached server-side to reduce calls

## Signal rule

BUY/SELL is allowed only when M15 and M5 are aligned in the same direction and a relevant zone exists.

H1 does **not** hard-veto a scalp signal. H1 is shown as context/hold support.

## Vercel

Set:

`TWELVE_DATA_API_KEY`

Then deploy the repository.

## Important

This is an analytical engine, not a guarantee of future price movement. XAU/USD spot does not have one centralized global order book, so liquidity/order-block interpretations are inferred from price data.
