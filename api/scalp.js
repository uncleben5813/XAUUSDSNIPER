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
    m5OutputSize: 2500,

    candleTTL: 60_000,
    priceTTL: 30_000,
    newsTTL: 300_000,

    pivotLeft: 3,
    pivotRight: 3,
    structureLookbackH1: 250,

    mergeATR: 0.35,
    minProminenceATR: 0.35,
    prominenceWindow: 6,

    // Scalp engine
    minRR: 1.35,
    tp1R: 1.0,
    tp2R: 2.0,
    tp3R: 3.0,
    m5SL_ATR: 1.25,
    nearLevelATR: 0.45,

    // News risk window. High-impact USD events are treated
    // as a temporary risk block around the scheduled release.
    newsHighBeforeMin: 30,
    newsHighAfterMin: 20,
    newsMediumBeforeMin: 10,
    newsMediumAfterMin: 10
  };

  globalThis.__XAU_SNIPER_CACHE__ ??= {
    candles: null,
    fetchedAt: 0,
    price: null,
    priceFetchedAt: 0,
    news: null,
    newsFetchedAt: 0
  };

  const cache = globalThis.__XAU_SNIPER_CACHE__;
  const now = Date.now();

  try {
    // ============================================================
    // M5 DATA - ONE TWELVE DATA REQUEST
    // ============================================================
    let m5;

    if (cache.candles && now - cache.fetchedAt < CFG.candleTTL) {
      m5 = cache.candles;
    } else {
      const url =
        `https://api.twelvedata.com/time_series` +
        `?symbol=${encodeURIComponent(CFG.symbol)}` +
        `&interval=5min` +
        `&outputsize=${CFG.m5OutputSize}` +
        `&apikey=${API_KEY}`;

      const r = await fetch(url);
      const d = await r.json();

      if (!r.ok || d?.status === "error" || !Array.isArray(d?.values)) {
        if (!cache.candles) {
          return res.status(502).json({
            ok: false,
            error: d?.message || "Twelve Data candle API error"
          });
        }
        m5 = cache.candles;
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

        cache.candles = m5;
        cache.fetchedAt = Date.now();
      }
    }

    // ============================================================
    // LIVE PRICE
    // ============================================================
    let livePrice = m5.at(-1)?.close ?? null;
    let livePriceSource = "M5_CANDLE_FALLBACK";
    let livePriceError = null;

    if (
      cache.price !== null &&
      Date.now() - cache.priceFetchedAt < CFG.priceTTL
    ) {
      livePrice = cache.price;
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

        if (r.ok && d?.status !== "error" && Number.isFinite(p)) {
          livePrice = p;
          livePriceSource = "TWELVE_DATA_PRICE";
          cache.price = p;
          cache.priceFetchedAt = Date.now();
        } else {
          livePriceError = d?.message || "Live price API error";
          if (cache.price !== null) {
            livePrice = cache.price;
            livePriceSource = "TWELVE_DATA_PRICE_CACHE";
          }
        }
      } catch (e) {
        livePriceError = e?.message || "Live price request failed";
        if (cache.price !== null) {
          livePrice = cache.price;
          livePriceSource = "TWELVE_DATA_PRICE_CACHE";
        }
      }
    }

    // ============================================================
    // BUILD TIMEFRAMES LOCALLY
    // ============================================================
    const m15All = aggregate(m5, 15);
    const h1All = aggregate(m5, 60);

    const m15 = closedTF(m15All);
    const h1 = closedTF(h1All);

    if (h1.length < 20) {
      return res.status(422).json({
        ok: false,
        error: "H1 candle tidak mencukupi",
        count: h1.length
      });
    }

    const structureData =
      h1.length > CFG.structureLookbackH1
        ? h1.slice(-CFG.structureLookbackH1)
        : h1;

    // ============================================================
    // H1 STRUCTURE
    // ============================================================
    const h1Pivots = findPivots(
      structureData,
      CFG.pivotLeft,
      CFG.pivotRight
    );

    const h1Highs = h1Pivots.filter(x => x.type === "HIGH");
    const h1Lows = h1Pivots.filter(x => x.type === "LOW");
    const h1ATR = calculateATR(structureData, 14);
    const h1Structure = classifyStructure(h1Highs, h1Lows);

    const h1Event = detectStructureEvent(
      structureData,
      h1Highs,
      h1Lows,
      h1Structure
    );

    const structuralLevels = buildStructuralLevels({
      highs: h1Highs,
      lows: h1Lows,
      candles: structureData,
      atr: h1ATR,
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
    // M15 CONFIRMATION
    // ============================================================
    const m15Analysis = analyzeM15(m15);

    // ============================================================
    // M5 TRIGGER
    // ============================================================
    const m5Analysis = analyzeM5(m5);

    // ============================================================
    // TECHNICAL SIGNAL
    //
    // USER RULE:
    // BUY  = M15 bullish + M5 BUY
    // SELL = M15 bearish + M5 SELL
    // H1 does NOT hard-veto a scalp signal.
    // ============================================================
    const technical = buildTechnicalSignal(
      m15Analysis,
      m5Analysis
    );

    // ============================================================
    // LIQUIDITY
    // ============================================================
    const liquidity = buildLiquidity(
      m5,
      h1Highs,
      h1Lows,
      livePrice,
      h1Structure
    );

    // ============================================================
    // ENTRY QUALITY + TRADE PLAN
    // ============================================================
    const entryQuality = calculateEntryQuality({
      signal: technical.signal,
      m15: m15Analysis,
      m5: m5Analysis,
      livePrice,
      support,
      resistance,
      h1ATR
    });

    const tradePlan = buildTradePlan({
      signal: technical.signal,
      livePrice,
      m5,
      m15: m15Analysis,
      support,
      resistance,
      h1ATR,
      liquidity,
      minRR: CFG.minRR,
      tp1R: CFG.tp1R,
      tp2R: CFG.tp2R,
      tp3R: CFG.tp3R,
      slATR: CFG.m5SL_ATR
    });

    // ============================================================
    // LIVE NEWS / ECONOMIC CALENDAR
    // ============================================================
    const newsFilter = await getLiveNewsFilter(CFG, cache);

    // News is a risk filter, not a replacement for the technical signal.
    // If a high-impact event is active, final signal becomes WAIT,
    // while technicalSignal remains visible for transparency.
    const finalSignal =
      newsFilter.blockSignal
        ? "WAIT"
        : technical.signal;

    const finalStrength =
      newsFilter.blockSignal
        ? "NEWS_BLOCK"
        : technical.strength;

    const finalTradePlan =
      newsFilter.blockSignal
        ? {
            ...tradePlan,
            active: false,
            direction: "WAIT",
            reason: "Technical signal blocked by active economic-news risk"
          }
        : tradePlan;

    // ============================================================
    // CONFIDENCE
    // ============================================================
    const confidence = calculateConfidence({
      technical,
      m15: m15Analysis,
      m5: m5Analysis,
      entryQuality,
      h1Structure,
      h1Event,
      newsFilter
    });

    // ============================================================
    // HOLD CONTEXT
    // ============================================================
    const h1Agrees =
      technical.signal !== "WAIT" &&
      h1Structure.bias ===
        (technical.signal === "BUY" ? "BULLISH" : "BEARISH");

    const holdContext = {
      status:
        finalSignal === "WAIT"
          ? "WAIT"
          : h1Agrees
            ? "HOLD_SUPPORTED"
            : "SCALP_ONLY",
      h1Agrees,
      note:
        finalSignal === "WAIT"
          ? newsFilter.blockSignal
            ? "Technical setup blocked by news risk"
            : "Waiting for M15 + M5 alignment"
          : h1Agrees
            ? "H1 supports scalp direction"
            : "H1 is context only; scalp signal remains valid"
    };

    // ============================================================
    // WARNINGS
    // ============================================================
    const warnings = buildWarnings({
      signal: finalSignal,
      livePrice,
      support,
      resistance,
      h1ATR,
      newsFilter,
      entryQuality
    });

    return res.status(200).json({
      ok: true,
      version: "XAUUSDSNIPER-FULL-V4-LIVE-NEWS",
      symbol: CFG.symbol,

      livePrice,
      price: livePrice,
      livePriceSource,
      livePriceAgeSeconds:
        cache.priceFetchedAt
          ? Math.round((Date.now() - cache.priceFetchedAt) / 1000)
          : null,
      livePriceError,

      // Technical signal before news filter.
      technicalSignal: technical.signal,
      technicalSignalStrength: technical.strength,
      technicalReasons: technical.reasons,

      // Final dashboard signal.
      signal: finalSignal,
      signalStrength: finalStrength,

      confidence,
      bias:
        finalSignal === "BUY"
          ? "BULLISH"
          : finalSignal === "SELL"
            ? "BEARISH"
            : "NEUTRAL",

      h1: {
        candles: h1All.length,
        closedCandles: h1.length,
        structureCandles: structureData.length,
        lastClosedTime: h1.at(-1)?.time ?? null,

        direction: h1Structure.bias,
        trend: h1Structure.bias,
        structure: h1Structure,

        bos: h1Event.type === "BOS" ? h1Event : null,
        choch: h1Event.type === "CHOCH" ? h1Event : null,
        event:
          h1Event.type !== "NONE"
            ? h1Event
            : null,

        support,
        resistance,

        supportLogic:
          "Nearest confirmed H1 structural swing low below live price",
        resistanceLogic:
          "Nearest confirmed H1 structural swing high above live price",

        atr14: Number.isFinite(h1ATR)
          ? Number(h1ATR.toFixed(4))
          : null,

        swings: {
          highs: h1Highs.slice(-12).map(x => ({
            price: x.price,
            time: x.time,
            strength: x.strength ?? "STRUCTURE"
          })),
          lows: h1Lows.slice(-12).map(x => ({
            price: x.price,
            time: x.time,
            strength: x.strength ?? "STRUCTURE"
          }))
        },

        majorStructures: {
          highs: structuralLevels.highs.slice(-12).map(x => ({
            type: x.type,
            price: x.price,
            time: x.time,
            strength: x.strength,
            prominenceATR: x.prominenceATR
          })),
          lows: structuralLevels.lows.slice(-12).map(x => ({
            type: x.type,
            price: x.price,
            time: x.time,
            strength: x.strength,
            prominenceATR: x.prominenceATR
          }))
        },

        breakTarget:
          h1Event.direction === "BULLISH"
            ? resistance
            : h1Event.direction === "BEARISH"
              ? support
              : null,

        context: {
          bullishResistance: resistance?.price ?? null,
          bearishSupport: support?.price ?? null,
          afterBullishBreak:
            h1Event.direction === "BULLISH"
              ? resistance?.price ?? null
              : null,
          afterBearishBreak:
            h1Event.direction === "BEARISH"
              ? support?.price ?? null
              : null
        }
      },

      m15: m15Analysis,
      m5: m5Analysis,

      tradePlan: finalTradePlan,
      entryQuality,
      liquidity,

      newsFilter,

      holdContext,
      warnings,

      rules: {
        scalpRequiresM15M5Alignment: true,
        h1IsContextNotHardVeto: true,
        structuralSROnly: true,
        newsIsRiskFilter: true,
        highImpactNewsCanBlockEntry: true
      },

      cache: {
        candleAgeSeconds:
          Math.round((Date.now() - cache.fetchedAt) / 1000),
        candleTTLSeconds: CFG.candleTTL / 1000,
        priceAgeSeconds:
          cache.priceFetchedAt
            ? Math.round((Date.now() - cache.priceFetchedAt) / 1000)
            : null,
        priceTTLSeconds: CFG.priceTTL / 1000,
        newsAgeSeconds:
          cache.newsFetchedAt
            ? Math.round((Date.now() - cache.newsFetchedAt) / 1000)
            : null,
        newsTTLSeconds: CFG.newsTTL / 1000,
        m5Candles: m5.length,
        m15Candles: m15.length,
        h1Candles: h1.length
      },

      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error("XAU SNIPER V4 ERROR", error);

    return res.status(500).json({
      ok: false,
      error: error?.message || "XAU sniper engine error"
    });
  }
}

// ============================================================
// TIMEFRAME HELPERS
// ============================================================

function closedTF(data) {
  if (!Array.isArray(data) || data.length < 2) {
    return Array.isArray(data) ? data : [];
  }
  return data.slice(0, -1);
}

function aggregate(data, minutes) {
  const size = minutes * 60 * 1000;
  const buckets = new Map();

  for (const c of data || []) {
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

  return [...buckets.values()].sort(
    (a, b) => new Date(a.time) - new Date(b.time)
  );
}

// ============================================================
// H1 STRUCTURE
// ============================================================

function findPivots(data, left = 3, right = 3) {
  const out = [];

  if (!Array.isArray(data) || data.length < left + right + 1) {
    return out;
  }

  for (let i = left; i < data.length - right; i++) {
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

  return out.sort((a, b) => a.index - b.index);
}

function calculateATR(data, period = 14) {
  if (!Array.isArray(data) || data.length < period + 1) {
    return null;
  }

  const tr = [];

  for (let i = 0; i < data.length; i++) {
    if (i === 0) {
      tr.push(Math.max(0, data[i].high - data[i].low));
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
  return slice.length
    ? slice.reduce((a, b) => a + b, 0) / slice.length
    : null;
}

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

  if (highPattern === "HH" && lowPattern === "HL") {
    bias = "BULLISH";
  } else if (highPattern === "LH" && lowPattern === "LL") {
    bias = "BEARISH";
  }

  return {
    bias,
    highPattern,
    lowPattern,
    lastSwingHigh: h.at(-1)?.price ?? null,
    lastSwingLow: l.at(-1)?.price ?? null
  };
}

function detectStructureEvent(data, highs, lows, structure) {
  const last = data.at(-1);

  if (!last) {
    return {
      type: "NONE",
      direction: "NONE",
      price: null,
      level: null,
      time: null,
      description: "No closed H1 candle"
    };
  }

  const priorHigh = highs.at(-1);
  const priorLow = lows.at(-1);

  const bullishBreak =
    priorHigh && last.close > priorHigh.price;

  const bearishBreak =
    priorLow && last.close < priorLow.price;

  if (bullishBreak) {
    const type =
      structure.bias === "BEARISH" ? "CHOCH" : "BOS";

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
      structure.bias === "BULLISH" ? "CHOCH" : "BOS";

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

  const highLevels = highs.map(pivot => {
    const prominence = calculateHighProminence(
      candles,
      pivot,
      prominenceWindow
    );
    const prominenceATR =
      safeATR > 0 ? prominence / safeATR : 0;

    return {
      ...pivot,
      prominenceATR: Number(prominenceATR.toFixed(3)),
      strength:
        prominenceATR >= minProminenceATR
          ? "MAJOR"
          : "STRUCTURE"
    };
  });

  const lowLevels = lows.map(pivot => {
    const prominence = calculateLowProminence(
      candles,
      pivot,
      prominenceWindow
    );
    const prominenceATR =
      safeATR > 0 ? prominence / safeATR : 0;

    return {
      ...pivot,
      prominenceATR: Number(prominenceATR.toFixed(3)),
      strength:
        prominenceATR >= minProminenceATR
          ? "MAJOR"
          : "STRUCTURE"
    };
  });

  const majorHighs = highLevels.filter(x => x.strength === "MAJOR");
  const majorLows = lowLevels.filter(x => x.strength === "MAJOR");

  return {
    highs: mergeStructuralLevels(
      majorHighs.length >= 2 ? majorHighs : highLevels,
      safeATR * mergeATR
    ),
    lows: mergeStructuralLevels(
      majorLows.length >= 2 ? majorLows : lowLevels,
      safeATR * mergeATR
    )
  };
}

function calculateHighProminence(candles, pivot, window = 6) {
  const start = Math.max(0, pivot.index - window);
  const end = Math.min(candles.length - 1, pivot.index + window);

  let surroundingLow = Infinity;

  for (let i = start; i <= end; i++) {
    if (i === pivot.index) continue;
    surroundingLow = Math.min(surroundingLow, candles[i].low);
  }

  if (!Number.isFinite(surroundingLow)) return 0;
  return Math.max(0, pivot.price - surroundingLow);
}

function calculateLowProminence(candles, pivot, window = 6) {
  const start = Math.max(0, pivot.index - window);
  const end = Math.min(candles.length - 1, pivot.index + window);

  let surroundingHigh = -Infinity;

  for (let i = start; i <= end; i++) {
    if (i === pivot.index) continue;
    surroundingHigh = Math.max(surroundingHigh, candles[i].high);
  }

  if (!Number.isFinite(surroundingHigh)) return 0;
  return Math.max(0, surroundingHigh - pivot.price);
}

function mergeStructuralLevels(levels, mergeDistance) {
  if (!levels.length) return [];

  const sorted = levels
    .filter(x => Number.isFinite(x.price))
    .slice()
    .sort((a, b) => a.price - b.price);

  const groups = [];

  for (const level of sorted) {
    const last = groups.at(-1);

    if (
      last &&
      Math.abs(level.price - last.price) <= mergeDistance
    ) {
      if ((level.prominenceATR ?? 0) > (last.prominenceATR ?? 0)) {
        groups[groups.length - 1] = level;
      }
      continue;
    }

    groups.push(level);
  }

  return groups.sort((a, b) => a.index - b.index);
}

function nearestStructuralBelow(levels, price) {
  if (!Number.isFinite(price)) return null;

  const candidates = levels
    .filter(x => Number.isFinite(x.price) && x.price < price)
    .sort((a, b) => b.price - a.price);

  if (!candidates.length) return null;

  const level = candidates[0];

  return {
    price: level.price,
    distance: price - level.price,
    time: level.time,
    type: "H1_STRUCTURAL_SWING_LOW",
    strength: level.strength || "STRUCTURE",
    prominenceATR: level.prominenceATR ?? null
  };
}

function nearestStructuralAbove(levels, price) {
  if (!Number.isFinite(price)) return null;

  const candidates = levels
    .filter(x => Number.isFinite(x.price) && x.price > price)
    .sort((a, b) => a.price - b.price);

  if (!candidates.length) return null;

  const level = candidates[0];

  return {
    price: level.price,
    distance: level.price - price,
    time: level.time,
    type: "H1_STRUCTURAL_SWING_HIGH",
    strength: level.strength || "STRUCTURE",
    prominenceATR: level.prominenceATR ?? null
  };
}

function estimateATRFromCandles(candles) {
  if (!Array.isArray(candles) || candles.length < 2) return 0;

  const sample = candles.slice(-20);
  let total = 0;
  let count = 0;

  for (const c of sample) {
    const range = c.high - c.low;
    if (Number.isFinite(range) && range > 0) {
      total += range;
      count++;
    }
  }

  return count ? total / count : 0;
}

// ============================================================
// M15 ANALYSIS
// ============================================================

function analyzeM15(data) {
  if (!data.length) {
    return {
      candles: 0,
      direction: "WAIT",
      confirmation: "WAIT",
      score: 0,
      structure: "NONE",
      event: "NONE",
      reasons: ["No closed M15 candles"],
      atr: null
    };
  }

  const atr = calculateATR(data, 14);
  const pivots = findPivots(data, 2, 2);
  const highs = pivots.filter(x => x.type === "HIGH");
  const lows = pivots.filter(x => x.type === "LOW");
  const structure = classifyStructure(highs, lows);
  const event = detectStructureEvent(data, highs, lows, structure);
  const last = data.at(-1);
  const prev = data.at(-2);

  let bullish = 0;
  let bearish = 0;
  const reasons = [];

  if (structure.bias === "BULLISH") {
    bullish += 2;
    reasons.push("bullish structure");
  } else if (structure.bias === "BEARISH") {
    bearish += 2;
    reasons.push("bearish structure");
  }

  if (last && prev) {
    if (last.close > prev.close) {
      bullish++;
      reasons.push("bullish candle");
    } else if (last.close < prev.close) {
      bearish++;
      reasons.push("bearish candle");
    }
  }

  if (event.direction === "BULLISH") {
    bullish += 2;
    reasons.push(event.type);
  } else if (event.direction === "BEARISH") {
    bearish += 2;
    reasons.push(event.type);
  }

  const direction =
    bullish > bearish && bullish >= 2
      ? "BULLISH"
      : bearish > bullish && bearish >= 2
        ? "BEARISH"
        : "NEUTRAL";

  const score = clamp(
    Math.round(Math.max(bullish, bearish) * 20),
    0,
    100
  );

  return {
    candles: data.length,
    direction,
    confirmation:
      direction === "BULLISH"
        ? "BULLISH"
        : direction === "BEARISH"
          ? "BEARISH"
          : "WAIT",
    score,
    structure: structure.bias,
    event:
      event.type === "NONE"
        ? "NONE"
        : event.type,
    reasons: reasons.length ? reasons : ["No strong M15 confirmation"],
    atr: finiteRound(atr, 4),
    lastClosedTime: last?.time ?? null
  };
}

// ============================================================
// M5 TRIGGER
//
// More selective than simply looking at candle colour.
// Requires:
// - direction candle
// - body quality
// - momentum against previous candle
// - breakout/engulfing OR strong continuation
// ============================================================

function analyzeM5(data) {
  if (!data.length) {
    return {
      candles: 0,
      direction: "WAIT",
      trigger: "WAIT",
      score: 0,
      structure: "NONE",
      event: "NONE",
      reasons: ["No closed M5 candles"],
      atr: null
    };
  }

  const closed = data.length > 1 ? data.slice(0, -1) : data;
  const last = closed.at(-1);
  const prev = closed.at(-2);
  const prev2 = closed.at(-3);
  const atr = calculateATR(closed, 14);

  if (!last) {
    return {
      candles: closed.length,
      direction: "WAIT",
      trigger: "WAIT",
      score: 0,
      structure: "NONE",
      event: "NONE",
      reasons: ["No closed M5 candle"],
      atr: finiteRound(atr, 4)
    };
  }

  const pivots = findPivots(closed.slice(-80), 2, 2);
  const highs = pivots.filter(x => x.type === "HIGH");
  const lows = pivots.filter(x => x.type === "LOW");
  const structure = classifyStructure(highs, lows);

  const range = Math.max(last.high - last.low, 0);
  const body = Math.abs(last.close - last.open);
  const bodyRatio = range > 0 ? body / range : 0;

  const bullish = last.close > last.open;
  const bearish = last.close < last.open;

  let buyScore = 0;
  let sellScore = 0;
  const buyReasons = [];
  const sellReasons = [];

  if (bullish) {
    buyScore += 20;
    buyReasons.push("bullish close");
  }

  if (bearish) {
    sellScore += 20;
    sellReasons.push("bearish close");
  }

  if (bodyRatio >= 0.55) {
    if (bullish) {
      buyScore += 20;
      buyReasons.push("strong body");
    }
    if (bearish) {
      sellScore += 20;
      sellReasons.push("strong body");
    }
  }

  if (prev) {
    if (bullish && last.close > prev.high) {
      buyScore += 30;
      buyReasons.push("breaks previous M5 high");
    }

    if (bearish && last.close < prev.low) {
      sellScore += 30;
      sellReasons.push("breaks previous M5 low");
    }

    if (bullish && prev.close < prev.open && last.close > prev.open) {
      buyScore += 20;
      buyReasons.push("bullish engulfing");
    }

    if (bearish && prev.close > prev.open && last.close < prev.open) {
      sellScore += 20;
      sellReasons.push("bearish engulfing");
    }
  }

  if (prev && prev2) {
    if (
      bullish &&
      last.close > prev.close &&
      prev.close > prev2.close
    ) {
      buyScore += 10;
      buyReasons.push("3-candle bullish momentum");
    }

    if (
      bearish &&
      last.close < prev.close &&
      prev.close < prev2.close
    ) {
      sellScore += 10;
      sellReasons.push("3-candle bearish momentum");
    }
  }

  if (structure.bias === "BULLISH") {
    buyScore += 10;
    buyReasons.push("M5 structure bullish");
  }

  if (structure.bias === "BEARISH") {
    sellScore += 10;
    sellReasons.push("M5 structure bearish");
  }

  const threshold = 60;

  const trigger =
    buyScore >= threshold && buyScore > sellScore
      ? "BUY"
      : sellScore >= threshold && sellScore > buyScore
        ? "SELL"
        : "WAIT";

  return {
    candles: closed.length,
    direction:
      trigger === "BUY"
        ? "BULLISH"
        : trigger === "SELL"
          ? "BEARISH"
          : "WAIT",
    trigger,
    score: clamp(Math.max(buyScore, sellScore), 0, 100),
    structure: structure.bias,
    event: "NONE",
    reasons:
      trigger === "BUY"
        ? buyReasons
        : trigger === "SELL"
          ? sellReasons
          : ["M5 trigger belum cukup kuat"],
    atr: finiteRound(atr, 4),
    bodyRatio: Number(bodyRatio.toFixed(3)),
    lastClosedTime: last.time
  };
}

function buildTechnicalSignal(m15, m5) {
  if (
    m15.direction === "BULLISH" &&
    m5.trigger === "BUY"
  ) {
    return {
      signal: "BUY",
      strength: m15.score >= 60 && m5.score >= 70
        ? "STRONG"
        : "NORMAL",
      reasons: [
        "M15 bullish confirmation",
        "M5 BUY trigger",
        "M15 + M5 aligned"
      ]
    };
  }

  if (
    m15.direction === "BEARISH" &&
    m5.trigger === "SELL"
  ) {
    return {
      signal: "SELL",
      strength: m15.score >= 60 && m5.score >= 70
        ? "STRONG"
        : "NORMAL",
      reasons: [
        "M15 bearish confirmation",
        "M5 SELL trigger",
        "M15 + M5 aligned"
      ]
    };
  }

  return {
    signal: "WAIT",
    strength: "WAIT",
    reasons: [
      "M15 + M5 belum aligned"
    ]
  };
}

// ============================================================
// LIQUIDITY
// ============================================================

function buildLiquidity(
  m5,
  h1Highs,
  h1Lows,
  price,
  h1Structure
) {
  const recent = m5.slice(-120);
  const pivots = findPivots(recent, 2, 2);

  const localHighs = pivots
    .filter(x => x.type === "HIGH")
    .map(x => x.price)
    .filter(Number.isFinite);

  const localLows = pivots
    .filter(x => x.type === "LOW")
    .map(x => x.price)
    .filter(Number.isFinite);

  const buySide = uniq(
    [
      ...nearEqual(localHighs),
      h1Structure.lastSwingHigh,
      ...h1Highs.slice(-4).map(x => x.price)
    ]
      .filter(x => Number.isFinite(x))
      .filter(x => x >= price)
      .sort((a, b) => a - b)
      .slice(0, 8)
  );

  const sellSide = uniq(
    [
      ...nearEqual(localLows),
      h1Structure.lastSwingLow,
      ...h1Lows.slice(-4).map(x => x.price)
    ]
      .filter(x => Number.isFinite(x))
      .filter(x => x <= price)
      .sort((a, b) => b - a)
      .slice(0, 8)
  );

  return {
    buySide,
    sellSide,
    equalHighs:
      equalLevels(localHighs).slice(0, 5),
    equalLows:
      equalLevels(localLows).slice(0, 5),
    previousH1High: h1Structure.lastSwingHigh ?? null,
    previousH1Low: h1Structure.lastSwingLow ?? null,
    nearestBuySide: buySide[0] ?? null,
    nearestSellSide: sellSide[0] ?? null
  };
}

function equalLevels(levels) {
  const out = [];

  for (let i = 0; i < levels.length; i++) {
    for (let j = i + 1; j < levels.length; j++) {
      const a = levels[i];
      const b = levels[j];
      const tolerance = 0.12;

      if (Math.abs(a - b) <= tolerance) {
        out.push(Number(((a + b) / 2).toFixed(4)));
      }
    }
  }

  return uniq(out);
}

function nearEqual(levels) {
  return equalLevels(levels);
}

function uniq(arr) {
  return [...new Set(
    arr.map(x => Number(Number(x).toFixed(4)))
  )];
}

// ============================================================
// ENTRY QUALITY
// ============================================================

function calculateEntryQuality({
  signal,
  m15,
  m5,
  livePrice,
  support,
  resistance,
  h1ATR
}) {
  let score = 0;
  const reasons = [];

  if (signal === "BUY" || signal === "SELL") {
    score += 25;
    reasons.push("M15 + M5 aligned");
  }

  if (
    signal === "BUY" &&
    m15.direction === "BULLISH"
  ) {
    score += 15;
  }

  if (
    signal === "SELL" &&
    m15.direction === "BEARISH"
  ) {
    score += 15;
  }

  if (m5.score >= 70) {
    score += 20;
    reasons.push("strong M5 trigger");
  } else if (m5.score >= 60) {
    score += 10;
  }

  const atr = Number.isFinite(h1ATR) ? h1ATR : null;

  if (atr && signal === "BUY" && resistance) {
    const d = resistance.price - livePrice;
    if (d > atr * 0.45) {
      score += 15;
      reasons.push("room to H1 resistance");
    }
  }

  if (atr && signal === "SELL" && support) {
    const d = livePrice - support.price;
    if (d > atr * 0.45) {
      score += 15;
      reasons.push("room to H1 support");
    }
  }

  const warning =
    signal === "BUY" && resistance && atr
      ? {
          warning:
            resistance.distance <= atr * 0.45,
          type:
            resistance.distance <= atr * 0.45
              ? "NEAR_H1_RESISTANCE"
              : null,
          level: resistance?.price ?? null
        }
      : signal === "SELL" && support && atr
        ? {
            warning:
              support.distance <= atr * 0.45,
            type:
              support.distance <= atr * 0.45
                ? "NEAR_H1_SUPPORT"
                : null,
            level: support?.price ?? null
          }
        : {
            warning: false,
            type: null,
            level: null
          };

  return {
    score: clamp(score, 0, 100),
    label:
      score >= 75
        ? "HIGH"
        : score >= 60
          ? "GOOD"
          : score >= 40
            ? "WAIT"
            : "LOW",
    m15Aligned:
      (signal === "BUY" && m15.direction === "BULLISH") ||
      (signal === "SELL" && m15.direction === "BEARISH"),
    m5Triggered:
      (signal === "BUY" && m5.trigger === "BUY") ||
      (signal === "SELL" && m5.trigger === "SELL"),
    warning,
    reasons
  };
}

// ============================================================
// TRADE PLAN
// ============================================================

function buildTradePlan({
  signal,
  livePrice,
  m5,
  m15,
  support,
  resistance,
  h1ATR,
  liquidity,
  minRR,
  tp1R,
  tp2R,
  tp3R,
  slATR
}) {
  if (
    signal !== "BUY" &&
    signal !== "SELL"
  ) {
    return {
      active: false,
      direction: "WAIT",
      entry: finiteRound(livePrice, 2),
      stopLoss: null,
      tp1: null,
      tp2: null,
      tp3: null,
      rr: null,
      validRR: false,
      reason: "No M15 + M5 aligned signal"
    };
  }

  const entry = livePrice;
  const atr = Number.isFinite(m5.atr)
    ? m5.atr
    : Number.isFinite(h1ATR)
      ? h1ATR / 4
      : 0.25;

  const buffer = Math.max(
    atr * slATR,
    0.18
  );

  let stopLoss;

  if (signal === "BUY") {
    const structural =
      support?.price != null
        ? support.price - Math.max(atr * 0.25, 0.05)
        : null;

    const atrStop = entry - buffer;

    stopLoss =
      structural != null
        ? Math.min(structural, atrStop)
        : atrStop;

    // Avoid absurdly large stops for scalp plans.
    if (entry - stopLoss > atr * 3) {
      stopLoss = atrStop;
    }
  } else {
    const structural =
      resistance?.price != null
        ? resistance.price + Math.max(atr * 0.25, 0.05)
        : null;

    const atrStop = entry + buffer;

    stopLoss =
      structural != null
        ? Math.max(structural, atrStop)
        : atrStop;

    if (stopLoss - entry > atr * 3) {
      stopLoss = atrStop;
    }
  }

  const risk = Math.abs(entry - stopLoss);

  if (!Number.isFinite(risk) || risk <= 0) {
    return {
      active: false,
      direction: "WAIT",
      entry: finiteRound(entry, 2),
      stopLoss: null,
      tp1: null,
      tp2: null,
      tp3: null,
      rr: null,
      validRR: false,
      reason: "Invalid risk distance"
    };
  }

  const structuralTarget =
    signal === "BUY"
      ? resistance?.price ?? null
      : support?.price ?? null;

  const structuralRR =
    structuralTarget != null
      ? Math.abs(structuralTarget - entry) / risk
      : null;

  const rr = Number(
    (structuralRR ?? tp2R).toFixed(2)
  );

  const validRR =
    Number.isFinite(rr) &&
    rr >= minRR;

  const tp1 =
    signal === "BUY"
      ? entry + risk * tp1R
      : entry - risk * tp1R;

  const tp2 =
    signal === "BUY"
      ? entry + risk * tp2R
      : entry - risk * tp2R;

  const tp3 =
    signal === "BUY"
      ? entry + risk * tp3R
      : entry - risk * tp3R;

  return {
    active: validRR,
    direction: validRR ? signal : "WAIT",
    entry: finiteRound(entry, 2),
    stopLoss: finiteRound(stopLoss, 2),
    tp1: finiteRound(tp1, 2),
    tp2: finiteRound(tp2, 2),
    tp3: finiteRound(tp3, 2),
    rr,
    validRR,
    structuralTarget:
      finiteOrNull(structuralTarget, 2),
    reason: validRR
      ? "M15 + M5 aligned and RR valid"
      : `RR below minimum ${minRR}`
  };
}

// ============================================================
// LIVE NEWS FILTER
//
// Source:
// financecalendar.com public calendar API.
// It provides scheduled economic releases, impact level,
// consensus/prior/actual and UTC timestamps.
//
// We focus on USD/US events because XAU/USD is USD-denominated.
// ============================================================

async function getLiveNewsFilter(CFG, cache) {
  const now = Date.now();

  if (
    cache.news &&
    now - cache.newsFetchedAt < CFG.newsTTL
  ) {
    return evaluateNews(cache.news, CFG, now);
  }

  try {
    const from = isoDateUTC(new Date(now - 24 * 60 * 60 * 1000));
    const to = isoDateUTC(
      new Date(now + 7 * 24 * 60 * 60 * 1000)
    );

    const url =
      `https://www.financecalendar.com/wp-json/fc/v1/calendar` +
      `?from=${from}` +
      `&to=${to}` +
      `&impact=high,medium` +
      `&limit=500`;

    const r = await fetch(url, {
      headers: {
        "accept": "application/json"
      }
    });

    if (!r.ok) {
      throw new Error(`News API HTTP ${r.status}`);
    }

    const d = await r.json();
    const raw = Array.isArray(d)
      ? d
      : Array.isArray(d?.events)
        ? d.events
        : [];

    const events = raw
      .map(normalizeNewsEvent)
      .filter(Boolean)
      .filter(isGoldRelevantNews);

    cache.news = events;
    cache.newsFetchedAt = Date.now();

    return evaluateNews(events, CFG, Date.now());
  } catch (error) {
    return {
      status: "UNKNOWN",
      live: false,
      blockSignal: false,
      reason:
        error?.message ||
        "Live economic calendar unavailable",
      source: "financecalendar.com",
      sourceUrl: "https://www.financecalendar.com",
      items: [],
      nextHighImpact: null,
      activeEvent: null
    };
  }
}

function normalizeNewsEvent(e) {
  const time =
    e?.time_utc ||
    e?.datetime_utc ||
    e?.date_utc ||
    e?.date;

  const timestamp = Date.parse(time);

  if (!Number.isFinite(timestamp)) {
    return null;
  }

  const name =
    e?.name ||
    e?.title ||
    e?.event ||
    "Economic event";

  const impact = String(
    e?.impact || "medium"
  ).toLowerCase();

  const country = String(
    e?.country ||
    e?.currency ||
    e?.region ||
    ""
  ).toUpperCase();

  return {
    id:
      e?.id ||
      e?.url ||
      `${name}-${timestamp}`,
    name,
    title: e?.title || name,
    impact,
    country,
    category: e?.category || null,
    timestamp,
    timeUTC: new Date(timestamp).toISOString(),
    consensus: e?.consensus ?? null,
    prior: e?.prior ?? null,
    actual: e?.actual ?? null,
    url: e?.url || null
  };
}

function isGoldRelevantNews(e) {
  const text =
    `${e.name} ${e.title} ${e.category} ${e.country}`
      .toLowerCase();

  const usd =
    /(^|[^a-z])(us|usa|usd|united states)([^a-z]|$)/i.test(
      `${e.country} ${e.name} ${e.title}`
    ) ||
    /\bus\b|\busa\b|\busd\b|united states/.test(text);

  const goldMacro =
    /fomc|fed|federal reserve|interest rate|rate decision|cpi|inflation|ppi|pce|payroll|non-farm|nfp|employment|unemployment|gdp|retail sales|jobless|claims|ism|jolts|consumer confidence|powell|treasury|bond|manufactur|services pmi/.test(
      text
    );

  return usd || goldMacro;
}

function evaluateNews(events, CFG, now) {
  const sorted = events
    .slice()
    .sort((a, b) => a.timestamp - b.timestamp);

  let activeEvent = null;
  let blockSignal = false;

  const items = sorted
    .filter(e => {
      const diffMin = (e.timestamp - now) / 60000;
      return diffMin >= -120 && diffMin <= 7 * 24 * 60;
    })
    .slice(0, 25)
    .map(e => {
      const diffMin = (e.timestamp - now) / 60000;
      const impact = normalizeImpact(e.impact);

      const before =
        impact === "high"
          ? CFG.newsHighBeforeMin
          : CFG.newsMediumBeforeMin;

      const after =
        impact === "high"
          ? CFG.newsHighAfterMin
          : CFG.newsMediumAfterMin;

      const active =
        diffMin >= -after &&
        diffMin <= before;

      if (active && impact === "high" && !activeEvent) {
        activeEvent = e;
        blockSignal = true;
      }

      return {
        ...e,
        impact,
        minutesToEvent: Number(diffMin.toFixed(1)),
        active
      };
    });

  const nextHighImpact =
    items.find(
      x =>
        x.impact === "high" &&
        x.minutesToEvent >= 0
    ) || null;

  let status = "CLEAR";

  if (activeEvent) {
    status = "HIGH_RISK";
  } else if (
    nextHighImpact &&
    nextHighImpact.minutesToEvent <= 60
  ) {
    status = "HIGH_SOON";
  } else if (
    items.some(
      x =>
        x.impact === "medium" &&
        x.active
    )
  ) {
    status = "MEDIUM_RISK";
  }

  return {
    status,
    live: true,
    blockSignal,
    reason:
      activeEvent
        ? `High-impact event active: ${activeEvent.name}`
        : nextHighImpact
          ? `Next high-impact event in ${nextHighImpact.minutesToEvent} minutes`
          : "No active relevant high-impact event",
    source: "financecalendar.com",
    sourceUrl: "https://www.financecalendar.com",
    activeEvent,
    nextHighImpact,
    items
  };
}

function normalizeImpact(value) {
  const x = String(value || "").toLowerCase();

  if (x.includes("high")) return "high";
  if (x.includes("medium") || x.includes("med")) return "medium";
  return "low";
}

// ============================================================
// CONFIDENCE
// ============================================================

function calculateConfidence({
  technical,
  m15,
  m5,
  entryQuality,
  h1Structure,
  h1Event,
  newsFilter
}) {
  if (technical.signal === "WAIT") {
    return clamp(
      Math.round(
        30 +
        m15.score * 0.15 +
        m5.score * 0.15 +
        entryQuality.score * 0.15
      ),
      0,
      100
    );
  }

  let score = 40;

  score += m15.score * 0.20;
  score += m5.score * 0.20;
  score += entryQuality.score * 0.20;

  if (
    h1Structure.bias ===
    (technical.signal === "BUY"
      ? "BULLISH"
      : "BEARISH")
  ) {
    score += 10;
  }

  if (
    h1Event.direction ===
    (technical.signal === "BUY"
      ? "BULLISH"
      : "BEARISH")
  ) {
    score += 5;
  }

  if (newsFilter.blockSignal) {
    score -= 25;
  } else if (newsFilter.status === "HIGH_SOON") {
    score -= 10;
  } else if (newsFilter.status === "MEDIUM_RISK") {
    score -= 5;
  }

  return clamp(Math.round(score), 0, 100);
}

// ============================================================
// WARNINGS
// ============================================================

function buildWarnings({
  signal,
  livePrice,
  support,
  resistance,
  h1ATR,
  newsFilter,
  entryQuality
}) {
  const warnings = [];

  if (
    signal === "BUY" &&
    resistance &&
    Number.isFinite(h1ATR) &&
    resistance.distance <= h1ATR * 0.45
  ) {
    warnings.push({
      type: "NEAR_H1_RESISTANCE",
      level: resistance.price,
      distance: resistance.distance,
      message: "BUY is close to H1 structural resistance"
    });
  }

  if (
    signal === "SELL" &&
    support &&
    Number.isFinite(h1ATR) &&
    support.distance <= h1ATR * 0.45
  ) {
    warnings.push({
      type: "NEAR_H1_SUPPORT",
      level: support.price,
      distance: support.distance,
      message: "SELL is close to H1 structural support"
    });
  }

  if (newsFilter.blockSignal) {
    warnings.push({
      type: "HIGH_IMPACT_NEWS",
      level: null,
      distance: null,
      message: newsFilter.reason
    });
  }

  if (
    entryQuality.score < 50 &&
    signal !== "WAIT"
  ) {
    warnings.push({
      type: "LOW_ENTRY_QUALITY",
      level: null,
      distance: null,
      message: "Technical signal exists but entry quality is weak"
    });
  }

  return warnings;
}

// ============================================================
// UTILITIES
// ============================================================

function clamp(x, min, max) {
  return Math.max(min, Math.min(max, x));
}

function finiteRound(value, digits = 2) {
  return Number.isFinite(value)
    ? Number(value.toFixed(digits))
    : null;
}

function finiteOrNull(value, digits = 2) {
  return Number.isFinite(value)
    ? Number(value.toFixed(digits))
    : null;
}

function isoDateUTC(date) {
  return date.toISOString().slice(0, 10);
}
