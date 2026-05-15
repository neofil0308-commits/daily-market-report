// tools/validators/data_validator.js
// 수집기에서 받은 raw 데이터를 표시용 구조로 변환.
// 절대 throw 하지 않는다 — 한 필드가 비어도 나머지 섹션은 살아남아야 한다.
import { logger } from '../utils/logger.js';

const round2 = v => Math.round(v * 100) / 100;

export function validateData(raw) {
  return {
    date: raw.date,
    meta: raw.meta,
    domestic:    _validateDomestic(raw.domestic    ?? {}),
    overseas:    _validateOverseas(raw.overseas    ?? {}),
    fxRates:     _validateFxRates(raw.fxRates      ?? {}),
    commodities: _validateCommodities(raw.commodities ?? {}),
    news:        raw.news ?? [],
  };
}

function _validateDomestic(d) {
  // ⚠️ 휴장일에도 모든 필드를 그대로 통과시킨다.
  // 예전엔 isHoliday=true면 { isHoliday: true } 만 반환해서 marketCap/vkospi/supply/supplyHistory가
  // 모두 사라지는 사고가 있었다 (2026-05-15 발견). pipeline 폴백이 채우면 표시되도록.
  const k = d.kospi  ?? {};
  const q = d.kosdaq ?? {};
  const v = d.vkospi ?? {};
  return {
    kospi:        enrich(k.today, k.prev, '지수'),
    kosdaq:       enrich(q.today, q.prev, '지수'),
    volumeBn:      k.volumeBn      ?? null,
    marketCap:     k.marketCap     ?? null,
    prevMarketCap: k.prevMarketCap ?? null,
    marketCapDiff: k.marketCapDiff ?? null,
    marketCapPct:  k.marketCapPct  ?? null,
    supply:        d.supply        ?? null,
    supplyToday:   d.supplyToday   ?? null,
    supplyHistory: d.supplyHistory ?? [],
    breadth:       d.breadth       ?? null,
    kospiHistory:  d.kospiHistory  ?? [],
    vkospi: {
      ...enrich(v.today, v.prev, '지수'),
      source: v.source ?? null,
      label:  v.label  ?? null,
    },
    isHoliday: !!d.isHoliday,
  };
}

function _validateOverseas(o) {
  return Object.fromEntries(
    Object.entries(o)
      .filter(([k]) => k !== 'usHoliday')
      .map(([k, v]) => [k, enrich(v?.close, v?.prevClose, '지수')])
  );
}

function _validateFxRates(f) {
  return {
    usdKrw: enrich(f.usdKrw?.today, f.usdKrw?.prev, '환율'),
    dxy:    enrich(f.dxy?.today,    f.dxy?.prev,    '지수'),
    us10y:  enrich(f.us10y?.today,  f.us10y?.prev,  '금리'),
    us2y:   enrich(f.us2y?.today,   f.us2y?.prev,   '금리'),
    fomc:   f.fomc ?? null,
  };
}

function _validateCommodities(c) {
  return Object.fromEntries(
    Object.entries(c).map(([k, v]) => {
      const type = k === 'goldKrw' ? '원화' : '달러';
      return [k, enrich(v?.today, v?.prev, type)];
    })
  );
}

// 값 두 개 받아 diff·pct·direction 계산. null 안전.
function enrich(today, prev, type) {
  if (today == null || prev == null || prev === 0) {
    return { today: today ?? null, prev: prev ?? null, diff: null, pct: null, direction: null, type };
  }

  const diff = round2(today - prev);
  const pct  = round2((diff / prev) * 100);
  const direction = diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat';

  // 이상치 경고 (±20% 이상) — 데이터 오염 의심 시 로그만 남기고 통과시킨다.
  if (Math.abs(pct) >= 20) {
    logger.warn(`[validator] 이상치 감지 — ${type}: today=${today}, prev=${prev}, pct=${pct}%`);
  }

  return { today, prev, diff, pct, direction, type };
}
