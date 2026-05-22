/**
 * tab-behavior-time.js  —  v2.1
 * 時間分析 Tab
 *
 * 新增功能：
 *   - renderStudyHeatmap()        學習規律熱力圖（SVG，7×24）
 *   - renderHourlyLine()          24小時學習趨勢折線（Chart.js，含分群疊加）
 *   - renderAIInsightBadge()      AI 智慧洞察文字框
 *
 * 保留原有功能：
 *   - renderWeeklyQuiz()          各週題庫作答強度
 *   - renderPreExamIntensity()    平時及考前學習強度（考前分型圓環）
 *   - renderTimeSlotDonut()       學習時段分布（四段圓環，保留）
 *
 * 資料來源：time_distribution.json v2.1
 *   新欄位：class_heatmap_matrix、class_avg_hourly_distribution、cohort_hourly
 *           students[i].heatmap_matrix、students[i].hourly_distribution
 *
 * 依賴：Chart.js、behavior-loader.js
 */

const BehaviorTimeTab = (() => {

  // ── 常數定義 ────────────────────────────────────────────────

  const PASS_THRESHOLD = 60;

  const SLOT_LABELS = {
    MORNING:    "上午 06-12",
    AFTERNOON:  "下午 12-18",
    EVENING:    "傍晚 18-23",
    LATE_NIGHT: "深夜 23-06",
  };

  const SLOT_COLORS = [
    "rgba(241, 196, 15,  0.80)",
    "rgba(52,  152, 219, 0.80)",
    "rgba(155, 89,  182, 0.80)",
    "rgba(44,  62,  80,  0.75)",
  ];

  const SLOT_TIPS = {
    MORNING:    "早晨學習，記憶力佳、專注度高",
    AFTERNOON:  "午後學習，效率穩定",
    EVENING:    "傍晚學習，適合複習整理",
    LATE_NIGHT: "深夜學習可能影響睡眠品質，建議調整",
  };

  const CLUSTER_NAMES = {
    P1: "影音輔導型",
    P2: "彈性聽覺型",
    P3: "平均使用型",
    P4: "題庫刷題型",
    P5: "被動低參與型",
  };

  const PREP_TYPES = [
    { key: "low_invest",  label: "學習低投入型", color: "rgba(158, 158, 158, 0.85)" },
    { key: "crammer",     label: "高度衝刺型",   color: "rgba(255, 82,  82,  0.85)" },
    { key: "consistent",  label: "規律分散型",   color: "rgba(76,  175, 80,  0.85)" },
    { key: "early",       label: "提早完成型",   color: "rgba(33,  150, 243, 0.85)" },
  ];

  const WEEKDAY_LABELS = ["一", "二", "三", "四", "五", "六", "日"];
  const HOUR_LABELS    = Array.from({ length: 24 }, (_, i) => `${i}:00`);

  // 24小時折線圖顏色
  const COHORT_COLORS = {
    class: { border: "rgba(52,  152, 219, 0.9)", bg: "rgba(52, 152, 219, 0.12)" },
    top25: { border: "rgba(46,  204, 113, 0.9)", bg: "rgba(46, 204, 113, 0.12)" },
    pass:  { border: "rgba(241, 196, 15,  0.9)", bg: "rgba(241,196, 15,  0.10)" },
    fail:  { border: "rgba(231, 76,  60,  0.8)", bg: "rgba(231, 76,  60,  0.08)" },
  };

  // ── 狀態 ────────────────────────────────────────────────────
  let _quizData     = null;
  let _timeData     = null;
  let _charts       = {};
  let _filterSemester = "all";
  let _filterCluster  = "all";
  let _filterPass     = "all";
  let _allSemesters   = [];

  // ── 工具函式 ─────────────────────────────────────────────────

  function _avg(values) {
    const nums = values.filter(v => v != null && isFinite(v));
    return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
  }

  function _num(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }

  function _normalizeSem(value) {
    return String(value || "").replace(/-/g, "");
  }

  function _formatSemLabel(sem) {
    const s = String(sem || "").trim();
    const m = s.match(/^(\d{3})-?([12])$/);
    return m ? `${m[1]}(${m[2]})` : s;
  }

  function _isPassing(row) {
    const score = _num(row.final_score ?? row.semester_score);
    return Number.isFinite(score) && score >= PASS_THRESHOLD;
  }

  function _weekAvgAttempts(w) {
    if (w.avg_attempts != null) return _num(w.avg_attempts);
    return _avg([w.pass_group_avg_attempts, w.fail_group_avg_attempts].map(_num));
  }

  function _weekPassRate(w) {
    return _num(w.avg_pass_rate ?? w.overall_pass_rate);
  }

  function _weekActiveStudents(w) {
    return _num(w.active_students ?? w.total_students ??
      ((w.pass_group_active_students || 0) + (w.fail_group_active_students || 0)));
  }

  function _availableSemesters() {
    const fromMeta = [
      ...(_timeData?.meta?.semesters  || []),
      ...(_quizData?.meta?.semesters  || []),
    ];
    const fromRows = (_timeData?.students || []).map(s => s.semester).filter(Boolean);
    return [...new Set([...fromMeta, ...fromRows])].sort((a, b) => String(b).localeCompare(String(a)));
  }

  // ── 熱力圖色彩函式（模組層級）────────────────────────
  // 深藍(少) → 藍 → 橙(多)
  function _heatColor(val, maxVal) {
    if (!val || val <= 0) return "rgba(40,46,68,0.6)";
    const t = Math.min(val / maxVal, 1);
    const r = Math.round(26  + t * (230 - 26));
    const g = Math.round(32  + t * (126 - 32));
    const b = Math.round(54  + (1 - t) * (219 - 54));
    return `rgb(${r},${g},${b})`;
  }

  // ── 初始化 & 篩選 ────────────────────────────────────────────

  async function init() {
    BehaviorLoader.setLoading("tab-time", true);
    try {
      [_quizData, _timeData] = await Promise.all([
        BehaviorLoader.load.quiz(),
        BehaviorLoader.load.time(),
      ]);
      _allSemesters = _availableSemesters();
      // BUG-1 修正：明確兩步驟賦值，避免 _filterRows 拋出時 _rowCache.filtered 保持 null 的競態
      const allRows = _studentRows(false);
      const filteredRows = _filterRows(allRows);
      _rowCache = { all: allRows, filtered: filteredRows };
      _renderFilterBar();
      _renderAll();
    } catch (err) {
      _rowCache = null;  // 確保失敗時快取不含部分資料
      BehaviorLoader.showError("tab-time", err.message);
    } finally {
      BehaviorLoader.setLoading("tab-time", false);
    }
  }

  function _renderFilterBar() {

    // 改為在專屬容器 #timeFilterBarAnchor 中插入，若不存在則在 #tab-time 最前面插入
    let anchor = document.getElementById("timeFilterBarAnchor");
    if (!anchor) {
      const tabEl = document.getElementById("tab-time");
      if (!tabEl) return;
      anchor = document.createElement("div");
      anchor.id = "timeFilterBarAnchor";
      tabEl.insertBefore(anchor, tabEl.firstChild);
    }
    const semOptions = [
      `<option value="all">全部年度</option>`,
      ..._allSemesters.map(s => `<option value="${s}"${s === _filterSemester ? " selected" : ""}>${_formatSemLabel(s)}</option>`),
    ].join("");
    const clusterOptions = [
      `<option value="all">全部分群</option>`,
      ...Object.entries(CLUSTER_NAMES).map(([k, v]) => `<option value="${k}"${k === _filterCluster ? " selected" : ""}>${k} ${v}</option>`),
    ].join("");
    const passOptions = [
      `<option value="all">全部</option>`,
      `<option value="pass"${_filterPass === "pass" ? " selected" : ""}>及格</option>`,
      `<option value="fail"${_filterPass === "fail" ? " selected" : ""}>不及格</option>`,
    ].join("");
    anchor.innerHTML = `
      <div style="display:flex;flex-wrap:nowrap;overflow-x:auto;align-items:center;gap:8px;margin-bottom:12px;padding:8px 12px;border:1px solid rgba(110,130,165,.22);border-radius:10px;background:var(--card-bg2,#1c2030);white-space:nowrap">
        <span style="font-size:.8rem;font-weight:700;color:var(--text-mid,#4f5f78);white-space:nowrap">篩選條件</span>
        <label style="display:flex;align-items:center;gap:4px;font-size:.78rem;color:var(--text-dim,#888);flex-shrink:0">學期
          <select id="timeSemFilter" onchange="BehaviorTimeTab.onFilterChange(this.id)" style="font-size:.78rem;padding:2px 4px;border-radius:7px;border:1px solid var(--border,#2a2f45);background:var(--surface2,#1c2030);color:var(--text-mid,#9aa0b8);cursor:pointer;max-width:90px">${semOptions}</select>
        </label>
        <label style="display:flex;align-items:center;gap:4px;font-size:.78rem;color:var(--text-dim,#888);flex-shrink:0">分群
          <select id="timeClusterFilter" onchange="BehaviorTimeTab.onFilterChange(this.id)" style="font-size:.78rem;padding:2px 4px;border-radius:7px;border:1px solid var(--border,#2a2f45);background:var(--surface2,#1c2030);color:var(--text-mid,#9aa0b8);cursor:pointer;max-width:110px">${clusterOptions}</select>
        </label>
        <label style="display:flex;align-items:center;gap:4px;font-size:.78rem;color:var(--text-dim,#888);flex-shrink:0">及格
          <select id="timePassFilter" onchange="BehaviorTimeTab.onFilterChange(this.id)" style="font-size:.78rem;padding:2px 4px;border-radius:7px;border:1px solid var(--border,#2a2f45);background:var(--surface2,#1c2030);color:var(--text-mid,#9aa0b8);cursor:pointer;max-width:80px">${passOptions}</select>
        </label>
        <span id="timeFilterCount" style="font-size:.76rem;color:var(--text-dim,#888)"></span>
      </div>`;
  }

  function onFilterChange(sourceId) {
    // [Fix Q2] 以觸發來源的 id 判斷變更的是哪個維度，取其值更新全域狀態，
    // 再同步所有其他同維度的 select，確保頂部列與圖表內三組篩選器永遠一致。
    if (sourceId) {
      const el = document.getElementById(sourceId);
      if (el) {
        const sid = sourceId.toLowerCase();
        if      (sid.includes("sem"))     _filterSemester = el.value;
        else if (sid.includes("cluster")) _filterCluster  = el.value;
        else if (sid.includes("pass"))    _filterPass     = el.value;
      }
    } else {
      // 無 sourceId（直接呼叫）：從頂部列讀取
      _filterSemester = document.getElementById("timeSemFilter")?.value     || "all";
      _filterCluster  = document.getElementById("timeClusterFilter")?.value || "all";
      _filterPass     = document.getElementById("timePassFilter")?.value    || "all";
    }

    // 同步所有同維度 select（頂部列 + 兩組圖表內）
    const semIds     = ["timeSemFilter",     "preExamSemFilter",     "tsDonutSemFilter"];
    const clusterIds = ["timeClusterFilter", "preExamClusterFilter", "tsDonutClusterFilter"];
    const passIds    = ["timePassFilter",    "preExamPassFilter",    "tsDonutPassFilter"];
    semIds    .forEach(id => { const el = document.getElementById(id); if (el) el.value = _filterSemester; });
    clusterIds.forEach(id => { const el = document.getElementById(id); if (el) el.value = _filterCluster;  });
    passIds   .forEach(id => { const el = document.getElementById(id); if (el) el.value = _filterPass;     });

    _renderAll();
  }

  // ── 資料列處理 ──────────────────────────────────────────────
  // time_distribution.json v2.1 已含 edu_type / cluster / semester / final_score，
  // 直接以 timeData.students 為主，不再 join window.DATA

  function _studentRows(applyFilters = true) {
    const timeStudents = _timeData?.students || [];
    const rows = timeStudents.map(s => {
      // [Fix v2.1] time_distribution.json 的 student 物件為扁平結構（07_export_json.py），
      // 所有 time_profile 欄位直接輸出於 s 頂層，不存在 s.time_profile 包層。
      // 原本 `const tp = s.time_profile || {}` 導致 tp 永遠為 {}，
      // 所有時段分布、考試距離、週節律欄位皆讀取失敗（靜默回傳 0/{} ）。
      const tp = s;
      return {
        anon_id:             s.anon_id,
        masked_id:           s.masked_id,
        semester:            s.semester  || "",
        cluster:             s.cluster   || "",
        edu_type:            s.edu_type  || "",
        final_score:         s.final_score    ?? null,
        semester_score:      s.semester_score ?? null,
        totalMinutes:        _num(s.total_learning_minutes ?? (s.features || {}).total_learning_minutes),
        preMidterm:          _num(tp.pre_midterm_7d_minutes),
        preFinal:            _num(tp.pre_final_7d_minutes),
        midRegular:          _num(tp.midterm_regular_minutes),
        finalRegular:        _num(tp.final_regular_minutes),
        midPeriod:           _num(tp.midterm_period_minutes),
        finalPeriod:         _num(tp.final_period_minutes),
        activeWeeks:         _num(tp.active_weeks),
        timeSlotDistribution: tp.time_slot_distribution || {},
        // v2.1 新欄位（已正確從 s 頂層讀取，維持不變）
        heatmapRaw:          s.heatmap_matrix?.raw        || {},
        heatmapNorm:         s.heatmap_matrix?.normalized || {},
        hourlyRaw:           s.hourly_distribution?.raw        || [],
        hourlyNorm:          s.hourly_distribution?.normalized || [],
        late_night_ratio:    _num(tp.late_night_ratio),
      };
    });
    return applyFilters ? _filterRows(rows) : rows;
  }

  function _filterRows(rows) {
    return rows.filter(row => {
      if (_filterSemester !== "all" && row.semester &&
          _normalizeSem(row.semester) !== _normalizeSem(_filterSemester)) return false;
      if (_filterCluster !== "all" && row.cluster !== _filterCluster) return false;
      if (_filterPass !== "all") {
        const hasScore = row.final_score != null || row.semester_score != null;
        if (!hasScore) return false;
        const pass = _isPassing(row);
        if (_filterPass === "pass" && !pass) return false;
        if (_filterPass === "fail" && pass) return false;
      }
      return true;
    });
  }

  // ── 列資料快取（每次 _renderAll 重置，各 render* 共用）──────
  let _rowCache = null;   // { all: rows[], filtered: rows[] }

  function _getRowCache() {
    if (!_rowCache) {
      const all = _studentRows(false);
      _rowCache = { all, filtered: _filterRows(all) };
    }
    return _rowCache;
  }

  function _filteredStudentRows() {
    return _getRowCache().filtered;
  }

  function _renderAll() {

    // [Fix Q1] 每次篩選變更時強制從 all rows 重新計算 filtered，
    // 確保 AI 洞察等所有元件都使用最新篩選結果。
    if (_rowCache) {
      _rowCache.filtered = _filterRows(_rowCache.all);
    } else {
      _getRowCache();   // fallback：透過 _getRowCache() 完整重建並快取
    }
    const rows    = _filteredStudentRows();
    const countEl = document.getElementById("timeFilterCount");
    if (countEl) countEl.textContent = `共 ${rows.length.toLocaleString()} 筆`;

    // ── 原有圖表 ──
    renderWeeklyQuiz("weeklyQuizChart");
    renderPreExamIntensity("preExamChart");
    renderTimeSlotDonut("timeSlotChart");

    // ── 新增圖表（rAF 避免篩選切換時卡頓）──
    // [Fix Q1] renderAIInsightBadge 移入 rAF，確保與其他圖表同一幀執行，
    // 避免在 _rowCache.filtered 尚未寫入前就讀取（理論上同步但保守處理）
    requestAnimationFrame(() => {
      renderAIInsightBadge("aiInsightBadge");
      renderStudyHeatmap("studyHeatmapWrap");
      renderHourlyLine("hourlyLineChart");
    });
  }

  // ────────────────────────────────────────────────────────────
  // 原有圖表（完整保留）
  // ────────────────────────────────────────────────────────────

  const examLinePlugin = {
    id: "examVerticalLines",
    afterDraw(chart) {
      const { ctx, scales, data } = chart;
      const xScale = scales.x;
      if (!xScale) return;
      const examWeeks = [9, 18];
      const examLabels = { 9: "期中考", 18: "期末考" };
      data.labels.forEach((label, i) => {
        const weekNum = parseInt(label.replace("W", ""), 10);
        if (!examWeeks.includes(weekNum)) return;
        const x = xScale.getPixelForValue(i);
        const top = chart.chartArea.top;
        const bottom = chart.chartArea.bottom;
        ctx.save();
        ctx.beginPath();
        ctx.setLineDash([]);
        ctx.strokeStyle = "rgba(220, 38, 38, 0.85)";
        ctx.lineWidth = 2;
        ctx.moveTo(x, top);
        ctx.lineTo(x, bottom);
        ctx.stroke();
        ctx.fillStyle = "rgba(220, 38, 38, 0.90)";
        ctx.font = "bold 10px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(examLabels[weekNum], x, top - 4);
        ctx.restore();
      });
    },
  };

  function _segmentKey() {
    const sem = _filterSemester === "all" ? "all" : _normalizeSem(_filterSemester);
    return `${sem}|${_filterCluster}|${_filterPass}`;
  }

  function _weeksForFilter() {
    const baseWeeks = _quizData?.weeks || [];
    const semData = _filterSemester !== "all"
      ? _quizData?.by_semester?.[_filterSemester] || _quizData?.by_semester?.[_normalizeSem(_filterSemester)]
      : null;
    const sourceWeeks = semData?.weeks || baseWeeks;
    const key = _segmentKey();
    return sourceWeeks.map(w => w.segments?.[key] || w.segments?.[`all|${_filterCluster}|${_filterPass}`] || w);
  }

  function renderWeeklyQuiz(canvasId) {
    const canvas = document.getElementById(canvasId);
    if (!canvas || !_quizData) return;

    const rawWeeks = _weeksForFilter();
    const weekMap = new Map(rawWeeks.map(w => [Number(w.week), w]));
    const weeks = [];
    for (let i = 1; i <= 18; i++) {
      const fallback = i === 9 || i === 18
        ? { week: i, title: `第${i}週 ${i === 9 ? "期中考" : "期末考"}`, is_exam_week: true, exam_type: i === 9 ? "midterm" : "final", active_students: 0, avg_attempts: 0, overall_pass_rate: 0 }
        : { week: i, title: `第${i}週 練習題庫`, active_students: 0, avg_attempts: 0, overall_pass_rate: 0 };
      weeks.push({ ...fallback, ...(weekMap.get(i) || {}) });
    }

    const labels         = weeks.map(w => `W${w.week}`);
    const avgAttempts    = weeks.map(w => _weekAvgAttempts(w));
    const avgPassRate    = weeks.map(w => _weekPassRate(w) * 100);
    const activeStudents = weeks.map(w => _weekActiveStudents(w));
    const validAttempts  = avgAttempts.filter(v => v != null);
    const semAvg         = validAttempts.reduce((a, b) => a + b, 0) / (validAttempts.length || 1);
    const maxStudents    = Math.max(...activeStudents.filter(v => v != null), 1);

    ChartRegistry.destroyById(canvasId);  // BUG-2：整合 ChartRegistry
    _charts.weeklyQuiz = new Chart(canvas.getContext("2d"), {
      type: "line",
      plugins: [examLinePlugin],
      data: {
        labels,
        datasets: [
          { label: "平均作答次數", data: avgAttempts,    borderColor: "rgba(52,152,219,0.9)", backgroundColor: "rgba(52,152,219,0.1)", fill: true,  tension: 0.35, yAxisID: "yAttempts", pointRadius: 3, spanGaps: true },
          { label: "平均及格率 (%)", data: avgPassRate,  borderColor: "rgba(39,174,96,0.9)",  backgroundColor: "transparent",           borderDash: [5,4], tension: 0.35, yAxisID: "yPassRate",  pointRadius: 2, spanGaps: true },
          { label: "作答人數",     data: activeStudents, borderColor: "rgba(127,140,141,0.95)",backgroundColor: "transparent",           borderDash: [3,3], tension: 0.2, yAxisID: "yAttempts", pointRadius: 2, spanGaps: true },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: "nearest", intersect: true },
        scales: {
          x: { ticks: { font: { size: 10 } } },
          yAttempts: { position: "left",  title: { display: true, text: "次數 / 人數", font: { size: 10 } }, min: 0 },
          yPassRate: { position: "right", title: { display: true, text: "及格率 (%)", font: { size: 10 } }, min: 0, max: 100, grid: { drawOnChartArea: false } },
        },
        plugins: {
          legend: { position: "bottom", labels: { font: { size: 11 } } },
          tooltip: {
            callbacks: {
              title: ctx => {
                if (!ctx.length) return "";
                const w = weeks[ctx[0].dataIndex];
                const examTag = w.is_exam_week ? (w.exam_type === "final" ? " 期末考週" : " 期中考週") : (w.is_pre_exam ? " 考前週" : "");
                return `第 ${w.week} 週${examTag}`;
              },
              label: ctx => {
                if (ctx.dataset.label.includes("及格率")) return ` 題庫及格率：${ctx.raw.toFixed(1)}%`;
                if (ctx.dataset.label.includes("人數"))   return ` 作答人數：${Math.round(ctx.raw)} 人`;
                return ` 平均作答次數：${ctx.raw.toFixed(1)} 次`;
              },
              afterBody: ctx => {
                if (!ctx.length) return [];
                const w = weeks[ctx[0].dataIndex];
                if (w.is_exam_week) return [];
                const diff = _weekAvgAttempts(w) - semAvg;
                return [diff >= 0 ? `高於學期均值 ${diff.toFixed(1)} 次` : `低於學期均值 ${Math.abs(diff).toFixed(1)} 次`];
              },
              footer: ctx => {
                if (!ctx.length) return [];
                const total = _weekActiveStudents(weeks[ctx[0].dataIndex]);
                if (!total) return [];
                return [`作答人數佔峰值 ${Math.round((total / maxStudents) * 100)}%`];
              },
            },
          },
        },
      },
    });
    ChartRegistry.register(canvasId, _charts.weeklyQuiz);  // BUG-T1：登記至 Registry
  }

  function _periodValues(row, exam) {
    const pre            = exam === "midterm" ? row.preMidterm : row.preFinal;
    const explicitRegular = exam === "midterm" ? row.midRegular : row.finalRegular;
    const explicitPeriod  = exam === "midterm" ? row.midPeriod  : row.finalPeriod;
    const period = explicitPeriod > 0 ? explicitPeriod : Math.max(row.totalMinutes, pre);
    const regular = explicitRegular > 0 ? explicitRegular : Math.max(period - pre, 0);
    return { pre, regular, period: Math.max(period, pre + regular, 0) };
  }

  function _prepType(row, exam, p15 = 0) {
    const { pre, period } = _periodValues(row, exam);
    if (period <= 0 || period < p15) return "low_invest";
    const preRatio = pre / period;
    if (preRatio >= 0.30) return "crammer";
    if (preRatio >= 0.10) return "consistent";
    return "early";
  }

  function _calcP15(exam) {
    // Phase D：優先讀 ETL 預聚合 segment_stats
    const segKey   = _segmentKey();
    const p15Field = exam === "midterm" ? "p15_midterm" : "p15_final";
    const segStats = _timeData?.segment_stats;
    if (segStats) {
      // 完整 key 命中
      if (segStats[segKey]?.[p15Field] != null) return segStats[segKey][p15Field];
      // 單維 fallback：只篩了一個維度時嘗試對應單維 key
      const [sem, cluster, pass] = segKey.split("|");
      if (sem !== "all" && cluster === "all" && pass === "all" && segStats[segKey]?.[p15Field] != null)
        return segStats[segKey][p15Field];
      // 全量 fallback
      if (segStats["all|all|all"]?.[p15Field] != null) return segStats["all|all|all"][p15Field];
    }
    // fallback：原始即時排序計算
    const all = _getRowCache().all;
    const periods = all.map(r => _periodValues(r, exam).period).filter(v => v > 0).sort((a, b) => a - b);
    if (!periods.length) return 0;
    const idx = Math.floor(periods.length * 0.15);
    return periods[Math.min(idx, periods.length - 1)];
  }

  function renderPreExamIntensity(canvasId) {
    const canvas = document.getElementById(canvasId);
    if (!canvas || !_timeData) return;
    const rows = _filteredStudentRows();
    const exams = [{ key: "midterm", label: "期中考" }, { key: "final", label: "期末考" }];
    const p15Mid   = _calcP15("midterm");
    const p15Final = _calcP15("final");
    const midCounts   = PREP_TYPES.map(t => rows.filter(r => _prepType(r, "midterm", p15Mid)   === t.key).length);
    const finalCounts = PREP_TYPES.map(t => rows.filter(r => _prepType(r, "final",   p15Final)  === t.key).length);
    const allCounts   = [...midCounts, ...finalCounts];
    _renderPreExamSummary(canvas, rows, allCounts, p15Mid, p15Final);
    ChartRegistry.destroyById(canvasId);  // BUG-2：整合 ChartRegistry
    _charts.preExam = new Chart(canvas.getContext("2d"), {
      type: "doughnut",
      data: {
        labels: PREP_TYPES.map(t => t.label),
        datasets: [
          { label: "期中考", data: midCounts,   backgroundColor: PREP_TYPES.map(t => t.color),                         borderWidth: 2, hoverOffset: 8 },
          { label: "期末考", data: finalCounts, backgroundColor: PREP_TYPES.map(t => t.color.replace("0.85", "0.45")), borderWidth: 2, hoverOffset: 8 },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: "50%",
        plugins: {
          legend: { position: "bottom", labels: { font: { size: 11 }, padding: 12, boxWidth: 22, boxHeight: 10 } },
          tooltip: {
            callbacks: {
              title: ctx => `${ctx[0].dataset.label}・${ctx[0].label}`,
              label: ctx => {
                const total = rows.length || 1;
                const count = ctx.raw || 0;
                return ` ${count} 人（${(count / total * 100).toFixed(1)}%）`;
              },
            },
          },
        },
      },
    });
    ChartRegistry.register(canvasId, _charts.preExam);  // BUG-T1：登記至 Registry
  }

  function _renderPreExamSummary(canvas, rows, counts, p15Mid, p15Final) {
    const card = canvas.closest(".chart-card") || canvas.parentElement;
    if (!card) return;
    let el = card.querySelector(".pre-exam-summary");
    if (!el) {
      el = document.createElement("div");
      el.className = "pre-exam-summary";
      card.appendChild(el);
    }
    const total    = rows.length || 1;
    const midLow   = counts[0] || 0, midCram  = counts[1] || 0;
    const finalLow = counts[4] || 0, finalCram = counts[5] || 0;
    const cardHtml = [
      ["分析人數",          `${rows.length.toLocaleString()} 人`],
      ["期中 學習低投入型",  `${midLow}  人（${(midLow  / total * 100).toFixed(1)}%）`],
      ["期中 高度衝刺型",    `${midCram} 人（${(midCram / total * 100).toFixed(1)}%）`],
      ["期末 學習低投入型",  `${finalLow}  人（${(finalLow  / total * 100).toFixed(1)}%）`],
      ["期末 高度衝刺型",    `${finalCram} 人（${(finalCram / total * 100).toFixed(1)}%）`],
    ].map(([label, value]) => `
      <div style="border:1px solid rgba(110,130,165,.18);border-radius:8px;padding:7px 9px;background:var(--card-bg2,#1c2030)">
        <div style="font-size:.72rem;color:var(--text-dim,#888);line-height:1.2">${label}</div>
        <div style="font-weight:700;color:var(--text-mid,#4f5f78);margin-top:3px">${value}</div>
      </div>`).join("");
    const semLabel     = _filterSemester === "all" ? "全部年度" : _formatSemLabel(_filterSemester);
    const clusterLabel = _filterCluster  === "all" ? "全部分群" : `${_filterCluster} ${CLUSTER_NAMES[_filterCluster] || _filterCluster}`;
    const passLabel    = _filterPass     === "all" ? "全部"     : (_filterPass === "pass" ? "及格" : "不及格");
    // [Fix Q2] 改為可互動的 <select>，與全域篩選雙向同步
    const semOptions2     = [
      `<option value="all"${_filterSemester === "all" ? " selected" : ""}>全部年度</option>`,
      ..._allSemesters.map(s => `<option value="${s}"${_normalizeSem(s) === _normalizeSem(_filterSemester) ? " selected" : ""}>${_formatSemLabel(s)}</option>`),
    ].join("");
    const clusterOptions2 = [
      `<option value="all"${_filterCluster === "all" ? " selected" : ""}>全部分群</option>`,
      ...Object.entries(CLUSTER_NAMES).map(([k, v]) => `<option value="${k}"${k === _filterCluster ? " selected" : ""}>${k} ${v}</option>`),
    ].join("");
    const passOptions2    = [
      `<option value="all"${_filterPass === "all" ? " selected" : ""}>全部</option>`,
      `<option value="pass"${_filterPass === "pass" ? " selected" : ""}>及格</option>`,
      `<option value="fail"${_filterPass === "fail" ? " selected" : ""}>不及格</option>`,
    ].join("");
    const selectStyle2 = `font-size:.76rem;padding:2px 4px;border-radius:6px;border:1px solid var(--border,#2a2f45);background:var(--surface2,#1c2030);color:var(--text-mid,#9aa0b8);cursor:pointer;max-width:105px`;
    const filterBadge  =
      `<div style="display:flex;flex-wrap:nowrap;overflow-x:auto;align-items:center;box-sizing:border-box;max-width:100%;margin-bottom:8px;padding:5px 10px;border-radius:6px;background:var(--card-bg2,#1c2030);` +
      `border:1px solid rgba(110,130,165,.2);font-size:.75rem;color:var(--text-mid,#4f5f78);line-height:1.6;gap:6px;white-space:nowrap">` +
      `<span style="font-weight:700;flex-shrink:0">篩選條件</span>` +
      `<label style="display:flex;align-items:center;gap:3px;flex-shrink:0">📅 <select id="preExamSemFilter" onchange="BehaviorTimeTab.onFilterChange(this.id)" style="${selectStyle2}">${semOptions2}</select></label>` +
      `<label style="display:flex;align-items:center;gap:3px;flex-shrink:0">👥 <select id="preExamClusterFilter" onchange="BehaviorTimeTab.onFilterChange(this.id)" style="${selectStyle2}">${clusterOptions2}</select></label>` +
      `<label style="display:flex;align-items:center;gap:3px;flex-shrink:0">✅ <select id="preExamPassFilter" onchange="BehaviorTimeTab.onFilterChange(this.id)" style="${selectStyle2}">${passOptions2}</select></label>` +
      `</div>`;
    el.innerHTML =
      filterBadge +
      `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:8px;margin-top:10px">${cardHtml}</div>` +
      '<div style="margin-top:8px;padding:8px 10px;border-radius:6px;background:var(--card-bg2,#1c2030);font-size:.76rem;color:var(--text-dim,#666);line-height:1.6">' +
        '<b>平時及考前學習強度分型定義（規格書 V2.1）：</b><br>' +
        '核心指標：<b>T<sub>total</sub></b>（統計期間總閱讀時數）、<b>T<sub>pre</sub></b>（考前7天累計時數）、' +
        '<b>P<sub>pre</sub></b> = T<sub>pre</sub> ÷ T<sub>total</sub> × 100%。<br>' +
        '判定優先順序（MECE）：' +
        '<b>① 學習低投入型</b>：T<sub>total</sub> &lt; P15 門檻（全體最低15%），學習量不足，不分析節奏；' +
        '<b>② 高度衝刺型</b>：P<sub>pre</sub> ≥ 30%（集中學習 Massed Practice）；' +
        '<b>③ 規律分散型</b>：10% ≤ P<sub>pre</sub> &lt; 30%（分散學習 Distributed Practice）；' +
        '<b>④ 提早完成型</b>：P<sub>pre</sub> &lt; 10%（前置規劃 Pre-planning）。<br>' +
        `本次 P15 門檻：期中 ${Math.round(p15Mid)} 分鐘、期末 ${Math.round(p15Final)} 分鐘。` +
      '</div>' +
      '<div style="margin-top:5px;font-size:.73rem;color:var(--text-dim,#999)">' +
        '外圈 = 期末考；內圈 = 期中考。若資料未含考試分段時數，以總閱讀時數與考前7天時數估算，重跑 ETL 可取得精準值。' +
      '</div>';
  }

  function renderTimeSlotDonut(canvasId) {
    const canvas = document.getElementById(canvasId);
    if (!canvas || !_timeData) return;
    const rows   = _filteredStudentRows();
    const slots  = Object.keys(SLOT_LABELS);
    const values = slots.map(slot => _avg(rows.map(row => _num(row.timeSlotDistribution?.[slot]))) * 100);
    const totalDaily = _avg(rows.map(row => row.totalMinutes / Math.max(row.activeWeeks || 1, 1)));
    const card = canvas.closest(".chart-card") || canvas.parentElement;
    if (card) {
      let badgeEl = card.querySelector(".time-slot-filter-badge");
      if (!badgeEl) {
        badgeEl = document.createElement("div");
        badgeEl.className = "time-slot-filter-badge";
        canvas.parentElement.insertBefore(badgeEl, canvas);
      }
      // [Fix Q2] 改為可互動的 <select>，與全域篩選雙向同步
      const semOptions     = [
        `<option value="all"${_filterSemester === "all" ? " selected" : ""}>全部年度</option>`,
        ..._allSemesters.map(s => `<option value="${s}"${_normalizeSem(s) === _normalizeSem(_filterSemester) ? " selected" : ""}>${_formatSemLabel(s)}</option>`),
      ].join("");
      const clusterOptions = [
        `<option value="all"${_filterCluster === "all" ? " selected" : ""}>全部分群</option>`,
        ...Object.entries(CLUSTER_NAMES).map(([k, v]) => `<option value="${k}"${k === _filterCluster ? " selected" : ""}>${k} ${v}</option>`),
      ].join("");
      const passOptions    = [
        `<option value="all"${_filterPass === "all" ? " selected" : ""}>全部</option>`,
        `<option value="pass"${_filterPass === "pass" ? " selected" : ""}>及格</option>`,
        `<option value="fail"${_filterPass === "fail" ? " selected" : ""}>不及格</option>`,
      ].join("");
      const selectStyle = `font-size:.76rem;padding:2px 4px;border-radius:6px;border:1px solid var(--border,#2a2f45);background:var(--surface2,#1c2030);color:var(--text-mid,#9aa0b8);cursor:pointer;max-width:105px`;
      badgeEl.innerHTML =
        `<div style="display:flex;flex-wrap:nowrap;overflow-x:auto;align-items:center;box-sizing:border-box;max-width:100%;margin-bottom:8px;padding:5px 10px;border-radius:6px;background:var(--card-bg2,#1c2030);` +
        `border:1px solid rgba(110,130,165,.2);font-size:.75rem;color:var(--text-mid,#4f5f78);line-height:1.6;gap:6px;white-space:nowrap">` +
        `<span style="font-weight:700;flex-shrink:0">篩選條件</span>` +
        `<label style="display:flex;align-items:center;gap:3px;flex-shrink:0">📅 <select id="tsDonutSemFilter" onchange="BehaviorTimeTab.onFilterChange(this.id)" style="${selectStyle}">${semOptions}</select></label>` +
        `<label style="display:flex;align-items:center;gap:3px;flex-shrink:0">👥 <select id="tsDonutClusterFilter" onchange="BehaviorTimeTab.onFilterChange(this.id)" style="${selectStyle}">${clusterOptions}</select></label>` +
        `<label style="display:flex;align-items:center;gap:3px;flex-shrink:0">✅ <select id="tsDonutPassFilter" onchange="BehaviorTimeTab.onFilterChange(this.id)" style="${selectStyle}">${passOptions}</select></label>` +
        `</div>`;
    }
    ChartRegistry.destroyById(canvasId);  // BUG-2：整合 ChartRegistry
    _charts.timeSlot = new Chart(canvas.getContext("2d"), {
      type: "doughnut",
      data: {
        labels: slots.map(s => SLOT_LABELS[s]),
        datasets: [{ data: values, backgroundColor: SLOT_COLORS, borderWidth: 2, hoverOffset: 8 }],
      },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: "62%",
        plugins: {
          legend: { position: "bottom", align: "center", labels: { boxWidth: 26, boxHeight: 10, font: { size: 12, weight: "600" }, padding: 12 } },
          tooltip: {
            callbacks: {
              label:      ctx => ` 佔比：${ctx.raw.toFixed(1)}%`,
              afterLabel: ctx => {
                if (!totalDaily) return "";
                const ratio = values[ctx.dataIndex] / 100 || 0;
                return ` 每週約 ${Math.round(ratio * totalDaily)} 分鐘`;
              },
              footer: ctx => ctx.length ? [SLOT_TIPS[slots[ctx[0].dataIndex]] || ""] : [],
            },
          },
        },
      },
    });
    ChartRegistry.register(canvasId, _charts.timeSlot);  // BUG-T1：登記至 Registry
  }

  // ────────────────────────────────────────────────────────────
  // 新增功能一：AI 智慧洞察 Badge
  // ────────────────────────────────────────────────────────────

  /**
   * renderAIInsightBadge(containerId)
   * 插入 id="aiInsightBadge" 的容器（由 index.html 新增）
   * 觸發條件（三選一，最嚴重的優先顯示）：
   *   1. 深夜比例 > 40% 且成績低於全班平均 → 警告
   *   2. 深夜比例 > 40% 但成績正常         → 提示
   *   3. 深夜比例 <= 40%                   → 正向鼓勵
   */
  function renderAIInsightBadge(containerId) {
    const el = document.getElementById(containerId);
    if (!el || !_timeData) return;

    const rows = _filteredStudentRows();
    if (!rows.length) { el.innerHTML = ""; return; }

    // Phase D：優先讀 ETL 預聚合 segment_stats
    let avgLateNight, avgScore;
    const segKey  = _segmentKey();
    const segData = _timeData?.segment_stats?.[segKey];
    if (segData) {
      avgLateNight = segData.late_night_ratio_mean ?? 0;
      avgScore     = segData.avg_score ?? null;
    } else {
      // fallback：即時計算（原有邏輯）
      avgLateNight = _avg(rows.map(r => r.late_night_ratio));
      const scoredRows  = rows.filter(r => r.final_score != null || r.semester_score != null);
      const scoreValues = scoredRows.map(r => _num(r.final_score ?? r.semester_score));
      avgScore = scoreValues.length
        ? scoreValues.reduce((a, b) => a + b, 0) / scoreValues.length
        : null;
    }
    const lateNightPct = (avgLateNight * 100).toFixed(1);

    let icon, color, borderColor, title, message;

    if (avgLateNight > 0.4 && avgScore !== null && avgScore < PASS_THRESHOLD) {
      icon = "⚠️"; color = "rgba(231,76,60,0.12)"; borderColor = "rgba(231,76,60,0.45)";
      title = "深夜學習比例偏高，且成績低於及格線";
      message = `目前篩選群組深夜（23:00-06:00）學習比例達 ${lateNightPct}%，平均成績 ${avgScore.toFixed(1)} 分。
研究顯示（Fouh et al., 2014），集中於深夜且臨近截止日期的學習行為與較低學業表現顯著相關。
建議教師關注此群學生的學習節奏，並評估是否提前介入輔導。`;
    } else if (avgLateNight > 0.4) {
      icon = "💡"; color = "rgba(241,196,15,0.10)"; borderColor = "rgba(241,196,15,0.40)";
      title = "觀察到較高的深夜學習比例";
      message = `目前篩選群組深夜學習比例為 ${lateNightPct}%。
雖然成績尚在及格範圍，深夜學習長期可能影響睡眠與記憶鞏固效果。
建議將部分深夜學習段落移至午後或傍晚，有助於提升學習吸收率。`;
    } else {
      icon = "✅"; color = "rgba(46,204,113,0.08)"; borderColor = "rgba(46,204,113,0.35)";
      title = "學習時段分布健康";
      message = `目前篩選群組深夜學習比例為 ${lateNightPct}%，時間管理整體良好。
研究指出（Tabuenca et al., 2015），規律分散的學習節奏是自我調節學習能力的核心指標，
與長期學習成效正相關。`;
    }

    el.innerHTML = `
      <div style="
        margin-bottom:14px;padding:12px 14px;border-radius:10px;
        background:${color};border:1px solid ${borderColor};
        font-size:.82rem;line-height:1.7;color:var(--text,#dde3f5)
      ">
        <div style="font-weight:700;margin-bottom:5px;font-size:.85rem">
          ${icon} AI 洞察 &nbsp;<span style="font-weight:400;color:var(--text-dim,#888)">${title}</span>
        </div>
        <div style="color:var(--text-mid,#9aa0b8);white-space:pre-line">${message}</div>
      </div>`;
  }

  // ────────────────────────────────────────────────────────────
  // 新增功能二：學習規律熱力圖（SVG，7×24）
  // ────────────────────────────────────────────────────────────

  /**
   * renderStudyHeatmap(containerId)
   * 使用 SVG 繪製 7×24 熱力圖（優先使用 ETL 預聚合的 class_heatmap_matrix）
   * 篩選器啟用時，從 students[] 即時加總 heatmap_raw（前端唯一運算點）
   * hover tooltip 顯示：星期、時段、累計分鐘 / 正規化比例
   */
  function renderStudyHeatmap(containerId) {
    const wrap = document.getElementById(containerId);
    if (!wrap || !_timeData) return;

    // 決定資料來源
    let heatmapData = {};
    const isAllFilter = (_filterSemester === "all" && _filterCluster === "all" && _filterPass === "all");

    if (isAllFilter && _timeData.class_heatmap_matrix?.raw) {
      // 無篩選：直接用 ETL 預聚合（最快）
      heatmapData = _timeData.class_heatmap_matrix.raw;
    } else {
      // Phase D：有篩選時，優先讀 segment_stats 預聚合
      const segKey  = _segmentKey();
      const segData = _timeData?.segment_stats?.[segKey];
      if (segData?.heatmap_raw) {
        heatmapData = segData.heatmap_raw;
      } else {
        // fallback：從 students[] 加總（原有邏輯）
        const rows = _filteredStudentRows();
        rows.forEach(r => {
          Object.entries(r.heatmapRaw || {}).forEach(([key, val]) => {
            heatmapData[key] = (heatmapData[key] || 0) + val;
          });
        });
      }
    }

    // 計算最大值（正規化色階）
    const vals = Object.values(heatmapData).filter(v => v > 0);
    const maxVal = vals.length ? Math.max(...vals) : 1;

    // SVG 尺寸參數
    const cellW = 22, cellH = 18;
    const labelW = 22, labelH = 20;
    const lgH = 20; // 圖例區高度（內嵌於 SVG）
    const svgW = labelW + 24 * cellW;
    const svgH = labelH + 7 * cellH + lgH;


    // 建構 SVG

    let svgParts = [
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${svgW} ${svgH}" width="100%" style="min-width:${svgW}px;font-family:sans-serif;display:block">`,
    ];

    // 小時標籤（X 軸）
    for (let h = 0; h < 24; h++) {
      if (h % 3 === 0) {
        const x = labelW + h * cellW + cellW / 2;
        svgParts.push(`<text x="${x}" y="${labelH - 4}" text-anchor="middle" font-size="9" fill="#6b748f">${h}:00</text>`);
      }
    }

    // 星期標籤（Y 軸）＋ 格子
    WEEKDAY_LABELS.forEach((wd, wdIdx) => {
      const y = labelH + wdIdx * cellH;
      svgParts.push(`<text x="${labelW - 3}" y="${y + cellH / 2 + 4}" text-anchor="end" font-size="10" fill="#9aa0b8">${wd}</text>`);

      for (let h = 0; h < 24; h++) {
        const key = `${wdIdx}_${h}`;
        const val = heatmapData[key] || 0;
        const color = _heatColor(val, maxVal);
        const x = labelW + h * cellW;
        const mins = val > 0 ? `${Math.round(val)} 分鐘` : "無資料";
        // tip 用 JSON.stringify 確保換行符正確編碼為 \n（不含原始換行）
        const tipText = `星期${wd} ${h}:00–${h + 1}:00 | 累計學習：${mins}`;

        svgParts.push(
          `<rect x="${x + 1}" y="${y + 1}" width="${cellW - 2}" height="${cellH - 2}" rx="3"` +
          ` fill="${color}" opacity="0.9"` +
          ` data-tip="${tipText.replace(/"/g, "&quot;")}"` +
          ` style="cursor:default;transition:opacity .15s"` +
          `/>`
        );
      }
    });

    // 圖例（右下角，內嵌於 SVG）
    const lgX = svgW - 100, lgY = svgH - lgH + 4;
    svgParts.push(`<text x="${lgX}" y="${lgY + 10}" font-size="9" fill="#6b748f">少</text>`);
    for (let i = 0; i < 8; i++) {
      const t = i / 7;
      const r = Math.round(26  + t * (230 - 26));
      const g = Math.round(32  + t * (126 - 32));
      const b = Math.round(54  + (1 - t) * (219 - 54));
      svgParts.push(`<rect x="${lgX + 18 + i * 9}" y="${lgY}" width="8" height="10" rx="2" fill="rgb(${r},${g},${b})"/>`);
    }
    svgParts.push(`<text x="${lgX + 92}" y="${lgY + 10}" font-size="9" fill="#6b748f">多</text>`);

    svgParts.push("</svg>");

    wrap.innerHTML = `
      <div class="heatmap-scroll" style="overflow-x:auto">
        ${svgParts.join("")}
      </div>`;


    if (!wrap.dataset.heatmapBound) {
      wrap.dataset.heatmapBound = "1";
      wrap.addEventListener("mouseover", e => {
        const tip = e.target.dataset?.tip;
        if (tip && typeof showSvgTip === "function") showSvgTip(e, tip);
      });
      wrap.addEventListener("mouseleave", () => {
        if (typeof hideSvgTip === "function") hideSvgTip();
      });
    }
  }

  // ────────────────────────────────────────────────────────────
  // 新增功能三：24小時學習趨勢折線圖（含分群疊加）
  // ────────────────────────────────────────────────────────────

  /**
   * renderHourlyLine(canvasId)
   * X 軸：24 小時；Y 軸：正規化學習活躍度（0~1）
   * 預設顯示：全班平均
   * 可疊加：前25%高分群、及格群、不及格群
   * 篩選器有效時：從 students[] 即時加總；無篩選時使用 ETL 預聚合
   */

  const _noExamLinesPlugin = { id: "examVerticalLines", afterDraw() {} };

  function renderHourlyLine(canvasId) {
    const canvas = document.getElementById(canvasId);
    if (!canvas || !_timeData) return;

    const isAllFilter = (_filterSemester === "all" && _filterCluster === "all" && _filterPass === "all");
    const cohort = _timeData.cohort_hourly || {};

    // 全班（含篩選）
    let classNorm;
    if (isAllFilter && _timeData.class_avg_hourly_distribution?.normalized) {
      classNorm = _timeData.class_avg_hourly_distribution.normalized;
    } else {
      // Phase D：有篩選時，優先讀 segment_stats 預聚合
      const segKey  = _segmentKey();
      const segData = _timeData?.segment_stats?.[segKey];
      if (segData?.hourly_raw?.length) {
        const raw   = segData.hourly_raw;
        const total = raw.reduce((a, b) => a + b, 0);
        classNorm = total > 0 ? raw.map(v => v / total) : Array(24).fill(0);
      } else {
        // fallback：從 students[] 即時加總（原有邏輯）
        const rows = _filteredStudentRows();
        const acc  = Array(24).fill(0);
        rows.forEach(r => (r.hourlyRaw || []).forEach((v, h) => { acc[h] += v; }));
        const total = acc.reduce((a, b) => a + b, 0);
        classNorm = total > 0 ? acc.map(v => v / total) : Array(24).fill(0);
      }
    }

    // 分群（只在無篩選時使用 ETL 預聚合；有篩選時暫不疊加，避免與篩選邏輯衝突）
    const datasets = [
      {
        label: "全班平均",
        data:  classNorm,
        borderColor: COHORT_COLORS.class.border,
        backgroundColor: COHORT_COLORS.class.bg,
        fill: true, tension: 0.4, pointRadius: 2, borderWidth: 2,
      },
    ];

    if (isAllFilter) {
      if (cohort.top25?.normalized?.length) {
        datasets.push({
          label: "前25%高分群",
          data:  cohort.top25.normalized,
          borderColor: COHORT_COLORS.top25.border,
          backgroundColor: "transparent",
          fill: false, tension: 0.4, pointRadius: 2, borderWidth: 2, borderDash: [5, 3],
        });
      }
      if (cohort.pass?.normalized?.length) {
        datasets.push({
          label: "及格群",
          data:  cohort.pass.normalized,
          borderColor: COHORT_COLORS.pass.border,
          backgroundColor: "transparent",
          fill: false, tension: 0.4, pointRadius: 2, borderWidth: 1.5, borderDash: [3, 3],
        });
      }
      if (cohort.fail?.normalized?.length) {
        datasets.push({
          label: "不及格群",
          data:  cohort.fail.normalized,
          borderColor: COHORT_COLORS.fail.border,
          backgroundColor: "transparent",
          fill: false, tension: 0.4, pointRadius: 2, borderWidth: 1.5, borderDash: [2, 4],
        });
      }
    }

    ChartRegistry.destroyById(canvasId);  // BUG-2：整合 ChartRegistry
    _charts.hourlyLine = new Chart(canvas.getContext("2d"), {
      type: "line",
      plugins: [_noExamLinesPlugin],
      data: { labels: HOUR_LABELS, datasets },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        scales: {
          x: {
            ticks: { font: { size: 10 }, maxTicksLimit: 12 },
            title: { display: true, text: "時段（小時）", font: { size: 10 }, color: "#6b748f" },
          },
          y: {
            min: 0,
            ticks: {
              font: { size: 10 },
              callback: v => `${(v * 100).toFixed(1)}%`,
            },
            title: { display: true, text: "學習活躍度（正規化）", font: { size: 10 }, color: "#6b748f" },
          },
        },
        plugins: {
          legend: { position: "bottom", labels: { font: { size: 11 }, boxWidth: 22, boxHeight: 8, padding: 12 } },
          tooltip: {
            callbacks: {
              title: ctx => ctx.length ? `${ctx[0].label}` : "",
              label: ctx => ` ${ctx.dataset.label}：${(ctx.raw * 100).toFixed(2)}%`,
            },
          },
        },
      },
    });
    ChartRegistry.register(canvasId, _charts.hourlyLine);  // BUG-T1：登記至 Registry
  }

  // ── 公開 API ─────────────────────────────────────────────────
  function resetFilters() {
    _filterSemester = "all";
    _filterCluster  = "all";
    _filterPass     = "all";
    // Sync all filter selects back to "all"
    const semIds     = ["timeSemFilter",     "preExamSemFilter",     "tsDonutSemFilter"];
    const clusterIds = ["timeClusterFilter", "preExamClusterFilter", "tsDonutClusterFilter"];
    const passIds    = ["timePassFilter",    "preExamPassFilter",    "tsDonutPassFilter"];
    semIds    .forEach(id => { const el = document.getElementById(id); if (el) el.value = "all"; });
    clusterIds.forEach(id => { const el = document.getElementById(id); if (el) el.value = "all"; });
    passIds   .forEach(id => { const el = document.getElementById(id); if (el) el.value = "all"; });
    _renderAll();
  }

  return {
    init,
    onFilterChange,
    resetFilters,
    renderWeeklyQuiz,
    renderPreExamIntensity,
    renderTimeSlotDonut,
    renderAIInsightBadge,
    renderStudyHeatmap,
    renderHourlyLine,
  };
})();
