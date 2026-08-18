# 小卡櫃 照片儲存（Cloudflare Worker + R2）

Firebase Cloud Storage 在較新的專案需要綁定付費方案，所以照片改放 Cloudflare R2：
**10GB 免費、不收流量費**，額度用完只會停止服務、不會產生帳單。

## 它怎麼保護資料

沒有另外一套帳號。用戶端把 App 既有的 **Firebase ID token** 帶上來，Worker 用
Google 的公開金鑰驗證簽章、發行者與 audience，再從**驗證過的 `sub`**（也就是 uid）
決定能存取哪個路徑。

**uid 永遠來自權杖，不來自網址** —— 所以拿著自己合法權杖的人也讀不到別人的照片。

## API

| 方法 | 路徑 | 說明 |
| --- | --- | --- |
| `GET` | `/photos` | 列出自己已上傳的照片 id（用來跟本機比對差異） |
| `PUT` | `/photos/:id` | 上傳原圖 |
| `PUT` | `/photos/:id/thumb` | 上傳縮圖 |
| `GET` | `/photos/:id` | 下載原圖 |
| `GET` | `/photos/:id/thumb` | 下載縮圖 |
| `DELETE` | `/photos/:id` | 刪除 |

全部都需要 `Authorization: Bearer <Firebase ID token>`。

## 部署

```bash
cd worker
npm install
npx wrangler login          # 開瀏覽器授權你的 Cloudflare 帳號
npx wrangler r2 bucket create poca-box-photos
npx wrangler deploy
```

部署後會得到一個 `https://poca-box-photos.<你的帳號>.workers.dev` 網址，
把它填進 App 的 `src/data/sync/photoStore.ts`。

## 本機測試

```bash
npx wrangler dev --local
```

`--local` 會用本機模擬的 R2，不會碰到真的 bucket。
