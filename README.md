# 小卡櫃 · K-pop 小卡收藏管理

在 **iPhone、iPad、PC 上都能用**的小卡收藏管理 App。一份程式碼、三個平台，不需要 App Store 審核，也不需要 Apple 開發者帳號。

**所有小卡資料與照片都只存在你自己的裝置上**，不會上傳到任何伺服器。

---

## 安裝到你的裝置

網頁本身是一般網址，用瀏覽器開啟就能用；但**安裝到主畫面**才會變成有 icon、全螢幕、可離線開啟的獨立 App，而且能大幅降低系統清除資料的機率（見下方「重要」）。

| 裝置 | 步驟 |
| --- | --- |
| **iPhone / iPad** | 用 **Safari** 開啟網址 → 點下方（或右上）的「分享」<kbd>􀈂</kbd> → 往下找到 **加入主畫面** → 加入 |
| **Windows / Mac（Chrome / Edge）** | 開啟網址 → 點網址列右側的「安裝」圖示 <kbd>⊕</kbd>，或選單 → **安裝「小卡櫃」** |
| **Android** | Chrome 開啟網址 → 選單 → **安裝應用程式** |

> iPhone 與 iPad 必須用 **Safari** 安裝，Chrome for iOS 沒有「加入主畫面」的 PWA 支援。

### ⚠️ 重要：請定期匯出備份

資料存在瀏覽器的本機資料庫裡。iOS Safari 對「**沒有安裝到主畫面**、又長期沒開啟」的網站，可能會清除其本機資料。App 已經做了兩層防護：

1. 啟動時自動申請「持久化儲存」授權（`navigator.storage.persist()`）；
2. 設定頁會在沒拿到授權時顯示提醒。

但真正的保險是**設定 → 匯出備份**，會下載一個 `pocabox-backup-日期.zip`（包含所有資料與照片）。請定期匯出，存到 iCloud、Google Drive 或電腦裡。

---

## 功能

- **小卡資料**：名稱、收藏時間、來源、團體、成員、專輯／活動出處、卡種、持有狀態、取得價格與幣別、自由備註
- **正面 + 背面照片**：列表顯示正面，詳情頁可點擊翻面。上傳時自動壓縮（可在設定調整品質）
- **完全自訂的分類**：來源、卡種、持有狀態、團體、成員、專輯都能自己新增。**在新增小卡的表單裡直接打一個不存在的名字就能當場建立**，不用先跑去設定頁
- **三種歸檔方式**
  - 卡片牆 + 多維度篩選與搜尋（篩選條件會寫進網址，回上一頁不會消失）
  - 團體 → 成員階層瀏覽
  - 自訂收藏夾，一張小卡可同時屬於多個收藏夾
- **團體全員套卡**：選團體即自動依成員產生格位，自動計算 `已收集 / 總數` 進度並列出還缺誰
- **備份與跨裝置搬移**：匯出／匯入 zip，匯入時可選「合併」或「完全覆蓋」
- **離線可用**、深色／淺色主題

### 跨裝置怎麼同步？

目前是**本機優先**：資料留在各自的裝置上，跨裝置搬移用備份 zip（在 A 裝置匯出 → 傳到 B 裝置 → 用「合併」模式匯入）。

資料層已經為之後接雲端同步預留好了 —— 每筆資料都有 UUID、`updatedAt` 與軟刪除標記，且所有讀寫都收斂在 `src/data/repo.ts` 這一個入口。要加雲端同步時，是在 `repo.ts` 後面接一個遠端 adapter，畫面程式碼不用改。

---

## 開發

```bash
npm install
npm run dev        # http://localhost:5173

npm run build      # 型別檢查 + 打包到 dist/
npm run preview    # 用正式打包的結果啟動，可驗證 Service Worker 與離線
npm run typecheck

npm run build:single   # 打包成單一 HTML 檔（dist-single/pocabox.html）
```

### 技術

| 層 | 使用 |
| --- | --- |
| 建置 | Vite + React + TypeScript |
| 樣式 | Tailwind CSS v4（CSS-first 設定，主題色以 CSS 變數切換） |
| 路由 | React Router，HashRouter（GitHub Pages 是純靜態，無法 rewrite 路徑） |
| 本機資料庫 | Dexie（IndexedDB），照片以 Blob 存放 |
| 圖片處理 | browser-image-compression（壓成 WebP，另存一份縮圖給列表用） |
| 備份 | fflate |
| PWA | vite-plugin-pwa（Workbox） |

### 目錄

```
src/
├── data/          資料層：schema、repo（唯一資料入口）、照片、備份
├── features/      各功能頁面：cards / groups / folders / sets / settings
├── components/    共用 UI
└── lib/           小工具（id、格式化、主題）
```

### 更新既有安裝的資料（重要）

小卡資料存在使用者裝置的 IndexedDB 裡，更新 App 不會碰到它。但**改變資料形狀**時就必須走遷移流程，否則舊資料會用新程式碼讀出錯誤的結果。

分工是：

| 改了什麼 | 要做什麼 |
| --- | --- |
| 只加一個非索引欄位（例如評分） | **什麼都不用做**。IndexedDB 存整個物件，舊資料讀起來就是 `undefined` |
| 加索引或新資料表 | 在 `src/data/db.ts` **新增** `this.version(n).stores({...})`，不要改舊的 |
| 改變既有欄位的意義、改名、換編碼 | 在 `src/data/migrations.ts` 把 `DATA_VERSION` +1，並**附加一個** `MIGRATIONS` 步驟 |

`migrations.ts` 的三條規則：

1. 一個版本一個步驟，**永遠只附加、不修改既有步驟** —— 一定有人還停在前一版。
2. 步驟是對純物件的純函式（不碰 Dexie、不碰 Blob），所以同一份邏輯同時用在啟動時的本機資料和匯入的舊備份上，兩條路徑不可能走歪。
3. 步驟必須可重複執行且防禦性強 —— 它會看到任何舊版寫出來的資料，包含欄位整個不存在的。

安全網（都已實作，不需額外處理）：

- 遷移前會自動把當時的資料存進 `settings`，設定頁出現「升級前的自動備份」讓使用者下載成一般備份檔。**使用者不必事先手動備份也救得回來。**
- 遷移在單一 Dexie transaction 內完成，失敗就整批回滾，不會留下半升級狀態。
- 比本機更新的資料（例如部署被回退）只會被讀取、不會被改寫。
- 匯入備份時，比 App 新的檔案會被擋下並顯示原因；比 App 舊的檔案會先跑遷移再寫入。

改完務必用 `scripts/` 外的 Playwright 腳本實測「舊版建資料 → 換新版 → 資料完好」，不要只靠推論。

### 部署

推到 `main` 時，`.github/workflows/deploy.yml` 會自動打包並發佈到 GitHub Pages。

第一次使用前，請到 repo 的 **Settings → Pages → Source** 選擇 **GitHub Actions**。

網址是 <https://shadow0u0.github.io/poca-box/>。資源使用相對路徑，所以 repo 改名或改部署到
網域根目錄都不會讓網站失效；真的需要固定前綴時可在建置時指定 `BASE_PATH`：

```bash
BASE_PATH=/ npm run build
```
