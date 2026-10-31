// ══ 工時／產能分析：計算核心（productivity.js）══
// 純計算，不讀寫資料庫。輸入：回報事件、打卡、派工、手動排除；輸出：每日切分結果與月份彙總。
// 規則（2026/10/31 確認）：
//  - 以「員工 × 日期」為單位，依回報時間切段：上班打卡（早於 08:00 以 08:00 計）→ 第一次回報 = 第一段，之後每兩次回報之間 = 後一筆的工時
//  - 最後一次回報 = 當天結束；跨到 12:00–13:00 的段落扣午休
//  - 多日工作：「今天還在做」之前的時段記在該派工，跨日累加，最後一天回報數量時才計入
//  - 5 分鐘內連續回報：同品名＋規格 → 合併成一段；不同品名 → 整串不列入
//  - 一筆工作（同一次回報的派工、多日工作的各天）只要有一段不可靠，整筆不列入
//  - 產能只算完成量；品名＋規格分開
(function(root){
  const SHORT=300;                 // 5 分鐘（秒）
  const DAY_START=8*3600;          // 08:00
  const L0=12*3600,L1=13*3600;     // 午休
  const SKEW_WARN=120;             // 手機時間與伺服器差超過 2 分鐘 → 提醒

  function twSecOf(iso){const t=Date.parse(iso);if(isNaN(t))return null;return((t+8*3600e3)/1000)%86400;}
  function hmSec(s){if(!s||typeof s!=='string')return null;const m=s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?/);if(!m)return null;return(+m[1])*3600+(+m[2])*60+(+(m[3]||0));}
  function tsMillis(v){if(!v)return null;if(typeof v.toMillis==='function')return v.toMillis();if(typeof v.seconds==='number')return v.seconds*1000+Math.floor((v.nanoseconds||0)/1e6);if(typeof v._seconds==='number')return v._seconds*1000;const t=Date.parse(v);return isNaN(t)?null:t;}
  function twDate(iso){const t=Date.parse(iso);if(isNaN(t))return'';return new Date(t+8*3600e3).toISOString().slice(0,10);}
  function workDate(d){return d.effectiveDate||twDate(d.createdAt);}
  function lunchOverlap(s,e){return Math.max(0,Math.min(e,L1)-Math.max(s,L0));}
  function keyOf(n,s){return`${n||''}||${s||''}`;}

  // 並查集：同一次回報的派工、同品名合併的段落 → 同一筆工作
  function UF(){const p={};const f=x=>{if(p[x]===undefined)p[x]=x;while(p[x]!==x){p[x]=p[p[x]];x=p[x];}return x;};return{find:f,union:(a,b)=>{a=f(a);b=f(b);if(a!==b)p[b]=a;}};}

  function compute(input){
    const events=(input.events||[]).filter(e=>e&&e.worker&&e.date&&e.at&&Array.isArray(e.dispatchIds)&&e.dispatchIds.length);
    const dispMap={};(input.dispatches||[]).forEach(d=>{dispMap[String(d.id)]=d;});
    const ciMap={};(input.checkins||[]).forEach(c=>{if(c&&c.worker&&c.date)ciMap[c.worker+'|'+c.date]=c;});
    const manual={};(input.excludes||[]).forEach(x=>{if(x&&x.w&&x.d)manual[x.w+'|'+x.d]=x;});
    if(!events.length)return{startDate:null,days:[],jobs:[],months:{}};
    const startDate=events.reduce((m,e)=>e.date<m?e.date:m,events[0].date);

    // ── 有事件涵蓋的派工；沒有事件、卻有數量的派工 → 管理端代填，當天不列入 ──
    const covered=new Set();events.forEach(e=>e.dispatchIds.forEach(id=>covered.add(String(id))));
    const adminFill={};
    (input.dispatches||[]).forEach(d=>{
      const q=(d.doneQty||0)+(d.defectQty||0)+(d.shortageQty||0);
      if(q<=0||covered.has(String(d.id)))return;
      const wd=workDate(d);if(!wd||wd<startDate)return;
      (adminFill[d.worker+'|'+wd]=adminFill[d.worker+'|'+wd]||[]).push(d);
    });

    // ── 依員工 × 日期分組 ──
    const byDay={};
    events.forEach(e=>{(byDay[e.worker+'|'+e.date]=byDay[e.worker+'|'+e.date]||[]).push(e);});

    const uf=UF();
    const reportCount={};      // 派工 id → 第一次回報事件數（>1 表示重複）
    const days=[];
    const allSegs=[];

    Object.keys(byDay).sort().forEach(k=>{
      const [w,d]=[k.slice(0,k.lastIndexOf('|')),k.slice(k.lastIndexOf('|')+1)];
      const evs=byDay[k].slice().sort((a,b)=>a.at.localeCompare(b.at));
      const ci=ciMap[k];
      const inSec=ci?hmSec(ci.inTime):null;
      const startSec=inSec===null?null:Math.max(inSec,DAY_START);
      const day={w,d,inTime:ci&&ci.inTime||null,start:startSec,flags:[],warns:[],segs:[]};
      if(manual[k])day.flags.push('手動排除'+(manual[k].note?`（${manual[k].note}）`:''));
      if(adminFill[k])day.flags.push(`管理端代填數量（${adminFill[k].map(x=>x.orderName).join('、')}）`);

      // 原始段落
      let prev=startSec;
      const raw=evs.map(ev=>{
        const t=twSecOf(ev.at);
        const ids=ev.dispatchIds.map(String);
        const f=ids.map(id=>dispMap[id]).find(Boolean);
        const n=f?f.orderName:(ev.orderName||''),sp=f?(f.orderSpec||''):(ev.orderSpec||'');
        const sv=tsMillis(ev.serverAt);
        if(sv!==null){const diff=Math.round((Date.parse(ev.at)-sv)/1000);if(Math.abs(diff)>SKEW_WARN)day.warns.push(`${n} 回報時手機時間與伺服器相差 ${Math.round(diff/60)} 分鐘`);}
        ids.forEach(id=>uf.find(id));
        for(let i=1;i<ids.length;i++)uf.union(ids[0],ids[i]);
        if(ev.kind!=='still')ids.forEach(id=>{reportCount[id]=(reportCount[id]||0)+1;});
        const seg={s:prev,e:t,ids,n,sp,key:keyOf(n,sp),kinds:[ev.kind==='still'?'still':'report'],cnt:1,ex:null};
        prev=t;
        return seg;
      });

      // 5 分鐘內連續回報 → 成串處理
      const segs=[];
      let i=0;
      while(i<raw.length){
        let j=i;
        while(j+1<raw.length&&raw[j+1].s!==null&&raw[j+1].e-raw[j+1].s<SHORT)j++;
        const run=raw.slice(i,j+1);
        if(run.length===1){segs.push(run[0]);}
        else if(run.every(x=>x.key===run[0].key)){
          const m={...run[0],e:run[run.length-1].e,ids:[...new Set(run.flatMap(x=>x.ids))],kinds:[...new Set(run.flatMap(x=>x.kinds))],cnt:run.length};
          for(let q=1;q<m.ids.length;q++)uf.union(m.ids[0],m.ids[q]);
          segs.push(m);
        }else{
          run.forEach(x=>{x.ex='5 分鐘內連續回報不同品名';x.run=run.length;segs.push(x);});
        }
        i=j+1;
      }

      segs.forEach(sg=>{
        if(!sg.ex){
          if(sg.s===null)sg.ex='沒有上班打卡';
          else if(sg.e===null||sg.e<=sg.s)sg.ex='回報時間早於起算時間';
          else if(sg.e-sg.s<SHORT)sg.ex='距上班不到 5 分鐘';
        }
        if(!sg.ex&&day.flags.length)sg.ex=day.flags[0].startsWith('手動')?'手動排除這天':'這天有管理端代填數量';
        const ok=sg.s!==null&&sg.e!==null&&sg.e>sg.s;
        sg.lunch=ok?lunchOverlap(sg.s,sg.e):0;
        sg.sec=ok?Math.max(0,sg.e-sg.s-sg.lunch):0;
        sg.w=w;sg.d=d;
        day.segs.push(sg);allSegs.push(sg);
      });
      days.push(day);
    });

    // ── 組成工作（job）──
    const jobMap={};
    allSegs.forEach(sg=>{
      const r=uf.find(sg.ids[0]);
      const j=jobMap[r]=jobMap[r]||{root:r,w:sg.w,ids:new Set(),sec:0,exSeg:[],reportDates:[],dates:new Set(),n:sg.n,sp:sg.sp};
      sg.ids.forEach(id=>j.ids.add(id));
      j.dates.add(sg.d);
      if(sg.ex)j.exSeg.push(`${sg.d} ${sg.ex}`);else j.sec+=sg.sec;
      if(sg.kinds.includes('report'))j.reportDates.push(sg.d);
      sg.job=j;
    });
    const jobs=Object.values(jobMap).map(j=>{
      const ids=[...j.ids];
      const ds=ids.map(id=>dispMap[id]);
      const why=[];
      let status='列入';
      if(!j.reportDates.length)status='進行中';
      if(ds.some(x=>!x))why.push('找不到派工資料');
      if(ids.some(id=>(reportCount[id]||0)>1))why.push('同一張派工有多次首次回報');
      if(ds.some(x=>x&&Array.isArray(x.stillDays)&&x.stillDays.some(s=>s&&s.rejected)))why.push('「今天還在做」被駁回');
      if(j.exSeg.length)why.push('有不可靠的時段：'+[...new Set(j.exSeg)].join('；'));
      const done=ds.reduce((a,x)=>a+(x?(x.doneQty||0):0),0);
      if(status!=='進行中'&&!why.length&&done<=0)why.push('完成量為 0');
      if(status!=='進行中'&&!why.length&&j.sec<=0)why.push('工時為 0');
      if(status!=='進行中'&&why.length)status='不列入';
      const finalDate=j.reportDates.length?j.reportDates.slice().sort().pop():null;
      const out={w:j.w,n:j.n,sp:j.sp,key:keyOf(j.n,j.sp),ids,done,sec:j.sec,days:j.dates.size,status,why,finalDate};
      j.out=out;
      return out;
    });
    allSegs.forEach(sg=>{sg.jobOut=sg.job.out;delete sg.job;});

    // ── 月份彙總：月份 → 品名||規格 → 員工 ──
    const months={};
    jobs.forEach(j=>{
      if(j.status!=='列入')return;
      const m=j.finalDate.slice(0,7);
      const mk=months[m]=months[m]||{};
      const pk=mk[j.key]=mk[j.key]||{n:j.n,sp:j.sp,w:{}};
      const x=pk.w[j.w]=pk.w[j.w]||{q:0,t:0,j:0};
      x.q+=j.done;x.t+=j.sec;x.j+=1;
    });
    return{startDate,days,jobs,months};
  }

  // 寫入 system/productivity 的內容（小文件：管理端開啟時讀這一份）
  function buildSummaryDoc(res,computedAt){
    const months={};
    Object.keys(res.months).sort().forEach(m=>{
      const arr=[];
      Object.values(res.months[m]).forEach(p=>Object.keys(p.w).forEach(w=>{const x=p.w[w];arr.push({n:p.n,s:p.sp,w,q:x.q,t:Math.round(x.t),j:x.j});}));
      months[m]=arr;
    });
    const cnt={列入:0,不列入:0,進行中:0};res.jobs.forEach(j=>cnt[j.status]++);
    return{v:1,computedAt,startDate:res.startDate,jobCount:cnt,months};
  }

  // 寫入 system/productivityDays 的內容（最近 N 天的切分明細，只有看明細時才讀）
  function buildDaysDoc(res,computedAt,fromDate){
    const days=res.days.filter(d=>d.d>=fromDate).map(d=>({
      w:d.w,d:d.d,in:d.inTime,st:d.start,flags:d.flags,warns:[...new Set(d.warns)],
      segs:d.segs.map(s=>({s:s.s===null?null:Math.round(s.s),e:s.e===null?null:Math.round(s.e),sec:Math.round(s.sec),l:Math.round(s.lunch),
        n:s.n,sp:s.sp,k:s.kinds.join(','),c:s.cnt,ex:s.ex,
        js:s.jobOut.status,jw:s.jobOut.why.join('；'),jq:s.jobOut.done,jt:Math.round(s.jobOut.sec),jd:s.jobOut.days}))
    }));
    return{v:1,computedAt,from:fromDate,days};
  }

  // 依期間（月份範圍）加總：回傳 { key: {n,sp,q,t,j,w:{員工:{q,t,j}}} }
  function aggregate(summary,fromMonth,toMonth){
    const out={};
    Object.keys((summary&&summary.months)||{}).forEach(m=>{
      if(fromMonth&&m<fromMonth)return;if(toMonth&&m>toMonth)return;
      summary.months[m].forEach(r=>{
        const k=keyOf(r.n,r.s);
        const p=out[k]=out[k]||{n:r.n,sp:r.s,q:0,t:0,j:0,w:{}};
        p.q+=r.q;p.t+=r.t;p.j+=r.j;
        const x=p.w[r.w]=p.w[r.w]||{q:0,t:0,j:0};x.q+=r.q;x.t+=r.t;x.j+=r.j;
      });
    });
    return out;
  }

  const api={compute,buildSummaryDoc,buildDaysDoc,aggregate,keyOf,_twSecOf:twSecOf,_hmSec:hmSec};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  root.PROD=api;
})(typeof window!=='undefined'?window:globalThis);
