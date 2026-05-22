// ══════════════════════════════════════════════════════════
// at-risk-report.js
// Phase 4：高風險報告管理器 (AtRiskReportManager)
// 對應規格書 §5.2–§6.2
// 依賴：main.js（escapeHtml、Chart 全域物件）
// ══════════════════════════════════════════════════════════

const AtRiskReportManager = (() => {
  let _initialized = false;
  let _data = null;
  let _currentSem = null;
  let _currentSemData = null;
  let _radarFilter = null;

  const DATA_PATH = 'data/at_risk_profile.json';

  // ── 內部工具 ────────────────────────────────────────────
  function _toFiniteNumber(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function _normalizeCohortSummary(cs = {}) {
    const passCount      = Math.max(0, Math.round(_toFiniteNumber(cs.pass_count)));
    const failCount      = Math.max(0, Math.round(_toFiniteNumber(cs.fail_count)));
    const gradedTotal    = passCount + failCount;
    const rawTotal       = Math.max(0, Math.round(_toFiniteNumber(cs.total_students, gradedTotal)));
    const explicitUnsettled = Math.max(0, Math.round(_toFiniteNumber(cs.unsettled_count)));
    const inferredUnsettled = Math.max(rawTotal - gradedTotal, 0);
    const unsettledCount = Math.max(explicitUnsettled, inferredUnsettled);
    const totalStudents  = Math.max(rawTotal, gradedTotal + unsettledCount);
    return {
      total_students:  totalStudents,
      pass_count:      passCount,
      fail_count:      failCount,
      graded_total:    gradedTotal,
      unsettled_count: unsettledCount,
      fail_rate_pct:   gradedTotal > 0
        ? +(failCount / gradedTotal * 100).toFixed(1)
        : null,
    };
  }

  // ── §5.2 班級概況卡片 ────────────────────────────────────
  function renderCohortSummary(cs) {
    const el = document.getElementById('rCohortSummary');
    if (!el) return;
    const safe = _normalizeCohortSummary(cs);
    const hasUnsettled = safe.unsettled_count > 0;
    const cards = [
      { label: '全體學生',   value: safe.total_students,  unit: '人', color: 'var(--accent)',  filter: null },
      ...(hasUnsettled
        ? [{ label: '未結算人數', value: safe.unsettled_count, unit: '人', color: '#8e44ad', filter: null }]
        : []),
      { label: '不及格人數', value: safe.fail_count,       unit: '人', color: '#e74c3c',        filter: safe.fail_count > 0 ? 'fail' : null },
      { label: '及格人數',   value: safe.pass_count,       unit: '人', color: '#27ae60',        filter: safe.pass_count > 0 ? 'pass' : null },
      { label: '不及格率',   value: safe.fail_rate_pct,    unit: '%',  color: '#e67e22',        filter: null, empty: safe.fail_rate_pct == null },
    ];
    el.innerHTML = cards.map(c => {
      const clickable = c.filter !== null;
      const clickAttr = clickable
        ? `data-filter="${c.filter}" data-action="atRiskFilterRadarCard" title="點擊聚焦雷達圖" style="flex:1;min-width:120px;background:var(--card-bg,#fff);border:1px solid var(--border,#e0e0e0);border-radius:10px;padding:14px 16px;text-align:center;cursor:pointer;transition:box-shadow .15s,opacity .15s"`
        : `style="flex:1;min-width:120px;background:var(--card-bg,#fff);border:1px solid var(--border,#e0e0e0);border-radius:10px;padding:14px 16px;text-align:center"`;
      const displayValue = c.empty
        ? '–'
        : (typeof c.value === 'number' ? c.value.toLocaleString() : c.value);
      const displayUnit = c.empty ? '' : ` ${c.unit}`;
      return `<div ${clickAttr}>
        <div style="font-size:22px;font-weight:700;color:${c.color}">${displayValue}<span style="font-size:13px;font-weight:400">${displayUnit}</span></div>
        <div style="font-size:11px;color:var(--text-dim,#888);margin-top:4px">${c.label}</div>
      </div>`;
    }).join('');
  }

  // ── §5.2-b 雷達圖卡片聚焦 ───────────────────────────────
  function filterRadar(mode) {
    const canvas   = document.getElementById('rRadarChart');
    const clearBtn = document.getElementById('rRadarClearBtn');
    const chart    = canvas ? Chart.getChart(canvas) : null;

    if (mode === _radarFilter) mode = null;
    _radarFilter = mode;

    if (chart) {
      chart.data.datasets.forEach((ds, i) => {
        const isPass = (i === 0);
        const active =
          mode === null ? true :
          mode === 'pass' ? isPass : !isPass;
        ds.borderColor          = active
          ? (isPass ? 'rgba(39,174,96,0.85)'  : 'rgba(231,76,60,0.85)')
          : (isPass ? 'rgba(39,174,96,0.15)'  : 'rgba(231,76,60,0.15)');
        ds.backgroundColor      = active
          ? (isPass ? 'rgba(39,174,96,0.15)'  : 'rgba(231,76,60,0.12)')
          : 'rgba(0,0,0,0.03)';
        ds.pointBackgroundColor = ds.borderColor;
        ds.pointBorderColor     = ds.borderColor;
      });
      chart.update('none');
    }

    if (clearBtn) clearBtn.style.display = mode !== null ? '' : 'none';

    document.querySelectorAll('#rCohortSummary [data-filter]').forEach(el => {
      const f = el.dataset.filter;
      if (mode === null) {
        el.style.opacity    = '1';
        el.style.boxShadow  = '';
      } else if (f === mode) {
        el.style.opacity    = '1';
        el.style.boxShadow  = `0 0 0 2px ${f === 'pass' ? '#27ae60' : '#e74c3c'}`;
      } else {
        el.style.opacity    = '0.45';
        el.style.boxShadow  = '';
      }
    });
  }

  // ── §5.1 學期篩選器（schema 3.0+） ──────────────────────
  function renderSemesterFilter(semesters, defaultSem) {
    const wrapper = document.getElementById('rSemesterFilter');
    const btns    = document.getElementById('rSemesterBtns');
    if (!wrapper || !btns || !semesters?.length) return;

    const allBtn = `
      <button data-sem="__all__" data-action="atRiskSwitchSemester"
              style="font-size:12px;padding:4px 14px;border-radius:20px;
                     border:1px solid var(--border,#ccc);background:var(--card-bg,#fff);
                     color:var(--text,#333);cursor:pointer;transition:background .15s,color .15s">
        全部
      </button>`;

    btns.innerHTML = allBtn + semesters.map(sem => `
      <button data-sem="${sem}" data-action="atRiskSwitchSemester"
              style="font-size:12px;padding:4px 14px;border-radius:20px;
                     border:1px solid var(--border,#ccc);background:var(--card-bg,#fff);
                     color:var(--text,#333);cursor:pointer;transition:background .15s,color .15s">
        ${sem}
      </button>`).join('');

    wrapper.style.display = 'flex';
    _highlightSemBtn(defaultSem);
  }

  function _highlightSemBtn(sem) {
    document.querySelectorAll('#rSemesterBtns [data-sem]').forEach(btn => {
      const active = btn.dataset.sem === sem;
      btn.style.background  = active ? 'var(--accent,#4a90d9)' : 'var(--card-bg,#fff)';
      btn.style.color       = active ? '#fff' : 'var(--text,#333)';
      btn.style.borderColor = active ? 'var(--accent,#4a90d9)' : 'var(--border,#ccc)';
      btn.style.fontWeight  = active ? '600' : '400';
    });
  }

  // ── 學期切換 ────────────────────────────────────────────
  function switchSemester(sem) {
    _radarFilter = null;
    _highlightSemBtn(sem);

    let semData;
    if (sem === '__all__') {
      semData = _data.all_semesters;
      if (!semData) return;
      _currentSem     = '__all__';
      _currentSemData = semData;
    } else {
      if (!_data?.by_semester?.[sem]) return;
      _currentSem     = sem;
      _currentSemData = _data.by_semester[sem];
      semData         = _currentSemData;
    }

    renderCohortSummary(semData.cohort_summary);
    renderRadarChart(semData.metrics_comparison);
    renderTemporalChart(semData.temporal_decay);
    renderRedFlags(semData.behavioral_markers, semData.temporal_decay);
    renderPrescriptions(semData.prescriptive_summary);

    const clearBtn = document.getElementById('rRadarClearBtn');
    if (clearBtn) clearBtn.style.display = 'none';
    document.querySelectorAll('#rCohortSummary [data-filter]').forEach(el => {
      el.style.opacity = '1'; el.style.boxShadow = '';
    });
  }

  // ── §5.3 六維度雷達圖 ────────────────────────────────────
  const RADAR_LABELS = [
    'TXT 教材完成率', 'SUP 解鎖教材', 'TUT 輔導資源',
    '考前學習強度', '學習穩定性', 'AUD 音頻時數',
  ];
  const RADAR_KEYS = [
    'text_material_completion', 'supplementary_completion', 'tutoring_resource_rate',
    'pre_exam_intensity', 'learning_stability', 'audio_material_hours',
  ];

  function renderRadarChart(mc) {
    const canvas = document.getElementById('rRadarChart');
    if (!canvas) return;
    const existing = Chart.getChart(canvas);
    if (existing) existing.destroy();

    const passVals = RADAR_KEYS.map(k => mc[k]?.pass_median_normalized ?? 0);
    const failVals = RADAR_KEYS.map(k => mc[k]?.fail_median_normalized ?? 0);

    const cs       = getComputedStyle(document.body);
    const clrText    = cs.getPropertyValue('--text').trim()     || (document.body.classList.contains('light') ? '#1a1d2e' : '#dde3f5');
    const clrTextDim = cs.getPropertyValue('--text-dim').trim() || '#6b748f';
    const clrBorder  = cs.getPropertyValue('--border').trim()   || (document.body.classList.contains('light') ? '#c8cce0' : '#2a2f45');

    new Chart(canvas, {
      type: 'radar',
      data: {
        labels: RADAR_LABELS,
        datasets: [
          {
            label: '及格組',
            data: passVals,
            backgroundColor:    'rgba(39,174,96,0.15)',
            borderColor:        'rgba(39,174,96,0.85)',
            borderWidth: 2,
            pointBackgroundColor: 'rgba(39,174,96,0.85)',
            pointRadius: 4,
          },
          {
            label: '不及格組',
            data: failVals,
            backgroundColor:    'rgba(231,76,60,0.12)',
            borderColor:        'rgba(231,76,60,0.85)',
            borderWidth: 2,
            pointBackgroundColor: 'rgba(231,76,60,0.85)',
            pointRadius: 4,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          r: {
            min: 0, max: 100,
            ticks:       { stepSize: 20, color: clrTextDim, font: { size: 10 }, backdropColor: 'transparent' },
            grid:        { color: clrBorder },
            angleLines:  { color: clrBorder },
            pointLabels: { color: clrText, font: { size: 11 } },
          }
        },
        plugins: {
          legend: { position: 'bottom', labels: { color: clrText, font: { size: 12 } } },
          tooltip: {
            callbacks: {
              label: ctx => {
                const key     = RADAR_KEYS[ctx.dataIndex];
                const mc_item = (_currentSemData || _data)?.metrics_comparison?.[key];
                const gap     = mc_item?.gap_percentage;
                const gapStr  = gap != null && gap !== '' ? `（落差 ${gap}）` : '';
                return `${ctx.dataset.label}：${ctx.raw.toFixed(1)}${gapStr}`;
              }
            }
          }
        }
      }
    });
  }

  // ── §5.4 時序折線圖 ──────────────────────────────────────
  function renderTemporalChart(td) {
    const section = document.getElementById('rTemporalSection');
    if (!section) return;
    if (!td?.available) { section.style.display = 'none'; return; }
    section.style.display = '';

    const canvas = document.getElementById('rTemporalChart');
    if (!canvas) return;
    const existing = Chart.getChart(canvas);
    if (existing) existing.destroy();

    const failSeries = td.weekly_activity_series?.fail_group ?? {};
    const passSeries = td.weekly_activity_series?.pass_group ?? {};
    const weeks = Object.keys(failSeries).sort((a, b) =>
      parseInt(a.replace('Week ', '')) - parseInt(b.replace('Week ', ''))
    );

    let annotationPlugin = {};
    try {
      if (window.ChartAnnotation) Chart.register(window.ChartAnnotation);
      const midWeekLabel = `Week ${td.midterm_week_num}`;
      const midIdx = weeks.indexOf(midWeekLabel);
      if (midIdx >= 0) {
        annotationPlugin = {
          annotation: {
            annotations: {
              midtermLine: {
                type: 'line',
                xMin: midIdx, xMax: midIdx,
                borderColor: 'rgba(231,76,60,0.7)',
                borderWidth: 2,
                borderDash: [6, 3],
                label: {
                  content:  `期中考 W${td.midterm_week_num}`,
                  display:  true,
                  position: 'start',
                  color:    '#e74c3c',
                  font:     { size: 11 },
                  backgroundColor: 'rgba(255,255,255,0.85)',
                }
              }
            }
          }
        };
      }
    } catch(e) {
      console.warn('[AtRisk] chartjs-plugin-annotation 載入失敗，期中考標注線以文字替代', e);
    }

    new Chart(canvas, {
      type: 'line',
      data: {
        labels: weeks,
        datasets: [
          {
            label: '及格組（週均分鐘）',
            data: weeks.map(w => passSeries[w] ?? null),
            borderColor:     'rgba(39,174,96,0.9)',
            backgroundColor: 'rgba(39,174,96,0.1)',
            borderWidth: 2, tension: 0.3, fill: true,
          },
          {
            label: '不及格組（週均分鐘）',
            data: weeks.map(w => failSeries[w] ?? null),
            borderColor:     'rgba(231,76,60,0.9)',
            backgroundColor: 'rgba(231,76,60,0.08)',
            borderWidth: 2, tension: 0.3, fill: true,
          },
        ]
      },
      options: {
        responsive: true,
        plugins: {
          legend: { position: 'bottom', labels: { color: 'var(--text,#222)', font: { size: 12 } } },
          ...annotationPlugin,
        },
        scales: {
          x: { ticks: { color: 'var(--text-dim,#888)', font: { size: 10 } }, grid: { color: 'var(--border,#e0e0e0)' } },
          y: {
            ticks: { color: 'var(--text-dim,#888)', font: { size: 10 } },
            grid:  { color: 'var(--border,#e0e0e0)' },
            title: { display: true, text: '平均分鐘', color: 'var(--text-dim,#888)', font: { size: 11 } },
          }
        }
      }
    });

    if (!Object.keys(annotationPlugin).length) {
      const note = document.createElement('div');
      note.style.cssText = 'font-size:11px;color:var(--text-dim,#888);text-align:right;margin-top:4px';
      note.textContent = `▲ 紅色虛線標注不可用。期中考：Week ${td.midterm_week_num}`;
      canvas.parentNode.appendChild(note);
    }
  }

  // ── §5.5 紅旗警示卡 ──────────────────────────────────────
  function renderRedFlags(bm, td) {
    const el = document.getElementById('rRedFlags');
    if (!el) return;
    const flags = [];

    (bm?.low_completion_flags ?? []).forEach(f => {
      const labelMap = {
        text_material_completion: 'TXT 文字教材',
        supplementary_completion: 'SUP 門檻解鎖教材（補充筆記／動畫解析）',
        tutoring_resource_rate:   'TUT 輔導資源（課輔／解題影片）',
      };
      const metricName = labelMap[f.metric] ?? f.metric;
      const threshold  = f.threshold_pct;
      const failPct    = (f.ratio_in_fail_group * 100).toFixed(0);
      const passPct    = (f.ratio_in_pass_group * 100).toFixed(0);
      const failAbove  = 100 - Number(failPct);
      const gapPct     = (Number(failPct) - Number(passPct)).toFixed(0);

      const body =
        `🔎 門檻定義：完成率低於 ${threshold}% 即視為「未達標」。\n\n` +
        `📊 不及格組：有 ${failPct}% 的不及格學生完成率低於 ${threshold}%，` +
        `也就是說這群學生中，每 100 人就有約 ${failPct} 人未達標，` +
        `僅 ${failAbove} 人有完成到門檻以上。\n\n` +
        `📊 及格組：也有 ${passPct}% 的及格學生完成率低於 ${threshold}%，` +
        `代表及格組同樣有 ${passPct} 人未達標（但比例遠低於不及格組）。\n\n` +
        `💡 解讀：兩組都有人低於門檻，但不及格組的比例（${failPct}%）遠高於及格組（${passPct}%），` +
        `差距 ${gapPct} 個百分點，顯示「${metricName}不足」是不及格的顯著風險因子。`;

      flags.push({
        icon: '⚠️', title: `${metricName} 完成率偏低警示（門檻：${threshold}%）`,
        body, color: '#e74c3c', multiline: true,
      });
    });

    const czw = td?.available ? td.consecutive_zero_weeks : null;
    if (czw?.fail_group_median >= 2) {
      const failMed = czw.fail_group_median;
      const passMed = czw.pass_group_median ?? 0;
      const diff    = failMed - passMed;
      const body =
        `🔎 「連續零活動週」是指學生連續數週完全沒有任何學習記錄（登入、閱讀、作答等均為零）。\n\n` +
        `📊 不及格組：中位數為 ${failMed} 週，代表有一半以上的不及格學生，整學期累計有至少 ${failMed} 週完全沒有學習活動。\n\n` +
        `📊 及格組：中位數為 ${passMed} 週，比不及格組少約 ${diff} 週的停擺期，學習連續性明顯較好。\n\n` +
        `💡 解讀：「學習中斷」是不及格的重要預警信號。建議在學生連續 2 週無活動時，主動發出提醒或課輔邀請。`;
      flags.push({
        icon: '🔴', title: `學習中斷警示：不及格組平均連續停擺 ${failMed} 週（及格組僅 ${passMed} 週）`,
        body, color: '#e67e22', multiline: true,
      });
    }

    const decayFail = td?.available ? td.post_midterm_decay_rate?.fail_group_median_pct : null;
    if (decayFail != null && decayFail <= -35) {
      const absDecayFail = Math.abs(decayFail).toFixed(1);
      const absDecayPass = Math.abs(td.post_midterm_decay_rate?.pass_group_median_pct ?? 0).toFixed(1);
      const body =
        `🔎 「期中後學習衰退率」是比較每位學生「期中考後」與「期中考前」的週平均學習分鐘數，計算下降幅度（百分比）。負值代表學習量減少。\n\n` +
        `📊 不及格組：中位數衰退幅度為 ${absDecayFail}%，代表有一半以上的不及格學生，在期中考結束後學習量掉了將近 ${absDecayFail}%。這是相當顯著的學習崩潰跡象。\n\n` +
        `📊 及格組：同期衰退幅度為 ${absDecayPass}%，雖然也有下降，但幅度明顯小於不及格組。\n\n` +
        `💡 解讀：不及格組在期中考後的大幅衰退，可能反映學生「看到成績不佳後放棄」或「期中前的衝刺無法持續」。建議在期中考後主動發出個人化的學習鼓勵，並提供補救資源。`;
      flags.push({
        icon: '📉', title: `期中考後學習量大幅衰退：不及格組下降 ${absDecayFail}%（及格組僅下降 ${absDecayPass}%）`,
        body, color: '#8e44ad', multiline: true,
      });
    }

    if (!flags.length) {
      el.innerHTML = '<div style="color:var(--text-dim,#888);font-size:13px;padding:8px 0">✅ 本學期無重大紅旗警示。</div>';
      return;
    }

    el.innerHTML = `<h3 style="font-size:14px;font-weight:600;color:var(--text);margin-bottom:8px">🚩 紅旗警示</h3>` +
      flags.map(f => `
        <div style="display:flex;gap:10px;align-items:flex-start;background:var(--card-bg,#fff);
                    border-left:4px solid ${escapeHtml(f.color)};border-radius:6px;
                    padding:12px 16px;margin-bottom:12px;box-shadow:0 1px 4px rgba(0,0,0,0.08)">
          <span style="font-size:20px;line-height:1.4;flex-shrink:0">${escapeHtml(f.icon)}</span>
          <div style="min-width:0;flex:1">
            <div style="font-size:13px;font-weight:700;color:${escapeHtml(f.color)};margin-bottom:6px">${escapeHtml(f.title)}</div>
            <div style="font-size:12px;color:var(--text-mid,#555);line-height:1.75;${f.multiline ? 'white-space:pre-line' : ''}">${escapeHtml(f.body)}</div>
          </div>
        </div>`).join('');
  }

  // ── §5.6 處方性建議 ──────────────────────────────────────
  function renderPrescriptions(ps) {
    const el = document.getElementById('rPrescriptions');
    if (!el) return;
    if (!ps?.length) {
      el.innerHTML = '<div style="color:var(--text-dim,#888);font-size:13px;padding:8px 0">✅ 本學期無改善建議項目。</div>';
      return;
    }
    const severityLabel = { critical: '高優先', warning: '中優先', info: '建議' };
    const severityColor = { critical: '#e74c3c', warning: '#e67e22', info: '#3498db' };
    const FALLBACK_COLOR = '#6c757d';
    el.innerHTML = `<h3 style="font-size:14px;font-weight:600;color:var(--text);margin-bottom:8px">💡 改善建議</h3>` +
      ps.map((item, i) => {
        const sev       = String(item.severity ?? '');
        const sevColor  = severityColor[sev] ?? FALLBACK_COLOR;
        const sevLabel  = severityLabel[sev]
          ? severityLabel[sev]
          : escapeHtml(sev) || '未知';
        return `
        <div style="background:var(--card-bg,#fff);border:1px solid var(--border,#e0e0e0);
                    border-radius:8px;padding:12px 14px;margin-bottom:10px">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
            <span style="background:${sevColor};color:#fff;border-radius:4px;
                         padding:2px 8px;font-size:11px;font-weight:600">${sevLabel}</span>
            <span style="font-size:12px;color:var(--text-dim,#888)">#${i+1}</span>
          </div>
          <div style="font-size:13px;color:var(--text);margin-bottom:4px">📌 ${escapeHtml(item.finding ?? '')}</div>
          <div style="font-size:12px;color:var(--text-dim,#888)">→ ${escapeHtml(item.action ?? '')}</div>
        </div>`;
      }).join('');
  }

  // ── §6.2 PDF 匯出 ────────────────────────────────────────
  window.exportAtRiskPDF = function() {
    const style = document.createElement('style');
    style.id = '__rPrintStyle';
    style.textContent = `
      @media print {
        body > *:not(#panelR) { display: none !important; }
        #panelR { display: block !important; }
        #rLoading, #rNoData { display: none !important; }
        #rContent { display: block !important; }
        .tab-bar, header, #panelR button { display: none !important; }
        canvas { max-width: 100% !important; }
      }`;
    document.head.appendChild(style);
    window.print();
    setTimeout(() => document.getElementById('__rPrintStyle')?.remove(), 1000);
  };

  // ── 雷達圖說明 popover toggle ────────────────────────────
  window.toggleRRadarInfo = function(e) {
    e.stopPropagation();
    document.getElementById('rRadarInfoPanel')?.classList.toggle('open');
  };

  // ── bStats 說明彈出面板 ──────────────────────────────────
  window.toggleBStatsHelp = function(e) {
    e.stopPropagation();
    const panel = document.getElementById('bStatsHelpPanel');
    if (!panel) return;
    panel.style.display = panel.style.display === 'none' ? '' : 'none';
  };

  document.addEventListener('click', function(e) {
    // bStats 說明面板：點外部關閉
    const bPanel = document.getElementById('bStatsHelpPanel');
    const bBtn   = document.getElementById('bStatsHelpBtn');
    if (bPanel && bPanel.style.display !== 'none' &&
        !bPanel.contains(e.target) && e.target !== bBtn) {
      bPanel.style.display = 'none';
    }
    // 雷達圖說明 popover：點外部關閉
    const rPanel = document.getElementById('rRadarInfoPanel');
    const rBtn   = document.getElementById('rRadarInfoBtn');
    if (rPanel && rPanel.classList.contains('open') &&
        !rPanel.contains(e.target) && e.target !== rBtn) {
      rPanel.classList.remove('open');
    }
  });

  // ── 主要初始化（lazyInit 模式） ──────────────────────────
  async function lazyInit() {
    if (_initialized) {
      requestAnimationFrame(() => {
        ['rRadarChart', 'rTemporalChart'].forEach(id => {
          const c = document.getElementById(id);
          if (c) { const inst = Chart.getChart(c); if (inst) { inst.resize(); inst.update('none'); } }
        });
      });
      return;
    }

    const rLoading = document.getElementById('rLoading');
    const rNoData  = document.getElementById('rNoData');
    const rContent = document.getElementById('rContent');

    if (!rLoading || !rNoData || !rContent) return;

    rLoading.style.display  = '';
    rNoData.style.display   = 'none';
    rContent.style.display  = 'none';

    try {
      const res = await fetch(DATA_PATH, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      _data = await res.json();

      if (!_data.schema_version || parseFloat(_data.schema_version) < 2.0) {
        throw new Error(
          `at_risk_profile.json schema_version 不相容（需 ≥ 2.0，實際 ${_data.schema_version ?? 'unknown'}）。請重新執行 ETL。`
        );
      }

      // schema 3.0：多學期結構
      if (parseFloat(_data.schema_version) >= 3.0 && _data.by_semester) {
        const sems = _data.available_semesters ?? Object.keys(_data.by_semester);
        const def  = _data.default_semester ?? sems[sems.length - 1];
        _currentSem     = def;
        _currentSemData = _data.by_semester[def];

        renderSemesterFilter(sems, def);
        renderCohortSummary(_currentSemData.cohort_summary);
        renderRadarChart(_currentSemData.metrics_comparison);
        renderTemporalChart(_currentSemData.temporal_decay);
        renderRedFlags(_currentSemData.behavioral_markers, _currentSemData.temporal_decay);
        renderPrescriptions(_currentSemData.prescriptive_summary);

      // schema 2.x：降級單學期
      } else {
        renderCohortSummary(_data.cohort_summary);
        renderRadarChart(_data.metrics_comparison);
        renderTemporalChart(_data.temporal_decay);
        renderRedFlags(_data.behavioral_markers, _data.temporal_decay);
        renderPrescriptions(_data.prescriptive_summary);
      }

      rLoading.style.display  = 'none';
      rContent.style.display  = '';
      _initialized = true;

    } catch(e) {
      rLoading.style.display  = 'none';
      if (rNoData) {
        rNoData.style.display   = '';
        const msgEl = document.getElementById('rNoDataMsg');
        if (msgEl) msgEl.textContent = `無法載入報告資料：${e.message}`;
      }
      console.error('[AtRiskReportManager] 初始化失敗', e);
    }
  }

  // ── 公開 API ─────────────────────────────────────────────
  return {
    lazyInit,
    filterRadar,
    switchSemester,
    reRenderRadar: () => {
      const mc = _currentSemData?.metrics_comparison ?? _data?.metrics_comparison;
      if (mc) renderRadarChart(mc);
    },
  };
})();
