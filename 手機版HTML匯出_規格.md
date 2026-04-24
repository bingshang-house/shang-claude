# 手機版 HTML 匯出功能規格

**所屬專案**：house-profile.html 延伸功能
**狀態**：🟢 2026-04-24 完工（commits dfccbde → 3e21861，6 個 commit）
**規格確認日**：2026-04-24
**完工日**：2026-04-24（同日完成）
**實際工時**：約 2.5 hr（比預估 5-7 hr 快，因選擇 clone DOM 而非手工模板）

---

## 一、為什麼做這個

夥伴在外面帶看時用手機看 A4 銷售資料表會**格式跑掉**（Excel 在手機 App 顯示不好看）。做一個響應式 HTML 檔，手機打開就能直接讀、存下來離線也能用。

同時產出兩份：**專員版**（含聯絡資訊，夥伴內部用）、**無名版**（給客戶看，隱去聯絡電話）。

---

## 二、賞哥已確認的規格

| 項目 | 決定 |
|---|---|
| **圖片處理** | Google Static Maps API 截靜態地圖 + 地籍 SVG 轉 PNG，全部 base64 嵌入（離線可看，如同 PDF） |
| **檔名** | `{案件名稱}_專員版.html` / `{案件名稱}_無名版.html` |
| **手機版型** | ≤768px 單欄直式；桌面維持雙欄 A4 風格 |
| **按鈕位置** | 現有 Excel 按鈕旁 |
| **按鈕文字** | 「📱 儲存成手機版（2 份）」— 一鍵生兩份下載 |
| **專員版上方** | 「專員 名字　電話 XXX　｜　店長 江炳賞」（店長不帶電話，沿用現有邏輯） |
| **無名版上方** | 完全移除聯絡列 |
| **兩版底部** | 都保留公司資訊「賞好賞不動產有限公司｜高雄市苓雅區中華四路122號｜經紀人：江炳賞 114年高市字第01680號」（法定字號必留） |

## 附帶：Excel 檔名預設修改

**兩個 Excel 按鈕都改**：

| 按鈕 | 舊檔名 | 新檔名 |
|---|---|---|
| 📊 下載 Excel（CS 範本） | `合約名-物件地址.xlsx` | `{案件名稱}-{物件地址}-{專員名}.xlsx` |
| 📄 下載 A4 銷售表 Excel | `案件名_日期.xlsx` | `{案件名稱}-{物件地址}-{專員名}.xlsx` |

若專員名為空 → 檔名變成 `{案件名稱}-{物件地址}.xlsx`（最後一節省略）
若案件名/地址均空 → fallback 到預設名稱

---

## 三、實作任務清單（按順序）✅ 全部完成 2026-04-24

### A. 手機版 HTML 匯出 ✅

- [x] 1. HTML 按鈕新增「📱 儲存成手機版（2 份）」（Excel 按鈕旁）
- [x] 2. 寫 `exportMobileHtml(mode)` 函式，參數 `'agent'` / `'anon'`
- [x] 3. 組裝響應式 HTML：改採 **clone `.a4-card` DOM + inline 全站 CSS**（比手工模板好維護）
- [x] 4. 圖片處理：
  - [x] Google Static Maps API 截位置圖 → base64
  - [x] **位置圖外層包 `<a href="google maps search">` 點圖跳 Google Maps**（新增，規格沒寫）
  - [ ] ~~嫌惡設施地圖 Static Maps with markers~~（本輪沒做；A4 裡沒獨立地圖元件，後續要可另加）
  - [x] 地籍圖 SVG → Canvas 2x → PNG base64
  - [x] 格局圖（用戶上傳）已是 base64 保留
- [x] 5. 聯絡列條件渲染（`mode === 'anon'` 移除 `#out-contact`）
- [x] 6. 底部公司資訊兩版都保留
- [x] 7. 一鍵按鈕 `exportMobileHtmlBoth()` 連續呼叫兩次（sleep 400ms 避免瀏覽器擋連續下載）
- [x] 8. 檔名簡化為 `專員版.html` / `無名版.html`（賞哥要求，原規格 `{案件}_專員版.html` 太長）

### B. Excel 檔名預設修改 ✅

- [x] 9. `downloadCaseStudyXlsx` 改用 `buildDownloadFileName('xlsx')`
- [x] 10. `downloadA4Xlsx` 改用同一 helper
- [x] 11. 統一 `{案件名稱}-{物件地址}-{專員名}.xlsx`，空值往前 fallback

---

## 四、驗收標準（上線後賞哥要走一遍）

1. A4 預覽填妥資料 → 點「📱 儲存成手機版（2 份）」
2. 瀏覽器同時下載 2 個檔：`XX_專員版.html`、`XX_無名版.html`
3. 手機打開專員版 → 版面單欄、圖片都顯示、上方看到「專員/店長」
4. 手機打開無名版 → 版面單欄、圖片都顯示、**上方沒有任何聯絡列**，底部有公司資訊
5. 桌面瀏覽器打開 → 維持雙欄 A4 版面
6. 關閉網路重開 HTML → 圖片仍顯示（base64 嵌入成功）
7. Excel 下載檔名為 `XX案-XX路-XX專員.xlsx` 格式

---

## 五、技術注意點（開工時回來看）

- Static Maps API 走既有 Google Maps API key（已啟用），計費走付費帳號，每月用量應該遠低於免費額度
- Static Maps 的 URL 長度有限制（8192 字元），嫌惡設施 marker 過多時要拆多張或用 path 簡化
- 圖片 base64 會讓 HTML 檔變大到 1-2 MB，提醒：LINE 傳檔上限 300 MB，夠用
- `document.execCommand('saveAs')` 已 deprecated，用 `Blob + URL.createObjectURL + a.download` 下載
- SVG → Canvas 要等 image.onload 完成才能 toDataURL，`Promise` 包起來

---

## 六、下次接手指引

1. **看這份規格**：賞哥已確認所有細節，規格書就是 source of truth
2. **依任務清單順序開工**，每完成一個階段（A 或 B）commit + push 讓賞哥驗收
3. 地圖截圖部分可以先獨立寫個測試函式 `testStaticMap(lat, lng)` 驗證 Static Maps API 回傳 OK，再整合進匯出流程
4. 手機版設計參考 A4 原版面的視覺層次，但砍掉不必要的裝飾（例如印章樣式的標題底色可以淡化，手機看太花）
