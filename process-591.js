// 591 競品分析腳本：合併 5 頁 → 歸併同物件 → Geocode → 1km 過濾 → 輸出 markdown
const fs = require('fs');
const path = require('path');

const root = __dirname;
const files = [
  path.join(root, 'samples', 'competitor-591', '591-p1.json'),
  path.join(root, 'samples', 'competitor-591', '591-p2.json'),
  path.join(root, 'samples', 'competitor-591', '591-p3.json'),
  path.join(root, 'samples', 'competitor-591', '591-p4.json'),
  path.join(root, 'samples', 'competitor-591', '591-p5.json'),
];

// 1. 合併
let all = [];
for (const f of files) {
  const arr = JSON.parse(fs.readFileSync(f, 'utf8'));
  all = all.concat(arr);
}
console.log(`原始筆數: ${all.length}`);

// 本案
const SUBJECT = {
  community: '瑞祥龍邸',
  href: 'https://sale.591.com.tw/home/house/detail/2/20109065.html',
  totalArea: 46.77,
  totalPrice: 1098,
  floor: '6F/15F',
  address: '高雄市前鎮區崗山南街529號',
};

// 2. 歸併規則（重設：community 名各家亂寫不可信，以 路名 + 居住樓層 + 主建坪 + 總價 為主鍵）
// L1: 同 href（少數情況同 url 重複）
// L2: 同 road + 同 livingFloor(F前數字) + 主建坪四捨五入到 0.5 + 總價四捨五入到 10
function livingFloor(f) { const m = (f || '').match(/^(\d+(?:~\d+)?)F/); return m ? m[1] : (f || ''); }
function mergeKey(item) {
  if (item.href) return `H:${item.href}`;
  const fl = livingFloor(item.floor);
  // 用主建坪當主指標（總坪數可能因含車位面積偏差），fallback 用權狀坪
  const area = item.mainArea || item.totalArea;
  return `K:${item.road || '?'}|${fl}|${Math.round(area*2)/2}|${Math.round((item.totalPrice||0)/10)*10}`;
}
const merged = new Map();
for (const item of all) {
  // primary key
  let k = mergeKey(item);
  // fallback：href 為主，但若已有「同 road+floor+area+price」key，仍歸一起
  const fl = livingFloor(item.floor);
  const area = item.mainArea || item.totalArea;
  const altK = `K:${item.road || '?'}|${fl}|${Math.round(area*2)/2}|${Math.round((item.totalPrice||0)/10)*10}`;
  // 找現有 key：優先看 altK 是否有人佔了
  let existKey = null;
  if (merged.has(altK)) existKey = altK;
  else if (merged.has(k)) existKey = k;
  if (existKey) {
    const x = merged.get(existKey);
    if (item.agent && !x.agents.includes(item.agent)) x.agents.push(item.agent);
    if (item.totalPrice && !x.prices.includes(item.totalPrice)) x.prices.push(item.totalPrice);
    if (item.href && !x.hrefs.includes(item.href)) x.hrefs.push(item.href);
    if (item.community && !x.communityVariants.includes(item.community)) x.communityVariants.push(item.community);
    if (!x.imgSrc && item.imgSrc) x.imgSrc = item.imgSrc;
  } else {
    merged.set(altK, {
      ...item,
      agents: item.agent ? [item.agent] : [],
      prices: item.totalPrice ? [item.totalPrice] : [],
      hrefs: item.href ? [item.href] : [],
      communityVariants: item.community ? [item.community] : [],
    });
  }
}
let items = Array.from(merged.values());
console.log(`歸併後: ${items.length}`);

// 排除本案
items = items.filter(x => !x.hrefs.includes(SUBJECT.href));
console.log(`排除本案後: ${items.length}`);

// 3. Geocode（Nominatim，rate limit 1 req/s）+ 磁碟 cache
const CACHE_FILE = path.join(root, '.geocode-cache.json');
let geocodeCache = {};
try { geocodeCache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch {}
async function nominatim(query) {
  if (geocodeCache[query]) return geocodeCache[query];
  const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=1&accept-language=zh-TW`;
  const res = await fetch(url, { headers: { 'User-Agent': 'shang-property-tool/1.0 (bingshang1019@gmail.com)' } });
  if (!res.ok) { geocodeCache[query] = null; fs.writeFileSync(CACHE_FILE, JSON.stringify(geocodeCache)); return null; }
  const arr = await res.json();
  const result = (arr && arr.length) ? { lat: parseFloat(arr[0].lat), lon: parseFloat(arr[0].lon), display: arr[0].display_name } : null;
  geocodeCache[query] = result;
  fs.writeFileSync(CACHE_FILE, JSON.stringify(geocodeCache));
  return result;
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

(async () => {
  // Subject 的座標 — 用社區名+路名（門牌號 OSM 找不到）
  console.log('Geocoding 本案...');
  let subjLoc = await nominatim('瑞祥龍邸 高雄市前鎮區');
  await new Promise(r => setTimeout(r, 1100));
  if (!subjLoc) {
    console.log('社區名查不到，fallback 路名');
    subjLoc = await nominatim('高雄市前鎮區崗山南街');
    await new Promise(r => setTimeout(r, 1100));
  }
  if (!subjLoc) { console.error('本案 geocode 失敗，連路名都查不到'); process.exit(1); }
  console.log(`本案座標: ${subjLoc.lat}, ${subjLoc.lon} (${subjLoc.display})`);

  // 每個競品 geocode（cache by community+road）
  const cache = new Map();
  let i = 0;
  for (const item of items) {
    i++;
    const cacheKey = `${item.community}|${item.road}`;
    if (cache.has(cacheKey)) {
      const c = cache.get(cacheKey);
      item.lat = c.lat; item.lon = c.lon;
      continue;
    }
    // 查詢字串：「社區名 + 路名 + 高雄市前鎮區」
    let q = '';
    if (item.community) q = `${item.community} 高雄市前鎮區`;
    else if (item.road) q = `高雄市前鎮區${item.road}`;
    if (!q) continue;
    process.stdout.write(`[${i}/${items.length}] ${q} ... `);
    const wasCached = !!geocodeCache[q];
    const loc = await nominatim(q);
    if (!wasCached) await new Promise(r => setTimeout(r, 1100)); // rate limit only when actually called API
    if (loc) {
      item.lat = loc.lat; item.lon = loc.lon;
      cache.set(cacheKey, loc);
      console.log(wasCached ? `(cache) OK` : `OK`);
    } else {
      if (item.road && item.community) {
        const q2 = `高雄市前鎮區${item.road}`;
        const wasCached2 = !!geocodeCache[q2];
        const loc2 = await nominatim(q2);
        if (!wasCached2) await new Promise(r => setTimeout(r, 1100));
        if (loc2) { item.lat = loc2.lat; item.lon = loc2.lon; cache.set(cacheKey, loc2); console.log(wasCached2 ? `(cache) fallback road OK` : `fallback road OK`); continue; }
      }
      console.log(`FAIL`);
    }
  }

  // 4. 距離計算
  for (const item of items) {
    if (item.lat) item.distance = haversine(subjLoc.lat, subjLoc.lon, item.lat, item.lon);
    else item.distance = null;
  }

  // 5. 過濾 ≤ 1000m + 寫檔
  const within = items.filter(x => x.distance !== null && x.distance <= 1000);
  const beyond = items.filter(x => x.distance !== null && x.distance > 1000);
  const failed = items.filter(x => x.distance === null);

  console.log(`\n結果：1km內 ${within.length} 筆，超出 ${beyond.length} 筆，geocode 失敗 ${failed.length} 筆`);

  // 排序：距離 asc, 單價 asc
  within.sort((a, b) => a.distance - b.distance || a.unitPrice - b.unitPrice);

  // 輸出
  fs.writeFileSync(path.join(root, '591-result.json'), JSON.stringify({ subject: SUBJECT, subjLoc, within, beyond, failed }, null, 2));
  console.log(`寫入 591-result.json`);

  // markdown
  let md = `# 591 競品分析：${SUBJECT.community}（${SUBJECT.address} ${SUBJECT.floor}）\n\n`;
  md += `**搜尋條件**：前鎮區 / 電梯大樓 / 屋齡 25 年以上 / 權狀 41-52 坪\n`;
  md += `**本案**：46.77 坪 / 32 年 / 6F/15F / 1,098 萬 / 23.48 萬/坪 / 含車位\n`;
  md += `**範圍**：以本案為中心 1000 公尺直線距離內\n`;
  md += `**結果**：原始 ${all.length} 筆 → 歸併 ${items.length+1} 筆（含本案）→ 1km 內 **${within.length} 筆**\n\n`;

  md += `## 1km 內競品（依距離排序）\n\n`;
  md += `| # | 距離 | 縮圖 | 社區 | 路 | 坪/主建 | 房型 | 屋齡 | 樓層 | 總價(萬) | 單價(萬/坪) | 車位 | 仲介 | 連結 |\n`;
  md += `|---|---|---|---|---|---|---|---|---|---|---|---|---|---|\n`;
  within.forEach((x, idx) => {
    const dist = `${Math.round(x.distance)}m`;
    const img = x.imgSrc ? `![](${x.imgSrc})` : '';
    const link = x.hrefs[0] ? `[看物件](${x.hrefs[0]})` : '';
    const agents = x.agents.length > 1 ? `${x.agents.length}家(${x.agents.join('/')})` : (x.agents[0] || '');
    const priceStr = x.prices.length > 1 ? `${Math.min(...x.prices)}-${Math.max(...x.prices)}` : (x.prices[0] || x.totalPrice);
    const community = x.community || '(未填)';
    md += `| ${idx+1} | ${dist} | ${img} | ${community} | ${x.road || '-'} | ${x.totalArea}/${x.mainArea||'-'} | ${x.rooms} | ${x.age || '-'}年 | ${x.floor} | ${priceStr} | ${x.unitPrice} | ${x.hasPark?'✓':'-'} | ${agents} | ${link} |\n`;
  });

  if (beyond.length) {
    md += `\n## 超出 1km（${beyond.length} 筆，僅列社區/距離供參考）\n\n`;
    beyond.sort((a,b) => a.distance - b.distance);
    beyond.forEach((x, idx) => {
      md += `- ${Math.round(x.distance)}m | ${x.community || '(未填)'} | ${x.road} | ${x.totalArea}坪 ${x.totalPrice}萬 ${x.unitPrice}萬/坪 [連結](${x.hrefs[0]})\n`;
    });
  }

  if (failed.length) {
    md += `\n## Geocode 失敗（${failed.length} 筆，無法判定距離）\n\n`;
    failed.forEach(x => md += `- ${x.community || '?'} | ${x.road || '?'} | ${x.totalArea}坪 ${x.totalPrice}萬 [連結](${x.hrefs[0]})\n`);
  }

  fs.writeFileSync(path.join(root, '591-result.md'), md);
  console.log(`寫入 591-result.md`);
  process.exit(0);
})();
