// tools/validators/data_validator.js
import { logger } from '../utils/logger.js';

export function validateData(raw) {
  return {
    date: raw.date,
    meta: raw.meta,

    domestic: raw.domestic.isHoliday ? { isHoliday: true } : {
      kospi:        enrich(raw.domestic.kospi.today,  raw.domestic.kospi.prev,  '지수'),
      kosdaq:       enrich(raw.domestic.kosdaq.today, raw.domestic.kosdaq.prev, '지수'),
      volumeBn:     raw.domestic.kospi.volumeBn,
      marketCap:     raw.domestic.kospi.marketCap      ?? null,
    prevMarketCap: raw.domestic.kospi.prevMarketCap  ?? null,
    marketCapDiff: raw.domestic.kospi.marketCapDiff  ?? null,
    marketCapPct:  raw.domestic.kospi.marketCapPct   ?? null,
      supply:       raw.domestic.supply,
      breadth:      raw.domestic.breadth ?? null,
      kospiHistory: raw.domestic.kospiHistory ?? [],
      vkospi:       {
        ...enrich(raw.domestic.vkospi?.today, raw.domestic.vkospi?.prev, '지수'),
        source: raw.domestic.vkospi?.source ?? null,
        label:  raw.domestic.vkospi?.label  ?? null,
      },
      isHoliday:    false,
    },

    overseas: Object.fromEntries(
      Object.entries(raw.overseas)
        .filter(([k]) => k !== 'usHoliday')
        .map(([k, v]) => [k, enrich(v.close, v.prevClose, '지수')])
    ),

    fxRates: {
      usdKrw: enrich(raw.fxRates.usdKrw.today, raw.fxRates.usdKrw.prev, '환율'),
      dxy:    enrich(raw.fxRates.dxy.today,    raw.fxRates.dxy.prev,    '지수'),
      us10y:  enrich(raw.fxRates.us10y.today,  raw.fxRates.us10y.prev,  '금리'),
      us2y:   enrich(raw.fxRates.us2y.today,   raw.fxRates.us2y.prev,   '금리'),
      fomc:   raw.fxRates.fomc,
    },

    commodities: Object.fromEntries(
      Object.entries(raw.commodities).map(([k, v]) => {
        const type = k === 'goldKrw' ? '원화' : '달러';
        return [k, enrich(v.today, v.prev, type)];
      })
    ),

    news: raw.news,
  };
}

function enrich(today, prev, type) {
  if (today == null || prev == null || prev === 0) {
    return { today, prev, diff: null, pct: null, direction: null, type };
  }

  const diff = round2(today - prev);
  const pct  = round2((diff / prev) * 100);
  const direction = diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat';

  // 이상치 경고 (±20% 이상)
  if (Math.abs(pct) >= 20) {
    logger.warn(`[validator] 이상치 감지 — ${type}: today=${today}, prev=${prev}, pct=${pct}%`);
  }

  return { today, prev, diff, pct, direction, type };
}

const round2 = v => Math.round(v * 100) / 100;
