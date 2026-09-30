# 3D CCTV 編輯器 V2.1

正式環境：
- GitHub Repository: https://github.com/Oscar86tw/3D_CCTV
- GitHub Pages: https://oscar86tw.github.io/3D_CCTV/
- Google Sheets: https://docs.google.com/spreadsheets/d/1iFo_ssShGpADOEj2D5ItF5FAYaoJclyrSXo1k61YXl0/edit?usp=sharing
- Apps Script: https://script.google.com/macros/s/AKfycbzXV-NHwpmjzscmfBbcnu0gK2KSsEm3ANS-dW9wZu85dFbKLQaQRInNiVwwOF9NxjtWiQ/exec
- Google Drive: https://drive.google.com/drive/folders/14XSbHur93Q_RmNas8gcfBsRNVGO_OhPR?usp=drive_link

V2.1 新增 Google Drive 雲端專案儲存與開啟。
雲端方法：JSONP 讀取 + 隱藏 Form POST + JSONP 輪詢確認 + Drive `.cctv3d` 實體檔。

工作流程：建立專案 → 建立樓層 → 匯入圖面 → 配置 CCTV → 標記 → 按「儲存」同步本機與 Google Drive。
