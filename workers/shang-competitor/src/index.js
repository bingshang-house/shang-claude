// shang-competitor Worker — 競品搜尋 Agent (v2: 社區關鍵字模式)
// 流程：591 keyword search (Browser Rendering) → 兩階段（同社區 / 鄰近條件）→ 跨來源歸併 → JSON 回傳
// 不再做 geocode + 1km 距離過濾（591 內建關鍵字搜尋已足夠）

import puppeteer from '@cloudflare/puppeteer';

// ============ CORS ============
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ============ 高雄市區 sectionid 對照（591）============
// ✅ 全 38 區用 Playwright 自動掃 591 checkbox 拿到（2026-04-29）
// 方法：navigate 591 列表頁 → loop click 每個區 checkbox → 讀 URL section param
const KAOHSIUNG_SECTIONS = {
  // 主要市區
  '前鎮區': 249, '苓雅區': 245, '鳳山區': 268, '小港區': 252,
  '三民區': 250, '左營區': 253, '楠梓區': 251, '鼓山區': 247,
  '新興區': 243, '前金區': 244, '鹽埕區': 246, '旗津區': 248,
  // 縣合併區（市郊 / 山區）
  '大寮區': 269, '仁武區': 254, '岡山區': 258, '林園區': 270,
  '路竹區': 259, '鳥松區': 271, '橋頭區': 263, '大樹區': 272,
  '梓官區': 264, '大社區': 255, '湖內區': 267, '茄萣區': 282,
  '燕巢區': 262, '阿蓮區': 260, '彌陀區': 265, '永安區': 266,
  '美濃區': 274, '旗山區': 273, '內門區': 276, '六龜區': 275,
  '杉林區': 277, '田寮區': 261, '甲仙區': 278, '桃源區': 279,
  '那瑪夏區': 280, '茂林區': 281,
};

// 相鄰區對照（賞哥 2026-04-29 idea：跨區比較才符合房仲場景）
// 依高雄市區地理相鄰關係（鳳山相鄰是大寮/仁武/鳥松不是三民）
const ADJACENT_DISTRICTS = {
  '前鎮區': ['前鎮區', '苓雅區', '小港區', '鳳山區'],
  '苓雅區': ['苓雅區', '前鎮區', '三民區', '新興區', '前金區'],
  '三民區': ['三民區', '苓雅區', '新興區', '鼓山區', '左營區', '仁武區'],
  '左營區': ['左營區', '三民區', '鼓山區', '楠梓區', '仁武區'],
  '楠梓區': ['楠梓區', '左營區', '仁武區', '橋頭區'],
  '鼓山區': ['鼓山區', '三民區', '左營區', '鹽埕區'],
  '鳳山區': ['鳳山區', '前鎮區', '小港區', '大寮區', '仁武區', '鳥松區'],
  '小港區': ['小港區', '前鎮區', '鳳山區', '林園區'],
  '新興區': ['新興區', '苓雅區', '三民區', '前金區'],
  '前金區': ['前金區', '苓雅區', '新興區', '鹽埕區'],
  '鹽埕區': ['鹽埕區', '鼓山區', '前金區'],
  '旗津區': ['旗津區', '鼓山區'],
};

// 建物型態 → 591 shape 參數
const SHAPE_MAP = { '公寓': 1, '電梯大樓': 2, '大樓': 2, '透天厝': 3, '透天': 3, '別墅': 4 };

// 591 產品別 → vertical config（2026-04-30 Playwright probe）
// 住宅類三種共用 sale.591；店面/辦公/廠房共用 business.591；土地用 land.591
// 參數名差異：sale 用 regionid/price/area/mainarea/houseage；business+land 用 region/sale_price/acreage
const PRODUCT_VERTICAL = {
  apartment: { domain: 'sale.591.com.tw',     path: '/',     shape: 1, regionParam: 'regionid', priceParam: 'price',      areaParam: 'area',    mainAreaParam: 'mainarea', landAreaParam: null,      ageParam: 'houseage', extra: { shType: 'list' }, parseSelector: '.ware-item' },
  dalou:     { domain: 'sale.591.com.tw',     path: '/',     shape: 2, regionParam: 'regionid', priceParam: 'price',      areaParam: 'area',    mainAreaParam: 'mainarea', landAreaParam: null,      ageParam: 'houseage', extra: { shType: 'list' }, parseSelector: '.ware-item' },
  townhouse: { domain: 'sale.591.com.tw',     path: '/',     shape: 3, regionParam: 'regionid', priceParam: 'price',      areaParam: 'area',    mainAreaParam: 'mainarea', landAreaParam: null,      ageParam: 'houseage', extra: { shType: 'list' }, parseSelector: '.ware-item' },
  store:     { domain: 'business.591.com.tw', path: '/list', kind: 5,  regionParam: 'region',   priceParam: 'sale_price', areaParam: 'acreage', mainAreaParam: null,       landAreaParam: null,      ageParam: null,       extra: { type: 2 },        parseSelector: '.item' },
  office:    { domain: 'business.591.com.tw', path: '/list', kind: 6,  regionParam: 'region',   priceParam: 'sale_price', areaParam: 'acreage', mainAreaParam: null,       landAreaParam: null,      ageParam: null,       extra: { type: 2 },        parseSelector: '.item' },
  factory:   { domain: 'business.591.com.tw', path: '/list', kind: 7,  regionParam: 'region',   priceParam: 'sale_price', areaParam: 'acreage', mainAreaParam: null,       landAreaParam: null,      ageParam: null,       extra: { type: 2 },        parseSelector: '.item' },
  land:      { domain: 'land.591.com.tw',     path: '/list', kind: 11, regionParam: 'region',   priceParam: 'sale_price', areaParam: null,      mainAreaParam: null,       landAreaParam: 'acreage', ageParam: null,       extra: { type: 2 },        parseSelector: '.item' },
};

// shape → productType 反查（自動模式從 buildingType 推）
const SHAPE_TO_PRODUCT = { 1: 'apartment', 2: 'dalou', 3: 'townhouse', 4: 'townhouse' };

// 依 productType + section + params 組 591 search URL
function buildSearchUrl(productType, sectionId, params, opts = {}) {
  const cfg = PRODUCT_VERTICAL[productType];
  if (!cfg) return null;
  const url = new URL(cfg.path, 'https://' + cfg.domain);
  url.searchParams.set(cfg.regionParam, '17'); // 高雄
  if (cfg.shape) url.searchParams.set('shape', String(cfg.shape));
  if (cfg.kind != null) url.searchParams.set('kind', String(cfg.kind));
  if (cfg.extra) for (const [k, v] of Object.entries(cfg.extra)) url.searchParams.set(k, String(v));
  if (sectionId) url.searchParams.set('section', String(sectionId));
  if (cfg.priceParam && (params.priceMin || params.priceMax)) {
    url.searchParams.set(cfg.priceParam, `${params.priceMin || 0}_${params.priceMax || 999999}`);
  }
  // 總坪 / 建坪（business 沒有「總坪」概念，acreage 是建坪 → fallback 用 mainArea）
  if (cfg.areaParam) {
    const lo = params.totalAreaMin ?? params.mainAreaMin;
    const hi = params.totalAreaMax ?? params.mainAreaMax;
    if (lo != null || hi != null) url.searchParams.set(cfg.areaParam, `${Math.floor(lo || 0)}_${Math.ceil(hi || 999)}`);
  }
  if (cfg.mainAreaParam && (params.mainAreaMin != null || params.mainAreaMax != null)) {
    url.searchParams.set(cfg.mainAreaParam, `${Math.floor(params.mainAreaMin || 0)}_${Math.ceil(params.mainAreaMax || 999)}`);
  }
  if (cfg.landAreaParam && (params.landAreaMin != null || params.landAreaMax != null)) {
    url.searchParams.set(cfg.landAreaParam, `${Math.floor(params.landAreaMin || 0)}_${Math.ceil(params.landAreaMax || 999)}`);
  }
  if (cfg.ageParam && (params.ageMin != null || params.ageMax != null)) {
    url.searchParams.set(cfg.ageParam, `${params.ageMin ?? 0}_${params.ageMax ?? 99}`);
  }
  if (opts.firstRow != null) url.searchParams.set('firstRow', String(opts.firstRow));
  if (opts.keywords) url.searchParams.set('keywords', opts.keywords);
  return url.toString();
}

// ============ 高雄市區 zipcode 對照（信義/樂屋）============
// 中華郵政公開靜態資料；信義 URL slug `{zip}-zip`
const KAOHSIUNG_ZIPS = {
  '新興區': '800', '前金區': '801', '苓雅區': '802', '鹽埕區': '803',
  '鼓山區': '804', '旗津區': '805', '前鎮區': '806', '三民區': '807',
  '楠梓區': '811', '小港區': '812', '左營區': '813',
  '仁武區': '814', '大社區': '815', '岡山區': '820', '路竹區': '821',
  '阿蓮區': '822', '田寮區': '823', '燕巢區': '824', '橋頭區': '825',
  '梓官區': '826', '彌陀區': '827', '永安區': '828', '湖內區': '829',
  '鳳山區': '830', '大寮區': '831', '林園區': '832', '鳥松區': '833',
  '大樹區': '840', '旗山區': '842', '美濃區': '843', '六龜區': '844',
  '內門區': '845', '杉林區': '846', '甲仙區': '847', '桃源區': '848',
  '那瑪夏區': '849', '茂林區': '851', '茄萣區': '852',
};

// 信義建物型態 slug（路徑 `{type}-type`，可複選 +）
const SINYI_TYPE_MAP = { '公寓': 'apartment', '電梯大樓': 'dalou', '大樓': 'dalou', '透天厝': 'townhouse', '透天': 'townhouse', '別墅': 'townhouse' };

// ============ Helper ============
function livingFloor(f) { return ((f || '').match(/^(\d+(?:~\d+)?)F/) || [])[1] || (f || ''); }

// 在 center 周圍以 radiusKm 半徑取 8 個圓周點（每 45 度一個）
function getCirclePoints(center, radiusKm) {
  const points = [];
  const latPerKm = 1 / 111;
  const lngPerKm = 1 / (111 * Math.cos(center.lat * Math.PI / 180));
  for (let i = 0; i < 8; i++) {
    const angle = (i * 45) * Math.PI / 180;
    points.push({
      lat: center.lat + radiusKm * latPerKm * Math.cos(angle),
      lng: center.lng + radiusKm * lngPerKm * Math.sin(angle),
    });
  }
  return points;
}

// reverse geocode lat/lng → 區名（KV cache）
async function reverseGeocodeDistrict(env, lat, lng) {
  if (!env.GOOGLE_MAPS_API_KEY) return null;
  const key = `rev:${lat.toFixed(4)}:${lng.toFixed(4)}`;
  try {
    const cached = await env.GEOCACHE.get(key, { type: 'json' });
    if (cached && cached.district) return cached.district;
    if (cached && cached.notFound) return null;
  } catch (_) { /* miss → 繼續打 API */ }
  const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&language=zh-TW&result_type=administrative_area_level_3&key=${env.GOOGLE_MAPS_API_KEY}`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    if (data.status === 'OK' && data.results?.length) {
      for (const r of data.results) {
        const comp = r.address_components?.find(c =>
          c.types.includes('administrative_area_level_3') || c.types.includes('sublocality_level_1')
        );
        const name = comp?.long_name;
        if (name && name.endsWith('區')) {
          env.GEOCACHE.put(key, JSON.stringify({ district: name }), { expirationTtl: 30 * 24 * 3600 }).catch(() => {});
          return name;
        }
      }
    }
    env.GEOCACHE.put(key, JSON.stringify({ notFound: true }), { expirationTtl: 7 * 24 * 3600 }).catch(() => {});
    return null;
  } catch (e) {
    console.error('reverseGeocode failed', lat, lng, e.message);
    return null;
  }
}

// haversine 距離（km），輸入 {lat, lng}
function haversineKm(a, b) {
  if (!a || !b) return null;
  const R = 6371;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

// Google Maps Geocoding + KV cache（30 天）
async function geocodeWithCache(env, query) {
  if (!query || !query.trim()) return null;
  const q = query.trim().slice(0, 200);
  const cacheKey = `geo:${q}`;
  try {
    const cached = await env.GEOCACHE.get(cacheKey, { type: 'json' });
    if (cached && cached.lat && cached.lng) return cached;
    if (cached && cached.notFound) return null; // 之前查過就是查不到，不重複打 API
  } catch (_) { /* KV miss 繼續 geocode */ }
  if (!env.GOOGLE_MAPS_API_KEY) return null;
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(q)}&language=zh-TW&region=tw&key=${env.GOOGLE_MAPS_API_KEY}`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    if (data.status === 'OK' && data.results?.[0]?.geometry?.location) {
      const { lat, lng } = data.results[0].geometry.location;
      const out = { lat, lng };
      env.GEOCACHE.put(cacheKey, JSON.stringify(out), { expirationTtl: 30 * 24 * 3600 }).catch(() => {});
      return out;
    }
    // ZERO_RESULTS / not found → 寫個 notFound 標記，避免重複打 API
    env.GEOCACHE.put(cacheKey, JSON.stringify({ notFound: true }), { expirationTtl: 7 * 24 * 3600 }).catch(() => {});
    return null;
  } catch (e) {
    console.error('geocode failed', q, e.message);
    return null;
  }
}

// 591 item → geocode query 字串（按優先級組合）
function itemGeocodeQuery(item) {
  const district = item.district || '';
  const community = (item.community || '').trim();
  const road = (item.road || '').trim();
  const parts = [];
  if (community) parts.push(community);
  if (district) parts.push(district.startsWith('高雄市') ? district : `高雄市${district}`);
  else parts.push('高雄市');
  if (road && road !== community) parts.push(road);
  return parts.join(' ');
}

// 591 簡體字 normalize（591 列表常見「综合」「楼」等簡體混用）
function normalizeForGeocode(s) {
  if (!s) return s;
  const map = { '综': '綜', '楼': '樓', '区': '區', '园': '園', '塆': '灣', '号': '號' };
  return s.replace(/[综楼区园塆号]/g, c => map[c] || c);
}

// 三段 fallback geocode：community+district+road → district+road → community+district
async function geocodeItemMultiTry(env, item) {
  const tryItem = { ...item };
  // 嘗試 1：原 query（含 community）+ 簡轉繁
  const q1 = normalizeForGeocode(itemGeocodeQuery(tryItem));
  let loc = await geocodeWithCache(env, q1);
  if (loc) return { loc, hitLevel: 1 };
  // 嘗試 2：district + road（不含 community，路名 Google 100% 認得）
  if (tryItem.district && tryItem.road) {
    const district = tryItem.district.replace(/^高雄市/, '');
    const q2 = `高雄市${district} ${normalizeForGeocode(tryItem.road)}`;
    loc = await geocodeWithCache(env, q2);
    if (loc) return { loc, hitLevel: 2 };
  }
  // 嘗試 3：community + district（不接 road，社區名單獨命中）
  if (tryItem.community && tryItem.district) {
    const district = tryItem.district.replace(/^高雄市/, '');
    const q3 = `${normalizeForGeocode(tryItem.community)} 高雄市${district}`;
    loc = await geocodeWithCache(env, q3);
    if (loc) return { loc, hitLevel: 3 };
  }
  return { loc: null, hitLevel: 0 };
}

function extractDistrict(addr) {
  const m = (addr || '').match(/([一-龥]+(?:區|鄉|鎮|市))/);
  return m ? m[1] : null;
}

// community 名標準化（合併 591 仲介間變體：「美國第五街综合大樓」「美國第五街」「美國第五街3棟」都歸一）
function normCommunityForMerge(s) {
  if (!s) return '';
  return s.toString()
    .replace(/\s+/g, '')
    .replace(/[综楼区园号塆厦]/g, c => ({ '综': '綜', '楼': '樓', '区': '區', '园': '園', '号': '號', '塆': '灣', '厦': '廈' }[c] || c))
    .replace(/(綜合大樓|綜合大廈|綜合|大樓|大廈|公寓|別墅|社區|華廈|大廳)$/g, '')
    .replace(/[\d\-之第A-Za-z]+(棟|號|樓|F)?$/, '') // 去尾 「3棟」「A棟」「2號」「14F」
    .slice(0, 8); // 取前 8 字當 key（避免極端長社區名）
}

// road 標準化（合併 591 仲介間變體：「新光路」「新光路62巷」「新光路62巷100號」都歸一成「新光路」）
function normRoadForMerge(s) {
  if (!s) return '';
  return s.toString()
    .replace(/\s+/g, '')
    .replace(/(\d+巷|\d+弄|\d+號|\d+段|一段|二段|三段|四段|五段|六段|七段|八段|九段).*$/, '') // 去尾巷弄號段
    .slice(0, 10);
}

function mergeKey(item) {
  const fl = livingFloor(item.floor);
  // 用 totalArea 不 fallback mainArea（591 列表 totalArea 100% 有值，mainArea 偶爾為 0）
  const area = Math.round((item.totalArea || 0) * 2) / 2;
  const price = Math.round((item.totalPrice || 0) / 10) * 10;
  const road = normRoadForMerge(item.road);
  const comm = normCommunityForMerge(item.community);
  return `${comm}|${road}|${fl}|${area}|${price}`;
}

// ============ 591 爬蟲（雙階段 + Browser Rendering）============
async function scrape591(env, params, subject, opts = {}) {
  const districtRaw = extractDistrict(subject.address);
  const district = districtRaw || '前鎮區';
  const section = KAOHSIUNG_SECTIONS[district] || KAOHSIUNG_SECTIONS['前鎮區'];

  // 鄰近區決定：優先用 opts.nearbyDistricts（main handler reverse geocode 算出 1km 圓覆蓋的區）
  // 其次 fallback 行政區相鄰表
  let adjacentList = (opts.nearbyDistricts && opts.nearbyDistricts.length)
    ? opts.nearbyDistricts
    : (ADJACENT_DISTRICTS[district] || [district]);
  let adjacentSectionIds = adjacentList
    .map(d => KAOHSIUNG_SECTIONS[d])
    .filter(Boolean);
  // 終極保險：算出來空的（可能 district 是 11 主要區外的郊區、或 address 異常），
  // 硬塞前鎮 + 苓雅（保守只取兩個市區）
  if (adjacentSectionIds.length === 0) {
    adjacentList = ['前鎮區', '苓雅區'];
    adjacentSectionIds = [249, 245];
  }

  // echo 給前端 debug 用（看 worker 真實收到 / 算出的內容）
  const _debugInfo = {
    receivedAddress: subject.address || '(空)',
    receivedCommunity: subject.community || '(空)',
    receivedBuildingType: subject.buildingType || '(空)',
    extractedDistrictRaw: districtRaw,
    finalDistrict: district,
    sectionResolved: section,
    adjacentList,
    adjacentSectionIds,
  };

  const shape = SHAPE_MAP[subject.buildingType?.replace(/\s/g, '')] || 2;

  // 產品別決議：params.productType 優先（用戶手選），其次 buildingType 反查 shape→productType
  const productType = params.productType || SHAPE_TO_PRODUCT[shape] || 'dalou';
  const verticalCfg = PRODUCT_VERTICAL[productType] || PRODUCT_VERTICAL.dalou;
  // 非住宅類（business / land）跳過「同社區」階段（沒有社區概念）
  const skipCommunityStage = productType === 'land' || productType === 'store' || productType === 'office' || productType === 'factory';
  _debugInfo.productType = productType;

  function buildUrl({ keywords, useFilter, firstRow = 0, sectionOverride }) {
    const sectionToUse = sectionOverride !== undefined ? sectionOverride : section;
    const filterParams = useFilter ? params : {};
    return buildSearchUrl(productType, sectionToUse, filterParams, { firstRow, keywords });
  }

  const browser = await puppeteer.launch(env.MYBROWSER);

  // 每個 page 共用設定（UA + abort 重型資源）
  async function newConfiguredPage() {
    const p = await browser.newPage();
    await p.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/121.0.0.0 Safari/537.36');
    await p.setRequestInterception(true);
    p.on('request', req => {
      const type = req.resourceType();
      const u = req.url();
      if (type === 'image' || type === 'media' || type === 'font' || type === 'stylesheet') return req.abort();
      if (/google-analytics|googletagmanager|doubleclick|facebook\.(com|net)|hotjar|criteo|googlesyndication|adservice|tiktok|line-scdn|tagcommander|matomo|sentry/.test(u)) return req.abort();
      req.continue();
    });
    return p;
  }

  // 單一 URL 抓取（每個 page 獨立 instance，並行不衝突）
  async function scrapeOneUrl(url, maxPages, matchType) {
    const items = [];
    let pageDebug = null;
    const page = await newConfiguredPage();
    try {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });
      } catch (gotoErr) {
        // navigation timeout 不一定是死的：591 廣告永遠不結束、但 .ware-item 可能已就緒
        console.warn(`[${matchType}] goto timeout, fallback to selector wait:`, gotoErr.message);
      }
      // race waitForSelector vs timeout，看到卡片就動手（591 有些頁 navigation 永遠不 done）
      const waitSel = verticalCfg.parseSelector + ', .no-result';
      try {
        await page.waitForSelector(waitSel, { timeout: 15000 });
      } catch (_) { /* 沒等到也不放棄，evaluate 看實況 */ }
      // 補一波 retry（591 SPA hydrate 偶爾再慢一點）
      let cardCount = 0;
      const sel = verticalCfg.parseSelector;
      for (let retry = 0; retry < 4; retry++) {
        cardCount = await page.evaluate((s) => document.querySelectorAll(s).length, sel).catch(() => 0);
        if (cardCount > 0) break;
        await new Promise(r => setTimeout(r, 1000));
      }
      for (let p = 0; p < maxPages; p++) {
        const pageItems = await page.evaluate(parseListPage, sel).catch(() => []);
        if (!pageItems.length) {
          if (p === 0) {
            pageDebug = await page.evaluate((s) => ({
              cardCount: document.querySelectorAll(s).length,
              bodyTextStart: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 600),
              title: document.title,
              url: location.href,
            }), sel).catch(e => ({ error: String(e), cardCount: 0 }));
          }
          break;
        }
        pageItems.forEach(x => x.matchType = matchType);
        items.push(...pageItems);
        if (p === maxPages - 1) break;
        const hasNext = await page.evaluate(() => {
          const next = [...document.querySelectorAll('span,a,button')].find(e => e.textContent.trim() === '下一頁');
          if (!next || next.classList.contains('disabled')) return false;
          next.click();
          return true;
        }).catch(() => false);
        if (!hasNext) break;
        await new Promise(r => setTimeout(r, 1500));
      }
    } catch (e) {
      console.error(`scrape stage failed (${matchType})`, e);
      pageDebug = { error: String(e), cardCount: 0 };
    } finally {
      await page.close().catch(() => {});
    }
    return { items, pageDebug };
  }

  // === 並行：階段 1 keyword + 階段 2 每相鄰區獨立 page ===
  const tasks = [];

  // 階段 1：同社區 keyword（不限區）— 土地/店面/辦公/廠房 跳過（沒社區概念）
  if (subject.community && !skipCommunityStage) {
    const u = buildUrl({ keywords: subject.community, useFilter: false, sectionOverride: '' });
    tasks.push(
      scrapeOneUrl(u, 1, 'same_community').then(r => ({
        name: '同社區', url: u, count: r.items.length, pageDebug: r.pageDebug, items: r.items,
      }))
    );
  }

  // 階段 2：本區 + 相鄰區，每區一個 page 並行（591 單區搜尋比 multi-section 穩很多）
  adjacentSectionIds.forEach((sid, idx) => {
    const dn = adjacentList[idx] || `區${sid}`;
    const u = buildUrl({ useFilter: true, sectionOverride: String(sid) });
    tasks.push(
      scrapeOneUrl(u, 2, 'nearby').then(r => ({
        name: dn, url: u, count: r.items.length, pageDebug: r.pageDebug, items: r.items,
      }))
    );
  });

  const results = await Promise.all(tasks);

  const allItems = [];
  const stages = [];
  results.forEach(r => {
    stages.push({ name: r.name, url: r.url, count: r.count, pageDebug: r.pageDebug });
    allItems.push(...r.items);
  });

  await browser.close().catch(() => {});
  return { items: allItems.map(x => ({ ...x, source: '591' })), stages, _debugInfo };
}

// ============ 信義房屋爬蟲（同社區 keyword + 鄰近區 zip 並行 + Browser Rendering）============
// 2026-04-29 Playwright probe 確認 URL slug 結構，詳見 reference_sinyi_structure.md
async function scrapeSinyi(env, params, subject, opts = {}) {
  const districtRaw = extractDistrict(subject.address);
  const district = districtRaw || '前鎮區';
  const zip = KAOHSIUNG_ZIPS[district] || '806';

  let adjacentList = (opts.nearbyDistricts && opts.nearbyDistricts.length)
    ? opts.nearbyDistricts
    : (ADJACENT_DISTRICTS[district] || [district]);
  let adjacentZips = adjacentList
    .map(d => ({ d, zip: KAOHSIUNG_ZIPS[d] }))
    .filter(x => x.zip);
  if (adjacentZips.length === 0) {
    adjacentList = ['前鎮區', '苓雅區'];
    adjacentZips = [{ d: '前鎮區', zip: '806' }, { d: '苓雅區', zip: '802' }];
  }

  const _debugInfo = {
    receivedAddress: subject.address || '(空)',
    receivedCommunity: subject.community || '(空)',
    finalDistrict: district,
    zipResolved: zip,
    adjacentList,
    adjacentZips,
  };

  const ageMin = params.ageMin ?? 0;
  const ageMax = params.ageMax ?? 99;
  const areaMin = params.totalAreaMin ?? 0;
  const areaMax = params.totalAreaMax ?? 999;

  // 信義 URL 段：filter slugs → city → zip → sort → page
  function buildUrl({ keyword, useFilter, zipOverride, page = 1 }) {
    const segs = [];
    if (keyword) segs.push(`${encodeURIComponent(keyword)}-keyword`);
    if (useFilter) {
      if (params.priceMin || params.priceMax) {
        segs.push(`${params.priceMin || 0}-${params.priceMax || 99999}-price`);
      }
      if (areaMin || areaMax < 999) {
        segs.push(`${Math.floor(areaMin)}-${Math.ceil(areaMax)}-area`);
      }
      if (params.mainAreaMin != null || params.mainAreaMax != null) {
        segs.push(`${Math.floor(params.mainAreaMin || 0)}-${Math.ceil(params.mainAreaMax || 999)}-balconyarea`);
      }
      if (ageMin || ageMax < 99) {
        segs.push(`${Math.floor(ageMin)}-${Math.ceil(ageMax)}-year`);
      }
    }
    segs.push('Kaohsiung-city');
    if (zipOverride) segs.push(`${zipOverride}-zip`);
    segs.push('default-desc', String(page));
    return `https://www.sinyi.com.tw/buy/list/${segs.join('/')}`;
  }

  const browser = await puppeteer.launch(env.MYBROWSER);

  async function newConfiguredPage() {
    const p = await browser.newPage();
    await p.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/121.0.0.0 Safari/537.36');
    await p.setRequestInterception(true);
    p.on('request', req => {
      const type = req.resourceType();
      const u = req.url();
      if (type === 'image' || type === 'media' || type === 'font' || type === 'stylesheet') return req.abort();
      if (/google-analytics|googletagmanager|doubleclick|facebook\.(com|net)|hotjar|criteo|googlesyndication|adservice|tiktok|line-scdn|tagcommander|matomo|sentry/.test(u)) return req.abort();
      req.continue();
    });
    return p;
  }

  async function scrapeOneUrl(url, matchType) {
    const items = [];
    let pageDebug = null;
    const page = await newConfiguredPage();
    try {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });
      } catch (gotoErr) {
        console.warn(`[sinyi ${matchType}] goto timeout:`, gotoErr.message);
      }
      // 等 Next.js hydrate 出卡片
      try {
        await page.waitForSelector('.buy-list-item, [class*="searchNoResult"]', { timeout: 15000 });
      } catch (_) { /* 沒等到也試一下 evaluate */ }
      let cardCount = 0;
      for (let retry = 0; retry < 4; retry++) {
        cardCount = await page.evaluate(() => document.querySelectorAll('.buy-list-item').length).catch(() => 0);
        if (cardCount > 0) break;
        await new Promise(r => setTimeout(r, 1000));
      }
      const pageItems = await page.evaluate(parseSinyiPage).catch(() => []);
      if (!pageItems.length) {
        pageDebug = await page.evaluate(() => ({
          cardCount: document.querySelectorAll('.buy-list-item').length,
          bodyTextStart: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 600),
          title: document.title,
          url: location.href,
        })).catch(e => ({ error: String(e), cardCount: 0 }));
      }
      pageItems.forEach(x => x.matchType = matchType);
      items.push(...pageItems);
    } catch (e) {
      console.error(`scrapeSinyi failed (${matchType})`, e);
      pageDebug = { error: String(e), cardCount: 0 };
    } finally {
      await page.close().catch(() => {});
    }
    return { items, pageDebug };
  }

  const tasks = [];

  // 階段 1：同社區（keyword 搜，全城範圍）
  if (subject.community) {
    const u = buildUrl({ keyword: subject.community, useFilter: false });
    tasks.push(
      scrapeOneUrl(u, 'same_community').then(r => ({
        name: '同社區', url: u, count: r.items.length, pageDebug: r.pageDebug, items: r.items,
      }))
    );
  }

  // 階段 2：本區 + 相鄰區，每區並行（信義一頁 10 筆，先抓第 1 頁，量不夠再加）
  adjacentZips.forEach(({ d, zip: z }) => {
    const u = buildUrl({ useFilter: true, zipOverride: z });
    tasks.push(
      scrapeOneUrl(u, 'nearby').then(r => ({
        name: d, url: u, count: r.items.length, pageDebug: r.pageDebug, items: r.items,
      }))
    );
  });

  const results = await Promise.all(tasks);

  const allItems = [];
  const stages = [];
  results.forEach(r => {
    stages.push({ name: `信義-${r.name}`, url: r.url, count: r.count, pageDebug: r.pageDebug });
    allItems.push(...r.items);
  });

  await browser.close().catch(() => {});
  return { items: allItems.map(x => ({ ...x, source: 'sinyi' })), stages, _debugInfo };
}

// 信義頁面 context parser
function parseSinyiPage() {
  const cards = document.querySelectorAll('.buy-list-item');
  const out = [];
  cards.forEach((c, idx) => {
    const link = c.querySelector('a[href*="/buy/house/"]');
    const href = link ? new URL(link.getAttribute('href'), location.origin).href.split('?')[0] : '';
    if (!href) return;

    // 三組 span 分別位於 Address / HouseInfo / SpecificTags
    const addrSpans = c.querySelector('[class*="LongInfoCard_Type_Address"]')?.querySelectorAll('span') || [];
    const houseSpans = c.querySelector('[class*="LongInfoCard_Type_HouseInfo"]')?.querySelectorAll('span') || [];

    const addrText = (addrSpans[0]?.textContent || '').trim(); // 「高雄市前鎮區光華三路」
    const ageText = (addrSpans[1]?.textContent || '').trim();   // 「19.9年」
    const buildingType = (addrSpans[2]?.textContent || '').trim(); // 「大樓」

    // 建坪 / 主+陽 / 房型 / 樓層
    const totalAreaText = (houseSpans[0]?.textContent || '').trim(); // 「建坪 33.81」
    const mainAreaText = (houseSpans[1]?.textContent || '').trim();  // 「主 + 陽16.16」
    const roomsText = (houseSpans[2]?.textContent || '').trim();     // 「2房2廳1衛」
    const floorText = (houseSpans[3]?.textContent || '').trim();     // 「7樓/15樓」

    const totalArea = parseFloat((totalAreaText.match(/([\d.]+)/) || [])[1] || 0);
    const mainArea = parseFloat((mainAreaText.match(/([\d.]+)/) || [])[1] || 0);
    const age = parseFloat((ageText.match(/([\d.]+)/) || [])[1] || 0);
    const roomsM = roomsText.match(/(\d+)房(\d+)廳(\d+)衛/);
    const floorM = floorText.match(/(\d+)樓\/(\d+)樓/);
    const floor = floorM ? `${floorM[1]}F/${floorM[2]}F` : floorText.replace(/樓/g, 'F').replace(/\//, '/');

    // 標題從 anchor 第一個 generic 抓（snapshot 顯示「title」是 e91 那層）
    // innerText 黏字 — 取 anchor 的 aria-label 或第一個非空文字
    let title = '';
    const titleEl = c.querySelector('[class*="LongInfoCard_Type_Name"]');
    if (titleEl) title = titleEl.textContent.trim();
    if (!title) {
      // fallback: anchor 第一段 alt 圖片或文字
      const img = c.querySelector('img[alt]');
      if (img) title = img.getAttribute('alt') || '';
    }

    // community = title（信義卡片標題基本上 = 社區名 / 物件名）
    const community = title;

    // road / district 從地址抽
    let road = '', district = '';
    const dm = addrText.match(/(高雄市)?([一-龥]{1,3}區)([一-龥\d\w]+?)(?:$)/);
    if (dm) { district = dm[2]; road = dm[3]; }

    // 價格：從卡片 innerText 抓「{原價}萬{現價}萬」or 單價，取現價
    const cardText = (c.innerText || '').replace(/\s+/g, ' ').trim();
    let totalPrice = 0;
    const priceM = cardText.match(/([\d,]+)\s*萬\s*([\d,]+)\s*萬/);
    if (priceM) {
      totalPrice = parseFloat(priceM[2].replace(/,/g, ''));
    } else {
      const single = cardText.match(/([\d,]+)\s*萬(?!\/坪)/);
      if (single) totalPrice = parseFloat(single[1].replace(/,/g, ''));
    }
    const unitPrice = totalArea > 0 && totalPrice > 0 ? Math.round((totalPrice / totalArea) * 100) / 100 : 0;

    // 圖
    const img = c.querySelector('img');
    const imgSrc = img ? (img.getAttribute('data-src') || img.getAttribute('src') || '') : '';

    // 車位（信義會在 specific tags 顯示「警衛管理」「有車位」等，但建坪通常含車位坪數，車位識別比較難）
    const hasPark = /車位|車墅|平車/.test(cardText);

    // sanity check
    if (!totalArea || totalArea < 5) return;
    if (!totalPrice || totalPrice < 50) return;

    const item = {
      title, community, road, district,
      rooms: roomsM ? `${roomsM[1]}房${roomsM[2]}廳${roomsM[3]}衛` : '',
      totalArea, mainArea, age, floor, agent: '信義房屋', hasPark, totalPrice, unitPrice,
      href, imgSrc, buildingType,
    };
    if (idx < 2) item._raw = cardText.slice(0, 350);
    out.push(item);
  });
  return out;
}

// ============ 樂屋網爬蟲（zipcode 區搜尋 + 並行 + Browser Rendering）============
// reference_rakuya_structure.md：URL query string、CF Challenge 擋 fetch、innerText 一行一欄
// 樂屋沒有 keyword 同社區搜尋功能，全靠 zipcode 抓回來 client-side 跨平台 mergeKey 合併
async function scrapeRakuya(env, params, subject, opts = {}) {
  const districtRaw = extractDistrict(subject.address);
  const district = districtRaw || '前鎮區';
  const zip = KAOHSIUNG_ZIPS[district] || '806';

  let adjacentList = (opts.nearbyDistricts && opts.nearbyDistricts.length)
    ? opts.nearbyDistricts
    : (ADJACENT_DISTRICTS[district] || [district]);
  let adjacentZips = adjacentList
    .map(d => ({ d, zip: KAOHSIUNG_ZIPS[d] }))
    .filter(x => x.zip);
  if (adjacentZips.length === 0) {
    adjacentList = ['前鎮區', '苓雅區'];
    adjacentZips = [{ d: '前鎮區', zip: '806' }, { d: '苓雅區', zip: '802' }];
  }

  const _debugInfo = {
    receivedAddress: subject.address || '(空)',
    receivedCommunity: subject.community || '(空)',
    finalDistrict: district,
    zipResolved: zip,
    adjacentList,
    adjacentZips,
  };

  // 樂屋 URL 只下 zipcode + 寬鬆 price（其他 client-side 過濾，因區間 boundary 會刷掉）
  function buildUrl({ zipOverride }) {
    const u = new URL('https://www.rakuya.com.tw/sell/result');
    u.searchParams.set('zipcode', zipOverride || zip);
    if (params.priceMin || params.priceMax) {
      u.searchParams.set('price', `${params.priceMin || ''}~${params.priceMax || ''}`);
    }
    return u.toString();
  }

  const browser = await puppeteer.launch(env.MYBROWSER);

  async function newConfiguredPage() {
    const p = await browser.newPage();
    await p.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/121.0.0.0 Safari/537.36');
    await p.setRequestInterception(true);
    p.on('request', req => {
      const type = req.resourceType();
      const u = req.url();
      if (type === 'image' || type === 'media' || type === 'font' || type === 'stylesheet') return req.abort();
      if (/google-analytics|googletagmanager|doubleclick|facebook\.(com|net)|hotjar|criteo|googlesyndication|adservice|tiktok|line-scdn|tagcommander|matomo|sentry/.test(u)) return req.abort();
      req.continue();
    });
    return p;
  }

  async function scrapeOneUrl(url, matchType) {
    const items = [];
    let pageDebug = null;
    const page = await newConfiguredPage();
    try {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });
      } catch (gotoErr) {
        console.warn(`[rakuya ${matchType}] goto timeout:`, gotoErr.message);
      }
      // 等 CF Challenge 過 + 卡片 hydrate
      try {
        await page.waitForSelector('section.grid-item.search-obj, .no-result', { timeout: 20000 });
      } catch (_) { /* 沒等到也試 evaluate */ }
      let cardCount = 0;
      for (let retry = 0; retry < 4; retry++) {
        cardCount = await page.evaluate(() => document.querySelectorAll('section.grid-item.search-obj').length).catch(() => 0);
        if (cardCount > 0) break;
        await new Promise(r => setTimeout(r, 1500));
      }
      const pageItems = await page.evaluate(parseRakuyaPage).catch(() => []);
      if (!pageItems.length) {
        pageDebug = await page.evaluate(() => ({
          cardCount: document.querySelectorAll('section.grid-item.search-obj').length,
          bodyTextStart: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 600),
          title: document.title,
          url: location.href,
        })).catch(e => ({ error: String(e), cardCount: 0 }));
      }
      pageItems.forEach(x => x.matchType = matchType);
      items.push(...pageItems);
    } catch (e) {
      console.error(`scrapeRakuya failed (${matchType})`, e);
      pageDebug = { error: String(e), cardCount: 0 };
    } finally {
      await page.close().catch(() => {});
    }
    return { items, pageDebug };
  }

  // 樂屋每區一個 page 並行（沒 keyword 同社區，全靠 zipcode）
  const tasks = adjacentZips.map(({ d, zip: z }) => {
    const u = buildUrl({ zipOverride: z });
    return scrapeOneUrl(u, 'nearby').then(r => ({
      name: d, url: u, count: r.items.length, pageDebug: r.pageDebug, items: r.items,
    }));
  });

  const results = await Promise.all(tasks);

  const allItems = [];
  const stages = [];
  results.forEach(r => {
    stages.push({ name: `樂屋-${r.name}`, url: r.url, count: r.count, pageDebug: r.pageDebug });
    allItems.push(...r.items);
  });

  await browser.close().catch(() => {});
  return { items: allItems.map(x => ({ ...x, source: 'rakuya' })), stages, _debugInfo };
}

// 樂屋頁面 context parser（innerText 一行一欄超乾淨）
function parseRakuyaPage() {
  const cards = document.querySelectorAll('section.grid-item.search-obj');
  const out = [];
  cards.forEach((c, idx) => {
    const link = c.querySelector('a[href*="/sell_item/info"]');
    const href = link ? new URL(link.getAttribute('href'), location.origin).href : '';
    if (!href) return;

    const text = (c.innerText || '').trim();
    const lines = text.split('\n').map(s => s.trim()).filter(Boolean);

    const get = (re) => (text.match(re) || [])[1];

    const totalArea = parseFloat(get(/總建\s*([\d.]+)\s*坪/) || 0);
    const mainArea = parseFloat(get(/主建\s*([\d.]+)\s*坪/) || 0);
    const ageText = get(/^([\d.]+)\s*年$/m);
    const age = ageText ? parseFloat(ageText) : 0;
    const roomsM = text.match(/(\d+)房(\d+)廳(\d+)衛/);
    const floorM = text.match(/(\d+)\/(\d+)樓/);
    const floor = floorM ? `${floorM[1]}F/${floorM[2]}F` : '';
    const unitPrice = parseFloat(get(/([\d.]+)\s*萬\/坪/) || 0);
    const totalPriceText = get(/^([\d,]+)\s*萬$/m);
    const totalPrice = totalPriceText ? parseInt(totalPriceText.replace(/,/g, '')) : 0;

    // 區、社區、物件型態：從 lines 結構抓
    // 樂屋格式：標題 → 上架狀態 → 區 → 社區 → 型態 → 房型 → ...
    let district = '';
    let community = '';
    let buildingType = '';
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (/^[一-龥]{1,3}區$/.test(l) && !district) {
        district = l;
        // 社區通常是下一行（型態前）
        if (lines[i + 1] && !/電梯|公寓|透天|別墅|大廈/.test(lines[i + 1])) {
          community = lines[i + 1];
        }
        // 型態
        for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
          if (/電梯大[廈樓]|公寓|透天厝|別墅|大廈|華廈/.test(lines[j])) {
            buildingType = lines[j];
            break;
          }
        }
        break;
      }
    }

    // 標題：列表第一行非「比較/立即預約」的有意義文字（卡片頂部物件名）
    let title = '';
    for (const l of lines) {
      if (/^(比較|立即預約|進入店鋪|新上架|降價|店長推薦|優質)$/.test(l)) continue;
      if (l.length >= 2 && l.length <= 30) { title = l; break; }
    }
    if (!community) community = title;

    const img = c.querySelector('img');
    const imgSrc = img ? (img.getAttribute('data-src') || img.getAttribute('src') || '') : '';
    const hasPark = /車位|平車|車墅/.test(text);

    if (!totalArea || totalArea < 5) return;
    if (!totalPrice || totalPrice < 50) return;

    const item = {
      title, community, road: '', district,
      rooms: roomsM ? `${roomsM[1]}房${roomsM[2]}廳${roomsM[3]}衛` : '',
      totalArea, mainArea, age, floor, agent: '樂屋網', hasPark, totalPrice, unitPrice,
      href, imgSrc, buildingType,
    };
    if (idx < 2) item._raw = text.slice(0, 350);
    out.push(item);
  });
  return out;
}

// 在頁面 context 跑的 parser
// v2.1: 591 SPA layout 變動 → community/age/district 加多重 fallback + DOM selector
function parseListPage(selector) {
  selector = selector || '.ware-item';
  const isSale = selector === '.ware-item';
  const cards = document.querySelectorAll(selector);
  const out = [];
  cards.forEach((c, idx) => {
    const t = (c.innerText || '').replace(/\s+/g, ' ').trim();
    if (!t) return;

    // land.591 + business.591 parser（.item selector）
    if (!isSale) {
      const link = c.querySelector('a[href*="/sale/"], a[href*="/buy/"], a[href*="/item/"], a[href*="/detail/"], a[href]');
      const href = link ? link.href.split('#')[0].split('?')[0] : '';
      const img = c.querySelector('img');
      const imgSrc = img ? (img.dataset.src || img.src || '') : '';
      const totalArea = parseFloat((t.match(/(\d+(?:\.\d+)?)\s*坪/) || [])[1] || 0);
      // 591 black 字格式「4,620萬 70.06萬/坪」
      const totalPriceMatch = t.match(/([\d,]+(?:\.\d+)?)\s*萬\s+[\d.]+\s*萬\/坪/);
      const totalPrice = totalPriceMatch ? parseFloat(totalPriceMatch[1].replace(/,/g, '')) : 0;
      const unitPrice = parseFloat((t.match(/([\d.]+)\s*萬\/坪/) || [])[1] || 0);
      const distM = t.match(/([一-鿿]{1,3}區)[\-\s]+([一-鿿\w\d]{1,15}?)(?:\s|$|距)/);
      const district = distM ? distM[1] : '';
      const road = distM ? distM[2] : '';
      // 標題：在「坪」之前的字段（去掉「精選/置頂/地號已核實」等前綴 tag）
      let title = '';
      const tm = t.match(/^(?:精選\s*|置頂\s*|地號已核實\s*|NEW\s*|\d+\s*)*(.+?)\s+\d+(?:\.\d+)?\s*坪/);
      if (tm) title = tm[1].trim();
      const agent = (t.match(/仲介\s*[^\d\s]*?(\S+?)\s*\d+\s*人瀏覽/) || [])[1] || '';

      if (!totalArea || totalArea < 1) return;
      if (!totalPrice || totalPrice < 50) return;
      if (!href) return;

      const item = {
        title, community: '', road, district,
        rooms: '',
        totalArea, mainArea: 0, age: 0, floor: '',
        agent, hasPark: false, totalPrice, unitPrice, href, imgSrc,
      };
      if (idx < 2) item._raw = t.slice(0, 350);
      out.push(item);
      return;
    }

    // isSale ↓ 住宅 sale.591 原有邏輯
    if (!/電梯大樓|公寓|透天厝|別墅/.test(t)) return;
    const link = c.querySelector('a[href*="/home/house/detail/"]');
    const href = link ? link.href.split('#')[0].split('?')[0] : '';
    const img = c.querySelector('img');
    const imgSrc = img ? (img.dataset.src || img.src || '') : '';

    // === 標題 ===
    let title = '';
    for (const sel of ['.ware-item-title', '.title', '.name', 'h3', 'h4']) {
      const el = c.querySelector(sel);
      if (el && el.textContent.trim()) { title = el.textContent.trim(); break; }
    }
    if (!title) {
      const tm = t.match(/(?:精選|置頂|NEW)\s+(.+?)(?:NEW)?\s+(?:電梯大樓|公寓|透天厝|別墅)/);
      if (tm) title = tm[1].trim().replace(/NEW$/, '').trim();
      else { const m2 = t.match(/^[\d\s]*(.+?)\s+(?:電梯大樓|公寓|透天厝|別墅)/); title = m2 ? m2[1].trim() : ''; }
    }

    // === community / district / road 多重 fallback ===
    // 591 raw 樣本：「3F/14F 美國第五街综合大樓前鎮區-文橫三路 仲介」— 區前不一定有空白
    let community = '', district = '', road = '';
    // 第一試：樓層後接「社區+區-路」（區前可能無空白）
    const m3 = t.match(/\d+(?:~\d+)?F\/\d+F\s+([一-鿿\w]+?)([一-鿿]{1,3}區)[\-\s]+([一-鿿\w]+?)\s+仲介/);
    if (m3) { community = m3[1]; district = m3[2]; road = m3[3]; }
    // 第二試：DOM selector 抓 community
    if (!community) {
      for (const sel of ['.community', '.community-name', '.community-title', '[class*="community"]', '[class*="Community"]']) {
        const el = c.querySelector(sel);
        if (el && el.textContent.trim()) { community = el.textContent.trim(); break; }
      }
    }
    // 第三試：純粹從文字抓「XX區-YY路」
    if (!district) {
      const m4 = t.match(/([一-鿿]{1,3}區)[\-\s]+([一-鿿\d]{1,15})/);
      if (m4) { district = m4[1]; if (!road) road = m4[2]; }
    }

    // === age 多重 fallback（591 黏字格式：「坪29年3F/14F」全無空白）===
    let age = 0;
    const ageRegexes = [
      /(?:屋齡|齡)\s*[:：]?\s*(\d+)\s*年/,
      /(\d+)\s*年屋齡/,
      /(\d+)\s*年(?:中古|新成屋)/,
      /坪\s*(\d{1,2})\s*年\s*\d+(?:~\d+)?F/,        // 「主建XX坪29年3F/14F」← 591 主流格式
      /(\d{1,2})\s*年\s*\d+(?:~\d+)?F\/\d+F/,       // 「29年3F/14F」更鬆版
      /\d+(?:~\d+)?F\/\d+F\s*(\d{1,2})\s*年/,       // 樓層後接屋齡
    ];
    for (const re of ageRegexes) {
      const m = t.match(re);
      if (m && parseInt(m[1]) > 0 && parseInt(m[1]) < 100) { age = parseFloat(m[1]); break; }
    }

    const rooms = t.match(/(\d+)房(\d+)廳(\d+)衛/);
    const totalArea = parseFloat((t.match(/權狀\s*([\d.]+)\s*坪/) || [])[1] || 0);
    const mainArea = parseFloat((t.match(/主建\s*([\d.]+)\s*坪/) || [])[1] || 0);
    const floor = (t.match(/(\d+(?:~\d+)?F\/\d+F)/) || [])[1] || '';
    // 591 黏字格式「仲介張庭瑜62人瀏覽」中間沒空白，後面用 \s* 不能 \s+
    const agent = (t.match(/仲介\s*(.+?)\s*\d+\s*人瀏覽/) || [])[1] || '';
    const hasPark = /含車位/.test(t);
    const totalPriceMatch = t.match(/([\d,]+)\s*萬\s*(?:\(\s*含車位價\s*\))?\s+[\d.]+\s*萬\/坪/);
    const totalPrice = totalPriceMatch ? parseFloat(totalPriceMatch[1].replace(/,/g, '')) : 0;
    const unitPrice = parseFloat((t.match(/([\d.]+)\s*萬\/坪/) || [])[1] || 0);

    // sanity check：591 列表有「廣告/精選位」用 .ware-item 殼但內容空 → 過濾掉
    // 條件：總坪 0、總價 0、或無連結 = 異常 / 廣告卡片
    if (!totalArea || totalArea < 5) return;
    if (!totalPrice || totalPrice < 50) return;
    if (!href) return;

    const item = {
      title, community, road, district,
      rooms: rooms ? `${rooms[1]}房${rooms[2]}廳${rooms[3]}衛` : '',
      totalArea, mainArea, age, floor, agent, hasPark, totalPrice, unitPrice, href, imgSrc,
    };
    // 只在前 2 筆塞 raw debug 樣本（讓 worker response 帶回前端，賞哥可截圖回報）
    if (idx < 2) item._raw = t.slice(0, 350);
    out.push(item);
  });
  return out;
}

// ============ 跨平台歸併（保留 matchType 優先級：same_community > nearby）============
function mergeItems(all) {
  const map = new Map();
  for (const item of all) {
    const k = mergeKey(item);
    if (map.has(k)) {
      const x = map.get(k);
      if (item.agent && !x.agents.includes(item.agent)) x.agents.push(item.agent);
      if (item.totalPrice && !x.prices.includes(item.totalPrice)) x.prices.push(item.totalPrice);
      if (item.community && !x.communityVariants.includes(item.community)) x.communityVariants.push(item.community);
      if (!x.sources.includes(item.source)) x.sources.push(item.source);
      if (item.href && !x.links[item.source]) x.links[item.source] = item.href;
      if (!x.imgSrc && item.imgSrc) x.imgSrc = item.imgSrc;
      if (item.district && !x.district) x.district = item.district;
      // matchType 優先級：same_community 蓋過 nearby
      if (item.matchType === 'same_community') x.matchType = 'same_community';
    } else {
      map.set(k, {
        ...item,
        agents: item.agent ? [item.agent] : [],
        prices: item.totalPrice ? [item.totalPrice] : [],
        communityVariants: item.community ? [item.community] : [],
        sources: item.source ? [item.source] : [],
        links: item.source && item.href ? { [item.source]: item.href } : {},
      });
    }
  }
  return [...map.values()].map(x => ({
    ...x,
    agentCount: x.agents.length,
    warningTags: livingFloor(x.floor) === '1' ? ['1F樓店'] : (livingFloor(x.floor) === '2' && x.totalPrice > 1500 ? ['2F樓店'] : []),
  }));
}

// ============ 同社區判定（fuzzy match）============
// 591 列表抓到的 community 可能跟 subject.community 有變體（多/少字、空白）
function isSameCommunity(itemCommunity, subjectCommunity) {
  if (!itemCommunity || !subjectCommunity) return false;
  const norm = s => s.replace(/\s+/g, '').replace(/大樓$/, '');
  const a = norm(itemCommunity);
  const b = norm(subjectCommunity);
  return a === b || a.includes(b) || b.includes(a);
}

// ============ 認證（先放，正式版接 shang-whitelist）============
async function checkAuth(env, request, body) {
  return { ok: true };
}

// ============ 屏東 nluz FUD 查詢 ============
// nluz.nlma.gov.tw = ArcGIS Server + token gating + session cookie 雙重認證。
// SEARCHCADA endpoint 必須在 puppeteer page session 內 fetch（cookie + token 同源），
// worker 自己 fetch 即使帶 token 也回 IIS 404（server 認不出 session）。
// 流程：puppeteer launch → goto default.aspx → IdentityManager 拿 token → 同 page fetch SEARCHCADA → close
// 不 cache token（token 綁 session、跨 session 失效）。每次查詢 ~5-10 秒。
async function fetchNluzFud(env, sect6, landno8) {
  // 注入用：sect6/landno8 為 worker 端可信值（屏東 dispatcher 構造），以 JSON.stringify 安全嵌入字串模板
  const sect6Lit = JSON.stringify(sect6);
  const landno8Lit = JSON.stringify(landno8);

  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise(r => setTimeout(r, 5000 * attempt));
    try {
      const browser = await puppeteer.launch(env.MYBROWSER);
      try {
        const page = await browser.newPage();
        await page.goto('https://nluz.nlma.gov.tw/ex3smap/default.aspx?CN=屏東縣&version=報部版', {
          waitUntil: 'networkidle0', timeout: 30000,
        });
        // 用 string 形式 evaluate 繞過 esbuild keepNames 對 callback 的 __name wrap
        const result = await page.evaluate(`new Promise(function(resolve, reject){
          var start = Date.now();
          function tryGet(){
            if (Date.now() - start > 15000) return reject(new Error('timeout waiting for IdentityManager'));
            if (!window.require) return setTimeout(tryGet, 500);
            window.require(['esri/identity/IdentityManager'], function(IM){
              var cred = IM.credentials.find(function(c){ return c.server && c.server.indexOf('nluzmap') >= 0; });
              if (!cred || !cred.token) return setTimeout(tryGet, 500);
              // 同 page session 內 fetch（自動帶 cookie + 同源 token），這是 server 接受的唯一形式
              fetch('https://nluz.nlma.gov.tw/ex3smap/ex_data?CMD=SEARCHCADA&TOKEN=' + encodeURIComponent(cred.token), {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: 'VAL1=' + encodeURIComponent(${sect6Lit}) + '&VAL2=' + encodeURIComponent(${landno8Lit})
              })
              .then(function(r){ return r.text().then(function(t){ return { status: r.status, text: t }; }); })
              .then(function(o){
                if (o.status !== 200) return resolve({ _httpError: o.status, _raw: o.text.slice(0, 300) });
                try { resolve(JSON.parse(o.text)); }
                catch(e){ resolve({ _parseError: true, _raw: o.text.slice(0, 300) }); }
              })
              .catch(function(e){ reject(e); });
            });
          }
          tryGet();
        })`);
        if (result?._httpError || result?._parseError) {
          console.log('SEARCHCADA fail:', JSON.stringify(result).slice(0, 400));
          return null;
        }
        if (!result || result.STATUS !== 1 || !result.features?.[0]) {
          console.log('SEARCHCADA empty:', JSON.stringify(result).slice(0, 300));
          return null;
        }
        const f = result.features[0];
        const a = f.attributes || {};
        return {
          fud: a['國土功能分區'] || '',
          nonUrbanZone: a['原使用分區'] || '',
          nonUrbanUse: a['原使用地'] || '',
          landUse: a['使用地'] || '',
          townName: a['鄉鎮市區'] || '',
          sectName: a['地段'] || '',
          landNo: a['地號'] || '',
          cx: f.geometry?.x ?? null,  // EPSG:3857
          cy: f.geometry?.y ?? null,
        };
      } finally {
        try { await browser.close(); } catch {}
      }
    } catch (e) {
      lastErr = e;
      const msg = String(e?.message || e);
      if (!msg.includes('429') && !msg.includes('Rate limit') && !msg.includes('Unable to create')) throw e;
    }
  }
  throw lastErr || new Error('fetchNluzFud exhausted retries');
}

// ============ Main handler ============
export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const url = new URL(request.url);

    // 屏東 nluz FUD 查詢路由（GET，前端直接 call）
    if (url.pathname === '/nluz-fud') {
      if (request.method !== 'GET') return new Response('Method Not Allowed', { status: 405, headers: CORS });
      const sect6 = url.searchParams.get('sect6');
      const landno8 = url.searchParams.get('landno8');
      if (!sect6 || !landno8) {
        return Response.json({ ok: false, error: 'sect6 and landno8 required' }, { status: 400, headers: CORS });
      }
      try {
        const data = await fetchNluzFud(env, sect6, landno8);
        if (!data) return Response.json({ ok: false, error: 'no result' }, { status: 404, headers: CORS });
        return Response.json({ ok: true, ...data }, { headers: CORS });
      } catch (e) {
        return Response.json({ ok: false, error: String(e?.message || e) }, { status: 500, headers: CORS });
      }
    }

    if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405, headers: CORS });
    if (url.pathname !== '/search') return new Response('Not Found', { status: 404, headers: CORS });

    let body;
    try { body = await request.json(); }
    catch { return Response.json({ ok: false, error: 'Invalid JSON' }, { status: 400, headers: CORS }); }

    const auth = await checkAuth(env, request, body);
    if (!auth.ok) return Response.json({ ok: false, error: auth.error || 'Unauthorized' }, { status: 401, headers: CORS });

    const { mode = 'auto', params = {}, subject = {}, sources = ['591'] } = body;

    // mode=auto 時自動填參數
    let p = { ...params };
    if (mode === 'auto') {
      p.totalAreaMin = subject.totalArea ? Math.max(0, subject.totalArea - 5) : null;
      p.totalAreaMax = subject.totalArea ? subject.totalArea + 15 : null;
      p.ageMin = subject.age ? Math.max(0, subject.age - 5) : null;
      p.ageMax = subject.age ? subject.age + 10 : null;
    }

    const start = Date.now();
    // 用戶手選的區（custom 模式下拉選單，最多 3 個）
    const userPickedDistricts = (p.customDistricts && Array.isArray(p.customDistricts) && p.customDistricts.length)
      ? p.customDistricts.slice(0, 3).filter(d => KAOHSIUNG_SECTIONS[d])
      : null;
    // 距離過濾半徑（km），預設 1.5 km（自動 / 手選都一樣，賞哥 2026-04-29 確認）
    const maxDistanceKm = typeof body.maxDistanceKm === 'number' ? body.maxDistanceKm : 1.5;

    try {
      // 0. 先 geocode subject 拿到本案座標
      const subjectQuery = subject.community
        ? `${subject.community} ${(subject.address || '').replace(/^.+市/, '高雄市')}`.trim()
        : (subject.address || '');
      const subjectLoc = await geocodeWithCache(env, normalizeForGeocode(subjectQuery));

      // 0.5 決定實際搜尋區：
      // (A) 用戶手選了 → 用手選的（custom 下拉）
      // (B) 沒手選 → 用 maxDistanceKm 圓 + reverse geocode 8 點動態算
      let nearbyDistricts = userPickedDistricts;
      if (!nearbyDistricts && subjectLoc) {
        const points = [{ lat: subjectLoc.lat, lng: subjectLoc.lng }, ...getCirclePoints(subjectLoc, maxDistanceKm)];
        const districtList = await Promise.all(points.map(p => reverseGeocodeDistrict(env, p.lat, p.lng)));
        const set = new Set(districtList.filter(Boolean).filter(d => KAOHSIUNG_SECTIONS[d]));
        if (set.size) nearbyDistricts = [...set];
      }

      // 1. 爬資料（並行多來源；591/sinyi 各自 launch browser 並行不衝突）
      const promises = [];
      if (sources.includes('591')) promises.push(
        scrape591(env, p, subject, { nearbyDistricts }).catch(e => { console.error('591 fail', e); return { items: [], stages: [], _debugInfo: { error: String(e) } }; })
      );
      if (sources.includes('sinyi')) promises.push(
        scrapeSinyi(env, p, subject, { nearbyDistricts }).catch(e => { console.error('sinyi fail', e); return { items: [], stages: [], _debugInfo: { error: String(e) } }; })
      );
      if (sources.includes('rakuya')) promises.push(
        scrapeRakuya(env, p, subject, { nearbyDistricts }).catch(e => { console.error('rakuya fail', e); return { items: [], stages: [], _debugInfo: { error: String(e) } }; })
      );
      const allByPlatform = await Promise.all(promises);
      // 各 platform 回傳 { items, stages, _debugInfo }，items 攤平、stages 收集
      const all = allByPlatform.flatMap(x => x.items || []);
      const platformStages = allByPlatform.flatMap(x => x.stages || []);
      const platformDebug = allByPlatform.find(x => x._debugInfo)?._debugInfo || null;

      // 1.2 client-side params 過濾（591 URL filter 對 mainArea / keyword 不全支援，worker 補強）
      // 同社區保留不過濾（信任 keyword + 同社區常會超出條件範圍正常，例如同社區大小坪都有）
      const passParamsFilter = (item) => {
        if (p.mainAreaMin != null && (item.mainArea || 0) < p.mainAreaMin) return false;
        if (p.mainAreaMax != null && (item.mainArea || 9999) > p.mainAreaMax) return false;
        if (p.totalAreaMin != null && (item.totalArea || 0) < p.totalAreaMin) return false;
        if (p.totalAreaMax != null && (item.totalArea || 9999) > p.totalAreaMax) return false;
        if (p.priceMin != null && (item.totalPrice || 0) < p.priceMin) return false;
        if (p.priceMax != null && (item.totalPrice || 9999999) > p.priceMax) return false;
        if (p.ageMin != null && (item.age || 0) < p.ageMin) return false;
        if (p.ageMax != null && (item.age || 9999) > p.ageMax) return false;
        if (p.keyword) {
          const blob = `${item.community || ''} ${item.title || ''} ${item.road || ''}`;
          if (!blob.includes(p.keyword)) return false;
        }
        return true;
      };
      // in-place mutate all：filter 後同社區留、其他要過 params filter
      const filtered = all.filter(item => item.matchType === 'same_community' || passParamsFilter(item));
      const droppedByParams = all.length - filtered.length;
      all.length = 0;
      all.push(...filtered);

      // 1.5 距離過濾：每筆 nearby 物件 geocode + haversine
      // 同社區（same_community）保留所有，不算距離（信任 591 keyword + isSameCommunity）
      let geoStats = {
        subjectLoc, total: 0, kept: 0, dropped: 0, ungeocoded: 0, hitL1: 0, hitL2: 0, hitL3: 0,
        nearbyDistricts, userPicked: !!userPickedDistricts, droppedByParams,
      };
      if (subjectLoc) {
        // 並行 geocode 每筆 nearby item（same_community 不算）
        const nearbyItems = all.filter(x => x.matchType !== 'same_community');
        geoStats.total = nearbyItems.length;
        const distances = await Promise.all(nearbyItems.map(async (item) => {
          const { loc, hitLevel } = await geocodeItemMultiTry(env, item);
          if (hitLevel === 1) geoStats.hitL1++;
          else if (hitLevel === 2) geoStats.hitL2++;
          else if (hitLevel === 3) geoStats.hitL3++;
          if (!loc) return null;
          return haversineKm(subjectLoc, loc);
        }));
        // mark item with distance + filter
        // 統一邏輯（賞哥 2026-04-29 確認）：自動 / 手選都套 maxDistanceKm 過濾、ungeocoded 都排除
        const survivors = [];
        for (let i = 0; i < nearbyItems.length; i++) {
          const item = nearbyItems[i];
          const d = distances[i];
          if (d == null) {
            geoStats.ungeocoded++;
            // 不 push → 排除
          } else {
            item._distanceKm = Math.round(d * 100) / 100;
            if (d <= maxDistanceKm) { survivors.push(item); geoStats.kept++; }
            else geoStats.dropped++;
          }
        }
        // 重組 all：same_community 全留 + nearby 過濾後
        const same = all.filter(x => x.matchType === 'same_community');
        all.length = 0;
        all.push(...same, ...survivors);
      }

      // 2. 歸併
      const merged = mergeItems(all);

      // 3. 分組：同社區 / 鄰近條件
      // - 階段 1（keywords=社區名）抓到的 → matchType='same_community'
      // - 但 591 keyword 搜尋可能模糊匹配到別社區，再用 community 名做二次驗證
      // - 自我比對排除（mergeKey 跟本案太像的，可能是案件本人）
      const subjectKey = subject.community && subject.totalArea ? `${subject.community}|${subject.totalArea}` : null;

      const sameCommunity = [];
      const nearby = [];
      for (const item of merged) {
        // community 名 fuzzy match → 不分 matchType 都歸 sameCommunity
        // （樂屋/信義 nearby 撞 subject community 也晉升；591 keyword 搜到但名對不上的降回 nearby）
        const reallySame = isSameCommunity(item.community, subject.community);
        if (reallySame) {
          sameCommunity.push({ ...item, matchType: 'same_community' });
        } else {
          nearby.push({ ...item, matchType: 'nearby' });
        }
      }

      // 排序：同社區依單價、鄰近依「距離 → 屋齡接近度 → 單價」
      sameCommunity.sort((a, b) => (a.unitPrice || 9999) - (b.unitPrice || 9999));
      nearby.sort((a, b) => {
        const da = a._distanceKm != null ? a._distanceKm : 999;
        const db = b._distanceKm != null ? b._distanceKm : 999;
        if (Math.abs(da - db) > 0.05) return da - db; // 50m 以上的差才用距離排
        const ageA = Math.abs((a.age || 0) - (subject.age || 0));
        const ageB = Math.abs((b.age || 0) - (subject.age || 0));
        if (ageA !== ageB) return ageA - ageB;
        return (a.unitPrice || 9999) - (b.unitPrice || 9999);
      });

      // 抓第一筆的 _raw 作為 debug 樣本（parser 對不準時可看實際 591 innerText）
      const debugSample = all.find(x => x._raw)?._raw || '';
      // 清掉 _raw 不傳到前端（每筆都有會吃流量）
      const cleanItem = x => { const { _raw, ...rest } = x; return rest; };

      return Response.json({
        ok: true,
        subject: {
          address: subject.address,
          community: subject.community,
          totalArea: subject.totalArea,
          age: subject.age,
        },
        stats: {
          rawCount: all.length,
          mergedCount: merged.length,
          sameCommunity: sameCommunity.length,
          nearby: nearby.length,
          elapsedMs: Date.now() - start,
          debugSample,            // 591 第一筆 innerText 樣本（前 350 字）
          stages: platformStages, // 每階段的 URL + 抓到筆數
          debugInfo: platformDebug, // worker 收到的 subject + 算出的 district / section
          maxDistanceKm,
          geoStats,               // { subjectLoc, total, kept, dropped, ungeocoded }
        },
        sameCommunity: sameCommunity.map(cleanItem),
        nearby: nearby.slice(0, 30).map(cleanItem),  // 鄰近最多顯示 30 筆
      }, { headers: CORS });
    } catch (e) {
      console.error('Worker error', e);
      return Response.json({ ok: false, error: String(e), stack: e.stack }, { status: 500, headers: CORS });
    }
  },
};
