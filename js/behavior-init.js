// ══════════════════════════════════════════════════════════
// behavior-init.js
// resetBehaviorFilters + BehaviorTabManager 懶載入協調器
// 依賴：tab-behavior-radar.js / tab-behavior-time.js /
//       tab-behavior-correlation.js（均以 defer 先行載入）
// ══════════════════════════════════════════════════════════

// ── 清除條件：各分頁獨立 try/catch 確保互不影響 ──────────
function resetBehaviorFilters() {
  try {
    if (typeof BehaviorRadarTab !== 'undefined' &&
        typeof BehaviorRadarTab.resetFilters === 'function')
      BehaviorRadarTab.resetFilters();
  } catch(e) { console.error('[resetBehaviorFilters] radar:', e); }

  try {
    if (typeof BehaviorTimeTab !== 'undefined' &&
        typeof BehaviorTimeTab.resetFilters === 'function')
      BehaviorTimeTab.resetFilters();
  } catch(e) { console.error('[resetBehaviorFilters] time:', e); }

  try {
    if (typeof BehaviorCorrelationTab !== 'undefined' &&
        typeof BehaviorCorrelationTab.resetFilters === 'function')
      BehaviorCorrelationTab.resetFilters();
  } catch(e) { console.error('[resetBehaviorFilters] correlation:', e); }
}

// ── BehaviorTabManager：懶載入協調器 ────────────────────
const BehaviorTabManager = (() => {
  const _init    = { radar: false, correlation: false, time: false };
  // BUG-R5-BI-1 FIX: _loading flag prevents concurrent lazyInit invocations
  // (two rapid clicks both passed `if (_init.radar)` before first resolved)
  let   _loading = false;

  // ── Helper: safe HTML-escape for error messages ──────
  function _safeMsg(e) {
    const raw = String(e?.message ?? e ?? '未知錯誤');
    return typeof escapeHtml === 'function'
      ? escapeHtml(raw)
      : raw.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ── Helper: show error banner inside a container element ──
  function _showSubError(containerId, label) {
    const el = document.getElementById(containerId);
    if (!el) return;
    // Avoid duplicate banners on retry
    if (el.querySelector('.btm-err-banner')) return;
    const div = document.createElement('div');
    div.className = 'btm-err-banner';
    div.style.cssText = 'color:#c0392b;font-size:0.85rem;margin-top:8px;padding:6px 10px;' +
                        'background:rgba(192,57,43,0.08);border-radius:6px;border:1px solid rgba(192,57,43,0.2)';
    div.textContent = `⚠️ ${label} 載入失敗，請重新整理頁面。`;
    el.prepend(div);
  }

  function _setSubBtn(sub) {
    document.querySelectorAll('#behaviorSubTabs .behavior-sub-btn').forEach(b => {
      const active = b.dataset.sub === sub;
      b.style.background = active ? 'var(--accent,#3498db)' : 'transparent';
      b.style.color      = active ? '#fff' : 'var(--accent,#3498db)';
    });
  }

  // BUG-R5-BI-1 FIX: guard with _loading to prevent concurrent double-init
  async function lazyInit() {
    if (_init.radar || _loading) return;
    _loading = true;
    const overlay = document.getElementById('behaviorLoadingOverlay');
    if (overlay) overlay.style.display = 'flex';
    try {
      // BUG-R5-BI-4 FIX: guard BehaviorRadarTab existence before calling
      if (typeof BehaviorRadarTab === 'undefined' || typeof BehaviorRadarTab.init !== 'function')
        throw new Error('BehaviorRadarTab 模組未載入，請確認 tab-behavior-radar.js 已正確引入。');
      await BehaviorRadarTab.init('radarChart', 'radarControls');
      BehaviorRadarTab.renderClusterSummary('clusterSummaryCards');
      _init.radar = true;
      // 重新掛載說明與放大按鈕（behavior 模組完成後 DOM 更新）
      if (typeof attachInfoButtons === 'function')        attachInfoButtons();
      if (typeof attachChartExpandButtons === 'function') attachChartExpandButtons();
      // 自動帶入行為資料的課程名稱
      if (typeof autoFillSubjectFromBehavior === 'function')
        autoFillSubjectFromBehavior().catch(() => {});
    } catch (e) {
      console.error('[BehaviorTabManager] lazyInit:', e);
      const el = document.getElementById('tab-behavior');
      if (el) {
        if (!el.querySelector('.btm-err-banner')) {
          const div = document.createElement('div');
          div.className = 'btm-err-banner';
          div.style.cssText = 'color:#c0392b;font-size:0.85rem;margin-top:8px';
          div.textContent = `⚠️ 資料載入失敗：${_safeMsg(e)}`;
          el.prepend(div);
        }
      }
    } finally {
      _loading = false;
      if (overlay) overlay.style.display = 'none';
    }
  }

  // BUG-R5-BI-3 FIX: removed unused `btn` parameter
  // BUG-R5-BI-4 FIX: guard BehaviorCorrelationTab/BehaviorTimeTab existence
  // BUG-R5-BI-2 FIX: show user-visible error in sub-pane on init failure
  async function switchSub(sub) {
    _setSubBtn(sub);
    document.querySelectorAll('.behavior-sub-pane').forEach(p => {
      p.style.display = p.id === `sub-${sub}` ? '' : 'none';
    });
    let didInit = false;

    if (sub === 'correlation' && !_init.correlation) {
      if (typeof BehaviorCorrelationTab === 'undefined' ||
          typeof BehaviorCorrelationTab.init !== 'function') {
        console.error('[BehaviorTabManager] BehaviorCorrelationTab 模組未載入');
        _showSubError('corrHeatmap', '相關性分析');
      } else {
        try {
          await BehaviorCorrelationTab.init('corrHeatmap', 'scatterSection');
          _init.correlation = true;
          didInit = true;
        } catch (e) {
          console.error('[BehaviorTabManager] correlation init:', e);
          _showSubError('corrHeatmap', '相關性分析');
        }
      }
    }

    if (sub === 'time' && !_init.time) {
      if (typeof BehaviorTimeTab === 'undefined' ||
          typeof BehaviorTimeTab.init !== 'function') {
        console.error('[BehaviorTabManager] BehaviorTimeTab 模組未載入');
        _showSubError('sub-time', '時間分析');
      } else {
        try {
          await BehaviorTimeTab.init();
          _init.time = true;
          didInit = true;
        } catch (e) {
          console.error('[BehaviorTabManager] time init:', e);
          _showSubError('sub-time', '時間分析');
        }
      }
    }

    if (didInit) {
      if (typeof attachInfoButtons === 'function')        attachInfoButtons();
      if (typeof attachChartExpandButtons === 'function') attachChartExpandButtons();
    }
  }

  return { lazyInit, switchSub };
})();
