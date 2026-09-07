const TWELVE_DATA_API_KEY = process.env.TWELVE_DATA_API_KEY;

const CONFIG = {
  symbol: "XAU/USD",
  interval: "5min",
  outputsize: 2500,

  // Candle data boleh cache 60s
  candleCacheTTL: 60 * 1000,

  // Live price refresh 5s
  livePriceTTL: 5 * 1000
};

let candleCache = {
  data: null,
  timestamp: 0
};

let livePriceCache = {
  data: null,
  timestamp: 0
};

async function twelveData(endpoint, params = {}) {
  const url = new URL(`https://api.twelvedata.com/${endpoint}`);

  Object.entries({
    ...params,
    apikey: TWELVE_DATA_API_KEY
  }).forEach(([key, value]) => {
    url.searchParams.set(key, value);
  });

  const response = await fetch(url.toString(), {
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(`Twelve Data HTTP ${response.status}`);
  }

  const data = await response.json();

  if (data.status === "error") {
    throw new Error(data.message || "Twelve Data error");
  }

  return data;
}

async function getLivePrice() {
  const now = Date.now();

  if (
    livePriceCache.data &&
    now - livePriceCache.timestamp < CONFIG.livePriceTTL
  ) {
    return livePriceCache.data;
  }

  const data = await twelveData("price", {
    symbol: CONFIG.symbol
  });

  const price = Number(data.price);

  if (!Number.isFinite(price)) {
    throw new Error("Invalid live XAU/USD price");
  }

  const result = {
    price,
    symbol: CONFIG.symbol,
    timestamp: Date.now(),
    source: "Twelve Data REST"
  };

  livePriceCache = {
    data: result,
    timestamp: now
  };

  return result;
}

async function getCandles() {
  const now = Date.now();

  if (
    candleCache.data &&
    now - candleCache.timestamp < CONFIG.candleCacheTTL
  ) {
    return candleCache.data;
  }

  const data = await twelveData("time_series", {
    symbol: CONFIG.symbol,
    interval: CONFIG.interval,
    outputsize: CONFIG.outputsize,
    order: "ASC"
  });

  if (!Array.isArray(data.values)) {
    throw new Error("No candle data returned");
  }

  const candles = data.values
    .map(c => ({
      datetime: c.datetime,
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close),
      volume: Number(c.volume || 0)
    }))
    .filter(c =>
      Number.isFinite(c.open) &&
      Number.isFinite(c.high) &&
      Number.isFinite(c.low) &&
      Number.isFinite(c.close)
    );

  candleCache = {
    data: candles,
    timestamp: now
  };

  return candles;
}

function ema(values, period) {
  if (!values.length) return [];

  const result = [];
  const multiplier = 2 / (period + 1);

  let previous = values[0];

  result.push(previous);

  for (let i = 1; i < values.length; i++) {
    const current =
      (values[i] - previous) * multiplier + previous;

    result.push(current);
    previous = current;
  }

  return result;
}

function sma(values, period) {
  const result = [];

  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) {
      result.push(null);
      continue;
    }

    let sum = 0;

    for (let j = i - period + 1; j <= i; j++) {
      sum += values[j];
    }

    result.push(sum / period);
  }

  return result;
}

function calculateRSI(values, period = 14) {
  if (values.length <= period) return [];

  const result = new Array(values.length).fill(null);

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];

    if (change >= 0) {
      gains += change;
    } else {
      losses += Math.abs(change);
    }
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  result[period] =
    avgLoss === 0
      ? 100
      : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];

    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);

    avgGain =
      (avgGain * (period - 1) + gain) / period;

    avgLoss =
      (avgLoss * (period - 1) + loss) / period;

    result[i] =
      avgLoss === 0
        ? 100
        : 100 - 100 / (1 + avgGain / avgLoss);
  }

  return result;
}

function buildSignal(candles) {
  if (candles.length < 50) {
    return {
      signal: "WAIT",
      score: 0,
      reason: "Not enough candle data"
    };
  }

  const closes = candles.map(c => c.close);

  const fastEMA = ema(closes, 9);
  const slowEMA = ema(closes, 21);
  const rsi = calculateRSI(closes, 14);

  const i = closes.length - 1;

  const price = closes[i];
  const ema9 = fastEMA[i];
  const ema21 = slowEMA[i];
  const currentRSI = rsi[i];

  let score = 0;
  let direction = "WAIT";
  const reasons = [];

  if (ema9 > ema21) {
    score += 30;
    direction = "BUY";
    reasons.push("EMA9 above EMA21");
  }

  if (ema9 < ema21) {
    score += 30;
    direction = "SELL";
    reasons.push("EMA9 below EMA21");
  }

  if (currentRSI >= 50 && currentRSI <= 70) {
    score += 25;

    if (direction === "BUY") {
      reasons.push("RSI bullish");
    }
  }

  if (currentRSI <= 50 && currentRSI >= 30) {
    score += 25;

    if (direction === "SELL") {
      reasons.push("RSI bearish");
    }
  }

  if (direction === "BUY" && price > ema9) {
    score += 25;
    reasons.push("Price above EMA9");
  }

  if (direction === "SELL" && price < ema9) {
    score += 25;
    reasons.push("Price below EMA9");
  }

  if (score < 75) {
    direction = "WAIT";
  }

  return {
    signal: direction,
    score,
    price,
    ema9,
    ema21,
    rsi: currentRSI,
    reasons
  };
}

export default async function handler(req, res) {
  try {
    if (!TWELVE_DATA_API_KEY) {
      return res.status(500).json({
        ok: false,
        error: "TWELVE_DATA_API_KEY is not configured"
      });
    }

    const [livePrice, candles] = await Promise.all([
      getLivePrice(),
      getCandles()
    ]);

    const signalEngine = buildSignal(candles);

    const lastCandle =
      candles[candles.length - 1] || null;

    return res.status(200).json({
      ok: true,

      symbol: CONFIG.symbol,

      livePrice,

      price: livePrice.price,

      candles,

      lastCandle,

      signal: signalEngine.signal,

      score: signalEngine.score,

      engine: signalEngine,

      status: "LIVE",

      data: {
        candleCount: candles.length,
        candleInterval: CONFIG.interval,
        livePriceSource: livePrice.source
      },

      timestamp: Date.now()
    });

  } catch (error) {
    console.error("SCALP API ERROR:", error);

    return res.status(500).json({
      ok: false,
      status: "ERROR",
      error: error.message || "Unknown server error",
      timestamp: Date.now()
    });
  }
}
