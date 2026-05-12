// tools/collectors/commodities.js
import axios from 'axios';
import * as cheerio from 'cheerio';

const YF_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart';

const SYMBOLS = {
  gold:     'GC=F',   // 금 선물 (COMEX, oz)
  silver:   'SI=F',   // 은 선물 (COMEX, oz)
  platinum: 'PL=F',   // 백금 선물 (COMEX, oz)
  wti:      'CL=F',   // WTI 원유 (NYMEX, bbl)
  copper:   'HG=F',   // 구리 선물 (COMEX, lb)
  aluminum: 'ALI=F',  // 알루미늄 선물 (COMEX)
  // zinc / nickel: LME 전용 — Yahoo Finance 갱신 불안정으로 제외
};

// 1돈 = 3.75g
const DON_GRAMS = 3.75;

export async function collectCommodities() {
  const result = {};

  // 해외 원자재 + 국내 금 시세 병렬 수집
  await Promise.all([
    // Yahoo Finance 심볼 일괄 수집
    ...Object.entries(SYMBOLS).map(async ([key, symbol]) => {
      try {
        const res = await axios.get(`${YF_BASE}/${encodeURIComponent(symbol)}`, {
          params: { interval: '1d', range: '5d' },
          headers: { 'User-Agent': 'Mozilla/5.0' },
          timeout: 10000,
        });
        const closes = res.data.chart.result[0]?.indicators?.quote?.[0]?.close?.filter(Boolean);
        if (!closes || closes.length < 2) throw new Error('데이터 부족');
        const len = closes.length;
        result[key] = { today: round2(closes[len - 1]), prev: round2(closes[len - 2]) };
      } catch (e) {
        console.warn(`[commodities] ${key}(${symbol}) 수집 실패:`, e.message);
        result[key] = { today: null, prev: null };
      }
    }),
    // 국내 금 시세 (네이버 금융 일별 시세 파싱)
    (async () => {
      result.goldKrw = await fetchKoreanGoldPrice();
    })(),
  ]);

  return result;
}

/**
 * 네이버 금융 일별 시세 페이지에서 국내 24K 금 시세 수집
 * URL: https://finance.naver.com/marketindex/goldDailyQuote.nhn
 *
 * 테이블 구조 (tr 기준):
 *   [0] 헤더 / [1] 당일 or 최신 / [2] 전일 / ...
 * 각 행: 날짜 | 살때(1g) | 팔때(1g) | ...
 * → "살때" 기준 1g 가격 × 3.75 = 1돈
 */
async function fetchKoreanGoldPrice() {
  try {
    const res = await axios.get(
      'https://finance.naver.com/marketindex/goldDailyQuote.nhn?page=1',
      {
        headers: {
          'User-Agent': 'Mozilla/5.0',
          'Referer':    'https://finance.naver.com/marketindex/',
          'Accept-Language': 'ko-KR,ko;q=0.9',
        },
        timeout: 12000,
        responseType: 'arraybuffer',  // EUC-KR 인코딩 대응
      }
    );

    // EUC-KR → UTF-8 변환
    const decoder = new TextDecoder('euc-kr');
    const html = decoder.decode(res.data);
    const $ = cheerio.load(html);

    const rows = $('table.tbl_exchange tbody tr').toArray();
    if (rows.length < 2) throw new Error('테이블 행 부족');

    const parsePrice = (row, colIdx) => {
      const text = $(row).find('td').eq(colIdx).text().replace(/,/g, '').trim();
      const val = parseFloat(text);
      return isNaN(val) ? null : Math.round(val * DON_GRAMS); // 1g → 1돈(3.75g)
    };

    // 1열: 날짜, 2열: 살때(1g), 3열: 팔때(1g) — 인덱스 0부터
    const today = parsePrice(rows[0], 1);
    const prev  = parsePrice(rows[1], 1);

    if (!today) throw new Error('가격 파싱 실패');
    return { today, prev };

  } catch (e) {
    console.warn('[commodities] 국내 금 시세 수집 실패:', e.message);
    return { today: null, prev: null };
  }
}

const round2 = v => Math.round(v * 100) / 100;
