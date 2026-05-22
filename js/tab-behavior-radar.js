/**
 * tab-behavior-radar.js  (patched: Fix1+Fix2+Fix3+Insights)
 * 升級內容：
 *   - 雙層雷達圖：疊加「及格群全體基準線」（灰色虛線）
 *   - _renderInsights()：自動文字差距洞察
 *   - _renderRecommendations()：規則式行動建議
 *   - _exportClusterCSV()：一鍵匯出當前分群學生名單
 */
const BehaviorRadarTab = (() => {
  const DIM_LABELS = {
    AUD:"AUD 聽覺教材",VID:"VID 影音教材",TXT:"TXT 文字教材",
    SUP:"SUP 補充筆記",TUT:"TUT 輔導資源",QUZ:"QUZ 題庫測驗",
    aud_completion_rate:"聽覺教材",vid_completion_rate:"影音教材",
    txt_completion_rate:"文字教材",sup_completion_rate:"補充筆記",
    tut_ratio:"輔導資源",quz_pass_rate:"題庫通過率",
    consistency_score:"學習穩定性",material_diversity:"教材多樣性",
  };
  const CLUSTER_COLORS = {
    P0:{border:"rgba(100,100,100,0.9)",bg:"rgba(100,100,100,0.12)"},
    P1:{border:"rgba(52,152,219,0.9)",bg:"rgba(52,152,219,0.15)"},
    P2:{border:"rgba(46,204,113,0.9)",bg:"rgba(46,204,113,0.15)"},
    P3:{border:"rgba(155,89,182,0.9)",bg:"rgba(155,89,182,0.15)"},
    P4:{border:"rgba(230,126,34,0.9)",bg:"rgba(230,126,34,0.15)"},
    P5:{border:"rgba(189,195,199,0.9)",bg:"rgba(189,195,199,0.15)"},
    pass:{border:"rgba(39,174,96,0.9)",bg:"rgba(39,174,96,0.12)"},
    fail:{border:"rgba(192,57,43,0.9)",bg:"rgba(192,57,43,0.12)"},
  };
  const CLUSTER_NAMES = {
    P0:"無分群（全體）",P1:"影音輔導型",P2:"彈性聽覺型",
    P3:"平均使用型",P4:"題庫刷題型",P5:"被動低參與型",
  };
  const DIM_FEATURE_MAP = {
    AUD:"aud_completion_rate",VID:"vid_completion_rate",TXT:"txt_completion_rate",
    SUP:"sup_completion_rate",TUT:"tut_completion_rate",QUZ:"quz_completion_rate",
  };
  const RANK_MEDALS=["🥇","🥈","🥉"];

  // ── 洞察設定 ──────────────────────────────────────────────
  const INSIGHT_THRESHOLD = 0.05;   // 差距 ≥ 5% 才列入洞察
  const MIN_PASS_COUNT    = 10;     // 及格樣本數低於此值時 fallback 至全體基準

  // DIM_NAMES_ZH 已合併至 DIM_LABELS，直接複用
  const DIM_NAMES_ZH = DIM_LABELS;

  // 各維度缺乏時的行動建議（弱點→建議文字）
  const RECOMMENDATION_MAP = {
    AUD: { action:"建議教師提醒本群學生補聽音頻教材，強化語音輸入吸收。", icon:"🎧" },
    VID: { action:"建議教師針對本群推送教學影片學習提醒，提升影音教材完成率。", icon:"📹" },
    TXT: { action:"建議引導學生閱讀文字教材與講義，提升文本理解能力。", icon:"📖" },
    SUP: { action:"建議提醒學生善用補充筆記與整理資源，強化知識架構。", icon:"📝" },
    TUT: { action:"建議鼓勵本群學生積極使用輔導資源，尋求教師或同儕支援。", icon:"🧑‍🏫" },
    QUZ: { action:"建議教師針對本群發送推播，提醒增加題庫演練時間，強化輸出練習。", icon:"📋" },
  };

  let _radarChart=null,_radarData=null,_behaviorMeta={};
  let _behaviorStudents=[],_allStudents=[],_allSemesters=[];
  let _selectedSemester="all",_selectedCluster="P0",_passFilter="all",_semesterFilterNote=null;

  // WARN-1：分群計算結果快取（key: `${cluster}|${passFilter}|${semester}` → result）
  const _computeCache = new Map();
  function _invalidateComputeCache() { _computeCache.clear(); }

  // 模組層級：讀取深色模式，避免每次 render 重建 closure
  function _isDark(){return document.documentElement.classList.contains('dark')||window.matchMedia('(prefers-color-scheme:dark)').matches;}

  function _dimensions(){
    const e=_radarData?.dimensions||_radarData?.meta?.dimensions;
    if(e?.length)return e;
    const fc=Object.values(_clusterRows()).find(r=>Array.isArray(r?.values));
    if(fc?.values?.length===6)return["AUD","VID","TXT","SUP","TUT","QUZ"];
    return fc?.values?.map((_,i)=>`D${i+1}`)||[];
  }
  function _clusterRows(){return _radarData?.clusters||_radarData||{};}
  function _nonEmpty(v){return v!==undefined&&v!==null&&v!==""&&!(Array.isArray(v)&&v.length===0);}
  function _mergedMeta(){
    const m={};
    [_behaviorMeta||{},_radarData?.meta||{}].forEach(s=>{Object.entries(s).forEach(([k,v])=>{if(_nonEmpty(v))m[k]=v;});});
    return m;
  }
  function _clampRate(v){const n=Number(v);return Number.isFinite(n)?Math.max(0,Math.min(n,1)):0;}
  function _values(row,dims){
    if(!row)return[];
    const raw=Array.isArray(row.values)?row.values:dims.map(d=>row[d]??row[String(d).toLowerCase()]??0);
    return raw.map(_clampRate);
  }
  function _clusterTotal(){
    const rows=_clusterRows();
    const t=Object.values(rows).reduce((s,r)=>s+(Number(r?.count)||0),0);
    return t||Number(_mergedMeta()?.student_count)||0;
  }
  function _formatSemester(sem){
    const s=String(sem||"").trim(),m=s.match(/^(\d{3})-?([12])$/);
    return m?`${m[1]}(${m[2]})`:s;
  }
  function _semesterText(meta={}){
    if(meta.semester_range_label)return meta.semester_range_label;
    if(meta.semester_range)return meta.semester_range;
    const sems=(meta.semesters||[]).filter(Boolean);
    if(sems.length){const l=sems.map(_formatSemester);return l[0]===l[l.length-1]?l[0]:`${l[0]}-${l[l.length-1]}`;}
    return _formatSemester(meta.semester)||"未標示";
  }
  function _formatDateTime(v){if(!v)return"未標示";return String(v).replace("T"," ").slice(0,16);}

  // behavior.json 已由 ETL 回填 final_score / edu_type，直接使用，無需再 join DATA
  function _enrichBehaviorStudents(students){
    return (students || []).filter(s => s.masked_id && s.features);
  }

  function _renderBehaviorMetaStrip(){
    const meta=_mergedMeta(),total=_clusterTotal();
    const semText=_selectedSemester&&_selectedSemester!=="all"?_formatSemester(_selectedSemester):_semesterText(meta);
    const updateTime=_formatDateTime(meta.generated_at);
    const badge=document.getElementById("behaviorRangeBadge");
    if(badge&&total){badge.style.display="inline-flex";badge.title=`行為資料更新：${updateTime}`;badge.textContent=`行為 ${semText} · ${total.toLocaleString()}人`;}
    const strip=document.getElementById("behaviorMetaStrip");
    if(strip)strip.style.display="none";
  }

  async function init(canvasId="radarChart",controlsId="radarControls"){
    BehaviorLoader.setLoading("tab-behavior",true);
    try{
      const[radarData,behaviorData]=await Promise.all([BehaviorLoader.load.radar(),BehaviorLoader.load.behavior().catch(()=>null)]);
      _radarData=radarData;_behaviorMeta=behaviorData?.meta||{};
      _behaviorStudents=_enrichBehaviorStudents(behaviorData?.students||[]);_allStudents=_behaviorStudents;
      _allSemesters=Array.isArray(_behaviorMeta.semesters)&&_behaviorMeta.semesters.length?[..._behaviorMeta.semesters]:[];
      _selectedSemester="all";_selectedCluster="P0";_passFilter="all";_semesterFilterNote=null;
      _invalidateComputeCache();  // WARN-1：資料重載時清除快取
      _renderBehaviorMetaStrip();
      _renderControls(controlsId);
      renderClusterSummary("clusterSummaryCards");
      _renderRadar(canvasId);
      _renderInsights();
    }catch(err){BehaviorLoader.showError("tab-behavior",err.message);}
    finally{BehaviorLoader.setLoading("tab-behavior",false);}
  }

  function _renderControls(containerId){
    const el=document.getElementById(containerId);if(!el)return;
    const semOpts=[
      `<option value="all">全部年度（${_behaviorMeta.semester_range_label||_behaviorMeta.semester_range||"—"}）</option>`,
      ..._allSemesters.map(s=>`<option value="${s}"${s===_selectedSemester?" selected":""}>${_formatSemester(s)}</option>`),
    ].join("");
    const noteHtml=_semesterFilterNote?`<div style="font-size:.76rem;color:var(--accent3,#e67e22);margin-top:3px;margin-bottom:6px">${_semesterFilterNote}</div>`:"";
    // 學期膠囊（規格書 §四-A）
    const semCapsules=_allSemesters.length?[
      `<button class="brt-sem${_selectedSemester==="all"?" brt-semA":""}" onclick="BehaviorRadarTab.onYearChange('all')">全部</button>`,
      ..._allSemesters.map(s=>`<button class="brt-sem${s===_selectedSemester?" brt-semA":""}" onclick="BehaviorRadarTab.onYearChange('${s}')">${_formatSemester(s)}</button>`)
    ].join(""):"";
    const clBtns=Object.entries(CLUSTER_NAMES).map(([k,n])=>`<button class="brt-cl${k===_selectedCluster?" brt-clA":""}" style="--cc:${CLUSTER_COLORS[k].border};--cb:${CLUSTER_COLORS[k].bg}" onclick="BehaviorRadarTab.selectCluster('${k}')"><span class="brt-code">${k}</span> ${n}</button>`).join("");
    const pfBtns=[{key:"all",lbl:"全體"},{key:"pass",lbl:"✅ 及格"},{key:"fail",lbl:"❌ 不及格"}].map(({key,lbl})=>`<button class="brt-pf${key===_passFilter?" brt-pfA":""}" onclick="BehaviorRadarTab.selectPassFilter('${key}')">${lbl}</button>`).join("");
    // 防止 <style> 重複注入
    const styleId = `brt-style-${containerId}`;
    if (!document.getElementById(styleId)) {
      const s = document.createElement('style');
      s.id = styleId;
      s.textContent = `
        #${containerId} .brt-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:6px}
        #${containerId} .brt-lbl{font-size:.78rem;color:var(--text-dim,#888);white-space:nowrap;min-width:72px}
        #${containerId} .brt-cl{display:inline-flex;align-items:center;gap:4px;padding:4px 10px;border-radius:20px;border:1.5px solid var(--cc);background:transparent;color:var(--cc);font-size:.78rem;cursor:pointer;transition:background .15s;font-family:inherit}
        #${containerId} .brt-clA{background:var(--cb);font-weight:700}
        #${containerId} .brt-code{font-weight:700;font-family:'JetBrains Mono','Courier New',monospace}
        #${containerId} .brt-pf{padding:4px 12px;border-radius:20px;border:1.5px solid var(--accent,#3498db);background:transparent;color:var(--accent,#3498db);font-size:.78rem;cursor:pointer;transition:background .15s;font-family:inherit}
        #${containerId} .brt-pfA{background:var(--accent,#3498db);color:#fff;font-weight:700}
        #${containerId} .brt-sem{padding:3px 9px;border-radius:14px;border:1px solid var(--border2,#353c58);background:var(--surface2,#1c2030);color:var(--text-dim,#888);font-size:.76rem;font-family:'JetBrains Mono','Courier New',monospace;cursor:pointer;transition:all .15s;white-space:nowrap}
        #${containerId} .brt-semA{background:var(--accent,#3498db);color:#fff;border-color:var(--accent,#3498db);font-weight:700}
      `;
      document.head.appendChild(s);
    }
    el.innerHTML=`<div style="display:flex;flex-direction:column;gap:2px">
      ${semCapsules?`<div class="brt-row"><span class="brt-lbl">學期</span><div style="display:flex;flex-wrap:wrap;gap:4px">${semCapsules}</div></div>${noteHtml}`:""}
      <div class="brt-row"><span class="brt-lbl">依分群</span>${clBtns}</div>
      <div class="brt-row"><span class="brt-lbl">及格狀況</span>${pfBtns}</div>
    </div>`;
  }

  function onYearChange(semester){
    _selectedSemester=semester;
    _invalidateComputeCache();  // WARN-1：學期切換時清除快取
    const base=_radarData?._base||_radarData;
    if(semester==="all"){
      _behaviorStudents=_allStudents;
      _radarData=base;
      _semesterFilterNote=null;
    }else{
      const semData=base?.by_semester?.[semester];
      if(semData){
        _radarData={...base,_base:base,clusters:semData.clusters,pass_vs_fail:semData.pass_vs_fail,meta:{...(base.meta||{}),student_count:semData.student_count}};
        const bySem=_allStudents.filter(s=>String(s.semester||"").replace(/-/g,"")==String(semester).replace(/-/g,""));
        _behaviorStudents=bySem.length>0?bySem:_allStudents;
        _semesterFilterNote=null;
      }else{
        // by_semester 不存在：ETL 尚未產出，顯示提示但不做前端即時計算
        _radarData={...base,_base:base};
        _behaviorStudents=_allStudents;
        _semesterFilterNote=`⚠ ${_formatSemester(semester)} 無分年資料，目前顯示跨年總量（請重跑 ETL）`;
      }
    }
    _renderBehaviorMetaStrip();_passFilter="all";
    _renderControls("radarControls");
    renderClusterSummary("clusterSummaryCards");
    _renderRadar("radarChart");
    _renderInsights();
  }

  function selectCluster(key){
    _selectedCluster=key;_passFilter="all";
    _renderControls("radarControls");
    renderClusterSummary("clusterSummaryCards");
    _renderRadar("radarChart");
    _renderInsights();
  }
  function selectPassFilter(key){
    _passFilter=key;
    _renderControls("radarControls");
    renderClusterSummary("clusterSummaryCards");
    _renderRadar("radarChart");
    _renderInsights();
  }

  function _computeFromStudents(clusterKey,passKey,dims){
    // WARN-1：快取命中時直接回傳，避免全量掃描
    const cacheKey=`${clusterKey}|${passKey}|${_selectedSemester}`;
    if(_computeCache.has(cacheKey))return _computeCache.get(cacheKey);

    const students=_behaviorStudents;if(!students||!students.length)return null;
    const filtered=students.filter(s=>{
      if(clusterKey!=="P0"&&s.cluster!==clusterKey)return false;
      if(passKey!=="all"){const sc=s.final_score??s.semester_score??null;const scNum=Number(sc);const isPassing=Number.isFinite(scNum)&&scNum>=60;if(passKey==="pass"&&!isPassing)return false;if(passKey==="fail"&&isPassing)return false;}
      return true;
    });
    if(!filtered.length){_computeCache.set(cacheKey,null);return null;}
    const sums=dims.map(()=>0),cnts=dims.map(()=>0);
    for(const s of filtered){const feats=s.features||{};dims.forEach((d,i)=>{const fk=DIM_FEATURE_MAP[d]||d.toLowerCase();const v=Number(feats[fk]??feats[d]??feats[d.toLowerCase()]);if(Number.isFinite(v)){sums[i]+=v;cnts[i]+=1;}});}
    const result={count:filtered.length,values:dims.map((_,i)=>cnts[i]?sums[i]/cnts[i]:0)};
    _computeCache.set(cacheKey,result);
    return result;
  }

  function _getPassBenchmark(dims){
    // 取得及格群基準線 values[]，自動處理樣本不足 fallback
    const pvf=_radarData?.pass_vs_fail;
    if(!pvf)return null;
    const basePvf=_radarData?._base?.pass_vs_fail||pvf;
    const useLocal=(pvf.pass?.count||0)>=MIN_PASS_COUNT;
    const src=useLocal?pvf.pass:basePvf.pass;
    if(!src?.values?.length)return null;
    return{values:src.values.map(_clampRate),count:src.count,isFallback:!useLocal};
  }

  function _renderRadar(canvasId){
    if(!_radarData)return;
    const dims=_dimensions(),labels=dims.map(d=>DIM_LABELS[d]||d),datasets=[];
    if(_passFilter==="all"){
      const row=_getClusterAggRow(_selectedCluster,dims);
      if(!row){_renderEmpty(canvasId,"選定分群無足夠資料");return;}
      const col=CLUSTER_COLORS[_selectedCluster];
      datasets.push({label:`${_selectedCluster} ${CLUSTER_NAMES[_selectedCluster]}（n=${row.count}）`,data:row.values.map(_clampRate),borderColor:col.border,backgroundColor:col.bg,pointBackgroundColor:col.border,borderWidth:2.5,pointRadius:4});
    }else{
      const clLbl=`${_selectedCluster} ${CLUSTER_NAMES[_selectedCluster]}`;
      const passRow=_computeFromStudents(_selectedCluster,"pass",dims);
      const failRow=_computeFromStudents(_selectedCluster,"fail",dims);
      // Always show both pass+fail lines for comparison; width/opacity highlight selected
      if(passRow)datasets.push({label:`${clLbl} — 及格（n=${passRow.count}）`,data:passRow.values.map(_clampRate),borderColor:CLUSTER_COLORS.pass.border,backgroundColor:_passFilter==="pass"?CLUSTER_COLORS.pass.bg:"rgba(39,174,96,0.05)",pointBackgroundColor:CLUSTER_COLORS.pass.border,borderWidth:_passFilter==="pass"?3:1.5,pointRadius:_passFilter==="pass"?4:2,borderDash:_passFilter==="fail"?[4,3]:[]});
      if(failRow)datasets.push({label:`${clLbl} — 不及格（n=${failRow.count}）`,data:failRow.values.map(_clampRate),borderColor:CLUSTER_COLORS.fail.border,backgroundColor:_passFilter==="fail"?CLUSTER_COLORS.fail.bg:"rgba(192,57,43,0.05)",pointBackgroundColor:CLUSTER_COLORS.fail.border,borderWidth:_passFilter==="fail"?3:1.5,pointRadius:_passFilter==="fail"?4:2,borderDash:_passFilter==="pass"?[4,3]:[]});
    }
    if(!labels.length||!datasets.length){_renderEmpty(canvasId,"選定條件無足夠資料");return;}
    // ── 疊加及格群基準線 ──────────────────────────────────
    const bench=_getPassBenchmark(dims);
    if(bench){
      const benchLabel=bench.isFallback
        ?`及格群基準（全年度，n=${bench.count}）※本學期樣本不足`
        :`及格群平均基準（n=${bench.count}）`;
      datasets.unshift({
        label: benchLabel,
        data:  bench.values,
        borderColor:     "rgba(156,163,175,1)",
        backgroundColor: "rgba(156,163,175,0.07)",
        pointBackgroundColor:"rgba(156,163,175,0.8)",
        borderWidth: 1.5,
        pointRadius: 3,
        borderDash: [5,5],
        order: 99,
      });
    }
    _renderChart(canvasId,labels,datasets);
  }

  function _getClusterAggRow(clusterKey,dims){
    if(clusterKey==="P0"){
      const c=_computeFromStudents("P0","all",dims);if(c)return c;
      const rows=_clusterRows(),total=_clusterTotal();if(!total)return null;
      const sums=dims.map(()=>0);
      for(const row of Object.values(rows)){const n=Number(row?.count)||0;_values(row,dims).forEach((v,i)=>{sums[i]+=v*n;});}
      return{count:total,values:sums.map(s=>s/total)};
    }
    const c=_computeFromStudents(clusterKey,"all",dims);if(c&&c.count>0)return c;
    const row=_clusterRows()[clusterKey];
    return row?{count:row.count||0,values:_values(row,dims)}:null;
  }

  function _renderEmpty(canvasId,message){
    const canvas=document.getElementById(canvasId),wrap=canvas?.parentElement;
    if(wrap){canvas.style.display="none";let msg=wrap.querySelector(".behavior-empty-message");if(!msg){msg=document.createElement("div");msg.className="behavior-empty-message text-muted small";msg.style.cssText="padding:24px;text-align:center";wrap.appendChild(msg);}msg.textContent=message;}
  }

  function _renderChart(canvasId,labels,datasets){
    const canvas=document.getElementById(canvasId);if(!canvas)return;
    canvas.style.display="";canvas.parentElement?.querySelector(".behavior-empty-message")?.remove();
    // BUG-1 修正：透過 ChartRegistry 統一管理，防止例外洩漏
    ChartRegistry.destroyById(canvasId);
    _radarChart=null;
    const _gridColor=_isDark()?'rgba(180,185,210,0.20)':'rgba(0,0,0,0.08)';
    const _angleColor=_isDark()?'rgba(180,185,210,0.30)':'rgba(0,0,0,0.15)';
    const _labelColor=_isDark()?'rgba(190,195,220,0.85)':'rgba(60,65,90,0.85)';
    const _tickColor=_isDark()?'rgba(160,165,195,0.70)':'rgba(80,85,110,0.70)';
    // 手機版縮小 legend 與 layout padding，避免上下留白過多
    const _isMobile=window.innerWidth<600;
    const _legendPad=_isMobile?6:16;
    const _legendBox=_isMobile?20:34;
    const _legendFontSz=_isMobile?11:13;
    const _layoutPad=_isMobile?{top:4,right:8,bottom:4,left:8}:6;
    const _pointLblFontSz=_isMobile?10:12;
    const _tickFontSz=_isMobile?9:10;
    _radarChart=new Chart(canvas.getContext("2d"),{type:"radar",data:{labels,datasets},options:{responsive:true,maintainAspectRatio:false,layout:{padding:_layoutPad},scales:{r:{min:0,max:1,grid:{color:_gridColor},angleLines:{color:_angleColor},pointLabels:{color:_labelColor,font:{size:_pointLblFontSz}},ticks:{stepSize:0.2,color:_tickColor,backdropColor:'transparent',callback:v=>`${Math.round(v*100)}%`,font:{size:_tickFontSz}}}},plugins:{legend:{position:"bottom",align:"center",labels:{boxWidth:_legendBox,boxHeight:_isMobile?10:12,font:{size:_legendFontSz,weight:"600"},padding:_legendPad}},tooltip:{mode:"nearest",intersect:true,callbacks:{title:ctx=>ctx.length?`📊 ${ctx[0].label}`:"",label:ctx=>` ${ctx.dataset.label.split("（")[0]}：${(ctx.raw*100).toFixed(1)}%`,afterBody:ctx=>{if(!ctx.length)return[];const sorted=[...ctx].sort((a,b)=>b.raw-a.raw),dl=ctx[0].label;return[`🏆 ${dl} 排名：`,...sorted.map((c,i)=>`  ${RANK_MEDALS[i]??`${i+1}.`} ${c.dataset.label.split("（")[0]}：${(c.raw*100).toFixed(1)}%`)];},footer:ctx=>{if(!ctx.length)return[];const l=["👥 人數："];ctx.forEach(c=>{const m=c.dataset.label.match(/n=(\d+)/);if(m)l.push(`  ${c.dataset.label.split("（")[0]}：${m[1]} 人`);});return l;}}}}}});
    ChartRegistry.register(canvasId, _radarChart);  // BUG-1：登記至 Registry
  }

  // 依目前篩選狀態計算某群人數（模組層級，避免每次 render 重建）
  function _filteredCount(clusterKey) {
    const students = _behaviorStudents;
    if (!students || !students.length) {
      if (clusterKey === "P0") return _clusterTotal();
      return _clusterRows()[clusterKey]?.count || 0;
    }
    return students.filter(s => {
      if (clusterKey !== "P0" && s.cluster !== clusterKey) return false;
      if (_passFilter !== "all") {
        const sc = s.final_score ?? s.semester_score ?? null;
        const scNum = Number(sc);
        const isPassing = Number.isFinite(scNum) && scNum >= 60;
        if (_passFilter === "pass" && !isPassing) return false;
        if (_passFilter === "fail" && isPassing) return false;
      }
      return true;
    }).length;
  }

  function renderClusterSummary(containerId) {
    if (!_radarData) return;
    const el = document.getElementById(containerId); if (!el) return;
    const total = _filteredCount("P0");
    let filterDesc = "";
    if (_selectedSemester !== "all") filterDesc += ` · ${_formatSemester(_selectedSemester)}`;
    if (_passFilter === "pass") filterDesc += " · 及格";
    if (_passFilter === "fail") filterDesc += " · 不及格";

    // 手機版縮小卡片
    const isMobile = window.innerWidth < 600;
    const cardW  = isMobile ? "110px" : "150px";
    const cardW2 = isMobile ? "104px" : "144px";
    const pad    = isMobile ? "7px 9px" : "10px 12px";
    const numSz  = isMobile ? "1.15rem" : "1.45rem";
    const lblSz  = isMobile ? ".72rem"  : ".78rem";
    const nameSz = isMobile ? ".76rem"  : ".82rem";
    const pcSz   = isMobile ? ".70rem"  : ".76rem";
    const keySz  = isMobile ? ".84rem"  : ".92rem";

    const totalCard = `<div class="behavior-cluster-card" style="flex:0 0 ${cardW};min-width:${cardW};border:1px solid rgba(46,204,113,.28);border-radius:8px;background:rgba(46,204,113,.08);padding:${pad};box-shadow:0 2px 8px rgba(20,35,60,.06)">
      <div style="font-size:${lblSz};color:var(--text-dim,#888)">分析人數${filterDesc}</div>
      <div style="margin-top:4px;font-weight:800;color:var(--green,#239b56);font-size:${numSz};line-height:1">${total.toLocaleString()}</div>
      <div style="margin-top:6px;font-size:${lblSz};line-height:1.25;color:var(--text-mid,#9aa0b8)">100.0%</div>
    </div>`;

    const cards=Object.entries(CLUSTER_NAMES).filter(([k])=>k!=="P0").map(([key,name])=>{
      const n=_filteredCount(key);
      const pct=total?(n/total)*100:0;
      const col=CLUSTER_COLORS[key];
      const isSelected=_selectedCluster===key;
      const borderStyle=isSelected?`2px solid ${col.border}`:`1px solid rgba(110,130,165,.22)`;
      const bgStyle=isSelected?col.bg:`var(--surface,#13161f)`;
      return`<div class="behavior-cluster-card" style="flex:0 0 ${cardW2};min-width:${cardW2};border:${borderStyle};border-radius:8px;background:${bgStyle};padding:${pad};box-shadow:0 2px 8px rgba(20,35,60,.06);cursor:pointer" onclick="BehaviorRadarTab.selectCluster('${key}')">
        <div style="display:flex;align-items:baseline;justify-content:space-between;gap:8px">
          <span style="font-weight:700;color:${col.border};font-size:${keySz}">${key}</span>
          <span style="font-weight:700;color:${col.border};font-size:${numSz};line-height:1">${n}</span>
        </div>
        <div title="${name}" style="margin-top:6px;font-size:${nameSz};line-height:1.25;color:var(--text-mid,#4f5f78);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${name}</div>
        <div style="margin-top:3px;font-size:${pcSz};line-height:1.2;color:var(--text-dim,#888)">佔 ${pct.toFixed(1)}%</div>
      </div>`;
    }).join("");

    el.innerHTML=`<div style="display:flex;flex-direction:row;gap:${isMobile?'6px':'10px'};align-items:stretch;overflow-x:auto;padding:4px 2px 8px">${totalCard}${cards}</div>`;
  }

  function switchView(){
    _renderControls("radarControls");
    renderClusterSummary("clusterSummaryCards");
    _renderRadar("radarChart");
    _renderInsights();
  }
  // toggleCluster is an alias kept for external API compatibility
  function toggleCluster(key){selectCluster(key);}

  // ── 策略 B & C：洞察面板 ────────────────────────────────

  function _renderInsights(){
    const panel=document.getElementById("radarInsightsPanel");
    if(!panel)return;

    // P0（全體）不顯示分群洞察
    if(_selectedCluster==="P0"){panel.style.display="none";return;}

    const dims=_dimensions();
    const bench=_getPassBenchmark(dims);
    if(!bench){panel.style.display="none";return;}

    // 取得當前分群數值
    const row=_getClusterAggRow(_selectedCluster,dims);
    if(!row){panel.style.display="none";return;}

    const clName=CLUSTER_NAMES[_selectedCluster]||_selectedCluster;
    const clColor=CLUSTER_COLORS[_selectedCluster]?.border||"var(--accent)";

    // 計算各維度差距
    const diffs=dims.map((d,i)=>({
      dim:d,
      label:DIM_NAMES_ZH[d]||d,
      clVal:row.values[i],
      benchVal:bench.values[i],
      diff:row.values[i]-bench.values[i],
    }));

    const strengths=diffs.filter(x=>x.diff>=INSIGHT_THRESHOLD)
                         .sort((a,b)=>b.diff-a.diff);
    const gaps=diffs.filter(x=>x.diff<=-INSIGHT_THRESHOLD)
                    .sort((a,b)=>a.diff-b.diff)
                    .slice(0,2);  // 最多列出最大落差前兩項

    const isMobile=window.innerWidth<600;
    const pct=v=>`${(v*100).toFixed(1)}%`;
    const sign=v=>v>0?"+":"";

    // ── 優勢項 HTML ──────────────────────────────────────
    const strHTML=strengths.length?`
      <div style="margin-bottom:10px">
        <div style="font-size:.78rem;font-weight:700;color:var(--green,#64d4a8);margin-bottom:6px;letter-spacing:.04em">▲ 高於及格群基準</div>
        ${strengths.map(x=>`
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:5px;flex-wrap:wrap">
            <span style="font-family:'JetBrains Mono','Courier New',monospace;font-size:.78rem;font-weight:700;color:${clColor};min-width:36px">${x.dim}</span>
            <span style="font-size:.78rem;color:var(--text-mid,#9aa0b8);flex:1;min-width:80px">${x.label.replace(x.dim+' ','')}</span>
            <div style="display:flex;gap:4px;align-items:center">
              <span style="font-size:.76rem;color:var(--text-dim,#888)">${pct(x.benchVal)} →</span>
              <span style="font-size:.82rem;font-weight:700;color:var(--green,#64d4a8)">${pct(x.clVal)}</span>
              <span style="font-size:.76rem;color:var(--green,#64d4a8);background:rgba(100,212,168,.12);border-radius:6px;padding:1px 5px">${sign(x.diff)}${pct(x.diff)}</span>
            </div>
          </div>`).join("")}
      </div>`:"";

    // ── 弱點項 HTML ──────────────────────────────────────
    const gapHTML=gaps.length?`
      <div style="margin-bottom:10px">
        <div style="font-size:.78rem;font-weight:700;color:var(--red,#f07070);margin-bottom:6px;letter-spacing:.04em">▼ 低於及格群基準（落差最大）</div>
        ${gaps.map(x=>`
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:5px;flex-wrap:wrap">
            <span style="font-family:'JetBrains Mono','Courier New',monospace;font-size:.78rem;font-weight:700;color:${clColor};min-width:36px">${x.dim}</span>
            <span style="font-size:.78rem;color:var(--text-mid,#9aa0b8);flex:1;min-width:80px">${x.label.replace(x.dim+' ','')}</span>
            <div style="display:flex;gap:4px;align-items:center">
              <span style="font-size:.76rem;color:var(--text-dim,#888)">${pct(x.benchVal)} →</span>
              <span style="font-size:.82rem;font-weight:700;color:var(--red,#f07070)">${pct(x.clVal)}</span>
              <span style="font-size:.76rem;color:var(--red,#f07070);background:rgba(240,112,112,.12);border-radius:6px;padding:1px 5px">${sign(x.diff)}${pct(x.diff)}</span>
            </div>
          </div>`).join("")}
      </div>`:"";

    // ── 文字摘要 ─────────────────────────────────────────
    const summaryParts=[];
    if(strengths.length){
      const topStr=strengths[0];
      summaryParts.push(`本群學生（${_selectedCluster}）在 <strong>${topStr.label}</strong> 的使用率高出及格群基準 <strong style="color:var(--green,#64d4a8)">${pct(Math.abs(topStr.diff))}</strong>`);
    }
    if(gaps.length){
      const topGap=gaps[0];
      summaryParts.push(`但在 <strong>${topGap.label}</strong> 的參與度低於及格群基準 <strong style="color:var(--red,#f07070)">${pct(Math.abs(topGap.diff))}</strong>`);
    }
    const summaryHTML=summaryParts.length?`
      <div style="font-size:.80rem;color:var(--text-mid,#9aa0b8);line-height:1.6;background:var(--surface2,#1c2030);border-left:3px solid ${clColor};border-radius:0 8px 8px 0;padding:8px 12px;margin-bottom:10px">
        ${summaryParts.join("，")}。
      </div>`:"";

    // ── 行動建議（策略 C） ───────────────────────────────
    const recItems=gaps.map(g=>RECOMMENDATION_MAP[g.dim]).filter(Boolean);
    const recHTML=recItems.length?`
      <div style="margin-bottom:10px">
        <div style="font-size:.78rem;font-weight:700;color:var(--accent3,#f7a44f);margin-bottom:6px;letter-spacing:.04em">💡 建議措施</div>
        ${recItems.map(r=>`
          <div style="display:flex;gap:8px;align-items:flex-start;margin-bottom:6px">
            <span style="font-size:1rem;line-height:1.4">${r.icon}</span>
            <span style="font-size:.80rem;color:var(--text-mid,#9aa0b8);line-height:1.5">${r.action}</span>
          </div>`).join("")}
      </div>`:"";

    // ── fallback 提示 ─────────────────────────────────────
    const fallbackHTML=bench.isFallback?`
      <div style="font-size:.74rem;color:var(--accent3,#f7a44f);margin-bottom:8px;padding:4px 8px;background:rgba(247,164,79,.08);border-radius:6px">
        ※ 本學期及格樣本數不足（&lt;${MIN_PASS_COUNT}人），基準線已自動使用全年度資料。
      </div>`:"";

    // ── 匯出按鈕 ─────────────────────────────────────────
    const exportHTML=`
      <div style="margin-top:4px">
        <button onclick="BehaviorRadarTab.exportClusterCSV()" style="display:inline-flex;align-items:center;gap:6px;padding:6px 14px;border-radius:20px;border:1.5px solid ${clColor};background:transparent;color:${clColor};font-size:.78rem;font-weight:600;cursor:pointer;font-family:inherit;transition:background .15s" onmouseover="this.style.background='${CLUSTER_COLORS[_selectedCluster]?.bg||'rgba(79,142,247,.15)'}';" onmouseout="this.style.background='transparent'">
          ⬇ 匯出 ${_selectedCluster} 學生名單（CSV）
        </button>
        <span style="font-size:.72rem;color:var(--text-dim,#888);margin-left:8px">共 ${row.count} 人</span>
      </div>`;

    panel.style.display="block";
    panel.innerHTML=`
      <div style="border:1px solid var(--border,#2a2f45);border-radius:10px;padding:${isMobile?'10px':'14px'};background:var(--surface,#13161f);margin-bottom:14px">
        <div style="font-size:.82rem;font-weight:700;color:var(--text,#dde3f5);margin-bottom:10px;display:flex;align-items:center;gap:8px">
          <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${clColor}"></span>
          學習行為洞察 — ${_selectedCluster} ${clName}
        </div>
        ${fallbackHTML}
        ${summaryHTML}
        ${strHTML}
        ${gapHTML}
        ${recHTML}
        ${exportHTML}
      </div>`;
  }

  function exportClusterCSV(){
    const students=_behaviorStudents;
    if(!students||!students.length){alert("無學生資料可匯出");return;}
    const filtered=students.filter(s=>_selectedCluster==="P0"||s.cluster===_selectedCluster);
    if(!filtered.length){alert("目前篩選條件下無學生資料");return;}
    const dims=_dimensions();
    const header=["masked_id","cluster","semester","final_score",...dims.map(d=>d.toLowerCase()+"_rate")].join(",");
    const rows=filtered.map(s=>{
      const feats=s.features||{};
      const dimVals=dims.map(d=>{const fk=DIM_FEATURE_MAP[d]||d.toLowerCase()+"_completion_rate";return(Number(feats[fk]??feats[d]??0)*100).toFixed(1)+"%";});
      return[s.masked_id||"",s.cluster||"",s.semester||"",s.final_score??s.semester_score??"",...dimVals].join(",");
    });
    const csv="\uFEFF"+[header,...rows].join("\r\n");
    const blob=new Blob([csv],{type:"text/csv;charset=utf-8;"});
    const url=URL.createObjectURL(blob);
    // BUG-2 修正：加 display:none 避免短暫顯示；用 rAF 確保 click 完成後再移除
    const a=Object.assign(document.createElement("a"),{
      href:url,
      download:`${_selectedCluster}_students_${_selectedSemester==="all"?"all":_selectedSemester}.csv`,
      style:"display:none",
    });
    document.body.appendChild(a);
    a.click();
    requestAnimationFrame(()=>{
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    });
  }

  function resetFilters(){
    _selectedSemester="all";_selectedCluster="P0";_passFilter="all";_semesterFilterNote=null;
    _renderBehaviorMetaStrip();
    _renderControls("radarControls");renderClusterSummary("clusterSummaryCards");_renderRadar("radarChart");
    _renderInsights();
    const ins=document.getElementById("radarInsightsPanel");if(ins)ins.style.display="none";
  }
  return{init,switchView,toggleCluster,renderClusterSummary,onYearChange,selectCluster,selectPassFilter,exportClusterCSV,resetFilters};
})();
