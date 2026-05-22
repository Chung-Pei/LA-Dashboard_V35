/**
 * chart-registry.js
 * 統一圖表實例生命週期管理
 *
 * 解決問題：
 *   index.html charts{}、_radarChart、_scatterChart、_charts{} 三套並行，
 *   各自 destroy 邏輯分散、例外時可能洩漏 Chart 實例。
 *
 * 使用方式：
 *   // 建立圖表時
 *   ChartRegistry.destroyById('myCanvas');   // 確保先清除舊實例
 *   const chart = new Chart(...);
 *   ChartRegistry.register('myCanvas', chart);
 *
 *   // Tab 切換離開時（可選）
 *   ChartRegistry.destroyById('myCanvas');
 *
 *   // 全部清除（如頁面重置）
 *   ChartRegistry.destroyAll();
 *
 * 載入順序：必須在所有 tab-behavior-*.js 之前載入（已於 index.html 設定 defer 順序）
 */
const ChartRegistry = (() => {
  // canvasId → Chart instance
  const _instances = new Map();

  /**
   * 登記圖表實例。若同一 canvasId 已有舊實例，先銷毀再登記。
   * @param {string} canvasId
   * @param {object} chart  Chart.js 實例
   */
  function register(canvasId, chart) {
    _destroyRegistered(canvasId);   // 清除 registry 內的舊實例
    _instances.set(canvasId, chart);
  }

  /**
   * 銷毀 registry 內部追蹤的實例（不查 Chart.js 全域）
   * 供 register 內部呼叫，避免重複查詢
   */
  function _destroyRegistered(canvasId) {
    const existing = _instances.get(canvasId);
    if (existing) {
      try { existing.destroy(); } catch (_) { /* ignore */ }
      _instances.delete(canvasId);
    }
  }

  /**
   * 依 canvasId 銷毀圖表實例。
   * 同時查 Chart.js 全域（Chart.getChart），防止 registry 遺漏時產生 zombie 實例。
   * @param {string} canvasId
   */
  function destroyById(canvasId) {
    _destroyRegistered(canvasId);

    // 兜底：查 Chart.js 全域 registry（Chart.js >= 3.x 提供 Chart.getChart）
    if (typeof Chart !== "undefined" && typeof Chart.getChart === "function") {
      const fromGlobal = Chart.getChart(canvasId);
      if (fromGlobal) {
        try { fromGlobal.destroy(); } catch (_) { /* ignore */ }
      }
    }
  }

  /**
   * 銷毀所有已登記的圖表實例。
   */
  function destroyAll() {
    for (const canvasId of [..._instances.keys()]) {
      destroyById(canvasId);
    }
  }

  /**
   * 回傳目前登記中的 canvasId 清單（供 debug 用）
   */
  function list() {
    return [..._instances.keys()];
  }

  return { register, destroyById, destroyAll, list };
})();
