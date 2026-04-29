// shang-competitor Worker — 競品搜尋 Agent
// 流程：591 (Browser Rendering) → 跨來源 dedup → Geocode (Google Maps) → 1km 距離過濾 → JSON 回傳

import puppeteer from '@cloudflare/puppeteer';

// ============ CORS ============
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ============ 高雄市區 sectionid 對照（591）============
// 完整列表待補，先列前鎮 + 常見幾個。漏的會 fallback 用整個高雄搜
const KAOHSIUNG_SECTIONS = {
  '前鎮區': 249, '苓雅區': 248, '三民區': 246, '左營區': 247, '楠梓區': 245,
  '鼓山區': 244, '鳳山區': 250, '小港區': 251, '新興區': 243, '前金區': 242,
  '鹽埕區': 241,
};

// 建物型態 → 591 shape 參數
const SHAPE_MAP = { '公寓': 1, '電梯大樓': 2, '大樓': 2, '透天厝': 3, '透天': 3, '別墅': 4 };

// ============ Helper ============
function livingFloor(f) { return ((f || '').match(/^(\d+(?:~\d+)?)F/) || [])[1] || (f || ''); }

function mergeKey(item) {
  const fl = livingFloor(item.floor);
  const area = item.mainArea || item.totalArea;
  return `${item.road || '?'}|${fl}|${Math.round(area * 2) / 2}|${Math.round((item.totalPrice || 0) / 10) * 10}`;
}

function haversine(a, b) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function extractDistrict(addr) {
  const m = addr.match(/([一-龥]+(?:區|鄉|鎮|市))/);
  return m ? m[1] : null;
}

// ============ Geocode（Google Maps + KV cache）============
async function geocode(env, query) {
  const cacheKey = `g:${query}`;
  const cached = await env.GEOCACHE.get(cacheKey, 'json');
  if (cached) return cached;
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(query)}&language=zh-TW&region=tw&key=${env.GOOGLE_MAPS_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  if (data.status !== 'OK' || !data.results.length) {
    await env.GEOCACHE.put(cacheKey, JSON.stringify(null), { expirationTtl: 86400 }); // 1 day for failure
    return null;
  }
  const loc = data.results[0].geometry.location;
  const result = { lat: loc.lat, lon: loc.lng, display: data.results[0].formatted_address };
  await env.GEOCACHE.put(cacheKey, JSON.stringify(result), { expirationTtl: 2592000 }); // 30 days
  return result;
}

// ============ 591 爬蟲（Browser Rendering）============
async function scrape591(env, params, subject) {
  const district = extractDistrict(subject.address) || '前鎮區';
  const section = KAOHSIUNG_SECTIONS[district] || 0;
  const shape = SHAPE_MAP[subject.buildingType?.replace(/\s/g, '')] || 2;

  const ageMin = params.ageMin ?? 0;
  const ageMax = params.ageMax ?? 99;
  const areaMin = params.totalAreaMin ?? 0;
  const areaMax = params.totalAreaMax ?? 999;

  let url = `https://sale.591.com.tw/?regionid=17&shape=${shape}&houseage=${ageMin}_${ageMax}&area=${Math.floor(areaMin)}_${Math.ceil(areaMax)}&firstRow=0&shType=list`;
  if (section) url += `&section=${section}`;
  if (params.keyword) url += `&keywords=${encodeURIComponent(params.keyword)}`;
  if (params.priceMin || params.priceMax) {
    url += `&price=${params.priceMin || 0}_${params.priceMax || 999999}`;
  }

  const browser = await puppeteer.launch(env.MYBROWSER);
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/121.0.0.0 Safari/537.36');

  const allItems = [];
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('.ware-item, .no-result', { timeout: 10000 }).catch(() => null);

    const maxPages = parseInt(env.DEFAULT_PAGES || '5', 10);
    for (let p = 0; p < maxPages; p++) {
      // wait for cards render
      await new Promise(r => setTimeout(r, 600));
      const items = await page.evaluate(parseListPage);
      if (!items.length) break;
      allItems.push(...items);
      // click next page
      const hasNext = await page.evaluate(() => {
        const next = [...document.querySelectorAll('span,a,button')].find(e => e.textContent.trim() === '下一頁');
        if (!next || next.classList.contains('disabled')) return false;
        next.click();
        return true;
      });
      if (!hasNext) break;
      await new Promise(r => setTimeout(r, 1500));
    }
  } finally {
    await browser.close();
  }
  return allItems.map(x => ({ ...x, source: '591' }));
}

// 在頁面 context 跑的 parser（會 serialize 到 browser 內執行）
function parseListPage() {
  const cards = document.querySelectorAll('.ware-item');
  const out = [];
  cards.forEach(c => {
    const t = (c.innerText || '').replace(/\s+/g, ' ').trim();
    if (!t || !/電梯大樓|公寓|透天厝|別墅/.test(t)) return;
    const link = c.querySelector('a[href*="/home/house/detail/"]');
    const href = link ? link.href.split('#')[0].split('?')[0] : '';
    const img = c.querySelector('img');
    const imgSrc = img ? (img.dataset.src || img.src || '') : '';
    let title = '';
    const tm = t.match(/(?:精選|置頂|NEW)\s+(.+?)(?:NEW)?\s+(?:電梯大樓|公寓|透天厝|別墅)/);
    if (tm) title = tm[1].trim().replace(/NEW$/, '').trim();
    else { const m2 = t.match(/^[\d\s]*(.+?)\s+(?:電梯大樓|公寓|透天厝|別墅)/); title = m2 ? m2[1].trim() : ''; }
    const rooms = t.match(/(\d+)房(\d+)廳(\d+)衛/);
    const totalArea = parseFloat((t.match(/權狀\s*([\d.]+)\s*坪/) || [])[1] || 0);
    const mainArea = parseFloat((t.match(/主建\s*([\d.]+)\s*坪/) || [])[1] || 0);
    const age = parseFloat((t.match(/坪\s+(\d+)\s*年\s+\d+F/) || [])[1] || 0);
    const floor = (t.match(/(\d+(?:~\d+)?F\/\d+F)/) || [])[1] || '';
    // 動態抓區名（不寫死「前鎮區」）：一次抓 (社區)(區)(路)
    const m3 = t.match(/\d+(?:~\d+)?F\/\d+F\s+(\S+?)\s+([一-鿿]{1,3}區)[\-\s]+(\S+?)\s+仲介/);
    const community = m3 ? m3[1] : '';
    const district = m3 ? m3[2] : '';
    const road = m3 ? m3[3] : '';
    const agent = (t.match(/仲介\s*(.+?)\s+\d+人瀏覽/) || [])[1] || '';
    const hasPark = /含車位/.test(t);
    const totalPriceMatch = t.match(/([\d,]+)\s*萬\s*(?:\(\s*含車位價\s*\))?\s+[\d.]+\s*萬\/坪/);
    const totalPrice = totalPriceMatch ? parseFloat(totalPriceMatch[1].replace(/,/g, '')) : 0;
    const unitPrice = parseFloat((t.match(/([\d.]+)\s*萬\/坪/) || [])[1] || 0);
    out.push({ title, community, road, district, rooms: rooms ? `${rooms[1]}房${rooms[2]}廳${rooms[3]}衛` : '', totalArea, mainArea, age, floor, agent, hasPark, totalPrice, unitPrice, href, imgSrc });
  });
  return out;
}

// ============ 跨平台歸併 ============
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
      // 保留首個非空的 district
      if (item.district && !x.district) x.district = item.district;
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

// ============ 認證（簡化版，先放過，正式版接 shang-whitelist）============
async function checkAuth(env, request, body) {
  // TODO: 整合 shang-whitelist 驗證 idToken
  // 目前測試階段先全放
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
      p.ageMin = subject.age ? subject.age - 5 : null;
      p.ageMax = subject.age ? subject.age + 5 : null;
      p.radiusM = 1000;
    }
    p.radiusM = p.radiusM || 1000;

    const start = Date.now();

    try {
      // 1. 爬資料（並行多來源）
      const promises = [];
      if (sources.includes('591')) promises.push(scrape591(env, p, subject).catch(e => { console.error('591 fail', e); return []; }));
      // TODO: rakuya
      const allByPlatform = await Promise.all(promises);
      const all = allByPlatform.flat();

      // 2. Geocode 本案
      const subjQuery = subject.community ? `${subject.community} ${subject.address}` : subject.address;
      const subjLoc = await geocode(env, subjQuery) || (subject.address ? await geocode(env, subject.address) : null);

      // 3. 歸併
      const merged = mergeItems(all);

      // 4. Geocode 每筆獨立物件（並行批次，但限速避免撞 Google QPS）
      // 用 item 自己抓到的 district（591 列表標的真實所在區）；fallback subject 地址抽出的區
      const fallbackDistrict = extractDistrict(subject.address) || '前鎮區';
      const geocodeBatch = async (items, batchSize = 10) => {
        for (let i = 0; i < items.length; i += batchSize) {
          await Promise.all(items.slice(i, i + batchSize).map(async (item) => {
            const dist = item.district || fallbackDistrict;
            const queries = [];
            if (item.community) queries.push(`${item.community} 高雄市${dist}`);
            if (item.road) queries.push(`高雄市${dist}${item.road}`);
            // 最後 fallback：只用區
            if (!queries.length && dist) queries.push(`高雄市${dist}`);
            for (const q of queries) {
              const loc = await geocode(env, q);
              if (loc) { item.lat = loc.lat; item.lon = loc.lon; break; }
            }
          }));
        }
      };
      await geocodeBatch(merged);

      // 5. 距離計算 + 過濾
      for (const item of merged) {
        if (item.lat && subjLoc) item.distance = Math.round(haversine(subjLoc, { lat: item.lat, lon: item.lon }));
        else item.distance = null;
      }

      const within = merged.filter(x => x.distance != null && x.distance <= p.radiusM).sort((a, b) => a.distance - b.distance || a.unitPrice - b.unitPrice);
      const beyond = merged.filter(x => x.distance != null && x.distance > p.radiusM).sort((a, b) => a.distance - b.distance);
      const failed = merged.filter(x => x.distance == null);

      // 6. 排名
      within.forEach((x, i) => x.rank = i + 1);

      return Response.json({
        ok: true,
        subject: subjLoc ? { ...subjLoc, address: subject.address } : { address: subject.address },
        stats: {
          rawCount: all.length,
          mergedCount: merged.length,
          withinRadius: within.length,
          beyondRadius: beyond.length,
          geocodeFailed: failed.length,
          elapsedMs: Date.now() - start,
        },
        items: within,
        beyond: beyond.slice(0, 50),
        failed: failed.slice(0, 30),
      }, { headers: CORS });
    } catch (e) {
      console.error('Worker error', e);
      return Response.json({ ok: false, error: String(e), stack: e.stack }, { status: 500, headers: CORS });
    }
  },
};
