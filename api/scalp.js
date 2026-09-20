export const config = { api: { bodyParser: false } };

const CACHE_KEY = "__XAU_ZONE_ENGINE_V2__";

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
    mergeATR: 0.30,
    zoneFreshBars: 8,
    minDisplacementATR: 0.75,
    minZoneScore: 48,
    slATR: 1.15,
    minRR: 1.5,
  };

  globalThis[CACHE_KEY] ??= { candles:null, candlesAt:0, price:null, priceAt:0 };
  const cache = globalThis[CACHE_KEY];

  try {
    const m5 = await getM5(key, cfg, cache);
    const price = await getPrice(key, cfg, cache, m5);
    const m15 = closedTF(aggregate(m5, 15));
    const h1 = closedTF(aggregate(m5, 60));

    if (m5.length < 100 || m15.length < 60 || h1.length < 30) {
      throw new Error("Data candle belum mencukupi untuk multi-timeframe engine");
    }

    const h1a = analyzeTF(h1, "H1", cfg);
    const m15a = analyzeTF(m15, "M15", cfg);
    const m5a = analyzeTF(m5, "M5", cfg);
    const session = getSession();
    const liquidity = buildLiquidity(h1, m15, m5, price, cfg);
    const zones = buildZones(h1, m15, m5, price, liquidity, cfg);
    const scalp = buildScalpSignal(h1a, m15a, m5a, zones, liquidity, price, cfg);
    const risk = buildRiskFilter(session);
    const finalSignal = risk.blockSignal ? "WAIT" : scalp.signal;
    const tradePlan = buildTradePlan(finalSignal, price, m5a, m15a, zones, liquidity, cfg);
    const confidence = scoreConfidence(scalp, risk, zones);

    const hold = {
      status: finalSignal === "WAIT" ? "WAIT" : h1a.bias === scalp.direction ? "HOLD_SUPPORTED" : "SCALP_ONLY",
      h1Agrees: finalSignal !== "WAIT" && h1a.bias === scalp.direction,
      note: finalSignal === "WAIT"
        ? (risk.blockSignal ? risk.reason : "Waiting for M15 + M5 alignment/zone confirmation")
        : h1a.bias === scalp.direction
          ? "H1 supports the scalp direction"
          : "H1 is context only; scalp remains valid"
    };

    return json(res, 200, {
      ok:true,
      version:"XAU-ZONE-ENGINE-V2",
      symbol:cfg.symbol,
      timestamp:Date.now(),
      livePrice:price,
      marketOpen: isLikelyGoldSessionOpen(),
      signal:finalSignal,
      technicalSignal:scalp.signal,
      signalStrength:risk.blockSignal ? "RISK_BLOCK" : scalp.strength,
      confidence,
      bias: finalSignal === "BUY" ? "BULLISH" : finalSignal === "SELL" ? "BEARISH" : "NEUTRAL",
      h1:packTF(h1a),
      m15:packTF(m15a),
      m5:packTF(m5a),
      session,
      liquidity,
      zones,
      tradePlan,
      holdContext:hold,
      riskFilter:risk,
      confluence:scalp.confluence,
      reasons:scalp.reasons,
      engine:scalp.engine,
      data:{m5:m5.length,m15:m15.length,h1:h1.length}
    });
  } catch (e) {
    return json(res, 500, { ok:false, error:e?.message || "Zone engine error" });
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
  const r=await fetch(u); const d=await r.json().catch(()=>({}));
  if(!r.ok || d?.status==="error" || !Array.isArray(d?.values)){
    if(cache.candles) return cache.candles;
    throw new Error(d?.message || "Twelve Data candle API error");
  }
  const out=d.values.slice().reverse().map(c=>({
    time:String(c.datetime),open:+c.open,high:+c.high,low:+c.low,close:+c.close
  })).filter(c=>[c.open,c.high,c.low,c.close].every(Number.isFinite));
  if(out.length<100) throw new Error("M5 candle tidak mencukupi");
  cache.candles=out; cache.candlesAt=now; return out;
}

async function getPrice(key,cfg,cache,m5){
  const now=Date.now();
  if(Number.isFinite(cache.price) && now-cache.priceAt<cfg.priceTTL) return cache.price;
  try{
    const r=await fetch(`https://api.twelvedata.com/price?symbol=${encodeURIComponent(cfg.symbol)}&apikey=${encodeURIComponent(key)}`);
    const d=await r.json().catch(()=>({})); const p=+d?.price;
    if(r.ok && d?.status!=="error" && Number.isFinite(p)){cache.price=p;cache.priceAt=now;return p;}
  }catch{}
  if(Number.isFinite(cache.price)) return cache.price;
  return m5.at(-1).close;
}

function aggregate(cs,min){
  const out=[];
  for(const c of cs){
    const ms=parseUTC(c.time); if(!Number.isFinite(ms)) continue;
    const bucket=Math.floor(ms/(min*60000))*min*60000;
    let x=out.at(-1);
    if(!x || x.bucket!==bucket){x={bucket,time:formatUTC(bucket),open:c.open,high:c.high,low:c.low,close:c.close};out.push(x);}
    else{x.high=Math.max(x.high,c.high);x.low=Math.min(x.low,c.low);x.close=c.close;}
  }
  return out.map(({bucket,...c})=>c);
}
function parseUTC(s){const t=String(s).replace(" ","T");return Date.parse(/Z$/.test(t)?t:`${t}Z`);}
function formatUTC(ms){return new Date(ms).toISOString().slice(0,16).replace("T"," ");}
function closedTF(cs){return cs.length>1?cs.slice(0,-1):cs;}

function atr(cs,n=14){
  if(cs.length<n+1)return null;
  const trs=[];
  for(let i=1;i<cs.length;i++) trs.push(Math.max(cs[i].high-cs[i].low,Math.abs(cs[i].high-cs[i-1].close),Math.abs(cs[i].low-cs[i-1].close)));
  const last=trs.slice(-n);
  return last.reduce((a,b)=>a+b,0)/last.length;
}
function ema(values,n){
  if(values.length<n)return null;
  let e=values.slice(0,n).reduce((a,b)=>a+b,0)/n, k=2/(n+1);
  for(let i=n;i<values.length;i++)e=values[i]*k+e*(1-k);
  return e;
}
function rsi(cs,n=14){
  if(cs.length<n+1)return null;
  let gain=0,loss=0;
  for(let i=1;i<=n;i++){const d=cs[i].close-cs[i-1].close;if(d>=0)gain+=d;else loss-=d;}
  gain/=n;loss/=n;
  for(let i=n+1;i<cs.length;i++){const d=cs[i].close-cs[i-1].close;gain=((gain*(n-1))+(d>0?d:0))/n;loss=((loss*(n-1))+(d<0?-d:0))/n;}
  if(loss===0)return 100; return 100-(100/(1+gain/loss));
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
  const highs=p.hi.slice(-8), lows=p.lo.slice(-8);
  const ph=highs.at(-2),lh=highs.at(-1),pl=lows.at(-2),ll=lows.at(-1);
  const hh=!!(lh&&ph&&lh.price>ph.price), lowerHigh=!!(lh&&ph&&lh.price<ph.price);
  const higherLow=!!(ll&&pl&&ll.price>pl.price), lowerLow=!!(ll&&pl&&ll.price<pl.price);
  const bias=hh&&higherLow?"BULLISH":lowerHigh&&lowerLow?"BEARISH":"NEUTRAL";
  const last=cs.at(-1), lastHigh=highs.at(-1), lastLow=lows.at(-1);
  const bosUp=!!(lastHigh&&last.close>lastHigh.price), bosDn=!!(lastLow&&last.close<lastLow.price);
  return {
    bias,
    bos:bosUp?"BULLISH":bosDn?"BEARISH":null,
    swingHigh:lastHigh||null,
    swingLow:lastLow||null,
    priorHighPattern:hh?"HH":lowerHigh?"LH":"—",
    priorLowPattern:higherLow?"HL":lowerLow?"LL":"—",
    highs,lows
  };
}
function analyzeTF(cs,tf,cfg){
  const p=pivots(cs,cfg.pivotLeft,cfg.pivotRight), a=atr(cs,cfg.atrPeriod);
  const s=structure(cs,p), e20=ema(cs.map(x=>x.close),20), e50=ema(cs.map(x=>x.close),50), r=rsi(cs,14), last=cs.at(-1).close;
  const trend=last>e20&&e20>e50?"BULLISH":last<e20&&e20<e50?"BEARISH":"NEUTRAL";
  const direction=s.bias!=="NEUTRAL"?s.bias:trend;
  return {tf,bias:direction,trend,structure:s,atr:a,ema20:e20,ema50:e50,rsi:r,last,time:cs.at(-1).time,candles:cs,pivots:p};
}

function buildLiquidity(h1,m15,m5,price,cfg){
  const levels=[];
  const add=(name,v,tf,type="LEVEL")=>{if(Number.isFinite(v))levels.push({name,price:+v.toFixed(5),tf,type,distance:Math.abs(v-price)});};
  add("H1 Range High",Math.max(...h1.slice(-24).map(x=>x.high)),"H1","SWING");
  add("H1 Range Low",Math.min(...h1.slice(-24).map(x=>x.low)),"H1","SWING");
  add("M15 Range High",Math.max(...m15.slice(-32).map(x=>x.high)),"M15","SWING");
  add("M15 Range Low",Math.min(...m15.slice(-32).map(x=>x.low)),"M15","SWING");
  const pd=previousDay(m5); add("Previous Day High",pd.high,"DAY","PDH"); add("Previous Day Low",pd.low,"DAY","PDL");
  const pw=previousWeek(m5); add("Previous Week High",pw.high,"WEEK","PWH"); add("Previous Week Low",pw.low,"WEEK","PWL");
  const pm=pivots(m15,cfg.pivotLeft,cfg.pivotRight);
  const eqH=findEqual(pm.hi,0.18), eqL=findEqual(pm.lo,0.18);
  eqH.forEach(x=>add("Equal High",x.price,"M15","EQH")); eqL.forEach(x=>add("Equal Low",x.price,"M15","EQL"));
  const above=levels.filter(x=>x.price>price).sort((a,b)=>a.price-b.price).slice(0,10);
  const below=levels.filter(x=>x.price<price).sort((a,b)=>b.price-a.price).slice(0,10);
  const nearestAbove=above[0]?.price, nearestBelow=below[0]?.price;
  return {above,below,equalHighs:eqH,equalLows:eqL,nearestAbove,nearestBelow};
}
function previousDay(cs){return previousBucket(cs,10, d=>d.slice(0,10));}
function previousWeek(cs){return previousBucket(cs,10, d=>{const x=new Date(parseUTC(d));const day=x.getUTCDay();x.setUTCDate(x.getUTCDate()-day);return x.toISOString().slice(0,10);});}
function previousBucket(cs,days,fn){
  const groups={}; for(const c of cs){const k=fn(c.time);(groups[k]??=[]).push(c);} const keys=Object.keys(groups).sort();
  if(keys.length<2)return {high:null,low:null,key:null}; const g=groups[keys.at(-2)]; return {high:Math.max(...g.map(x=>x.high)),low:Math.min(...g.map(x=>x.low)),key:keys.at(-2)};
}
function findEqual(arr,tolerance){
  const out=[]; for(let i=0;i<arr.length;i++)for(let j=i+1;j<arr.length;j++){
    if(Math.abs(arr[i].price-arr[j].price)<=tolerance)out.push({price:(arr[i].price+arr[j].price)/2,time:arr[j].time});
  }
  return dedupeLevels(out).slice(-6);
}
function dedupeLevels(a){return a.filter((x,i)=>a.findIndex(y=>Math.abs(y.price-x.price)<0.05)===i);}

function buildZones(h1,m15,m5,price,liq,cfg){
  const raw=[];
  addStructureZones(raw,h1,"H1",cfg); addStructureZones(raw,m15,"M15",cfg); addStructureZones(raw,m5,"M5",cfg);
  addFVG(raw,m15,"M15",cfg); addFVG(raw,m5,"M5",cfg);
  addOrderBlocks(raw,m15,"M15",cfg); addOrderBlocks(raw,m5,"M5",cfg);
  addLiquidityZones(raw,liq,cfg);

  for(const z of raw){
    z.distance=Math.abs(price-(z.low+z.high)/2);
    z.position=price<z.low?"ABOVE":price>z.high?"BELOW":"INSIDE";
    z.touches=countTouches(z,z.sourceCandles||[]);
    z.fresh=(z.sourceIndex==null)?z.fresh:z.sourceCandles.length-1-z.sourceIndex<=cfg.zoneFreshBars;
    z.score=zoneScore(z,price,cfg);
    z.grade=z.score>=85?"A+":z.score>=75?"A":z.score>=65?"B":z.score>=55?"C":"D";
  }
  const merged=[];
  raw.sort((a,b)=>a.distance-b.distance || b.score-a.score);
  for(const z of raw){
    const hit=merged.find(x=>x.side===z.side && (overlap(x,z) || Math.abs(mid(x)-mid(z))<Math.max(x.atr,z.atr)*cfg.mergeATR));
    if(hit){
      hit.low=Math.min(hit.low,z.low); hit.high=Math.max(hit.high,z.high); hit.score=Math.min(100,Math.round(hit.score+z.score*0.16));
      hit.sources=[...new Set([...hit.sources,...z.sources])]; hit.tf=[...new Set([...String(hit.tf).split("+"),...String(z.tf).split("+")])].join("+"); hit.fresh=hit.fresh||z.fresh;
    } else merged.push({...z});
  }
  const near=merged.filter(z=>z.score>=cfg.minZoneScore && z.distance<Math.max(z.atr*4,1.5)).sort((a,b)=>b.score-a.score || a.distance-b.distance).slice(0,16);
  return {
    near,
    demand:merged.filter(z=>z.side==="DEMAND").sort((a,b)=>b.score-a.score).slice(0,12),
    supply:merged.filter(z=>z.side==="SUPPLY").sort((a,b)=>b.score-a.score).slice(0,12),
    allCount:merged.length
  };
}
function addStructureZones(out,cs,tf,cfg){
  const a=atr(cs,cfg.atrPeriod)||1, p=pivots(cs,cfg.pivotLeft,cfg.pivotRight);
  for(const x of p.lo.slice(-14)) out.push(makeZone("DEMAND",x.price-a*.20,x.price+a*.12,tf,["Support","Swing"],54,a,x.i,x.time,cs));
  for(const x of p.hi.slice(-14)) out.push(makeZone("SUPPLY",x.price-a*.12,x.price+a*.20,tf,["Resistance","Swing"],54,a,x.i,x.time,cs));
  for(let i=Math.max(3,cs.length-260);i<cs.length-3;i++){
    const c=cs[i], next=cs[i+1], next2=cs[i+2], move=Math.abs(next2.close-c.close), body=Math.abs(c.close-c.open);
    if(next2.close>c.high && move>a*cfg.minDisplacementATR) out.push(makeZone("DEMAND",Math.min(c.open,c.low),Math.max(c.open,c.high),tf,["Supply/Demand","Displacement"],66+(body>a*.4?7:0),a,i,c.time,cs));
    if(next2.close<c.low && move>a*cfg.minDisplacementATR) out.push(makeZone("SUPPLY",Math.min(c.open,c.low),Math.max(c.open,c.high),tf,["Supply/Demand","Displacement"],66+(body>a*.4?7:0),a,i,c.time,cs));
  }
}
function addFVG(out,cs,tf,cfg){
  const a=atr(cs,14)||1;
  for(let i=2;i<cs.length;i++){
    const left=cs[i-2],right=cs[i];
    if(right.low-left.high>a*.12) out.push(makeZone("DEMAND",left.high,right.low,tf,["FVG","Imbalance"],68,a,i,right.time,cs));
    if(left.low-right.high>a*.12) out.push(makeZone("SUPPLY",right.high,left.low,tf,["FVG","Imbalance"],68,a,i,right.time,cs));
  }
}
function addOrderBlocks(out,cs,tf,cfg){
  const a=atr(cs,14)||1;
  for(let i=3;i<cs.length-2;i++){
    const c=cs[i], n1=cs[i+1], n2=cs[i+2], move=Math.abs(n2.close-c.close);
    if(c.close<c.open && n2.close>c.high && move>a*cfg.minDisplacementATR) out.push(makeZone("DEMAND",c.low,c.high,tf,["Order Block","Bullish OB"],73,a,i,c.time,cs));
    if(c.close>c.open && n2.close<c.low && move>a*cfg.minDisplacementATR) out.push(makeZone("SUPPLY",c.low,c.high,tf,["Order Block","Bearish OB"],73,a,i,c.time,cs));
  }
}
function addLiquidityZones(out,liq,cfg){
  for(const x of [...liq.equalHighs]) out.push(makeZone("SUPPLY",x.price-.08,x.price+.08,"M15",["Liquidity","Equal High"],62,1,null,x.time,[]));
  for(const x of [...liq.equalLows]) out.push(makeZone("DEMAND",x.price-.08,x.price+.08,"M15",["Liquidity","Equal Low"],62,1,null,x.time,[]));
}
function makeZone(side,low,high,tf,sources,score,atrValue,sourceIndex,time,sourceCandles){return {side,low:Math.min(low,high),high:Math.max(low,high),tf,sources,score,atr:atrValue,sourceIndex,time,sourceCandles:sourceCandles||[],fresh:true,touches:0};}
function mid(z){return (z.low+z.high)/2;}
function overlap(a,b){return !(a.high<b.low || b.high<a.low);}
function countTouches(z,cs){if(!cs?.length)return 0;let n=0;for(const c of cs.slice(-80)){if(c.high>=z.low&&c.low<=z.high)n++;}return n;}
function zoneScore(z,price,cfg){
  let s=z.score;
  if(z.fresh)s+=8;
  if(z.sources.some(x=>/Order Block|Bullish OB|Bearish OB/.test(x)))s+=6;
  if(z.sources.includes("FVG"))s+=5;
  if(z.sources.includes("Liquidity"))s+=5;
  if(z.sources.includes("Displacement"))s+=5;
  if(z.touches===1)s+=5;
  if(z.touches>5)s-=Math.min(10,(z.touches-5)*2);
  const d=Math.abs(price-mid(z)); if(d<=z.atr*.5)s+=5; else if(d<=z.atr)s+=2;
  return Math.max(0,Math.min(100,Math.round(s)));
}

function buildScalpSignal(h1,m15,m5,zones,liq,price,cfg){
  const aligned=m15.bias!=="NEUTRAL" && m15.bias===m5.bias;
  const side=m15.bias;
  const wanted=side==="BULLISH"?"DEMAND":side==="BEARISH"?"SUPPLY":null;
  const candidates=zones.near.filter(z=>wanted && z.side===wanted && (z.tf.includes("M15")||z.tf.includes("M5")));
  const active=candidates.find(z=>price>=z.low&&price<=z.high) || candidates.sort((a,b)=>a.distance-b.distance || b.score-a.score)[0] || null;
  const sweep=detectLiquiditySweep(m5.candles,side,liq);
  const displacement=detectDisplacement(m5.candles,side,m5.atr||1);
  const mss=detectMSS(m5.candles,side,cfg);
  const fvg=!!active?.sources?.includes("FVG");
  const ob=!!active?.sources?.some(x=>x.includes("Order Block"));
  const confluence={
    m15Alignment:aligned,
    m5Structure:side!=="NEUTRAL"&&m5.bias===side,
    zone:!!active,
    liquiditySweep:sweep,
    displacement,
    marketStructureShift:mss,
    fvg,
    orderBlock:ob,
    h1Context:h1.bias===side
  };
  let points=0; Object.entries(confluence).forEach(([k,v])=>{if(v)points += k==="h1Context"?0.5:1;});
  let signal="WAIT";
  // Core rule: M15 + M5 alignment + qualified zone. H1 never vetoes a scalp.
  if(aligned && active) signal=side==="BULLISH"?"BUY":side==="BEARISH"?"SELL":"WAIT";
  const strength=points>=7?"A+":points>=5?"A":points>=3.5?"B":"C";
  const reasons=[
    aligned?"M15 + M5 searah":"M15 + M5 belum searah",
    active?`${active.grade} ${active.side} zone · ${active.sources.join(" + ")}`:"Tiada qualified M15/M5 zone",
    sweep?"Liquidity sweep detected":"No confirmed liquidity sweep",
    displacement?"Displacement confirmed":"Displacement belum jelas",
    mss?"M5 market-structure shift confirmed":"M5 MSS belum confirm"
  ];
  return {signal,strength,direction:side,points,confluence,reasons,activeZone:active,engine:{coreRule:"M15 + M5 alignment",h1Role:h1.bias===side?"HOLD_SUPPORTED":"SCALP_ONLY",h1Bias:h1.bias,m15Bias:m15.bias,m5Bias:m5.bias}};
}
function detectLiquiditySweep(cs,side,liq){
  const a=cs.slice(-10); if(a.length<5||side==="NEUTRAL")return false; const last=a.at(-1);
  const priorHigh=Math.max(...a.slice(0,-1).map(x=>x.high)),priorLow=Math.min(...a.slice(0,-1).map(x=>x.low));
  if(side==="BULLISH") return last.low<priorLow&&last.close>priorLow;
  return last.high>priorHigh&&last.close<priorHigh;
}
function detectDisplacement(cs,side,a){const c=cs.at(-1);if(!c||side==="NEUTRAL")return false;return Math.abs(c.close-c.open)>=a*.7&&(side==="BULLISH"?c.close>c.open:c.close<c.open);}
function detectMSS(cs,side,cfg){
  const p=pivots(cs,cfg.pivotLeft,cfg.pivotRight), last=cs.at(-1); if(!last||side==="NEUTRAL")return false;
  if(side==="BULLISH"){const h=p.hi.at(-1);return !!h&&last.close>h.price;}
  const l=p.lo.at(-1);return !!l&&last.close<l.price;
}

function buildTradePlan(signal,price,m5,m15,zones,liq,cfg){
  if(signal==="WAIT") return {active:false,direction:"WAIT",entryLow:null,entryHigh:null,entry:null,stopLoss:null,tp1:null,tp2:null,tp3:null,rr:null,invalidation:"No active trade plan"};
  const side=signal==="BUY"?"DEMAND":"SUPPLY";
  const z=zones.near.find(x=>x.side===side&&(x.tf.includes("M15")||x.tf.includes("M5"))) || zones.near.find(x=>x.side===side);
  const a=m5.atr||1;
  const entryLow=z?.low??price-a*.20, entryHigh=z?.high??price+a*.20;
  const entry=Math.max(entryLow,Math.min(price,entryHigh));
  const sl=signal==="BUY"?entryLow-a*cfg.slATR:entryHigh+a*cfg.slATR;
  const risk=Math.abs(entry-sl);
  const tp1=signal==="BUY"?entry+risk:entry-risk;
  const tp2=signal==="BUY"?entry+2*risk:entry-2*risk;
  const tp3=signal==="BUY"?entry+3*risk:entry-3*risk;
  const nearest=signal==="BUY"?liq.nearestAbove:liq.nearestBelow;
  return {active:true,direction:signal,entryLow,entryHigh,entry,stopLoss:sl,tp1,tp2,tp3,rr:3,zone:z?.grade||null,liquidityTarget:nearest??null,invalidation:signal==="BUY"?`Close below ${sl.toFixed(2)}`:`Close above ${sl.toFixed(2)}`};
}

function scoreConfidence(s,r,zones){
  let p=s.points*11.5;
  if(s.activeZone)p+=Math.min(15,s.activeZone.score*.15);
  if(s.engine.h1Role==="HOLD_SUPPORTED")p+=5;
  if(r.blockSignal)p-=35;
  return Math.max(0,Math.min(100,Math.round(p)));
}

function packTF(a){return {tf:a.tf,bias:a.bias,trend:a.trend,structure:a.structure,atr:a.atr,ema20:a.ema20,ema50:a.ema50,rsi:a.rsi,last:a.last,time:a.time};}

function getSession(){
  const now=new Date(); const h=now.getUTCHours()+now.getUTCMinutes()/60;
  let name="ASIA";
  if(h>=7&&h<12)name="LONDON";
  else if(h>=12&&h<17)name="LONDON_NY_OVERLAP";
  else if(h>=17&&h<22)name="NEW_YORK";
  else if(h>=22||h<1)name="NY_LATE";
  const weekend=now.getUTCDay()===0||now.getUTCDay()===6;
  return {name,utcHour:h,weekend,active:!weekend&&!(h>=22&&h<23)};
}
function isLikelyGoldSessionOpen(){const s=getSession();return s.active;}
function buildRiskFilter(session){
  // No fake economic-news feed. This layer only reports session/weekend risk.
  // It can optionally be extended with a dedicated calendar provider later.
  if(session.weekend)return {blockSignal:true,state:"WEEKEND",reason:"Weekend / market likely closed",available:false,events:[]};
  return {blockSignal:false,state:"SESSION_MONITOR",reason:`Session: ${session.name}`,available:false,events:[]};
}
