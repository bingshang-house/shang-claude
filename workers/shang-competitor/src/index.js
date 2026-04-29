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
const KAOHSIUNG_SECTIONS = {
  '前鎮區': 249, '苓雅區': 248, '三民區': 246, '左營區': 247, '楠梓區': 245,
  '鼓山區': 244, '鳳山區': 250, '小港區': 251, '新興區': 243, '前金區': 242,
  '鹽埕區': 241,
};

// 建物型態 → 591 shape 參數
const SHAPE_MAP = { '公寓': 1, '電梯大樓': 2, '大樓': 2, '透天厝': 3, '透天': 3, '別墅': 4 };

// ============ Helper ============
function livingFloor(f) { return ((f || '').match(/^(\d+(?:~\d+)?)F/) || [])[1] || (f || ''); }

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
async function scrape591(env, params, subject) {
  const district = extractDistrict(subject.address) || '前鎮區';
  const section = KAOHSIUNG_SECTIONS[district] || 0;
  const shape = SHAPE_MAP[subject.buildingType?.replace(/\s/g, '')] || 2;

  const ageMin = params.ageMin ?? 0;
  const ageMax = params.ageMax ?? 99;
  const areaMin = params.totalAreaMin ?? 0;
  const areaMax = params.totalAreaMax ?? 999;

  function buildUrl({ keywords, useFilter, firstRow = 0 }) {
    let u = `https://sale.591.com.tw/?regionid=17&shape=${shape}&firstRow=${firstRow}&shType=list`;
    if (useFilter) {
      u += `&houseage=${ageMin}_${ageMax}&area=${Math.floor(areaMin)}_${Math.ceil(areaMax)}`;
      if (section) u += `&section=${section}`;
      if (params.priceMin || params.priceMax) {
        u += `&price=${params.priceMin || 0}_${params.priceMax || 999999}`;
      }
    } else if (section) {
      u += `&section=${section}`;
    }
    if (keywords) u += `&keywords=${encodeURIComponent(keywords)}`;
    return u;
  }

  const browser = await puppeteer.launch(env.MYBROWSER);
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/121.0.0.0 Safari/537.36');

  // 阻擋圖片/CSS/字型/媒體/廣告，避免撞 CF Workers 1000 subrequest 上限
  await page.setRequestInterception(true);
  page.on('request', req => {
    const type = req.resourceType();
    const u = req.url();
    if (type === 'image' || type === 'media' || type === 'font' || type === 'stylesheet') return req.abort();
    if (/google-analytics|googletagmanager|doubleclick|facebook\.(com|net)|hotjar|criteo|googlesyndication|adservice|tiktok|line-scdn|tagcommander|matomo|sentry/.test(u)) return req.abort();
    req.continue();
  });

  async function scrapePages(url, maxPages, matchType) {
    const items = [];
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForSelector('.ware-item, .no-result', { timeout: 10000 }).catch(() => null);
      for (let p = 0; p < maxPages; p++) {
        await new Promise(r => setTimeout(r, 600));
        const pageItems = await page.evaluate(parseListPage);
        if (!pageItems.length) break;
        pageItems.forEach(x => x.matchType = matchType);
        items.push(...pageItems);
        if (p === maxPages - 1) break;
        const hasNext = await page.evaluate(() => {
          const next = [...document.querySelectorAll('span,a,button')].find(e => e.textContent.trim() === '下一頁');
          if (!next || next.classList.contains('disabled')) return false;
          next.click();
          return true;
        });
        if (!hasNext) break;
        await new Promise(r => setTimeout(r, 1500));
      }
    } catch (e) {
      console.error(`scrape stage failed (${matchType})`, e);
    }
    return items;
  }

  const allItems = [];

  // 階段 1：同社區（用 community 名搜尋，1 頁就夠 — 一個社區掛賣通常 < 30 筆）
  if (subject.community) {
    const url1 = buildUrl({ keywords: subject.community, useFilter: false });
    const stage1 = await scrapePages(url1, 1, 'same_community');
    allItems.push(...stage1);
  }

  // 階段 2：鄰近條件（同區 + ±10 坪 / ±5 年）
  const url2 = buildUrl({ useFilter: true });
  const stage2 = await scrapePages(url2, 3, 'nearby');
  allItems.push(...stage2);

  await browser.close();
  return allItems.map(x => ({ ...x, source: '591' }));
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

    try {
      // 1. 爬資料（並行多來源）
      const promises = [];
      if (sources.includes('591')) promises.push(scrape591(env, p, subject).catch(e => { console.error('591 fail', e); return []; }));
      // TODO Phase 1B: rakuya
      const allByPlatform = await Promise.all(promises);
      const all = allByPlatform.flat();

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

      // 排序：同社區依單價、鄰近依屋齡接近度 + 單價
      sameCommunity.sort((a, b) => (a.unitPrice || 9999) - (b.unitPrice || 9999));
      nearby.sort((a, b) => {
        const ageDiff = (subject.age || 0);
        const da = Math.abs((a.age || 0) - ageDiff);
        const db = Math.abs((b.age || 0) - ageDiff);
        if (da !== db) return da - db;
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
          debugSample,  // 591 第一筆 innerText 樣本（前 350 字）
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
