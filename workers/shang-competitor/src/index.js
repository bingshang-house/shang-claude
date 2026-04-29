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

function mergeKey(item) {
  const fl = livingFloor(item.floor);
  const area = item.mainArea || item.totalArea;
  return `${item.road || '?'}|${fl}|${Math.round(area * 2) / 2}|${Math.round((item.totalPrice || 0) / 10) * 10}`;
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

  const ageMin = params.ageMin ?? 0;
  const ageMax = params.ageMax ?? 99;
  const areaMin = params.totalAreaMin ?? 0;
  const areaMax = params.totalAreaMax ?? 999;

  function buildUrl({ keywords, useFilter, firstRow = 0, sectionOverride }) {
    let u = `https://sale.591.com.tw/?regionid=17&shape=${shape}&firstRow=${firstRow}&shType=list`;
    const sectionToUse = sectionOverride !== undefined ? sectionOverride : section;
    if (useFilter) {
      u += `&houseage=${ageMin}_${ageMax}&area=${Math.floor(areaMin)}_${Math.ceil(areaMax)}`;
      if (sectionToUse) u += `&section=${sectionToUse}`;
      if (params.priceMin || params.priceMax) {
        u += `&price=${params.priceMin || 0}_${params.priceMax || 999999}`;
      }
    } else if (sectionToUse) {
      u += `&section=${sectionToUse}`;
    }
    if (keywords) u += `&keywords=${encodeURIComponent(keywords)}`;
    return u;
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
      try {
        await page.waitForSelector('.ware-item, .no-result', { timeout: 15000 });
      } catch (_) { /* 沒等到也不放棄，evaluate 看實況 */ }
      // 補一波 retry（591 SPA hydrate 偶爾再慢一點）
      let cardCount = 0;
      for (let retry = 0; retry < 4; retry++) {
        cardCount = await page.evaluate(() => document.querySelectorAll('.ware-item').length).catch(() => 0);
        if (cardCount > 0) break;
        await new Promise(r => setTimeout(r, 1000));
      }
      for (let p = 0; p < maxPages; p++) {
        const pageItems = await page.evaluate(parseListPage).catch(() => []);
        if (!pageItems.length) {
          if (p === 0) {
            pageDebug = await page.evaluate(() => ({
              cardCount: document.querySelectorAll('.ware-item').length,
              bodyTextStart: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 600),
              title: document.title,
              url: location.href,
            })).catch(e => ({ error: String(e), cardCount: 0 }));
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

  // 階段 1：同社區 keyword（不限區）
  if (subject.community) {
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

// 在頁面 context 跑的 parser
// v2.1: 591 SPA layout 變動 → community/age/district 加多重 fallback + DOM selector
function parseListPage() {
  const cards = document.querySelectorAll('.ware-item');
  const out = [];
  cards.forEach((c, idx) => {
    const t = (c.innerText || '').replace(/\s+/g, ' ').trim();
    if (!t || !/電梯大樓|公寓|透天厝|別墅/.test(t)) return;
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
    const agent = (t.match(/仲介\s*(.+?)\s+\d+人瀏覽/) || [])[1] || '';
    const hasPark = /含車位/.test(t);
    const totalPriceMatch = t.match(/([\d,]+)\s*萬\s*(?:\(\s*含車位價\s*\))?\s+[\d.]+\s*萬\/坪/);
    const totalPrice = totalPriceMatch ? parseFloat(totalPriceMatch[1].replace(/,/g, '')) : 0;
    const unitPrice = parseFloat((t.match(/([\d.]+)\s*萬\/坪/) || [])[1] || 0);

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

// ============ Main handler ============
export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405, headers: CORS });

    const url = new URL(request.url);
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
      p.totalAreaMin = subject.totalArea ? subject.totalArea - 10 : null;
      p.totalAreaMax = subject.totalArea ? subject.totalArea + 10 : null;
      p.ageMin = subject.age ? Math.max(0, subject.age - 5) : null;
      p.ageMax = subject.age ? subject.age + 5 : null;
    }

    const start = Date.now();
    // 距離過濾半徑（km），預設 1km；同社區（matchType=same_community）不受此限制
    const maxDistanceKm = typeof body.maxDistanceKm === 'number' ? body.maxDistanceKm : 1;

    try {
      // 0. 先 geocode subject 拿到本案座標
      const subjectQuery = subject.community
        ? `${subject.community} ${(subject.address || '').replace(/^.+市/, '高雄市')}`.trim()
        : (subject.address || '');
      const subjectLoc = await geocodeWithCache(env, normalizeForGeocode(subjectQuery));

      // 0.5 用本案座標 + 1km 圓周 8 點 reverse geocode → 算出真正涵蓋的區
      // 例：文橫三路三多商圈 1km 圓 → 通常只有前鎮 + 苓雅，不會碰到小港
      let nearbyDistricts = null;
      if (subjectLoc) {
        const points = [{ lat: subjectLoc.lat, lng: subjectLoc.lng }, ...getCirclePoints(subjectLoc, maxDistanceKm)];
        const districtList = await Promise.all(points.map(p => reverseGeocodeDistrict(env, p.lat, p.lng)));
        const set = new Set(districtList.filter(Boolean).filter(d => KAOHSIUNG_SECTIONS[d]));
        if (set.size) nearbyDistricts = [...set];
      }

      // 1. 爬資料（並行多來源；591 用動態算出的 nearbyDistricts）
      const promises = [];
      if (sources.includes('591')) promises.push(
        scrape591(env, p, subject, { nearbyDistricts }).catch(e => { console.error('591 fail', e); return { items: [], stages: [], _debugInfo: { error: String(e) } }; })
      );
      // TODO Phase 1B: rakuya
      const allByPlatform = await Promise.all(promises);
      // 各 platform 回傳 { items, stages, _debugInfo }，items 攤平、stages 收集
      const all = allByPlatform.flatMap(x => x.items || []);
      const platformStages = allByPlatform.flatMap(x => x.stages || []);
      const platformDebug = allByPlatform.find(x => x._debugInfo)?._debugInfo || null;

      // 1.5 距離過濾：每筆 nearby 物件 geocode + haversine
      // 同社區（same_community）保留所有，不算距離（信任 591 keyword + isSameCommunity）
      let geoStats = { subjectLoc, total: 0, kept: 0, dropped: 0, ungeocoded: 0, hitL1: 0, hitL2: 0, hitL3: 0, nearbyDistricts };
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
        // 改激進：geocode 失敗（三段 fallback 都不行）= 直接排除，不再保守保留
        // 賞哥反饋：ungeocoded 保守保留會讓超遠物件混在結果裡
        const survivors = [];
        for (let i = 0; i < nearbyItems.length; i++) {
          const item = nearbyItems[i];
          const d = distances[i];
          if (d == null) {
            geoStats.ungeocoded++;
            // 不 push survivors → 直接排除
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
        // 確認真的同社區（用 community 名 fuzzy match）
        const reallySame = isSameCommunity(item.community, subject.community);
        if (item.matchType === 'same_community' && reallySame) {
          sameCommunity.push(item);
        } else if (item.matchType === 'same_community' && !reallySame) {
          // keyword 搜到但社區名對不上 → 歸到鄰近
          nearby.push({ ...item, matchType: 'nearby' });
        } else {
          nearby.push(item);
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
