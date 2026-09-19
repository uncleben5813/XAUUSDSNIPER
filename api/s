export default async function handler(req, res) {
  const API_KEY = process.env.TWELVE_DATA_API_KEY;

  if (!API_KEY) {
    return res.status(500).json({
      ok: false,
      error: "TWELVE_DATA_API_KEY belum diset"
    });
  }

  const CFG = {
    symbol: "XAU/USD",

    // One M5 request. H1 is built locally to save Twelve Data quota.
    m5OutputSize: 2500,

    candleTTL: 60_000,
    priceTTL: 30_000,

    // H1 structure pivots are intentionally wider than 2/2.
    // This avoids treating tiny candle swings as H1 S/R.
    pivotLeft: 3,
    pivotRight: 3,

    // Structural S/R lookback. 250 H1 candles ~= 10 days.
    structureLookbackH1: 250,

    // Two levels inside this fraction of H1 ATR are treated as one zone.
    // This reduces clusters of almost-identical pivots.
    mergeATR: 0.35,

    // A pivot must have at least this much prominence to be considered
    // a major structural level. This is intentionally modest so the
    // engine still works on XAU/USD during quieter sessions.
    minProminenceATR: 0.35,

    prominenceWindow: 6
  };

  globalThis.__XAU_STRUCTURE_CACHE__ ??= {
    candles: null,
    fetchedAt: 0
  };

  globalThis.__XAU_LIVE_PRICE__ ??= {
    price: null,
    fetchedAt: 0
  };

  const candleCache = globalThis.__XAU_STRUCTURE_CACHE__;
  const priceCache = globalThis.__XAU_LIVE_PRICE__;
  const now = Date.now();

  try {
    // ============================================================
    // M5 DATA
    // ============================================================
    let m5;

    if (
      candleCache.candles &&
      now - candleCache.fetchedAt < CFG.candleTTL
    ) {
      m5 = candleCache.candles;
    } else {
      const url =
        `https://api.twelvedata.com/time_series` +
        `?symbol=${encodeURIComponent(CFG.symbol)}` +
        `&interval=5min` +
        `&outputsize=${CFG.m5OutputSize}` +
        `&apikey=${API_KEY}`;

      const r = await fetch(url);
      const d = await r.json();

      if (
        !r.ok ||
        d?.status === "error" ||
        !Array.isArray(d?.values)
      ) {
        if (!candleCache.candles) {
          return res.status(502).json({
            ok: false,
            error: d?.message || "Twelve Data candle API error"
          });
        }

        m5 = candleCache.candles;
      } else {
        m5 = d.values
          .slice()
          .reverse()
          .map(c => ({
            time: c.datetime,
            open: Number(c.open),
            high: Number(c.high),
            low: Number(c.low),
            close: Number(c.close)
          }))
          .filter(c =>
            [c.open, c.high, c.low, c.close].every(Number.isFinite)
          );

        if (m5.length < 100) {
          return res.status(422).json({
            ok: false,
            error: "Candle M5 tidak mencukupi",
            count: m5.length
          });
        }

        candleCache.candles = m5;
        candleCache.fetchedAt = Date.now();
      }
    }

    // ============================================================
    // LIVE PRICE
    // ============================================================
    let livePrice = m5.at(-1)?.close ?? null;
    let livePriceSource = "M5_CANDLE_FALLBACK";
    let livePriceError = null;

    if (
      priceCache.price !== null &&
      Date.now() - priceCache.fetchedAt < CFG.priceTTL
    ) {
      livePrice = priceCache.price;
      livePriceSource = "TWELVE_DATA_PRICE_CACHE";
    } else {
      try {
        const r = await fetch(
          `https://api.twelvedata.com/price` +
          `?symbol=${encodeURIComponent(CFG.symbol)}` +
          `&apikey=${API_KEY}`
        );

        const d = await r.json();
        const p = Number(d?.price);

        if (
          r.ok &&
          d?.status !== "error" &&
          Number.isFinite(p)
        ) {
          livePrice = p;
          livePriceSource = "TWELVE_DATA_PRICE";

          priceCache.price = p;
          priceCache.fetchedAt = Date.now();
        } else {
          livePriceError = d?.message || "Live price API error";

          if (priceCache.price !== null) {
            livePrice = priceCache.price;
            livePriceSource = "TWELVE_DATA_PRICE_CACHE";
          }
        }
      } catch (e) {
        livePriceError =
          e?.message || "Live price request failed";

        if (priceCache.price !== null) {
          livePrice = priceCache.price;
          livePriceSource = "TWELVE_DATA_PRICE_CACHE";
        }
      }
    }

    // ============================================================
    // BUILD H1 FROM M5
    // ============================================================
    const h1 = aggregate(m5, 60);

    if (h1.length < 20) {
      return res.status(422).json({
        ok: false,
        error: "H1 candle tidak mencukupi",
        count: h1.length
      });
    }

    // Never use the currently-forming H1 candle for structure.
    const closedH1 = h1.length > 1 ? h1.slice(0, -1) : h1;

    const structureData =
      closedH1.length > CFG.structureLookbackH1
        ? closedH1.slice(-CFG.structureLookbackH1)
        : closedH1;

    const pivots = findPivots(
      structureData,
      CFG.pivotLeft,
      CFG.pivotRight
    );

    const swingHighs = pivots.filter(p => p.type === "HIGH");
    const swingLows = pivots.filter(p => p.type === "LOW");

    const current = closedH1.at(-1);

    const atr = calculateATR(structureData, 14);

    const structure = classifyStructure(
      swingHighs,
      swingLows
    );

    const event = detectStructureEvent(
      structureData,
      swingHighs,
      swingLows,
      structure
    );

    // ============================================================
    // IMPORTANT H1 S/R LOGIC
    //
    // DO NOT use arbitrary nearest candle highs/lows.
    //
    // Support  = nearest CONFIRMED STRUCTURAL SWING LOW below price.
    // Resistance = nearest CONFIRMED STRUCTURAL SWING HIGH above price.
    //
    // Minor pivots are filtered/merged so S/R does not sit directly
    // beside the live price just because of a tiny H1 fluctuation.
    // ============================================================
    const structuralLevels = buildStructuralLevels({
      highs: swingHighs,
      lows: swingLows,
      candles: structureData,
      atr,
      mergeATR: CFG.mergeATR,
      minProminenceATR: CFG.minProminenceATR,
      prominenceWindow: CFG.prominenceWindow
    });

    const support = nearestStructuralBelow(
      structuralLevels.lows,
      livePrice
    );

    const resistance = nearestStructuralAbove(
      structuralLevels.highs,
      livePrice
    );

    // ============================================================
    // CHOCH/BOS TARGET
    //
    // Bullish CHOCH/BOS:
    //   target = next confirmed H1 structure high ABOVE price.
    //
    // Bearish CHOCH/BOS:
    //   target = next confirmed H1 structure low BELOW price.
    // ============================================================
    let breakTarget = null;

    if (
      (event.type === "BOS" || event.type === "CHOCH") &&
      event.direction === "BULLISH"
    ) {
      breakTarget = resistance;
    }

    if (
      (event.type === "BOS" || event.type === "CHOCH") &&
      event.direction === "BEARISH"
    ) {
      breakTarget = support;
    }

    return res.status(200).json({
      ok: true,

      version:
        "H1-MAJOR-STRUCTURE-SR-CHOCH-BOS-LIVEPRICE-V2",

      symbol: CFG.symbol,

      livePrice,
      livePriceSource,

      livePriceAgeSeconds:
        priceCache.fetchedAt
          ? Math.round(
              (Date.now() - priceCache.fetchedAt) / 1000
            )
          : null,

      livePriceTTLSeconds: CFG.priceTTL / 1000,

      livePriceError,

      h1: {
        candles: h1.length,
        closedCandles: closedH1.length,
        structureCandles: structureData.length,
        lastClosedTime: current?.time ?? null,

        structure,

        // Main dashboard fields.
        support,
        resistance,

        // Extra transparency for debugging/UI.
        supportLogic:
          "Nearest confirmed H1 structural swing low below live price",

        resistanceLogic:
          "Nearest confirmed H1 structural swing high above live price",

        atr14: Number.isFinite(atr)
          ? Number(atr.toFixed(4))
          : null,

        swings: {
          highs: swingHighs.slice(-12).map(x => ({
            price: x.price,
            time: x.time,
            strength: x.strength ?? "STRUCTURE"
          })),

          lows: swingLows.slice(-12).map(x => ({
            price: x.price,
            time: x.time,
            strength: x.strength ?? "STRUCTURE"
          }))
        },

        majorStructures: {
          highs: structuralLevels.highs
            .slice(-12)
            .map(x => ({
              price: x.price,
              time: x.time,
              strength: x.strength,
              prominenceATR: x.prominenceATR
            })),

          lows: structuralLevels.lows
            .slice(-12)
            .map(x => ({
              price: x.price,
              time: x.time,
              strength: x.strength,
              prominenceATR: x.prominenceATR
            }))
        },

        bos: event.type === "BOS" ? event : null,
        choch: event.type === "CHOCH" ? event : null,

        breakTarget,

        // Explicit structure context for the frontend.
        context: {
          bullishResistance:
            resistance?.price ?? null,

          bearishSupport:
            support?.price ?? null,

          afterBullishBreak:
            event.direction === "BULLISH"
              ? resistance?.price ?? null
              : null,

          afterBearishBreak:
            event.direction === "BEARISH"
              ? support?.price ?? null
              : null
        }
      },

      cache: {
        candleAgeSeconds:
          Math.round(
            (Date.now() - candleCache.fetchedAt) / 1000
          ),

        candleTTLSeconds: CFG.candleTTL / 1000,

        m5Candles: m5.length
      },

      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error("H1 STRUCTURE ERROR", error);

    return res.status(500).json({
      ok: false,
      error:
        error?.message ||
        "H1 structure engine error"
    });
  }
}


// ============================================================
// AGGREGATE M5 -> H1
// ============================================================
function aggregate(data, minutes) {
  const size = minutes * 60 * 1000;
  const buckets = new Map();

  for (const c of data) {
    const ts = new Date(c.time).getTime();

    if (!Number.isFinite(ts)) continue;

    const key = Math.floor(ts / size) * size;

    let b = buckets.get(key);

    if (!b) {
      b = {
        time: new Date(key).toISOString(),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close
      };

      buckets.set(key, b);
    } else {
      b.high = Math.max(b.high, c.high);
      b.low = Math.min(b.low, c.low);
      b.close = c.close;
    }
  }

  return [...buckets.values()]
    .sort(
      (a, b) =>
        new Date(a.time) - new Date(b.time)
    );
}


// ============================================================
// CONFIRMED H1 PIVOTS
// ============================================================
function findPivots(data, left = 3, right = 3) {
  const out = [];

  for (
    let i = left;
    i < data.length - right;
    i++
  ) {
    const c = data[i];

    let high = true;
    let low = true;

    for (let j = 1; j <= left; j++) {
      high &&= c.high > data[i - j].high;
      low &&= c.low < data[i - j].low;
    }

    for (let j = 1; j <= right; j++) {
      high &&= c.high >= data[i + j].high;
      low &&= c.low <= data[i + j].low;
    }

    if (high) {
      out.push({
        type: "HIGH",
        price: c.high,
        time: c.time,
        index: i
      });
    }

    if (low) {
      out.push({
        type: "LOW",
        price: c.low,
        time: c.time,
        index: i
      });
    }
  }

  return out.sort(
    (a, b) => a.index - b.index
  );
}


// ============================================================
// ATR
// ============================================================
function calculateATR(data, period = 14) {
  if (data.length < period + 1) return null;

  const tr = [];

  for (let i = 0; i < data.length; i++) {
    if (i === 0) {
      tr.push(
        data[i].high - data[i].low
      );
      continue;
    }

    const prevClose = data[i - 1].close;

    tr.push(
      Math.max(
        data[i].high - data[i].low,
        Math.abs(data[i].high - prevClose),
        Math.abs(data[i].low - prevClose)
      )
    );
  }

  const slice = tr.slice(-period);

  if (!slice.length) return null;

  return (
    slice.reduce(
      (sum, value) => sum + value,
      0
    ) / slice.length
  );
}


// ============================================================
// STRUCTURE CLASSIFICATION
// ============================================================
function classifyStructure(highs, lows) {
  const h = highs.slice(-3);
  const l = lows.slice(-3);

  let highPattern = "NONE";
  let lowPattern = "NONE";

  if (h.length >= 2) {
    highPattern =
      h.at(-1).price > h.at(-2).price
        ? "HH"
        : h.at(-1).price < h.at(-2).price
          ? "LH"
          : "EQH";
  }

  if (l.length >= 2) {
    lowPattern =
      l.at(-1).price > l.at(-2).price
        ? "HL"
        : l.at(-1).price < l.at(-2).price
          ? "LL"
          : "EQL";
  }

  let bias = "NEUTRAL";

  if (
    highPattern === "HH" &&
    lowPattern === "HL"
  ) {
    bias = "BULLISH";
  } else if (
    highPattern === "LH" &&
    lowPattern === "LL"
  ) {
    bias = "BEARISH";
  }

  return {
    bias,
    highPattern,
    lowPattern,

    lastSwingHigh:
      h.at(-1)?.price ?? null,

    lastSwingLow:
      l.at(-1)?.price ?? null
  };
}


// ============================================================
// STRUCTURE EVENT
//
// A break is only evaluated against a confirmed H1 swing.
// ============================================================
function detectStructureEvent(
  data,
  highs,
  lows,
  structure
) {
  const last = data.at(-1);

  if (!last) {
    return {
      type: "NONE",
      direction: "NONE",
      price: null,
      level: null,
      time: null,
      description:
        "No closed H1 candle"
    };
  }

  const priorHigh = highs.at(-1);
  const priorLow = lows.at(-1);

  const bullishBreak =
    priorHigh &&
    last.close > priorHigh.price;

  const bearishBreak =
    priorLow &&
    last.close < priorLow.price;

  if (bullishBreak) {
    const type =
      structure.bias === "BEARISH"
        ? "CHOCH"
        : "BOS";

    return {
      type,
      direction: "BULLISH",
      price: last.close,
      level: priorHigh.price,
      time: last.time,

      description:
        type === "BOS"
          ? "Bullish BOS — confirmed H1 swing high broken"
          : "Bullish CHOCH — H1 bearish structure broken"
    };
  }

  if (bearishBreak) {
    const type =
      structure.bias === "BULLISH"
        ? "CHOCH"
        : "BOS";

    return {
      type,
      direction: "BEARISH",
      price: last.close,
      level: priorLow.price,
      time: last.time,

      description:
        type === "BOS"
          ? "Bearish BOS — confirmed H1 swing low broken"
          : "Bearish CHOCH — H1 bullish structure broken"
    };
  }

  return {
    type: "NONE",
    direction: "NONE",
    price: null,
    level: null,
    time: null,

    description:
      "No new H1 structure break on the last closed candle"
  };
}


// ============================================================
// BUILD MAJOR STRUCTURAL LEVELS
//
// This is the key fix.
//
// 1. Start from confirmed H1 swing highs/lows.
// 2. Calculate each pivot's prominence.
// 3. Ignore tiny pivots.
// 4. Merge levels that are extremely close.
// 5. Keep structural levels only.
// ============================================================
function buildStructuralLevels({
  highs,
  lows,
  candles,
  atr,
  mergeATR = 0.35,
  minProminenceATR = 0.35,
  prominenceWindow = 6
}) {
  const safeATR =
    Number.isFinite(atr) && atr > 0
      ? atr
      : estimateATRFromCandles(candles);

  const highLevels = [];

  for (const pivot of highs) {
    const prominence =
      calculateHighProminence(
        candles,
        pivot,
        prominenceWindow
      );

    const prominenceATR =
      safeATR > 0
        ? prominence / safeATR
        : 0;

    highLevels.push({
      ...pivot,

      prominenceATR:
        Number(prominenceATR.toFixed(3)),

      strength:
        prominenceATR >=
        minProminenceATR
          ? "MAJOR"
          : "STRUCTURE"
    });
  }

  const lowLevels = [];

  for (const pivot of lows) {
    const prominence =
      calculateLowProminence(
        candles,
        pivot,
        prominenceWindow
      );

    const prominenceATR =
      safeATR > 0
        ? prominence / safeATR
        : 0;

    lowLevels.push({
      ...pivot,

      prominenceATR:
        Number(prominenceATR.toFixed(3)),

      strength:
        prominenceATR >=
        minProminenceATR
          ? "MAJOR"
          : "STRUCTURE"
    });
  }

  // Prefer MAJOR levels. If there are not enough major levels,
  // keep confirmed STRUCTURE pivots as a fallback.
  const majorHighs =
    highLevels.filter(
      x => x.strength === "MAJOR"
    );

  const majorLows =
    lowLevels.filter(
      x => x.strength === "MAJOR"
    );

  const selectedHighs =
    majorHighs.length >= 2
      ? majorHighs
      : highLevels;

  const selectedLows =
    majorLows.length >= 2
      ? majorLows
      : lowLevels;

  return {
    highs: mergeStructuralLevels(
      selectedHighs,
      safeATR * mergeATR
    ),

    lows: mergeStructuralLevels(
      selectedLows,
      safeATR * mergeATR
    )
  };
}


// ============================================================
// PIVOT PROMINENCE
// ============================================================
function calculateHighProminence(
  candles,
  pivot,
  window = 6
) {
  const start =
    Math.max(0, pivot.index - window);

  const end =
    Math.min(
      candles.length - 1,
      pivot.index + window
    );

  let surroundingLow = Infinity;

  for (let i = start; i <= end; i++) {
    if (i === pivot.index) continue;

    surroundingLow =
      Math.min(
        surroundingLow,
        candles[i].low
      );
  }

  if (!Number.isFinite(surroundingLow)) {
    return 0;
  }

  return Math.max(
    0,
    pivot.price - surroundingLow
  );
}


function calculateLowProminence(
  candles,
  pivot,
  window = 6
) {
  const start =
    Math.max(0, pivot.index - window);

  const end =
    Math.min(
      candles.length - 1,
      pivot.index + window
    );

  let surroundingHigh = -Infinity;

  for (let i = start; i <= end; i++) {
    if (i === pivot.index) continue;

    surroundingHigh =
      Math.max(
        surroundingHigh,
        candles[i].high
      );
  }

  if (!Number.isFinite(surroundingHigh)) {
    return 0;
  }

  return Math.max(
    0,
    surroundingHigh - pivot.price
  );
}


// ============================================================
// MERGE NEAR-DUPLICATE STRUCTURE LEVELS
// ============================================================
function mergeStructuralLevels(
  levels,
  mergeDistance
) {
  if (!levels.length) return [];

  const sorted =
    levels
      .filter(x => Number.isFinite(x.price))
      .sort((a, b) => a.price - b.price);

  const groups = [];

  for (const level of sorted) {
    const last =
      groups.at(-1);

    if (
      last &&
      Math.abs(
        level.price -
        last.price
      ) <= mergeDistance
    ) {
      // Keep the stronger/more prominent pivot.
      if (
        (level.prominenceATR ?? 0) >
        (last.prominenceATR ?? 0)
      ) {
        groups[groups.length - 1] =
          level;
      }

      continue;
    }

    groups.push(level);
  }

  return groups.sort(
    (a, b) => a.index - b.index
  );
}


// ============================================================
// H1 SUPPORT
//
// Only confirmed structural swing lows BELOW price.
// ============================================================
function nearestStructuralBelow(
  levels,
  price
) {
  if (!Number.isFinite(price)) {
    return null;
  }

  const candidates =
    levels
      .filter(x =>
        Number.isFinite(x.price)
      )
      .filter(x =>
        x.price < price
      )
      .sort(
        (a, b) =>
          b.price - a.price
      );

  if (!candidates.length) {
    return null;
  }

  const level = candidates[0];

  return {
    price: level.price,
    distance:
      price - level.price,

    time: level.time,

    type: "H1_STRUCTURAL_SWING_LOW",

    strength:
      level.strength || "STRUCTURE",

    prominenceATR:
      level.prominenceATR ?? null
  };
}


// ============================================================
// H1 RESISTANCE
//
// Only confirmed structural swing highs ABOVE price.
// ============================================================
function nearestStructuralAbove(
  levels,
  price
) {
  if (!Number.isFinite(price)) {
    return null;
  }

  const candidates =
    levels
      .filter(x =>
        Number.isFinite(x.price)
      )
      .filter(x =>
        x.price > price
      )
      .sort(
        (a, b) =>
          a.price - b.price
      );

  if (!candidates.length) {
    return null;
  }

  const level = candidates[0];

  return {
    price: level.price,
    distance:
      level.price - price,

    time: level.time,

    type: "H1_STRUCTURAL_SWING_HIGH",

    strength:
      level.strength || "STRUCTURE",

    prominenceATR:
      level.prominenceATR ?? null
  };
}


// ============================================================
// ATR FALLBACK
// ============================================================
function estimateATRFromCandles(
  candles
) {
  if (candles.length < 2) {
    return 0;
  }

  const sample =
    candles.slice(-20);

  let total = 0;
  let count = 0;

  for (const c of sample) {
    const range =
      c.high - c.low;

    if (
      Number.isFinite(range) &&
      range > 0
    ) {
      total += range;
      count++;
    }
  }

  return count
    ? total / count
    : 0;
}
