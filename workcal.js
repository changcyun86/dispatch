// ══ 工作日曆（管理端 index.html 與員工端 worker.html 共用）══════════════
// 預設：平日 08:00–17:00、午休 12:00–13:00；週六、週日與國定假日休假。
// 管理員在「打卡記錄 → 工作日曆」調整的日子存在 system/workCalendar（days: {日期: {work,start,end,lunch,note}}），整份 1 次讀取。
// 國定假日：依行政院人事行政總處「政府行政機關辦公日曆表」（含補假；115、116 年皆無補班日）。
// ※ 每年需補上新年度資料（人事總處通常在前一年 5～6 月公告）；未內建的年份只會把週末當休假。
(function(){
  const HOLIDAYS={
    // 115 年（2026）
    '2026-01-01':'元旦',
    '2026-02-16':'除夕','2026-02-17':'春節','2026-02-18':'春節','2026-02-19':'春節','2026-02-20':'春節（小年夜補假）',
    '2026-02-27':'和平紀念日補假',
    '2026-04-03':'兒童節補假','2026-04-06':'清明節補假',
    '2026-05-01':'勞動節',
    '2026-06-19':'端午節',
    '2026-09-25':'中秋節','2026-09-28':'教師節',
    '2026-10-09':'國慶日補假',
    '2026-10-26':'光復節補假',
    '2026-12-25':'行憲紀念日',
    // 116 年（2027）
    '2027-01-01':'元旦',
    '2027-02-04':'小年夜','2027-02-05':'除夕','2027-02-08':'春節','2027-02-09':'春節補假','2027-02-10':'春節補假',
    '2027-03-01':'和平紀念日補假',
    '2027-04-05':'清明節','2027-04-06':'兒童節補假',
    '2027-04-30':'勞動節補假',
    '2027-06-09':'端午節',
    '2027-09-15':'中秋節','2027-09-28':'教師節',
    '2027-10-11':'國慶日補假',
    '2027-10-25':'光復節',
    '2027-12-24':'行憲紀念日補假',
    '2027-12-31':'元旦補假（117 年）'
  };
  const HOLIDAY_YEARS=['2026','2027'];
  const DEF={start:'08:00',end:'17:00',lunch:true};
  const pad=n=>String(n).padStart(2,'0');
  const addMin=(hm,m)=>{const[h,mm]=String(hm||'08:00').split(':').map(Number);const t=h*60+mm+m;return pad(Math.floor(t/60))+':'+pad(t%60);};
  const WC={
    HOLIDAYS,HOLIDAY_YEARS,DEF,overrides:{},loaded:false,
    setOverrides(days){this.overrides=days||{};this.loaded=true;},
    weekday(d){return new Date(d+'T00:00:00Z').getUTCDay();},
    // 某一天的設定：{work,start,end,lunch,note,holiday,custom}
    conf(d){
      const wd=this.weekday(d),hol=HOLIDAYS[d]||'';
      const base={work:!(hol||wd===0||wd===6),start:DEF.start,end:DEF.end,lunch:DEF.lunch,note:'',holiday:hol,custom:false};
      const o=this.overrides[d];
      if(!o)return base;
      return{...base,work:!!o.work,start:o.start||DEF.start,end:o.end||DEF.end,lunch:o.lunch!==false,note:o.note||'',custom:true};
    },
    isWork(d){return this.conf(d).work;},
    // 準時上班的最晚時間（上班時間＋10 分鐘寬限）；休假日照預設 08:00 計
    onTime(d){return addMin(this.conf(d).start,10);},
    monthDates(ym){const[y,m]=ym.split('-').map(Number);const n=new Date(Date.UTC(y,m,0)).getUTCDate();const a=[];for(let i=1;i<=n;i++)a.push(`${ym}-${pad(i)}`);return a;},
    workDaysInMonth(ym){return this.monthDates(ym).filter(d=>this.isWork(d)).length;},
    hasHolidayData(ym){return HOLIDAY_YEARS.includes(ym.slice(0,4));}
  };
  window.WC=WC;
})();
