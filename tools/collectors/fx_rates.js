// tools/collectors/fx_rates.js
import axios from 'axios';

export async function collectFxRates() {
  // Yahoo Finance: USD/KRW, DXY, 미국채 금리, FOMC 확률 병렬 수집
  const [usdKrw, dxy, us10y, us2y, fomc] = await Promise.all([
    fetchYF('USDKRW=X'),   // 달러원 환율
    fetchYF('DX-Y.NYB'),   // 달러인덱스
    fetchYF('^TNX'),       // 미 10년물 금리
    fetchYF('^IRX'),       // 미 2년물(단기) 금리
    fetchFomcProbabilities(),
  ]);

  return { usdKrw, dxy, us10y, us2y, fomc };
}

/**
 * CME 30일 연방기금금리 선물(ZQ)로 FOMC 확률 역산
 *
 * 원리: ZQ 가격 = 100 - 해당 월 내재금리
 *   → 내재금리 = 100 - 가격
 *   → 동결확률 = (내재금리 - 인하시_기대금리) / (현재금리 - 인하시_기대금리) × 100
 *
 * 사용 심볼:
 *   ZQM26 = 6월물 → 6월 FOMC 직후 금리 반영
 *   ZQU26 = 9월물 → 9월 FOMC 직후 금리 반영
 */
async function fetchFomcProbabilities() {
  // 현재 연준 기준금리 상단 (변경 시 수동 업데이트 필요)
  const CURRENT_RATE = 4.50;
  const CUT_25BP     = CURRENT_RATE - 0.25;
  const CUT_50BP     = CURRENT_RATE - 0.50;

  try {
    const [jun, sep] = await Promise.all([
      fetchZQ('ZQM26.CBT'),  // 6월물
      fetchZQ('ZQU26.CBT'),  // 9월물
    ]);

    // 6월 FOMC: 동결 확률
    const junHoldPct = jun != null
      ? clamp((jun - CUT_25BP) / (CURRENT_RATE - CUT_25BP) * 100)
      : null;

    // 9월 FOMC: 누적 25bp 인하 확률 (현재 대비)
    const sepCutPct = sep != null
      ? clamp((CURRENT_RATE - sep) / 0.25 * 100)
      : null;

    return {
      junHoldPct: junHoldPct != null ? round2(junHoldPct) : null,
      sepCutPct:  sepCutPct  != null ? round2(sepCutPct)  : null,
      currentRate: CURRENT_RATE,
    };
  } catch (e) {
    console.warn('[fx] FOMC 확률 계산 실패:', e.message);
    return { junHoldPct: null, sepCutPct: null, currentRate: CURRENT_RATE };
  }
}

// ZQ 선물 최신 종가 → 내재금리 반환
async function fetchZQ(symbol) {
  try {
    const res = await axios.get(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`,
      { params: { interval: '1d', range: '5d' }, headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000 }
    );
    const closes = res.data.chart.result[0]?.indicators?.quote?.[0]?.close?.filter(Boolean);
    if (!closes?.length) return null;
    // ZQ 가격 = 100 - 내재금리(%) → 내재금리 = 100 - 가격
    return round2(100 - closes[closes.length - 1]);
  } catch (e) {
    console.warn(`[fx] ${symbol} 수집 실패:`, e.message);
    return null;
  }
}

async function fetchYF(symbol) {
  try {
    const res = await axios.get(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`,
      { params: { interval: '1d', range: '5d' }, headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000 }
    );
    const closes = res.data.chart.result[0].indicators.quote[0].close.filter(Boolean);
    const len = closes.length;
    return {
      today: round2(closes[len - 1]),
      prev:  round2(closes[len - 2]),
    };
  } catch (e) {
    console.warn(`[fx] ${symbol} 수집 실패:`, e.message);
    return { today: null, prev: null };
  }
}

const round2 = v => Math.round(v * 100) / 100;
const clamp  = v => Math.min(100, Math.max(0, v));
