# 3D CCTV 編輯器 V2.7

正式環境：
- GitHub Repository: https://github.com/Oscar86tw/3D_CCTV
- GitHub Pages: https://oscar86tw.github.io/3D_CCTV/
- Google Sheets: https://docs.google.com/spreadsheets/d/1iFo_ssShGpADOEj2D5ItF5FAYaoJclyrSXo1k61YXl0/edit?usp=sharing
- Apps Script: https://script.google.com/macros/s/AKfycbzXV-NHwpmjzscmfBbcnu0gK2KSsEm3ANS-dW9wZu85dFbKLQaQRInNiVwwOF9NxjtWiQ/exec
- Google Drive: https://drive.google.com/drive/folders/14XSbHur93Q_RmNas8gcfBsRNVGO_OhPR?usp=drive_link

V2.7 新增 Google Drive 雲端專案儲存與開啟。
雲端方法：JSONP 讀取 + 隱藏 Form POST + JSONP 輪詢確認 + Drive `.cctv3d` 實體檔。

工作流程：建立專案 → 建立樓層 → 匯入圖面 → 配置 CCTV → 標記 → 按「儲存」同步本機與 Google Drive。

## V2.7 雲端連線修正
- HTML / CSS / app.js / config.js 全部加入版本 cache-busting，避免 GitHub Pages 顯示 V2.7 HTML 卻仍執行瀏覽器快取的舊 app.js。
- 首次連線直接使用 config.js 已指定的正式 Apps Script /exec，不再先等待 Google Sheets B1。
- B1 保留作為備援來源。
- 首頁雲端區加入明確的「連線中 / 已連線 / 連線失敗」狀態。
- 失敗時顯示實際 API URL、前端版本與錯誤資訊。
- 新增「重新測試」與「複製診斷」。
- Apps Script API 版本升至 2.2，新增 diagnostics action。

## V2.7｜設定表 B2 修正
正式設定改為：
- B1：EXCEL
- B2：APPS SCRIPT /exec
- B3：Google Drive 儲存路徑
- B4：GitHub Server

前端 `config.js` 已改用 B2 作為 Apps Script API 設定儲存格，正式 `/exec` 也更新為：
https://script.google.com/macros/s/AKfycbwEbJjX96-JAdKmlUW5TBDpuQ_Aocqt19SYbg4bb0P8S-lnmjN_lmK_zMMecjH5Rm20-Q/exec

重要：`setup()` 不再覆蓋 B1，避免把 EXCEL 連結改掉。

## V2.7｜雲端專案開啟進度顯示
- 點「開啟專案」後會顯示中央進度視窗，不再只有按鈕沒有反應。
- 顯示 6 個步驟：
  1. 確認 Apps Script 連線
  2. 取得 Google Drive 專案
  3. 分段下載
  4. JSON 組合 / 解析
  5. 建立 IndexedDB 本機快取
  6. 建立 3D 場景
- 顯示百分比、已讀取大小 / 總大小、經過時間、目前第幾段。
- 可取消讀取。
- 發生錯誤時視窗會停留在錯誤步驟，不會只跳一個看不到過程的 alert。
- 分段大小由 100KB 提高到約 400KB，減少 Apps Script 往返次數，加速大型平面圖專案。

## V2.7｜環境 + 監視器
- 環境：牆體、柱子、汽車、機車、停車格。
- 環境物件可拖曳、旋轉、固定、隱藏，並可設定是否遮擋監視器。
- 監視器：2.8 / 3.6 / 4 / 6 / 8mm、方向、距離、高度、狀態、固定、視野、備註。
- 焦段切換會自動帶入建議距離。
- 原建置 / 增設 / 故障狀態圖例與數量。
- FOV 依牆體、柱子、汽車、機車做 2D 遮擋裁切。

## V2.7｜連續牆體 + 舊版監視器外觀
### 牆體
- 恢復舊版連續牆體繪製方式。
- 點「＋牆體」後：
  1. 點第一點開始。
  2. 依序點選轉角。
  3. 點回第一點（約 20px 內）會自動封閉並完成牆體。
  4. 不封閉時按 Enter，完成開放式牆體。
  5. Esc 取消。
- 繪製中顯示橘色路徑與節點，第一點以藍色顯示。
- 完成後直接產生有高度與厚度的 3D 連續牆面。
- 連續牆體可以整體拖曳；右側可改高度、厚度、固定、隱藏、是否遮擋鏡頭。

### 監視器
- 監視器模組外觀改回 V1.10 類型：
  - 完整機身
  - 前端鏡頭
  - 鏡片
  - 支柱
  - 圓形底座
- 保留 V2.5 的焦段、方向、距離、狀態分類與遮擋 FOV。

## V2.7｜增設鏡頭星星 + 鏡頭配置報告
### 增設鏡頭提示
- 狀態為「增設」的鏡頭，上方 7m 顯示黃色五角星。
- 星星永遠朝向觀看鏡頭，避免轉視角後看不到。
- 星星會閃爍、呼吸放大縮小，沿用之前的「無敵星星」提示概念。
- 星星下方有黃色虛線，指向該新增鏡頭。
- 原建置 / 故障鏡頭不顯示星星。

### 輸出鏡頭配置報告
- 「報告 → 輸出鏡頭配置報告」正式啟用。
- 可選：
  - 目前樓層
  - 全部樓層
- 可加入目前 3D 畫面截圖。
- 報告統計：總鏡頭、原建置、增設、故障。
- 每層列出鏡頭名稱、狀態、焦段、有效距離、方向、安裝高度、固定、備註。
- 可列出標記 / 說明。
- 以瀏覽器列印功能直接「另存為 PDF」。


## V2.8｜指定工業型鏡頭模組 + 鏡頭前端視野起點
- 監視器外觀改為使用者指定的工業型戶外 CCTV 造型。
- 模組包含：護罩、方形前框、多層鏡頭、玻璃鏡片、轉軸支架、立柱、圓形固定底座與螺栓細節。
- 鏡頭視野的 3D 半透明光束從鏡頭玻璃前端射出。
- 平面 FOV / 遮擋演算起點同步前移到鏡頭前端，不再從底座中心展開。
- 保留增設鏡頭 7m 黃色閃爍星星、連續牆體、環境遮擋與鏡頭配置報告。
- 前端可見版本、快取 query、config.js、Apps Script API 均同步為 V2.8。


## V2.10｜鏡頭方向修正 + 取消透明立體光束
- 修正指定工業型監視器模組與 FOV 視野方向相反的問題。
- 監視器模型相對 V2.8 旋轉 180°，使鏡頭正面與地面視野 / 遮擋分析方向一致。
- 移除鏡頭前方額外的半透明白／藍色 3D 光束。
- 保留地面 FOV 覆蓋範圍、焦段、遮擋裁切、增設黃色星星等功能。


## V2.10｜完整鏡頭視野 + 牆體預設固定
- 鏡頭地面 FOV 改為完整扇形，不再被牆體、柱子、汽車、機車裁切。
- 視野由鏡頭前端開始，保留焦段 / 方向 / 距離設定。
- 新增完整外框線，視野邊界更清楚。
- 新建立的連續牆體預設為「固定」。
- 單段牆體若建立，預設也為「固定」。
- 其他環境物件（柱子、汽車、機車、停車格）仍維持可移動。
