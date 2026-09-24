# XAUUSD H1 Swing Breakout

H1 swing-only engine for XAU/USD.

## Trigger
- Confirmed H1 candle CLOSE beyond a confirmed H1 swing high/low.
- Wick-only break does not trigger.
- Retest is NOT required.
- No M5/M15 scalp engine.
- Entry is the breakout H1 close.

## Signal quality
Scores breakout displacement, close strength, EMA20/50/200 alignment, RSI, and room to the next confirmed H1 swing target.

Set `TWELVE_DATA_API_KEY` in Vercel.
