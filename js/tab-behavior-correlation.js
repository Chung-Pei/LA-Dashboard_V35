/**
 * tab-behavior-correlation.js
 * 相關性分析 Tab — Pearson 熱力圖 + 散佈圖
 * 依賴：Chart.js (scatter)、behavior-loader.js
 *
 * FIXED (2025-05):
 *   BUG1 — _applyFiltersAndRender 覆蓋 _corrData.scatter_data，
 *           導致篩選基底被污染；改以 _lastFiltered 傳遞給下游，不再動 _corrData。
 *   BUG2 — _scatterRows 直接讀 _corrData.scatter_data 而非篩選後資料；
 *           改為接受 rows 參數，fallback 順序：rows → _lastFiltered → _allScatterData。
 *   BUG3 — setCorrType 只呼叫 _renderHeatmap，未同步更新散佈圖；
 *           改呼叫 _applyFiltersAndRender 確保全部元件連動。
 *   BUG4 — _renderHeatmap 永遠讀 _corrData.pearson（ETL 全量預算值），
 *           篩選後熱力圖 r 值不更新；改為接受 filteredRows 參數，
 *           有篩選時以 _pearsonValue/_spearmanValue 即時重算，
 *           全量（all）時仍優先用 ETL 值避免不必要運算。
 *           篩選後 p-value 無法可靠估算，改顯示 n=筆數。
 *
 * FIXED (2025-05, v2):
 *   BUG5 — _pearsonValue / _spearmanValue 改回傳 {r, reason, n?} 診斷物件後，
 *           _liveR、showScatter 中的 rho、insights badge 中的 bestR 仍以舊格式
 *           純數字處理，導致 .toFixed()、Math.abs()、>= 0 等比較對物件運算失效；
 *           分別在 _liveR 回傳前解包、rhoResult?.r、_pearsonValue(...)?.r 修正。
 *   OPT1 — isUnfiltered 邏輯重複定義 3 次；提取為模組級 _isUnfiltered() helper。
 *
 * FIXED (2025-05, v3 — systematic-debugging):
 *   DEAD1 — corrLabelInFooter：計算後從未使用，移除。
 *   DEAD2 — _currentTarget：寫入後從未讀取，移除。
 *   DEAD3 — _allEduTypes：UI 已移除，收集後從未讀取，移除。
 *   DEAD4 — _scatterChart = null 後立即重賦值，多餘賦值移除。
 *   DEAD5 — 7 處行內 FIX BUGx 注解已整合入 header，清除。
 *   BUG6  — result?.r ?? result 舊格式相容分支：_getR 已統一回傳
 *           {r,...} 物件，純數字 fallback 永遠不會觸發且遮蔽型別錯誤；移除。
 *   OPT3  — segKey 字串在 _renderHeatmap / _renderInsightsBadge 重複計算；
 *           提取為 _segKey() helper。
 *   OPT4  — 重複分區注解 '取得篩選後資料' + '篩選快取' 合併為一。
 *   OPT5  — 熱力圖圖例 HTML 硬編碼，與 REASON_CONFIG 資料重複；
 *           改從 REASON_CONFIG 動態產生，維護單一來源。
 *
 * FIXED (2025-05, v4 — systematic-debugging):
 *   DEAD6 — _renderHeatmap 上方 BUG4 comment block（5行）已整合入 header，清除。
 *   DEAD7 — '// ── Modal 開關事件' 分區注解多餘，清除。
 *   DEAD8 — _filterEduType filter branch 在 _filteredScatterData 內：
 *           onFilterChange/resetFilters 皆硬設為 "all" 且無 UI，
 *           此 if 分支永遠不執行，移除。
 *   BUG7  — stat.p?.toFixed(4)：stat.p != null 已守衛，?.toFixed 多餘且遮蔽意圖；改為 .toFixed。
 *   OPT6  — _canUseSegPearson / _canUseSegBadge 含 _filterEduType === "all" 永遠 true；
 *           提取為 _canUseSeg() helper，移除冗餘條件，兩處共用。
 *
 * FIXED (2025-05, v5):
 *   BUG8  — _renderLaggedSection 顯示門檻 |r| >= 0.1 過高，導致多數學期篩選後
 *           rows.length === 0，tbody 靜默保留全量舊值，使用者看不出已連動。
 *           實測：學期 1112/1122 在門檻 0.1 下通過指標數為 0。
 *           修正：門檻降為 0.05，同步更新 footer 說明文字。
 *           同時修正 rows 為空時改顯示「無符合門檻」提示取代 return，確保舊內容被清除。
 */

const BehaviorCorrelationTab = (() => {

  // ── 欄位中文標籤 ─────────────────────────────────────────
  const FEAT_LABELS = {
    aud_completion_rate:          "聽覺教材完成率",
    aud_total_minutes:            "聽覺教材學習時間",
    vid_completion_rate:          "影音教材完成率",
    vid_total_minutes:            "影音教材學習時間",
    txt_completion_rate:          "文字教材完成率",
    txt_total_minutes:            "文字教材學習時間",
    sup_completion_rate:          "補充筆記完成率",
    sup_total_minutes:            "補充筆記學習時間",
    tut_total_minutes:            "輔導資源時間",
    quz_total_attempts:           "題庫作答次數",
    quz_pass_rate:                "題庫通過率",
    quz_coverage:                 "題庫涵蓋率",
    quz_late_cram:                "題庫考前集中度(3天)",
    total_learning_minutes:       "總學習時間",
    material_diversity_score:     "教材多樣性",
    consistency_score:            "學習穩定性",
    early_start_ratio:            "提早學習比例",
    cram_pattern_score:           "臨陣磨槍指數",
    pre_exam_intensity:           "考前學習強度",
    quz_first_attempt_accuracy:   "首答正確率",
    quz_final_accuracy:           "最終正確率",
    quz_score_delta:              "成績進步幅度",
    quz_cramming_ratio:           "考前7天刷題比",
  };

  const GRADE_LABELS = {
    grade_midterm:  "期中成績",
    grade_final:    "期末成績",
    grade_total:    "學期成績",
    midterm_score:  "期中成績",
    final_score:    "期末成績",
    semester_score: "學期成績",
  };

  const PASS_THRESHOLD_CORR = 60;   // 及格門檻（與 time tab 保持一致）

  // ── 無法計算原因設定（熱力圖診斷顯示用）────────────────────
  const REASON_CONFIG = {
    no_etl: {
      symbol:  "∅",
      label:   "ETL 無此欄位",
      detail:  "ETL 預算值中無此指標，請重跑 ETL 後重整頁面。",
      color:   "rgba(255,90,60,0.18)",
      border:  "1px solid rgba(255,90,60,0.5)",
      txtCls:  "text-danger",
    },
    insufficient: {
      symbol:  "n↓",
      label:   "樣本不足",
      detail:  "有效配對樣本數不足（需 ≥ 5）{nHint}，無法計算相關係數。",
      color:   "rgba(255,193,7,0.15)",
      border:  "1px solid rgba(255,193,7,0.45)",
      txtCls:  "text-warning",
    },
    no_variance: {
      symbol:  "σ=0",
      label:   "數值無變異",
      detail:  "所有人數值完全相同（變異數為 0）{nHint}，Pearson/Spearman 分母為零，無法計算。",
      color:   "rgba(120,130,160,0.12)",
      border:  "1px solid rgba(120,130,160,0.35)",
      txtCls:  "text-muted",
    },
  };

  let _corrData     = null;
  let _scatterChart = null;

  // ── 篩選狀態 ─────────────────────────────────────────────
  let _allScatterData   = null;   // 全量 scatter_data（篩選的基底）
  let _behaviorByMasked = null;   // masked_id → behavior student
  let _behaviorByAnon   = null;   // anon_id → behavior student
  let _allSemesters     = [];     // 可用學期列表
  let _filterSemester   = "all";
  let _filterCluster    = "all";
  let _filterPass       = "all";
  let _filterEduType    = "all";
  let _filterOutlier    = false;
  let _corrType         = "pearson";

  /** 判斷目前篩選狀態是否為「全量」（所有篩選器皆為 all，無排除異常值） */
  function _isUnfiltered() {
    return (
      _filterSemester === "all" &&
      _filterCluster  === "all" &&
      _filterPass     === "all" &&
      _filterEduType  === "all" &&
      !_filterOutlier
    );
  }

  /** segment_pearson 查詢鍵（學期|分群|及格狀況） */
  function _segKey() {
    return `${_filterSemester}|${_filterCluster}|${_filterPass}`;
  }

  /**
   * 是否可使用 segment_pearson 預聚合資料。
   * eduType 已無 UI，永遠為 "all"；排除異常值時 ETL 預聚合不適用。
   */
  function _canUseSeg() {
    return !_filterOutlier;
  }

  /**
   * 讀取目前相關係數矩陣中的 r 值。
   * Ph2b Breaking change：pearson 結構從純 float 改為 {r, p, significant}。
   * 此函式統一解包，確保整個 module 取到的都是 number | null。
   */
  function _pearson(feat, target) {
    const m = (_corrType === "spearman")
      ? (_corrData?.spearman || _corrData?.pearson || {})
      : (_corrData?.pearson || {});
    const raw = m[feat]?.[target] ?? m[target]?.[feat] ?? null;
    // 支援新格式 {r, p, significant} 與舊格式 number 並存
    if (raw !== null && typeof raw === "object") return raw.r ?? null;
    return raw;
  }

  /**
   * Ph2b 新增：讀取 p-value（僅 Pearson 模式下有效）。
   */
  function _pearsonP(feat, target) {
    const m = _corrData?.pearson || {};
    const raw = m[feat]?.[target] ?? m[target]?.[feat] ?? null;
    if (raw !== null && typeof raw === "object") return raw.p ?? null;
    return null;
  }

  function _targets() {
    if (_corrData?.targets?.length) return _corrData.targets;
    if (_corrData?.grades?.length)  return _corrData.grades;
    const p = _corrData?.pearson || {};
    const topKeys = Object.keys(p);
    // 如果頂層 key 是 grade 名稱（新格式 target→feat），直接回傳
    const gradeKeys = topKeys.filter(k => k in GRADE_LABELS);
    if (gradeKeys.length) return gradeKeys;
    return ["midterm_score", "final_score", "semester_score"];
  }

  function _features() {
    if (_corrData?.features?.length) return _corrData.features;
    const p = _corrData?.pearson || {};
    const targets = _targets();
    const fromTargetRows = targets.flatMap(target => Object.keys(p[target] || {}));
    if (fromTargetRows.length) return [...new Set(fromTargetRows)];
    return Object.keys(p);
  }

  function _scatterRows(feat, target, rows) {
    const raw = rows ?? _lastFiltered ?? _allScatterData ?? _corrData?.scatter_data ?? [];
    if (Array.isArray(raw)) {
      return raw
        .map(row => ({
          x: row.features?.[feat],
          y: row[target],
          masked_id: row.masked_id,
        }))
        .filter(row => row.x != null && row.y != null && isFinite(row.x) && isFinite(row.y));
    }
    return raw[`${feat}_vs_${target}`] || [];
  }

  function _toNumber(value) {
    if (value === null || value === undefined || value === "") return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function _hasUsableCorrelation(data) {
    const pearson = data?.pearson || {};
    const hasR = Object.values(pearson).some(row => {
      if (row && typeof row === "object") {
        return Object.values(row).some(v => {
          // 相容新格式 {r, p, significant} 與舊格式 float
          const rVal = (v && typeof v === "object") ? v.r : v;
          return Number.isFinite(Number(rVal));
        });
      }
      return Number.isFinite(Number(row));
    });
    const scatter = data?.scatter_data || [];
    const hasScatter = Array.isArray(scatter)
      ? scatter.length > 0
      : Object.keys(scatter).length > 0;
    return hasR && hasScatter;
  }

  /**
   * 回傳 { r: number } 或 { r: null, reason: string, n?: number }
   * reason 值：
   *   "no_etl"       — ETL 預算值本身缺失（全量模式專用，由 _getR 注入）
   *   "insufficient" — 有效配對樣本數不足（< 5）
   *   "no_variance"  — 所有人數值相同，變異數為 0
   */
  function _pearsonValue(rows, feat, target) {
    const pairs = rows
      .map(row => ({ x: _toNumber(row.features?.[feat]), y: _toNumber(row[target]) }))
      .filter(p => p.x !== null && p.y !== null);
    if (pairs.length < 5) return { r: null, reason: "insufficient", n: pairs.length };
    const meanX = pairs.reduce((sum, p) => sum + p.x, 0) / pairs.length;
    const meanY = pairs.reduce((sum, p) => sum + p.y, 0) / pairs.length;
    let num = 0;
    let denX = 0;
    let denY = 0;
    pairs.forEach(p => {
      const dx = p.x - meanX;
      const dy = p.y - meanY;
      num += dx * dy;
      denX += dx * dx;
      denY += dy * dy;
    });
    const den = Math.sqrt(denX * denY);
    if (!den) return { r: null, reason: "no_variance", n: pairs.length };
    return { r: Math.round((num / den) * 10000) / 10000 };
  }

  // ── Spearman 等級相關係數 ─────────────────────────────────
  function _rankArray(arr) {
    const n = arr.length;
    const indexed = arr.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
    const ranks = new Array(n);
    let i = 0;
    while (i < n) {
      let j = i;
      while (j < n && indexed[j].v === indexed[i].v) j++;
      const avg = (i + j + 1) / 2;
      for (let k = i; k < j; k++) ranks[indexed[k].i] = avg;
      i = j;
    }
    return ranks;
  }

  function _spearmanValue(rows, feat, target) {
    const pairs = rows
      .map(row => ({ x: _toNumber(row.features?.[feat]), y: _toNumber(row[target]) }))
      .filter(p => p.x !== null && p.y !== null);
    if (pairs.length < 5) return { r: null, reason: "insufficient", n: pairs.length };
    const xs = pairs.map(p => p.x);
    const ys = pairs.map(p => p.y);
    const rx = _rankArray(xs), ry = _rankArray(ys);
    const n = rx.length;
    const mX = rx.reduce((s, v) => s + v, 0) / n;
    const mY = ry.reduce((s, v) => s + v, 0) / n;
    let num = 0, dX = 0, dY = 0;
    for (let i = 0; i < n; i++) {
      const dx = rx[i] - mX, dy = ry[i] - mY;
      num += dx * dy; dX += dx * dx; dY += dy * dy;
    }
    const den = Math.sqrt(dX * dY);
    if (!den) return { r: null, reason: "no_variance", n };
    return { r: Math.round(num / den * 10000) / 10000 };
  }

  // ── 初始化 ───────────────────────────────────────────────

  async function init(heatmapId = "corrHeatmap", scatterWrapperId = "scatterSection") {
    BehaviorLoader.setLoading("tab-correlation", true);
    try {
      // 同步載入 correlation + behavior（用於分群 join）
      const [corrRaw, behaviorData] = await Promise.all([
        BehaviorLoader.load.correlation(),
        BehaviorLoader.load.behavior().catch(() => null),
      ]);

      _corrData = corrRaw;

      // 若 ETL 資料不完整（無 scatter 或無欄位）直接提示，不再前端重建
      if (!_hasUsableCorrelation(_corrData)) {
        BehaviorLoader.showError("tab-correlation", "correlation.json 資料不完整，請重跑 ETL 後重新整理頁面。");
        return;
      }

      // 建立 masked_id → behavior student 索引（取得 cluster）
      const bStudents = behaviorData?.students || [];
      _behaviorByMasked = new Map(bStudents.map(s => [s.masked_id, s]));
      _behaviorByAnon = new Map(bStudents.map(s => [s.anon_id, s]));

      // 備份全量並 join cluster 欄位
      const raw = _corrData?.scatter_data || [];
      _allScatterData = Array.isArray(raw)
        ? raw.map(row => {
            const behaviorRow = _behaviorByAnon.get(row.anon_id) || _behaviorByMasked.get(row.masked_id);
            return {
              ...row,
              cluster:  row.cluster  || behaviorRow?.cluster  || "",
              semester: row.semester || behaviorRow?.semester  || "",
              edu_type: row.edu_type || "",
            };
          })
        : raw;

      // 收集可用學期（從 meta）
      _allSemesters = Array.isArray(_corrData?.meta?.semesters)
        ? _corrData.meta.semesters
        : (behaviorData?.meta?.semesters || []);

      _filterSemester = "all";
      _filterCluster  = "all";
      _filterPass     = "all";
      _filterEduType  = "all";
      _filterOutlier  = false;

      _renderFilterBar(heatmapId);
      _applyFiltersAndRender(heatmapId, scatterWrapperId);
    } catch (err) {
      BehaviorLoader.showError("tab-correlation", err.message);
    } finally {
      BehaviorLoader.setLoading("tab-correlation", false);
    }
  }

  // ── 篩選列 ───────────────────────────────────────────────

  function _formatSemLabel(sem) {
    const s = String(sem || "").trim();
    const m = s.match(/^(\d{3})-?([12])$/);
    return m ? `${m[1]}(${m[2]})` : s;
  }

  const CLUSTER_NAMES_CORR = {
    P1: "影音輔導型", P2: "彈性聽覺型", P3: "平均使用型",
    P4: "題庫刷題型", P5: "被動低參與型",
  };

  function _renderFilterBar(insertBeforeId) {
    const anchor = document.getElementById(insertBeforeId);
    if (!anchor) return;

    // 避免重複插入
    const existing = document.getElementById("corrFilterBar");
    if (existing) { existing.remove(); }

    const semOptions = [
      `<option value="all">全部學期</option>`,
      ..._allSemesters.map(s => `<option value="${s}">${_formatSemLabel(s)}</option>`),
    ].join("");

    const _clCounts = {};
    if (Array.isArray(_allScatterData)) {
      _allScatterData.forEach(r => { const c = r.cluster || ""; if (c) _clCounts[c] = (_clCounts[c] || 0) + 1; });
    }
    const clusterOptions = [
      `<option value="all">全部分群（${Array.isArray(_allScatterData) ? _allScatterData.length : "—"}）</option>`,
      ...Object.entries(CLUSTER_NAMES_CORR).map(([k, n]) => {
        const cnt = _clCounts[k] || 0;
        const dis = cnt === 0 ? " disabled" : "";
        return `<option value="${k}"${dis}>${k} ${n}${cnt > 0 ? "（" + cnt + "）" : "（無資料）"}</option>`;
      }),
    ].join("");

    const passOptions = [
      `<option value="all">全部</option>`,
      `<option value="pass">及格</option>`,
      `<option value="fail">不及格</option>`,
    ].join("");

    const hasOutlierData = Object.keys(_corrData?.outlier_thresholds || {}).length > 0;

    const bar = document.createElement("div");
    bar.id = "corrFilterBar";
    bar.style.cssText = "display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-bottom:12px;padding:10px 12px;border:1px solid rgba(110,130,165,.22);border-radius:10px;background:var(--card-bg2,#1c2030)";
    bar.innerHTML = `
      <span style="font-size:.8rem;font-weight:700;color:var(--text-mid,#4f5f78);white-space:nowrap">篩選條件</span>
      <div style="display:flex;align-items:center;gap:5px">
        <label style="font-size:.78rem;color:var(--text-dim,#888);white-space:nowrap">學期</label>
        <select id="corrSemFilter"
                style="font-size:.8rem;padding:3px 7px;border-radius:7px;border:1px solid var(--border,#2a2f45);background:var(--surface2,#1c2030);color:var(--text-mid,#9aa0b8);cursor:pointer">
          ${semOptions}
        </select>
      </div>
      <div style="display:flex;align-items:center;gap:5px">
        <label style="font-size:.78rem;color:var(--text-dim,#888);white-space:nowrap">分群</label>
        <select id="corrClusterFilter"
                style="font-size:.8rem;padding:3px 7px;border-radius:7px;border:1px solid var(--border,#2a2f45);background:var(--surface2,#1c2030);color:var(--text-mid,#9aa0b8);cursor:pointer">
          ${clusterOptions}
        </select>
      </div>
      <div style="display:flex;align-items:center;gap:5px">
        <label style="font-size:.78rem;color:var(--text-dim,#888);white-space:nowrap">及格狀況</label>
        <select id="corrPassFilter"
                style="font-size:.8rem;padding:3px 7px;border-radius:7px;border:1px solid var(--border,#2a2f45);background:var(--surface2,#1c2030);color:var(--text-mid,#9aa0b8);cursor:pointer">
          ${passOptions}
        </select>
      </div>
      ${hasOutlierData ? `
      <div style="display:flex;align-items:center;gap:5px">
        <label style="font-size:.78rem;color:var(--text-dim,#888);white-space:nowrap;cursor:pointer" for="corrOutlierToggle">
          <input type="checkbox" id="corrOutlierToggle"
                 style="margin-right:4px;cursor:pointer">
          排除異常值
        </label>
      </div>` : ""}
      <span id="corrFilterCount" style="font-size:.76rem;color:var(--text-dim,#888)"></span>
      <span style="margin-left:auto;display:inline-flex;align-items:center;gap:5px">
        <span style="font-size:.76rem;color:var(--text-dim,#888)">方法</span>
        <button id="btnCorrPearson" data-corr-type="pearson">Pearson <i>r</i></button>
        <button id="btnCorrSpearman" data-corr-type="spearman">Spearman <i>ρ</i></button>
      </span>`;

    anchor.parentNode.insertBefore(bar, anchor);
    _bindFilterBar(bar);
    _updateCorrTypeButtons();
  }

  function _bindFilterBar(bar) {
    ["corrSemFilter", "corrClusterFilter", "corrPassFilter", "corrOutlierToggle"].forEach(id => {
      const el = bar.querySelector(`#${id}`);
      if (el) el.addEventListener("change", onFilterChange);
    });
    bar.querySelectorAll("[data-corr-type]").forEach(btn => {
      btn.addEventListener("click", () => setCorrType(btn.dataset.corrType));
    });
  }

  function _updateCorrTypeButtons() {
    const btnP = document.getElementById("btnCorrPearson");
    const btnS = document.getElementById("btnCorrSpearman");
    if (!btnP || !btnS) return;
    const ip = _corrType === "pearson";
    const ac = "var(--accent,#3498db)";
    btnP.style.cssText = `font-size:.76rem;padding:3px 9px;border-radius:6px 0 0 6px;border:1px solid ${ac};background:${ip ? ac : "transparent"};color:${ip ? "#fff" : ac};cursor:pointer;font-family:inherit;font-weight:${ip ? "700" : "400"}`;
    btnS.style.cssText = `font-size:.76rem;padding:3px 9px;border-radius:0 6px 6px 0;border:1px solid ${ac};background:${ip ? "transparent" : ac};color:${ip ? ac : "#fff"};cursor:pointer;font-family:inherit;font-weight:${ip ? "400" : "700"}`;
  }

  function setCorrType(type) {
    _corrType = type;
    _lastFilterKey = null;   // 強制清快取，確保重新過濾
    _updateCorrTypeButtons();
    _applyFiltersAndRender("corrHeatmap", "scatterSection");
  }

  function onFilterChange() {
    _filterSemester = document.getElementById("corrSemFilter")?.value     || "all";
    _filterCluster  = document.getElementById("corrClusterFilter")?.value  || "all";
    _filterPass     = document.getElementById("corrPassFilter")?.value     || "all";
    _filterEduType  = "all";  // 修課類型 UI 已移除（規格書 §四），內部邏輯保留備用
    _filterOutlier  = document.getElementById("corrOutlierToggle")?.checked ?? false;
    _lastFilterKey  = null;
    _applyFiltersAndRender("corrHeatmap", "scatterSection");
  }

  function resetFilters() {
    _filterSemester = "all";
    _filterCluster  = "all";
    _filterPass     = "all";
    _filterEduType  = "all";
    _filterOutlier  = false;
    _lastFilterKey  = null;
    // Sync selects back to "all"
    const semEl     = document.getElementById("corrSemFilter");
    const clusterEl = document.getElementById("corrClusterFilter");
    const passEl    = document.getElementById("corrPassFilter");
    const outlierEl = document.getElementById("corrOutlierToggle");
    if (semEl)     semEl.value     = "all";
    if (clusterEl) clusterEl.value = "all";
    if (passEl)    passEl.value    = "all";
    if (outlierEl) outlierEl.checked = false;
    _applyFiltersAndRender("corrHeatmap", "scatterSection");
  }

  // ── 篩選快取：條件未變時不重新過濾 ─────────────────────────
  let _lastFilterKey  = null;
  let _lastFiltered   = null;

  function _filteredScatterData() {
    const key = `${_filterSemester}|${_filterCluster}|${_filterPass}|${_filterEduType}|${_filterOutlier}`;
    if (key === _lastFilterKey && _lastFiltered !== null) return _lastFiltered;

    const raw = _allScatterData;
    if (!Array.isArray(raw)) { _lastFilterKey = key; _lastFiltered = raw; return raw; }

    const thresholds = _corrData?.outlier_thresholds || {};
    _lastFiltered = raw.filter(row => {
      if (_filterSemester !== "all") {
        const rowSem = String(row.semester || "").replace(/-/g,"");
        const selSem = String(_filterSemester).replace(/-/g,"");
        if (rowSem && rowSem !== selSem) return false;
      }
      if (_filterCluster !== "all") {
        if ((row.cluster || "") !== _filterCluster) return false;
      }
      if (_filterPass !== "all") {
        const score = _toNumber(row.semester_score ?? row.final_score ?? row.grade_total);
        if (score === null) return false;
        const passing = score >= PASS_THRESHOLD_CORR;
        if (_filterPass === "pass" && !passing) return false;
        if (_filterPass === "fail" && passing) return false;
      }
      if (_filterOutlier && Object.keys(thresholds).length) {
        for (const [feat, bounds] of Object.entries(thresholds)) {
          const val = _toNumber(row.features?.[feat]);
          if (val === null) continue;
          if (val < bounds.iqr_lower || val > bounds.iqr_upper) return false;
        }
      }
      return true;
    });
    _lastFilterKey = key;
    return _lastFiltered;
  }

  function _applyFiltersAndRender(heatmapId, scatterWrapperId) {
    const filtered = _filteredScatterData();
    const count = Array.isArray(filtered) ? filtered.length : "—";

    const countEl = document.getElementById("corrFilterCount");
    if (countEl) countEl.textContent = `共 ${count} 筆`;

    _renderInsightsBadge(heatmapId, filtered);
    _renderHeatmap(heatmapId, filtered);
    _renderScatterSelector(scatterWrapperId, filtered);
    _renderLaggedSection(scatterWrapperId, filtered);
  }

  /**
   * C3：時間滯後相關性摘要表。
   * 讀取 _corrData.lagged_pearson（ETL 產出結構），插入於散佈圖容器下方。
   * 篩選模式下，r 值以 _pearsonValue/_spearmanValue 即時重算取代 ETL 靜態值。
   * 無資料時靜默不顯示。
   *
   * @param {string} afterId        - DOM 容器 id
   * @param {Array|null} filteredRows - 篩選後資料列；null 表示全量模式
   */
  function _renderLaggedSection(afterId, filteredRows) {
    const anchor = document.getElementById(afterId);
    if (!anchor) return;

    const lagged = _corrData?.lagged_pearson;
    if (!lagged?.results || !Object.keys(lagged.results).length) return;

    const { front_target, back_target, results } = lagged;
    const frontLabel = GRADE_LABELS[front_target] || front_target;
    const backLabel  = GRADE_LABELS[back_target]  || back_target;

    // 判斷是否為全量模式（篩選器皆為 all）
    const isUnfiltered = _isUnfiltered();

    // 篩選模式下即時重算 r 值，取代 ETL 靜態值
    const activeRows = (!isUnfiltered && Array.isArray(filteredRows) && filteredRows.length > 0)
      ? filteredRows
      : null;

    // 重建 rows：篩選模式下動態計算 front r / back r / lag_delta
    const rows = Object.entries(results)
      .map(([feat, v]) => {
        if (!activeRows) return [feat, v];  // 全量：直接用 ETL 值
        const frResult = _pearsonValue(activeRows, feat, front_target);
        const brResult = _pearsonValue(activeRows, feat, back_target);
        const fr = frResult?.r ?? null;
        const br = brResult?.r ?? null;
        const lagDelta = (fr != null && br != null) ? +(br - fr).toFixed(4) : null;
        return [feat, {
          front: fr != null ? { r: fr, p: null, significant: false } : null,
          back:  br != null ? { r: br, p: null, significant: false } : null,
          lag_delta: lagDelta,
        }];
      })
      .filter(([, v]) => {
        const fr = v.front?.r, br = v.back?.r;
        return (fr != null && Math.abs(fr) >= 0.05) || (br != null && Math.abs(br) >= 0.05);
      })
      .sort(([, a], [, b]) => Math.abs(b.lag_delta ?? 0) - Math.abs(a.lag_delta ?? 0));

    // BUG8 FIX：rows 為空時不能靜默 return，必須清除 tbody 舊內容
    if (!rows.length) {
      const existing = document.getElementById("corrLaggedSection");
      const tbody = existing?.querySelector("tbody");
      if (tbody) {
        const n = Array.isArray(filteredRows) ? filteredRows.length : "—";
        tbody.innerHTML = `<tr><td colspan="4" class="text-center text-muted small py-2">此篩選條件下無 |r| ≥ 0.05 的指標（n=${n}）</td></tr>`;
      }
      return;
    }

    const _rCell = (stat) => {
      if (!stat || stat.r == null) return `<td class="text-center text-muted small">—</td>`;
      const r   = stat.r;
      const bg  = _rToColor(r);
      const tc  = Math.abs(r) > 0.45 ? "#fff" : "var(--text,#dde3f5)";
      const sig = (!activeRows && stat.significant) ? "*" : "";
      const tipDetail = activeRows
        ? `n=${activeRows.length}`
        : (stat.p != null ? `p=${stat.p < 1e-6 ? "<0.000001" : stat.p.toFixed(4)}` : "");
      return `<td class="text-center small"
                  style="background:${bg};color:${tc}"
                  title="r=${r >= 0 ? "+" : ""}${r.toFixed(3)} ${tipDetail}">
                ${r >= 0 ? "+" : ""}${r.toFixed(2)}${sig}
              </td>`;
    };

    const _deltaCell = (delta) => {
      if (delta == null) return `<td class="text-center text-muted small">—</td>`;
      const color = delta > 0.05
        ? "rgba(39,174,96,0.85)"
        : delta < -0.05
          ? "rgba(192,57,43,0.85)"
          : "var(--text-mid,#9aa0b8)";
      const arrow = delta > 0.02 ? "▲" : delta < -0.02 ? "▼" : "≈";
      return `<td class="text-center small fw-bold" style="color:${color}">
                ${arrow} ${delta >= 0 ? "+" : ""}${delta.toFixed(3)}
              </td>`;
    };

    const tableRows = rows.map(([feat, v]) => `
      <tr>
        <td class="small text-nowrap pe-2">${escapeHtml(FEAT_LABELS[feat] || feat)}</td>
        ${_rCell(v.front)}
        ${_rCell(v.back)}
        ${_deltaCell(v.lag_delta)}
      </tr>`).join("");

    // 若外框已存在，僅更新 tbody，避免整個 DOM 重建造成 Layout Reflow
    const existing = document.getElementById("corrLaggedSection");
    if (existing) {
      const tbody = existing.querySelector("tbody");
      if (tbody) { tbody.innerHTML = tableRows; return; }
      existing.remove();
    }

    const section = document.createElement("div");
    section.id = "corrLaggedSection";
    section.style.cssText = "margin-top:20px";
    section.innerHTML = `
      <h6 class="fw-semibold mb-1" style="font-size:.88rem;display:flex;align-items:center;gap:8px">
        ⏱ 時間滯後相關性
        <span style="font-size:.75rem;font-weight:400;color:var(--text-dim,#888)">
          行為指標 vs 前段（${frontLabel}）/ 後段（${backLabel}）
        </span>
        <button id="btnLaggedHelp"
          style="margin-left:4px;width:18px;height:18px;border-radius:50%;border:1px solid var(--accent,#3498db);
                 background:transparent;color:var(--accent,#3498db);font-size:.7rem;font-weight:700;
                 cursor:pointer;line-height:1;padding:0;flex-shrink:0"
          title="說明此分析圖">?</button>
      </h6>

      <!-- 說明 Modal -->
      <div id="laggedHelpModal" style="display:none;position:fixed;inset:0;z-index:9999;
           background:rgba(0,0,0,.6);overflow-y:auto;padding:24px 12px">
        <div style="max-width:620px;margin:auto;background:var(--card-bg,#1a1f35);border:1px solid var(--border,#2a3050);
                    border-radius:14px;padding:28px 28px 22px;position:relative;font-size:.88rem;
                    color:var(--text,#dde3f5);line-height:1.75">
          <button id="btnLaggedHelpClose"
            style="position:absolute;top:14px;right:16px;background:transparent;border:none;
                   font-size:1.3rem;color:var(--text-dim,#888);cursor:pointer;line-height:1">✕</button>

          <h5 style="margin:0 0 18px;font-size:1rem;color:var(--text,#eef)">
            ⏱ 時間滯後相關性分析說明
          </h5>

          <div style="margin-bottom:16px">
            <div style="font-weight:700;color:var(--accent,#3498db);margin-bottom:6px">▍ 分析目的</div>
            <p style="margin:0">
              判斷某項學習行為對「前段成績（${frontLabel}）」與「後段成績（${backLabel}）」的預測力是否存在差異。
              若一個行為與後段成績的相關性明顯高於前段，代表這個行為的效果需要時間積累才能顯現；
              反之，若前段相關性更高，代表行為對早期表現影響更即時。
            </p>
          </div>

          <div style="margin-bottom:16px">
            <div style="font-weight:700;color:var(--accent,#3498db);margin-bottom:6px">▍ 計算原理</div>
            <p style="margin:0 0 8px">
              對每項學習行為指標，分別計算其與前段、後段成績的 Pearson 相關係數（r），
              再取兩者之差作為「預測增量 Δ」：
            </p>
            <div style="background:rgba(52,152,219,.08);border-left:3px solid var(--accent,#3498db);
                        border-radius:0 6px 6px 0;padding:10px 14px;font-family:monospace;font-size:.85rem">
              Δ = r（${backLabel}）− r（${frontLabel}）
            </div>
            <p style="margin:8px 0 0;color:var(--text-dim,#9aa0b8);font-size:.82rem">
              僅顯示至少一欄 |r| ≥ 0.05 的指標，並依 |Δ| 由大到小排序，讓差異最顯著的行為優先呈現。
            </p>
          </div>

          <div style="margin-bottom:16px">
            <div style="font-weight:700;color:var(--accent,#3498db);margin-bottom:6px">▍ 欄位說明</div>
            <table style="width:100%;border-collapse:collapse;font-size:.82rem">
              <thead>
                <tr style="color:var(--text-dim,#888);border-bottom:1px solid var(--border,#2a3050)">
                  <th style="text-align:left;padding:4px 8px;font-weight:600">欄位</th>
                  <th style="text-align:left;padding:4px 8px;font-weight:600">說明</th>
                </tr>
              </thead>
              <tbody>
                <tr style="border-bottom:1px solid rgba(255,255,255,.06)">
                  <td style="padding:6px 8px;white-space:nowrap">${frontLabel}</td>
                  <td style="padding:6px 8px">該行為指標與前段考試成績的 Pearson r 值，色彩同熱力圖（藍正紅負）</td>
                </tr>
                <tr style="border-bottom:1px solid rgba(255,255,255,.06)">
                  <td style="padding:6px 8px;white-space:nowrap">${backLabel}</td>
                  <td style="padding:6px 8px">該行為指標與後段考試成績的 Pearson r 值</td>
                </tr>
                <tr>
                  <td style="padding:6px 8px;white-space:nowrap">Δ 預測增量</td>
                  <td style="padding:6px 8px">後段 r − 前段 r，反映行為預測力的時間性偏移方向與幅度</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div style="margin-bottom:20px">
            <div style="font-weight:700;color:var(--accent,#3498db);margin-bottom:10px">▍ 結果判讀</div>
            <div style="display:flex;flex-direction:column;gap:8px">
              <div style="display:flex;align-items:flex-start;gap:10px;padding:10px 12px;
                          background:rgba(39,174,96,.08);border:1px solid rgba(39,174,96,.25);border-radius:8px">
                <span style="font-size:1rem;flex-shrink:0">▲</span>
                <div>
                  <div style="font-weight:600;color:rgba(39,174,96,.95)">正增量（Δ &gt; +0.05）</div>
                  <div style="font-size:.82rem;color:var(--text-dim,#9aa0b8);margin-top:2px">
                    後段相關性顯著高於前段。行為效果遞延累積，學習投入需要時間才能反映在成績上。
                    例如：穩定的學習頻率在期末比期中更有預測力，代表持續性習慣的長期回報。
                  </div>
                </div>
              </div>
              <div style="display:flex;align-items:flex-start;gap:10px;padding:10px 12px;
                          background:rgba(192,57,43,.08);border:1px solid rgba(192,57,43,.25);border-radius:8px">
                <span style="font-size:1rem;flex-shrink:0">▼</span>
                <div>
                  <div style="font-weight:600;color:rgba(220,80,60,.95)">負增量（Δ &lt; −0.05）</div>
                  <div style="font-size:.82rem;color:var(--text-dim,#9aa0b8);margin-top:2px">
                    前段相關性顯著高於後段。行為對即時表現影響更強，但效果難以持續。
                    例如：考前集中刷題對期中分數預測力較強，但此策略在期末已相對式微。
                  </div>
                </div>
              </div>
              <div style="display:flex;align-items:flex-start;gap:10px;padding:10px 12px;
                          background:rgba(120,130,160,.08);border:1px solid rgba(120,130,160,.25);border-radius:8px">
                <span style="font-size:1rem;flex-shrink:0">≈</span>
                <div>
                  <div style="font-weight:600;color:var(--text-mid,#9aa0b8)">近零增量（−0.05 ≤ Δ ≤ +0.05）</div>
                  <div style="font-size:.82rem;color:var(--text-dim,#9aa0b8);margin-top:2px">
                    前後段預測力相近，行為的影響力在時間軸上穩定一致，無明顯遞延或遞減效應。
                  </div>
                </div>
              </div>
              <div style="display:flex;align-items:flex-start;gap:10px;padding:10px 12px;
                          background:rgba(120,130,160,.05);border:1px solid rgba(120,130,160,.18);border-radius:8px">
                <span style="font-size:1rem;flex-shrink:0">—</span>
                <div>
                  <div style="font-weight:600;color:var(--text-mid,#9aa0b8)">無法計算（—）</div>
                  <div style="font-size:.82rem;color:var(--text-dim,#9aa0b8);margin-top:2px">
                    該指標在此分群或篩選條件下樣本數不足（&lt; 5）、或所有人數值相同（變異數為 0），
                    無法計算相關係數，Δ 亦無法得出。
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div style="background:rgba(255,193,7,.07);border:1px solid rgba(255,193,7,.2);
                      border-radius:8px;padding:10px 14px;font-size:.8rem;color:var(--text-dim,#9aa0b8)">
            ⚠️ <strong style="color:var(--text,#dde3f5)">解讀注意</strong>：
            Δ 反映的是相關性方向，而非因果關係。相關係數受樣本數、異常值及指標定義影響，
            建議搭配散佈圖與分群篩選進一步確認。全量模式下標 * 者代表 p &lt; 0.05（統計顯著）。
          </div>
        </div>
      </div>

      <div class="table-responsive">
        <table class="table table-sm table-bordered mb-1" style="font-size:.83rem">
          <thead>
            <tr>
              <th class="text-muted fw-normal">學習行為指標</th>
              <th class="text-center fw-normal small" style="min-width:80px">${frontLabel}</th>
              <th class="text-center fw-normal small" style="min-width:80px">${backLabel}</th>
              <th class="text-center fw-normal small" title="後段r − 前段r，正值代表行為對後期預測力更強"
                  style="min-width:80px">Δ 預測增量</th>
            </tr>
          </thead>
          <tbody>${tableRows}</tbody>
        </table>
      </div>
      <div class="text-muted small mb-0" style="line-height:1.9">
        <div>
          <span style="color:rgba(39,174,96,.9);font-weight:600">▲ 正增量（Δ &gt; +0.05）</span>
          後段相關性顯著高於前段，行為效果遞延累積，學習習慣長期回報更佳。
        </div>
        <div>
          <span style="color:rgba(220,80,60,.9);font-weight:600">▼ 負增量（Δ &lt; −0.05）</span>
          前段相關性顯著高於後段，行為對即時表現影響更強，但效果難以持續至後段。
        </div>
        <div>
          <span style="color:var(--text-mid,#9aa0b8);font-weight:600">≈ 近零增量（|Δ| ≤ 0.05）</span>
          前後段預測力相近，行為影響力在時間軸上穩定一致。
        </div>
        <div>
          <span style="color:var(--text-mid,#9aa0b8);font-weight:600">— 無法計算</span>
          樣本不足（&lt; 5 筆）或所有人數值相同（σ = 0），Δ 無法得出。
        </div>
        <div style="margin-top:2px;opacity:.7">色彩同熱力圖（藍正紅負）。全量模式標 * 者 p &lt; 0.05。僅顯示 |r| ≥ 0.05 的指標。</div>
      </div>`;

    anchor.parentNode.insertBefore(section, anchor.nextSibling);

    const modal    = section.querySelector("#laggedHelpModal");
    const btnOpen  = section.querySelector("#btnLaggedHelp");
    const btnClose = section.querySelector("#btnLaggedHelpClose");
    btnOpen.addEventListener("click",  () => { modal.style.display = "block"; });
    btnClose.addEventListener("click", () => { modal.style.display = "none";  });
    modal.addEventListener("click", e => { if (e.target === modal) modal.style.display = "none"; });
  }

  // ── Pearson 熱力圖（HTML table + 色彩映射）────────────────
  function _renderHeatmap(containerId, filteredRows) {
    const el = document.getElementById(containerId);
    if (!el || !_corrData) return;

    const features   = _features();
    const grades     = _targets();
    const isSpearman = _corrType === "spearman";
    const corrSym    = isSpearman ? "ρ" : "r";

    // 判斷是否為「全量」模式：篩選狀態全為 all 且無排除異常值
    const isUnfiltered = _isUnfiltered();

    if (!features.length || !grades.length) {
      el.innerHTML = `<p class="text-muted small">相關性資料格式缺少 features / targets。</p>`;
      return;
    }

    /**
     * 取得 r 值：
     *   全量模式 → 優先讀 ETL 預算值（精確且含 p-value）
     *   篩選模式 → 即時重算（_pearsonValue / _spearmanValue）
     */
    // Phase D：segData 僅在未排除異常值時可用（ETL 無 eduType / outlier 維度預聚合）
    const segKey  = _segKey();
    const segData = _canUseSeg() ? (_corrData?.segment_pearson?.[segKey] ?? null) : null;

    function _getR(feat, g) {
      if (isUnfiltered) {
        // 全量：讀 ETL 預算值
        const r = _pearson(feat, g);
        if (r == null) return { r: null, reason: "no_etl" };
        return { r };
      }
      // Phase D：篩選模式，優先讀 segment_pearson 預聚合
      if (segData?.pearson) {
        const rObj = segData.pearson[g]?.[feat] ?? segData.pearson[feat]?.[g];
        if (rObj != null) {
          const r = typeof rObj === "object" ? (rObj.r ?? null) : rObj;
          if (r == null) return { r: null, reason: "no_etl" };
          return { r };
        }
      }
      // fallback：即時重算（回傳完整診斷物件）
      const rows = Array.isArray(filteredRows) ? filteredRows : (_lastFiltered ?? _allScatterData ?? []);
      return isSpearman
        ? _spearmanValue(rows, feat, g)
        : _pearsonValue(rows, feat, g);
    }

    // 篩選後資料列數（用於 tooltip n=N 顯示）
    const nCount = Array.isArray(filteredRows) ? filteredRows.length
                 : Array.isArray(_allScatterData) ? _allScatterData.length
                 : null;

    const gradeHeaderCells = grades.map(g =>
      `<th class="text-center small fw-normal" style="min-width:90px">
        ${escapeHtml(GRADE_LABELS[g] || g)}
      </th>`
    ).join("");

    const rows = features.map(feat => {
      const cells = grades.map(g => {
        const result = _getR(feat, g);
        const r      = result.r;

        // ── r 值無效：依 reason 顯示診斷符號與 tooltip ──────
        if (r == null) {
          const reason = result?.reason ?? "no_etl";
          const nHint  = (result?.n != null) ? `（有效樣本 ${result.n} 筆）` : "";
          const cfg    = REASON_CONFIG[reason] ?? REASON_CONFIG.no_etl;
          const detail = cfg.detail.replace("{nHint}", nHint);
          const featLabel  = escapeHtml(FEAT_LABELS[feat] || feat);
          const gradeLabel = escapeHtml(GRADE_LABELS[g] || g);
          const tipText    = `${featLabel} vs ${gradeLabel}：${cfg.label}｜${detail}`;

          return `<td class="text-center small ${cfg.txtCls}"
                      style="background:${cfg.color};border:${cfg.border};cursor:help"
                      title="${escapeHtml(tipText)}">
                    <span style="font-size:.75em;letter-spacing:.02em">${cfg.symbol}</span>
                  </td>`;
        }

        // ── r 值正常 ─────────────────────────────────────────
        const bg        = _rToColor(r);
        const textColor = Math.abs(r) > 0.55 ? "#fff" : "var(--text,#dde3f5)";

        // 全量時顯示 ETL p-value 顯著性標記；篩選後改顯示 n=N（p 值不可靠）
        let sig = "";
        let tipExtra = "";
        if (isUnfiltered && _corrType === "pearson") {
          const p = _pearsonP(feat, g);
          if (p !== null) {
            sig = p < 0.01 ? "**" : p < 0.05 ? "*" : "";
            tipExtra = p < 1e-6 ? " p<0.000001" : ` p=${p.toFixed(4)}`;
          }
        } else if (!isUnfiltered && nCount !== null) {
          tipExtra = ` n=${nCount}`;
        }

        return `<td class="text-center small" style="background:${bg};color:${textColor};cursor:pointer"
                    data-corr-feat="${escapeHtml(feat)}" data-corr-target="${escapeHtml(g)}"
                    title="${escapeHtml(FEAT_LABELS[feat] || feat)} vs ${escapeHtml(GRADE_LABELS[g] || g)}: ${corrSym}=${r >= 0 ? "+" : ""}${r.toFixed(3)}${tipExtra}">
                  ${corrSym}${r >= 0 ? "+" : ""}${r.toFixed(2)}${sig ? `<sup style="font-size:.65em;opacity:.9">${sig}</sup>` : ""}
                </td>`;
      }).join("");
      return `<tr>
        <td class="small text-nowrap pe-2">${escapeHtml(FEAT_LABELS[feat] || feat)}</td>
        ${cells}
      </tr>`;
    }).join("");

    const isPrecomputed = !isUnfiltered && segData?.pearson != null;
    const isLowConf     = isPrecomputed && segData?.low_confidence === true;
    const filteredNote = !isUnfiltered
      ? isPrecomputed
        ? `<span style="margin-left:8px;font-size:.78em;color:var(--accent3,#f7a44f)">⚑ 已篩選子集（n=${segData.student_count}）預聚合${isLowConf ? "　⚠️ 樣本數較少，r 值僅供參考" : ""}</span>`
        : `<span style="margin-left:8px;font-size:.78em;color:var(--accent3,#f7a44f)">⚑ 已篩選子集（n=${nCount}）即時重算</span>`
      : (!isSpearman ? `<span style="margin-left:8px;font-size:.78em;opacity:.75">* p&lt;0.05　** p&lt;0.01</span>` : "");

    el.innerHTML = `
      <div class="table-responsive">
        <table class="table table-sm table-bordered mb-1" style="font-size:0.85rem">
          <thead>
            <tr>
              <th class="text-muted fw-normal">學習行為指標</th>
              ${gradeHeaderCells}
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div style="margin-top:6px;display:flex;flex-wrap:wrap;align-items:center;gap:10px">
        <span class="text-muted small">點擊儲存格查看散佈圖（${isSpearman ? "Spearman ρ" : "Pearson r"}）</span>
        <div style="display:flex;align-items:center;gap:6px">
          <span style="font-size:.75rem;color:var(--text-dim,#888)">負相關</span>
          <div style="position:relative;width:200px;height:16px;border-radius:4px;overflow:visible">
            <div style="width:200px;height:16px;border-radius:4px;background:linear-gradient(to right,
              ${_rToColor(-1.0)},
              ${_rToColor(-0.6)},
              ${_rToColor(-0.3)},
              ${_rToColor(0)},
              ${_rToColor(0.3)},
              ${_rToColor(0.6)},
              ${_rToColor(1.0)}
            );"></div>
            <div style="display:flex;justify-content:space-between;margin-top:2px;width:200px">
              <span style="font-size:.68rem;color:var(--text-dim,#888)">−1.0</span>
              <span style="font-size:.68rem;color:var(--text-dim,#888)">−0.3</span>
              <span style="font-size:.68rem;color:var(--text-dim,#888)">0</span>
              <span style="font-size:.68rem;color:var(--text-dim,#888)">+0.3</span>
              <span style="font-size:.68rem;color:var(--text-dim,#888)">+1.0</span>
            </div>
          </div>
          <span style="font-size:.75rem;color:var(--text-dim,#888)">正相關</span>
        </div>
        <span style="font-size:.75rem;color:var(--accent3,#f7a44f)">|r| ≥ 0.3 值得關注</span>
        ${filteredNote}
      </div>
      <div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:10px;font-size:.75rem;color:var(--text-dim,#999)">
        <span style="font-weight:600;color:var(--text,#ccc)">無法顯示原因說明：</span>
        ${Object.values(REASON_CONFIG).map(cfg => `
        <span style="display:inline-flex;align-items:center;gap:4px">
          <span style="background:${cfg.color};border:${cfg.border};border-radius:3px;padding:1px 5px;font-size:.8em" class="${cfg.txtCls}">${cfg.symbol}</span>
          ${cfg.label}
        </span>`).join("")}
        <span style="opacity:.7">（滑鼠移至儲存格可查看詳細說明）</span>
      </div>`;
    el.querySelectorAll("[data-corr-feat][data-corr-target]").forEach(cell => {
      cell.addEventListener("click", () => showScatter(cell.dataset.corrFeat, cell.dataset.corrTarget));
    });
  }

  /** r → rgba 顏色（正：藍，負：紅，0：白） */
  function _rToColor(r) {
    const abs = Math.min(Math.abs(r || 0), 1);
    const v   = Math.round(abs * 180);
    return r >= 0
      ? `rgba(${70 - v}, ${130 + v}, 220, ${0.15 + abs * 0.75})`
      : `rgba(${200 + v}, 60, 60, ${0.15 + abs * 0.75})`;
  }

  /**
   * Ph2b B6：最高相關指標 Badge + score_delta / cramming 洞察摘要。
   * 插入於熱力圖容器上方；無 correlation_insights 資料時靜默不顯示。
   *
   * FIX：接受 filteredRows 參數。
   *   • 全量模式：讀 ETL 預算值 _corrData.correlation_insights（原行為）
   *   • 篩選模式：以 _pearsonValue / _spearmanValue 即時重算三項指標
   */
  function _renderInsightsBadge(insertBeforeId, filteredRows) {
    const anchor = document.getElementById(insertBeforeId);
    if (!anchor) return;

    const existing = document.getElementById("corrInsightsBadge");
    if (existing) existing.remove();

    const ci = _corrData?.correlation_insights;
    if (!ci) return;

    const isUnfiltered = _isUnfiltered();

    const lines = [];

    /**
     * 取 r 值的統一入口：
     *   全量 → ETL 預算值；篩選 → 即時重算。
     */
    function _liveR(feat, target) {
      if (isUnfiltered) {
        return _pearson(feat, target);   // 已是 number | null
      }
      const rows = Array.isArray(filteredRows) ? filteredRows : (_lastFiltered ?? _allScatterData ?? []);
      const result = (_corrType === "spearman")
        ? _spearmanValue(rows, feat, target)
        : _pearsonValue(rows, feat, target);
      return result?.r ?? null;   // 解包診斷物件，統一回傳 number | null
    }

    const nSuffix = (!isUnfiltered && Array.isArray(filteredRows))
      ? ` <span style="opacity:.65;font-size:.75em">n=${filteredRows.length}</span>`
      : "";

    // ── 最高相關指標（依篩選後資料重新搜尋最高 |r|）─────────
    if (isUnfiltered) {
      // 全量：直接用 ETL 欄位
      const hr = ci.highest_r_feature;
      if (hr?.feature && hr?.r != null) {
        const rSign = hr.r >= 0 ? "+" : "";
        lines.push(
          `🏆 <strong>最高相關指標</strong>：${FEAT_LABELS[hr.feature] || hr.feature} × ${GRADE_LABELS[hr.target] || hr.target}　<code>r = ${rSign}${hr.r.toFixed(3)}</code>`
        );
      }
    } else {
      // Phase D：篩選模式，優先讀 segment_pearson 預聚合的 highest_r
      const segData = _canUseSeg() ? (_corrData?.segment_pearson?.[_segKey()] ?? null) : null;
      if (segData?.highest_r?.feature) {
        const hr    = segData.highest_r;
        const rSign = hr.r >= 0 ? "+" : "";
        const lowConfWarn = segData.low_confidence
          ? ` <span style="opacity:.65;font-size:.75em">⚠️ 低信心</span>` : "";
        lines.push(
          `🏆 <strong>最高相關指標</strong>：${FEAT_LABELS[hr.feature] || hr.feature} × ${GRADE_LABELS[hr.target] || hr.target}　<code>r = ${rSign}${hr.r.toFixed(3)}</code>${nSuffix}${lowConfWarn}`
        );
      } else {
        // fallback：掃描所有 feat×target 即時取最高 |r|（原有邏輯）
        const rows = Array.isArray(filteredRows) ? filteredRows : (_lastFiltered ?? _allScatterData ?? []);
        let bestFeat = null, bestTarget = null, bestR = null;
        for (const feat of _features()) {
          for (const target of _targets()) {
            const r = _pearsonValue(rows, feat, target)?.r ?? null;
            if (r !== null && (bestR === null || Math.abs(r) > Math.abs(bestR))) {
              bestFeat = feat; bestTarget = target; bestR = r;
            }
          }
        }
        if (bestFeat && bestR !== null) {
          const rSign = bestR >= 0 ? "+" : "";
          lines.push(
            `🏆 <strong>最高相關指標</strong>：${FEAT_LABELS[bestFeat] || bestFeat} × ${GRADE_LABELS[bestTarget] || bestTarget}　<code>r = ${rSign}${bestR.toFixed(3)}</code>${nSuffix}`
          );
        }
      }
    }

    // ── score_delta 相關性 ───────────────────────────────────
    const sdFeat = "quz_score_delta";
    // 嘗試從 correlation_insights 取得目標欄位名稱，fallback 到 final_score / grade_final
    const sdTarget = ci.score_delta_correlation?.target || "final_score";
    const sdR = _liveR(sdFeat, sdTarget)
             ?? _liveR(sdFeat, "grade_final")
             ?? _liveR(sdFeat, "grade_total");
    if (sdR != null) {
      const sign = sdR >= 0 ? "+" : "";
      lines.push(
        `📈 <strong>成績進步幅度</strong> × 期末成績：<code>r = ${sign}${sdR.toFixed(3)}</code>${nSuffix}`
      );
    } else if (isUnfiltered && ci.score_delta_correlation?.final != null) {
      // 全量 fallback：直接讀 ETL 欄位（feat key 不在 scatter 時）
      const sign = ci.score_delta_correlation.final >= 0 ? "+" : "";
      lines.push(
        `📈 <strong>成績進步幅度</strong> × 期末成績：<code>r = ${sign}${ci.score_delta_correlation.final.toFixed(3)}</code>`
      );
    }

    // ── cramming_ratio 相關性 ────────────────────────────────
    const crFeat = "quz_cramming_ratio";
    const crTarget = ci.cramming_correlation?.target || "final_score";
    const crR = _liveR(crFeat, crTarget)
             ?? _liveR(crFeat, "grade_final")
             ?? _liveR(crFeat, "grade_total");
    if (crR != null) {
      const sign = crR >= 0 ? "+" : "";
      lines.push(
        `🕐 <strong>考前7天刷題比</strong> × 期末成績：<code>r = ${sign}${crR.toFixed(3)}</code>${nSuffix}`
      );
    } else if (isUnfiltered && ci.cramming_correlation?.final != null) {
      const sign = ci.cramming_correlation.final >= 0 ? "+" : "";
      lines.push(
        `🕐 <strong>考前7天刷題比</strong> × 期末成績：<code>r = ${sign}${ci.cramming_correlation.final.toFixed(3)}</code>`
      );
    }

    if (!lines.length) return;

    const badge = document.createElement("div");
    badge.id = "corrInsightsBadge";
    badge.style.cssText = [
      "display:flex;flex-wrap:wrap;gap:10px;margin-bottom:10px;padding:9px 13px",
      "border:1px solid rgba(52,152,219,.25);border-radius:9px",
      "background:rgba(52,152,219,.06);font-size:.8rem;line-height:1.6",
      "color:var(--text-mid,#9aa0b8)",
    ].join(";");
    badge.innerHTML = lines.map(l => `<span>${l}</span>`).join("");

    anchor.parentNode.insertBefore(badge, anchor);
  }

  // ── 散佈圖選擇器 ─────────────────────────────────────────

  function _renderScatterSelector(wrapperId, filteredRows) {
    const el = document.getElementById(wrapperId);
    if (!el || !_corrData) return;

    // 以傳入的篩選資料判斷是否有資料可顯示
    const scatterData = filteredRows ?? _lastFiltered ?? _allScatterData ?? _corrData.scatter_data ?? [];
    const hasScatterData = Array.isArray(scatterData)
      ? scatterData.length > 0
      : Object.keys(scatterData).length > 0;

    if (!hasScatterData) {
      const noDataReason = (_filterCluster !== "all")
        ? `分群 ${_filterCluster} 在本相關性資料集中無對應學生（兩資料集學生母體不同）`
        : (_filterSemester !== "all")
          ? `年度 ${_filterSemester} 尚無獨立散佈圖資料（ETL 尚未產出 by_semester）`
          : "散佈圖資料尚未產出，請執行 ETL";
      el.innerHTML = `<div style="padding:14px;background:rgba(230,126,34,.08);border:1px solid rgba(230,126,34,.3);border-radius:8px;font-size:.82rem;color:var(--accent3,#a04000)">⚠️ ${noDataReason}</div>`;
      return;
    }

    el.innerHTML = `
      <h6 class="mt-4 mb-2 fw-semibold">散佈圖</h6>
      <div id="scatterChartWrap" style="position:relative;height:320px;width:100%">
        <canvas id="scatterChart"></canvas>
      </div>`;

    if (Array.isArray(scatterData)) {
      const firstFeat   = (_features())[0];
      const firstTarget = (_targets())[0];
      if (firstFeat && firstTarget) showScatter(firstFeat, firstTarget, scatterData);
    } else {
      const firstKey                = Object.keys(scatterData)[0];
      const [featPart, , gradePart] = firstKey.split("_vs_");
      showScatter(featPart, gradePart || "grade_total", null);
    }
  }

  // ── 散佈圖渲染 ───────────────────────────────────────────

  /** 計算 value 在已排序陣列中的百分位（0–100） */
  function _percentile(sortedArr, value) {
    const below = sortedArr.filter(v => v < value).length;
    return Math.round((below / sortedArr.length) * 100);
  }

  /** 最小二乘法線性回歸，回傳 {slope, intercept, xMin, xMax, yAtMin, yAtMax} 或 null */
  function _calcRegression(points) {
    const n = points.length;
    if (n < 30) return null;   // 資料點不足，不畫迴歸線
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    for (const p of points) { sumX += p.x; sumY += p.y; sumXY += p.x * p.y; sumX2 += p.x * p.x; }
    const denom = n * sumX2 - sumX * sumX;
    if (Math.abs(denom) < 1e-10) return null;
    const slope     = (n * sumXY - sumX * sumY) / denom;
    const intercept = (sumY - slope * sumX) / n;
    const xs        = points.map(p => p.x);
    const xMin      = Math.min(...xs);
    const xMax      = Math.max(...xs);
    return { slope, intercept, xMin, xMax,
             yAtMin: slope * xMin + intercept,
             yAtMax: slope * xMax + intercept };
  }

  function showScatter(feat, gradeCol, rows) {
    if (!_corrData) return;

    const raw    = _scatterRows(feat, gradeCol, rows);
    const r      = _pearson(feat, gradeCol);
    const rLabel = r != null ? ` (r = ${r >= 0 ? "+" : ""}${r.toFixed(3)})` : "";

    const points  = raw.map(d => ({ x: d.x, y: d.y, masked: d.masked_id }));
    if (!points.length) return;

    const sortedX = [...points.map(p => p.x)].sort((a, b) => a - b);
    const sortedY = [...points.map(p => p.y)].sort((a, b) => a - b);

    const isRateField = feat.includes("rate") || feat.includes("ratio") || feat.includes("score");

    const canvas = document.getElementById("scatterChart");
    if (!canvas) return;

    const rhoResult = _spearmanValue(
      raw.map(d => ({ features: { [feat]: d.x }, [gradeCol]: d.y })),
      feat, gradeCol
    );
    const rho = rhoResult?.r ?? null;

    const reg = _calcRegression(points);
    const datasets = [{
      label: `${FEAT_LABELS[feat] || feat} vs ${GRADE_LABELS[gradeCol] || gradeCol}${rLabel}`,
      data: points,
      backgroundColor: "rgba(52, 152, 219, 0.55)",
      pointRadius: 5,
      pointHoverRadius: 7,
    }];
    if (reg) {
      datasets.push({
        label: `趨勢線 (y = ${reg.slope >= 0 ? "+" : ""}${reg.slope.toFixed(2)}x + ${reg.intercept.toFixed(1)})`,
        data: [
          { x: reg.xMin, y: Math.max(0, Math.min(100, reg.yAtMin)) },
          { x: reg.xMax, y: Math.max(0, Math.min(100, reg.yAtMax)) },
        ],
        type: "line",
        borderColor: "rgba(231, 76, 60, 0.75)",
        borderWidth: 2,
        borderDash: [6, 3],
        pointRadius: 0,
        fill: false,
        tension: 0,
      });
    }

    ChartRegistry.destroyById("scatterChart");
    _scatterChart = new Chart(canvas.getContext("2d"), {
      type: "scatter",
      data: { datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: {
            title: { display: true, text: FEAT_LABELS[feat] || feat, font: { size: 11 } },
            ticks: { callback: v => isRateField ? `${Math.round(v * 100)}%` : v },
          },
          y: {
            title: { display: true, text: GRADE_LABELS[gradeCol] || gradeCol, font: { size: 11 } },
            min: 0, max: 100,
          },
        },
        plugins: {
          legend: { labels: { font: { size: 11 } } },
          tooltip: {
            filter: item => item.datasetIndex === 0,   // 迴歸線不觸發 tooltip
            callbacks: {
              title: ctx => ctx.length ? `學生 ${ctx[0].raw.masked}` : "",
              label: ctx => {
                const p      = ctx.raw;
                const xLabel = isRateField ? `${(p.x * 100).toFixed(1)}%` : p.x.toFixed(2);
                return [
                  ` ${FEAT_LABELS[feat] || feat}：${xLabel}`,
                  ` ${GRADE_LABELS[gradeCol] || gradeCol}：${p.y} 分`,
                ];
              },
              afterLabel: ctx => {
                const p    = ctx.raw;
                const xPct = _percentile(sortedX, p.x);
                const yPct = _percentile(sortedY, p.y);
                return [
                  ` 行為指標：高於 ${xPct}% 同學`,
                  ` 成績：高於 ${yPct}% 同學`,
                ];
              },
              footer: ctx => {
                if (!ctx.length) return [];
                const lines = [];
                if (r != null) {
                  const st = Math.abs(r) >= 0.5 ? "強" : Math.abs(r) >= 0.3 ? "中等" : "弱";
                  lines.push(`📈 Pearson r = ${r >= 0 ? "+" : ""}${r.toFixed(3)}  → ${st}${r >= 0 ? "正" : "負"}相關`);
                }
                if (rho != null) {
                  const ss = Math.abs(rho) >= 0.5 ? "強" : Math.abs(rho) >= 0.3 ? "中等" : "弱";
                  lines.push(`📊 Spearman ρ = ${rho >= 0 ? "+" : ""}${rho.toFixed(3)}  → ${ss}${rho >= 0 ? "正" : "負"}相關`);
                }
                if (reg) {
                  lines.push(`📉 趨勢線：斜率 ${reg.slope >= 0 ? "+" : ""}${reg.slope.toFixed(3)}`);
                }
                return lines;
              },
            },
          },
        },
      },
    });
    ChartRegistry.register("scatterChart", _scatterChart);
  }

  return { init, showScatter, onFilterChange, resetFilters, setCorrType };
})();
