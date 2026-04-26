/**
 * tax-lib.js 單元測試 — 對照 etax 試算實測結果
 *
 * 用法：node scripts/test-tax-lib.js
 */

const fs = require('fs');
const path = require('path');
const lib = require('../tax-lib.js');

const cpiData = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'data', 'cpi-tax-index.json'), 'utf-8')
);

let pass = 0, fail = 0;

function expect(label, actual, expected) {
  const ok = actual === expected;
  console.log(`${ok ? '✅' : '❌'} ${label}: ${actual}${ok ? '' : ` (expected ${expected})`}`);
  if (ok) pass++; else fail++;
}

// ========== Test 1: 旗津段 0900-0060（持分 1/12，漲價 = 0）==========
console.log('\n--- Test 1: 旗津 0900-0060 (4 年, 漲價=0) ---');
{
  const cpi = lib.cpiLookup(cpiData, 111, 10);
  expect('CPI 111/10', cpi, 106.4);

  const r = lib.calcLandFull({
    currentValue: 33500,
    previousValue: 32500,
    cpiIndex: cpi,
    area: 178,
    numerator: 1,
    denominator: 12,
    holdingYears: 4,
  });
  expect('申報移轉現值', r.reportedValue, 496916);
  expect('調整後前次', r.adjustedPrevious, 512936);
  expect('漲價總數額', r.landGain, 0);
  expect('自用稅', r.selfUseTax, 0);
  expect('一般稅', r.generalTax, 0);
}

// ========== Test 2: 旗津段 0900-0054（全部，漲價 = 0）==========
console.log('\n--- Test 2: 旗津 0900-0054 (4 年, 漲價=0) ---');
{
  const r = lib.calcLandFull({
    currentValue: 23400,
    previousValue: 22400,
    cpiIndex: 106.4,
    area: 91,
    numerator: 1,
    denominator: 1,
    holdingYears: 4,
  });
  expect('申報移轉現值', r.reportedValue, 2129400);
  expect('調整後前次', r.adjustedPrevious, 2168857);
  expect('漲價總數額', r.landGain, 0);
}

// ========== Test 3: 旗津段 0900-0047（持分 1/12，漲價 = 0）==========
console.log('\n--- Test 3: 旗津 0900-0047 (4 年, 漲價=0) ---');
{
  const r = lib.calcLandFull({
    currentValue: 23400,
    previousValue: 22400,
    cpiIndex: 106.4,
    area: 103,
    numerator: 1,
    denominator: 12,
    holdingYears: 4,
  });
  expect('申報移轉現值', r.reportedValue, 200850);
  expect('調整後前次', r.adjustedPrevious, 204571);
  expect('漲價總數額', r.landGain, 0);
}

// ========== Test 4: 楠梓和平段 0233-0001（36 年, 第三級, 30 年減徵）==========
console.log('\n--- Test 4: 楠梓 0233-0001 (36 年, 第三級, 30 年減徵) ---');
{
  const cpi = lib.cpiLookup(cpiData, 79, 5);
  expect('CPI 79/05', cpi, 174.4);

  const r = lib.calcLandFull({
    currentValue: 59940,
    previousValue: 4000,
    cpiIndex: cpi,
    area: 1702,
    numerator: 117,
    denominator: 10000,
    holdingYears: 36,
  });
  expect('申報移轉現值', r.reportedValue, 1193609);
  expect('調整後前次', r.adjustedPrevious, 138915);
  expect('漲價總數額', r.landGain, 1054694);
  expect('級距', r.gainBracket, 3);
  expect('自用稅', r.selfUseTax, 105469);
  expect('一般稅', r.generalTax, 329424);
  expect('減徵', r.holdingDiscount, '30 年以上減徵 30%');
}

// ========== Test 5: 多筆累加 ==========
console.log('\n--- Test 5: 多筆累加 ---');
{
  const r1 = lib.calcLandFull({
    currentValue: 33500, previousValue: 32500, cpiIndex: 106.4,
    area: 178, numerator: 1, denominator: 12, holdingYears: 4,
  });
  const r4 = lib.calcLandFull({
    currentValue: 59940, previousValue: 4000, cpiIndex: 174.4,
    area: 1702, numerator: 117, denominator: 10000, holdingYears: 36,
  });
  const sum = lib.sumLands([r1, r4]);
  expect('總漲價總數額', sum.landGain, 0 + 1054694);
  expect('總自用稅', sum.selfUseTax, 0 + 105469);
  expect('總一般稅', sum.generalTax, 0 + 329424);
}

// ========== Test 6.5: 都市/非都市自用上限（§34）==========
console.log('\n--- Test 6.5: 自用面積上限 (§34) ---');
{
  // 都市土地、面積 250 ㎡ < 300 → 全套 10%
  const r1 = lib.calcLandTax({
    landGain: 1000000, adjustedPrevious: 100000, gainBracket: 3,
    holdingYears: 10, landAreaShare: 250, isUrban: true,
  });
  expect('都市 250㎡ 自用稅', r1.selfUseTax, 100000);
  expect('都市 250㎡ 在上限內', r1.selfUseInLimit, true);

  // 都市土地、面積 600 ㎡ > 300 → 拆分（300/600=50% 自用 + 50% 一般）
  // 一般 = 1000000 × 40% - 100000 × 30% = 400000 - 30000 = 370000
  // 自用拆分 = 1000000 × 0.5 × 10% + 370000 × 0.5 = 50000 + 185000 = 235000
  const r2 = lib.calcLandTax({
    landGain: 1000000, adjustedPrevious: 100000, gainBracket: 3,
    holdingYears: 10, landAreaShare: 600, isUrban: true,
  });
  expect('都市 600㎡ 一般稅', r2.generalTax, 370000);
  expect('都市 600㎡ 自用稅（拆分）', r2.selfUseTax, 235000);
  expect('都市 600㎡ 超上限', r2.selfUseInLimit, false);

  // 非都市土地、面積 500 ㎡ < 700 → 全套 10%
  const r3 = lib.calcLandTax({
    landGain: 1000000, adjustedPrevious: 100000, gainBracket: 3,
    holdingYears: 10, landAreaShare: 500, isUrban: false,
  });
  expect('非都市 500㎡ 自用稅', r3.selfUseTax, 100000);
  expect('非都市 500㎡ 在上限內', r3.selfUseInLimit, true);

  // detectUrbanType
  expect('住宅區 → 都市', lib.detectUrbanType('住宅區', '', '', ''), true);
  expect('使用地類別有值 → 非都市', lib.detectUrbanType('', '甲種建築用地', '', ''), false);
  expect('GIS nonUrbanZone 有值 → 非都市', lib.detectUrbanType('', '', '一般農業區', ''), false);
  expect('全空 → 預設都市', lib.detectUrbanType('', '', '', ''), true);
}

// ========== Test 6: 免徵偵測 ==========
console.log('\n--- Test 6: 免徵偵測 ---');
{
  const e1 = lib.detectExemption('道路用地', '');
  expect('道路用地 type', e1?.type, '公共設施保留地');
  const e2 = lib.detectExemption('一般農業區', '農牧用地');
  expect('農地 type', e2?.type, '農業用地');
  const e3 = lib.detectExemption('住宅區', '');
  expect('住宅區 → null', e3, null);
  const e4 = lib.detectExemption('(空白)', '(空白)');
  expect('空白 → null', e4, null);
}

console.log(`\n=== ${pass} pass, ${fail} fail ===`);
process.exit(fail > 0 ? 1 : 0);
