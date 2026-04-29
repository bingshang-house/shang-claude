# Phase 1：競品搜尋 Agent 規格書

> 屬於 `專案藍圖_雲端化與AI建議書.md` 階段 2「AI Agent 團隊」的 **Agent 1**。
> PoC 已於 2026-04-29 完成（130 → 9 筆獨立物件、含縮圖+連結+歸併），規格收斂如下。

## 0. 一句話定位

**夥伴在 house-profile.html 點「🔍 競品分析」→ Modal 選自動或自訂條件 → CF Worker 並行爬 591 + 樂屋網 → 跨平台歸併去重 → 1km 內結果以表格 + 縮圖呈現**

預期體感時間：**~30-40 秒**（兩平台並行）

---

## 1. 整體架構

```
┌────────────────────────────────────────┐
│  house-profile.html                    │
│  [🔍 競品分析] 按鈕 → Modal            │
└────────────────┬───────────────────────┘
                 │ POST /competitor-search
                 │ Body: { mode, params, subject }
                 ▼
┌────────────────────────────────────────┐
│  CF Worker: shang-competitor (新建)    │
│  ├─ 驗證白名單（沿用 shang-whitelist）  │
│  ├─ Promise.all 並行                   │
│  │  ├─ scrape591(params)               │
│  │  ├─ scrapeRakuya(params)            │
│  │  └─ geocodeSubject(subject)         │
│  ├─ 跨平台 dedup                       │
│  ├─ batchGeocode（Google Maps）         │
│  ├─ 距離過濾                            │
│  └─ 回傳 JSON                          │
└────────────────┬───────────────────────┘
                 │ Response: { items, subject, stats }
                 ▼
┌────────────────────────────────────────┐
│  house-profile.html                    │
│  渲染表格 / 卡片（含縮圖、連結）          │
└────────────────────────────────────────┘
```

---

## 2. UI 規格（house-profile.html）

### 2.1 主畫面按鈕

A4 預覽下方（或銷售資料表填寫區附近）加按鈕：

```html
<button onclick="openCompetitorModal()">🔍 競品分析</button>
```

按鈕 disable 條件（必填欄位齊全才能點）：
- 必填：地址、坪數、屋齡、建物型態
- 缺任一 → disable + tooltip 提示「請先填完物件基本資料」

### 2.2 Modal 結構

```
┌──────────────────────────────────────┐
│   🔍 競品分析                  [X]   │
├──────────────────────────────────────┤
│                                      │
│  ┌──────────────────────────────┐   │
│  │ 🤖 自動分析                   │   │
│  │ 本案 ±10 坪 / ±5 年 / 1km    │   │
│  │ [立即分析]                    │   │
│  └──────────────────────────────┘   │
│                                      │
│  ─── 或自訂條件 ───                  │
│                                      │
│  關鍵字   [_____________________]    │
│  總價區間 [____]萬 ~ [____]萬       │
│  總坪數   [____]坪 ~ [____]坪       │
│  主建坪   [____]坪 ~ [____]坪       │
│  屋齡區間 [____]年 ~ [____]年       │
│  距離     ◉ 500m   ○ 1000m          │
│                                      │
│  [🔍 開始分析]                       │
└──────────────────────────────────────┘
```

**自訂模式規則**：
- 預設**全空白**
- 任一欄空白 = 該條件不限制
- 至少要填 1 個欄位 + 距離（不然等於沒篩選）
- 距離 500m / 1000m 二選一（必選）

### 2.3 分析中 loading 狀態

點下「立即分析 / 開始分析」後：
- Modal 內按鈕變 disabled
- 顯示進度文字：
  - `0-5s` 「啟動爬蟲中...」
  - `5-15s` 「正在搜尋 591 + 樂屋網...」
  - `15-30s` 「正在計算距離與歸併同物件...」
  - `>30s` 「快好了，等下..」（避免讓夥伴覺得卡住）
- 收到結果 → Modal 關閉 → 結果區渲染表格

### 2.4 結果呈現

A4 預覽下方新增「競品分析結果」區塊：

```
┌─────────────────────────────────────────────────┐
│ 📊 競品分析（591 + 樂屋網）              [重跑]  │
│ 條件：自動分析（±10 坪 ±5 年 1km）                │
│ 統計：原始 X 筆 → 歸併 Y 筆 → 1km 內 Z 筆        │
├─────────────────────────────────────────────────┤
│  [縮圖] 富貴明園 / 瑞福路                         │
│         311m | 26.57/42.95坪 | 32y | 7F/12F      │
│         💰 1,180 萬 | 27.48 萬/坪 | ✓ 含車位     │
│         👥 4 家掛牌（591 / 樂屋）                 │
│         [看 591] [看樂屋]                         │
├─────────────────────────────────────────────────┤
│  [縮圖] ...                                      │
└─────────────────────────────────────────────────┘
```

**卡片設計**（不是表格，因為要嵌縮圖更直觀）：
- 縮圖 200x150（lazy load）
- 點縮圖：lightbox 放大
- 點「看 591 / 樂屋」：新分頁開原 listing
- 距離 badge：≤300m 紅 / 300-700m 橘 / 700-1000m 黃
- 多家掛牌數標 badge

---

## 3. Worker API 規格

### 3.1 Endpoint

```
POST https://shang-competitor.<賞哥-cf-account>.workers.dev/search
```

### 3.2 Request

```json
{
  "auth": {
    "googleEmail": "bingshang1019@gmail.com",
    "idToken": "..."
  },
  "subject": {
    "address": "高雄市前鎮區崗山南街529號",
    "communityName": "瑞祥龍邸",
    "buildingType": "大樓",
    "totalArea": 46.77,
    "mainArea": 31.49,
    "age": 32,
    "totalPrice": 1098,
    "rooms": "3房2廳2衛"
  },
  "mode": "auto",
  "params": {
    "keyword": "",
    "priceMin": null, "priceMax": null,
    "totalAreaMin": 36.77, "totalAreaMax": 56.77,
    "mainAreaMin": null, "mainAreaMax": null,
    "ageMin": 27, "ageMax": 37,
    "radiusM": 1000
  },
  "sources": ["591", "rakuya"]
}
```

`mode = "auto"` 時，Worker 端依 subject 自動填 `params`：
- `totalAreaMin = subject.totalArea - 10`
- `totalAreaMax = subject.totalArea + 10`
- `ageMin = subject.age - 5`
- `ageMax = subject.age + 5`
- `radiusM = 1000`

`mode = "custom"` 時，照前端傳入。

### 3.3 Response

```json
{
  "ok": true,
  "subject": { "lat": 22.6, "lon": 120.32, "address": "..." },
  "stats": {
    "rawCount": 130,
    "mergedCount": 68,
    "withinRadius": 9,
    "beyondRadius": 46,
    "geocodeFailed": 13,
    "elapsedMs": 28500
  },
  "items": [
    {
      "rank": 1,
      "distance": 161,
      "community": "向陽門第",
      "communityVariants": ["向陽門第", "向陽門第大樓", "崗山中街"],
      "road": "崗山中街",
      "totalArea": 41.02, "mainArea": 27.03,
      "age": 32, "floor": "1F/8F",
      "totalPrice": 998, "unitPrice": 24.33,
      "hasPark": false,
      "rooms": "4房2廳2衛",
      "agents": ["陳絲瑜", "顏河源", "..."],
      "agentCount": 8,
      "sources": ["591"],
      "imgSrc": "https://img1.591.com.tw/...",
      "links": {
        "591": "https://sale.591.com.tw/home/house/detail/2/19914411.html",
        "rakuya": null
      },
      "warningTags": ["1F", "樓店"]
    }
  ],
  "beyond": [...],
  "failed": [...]
}
```

### 3.4 認證

沿用 `shang-whitelist` Worker 的白名單機制：
1. Front-end 取得 Google Sign-in idToken
2. POST 給 shang-competitor 帶 idToken
3. Worker fetch shang-whitelist 驗證 → 拿到白名單 OK 才繼續
4. 否則 401

---

## 4. 兩平台 Parser 規格

### 4.1 591（已 PoC，可沿用）

**搜尋 URL 結構**：
```
https://sale.591.com.tw/?regionid={X}&section={Y}&shape={Z}&houseage={A}_{B}&area={C}_{D}&firstRow=0&shType=list
```

**參數對照**：
- `regionid`：高雄市 = 17（其他: 1=台北 3=新北 6=桃園 8=台中 15=台南）
- `section`：前鎮區 = 249（其他區 sectionid 待表）
- `shape`：1=公寓 / 2=電梯大樓 / 3=透天厝 / 4=別墅
- `houseage`：`25_99` 表示 25-99 年
- `area`：`41_52` 表示 41-52 坪

**翻頁**：URL 帶 firstRow 沒效果，必須 click「下一頁」span。

**Parse**：sel = `.ware-item`，每張卡 `innerText` 用 regex 抽：
- 標題：`(?:精選|置頂|NEW)\s+(.+?)\s+電梯大樓`
- 房廳衛：`(\d+)房(\d+)廳(\d+)衛`
- 權狀坪：`權狀\s*([\d.]+)\s*坪`
- 主建坪：`主建\s*([\d.]+)\s*坪`
- 屋齡：`坪\s+(\d+)\s*年\s+\d+F`
- 樓層：`(\d+(?:~\d+)?F\/\d+F)`
- 社區：`F\/\d+F\s+([^前]+?)\s+前鎮區`
- 路名：`前鎮區[\-\s]*(.+?)\s+仲介`
- 仲介：`仲介\s*(.+?)\s+\d+人瀏覽`
- 含車位：`/含車位/`
- 總價：`([\d,]+)\s*萬\s*(?:\(\s*含車位價\s*\))?\s+[\d.]+\s*萬\/坪`
- 單價：`([\d.]+)\s*萬\/坪`
- 縮圖：`img.dataset.src || img.src`
- URL：`a[href*="/home/house/detail/"]`

**詳見**：`process-591.js`（PoC 實作，CF Worker 改寫沿用此 regex）

### 4.2 樂屋網（待實作）

**搜尋 URL**：`https://www.rakuya.com.tw/sales/sales_list?...`（待踩）

**待開工的事**：
1. 用 Playwright 跑一次手動探索
2. 找到列表頁的 selector
3. 寫 parser → 同樣 schema 輸出
4. 跨平台一致 schema：兩家 parse 出 `{ community, road, totalArea, mainArea, age, floor, totalPrice, unitPrice, hasPark, agent, source: 'rakuya', href, imgSrc }`

---

## 5. 跨平台 Dedup 規則（沿用 PoC 驗證版）

### 主鍵（mergeKey）

```js
function livingFloor(f) { return (f.match(/^(\d+(?:~\d+)?)F/) || [])[1] || f; }
function mergeKey(item) {
  const fl = livingFloor(item.floor);
  const area = item.mainArea || item.totalArea;
  return `${item.road || '?'}|${fl}|${Math.round(area*2)/2}|${Math.round(item.totalPrice/10)*10}`;
}
```

**邏輯**：路名 + 居住樓層 + 主建坪四捨五入 0.5 + 總價四捨五入 10 萬

### 歸併動作

同 mergeKey 的多筆 → 合併成 1 筆：
- `agents[]`：所有仲介合併
- `prices[]`：不同開價（多家不同價）合併
- `links{ '591': ..., 'rakuya': ... }`：兩平台連結都留
- `sources[]`：標 ['591'] / ['rakuya'] / ['591','rakuya']
- `communityVariants[]`：所有社區名變體（向陽門第、向陽門第大樓、崗山中街）

### 歸併效果驗證（PoC 實證）

| 物件 | 原始 listing | 歸併後 |
|---|---|---|
| 向陽門第 1F 998 萬 | 14 | 1 |
| 富貴明園 7F 1180 萬 | 4 | 1 |
| 公園圖書館 9F 980 萬 | 7 | 1 |

→ 130 listing 歸成 9 個獨立物件（壓縮 14×）

---

## 6. Geocode 策略

### 6.1 不再用 Nominatim

PoC 用 OSM Nominatim 是省錢但慢（1 req/s）+ 13 筆 fail（「新中環」等社區查不到）。

### 6.2 改用 Google Maps Geocoding API

- 賞哥已有 API key（在 GCP）
- Rate limit 50 qps（並行打 50 個 ≤ 1 秒）
- 對台灣社區名 / 路名命中率高
- 計費：每 1000 次 $5（每月 200 美元免費額度 = 40,000 次）

### 6.3 Cache 策略

CF Worker 用 KV 存 geocode cache：
- key：`geo:${address}`
- value：`{lat, lon, ts}`
- TTL：30 天
- 命中率高（同社區會被重複搜）→ 預期 80%+ cache hit，實際 API 用量 < 月 200 次

### 6.4 查詢策略（多 fallback）

```
1. 「{社區名} {路名} 高雄市{區}」
2. 失敗 → 「{社區名} 高雄市{區}」
3. 失敗 → 「{路名} 高雄市{區}」
4. 失敗 → 標記 geocodeFailed
```

PoC 實證最有效是 fallback 2 + 3 組合。

---

## 7. 安全 / 法律

### 7.1 591 / 樂屋 ToS

- **單一夥伴單次手動觸發查單筆物件競品** = ToS 邊界內（人工查詢）
- **每天定時批量爬全市場** = 違反 ToS
- 設計上不開放 cron 自動跑、也不開後端 cache 二次發佈
- Worker 加 rate limit：同 user 5 分鐘 1 次（避免 abuse）

### 7.2 法律定位

爬到的競品**只在夥伴電腦上呈現**，不對外發布、不寫進建議書（Phase 3 建議書才用，且做匿名化處理：例「同區 30-40 年大樓 8 筆，平均單價 X 萬」，不附其他屋主物件連結 / 照片）

### 7.3 帳號白名單

走既有 shang-whitelist Worker。新建 `shang-competitor` Worker 部署時 inherit 同套權限。

---

## 8. 開發階段拆分

### Phase 1A（今天可上線玩）

- [ ] house-profile.html 加 Modal UI（純前端，可單跑測試 UI）
- [ ] CF Worker `shang-competitor` 骨架（ROUTE: /search、auth check、回 mock JSON）
- [ ] 591 爬蟲邏輯移植到 Worker（**先決定走 Browser Rendering 還是純 fetch**，要 probe 591 internal API）
- [ ] Geocode 接 Google Maps + KV cache
- [ ] Dedup + 距離過濾邏輯（沿用 process-591.js）
- [ ] 結果卡片 render（在 house-profile.html 結果區）
- [ ] 整合測試：用本案丟進去，看出來的 9 筆和今天 PoC 一致

### Phase 1B（Day 2 加樂屋網）

- [ ] Playwright 探索樂屋網列表頁結構
- [ ] 寫 rakuya parser → 同 schema 輸出
- [ ] 跨平台 dedup 加 source 標記
- [ ] UI 加「來源 591/樂屋/兩家」 badge

### Phase 1C（Day 3+ 細節 + 上線）

- [ ] 自訂模式表單驗證（至少 1 欄填、距離必選）
- [ ] 進度條 / loading 文字優化
- [ ] 縮圖 lazy load + lightbox
- [ ] rate limit 機制
- [ ] 寫 README + 給夥伴使用手冊

---

## 9. 成本估算（每月）

| 項目 | 用量假設 | 月成本 |
|---|---|---|
| CF Workers Paid Plan | 自己 + 5 夥伴 × 每天 2 次 | $5 |
| CF Workers Browser Rendering | 視 fetch 替代成功與否 | $0-5 |
| Google Maps Geocoding | KV cache 80% 命中 → 月 ~200 次 | $0（免費額度內）|
| KV 儲存 | < 100MB | $0（免費額度）|
| **總計** | | **$5-10** |

---

## 10. 效能目標

| 指標 | 目標 |
|---|---|
| 點按鈕 → 收到結果 | ≤ 40 秒 |
| 591 爬 5 頁 | ≤ 15 秒 |
| 樂屋爬 5 頁 | ≤ 15 秒（並行） |
| Geocode 60 筆（cache miss）| ≤ 5 秒 |
| 跨平台 dedup + 距離過濾 | < 1 秒 |
| 表格 render（含縮圖載入） | 2-3 秒 |

---

## 11. 已知風險 + Mitigation

| 風險 | Mitigation |
|---|---|
| 591 偵測 CF Worker IP 被擋 | Worker 加自訂 User-Agent + 帶 cookie；極端情況走 residential proxy |
| Browser Rendering 月費突破預算 | 先 probe 591 internal API，若可純 fetch 則不用 Browser Rendering |
| 樂屋網結構大改 | parser 集中在 Worker 一處，改起來快；加每日 monitoring（用 PoC 樣本當 regression test）|
| Geocode 費用爆 | KV cache 必加；同社區重複查不打 API |
| 兩平台同物件 dedup 邏輯漏 | 用 PoC 130 筆樣本當 regression test，未來加新規則前先跑 |

---

## 12. 開工 checklist（明天動工前確認）

- [ ] 賞哥 GCP Maps API key 已啟用 Geocoding API
- [ ] CF Workers Paid Plan 已升級（Browser Rendering 用得到時）
- [ ] CF KV namespace 「shang-competitor-cache」已建
- [ ] shang-whitelist Worker 確認可從 shang-competitor 跨 worker 呼叫
- [ ] 591 internal API probe 結果出爐（決定走 fetch 還是 Browser Rendering）
- [ ] 樂屋網列表頁 selector 探索完成

---

## 附錄 A：PoC 實作參考檔案

- `process-591.js` — PoC 完整邏輯（爬蟲 + dedup + geocode + 距離 + markdown 輸出）
- `samples/competitor-591/591-p1.json` ~ `591-p5.json` — 5 頁原始爬蟲產出
- `591-result.json` — 完整結構化結果
- `591-result.md` — 給人看的 markdown 報告
- `.geocode-cache.json` — Nominatim 結果 cache（轉 KV 時可導入做初始）

## 附錄 B：今日 PoC 學到的關鍵

1. **591 SPA 翻頁**：firstRow URL 無效，必須 click「下一頁」span 觸發 vue 翻頁
2. **同物件灌水嚴重**：130 → 9 表示 14× 重複率，去重不做就是垃圾報告
3. **mergeKey 用「路名 + 樓層 + 主建坪 + 總價」最穩**：community 名各家亂寫
4. **livingFloor**（取 F 前數字）解決「9F/9F vs 9F/10F」字串差異
5. **OSM Nominatim 對台灣社區名命中率不夠**：必須換 Google Maps
6. **OSM 把「瑞祥龍邸」geocode 到「瑞祥國小」**：誤差 200m 但同商圈，業務可接受
7. **591 imgSrc 在 `img.dataset.src` 或 `img.src`**：lazy load 原圖在 dataset
8. **591 「ware-item」class 是穩定的列表卡片 selector**

---

**Spec 版本**：v1.0（2026-04-29 收斂自 PoC）
**狀態**：待動工 Phase 1A
**負責人**：江炳賞 + Claude
