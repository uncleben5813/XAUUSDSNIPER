# XAUUSDSNIPER — H1 Structure Edition

This reduced build keeps only:
- Twelve Data XAU/USD live price
- H1 support and resistance from confirmed H1 swing points
- H1 Break of Structure (BOS)
- H1 Change of Character (CHOCH)
- BOS target logic: bullish BOS -> nearest resistance above live price; bearish BOS -> nearest support below live price
- 10-second frontend refresh
- 60-second candle cache and 30-second live-price cache

Removed from the original UI/API: buy/sell entry signals, trade plan, chart, M15/M5 scoring, RSI/MACD/EMA signal logic, push notifications, full API response panel and unrelated dashboard sections.

Environment variable required on Vercel:
`TWELVE_DATA_API_KEY`
