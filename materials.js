// ══════════════════════════════════════════════════════════════
// 耗材領取（index.html 與 worker.html 共用）
// 資料位置（全部是新的，不碰既有資料）：
//   system/materials        耗材品項 {list:[{id,name,spec,unit,price,active}]}
//   system/materialKeepers  耗材管理員 {list:[員工姓名]}
//   system/materialLocks    已鎖定月份 {months:['2026-10'], log:[{month,action,at,by}]}
//   materialRequests/MR-*   領取／退還紀錄
// 紀錄欄位：type 'issue'(領取)|'return'(退還)；status 'pending'(待發放)|'issued'(已發放/已退還)|'cancelled'
//   source 'request'(員工申請)|'walkin'(代登)|'return'；worker；month/date（依發放或退還日，台灣時間）
//   wm = 員工|月份（查詢用）；items [{mid,name,spec,unit,price,reqQty,qty}]；amount（領取為正、退還為負，不四捨五入）
//   refId（退還→原領取單）
// ══════════════════════════════════════════════════════════════
(function(){
const TWnow=()=>new Date(Date.now()+8*3600e3);
const today=()=>TWnow().toISOString().slice(0,10);
const curMonth=()=>today().slice(0,7);
function addMonths(m,k){let[y,mm]=m.split('-').map(Number);mm+=k;while(mm<1){mm+=12;y--;}while(mm>12){mm-=12;y++;}return y+'-'+String(mm).padStart(2,'0');}
function monthsBetween(from,to){const out=[];let m=from.slice(0,7);const end=to.slice(0,7);while(m<=end&&out.length<60){out.push(m);m=addMonths(m,1);}return out;}
let _c=0;const gid=p=>p+'-'+Date.now().toString(36).toUpperCase()+((_c++)%1000).toString(36).toUpperCase();
const nowISO=()=>new Date().toISOString();
const amountOf=(items,sign)=>Number((items.reduce((a,i)=>a+(Number(i.qty)||0)*(Number(i.price)||0),0)*sign).toFixed(4));
const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=x=>{const v=Math.round((Number(x)||0)*100)/100;return(v<0?'-$':'$')+Math.abs(v).toLocaleString();};

const MAT={items:[],keepers:[],locks:{months:[],log:[]},ready:{items:false,keepers:false,locks:false},
  db:null,_subs:[],_cbs:new Set(),_cache:new Map(),
  today,curMonth,addMonths,monthsBetween,esc,money};
function emit(){MAT._cbs.forEach(f=>{try{f();}catch(e){console.error(e);}});}
MAT.onChange=f=>{MAT._cbs.add(f);return()=>MAT._cbs.delete(f);};
MAT.init=function(db){
  if(MAT.db)return;MAT.db=db;
  const sys=db.collection('system');
  sys.doc('materials').onSnapshot(s=>{MAT.items=s.exists?(s.data().list||[]):[];MAT.ready.items=true;emit();},e=>console.warn('materials',e));
  sys.doc('materialKeepers').onSnapshot(s=>{MAT.keepers=s.exists?(s.data().list||[]):[];MAT.ready.keepers=true;emit();},e=>console.warn('keepers',e));
  sys.doc('materialLocks').onSnapshot(s=>{const d=s.exists?s.data():{};MAT.locks={months:d.months||[],log:d.log||[]};MAT.ready.locks=true;emit();},e=>console.warn('locks',e));
};
MAT.isLocked=m=>!!m&&MAT.locks.months.includes(m);
MAT.isKeeper=n=>!!n&&MAT.keepers.includes(n);
MAT.activeItems=()=>MAT.items.filter(i=>i.active!==false);
MAT.itemLabel=i=>`${i.name}${i.spec?' '+i.spec:''}`;
function needReady(){if(!MAT.ready.locks||!MAT.ready.items)throw new Error('資料同步中，請稍候再試 / Đang đồng bộ');}
function col(){return MAT.db.collection('materialRequests');}
function invalidate(){MAT._cache.clear();}

// ── 設定（管理端） ──
MAT.saveItems=async list=>{await MAT.db.collection('system').doc('materials').set({list});};
MAT.saveKeepers=async list=>{await MAT.db.collection('system').doc('materialKeepers').set({list});};
MAT.setLock=async(month,lock,by)=>{
  needReady();
  const months=new Set(MAT.locks.months);lock?months.add(month):months.delete(month);
  const log=[...(MAT.locks.log||[]),{month,action:lock?'lock':'unlock',at:nowISO(),by:by||''}].slice(-200);
  await MAT.db.collection('system').doc('materialLocks').set({months:[...months].sort(),log});
};

// ── 品項明細 ──
function buildItems(rows,useReq){
  const out=[];
  for(const r of rows){
    const qty=Number(r.qty);
    if(!r.mid||!(qty>0))continue;
    if(!Number.isInteger(qty))throw new Error('數量必須是整數 / Số lượng phải là số nguyên');
    const it=MAT.items.find(x=>x.id===r.mid);
    if(!it)throw new Error('找不到耗材品項');
    const row={mid:it.id,name:it.name,spec:it.spec||'',unit:it.unit||'',price:Number(it.price)||0,qty};
    if(useReq)row.reqQty=qty;
    out.push(row);
  }
  if(!out.length)throw new Error('請至少填寫一項數量 / Nhập ít nhất một mục');
  return out;
}
async function getRec(id){const s=await col().doc(id).get();if(!s.exists)throw new Error('找不到此紀錄');return{id:s.id,...s.data()};}
async function returnedMap(origId){
  const snap=await col().where('refId','==',origId).get();
  const m={};
  snap.docs.map(d=>d.data()).filter(r=>r.status==='issued'&&r.type==='return')
    .forEach(r=>r.items.forEach(i=>{m[i.mid]=(m[i.mid]||0)+(Number(i.qty)||0);}));
  return m;
}
MAT.returnedMap=returnedMap;
function checkMonthOpen(m){if(MAT.isLocked(m))throw new Error(`${m} 已鎖定，無法新增或修改 / Tháng đã khóa`);}

// 員工申請（階段二使用）
MAT.request=async(worker,rows)=>{
  needReady();if(!worker)throw new Error('請先登入');
  const items=buildItems(rows,true);
  const id=gid('MR');
  const rec={id,type:'issue',status:'pending',source:'request',worker,wm:worker+'|pending',month:null,date:null,
    items,amount:amountOf(items,1),requestedAt:nowISO(),requestedBy:worker,createdAt:nowISO()};
  await col().doc(id).set(rec);invalidate();return rec;
};
// 代登：直接成為已發放
MAT.walkin=async(worker,rows,by)=>{
  needReady();if(!worker)throw new Error('請選擇員工 / Chọn nhân viên');
  const m=curMonth();checkMonthOpen(m);
  const items=buildItems(rows,true);
  const id=gid('MR');
  const rec={id,type:'issue',status:'issued',source:'walkin',worker,wm:worker+'|'+m,month:m,date:today(),
    items,amount:amountOf(items,1),issuedAt:nowISO(),issuedBy:by,createdAt:nowISO(),createdBy:by};
  await col().doc(id).set(rec);invalidate();return rec;
};
// 確認發放（可修改實發數量；數量 0 的品項不發）
MAT.issue=async(id,qtyMap,by)=>{
  needReady();
  const r=await getRec(id);
  if(r.status!=='pending')throw new Error('此申請已被處理 / Đã được xử lý');
  const m=curMonth();checkMonthOpen(m);
  const items=r.items.map(i=>{
    const q=qtyMap&&qtyMap[i.mid]!=null&&qtyMap[i.mid]!==''?Number(qtyMap[i.mid]):Number(i.reqQty??i.qty);
    if(!(q>=0)||!Number.isInteger(q))throw new Error('數量必須是 0 以上的整數');
    return{...i,qty:q};
  }).filter(i=>i.qty>0);
  if(!items.length)throw new Error('實發數量都是 0，若不發放請按「取消」');
  await col().doc(id).update({status:'issued',items,amount:amountOf(items,1),month:m,date:today(),
    wm:r.worker+'|'+m,issuedAt:nowISO(),issuedBy:by});
  invalidate();
};
// 取消：待發放→取消；已發放（未鎖定）→作廢
MAT.cancel=async(id,by)=>{
  needReady();
  const r=await getRec(id);
  if(r.status==='cancelled')throw new Error('此紀錄已取消');
  if(r.status==='issued'){
    checkMonthOpen(r.month);
    if(r.type==='issue'){
      const ret=await returnedMap(id);
      if(Object.values(ret).some(q=>q>0))throw new Error('此領取已有退還紀錄，請先作廢退還紀錄');
    }
  }
  const upd={status:'cancelled',cancelledAt:nowISO(),cancelledBy:by,prevStatus:r.status};
  if(r.status==='pending')upd.wm=r.worker+'|'+curMonth();
  await col().doc(id).update(upd);
  invalidate();
};
// 員工取消自己尚未發放的申請
MAT.cancelOwn=async(id,worker)=>{
  needReady();
  const r=await getRec(id);
  if(r.worker!==worker)throw new Error('只能取消自己的申請');
  if(r.status!=='pending')throw new Error('已發放或已取消，無法取消 / Không thể hủy');
  await MAT.cancel(id,worker);
};
// 修改已發放的領取（未鎖定）：員工、各品項數量
MAT.edit=async(id,{worker,qtyMap},by)=>{
  needReady();
  const r=await getRec(id);
  if(r.status!=='issued'||r.type!=='issue')throw new Error('只能修改已發放的領取紀錄');
  checkMonthOpen(r.month);
  const ret=await returnedMap(id);
  const hasRet=Object.values(ret).some(q=>q>0);
  if(hasRet&&worker&&worker!==r.worker)throw new Error('已有退還紀錄，不能更改領取人');
  const items=r.items.map(i=>{
    const q=qtyMap&&qtyMap[i.mid]!=null&&qtyMap[i.mid]!==''?Number(qtyMap[i.mid]):Number(i.qty);
    if(!(q>=0)||!Number.isInteger(q))throw new Error('數量必須是 0 以上的整數');
    if(q<(ret[i.mid]||0))throw new Error(`${i.name} 已退還 ${ret[i.mid]}，數量不能少於已退還數量`);
    return{...i,qty:q};
  }).filter(i=>i.qty>0);
  if(!items.length)throw new Error('數量都是 0，若要取消請按「作廢」');
  const w=worker||r.worker;
  await col().doc(id).update({worker:w,wm:w+'|'+r.month,items,amount:amountOf(items,1),
    updatedAt:nowISO(),updatedBy:by});
  invalidate();
};
// 退還：照原領取單價，可部分退還，記在退還當月
MAT.returnItems=async(origId,qtyMap,by)=>{
  needReady();
  const o=await getRec(origId);
  if(o.status!=='issued'||o.type!=='issue')throw new Error('只能退還已發放的領取紀錄');
  const m=curMonth();checkMonthOpen(m);
  const ret=await returnedMap(origId);
  const items=[];
  for(const i of o.items){
    const q=Number(qtyMap&&qtyMap[i.mid]||0);
    if(!q)continue;
    if(!(q>0)||!Number.isInteger(q))throw new Error('數量必須是正整數');
    const left=(Number(i.qty)||0)-(ret[i.mid]||0);
    if(q>left)throw new Error(`${i.name} 最多只能退 ${left}`);
    items.push({mid:i.mid,name:i.name,spec:i.spec||'',unit:i.unit||'',price:Number(i.price)||0,qty:q});
  }
  if(!items.length)throw new Error('請填寫退還數量 / Nhập số lượng trả');
  const id=gid('MR');
  const rec={id,type:'return',status:'issued',source:'return',refId:origId,worker:o.worker,wm:o.worker+'|'+m,
    month:m,date:today(),items,amount:amountOf(items,-1),issuedAt:nowISO(),issuedBy:by,createdAt:nowISO(),createdBy:by};
  await col().doc(id).set(rec);invalidate();return rec;
};

// ── 查詢（只讀需要的範圍） ──
MAT.listenPending=cb=>col().where('status','==','pending').onSnapshot(s=>cb(s.docs.map(d=>({id:d.id,...d.data()}))),e=>console.warn(e));
MAT.listenMonth=(m,cb)=>col().where('month','==',m).onSnapshot(s=>cb(s.docs.map(d=>({id:d.id,...d.data()}))),e=>console.warn(e));
async function getIn(field,vals){
  const out=[];
  for(let i=0;i<vals.length;i+=30){
    const s=await col().where(field,'in',vals.slice(i,i+30)).get();
    s.docs.forEach(d=>out.push({id:d.id,...d.data()}));
  }
  return out;
}
MAT.fetchMonths=async months=>{
  const key='m:'+months.join(',');const c=MAT._cache.get(key);
  if(c&&Date.now()-c.t<30000)return c.v;
  const v=await getIn('month',months);MAT._cache.set(key,{t:Date.now(),v});return v;
};
MAT.fetchWorkerRecent=(worker,n=3)=>getIn('wm',Array.from({length:n},(_,k)=>worker+'|'+addMonths(curMonth(),-k)));
// 各員工在期間內的耗材淨額（領取－退還），不四捨五入
MAT.summarize=(recs,from,to)=>{
  const s={};
  recs.forEach(r=>{if(r.status!=='issued'||!r.date||r.date<from||r.date>to)return;s[r.worker]=(s[r.worker]||0)+(Number(r.amount)||0);});
  return s;
};

// ══ 共用畫面：待發放、代登、紀錄（修改／作廢／退還） ══
// opts: {mode:'admin'|'keeper', by:()=>經手人, employees:()=>員工清單, toast:fn}
MAT.mount=function(el,opts){
  const isK=opts.mode==='keeper';
  const L=(zh,vi)=>isK&&vi?`${zh} / ${vi}`:zh;
  const st={pq:{},month:curMonth(),worker:'',pending:[],recs:[],form:null,busy:false,unsubP:null,unsubM:null,retCache:{}};
  const t=msg=>(opts.toast||alert)(msg);
  function subMonth(){st.unsubM&&st.unsubM();st.recs=[];st.unsubM=MAT.listenMonth(st.month,r=>{st.recs=r;render();});}
  st.unsubP=MAT.listenPending(r=>{st.pending=r;render();});
  subMonth();
  const offChange=MAT.onChange(()=>render());
  async function run(fn,ok){
    if(st.busy)return;st.busy=true;render();
    try{await fn();if(ok)t(ok);st.form=null;}catch(e){t(e.message||String(e));}
    finally{st.busy=false;render();}
  }
  const itemsText=r=>r.items.map(i=>`${esc(i.name)}${i.spec?' '+esc(i.spec):''} ×${i.qty}${i.unit?esc(i.unit):''} @$${i.price}`).join('<br>');
  const matOptions=sel=>'<option value="">選擇耗材 / Chọn vật tư</option>'+MAT.activeItems().map(i=>`<option value="${esc(i.id)}" ${i.id===sel?'selected':''}>${esc(MAT.itemLabel(i))}｜$${i.price}${i.unit?'/'+esc(i.unit):''}</option>`).join('');
  const empOptions=(sel,blank)=>`<option value="">${blank}</option>`+opts.employees().map(e=>`<option value="${esc(e)}" ${e===sel?'selected':''}>${esc(e)}</option>`).join('');
  function formHtml(){
    const f=st.form;if(!f)return'';
    if(f.kind==='walkin'){
      const rows=f.rows.map((r,i)=>`<div style="display:flex;gap:6px;margin-bottom:6px">
        <select data-k="wm" data-i="${i}" style="flex:3">${matOptions(r.mid)}</select>
        <input data-k="wq" data-i="${i}" type="number" min="0" step="1" inputmode="numeric" value="${esc(r.qty)}" placeholder="數量" style="flex:1;min-width:64px">
        <button class="btn btn-sm" data-a="wdel" data-i="${i}">✕</button></div>`).join('');
      const total=f.rows.reduce((a,r)=>{const it=MAT.items.find(x=>x.id===r.mid);return a+(it?(Number(r.qty)||0)*(Number(it.price)||0):0);},0);
      return`<div class="card" style="border:1.5px solid #185FA5">
        <div style="font-weight:600;margin-bottom:8px">${L('代登領取','Đăng ký hộ')}（${MAT.curMonth()}）</div>
        <select data-k="ww" style="margin-bottom:8px">${empOptions(f.worker,L('選擇員工','Chọn nhân viên'))}</select>
        ${rows}
        <button class="btn btn-sm" data-a="wadd" style="margin-bottom:8px">＋ ${L('新增品項','Thêm mục')}</button>
        <div style="font-size:13px;margin-bottom:8px">${L('金額','Số tiền')}：<b data-total="1">${money(total)}</b></div>
        <div style="display:flex;gap:8px"><button class="btn btn-primary btn-sm" data-a="wsave" ${st.busy?'disabled':''}>${L('登記','Lưu')}</button>
        <button class="btn btn-sm" data-a="close">${L('取消','Hủy')}</button></div></div>`;
    }
    const r=f.rec;
    if(f.kind==='edit'){
      return`<div class="card" style="border:1.5px solid #E65100">
        <div style="font-weight:600;margin-bottom:8px">${L('修改領取紀錄','Sửa')}（${esc(r.date)}）</div>
        <select data-k="ew" style="margin-bottom:8px">${empOptions(f.worker,'選擇員工')}</select>
        ${r.items.map(i=>`<div style="display:flex;gap:8px;align-items:center;margin-bottom:6px"><div style="flex:3;font-size:13px">${esc(i.name)} ${esc(i.spec||'')} @$${i.price}</div>
          <input data-k="eq" data-m="${esc(i.mid)}" type="number" min="0" step="1" value="${esc(f.qty[i.mid])}" style="flex:1;min-width:64px"></div>`).join('')}
        <div style="display:flex;gap:8px"><button class="btn btn-primary btn-sm" data-a="esave" ${st.busy?'disabled':''}>${L('儲存','Lưu')}</button>
        <button class="btn btn-sm" data-a="close">${L('取消','Hủy')}</button></div></div>`;
    }
    if(f.kind==='return'){
      const ret=f.ret||{};
      return`<div class="card" style="border:1.5px solid #2E7D32">
        <div style="font-weight:600;margin-bottom:4px">${L('登記退還','Trả lại')}：${esc(r.worker)}（${L('原領取','Ngày lĩnh')} ${esc(r.date)}）</div>
        <div style="font-size:12px;color:#888;margin-bottom:8px">${L('照原領取單價退還，記在本月','Hoàn theo giá cũ, tính vào tháng này')}（${MAT.curMonth()}）</div>
        ${f.loading?'<div style="color:#aaa">載入中...</div>':r.items.map(i=>{const left=(Number(i.qty)||0)-(ret[i.mid]||0);return`<div style="display:flex;gap:8px;align-items:center;margin-bottom:6px">
          <div style="flex:3;font-size:13px">${esc(i.name)} ${esc(i.spec||'')} @$${i.price}<br><span style="font-size:11px;color:#888">${L('已領','Đã lĩnh')} ${i.qty}，${L('已退','Đã trả')} ${ret[i.mid]||0}，${L('可退','Có thể trả')} ${left}</span></div>
          <input data-k="rq" data-m="${esc(i.mid)}" type="number" min="0" max="${left}" step="1" value="${esc(f.qty[i.mid]||'')}" ${left<=0?'disabled':''} style="flex:1;min-width:64px"></div>`;}).join('')}
        <div style="display:flex;gap:8px"><button class="btn btn-primary btn-sm" data-a="rsave" ${st.busy||f.loading?'disabled':''}>${L('登記退還','Lưu trả')}</button>
        <button class="btn btn-sm" data-a="close">${L('取消','Hủy')}</button></div></div>`;
    }
    if(f.kind==='pickReturn'){
      return`<div class="card" style="border:1.5px solid #2E7D32">
        <div style="font-weight:600;margin-bottom:8px">${L('登記退還：選擇員工與原領取紀錄','Trả lại: chọn nhân viên')}</div>
        <select data-k="pw" style="margin-bottom:8px">${empOptions(f.worker,L('選擇員工','Chọn nhân viên'))}</select>
        ${f.loading?'<div style="color:#aaa">載入中...</div>':(f.list||[]).length?f.list.map(r=>`<div style="display:flex;gap:8px;align-items:center;padding:6px 0;border-top:1px solid #eee">
          <div style="flex:1;font-size:12px">${esc(r.date)}｜${itemsText(r)}</div><button class="btn btn-sm" data-a="ret" data-id="${esc(r.id)}">${L('退還','Trả')}</button></div>`).join(''):f.worker?`<div style="color:#aaa;font-size:13px">${L('近三個月沒有領取紀錄','Không có')}</div>`:''}
        <button class="btn btn-sm" data-a="close" style="margin-top:8px">${L('關閉','Đóng')}</button></div>`;
    }
    return'';
  }
  function render(){
    if(!el.isConnected&&!document.body.contains(el))return;
    const locked=MAT.isLocked(st.month),curLocked=MAT.isLocked(curMonth());
    const pend=st.pending.filter(r=>!st.worker||r.worker===st.worker).sort((a,b)=>(a.requestedAt||'').localeCompare(b.requestedAt||''));
    const recs=st.recs.filter(r=>r.status!=='pending'&&(!st.worker||r.worker===st.worker)).sort((a,b)=>(b.issuedAt||b.createdAt||'').localeCompare(a.issuedAt||a.createdAt||''));
    const sums={};recs.forEach(r=>{if(r.status==='issued')sums[r.worker]=(sums[r.worker]||0)+(Number(r.amount)||0);});
    const monthSel=isK?`<button class="btn btn-sm ${st.month===curMonth()?'btn-primary':''}" data-a="mcur">${L('本月','Tháng này')}</button>
        <button class="btn btn-sm ${st.month===addMonths(curMonth(),-1)?'btn-primary':''}" data-a="mprev">${L('上月','Tháng trước')}</button>`
      :`<input type="month" data-k="month" value="${st.month}" style="width:auto">`;
    // 重畫前記住游標所在欄位，重畫後還原（即時更新時不會打斷輸入）
    const ae=document.activeElement;let keep=null;
    if(ae&&el.contains(ae)&&ae.dataset&&ae.dataset.k){keep={sel:['k','i','m','id'].filter(x=>ae.dataset[x]!=null).map(x=>`[data-${x}="${CSS.escape(ae.dataset[x])}"]`).join(''),v:ae.value,tag:ae.tagName};}
    el.innerHTML=`${formHtml()}
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px;align-items:center">
        <button class="btn btn-primary btn-sm" data-a="walkin" ${curLocked?'disabled':''}>＋ ${L('代登領取','Đăng ký hộ')}</button>
        <button class="btn btn-sm" data-a="pickReturn" ${curLocked?'disabled':''}>↩ ${L('登記退還','Trả lại')}</button>
        <select data-k="fw" style="width:auto">${empOptions(st.worker,L('全部員工','Tất cả'))}</select>
        ${curLocked?`<span style="color:#C62828;font-size:12px">${L('本月已鎖定，無法新增','Tháng này đã khóa')}</span>`:''}
      </div>
      <div class="card">
        <div style="font-weight:600;margin-bottom:8px">${L('待發放','Chờ phát')}（${pend.length}）</div>
        ${pend.length?pend.map(r=>`<div style="border-top:1px solid #eee;padding:8px 0">
          <div style="font-size:13px;margin-bottom:6px"><b>${esc(r.worker)}</b> <span style="color:#888;font-size:11px">${esc((r.requestedAt||'').slice(0,10))}</span></div>
          ${r.items.map(i=>`<div style="display:flex;gap:8px;align-items:center;margin-bottom:4px"><div style="flex:3;font-size:12px">${esc(i.name)} ${esc(i.spec||'')} @$${i.price}（${L('申請','Xin')} ${i.reqQty??i.qty}）</div>
            <input data-k="pq" data-id="${esc(r.id)}" data-m="${esc(i.mid)}" type="number" min="0" step="1" value="${esc(st.pq[r.id]&&st.pq[r.id][i.mid]!=null?st.pq[r.id][i.mid]:(i.reqQty??i.qty))}" style="flex:1;min-width:64px"></div>`).join('')}
          <div style="display:flex;gap:8px;margin-top:4px"><button class="btn btn-primary btn-sm" data-a="issue" data-id="${esc(r.id)}" ${st.busy||curLocked?'disabled':''}>✓ ${L('確認發放','Xác nhận phát')}</button>
          <button class="btn btn-sm" data-a="cancelP" data-id="${esc(r.id)}" ${st.busy?'disabled':''}>${L('取消申請','Hủy')}</button></div></div>`).join('')
          :`<div style="color:#aaa;font-size:13px">${L('目前沒有待發放的申請','Không có')}</div>`}
      </div>
      <div class="card">
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px">
          <div style="font-weight:600">${L('領取紀錄','Lịch sử')}</div>${monthSel}
          ${locked?`<span style="background:#FFEBEE;color:#C62828;border-radius:12px;padding:2px 8px;font-size:11px">🔒 ${L('已鎖定','Đã khóa')}</span>`:''}
        </div>
        ${Object.keys(sums).length?`<div style="font-size:12px;color:#555;margin-bottom:8px">${Object.entries(sums).sort().map(([w,v])=>`${esc(w)} ${money(v)}`).join('　')}</div>`:''}
        ${recs.length?`<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:12px;min-width:520px">
          <tr style="background:#f5f5f5"><th style="text-align:left;padding:6px">${L('日期','Ngày')}</th><th style="text-align:left;padding:6px">${L('員工','NV')}</th><th style="text-align:left;padding:6px">${L('品項','Mục')}</th><th style="text-align:right;padding:6px">${L('金額','Tiền')}</th><th style="text-align:left;padding:6px">${L('類型','Loại')}</th><th style="padding:6px"></th></tr>
          ${recs.map(r=>{const can=r.status==='issued'&&!MAT.isLocked(r.month);const kind=r.type==='return'?L('退還','Trả'):r.source==='walkin'?L('代登','Đăng ký hộ'):L('申請','Xin');
            return`<tr style="border-top:1px solid #eee;${r.status==='cancelled'?'color:#bbb;text-decoration:line-through':''}">
            <td style="padding:6px;white-space:nowrap">${esc((r.date||'').slice(5))}</td><td style="padding:6px">${esc(r.worker)}</td><td style="padding:6px">${itemsText(r)}</td>
            <td style="padding:6px;text-align:right;${r.amount<0?'color:#2E7D32':''}">${money(r.amount)}</td>
            <td style="padding:6px;font-size:11px">${kind}${r.status==='cancelled'?'（'+L('已作廢','Đã hủy')+'）':''}<br><span style="color:#aaa">${esc(r.issuedBy||'')}</span></td>
            <td style="padding:6px;white-space:nowrap">${r.status==='issued'&&r.type==='issue'&&!curLocked?`<button class="btn btn-sm" data-a="ret" data-id="${esc(r.id)}">${L('退還','Trả')}</button>`:''}
              ${can&&r.type==='issue'?`<button class="btn btn-sm" data-a="edit" data-id="${esc(r.id)}">${L('修改','Sửa')}</button>`:''}
              ${can?`<button class="btn btn-sm" data-a="void" data-id="${esc(r.id)}">${L('作廢','Hủy')}</button>`:''}</td></tr>`;}).join('')}
        </table></div>`:`<div style="color:#aaa;font-size:13px">${L('此月份沒有紀錄','Không có')}</div>`}
      </div>`;
    if(keep){const n=el.querySelector(keep.tag.toLowerCase()+keep.sel);if(n){if(n.tagName==='INPUT')n.value=keep.v;n.focus();}}
  }
  function findRec(id){return st.recs.find(r=>r.id===id)||(st.form&&st.form.list||[]).find(r=>r.id===id);}
  async function openReturn(id){
    const r=findRec(id);if(!r)return;
    st.form={kind:'return',rec:r,qty:{},loading:true};render();
    try{st.form.ret=await MAT.returnedMap(id);}catch(e){t(e.message);st.form=null;}
    if(st.form)st.form.loading=false;render();
  }
  async function loadPick(){
    const f=st.form;f.loading=true;f.list=[];render();
    try{const l=await MAT.fetchWorkerRecent(f.worker,3);
      if(st.form===f){f.list=l.filter(r=>r.type==='issue'&&r.status==='issued').sort((a,b)=>(b.date||'').localeCompare(a.date||''));}}
    catch(e){t(e.message);}
    f.loading=false;render();
  }
  el.addEventListener('input',e=>{
    const k=e.target.dataset.k,f=st.form;if(!k)return;
    if(k==='wq'&&f){f.rows[+e.target.dataset.i].qty=e.target.value;
      // 只更新金額文字，不重畫（重畫會讓緊接著的「登記」點擊失效）
      const tEl=el.querySelector('[data-total]');
      if(tEl)tEl.textContent=money(f.rows.reduce((a,r)=>{const it=MAT.items.find(x=>x.id===r.mid);return a+(it?(Number(r.qty)||0)*(Number(it.price)||0):0);},0));}
    if(k==='eq'&&f)f.qty[e.target.dataset.m]=e.target.value;
    if(k==='rq'&&f)f.qty[e.target.dataset.m]=e.target.value;
    if(k==='pq'){const id=e.target.dataset.id;(st.pq[id]=st.pq[id]||{})[e.target.dataset.m]=e.target.value;}
  });
  el.addEventListener('change',e=>{
    const k=e.target.dataset.k,f=st.form;if(!k)return;
    if(k==='wm'&&f){f.rows[+e.target.dataset.i].mid=e.target.value;render();}
    if(k==='ww'&&f)f.worker=e.target.value;
    if(k==='ew'&&f)f.worker=e.target.value;
    if(k==='pw'&&f){f.worker=e.target.value;if(f.worker)loadPick();else{f.list=[];render();}}
    if(k==='fw'){st.worker=e.target.value;render();}
    if(k==='month'&&e.target.value){st.month=e.target.value;subMonth();render();}
  });
  el.addEventListener('click',e=>{
    const b=e.target.closest('[data-a]');if(!b)return;
    const a=b.dataset.a,id=b.dataset.id,by=opts.by();
    if(a==='walkin'){st.form={kind:'walkin',worker:st.worker||'',rows:[{mid:'',qty:''}]};render();}
    else if(a==='wadd'){st.form.rows.push({mid:'',qty:''});render();}
    else if(a==='wdel'){st.form.rows.splice(+b.dataset.i,1);if(!st.form.rows.length)st.form.rows.push({mid:'',qty:''});render();}
    else if(a==='close'){st.form=null;render();}
    else if(a==='wsave'){const f=st.form;
      const total=f.rows.reduce((s,r)=>{const it=MAT.items.find(x=>x.id===r.mid);return s+(it?(Number(r.qty)||0)*(Number(it.price)||0):0);},0);
      if(!confirm(`確認代登 ${f.worker||''} 領取，金額 ${money(total)}？`))return;
      run(()=>MAT.walkin(f.worker,f.rows,by),'已登記 / Đã lưu ✓');}
    else if(a==='issue'){const q={};el.querySelectorAll(`input[data-k="pq"][data-id="${CSS.escape(id)}"]`).forEach(i=>q[i.dataset.m]=i.value);
      run(()=>MAT.issue(id,q,by),'已發放 / Đã phát ✓');}
    else if(a==='cancelP'){if(!confirm('確定取消此申請？ / Hủy?'))return;run(()=>MAT.cancel(id,by),'已取消');}
    else if(a==='void'){if(!confirm('確定作廢此紀錄？作廢後不計入扣款。'))return;run(()=>MAT.cancel(id,by),'已作廢');}
    else if(a==='edit'){const r=findRec(id);if(!r)return;st.form={kind:'edit',rec:r,worker:r.worker,qty:Object.fromEntries(r.items.map(i=>[i.mid,i.qty]))};render();}
    else if(a==='esave'){const f=st.form;run(()=>MAT.edit(f.rec.id,{worker:f.worker,qtyMap:f.qty},by),'已修改 / Đã sửa ✓');}
    else if(a==='pickReturn'){st.form={kind:'pickReturn',worker:st.worker||'',list:[]};render();if(st.worker)loadPick();}
    else if(a==='ret'){openReturn(id);}
    else if(a==='rsave'){const f=st.form;run(()=>MAT.returnItems(f.rec.id,f.qty,by),'已登記退還 / Đã trả ✓');}
    else if(a==='mcur'){st.month=curMonth();subMonth();render();}
    else if(a==='mprev'){st.month=addMonths(curMonth(),-1);subMonth();render();}
  });
  render();
  return{unmount(){st.unsubP&&st.unsubP();st.unsubM&&st.unsubM();offChange();el.innerHTML='';},render};
};
// ══ 員工端：申請領取、我的紀錄、本月已領金額 ══
// 只讀自己的資料：本月、上月、待發放（wm in 三個值）
MAT.mountWorker=function(el,opts){
  const me=opts.worker;
  const st={qty:{},recs:[],busy:false,loaded:false,unsub:null};
  const t=msg=>(opts.toast||alert)(msg);
  const cm=curMonth(),pm=addMonths(cm,-1);
  st.unsub=col().where('wm','in',[me+'|'+cm,me+'|'+pm,me+'|pending']).onSnapshot(s=>{
    st.recs=s.docs.map(d=>({id:d.id,...d.data()}));st.loaded=true;render();
  },e=>console.warn(e));
  const offChange=MAT.onChange(()=>render());
  function total(){return MAT.activeItems().reduce((a,i)=>a+(Number(st.qty[i.id])||0)*(Number(i.price)||0),0);}
  function render(){
    const ae=document.activeElement;let keep=null;
    if(ae&&el.contains(ae)&&ae.dataset&&ae.dataset.mid)keep={mid:ae.dataset.mid,v:ae.value};
    const items=MAT.activeItems();
    const monthSum=st.recs.filter(r=>r.status==='issued'&&r.month===cm).reduce((a,r)=>a+(Number(r.amount)||0),0);
    const lastSum=st.recs.filter(r=>r.status==='issued'&&r.month===pm).reduce((a,r)=>a+(Number(r.amount)||0),0);
    const pend=st.recs.filter(r=>r.status==='pending').sort((a,b)=>(b.requestedAt||'').localeCompare(a.requestedAt||''));
    const hist=st.recs.filter(r=>r.status!=='pending').sort((a,b)=>(b.issuedAt||b.cancelledAt||b.createdAt||'').localeCompare(a.issuedAt||a.cancelledAt||a.createdAt||''));
    const line=r=>r.items.map(i=>`${esc(i.name)}${i.spec?' '+esc(i.spec):''} ×${i.qty} @$${i.price}`).join('<br>');
    el.innerHTML=`
      <div class="card" style="text-align:center">
        <div style="font-size:12px;color:#888">本月已領耗材 / Vật tư đã lĩnh tháng này</div>
        <div style="font-size:24px;font-weight:700;color:#C62828">${st.loaded?money(Math.round(monthSum)):'…'}</div>
        <div style="font-size:11px;color:#aaa">上月 / Tháng trước：${st.loaded?money(Math.round(lastSum)):'…'}　（從薪資扣除 / Trừ vào lương）</div>
      </div>
      <div class="card">
        <div style="font-weight:600;margin-bottom:8px">申請領取 / Xin lĩnh vật tư</div>
        ${items.length?items.map(i=>`<div style="display:flex;gap:8px;align-items:center;padding:6px 0;border-top:1px solid #f0f0f0">
          <div style="flex:3;font-size:13px">${esc(i.name)}${i.spec?' <span style="color:#888">'+esc(i.spec)+'</span>':''}<br><span style="font-size:12px;color:#185FA5">$${i.price}${i.unit?' / '+esc(i.unit):''}</span></div>
          <input data-mid="${esc(i.id)}" type="number" min="0" step="1" inputmode="numeric" placeholder="0" value="${esc(st.qty[i.id]||'')}" style="flex:1;min-width:64px;text-align:center"></div>`).join('')
          :'<div style="color:#aaa;font-size:13px">目前沒有可申請的耗材 / Chưa có vật tư</div>'}
        ${items.length?`<div style="display:flex;justify-content:space-between;align-items:center;margin-top:10px">
          <div style="font-size:13px">金額 / Số tiền：<b data-total="1">${money(total())}</b></div>
          <button class="btn btn-primary" data-a="submit" ${st.busy?'disabled':''}>送出申請 / Gửi</button></div>`:''}
      </div>
      <div class="card">
        <div style="font-weight:600;margin-bottom:8px">我的申請與領取 / Lịch sử của tôi</div>
        ${pend.map(r=>`<div style="border-top:1px solid #eee;padding:8px 0;display:flex;gap:8px;align-items:center">
          <div style="flex:1;font-size:12px"><span style="background:#FFF3E0;color:#E65100;border-radius:10px;padding:1px 8px;font-size:11px">待發放 / Chờ phát</span><br>${line(r)}</div>
          <button class="btn btn-sm" data-a="cancel" data-id="${esc(r.id)}" ${st.busy?'disabled':''}>取消 / Hủy</button></div>`).join('')}
        ${hist.map(r=>{const tag=r.status==='cancelled'?['#f5f5f5','#999','已取消 / Đã hủy']:r.type==='return'?['#E8F5E9','#2E7D32','已退還 / Đã trả']:['#E3F2FD','#185FA5','已領取 / Đã lĩnh'];
          return`<div style="border-top:1px solid #eee;padding:8px 0;font-size:12px;${r.status==='cancelled'?'color:#aaa':''}">
          <span style="background:${tag[0]};color:${tag[1]};border-radius:10px;padding:1px 8px;font-size:11px">${tag[2]}</span>
          <span style="color:#888">${esc(r.date||(r.cancelledAt||'').slice(0,10))}</span>
          <span style="float:right;font-weight:600;${r.amount<0?'color:#2E7D32':''}">${r.status==='cancelled'?'':money(r.amount)}</span><br>${line(r)}</div>`;}).join('')}
        ${!pend.length&&!hist.length?`<div style="color:#aaa;font-size:13px">${st.loaded?'本月與上月沒有紀錄 / Không có':'載入中... / Đang tải...'}</div>`:''}
      </div>`;
    if(keep){const n=el.querySelector(`input[data-mid="${CSS.escape(keep.mid)}"]`);if(n){n.value=keep.v;n.focus();}}
  }
  el.addEventListener('input',e=>{
    const mid=e.target.dataset.mid;if(!mid)return;
    st.qty[mid]=e.target.value;
    const tEl=el.querySelector('[data-total]');if(tEl)tEl.textContent=money(total());
  });
  el.addEventListener('click',async e=>{
    const b=e.target.closest('[data-a]');if(!b||st.busy)return;
    if(b.dataset.a==='submit'){
      const rows=Object.entries(st.qty).filter(([,q])=>Number(q)>0).map(([mid,qty])=>({mid,qty}));
      if(!rows.length)return t('請填寫數量 / Nhập số lượng');
      if(!confirm(`確認送出申請？金額 ${money(total())}\nXác nhận gửi?`))return;
      st.busy=true;render();
      try{await MAT.request(me,rows);st.qty={};t('已送出申請 / Đã gửi ✓');}catch(err){t(err.message||String(err));}
      finally{st.busy=false;render();}
    }
    if(b.dataset.a==='cancel'){
      if(!confirm('確定取消此申請？ / Hủy yêu cầu này?'))return;
      st.busy=true;render();
      try{await MAT.cancelOwn(b.dataset.id,me);t('已取消 / Đã hủy');}catch(err){t(err.message||String(err));}
      finally{st.busy=false;render();}
    }
  });
  render();
  return{unmount(){st.unsub&&st.unsub();offChange();el.innerHTML='';}};
};
window.MAT=MAT;
})();
