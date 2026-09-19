export default async function handler(req, res) {
  const API_KEY = process.env.TWELVE_DATA_API_KEY;
  if (!API_KEY) return res.status(500).json({ ok:false, error:'TWELVE_DATA_API_KEY belum diset' });

  const CFG = {
    symbol: 'XAU/USD',
    m5OutputSize: 2500,
    candleTTL: 60_000,
    priceTTL: 30_000,
    pivotLeft: 2,
    pivotRight: 2,
    srMaxAgeHours: 240
  };

  globalThis.__XAU_STRUCTURE_CACHE__ ??= { candles:null, fetchedAt:0 };
  globalThis.__XAU_LIVE_PRICE__ ??= { price:null, fetchedAt:0 };
  const candleCache = globalThis.__XAU_STRUCTURE_CACHE__;
  const priceCache = globalThis.__XAU_LIVE_PRICE__;

  const now = Date.now();

  try {
    // ---------------------------------------------------------
    // M5 DATA — one cached Twelve Data request. H1 is aggregated
    // locally so the H1 structure does not consume another API call.
    // ---------------------------------------------------------
    let m5;
    if (candleCache.candles && now - candleCache.fetchedAt < CFG.candleTTL) {
      m5 = candleCache.candles;
    } else {
      const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(CFG.symbol)}&interval=5min&outputsize=${CFG.m5OutputSize}&apikey=${API_KEY}`;
      const r = await fetch(url);
      const d = await r.json();
      if (!r.ok || d?.status === 'error' || !Array.isArray(d?.values)) {
        if (!candleCache.candles) return res.status(502).json({ok:false,error:d?.message||'Twelve Data candle API error'});
        m5 = candleCache.candles;
      } else {
        m5 = d.values.slice().reverse().map(c => ({
          time:c.datetime,
          open:Number(c.open), high:Number(c.high), low:Number(c.low), close:Number(c.close)
        })).filter(c => [c.open,c.high,c.low,c.close].every(Number.isFinite));
        if (m5.length < 100) return res.status(422).json({ok:false,error:'Candle M5 tidak mencukupi',count:m5.length});
        candleCache.candles = m5;
        candleCache.fetchedAt = Date.now();
      }
    }

    // ---------------------------------------------------------
    // LIVE PRICE — preserved from the existing project.
    // ---------------------------------------------------------
    let livePrice = m5.at(-1)?.close ?? null;
    let livePriceSource = 'M5_CANDLE_FALLBACK';
    let livePriceError = null;

    if (priceCache.price !== null && Date.now() - priceCache.fetchedAt < CFG.priceTTL) {
      livePrice = priceCache.price;
      livePriceSource = 'TWELVE_DATA_PRICE_CACHE';
    } else {
      try {
        const r = await fetch(`https://api.twelvedata.com/price?symbol=${encodeURIComponent(CFG.symbol)}&apikey=${API_KEY}`);
        const d = await r.json();
        const p = Number(d?.price);
        if (r.ok && d?.status !== 'error' && Number.isFinite(p)) {
          livePrice = p;
          livePriceSource = 'TWELVE_DATA_PRICE';
          priceCache.price = p;
          priceCache.fetchedAt = Date.now();
        } else {
          livePriceError = d?.message || 'Live price API error';
          if (priceCache.price !== null) {
            livePrice = priceCache.price;
            livePriceSource = 'TWELVE_DATA_PRICE_CACHE';
          }
        }
      } catch (e) {
        livePriceError = e?.message || 'Live price request failed';
        if (priceCache.price !== null) {
          livePrice = priceCache.price;
          livePriceSource = 'TWELVE_DATA_PRICE_CACHE';
        }
      }
    }

    // ---------------------------------------------------------
    // H1 AGGREGATION
    // ---------------------------------------------------------
    const h1 = aggregate(m5, 60);
    if (h1.length < 20) return res.status(422).json({ok:false,error:'H1 candle tidak mencukupi',count:h1.length});

    // Only use CLOSED H1 candles for structure. This prevents a live,
    // still-forming H1 candle from creating a false BOS/CHOCH.
    const closedH1 = h1.length > 1 ? h1.slice(0,-1) : h1;
    const pivots = findPivots(closedH1, CFG.pivotLeft, CFG.pivotRight);
    const swingHighs = pivots.filter(p=>p.type==='HIGH');
    const swingLows  = pivots.filter(p=>p.type==='LOW');

    const current = closedH1.at(-1);
    const structure = classifyStructure(swingHighs, swingLows);
    const event = detectStructureEvent(closedH1, swingHighs, swingLows, structure);

    // Nearest H1 S/R relative to LIVE price.
    const support = nearestBelow(swingLows.map(x=>x.price), livePrice);
    const resistance = nearestAbove(swingHighs.map(x=>x.price), livePrice);

    // BOS target logic requested:
    // bullish BOS -> nearest resistance above price
    // bearish BOS -> nearest support below price
    let breakTarget = null;
    if (event.type === 'BOS' && event.direction === 'BULLISH') breakTarget = resistance;
    if (event.type === 'BOS' && event.direction === 'BEARISH') breakTarget = support;

    return res.status(200).json({
      ok:true,
      version:'H1-STRUCTURE-SR-BOS-CHOCH-LIVEPRICE',
      symbol:CFG.symbol,
      livePrice,
      livePriceSource,
      livePriceAgeSeconds: priceCache.fetchedAt ? Math.round((Date.now()-priceCache.fetchedAt)/1000) : null,
      livePriceTTLSeconds: CFG.priceTTL/1000,
      livePriceError,
      h1:{
        candles:h1.length,
        closedCandles:closedH1.length,
        lastClosedTime:current?.time ?? null,
        structure,
        support,
        resistance,
        swings:{
          highs:swingHighs.slice(-12).map(x=>({price:x.price,time:x.time})),
          lows:swingLows.slice(-12).map(x=>({price:x.price,time:x.time}))
        },
        bos: event.type==='BOS' ? event : null,
        choch: event.type==='CHOCH' ? event : null,
        breakTarget
      },
      cache:{
        candleAgeSeconds:Math.round((Date.now()-candleCache.fetchedAt)/1000),
        candleTTLSeconds:CFG.candleTTL/1000,
        m5Candles:m5.length
      },
      timestamp:new Date().toISOString()
    });
  } catch (error) {
    console.error('H1 STRUCTURE ERROR', error);
    return res.status(500).json({ok:false,error:error?.message||'H1 structure engine error'});
  }
}

function aggregate(data, minutes) {
  const size = minutes * 60 * 1000;
  const buckets = new Map();
  for (const c of data) {
    const ts = new Date(c.time).getTime();
    if (!Number.isFinite(ts)) continue;
    const key = Math.floor(ts / size) * size;
    let b = buckets.get(key);
    if (!b) {
      b = {time:new Date(key).toISOString(),open:c.open,high:c.high,low:c.low,close:c.close};
      buckets.set(key,b);
    } else {
      b.high = Math.max(b.high,c.high);
      b.low = Math.min(b.low,c.low);
      b.close = c.close;
    }
  }
  return [...buckets.values()].sort((a,b)=>new Date(a.time)-new Date(b.time));
}

function findPivots(data,left=2,right=2) {
  const out=[];
  for (let i=left; i<data.length-right; i++) {
    const c=data[i];
    let high=true, low=true;
    for(let j=1;j<=left;j++) { high &&= c.high > data[i-j].high; low &&= c.low < data[i-j].low; }
    for(let j=1;j<=right;j++) { high &&= c.high >= data[i+j].high; low &&= c.low <= data[i+j].low; }
    if(high) out.push({type:'HIGH',price:c.high,time:c.time,index:i});
    if(low) out.push({type:'LOW',price:c.low,time:c.time,index:i});
  }
  return out.sort((a,b)=>a.index-b.index);
}

function classifyStructure(highs,lows) {
  const h=highs.slice(-3), l=lows.slice(-3);
  let highPattern='NONE', lowPattern='NONE';
  if(h.length>=2) highPattern = h.at(-1).price > h.at(-2).price ? 'HH' : h.at(-1).price < h.at(-2).price ? 'LH' : 'EQH';
  if(l.length>=2) lowPattern = l.at(-1).price > l.at(-2).price ? 'HL' : l.at(-1).price < l.at(-2).price ? 'LL' : 'EQL';
  let bias='NEUTRAL';
  if(highPattern==='HH' && lowPattern==='HL') bias='BULLISH';
  else if(highPattern==='LH' && lowPattern==='LL') bias='BEARISH';
  return {bias,highPattern,lowPattern,lastSwingHigh:h.at(-1)?.price??null,lastSwingLow:l.at(-1)?.price??null};
}

function detectStructureEvent(data, highs, lows, structure) {
  const last=data.at(-1);
  if(!last) return {type:'NONE',direction:'NONE',price:null,level:null,time:null,description:'No closed H1 candle'};

  const priorHigh=highs.at(-1);
  const priorLow=lows.at(-1);
  const bullishBreak=priorHigh && last.close > priorHigh.price;
  const bearishBreak=priorLow && last.close < priorLow.price;

  if(bullishBreak) {
    const type=structure.bias==='BEARISH' ? 'CHOCH' : 'BOS';
    return {type,direction:'BULLISH',price:last.close,level:priorHigh.price,time:last.time,description:type==='BOS'?'Bullish BOS — H1 swing high broken':'Bullish CHOCH — H1 bearish structure broken'};
  }
  if(bearishBreak) {
    const type=structure.bias==='BULLISH' ? 'CHOCH' : 'BOS';
    return {type,direction:'BEARISH',price:last.close,level:priorLow.price,time:last.time,description:type==='BOS'?'Bearish BOS — H1 swing low broken':'Bearish CHOCH — H1 bullish structure broken'};
  }
  return {type:'NONE',direction:'NONE',price:null,level:null,time:null,description:'No new H1 structure break on the last closed candle'};
}

function nearestBelow(levels,price) {
  if(!Number.isFinite(price)) return null;
  const a=levels.filter(Number.isFinite).filter(x=>x < price).sort((x,y)=>y-x);
  return a.length ? {price:a[0],distance:price-a[0]} : null;
}
function nearestAbove(levels,price) {
  if(!Number.isFinite(price)) return null;
  const a=levels.filter(Number.isFinite).filter(x=>x > price).sort((x,y)=>x-y);
  return a.length ? {price:a[0],distance:a[0]-price} : null;
}
