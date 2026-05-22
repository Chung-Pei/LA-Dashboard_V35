/**
 * frame-guard.js
 * Clickjacking 防護 — GitHub Pages 替代方案
 *
 * GitHub Pages 不支援自訂 HTTP headers，
 * 無法設定 Content-Security-Policy: frame-ancestors 或 X-Frame-Options。
 * 本腳本同步執行（index.html 中無 defer），在 <body> 渲染前偵測 iframe 嵌入。
 *
 * 行為：
 *   同域 iframe → 強制導向至頂層視窗（等效 X-Frame-Options: SAMEORIGIN）
 *   跨域 iframe → 隱藏整個頁面內容（防止 UI redressing 攻擊）
 */
(function frameGuard() {
  'use strict';
  if (window.self === window.top) return; // 正常情況：不在 iframe 中，直接結束

  try {
    // 嘗試存取 window.top.location
    // 同域 iframe：可存取，重定向至頂層
    window.top.location.replace(window.self.location.href);
  } catch (e) {
    // 跨域 iframe：SecurityError — 禁止存取 top.location
    // 立即隱藏頁面，防止攻擊者透過視覺疊加誘導使用者點擊
    document.documentElement.style.setProperty('visibility', 'hidden', 'important');
    document.documentElement.style.setProperty('display', 'none', 'important');
  }
}());
