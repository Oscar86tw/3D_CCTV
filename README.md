# 3D CCTV 編輯器 V2.3

正式環境：
- GitHub Repository: https://github.com/Oscar86tw/3D_CCTV
- GitHub Pages: https://oscar86tw.github.io/3D_CCTV/
- Google Sheets: https://docs.google.com/spreadsheets/d/1iFo_ssShGpADOEj2D5ItF5FAYaoJclyrSXo1k61YXl0/edit?usp=sharing
- Apps Script: https://script.google.com/macros/s/AKfycbzXV-NHwpmjzscmfBbcnu0gK2KSsEm3ANS-dW9wZu85dFbKLQaQRInNiVwwOF9NxjtWiQ/exec
- Google Drive: https://drive.google.com/drive/folders/14XSbHur93Q_RmNas8gcfBsRNVGO_OhPR?usp=drive_link

V2.3 新增 Google Drive 雲端專案儲存與開啟。
雲端方法：JSONP 讀取 + 隱藏 Form POST + JSONP 輪詢確認 + Drive `.cctv3d` 實體檔。

工作流程：建立專案 → 建立樓層 → 匯入圖面 → 配置 CCTV → 標記 → 按「儲存」同步本機與 Google Drive。

## V2.3 雲端連線修正
- HTML / CSS / app.js / config.js 全部加入版本 cache-busting，避免 GitHub Pages 顯示 V2.3 HTML 卻仍執行瀏覽器快取的舊 app.js。
- 首次連線直接使用 config.js 已指定的正式 Apps Script /exec，不再先等待 Google Sheets B1。
- B1 保留作為備援來源。
- 首頁雲端區加入明確的「連線中 / 已連線 / 連線失敗」狀態。
- 失敗時顯示實際 API URL、前端版本與錯誤資訊。
- 新增「重新測試」與「複製診斷」。
- Apps Script API 版本升至 2.2，新增 diagnostics action。

## V2.3｜設定表 B2 修正
正式設定改為：
- B1：EXCEL
- B2：APPS SCRIPT /exec
- B3：Google Drive 儲存路徑
- B4：GitHub Server

前端 `config.js` 已改用 B2 作為 Apps Script API 設定儲存格，正式 `/exec` 也更新為：
https://script.google.com/macros/s/AKfycbwEbJjX96-JAdKmlUW5TBDpuQ_Aocqt19SYbg4bb0P8S-lnmjN_lmK_zMMecjH5Rm20-Q/exec

重要：`setup()` 不再覆蓋 B1，避免把 EXCEL 連結改掉。
