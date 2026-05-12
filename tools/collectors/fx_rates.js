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
 * 현재 기준금리는 당월물(ZQK26) 내재금리를 25bp 단위로 반올림해 자동 감지.
 * 사용 심볼:
 *   ZQK26 = 5월물 → 현재 기준금리 추정
 *   ZQM26 = 6월물 → 6월 FOMC 직후 금리 반영
 *   ZQU26 = 9월물 → 9월 FOMC 직후 금리 반영
 */
async function fetchFomcProbabilities() {
  try {
    const [cur, jun, sep] = await Promise.all([
      fetchZQ('ZQK26.CBT'),  // 5월물 → 현재 기준금리 추정
      fetchZQ('ZQM26.CBT'),  // 6월물
      fetchZQ('ZQU26.CBT'),  // 9월물
    ]);

    // 현재 기준금리: 당월 내재금리를 25bp 단위로 반올림
    const CURRENT_RATE = cur.today != null ? round2(Math.round(cur.today / 0.25) * 0.25) : 3.75;
    const CUT_25BP     = CURRENT_RATE - 0.25;

    const calcHold = rate => (rate != null && CURRENT_RATE > CUT_25BP)
      ? clamp((rate - CUT_25BP) / (CURRENT_RATE - CUT_25BP) * 100) : null;
    const calcCut  = rate => rate != null
      ? clamp((CURRENT_RATE - rate) / 0.25 * 100) : null;

    return {
      junHoldPct:     jun.today != null ? round2(calcHold(jun.today)) : null,
      junHoldPctPrev: jun.prev  != null ? round2(calcHold(jun.prev))  : null,
      sepCutPct:      sep.today != null ? round2(calcCut(sep.today))  : null,
      sepCutPctPrev:  sep.prev  != null ? round2(calcCut(sep.prev))   : null,
      currentRate:    CURRENT_RATE,
    };
  } catch (e) {
    console.warn('[fx] FOMC 확률 계산 실패:', e.message);
    return { junHoldPct: null, sepCutPct: null, currentRate: null };
  }
}

// ZQ 선물 최신·전일 종가 → 내재금리 반환
async function fetchZQ(symbol) {
  try {
    const res = await axios.get(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`,
      { params: { interval: '1d', range: '5d' }, headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000 }
    );
    const closes = res.data.chart.result[0]?.indicators?.quote?.[0]?.close?.filter(Boolean);
    if (!closes || closes.length < 2) return { today: null, prev: null };
    return {
      today: round2(100 - closes[closes.length - 1]),
      prev:  round2(100 - closes[closes.length - 2]),
    };
  } catch (e) {
    console.warn(`[fx] ${symbol} 수집 실패:`, e.message);
    return { today: null, prev: null };
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
