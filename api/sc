export const config = { runtime: "nodejs" };

const SYMBOL = "XAU/USD";
const TD = "https://api.twelvedata.com";
const CFG = {
  m5Output: 2500,
  cacheMs: 60000,
  priceCacheMs: 30000,
  h1Pivot: [3,3],
  m15Pivot: [2,2],
  m5Pivot: [2,2],
  atrPeriod: 14,
  mergeATR: 0.35,
  minProminenceATR: 0.35,
  prominenceWindow: 6,
  nearLevelATR: 0.45,
  equalLevelATR: 0.18,
  minSignalScore: 65,
  strongSignalScore: 80,
  minimumRR: 1.35,
  m5SL_ATR: 1.25,
  m15SL_ATR: 0.90,
  tp1R: 1,
  tp2R: 2,
  tp3R: 3,
  newsLookbackHours: 12,
  newsLimit: 20
};

const cache = globalThis.__XAUUSDSNIPER__ || (globalThis.__XAUUSDSNIPER__ = {
  candles: null, candlesAt: 0, price: null, priceAt: 0, news: null, newsAt: 0
});

function n(v, d=null) {
  const x = Number(v);
  return Number.isFinite(x) ? x : d;
}
function clamp(x,a,b){return Math.max(a,Math.min(b,x));}
function round(x,d=2){const p=10**d;return Math.round(x*p)/p;}
function arr(v){return Array.isArray(v)?v:[];}
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}

async function getJSON(url, ms=12000) {
  const c = new AbortController();
  const t = setTimeout(()=>c.abort(),ms);
  try {
    const r = await fetch(url,{signal:c.signal,headers:{"accept":"application/json"}});
    const text = await r.text();
    let j; try { j = JSON.parse(text); } catch { throw new Error("Invalid JSON"); }
    if(!r.ok || j?.status==="error") throw new Error(j?.message || `HTTP ${r.status}`);
    return j;
  } finally { clearTimeout(t); }
}

function normalizeCandle(x){
  return {
    time:x.datetime ?? x.time ?? x.timestamp,
    open:n(x.open), high:n(x.high), low:n(x.low), close:n(x.close),
    volume:n(x.volume,0)
  };
}
function validCandle(c){return c && [c.open,c.high,c.low,c.close].every(Number.isFinite);}
function timeMs(x){
  if(typeof x==="number") return x>1e12?x:x*1000;
  const s=String(x||"");
  const z=Date.parse(s.replace(" ","T")+"Z");
  return Number.isFinite(z)?z:NaN;
}
function sortCandles(a){return a.filter(validCandle).sort((x,y)=>timeMs(x.time)-timeMs(y.time));}

async function fetchM5(){
  const now=Date.now();
  if(cache.candles && now-cache.candlesAt<CFG.cacheMs) return cache.candles;
  const key=process.env.TWELVE_DATA_API_KEY;
  if(!key) throw new Error("TWELVE_DATA_API_KEY missing");
  const qs=new URLSearchParams({
    symbol:SYMBOL, interval:"5min", outputsize:String(CFG.m5Output),
    order:"ASC", timezone:"UTC", apikey:key
  });
  const j=await getJSON(`${TD}/time_series?${qs}`);
  const data=sortCandles(arr(j?.values).map(normalizeCandle));
  if(data.length<100) throw new Error("Not enough Twelve Data candles");
  cache.candles=data; cache.candlesAt=now; return data;
}
async function fetchPrice(){
  const now=Date.now();
  if(cache.price!=null && now-cache.priceAt<CFG.priceCacheMs) return cache.price;
  const key=process.env.TWELVE_DATA_API_KEY;
  if(!key) throw new Error("TWELVE_DATA_API_KEY missing");
  const qs=new URLSearchParams({symbol:SYMBOL,apikey:key});
  const j=await getJSON(`${TD}/price?${qs}`);
  const p=n(j?.price);
  if(!Number.isFinite(p)) throw new Error("Invalid live price");
  cache.price=p; cache.priceAt=now; return p;
}

function aggregate(candles, minutes){
  const out=[], bucketMs=minutes*60000;
  for(const c of candles){
    const t=timeMs(c.time); if(!Number.isFinite(t)) continue;
    const b=Math.floor(t/bucketMs)*bucketMs;
    let x=out[out.length-1];
    if(!x || x._b!==b){
      x={_b:b,time:new Date(b).toISOString(),open:c.open,high:c.high,low:c.low,close:c.close,volume:c.volume};
      out.push(x);
    } else {
      x.high=Math.max(x.high,c.high); x.low=Math.min(x.low,c.low); x.close=c.close; x.volume+=c.volume;
    }
  }
  return out.map(({_b,...x})=>x);
}
function closed(candles,minutes){
  if(candles.length<2)return candles;
  const bucket=minutes*60000;
  const last=timeMs(candles[candles.length-1].time);
  const current=Math.floor(last/bucket)*bucket;
  return candles.filter(c=>timeMs(c.time)<current);
}

function atr(candles,p=14){
  if(candles.length<2)return null;
  p=Math.min(p,candles.length-1);
  const tr=[];
  for(let i=1;i<candles.length;i++){
    const c=candles[i], prev=candles[i-1];
    tr.push(Math.max(c.high-c.low,Math.abs(c.high-prev.close),Math.abs(c.low-prev.close)));
  }
  const a=tr.slice(-p);
  return a.reduce((s,x)=>s+x,0)/a.length;
}
function ema(vals,p){
  if(!vals.length)return null;
  const k=2/(p+1); let e=vals[0];
  for(let i=1;i<vals.length;i++)e=vals[i]*k+e*(1-k);
  return e;
}
function pivots(candles,left,right){
  const highs=[],lows=[];
  for(let i=left;i<candles.length-right;i++){
    let hi=true,lo=true;
    for(let j=1;j<=left;j++){if(candles[i].high<=candles[i-j].high)hi=false;if(candles[i].low>=candles[i-j].low)lo=false;}
    for(let j=1;j<=right;j++){if(candles[i].high<=candles[i+j].high)hi=false;if(candles[i].low>=candles[i+j].low)lo=false;}
    if(hi)highs.push({index:i,time:candles[i].time,price:candles[i].high});
    if(lo)lows.push({index:i,time:candles[i].time,price:candles[i].low});
  }
  return {highs,lows};
}
function significantPivots(candles,pv,a){
  const p=pivots(candles,pv[0],pv[1]);
  const atrv=a||atr(candles,CFG.atrPeriod)||1;
  const out=(xs,type)=>{
    const keep=[];
    for(const x of xs){
      const before=candles.slice(Math.max(0,x.index-CFG.prominenceWindow),x.index);
      const after=candles.slice(x.index+1,Math.min(candles.length,x.index+1+CFG.prominenceWindow));
      const extreme=type==="high"
        ? Math.max(...before.map(z=>z.high),...after.map(z=>z.high),candles[x.index].low)
        : Math.min(...before.map(z=>z.low),...after.map(z=>z.low),candles[x.index].high);
      const prom=type==="high"
        ? x.price-Math.min(candles[x.index].low,extreme)
        : Math.max(candles[x.index].high,extreme)-x.price;
      if(prom>=atrv*CFG.minProminenceATR) keep.push({...x,prominence:prom});
    }
    return keep;
  };
  return {highs:out(p.highs,"high"),lows:out(p.lows,"low")};
}
function mergeLevels(levels, distance){
  const xs=[...levels].filter(x=>Number.isFinite(x)).sort((a,b)=>a-b);
  const out=[];
  for(const x of xs){
    const last=out[out.length-1];
    if(last && Math.abs(x-last.price)<=distance){
      last.price=(last.price*last.count+x)/(last.count+1);last.count++;
    } else out.push({price:x,count:1});
  }
  return out;
}
function structure(candles,pv,a){
  const sp=significantPivots(candles,pv,a);
  const hs=sp.highs.slice(-8),ls=sp.lows.slice(-8);
  let trend="NEUTRAL",event="NONE";
  const last=candles[candles.length-1]?.close;
  if(hs.length>=2&&ls.length>=2){
    const h1=hs[hs.length-2].price,h2=hs[hs.length-1].price;
    const l1=ls[ls.length-2].price,l2=ls[ls.length-1].price;
    if(h2>h1&&l2>l1)trend="BULLISH";
    else if(h2<h1&&l2<l1)trend="BEARISH";
  }
  const priorH=hs.length?hs[hs.length-1].price:null, priorL=ls.length?ls[ls.length-1].price:null;
  const av=a||atr(candles,CFG.atrPeriod)||1;
  if(priorH!=null && last>priorH+av*.05) event=trend==="BEARISH"?"CHOCH_BULL":"BOS_BULL";
  else if(priorL!=null && last<priorL-av*.05) event=trend==="BULLISH"?"CHOCH_BEAR":"BOS_BEAR";
  return {
    trend,event,pivots:{highs:hs,lows:ls},
    lastSwingHigh:hs.length?hs[hs.length-1].price:null,
    lastSwingLow:ls.length?ls[ls.length-1].price:null
  };
}
function structuralLevels(candles,s,a){
  const av=a||atr(candles,CFG.atrPeriod)||1;
  const hi=mergeLevels(s.pivots.highs.map(x=>x.price),av*CFG.mergeATR);
  const lo=mergeLevels(s.pivots.lows.map(x=>x.price),av*CFG.mergeATR);
  return {supports:lo.map(x=>x.price),resistances:hi.map(x=>x.price)};
}
function nearestBelow(xs,p){return xs.filter(x=>x<p).sort((a,b)=>b-a)[0]??null;}
function nearestAbove(xs,p){return xs.filter(x=>x>p).sort((a,b)=>a-b)[0]??null;}

function trendData(candles){
  const closes=candles.map(x=>x.close);
  const e20=ema(closes.slice(-100),20), e50=ema(closes.slice(-120),50);
  if(e20!=null&&e50!=null){
    if(e20>e50 && closes.at(-1)>=e20)return "BULLISH";
    if(e20<e50 && closes.at(-1)<=e20)return "BEARISH";
  }
  return "NEUTRAL";
}
function confirmation(candles,s,a){
  const c=candles[candles.length-1], av=a||atr(candles,14)||1;
  let score=0, reasons=[];
  if(s.trend==="BULLISH"){score+=30;reasons.push("higher-high/higher-low");}
  if(s.trend==="BEARISH"){score-=30;reasons.push("lower-high/lower-low");}
  if(c.close>c.open){score+=15;reasons.push("bullish candle");}
  if(c.close<c.open){score-=15;reasons.push("bearish candle");}
  if(c.close>ema(candles.slice(-60).map(x=>x.close),20)){score+=10;}else{score-=10;}
  if(Math.abs(c.close-c.open)>av*.45){score += c.close>c.open?10:-10; reasons.push("momentum");}
  return {bias:score>=20?"BULLISH":score<=-20?"BEARISH":"NEUTRAL",score:clamp(50+score,0,100),reasons};
}
function trigger(candles,s,a){
  const c=candles[candles.length-1], prev=candles[candles.length-2], av=a||atr(candles,14)||1;
  let dir="WAIT",score=0,reasons=[];
  if(c.close>c.open){score+=20;reasons.push("bullish close");}
  if(c.close<c.open){score-=20;reasons.push("bearish close");}
  if(c.close>prev.high){score+=30;reasons.push("break previous high");}
  if(c.close<prev.low){score-=30;reasons.push("break previous low");}
  if(s.trend==="BULLISH"){score+=20;reasons.push("M5 structure bullish");}
  if(s.trend==="BEARISH"){score-=20;reasons.push("M5 structure bearish");}
  if(Math.abs(c.close-c.open)>av*.5){score += c.close>c.open?15:-15;reasons.push("M5 momentum");}
  if(score>=45)dir="BUY"; else if(score<=-45)dir="SELL";
  return {direction:dir,score:clamp(50+score,0,100),reasons};
}

function liquidity(m5,m15,h1,price,a){
  const av=a||1, eqDist=av*CFG.equalLevelATR;
  const hi=[],lo=[];
  for(const c of m5.slice(-100)) {hi.push(c.high);lo.push(c.low);}
  const p15=pivots(m15,2,2), ph=pivots(h1,2,2);
  const equalHighs=[],equalLows=[];
  const addEq=(xs,out)=>{
    for(let i=1;i<xs.length;i++)for(let j=i-1;j>=0&&j>=i-8;j--){
      if(Math.abs(xs[i]-xs[j])<=eqDist){out.push(round((xs[i]+xs[j])/2,2));break;}
    }
  };
  addEq(hi,equalHighs);addEq(lo,equalLows);
  const buy=[...equalHighs,...ph.highs.slice(-4).map(x=>x.price),...p15.highs.slice(-4).map(x=>x.price)].filter(x=>x>price);
  const sell=[...equalLows,...ph.lows.slice(-4).map(x=>x.price),...p15.lows.slice(-4).map(x=>x.price)].filter(x=>x<price);
  return {
    buySide:mergeLevels(buy,eqDist).map(x=>round(x.price,2)),
    sellSide:mergeLevels(sell,eqDist).map(x=>round(x.price,2)),
    equalHighs:mergeLevels(equalHighs,eqDist).map(x=>round(x.price,2)),
    equalLows:mergeLevels(equalLows,eqDist).map(x=>round(x.price,2)),
    previousH1High:ph.highs.at(-1)?.price??null,
    previousH1Low:ph.lows.at(-1)?.price??null,
    nearestBuySide:nearestAbove(buy,price),
    nearestSellSide:nearestBelow(sell,price)
  };
}

async function newsFilter(){
  const now=Date.now();
  if(cache.news && now-cache.newsAt<10*60000)return cache.news;
  const key=process.env.TWELVE_DATA_API_KEY;
  if(!key)return {status:"UNKNOWN",reason:"API key unavailable",items:[]};
  try{
    const end=new Date(now).toISOString();
    const start=new Date(now-CFG.newsLookbackHours*3600000).toISOString();
    const q=new URLSearchParams({
      symbol:"XAU/USD",start_date:start,end_date:end,limit:String(CFG.newsLimit),apikey:key
    });
    const j=await getJSON(`${TD}/news?${q}`,10000);
    const items=arr(j?.data||j?.news||j?.values).slice(0,CFG.newsLimit);
    const result={status:items.length?"CHECK":"CLEAR",reason:items.length?"Recent market news found":"No news returned",items};
    cache.news=result;cache.newsAt=now;return result;
  }catch(e){
    return {status:"UNKNOWN",reason:"News endpoint unavailable",items:[]};
  }
}

function distanceWarning(dir,price,support,resistance,av){
  if(dir==="BUY"&&resistance!=null&&Math.abs(resistance-price)<=av*CFG.nearLevelATR)
    return {warning:true,type:"BUY_NEAR_H1_RESISTANCE",level:round(resistance,2)};
  if(dir==="SELL"&&support!=null&&Math.abs(price-support)<=av*CFG.nearLevelATR)
    return {warning:true,type:"SELL_NEAR_H1_SUPPORT",level:round(support,2)};
  return {warning:false,type:null,level:null};
}
function tradePlan(dir,price,m5,m15,h1,levels,av){
  if(dir==="WAIT")return {active:false,direction:"WAIT",entry:round(price,2),stopLoss:null,tp1:null,tp2:null,tp3:null,rr:null};
  let sl;
  if(dir==="BUY"){
    const candidates=[m5.lastSwingLow,m15.lastSwingLow,levels.supports.filter(x=>x<price).at(-1)].filter(Number.isFinite);
    sl=(candidates.length?Math.max(...candidates):price-av*CFG.m5SL_ATR)-av*.10;
    if(sl>=price)sl=price-av*CFG.m5SL_ATR;
  }else{
    const candidates=[m5.lastSwingHigh,m15.lastSwingHigh,levels.resistances.filter(x=>x>price)[0]].filter(Number.isFinite);
    sl=(candidates.length?Math.min(...candidates):price+av*CFG.m5SL_ATR)+av*.10;
    if(sl<=price)sl=price+av*CFG.m5SL_ATR;
  }
  const risk=Math.abs(price-sl);
  const tp1=dir==="BUY"?price+risk*CFG.tp1R:price-risk*CFG.tp1R;
  const tp2=dir==="BUY"?price+risk*CFG.tp2R:price-risk*CFG.tp2R;
  const tp3=dir==="BUY"?price+risk*CFG.tp3R:price-risk*CFG.tp3R;
  const target=dir==="BUY"?levels.resistances.filter(x=>x>price)[0]:levels.supports.filter(x=>x<price).at(-1);
  const rr=target?Math.abs(target-price)/risk:CFG.tp2R;
  return {active:true,direction:dir,entry:round(price,2),stopLoss:round(sl,2),tp1:round(tp1,2),tp2:round(tp2,2),tp3:round(tp3,2),structureTarget:target?round(target,2):null,rr:round(rr,2),validRR:rr>=CFG.minimumRR};
}
function confidence(h1,m15,m5,liq,warning,news){
  let score=50;
  if(m15.bias==="BULLISH")score+=12;else if(m15.bias==="BEARISH")score-=12;
  if(m5.direction==="BUY")score+=18;else if(m5.direction==="SELL")score-=18;
  if(h1.trend==="BULLISH")score+=6;else if(h1.trend==="BEARISH")score-=6;
  if(h1.event.startsWith("BOS"))score+=5;
  if(h1.event.startsWith("CHOCH"))score+=3;
  if(liq.nearestBuySide!=null||liq.nearestSellSide!=null)score+=3;
  if(warning.warning)score-=12;
  if(news.status==="CHECK")score-=5;
  const direction=score>=55?"BUY":score<=45?"SELL":"NEUTRAL";
  return {score:round(clamp(Math.max(score,100-score),0,100),0),bias:direction};
}
function signal(m15,m5){
  if(m15.bias==="BULLISH"&&m5.direction==="BUY")return "BUY";
  if(m15.bias==="BEARISH"&&m5.direction==="SELL")return "SELL";
  return "WAIT";
}

export default async function handler(req,res){
  res.setHeader("Cache-Control","no-store");
  res.setHeader("Access-Control-Allow-Origin","*");
  if(req.method==="OPTIONS"){res.status(204).end();return;}
  try{
    const key=process.env.TWELVE_DATA_API_KEY;
    if(!key)return res.status(500).json({ok:false,error:"TWELVE_DATA_API_KEY missing"});
    const raw=await fetchM5();
    const price=await fetchPrice();
    const m5=closed(raw,5);
    const m15=closed(aggregate(raw,15),15);
    const h1=closed(aggregate(raw,60),60);
    if(m5.length<25)throw new Error("Insufficient M5 candle data");
    // H1/M15 may legitimately have fewer candles because they are aggregated
    // locally from the M5 response. Do not fail the whole API for that.
    // Structure/ATR helpers gracefully fall back to NEUTRAL/null when history
    // is limited.

    const a5=atr(m5,CFG.atrPeriod)||0;
    const a15=atr(m15,CFG.atrPeriod)||a5;
    const a1=atr(h1,CFG.atrPeriod)||a15;
    const h1s=structure(h1,CFG.h1Pivot,a1);
    const m15s=structure(m15,CFG.m15Pivot,a15);
    const m5s=structure(m5,CFG.m5Pivot,a5);
    const h1levels=structuralLevels(h1,h1s,a1);
    const support=nearestBelow(h1levels.supports,price);
    const resistance=nearestAbove(h1levels.resistances,price);
    const m15c=confirmation(m15,m15s,a15);
    const m5t=trigger(m5,m5s,a5);
    const liq=liquidity(m5,m15,h1,price,a1);
    const news=await newsFilter();
    const dir=signal(m15c,m5t);
    const warning=distanceWarning(dir,price,support,resistance,a1);
    const plan=tradePlan(dir,price,m5s,m15s,h1s,h1levels,a5);
    const conf=confidence(h1s,m15c,m5t,liq,warning,news);

    const hold = h1s.trend==="BULLISH"&&dir==="BUY" ? "HOLD_BUY" :
      h1s.trend==="BEARISH"&&dir==="SELL" ? "HOLD_SELL" :
      dir==="WAIT" ? "WAIT" : "SCALP_ONLY";
    const signalStrength=dir==="WAIT"?"WAIT":(
      m15c.score>=75&&m5t.score>=75&&plan.validRR&&!warning.warning?"STRONG":"NORMAL"
    );

    return res.status(200).json({
      ok:true,
      symbol:SYMBOL,
      source:"Twelve Data REST",
      timestamp:Date.now(),
      price:round(price,3),
      livePrice:{price:round(price,3),source:"Twelve Data REST"},
      signal:dir,
      signalStrength,
      confidence:conf.score,
      bias:conf.bias,
      h1:{
        direction:h1s.trend,
        trend:h1s.trend,
        structure:h1s.trend,
        event:h1s.event,
        bos:h1s.event.startsWith("BOS")?h1s.event:null,
        choch:h1s.event.startsWith("CHOCH")?h1s.event:null,
        support:support?round(support,2):null,
        resistance:resistance?round(resistance,2):null,
        structuralSupport:support?round(support,2):null,
        structuralResistance:resistance?round(resistance,2):null,
        atr:round(a1,3),
        lastSwingHigh:h1s.lastSwingHigh?round(h1s.lastSwingHigh,2):null,
        lastSwingLow:h1s.lastSwingLow?round(h1s.lastSwingLow,2):null
      },
      m15:{
        direction:m15c.bias,
        confirmation:m15c.bias,
        score:round(m15c.score,0),
        structure:m15s.trend,
        event:m15s.event,
        reasons:m15c.reasons,
        atr:round(a15,3)
      },
      m5:{
        direction:m5t.direction,
        trigger:m5t.direction,
        score:round(m5t.score,0),
        structure:m5s.trend,
        event:m5s.event,
        reasons:m5t.reasons,
        atr:round(a5,3)
      },
      tradePlan:plan,
      entryQuality:{
        score:round((m15c.score+m5t.score)/2,0),
        label:dir==="WAIT"?"WAIT":(m15c.score>=75&&m5t.score>=75?"HIGH":m15c.score>=60&&m5t.score>=60?"GOOD":"LOW"),
        m15Aligned:(dir==="BUY"&&m15c.bias==="BULLISH")||(dir==="SELL"&&m15c.bias==="BEARISH"),
        m5Triggered:(dir==="BUY"&&m5t.direction==="BUY")||(dir==="SELL"&&m5t.direction==="SELL"),
        warning
      },
      liquidity:liq,
      newsFilter:news,
      holdContext:{
        status:hold,
        h1Agrees:(dir==="BUY"&&h1s.trend==="BULLISH")||(dir==="SELL"&&h1s.trend==="BEARISH"),
        note:h1s.trend==="NEUTRAL"?"H1 neutral context":hold==="SCALP_ONLY"?"H1 disagrees with scalp direction; scalp is still valid":"H1 supports scalp direction"
      },
      rules:{
        scalpRequiresM15M5Alignment:true,
        h1IsContextNotHardVeto:true,
        structuralSROnly:true
      },
      candles:{
        m5Count:m5.length,m15Count:m15.length,h1Count:h1.length,
        lastM5:m5.at(-1)?.time,lastM15:m15.at(-1)?.time,lastH1:h1.at(-1)?.time
      }
    });
  }catch(e){
    return res.status(500).json({
      ok:false,error:e?.message||"Unknown API error",
      hint:"Check TWELVE_DATA_API_KEY and Twelve Data quota."
    });
  }
}
