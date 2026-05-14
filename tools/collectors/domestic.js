// tools/collectors/domestic.js
import axios from 'axios';

const YF_BASE      = 'https://query1.finance.yahoo.com/v8/finance/chart';
const NAVER_BASE   = 'https://m.stock.naver.com/api/index';
const NAVER_POLL   = 'https://polling.finance.naver.com/api/realtime/domestic/index';
const NAVER_HDRS   = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', Referer: 'https://finance.naver.com/' };

export async function collectDomestic(isHoliday, prevOutputDir = null) {
  if (isHoliday) {
    return { kospi: null, kosdaq: null, supply: null, kospiHistory: [], isHoliday: true };
  }

  const [kospiData, kosdaqData, vkospiData, realtimeStats, supplyData, breadth, naverHistory] = await Promise.all([
    fetchYahooHistory('^KS11', '20d'),
    fetchYahooHistory('^KQ11', '5d'),
    fetchVkospi(prevOutputDir),
    fetchKospiRealtimeStats(),
    fetchKrxSupply(),
    fetchMarketBreadth(),
    fetchNaverKospiHistory(),
  ]);

  // 최근 6거래일 이력: Naver 우선(거래대금 포함), 부족 시 Yahoo 폴백
  let kospiHistory;
  if (naverHistory.length >= 2) {
    kospiHistory = naverHistory.slice(-6);
  } else {
    kospiHistory = kospiData.history.slice(-6).map(h => ({
      date: h.date, dateISO: null, close: h.close, volume: h.volume, tradingValueBn: null,
    }));
    if (naverHistory.length > 0) {
      const byDate = new Map(naverHistory.map(n => [n.date, n]));
      kospiHistory = kospiHistory.map(h => {
        const n = byDate.get(h.date);
        return n ? { ...h, dateISO: n.dateISO, tradingValueBn: n.tradingValueBn } : h;
      });
    }
  }

  const kDiff = (kospiData.today != null && kospiData.prev != null) ? round2(kospiData.today - kospiData.prev) : null;
  const kPct  = (kDiff != null && kospiData.prev) ? round2(kDiff / kospiData.prev * 100) : null;
  const qDiff = (kosdaqData.today != null && kosdaqData.prev != null) ? round2(kosdaqData.today - kosdaqData.prev) : null;
  const qPct  = (qDiff != null && kosdaqData.prev) ? round2(qDiff / kosdaqData.prev * 100) : null;

  // 전일 시가총액: prevOutputDir의 data.json에서 로드
  let prevMarketCap = null;
  if (prevOutputDir) {
    try {
      const fs = await import('fs/promises');
      const prev = JSON.parse(await fs.default.readFile(`${prevOutputDir}/data.json`, 'utf-8'));
      prevMarketCap = prev?.domestic?.marketCap ?? prev?.domestic?.kospi?.marketCap ?? null;
    } catch {}
  }
  const mcToday = realtimeStats.marketCap;
  const mcDiff  = (mcToday != null && prevMarketCap != null) ? round2(mcToday - prevMarketCap) : null;
  const mcPct   = (mcDiff  != null && prevMarketCap)         ? round2(mcDiff / prevMarketCap * 100) : null;

  return {
    kospi: {
      today:     kospiData.today,
      prev:      kospiData.prev,
      diff:      kDiff,
      pct:       kPct,
      direction: kDiff == null ? 'flat' : kDiff > 0 ? 'up' : kDiff < 0 ? 'down' : 'flat',
      volumeBn:    realtimeStats.volumeBn,
      volumeShares: realtimeStats.volumeShares,
      marketCap:     mcToday,
      prevMarketCap,
      marketCapDiff: mcDiff,
      marketCapPct:  mcPct,
    },
    kosdaq: {
      today:     kosdaqData.today,
      prev:      kosdaqData.prev,
      diff:      qDiff,
      pct:       qPct,
      direction: qDiff == null ? 'flat' : qDiff > 0 ? 'up' : qDiff < 0 ? 'down' : 'flat',
    },
    supply:      supplyData,
    breadth,
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

// VKOSPI — 수집 체인: Naver sise HTML → Naver mobile API → 전일 carry-forward → Yahoo ^VIX
async function fetchVkospi(prevOutputDir = null) {
  // 1차: Naver sise_index 메인 페이지 파싱 (장전/장후 모두 전일 종가 유지)
  try {
    const res = await axios.get('https://finance.naver.com/sise/sise_index.naver?code=VKOSPI', {
      headers: NAVER_HDRS, timeout: 10000, responseType: 'arraybuffer',
    });
    const html = new TextDecoder('euc-kr').decode(res.data);
    const { load } = await import('cheerio');
    const $ = load(html);

    const pn = s => { const v = parseFloat(String(s ?? '').replace(/,/g, '').trim()); return isNaN(v) ? null : v; };

    // 현재가 — 여러 선택자 시도
    const todayCandidates = [
      $('td[class*="tah"] strong, strong.tah').first().text(),
      $('em#_nowVal').text(),
      $('span[id="VKOSPI"] em').text(),
      $('td.tah').first().text(),
    ];
    let today = null;
    for (const c of todayCandidates) {
      const v = pn(c);
      if (v != null && v > 0) { today = v; break; }
    }

    // 전일대비 — 여러 선택자 시도
    const deltaCandidates = [
      $('td[class*="tah"] ~ td em').first().text(),
      $('em#_change').text(),
    ];
    let delta = null;
    for (const c of deltaCandidates) {
      const v = pn(c);
      if (v != null) { delta = v; break; }
    }

    if (today != null) {
      const prev = delta != null ? round2(today - delta) : null;
      console.log('[domestic] VKOSPI Naver sise 수집 완료:', today);
      return { today, prev, source: 'naver_sise' };
    }
  } catch (e) {
    console.warn('[domestic] VKOSPI Naver sise 실패:', e.message);
  }

  // 2차: Naver mobile basic API (재시도 2회)
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await axios.get(`${NAVER_BASE}/VKOSPI/basic`, {
        headers: NAVER_HDRS, timeout: 8000,
      });
      const p = s => parseFloat(String(s ?? '').replace(/,/g, '')) || null;
      const today = p(res.data.closePrice);
      const delta = p(res.data.compareToPreviousClosePrice);
      const prev  = (today != null && delta != null) ? round2(today - delta) : null;
      if (today != null) {
        console.log('[domestic] VKOSPI Naver mobile 수집 완료:', today);
        return { today, prev, source: 'naver' };
      }
    } catch (e) {
      if (attempt < 2) await new Promise(r => setTimeout(r, 1000));
    }
  }

  // 3차: investing.com 스트리밍 파싱 (189KB, 장 마감 후에도 정확한 종가 제공)
  try {
    const stream = await axios.get('https://kr.investing.com/indices/kospi-volatility', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'ko-KR,ko;q=0.9',
      },
      responseType: 'stream', timeout: 15000,
    });
    let buf = '';
    for await (const chunk of stream.data) {
      buf += chunk.toString();
      if (buf.includes('instrument-price-change-percent') || buf.length > 250000) break;
    }
    stream.data.destroy();

    const pn = s => { const v = parseFloat(String(s ?? '').replace(/,/g, '')); return isNaN(v) ? null : v; };
    const today  = pn(buf.match(/data-test="instrument-price-last">([0-9.,]+)</)?.[1]);
    const change = pn(buf.match(/data-test="instrument-price-change"[^>]*>\s*([^<]+)</)?.[1]);

    if (today != null) {
      const prev = change != null ? round2(today - change) : null;
      console.log('[domestic] VKOSPI investing.com 수집 완료:', today);
      return { today, prev, source: 'investing_com' };
    }
  } catch (e) {
    console.warn('[domestic] VKOSPI investing.com 실패:', e.message);
  }

  // 4차: 전일 outputs에서 carry-forward (당일 데이터 없을 때만)
  if (prevOutputDir) {
    try {
      const fs = await import('fs/promises');
      const prevData = JSON.parse(await fs.default.readFile(`${prevOutputDir}/data.json`, 'utf-8'));
      const pv = prevData?.domestic?.vkospi;
      if (pv?.today != null && pv.source !== 'carry_forward') {
        console.warn('[domestic] VKOSPI carry-forward 사용:', pv.today, '(전일 값)');
        return { today: pv.today, prev: pv.prev ?? null, source: 'carry_forward' };
      }
    } catch {}
  }

  console.warn('[domestic] VKOSPI 모든 소스 실패 — null 반환');
  return { today: null, prev: null };
}

// KOSPI 거래대금(조원) + 거래량 — Naver polling realtime
async function fetchKospiRealtimeStats() {
  try {
    const res = await axios.get(`${NAVER_POLL}/KOSPI`, {
      headers: NAVER_HDRS, timeout: 10000,
    });
    const data = res.data?.datas?.[0];
    if (!data) throw new Error('datas 없음');

    const pRaw = v => { const n = parseFloat(String(v ?? '').replace(/,/g, '')); return isNaN(n) ? null : n; };

    // accumulatedTradingValueRaw: 원 단위 → 조원 변환
    const valueBn = pRaw(data.accumulatedTradingValueRaw);
    const volumeThousand = pRaw(data.accumulatedTradingVolumeRaw); // 주 단위

    // 시가총액 병렬 수집 (별도 함수)
    const marketCap = await fetchKospiMarketCap();

    return {
      volumeBn:  valueBn  != null ? round2(valueBn  / 1e12) : null,   // 조원
      volumeShares: volumeThousand != null ? Math.round(volumeThousand / 1e4) / 100 : null,  // 억주
      marketCap,
    };
  } catch (e) {
    console.warn('[domestic] KOSPI 거래대금 수집 실패:', e.message);
    return { volumeBn: null, volumeShares: null, marketCap: null };
  }
}

// KOSPI 전체 시가총액(조원) — Naver sise_market_sum 전 종목 합산
// sosok=0: KOSPI, 페이지당 50개 종목, 시가총액 컬럼 단위: 억원
async function fetchKospiMarketCap() {
  try {
    // 1페이지에서 총 페이지 수 확인 후 전체 병렬 수집
    const firstRes = await axios.get(
      'https://finance.naver.com/sise/sise_market_sum.naver?sosok=0&page=1',
      { headers: NAVER_HDRS, responseType: 'arraybuffer', timeout: 12000 }
    );
    const firstHtml = new TextDecoder('euc-kr').decode(firstRes.data);
    const { load } = await import('cheerio');
    const $first = load(firstHtml);

    // 마지막 페이지 번호 추출
    const lastHref = $first('td.pgRR a').attr('href') ?? '';
    const lastPageMatch = lastHref.match(/page=(\d+)/);
    const totalPages = lastPageMatch ? parseInt(lastPageMatch[1]) : 1;

    // 1페이지 시가총액 합산 (이미 로드됨)
    const parsePage = (html) => {
      const $ = load(html);
      let total = 0;
      $('table.type_2 tr').each((_, tr) => {
        const tds = $(tr).find('td');
        if (tds.length < 7) return;
        const cap = parseFloat($(tds[6]).text().trim().replace(/,/g, ''));
        if (!isNaN(cap) && cap > 0) total += cap;
      });
      return total; // 억원 단위
    };

    let grandTotal = parsePage(firstHtml);

    // 나머지 페이지 병렬 수집 (배치 10개씩)
    for (let batchStart = 2; batchStart <= totalPages; batchStart += 10) {
      const batchEnd = Math.min(batchStart + 9, totalPages);
      const pages = Array.from({ length: batchEnd - batchStart + 1 }, (_, i) => batchStart + i);
      const results = await Promise.allSettled(
        pages.map(page =>
          axios.get(
            `https://finance.naver.com/sise/sise_market_sum.naver?sosok=0&page=${page}`,
            { headers: NAVER_HDRS, responseType: 'arraybuffer', timeout: 12000 }
          ).then(r => parsePage(new TextDecoder('euc-kr').decode(r.data)))
        )
      );
      results.forEach(r => { if (r.status === 'fulfilled') grandTotal += r.value; });
    }

    if (grandTotal <= 0) throw new Error('시가총액 합산 결과 0');

    // 억원 → 조원 변환 (1조 = 10,000억)
    const marketCapTrillion = round2(grandTotal / 10000);
    console.log(`[domestic] KOSPI 시가총액 수집 완료: ${marketCapTrillion}조원 (${totalPages}페이지)`);
    return marketCapTrillion;
  } catch (e) {
    console.warn('[domestic] KOSPI 시가총액 수집 실패:', e.message);
    return null;
  }
}

// 수급 — Naver polling KOSPI_INVESTOR (장중에만 실시간 데이터, 장전/장후 empty)
async function fetchKrxSupply() {
  try {
    const res = await axios.get(`${NAVER_POLL}/KOSPI_INVESTOR`, {
      headers: NAVER_HDRS, timeout: 8000,
    });
    const list = res.data?.datas ?? [];
    if (list.length === 0) return { foreign: null, institution: null, individual: null };
    const find   = t => list.find(d => String(d.investorType ?? d.investorCode ?? d.name ?? '').includes(t));
    const pn     = s => { const v = parseFloat(String(s ?? '').replace(/,/g, '')); return isNaN(v) ? null : v; };
    const getNet = x => pn(x?.netBuySellAmountRaw ?? x?.netBuySellQuantityRaw ?? x?.netCount ?? x?.net);
    return {
      foreign:     getNet(find('외국인') ?? find('FOREIGN') ?? find('8')),
      institution: getNet(find('기관')   ?? find('INSTITUTION') ?? find('4')),
      individual:  getNet(find('개인')   ?? find('INDIVIDUAL')  ?? find('1')),
    };
  } catch (e) {
    console.warn('[domestic] 수급 수집 실패:', e.message);
    return { foreign: null, institution: null, individual: null };
  }
}

// 시장 강도 — Naver sise 페이지 (장중 고가/저가, 상승/하락 종목 수)
// 장전/장후 실행 시에는 당일 장중 데이터가 없으므로 전일 데이터가 반환됨
async function fetchMarketBreadth() {
  try {
    const res = await axios.get('https://finance.naver.com/sise/sise_index.naver?code=KOSPI', {
      headers: NAVER_HDRS,
      timeout: 8000,
      responseType: 'arraybuffer',
    });
    const html = new TextDecoder('euc-kr').decode(res.data);
    const { load } = await import('cheerio');
    const $ = load(html);

    const pn = s => { const v = parseFloat(String(s ?? '').replace(/,/g, '')); return isNaN(v) ? null : v; };
    const cells = $('table').first().find('td').map((_, el) => $(el).text().trim()).get();

    // 파싱: 거래량(천주) | 값 | 거래대금(백만) | 값 | 장중최고 | 값 | 장중최저 | 값
    const getCellAfter = (label) => {
      const idx = cells.findIndex(c => c.includes(label));
      return idx !== -1 ? pn(cells[idx + 1]) : null;
    };

    const highLow = {
      intraHigh: getCellAfter('장중최고'),
      intraLow:  getCellAfter('장중최저'),
    };

    // 등락/종목 수 (상한/상승/보합/하락/하한)
    const breadthText = cells.find(c => c.includes('상승') || c.includes('하락')) ?? '';
    const extractCount = (text, keyword) => {
      const m = text.match(new RegExp(keyword + '[수]?(\\d+)'));
      return m ? parseInt(m[1]) : null;
    };
    const advancing  = extractCount(breadthText, '상승종목');
    const declining  = extractCount(breadthText, '하락종목');
    const unchanged  = extractCount(breadthText, '보합종목');

    return { ...highLow, advancing, declining, unchanged };
  } catch (e) {
    console.warn('[domestic] 시장 강도 수집 실패:', e.message);
    return { intraHigh: null, intraLow: null, advancing: null, declining: null, unchanged: null };
  }
}

// 네이버 KOSPI 일별 시세 (거래대금 포함) — 역사 테이블용
async function fetchNaverKospiHistory() {
  try {
    const res = await axios.get(
      'https://finance.naver.com/sise/sise_index_day.nhn?code=KOSPI&page=1',
      {
        headers: { ...NAVER_HDRS, 'Accept-Language': 'ko-KR,ko;q=0.9' },
        timeout: 10000,
        responseType: 'arraybuffer',
      }
    );
    const html = new TextDecoder('euc-kr').decode(res.data);
    const { load } = await import('cheerio');
    const $ = load(html);

    const rows = [];
    $('table.type_1 tr').each((_, tr) => {
      const dateText = $(tr).find('td.date').text().trim();
      if (!dateText.match(/^\d{4}\.\d{2}\.\d{2}$/)) return;

      const tds = $(tr).find('td');
      const pn  = s => { const v = parseFloat(String(s ?? '').replace(/,/g, '').trim()); return isNaN(v) ? null : v; };

      const close         = pn($(tds[1]).text());
      const volumeThousand = pn($(tds[4]).text());  // 천주
      const tradingValueM  = pn($(tds[5]).text());  // 백만원

      if (close == null) return;
      const [y, m, d] = dateText.split('.');
      rows.push({
        date:           `${m}/${d}`,
        dateISO:        `${y}-${m}-${d}`,
        close:          round2(close),
        volume:         volumeThousand != null ? volumeThousand * 1000 : null,
        tradingValueBn: tradingValueM  != null ? round2(tradingValueM / 1_000_000) : null,
      });
    });

    // Naver: 최신순 → 오래된 순으로 반전, 최근 7개
    return rows.slice(0, 7).reverse();
  } catch (e) {
    console.warn('[domestic] Naver KOSPI 역사 수집 실패:', e.message);
    return [];
  }
}

const round2 = v => Math.round(v * 100) / 100;
