// 代码版本（和 manifest.json 的 version 保持一致，有单测检查）。
// 排版页用它确认后台 service worker 是不是同一版：扩展文件更新后，页面刷新就是新代码，
// 但后台要在 chrome://extensions 重新加载才会换，两边对不上时打印会失败。
export const CODE_VERSION = '0.3.3';
