# shang-competitor Worker

Phase 1A：591 競品爬蟲 Cloudflare Worker（Browser Rendering）。

## 部署步驟（賞哥照表執行）

### 0. 前置確認

- [x] Cloudflare Workers Paid Plan 已啟用（2026-04-29）
- [ ] Google Maps Geocoding API 已在 GCP 啟用（如果還沒，去 [GCP Console](https://console.cloud.google.com/apis/library/geocoding-backend.googleapis.com) 啟用）

### 1. 安裝 wrangler（如果還沒）

```bash
cd workers/shang-competitor
npm install
```

如果是第一次用 wrangler，要登入：
```bash
npx wrangler login
```
會跳瀏覽器，授權給 wrangler 用你的 Cloudflare 帳號。

### 2. 建立 KV namespace（geocode cache）

```bash
npx wrangler kv namespace create GEOCACHE
```

跑完會回傳一個 ID，例如：
```
🌀 Creating namespace with title "shang-competitor-GEOCACHE"
✨ Success!
[[kv_namespaces]]
binding = "GEOCACHE"
id = "abc123def456..."
```

**把那個 id 複製，去改 `wrangler.toml` 把 `REPLACE_WITH_KV_ID_AFTER_CREATE` 換成它**。

### 3. 設環境變數（Google Maps API key）

```bash
npx wrangler secret put GOOGLE_MAPS_API_KEY
```

會問你輸入 key，貼上你的 Google Maps Geocoding API key（不會顯示，貼完按 Enter）。

### 4. 部署

```bash
npx wrangler deploy
```

成功會輸出 worker URL，例如：
```
✨ Successfully published shang-competitor
   https://shang-competitor.<你的 cf 帳號>.workers.dev
```

**記下這個 URL** — 等下要填進 `house-profile.html`。

### 5. 啟用 Browser Rendering

第一次 deploy 後，可能需要去 dashboard 確認 Browser Rendering 已開：

https://dash.cloudflare.com/?to=/:account/workers/browser-rendering

如果有「Get Started」按鈕，點它啟用。

### 6. 測試

```bash
curl -X POST https://shang-competitor.<你的帳號>.workers.dev/search \
  -H "Content-Type: application/json" \
  -d '{
    "mode": "auto",
    "subject": {
      "address": "高雄市前鎮區崗山南街529號",
      "community": "瑞祥龍邸",
      "totalArea": 46.77,
      "age": 32,
      "buildingType": "大樓"
    },
    "sources": ["591"]
  }'
```

預期回傳 JSON：
```json
{
  "ok": true,
  "subject": { "lat": 22.6, "lon": 120.32, "address": "..." },
  "stats": { "rawCount": 130, "mergedCount": 68, "withinRadius": 9, ... },
  "items": [...]
}
```

如果 `items` 有東西就成功。

### 7. 把 worker URL 給 Claude

跟 Claude 說：「Worker 部署完了，網址是 https://shang-competitor.xxx.workers.dev」，Claude 會把 `house-profile.html` 的 mock 改成真實 fetch。

## 看 log（debug 用）

```bash
npx wrangler tail
```

會即時顯示 Worker 收到的請求和 console.log。

## 計費注意

- Workers Paid 月 $5 是基礎
- Browser Rendering 月 10 分鐘免費，超量 $0.05/min
- 每次跑大概 30-60 秒（爬 5 頁 + geocode），所以月 30 次 ≈ 15-30 分鐘 = 多花 $0.25-1
- KV 操作免費額度遠大於用量

## 已知限制

- 目前只爬 591（樂屋網 Phase 1B 加）
- Region 寫死高雄市（regionid=17），要查其他縣市要改 `KAOHSIUNG_SECTIONS`（其實是台灣全縣市的 section table）
- Auth 還沒接 shang-whitelist（目前任何人都能打 /search）
