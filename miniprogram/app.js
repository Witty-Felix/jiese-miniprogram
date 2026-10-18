const { apiBaseUrlForEnv, PRODUCTION_API_BASE_URL } = require('./config.js');

function currentEnvVersion() {
  try { return wx.getAccountInfoSync?.().miniProgram?.envVersion; } catch { return undefined; }
}

App({
  globalData: {
    // 开发者工具/预览走当前可用的 Pages API，便于调试模式真机冒烟；正式版
    // 强制走可配置的备案 API 子域，避免把 Pages 域名误当成发布白名单方案。
    apiBaseUrl: apiBaseUrlForEnv(currentEnvVersion()),
    productionApiBaseUrl: PRODUCTION_API_BASE_URL,
  },
});
