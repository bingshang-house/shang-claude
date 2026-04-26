/**
 * tax-lib.js — 土地增值稅 / 房地合一稅共用試算邏輯
 *
 * 純函式，無 DOM 依賴；house-profile.html + tax-calc-prototype.html 共用。
 *
 * 對照基準：財政部稅務入口網 etax 試算
 * (https://www.etax.nat.gov.tw/etwmain/etw158w/51)
 *
 * 捨入規則（已對 etax 4 份謄本實測）：
 * - 金額計算（申報移轉現值、調整後前次現值）→ Math.floor（無條件捨去）
 * - 稅額計算（最終 a×rate − b×coef）→ Math.round（四捨五入）
 *
 * CPI 物價指數來源：data/cpi-tax-index.json（GHA cron 每月更新）
 */

(function (global) {
  'use strict';

  // ========== 物價指數查表 ==========

  /**
   * @param {object} cpiData - 整份 cpi-tax-index.json
   * @param {number|string} year - 民國年（48-115）
   * @param {number|string} month - 月份（1-12）
   * @returns {number|null} 指數值（例如 106.4），找不到 null
   */
  function cpiLookup(cpiData, year, month) {
    if (!cpiData || !cpiData.indexes) return null;
    const y = String(parseInt(year, 10));
    const m = String(parseInt(month, 10));
    return cpiData.indexes[y]?.[m] ?? null;
  }

  // ========== 土地漲價總數額計算 ==========

  /**
   * @param {object} input
   * @param {number} input.currentValue - 公告現值（元/㎡）
   * @param {number} input.previousValue - 前次移轉現值（元/㎡）
   * @param {number} input.cpiIndex - 物價指數（例 106.4）
   * @param {number} input.area - 面積（㎡）
   * @param {number} [input.numerator=1] - 移轉範圍分子
   * @param {number} [input.denominator=1] - 移轉範圍分母
   * @param {number} [input.improveFee=0] - 改良費用 + 工程受益費 + 重劃費
   * @returns {{reportedValue, adjustedPrevious, landGain, gainRatio, gainBracket}}
   */
  function calcLandGain(input) {
    const {
      currentValue, previousValue, cpiIndex, area,
      numerator = 1, denominator = 1, improveFee = 0,
    } = input;

    const reportedValue = Math.floor(
      currentValue * area * numerator / denominator
    );
    const adjustedPrevious = Math.floor(
      previousValue * (cpiIndex / 100) * area * numerator / denominator
    );
    const landGain = Math.max(
      0, reportedValue - adjustedPrevious - improveFee
    );

    const gainRatio = adjustedPrevious > 0 ? landGain / adjustedPrevious : 0;
    let gainBracket = 1;
    if (gainRatio >= 2) gainBracket = 3;
    else if (gainRatio >= 1) gainBracket = 2;

    return { reportedValue, adjustedPrevious, landGain, gainRatio, gainBracket };
  }

  // ========== 土地增值稅計算（自用 + 一般） ==========

  // 一般用地稅率速算表 [rate, coef]
  // 第二級：a × rate − b × coef；第三級：同上
  // 來源：etax 試算頁面、土稅 §33
  const RATE_TABLE = {
    1: {
      lt20: [0.20, 0], y20: [0.20, 0], y30: [0.20, 0], y40: [0.20, 0],
    },
    2: {
      lt20: [0.30, 0.10], y20: [0.28, 0.08], y30: [0.27, 0.07], y40: [0.26, 0.06],
    },
    3: {
      lt20: [0.40, 0.30], y20: [0.36, 0.24], y30: [0.34, 0.21], y40: [0.32, 0.18],
    },
  };

  function holdingTier(years) {
    if (years >= 40) return 'y40';
    if (years >= 30) return 'y30';
    if (years >= 20) return 'y20';
    return 'lt20';
  }

  function holdingDiscountLabel(years) {
    if (years >= 40) return '40 年以上減徵 40%';
    if (years >= 30) return '30 年以上減徵 30%';
    if (years >= 20) return '20 年以上減徵 20%';
    return '無減徵';
  }

  // 自用住宅面積上限（土稅 §34，單位 ㎡）
  // 一生一次：都市 3 公畝(300) / 非都市 7 公畝(700)
  // 一生一屋：都市 1.5 公畝(150) / 非都市 3.5 公畝(350) — 條件嚴，預設用一生一次
  const SELF_USE_LIMIT = {
    urban: 300,
    nonUrban: 700,
  };

  /**
   * @param {object} input
   * @param {number} input.landGain - 土地漲價總數額 (a)
   * @param {number} input.adjustedPrevious - 調整後前次現值 (b)
   * @param {1|2|3} input.gainBracket
   * @param {number} input.holdingYears
   * @param {number} [input.landAreaShare] - 持分後面積（㎡），用於自用上限判斷
   * @param {boolean} [input.isUrban=true] - 都市土地 true / 非都市 false
   * @returns {{generalTax, selfUseTax, selfUseInLimit, selfUseLimit, ...}}
   */
  function calcLandTax(input) {
    const {
      landGain, adjustedPrevious, gainBracket, holdingYears,
      landAreaShare, isUrban = true,
    } = input;

    const tier = holdingTier(holdingYears);
    const [rate, coef] = RATE_TABLE[gainBracket][tier];

    // 一般稅率：a × rate − b × coef，最終 round
    const generalTax = Math.max(
      0, Math.round(landGain * rate - adjustedPrevious * coef)
    );

    // 自用稅率：按 §34 面積上限拆分計算
    const selfUseLimit = isUrban ? SELF_USE_LIMIT.urban : SELF_USE_LIMIT.nonUrban;
    let selfUseTax, selfUseInLimit;
    if (!landAreaShare || landAreaShare <= selfUseLimit) {
      // 全部適用 10%
      selfUseTax = Math.max(0, Math.round(landGain * 0.10));
      selfUseInLimit = true;
    } else {
      // 部分 10% + 超過部分套一般稅率（按面積比例拆）
      const eligibleRatio = selfUseLimit / landAreaShare;
      const eligiblePart = Math.round(landGain * eligibleRatio * 0.10);
      const excessPart = Math.round(generalTax * (1 - eligibleRatio));
      selfUseTax = Math.max(0, eligiblePart + excessPart);
      selfUseInLimit = false;
    }

    return {
      generalTax,
      selfUseTax,
      selfUseInLimit,
      selfUseLimit,
      isUrban,
      generalRate: rate,
      generalCoef: coef,
      holdingDiscount: holdingDiscountLabel(holdingYears),
    };
  }

  /**
   * 從謄本「使用分區」/「使用地類別」判斷都市 / 非都市
   * （影響自用稅面積上限：都市 300 ㎡ / 非都市 700 ㎡）
   * @returns {boolean} true=都市, false=非都市
   */
  function detectUrbanType(zone = '', landType = '', nonUrbanZone = '', nonUrbanUse = '') {
    // 非都市判斷：謄本「使用地類別」有值（甲建/乙建/農牧/林業...）= 非都市
    // 或 GIS 有抓到非都市分區（一般農業區/特定農業區/山坡地保育區/森林區/鄉村區）
    if (nonUrbanUse && nonUrbanUse.trim() && !/^\(?空白\)?$/.test(nonUrbanUse)) return false;
    if (nonUrbanZone && nonUrbanZone.trim() && !/^\(?空白\)?$/.test(nonUrbanZone)) return false;
    if (landType && landType.trim() && !/^\(?空白\)?$/.test(landType)) return false;
    // 預設都市（同 etax 試算頁面預設）
    return true;
  }

  // ========== 免徵類型偵測（依謄本「使用分區」/「使用地類別」） ==========

  /**
   * @param {string} zone - 使用分區
   * @param {string} landType - 使用地類別
   * @returns {{type, hint, lawRef}|null}
   */
  function detectExemption(zone = '', landType = '') {
    const text = (zone + ' ' + landType).trim();
    if (!text || /^\(?空白\)?$/.test(text)) return null;

    if (/道路|公園|綠地|廣場|學校|體育|兒童遊樂|公共設施保留|公設保留/.test(text)) {
      return {
        type: '公共設施保留地',
        hint: '⚠️ 公保地未徵收前移轉，賣方有機會申請免徵',
        lawRef: '土稅 §39 II',
      };
    }
    if (/農業|農地|特定農業|一般農業|山坡地保育|森林|林業/.test(text)) {
      return {
        type: '農業用地',
        hint: '⚠️ 作農業使用之農地，移轉自然人可申請不課徵',
        lawRef: '土稅 §39-2',
      };
    }
    return null;
  }

  // ========== 持有年數計算 ==========

  /**
   * 從前次基期年月（民國）計算到目前的持有年數（小數）
   * @param {number} prevYearROC - 民國年（例 79）
   * @param {number} prevMonth - 月份（1-12）
   * @param {Date} [now=new Date()]
   * @returns {number}
   */
  function calcHoldingYears(prevYearROC, prevMonth, now = new Date()) {
    const prevWestern = prevYearROC + 1911;
    const prevDate = new Date(prevWestern, prevMonth - 1, 1);
    const ms = now - prevDate;
    return ms / (365.25 * 86400 * 1000);
  }

  // ========== 一筆地的整套試算（門面函式） ==========

  /**
   * 給單筆土地全套輸入，回傳完整試算結果（含漲價 + 兩種稅 + 免徵提示）
   */
  function calcLandFull(input) {
    const gain = calcLandGain(input);
    const years = input.holdingYears != null
      ? input.holdingYears
      : calcHoldingYears(input.prevYearROC, input.prevMonth);
    const landAreaShare = (input.area || 0) * (input.numerator || 1) / (input.denominator || 1);
    const isUrban = input.isUrban != null
      ? input.isUrban
      : detectUrbanType(input.zone, input.landType, input.nonUrbanZone, input.nonUrbanUse);
    const tax = calcLandTax({
      landGain: gain.landGain,
      adjustedPrevious: gain.adjustedPrevious,
      gainBracket: gain.gainBracket,
      holdingYears: years,
      landAreaShare,
      isUrban,
    });
    const exemption = detectExemption(input.zone, input.landType);
    return {
      ...gain,
      ...tax,
      holdingYears: years,
      landAreaShare,
      exemption,
    };
  }

  // ========== 多筆地累加 ==========

  function sumLands(results) {
    return results.reduce((acc, r) => ({
      landGain: acc.landGain + r.landGain,
      generalTax: acc.generalTax + r.generalTax,
      selfUseTax: acc.selfUseTax + r.selfUseTax,
    }), { landGain: 0, generalTax: 0, selfUseTax: 0 });
  }

  // ========== 匯出 ==========

  const api = {
    cpiLookup,
    calcLandGain,
    calcLandTax,
    calcLandFull,
    calcHoldingYears,
    detectExemption,
    detectUrbanType,
    sumLands,
    holdingTier,
    RATE_TABLE,
    SELF_USE_LIMIT,
  };

  if (typeof window !== 'undefined') window.taxLib = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
