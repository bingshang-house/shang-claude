// scrape-competitor.js — GHA cron 每小時跑一次
// 三家 (591/sinyi/rakuya) × 主要 12 高雄市區 × Playwright 抓清單 → 寫 Cloudflare KV
// 用 env: CF_ACCOUNT_ID, CF_API_TOKEN, CF_KV_NAMESPACE_ID
//
// 統一 item schema：
// { source, productType, community, road, district, rooms, totalArea, mainArea, age, floor, totalPrice, unitPrice, hasPark, href, imgSrc }

import { chromium } from 'playwright';

// ============ 高雄市區對照（591 section / sinyi+rakuya zipcode） ============
// 主要 12 個市區 + 涵蓋率 95%+ 案件，郊區未來再擴
const KAOHSIUNG_DISTRICTS = [
  { name: '前鎮區', section: 249, zip: '806' },
  { name: '苓雅區', section: 245, zip: '802' },
  { name: '鳳山區', section: 268, zip: '830' },
  { name: '小港區', section: 252, zip: '812' },
  { name: '三民區', section: 250, zip: '807' },
  { name: '左營區', section: 253, zip: '813' },
  { name: '楠梓區', section: 251, zip: '811' },
  { name: '鼓山區', section: 247, zip: '804' },
  { name: '新興區', section: 243, zip: '800' },
  { name: '前金區', section: 244, zip: '801' },
  { name: '鹽埕區', section: 246, zip: '803' },
  { name: '旗津區', section: 248, zip: '805' },
];

// ============ 591 各 vertical 對照（沿用 worker 內 PRODUCT_VERTICAL）============
const SHAPE_PRODUCTS = [
  { productType: 'apartment', shape: 1 },
  { productType: 'dalou',     shape: 2 },
  { productType: 'townhouse', shape: 3 },
];

const BUSINESS_PRODUCTS = [
  { productType: 'store',   kind: 5 },
  { productType: 'office',  kind: 6 },
  { productType: 'factory', kind: 7 },
];

const LAND_PRODUCT = { productType: 'land', kind: 11 };

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

// ============ 591 sale.591 抓取（住宅三型）============
async function scrape591Sale(page, section, productType, shape, maxPages = 3) {
  const items = [];
  for (let p = 0; p < maxPages; p++) {
    const url = `https://sale.591.com.tw/?regionid=17&shape=${shape}&shType=list&firstRow=${p * 30}&section=${section}`;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });
    } catch (e) { console.warn(`[591 sale ${productType} sec=${section} p=${p}] goto:`, e.message); }
    try {
      await page.waitForSelector('.ware-item, .no-result', { timeout: 15000 });
    } catch (_) {}
    const pageItems = await page.evaluate((pt) => {
      const cards = document.querySelectorAll('.ware-item');
      const out = [];
      cards.forEach((c) => {
        const t = (c.innerText || '').replace(/\s+/g, ' ').trim();
        if (!t || !/電梯大樓|公寓|透天厝|別墅/.test(t)) return;
        const link = c.querySelector('a[href*="/home/house/detail/"]');
        const href = link ? link.href.split('#')[0].split('?')[0] : '';
        const img = c.querySelector('img');
        const imgSrc = img ? (img.dataset.src || img.src || '') : '';
        let title = '';
        for (const sel of ['.ware-item-title', '.title', '.name', 'h3', 'h4']) {
          const el = c.querySelector(sel);
          if (el && el.textContent.trim()) { title = el.textContent.trim(); break; }
        }
        if (!title) {
          const tm = t.match(/(?:精選|置頂|NEW)\s+(.+?)(?:NEW)?\s+(?:電梯大樓|公寓|透天厝|別墅)/);
          if (tm) title = tm[1].trim().replace(/NEW$/, '').trim();
        }
        let community = '', district = '', road = '';
        const m3 = t.match(/\d+(?:~\d+)?F\/\d+F\s+([一-鿿\w]+?)([一-鿿]{1,3}區)[\-\s]+([一-鿿\w]+?)\s+仲介/);
        if (m3) { community = m3[1]; district = m3[2]; road = m3[3]; }
        if (!district) {
          const m4 = t.match(/([一-鿿]{1,3}區)[\-\s]+([一-鿿\d]{1,15})/);
          if (m4) { district = m4[1]; if (!road) road = m4[2]; }
        }
        let age = 0;
        const ageRegexes = [
          /(?:屋齡|齡)\s*[:：]?\s*(\d+)\s*年/,
          /(\d+)\s*年屋齡/,
          /坪\s*(\d{1,2})\s*年\s*\d+(?:~\d+)?F/,
          /(\d{1,2})\s*年\s*\d+(?:~\d+)?F\/\d+F/,
        ];
        for (const re of ageRegexes) {
          const m = t.match(re);
          if (m && parseInt(m[1]) > 0 && parseInt(m[1]) < 100) { age = parseFloat(m[1]); break; }
        }
        const rooms = t.match(/(\d+)房(\d+)廳(\d+)衛/);
        const totalArea = parseFloat((t.match(/權狀\s*([\d.]+)\s*坪/) || [])[1] || 0);
        const mainArea = parseFloat((t.match(/主建\s*([\d.]+)\s*坪/) || [])[1] || 0);
        const floor = (t.match(/(\d+(?:~\d+)?F\/\d+F)/) || [])[1] || '';
        const hasPark = /含車位/.test(t);
        const tpm = t.match(/([\d,]+)\s*萬\s*(?:\(\s*含車位價\s*\))?\s+[\d.]+\s*萬\/坪/);
        const totalPrice = tpm ? parseFloat(tpm[1].replace(/,/g, '')) : 0;
        const unitPrice = parseFloat((t.match(/([\d.]+)\s*萬\/坪/) || [])[1] || 0);
        if (!totalArea || totalArea < 5 || !totalPrice || totalPrice < 50 || !href) return;
        out.push({
          source: '591', productType: pt, title, community, road, district,
          rooms: rooms ? `${rooms[1]}房${rooms[2]}廳${rooms[3]}衛` : '',
          totalArea, mainArea, age, floor, hasPark, totalPrice, unitPrice, href, imgSrc,
        });
      });
      return out;
    }, productType).catch(() => []);
    if (!pageItems.length) break;
    items.push(...pageItems);
  }
  return items;
}

// ============ 591 land/business（土地/店面/辦公/廠房）============
async function scrape591ItemPage(page, urlBuilder, productType, maxPages = 3) {
  const items = [];
  for (let p = 1; p <= maxPages; p++) {
    const url = urlBuilder(p);
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });
    } catch (e) { console.warn(`[591 ${productType} p=${p}] goto:`, e.message); }
    try {
      await page.waitForSelector('.item, .no-result', { timeout: 15000 });
    } catch (_) {}
    const pageItems = await page.evaluate((pt) => {
      const cards = document.querySelectorAll('.item');
      const out = [];
      cards.forEach((c) => {
        const t = (c.innerText || '').replace(/\s+/g, ' ').trim();
        if (!t) return;
        const link = c.querySelector('a[href*="/sale/"], a[href*="/buy/"], a[href*="/item/"], a[href*="/detail/"], a[href]');
        const href = link ? link.href.split('#')[0].split('?')[0] : '';
        const img = c.querySelector('img');
        const imgSrc = img ? (img.dataset.src || img.src || '') : '';
        const totalArea = parseFloat((t.match(/(\d+(?:\.\d+)?)\s*坪/) || [])[1] || 0);
        const tpm = t.match(/([\d,]+(?:\.\d+)?)\s*萬\s+[\d.]+\s*萬\/坪/);
        const totalPrice = tpm ? parseFloat(tpm[1].replace(/,/g, '')) : 0;
        const unitPrice = parseFloat((t.match(/([\d.]+)\s*萬\/坪/) || [])[1] || 0);
        const distM = t.match(/([一-鿿]{1,3}區)[\-\s]+([一-鿿\w\d]{1,15}?)(?:\s|$|距)/);
        const district = distM ? distM[1] : '';
        const road = distM ? distM[2] : '';
        let title = '';
        const tm = t.match(/^(?:精選\s*|置頂\s*|地號已核實\s*|NEW\s*|\d+\s*)*(.+?)\s+\d+(?:\.\d+)?\s*坪/);
        if (tm) title = tm[1].trim();
        if (!totalArea || totalArea < 1 || !totalPrice || totalPrice < 50 || !href) return;
        out.push({
          source: '591', productType: pt, title, community: '', road, district,
          rooms: '', totalArea, mainArea: 0, age: 0, floor: '', hasPark: false,
          totalPrice, unitPrice, href, imgSrc,
        });
      });
      return out;
    }, productType).catch(() => []);
    if (!pageItems.length) break;
    items.push(...pageItems);
  }
  return items;
}

// ============ 信義房屋 ============
async function scrapeSinyi(page, zip, maxPages = 3) {
  const items = [];
  for (let p = 1; p <= maxPages; p++) {
    const url = `https://www.sinyi.com.tw/buy/list/Kaohsiung-city/${zip}-zip/default-desc/${p}`;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });
    } catch (e) { console.warn(`[sinyi zip=${zip} p=${p}] goto:`, e.message); }
    try {
      await page.waitForSelector('.buy-list-item, .LongInfoCard_Type_Wrap, .no-result', { timeout: 15000 });
    } catch (_) {}
    const pageItems = await page.evaluate(() => {
      const cards = document.querySelectorAll('.buy-list-item, .LongInfoCard_Type_Wrap');
      const out = [];
      cards.forEach((c) => {
        const t = (c.innerText || '').replace(/\s+/g, ' ').trim();
        if (!t) return;
        const link = c.querySelector('a[href*="/buy/house/"], a[href]');
        const href = link ? link.href.split('#')[0].split('?')[0] : '';
        const img = c.querySelector('img');
        const imgSrc = img ? (img.dataset.src || img.src || '') : '';
        const totalArea = parseFloat((t.match(/權狀\s*([\d.]+)\s*坪/) || t.match(/總坪\s*([\d.]+)\s*坪/) || t.match(/([\d.]+)\s*坪/) || [])[1] || 0);
        const mainArea = parseFloat((t.match(/主建\s*([\d.]+)\s*坪/) || [])[1] || 0);
        const totalPrice = parseFloat((t.match(/([\d,]+)\s*萬/) || [])[1]?.replace(/,/g, '') || 0);
        const unitPrice = parseFloat((t.match(/([\d.]+)\s*萬\/坪/) || [])[1] || 0);
        const ageM = t.match(/(\d+(?:\.\d+)?)\s*年/);
        const age = ageM ? parseFloat(ageM[1]) : 0;
        const rooms = t.match(/(\d+)房(\d+)廳(\d+)衛/);
        const floor = (t.match(/(\d+)\/(\d+)F?/) || []).slice(1).join('/') || '';
        const distM = t.match(/([一-鿿]{1,3}區)/);
        const district = distM ? distM[1] : '';
        const titleEl = c.querySelector('.buy-list-item-title, h3, h4, [class*="title"], [class*="Title"]');
        const title = titleEl ? titleEl.textContent.trim() : '';
        const communityEl = c.querySelector('[class*="community"], [class*="Community"]');
        const community = communityEl ? communityEl.textContent.trim() : '';
        const roadEl = c.querySelector('[class*="address"], [class*="Address"]');
        const road = roadEl ? roadEl.textContent.trim().replace(/\d+號.*$/, '').replace(/\s/g, '') : '';
        const hasPark = /含車位|附車位|平面車位|機械車位/.test(t);
        if (!totalArea || totalArea < 5 || !totalPrice || totalPrice < 50 || !href) return;
        out.push({
          source: 'sinyi', productType: 'dalou',
          title, community, road, district,
          rooms: rooms ? `${rooms[1]}房${rooms[2]}廳${rooms[3]}衛` : '',
          totalArea, mainArea, age, floor: floor ? `${floor.split('/')[0]}F/${floor.split('/')[1]}F` : '',
          hasPark, totalPrice, unitPrice, href, imgSrc,
        });
      });
      return out;
    }).catch(() => []);
    if (!pageItems.length) break;
    items.push(...pageItems);
  }
  return items;
}

// ============ 樂屋網 ============
async function scrapeRakuya(page, zip, maxPages = 5) {
  const items = [];
  for (let p = 1; p <= maxPages; p++) {
    const url = `https://www.rakuya.com.tw/sell/result?zipcode=${zip}&page=${p}`;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });
    } catch (e) { console.warn(`[rakuya zip=${zip} p=${p}] goto:`, e.message); }
    try {
      await page.waitForSelector('section.grid-item.search-obj, .no-result', { timeout: 15000 });
    } catch (_) {}
    const pageItems = await page.evaluate(() => {
      const cards = document.querySelectorAll('section.grid-item.search-obj');
      const out = [];
      cards.forEach((c) => {
        const t = (c.innerText || '').replace(/\s+/g, ' ').trim();
        if (!t) return;
        const link = c.querySelector('a[href*="/info"], a[href]');
        const href = link ? link.href.split('#')[0].split('?')[0] : '';
        const img = c.querySelector('img');
        const imgSrc = img ? (img.src || img.dataset.src || '') : '';
        // 「俯瞰海天交界，收藏高雄最美天際線.國城定潮 新上架 前鎮區 國城定潮 電梯大廈 3房2廳3衛 3.9年 22/41樓 總建123.27坪 主建57.8坪 67.07萬/坪 8,268萬 ...」
        const distM = t.match(/([一-鿿]{1,3}區)\s+([一-鿿\w\d]+?)\s+(?:電梯大廈|公寓|透天厝|別墅|大樓|店面|辦公|廠房|套房)/);
        const district = distM ? distM[1] : '';
        const community = distM ? distM[2] : '';
        const typeM = t.match(/(電梯大廈|公寓|透天厝|別墅|大樓|店面|辦公|廠房|套房)/);
        const buildingType = typeM ? typeM[1] : '';
        const productType = /公寓/.test(buildingType) ? 'apartment' : /透天|別墅/.test(buildingType) ? 'townhouse' : /店面/.test(buildingType) ? 'store' : /辦公/.test(buildingType) ? 'office' : /廠房/.test(buildingType) ? 'factory' : 'dalou';
        const rooms = t.match(/(\d+)房(\d+)廳(\d+)衛/);
        const ageM = t.match(/(\d+(?:\.\d+)?)\s*年(?!\D*月)/);
        const age = ageM ? parseFloat(ageM[1]) : 0;
        const floorM = t.match(/(\d+)\/(\d+)樓/);
        const floor = floorM ? `${floorM[1]}F/${floorM[2]}F` : '';
        const totalArea = parseFloat((t.match(/總建\s*([\d.]+)\s*坪/) || [])[1] || 0);
        const mainArea = parseFloat((t.match(/主建\s*([\d.]+)\s*坪/) || [])[1] || 0);
        const unitPrice = parseFloat((t.match(/([\d.]+)\s*萬\/坪/) || [])[1] || 0);
        const tpM = t.match(/([\d,]+(?:\.\d+)?)\s*萬(?!\/)/);
        const totalPrice = tpM ? parseFloat(tpM[1].replace(/,/g, '')) : 0;
        const hasPark = /車位|附車位|平面車位|機械車位/.test(t);
        // road 樂屋列表沒給，留空
        const road = '';
        if (!totalArea || totalArea < 5 || !totalPrice || totalPrice < 50 || !href) return;
        out.push({
          source: 'rakuya', productType,
          title: '', community, road, district,
          rooms: rooms ? `${rooms[1]}房${rooms[2]}廳${rooms[3]}衛` : '',
          totalArea, mainArea, age, floor, hasPark, totalPrice, unitPrice, href, imgSrc,
        });
      });
      return out;
    }).catch(() => []);
    if (!pageItems.length) break;
    items.push(...pageItems);
  }
  return items;
}

// ============ 上傳 KV ============
async function putKV(env, key, value) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/storage/kv/namespaces/${env.CF_KV_NAMESPACE_ID}/values/${encodeURIComponent(key)}`;
  const r = await fetch(url, {
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${env.CF_API_TOKEN}`, 'Content-Type': 'text/plain' },
    body: typeof value === 'string' ? value : JSON.stringify(value),
  });
  if (!r.ok) throw new Error(`KV PUT ${key} failed: ${r.status} ${await r.text()}`);
}

// ============ 主流程 ============
async function main() {
  const env = {
    CF_ACCOUNT_ID: process.env.CF_ACCOUNT_ID,
    CF_API_TOKEN: process.env.CF_API_TOKEN,
    CF_KV_NAMESPACE_ID: process.env.CF_KV_NAMESPACE_ID,
  };
  for (const k of Object.keys(env)) {
    if (!env[k]) { console.error(`Missing env ${k}`); process.exit(1); }
  }

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1366, height: 900 } });
  const page = await ctx.newPage();
  // abort image/font/media 省頻寬
  await page.route('**/*', (route) => {
    const type = route.request().resourceType();
    if (['image', 'media', 'font'].includes(type)) return route.abort();
    return route.continue();
  });

  const startTime = Date.now();
  const stats = { totalItems: 0, perDistrict: {}, errors: [] };

  for (const dist of KAOHSIUNG_DISTRICTS) {
    console.log(`\n=== ${dist.name} (591 sec=${dist.section} / zip=${dist.zip}) ===`);
    stats.perDistrict[dist.name] = {};
    // 591 住宅三型
    for (const sp of SHAPE_PRODUCTS) {
      try {
        const items = await scrape591Sale(page, dist.section, sp.productType, sp.shape, 3);
        await putKV(env, `591:${sp.productType}:${dist.section}`, items);
        stats.perDistrict[dist.name][`591-${sp.productType}`] = items.length;
        stats.totalItems += items.length;
        console.log(`  591 ${sp.productType}: ${items.length}`);
      } catch (e) { stats.errors.push(`591-${sp.productType}-${dist.name}: ${e.message}`); }
    }
    // 591 店面/辦公/廠房
    for (const bp of BUSINESS_PRODUCTS) {
      try {
        const items = await scrape591ItemPage(page,
          (p) => `https://business.591.com.tw/list?type=2&region=17&kind=${bp.kind}&section=${dist.section}&page=${p}`,
          bp.productType, 2);
        await putKV(env, `591:${bp.productType}:${dist.section}`, items);
        stats.perDistrict[dist.name][`591-${bp.productType}`] = items.length;
        stats.totalItems += items.length;
        console.log(`  591 ${bp.productType}: ${items.length}`);
      } catch (e) { stats.errors.push(`591-${bp.productType}-${dist.name}: ${e.message}`); }
    }
    // 591 土地
    try {
      const items = await scrape591ItemPage(page,
        (p) => `https://land.591.com.tw/list?type=2&region=17&kind=11&section=${dist.section}&page=${p}`,
        'land', 2);
      await putKV(env, `591:land:${dist.section}`, items);
      stats.perDistrict[dist.name]['591-land'] = items.length;
      stats.totalItems += items.length;
      console.log(`  591 land: ${items.length}`);
    } catch (e) { stats.errors.push(`591-land-${dist.name}: ${e.message}`); }

    // 信義
    try {
      const items = await scrapeSinyi(page, dist.zip, 3);
      await putKV(env, `sinyi:${dist.zip}`, items);
      stats.perDistrict[dist.name]['sinyi'] = items.length;
      stats.totalItems += items.length;
      console.log(`  sinyi: ${items.length}`);
    } catch (e) { stats.errors.push(`sinyi-${dist.name}: ${e.message}`); }

    // 樂屋
    try {
      const items = await scrapeRakuya(page, dist.zip, 5);
      await putKV(env, `rakuya:${dist.zip}`, items);
      stats.perDistrict[dist.name]['rakuya'] = items.length;
      stats.totalItems += items.length;
      console.log(`  rakuya: ${items.length}`);
    } catch (e) { stats.errors.push(`rakuya-${dist.name}: ${e.message}`); }
  }

  await putKV(env, '_meta:lastRun', {
    time: new Date().toISOString(),
    elapsedSec: Math.round((Date.now() - startTime) / 1000),
    stats,
  });

  await browser.close();
  console.log(`\n✅ 完成 ${stats.totalItems} 筆，耗時 ${Math.round((Date.now() - startTime) / 1000)}s`);
  if (stats.errors.length) console.log(`⚠ ${stats.errors.length} 個錯誤:\n  ${stats.errors.join('\n  ')}`);
  process.exit(0);
}

main().catch(e => { console.error('fatal:', e); process.exit(1); });
