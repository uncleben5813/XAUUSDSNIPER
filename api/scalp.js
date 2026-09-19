export default async function handler(req, res) {
  const API_KEY = process.env.TWELVE_DATA_API_KEY;
  if (!API_KEY) return res.status(500).json({ok:false,error:"TWELVE_DATA_API_KEY belum diset"});

  const CFG = {
    symbol:"XAU/USD", m5OutputSize:2500, candleTTL:60000, priceTTL:30000,
    pivotLeft:3,pivotRight:3,structureLookbackH1:250,mergeATR:.35,
    minProminenceATR:.35,prominenceWindow:6,atrPeriod:14,
    nearLevelATR:.45,minimumRR:1.35,tp1R:1,tp2R:2,tp3R:3,m5SL_ATR:1.25
  };

  globalThis.__XAU_SNIPER_CACHE__ ??= {
    candles:null,candlesAt:0,price:null,priceAt:0,news:null,newsAt:0
  };
  const cache=globalThis.__XAU_SNIPER_CACHE__;

  try {
    const m5=await getM5(API_KEY,CFG,cache);
    if(!Array.isArray(m5)||m5.length<2)
      throw new Error("Twelve Data returned insufficient M5 candles");

    let livePrice=m5.at(-1)?.close ?? null, livePriceSource="M5_CANDLE_FALLBACK",livePriceError=null;
    if(cache.price!==null && Date.now()-cache.priceAt<CFG.priceTTL){
      livePrice=cache.price;livePriceSource="TWELVE_DATA_PRICE_CACHE";
    } else {
      try {
        const d=await jsonFetch(`https://api.twelvedata.com/price?symbol=${encodeURIComponent(CFG.symbol)}&apikey=${API_KEY}`);
        const p=Number(d?.price);
        if(Number.isFinite(p)){livePrice=p;livePriceSource="TWELVE_DATA_PRICE";cache.price=p;cache.priceAt=Date.now();}
        else livePriceError=d?.message||"Live price API error";
      } catch(e){livePriceError=e?.message||"Live price request failed";}
    }

    const closedM5=closedTF(m5,5);
    const m15=aggregate(m5,15), h1=aggregate(m5,60);
    const closedM15=closedTF(m15,15),closedH1=closedTF(h1,60);
    const structureData=closedH1.slice(-CFG.structureLookbackH1);
    const atrH1=calculateATR(structureData,CFG.atrPeriod);
    const atrM15=calculateATR(closedM15,CFG.atrPeriod)||atrH1;
    const atrM5=calculateATR(closedM5,CFG.atrPeriod)||atrM15;

    const h1Struct=buildTF(structureData,CFG.pivotLeft,CFG.pivotRight,atrH1);
    const m15Struct=buildTF(closedM15,2,2,atrM15);
    const m5Struct=buildTF(closedM5,2,2,atrM5);

    const h1Levels=buildStructuralLevels(h1Struct.pivots.highs,h1Struct.pivots.lows,structureData,atrH1,CFG);
    const support=nearestBelow(h1Levels.lows,livePrice);
    const resistance=nearestAbove(h1Levels.highs,livePrice);
    const event=detectStructureEvent(structureData,h1Struct.pivots.highs,h1Struct.pivots.lows,h1Struct.structure);

    const m15Conf=confirmation(closedM15,m15Struct,atrM15);
    const m5Trig=trigger(closedM5,m5Struct,atrM5);
    const signal=m15Conf.bias==="BULLISH"&&m5Trig.direction==="BUY"?"BUY":
                 m15Conf.bias==="BEARISH"&&m5Trig.direction==="SELL"?"SELL":"WAIT";

    const liquidity=buildLiquidity(closedM5,closedM15,structureData,livePrice,atrH1||1);
    const warning=signal==="BUY"&&resistance&&resistance.distance<=(atrH1||1)*CFG.nearLevelATR
      ? {warning:true,type:"BUY_NEAR_H1_RESISTANCE",level:resistance.price}
      : signal==="SELL"&&support&&support.distance<=(atrH1||1)*CFG.nearLevelATR
      ? {warning:true,type:"SELL_NEAR_H1_SUPPORT",level:support.price}
      : {warning:false,type:null,level:null};

    const plan=tradePlan(signal,livePrice,m5Struct,m15Struct,h1Levels,atrM5||1,CFG);
    const confidence=calcConfidence(signal,h1Struct.structure,m15Conf,m5Trig,warning);
    const news=await getNews(API_KEY,cache,CFG);

    return res.status(200).json({
      ok:true,version:"XAUUSDSNIPER-FULL-V3",symbol:CFG.symbol,
      livePrice,price:livePrice,livePriceSource,livePriceError,
      signal,signalStrength:signal==="WAIT"?"WAIT":confidence.score>=80?"STRONG":"NORMAL",
      confidence:confidence.score,bias:confidence.bias,
      h1:{
        candles:h1.length,closedCandles:closedH1.length,structureCandles:structureData.length,
        lastClosedTime:structureData.at(-1)?.time??null,
        direction:h1Struct.structure.bias,trend:h1Struct.structure.bias,
        structure:h1Struct.structure,bos:event.type==="BOS"?event:null,
        choch:event.type==="CHOCH"?event:null,event:event.type==="NONE"?null:event,
        support,resistance,breakTarget:event.direction==="BULLISH"?resistance:event.direction==="BEARISH"?support:null,
        atr14:round(atrH1,4),swings:{
          highs:h1Struct.pivots.highs.slice(-12).map(cleanPivot),
          lows:h1Struct.pivots.lows.slice(-12).map(cleanPivot)
        },majorStructures:{highs:h1Levels.highs.slice(-12),lows:h1Levels.lows.slice(-12)}
      },
      m15:{candles:closedM15.length,direction:m15Conf.bias,confirmation:m15Conf.bias,score:m15Conf.score,
        structure:m15Struct.structure.bias,event:m15Struct.event,reasons:m15Conf.reasons,atr:round(atrM15,4)},
      m5:{candles:closedM5.length,direction:m5Trig.direction,trigger:m5Trig.direction,score:m5Trig.score,
        structure:m5Struct.structure.bias,event:m5Struct.event,reasons:m5Trig.reasons,atr:round(atrM5,4)},
      tradePlan:plan,
      entryQuality:{
        score:Math.round((m15Conf.score+m5Trig.score)/2),
        label:signal==="WAIT"?"WAIT":warning.warning?"CAUTION":m15Conf.score>=75&&m5Trig.score>=75?"HIGH":"GOOD",
        m15Aligned:signal==="BUY"?m15Conf.bias==="BULLISH":signal==="SELL"?m15Conf.bias==="BEARISH":false,
        m5Triggered:signal==="BUY"?m5Trig.direction==="BUY":signal==="SELL"?m5Trig.direction==="SELL":false,
        warning
      },
      liquidity,newsFilter:news,
      holdContext:{
        status:signal==="WAIT"?"WAIT":(h1Struct.structure.bias===signalBias(signal) ? signal==="BUY"?"HOLD_BUY":"HOLD_SELL":"SCALP_ONLY"),
        h1Agrees:h1Struct.structure.bias===signalBias(signal),
        note:h1Struct.structure.bias===signalBias(signal)?"H1 supports scalp direction":"H1 is context only; it does not veto M15+M5 scalp"
      },
      rules:{scalpRequiresM15M5Alignment:true,h1IsContextNotHardVeto:true,structuralSROnly:true},
      cache:{candleAgeSeconds:cache.candlesAt?Math.round((Date.now()-cache.candlesAt)/1000):null,candleTTLSeconds:CFG.candleTTL/1000,m5Candles:m5.length},
      timestamp:new Date().toISOString()
    });
  } catch(error) {
    console.error("XAU SNIPER ERROR",error);
    return res.status(500).json({ok:false,error:error?.message||"XAU structure engine error",hint:"Check Twelve Data API key/quota and /api/scalp deployment."});
  }
}

async function getM5(key,cfg,cache){
  const now=Date.now();
  if(cache.candles&&now-cache.candlesAt<cfg.candleTTL)return cache.candles;
  const url=`https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(cfg.symbol)}&interval=5min&outputsize=${cfg.m5OutputSize}&apikey=${key}`;
  let d;
  try{d=await jsonFetch(url);}catch(e){
    if(cache.candles)return cache.candles;
    throw e;
  }
  if(!Array.isArray(d?.values)){
    if(cache.candles)return cache.candles;
    throw new Error(d?.message||"Twelve Data candle API error");
  }
  const data=d.values.slice().reverse().map(c=>({time:c.datetime,open:Number(c.open),high:Number(c.high),low:Number(c.low),close:Number(c.close)}))
    .filter(c=>[c.open,c.high,c.low,c.close].every(Number.isFinite));
  if(!data.length)throw new Error("Twelve Data returned empty candles");
  cache.candles=data;cache.candlesAt=now;return data;
}

async function jsonFetch(url){
  const r=await fetch(url);
  let d;try{d=await r.json();}catch{throw new Error(`Invalid Twelve Data response (${r.status})`);}
  if(!r.ok||d?.status==="error")throw new Error(d?.message||`HTTP ${r.status}`);
  return d;
}

function aggregate(data,minutes){
  const size=minutes*60000,map=new Map();
  for(const c of data||[]){
    const ts=Date.parse(String(c.time).replace(" ","T")+"Z");
    if(!Number.isFinite(ts))continue;
    const key=Math.floor(ts/size)*size;
    let b=map.get(key);
    if(!b){b={time:new Date(key).toISOString(),open:c.open,high:c.high,low:c.low,close:c.close};map.set(key,b);}
    else{b.high=Math.max(b.high,c.high);b.low=Math.min(b.low,c.low);b.close=c.close;}
  }
  return [...map.values()].sort((a,b)=>Date.parse(a.time)-Date.parse(b.time));
}
function closedTF(data,minutes){
  if(!data?.length)return[];
  const size=minutes*60000,last=Date.parse(data.at(-1).time);
  if(!Number.isFinite(last)||data.length<2)return data;
  const current=Math.floor(last/size)*size;
  return data.filter(c=>Date.parse(c.time)<current);
}
function findPivots(data,left,right){
  const out=[];if(!Array.isArray(data)||data.length<left+right+1)return out;
  for(let i=left;i<data.length-right;i++){
    let hi=true,lo=true,c=data[i];
    for(let j=1;j<=left;j++){if(!(c.high>data[i-j].high))hi=false;if(!(c.low<data[i-j].low))lo=false;}
    for(let j=1;j<=right;j++){if(!(c.high>=data[i+j].high))hi=false;if(!(c.low<=data[i+j].low))lo=false;}
    if(hi)out.push({type:"HIGH",price:c.high,time:c.time,index:i});
    if(lo)out.push({type:"LOW",price:c.low,time:c.time,index:i});
  }
  return out.sort((a,b)=>a.index-b.index);
}
function calculateATR(data,p=14){
  if(!Array.isArray(data)||data.length<2)return null;
  p=Math.min(p,data.length-1);const tr=[];
  for(let i=1;i<data.length;i++)tr.push(Math.max(data[i].high-data[i].low,Math.abs(data[i].high-data[i-1].close),Math.abs(data[i].low-data[i-1].close)));
  const x=tr.slice(-p);return x.length?x.reduce((a,b)=>a+b,0)/x.length:null;
}
function buildTF(data,left,right,atr){
  data=data||[];const piv=findPivots(data,left,right),highs=piv.filter(x=>x.type==="HIGH"),lows=piv.filter(x=>x.type==="LOW");
  const hp=highs.slice(-3),lp=lows.slice(-3);let bias="NEUTRAL";
  if(hp.length>=2&&lp.length>=2){
    if(hp.at(-1).price>hp.at(-2).price&&lp.at(-1).price>lp.at(-2).price)bias="BULLISH";
    else if(hp.at(-1).price<hp.at(-2).price&&lp.at(-1).price<lp.at(-2).price)bias="BEARISH";
  }
  let event="NONE";const last=data.at(-1);
  if(last&&highs.at(-1)&&last.close>highs.at(-1).price+(atr||0)*.05)event=bias==="BEARISH"?"CHOCH_BULL":"BOS_BULL";
  else if(last&&lows.at(-1)&&last.close<lows.at(-1).price-(atr||0)*.05)event=bias==="BULLISH"?"CHOCH_BEAR":"BOS_BEAR";
  return {pivots:{highs,lows},structure:{bias,highPattern:hp.length>=2?(hp.at(-1).price>hp.at(-2).price?"HH":"LH"):"NONE",lowPattern:lp.length>=2?(lp.at(-1).price>lp.at(-2).price?"HL":"LL"):"NONE",lastSwingHigh:hp.at(-1)?.price??null,lastSwingLow:lp.at(-1)?.price??null},event};
}
function buildStructuralLevels(highs,lows,candles,atr,cfg){
  const a=Number.isFinite(atr)&&atr>0?atr:estimateATR(candles);
  const filter=(xs,type)=>xs.map(p=>{
    const prom=prominence(candles,p,type,cfg.prominenceWindow),pa=a>0?prom/a:0;
    return {...p,strength:pa>=cfg.minProminenceATR?"MAJOR":"STRUCTURE",prominenceATR:Number(pa.toFixed(3))};
  });
  let hs=filter(highs,"HIGH"),ls=filter(lows,"LOW");
  const mh=hs.filter(x=>x.strength==="MAJOR"),ml=ls.filter(x=>x.strength==="MAJOR");
  hs=mh.length>=2?mh:hs;ls=ml.length>=2?ml:ls;
  return {highs:mergeLevels(hs,a*cfg.mergeATR),lows:mergeLevels(ls,a*cfg.mergeATR)};
}
function prominence(c,p,type,w){
  if(!c?.length)return 0;const s=Math.max(0,p.index-w),e=Math.min(c.length-1,p.index+w);
  if(type==="HIGH"){let low=Infinity;for(let i=s;i<=e;i++)if(i!==p.index)low=Math.min(low,c[i].low);return Number.isFinite(low)?Math.max(0,p.price-low):0;}
  let high=-Infinity;for(let i=s;i<=e;i++)if(i!==p.index)high=Math.max(high,c[i].high);return Number.isFinite(high)?Math.max(0,high-p.price):0;
}
function mergeLevels(xs,d){
  const out=[];for(const x of [...xs].sort((a,b)=>a.price-b.price)){const last=out.at(-1);if(last&&Math.abs(x.price-last.price)<=d){if((x.prominenceATR||0)>(last.prominenceATR||0))out[out.length-1]=x;}else out.push(x);}return out.sort((a,b)=>a.index-b.index);
}
function nearestBelow(xs,p){if(!Number.isFinite(p))return null;const x=(xs||[]).filter(x=>x.price<p).sort((a,b)=>b.price-a.price)[0];return x?levelObj(x,p-x.price,"H1_STRUCTURAL_SWING_LOW"):null;}
function nearestAbove(xs,p){if(!Number.isFinite(p))return null;const x=(xs||[]).filter(x=>x.price>p).sort((a,b)=>a.price-b.price)[0];return x?levelObj(x,x.price-p,"H1_STRUCTURAL_SWING_HIGH"):null;}
function levelObj(x,d,type){return{price:x.price,distance:d,time:x.time,type,strength:x.strength,prominenceATR:x.prominenceATR};}
function detectStructureEvent(data,highs,lows,s){
  const c=data?.at(-1);if(!c)return{type:"NONE",direction:"NONE",price:null,level:null,time:null};
  const h=highs?.at(-1),l=lows?.at(-1);
  if(h&&c.close>h.price)return{type:s.bias==="BEARISH"?"CHOCH":"BOS",direction:"BULLISH",price:c.close,level:h.price,time:c.time};
  if(l&&c.close<l.price)return{type:s.bias==="BULLISH"?"CHOCH":"BOS",direction:"BEARISH",price:c.close,level:l.price,time:c.time};
  return{type:"NONE",direction:"NONE",price:null,level:null,time:null};
}
function confirmation(data,s,a){
  if(!data?.length)return{bias:"NEUTRAL",score:50,reasons:["Insufficient M15 candles"]};
  const c=data.at(-1),prev=data.at(-2),e=ema(data.map(x=>x.close),20),v=a||1;let z=0,reasons=[];
  if(s.structure.bias==="BULLISH"){z+=25;reasons.push("M15 bullish structure");}
  if(s.structure.bias==="BEARISH"){z-=25;reasons.push("M15 bearish structure");}
  if(c.close>c.open){z+=15;reasons.push("bullish candle");}else if(c.close<c.open){z-=15;reasons.push("bearish candle");}
  if(prev&&c.close>prev.high){z+=20;reasons.push("break previous high");}
  if(prev&&c.close<prev.low){z-=20;reasons.push("break previous low");}
  if(e&&c.close>e){z+=10;}else if(e&&c.close<e){z-=10;}
  if(Math.abs(c.close-c.open)>v*.45){z+=c.close>c.open?10:-10;}
  return{bias:z>=20?"BULLISH":z<=-20?"BEARISH":"NEUTRAL",score:Math.round(Math.max(0,Math.min(100,50+z))),reasons};
}
function trigger(data,s,a){
  if(!data?.length)return{direction:"WAIT",score:50,reasons:["Insufficient M5 candles"]};
  if(data.length<2)return{direction:"WAIT",score:50,reasons:["Waiting for M5 history"]};
  const c=data.at(-1),p=data.at(-2),v=a||1;let z=0,reasons=[];
  if(c.close>c.open){z+=20;reasons.push("M5 bullish close");}else if(c.close<c.open){z-=20;reasons.push("M5 bearish close");}
  if(c.close>p.high){z+=25;reasons.push("M5 break high");}
  if(c.close<p.low){z-=25;reasons.push("M5 break low");}
  if(s.structure.bias==="BULLISH"){z+=15;reasons.push("M5 bullish structure");}
  if(s.structure.bias==="BEARISH"){z-=15;reasons.push("M5 bearish structure");}
  if(Math.abs(c.close-c.open)>v*.5)z+=c.close>c.open?15:-15;
  return{direction:z>=35?"BUY":z<=-35?"SELL":"WAIT",score:Math.round(Math.max(0,Math.min(100,50+z))),reasons};
}
function buildLiquidity(m5,m15,h1,price,a){
  const d=a*.18,p15=findPivots(m15||[],2,2),ph=findPivots(h1||[],3,3),hi=[],lo=[];
  for(const x of m5.slice(-120))hi.push(x.high),lo.push(x.low);
  const eq=(xs)=>{const o=[];for(let i=1;i<xs.length;i++)for(let j=i-1;j>=Math.max(0,i-8);j--)if(Math.abs(xs[i]-xs[j])<=d){o.push((xs[i]+xs[j])/2);break;}return o;};
  const eh=eq(hi),el=eq(lo),buy=[...eh,...ph.filter(x=>x.type==="HIGH").slice(-5).map(x=>x.price),...p15.filter(x=>x.type==="HIGH").slice(-5).map(x=>x.price)].filter(x=>x>price);
  const sell=[...el,...ph.filter(x=>x.type==="LOW").slice(-5).map(x=>x.price),...p15.filter(x=>x.type==="LOW").slice(-5).map(x=>x.price)].filter(x=>x<price);
  return{buySide:uniq(buy,d),sellSide:uniq(sell,d),equalHighs:uniq(eh,d),equalLows:uniq(el,d),previousH1High:ph.filter(x=>x.type==="HIGH").at(-1)?.price??null,previousH1Low:ph.filter(x=>x.type==="LOW").at(-1)?.price??null,nearestBuySide:buy.sort((a,b)=>a-b)[0]??null,nearestSellSide:sell.sort((a,b)=>b-a)[0]??null};
}
function uniq(xs,d){const o=[];for(const x of [...xs].sort((a,b)=>a-b)){if(!o.length||Math.abs(x-o.at(-1))>d)o.push(x);}return o.map(x=>round(x,2));}
function tradePlan(dir,price,m5,m15,levels,a,cfg){
  if(dir==="WAIT")return{active:false,direction:"WAIT",entry:round(price,2),stopLoss:null,tp1:null,tp2:null,tp3:null,rr:null,validRR:false};
  let sl;
  if(dir==="BUY"){const c=[m5.structure.lastSwingLow,m15.structure.lastSwingLow,...levels.lows.filter(x=>x.price<price).map(x=>x.price)].filter(Number.isFinite);sl=(c.length?Math.max(...c):price-a*cfg.m5SL_ATR)-a*.1;if(sl>=price)sl=price-a*cfg.m5SL_ATR;}
  else{const c=[m5.structure.lastSwingHigh,m15.structure.lastSwingHigh,...levels.highs.filter(x=>x.price>price).map(x=>x.price)].filter(Number.isFinite);sl=(c.length?Math.min(...c):price+a*cfg.m5SL_ATR)+a*.1;if(sl<=price)sl=price+a*cfg.m5SL_ATR;}
  const risk=Math.abs(price-sl),tp=(r)=>dir==="BUY"?price+r*risk:price-r*risk;
  return{active:true,direction:dir,entry:round(price,2),stopLoss:round(sl,2),tp1:round(tp(cfg.tp1R),2),tp2:round(tp(cfg.tp2R),2),tp3:round(tp(cfg.tp3R),2),rr:cfg.tp2R,validRR:cfg.tp2R>=cfg.minimumRR};
}
function calcConfidence(dir,h1,m15,m5,w){
  let s=(m15.score+m5.score)/2;if(dir==="BUY"&&h1==="BULLISH")s+=8;if(dir==="SELL"&&h1==="BEARISH")s+=8;if(w.warning)s-=12;
  return{score:Math.round(Math.max(0,Math.min(100,s))),bias:dir==="WAIT"?"NEUTRAL":dir};
}
function signalBias(x){return x==="BUY"?"BULLISH":x==="SELL"?"BEARISH":"NEUTRAL";}
async function getNews(){return{status:"UNKNOWN",reason:"News filter best-effort; no news endpoint required for signal",items:[]};}
function estimateATR(c){return calculateATR(c,Math.min(14,Math.max(1,(c?.length||1)-1)))||0;}
function cleanPivot(x){return{price:x.price,time:x.time,strength:x.strength||"STRUCTURE"};}
function ema(xs,p){if(!xs?.length)return null;const k=2/(p+1);let e=xs[0];for(let i=1;i<xs.length;i++)e=xs[i]*k+e*(1-k);return e;}
function round(x,d=2){return Number.isFinite(x)?Number(x.toFixed(d)):null;}
