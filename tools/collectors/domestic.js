// tools/collectors/domestic.js
import axios from 'axios';

const YF_BASE    = 'https://query1.finance.yahoo.com/v8/finance/chart';
const NAVER_BASE = 'https://m.stock.naver.com/api/index';

export async function collectDomestic(isHoliday) {
  if (isHoliday) {
    return { kospi: null, kosdaq: null, supply: null, kospiHistory: [], isHoliday: true };
  }

  const [kospiData, kosdaqData, vkospiData, kospiVolumeBn, supplyData] = await Promise.all([
    fetchYahooHistory('^KS11', '20d'),
    fetchYahooHistory('^KQ11', '5d'),
    fetchNaverIndex('VKOSPI'),
    fetchKospiVolume(),
    fetchKrxSupply(),
  ]);

  // 최근 6거래일 이력 (5일 표시 + 1일 전일비 계산용) — 오래된 날부터
  const kospiHistory = kospiData.history.slice(-6).map(h => ({
    date:   h.date,
    close:  h.close,
    volume: h.volume,  // Yahoo Finance 천주 단위
  }));

  const kDiff = (kospiData.today != null && kospiData.prev != null) ? round2(kospiData.today - kospiData.prev) : null;
  const kPct  = (kDiff != null && kospiData.prev) ? round2(kDiff / kospiData.prev * 100) : null;
  const qDiff = (kosdaqData.today != null && kosdaqData.prev != null) ? round2(kosdaqData.today - kosdaqData.prev) : null;
  const qPct  = (qDiff != null && kosdaqData.prev) ? round2(qDiff / kosdaqData.prev * 100) : null;

  return {
    kospi: {
      today:     kospiData.today,
      prev:      kospiData.prev,
      diff:      kDiff,
      pct:       kPct,
      direction: kDiff == null ? 'flat' : kDiff > 0 ? 'up' : kDiff < 0 ? 'down' : 'flat',
      volumeBn:  kospiVolumeBn,
      marketCap: null,
    },
    kosdaq: {
      today:     kosdaqData.today,
      prev:      kosdaqData.prev,
      diff:      qDiff,
      pct:       qPct,
      direction: qDiff == null ? 'flat' : qDiff > 0 ? 'up' : qDiff < 0 ? 'down' : 'flat',
    },
    supply:      supplyData,
    kospiHistory,
    vkospi:      vkospiData,
    isHoliday:   false,
  };
}

async function fetchYahooHistory(symbol, range) {
  try {
    const res = await axios.get(
      `${YF_BASE}/${encodeURIComponent(symbol)}`,
      {
        params:  { interval: '1d', range },
        headers: { 'User-Agent': 'Mozilla/5.0' },
        timeout: 12000,
      }
    );
    const result    = res.data.chart.result[0];
    const closes    = result.indicators.quote[0].close;
    const volumes   = result.indicators.quote[0].volume;
    const timestamps = result.timestamp;

    // null 제거 후 유효 데이터만 추출
    const rows = timestamps
      .map((ts, i) => ({ ts, close: closes[i], volume: volumes[i] }))
      .filter(r => r.close != null);

    const len = rows.length;
    if (len < 2) throw new Error('데이터 부족');

    const toDateStr = ts => {
      const d = new Date(ts * 1000);
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      return `${mm}/${dd}`;
    };

    return {
      today:       round2(rows[len - 1].close),
      prev:        round2(rows[len - 2].close),
      todayVolume: rows[len - 1].volume ?? 0,
      history:     rows.map(r => ({ date: toDateStr(r.ts), close: round2(r.close), volume: r.volume ?? 0 })),
    };
  } catch (e) {
    console.warn(`[domestic] ${symbol} 수집 실패:`, e.message);
    return { today: null, prev: null, todayVolume: 0, history: [] };
  }
}

// Naver Finance 지수 API — VKOSPI, KOSPI 등
async function fetchNaverIndex(symbol) {
  try {
    const res = await axios.get(`${NAVER_BASE}/${symbol}/basic`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 10000,
    });
    const d = res.data;
    const parseNum = s => parseFloat(String(s ?? '').replace(/,/g, '')) || null;
    const today = parseNum(d.closePrice);
    const delta = parseNum(d.compareToPreviousClosePrice);
    const prev  = (today != null && delta != null) ? round2(today - delta) : null;
    return { today, prev };
  } catch (e) {
    console.warn(`[domestic] Naver ${symbol} 수집 실패:`, e.message);
    return { today: null, prev: null };
  }
}

// KOSPI 거래대금(조원) — Naver Finance accumulatedTradingValue
async function fetchKospiVolume() {
  try {
    const res = await axios.get(`${NAVER_BASE}/KOSPI/basic`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 10000,
    });
    const raw = String(res.data.accumulatedTradingValue ?? '').replace(/,/g, '');
    const val = parseFloat(raw);
    return isNaN(val) || val === 0 ? null : round2(val / 1e12);
  } catch (e) {
    console.warn('[domestic] KOSPI 거래대금 수집 실패:', e.message);
    return null;
  }
}

async function fetchKrxSupply() {
  // Naver polling KOSPI_INVESTOR (영업일에만 데이터 있음, 공휴일 empty)
  try {
    const res = await axios.get('https://polling.finance.naver.com/api/realtime/domestic/index/KOSPI_INVESTOR', {
      headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 8000,
    });
    const list = res.data?.datas ?? [];
    if (list.length === 0) return { foreign: null, institution: null, individual: null };
    const find  = t => list.find(d => String(d.investorType ?? d.investorCode ?? d.name ?? '').includes(t));
    const pn    = s => { const v = parseFloat(String(s ?? '').replace(/,/g, '')); return isNaN(v) ? null : v; };
    const getNet = x => pn(x?.netBuySellQuantityRaw ?? x?.netCount ?? x?.net);
    return {
      foreign:     getNet(find('외국인') ?? find('FOREIGN') ?? find('8')),
      institution: getNet(find('기관') ?? find('INSTITUTION') ?? find('4')),
      individual:  getNet(find('개인') ?? find('INDIVIDUAL') ?? find('1')),
    };
  } catch (e) {
    console.warn('[domestic] 수급 수집 실패:', e.message);
    return { foreign: null, institution: null, individual: null };
  }
}

const round2 = v => Math.round(v * 100) / 100;
