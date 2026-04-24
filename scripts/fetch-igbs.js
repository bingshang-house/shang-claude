#!/usr/bin/env node
// 從 igbs-tabc.org 抓高雄市三大標章資料存成 JSON
// 綠建築 / 智慧建築 / 建築能效（BERS）
// 給 GHA 每兩週跑一次用，也可以手動本地跑

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

const ENDPOINTS = [
  {
    name: 'green',
    url: 'https://igbs-tabc.org/igbs/GreenBuilding_Json2.aspx',
    body: 'BuildingName=&District=高雄市&DataType=&GradeEvaluation=',
    file: 'igbs-green.json',
  },
  {
    name: 'smart',
    url: 'https://igbs-tabc.org/igbs/IntelligentBuilding_Json2.aspx',
    body: 'BuildingName=&City=高雄市&Classification=&SmartBuildingLevel=',
    file: 'igbs-smart.json',
  },
  {
    name: 'bers',
    url: 'https://igbs-tabc.org/igbs/BERS_Json2.aspx',
    body: 'BuildingName=&District=高雄市&DataType=&GradeEvaluation=',
    file: 'igbs-bers.json',
  },
];

async function fetchWithRetry(ep, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(ep.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: encodeURI(ep.body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const arr = await res.json();
      if (!Array.isArray(arr)) throw new Error('not array');
      return arr;
    } catch (e) {
      lastErr = e;
      if (i < tries - 1) await new Promise(r => setTimeout(r, 800 * (i + 1)));
    }
  }
  throw lastErr;
}

(async () => {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  const summary = { updatedAt: new Date().toISOString(), counts: {} };

  for (const ep of ENDPOINTS) {
    console.log(`[${ep.name}] fetching...`);
    const arr = await fetchWithRetry(ep);
    // 部分端點會混入高雄縣舊資料或外縣市髒資料，這裡只做最基本過濾
    const filtered = arr.filter(r => {
      const city = r.CountyCity || r.City || r.District || '';
      return /高雄/.test(city);
    });
    const outPath = path.join(DATA_DIR, ep.file);
    fs.writeFileSync(outPath, JSON.stringify(filtered, null, 0) + '\n');
    summary.counts[ep.name] = filtered.length;
    console.log(`[${ep.name}] ${filtered.length} 筆 → ${ep.file}`);
  }

  fs.writeFileSync(
    path.join(DATA_DIR, 'igbs-meta.json'),
    JSON.stringify(summary, null, 2) + '\n'
  );
  console.log('\n✅ 完成', summary);
})().catch(e => {
  console.error('❌ 失敗:', e);
  process.exit(1);
});
