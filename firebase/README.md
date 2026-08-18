# Firebase 設定

雲端同步用的規則檔。**這兩個檔案是真正保護資料的東西** —— App 裡的
`firebaseConfig` 只是專案識別碼，本來就是公開資訊，任何人打開網頁原始碼都看得到。
擋住別人讀你的小卡的，是這裡的規則。

規則的內容一句話講完：**每個人只能讀寫 `users/{自己的 uid}/` 底下的東西**，
其他路徑一律拒絕。

## 怎麼套用

Firebase 主控台改，或用 CLI：

```bash
npx firebase-tools deploy --only firestore:rules,storage --project poca-box
```

用主控台的話：
- Firestore Database → 規則 → 貼上 `firestore.rules` → 發布
- Storage → 規則 → 貼上 `storage.rules` → 發布

## ⚠️ 預設規則會過期

Firebase 建立資料庫時若選「測試模式」，預設規則是「任何人都能讀寫」，
而且**30 天後自動失效**。務必在存入任何真實資料前換成這裡的版本。
