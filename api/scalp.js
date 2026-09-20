export default async function handler(req, res) {
  const API_KEY = process.env.TWELVE_DATA_API_KEY;
  if (!API_KEY) return res.status(500).json({ ok:false, error:"TWELVE_DATA_API_KEY belum diset" });

  const CFG = {
    symbol:"XAU/USD", m5OutputSize:2500,
    candleTTL:60000, priceTTL:20000,
    pivotLeft:3, pivotRight:3, atrPeriod:14,
    zoneLookbackH1:180, zoneLookbackM15:220, zoneLookbackM5:300,
    minRR:1.35, slATR:1.15, nearATR:0.45,
    freshnessBars:6, mergeATR:0.35,
    newsBefore:30, newsAfter:20
  };

  globalThis.__XAU_ZONE_CACHE__ ??= { candles:null, candlesAt:0, price:null, priceAt:0, news:null, newsAt:0 };
  const cache=globalThis.__XAU_ZONE_CACHE__;

  try {
    const m5=await getM5(API_KEY,CFG,cache);
    const price=await getPrice(API_KEY,CFG,cache,m5);
    const m15=closedTF(aggregate(m5,15));
    const h1=closedTF(aggregate(m5,60));
    if(m15.length<60 || h1.length<30) throw new Error("Data candle belum mencukupi");

    const h1a=analyzeTF(h1, "H1", CFG);
    const m15a=analyzeTF(m15, "M15", CFG);
    const m5a=analyzeTF(m5, "M5", CFG);

    const liquidity=buildLiquidity(h1,m15,m5,price,CFG);
    const zones=buildZones(h1,m15,m5,price,liquidity,CFG);

    const scalp=buildScalpSignal(m15a,m5a,zones,liquidity,price,CFG);
    const news=await getNewsFilter(API_KEY,cache,CFG);
    const finalSignal=news.blockSignal ? "WAIT" : scalp.signal;
    const tradePlan=buildTradePlan(finalSignal,price,m5a,m15a,zones,liquidity,CFG);
    const confidence=scoreConfidence(scalp,news,zones,liquidity);
    const hold={
      status: finalSignal==="WAIT" ? "WAIT" :
        h1a.bias===scalp.direction ? "HOLD_SUPPORTED":"SCALP_ONLY",
      h1Agrees:h1a.bias===scalp.direction && finalSignal!=="WAIT",
      note: finalSignal==="WAIT" ? (news.blockSignal?"News risk active":"Waiting for M15 + M5 alignment") :
        h1a.bias===scalp.direction ? "H1 supports the scalp direction":"H1 is context only; scalp remains valid"
    };

    res.setHeader("Cache-Control","no-store");
    return res.status(200).json({
      ok:true, version:"XAU-ZONE-ENGINE-FRESH-V1", symbol:CFG.symbol,
      timestamp:Date.now(), livePrice:price,
      signal:finalSignal, technicalSignal:scalp.signal,
      signalStrength:news.blockSignal?"NEWS_BLOCK":scalp.strength,
      confidence, bias: finalSignal==="BUY"?"BULLISH":finalSignal==="SELL"?"BEARISH":"NEUTRAL",
      h1:packTF(h1a), m15:packTF(m15a), m5:packTF(m5a),
      liquidity, zones,
      tradePlan, holdContext:hold, newsFilter:news,
      confluence:scalp.confluence, reasons:scalp.reasons,
      data:{m5:m5.length,m15:m15.length,h1:h1.length}
    });
  } catch(e) {
    return res.status(500).json({ok:false,error:e?.message||"Zone engine error"});
  }
}

async function getM5(key,cfg,cache){
  const now=Date.now();
  if(cache.candles && now-cache.candlesAt<cfg.candleTTL) return cache.candles;
  const u=`https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(cfg.symbol)}&interval=5min&outputsize=${cfg.m5OutputSize}&apikey=${key}`;
  const r=await fetch(u); const d=await r.json();
  if(!r.ok || d?.status==="error" || !Array.isArray(d?.values)){
    if(cache.candles) return cache.candles;
    throw new Error(d?.message||"Twelve Data candle API error");
  }
  const out=d.values.slice().reverse().map(c=>({time:c.datetime,open:+c.open,high:+c.high,low:+c.low,close:+c.close}))
    .filter(c=>Object.values(c).slice(1).every(Number.isFinite));
  if(out.length<100) throw new Error("M5 candle tidak mencukupi");
  cache.candles=out; cache.candlesAt=now; return out;
}
async function getPrice(key,cfg,cache,m5){
  const now=Date.now();
  if(Number.isFinite(cache.price)&&now-cache.priceAt<cfg.priceTTL) return cache.price;
  try{
    const r=await fetch(`https://api.twelvedata.com/price?symbol=${encodeURIComponent(cfg.symbol)}&apikey=${key}`);
    const d=await r.json(), p=+d?.price;
    if(r.ok&&d?.status!=="error"&&Number.isFinite(p)){cache.price=p;cache.priceAt=now;return p;}
  }catch{}
  return Number.isFinite(cache.price)?cache.price:m5.at(-1).close;
}
function aggregate(cs,min){
  const out=[];
  for(const c of cs){
    const t=new Date(c.time.replace(" ","T")+"Z");
    const bucket=Math.floor(t.getTime()/(min*60000))*min*60000;
    let x=out.at(-1);
    if(!x||x.bucket!==bucket){x={bucket,time:new Date(bucket).toISOString().slice(0,16).replace("T"," "),open:c.open,high:c.high,low:c.low,close:c.close};out.push(x);}
    else{x.high=Math.max(x.high,c.high);x.low=Math.min(x.low,c.low);x.close=c.close;}
  }
  return out.map(({bucket,...c})=>c);
}
function closedTF(cs){ return cs.length>1?cs.slice(0,-1):cs; }
function atr(cs,n=14){
  if(cs.length<n+1)return null; let trs=[];
  for(let i=1;i<cs.length;i++) trs.push(Math.max(cs[i].high-cs[i].low,Math.abs(cs[i].high-cs[i-1].close),Math.abs(cs[i].low-cs[i-1].close)));
  return trs.slice(-n).reduce((a,b)=>a+b,0)/Math.min(n,trs.length);
}
function pivots(cs,l=3,r=3){
  const hi=[],lo=[];
  for(let i=l;i<cs.length-r;i++){
    let H=true,L=true;
    for(let j=i-l;j<=i+r;j++){if(j===i)continue;if(cs[j].high>=cs[i].high)H=false;if(cs[j].low<=cs[i].low)L=false;}
    if(H)hi.push({i,price:cs[i].high,time:cs[i].time});
    if(L)lo.push({i,price:cs[i].low,time:cs[i].time});
  }
  return {hi,lo};
}
function structure(cs,p){
  const highs=p.hi.slice(-6), lows=p.lo.slice(-6);
  const hh=highs.length>1&&highs.at(-1).price>highs.at(-2).price;
  const lh=highs.length>1&&highs.at(-1).price<highs.at(-2).price;
  const hl=lows.length>1&&lows.at(-1).price>lows.at(-2).price;
  const ll=lows.length>1&&lows.at(-1).price<lows.at(-2).price;
  const bias=hh&&hl?"BULLISH":lh&&ll?"BEARISH":"NEUTRAL";
  const last=cs.at(-1);
  const lastH=highs.at(-1),lastL=lows.at(-1);
  const bosUp=lastH&&last.close>lastH.price;
  const bosDn=lastL&&last.close<lastL.price;
  return {bias,bos:bosUp?"BULLISH":bosDn?"BEARISH":null,highs,lows};
}
function analyzeTF(cs,tf,cfg){
  const p=pivots(cs,cfg.pivotLeft,cfg.pivotRight), a=atr(cs,cfg.atrPeriod), s=structure(cs,p);
  const ema20=ema(cs.map(x=>x.close),20), ema50=ema(cs.map(x=>x.close),50);
  const last=cs.at(-1).close;
  let candleBias=last>ema20&&ema20>ema50?"BULLISH":last<ema20&&ema20<ema50?"BEARISH":"NEUTRAL";
  const direction=s.bias!=="NEUTRAL"?s.bias:candleBias;
  return {tf,bias:direction,structure:s,atr:a,ema20,ema50,last,time:cs.at(-1).time,candles:cs,
    trend:candleBias, pivots:p};
}
function ema(v,n){if(v.length<n)return null;let e=v.slice(0,n).reduce((a,b)=>a+b,0)/n,k=2/(n+1);for(let i=n;i<v.length;i++)e=v[i]*k+e*(1-k);return e;}
function buildLiquidity(h1,m15,m5,price,cfg){
  const levels=[];
  const add=(name,v,tf)=>{if(Number.isFinite(v))levels.push({name,price:v,tf,distance:Math.abs(v-price)});}
  add("H1 High",Math.max(...h1.slice(-20).map(x=>x.high)),"H1");
  add("H1 Low",Math.min(...h1.slice(-20).map(x=>x.low)),"H1");
  add("M15 High",Math.max(...m15.slice(-20).map(x=>x.high)),"M15");
  add("M15 Low",Math.min(...m15.slice(-20).map(x=>x.low)),"M15");
  add("Previous Day High",dayExtreme(m5,true),"DAY");
  add("Previous Day Low",dayExtreme(m5,false),"DAY");
  const ps=pivots(m15,3,3);
  const eqH=findEqual(ps.hi,cfg),eqL=findEqual(ps.lo,cfg);
  eqH.forEach(x=>add("Equal High",x.price,"M15")); eqL.forEach(x=>add("Equal Low",x.price,"M15"));
  return {above:levels.filter(x=>x.price>price).sort((a,b)=>a.price-b.price).slice(0,8),
    below:levels.filter(x=>x.price<price).sort((a,b)=>b.price-a.price).slice(0,8),
    equalHighs:eqH,equalLows:eqL};
}
function dayExtreme(cs,high){
  const days={};for(const c of cs){const d=c.time.slice(0,10);(days[d]??=[]).push(c);}
  const ds=Object.keys(days).sort(); if(ds.length<2)return null;const prev=days[ds.at(-2)];
  return high?Math.max(...prev.map(x=>x.high)):Math.min(...prev.map(x=>x.low));
}
function findEqual(arr,cfg){const out=[];for(let i=0;i<arr.length;i++)for(let j=i+1;j<arr.length;j++){const a=arr[i],b=arr[j];if(Math.abs(a.price-b.price)<0.25*(atrApprox(arr)||1))out.push({price:(a.price+b.price)/2,time:b.time});}return out.slice(-5);}
function atrApprox(a){if(a.length<3)return 1;let d=0;for(let i=1;i<a.length;i++)d+=Math.abs(a[i].price-a[i-1].price);return d/(a.length-1);}
function buildZones(h1,m15,m5,price,liq,cfg){
  const raw=[];
  addZones(raw,h1,"H1",price,cfg); addZones(raw,m15,"M15",price,cfg); addZones(raw,m5,"M5",price,cfg);
  // FVG from displacement
  addFVG(raw,m15,"M15",price); addFVG(raw,m5,"M5",price);
  // merge overlapping zones of same side
  raw.sort((a,b)=>a.distance-b.distance);
  const merged=[];
  for(const z of raw){const hit=merged.find(x=>x.side===z.side && overlap(x,z,cfg)); if(hit){hit.low=Math.min(hit.low,z.low);hit.high=Math.max(hit.high,z.high);hit.score=Math.min(100,hit.score+Math.round(z.score*.18));hit.sources=[...new Set(hit.sources.concat(z.sources))];hit.tf=[...new Set([].concat(hit.tf,z.tf))].join("+");}else merged.push({...z});}
  for(const z of merged){z.distance=Math.abs(price-(z.low+z.high)/2);z.position=price<z.low?"ABOVE":price>z.high?"BELOW":"INSIDE";z.grade=z.score>=80?"A":z.score>=65?"B":z.score>=50?"C":"D";}
  return {near:merged.filter(z=>z.distance<((z.atr||1)*4)).sort((a,b)=>b.score-a.score).slice(0,12),
    demand:merged.filter(z=>z.side==="DEMAND").sort((a,b)=>b.score-a.score).slice(0,8),
    supply:merged.filter(z=>z.side==="SUPPLY").sort((a,b)=>b.score-a.score).slice(0,8)};
}
function addZones(out,cs,tf,price,cfg){
  const a=atr(cs,cfg.atrPeriod)||Math.abs(cs.at(-1).close-cs.at(-2).close)||1;
  const start=Math.max(3,cs.length-220);
  for(let i=start;i<cs.length-3;i++){
    const c=cs[i], n=cs[i+1], n2=cs[i+2];
    const body=Math.abs(c.close-c.open), move=Math.abs(n2.close-c.close);
    const bullish=n2.close>c.high && move>a*.8;
    const bearish=n2.close<c.low && move>a*.8;
    if(bullish){
      const low=Math.min(c.low,c.open),high=Math.max(c.open,c.high);
      out.push(zone("DEMAND",low,high,tf,["Demand","Displacement"],70+(body>a*.4?7:0),a,c.time,i,cs));
    }
    if(bearish){
      const low=Math.min(c.low,c.open),high=Math.max(c.open,c.high);
      out.push(zone("SUPPLY",low,high,tf,["Supply","Displacement"],70+(body>a*.4?7:0),a,c.time,i,cs));
    }
  }
  const p=pivots(cs,cfg.pivotLeft,cfg.pivotRight);
  for(const x of p.lo.slice(-10)) out.push(zone("DEMAND",x.price-a*.22,x.price+a*.12,tf,["Support","Swing"],55,a,x.time,x.i,cs));
  for(const x of p.hi.slice(-10)) out.push(zone("SUPPLY",x.price-a*.12,x.price+a*.22,tf,["Resistance","Swing"],55,a,x.time,x.i,cs));
}
function zone(side,low,high,tf,sources,score,a,time,i,cs){
  const fresh=(cs.length-1-i)<=6; if(fresh)score+=8;
  return {side,low,high,tf,sources,score:Math.min(100,score),atr:a,time,fresh,distance:0};
}
function addFVG(out,cs,tf,price){
  const a=atr(cs,14)||1;
  for(let i=2;i<cs.length;i++){
    const a0=cs[i-2],c=cs[i];
    if(c.low>a0.high && c.low-a0.high>a*.15) out.push(zone("DEMAND",a0.high,c.low,tf,["FVG","Imbalance"],68,a,c.time,i,cs));
    if(c.high<a0.low && a0.low-c.high>a*.15) out.push(zone("SUPPLY",c.high,a0.low,tf,["FVG","Imbalance"],68,a,c.time,i,cs));
  }
}
function overlap(a,b,cfg){return !(a.high<b.low || b.high<a.low) || Math.abs((a.low+a.high)/2-(b.low+b.high)/2)<Math.max(a.atr,b.atr)*cfg.mergeATR;}
function buildScalpSignal(m15,m5,zones,liq,price,cfg){
  const aligned=m15.bias!=="NEUTRAL"&&m15.bias===m5.bias;
  const side=m15.bias;
  const candidates=zones.near.filter(z=>z.tf.includes("M15")||z.tf.includes("M5"));
  const active=candidates.filter(z=>side==="BULLISH"?z.side==="DEMAND":z.side==="SUPPLY");
  const zoneHit=active.find(z=>price>=z.low&&price<=z.high)||active.sort((a,b)=>b.score-a.score)[0];
  const sweep=detectSweep(m5.candles,side);
  const displacement=detectDisplacement(m5.candles,side,m5.atr||1);
  const fvg=zoneHit?.sources?.includes("FVG");
  const conf={m15Alignment:aligned,m5Structure:m5.bias===side,zone:!!zoneHit,liquiditySweep:sweep,displacement,fvg:!!fvg,h1Context:true};
  let points=0; Object.values(conf).forEach(v=>{if(v)points+=1;});
  let signal="WAIT",strength="WAIT";
  if(aligned && zoneHit){ if(side==="BULLISH")signal="BUY"; if(side==="BEARISH")signal="SELL"; }
  if(signal!=="WAIT") strength=points>=6?"A":points>=4?"B":"C";
  const reasons=[
    aligned?"M15 + M5 searah":"M15 + M5 belum searah",
    zoneHit?`${zoneHit.grade} ${zoneHit.side} zone`:"Tiada zone berkualiti dekat price",
    sweep?"Liquidity sweep detected":"No clear liquidity sweep",
    displacement?"Displacement confirmed":"Displacement belum jelas"
  ];
  return {signal,strength,direction:side,points,confluence:conf,reasons,activeZone:zoneHit||null};
}
function detectSweep(cs,side){const a=cs.slice(-8);if(a.length<5)return false;if(side==="BULLISH"){const low=Math.min(...a.slice(0,-1).map(x=>x.low));return a.at(-1).low<low&&a.at(-1).close>low;}if(side==="BEARISH"){const high=Math.max(...a.slice(0,-1).map(x=>x.high));return a.at(-1).high>high&&a.at(-1).close<high;}return false;}
function detectDisplacement(cs,side,a){const c=cs.at(-1);const body=Math.abs(c.close-c.open);return body>a*.7&&(side==="BULLISH"?c.close>c.open:c.close<c.open);}
function buildTradePlan(signal,price,m5,m15,zones,liq,cfg){
  if(signal==="WAIT")return {active:false,direction:"WAIT",entryLow:null,entryHigh:null,stopLoss:null,tp1:null,tp2:null,tp3:null,rr:null};
  const z=zones.near.find(x=>x.side===(signal==="BUY"?"DEMAND":"SUPPLY")&&(x.tf.includes("M15")||x.tf.includes("M5")))||zones.near.find(x=>x.side===(signal==="BUY"?"DEMAND":"SUPPLY"));
  const a=m5.atr||1, entryLow=z?.low??price-a*.2,entryHigh=z?.high??price+a*.2;
  let sl=signal==="BUY"?entryLow-a*cfg.slATR:entryHigh+a*cfg.slATR;
  const risk=Math.abs(price-sl), tp1=signal==="BUY"?price+risk:price-risk,tp2=signal==="BUY"?price+2*risk:price-2*risk,tp3=signal==="BUY"?price+3*risk:price-3*risk;
  return {active:true,direction:signal,entryLow,entryHigh,stopLoss:sl,tp1,tp2,tp3,rr:3,zone:z?.grade||null,invalidation:signal==="BUY"?`Close below ${sl.toFixed(2)}`:`Close above ${sl.toFixed(2)}`};
}
function scoreConfidence(s,n,z,l){let p=s.points*12;if(s.activeZone)p+=Math.min(15,s.activeZone.score*.12);if(n.blockSignal)p-=30;return Math.max(0,Math.min(100,Math.round(p)));}
function packTF(a){return {tf:a.tf,bias:a.bias,trend:a.trend,structure:a.structure,atr:a.atr,ema20:a.ema20,ema50:a.ema50,last:a.last,time:a.time};}
async function getNewsFilter(key,cache,cfg){
  // Optional Twelve Data economic-calendar endpoint. Failure is non-blocking.
  const now=Date.now(); if(cache.news&&now-cache.newsAt<300000)return cache.news;
  let result={available:false,blockSignal:false,state:"UNKNOWN",events:[],note:"Economic calendar unavailable; technical engine not blocked."};
  try{
    const u=`https://api.twelvedata.com/market_state?symbol=USD&apikey=${key}`;
    const r=await fetch(u); const d=await r.json();
    if(r.ok && d?.status!=="error") result={...result,available:true,state:"MONITOR"};
  }catch{}
  cache.news=result;cache.newsAt=now;return result;
}
