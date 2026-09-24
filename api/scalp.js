export const config = { api: { bodyParser: false } };

const CACHE_KEY = "__XAU_SWING_ENGINE_V1__";

export default async function handler(req, res) {
  const key = process.env.TWELVE_DATA_API_KEY;
  if (!key) return json(res, 500, { ok:false, error:"TWELVE_DATA_API_KEY belum diset" });

  const cfg = {
    symbol: "XAU/USD",
    timezone: "UTC",
    m5OutputSize: 2500,
    candleTTL: 55000,
    priceTTL: 15000,
    pivotLeft: 3,
    pivotRight: 3,
    atrPeriod: 14,
    breakoutATRMin: 0.12,
    breakoutBodyATRMin: 0.35,
    strongBodyRatio: 0.60,
    minScore: 65,
    strongScore: 80,
    slATR: 0.45,
    targetLookback: 120,
    minRR: 1.5
  };

  globalThis[CACHE_KEY] ??= { candles:null, candlesAt:0, price:null, priceAt:0 };
  const cache = globalThis[CACHE_KEY];

  try {
    const m5 = await getM5(key, cfg, cache);
    const price = await getPrice(key, cfg, cache, m5);
    const h1 = closedTF(aggregate(m5, 60));

    if (h1.length < 80) throw new Error("H1 candle tidak mencukupi untuk swing engine");

    const a = atr(h1, cfg.atrPeriod);
    const p = pivots(h1, cfg.pivotLeft, cfg.pivotRight);
    const s = structure(h1, p);
    const ema20 = ema(h1.map(x=>x.close),20);
    const ema50 = ema(h1.map(x=>x.close),50);
    const ema200 = ema(h1.map(x=>x.close),200);
    const rsi14 = rsi(h1,14);

    const breakout = detectH1Breakout(h1, p, a, cfg);
    const setup = buildSwingSetup(h1, p, breakout, {
      atr:a, ema20, ema50, ema200, rsi:rsi14
    }, cfg);

    const session = getSession();
    const risk = buildRiskFilter(session);
    const signal = risk.blockSignal ? "WAIT" : setup.signal;
    const confidence = risk.blockSignal ? 0 : setup.score;

    return json(res, 200, {
      ok:true,
      version:"XAU-SWING-BREAKOUT-V1",
      symbol:cfg.symbol,
      timestamp:Date.now(),
      livePrice:price,
      signal,
      confidence,
      signalStrength: setup.strength,
      bias: setup.bias,
      timeframe:"H1",
      breakout,
      setup: signal==="WAIT" && !breakout.active ? {...setup, signal:"WAIT"} : setup,
      h1:{
        last:h1.at(-1).close,
        time:h1.at(-1).time,
        atr:a,
        ema20, ema50, ema200,
        rsi:rsi14,
        structure:s
      },
      session,
      riskFilter:risk,
      engine:{
        type:"H1 SWING ONLY",
        entryRule:"Confirmed H1 close beyond a confirmed H1 swing level",
        retestRequired:false,
        lowerTimeframes:false
      },
      data:{h1:h1.length,m5:m5.length}
    });
  } catch(e) {
    return json(res, 500, { ok:false, error:e?.message || "Swing engine error" });
  }
}

function json(res,status,data){
  res.setHeader("Cache-Control","no-store, max-age=0");
  res.setHeader("Content-Type","application/json; charset=utf-8");
  return res.status(status).json(data);
}

async function getM5(key,cfg,cache){
  const now=Date.now();
  if(cache.candles && now-cache.candlesAt<cfg.candleTTL) return cache.candles;

  const u=`https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(cfg.symbol)}&interval=5min&outputsize=${cfg.m5OutputSize}&timezone=UTC&apikey=${encodeURIComponent(key)}`;
  const r=await fetch(u);
  const d=await r.json().catch(()=>({}));

  if(!r.ok || d?.status==="error" || !Array.isArray(d?.values)){
    if(cache.candles) return cache.candles;
    throw new Error(d?.message || "Twelve Data candle API error");
  }

  const out=d.values.slice().reverse().map(c=>({
    time:String(c.datetime),
    open:+c.open, high:+c.high, low:+c.low, close:+c.close
  })).filter(c=>[c.open,c.high,c.low,c.close].every(Number.isFinite));

  if(out.length<100) throw new Error("M5 candle tidak mencukupi");
  cache.candles=out;
  cache.candlesAt=now;
  return out;
}

async function getPrice(key,cfg,cache,m5){
  const now=Date.now();
  if(Number.isFinite(cache.price) && now-cache.priceAt<cfg.priceTTL) return cache.price;
  try{
    const r=await fetch(`https://api.twelvedata.com/price?symbol=${encodeURIComponent(cfg.symbol)}&apikey=${encodeURIComponent(key)}`);
    const d=await r.json().catch(()=>({}));
    const p=+d?.price;
    if(r.ok && d?.status!=="error" && Number.isFinite(p)){
      cache.price=p; cache.priceAt=now; return p;
    }
  }catch{}
  if(Number.isFinite(cache.price)) return cache.price;
  return m5.at(-1).close;
}

function aggregate(cs,min){
  const out=[];
  for(const c of cs){
    const ms=parseUTC(c.time);
    if(!Number.isFinite(ms)) continue;
    const bucket=Math.floor(ms/(min*60000))*min*60000;
    let x=out.at(-1);
    if(!x || x.bucket!==bucket){
      x={bucket,time:formatUTC(bucket),open:c.open,high:c.high,low:c.low,close:c.close};
      out.push(x);
    } else {
      x.high=Math.max(x.high,c.high);
      x.low=Math.min(x.low,c.low);
      x.close=c.close;
    }
  }
  return out.map(({bucket,...c})=>c);
}

function parseUTC(s){
  const t=String(s).replace(" ","T");
  return Date.parse(/Z$/.test(t)?t:`${t}Z`);
}

function formatUTC(ms){
  return new Date(ms).toISOString().slice(0,16).replace("T"," ");
}

function closedTF(cs){
  return cs.length>1 ? cs.slice(0,-1) : cs;
}

function atr(cs,n=14){
  if(cs.length<n+1) return null;
  const trs=[];
  for(let i=1;i<cs.length;i++){
    trs.push(Math.max(
      cs[i].high-cs[i].low,
      Math.abs(cs[i].high-cs[i-1].close),
      Math.abs(cs[i].low-cs[i-1].close)
    ));
  }
  const last=trs.slice(-n);
  return last.reduce((a,b)=>a+b,0)/last.length;
}

function ema(values,n){
  if(values.length<n) return null;
  let e=values.slice(0,n).reduce((a,b)=>a+b,0)/n;
  const k=2/(n+1);
  for(let i=n;i<values.length;i++) e=values[i]*k+e*(1-k);
  return e;
}

function rsi(cs,n=14){
  if(cs.length<n+1) return null;
  let gain=0,loss=0;
  for(let i=1;i<=n;i++){
    const d=cs[i].close-cs[i-1].close;
    if(d>=0) gain+=d; else loss-=d;
  }
  gain/=n; loss/=n;
  for(let i=n+1;i<cs.length;i++){
    const d=cs[i].close-cs[i-1].close;
    gain=((gain*(n-1))+(d>0?d:0))/n;
    loss=((loss*(n-1))+(d<0?-d:0))/n;
  }
  if(loss===0) return 100;
  return 100-(100/(1+gain/loss));
}

function pivots(cs,l=3,r=3){
  const hi=[],lo=[];
  for(let i=l;i<cs.length-r;i++){
    let H=true,L=true;
    for(let j=i-l;j<=i+r;j++){
      if(j===i) continue;
      if(cs[j].high>=cs[i].high) H=false;
      if(cs[j].low<=cs[i].low) L=false;
    }
    if(H) hi.push({i,price:cs[i].high,time:cs[i].time});
    if(L) lo.push({i,price:cs[i].low,time:cs[i].time});
  }
  return {hi,lo};
}

function structure(cs,p){
  const highs=p.hi.slice(-8), lows=p.lo.slice(-8);
  const ph=highs.at(-2), lh=highs.at(-1);
  const pl=lows.at(-2), ll=lows.at(-1);
  const hh=!!(lh&&ph&&lh.price>ph.price);
  const lh2=!!(lh&&ph&&lh.price<ph.price);
  const hl=!!(ll&&pl&&ll.price>pl.price);
  const ll2=!!(ll&&pl&&ll.price<pl.price);
  const bias=hh&&hl?"BULLISH":lh2&&ll2?"BEARISH":"NEUTRAL";
  return {
    bias,
    swingHigh:lh||null,
    swingLow:ll||null,
    priorHighPattern:hh?"HH":lh2?"LH":"—",
    priorLowPattern:hl?"HL":ll2?"LL":"—",
    highs,lows
  };
}

/*
  Swing trigger:
  - Use only CONFIRMED H1 pivots.
  - The latest CLOSED H1 candle must close beyond the latest confirmed
    swing high/low that existed BEFORE that candle.
  - Wick-only breaks do not trigger.
  - No retest is required.
*/
function detectH1Breakout(cs,p,a,cfg){
  const last=cs.at(-1);
  if(!last || !a) return inactiveBreakout();

  const pivotHighs=p.hi.filter(x=>x.i<cs.length-1);
  const pivotLows=p.lo.filter(x=>x.i<cs.length-1);
  const ph=pivotHighs.at(-1);
  const pl=pivotLows.at(-1);

  const up=!!ph && last.close>ph.price;
  const dn=!!pl && last.close<pl.price;

  let direction=null, level=null, pivot=null;
  if(up && !dn){direction="BUY";level=ph.price;pivot=ph;}
  else if(dn && !up){direction="SELL";level=pl.price;pivot=pl;}
  else if(up && dn){
    const du=last.close-ph.price, dd=pl.price-last.close;
    if(du>=dd){direction="BUY";level=ph.price;pivot=ph;}
    else {direction="SELL";level=pl.price;pivot=pl;}
  }

  if(!direction) return {
    active:false, direction:"WAIT", level:null, pivot:null,
    candle:packCandle(last), distance:null, breakoutATR:null,
    bodyATR:null, bodyRatio:null, closeLocation:null,
    fresh:false
  };

  const range=Math.max(last.high-last.low,0);
  const body=Math.abs(last.close-last.open);
  const distance=Math.abs(last.close-level);
  const bodyATR=body/a;
  const breakoutATR=distance/a;
  const bodyRatio=range>0?body/range:0;
  const closeLocation=range>0
    ? direction==="BUY"?(last.close-last.low)/range:(last.high-last.close)/range
    : 0;

  const priorClose=cs.length>1?cs.at(-2).close:null;
  const alreadyBeyond=direction==="BUY"
    ? Number.isFinite(priorClose)&&priorClose>level
    : Number.isFinite(priorClose)&&priorClose<level;

  const fresh=!alreadyBeyond;

  return {
    active:fresh,
    direction:fresh?direction:"WAIT",
    level:+level.toFixed(5),
    pivot,
    candle:packCandle(last),
    distance:+distance.toFixed(5),
    breakoutATR:+breakoutATR.toFixed(3),
    bodyATR:+bodyATR.toFixed(3),
    bodyRatio:+bodyRatio.toFixed(3),
    closeLocation:+closeLocation.toFixed(3),
    fresh,
    alreadyActive:!fresh
  };
}

function buildSwingSetup(cs,p,breakout,ind,cfg){
  const last=cs.at(-1);
  const a=ind.atr||1;
  const trend20=last.close>ind.ema20?"BULLISH":"BEARISH";
  const trend50=last.close>ind.ema50?"BULLISH":"BEARISH";
  const trend200=ind.ema200 ? (last.close>ind.ema200?"BULLISH":"BEARISH") : "UNKNOWN";

  if(!breakout.active){
    const bias=trend20===trend50?trend20:"NEUTRAL";
    return {
      signal:"WAIT",
      bias,
      score:0,
      strength:"WAIT",
      entry:null,stopLoss:null,tp1:null,tp2:null,tp3:null,rr:null,
      target:null,targetType:null,
      invalidation:"Wait for a NEW confirmed H1 close beyond a confirmed H1 swing.",
      reasons:[
        "No new H1 breakout on the latest closed candle.",
        "Wick-only movement does not trigger a swing signal.",
        "Retest is not required; the next valid trigger is the breakout close."
      ],
      checks:{
        h1Breakout:false,
        breakoutBody:false,
        breakoutDistance:false,
        closeStrength:false,
        ema20Alignment:false,
        ema50Alignment:false,
        ema200Alignment:false,
        rsiConfirmation:false,
        roomToTarget:false
      }
    };
  }

  const dir=breakout.direction;
  const bullish=dir==="BUY";
  const checks={
    h1Breakout:true,
    breakoutBody:breakout.bodyATR>=cfg.breakoutBodyATRMin,
    breakoutDistance:breakout.breakoutATR>=cfg.breakoutATRMin,
    closeStrength:breakout.bodyRatio>=cfg.strongBodyRatio &&
      (bullish?breakout.closeLocation>=0.70:breakout.closeLocation>=0.70),
    ema20Alignment:bullish?last.close>ind.ema20:last.close<ind.ema20,
    ema50Alignment:bullish?last.close>ind.ema50:last.close<ind.ema50,
    ema200Alignment:ind.ema200 ? (bullish?last.close>ind.ema200:last.close<ind.ema200) : false,
    rsiConfirmation:bullish?ind.rsi>=52:ind.rsi<=48
  };

  const targetInfo=findSwingTarget(cs,p,dir,last.close,cfg);
  checks.roomToTarget=!!targetInfo.target && (
    bullish
      ? targetInfo.target>last.close+a*cfg.minRR
      : targetInfo.target<last.close-a*cfg.minRR
  );

  let score=0;
  if(checks.h1Breakout) score+=25;
  if(checks.breakoutBody) score+=12;
  if(checks.breakoutDistance) score+=10;
  if(checks.closeStrength) score+=12;
  if(checks.ema20Alignment) score+=8;
  if(checks.ema50Alignment) score+=8;
  if(checks.ema200Alignment) score+=7;
  if(checks.rsiConfirmation) score+=6;
  if(checks.roomToTarget) score+=12;
  score=Math.min(100,score);

  const entry=last.close;
  const slBase=bullish
    ? Math.min(breakout.level,last.low)
    : Math.max(breakout.level,last.high);
  const stopLoss=bullish
    ? slBase-a*cfg.slATR
    : slBase+a*cfg.slATR;
  const risk=Math.abs(entry-stopLoss);

  const fallback1=bullish?entry+risk*1.5:entry-risk*1.5;
  const target=targetInfo.target && (
    bullish?targetInfo.target>entry:targetInfo.target<entry
  ) ? targetInfo.target : null;

  const tp1=target
    ? (bullish?Math.min(entry+risk,target):Math.max(entry-risk,target))
    : (bullish?entry+risk:entry-risk);
  const tp2=target
    ? (bullish?Math.min(entry+risk*2,target):Math.max(entry-risk*2,target))
    : (bullish?entry+risk*2:entry-risk*2);
  const tp3=target
    ? (bullish?Math.min(entry+risk*3,target):Math.max(entry-risk*3,target))
    : (bullish?entry+risk*3:entry-risk*3);

  const rr=Math.abs(tp3-entry)/risk;
  const validRR=Number.isFinite(rr) && rr>=cfg.minRR;

  const signal=score>=cfg.minScore && validRR ? dir : "WAIT";
  const strength=score>=cfg.strongScore?"A+":score>=cfg.minScore?"A":score>=50?"B":"C";

  const reasons=[
    `H1 ${dir} breakout above/below ${fmt(breakout.level)}`,
    checks.breakoutBody?"Breakout candle body has enough displacement":"Breakout candle body is weak",
    checks.breakoutDistance?"Close has cleared the swing by enough distance":"Close is too close to the broken swing",
    checks.closeStrength?"Strong breakout close":"Breakout close is not dominant",
    checks.ema20Alignment?"EMA20 aligned":"EMA20 not aligned",
    checks.ema50Alignment?"EMA50 aligned":"EMA50 not aligned",
    checks.ema200Alignment?"EMA200 aligned":"EMA200 not aligned",
    checks.rsiConfirmation?"RSI confirms direction":"RSI is neutral/misaligned",
    checks.roomToTarget?"There is usable room to the next H1 swing target":"Target room is limited"
  ];

  return {
    signal,
    bias:dir,
    score,
    strength,
    entry:+entry.toFixed(5),
    stopLoss:+stopLoss.toFixed(5),
    tp1:+tp1.toFixed(5),
    tp2:+tp2.toFixed(5),
    tp3:+tp3.toFixed(5),
    rr:+rr.toFixed(2),
    target:target?+target.toFixed(5):null,
    targetType:targetInfo.type||null,
    risk:+risk.toFixed(5),
    invalidation:bullish
      ? `H1 close back below ${fmt(breakout.level)} / stop ${fmt(stopLoss)}`
      : `H1 close back above ${fmt(breakout.level)} / stop ${fmt(stopLoss)}`,
    reasons,
    checks,
    breakoutEventId:`H1-${dir}-${breakout.candle.time}-${breakout.level}`,
    fallbackTarget:fallback1
  };
}

function findSwingTarget(cs,p,dir,entry,cfg){
  const candidates=dir==="BUY"
    ? p.hi.filter(x=>x.price>entry).slice().reverse()
    : p.lo.filter(x=>x.price<entry).slice().reverse();

  const target=candidates.find(x=>x.i<cs.length-1);
  if(target) return {target:target.price,type:"Next confirmed H1 swing"};

  const look=cs.slice(-cfg.targetLookback);
  if(!look.length) return {target:null,type:null};
  if(dir==="BUY"){
    const max=Math.max(...look.map(x=>x.high));
    return max>entry?{target:max,type:"H1 lookback high"}:{target:null,type:null};
  }
  const min=Math.min(...look.map(x=>x.low));
  return min<entry?{target:min,type:"H1 lookback low"}:{target:null,type:null};
}

function packCandle(c){
  return {
    time:c.time,
    open:c.open,
    high:c.high,
    low:c.low,
    close:c.close
  };
}

function getSession(){
  const now=new Date();
  const h=now.getUTCHours()+now.getUTCMinutes()/60;
  let name="ASIA";
  if(h>=7&&h<12) name="LONDON";
  else if(h>=12&&h<17) name="LONDON_NY_OVERLAP";
  else if(h>=17&&h<22) name="NEW_YORK";
  else if(h>=22||h<1) name="NY_LATE";
  const weekend=now.getUTCDay()===0||now.getUTCDay()===6;
  return {name,utcHour:+h.toFixed(2),weekend,active:!weekend};
}

function buildRiskFilter(session){
  if(session.weekend){
    return {
      blockSignal:true,
      state:"WEEKEND",
      reason:"Weekend / market likely closed",
      available:false,
      events:[]
    };
  }
  return {
    blockSignal:false,
    state:"SESSION_MONITOR",
    reason:`Session: ${session.name}`,
    available:false,
    events:[]
  };
}

function inactiveBreakout(){
  return {
    active:false,
    direction:"WAIT",
    level:null,
    pivot:null,
    candle:null,
    distance:null,
    breakoutATR:null,
    bodyATR:null,
    bodyRatio:null,
    closeLocation:null,
    fresh:false
  };
}

function fmt(v){
  return Number.isFinite(v)?v.toFixed(2):"—";
}
