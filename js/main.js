// ══════════════════════════════════════════════════════════
// 學習分析儀表板 - 主應用邏輯
// ══════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════
// SECURITY HELPERS
// ══════════════════════════════════════════════════════════
/** HTML-escape for innerHTML template literals */
function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
/** Escape for SVG/HTML attribute values (double-quote context) */
const safeSvgAttr = escapeHtml;

// ══════════════════════════════════════════════════════════
// DATA & STATE
// ══════════════════════════════════════════════════════════
let DATA = null;
let bMode = 'sheet';
let dView   = 'merge';
let dMetric = 'semester_score';
let dType   = 'theory';  // 'theory' | 'practicum'

// Panel D 學期篩選狀態
let dSemMode     = 'range';   // 'range' | 'multi'
let dSemRange    = [0, 29];   // [startIdx, endIdx]（索引對應 DATA.meta.semesters）
let dSemSelected = new Set(); // 多選模式：已選學期 value set

// ══════════════════════════════════════════════════════════
// 統一 Chart.js Tooltip 樣式
// ══════════════════════════════════════════════════════════
const TOOLTIP_STYLE = {
  backgroundColor: 'rgba(28,32,48,0.97)',
  borderColor: '#353c58',
  borderWidth: 1,
  titleColor: '#dde3f5',
  bodyColor: '#9aa0b8',
  footerColor: '#6b748f',
  padding: 10,
  cornerRadius: 8,
  titleFont: { family: "'Noto Sans TC', sans-serif", size: 12, weight: 'bold' },
  bodyFont:  { family: "'Noto Sans TC', sans-serif", size: 11 },
  displayColors: true,
  boxWidth: 10,
  boxHeight: 10,
  usePointStyle: true,
};
function getTooltipStyle() {
  const light = document.body.classList.contains('light');
  return {
    ...TOOLTIP_STYLE,
    backgroundColor: light ? 'rgba(255,255,255,0.97)' : 'rgba(28,32,48,0.97)',
    borderColor:     light ? '#b0b6d0' : '#353c58',
    titleColor:      light ? '#1a1d2e' : '#dde3f5',
    bodyColor:       light ? '#4a5070' : '#9aa0b8',
  };
}

/**
 * weightedAvg(rows, valFn, weightFn)
 * Compute a student-count-weighted average instead of a simple average of
 * class-level averages.  When all weights are 0 (no data), returns null.
 */
function weightedAvg(rows, valFn, weightFn = c => Number(c.count) || 1) {
  let sumW = 0, sumV = 0;
  for (const r of rows) {
    const v = valFn(r);
    if (v == null) continue;
    const w = weightFn(r);
    sumW += w;
    sumV += v * w;
  }
  return sumW > 0 ? sumV / sumW : null;
}

function cssColor(name, fallback) {
  const value = getComputedStyle(document.body).getPropertyValue(name).trim();
  return value || fallback;
}

function chartTextColor() {
  return cssColor('--text', document.body.classList.contains('light') ? '#1a1d2e' : '#dde3f5');
}

function chartTextDimColor() {
  return cssColor('--text-dim', document.body.classList.contains('light') ? '#6b748f' : '#9aa0b8');
}

function resolveChartColor(value, fallback = chartTextDimColor()) {
  if (typeof value !== 'string') return value;
  const match = value.trim().match(/^var\((--[\w-]+)(?:,\s*([^)]+))?\)$/);
  if (!match) return value;
  return cssColor(match[1], match[2]?.trim() || fallback);
}

function normalizeChartThemeColors(config) {
  const options = config.options || {};
  if (options.color) options.color = resolveChartColor(options.color, chartTextColor());
  const plugins = options.plugins || {};
  ['legend', 'title', 'subtitle'].forEach(key => {
    const plugin = plugins[key];
    if (!plugin || typeof plugin !== 'object') return;
    if (plugin.color) plugin.color = resolveChartColor(plugin.color);
    if (plugin.labels?.color) plugin.labels.color = resolveChartColor(plugin.labels.color);
  });
  Object.values(options.scales || {}).forEach(scale => {
    if (!scale || typeof scale !== 'object') return;
    if (scale.ticks?.color) scale.ticks.color = resolveChartColor(scale.ticks.color);
    if (scale.title?.color) scale.title.color = resolveChartColor(scale.title.color);
  });
}

const CHART_DEFAULTS = {
  color: chartTextColor(),
  plugins: {
    legend: { labels: { color: chartTextDimColor(), font: { size: 11 } } },
    tooltip: getTooltipStyle(),
  },
  scales: {
    x: {
      ticks: { color: '#6b748f', font: { size: 10 } },
      grid:  { color: '#1c2030', drawTicks: false, tickLength: 0 },
      border: { display: false },
    },
    y: {
      ticks: { color: '#6b748f', font: { size: 10 } },
      grid:  { color: '#242840', drawTicks: false, tickLength: 0 },
      border: { display: false },
    }
  }
};

function smoothScaleEdges(config) {
  const scales = config.options?.scales;
  if (!scales) return;
  Object.values(scales).forEach(scale => {
    if (!scale || typeof scale !== 'object') return;
    scale.grid = { ...(scale.grid || {}), drawTicks: false, tickLength: 0 };
    scale.border = { ...(scale.border || {}), display: false };
  });
}

function refreshChartDefaults() {
  const ts = getTooltipStyle();
  const light = document.body.classList.contains('light');
  CHART_DEFAULTS.color = chartTextColor();
  CHART_DEFAULTS.plugins.tooltip = ts;
  CHART_DEFAULTS.plugins.legend.labels.color = chartTextDimColor();
  CHART_DEFAULTS.scales.x.ticks.color = '#6b748f';
  CHART_DEFAULTS.scales.x.grid.color  = light ? '#e0e4f0' : '#1c2030';
  CHART_DEFAULTS.scales.y.ticks.color = '#6b748f';
  CHART_DEFAULTS.scales.y.grid.color  = light ? '#e8eaf2' : '#242840';
}

const charts = {};
const chartConfigs = {};
let chartResizeFrame = null;
const observedChartWraps = new WeakSet();
const chartResizeObserver = typeof ResizeObserver !== 'undefined'
  ? new ResizeObserver(scheduleChartResize)
  : null;

function chartUsesCategoryX(config) {
  const xScale = config.options?.scales?.x;
  return !xScale?.type || xScale.type === 'category';
}

function chartDataLength(config) {
  const labels = config.data?.labels;
  if (Array.isArray(labels) && labels.length) return labels.length;
  if (config.type === 'scatter' || !chartUsesCategoryX(config)) return 0;
  const datasets = config.data?.datasets || [];
  return datasets.reduce((max, ds) =>
    Math.max(max, Array.isArray(ds.data) ? ds.data.length : 0), 0);
}

function estimateChartMinWidth(config, viewportWidth) {
  return Math.max(Math.floor(viewportWidth || 0), 280);
}

function availableChartWidth(wrap) {
  const rect = wrap.getBoundingClientRect();
  const docWidth = document.documentElement.clientWidth || window.innerWidth || 0;
  const containerWidth = Math.floor(wrap.clientWidth || rect.width || docWidth || 320);
  const pageLimit = docWidth ? Math.floor(docWidth - Math.max(rect.left, 0) - 12) : containerWidth;
  return Math.max(280, Math.min(containerWidth, pageLimit || containerWidth));
}

function applyAdaptiveChartOptions(config, width) {
  const count = chartDataLength(config);
  if (chartUsesCategoryX(config) && config.options?.scales?.x) {
    const tickBudget = Math.max(3, Math.floor(width / (width < 520 ? 78 : 92)));
    const xScale = config.options.scales.x;
    config.options.scales = { ...config.options.scales };
    config.options.scales.x = {
      ...xScale,
      ticks: {
        ...(xScale.ticks || {}),
        autoSkip: true,
        maxTicksLimit: count ? Math.min(count, tickBudget) : tickBudget,
        minRotation: 0,
        maxRotation: width < 560 ? 45 : 0,
      }
    };
  }

  const legend = config.options?.plugins?.legend;
  if (legend && legend.display !== false) {
    config.options.plugins = { ...(config.options.plugins || {}) };
    config.options.plugins.legend = {
      ...legend,
      position: width < 520 ? 'bottom' : (legend.position || 'top'),
      labels: {
        ...(legend.labels || {}),
        color: (legend.labels?.color) || CHART_DEFAULTS.plugins.legend.labels.color,
        boxWidth: width < 520 ? 9 : (legend.labels?.boxWidth || 12),
        font: {
          ...(legend.labels?.font || {}),
          size: width < 520 ? 9 : (legend.labels?.font?.size || 11),
        }
      }
    };
  }
}

function prepareScrollableChart(canvas, config) {
  const wrap = canvas.closest('.chart-wrap');
  if (!wrap) return;
  let inner = canvas.parentElement?.classList.contains('chart-scroll-inner')
    ? canvas.parentElement
    : null;
  if (!inner) {
    inner = document.createElement('div');
    inner.className = 'chart-scroll-inner';
    canvas.parentNode.insertBefore(inner, canvas);
    inner.appendChild(canvas);
  }
  const fitWidth = estimateChartMinWidth(config, availableChartWidth(wrap));
  applyAdaptiveChartOptions(config, fitWidth);
  inner.style.width = `${fitWidth}px`;
  inner.style.minWidth = '0';
  inner.style.maxWidth = '100%';
}

function resizeAllCharts() {
  Object.entries(charts).forEach(([id, chart]) => {
    const canvas = document.getElementById(id);
    const config = chartConfigs[id];
    if (!canvas || !config) return;
    prepareScrollableChart(canvas, config);
    chart.resize();
  });
}

function scheduleChartResize() {
  if (chartResizeFrame) cancelAnimationFrame(chartResizeFrame);
  chartResizeFrame = requestAnimationFrame(() => {
    chartResizeFrame = null;
    resizeAllCharts();
  });
}

function observeChartWrap(canvas) {
  const wrap = canvas.closest('.chart-wrap');
  if (!wrap || observedChartWraps.has(wrap) || !chartResizeObserver) return;
  observedChartWraps.add(wrap);
  chartResizeObserver.observe(wrap);
}

function mkChart(id, config) {
  if (charts[id]) charts[id].destroy();
  const ctx = document.getElementById(id);
  if (!ctx) return null;
  config.options = { ...(config.options || {}) };
  if (config.options.responsive == null) config.options.responsive = true;
  if (config.options.maintainAspectRatio == null) config.options.maintainAspectRatio = false;
  if (config.options?.plugins?.tooltip &&
      !config.options.plugins.tooltip._custom) {
    config.options.plugins.tooltip = {
      ...getTooltipStyle(),
      ...config.options.plugins.tooltip
    };
  }
  prepareScrollableChart(ctx, config);
  smoothScaleEdges(config);
  normalizeChartThemeColors(config);
  charts[id] = new Chart(ctx, config);
  chartConfigs[id] = config;
  observeChartWrap(ctx);
  requestAnimationFrame(() => {
    charts[id]?.resize();
    attachChartExpandButtons();
  });
  return charts[id];
}

// ══════════════════════════════════════════════════════════
// SVG Tooltip 系統
// ══════════════════════════════════════════════════════════
const svgTip = document.getElementById('svgTooltip') ?? (() => {
  const el = document.createElement('div');
  el.id = 'svgTooltip';
  el.style.display = 'none';
  document.body.appendChild(el);
  return el;
})();
let svgTipTimer = null;

function showSvgTip(evt, text) {
  clearTimeout(svgTipTimer);
  svgTip.innerHTML = '';
  text.split('\n').forEach((line, i) => {
    if (i > 0) svgTip.appendChild(document.createElement('br'));
    const boldPattern = /<b>(.*?)<\/b>/g;
    let lastIndex = 0, match;
    const span = document.createElement('span');
    while ((match = boldPattern.exec(line)) !== null) {
      if (match.index > lastIndex) {
        span.appendChild(document.createTextNode(line.slice(lastIndex, match.index)));
      }
      const b = document.createElement('b');
      b.textContent = match[1];
      span.appendChild(b);
      lastIndex = boldPattern.lastIndex;
    }
    if (lastIndex < line.length) {
      span.appendChild(document.createTextNode(line.slice(lastIndex)));
    }
    svgTip.appendChild(span);
  });
  svgTip.style.display = 'block';
  moveSvgTip(evt);
}
function moveSvgTip(evt) {
  const margin = 14;
  const tw = svgTip.offsetWidth, th = svgTip.offsetHeight;
  let x = evt.clientX + margin, y = evt.clientY + margin;
  if (x + tw > window.innerWidth  - 8) x = evt.clientX - tw - margin;
  if (y + th > window.innerHeight - 8) y = evt.clientY - th - margin;
  svgTip.style.left = x + 'px';
  svgTip.style.top  = y + 'px';
}
function hideSvgTip() {
  svgTipTimer = setTimeout(() => { svgTip.style.display = 'none'; }, 80);
}

document.addEventListener('touchstart', e => {
  if (svgTip.style.display === 'none') return;
  if (!e.target.closest('[data-svgtip]')) svgTip.style.display = 'none';
}, { passive: true });

// ══════════════════════════════════════════════════════════
// 圖表說明系統
// ══════════════════════════════════════════════════════════
const CHART_INFO = {
  chartCohortTrend: {
    title: '整屆跨學期趨勢',
    desc: '各學制在每個學期的平均分走勢。',
    points: [
      '折線持續上升 → 教學成效改善，可能反映教學法調整有效',
      '某學期急劇下降 → 查明原因（課程難度？師資異動？）',
      '各學制差距大 → 學制特性對成效有顯著影響',
    ],
    use: '適合截圖作為研究計畫「研究背景」的量化佐證。',
  },
  chartProgramBar: {
    title: '各學期學制比較',
    desc: '同一學期內各學制的平均分群組長條圖。',
    points: [
      '長條差距大 → 學制背景對學習成效有顯著影響',
      '所有學制某學期同步下降 → 可能為外部共同因素',
    ],
    use: '用於學制差異分析，作為課程差異化設計依據。',
  },
  chartPassRate: {
    title: '及格率跨學期趨勢',
    desc: '各學制及格率（%）的時間趨勢，是比均分更直接的達標指標。',
    points: [
      '及格率 > 90% 且穩定 → 課程難度適中',
      '某學期突然跌落 → 檢視評量方式或課程模組是否異動',
      '特定學制持續偏低 → 考慮提供差異化支持',
    ],
    use: '及格率是教育研究常用結果變項，可直接呈現於報告。',
  },
  heatmapWrap: {
    title: '學期 × 班級成績熱力圖',
    desc: '顏色越綠分數越高，越紅越低。格子內為確切均分數值。',
    points: [
      '橫向看（同一行）→ 追蹤同班跨學期變化',
      '縱向看（同一列）→ 比較同學期各班相對表現',
      '孤立深紅格 → 某班某學期出現異常，值得深入調查',
    ],
    use: '一眼掌握多年度多班全貌，快速定位「紅色熱點」。',
  },
  boxplotWrap: {
    title: '學制成績分布箱形圖',
    desc: '標準統計描述工具。橫線=中位數，箱=四分位距，圓點=離群值。',
    points: [
      '箱體高（IQR 大）→ 學生成績分散，需差異化教學',
      '中位數遠低於均分 → 分布右偏，少數高分拉高平均',
      '大量低分離群點 → 需個別關注的學生較多',
    ],
    use: '學術論文常用的描述統計圖，可直接呈現於結果章節。',
  },
  chartCorrelation: {
    title: '人數 vs 及格率相關性',
    desc: '探討班級規模是否影響及格率。每個點代表一個班次。',
    points: [
      '點群呈負相關 → 班級越大及格率越低，支持小班教學',
      '各學制點群分離 → 學制差異比規模影響更大',
      'Hover 可查看班次名稱、學期與確切數值',
    ],
    use: '若發現明顯相關性，可計算相關係數納入研究結果。',
  },
  chartDist: {
    title: '成績分布直方圖',
    desc: '各分數區間的學生人數。60分以上綠色，以下紅色。',
    points: [
      '鐘型分布 → 評量難度適中',
      '左偏（高分集中）→ 課程偏易',
      '右偏（低分集中）→ 課程偏難，評量方式可考慮調整',
      '雙峰 → 學生兩極分化，需差異化教學',
    ],
    use: '快速掌握班級整體成績分布形態。',
  },
  chartNormalOverlay: {
    title: '常態分布曲線疊加',
    desc: '在直方圖上疊加理論常態曲線（灰色虛線），以實際均分與標準差計算。',
    points: [
      '實際分布與曲線吻合 → 成績接近常態，符合統計假設',
      '明顯偏離 → 存在地板效應（整體偏低）或天花板效應（整體偏高）',
    ],
    use: '判斷是否符合常態假設，作為 t 檢定等分析的前提確認。',
  },
  chartMidFinal: {
    title: '期中 vs 期末指標對比',
    desc: '並排比較期中均分、期末均分與學期均分三項指標。',
    points: [
      '期末 > 期中 → 學生後段有所進步',
      '期末 < 期中 → 後段學習退步，課程後半段難度可能提升',
      '學期明顯高於期末 → 加分機制發生作用',
    ],
    use: '評量設計一致性檢討，判斷期中期末難度是否均衡。',
  },
  chartRegression: {
    title: '期中 → 期末線性迴歸',
    desc: '每個點代表一位學生（X=期中，Y=期末），橘色線為迴歸線，R² 顯示預測力。',
    points: [
      'R² 接近 1.0 → 期中高度預測期末，兩次評量一致性高',
      'R² 接近 0.0 → 期中幾乎無法預測期末，測量不同能力',
      '右下角點（期中高但期末低）→「後段滑落型」學生',
      '左上角點（期中低但期末高）→「後段爆發型」學生',
    ],
    use: '識別期中後需追蹤的學生，作為補救教學介入依據。',
  },
  chartTrend: {
    title: '跨屆趨勢折線圖',
    desc: '同班級名稱跨學期的期中、期末、學期成績均分趨勢。',
    points: [
      '三條折線同步上升 → 教學成效逐年改善',
      '某學期同步下跌後恢復 → 可能為偶發因素',
      '期末與期中走勢不同步 → 期末考難度或評量方式可能調整過',
    ],
    use: '教學法介入（前後比較）的佐證，適合呈現於研究計畫。',
  },
  chartVariance: {
    title: '與前次同班比較 Δ',
    desc: '各指標相對上一個有同班資料學期的變化量。綠色=進步，紅色=退步。',
    points: [
      '全部指標綠色 → 本學期全面優於上學期',
      '及格率進步但均分退步 → 低分學生改善，整體水準略降',
      '顯示「無前期資料」→ 該班首次開課或前學期資料未匯入',
    ],
    use: '即時掌握本學期相對上學期的教學成效變化。',
  },
  chartAnomalyDensity: {
    title: '各學期異常事件密度',
    desc: '全體學生各類異常標籤每學期的發生人次。',
    points: [
      '🟡 黃色折線升高 → 某學期後測執行率偏低或缺考增加',
      '🔵 藍色峰值 → 該學期同意書收取流程出現問題',
      '🔴 紅色出現 → 考試誠信問題，應個別追蹤',
      '整體趨勢下降 → 班級管理與學習文化改善',
    ],
    use: '班級管理或課程執行品質的長期監控指標。',
  },
  chartRetakerFirstDist: {
    title: '重修生首修成績分布',
    desc: '有重修記錄的學生，其「第一次修課」時的成績分布。',
    points: [
      '集中在 50–59 分 → 接近及格邊緣的學生重修率最高',
      '集中在 40 分以下 → 需更早介入（如期中後補救教學）',
      '首修 ≥ 60 卻重修 → 可能有特殊情況，至個案追蹤確認',
    ],
    use: '預警介入對象的輪廓分析，搭配頁籤 B 使用。',
  },
  slopeChart: {
    title: '首修 → 重修進退步坡度圖',
    desc: '每位重修生以一條連線表示，綠色=進步，紅色=退步。',
    points: [
      '綠線多且陡 → 重修整體改善效果顯著',
      '紅線多 → 重修後仍退步，需調整輔導策略',
      '水平線 → 重修沒有顯著改變',
    ],
    use: '一眼掌握補救教學整體成效。',
  },
  chartDelta: {
    title: 'Δ 分佈直方圖',
    desc: '所有重修生「重修成績 − 首修成績」（Δ）的分布。綠色=進步，紅色=退步。',
    points: [
      '集中在 +10 至 +20 → 多數重修生進步約 10–20 分，機制有效',
      '分布以 0 對稱 → 重修成效不一，需個案分析',
      '大量負值 → 重修機制需要檢討',
    ],
    use: '評估補救教學制度性成效。',
  },
  chartQuadrant: {
    title: '正課 × 實驗課四象限',
    desc: '以正課（X軸）與實驗課（Y軸）成績定位重修學生。',
    points: [
      'Q1 右上（雙強）→ 無需介入',
      'Q2 左上（正課弱/實驗強）→ 加強流病報告邏輯輔導',
      'Q3 左下（雙弱）→ 高風險，優先個別輔導',
      'Q4 右下（正課強/實驗弱）→ 補充致病機轉概念圖',
    ],
    use: '差異化輔導方向判斷，根據象限位置制定介入策略。',
  },
  chartDeltaByProgram: {
    title: '重修改善率依學制比較',
    desc: '各學制重修生的平均 Δ 值（進步幅度）比較。',
    points: [
      '某學制 Δ 顯著高 → 該學制對重修機制反應較佳',
      '某學制 Δ 為負值 → 需重新評估該學制的輔導策略',
      '各學制 Δ 差異不大 → 個人動機比學制背景更關鍵',
    ],
    use: '探討不同學制補救教學成效差異的量化佐證。',
  },
  chartRetakeCount: {
    title: '重修次數分布圖',
    desc: '重修 1 次、2 次、3 次以上的學生人數分布。',
    points: [
      '絕大多數在「重修第 1 次」→ 一次重修後即達標，機制有效',
      '「重修第 2 次」不少 → 有持續困難學生，需長期追蹤',
      '出現「重修第 3 次」→ 啟動積極介入，考慮學習障礙評估',
    ],
    use: '識別需要長期輔導的持續困難學生群體。',
  },
  chartFirstVsDelta: {
    title: '首修成績 vs 重修進步幅度',
    desc: 'X=首修成績，Y=重修 Δ。探索「首修越低改善越多」或其他規律。',
    points: [
      '左上角（首修低，Δ 大正值）→「低谷反彈型」，補救效果顯著',
      '右下角（首修高，Δ 為負值）→「高原退步型」，疏於準備',
      '無明顯趨勢 → 個別差異大，首修成績無法預測改善幅度',
    ],
    use: '判斷補救教學介入時機，Hover 可查看遮蔽學號。',
  },
  radarChart: {
    title: '學習行為分群雷達圖',
    desc: '以 K-means 分群結果將學生分為五種學習型態。',
    points: [
      '面積越大 → 該群學習投入度越高，多媒體使用越多元',
      '特定維度突出 → 找出各群的主力學習工具，作為差異化教學依據',
      '切換「及格/不及格」視圖 → 觀察通過與未通過學生的行為輪廓差異',
    ],
    use: '用於識別學習型態與成效的關聯，適合作為主動學習研究的分群佐證。',
  },
  scatterChart: {
    title: '行為指標相關性散佈圖',
    desc: '點擊相關性熱力圖的儲存格後，顯示對應兩項行為指標的學生分布。',
    points: [
      '點群呈正相關 → 兩項行為同步增減，可合併為單一學習投入指標',
      '點群呈負相關 → 兩種學習策略存在替代關係',
      'Hover 可查看個別學生資訊，利於個案追蹤',
    ],
    use: '驗證行為指標間的統計關聯，作為建立預測模型的前置分析。',
  },
  weeklyQuizChart: {
    title: '各週題庫作答強度',
    desc: '以週為單位呈現全體學生題庫作答次數的趨勢。',
    points: [
      '考前幾週明顯峰值 → 學生傾向臨時抱佛腳，可引導平時練習',
      '整學期均勻分布 → 自主學習習慣良好',
      '某週突然下降 → 可能與校內活動或其他課程評量撞期',
    ],
    use: '量化學習節律，作為課程設計（作業分散化）的參考依據。',
  },
  preExamChart: {
    title: '平時及考前學習強度分型（V2.1）',
    desc: '核心指標：T_total（期間總閱讀時數）、P_pre = T_pre ÷ T_total × 100%（考前 7 天占比）。',
    points: [
      '① 學習低投入型：T_total < P15 門檻，學習量不足，不分析節奏',
      '② 高度衝刺型：P_pre ≥ 30%（集中學習 Massed Practice）',
      '③ 規律分散型：10% ≤ P_pre < 30%（分散學習 Distributed Practice）',
      '④ 提早完成型：P_pre < 10%（前置規劃 Pre-planning）',
    ],
    use: '識別備考模式與成效的關係，引導學生調整學習策略。',
  },
  timeSlotChart: {
    title: '學習時段分布',
    desc: '統計學生一天中各時段使用學習資源的比例。',
    points: [
      '夜間比例高 → 學生習慣深夜學習，早課出席率可能受影響',
      '午間峰值 → 碎片化利用午休時間',
      '各時段均勻 → 學習時間自主彈性大，說明非同步教學需求高',
    ],
    use: '作為課程素材設計（影片長度、推送時機）的行為依據。',
  },
  studyHeatmapWrap: {
    title: '學習規律熱力圖',
    desc: '顯示一週七天 × 24 小時的學習密集度分布。',
    points: [
      '規律出現高密度時段 → 學生有固定學習節奏（Spaced Practice）',
      '集中於特定時段（如深夜）→ 可能影響白天上課專注度',
      '週末明顯低落 → 學習行為受週次作息影響',
    ],
    use: '協助識別學生是否有規律的學習節奏，作為差異化教學與課程設計依據。',
  },
  hourlyLineChart: {
    title: '24 小時學習活躍度趨勢',
    desc: 'X 軸為一天 24 小時，Y 軸為正規化學習活躍度。',
    points: [
      '高分群（綠線）持續高於其他群 → 學習時間分配策略是成效差異主因',
      '深夜（22:00 後）高峰 → 學生普遍傾向夜間學習',
      '篩選器啟用時分群疊加線暫不顯示 → 避免邏輯衝突',
    ],
    use: '跨群學習行為比較，識別高分群的時間投入模式。',
  },
};

function chartTitleActions(titleEl) {
  let actions = titleEl.querySelector('.chart-title-actions');
  if (!actions) {
    actions = document.createElement('span');
    actions.className = 'chart-title-actions';
    titleEl.appendChild(actions);
  }
  return actions;
}

function resizeChartsInCard(card) {
  card.querySelectorAll('canvas[id]').forEach(canvas => {
    const chart = charts[canvas.id];
    if (!chart) return;
    const config = chartConfigs[canvas.id];
    if (config) prepareScrollableChart(canvas, config);
    chart.resize();
  });
}

function closeExpandedChart() {
  const card = document.querySelector('.chart-card.chart-expanded');
  if (!card) return;
  const btn = card.querySelector('.chart-expand-btn.active');
  card.classList.remove('chart-expanded');
  document.body.classList.remove('chart-expanded-open');
  if (btn) {
    btn.classList.remove('active');
    btn.textContent = '⤢';
    btn.title = '放大圖表';
    btn.setAttribute('aria-label', '放大圖表');
  }
  requestAnimationFrame(() => resizeChartsInCard(card));
}

function toggleChartExpanded(btn) {
  const card = btn.closest('.chart-card');
  if (!card) return;
  const willOpen = !card.classList.contains('chart-expanded');
  closeExpandedChart();
  if (!willOpen) return;
  card.classList.add('chart-expanded');
  document.body.classList.add('chart-expanded-open');
  btn.classList.add('active');
  btn.textContent = '×';
  btn.title = '縮小圖表';
  btn.setAttribute('aria-label', '縮小圖表');
  requestAnimationFrame(() => resizeChartsInCard(card));
}

function attachChartExpandButtons() {
  document.querySelectorAll('.chart-card').forEach(card => {
    const titleEl = card.querySelector('.chart-title');
    if (!titleEl) return;
    const existing = titleEl.querySelector('.chart-expand-btn');
    if (existing) {
      if (!existing.dataset.wired) {
        existing.dataset.wired = '1';
        existing.addEventListener('click', e => {
          e.stopPropagation();
          toggleChartExpanded(existing);
        });
      }
      return;
    }
    const hasChart = card.querySelector('canvas, svg, #heatmapWrap, #boxplotWrap, .slope-wrap');
    if (!hasChart) return;
    const btn = document.createElement('button');
    btn.className = 'chart-expand-btn';
    btn.type = 'button';
    btn.textContent = '⤢';
    btn.title = '放大圖表';
    btn.setAttribute('aria-label', '放大圖表');
    btn.dataset.wired = '1';
    btn.addEventListener('click', e => {
      e.stopPropagation();
      toggleChartExpanded(btn);
    });
    chartTitleActions(titleEl).appendChild(btn);
  });
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeExpandedChart();
});

window.addEventListener('resize', scheduleChartResize);
window.addEventListener('orientationchange', scheduleChartResize);

function attachInfoButtons() {
  const isMobile = () => window.matchMedia('(hover: none)').matches;

  Object.entries(CHART_INFO).forEach(([id, info]) => {
    let titleEl = null;
    const canvas = document.getElementById(id);
    if (canvas) {
      titleEl = canvas.closest('.chart-card')?.querySelector('.chart-title');
    } else {
      const wrap = document.getElementById(id);
      if (wrap) titleEl = wrap.closest('.chart-card')?.querySelector('.chart-title');
    }
    if (!titleEl) return;
    titleEl.querySelector('.chart-info-btn')?.remove();
    titleEl.querySelector('.chart-popover')?.remove();

    const btn = document.createElement('button');
    btn.className = 'chart-info-btn';
    btn.textContent = '?';
    btn.setAttribute('aria-label', `${info.title} 說明`);
    btn.title = info.title;

    const pop = document.createElement('div');
    pop.className = 'chart-popover';
    const pointsHtml = info.points.map(p => `<li>${p}</li>`).join('');
    pop.innerHTML = `
      <div class="chart-popover-title">
        <span>${info.title}</span>
        <button class="chart-popover-close" data-action="closePopover">✕</button>
      </div>
      <div style="color:var(--text-mid);font-size:11px;margin-bottom:6px">${info.desc}</div>
      <ul>${pointsHtml}</ul>
      ${info.use ? `<div style="margin-top:8px;font-size:10px;color:var(--accent3);border-top:1px solid var(--border);padding-top:6px">💡 ${info.use}</div>` : ''}
    `;

    chartTitleActions(titleEl).appendChild(btn);
    titleEl.appendChild(pop);

    btn.addEventListener('mouseenter', () => {
      if (!isMobile()) pop.classList.add('open');
    });
    btn.addEventListener('mouseleave', (e) => {
      if (!isMobile() && !pop.contains(e.relatedTarget)) {
        setTimeout(() => { if (!pop.matches(':hover')) pop.classList.remove('open'); }, 200);
      }
    });
    pop.addEventListener('mouseleave', () => {
      if (!isMobile()) pop.classList.remove('open');
    });

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      document.querySelectorAll('.chart-popover.open').forEach(p => {
        if (p !== pop) p.classList.remove('open');
      });
      pop.classList.toggle('open');
    });
  });

  if (!window.__chartInfoGlobalClickBound) {
    window.__chartInfoGlobalClickBound = true;
    document.addEventListener('click', () => {
      document.querySelectorAll('.chart-popover.open').forEach(p => p.classList.remove('open'));
    });
  }
}

// ══════════════════════════════════════════════════════════
// SVG Tooltip helpers
// ══════════════════════════════════════════════════════════
function addSvgTooltip(svgEl, selector, contentFn) {
  svgEl.addEventListener('mouseover', e => {
    const target = e.target.closest(selector);
    if (!target) return;
    const html = contentFn(target);
    if (html) showSvgTip(e, html);
  });
  svgEl.addEventListener('mousemove', e => {
    if (svgTip.style.display !== 'none') moveSvgTip(e);
  });
  svgEl.addEventListener('mouseleave', () => {
    clearTimeout(svgTipTimer);
    svgTip.style.display = 'none';
  });
  svgEl.addEventListener('mouseout', e => {
    if (!e.target.closest(selector)) hideSvgTip();
  });
  svgEl.addEventListener('touchstart', e => {
    const target = e.changedTouches[0];
    const el = document.elementFromPoint(target.clientX, target.clientY);
    const match = el?.closest(selector);
    if (!match) { svgTip.style.display='none'; return; }
    const html = contentFn(match);
    if (html) {
      showSvgTip({ clientX: target.clientX, clientY: target.clientY }, html);
      e.preventDefault();
    }
  }, { passive: false });
}

// ══════════════════════════════════════════════════════════
// LOAD DATA
// ══════════════════════════════════════════════════════════
const CLASS_LETTER_ORDER = ['A','B','C','D','E'];
const CLASS_WORK_ORDER = ['甲','乙','戊','己'];
const CLASS_NIGHT_ORDER = ['丙','丁'];

function cleanSheetName(s) {
  if (!s) return s;
  s = String(s);
  if (s.normalize) s = s.normalize('NFKC');
  s = s.replace(/[\u00AD\u200B-\u200F\u202A-\u202E\u2060\uFE00-\uFE0F\uFEFF]/g, '');
  s = s.replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g, '-');
  s = s.trim().replace(/[\s\u00A0\u1680\u180E\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+/g, '');
  return s;
}

function classCodeText(s) {
  const numMap = { '零':'0','〇':'0','一':'1','ㄧ':'1','二':'2','兩':'2','三':'3','四':'4','五':'5','六':'6','七':'7','八':'8','九':'9' };
  return cleanSheetName(s)
    .toUpperCase()
    .replace(/[零〇一ㄧ二兩三四五六七八九]/g, ch => numMap[ch] ?? ch)
    .replace(/已/g, '己');
}

function classInfo(sheetName, semester = '') {
  const raw = cleanSheetName(sheetName) || '';
  const code = classCodeText(raw);
  if (!raw) return { canonical: raw, program: '2yr_gen', order: 9999 };

  if (/重修生/.test(raw)) {
    return { canonical: '重修生', program: 'retake_student', order: 0 };
  }
  if (/重修|暑期|學分|補修|微免|遠距|R\d/i.test(raw) || /R\d/i.test(code)) {
    const canonical = /(?:護|N|日)?[24]\d/.test(code) ? code.replace(/^日/, '護').replace(/^N/, '護') : raw;
    return { canonical, program: 'retake_class', order: 5000 };
  }
  if (/學後護|學士後|學後/.test(raw)) {
    return { canonical: '學士後護', program: 'post', order: 0 };
  }

  let m = code.match(/(?:護|N|日)?2([1-9])([A-E])/i);
  if (m) {
    const section = m[2].toUpperCase();
    return {
      canonical: `護2${m[1]}${section}`,
      program: '2yr_gen',
      order: Number(m[1]) * 10 + CLASS_LETTER_ORDER.indexOf(section)
    };
  }

  m = code.match(/(?:護|日|N)?2([1-9])([甲乙丙丁戊己])/);
  if (m) {
    const section = m[2];
    const isNight = CLASS_NIGHT_ORDER.includes(section);
    const orderSet = isNight ? CLASS_NIGHT_ORDER : CLASS_WORK_ORDER;
    return {
      canonical: `護2${m[1]}${section}`,
      program: isNight ? '2yr_night' : '2yr_work',
      order: Number(m[1]) * 10 + orderSet.indexOf(section)
    };
  }

  m = code.match(/(?:護|N)?4([1-9])([A-D])/i);
  if (m) {
    const section = m[2].toUpperCase();
    return {
      canonical: `護4${m[1]}${section}`,
      program: '4yr',
      order: Number(m[1]) * 10 + CLASS_LETTER_ORDER.indexOf(section)
    };
  }

  const semType = semester ? String(semester).slice(-1) : '';
  return {
    canonical: raw,
    program: semType === '2' ? '4yr' : '2yr_gen',
    order: 9000
  };
}

function normalizeSheet(s) {
  return classInfo(s).canonical;
}

const PROGRAM_ORDER = ['2yr_gen','2yr_work','2yr_night','4yr','post','retake_class','retake_student'];
const PROGRAM_LABELS = {
  '2yr_gen':        '二技一般',
  '2yr_work':       '二技在職',
  '2yr_night':      '二技夜間',
  '4yr':            '四技一般',
  'post':           '學士後護',
  'retake_class':   '重修班',
  'retake_student': '重修生',
};
const PROGRAM_COLORS = {
  '2yr_gen':        '#4f8ef7',
  '2yr_work':       '#64d4a8',
  '2yr_night':      '#f7a44f',
  '4yr':            '#e06c8c',
  'post':           '#be78f0',
  'retake_class':   '#f0c85b',
  'retake_student': '#a0b0c0',
};

function programOrderIndex(program) {
  const idx = PROGRAM_ORDER.indexOf(program);
  return idx >= 0 ? idx : 99;
}

function compareSheetNames(a, b) {
  const ia = classInfo(a), ib = classInfo(b);
  const programOrder = programOrderIndex(ia.program) - programOrderIndex(ib.program);
  if (programOrder !== 0) return programOrder;
  if (ia.order !== ib.order) return ia.order - ib.order;
  return ia.canonical.localeCompare(ib.canonical, 'zh-TW', { numeric: true });
}

function compareClassRecords(a, b) {
  return a.semester.localeCompare(b.semester)
    || compareSheetNames(a.sheet_name, b.sheet_name)
    || (a.type || '').localeCompare(b.type || '');
}

function mergeClassSummary(target, source) {
  const weightedFields = ['avg_midterm', 'avg_final', 'avg_semester', 'pass_rate', 'retaker_rate'];
  const sameSummary = target.count === source.count
    && weightedFields.every(k => target[k] === source[k]);

  if (!sameSummary) {
    const countA = Number(target.count) || 0;
    const countB = Number(source.count) || 0;
    const total = countA + countB;
    weightedFields.forEach(k => {
      if (target[k] == null) target[k] = source[k] ?? null;
      else if (source[k] != null && total > 0) target[k] = +(((target[k] * countA) + (source[k] * countB)) / total).toFixed(2);
    });
    if (Array.isArray(target.score_distribution) && Array.isArray(source.score_distribution)) {
      target.score_distribution = target.score_distribution.map((v, i) => v + (source.score_distribution[i] || 0));
    }
    target.count = total || target.count || source.count;
  }

  Object.keys(source).forEach(k => {
    if (target[k] == null && source[k] != null) target[k] = source[k];
  });
}

function normalizeData() {
  // SEC-BUG-1 FIX: validate required top-level keys before accessing
  const REQUIRED = ['class_summary', 'students', 'meta'];
  const missing = REQUIRED.filter(k => !DATA || typeof DATA[k] !== 'object' || DATA[k] === null);
  if (missing.length) {
    throw new Error(`data.json 格式不符：缺少必要欄位 [${missing.join(', ')}]。請重新執行 ETL。`);
  }
  if (!Array.isArray(DATA.meta.semesters) || DATA.meta.semesters.length === 0) {
    throw new Error('data.json 格式不符：meta.semesters 必須為非空陣列。請重新執行 ETL。');
  }

  const newCS = {};
  for (const [key, val] of Object.entries(DATA.class_summary)) {
    const normName = normalizeSheet(val.sheet_name);
    val.sheet_name = normName;
    const normType = val.type || 'all';
    const normKey = `${val.semester}_${normName}_${normType}`;
    if (newCS[normKey]) {
      mergeClassSummary(newCS[normKey], val);
    } else {
      newCS[normKey] = val;
    }
  }
  DATA.class_summary = newCS;

  if (DATA.students) {
    for (const stu of Object.values(DATA.students)) {
      if (stu.records) {
        stu.records.forEach(r => { r.sheet_name = normalizeSheet(r.sheet_name); });
      }
    }
  }
}

async function loadData() {
  if (location.protocol === 'file:') {
    document.getElementById('metaInfo').innerHTML =
      `⚠ 請透過本機伺服器開啟（<code>npx serve .</code> 或 VS Code Live Server），` +
      `直接用 file:// 開啟時 fetch() 無法讀取 data/data.json。`;
    return;
  }
  try {
    const res = await fetch('data/data.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    DATA = await res.json();
    normalizeData();
    if (typeof FilterEngine !== 'undefined') FilterEngine.buildIndex(DATA);
    init();
    bindStaticHandlers();
  } catch(e) {
    document.getElementById('metaInfo').textContent = `⚠ 無法載入 data/data.json（${e.message}）`;
  }
}

function init() {
  const m = DATA.meta;
  document.getElementById('metaInfo').innerHTML =
    `${escapeHtml(String(m.semesters.length))} 學期 · 更新 ${escapeHtml(m.generated_at.slice(0,10))}`;

  const sems = m.semesters;
  if (sems.length > 0) {
    const first = sems[0], last = sems[sems.length - 1];
    const fmt = s => `${s.slice(0,3)}(${s.slice(3)})`;
    const rangeText = first === last ? fmt(first) : `${fmt(first)} - ${fmt(last)}`;
    const studentText = Number(m.total_students || 0).toLocaleString();
    document.getElementById('yearRangeBadge').textContent =
      `成績 ${rangeText} · ${studentText}人`;
  }

  populateFilters();
  initDSemFilter();
  populateCFilterSem();
  renderD();
  requestAnimationFrame(() => {
    attachInfoButtons();
    attachChartExpandButtons();
  });
  // 背景預載行為資料，不阻塞主流程；切換至學習行為分頁時直接使用快取
  setTimeout(() => {
    if (typeof BehaviorTabManager !== 'undefined') {
      BehaviorTabManager.lazyInit(); // lazyInit 內部已有完整 try/catch，無需外層 catch
    }
  }, 0);
}

// ══════════════════════════════════════════════════════════
// FILTERS
// ══════════════════════════════════════════════════════════
function semLabel(s) {
  if (!s) return '';
  const y = String(s).slice(0,3), t = String(s).slice(3);
  return `${y}(${t})`;
}

function sortSemestersDesc(sems) {
  return [...sems].sort((a, b) => Number(b) - Number(a));
}

function sortPrograms(progs) {
  return [...progs].sort((a, b) =>
    programOrderIndex(a) - programOrderIndex(b)
  );
}

function sortSheetNames(names) {
  return [...new Set(names.map(normalizeSheet).filter(Boolean))].sort(compareSheetNames);
}

function populateFilters() {
  const sems = DATA.meta.semesters;
  const semsDesc = sortSemestersDesc(sems);

  const aSem = document.getElementById('aFilterSem');
  aSem.innerHTML = `<option value="all">全學期 All</option>` +
    semsDesc.map(s => `<option value="${escapeHtml(s)}">${escapeHtml(semLabel(s))}</option>`).join('');

  _applyProgramDisabledState('all');
  _applyTypeLockedState('all');
  _rebuildSheetOptions('all', 'all', 'all', 'init');

  const trendSheets = sortSheetNames([...new Set(
    Object.values(DATA.class_summary).map(c => c.sheet_name)
  )]);
  const aTrend = document.getElementById('aTrendSheet');
  aTrend.innerHTML = trendSheets.map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');

  populateCYearFilter();
}

function updateSheetFilter() {
  const sem  = document.getElementById('aFilterSem').value;
  const type = document.getElementById('aFilterType').value;
  const prog = (document.getElementById('aFilterProgram') || {}).value || 'all';
  _rebuildSheetOptions(sem, prog, type, 'external');
  return document.getElementById('aFilterSheet').value || 'all';
}

function cloneClassSummary(c) {
  return {
    ...c,
    score_distribution: Array.isArray(c.score_distribution) ? [...c.score_distribution] : c.score_distribution
  };
}

function aggregateClassSummaries(rows, sem, sheet, type = 'all') {
  if (!rows.length) return null;
  const total = rows.reduce((a, c) => a + (Number(c.count) || 0), 0);
  const first = cloneClassSummary(rows[0]);
  first.semester = sem;
  first.sheet_name = normalizeSheet(sheet);
  first.type = type;
  first.count = total || rows.reduce((a, c) => a + (c.count || 0), 0);

  ['avg_midterm', 'avg_final', 'avg_semester', 'pass_rate', 'retaker_rate'].forEach(field => {
    const weighted = rows
      .filter(c => c[field] != null)
      .reduce((acc, c) => {
        const w = Number(c.count) || 1;
        acc.sum += c[field] * w;
        acc.weight += w;
        return acc;
      }, { sum: 0, weight: 0 });
    first[field] = weighted.weight ? +(weighted.sum / weighted.weight).toFixed(2) : null;
  });

  if (rows.some(c => Array.isArray(c.score_distribution))) {
    first.score_distribution = Array(11).fill(0);
    rows.forEach(c => {
      if (!Array.isArray(c.score_distribution)) return;
      c.score_distribution.forEach((v, i) => { first.score_distribution[i] += v || 0; });
    });
  }

  return first;
}

function getClassSummary(sem, sheet, type = 'all', includeRetaker = true) {
  const rows = Object.values(DATA.class_summary).filter(c => {
    if (sem !== 'all' && c.semester !== sem) return false;
    if (sheet !== 'all' && c.sheet_name !== normalizeSheet(sheet)) return false;
    if (type !== 'all' && c.type !== type) return false;
    if (!includeRetaker) {
      const prog = classInfo(c.sheet_name, c.semester).program;
      if (prog === 'retake_class' || prog === 'retake_student') return false;
    }
    return true;
  });
  if (!rows.length) return null;
  const normSheet = sheet === 'all' ? 'all' : normalizeSheet(sheet);
  return rows.length === 1 ? cloneClassSummary(rows[0]) : aggregateClassSummaries(rows, sem, normSheet, type);
}

function recordMatchesClass(r, sem, sheet, type = 'all') {
  return r.semester === sem &&
    normalizeSheet(r.sheet_name) === normalizeSheet(sheet) &&
    (type === 'all' || r.type === type);
}

function availableCompareSems(sem, sheet, type = 'all', includeRetaker = true) {
  const sems = DATA.meta.semesters;
  const idx = sems.indexOf(sem);
  if (idx <= 0) return [];
  return sems
    .slice(0, idx)
    .reverse()
    .filter(prevSem => getClassSummary(prevSem, sheet, type, includeRetaker));
}

function updateCompareFilter(sem, sheet, type = 'all', includeRetaker = true) {
  const el = document.getElementById('aCompareSem');
  if (!el) return '';
  if (sem === 'all') {
    el.innerHTML = `<option value="auto">全學期模式下不適用</option>`;
    el.value = 'auto';
    return 'auto';
  }
  const candidates = availableCompareSems(sem, sheet, type, includeRetaker);
  const prev = el.value || 'auto';
  el.innerHTML = [
    `<option value="auto">自動：上一個有資料</option>`,
    ...candidates.map(s => `<option value="${escapeHtml(s)}">${escapeHtml(semLabel(s))}</option>`)
  ].join('');
  if (prev !== 'auto' && candidates.includes(prev)) el.value = prev;
  else el.value = 'auto';
  return el.value;
}

// ══════════════════════════════════════════════════════════
// PANEL A — 篩選器連動
// ══════════════════════════════════════════════════════════
let _aFilterSnapshot = null;

function onAFilterChange(changedField) {
  const sem       = document.getElementById('aFilterSem').value;
  const program   = document.getElementById('aFilterProgram').value;
  const courseType= document.getElementById('aFilterType').value;

  _aFilterSnapshot = { sem, program, courseType,
    sheet: document.getElementById('aFilterSheet').value };

  _applyProgramDisabledState(sem);
  _applyTypeLockedState(program);

  const resetFields = _rebuildSheetOptions(sem, program, courseType, changedField);

  if (resetFields.length > 0) {
    _showAResetHint(changedField, resetFields);
  } else {
    _hideAResetHint();
  }

  const newSheet = document.getElementById('aFilterSheet').value;
  const emptyCheck = typeof FilterEngine !== 'undefined'
    ? FilterEngine.checkEmptyResult(sem, program, courseType, DATA)
    : { empty: false };

  if (emptyCheck.empty) {
    _showAEmptyHint(emptyCheck.reason);
    document.getElementById('aStats').innerHTML =
      `<div class="empty-state" style="padding:12px;color:var(--red)">⚠ ${emptyCheck.reason}</div>`;
    return;
  }
  _hideAEmptyHint();
  renderA();
}

function _applyProgramDisabledState(sem) {
  const sel = document.getElementById('aFilterProgram');
  if (!sel) return;
  const suffix = sem && sem !== 'all' ? String(sem).slice(-1) : null;
  const disabledMap = { '1': ['4yr'], '2': ['2yr_gen','2yr_work','2yr_night','post'] };
  const disabled = suffix ? (disabledMap[suffix] || []) : [];
  const TOOLTIPS = {
    '4yr':       '四技一般僅於下半學期開課',
    '2yr_gen':   '二技僅於上半學期開課',
    '2yr_work':  '二技在職僅於上半學期開課',
    '2yr_night': '二技夜間僅於上半學期開課',
    'post':      '學士後護僅於上半學期開課',
  };
  Array.from(sel.options).forEach(opt => {
    const v = opt.value;
    if (v === 'all') return;
    opt.disabled = disabled.includes(v);
    opt.style.color = disabled.includes(v) ? 'var(--text-dim)' : '';
    opt.title = disabled.includes(v) ? (TOOLTIPS[v] || '') : '';
  });
  if (disabled.includes(sel.value)) {
    sel.value = 'all';
  }
}

function _applyTypeLockedState(program) {
  const sel = document.getElementById('aFilterType');
  if (!sel) return;
  const noLab = ['2yr_gen','2yr_work','2yr_night','retake_class'];
  if (noLab.includes(program)) {
    sel.value = 'theory';
    Array.from(sel.options).forEach(opt => {
      opt.disabled = opt.value === 'practicum';
      opt.title    = opt.value === 'practicum' ? '此學制不開設實驗課' : '';
    });
  } else {
    Array.from(sel.options).forEach(opt => { opt.disabled = false; opt.title = ''; });
  }
}

function _rebuildSheetOptions(sem, program, courseType, changedField) {
  const el = document.getElementById('aFilterSheet');
  const prevSheet = el.value;
  const resetFields = [];

  const sheetCountMap = {};
  Object.values(DATA.class_summary).forEach(c => {
    if (sem !== 'all' && c.semester !== sem) return;
    if (courseType !== 'all' && c.type !== courseType) return;
    const prog = classInfo(c.sheet_name, c.semester).program;
    if (program !== 'all' && prog !== program) return;
    const sn = c.sheet_name;
    sheetCountMap[sn] = (sheetCountMap[sn] || 0) + (c.count || 0);
  });

  const sheets = sortSheetNames(Object.keys(sheetCountMap));

  el.innerHTML = `<option value="all">全部班級 All</option>` +
    sheets.map(s => {
      const cnt = sheetCountMap[s];
      const label = cnt ? `${s}（${cnt}人）` : s;
      return `<option value="${escapeHtml(s)}">${escapeHtml(label)}</option>`;
    }).join('');

  if (prevSheet !== 'all' && !sheets.includes(prevSheet)) {
    el.value = 'all';
    if (changedField !== 'class') resetFields.push('班級');
  } else {
    el.value = prevSheet;
  }

  return resetFields;
}

function _showAResetHint(changedField, resetFields) {
  const FIELD_LABELS = { semester:'學期', program:'學制', courseType:'課程類型', class:'班級' };
  const hint = document.getElementById('aResetHint');
  const text = document.getElementById('aResetHintText');
  if (!hint || !text) return;
  text.textContent =
    `已自動調整：${resetFields.join('、')} 已重置（因 ${FIELD_LABELS[changedField] || changedField} 變更）`;
  hint.style.display = 'flex';
}

function _hideAResetHint() {
  const hint = document.getElementById('aResetHint');
  if (hint) hint.style.display = 'none';
}

function undoAFilterReset() {
  if (!_aFilterSnapshot) return;
  const { sem, program, courseType, sheet } = _aFilterSnapshot;
  document.getElementById('aFilterSem').value    = sem;
  document.getElementById('aFilterProgram').value = program;
  document.getElementById('aFilterType').value    = courseType;
  _rebuildSheetOptions(sem, program, courseType, 'class');
  document.getElementById('aFilterSheet').value   = sheet;
  _applyProgramDisabledState(sem);
  _applyTypeLockedState(program);
  _hideAResetHint();
  _hideAEmptyHint();
  renderA();
}

function resetAFilters() {
  document.getElementById('aFilterSem').value     = 'all';
  document.getElementById('aFilterProgram').value  = 'all';
  document.getElementById('aFilterType').value     = 'all';
  _applyProgramDisabledState('all');
  _applyTypeLockedState('all');
  _rebuildSheetOptions('all','all','all','semester');
  document.getElementById('aFilterSheet').value = 'all';
  _hideAResetHint();
  _hideAEmptyHint();
  if (typeof _retakerState !== 'undefined') {
    _retakerState['A'] = true;
    if (typeof _syncRetakerBtn === 'function') _syncRetakerBtn('A');
  }
  if (typeof _filterCollapsed !== 'undefined' && _filterCollapsed['A']) {
    _filterCollapsed['A'] = false;
    if (typeof _applyFilterCollapse === 'function') _applyFilterCollapse('A');
  }
  renderA();
}

function _showAEmptyHint(reason) {
  const el = document.getElementById('aEmptyHint');
  if (!el) return;
  el.textContent = `⚠ 查無資料：${reason}`;
  el.style.display = 'block';
}

function _hideAEmptyHint() {
  const el = document.getElementById('aEmptyHint');
  if (el) el.style.display = 'none';
}

// ══════════════════════════════════════════════════════════
// PANEL A
// ══════════════════════════════════════════════════════════
function renderA() {
  const sheet = document.getElementById('aFilterSheet').value;
  const sem   = document.getElementById('aFilterSem').value;
  const type  = document.getElementById('aFilterType').value;
  const cls   = getClassSummary(sem, sheet, type, getIncludeRetaker('A'));

  if (!cls) {
    document.getElementById('aStats').innerHTML = '<div class="empty-state">無此班次資料</div>';
    return;
  }

  const passColor = cls.pass_rate >= 0.9 ? 'var(--green)' : cls.pass_rate >= 0.7 ? 'var(--accent3)' : 'var(--red)';
  document.getElementById('aStats').innerHTML = `
    <div class="stat-card" style="--accent-color:var(--accent)">
      <div class="val">${cls.count}</div>
      <div class="lbl">人數 Students</div>
    </div>
    <div class="stat-card" style="--accent-color:var(--accent2)">
      <div class="val">${cls.avg_semester ?? '–'}</div>
      <div class="lbl">學期平均 Avg Score</div>
    </div>
    <div class="stat-card" style="--accent-color:${passColor}">
      <div class="val">${cls.pass_rate != null ? (cls.pass_rate*100).toFixed(1)+'%' : '–'}</div>
      <div class="lbl">及格率 Pass Rate</div>
    </div>
    <div class="stat-card" style="--accent-color:var(--accent4)">
      <div class="val">${cls.retaker_rate != null ? (cls.retaker_rate*100).toFixed(1)+'%' : '–'}</div>
      <div class="lbl">重修率 Retaker Rate</div>
    </div>
    <div class="stat-card" style="--accent-color:var(--accent3)">
      <div class="val">${cls.avg_midterm ?? '–'}</div>
      <div class="lbl">期中平均 Midterm Avg</div>
    </div>
    <div class="stat-card" style="--accent-color:var(--accent)">
      <div class="val">${cls.avg_final ?? '–'}</div>
      <div class="lbl">期末平均 Final Avg</div>
    </div>
  `;

  const dist = cls.score_distribution;
  const labels = ['0-9','10-19','20-29','30-39','40-49','50-59','60-69','70-79','80-89','90-99','100'];
  mkChart('chartDist', {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: '人數',
        data: dist,
        backgroundColor: dist.map((_, i) => i >= 6
          ? 'rgba(100,212,168,0.7)' : 'rgba(240,112,112,0.5)'),
        borderColor: dist.map((_, i) => i >= 6
          ? '#64d4a8' : '#f07070'),
        borderWidth: 1,
        borderRadius: 3,
      }]
    },
    options: {
      ...CHART_DEFAULTS,
      plugins: {
        ...CHART_DEFAULTS.plugins,
        legend: { display: false },
        tooltip: {
          ...CHART_DEFAULTS.plugins.tooltip,
          callbacks: {
            label: ctx => `人數：${ctx.raw}（${cls.count ? (ctx.raw/cls.count*100).toFixed(1) : 0}%）`
          }
        }
      },
      scales: { ...CHART_DEFAULTS.scales, y: { ...CHART_DEFAULTS.scales.y, beginAtZero: true } }
    }
  });

  mkChart('chartMidFinal', {
    type: 'bar',
    data: {
      labels: ['期中考 Midterm', '期末考 Final', '學期成績 Semester'],
      datasets: [{
        label: '平均分',
        data: [cls.avg_midterm, cls.avg_final, cls.avg_semester],
        backgroundColor: ['rgba(79,142,247,0.7)', 'rgba(100,212,168,0.7)', 'rgba(247,164,79,0.7)'],
        borderColor: ['#4f8ef7', '#64d4a8', '#f7a44f'],
        borderWidth: 1,
        borderRadius: 4,
      }]
    },
    options: {
      ...CHART_DEFAULTS,
      indexAxis: 'y',
      plugins: { ...CHART_DEFAULTS.plugins, legend: { display: false } },
      scales: {
        x: { ...CHART_DEFAULTS.scales.x, min: 0, max: 100 },
        y: { ...CHART_DEFAULTS.scales.y }
      }
    }
  });

  renderNormalOverlay(cls, sem, sheet, type);
  renderRegression(sem, sheet, type);
  renderVarianceBar(sem, sheet);

  const trendCard = document.getElementById('chartTrend')?.closest('.chart-card');
  if (sheet === 'all') {
    if (trendCard) trendCard.style.display = 'none';
  } else {
    if (trendCard) trendCard.style.display = '';
    renderTrend();
  }

  updateFilterSummary('A');
}

function renderTrend() {
  if (!DATA) return;
  const sheetName = document.getElementById('aTrendSheet').value;
  const type = document.getElementById('aFilterType')?.value || 'all';
  const relevant = DATA.meta.semesters
    .map(sem => getClassSummary(sem, sheetName, type, getIncludeRetaker('A')))
    .filter(Boolean);

  if (relevant.length === 0) return;

  const labels = relevant.map(c => semLabel(c.semester));
  mkChart('chartTrend', {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: '期中 Midterm',
          data: relevant.map(c => c.avg_midterm),
          borderColor: '#4f8ef7', backgroundColor: 'rgba(79,142,247,0.1)',
          tension: 0.3, fill: false, pointRadius: 5, pointHoverRadius: 7,
        },
        {
          label: '期末 Final',
          data: relevant.map(c => c.avg_final),
          borderColor: '#64d4a8', backgroundColor: 'rgba(100,212,168,0.1)',
          tension: 0.3, fill: false, pointRadius: 5, pointHoverRadius: 7,
        },
        {
          label: '學期 Semester',
          data: relevant.map(c => c.avg_semester),
          borderColor: '#f7a44f', backgroundColor: 'rgba(247,164,79,0.1)',
          tension: 0.3, fill: false, pointRadius: 5, pointHoverRadius: 7,
          borderDash: [5,3],
        },
        {
          label: '及格率×100 Pass Rate×100',
          data: relevant.map(c => c.pass_rate != null ? (c.pass_rate*100) : null),
          borderColor: '#e06c8c', backgroundColor: 'rgba(224,108,140,0.05)',
          tension: 0.3, fill: false, pointRadius: 4, pointHoverRadius: 6,
          borderDash: [2,4],
        }
      ]
    },
    options: {
      ...CHART_DEFAULTS,
      scales: {
        x: { ...CHART_DEFAULTS.scales.x },
        y: { ...CHART_DEFAULTS.scales.y, min: 0, max: 100 }
      }
    }
  });
}

// ══════════════════════════════════════════════════════════
// PANEL B
// ══════════════════════════════════════════════════════════
function setBMode(mode) {
  bMode = mode;
  document.getElementById('modeBySheet').classList.toggle('active', mode === 'sheet');
  document.getElementById('modeByStudent').classList.toggle('active', mode === 'student');
  renderB();
}

function getRetakerRecords() {
  const type = document.getElementById('bFilterType').value;
  const retakers = [];

  for (const [sid, data] of Object.entries(DATA.students)) {
    const recs = data.records.filter(r => r.is_retaker && r.type === type);
    if (recs.length < 2) continue;

    if (bMode === 'sheet') {
      const bySheet = {};
      recs.forEach(r => {
        if (!bySheet[r.sheet_name]) bySheet[r.sheet_name] = [];
        bySheet[r.sheet_name].push(r);
      });
      for (const [sh, shRecs] of Object.entries(bySheet).sort(([a], [b]) => compareSheetNames(a, b))) {
        if (shRecs.length >= 2) {
          const sorted = [...shRecs].sort(compareClassRecords);
          retakers.push({ sid, masked: data.name_masked, recs: sorted, sheet: sh });
        }
      }
    } else {
      const sorted = [...recs].sort(compareClassRecords);
      retakers.push({ sid, masked: data.name_masked, recs: sorted, sheet: '全部' });
    }
  }
  return retakers.sort((a, b) =>
    compareSheetNames(a.sheet, b.sheet) || a.masked.localeCompare(b.masked, 'zh-TW')
  );
}

// ══════════════════════════════════════════════════════════
// PANEL C — 整合控制器
// ══════════════════════════════════════════════════════════
let cCurrentView = 'general';
let cCurrentExam = 'semester_score';
let cCurrentType = 'all';
let cCurrentPass = 'all';

function switchCView(view) {
  cCurrentView = view;

  document.querySelectorAll('#cViewControls .seg-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.view === view)
  );

  const isGeneral = view === 'general';
  document.getElementById('cFilterGeneral').style.display = isGeneral ? '' : 'none';
  document.getElementById('cFilterRetake').style.display  = isGeneral ? 'none' : '';
  document.getElementById('cResetBtn').style.display      = '';

  if (isGeneral) {
    _resetCGeneralFilters();
  } else {
    _resetCRetakeFilters();
    document.getElementById('cPanelRetake').style.display  = '';
    document.getElementById('cPanelGeneral').style.display = 'none';
    document.getElementById('cStats').innerHTML = '';
    document.getElementById('bStats').innerHTML = '';
    return;
  }

  document.getElementById('cPanelGeneral').style.display = '';
  document.getElementById('cPanelRetake').style.display  = 'none';
  renderCView();
}

function onCGeneralFilterChange(changedField) {
  const sem     = document.getElementById('cFilterSem').value;
  const program = document.getElementById('cFilterProgram').value;

  const noLab = ['2yr_gen','2yr_work','2yr_night','retake_class'];
  const lockHint = document.getElementById('cTypeLockHint');
  if (noLab.includes(program)) {
    cCurrentType = 'theory';
    ['cTypeAll','cTypeTheory','cTypePrac'].forEach(id => {
      const btn = document.getElementById(id);
      if (!btn) return;
      btn.classList.toggle('active', id === 'cTypeTheory');
      if (id === 'cTypePrac') { btn.disabled = true; btn.style.opacity = '0.4'; }
      else { btn.disabled = false; btn.style.opacity = ''; }
    });
    if (lockHint) {
      lockHint.textContent = `此學制不開設實驗課，課程類型已鎖定為正課`;
      lockHint.style.display = 'block';
    }
  } else {
    ['cTypeAll','cTypeTheory','cTypePrac'].forEach(id => {
      const btn = document.getElementById(id);
      if (btn) { btn.disabled = false; btn.style.opacity = ''; }
    });
    if (lockHint) lockHint.style.display = 'none';
  }

  _hideCEmptyHint();
  renderCView();
}

function setCType(type) {
  cCurrentType = type;
  ['cTypeAll','cTypeTheory','cTypePrac'].forEach(id => {
    const map = { cTypeAll:'all', cTypeTheory:'theory', cTypePrac:'practicum' };
    document.getElementById(id)?.classList.toggle('active', map[id] === type);
  });
  renderCView();
}

function setCPass(pass) {
  cCurrentPass = pass;
  ['cPassAll','cPassPass','cPassFail'].forEach(id => {
    const map = { cPassAll:'all', cPassPass:'pass', cPassFail:'fail' };
    document.getElementById(id)?.classList.toggle('active', map[id] === pass);
  });
  renderCView();
}

function setCExam(metric) {
  cCurrentExam = metric;
  ['cExamSem','cExamMid','cExamFin','cExamSemR','cExamMidR','cExamFinR'].forEach(id => {
    document.getElementById(id)?.classList.remove('active');
  });
  const map = {
    semester_score: ['cExamSem','cExamSemR'],
    midterm:        ['cExamMid','cExamMidR'],
    final:          ['cExamFin','cExamFinR'],
  };
  (map[metric] || []).forEach(id => document.getElementById(id)?.classList.add('active'));
  renderCView();
}

function resetCFilters() {
  if (cCurrentView === 'retake') {
    _resetCRetakeFilters();
    document.getElementById('cStats').innerHTML = '';
    document.getElementById('bStats').innerHTML = '';
    const hint = document.getElementById('cRetakeSearchHint');
    if (hint) hint.style.display = '';
  } else {
    _resetCGeneralFilters();
    renderCView();
  }
}

function _resetCGeneralFilters() {
  const semEl = document.getElementById('cFilterSem');
  if (semEl) semEl.value = 'all';
  const progEl = document.getElementById('cFilterProgram');
  if (progEl) progEl.value = 'all';
  cCurrentType = 'all';
  cCurrentPass = 'all';
  ['cTypeAll','cTypeTheory','cTypePrac'].forEach((id,i) =>
    document.getElementById(id)?.classList.toggle('active', i===0));
  ['cPassAll','cPassPass','cPassFail'].forEach((id,i) =>
    document.getElementById(id)?.classList.toggle('active', i===0));
  cCurrentExam = 'semester_score';
  ['cExamSem','cExamMid','cExamFin','cExamSemR','cExamMidR','cExamFinR'].forEach(id =>
    document.getElementById(id)?.classList.remove('active'));
  document.getElementById('cExamSem')?.classList.add('active');
  document.getElementById('cExamSemR')?.classList.add('active');
  const searchEl = document.getElementById('cSearch');
  if (searchEl) searchEl.value = '';
  const searchBox = document.getElementById('searchResults');
  if (searchBox) { searchBox.classList.remove('open'); searchBox.innerHTML = ''; }
  // BUG-5 FIX: 清除學生成績輪廓區塊與搜尋提示
  const profileWrap = document.getElementById('profileWrap');
  if (profileWrap) { profileWrap.innerHTML = ''; profileWrap.style.marginBottom = ''; }
  const searchHint = document.getElementById('cSearchHint');
  if (searchHint) searchHint.style.display = '';
  ['cTypePrac'].forEach(id => {
    const btn = document.getElementById(id);
    if (btn) { btn.disabled = false; btn.style.opacity = ''; }
  });
  const lockHint = document.getElementById('cTypeLockHint');
  if (lockHint) lockHint.style.display = 'none';
  _hideCEmptyHint();
}

function _resetCRetakeFilters() {
  const inp = document.getElementById('cSearchRetake');
  if (inp) inp.value = '';
  const box = document.getElementById('searchResultsRetake');
  if (box) { box.classList.remove('open'); box.innerHTML = ''; }
  const pw = document.getElementById('profileWrap');
  if (pw) pw.innerHTML = '';
  cCurrentExam = 'semester_score';
  ['cExamSem','cExamMid','cExamFin','cExamSemR','cExamMidR','cExamFinR'].forEach(id =>
    document.getElementById(id)?.classList.remove('active'));
  document.getElementById('cExamSem')?.classList.add('active');
  document.getElementById('cExamSemR')?.classList.add('active');
}

function onCRetakeSearch() {
  const q = document.getElementById('cSearchRetake')?.value?.trim() || '';
  const box = document.getElementById('searchResultsRetake');
  const hint = document.getElementById('cRetakeSearchHint');

  if (q.length < 2) {
    if (box) { box.classList.remove('open'); box.innerHTML = ''; }
    if (hint) hint.style.display = '';
    return;
  }
  if (hint) hint.style.display = 'none';

  const results = [];
  const pat = q.replace(/\*/g, '.*').replace(/\?/g, '.');
  let re;
  try { re = new RegExp(pat, 'i'); } catch { re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'), 'i'); }

  Object.entries(DATA.students).forEach(([sid, s]) => {
    if (!s.records.some(r => r.is_retaker)) return;
    if (re.test(sid) || re.test(s.name_masked || '')) results.push({ id: sid, masked: s.name_masked });
  });

  if (!box) return;
  if (!results.length) {
    box.innerHTML = '<div class="no-result">查無重修學生（學號片段不符或無重修記錄）</div>';
    box.classList.add('open');
    return;
  }

  box.innerHTML = results.slice(0, 12).map(r =>
    `<div class="result-item" data-sid="${escapeHtml(r.id)}" data-action="selectRetakeStudent">
       <span class="result-id">${escapeHtml(r.id)}</span>
       <span class="result-name">${escapeHtml(r.masked || '–')}</span>
     </div>`
  ).join('');
  box.classList.add('open');
}

function selectRetakeStudent(sid) {
  const inp = document.getElementById('cSearchRetake');
  if (inp) inp.value = sid;
  const box = document.getElementById('searchResultsRetake');
  if (box) box.classList.remove('open');
  selectStudent(sid);
  renderCView();
}

function _showCEmptyHint(reason) {
  const el = document.getElementById('cEmptyHint');
  if (el) { el.textContent = `⚠ 查無資料：${reason}`; el.style.display = 'block'; }
}
function _hideCEmptyHint() {
  const el = document.getElementById('cEmptyHint');
  if (el) el.style.display = 'none';
}

function renderCView() {
  if (!DATA) return;
  if (cCurrentView === 'general') {
    renderCAnomalyAndDist();
    renderCStats();
  } else {
    const retakeId = document.getElementById('cSearchRetake')?.value?.trim() || '';
    if (!retakeId) return;
    renderCRetakeStats();
    renderB();
    renderRetakerFirstDist();
  }
  updateFilterSummary('C');
}

function initCPanel() {
  if (!DATA) return;
  populateCYearFilter();
  populateCFilterSem();
  setBType('theory');
  _resetCGeneralFilters();
  renderCView();
  const pw = document.getElementById('profileWrap');
  if (pw && !pw.querySelector('[data-student-profile]')) pw.innerHTML = '';
}

function populateCFilterSem() {
  const sel = document.getElementById('cFilterSem');
  if (!sel || !DATA) return;
  const sems = [...DATA.meta.semesters].sort((a,b) => Number(b)-Number(a));
  sel.innerHTML = '<option value="all">全部學期 All</option>' +
    sems.map(s => `<option value="${escapeHtml(s)}">${escapeHtml(semLabel(s))}</option>`).join('');
}

function populateCYearFilter() {
  const sel = document.getElementById('cFilterYear');
  if (!sel || !DATA) return;
  const sems = (DATA.meta.semesters || []).map(String);
  const years = [...new Set(sems.map(s => s.slice(0,3)))].sort((a,b) => b-a);
  let html = '<option value="all">全部學年</option>';
  years.forEach(yr => {
    const sem1 = yr+'1', sem2 = yr+'2';
    html += `<optgroup label="${yr} 學年度">`;
    if (sems.includes(sem1)) html += `<option value="${sem1}">${yr}(1)</option>`;
    if (sems.includes(sem2)) html += `<option value="${sem2}">${yr}(2)</option>`;
    html += `</optgroup>`;
  });
  sel.innerHTML = html;
}

function getCFilteredRecords() {
  if (!DATA) return [];
  const semVal  = document.getElementById('cFilterSem')?.value  || 'all';
  const progVal = document.getElementById('cFilterProgram')?.value || 'all';
  const typeVal = cCurrentType;
  const passVal = cCurrentPass;
  const inclRetaker = getIncludeRetaker('C');

  const result = [];
  Object.values(DATA.students).forEach(stu => {
    stu.records.forEach(r => {
      if (semVal  !== 'all' && String(r.semester) !== String(semVal))  return;
      if (progVal !== 'all' && classInfo(r.sheet_name||'', r.semester).program !== progVal) return;
      if (typeVal !== 'all' && r.type !== typeVal) return;
      if (!inclRetaker && r.is_retaker) return;
      const score = r[cCurrentExam];
      if (passVal === 'pass' && (score == null || score < 60)) return;
      if (passVal === 'fail' && (score == null || score >= 60)) return;
      result.push({ ...r, masked: stu.name_masked });
    });
  });
  return result;
}

function renderCAnomalyAndDist() {
  renderAnomalyDensity();

  const recs = getCFilteredRecords().filter(r => {
    const s = r[cCurrentExam];
    return s != null && !isNaN(s);
  });

  const buckets = Array(11).fill(0);
  recs.forEach(r => {
    const s = r[cCurrentExam];
    const idx = s >= 100 ? 10 : Math.floor(s / 10);
    buckets[Math.min(idx, 10)]++;
  });

  const labels = ['0-9','10-19','20-29','30-39','40-49','50-59','60-69','70-79','80-89','90-99','100'];

  mkChart('cChartDist', {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: '人次',
        data: buckets,
        backgroundColor: buckets.map((_,i) => i < 6 ? 'rgba(240,112,112,0.7)' : 'rgba(79,142,247,0.7)'),
        borderRadius: 4
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { font: { size: 10 } } },
        y: { beginAtZero: true, ticks: { font: { size: 10 } } }
      }
    }
  });
}

function renderCStats() {
  const recs = getCFilteredRecords().filter(r => r[cCurrentExam] != null);
  const scores = recs.map(r => r[cCurrentExam]).filter(s => !isNaN(s));
  if (!scores.length) { document.getElementById('cStats').innerHTML = ''; return; }
  const avg = (scores.reduce((a,b)=>a+b,0)/scores.length).toFixed(1);
  const pass = scores.filter(s=>s>=60).length;
  const passRate = ((pass/scores.length)*100).toFixed(1);
  document.getElementById('cStats').innerHTML = `
    <div class="stat-card" style="--accent-color:var(--accent)">
      <div class="val">${scores.length}</div><div class="lbl">記錄筆數</div>
    </div>
    <div class="stat-card" style="--accent-color:var(--accent2)">
      <div class="val">${avg}</div><div class="lbl">平均分</div>
    </div>
    <div class="stat-card" style="--accent-color:var(--green)">
      <div class="val">${passRate}%</div><div class="lbl">及格率</div>
    </div>
  `;
}

function renderCRetakeStats() {
  const retakers = getRetakerRecords();
  const allDeltas = retakers.flatMap(r => r.recs.filter(rec => rec.delta != null).map(rec => rec.delta));
  const improved = allDeltas.filter(d=>d>0).length;
  const worsened = allDeltas.filter(d=>d<0).length;
  const avgDelta = allDeltas.length ? (allDeltas.reduce((a,b)=>a+b,0)/allDeltas.length).toFixed(1) : '–';
  document.getElementById('cStats').innerHTML = `
    <div class="stat-card" style="--accent-color:var(--accent4)">
      <div class="val">${retakers.length}</div><div class="lbl">重修學生</div>
    </div>
    <div class="stat-card" style="--accent-color:var(--green)">
      <div class="val">${improved}</div><div class="lbl">進步 Δ &gt; 0</div>
    </div>
    <div class="stat-card" style="--accent-color:var(--red)">
      <div class="val">${worsened}</div><div class="lbl">退步 Δ &lt; 0</div>
    </div>
    <div class="stat-card" style="--accent-color:var(--accent3)">
      <div class="val">${avgDelta}</div><div class="lbl">平均 Δ</div>
    </div>
  `;
}

function setBType(type) {
  const sel = document.getElementById('bFilterType');
  if (sel) sel.value = type;
  ['bTypeTheory','bTypePracticum'].forEach(id => document.getElementById(id)?.classList.remove('active'));
  document.getElementById(type === 'theory' ? 'bTypeTheory' : 'bTypePracticum')?.classList.add('active');
  renderB();
}

function renderB() {
  const retakers = getRetakerRecords();
  const type = document.getElementById('bFilterType').value;

  const allDeltas = retakers.flatMap(r =>
    r.recs.filter(rec => rec.delta != null).map(rec => rec.delta)
  );
  const improved = allDeltas.filter(d => d > 0).length;
  const worsened = allDeltas.filter(d => d < 0).length;
  const avgDelta = allDeltas.length ? (allDeltas.reduce((a,b)=>a+b,0)/allDeltas.length).toFixed(1) : '–';

  document.getElementById('bStats').innerHTML = `
    <div class="stat-card" style="--accent-color:var(--accent4)">
      <div class="val">${retakers.length}</div>
      <div class="lbl">重修學生 Retakers</div>
    </div>
    <div class="stat-card" style="--accent-color:var(--green)">
      <div class="val">${improved}</div>
      <div class="lbl">進步 Improved</div>
      <div class="sub">Δ &gt; 0</div>
    </div>
    <div class="stat-card" style="--accent-color:var(--red)">
      <div class="val">${worsened}</div>
      <div class="lbl">退步 Declined</div>
      <div class="sub">Δ &lt; 0</div>
    </div>
    <div class="stat-card" style="--accent-color:var(--accent3)">
      <div class="val">${avgDelta}</div>
      <div class="lbl">平均 Δ Avg Delta</div>
      <div class="sub">首修 → 重修</div>
    </div>
  `;

  renderSlope(retakers);
  renderDelta(allDeltas);
  renderQuadrant();
  renderDeltaByProgram(retakers);
  renderRetakeCount(type);
  renderFirstVsDelta();
}

function renderSlope(retakers) {
  const svg = document.getElementById('slopeChart');
  const W = Math.max(svg.parentElement.clientWidth - 20, 300);
  const H = 280;
  svg.setAttribute('width', W);

  const isDark = !document.body.classList.contains('light');
  const textCol  = isDark ? '#9aa0b8' : '#4a5070';
  const dimCol   = isDark ? '#6b748f' : '#8a90a8';
  const axisCol  = isDark ? '#2a2f45' : '#c8cce0';
  const gridCol  = isDark ? '#1c2030' : '#e0e4f0';

  if (retakers.length === 0) {
    svg.innerHTML = `<text x="${W/2}" y="${H/2}" text-anchor="middle" fill="${dimCol}" font-size="12">無重修資料</text>`;
    return;
  }

  const shown = retakers.slice(0, 30);
  const pad = { l: 60, r: 60, t: 24, b: 24 };
  const innerH = H - pad.t - pad.b;

  const allScores = shown.flatMap(r => r.recs.map(rec => rec.semester_score).filter(s => s != null));
  const minS = Math.max(0, Math.min(...allScores) - 5);
  const maxS = Math.min(100, Math.max(...allScores) + 5);
  const scaleY = s => pad.t + innerH * (1 - (s - minS) / (maxS - minS));

  const x1 = pad.l, x2 = W - pad.r;
  let svgHtml = `
    <line x1="${x1}" y1="${pad.t}" x2="${x1}" y2="${H-pad.b}" stroke="${axisCol}" stroke-width="1"/>
    <line x1="${x2}" y1="${pad.t}" x2="${x2}" y2="${H-pad.b}" stroke="${axisCol}" stroke-width="1"/>
    <text x="${x1}" y="${pad.t-6}" text-anchor="middle" fill="${dimCol}" font-size="10">首修</text>
    <text x="${x2}" y="${pad.t-6}" text-anchor="middle" fill="${dimCol}" font-size="10">重修</text>
  `;

  for (let v = Math.ceil(minS/10)*10; v <= maxS; v+=10) {
    const y = scaleY(v);
    svgHtml += `
      <line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="${gridCol}" stroke-width="1"/>
      <text x="${x1-8}" y="${y+4}" text-anchor="end" fill="${dimCol}" font-size="9">${v}</text>
    `;
  }

  shown.forEach(item => {
    const first = item.recs[0].semester_score;
    const last  = item.recs[item.recs.length-1].semester_score;
    if (first == null || last == null) return;
    const delta = last - first;
    const color = delta > 0 ? '#64d4a8' : delta < 0 ? '#f07070' : '#6b748f';
    const y1s = scaleY(first), y2s = scaleY(last);
    const firstSem = item.recs[0].semester, lastSem = item.recs[item.recs.length-1].semester;
    const tipAttr = `data-svgtip="1" data-masked="${safeSvgAttr(item.masked)}" data-first="${first}" data-last="${last}" data-delta="${delta>=0?'+':''}${delta}" data-fsem="${safeSvgAttr(firstSem)}" data-lsem="${safeSvgAttr(lastSem)}"`;

    svgHtml += `
      <line x1="${x1}" y1="${y1s}" x2="${x2}" y2="${y2s}"
        stroke="${color}" stroke-width="1.5" stroke-opacity="0.6"/>
      <circle ${tipAttr} cx="${x1}" cy="${y1s}" r="5" fill="${color}" opacity="0.8" style="cursor:pointer"/>
      <circle ${tipAttr} cx="${x2}" cy="${y2s}" r="5" fill="${color}" opacity="0.8" style="cursor:pointer"/>
    `;
  });

  svg.innerHTML = svgHtml;

  addSvgTooltip(svg, '[data-svgtip]', el => {
    const d = el.dataset;
    return `<b>${d.masked}</b>\n首修（${d.fsem}）：${d.first} 分\n重修（${d.lsem}）：${d.last} 分\nΔ：<b>${d.delta} 分</b>`;
  });
}

function renderDelta(allDeltas) {
  if (allDeltas.length === 0) return;
  const bins = {};
  allDeltas.forEach(d => {
    const b = Math.floor(d/10)*10;
    bins[b] = (bins[b]||0)+1;
  });
  const minB = Math.min(...Object.keys(bins).map(Number));
  const maxB = Math.max(...Object.keys(bins).map(Number));
  const labels = [], vals = [], colors = [];
  for (let b = minB; b <= maxB; b+=10) {
    labels.push(b >= 0 ? `+${b}~+${b+9}` : `${b}~${b+9}`);
    const v = bins[b]||0;
    vals.push(v);
    colors.push(b >= 0 ? 'rgba(100,212,168,0.7)' : 'rgba(240,112,112,0.6)');
  }
  mkChart('chartDelta', {
    type: 'bar',
    data: {
      labels,
      datasets: [{ label: '人數', data: vals, backgroundColor: colors, borderRadius: 3 }]
    },
    options: {
      ...CHART_DEFAULTS,
      plugins: { ...CHART_DEFAULTS.plugins, legend: { display: false } },
      scales: { ...CHART_DEFAULTS.scales, y: { ...CHART_DEFAULTS.scales.y, beginAtZero: true } }
    }
  });
}

function renderQuadrant() {
  const qCard = document.getElementById('quadrantCard');
  const pairs = [];
  for (const [sid, data] of Object.entries(DATA.students)) {
    if (!data.records.some(r => r.is_retaker)) continue;
    const bySem = {};
    data.records.forEach(r => {
      if (!bySem[r.semester]) bySem[r.semester] = {};
      if (r.type === 'theory') bySem[r.semester].theory = r.semester_score;
      if (r.type === 'practicum') bySem[r.semester].practicum = r.semester_score;
    });
    for (const [sem, scores] of Object.entries(bySem)) {
      if (scores.theory != null && scores.practicum != null) {
        pairs.push({ x: scores.theory, y: scores.practicum, sem, masked: data.name_masked });
      }
    }
  }

  if (pairs.length < 3) { qCard.style.display = 'none'; return; }
  qCard.style.display = 'block';

  mkChart('chartQuadrant', {
    type: 'scatter',
    data: {
      datasets: [{
        label: '學生',
        data: pairs,
        backgroundColor: pairs.map(p =>
          p.x>=60&&p.y>=60 ? 'rgba(100,212,168,0.6)' :
          p.x<60&&p.y>=60  ? 'rgba(247,164,79,0.6)' :
          p.x>=60&&p.y<60  ? 'rgba(247,164,79,0.6)' :
          'rgba(240,112,112,0.6)'),
        pointRadius: 6,
      }]
    },
    options: {
      ...CHART_DEFAULTS,
      plugins: {
        ...CHART_DEFAULTS.plugins,
        legend: { display: false },
        tooltip: {
          ...CHART_DEFAULTS.plugins.tooltip,
          callbacks: {
            label: ctx => `${ctx.raw.masked}  正課:${ctx.raw.x} 實驗:${ctx.raw.y}`
          }
        }
      },
      scales: {
        x: { ...CHART_DEFAULTS.scales.x, min: 0, max: 100,
          title: { display: true, text: '正課成績 Theory', color: '#6b748f' } },
        y: { ...CHART_DEFAULTS.scales.y, min: 0, max: 100,
          title: { display: true, text: '實驗成績 Practicum', color: '#6b748f' } }
      }
    }
  });
}

// ══════════════════════════════════════════════════════════
// PANEL C — 學生搜尋
// ══════════════════════════════════════════════════════════
function searchStudent() {
  const q = document.getElementById('cSearch').value.trim();
  const box = document.getElementById('searchResults');

  if (q.length < 2) { box.classList.remove('open'); return; }

  const results = [];
  for (const [sid, data] of Object.entries(DATA.students)) {
    const masked = data.name_masked;
    if (sid.includes(q) || masked.includes(q)) {
      const rCount = data.records.length;
      const hasExc = data.records.some(r => r.exceptions.length > 0);
      const isRet  = data.records.some(r => r.is_retaker);
      results.push({ sid, masked, rCount, hasExc, isRet });
      if (results.length >= 10) break;
    }
  }

  if (results.length === 0) {
    box.innerHTML = '<div class="search-item" style="color:var(--text-dim)">無符合結果</div>';
  } else {
    box.innerHTML = results.map(r => `
      <div class="search-item" data-sid="${escapeHtml(r.sid)}">
        <span>${escapeHtml(r.masked)}</span>
        <span class="s-info">
          ${r.rCount} 筆記錄
          ${r.isRet ? '· <span style="color:var(--accent4)">重修</span>' : ''}
          ${r.hasExc ? '· <span style="color:var(--yellow)">⚑</span>' : ''}
        </span>
      </div>
    `).join('');
    box.querySelectorAll('.search-item[data-sid]').forEach(el => {
      el.addEventListener('click', () => selectStudent(el.dataset.sid));
    });
  }
  box.classList.add('open');
}

function selectStudent(sid) {
  document.getElementById('searchResults').classList.remove('open');
  document.getElementById('cSearch').value = DATA.students[sid].name_masked;
  const hint = document.getElementById('cSearchHint');
  if (hint) hint.style.display = 'none';
  renderProfile(sid);
}

function renderProfile(sid) {
  const data = DATA.students[sid];
  const wrap = document.getElementById('profileWrap');

  if (!data) { wrap.innerHTML = '<div class="empty-state">找不到學生資料</div>'; wrap.style.marginBottom = '14px'; return; }
  wrap.style.marginBottom = '14px';

  const isRetaker = data.records.some(r => r.is_retaker);
  const allExc    = data.records.flatMap(r => r.exceptions);
  const excCounts = { red:0, yellow:0, blue:0, gray:0 };
  allExc.forEach(e => excCounts[e.color] = (excCounts[e.color]||0)+1);

  let html = `
    <div data-student-profile style="display:flex;align-items:center;gap:12px;margin-bottom:16px;flex-wrap:wrap">
      <div style="font-family:'Space Mono',monospace;font-size:20px;color:var(--text)">${escapeHtml(data.name_masked)}</div>
      ${isRetaker ? '<span class="tag tag-red">重修生 Retaker</span>' : ''}
      ${excCounts.red    ? `<span class="tag tag-red">🔴 ${excCounts.red} 重大違規</span>` : ''}
      ${excCounts.yellow ? `<span class="tag tag-yellow">🟡 ${excCounts.yellow} 態度異常</span>` : ''}
      ${excCounts.blue   ? `<span class="tag tag-blue">🔵 ${excCounts.blue} 行政缺漏</span>` : ''}
    </div>
  `;

  html += '<div class="timeline">';
  const sorted = [...data.records].sort(compareClassRecords);
  sorted.forEach(r => {
    const typeLabel = r.type === 'theory' ? 'Theory' : r.type === 'practicum' ? 'Practicum' : 'Summer';
    const scoreColor = (s) => s == null ? '' : s >= 60 ? 'pass' : 'fail';

    html += `
      <div class="tl-item">
        <div class="tl-dot ${escapeHtml(r.type)}"></div>
        <div class="tl-header">
          <span class="tl-sem">${escapeHtml(semLabel(r.semester))}</span>
          <span class="tl-sheet">${escapeHtml(r.sheet_name)}</span>
          <span class="tl-type-badge tl-type-${escapeHtml(r.type)}">${typeLabel}</span>
          ${r.is_retaker && r.delta != null
            ? `<span class="tl-delta ${r.delta>=0?'pos':'neg'}">Δ ${r.delta>=0?'+':''}${r.delta}</span>`
            : ''}
        </div>
        <div class="tl-scores">
          ${r.midterm != null ? `<div class="tl-score"><span class="s-lbl">期中 Mid</span><span class="s-val ${scoreColor(r.midterm)}">${r.midterm}</span></div>` : ''}
          ${r.final   != null ? `<div class="tl-score"><span class="s-lbl">期末 Final</span><span class="s-val ${scoreColor(r.final)}">${r.final}</span></div>` : ''}
          ${r.semester_score != null ? `<div class="tl-score"><span class="s-lbl">學期 Sem</span><span class="s-val ${scoreColor(r.semester_score)}">${r.semester_score}</span></div>` : ''}
          ${r.adjusted != null ? `<div class="tl-score"><span class="s-lbl">調整 Adj</span><span class="s-val" style="color:var(--accent3)">${r.adjusted}</span></div>` : ''}
          ${r.reading_pct != null ? `<div class="tl-score"><span class="s-lbl">閱讀% Read</span><span class="s-val">${r.reading_pct}%</span></div>` : ''}
        </div>
        ${r.exceptions.length ? `<div class="tl-tags">${r.exceptions.map(e =>
          `<span class="tag tag-${escapeHtml(e.color)}">${escapeHtml(e.tag)}</span>`).join('')}</div>` : ''}
      </div>
    `;
  });
  html += '</div>';

  html += `
    <div class="chart-card" style="margin-top:14px">
      <div class="chart-title" style="--accent-color:var(--accent)">
        <div class="dot"></div>成績軌跡 Score Trajectory
      </div>
      <div class="chart-wrap" style="height:180px">
        <canvas id="chartProfile"></canvas>
      </div>
    </div>
  `;

  wrap.innerHTML = html;

  const theory    = sorted.filter(r => r.type === 'theory');
  const practicum = sorted.filter(r => r.type === 'practicum');

  // BUG-3 FIX: x 軸以「學期+班別」為唯一鍵，theory 與 practicum 共用同一時間軸，
  // 避免同學期同班出現重複 label（theory 一條、practicum 一條均映射到同一 x 位置）。
  const labelKey = r => semLabel(r.semester) + ' ' + r.sheet_name;
  const allLabels = [...new Map(sorted.map(r => [labelKey(r), labelKey(r)])).values()];

  const datasets = [];
  if (theory.length > 0) {
    const theoryMap = new Map(theory.map(r => [labelKey(r), r.semester_score]));
    datasets.push({
      label: '正課 Theory',
      data: allLabels.map(lbl => theoryMap.has(lbl) ? theoryMap.get(lbl) : null),
      borderColor: '#4f8ef7', pointRadius: 5, tension: 0.3, fill: false,
      spanGaps: false,
    });
  }
  if (practicum.length > 0) {
    const practicumMap = new Map(practicum.map(r => [labelKey(r), r.semester_score]));
    datasets.push({
      label: '實驗 Practicum',
      data: allLabels.map(lbl => practicumMap.has(lbl) ? practicumMap.get(lbl) : null),
      borderColor: '#64d4a8', pointRadius: 5, tension: 0.3, fill: false,
      spanGaps: false,
    });
  }

  // BUG-4 FIX: 單點時在 labels 前後各補一個空字串 label，
  // 使 category scale 將資料點置中（layout.padding 對 category scale 無效）。
  const displayLabels = allLabels.length === 1
    ? ['', allLabels[0], '']
    : allLabels;
  const displayDatasets = allLabels.length === 1
    ? datasets.map(ds => ({
        ...ds,
        data: [null, ds.data[0], null],
      }))
    : datasets;

  mkChart('chartProfile', {
    type: 'line',
    data: { labels: displayLabels, datasets: displayDatasets },
    options: {
      ...CHART_DEFAULTS,
      scales: {
        x: {
          type: 'category',
          ticks: { color: '#6b748f', font: { size: 9 } },
          grid: { color: '#1c2030' },
          offset: true,
        },
        y: { ...CHART_DEFAULTS.scales.y, min: 0, max: 100 }
      }
    }
  });
}

// ══════════════════════════════════════════════════════════
// PANEL A — 新增圖表
// ══════════════════════════════════════════════════════════
function renderNormalOverlay(cls, sem, sheet, type = 'all') {
  if (!cls) return;
  const dist = cls.score_distribution;
  const n = cls.count || 1;
  const mu = cls.avg_semester || 70;
  const inclRetaker = getIncludeRetaker('A');
  const scores = [];
  Object.values(DATA.students).forEach(s => s.records.forEach(r => {
    if (!inclRetaker && r.is_retaker) return;
    if (recordMatchesClass(r, sem, sheet, type) &&
        r.semester_score != null) scores.push(r.semester_score);
  }));
  const sd = scores.length > 1
    ? Math.sqrt(scores.reduce((a,v)=>a+(v-mu)**2,0)/(scores.length-1))
    : 10;

  const labels = ['0–9','10–19','20–29','30–39','40–49','50–59','60–69','70–79','80–89','90–99','100'];
  const normal = labels.map((_,i) => {
    const x = i===10 ? 100 : i*10+5;
    return +(n * 10 * (1/(sd*Math.sqrt(2*Math.PI))) * Math.exp(-0.5*((x-mu)/sd)**2)).toFixed(2);
  });

  mkChart('chartNormalOverlay', {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: '實際人數', data: dist,
          backgroundColor: dist.map((_,i)=>i>=6?'rgba(100,212,168,0.55)':'rgba(240,112,112,0.45)'),
          borderColor: dist.map((_,i)=>i>=6?'#64d4a8':'#f07070'), borderWidth:1, borderRadius:3, order:2 },
        { label: '理論常態', data: normal, type:'line',
          borderColor:'rgba(200,200,220,0.7)', backgroundColor:'transparent',
          pointRadius:0, borderWidth:2, borderDash:[4,3], tension:0.4, order:1 }
      ]
    },
    options: {
      ...CHART_DEFAULTS,
      plugins: { ...CHART_DEFAULTS.plugins,
        legend:{ labels:{ color:'var(--text-dim)', font:{size:10} } } },
      scales: { ...CHART_DEFAULTS.scales, y:{ ...CHART_DEFAULTS.scales.y, beginAtZero:true } }
    }
  });
}

function renderRegression(sem, sheet, type = 'all') {
  const pts = [];
  const inclRetaker = getIncludeRetaker('A');
  Object.values(DATA.students).forEach(s => s.records.forEach(r => {
    if (!inclRetaker && r.is_retaker) return;
    if (recordMatchesClass(r, sem, sheet, type) && r.midterm!=null && r.final!=null)
      pts.push({ x: r.midterm, y: r.final, m: s.name_masked });
  }));
  if (pts.length < 3) { document.getElementById('aRsqLabel').textContent=''; return; }

  const n=pts.length, sx=pts.reduce((a,p)=>a+p.x,0), sy=pts.reduce((a,p)=>a+p.y,0);
  const sxy=pts.reduce((a,p)=>a+p.x*p.y,0), sxx=pts.reduce((a,p)=>a+p.x*p.x,0);
  const denom = n*sxx - sx*sx;
  if (denom === 0) {
    document.getElementById('aRsqLabel').textContent = 'R² = 無法計算（期中成績無差異）';
    mkChart('chartRegression', {
      type:'scatter', data:{ datasets:[{ label:'學生', data:pts,
        backgroundColor:'rgba(79,142,247,0.5)', pointRadius:4, pointHoverRadius:6 }]},
      options:{ ...CHART_DEFAULTS, plugins:{ ...CHART_DEFAULTS.plugins, legend:{display:false},
        tooltip:{ ...CHART_DEFAULTS.plugins.tooltip,
          callbacks:{ label:ctx=>`${ctx.raw.m}  期中:${ctx.raw.x} 期末:${ctx.raw.y}` }}},
        scales:{ x:{...CHART_DEFAULTS.scales.x,min:0,max:100}, y:{...CHART_DEFAULTS.scales.y,min:0,max:100} }
      }});
    return;
  }
  const slope=(n*sxy-sx*sy)/denom;
  const intc=(sy-slope*sx)/n;
  const ybar=sy/n;
  const sstot=pts.reduce((a,p)=>a+(p.y-ybar)**2,0);
  const ssres=pts.reduce((a,p)=>a+(p.y-(slope*p.x+intc))**2,0);
  const r2=sstot===0 ? 1 : Math.max(0,1-ssres/sstot);

  document.getElementById('aRsqLabel').textContent=`R² = ${r2.toFixed(3)}`;

  const xs=[0,100];
  const line=xs.map(x=>+( slope*x+intc ).toFixed(1));

  mkChart('chartRegression', {
    type:'scatter',
    data:{ datasets:[
      { label:'學生', data:pts,
        backgroundColor:'rgba(79,142,247,0.5)', pointRadius:4, pointHoverRadius:6, order:2 },
      { label:'迴歸線', data:xs.map((x,i)=>({x,y:line[i]})), type:'line',
        borderColor:'#f7a44f', backgroundColor:'transparent',
        pointRadius:0, borderWidth:2, tension:0, order:1 }
    ]},
    options:{ ...CHART_DEFAULTS,
      plugins:{ ...CHART_DEFAULTS.plugins,
        tooltip:{ ...CHART_DEFAULTS.plugins.tooltip,
          callbacks:{ label:ctx=>ctx.dataset.label==='學生'
            ? `${ctx.raw.m}  期中:${ctx.raw.x} 期末:${ctx.raw.y}`
            : `迴歸線` } } },
      scales:{
        x:{ ...CHART_DEFAULTS.scales.x, min:0, max:100, title:{display:true,text:'期中考',color:'var(--text-dim)'} },
        y:{ ...CHART_DEFAULTS.scales.y, min:0, max:100, title:{display:true,text:'期末考',color:'var(--text-dim)'} }
      }
    }
  });
}

function renderVarianceBar(sem, sheet) {
  const type = document.getElementById('aFilterType')?.value || 'all';
  const inclRetaker = getIncludeRetaker('A');
  const selectedCompare = updateCompareFilter(sem, sheet, type, inclRetaker);
  const candidates = availableCompareSems(sem, sheet, type, inclRetaker);
  const prevSem = selectedCompare !== 'auto' ? selectedCompare : candidates[0];
  const cur = getClassSummary(sem, sheet, type, inclRetaker);
  const prev = prevSem ? getClassSummary(prevSem, sheet, type, inclRetaker) : null;

  if (!cur || !prev) {
    mkChart('chartVariance', {
      type:'bar',
      data:{labels:['無可比較資料'],datasets:[{
        label:'No comparison data',
        data:[0],
        backgroundColor:['rgba(107,116,143,0.25)'],
        borderColor:['rgba(107,116,143,0.55)'],
        borderWidth:1,
        borderRadius:4
      }]},
      options:{...CHART_DEFAULTS,
        plugins:{...CHART_DEFAULTS.plugins,legend:{display:false},
          subtitle:{display:true,text:'目前班級沒有較早且同課別的同班資料',color:'var(--text-dim)',font:{size:10}}},
        scales:{
          x:{...CHART_DEFAULTS.scales.x},
          y:{...CHART_DEFAULTS.scales.y,min:0,max:1,ticks:{display:false},grid:{display:false}}
        }
      }
    });
    return;
  }

  const metrics = ['avg_midterm','avg_final','avg_semester','pass_rate'];
  const mLabels = ['期中均分','期末均分','學期均分','及格率×100'];
  const deltas  = metrics.map((m,i)=>{
    const c = cur[m]??0, p = prev[m]??0;
    return i===3 ? +((c-p)*100).toFixed(1) : +(c-p).toFixed(1);
  });
  const typeLabel = type === 'all' ? '全部課別' : (type === 'practicum' ? '實驗課' : '正課');

  mkChart('chartVariance',{
    type:'bar',
    data:{ labels:mLabels, datasets:[{
      label:`vs ${semLabel(prevSem)}`,
      data:deltas,
      backgroundColor:deltas.map(d=>d>=0?'rgba(100,212,168,0.65)':'rgba(240,112,112,0.55)'),
      borderColor:deltas.map(d=>d>=0?'#64d4a8':'#f07070'),
      borderWidth:1, borderRadius:4
    }]},
    options:{ ...CHART_DEFAULTS,
      plugins:{ ...CHART_DEFAULTS.plugins, legend:{display:false},
        subtitle:{display:true,text:`${semLabel(sem)} ${normalizeSheet(sheet)}（${typeLabel}） vs ${semLabel(prevSem)}`,color:'var(--text-dim)',font:{size:10}},
        tooltip:{...CHART_DEFAULTS.plugins.tooltip,
          callbacks:{label:ctx=>{
            const i = ctx.dataIndex;
            const metric = metrics[i];
            const curVal = metric === 'pass_rate' && cur[metric] != null ? (cur[metric]*100).toFixed(1) : cur[metric];
            const prevVal = metric === 'pass_rate' && prev[metric] != null ? (prev[metric]*100).toFixed(1) : prev[metric];
            return `${prevVal ?? '–'} → ${curVal ?? '–'}，Δ ${ctx.raw>=0?'+':''}${ctx.raw}`;
          }}} },
      scales:{
        x:{ ...CHART_DEFAULTS.scales.x },
        y:{ ...CHART_DEFAULTS.scales.y,
          title:{display:true,text:'相對比較基準變化量',color:'var(--text-dim)'} }
      }
    }
  });
}

// ══════════════════════════════════════════════════════════
// PANEL C — 新增圖表
// ══════════════════════════════════════════════════════════
function renderAnomalyDensity() {
  const sems = DATA.meta.semesters;
  const colorMap = { red:'重大違規', yellow:'學習態度異常', blue:'行政缺漏', gray:'特殊身份' };

  const countMap = {};
  Object.keys(colorMap).forEach(c => { countMap[c] = {}; });
  Object.values(DATA.students).forEach(s => {
    s.records.forEach(r => {
      r.exceptions.forEach(e => {
        if (countMap[e.color]) {
          countMap[e.color][r.semester] = (countMap[e.color][r.semester] || 0) + 1;
        }
      });
    });
  });

  const datasets = Object.entries(colorMap).map(([color, label]) => {
    const borderCol = {red:'#f07070',yellow:'#f0c85b',blue:'#5b8af0',gray:'#6b748f'}[color];
    return {
      label,
      data: sems.map(sem => countMap[color][sem] || 0),
      borderColor: borderCol,
      backgroundColor: borderCol+'33',
      fill: true, tension:0.3, pointRadius:4, spanGaps:true
    };
  });

  mkChart('chartAnomalyDensity',{
    type:'line',
    data:{ labels:sems.map(semLabel), datasets },
    options:{ ...CHART_DEFAULTS,
      plugins:{ ...CHART_DEFAULTS.plugins,
        legend:{labels:{color:'var(--text-dim)',font:{size:10}}},
        tooltip:{...CHART_DEFAULTS.plugins.tooltip,
          callbacks:{label:ctx=>`${ctx.dataset.label}：${ctx.raw} 人次`}} },
      scales:{ x:{...CHART_DEFAULTS.scales.x}, y:{...CHART_DEFAULTS.scales.y,beginAtZero:true,
        title:{display:true,text:'異常人次',color:'var(--text-dim)'}} }
    }
  });
}

function renderRetakerFirstDist() {
  const bins = Array(11).fill(0);
  Object.values(DATA.students).forEach(s=>{
    const retakerRecs = s.records.filter(r=>r.is_retaker);
    if (!retakerRecs.length) return;
    const sorted = [...retakerRecs].sort(compareClassRecords);
    const first = sorted[0].semester_score;
    if (first==null) return;
    const b = Math.min(Math.floor(first/10), 10);
    bins[b]++;
  });
  const labels=['0–9','10–19','20–29','30–39','40–49','50–59','60–69','70–79','80–89','90–99','100'];
  mkChart('chartRetakerFirstDist',{
    type:'bar',
    data:{ labels, datasets:[{
      label:'重修生人數', data:bins,
      backgroundColor:bins.map((_,i)=>i>=6?'rgba(224,108,140,0.5)':'rgba(240,112,112,0.65)'),
      borderColor:bins.map((_,i)=>i>=6?'#e06c8c':'#f07070'),
      borderWidth:1, borderRadius:3
    }]},
    options:{ ...CHART_DEFAULTS,
      plugins:{...CHART_DEFAULTS.plugins,legend:{display:false},
        tooltip:{...CHART_DEFAULTS.plugins.tooltip,
          callbacks:{label:ctx=>`${ctx.raw} 位重修生首修分數在此區間`}}},
      scales:{...CHART_DEFAULTS.scales, y:{...CHART_DEFAULTS.scales.y,beginAtZero:true}}
    }
  });
}

// ══════════════════════════════════════════════════════════
// PANEL B — 新增圖表
// ══════════════════════════════════════════════════════════
function renderDeltaByProgram(retakers) {
  const progDeltas = {};
  retakers.forEach(item => {
    item.recs.filter(r => r.delta != null).forEach(r => {
      const p = classifyProgram(r.sheet_name, r.semester);
      if (!progDeltas[p]) progDeltas[p] = [];
      progDeltas[p].push(r.delta);
    });
  });
  const progs = PROGRAM_ORDER.filter(p=>progDeltas[p]?.length);
  const avgs  = progs.map(p=>+(progDeltas[p].reduce((a,v)=>a+v,0)/progDeltas[p].length).toFixed(1));

  mkChart('chartDeltaByProgram',{
    type:'bar',
    data:{ labels:progs.map(p=>PROGRAM_LABELS[p]), datasets:[{
      label:'平均改善幅度 Δ',
      data:avgs,
      backgroundColor:avgs.map(v=>v>=0?'rgba(100,212,168,0.65)':'rgba(240,112,112,0.55)'),
      borderColor:avgs.map(v=>v>=0?'#64d4a8':'#f07070'),
      borderWidth:1, borderRadius:4
    }]},
    options:{ ...CHART_DEFAULTS,
      plugins:{...CHART_DEFAULTS.plugins,legend:{display:false},
        tooltip:{...CHART_DEFAULTS.plugins.tooltip,
          callbacks:{label:ctx=>`平均 Δ：${ctx.raw>=0?'+':''}${ctx.raw} 分（${progDeltas[progs[ctx.dataIndex]]?.length}人）`}}},
      scales:{ x:{...CHART_DEFAULTS.scales.x},
        y:{...CHART_DEFAULTS.scales.y, title:{display:true,text:'平均 Δ（分）',color:'var(--text-dim)'}} }
    }
  });
}

function renderRetakeCount(type) {
  const countDist = {};
  Object.values(DATA.students).forEach(s=>{
    const recs = s.records.filter(r=>r.is_retaker && r.type===type);
    if (!recs.length) return;
    const bySheet = {};
    recs.forEach(r=>{ bySheet[r.sheet_name]=(bySheet[r.sheet_name]||0)+1; });
    Object.values(bySheet).forEach(cnt=>{ countDist[cnt]=(countDist[cnt]||0)+1; });
  });
  const maxC = Math.max(...Object.keys(countDist).map(Number), 1);
  const labels=[], data=[];
  for(let i=1;i<=maxC;i++){
    labels.push(`重修第${i}次`);
    data.push(countDist[i]||0);
  }
  mkChart('chartRetakeCount',{
    type:'bar',
    data:{ labels, datasets:[{
      label:'學生人數', data,
      backgroundColor:data.map((_,i)=>i===0?'rgba(79,142,247,0.5)':'rgba(247,164,79,0.65)'),
      borderColor:data.map((_,i)=>i===0?'#4f8ef7':'#f7a44f'),
      borderWidth:1, borderRadius:4
    }]},
    options:{ ...CHART_DEFAULTS,
      plugins:{...CHART_DEFAULTS.plugins,legend:{display:false}},
      scales:{...CHART_DEFAULTS.scales,y:{...CHART_DEFAULTS.scales.y,beginAtZero:true}}
    }
  });
}

function renderFirstVsDelta() {
  const type = document.getElementById('bFilterType').value;
  const pts=[];
  Object.values(DATA.students).forEach(s=>{
    const recs=[...s.records.filter(r=>r.is_retaker&&r.type===type)].sort(compareClassRecords);
    if(recs.length<2) return;
    const first=recs[0].semester_score;
    recs.slice(1).forEach(r=>{ if(r.delta!=null&&first!=null) pts.push({x:first,y:r.delta,m:s.name_masked}); });
  });
  mkChart('chartFirstVsDelta',{
    type:'scatter',
    data:{ datasets:[{
      label:'重修生',
      data:pts,
      backgroundColor:pts.map(p=>p.y>=0?'rgba(100,212,168,0.6)':'rgba(240,112,112,0.55)'),
      pointRadius:5, pointHoverRadius:7
    }]},
    options:{ ...CHART_DEFAULTS,
      plugins:{...CHART_DEFAULTS.plugins,legend:{display:false},
        tooltip:{...CHART_DEFAULTS.plugins.tooltip,
          callbacks:{label:ctx=>`${ctx.raw.m}  首修:${ctx.raw.x}  Δ:${ctx.raw.y>=0?'+':''}${ctx.raw.y}`}}},
      scales:{
        x:{...CHART_DEFAULTS.scales.x,min:0,max:100,title:{display:true,text:'首修學期成績',color:'var(--text-dim)'}},
        y:{...CHART_DEFAULTS.scales.y,title:{display:true,text:'重修改善幅度 Δ',color:'var(--text-dim)'}}
      }
    }
  });
}

// ══════════════════════════════════════════════════════════
// PANEL D — 新增圖表
// ══════════════════════════════════════════════════════════
function renderHeatmap(filtered) {
  const wrap = document.getElementById('heatmapWrap');
  const sems  = getDSemList();

  function mergeWeightedAvg(a, aw, b, bw) {
    if (a == null) return b ?? null;
    if (b == null) return a;
    const wa = aw || 1, wb = bw || 1;
    return +(((a * wa) + (b * wb)) / (wa + wb)).toFixed(2);
  }

  const cellMap = new Map();
  filtered.forEach(c => {
    const cls = normalizeSheet(c.sheet_name);
    if (!cls) return;
    const key = `${c.semester}__${cls}`;
    const rec = { ...c, sheet_name: cls };
    const prev = cellMap.get(key);
    if (!prev) {
      cellMap.set(key, rec);
      return;
    }

    const prevCount = Number(prev.count) || 0;
    const nextCount = Number(rec.count) || 0;
    ['avg_midterm', 'avg_final', 'avg_semester'].forEach(field => {
      prev[field] = mergeWeightedAvg(prev[field], prevCount, rec[field], nextCount);
    });
    prev.pass_rate = mergeWeightedAvg(prev.pass_rate, prevCount, rec.pass_rate, nextCount);
    prev.count = prevCount + nextCount || prev.count || rec.count;
  });

  const heatRows = [...cellMap.values()];
  const classes = sortSheetNames([...new Set(heatRows.map(c=>c.sheet_name))]);
  if (!classes.length) { wrap.innerHTML='<div class="empty-state">無資料</div>'; return; }

  const isDark = !document.body.classList.contains('light');
  const cellW=56, cellH=32, labelW=90, headerH=30;
  const W=labelW+sems.length*cellW, H=headerH+classes.length*cellH;

  const vals=heatRows.map(c=>c.avg_semester).filter(v=>v!=null);
  const minV=vals.length ? Math.min(...vals) : 0, maxV=vals.length ? Math.max(...vals) : 100;
  const lerp=(v,mn,mx)=>mx===mn?0.5:(v-mn)/(mx-mn);

  function scoreColor(v) {
    if(v==null) return isDark?'#1c2030':'#e0e4f0';
    const t=lerp(v,minV,maxV);
    const r=Math.round(220*(1-t)+40*t), g=Math.round(80*(1-t)+200*t), b=Math.round(80*(1-t)+100*t);
    return `rgb(${r},${g},${b})`;
  }
  const textCol=isDark?'#dde3f5':'#1a1d2e';
  const dimCol='#6b748f';
  const bgCol=isDark?'#13161f':'#ffffff';

  let svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" style="display:block">`;
  svg+=`<rect width="${W}" height="${H}" fill="${bgCol}" rx="8"/>`;
  sems.forEach((s,i)=>{
    svg+=`<text x="${labelW+i*cellW+cellW/2}" y="${headerH-8}" text-anchor="middle" fill="${dimCol}" font-size="9" font-family="monospace">${safeSvgAttr(semLabel(s))}</text>`;
  });
  classes.forEach((cls,ri)=>{
    const y=headerH+ri*cellH;
    svg+=`<text x="${labelW-6}" y="${y+cellH/2+4}" text-anchor="end" fill="${textCol}" font-size="10" font-family="sans-serif">${safeSvgAttr(cls)}</text>`;
    sems.forEach((sem,ci)=>{
      const rec=cellMap.get(`${sem}__${cls}`);
      const v=rec?.avg_semester;
      const fill=scoreColor(v);
      const lum=v!=null?lerp(v,minV,maxV):0.5;
      const txtFill=lum>0.5?'#0a0c14':'#f0f4ff';
      const tipData = v!=null
        ? `data-svgtip="1" data-cls="${safeSvgAttr(cls)}" data-sem="${safeSvgAttr(sem)}" data-avg="${v.toFixed(1)}" data-pass="${rec.pass_rate!=null?(rec.pass_rate*100).toFixed(1)+'%':'–'}" data-n="${rec.count}"`
        : `data-svgtip="1" data-cls="${safeSvgAttr(cls)}" data-sem="${safeSvgAttr(sem)}" data-avg="無資料"`;
      svg+=`<rect ${tipData} x="${labelW+ci*cellW+1}" y="${y+1}" width="${cellW-2}" height="${cellH-2}" fill="${fill}" rx="3" style="cursor:crosshair"/>`;
      if(v!=null) svg+=`<text pointer-events="none" x="${labelW+ci*cellW+cellW/2}" y="${y+cellH/2+4}" text-anchor="middle" fill="${txtFill}" font-size="10" font-weight="600" font-family="monospace">${v.toFixed(1)}</text>`;
    });
  });
  svg+=`</svg>`;
  wrap.innerHTML=svg;

  const svgEl = wrap.querySelector('svg');
  addSvgTooltip(svgEl, '[data-svgtip]', el => {
    const avg = el.dataset.avg;
    if (avg === '無資料') return `<b>${el.dataset.cls}</b>\n${semLabel(el.dataset.sem)}\n無資料`;
    return `<b>${el.dataset.cls}</b>\n${semLabel(el.dataset.sem)}\n學期均分：<b>${avg}</b>\n及格率：${el.dataset.pass}\n人數：${el.dataset.n}`;
  });
}

function renderBoxPlot(allClasses, filterProg) {
  const wrap=document.getElementById('boxplotWrap');
  const programs = filterProg === 'all'
    ? PROGRAM_ORDER
    : PROGRAM_ORDER.filter(p => p === filterProg);

  const progScores={};
  programs.forEach(p=>progScores[p]=[]);
  allClasses.forEach(c => {
    if (!programs.includes(c.program)) return;
    if (c.avg_semester == null) return;
    progScores[c.program].push(c.avg_semester);
  });

  const isDark=!document.body.classList.contains('light');
  const W=Math.max(300,programs.length*90+60), H=240;
  const pad={l:40,r:10,t:10,b:50}, innerH=H-pad.t-pad.b, innerW=W-pad.l-pad.r;
  const scaleY=v=>pad.t+innerH*(1-(v/100));
  const textCol=isDark?'#9aa0b8':'#4a5070';
  const bgCol=isDark?'#13161f':'#ffffff';
  const gridCol=isDark?'#242840':'#e0e4f0';

  let svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" style="display:block;min-width:${W}px">`;
  svg+=`<rect width="${W}" height="${H}" fill="${bgCol}" rx="8"/>`;

  [0,25,50,60,75,100].forEach(v=>{
    const y=scaleY(v);
    svg+=`<line x1="${pad.l}" y1="${y}" x2="${W-pad.r}" y2="${y}" stroke="${gridCol}" stroke-width="${v===60?1.5:0.5}" stroke-dasharray="${v===60?'4 3':''}"/>`;
    svg+=`<text x="${pad.l-4}" y="${y+4}" text-anchor="end" fill="${textCol}" font-size="9" font-family="monospace">${v}</text>`;
  });

  programs.forEach((p,i)=>{
    const scores=progScores[p].sort((a,b)=>a-b);
    if(scores.length<4) return;
    const x=pad.l+(i+0.5)*(innerW/programs.length);
    const bw=Math.min(30,(innerW/programs.length)*0.5);
    const q1=scores[Math.floor(scores.length*0.25)];
    const med=scores[Math.floor(scores.length*0.5)];
    const q3=scores[Math.floor(scores.length*0.75)];
    const iqr=q3-q1;
    const lo=Math.max(scores[0],q1-1.5*iqr);
    const hi=Math.min(scores[scores.length-1],q3+1.5*iqr);
    const col=PROGRAM_COLORS[p];
    const outliers=scores.filter(v=>v<lo||v>hi);
    const avg=+(scores.reduce((a,v)=>a+v,0)/scores.length).toFixed(1);

    const tipAttr=`data-svgtip="1" data-prog="${PROGRAM_LABELS[p]}" data-n="${scores.length}" data-med="${med.toFixed(1)}" data-q1="${q1.toFixed(1)}" data-q3="${q3.toFixed(1)}" data-lo="${lo.toFixed(1)}" data-hi="${hi.toFixed(1)}" data-avg="${avg}" data-out="${outliers.length}"`;

    svg+=`<line x1="${x}" y1="${scaleY(lo)}" x2="${x}" y2="${scaleY(q1)}" stroke="${col}" stroke-width="1.5"/>`;
    svg+=`<line x1="${x}" y1="${scaleY(q3)}" x2="${x}" y2="${scaleY(hi)}" stroke="${col}" stroke-width="1.5"/>`;
    svg+=`<line x1="${x-bw/3}" y1="${scaleY(lo)}" x2="${x+bw/3}" y2="${scaleY(lo)}" stroke="${col}" stroke-width="1.5"/>`;
    svg+=`<line x1="${x-bw/3}" y1="${scaleY(hi)}" x2="${x+bw/3}" y2="${scaleY(hi)}" stroke="${col}" stroke-width="1.5"/>`;
    svg+=`<rect ${tipAttr} x="${x-bw/2}" y="${scaleY(q3)}" width="${bw}" height="${scaleY(q1)-scaleY(q3)}" fill="${col}33" stroke="${col}" stroke-width="1.5" rx="2" style="cursor:crosshair"/>`;
    svg+=`<line x1="${x-bw/2}" y1="${scaleY(med)}" x2="${x+bw/2}" y2="${scaleY(med)}" stroke="${col}" stroke-width="2.5"/>`;
    outliers.forEach(v=>{
      svg+=`<circle ${tipAttr} cx="${x}" cy="${scaleY(v)}" r="4" fill="${col}" opacity="0.5" style="cursor:crosshair"/>`;
    });
    svg+=`<text x="${x}" y="${H-pad.b+14}" text-anchor="middle" fill="${textCol}" font-size="9" font-family="sans-serif">${PROGRAM_LABELS[p].slice(0,4)}</text>`;
    svg+=`<text x="${x}" y="${H-pad.b+24}" text-anchor="middle" fill="${textCol}" font-size="8" font-family="monospace" opacity="0.7">n=${scores.length}</text>`;
  });
  svg+=`</svg>`;
  wrap.innerHTML=svg;

  const svgEl=wrap.querySelector('svg');
  addSvgTooltip(svgEl,'[data-svgtip]', el=>{
    const d=el.dataset;
    return `<b>${d.prog}</b>（n=${d.n}）\n中位數：<b>${d.med}</b>\nQ1：${d.q1}　Q3：${d.q3}\nIQR：${(d.q3-d.q1).toFixed(1)}\n最小值：${d.lo}　最大值：${d.hi}\n平均值：${d.avg}\n離群值：${d.out} 個`;
  });
}

function renderCorrelation(filtered) {
  const pts = filtered.filter(c => c.count && c.pass_rate != null).map(c => ({
    x: c.count, y: +(c.pass_rate * 100).toFixed(1),
    prog: c.program, sem: c.semester, cls: c.sheet_name
  }));

  const regData = DATA?.meta?.count_passrate_regression;  // schema 3.0: 巢狀結構
  const optData = DATA?.meta?.optimal_enrollment;         // schema 3.0: 各學制建議人數

  // 全體合併回歸線（橘色虛線）
  const regAll    = regData?.all;
  const hasRegAll = regAll?.available === true;
  const rLabelAll = hasRegAll
    ? `全體回歸線  r=${regAll.r}  y=${regAll.slope}x${regAll.intercept >= 0 ? '+' : ''}${regAll.intercept}`
    : '';

  const rDatasetAll = hasRegAll ? [{
    label:       rLabelAll,
    data:        regAll.line,
    type:        'line',
    borderColor: 'rgba(247,164,79,0.85)',
    borderWidth: 2,
    borderDash:  [5, 4],
    pointRadius: 0,
    fill:        false,
    tension:     0,
    _progKey:    'all',   // 供 tooltip 識別
  }] : [];

  // 各學制回歸線（依 PROGRAM_COLORS，細實線）
  const programs = [...new Set(pts.map(p => p.prog))];
  const rDatasetByProg = programs.flatMap(prog => {
    const reg = regData?.[prog];
    if (!reg?.available) return [];
    const col   = PROGRAM_COLORS[prog] ?? 'rgba(180,180,180,0.7)';
    const label = reg.label ?? PROGRAM_LABELS[prog] ?? prog;
    return [{
      label:       `${label}  r=${reg.r}`,
      data:        reg.line,
      type:        'line',
      borderColor: col,
      borderWidth: 1.5,
      borderDash:  [3, 3],
      pointRadius: 0,
      fill:        false,
      tension:     0,
      _progKey:    prog,  // 供 tooltip 識別
    }];
  });

  const hasAnyReg = hasRegAll || rDatasetByProg.length > 0;

  mkChart('chartCorrelation', {
    type: 'scatter',
    data: {
      datasets: [
        {
          label:           '班次',
          data:            pts,
          backgroundColor: pts.map(p => PROGRAM_COLORS[p.prog] + '88'),
          pointRadius:     5,
          pointHoverRadius:7,
        },
        ...rDatasetAll,
        ...rDatasetByProg,
      ]
    },
    options: { ...CHART_DEFAULTS,
      plugins: { ...CHART_DEFAULTS.plugins,
        legend: {
          display:  hasAnyReg,
          position: 'bottom',
          labels:   { color: 'var(--text,#dde3f5)', font: { size: 11 } },
        },
        tooltip: { ...CHART_DEFAULTS.plugins.tooltip,
          callbacks: {
            label: ctx => {
              // 散佈點：顯示班級資訊
              if (ctx.dataset.type !== 'line') {
                return `${ctx.raw.cls} ${semLabel(ctx.raw.sem)}  人數:${ctx.raw.x} 及格率:${ctx.raw.y}%`;
              }
              // 回歸線：顯示建議人數資訊（方案 2）
              const progKey = ctx.dataset._progKey;
              const opt = optData?.[progKey];
              if (!opt?.available) return null;
              const rangeNote = opt.in_range ? '' : `（觀測範圍外，夾緊至 ${opt.optimal_count_clamped} 人）`;
              return [
                `建議人數：${opt.optimal_count_clamped} 人${rangeNote}`,
                `預期及格率：${opt.optimal_passrate}%`,
                `觀測範圍：${opt.x_min}–${opt.x_max} 人（${opt.n} 筆）`,
              ];
            },
            title: ctx => {
              // 回歸線才顯示學制名稱；散佈點不顯示 title
              const ds = ctx[0]?.dataset;
              if (!ds || ds.type !== 'line') return '';
              const progKey = ds._progKey;
              const opt = optData?.[progKey];
              return opt?.label ?? ds.label ?? '';
            },
          }
        },
      },
      scales: {
        x: { ...CHART_DEFAULTS.scales.x, title: { display: true, text: '班級人數',  color: 'var(--text-dim)' } },
        y: { ...CHART_DEFAULTS.scales.y, min: 0, max: 100, title: { display: true, text: '及格率 %', color: 'var(--text-dim)' } },
      },
    },
  });

  // 方案 1：圖表下方摘要表格
  _renderEnrollmentSummary(programs, optData);
}

/**
 * 在 #enrollmentSummary 容器渲染建議人數摘要表格。
 * 顯示當前篩選有資料的學制 + 全體合併（all）。
 * available=false 的學制也顯示，說明原因。
 */
function _renderEnrollmentSummary(programs, optData) {
  const el = document.getElementById('enrollmentSummary');
  if (!el || !optData) return;

  // 顯示順序：全體合併優先，其餘依 PROGRAM_ORDER（WARN-2 修正）
  const keys = ['all', ...programs].filter((k, i, arr) => arr.indexOf(k) === i);

  const reasonText = {
    no_maximum:        '人數分布呈 U 型，無最大值',
    insufficient_data: '資料點不足（< 3 筆）',
    singular_matrix:   '資料共線，無法計算',
    linear:            '回歸退化為線性，無最大值',
  };

  // WARN-2 修正：依 PROGRAM_ORDER 排序，確保表格顯示順序一致
  const SUMMARY_ORDER = ['all', ...PROGRAM_ORDER];
  const sortedKeys = SUMMARY_ORDER.filter(k => keys.includes(k));
  // 補上 PROGRAM_ORDER 未涵蓋的 key（如未來新學制）
  keys.forEach(k => { if (!sortedKeys.includes(k)) sortedKeys.push(k); });

  const rows = sortedKeys.map(key => {
    const opt = optData[key];
    if (!opt) return '';
    // BUG-1 修正：label 套 escapeHtml 防禦
    const label = escapeHtml(opt.label ?? key);
    const color = key === 'all'
      ? 'rgba(247,164,79,0.9)'
      : (PROGRAM_COLORS[key] ?? 'var(--text-dim)');

    if (opt.available) {
      const clamped  = opt.in_range ? '' :
        `<span style="color:var(--text-dim);font-size:10px"> →夾緊至 ${opt.optimal_count_clamped} 人</span>`;
      const inRange  = opt.in_range
        ? '<span style="color:#64d4a8">✓</span>'
        : '<span style="color:#f0c85b">⚠</span>';
      return `<tr>
        <td><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${color};margin-right:6px"></span>${label}</td>
        <td style="text-align:center">${opt.optimal_count_clamped} 人${clamped}</td>
        <td style="text-align:center">${opt.optimal_passrate}%</td>
        <td style="text-align:center">${opt.n} 筆</td>
        <td style="text-align:center">${opt.x_min}–${opt.x_max}</td>
        <td style="text-align:center">${inRange}</td>
      </tr>`;
    } else {
      // BUG-2 修正：reason fallback 套 escapeHtml
      const reason = reasonText[opt.reason] ?? escapeHtml(opt.reason ?? '–');
      return `<tr style="opacity:0.55">
        <td><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${color};margin-right:6px"></span>${label}</td>
        <td colspan="4" style="color:var(--text-dim);font-style:italic">⚠ ${reason}</td>
        <td style="text-align:center">${opt.n ?? '–'} 筆</td>
      </tr>`;
    }
  }).join('');

  el.innerHTML = rows
    ? `<table class="enrollment-summary-table">
        <thead><tr>
          <th>學制</th>
          <th>建議人數</th>
          <th>預期及格率</th>
          <th>資料點</th>
          <th>觀測範圍</th>
          <th>在範圍內</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>`
    : '';
}

// ══════════════════════════════════════════════════════════
// TAB SWITCH
// ══════════════════════════════════════════════════════════
function switchTab(tab) {
  closeExpandedChart();
  const TAB_ORDER = ['D','A','C','L','R','P'];
  document.querySelectorAll('.tab').forEach((t, i) => {
    const isActive = TAB_ORDER[i] === tab;
    t.classList.toggle('active', isActive);
    t.setAttribute('aria-selected', isActive ? 'true' : 'false');
  });
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  const panel = document.getElementById('panel' + tab);
  if (panel) panel.classList.add('active');
  if (tab === 'A') renderA();
  if (tab === 'C') { initCPanel(); }
  if (tab === 'D') renderD();
  if (tab === 'L') {
    BehaviorTabManager.lazyInit();
    requestAnimationFrame(() => {
      ['radarChart','weeklyQuizChart','preExamChart','timeSlotChart','hourlyLineChart','scatterChart'].forEach(id => {
        const canvas = document.getElementById(id);
        if (!canvas) return;
        const inst = Chart.getChart(canvas);
        if (inst) { inst.resize(); inst.update('none'); }
      });
    });
  }
  if (tab === 'R') { AtRiskReportManager.lazyInit(); }
  if (tab === 'P') renderPrintPanel();
  requestAnimationFrame(() => {
    attachInfoButtons();
    attachChartExpandButtons();
  });
}

// ══════════════════════════════════════════════════════════
// 深/淺色模式切換
// ══════════════════════════════════════════════════════════
function updateSubjectDisplay() {
  const subj = document.getElementById('subjectInput')?.textContent?.trim();
  const badge = document.getElementById('yearRangeBadge');
  if (badge && subj) {
    badge.title = '科目：' + subj;
  }
}

async function autoFillSubjectFromBehavior() {
  const input = document.getElementById('subjectInput');
  if (!input) return;

  let courseName = null;

  if (!courseName && window.BEHAVIOR_SUMMARY?.course_name) {
    courseName = window.BEHAVIOR_SUMMARY.course_name;
  }
  if (!courseName && typeof BehaviorRadarTab !== 'undefined' && BehaviorRadarTab._meta?.course_name) {
    courseName = BehaviorRadarTab._meta.course_name;
  }
  if (!courseName) {
    try {
      const r = await fetch('data/behavior.json', { cache: 'no-cache' });
      if (r.ok) {
        const j = await r.json();
        courseName = j.meta?.course_name ?? j.course_name ?? j.courseName ?? null;
      }
    } catch (_) { }
  }

  if (courseName) {
    input.textContent = courseName;
    updateSubjectDisplay();
  }
}

function toggleMetaInfo() {
  const header = document.querySelector('header');
  const btn = document.getElementById('metaToggle');
  const open = header?.classList.toggle('meta-open');
  if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function toggleTheme() {
  const isLight = document.body.classList.toggle('light');
  document.getElementById('themeToggle').textContent = isLight ? '🌞' : '🌙';
  localStorage.setItem('la-theme', isLight ? 'light' : 'dark');
  refreshChartDefaults();
  if (!DATA) return;
  const activeTab = document.querySelector('.tab.active');
  if (activeTab) {
    const tabs = [...document.querySelectorAll('.tab')];
    const tabId = ['D','A','C','L','R','P'][tabs.indexOf(activeTab)];
    if (tabId === 'A') { renderA(); renderTrend(); }
    if (tabId === 'C') renderCView();
    if (tabId === 'D') renderD();
    if (tabId === 'P') renderPrintPanel();
    if (tabId === 'R' && typeof AtRiskReportManager !== 'undefined' && AtRiskReportManager.reRenderRadar) {
      AtRiskReportManager.reRenderRadar();
    }
    requestAnimationFrame(() => {
      attachInfoButtons();
      attachChartExpandButtons();
    });
  }
}

// 初始化主題
(function() {
  const saved = localStorage.getItem('la-theme');
  if (saved === 'light') {
    document.body.classList.add('light');
    const btn = document.getElementById('themeToggle');
    if (btn) btn.textContent = '🌞';
  }
  refreshChartDefaults();
})();

// ══════════════════════════════════════════════════════════
// 學制分類器
// ══════════════════════════════════════════════════════════
function classifyProgram(sheetName, semester) {
  return classInfo(sheetName, semester).program;
}

// ══════════════════════════════════════════════════════════
// PANEL D — 跨屆比較
// ══════════════════════════════════════════════════════════
function setDView(v) {
  dView = v;
  document.getElementById('dViewMerge').classList.toggle('active', v === 'merge');
  document.getElementById('dViewClass').classList.toggle('active', v === 'class');
  renderD();
}

function setDType(t) {
  dType = t;
  document.getElementById('dTypeTheory').classList.toggle('active', t === 'theory');
  document.getElementById('dTypePracticum').classList.toggle('active', t === 'practicum');
  const noMidFin = t === 'practicum';
  ['dMetricMid', 'dMetricFin'].forEach(id => {
    const btn = document.getElementById(id);
    if (btn) {
      btn.disabled = noMidFin;
      btn.style.opacity = noMidFin ? '0.35' : '1';
      btn.style.cursor = noMidFin ? 'not-allowed' : 'pointer';
      btn.title = noMidFin ? '實驗課不支援期中／期末成績' : '';
    }
  });
  if (noMidFin && dMetric !== 'semester_score') {
    setDMetric('semester_score');
    return;
  }
  renderD();
}

function setDMetric(m) {
  dMetric = m;
  ['semester_score','midterm','final'].forEach(k => {
    const map = { semester_score:'dMetricSem', midterm:'dMetricMid', final:'dMetricFin' };
    document.getElementById(map[k]).classList.toggle('active', k === m);
  });
  renderD();
}

function metricLabel(m) {
  return { semester_score:'學期成績', midterm:'期中考', final:'期末考' }[m] || m;
}

function metricField(m) {
  return { semester_score:'avg_semester', midterm:'avg_midterm', final:'avg_final' }[m] || m;
}

// ══════════════════════════════════════════════════════════
// PHASE 6 — 全域 UX
// ══════════════════════════════════════════════════════════
const _retakerState = { A: true, D: true, C: true };

function toggleRetakerSwitch(panel) {
  const btn = document.getElementById(`${panel.toLowerCase()}RetakerSwitch`);
  const progEl = document.getElementById(
    panel === 'A' ? 'aFilterProgram' :
    panel === 'D' ? 'dFilterProgram' : 'cFilterProgram'
  );
  const prog = progEl?.value || 'all';

  if (typeof FilterEngine !== 'undefined' && FilterEngine.isRetakerSwitchLocked(prog)) {
    return;
  }

  _retakerState[panel] = !_retakerState[panel];
  _syncRetakerBtn(panel);

  if (panel === 'A') renderA();
  else if (panel === 'D') renderD();
  else if (panel === 'C') renderCView();
}

function _syncRetakerBtn(panel) {
  const btn = document.getElementById(`${panel.toLowerCase()}RetakerSwitch`);
  if (!btn) return;
  const included = _retakerState[panel];
  btn.className = 'retaker-switch' + (included ? ' active' : '');
  btn.textContent = included ? '👤 包含重修生' : '👤 排除重修生';

  const progEl = document.getElementById(
    panel === 'A' ? 'aFilterProgram' :
    panel === 'D' ? 'dFilterProgram' : 'cFilterProgram'
  );
  const prog = progEl?.value || 'all';
  const locked = typeof FilterEngine !== 'undefined'
    ? FilterEngine.isRetakerSwitchLocked(prog)
    : false;
  if (locked) {
    _retakerState[panel] = true;
    btn.classList.add('locked');
    btn.title = '學制選為「重修生」時，必須包含重修生';
  } else {
    btn.classList.remove('locked');
    btn.title = '切換是否包含重修生資料';
  }
}

function getIncludeRetaker(panel) {
  return _retakerState[panel] !== false;
}

// ── 篩選器收合/展開 ───────────────────────────────────────
const _filterCollapsed = { A: false, D: false, C: false };

function toggleFilterCollapse(panel) {
  _filterCollapsed[panel] = !_filterCollapsed[panel];
  _applyFilterCollapse(panel);
}

function _applyFilterCollapse(panel) {
  const collapsed = _filterCollapsed[panel];
  const collapseBar = document.getElementById(`${panel.toLowerCase()}CollapseBar`);
  const summaryEl   = document.getElementById(`${panel.toLowerCase()}CollapseSummary`);

  const panelEl = document.getElementById(`panel${panel}`);
  if (!panelEl) return;

  const filterBars = panelEl.querySelectorAll('.filter-bar');
  filterBars.forEach(bar => {
    bar.classList.toggle('collapsed', collapsed);
  });

  if (collapseBar) {
    collapseBar.style.display = collapsed ? 'flex' : 'none';
    const icon = collapseBar.querySelector('.collapse-icon');
    if (icon) icon.textContent = collapsed ? '▶' : '▼';
  }

  if (summaryEl && collapsed) {
    summaryEl.textContent = _buildPanelSummary(panel);
  }
}

function _buildPanelSummary(panel) {
  const parts = [];
  if (panel === 'A' || panel === 'D') {
    const semEl  = panel === 'A' ? document.getElementById('aFilterSem') : null;
    const progEl = document.getElementById(panel === 'A' ? 'aFilterProgram' : 'dFilterProgram');
    const typeEl = panel === 'A' ? document.getElementById('aFilterType') : null;
    if (semEl?.value  && semEl.value  !== 'all') parts.push(semLabel(semEl.value));
    if (progEl?.value && progEl.value !== 'all') parts.push(PROGRAM_LABELS[progEl.value] || progEl.value);
    if (typeEl?.value && typeEl.value !== 'all') parts.push(typeEl.value === 'theory' ? '正課' : '實驗課');
    if (panel === 'D' && dSemMode === 'range') {
      const sems = DATA?.meta?.semesters || [];
      if (sems.length) parts.unshift(`${semLabel(sems[dSemRange[0]])}–${semLabel(sems[dSemRange[1]])}`);
    }
  } else if (panel === 'C') {
    const semEl  = document.getElementById('cFilterSem');
    const progEl = document.getElementById('cFilterProgram');
    if (semEl?.value  && semEl.value  !== 'all') parts.push(semLabel(semEl.value));
    if (progEl?.value && progEl.value !== 'all') parts.push(PROGRAM_LABELS[progEl.value] || progEl.value);
    if (cCurrentType !== 'all') parts.push(cCurrentType === 'theory' ? '正課' : '實驗課');
    if (cCurrentPass !== 'all') parts.push(cCurrentPass === 'pass' ? '及格' : '不及格');
  }
  if (!getIncludeRetaker(panel)) parts.push('排除重修生');
  return parts.length ? parts.join(' · ') : '全部條件';
}

function updateFilterSummary(panel) {
  if (!_filterCollapsed[panel]) return;
  const summaryEl = document.getElementById(`${panel.toLowerCase()}CollapseSummary`);
  if (summaryEl) summaryEl.textContent = _buildPanelSummary(panel);
}

// ══════════════════════════════════════════════════════════
// PANEL D — 學期雙模選擇器
// ══════════════════════════════════════════════════════════
function initDSemFilter() {
  if (!DATA) return;
  const sems = DATA.meta.semesters;
  const maxIdx = sems.length - 1;

  document.getElementById('dSemStart').max = maxIdx;
  document.getElementById('dSemEnd').max   = maxIdx;
  document.getElementById('dSemStart').value = 0;
  document.getElementById('dSemEnd').value   = maxIdx;
  dSemRange = [0, maxIdx];

  const wrap = document.getElementById('dSemMultiWrap');
  wrap.innerHTML = sems.map(s => `
    <button class="sem-capsule" data-sem="${escapeHtml(s)}"
            data-action="toggleDSemCapsule"
            style="padding:3px 10px;border-radius:14px;border:1px solid var(--border2);
                   background:var(--surface2);color:var(--text-dim);font-size:10px;
                   font-family:'JetBrains Mono',monospace;cursor:pointer;transition:all 0.15s">
      ${escapeHtml(semLabel(s))}
    </button>`).join('');

  _updateDSemRangeLabel();
}

function setDSemMode(mode) {
  dSemMode = mode;
  document.getElementById('dSemModeRange').classList.toggle('active', mode === 'range');
  document.getElementById('dSemModeMulti').classList.toggle('active', mode === 'multi');
  document.getElementById('dSemRangeWrap').style.display  = mode === 'range' ? 'flex'   : 'none';
  document.getElementById('dSemMultiWrap').style.display  = mode === 'multi' ? 'flex'   : 'none';
  document.getElementById('dSemMultiCount').style.display = mode === 'multi' ? 'inline' : 'none';

  if (mode === 'multi' && dSemSelected.size === 0 && DATA) {
    const sems = DATA.meta.semesters;
    sems.slice(-3).forEach(s => dSemSelected.add(s));
    _syncCapsuleStyles();
  }

  const hint = document.getElementById('dModeHint');
  if (mode === 'multi') {
    hint.innerHTML = '📊 <strong style="color:var(--accent)">多選模式</strong> — 點選學期膠囊（最多 5 個）進行並排長條圖比較。';
  } else {
    hint.innerHTML = '📈 <strong style="color:var(--accent)">範圍模式</strong> — 顯示連續趨勢折線；超過 6 個學制時自動合併為總平均。';
  }

  document.getElementById('dProgramBarWrap').style.display = mode === 'multi' ? 'block' : 'none';
  document.getElementById('dPassRateWrap').style.display   = mode === 'range' ? 'block' : 'none';

  renderD();
}

function onDSemRangeChange(event) {
  let start = parseInt(document.getElementById('dSemStart').value, 10);
  let end   = parseInt(document.getElementById('dSemEnd').value, 10);
  if (start > end) {
    const src = event?.target?.id;
    if (src === 'dSemStart') { start = end; document.getElementById('dSemStart').value = start; }
    else { end = start; document.getElementById('dSemEnd').value = end; }
  }
  dSemRange = [start, end];
  _updateDSemRangeLabel();
  renderD();
}

function toggleDSemCapsule(btn) {
  const sem = btn.dataset.sem;
  if (dSemSelected.has(sem)) {
    dSemSelected.delete(sem);
  } else {
    if (dSemSelected.size >= 5) {
      const first = dSemSelected.values().next().value;
      dSemSelected.delete(first);
    }
    dSemSelected.add(sem);
  }
  _syncCapsuleStyles();
  _updateMultiCount();
  renderD();
}

function getDSemList() {
  if (!DATA) return [];
  const sems = DATA.meta.semesters;
  if (dSemMode === 'range') {
    return sems.slice(dSemRange[0], dSemRange[1] + 1);
  }
  return sems.filter(s => dSemSelected.has(s));
}

function _updateDSemRangeLabel() {
  if (!DATA) return;
  const sems = DATA.meta.semesters;
  const [si, ei] = dSemRange;
  const count = ei - si + 1;
  document.getElementById('dSemRangeLabel').textContent =
    `${semLabel(sems[si])} – ${semLabel(sems[ei])}`;
  document.getElementById('dSemRangeCount').textContent = `${count} 個學期`;

  if (dView === 'class' && count > 12) {
    document.getElementById('dSemRangeCount').innerHTML =
      `${count} 個學期 <span style="color:var(--accent3)">⚠ 各班獨立模式下線條可能過多</span>`;
  }
}

function _syncCapsuleStyles() {
  document.querySelectorAll('#dSemMultiWrap .sem-capsule').forEach(btn => {
    const active = dSemSelected.has(btn.dataset.sem);
    btn.style.background    = active ? 'var(--accent)'    : 'var(--surface2)';
    btn.style.color         = active ? '#fff'             : 'var(--text-dim)';
    btn.style.borderColor   = active ? 'var(--accent)'    : 'var(--border2)';
    btn.style.fontWeight    = active ? '700'              : '400';
  });
}

function _updateMultiCount() {
  document.getElementById('dSemMultiCount').textContent =
    `已選 ${dSemSelected.size} / 5 個學期`;
}

function renderD() {
  if (!DATA) return;

  const filterProg = document.getElementById('dFilterProgram').value;
  const sems = getDSemList();

  if (sems.length === 0) {
    document.getElementById('dStats').innerHTML =
      '<div class="empty-state" style="padding:16px;color:var(--text-dim)">請至少選擇一個學期</div>';
    return;
  }

  const semsSet = new Set(sems);
  const allClasses = Object.values(DATA.class_summary).map(c => ({
    ...c,
    program: classifyProgram(c.sheet_name, c.semester)
  })).filter(c => {
    if (!semsSet.has(c.semester)) return false;
    if (!getIncludeRetaker('D') &&
        (c.program === 'retake_class' || c.program === 'retake_student')) return false;
    if (dType === 'practicum') return c.type === 'practicum';
    return c.type !== 'practicum';
  });

  const filtered = filterProg === 'all'
    ? allClasses
    : allClasses.filter(c => c.program === filterProg);

  const totalStudents = filtered.reduce((a, c) => a + (c.count || 0), 0);
  const _weightedScore = filtered.reduce((a, c) => a + (c.avg_semester || 0) * (c.count || 0), 0);
  const _weightedPass  = filtered.reduce((a, c) => a + (c.pass_rate  || 0) * (c.count || 0), 0);
  const avgScore = totalStudents > 0
    ? (_weightedScore / totalStudents).toFixed(1)
    : '–';
  const avgPass = totalStudents > 0
    ? ((_weightedPass / totalStudents) * 100).toFixed(1) + '%'
    : '–';
  const programs = [...new Set(filtered.map(c => c.program))];

  document.getElementById('dStats').innerHTML = `
    <div class="stat-card" style="--accent-color:var(--accent)">
      <div class="val">${totalStudents}</div>
      <div class="lbl">總人次 Total</div>
    </div>
    <div class="stat-card" style="--accent-color:var(--accent2)">
      <div class="val">${avgScore}</div>
      <div class="lbl">整體均分 Overall Avg</div>
    </div>
    <div class="stat-card" style="--accent-color:var(--accent3)">
      <div class="val">${avgPass}</div>
      <div class="lbl">整體及格率 Pass Rate</div>
    </div>
    <div class="stat-card" style="--accent-color:var(--accent4)">
      <div class="val">${sems.length}</div>
      <div class="lbl">學期數 Semesters</div>
    </div>
    <div class="stat-card" style="--accent-color:var(--accent)">
      <div class="val">${programs.length}</div>
      <div class="lbl">學制數 Programs</div>
    </div>
  `;

  document.getElementById('dChartTitle').textContent =
    (filterProg === 'all' ? '全部學制' : PROGRAM_LABELS[filterProg]) +
    '【' + (dType === 'practicum' ? '實驗課' : '正課') + '】' +
    ' — ' + metricLabel(dMetric) + ' 跨學期趨勢';

  if (dView === 'merge') {
    renderDTrendMerge(filtered, sems, allClasses);
  } else {
    renderDTrendClass(filtered, sems, allClasses);
  }

  if (dSemMode === 'multi') {
    renderDProgramBar(allClasses, sems, filterProg);
    renderDPassRateBar(allClasses, sems, filterProg);
  } else {
    renderDPassRateLine(allClasses, sems, filterProg);
  }

  const tableCard = document.getElementById('dClassTable');
  if (dView === 'class') {
    tableCard.style.display = 'block';
    renderDTable(filtered);
  } else {
    tableCard.style.display = 'none';
  }

  renderHeatmap(filtered);
  renderBoxPlot(allClasses, filterProg);
  renderCorrelation(filtered);

  updateFilterSummary('D');
}

function renderDTrendMerge(filtered, sems, allClasses) {
  const filterProg = document.getElementById('dFilterProgram').value;

  let datasets;
  if (filterProg === 'all') {
    const programs = sortPrograms([...new Set(allClasses.map(c => c.program))]);
    datasets = programs.map(prog => {
      const data = sems.map(sem => {
        const cls = allClasses.filter(c => c.semester === sem && c.program === prog);
        if (!cls.length) return null;
        const field = metricField(dMetric);
        const w = weightedAvg(cls, c => c[field]);
        return w != null ? +w.toFixed(2) : null;
      });
      return {
        label: PROGRAM_LABELS[prog],
        data,
        borderColor: PROGRAM_COLORS[prog],
        backgroundColor: PROGRAM_COLORS[prog] + '20',
        tension: 0.3,
        fill: false,
        pointRadius: 5,
        pointHoverRadius: 7,
        spanGaps: true,
      };
    });
  } else {
    const data = sems.map(sem => {
      const cls = filtered.filter(c => c.semester === sem);
      if (!cls.length) return null;
      const field = metricField(dMetric);
      const w = weightedAvg(cls, c => c[field]);
      return w != null ? +w.toFixed(2) : null;
    });
    datasets = [{
      label: PROGRAM_LABELS[filterProg] + ' 均線',
      data,
      borderColor: PROGRAM_COLORS[filterProg] || '#4f8ef7',
      backgroundColor: (PROGRAM_COLORS[filterProg] || '#4f8ef7') + '20',
      tension: 0.3,
      fill: false,
      pointRadius: 5,
      pointHoverRadius: 7,
      spanGaps: true,
    }];
  }

  mkChart('chartCohortTrend', {
    type: 'line',
    data: { labels: sems.map(semLabel), datasets },
    options: {
      ...CHART_DEFAULTS,
      plugins: {
        ...CHART_DEFAULTS.plugins,
        tooltip: {
          ...CHART_DEFAULTS.plugins.tooltip,
          callbacks: {
            label: ctx => `${ctx.dataset.label}：${ctx.raw ?? '無資料'}`
          }
        }
      },
      scales: {
        x: { ...CHART_DEFAULTS.scales.x },
        y: { ...CHART_DEFAULTS.scales.y, min: 0, max: 100,
          title: { display: true, text: metricLabel(dMetric), color: 'var(--text-dim)' } }
      }
    }
  });
}

function renderDTrendClass(filtered, sems, allClasses) {
  const classes = sortSheetNames([...new Set(filtered.map(c => c.sheet_name))]);
  const MAX_LINES = 18;

  if (classes.length > MAX_LINES) {
    document.getElementById('dModeHint').innerHTML =
      `⚠️ 各班獨立模式：班級數（${classes.length}）超過上限（${MAX_LINES}），` +
      `已自動切換為 <strong style="color:var(--accent)">合併總平均</strong>。請縮小學期範圍或指定學制。`;
    renderDTrendMerge(filtered, sems, allClasses);
    return;
  }

  const datasets = classes.map(cls => {
    const prog = filtered.find(c => c.sheet_name === cls)?.program || '2yr_gen';
    const data = sems.map(sem => {
      const rec = filtered.find(c => c.semester === sem && c.sheet_name === cls);
      return rec ? (rec[metricField(dMetric)] ?? null) : null;
    });
    return {
      label: cls,
      data,
      borderColor: PROGRAM_COLORS[prog],
      backgroundColor: PROGRAM_COLORS[prog] + '15',
      tension: 0.3,
      fill: false,
      pointRadius: 4,
      pointHoverRadius: 6,
      borderWidth: 1.5,
      spanGaps: true,
    };
  });

  mkChart('chartCohortTrend', {
    type: 'line',
    data: { labels: sems.map(semLabel), datasets },
    options: {
      ...CHART_DEFAULTS,
      plugins: {
        ...CHART_DEFAULTS.plugins,
        legend: { labels: { color: 'var(--text-dim)', font: { size: 9 }, boxWidth: 12 } }
      },
      scales: {
        x: { ...CHART_DEFAULTS.scales.x },
        y: { ...CHART_DEFAULTS.scales.y, min: 0, max: 100,
          title: { display: true, text: metricLabel(dMetric), color: 'var(--text-dim)' } }
      }
    }
  });
}

function renderDProgramBar(allClasses, sems, filterProg) {
  const programs = PROGRAM_ORDER;
  const datasets = programs.map(prog => {
    const data = sems.map(sem => {
      const cls = allClasses.filter(c => c.semester === sem && c.program === prog);
      if (!cls.length) return null;
      const field = metricField(dMetric);
      const w = weightedAvg(cls, c => c[field]);
      return w != null ? +w.toFixed(1) : null;
    });

    const isHighlighted = filterProg === 'all' || prog === filterProg;
    const alpha = isHighlighted ? 'bb' : '33';
    const borderW = isHighlighted ? (filterProg !== 'all' && prog === filterProg ? 2 : 1) : 1;

    return {
      label: PROGRAM_LABELS[prog],
      data,
      backgroundColor: PROGRAM_COLORS[prog] + alpha,
      borderColor: PROGRAM_COLORS[prog] + (isHighlighted ? '' : '66'),
      borderWidth: borderW,
      borderRadius: 3,
    };
  });

  const subtitle = `各學期學制比較｜指標：${metricLabel(dMetric)}` +
    (filterProg !== 'all' ? `｜高亮：${PROGRAM_LABELS[filterProg]}` : '');

  mkChart('chartProgramBar', {
    type: 'bar',
    data: { labels: sems.map(semLabel), datasets },
    options: {
      ...CHART_DEFAULTS,
      plugins: {
        ...CHART_DEFAULTS.plugins,
        legend: { labels: { color: 'var(--text-dim)', font: { size: 9 }, boxWidth: 10 } },
        subtitle: { display: true, text: subtitle, color: 'var(--text-dim)', font: { size: 10 }, padding: { bottom: 4 } }
      },
      scales: {
        x: { ...CHART_DEFAULTS.scales.x },
        y: { ...CHART_DEFAULTS.scales.y, min: 0, max: 100 }
      }
    }
  });
}

function renderDPassRateLine(allClasses, sems, filterProg) {
  const programs = filterProg === 'all'
    ? PROGRAM_ORDER
    : PROGRAM_ORDER.filter(p => p === filterProg);
  const datasets = programs.map(prog => {
    const data = sems.map(sem => {
      const cls = allClasses.filter(c => c.semester === sem && c.program === prog);
      if (!cls.length) return null;
      const w = weightedAvg(cls, c => c.pass_rate);
      return w != null ? +(w * 100).toFixed(1) : null;
    });
    return {
      label: PROGRAM_LABELS[prog],
      data,
      borderColor: PROGRAM_COLORS[prog],
      backgroundColor: PROGRAM_COLORS[prog] + '20',
      tension: 0.3, fill: false, pointRadius: 4, spanGaps: true,
    };
  });

  mkChart('chartPassRateRange', {
    type: 'line',
    data: { labels: sems.map(semLabel), datasets },
    options: {
      ...CHART_DEFAULTS,
      plugins: {
        ...CHART_DEFAULTS.plugins,
        legend: { labels: { color: 'var(--text-dim)', font: { size: 9 }, boxWidth: 10 } },
        tooltip: {
          ...CHART_DEFAULTS.plugins.tooltip,
          callbacks: { label: ctx => `${ctx.dataset.label}：${ctx.raw ?? '–'}%` }
        }
      },
      scales: {
        x: { ...CHART_DEFAULTS.scales.x },
        y: { ...CHART_DEFAULTS.scales.y, min: 0, max: 100,
          title: { display: true, text: '及格率 %', color: 'var(--text-dim)' } }
      }
    }
  });
}

function renderDPassRateBar(allClasses, sems, filterProg) {
  const programs = filterProg === 'all'
    ? PROGRAM_ORDER.filter(p => allClasses.some(c => c.program === p))
    : PROGRAM_ORDER.filter(p => p === filterProg);

  const datasets = programs.map(prog => {
    const data = sems.map(sem => {
      const cls = allClasses.filter(c => c.semester === sem && c.program === prog);
      if (!cls.length) return null;
      const w = weightedAvg(cls, c => c.pass_rate);
      return w != null ? +(w * 100).toFixed(1) : null;
    });
    return {
      label: PROGRAM_LABELS[prog],
      data,
      backgroundColor: PROGRAM_COLORS[prog] + 'bb',
      borderColor: PROGRAM_COLORS[prog],
      borderWidth: 1, borderRadius: 3,
    };
  });

  mkChart('chartPassRate', {
    type: 'bar',
    data: { labels: sems.map(semLabel), datasets },
    options: {
      ...CHART_DEFAULTS,
      plugins: {
        ...CHART_DEFAULTS.plugins,
        legend: { labels: { color: 'var(--text-dim)', font: { size: 9 }, boxWidth: 10 } },
        tooltip: {
          ...CHART_DEFAULTS.plugins.tooltip,
          callbacks: { label: ctx => `${ctx.dataset.label}：${ctx.raw ?? '–'}%` }
        },
        subtitle: {
          display: true,
          text: `${sems.length} 個學期並排及格率比較`,
          color: 'var(--text-dim)', font: { size: 10 }, padding: { bottom: 4 }
        }
      },
      scales: {
        x: { ...CHART_DEFAULTS.scales.x },
        y: { ...CHART_DEFAULTS.scales.y, min: 0, max: 100,
          title: { display: true, text: '及格率 %', color: 'var(--text-dim)' } }
      }
    }
  });
}


function renderDTable(filtered) {
  const tbody = document.getElementById('dDetailBody');
  if (!tbody) return;
  const rows = [...filtered].sort((a, b) =>
    a.semester.localeCompare(b.semester) || compareSheetNames(a.sheet_name, b.sheet_name)
  );
  tbody.innerHTML = rows.map((c, i) => `
    <tr style="background:${i%2?'var(--surface2)':'var(--surface)'}">
      <td style="padding:7px 10px;border-bottom:1px solid var(--border)">${escapeHtml(semLabel(c.semester))}</td>
      <td style="padding:7px 10px;border-bottom:1px solid var(--border);font-weight:600">${escapeHtml(c.sheet_name)}</td>
      <td style="padding:7px 10px;border-bottom:1px solid var(--border)">
        <span class="program-badge prog-${escapeHtml(c.program.replace(/_/g,'-'))}">${escapeHtml(PROGRAM_LABELS[c.program] ?? c.program)}</span>
      </td>
      <td style="padding:7px 10px;border-bottom:1px solid var(--border);text-align:right">${c.count}</td>
      <td style="padding:7px 10px;border-bottom:1px solid var(--border);text-align:right;font-family:'JetBrains Mono',monospace">${c.avg_midterm ?? '–'}</td>
      <td style="padding:7px 10px;border-bottom:1px solid var(--border);text-align:right;font-family:'JetBrains Mono',monospace">${c.avg_final ?? '–'}</td>
      <td style="padding:7px 10px;border-bottom:1px solid var(--border);text-align:right;font-family:'JetBrains Mono',monospace;font-weight:600;color:${c.avg_semester>=60?'var(--green)':'var(--red)'}">${c.avg_semester ?? '–'}</td>
      <td style="padding:7px 10px;border-bottom:1px solid var(--border);text-align:right;color:${c.pass_rate>=0.8?'var(--green)':c.pass_rate>=0.6?'var(--accent3)':'var(--red)'}">${c.pass_rate!=null?(c.pass_rate*100).toFixed(1)+'%':'–'}</td>
    </tr>
  `).join('');
}

// ══════════════════════════════════════════════════════════
// PWA：Service Worker 註冊 & 更新提示
// ══════════════════════════════════════════════════════════
if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('./sw.js', { scope: './' });

      reg.addEventListener('updatefound', () => {
        const newWorker = reg.installing;
        newWorker.addEventListener('statechange', () => {
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            showUpdateBanner(newWorker);
          }
        });
      });

      if (reg.waiting) {
        showUpdateBanner(reg.waiting);
      }

    } catch (err) {
    }
  });

  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!refreshing) {
      refreshing = true;
      window.location.reload();
    }
  });
}

function showUpdateBanner(worker) {
  const existing = document.querySelector('.sw-update-banner');
  if (existing) return;

  const banner = document.createElement('div');
  banner.className = 'sw-update-banner';

  const msg = document.createElement('span');
  msg.textContent = '🔄 有新版本可用';

  const btn = document.createElement('button');
  btn.textContent = '立即更新';
  btn.addEventListener('click', () => {
    worker.postMessage({ type: 'SKIP_WAITING' });
    banner.remove();
  });

  const close = document.createElement('button');
  close.textContent = '×';
  close.style.cssText = 'background:none;border:none;color:rgba(255,255,255,0.7);font-size:16px;cursor:pointer;padding:0 4px';
  close.addEventListener('click', () => banner.remove());

  banner.append(msg, btn, close);
  document.body.appendChild(banner);
}

// ══════════════════════════════════════════════════════════
// PWA：iOS 安裝引導 Banner
// ══════════════════════════════════════════════════════════
function showIOSInstallBanner() {
  const lastShown = localStorage.getItem('pwa-banner-shown');
  if (lastShown && Date.now() - parseInt(lastShown, 10) < 7 * 24 * 60 * 60 * 1000) return;

  const isInstalled = window.navigator.standalone === true;
  if (isInstalled) return;

  const banner = document.createElement('div');
  banner.className = 'pwa-install-banner';

  const icon = document.createElement('img');
  icon.src = './icons/icon-180.png';
  icon.alt = 'LA DASH';

  const textWrap = document.createElement('div');
  textWrap.className = 'banner-text';

  const title = document.createElement('strong');
  title.textContent = '安裝到主畫面';

  const desc = document.createElement('span');
  desc.textContent = '點擊底部「分享』按鈕，選擇「加入主畫面」';

  textWrap.append(title, desc);

  const closeBtn = document.createElement('button');
  closeBtn.className = 'banner-close';
  closeBtn.textContent = '×';
  closeBtn.setAttribute('aria-label', '關閉安裝提示');
  closeBtn.addEventListener('click', () => {
    banner.remove();
    localStorage.setItem('pwa-banner-shown', Date.now());
  });

  banner.append(icon, textWrap, closeBtn);
  document.body.appendChild(banner);

  setTimeout(() => {
    if (banner.parentNode) {
      banner.style.transition = 'opacity 0.5s';
      banner.style.opacity = '0';
      setTimeout(() => banner.remove(), 500);
    }
  }, 8000);
}

const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
const isSafari = /Safari/.test(navigator.userAgent) && !/Chrome|CriOS|FxiOS/.test(navigator.userAgent);
const isStandalone = window.navigator.standalone === true;

if (isIOS && isSafari && !isStandalone) {
  setTimeout(showIOSInstallBanner, 3000);
}

// ══════════════════════════════════════════════════════════
// PRINT PANEL
// ══════════════════════════════════════════════════════════
const PRINT_ITEMS = [
  // ── Panel D：整屆分析 ──
  { id: 'chartCohortTrend',      label: '整屆跨學期趨勢',           tab: 'D', type: 'canvas', checked: true },
  { id: 'chartProgramBar',       label: '各學期學制比較',           tab: 'D', type: 'canvas', checked: true },
  { id: 'chartPassRate',         label: '及格率比較',               tab: 'D', type: 'canvas', checked: true },
  { id: 'chartPassRateRange',    label: '及格率趨勢折線',           tab: 'D', type: 'canvas', checked: false },
  { id: 'heatmapWrap',           label: '學期 × 班級成績熱力圖',     tab: 'D', type: 'svg',    checked: true },
  { id: 'boxplotWrap',           label: '學制成績分布箱形圖',       tab: 'D', type: 'svg',    checked: true },
  { id: 'chartCorrelation',      label: '人數 vs 及格率相關性',      tab: 'D', type: 'canvas', checked: false },
  // ── Panel A：班級分析 ──
  { id: 'chartDist',             label: '成績分布直方圖',           tab: 'A', type: 'canvas', checked: false },
  { id: 'chartMidFinal',         label: '期中/期末指標對比',         tab: 'A', type: 'canvas', checked: false },
  { id: 'chartTrend',            label: '班級跨屆趨勢',             tab: 'A', type: 'canvas', checked: false },
  { id: 'chartNormalOverlay',    label: '常態分布曲線疊加',         tab: 'A', type: 'canvas', checked: false },
  { id: 'chartRegression',       label: '期中 → 期末線性迴歸',       tab: 'A', type: 'canvas', checked: false },
  { id: 'chartVariance',         label: '與前次同班比較 Δ',          tab: 'A', type: 'canvas', checked: false },
  // ── Panel C：個案 / 重修 ──
  // cChartDist：個案成績分布（canvas，由 renderCAnomalyAndDist 繪製）
  { id: 'cChartDist',            label: '個案成績分布',             tab: 'C', type: 'canvas', checked: false },
  { id: 'chartAnomalyDensity',   label: '異常事件密度',             tab: 'C', type: 'canvas', checked: false },
  { id: 'chartRetakerFirstDist', label: '重修生首修成績分布',       tab: 'C', type: 'canvas', checked: false },
  { id: 'slopeChart',            label: '首修 → 重修進退步坡度圖',   tab: 'C', type: 'svg',    checked: false },
  { id: 'chartDelta',            label: '重修 Δ 分布',              tab: 'C', type: 'canvas', checked: false },
  { id: 'chartQuadrant',         label: '正課 × 實驗四象限',         tab: 'C', type: 'canvas', checked: false },
  { id: 'chartDeltaByProgram',   label: '重修改善率依學制',         tab: 'C', type: 'canvas', checked: false },
  { id: 'chartRetakeCount',      label: '重修次數分布',             tab: 'C', type: 'canvas', checked: false },
  { id: 'chartFirstVsDelta',     label: '首修成績 vs 重修進步',     tab: 'C', type: 'canvas', checked: false },
  // ── Panel L：學習行為 ──
  { id: 'radarChart',            label: '學習行為分群雷達圖',       tab: 'L', type: 'canvas', checked: false },
  // corrHeatmap 為 HTML table，無法截圖；改為擷取 scatterChart canvas
  { id: 'scatterChart',          label: '行為相關性散佈圖',         tab: 'L', type: 'canvas', checked: false },
  { id: 'weeklyQuizChart',       label: '各週題庫作答強度',         tab: 'L', type: 'canvas', checked: false },
  { id: 'preExamChart',          label: '平時及考前學習強度',       tab: 'L', type: 'canvas', checked: false },
  { id: 'timeSlotChart',         label: '學習時段分布',             tab: 'L', type: 'canvas', checked: false },
  // studyHeatmapWrap 為 SVG 渲染進 div，使用 svg type 取得 getPrintableSvgHtml
  { id: 'studyHeatmapWrap',      label: '學習規律熱力圖',           tab: 'L', type: 'svg',    checked: false },
  // hourlyLineWrap 為 div 包 canvas，直接指向 canvas id
  { id: 'hourlyLineChart',       label: '24小時學習活躍度趨勢',     tab: 'L', type: 'canvas', checked: false },
];

const PRINT_TAB_LABELS = { D: '整屆', A: '班級', C: '個案 / 重修', L: '學習行為' };

function printYears() {
  if (!DATA?.meta?.semesters?.length) return [];
  return [...new Set(DATA.meta.semesters.map(s => String(s).slice(0, 3)))].sort((a,b) => b-a);
}

function populatePrintYearFilters() {
  const start = document.getElementById('printYearStart');
  const end = document.getElementById('printYearEnd');
  if (!start || !end) return;
  const years = printYears();
  const options = years.map(y => `<option value="${y}">${y} 年</option>`).join('');
  const prevStart = start.value;
  const prevEnd = end.value;
  start.innerHTML = options;
  end.innerHTML = options;
  start.value = years.includes(prevStart) ? prevStart : years[years.length - 1] || '';
  end.value   = years.includes(prevEnd)   ? prevEnd   : years[0] || '';
  syncPrintYearRange();
}

function syncPrintYearRange() {
  const start = document.getElementById('printYearStart');
  const end = document.getElementById('printYearEnd');
  if (!start || !end || !start.value || !end.value) return;
  if (Number(start.value) > Number(end.value)) {
    if (document.activeElement === start) end.value = start.value;
    else start.value = end.value;
  }
}

function getPrintYearRange() {
  const years = printYears();
  const start = document.getElementById('printYearStart')?.value || years[0] || '';
  const end = document.getElementById('printYearEnd')?.value || years[years.length - 1] || '';
  return { start, end };
}

function getPrintSemesters() {
  const { start, end } = getPrintYearRange();
  return sortSemestersDesc((DATA?.meta?.semesters || []).filter(s => {
    const year = String(s).slice(0, 3);
    return (!start || year >= start) && (!end || year <= end);
  }));
}

function updatePrintChoiceState() {
  const selectedCount = getSelectedPrintItems().length;
  document.querySelectorAll('.print-choice').forEach(label => {
    const cb = label.querySelector('input[type="checkbox"]');
    label.classList.toggle('selected', !!cb?.checked);
  });
  const summary = document.getElementById('printSummary');
  if (summary) summary.textContent = `已選擇 ${selectedCount} 個列印項目`;
}

function renderPrintPanel() {
  const container = document.getElementById('printSelections');
  if (!container) return;
  populatePrintYearFilters();
  container.innerHTML = '';
  PRINT_ITEMS.forEach(item => {
    const label = document.createElement('label');
    label.className = 'print-choice';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.id = 'print_' + item.id;
    cb.checked = item.checked !== false;
    cb.addEventListener('change', updatePrintChoiceState);
    const tabBadge = document.createElement('span');
    tabBadge.className = 'print-tab';
    tabBadge.textContent = PRINT_TAB_LABELS[item.tab] || item.tab;
    const labelText = document.createElement('span');
    labelText.className = 'print-label';
    labelText.textContent = item.label;
    label.appendChild(cb);
    label.appendChild(tabBadge);
    label.appendChild(labelText);
    container.appendChild(label);
  });
  updatePrintChoiceState();
}

function getSelectedPrintItems() {
  return PRINT_ITEMS.filter(item => {
    const cb = document.getElementById('print_' + item.id);
    return cb && cb.checked;
  });
}

function withPrintablePanelsVisible(task) {
  const panels = [...document.querySelectorAll('.panel')].filter(p => p.id !== 'panelP' && p.id !== 'panelR');
  const originals = panels.map(p => ({
    el: p,
    display: p.style.display,
    visibility: p.style.visibility,
    position: p.style.position,
    left: p.style.left,
    top: p.style.top,
    width: p.style.width,
    pointerEvents: p.style.pointerEvents,
  }));
  panels.forEach(p => {
    p.style.display = 'block';
    p.style.visibility = 'hidden';
    p.style.position = 'absolute';
    p.style.left = '-10000px';
    p.style.top = '0';
    p.style.width = '1200px';
    p.style.pointerEvents = 'none';
  });
  const subPanes = [...document.querySelectorAll('.behavior-sub-pane')];
  const subPaneOriginals = subPanes.map(p => ({ el: p, display: p.style.display }));
  subPanes.forEach(p => { p.style.display = 'block'; });
  try {
    return task();
  } finally {
    originals.forEach(({ el, ...style }) => Object.assign(el.style, style));
    subPaneOriginals.forEach(({ el, display }) => { el.style.display = display; });
  }
}

function clonePrintDataForSemesters(sems) {
  const semSet = new Set(sems);
  const classSummary = Object.fromEntries(
    Object.entries(DATA.class_summary || {}).filter(([, c]) => semSet.has(c.semester))
  );
  const students = Object.fromEntries(
    Object.entries(DATA.students || {}).map(([sid, student]) => [
      sid,
      { ...student, records: (student.records || []).filter(r => semSet.has(r.semester)) }
    ]).filter(([, student]) => student.records.length)
  );
  return {
    ...DATA,
    meta: { ...DATA.meta, semesters: sems },
    class_summary: classSummary,
    students,
  };
}

function withPrintDataRange(task) {
  if (!DATA) return task();
  const sems = getPrintSemesters();
  if (!sems.length) return task();
  const originalData = DATA;
  const controls = ['aFilterSem', 'aFilterProgram', 'aFilterSheet', 'aTrendSheet', 'aCompareSem'].map(id => {
    const el = document.getElementById(id);
    return { el, value: el?.value };
  });
  DATA = clonePrintDataForSemesters(sems);
  const aSem = document.getElementById('aFilterSem');
  if (aSem && !sems.includes(aSem.value)) aSem.value = sems[0];
  try {
    return task();
  } finally {
    DATA = originalData;
    controls.forEach(({ el, value }) => {
      if (el && value != null) el.value = value;
    });
  }
}

function renderPrintCharts() {
  if (!DATA) return;
  renderD();
  renderA();
  // renderB 已包含 renderSlope/renderDelta/renderQuadrant/renderDeltaByProgram/renderRetakeCount/renderFirstVsDelta
  renderB();
  // renderCAnomalyAndDist 繪製 chartAnomalyDensity + cChartDist
  renderCAnomalyAndDist();
  renderRetakerFirstDist();
  // 強制所有已登記圖表 resize，確保 hidden panel 內的 canvas 有正確尺寸
  Object.values(charts).forEach(chart => {
    try { chart.resize(); chart.update('none'); } catch(e) {}
  });
  // 補足由外部模組（behavior tabs / ChartRegistry）管理、未在 charts{} map 中的圖表
  // 優先使用 ChartRegistry.list() 涵蓋所有已登記實例
  const registryIds = (typeof ChartRegistry !== 'undefined') ? ChartRegistry.list() : [];
  const behaviorIds = ['radarChart', 'weeklyQuizChart', 'preExamChart', 'timeSlotChart', 'scatterChart', 'hourlyLineChart'];
  const externalIds = [...new Set([...registryIds, ...behaviorIds])].filter(id => !charts[id]);
  externalIds.forEach(id => {
    const canvas = document.getElementById(id);
    if (!canvas) return;
    const instance = typeof Chart !== 'undefined' && Chart.getChart(canvas);
    if (instance) { try { instance.resize(); instance.update('none'); } catch(e) {} }
  });
}

function getPrintableSvgHtml(item) {
  const el = document.getElementById(item.id);
  if (!el) return '';
  const svg = el.tagName?.toLowerCase() === 'svg' ? el : el.querySelector('svg');
  if (!svg) return '';
  const copy = svg.cloneNode(true);
  // 若無 viewBox，從 width/height 屬性補全，確保縮放不裁切
  if (!copy.getAttribute('viewBox')) {
    const w = parseFloat(svg.getAttribute('width') || svg.getBoundingClientRect().width) || 800;
    const h = parseFloat(svg.getAttribute('height') || svg.getBoundingClientRect().height) || 400;
    copy.setAttribute('viewBox', `0 0 ${w} ${h}`);
  }
  copy.removeAttribute('width');
  copy.removeAttribute('height');
  copy.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  copy.style.width = '100%';
  copy.style.height = 'auto';
  copy.style.display = 'block';
  return copy.outerHTML;
}

function captureCanvasAtSize(canvas, targetW, targetH) {
  // 優先從 charts{} map 取，再查 Chart.js 全域 registry（涵蓋 ChartRegistry 模組）
  const chart = charts[canvas.id] || (typeof Chart !== 'undefined' && Chart.getChart(canvas));
  // 儲存原始 CSS style（Chart.resize 修改的是 CSS，非 canvas.width/height 屬性）
  const origStyleW = canvas.style.width;
  const origStyleH = canvas.style.height;
  try {
    if (chart) {
      chart.stop();
      chart.resize(targetW, targetH);
      chart.update('none');
    }
    // 若 canvas 完全空白（未初始化）則回傳 null，由呼叫端顯示提示
    const dataUrl = canvas.toDataURL('image/png');
    // 偵測純白/純透明空白 canvas（未初始化的圖表）
    const isBlank = (() => {
      try {
        const ctx2 = canvas.getContext('2d');
        if (!ctx2) return false;
        const px = ctx2.getImageData(0, 0, Math.min(canvas.width, 4), Math.min(canvas.height, 4)).data;
        // 若所有像素 alpha=0 或 rgb 全為 255（純白）則視為空白
        for (let i = 0; i < px.length; i += 4) {
          if (px[i+3] > 0 && !(px[i] === 255 && px[i+1] === 255 && px[i+2] === 255)) return false;
        }
        return true;
      } catch(e) { return false; }
    })();
    return isBlank ? null : dataUrl;
  } finally {
    if (chart) {
      // 用 CSS style 復原（與 resize 對應），再讓 Chart.js 依容器重新自適應
      canvas.style.width = origStyleW;
      canvas.style.height = origStyleH;
      chart.resize();
      chart.update('none');
    }
  }
}

function getPrintableItemHTML(item) {
  const title = `<div class="print-card-title">${escapeHtml(item.label)}</div>`;
  const empty = `<div style="color:#777;font-size:12px;padding:18px 0">此項目目前沒有可列印圖表</div>`;
  const figImg = (dataUrl, label) =>
    `<div class="print-figure"><img src="${dataUrl}" alt="${escapeHtml(label)}" style="width:100%;height:auto;max-width:100%;display:block;" /></div>`;
  if (item.type === 'svg') {
    const svgHtml = getPrintableSvgHtml(item);
    return title + (svgHtml ? `<div class="print-figure">${svgHtml}</div>` : empty);
  }
  if (item.type === 'div') {
    const container = document.getElementById(item.id);
    if (!container) return title + empty;
    const innerCanvas = container.querySelector('canvas');
    if (innerCanvas) {
      try {
        const dataUrl = captureCanvasAtSize(innerCanvas, 800, 380);
        if (dataUrl) return title + figImg(dataUrl, item.label);
        return title + `<div style="color:#777;font-size:12px;padding:18px 0">⚠ 圖表未初始化，請先切換至對應頁籤後再預覽列印</div>`;
      } catch(e) { }
    }
    const svgHtml = getPrintableSvgHtml(item);
    if (svgHtml) return title + `<div class="print-figure">${svgHtml}</div>`;
    return title + empty;
  }
  const canvas = document.getElementById(item.id);
  if (!canvas) return title + empty;
  try {
    const dataUrl = captureCanvasAtSize(canvas, 800, 380);
    if (!dataUrl) return title + `<div style="color:#777;font-size:12px;padding:18px 0">⚠ 圖表未初始化，請先切換至對應頁籤後再預覽列印</div>`;
    return title + figImg(dataUrl, item.label);
  } catch(e) {
    return title + `<div style="color:#777;font-size:12px;padding:18px 0">⚠ 圖表擷取失敗（${escapeHtml(String(e?.message||e))}）</div>`;
  }
}

function buildPrintHTML(items) {
  let itemHtml = '';
  withPrintDataRange(() => {
    withPrintablePanelsVisible(() => {
      renderPrintCharts();
      itemHtml = items.map(item =>
        `<div class="print-card">${getPrintableItemHTML(item)}</div>`
      ).join('');
    });
  });

  const range = getPrintYearRange();
  const rangeLabel = range.start && range.end ? `${range.start} 年至 ${range.end} 年` : '全部年份';
  let html = `<style>
    .print-report { font-family:sans-serif;background:#fff;color:#000;padding:20px; }
    .print-grid { display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px;align-items:start; }
    .print-card { break-inside:avoid;border:1px solid #ddd;border-radius:8px;padding:12px;background:#fff;margin-bottom:4px; }
    .print-card-title { font-size:12px;font-weight:600;color:#444;margin-bottom:8px; }
    .print-figure { width:100%;overflow:visible; }
    .print-figure img { width:100%;height:auto;max-width:100%;display:block;object-fit:contain; }
    .print-figure svg { width:100%;height:auto;max-width:100%;display:block; }
    @media print { .print-card { page-break-inside:avoid; } }
  </style><div class="print-report">
    <div style="border-bottom:2px solid #333;padding-bottom:10px;margin-bottom:20px">
      <h1 style="font-size:18px;margin:0">學習分析儀表板</h1>`;
  const subj = document.getElementById('subjectInput')?.textContent?.trim();
  if (subj) html += `<div style="font-size:13px;color:#555;margin-top:4px">科目：${escapeHtml(subj)}</div>`;
  html += `<div style="font-size:12px;color:#555;margin-top:4px">輸出年份：${escapeHtml(rangeLabel)}</div>`;
  const meta = document.getElementById('metaInfo')?.textContent;
  if (meta) html += `<div style="font-size:11px;color:#888;margin-top:2px">${escapeHtml(meta)}</div>`;
  html += `</div><div class="print-grid">`;
  html += itemHtml;
  html += `</div></div>`;
  return html;
}

/**
 * doPrint — Phase 2 重構版（Blob URL，無需子視窗 inline script）
 * 詳見規格書 Phase 2
 */
function doPrint() {
  const items = getSelectedPrintItems();
  if (!items.length) { alert('請至少選擇一個圖表'); return; }
  const html = buildPrintHTML(items);

  const docHtml = `<!DOCTYPE html><html><head>
    <meta charset="UTF-8">
    <title>學習分析儀表板 - 列印</title>
    <style>
      body { margin: 0; padding: 20px; background: #fff; }
      @page { size: A4 landscape; margin: 15mm; }
      @media print {
        body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      }
    </style>
  </head><body>${html}</body></html>`;

  const blob = new Blob([docHtml], { type: 'text/html' });
  const blobUrl = URL.createObjectURL(blob);
  const printWin = window.open(blobUrl, '_blank', 'noopener,noreferrer');

  if (printWin) {
    printWin.addEventListener('load', () => {
      const imgs = Array.from(printWin.document.images);
      if (!imgs.length) {
        printWin.print();
        URL.revokeObjectURL(blobUrl);
        return;
      }
      let loaded = 0;
      const tryPrint = () => {
        if (++loaded >= imgs.length) {
          printWin.print();
          URL.revokeObjectURL(blobUrl);
        }
      };
      imgs.forEach(img => {
        if (img.complete) tryPrint();
        else { img.onload = img.onerror = tryPrint; }
      });
    });
  } else {
    // Fallback：popup 被封鎖時下載 HTML 檔
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = '學習分析報表.html';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);
  }
}

function doPrintPreview() {
  const items = getSelectedPrintItems();
  if (!items.length) { alert('請至少選擇一個圖表'); return; }
  const area = document.getElementById('printPreviewArea');
  const content = document.getElementById('printPreviewContent');
  content.innerHTML = buildPrintHTML(items);
  area.style.display = 'block';
  area.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ══════════════════════════════════════════════════════════
// data-action 事件委派系統（Phase 3）
// 取代靜態 HTML 中所有 onclick 屬性
// ══════════════════════════════════════════════════════════
function initDataActionDelegation() {
  // Actions that toggle a popover/panel open and must stop propagation,
  // otherwise the same click immediately bubbles to the global "close" listener.
  const STOP_PROPAGATION_ACTIONS = new Set([
    'toggleBStatsHelp', 'toggleRRadarInfo',
    'closePopover', 'closePanelOpen', 'hidePanel',
  ]);

  document.addEventListener('click', e => {
    const el = e.target.closest('[data-action]');

    // Always close open search results on any outside click (consolidated here)
    if (!e.target.closest('.search-wrap')) {
      document.getElementById('searchResults')?.classList.remove('open');
    }

    if (!el) return;

    const action = el.dataset.action;
    const arg    = el.dataset.arg ?? null;

    // Only stop propagation for toggle/close actions to prevent the global
    // chart-popover close listener from immediately undoing the open state.
    if (STOP_PROPAGATION_ACTIONS.has(action)) e.stopPropagation();

    const actionMap = {
      // Header
      toggleMetaInfo:       () => toggleMetaInfo(),
      toggleTheme:          () => toggleTheme(),
      // Tabs
      switchTab:            () => switchTab(arg),
      // Filter collapse
      toggleFilterCollapse: () => toggleFilterCollapse(arg),
      // Retaker switch
      toggleRetakerSwitch:  () => toggleRetakerSwitch(arg),
      // Panel A
      resetAFilters:        () => resetAFilters(),
      undoAFilterReset:     () => undoAFilterReset(),
      // Panel C
      resetCFilters:        () => resetCFilters(),
      switchCView:          () => switchCView(arg),
      setCType:             () => setCType(arg),
      setCExam:             () => setCExam(arg),
      setCPass:             () => setCPass(arg),
      // Panel B
      setBMode:             () => setBMode(arg),
      setBType:             () => setBType(arg),
      // Panel D
      setDSemMode:          () => setDSemMode(arg),
      setDType:             () => setDType(arg),
      setDView:             () => setDView(arg),
      setDMetric:           () => setDMetric(arg),
      toggleDSemCapsule:    () => toggleDSemCapsule(el),
      // Behavior
      resetBehaviorFilters: () => resetBehaviorFilters(),
      behaviorSwitchSub:    () => {
        if (typeof BehaviorTabManager !== 'undefined')
          BehaviorTabManager.switchSub(el.dataset.sub);
      },
      // bStats help — function exposed on window by at-risk-report.js (defer)
      toggleBStatsHelp: () => {
        if (typeof window.toggleBStatsHelp === 'function') window.toggleBStatsHelp(e);
      },
      // Radar info — same
      toggleRRadarInfo: () => {
        if (typeof window.toggleRRadarInfo === 'function') window.toggleRRadarInfo(e);
      },
      // At-risk report
      atRiskFilterRadar: () => {
        if (typeof AtRiskReportManager !== 'undefined')
          AtRiskReportManager.filterRadar(null);
      },
      atRiskFilterRadarCard: () => {
        if (typeof AtRiskReportManager !== 'undefined')
          AtRiskReportManager.filterRadar(el.dataset.filter);
      },
      atRiskSwitchSemester: () => {
        if (typeof AtRiskReportManager !== 'undefined')
          AtRiskReportManager.switchSemester(el.dataset.sem);
      },
      exportAtRiskPDF: () => {
        if (typeof window.exportAtRiskPDF === 'function') window.exportAtRiskPDF();
      },
      // Print
      doPrintPreview: () => doPrintPreview(),
      doPrint:        () => doPrint(),
      // Panel C retake search result selection
      selectRetakeStudent: () => selectRetakeStudent(el.dataset.sid),
      // Panel / popover close
      hidePanel: () => {
        const panel = document.getElementById(el.dataset.target);
        if (panel) panel.style.display = 'none';
      },
      closePanelOpen: () => {
        document.getElementById(el.dataset.target)?.classList.remove('open');
      },
      closePopover: () => el.closest('.chart-popover')?.classList.remove('open'),
    };

    if (actionMap[action]) {
      actionMap[action]();
    } else {
      console.warn('[data-action] unknown action:', action);
    }
  });
}

// ══════════════════════════════════════════════════════════
// 靜態元素事件綁定（DOMContentLoaded 後由 loadData() 呼叫）
// ══════════════════════════════════════════════════════════
function bindStaticHandlers() {
  const byId = id => document.getElementById(id);

  // onchange
  byId('aFilterSem')      ?.addEventListener('change', () => onAFilterChange('semester'));
  byId('aFilterProgram')  ?.addEventListener('change', () => onAFilterChange('program'));
  byId('aFilterType')     ?.addEventListener('change', () => onAFilterChange('courseType'));
  byId('aFilterSheet')    ?.addEventListener('change', () => onAFilterChange('class'));
  byId('aTrendSheet')     ?.addEventListener('change', () => renderTrend());
  byId('aCompareSem')     ?.addEventListener('change', () =>
    renderVarianceBar(byId('aFilterSem').value, byId('aFilterSheet').value));
  byId('cFilterSem')      ?.addEventListener('change', () => onCGeneralFilterChange('semester'));
  byId('cFilterProgram')  ?.addEventListener('change', () => onCGeneralFilterChange('program'));
  byId('dFilterProgram')  ?.addEventListener('change', () => renderD());
  byId('printYearStart')  ?.addEventListener('change', () => syncPrintYearRange());
  byId('printYearEnd')    ?.addEventListener('change', () => syncPrintYearRange());

  // oninput
  byId('cSearch')         ?.addEventListener('input', () => searchStudent());
  byId('cSearchRetake')   ?.addEventListener('input', () => onCRetakeSearch());
  byId('dSemStart')       ?.addEventListener('input', e => onDSemRangeChange(e));
  byId('dSemEnd')         ?.addEventListener('input', e => onDSemRangeChange(e));
}

// ── BOOT ──
document.addEventListener('DOMContentLoaded', () => {
  initDataActionDelegation();
  loadData();
});
