// tools/layer-1-pipeline/index.js — Layer 1 집약 진입점
// 모든 피드를 병렬 수집해 PipelineData 객체 반환.
// 수집 실패는 null/[] 반환, 전체 파이프라인 중단 금지.
import axios from 'axios';
import { collectDomestic, fetchKospiMarketCap, fetchNaverKospiHistory } from './collectors/domestic.js';
import { collectOverseas }    from './collectors/overseas.js';
import { collectFxRates }     from './collectors/fx_rates.js';
import { collectCommodities } from './collectors/commodities.js';
// news는 tf-news 소속, dart/crypto는 tf-analyst·tf-crypto 소속. Layer 1은 시장 데이터(4종)만 책임.
import { validateData }       from '../shared/validators/data_validator.js';
import { isHoliday }          from '../shared/utils/holiday.js';
import { logger }             from '../shared/utils/logger.js';
import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone.js';
import utc from 'dayjs/plugin/utc.js';
import fs from 'fs/promises';
import path from 'path';

dayjs.extend(utc);
dayjs.extend(timezone);

const r2    = v => Math.round(v * 100) / 100;
const NAV_H = { 'User-Agent': 'Mozilla/5.0' };

/**
 * 전체 Layer 1 수집 실행.
 * @param {string} reportDate  YYYY-MM-DD
 * @param {string} outputDir   저장 폴더 경로
 * @returns {Promise<PipelineData>}
 */
export async function runPipeline(reportDate, outputDir) {
  const today      = dayjs(reportDate).tz('Asia/Seoul');
  const krHoliday  = await isHoliday(today, 'KR');
  const usHoliday  = await isHoliday(today.subtract(1, 'day'), 'US');
  logger.info(`[pipeline] 공휴일 — KR: ${krHoliday}, US: ${usHoliday}`);

  const prevDate      = today.subtract(1, 'day').format('YYYY-MM-DD');
  const prevOutputDir = path.join(process.env.OUTPUT_DIR ?? './outputs', prevDate);

  // ── 시장 데이터 병렬 수집 ────────────────────────────────────────────────────
  const [domestic, overseas, fxRates, commodities] = await Promise.all([
    collectDomestic(krHoliday, prevOutputDir, reportDate)
      .catch(e => { logger.warn('[pipeline] domestic 실패:', e.message);    return {}; }),
    collectOverseas(usHoliday)
      .catch(e => { logger.warn('[pipeline] overseas 실패:', e.message);    return {}; }),
    collectFxRates()
      .catch(e => { logger.warn('[pipeline] fxRates 실패:', e.message);     return {}; }),
    collectCommodities()
      .catch(e => { logger.warn('[pipeline] commodities 실패:', e.message); return {}; }),
  ]);

  // news/dart/crypto는 Layer 2 각 TF팀이 자체 수집 (Layer 1은 시장 데이터 전용)
  const coreData = validateData({
    date: reportDate,
    domestic, overseas, fxRates, commodities,
    news: [],   // 호환을 위해 빈 배열 유지 (validator 통과용). 실제 뉴스는 tf-news가 수집.
    meta: { krHoliday, usHoliday },
  });

  const pipelineData = { ...coreData };

  // ── 전일 수급 스냅샷 병합 (supply-collect.yml이 16:40 KST에 저장한 supply.json) ──
  await _mergeSupplySnapshot(pipelineData, prevOutputDir);

  // ── 실시간 폴백 — null 값 보완 (KOSPI/KOSDAQ/VKOSPI/시총/수급/거래대금/히스토리) ─
  await _applyLiveFallbacks(pipelineData, prevOutputDir);

  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(
    path.join(outputDir, 'data.json'),
    JSON.stringify(pipelineData, null, 2),
    'utf-8'
  );
  logger.info(`[pipeline] data.json 저장 완료 → ${outputDir}`);

  return pipelineData;
}

// ── 전일 수급 스냅샷 병합 ──────────────────────────────────────────────────────
async function _mergeSupplySnapshot(data, prevOutputDir) {
  try {
    const snap = JSON.parse(
      await fs.readFile(path.join(prevOutputDir, 'supply.json'), 'utf-8')
    );
    if (snap.supply && (snap.supply.foreign != null || snap.supply.institution != null)) {
      data.domestic.supply = snap.supply;
      logger.info(`[pipeline] 전일 수급 병합 (${snap.date}): 외국인 ${snap.supply.foreign}`);
    }
    if (snap.vkospi?.today != null && data.domestic.vkospi?.today == null) {
      data.domestic.vkospi = { ...snap.vkospi, source: 'snapshot' };
      logger.info(`[pipeline] 전일 VKOSPI 병합: ${snap.vkospi.today}`);
    }
  } catch { /* supply.json 없으면 무시 */ }
}

// ── 실시간 폴백 (null 값 보완) ─────────────────────────────────────────────────
async function _applyLiveFallbacks(data, prevOutputDir = null) {
  const d = data.domestic ?? {};

  // KOSPI/KOSDAQ 종가 실시간 폴백
  // ⚠️ 핵심 규칙: 사주는 매일 08:00 KST에 메일 수신 → 그때 "기준 거래일"은 직전 거래일(=어제) 종가.
  //   m.stock의 closePrice는 marketStatus=CLOSE면 어제 종가, OPEN이면 장중 현재가다.
  //   장중에 실수로 트리거된 경우(수동 검증 등)에는 그 값을 절대 신뢰하면 안 된다 → kospiHistory 마지막 사용.
  if (d.kospi?.today == null) {
    const live = await _fetchNaverIdxLive('KOSPI');
    if (live?.today != null && live.marketStatus !== 'OPEN') {
      d.kospi = { ...(d.kospi ?? {}), ...live, source: 'naver-fallback' };
      logger.info(`[pipeline] KOSPI 종가 실시간 폴백: ${live.today} (${live.diff >= 0 ? '+' : ''}${live.diff})`);
    } else if (live?.marketStatus === 'OPEN') {
      logger.info(`[pipeline] KOSPI 시장 OPEN — 라이브값 ${live.today} 무시, kospiHistory 폴백으로 위임`);
    }
  }
  if (d.kosdaq?.today == null) {
    const live = await _fetchNaverIdxLive('KOSDAQ');
    if (live?.today != null && live.marketStatus !== 'OPEN') {
      d.kosdaq = { ...(d.kosdaq ?? {}), ...live, source: 'naver-fallback' };
      logger.info(`[pipeline] KOSDAQ 종가 실시간 폴백: ${live.today} (${live.diff >= 0 ? '+' : ''}${live.diff})`);
    }
  }

  // VKOSPI 실시간 폴백
  if (d.vkospi?.today == null) {
    try {
      const res = await axios.get(
        'https://m.stock.naver.com/api/index/VKOSPI/basic',
        { headers: NAV_H, timeout: 8000 }
      );
      const p     = s => parseFloat(String(s ?? '').replace(/,/g, '')) || null;
      const today = p(res.data.closePrice);
      const delta = p(res.data.compareToPreviousClosePrice);
      const prev  = (today != null && delta != null) ? r2(today - delta) : null;
      if (today != null) {
        d.vkospi = {
          today, prev, diff: delta,
          pct: prev ? r2((today - prev) / prev * 100) : 0,
          direction: delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat',
        };
        logger.info(`[pipeline] VKOSPI 실시간 폴백: ${today}`);
      }
    } catch (e) { logger.warn('[pipeline] VKOSPI 폴백 실패:', e.message); }
  }

  // KOSPI 거래대금 + 시가총액 실시간 폴백 — 같은 API 한 번 호출로 둘 다 수집
  // 휴장일에도 polling API는 직전 거래일 값을 반환하므로 안전.
  if (d.volumeBn == null || d.marketCap == null) {
    try {
      const res  = await axios.get(
        'https://polling.finance.naver.com/api/realtime/domestic/index/KOSPI',
        { headers: NAV_H, timeout: 8000 }
      );
      const item = res.data?.datas?.[0];
      const parseNum = s => { const v = parseFloat(String(s ?? '').replace(/,/g, '')); return isNaN(v) ? null : v; };
      const tradeVal = parseNum(item?.accumulatedTradingValueRaw);
      const mc       = parseNum(item?.marketCapRaw);
      if (tradeVal != null && tradeVal > 0 && d.volumeBn == null) {
        d.volumeBn = r2(tradeVal / 1e12);
        logger.info(`[pipeline] KOSPI 거래대금 실시간 폴백: ${d.volumeBn}조`);
      }
      if (mc != null && mc > 0 && d.marketCap == null) {
        d.marketCap = r2(mc / 1e12); // 단위: 조원
        logger.info(`[pipeline] KOSPI 시가총액 실시간 폴백: ${d.marketCap}조`);
      }
    } catch (e) { logger.warn('[pipeline] KOSPI 거래대금·시총 폴백 실패:', e.message); }
  }

  // VKOSPI 폴백 — m.stock 실패(409) 또는 휴장일 → investing.com 시도
  if (d.vkospi?.today == null) {
    const liveVk = await _fetchInvestingVkospi();
    if (liveVk?.today != null) {
      d.vkospi = { ...liveVk, source: 'investing-fallback' };
      logger.info(`[pipeline] VKOSPI investing.com 폴백: ${liveVk.today}`);
    }
  }

  // 수급 (당일 + 5거래일 추이) — Naver investorDealTrendDay 스크래핑
  // 휴장일이어도 응답하며 직전 거래일 데이터가 첫 행에 옴.
  if (!d.supply || (d.supplyHistory ?? []).length === 0) {
    const supplyRows = await _fetchNaverSupplyHistory(data.date);
    if (supplyRows?.length > 0) {
      // 5거래일 추이는 시간 순(오래된 → 최근)
      d.supplyHistory = supplyRows;
      // 가장 최근 거래일을 당일 수급으로
      const latest = supplyRows[supplyRows.length - 1];
      if (!d.supply && latest) {
        d.supply = {
          foreign:     latest.foreign,
          institution: latest.institution,
          individual:  latest.individual,
          source:      'naver-fallback',
        };
      }
      logger.info(`[pipeline] 수급 폴백 — 당일 외국인 ${latest?.foreign}억, 5거래일 추이 ${supplyRows.length}건`);
    }
  }

  // KOSPI 종가/거래대금 폴백을 받지 못했지만 kospiHistory가 있으면 마지막 종가로 보완
  // (Naver·Yahoo가 모두 실패해도 사용자에게는 N/A 대신 직전 거래일 종가가 표시되도록.)
  if (d.kospi?.today == null && (d.kospiHistory ?? []).length >= 2) {
    const hist = d.kospiHistory;
    const last = hist[hist.length - 1];
    const prev = hist[hist.length - 2];
    if (last?.close != null && prev?.close != null) {
      const diff = r2(last.close - prev.close);
      const pct  = prev.close ? r2(diff / prev.close * 100) : 0;
      d.kospi = {
        ...(d.kospi ?? {}),
        today: last.close, prev: prev.close, diff, pct,
        direction: diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat',
        source: 'history-fallback',
      };
      logger.info(`[pipeline] KOSPI 히스토리 기반 폴백: ${last.close} (전일 ${prev.close})`);
    }
  }

  // KOSPI 히스토리 폴백 1단계: Naver (거래대금 포함, 사주 핵심 요구)
  // data.date를 캐시 키로 전달 → collectDomestic에서 이미 호출했으면 메모리 hit (0ms).
  if ((d.kospiHistory ?? []).length < 6) {
    try {
      const naver = await fetchNaverKospiHistory(data.date);
      if (naver?.length >= 2) {
        d.kospiHistory = naver.slice(-6);
        logger.info(`[pipeline] KOSPI 히스토리 Naver 폴백: ${naver.length}거래일 (거래대금 포함)`);
      }
    } catch (e) { logger.warn('[pipeline] Naver KOSPI 히스토리 폴백 실패:', e.message); }
  }

  // KOSPI 히스토리 폴백 2단계: Yahoo (Naver도 실패한 경우 — 거래대금 없음)
  if ((d.kospiHistory ?? []).length < 6) {
    try {
      const yf     = await axios.get(
        'https://query1.finance.yahoo.com/v8/finance/chart/%5EKS11',
        { params: { interval: '1d', range: '30d' }, headers: NAV_H, timeout: 12000 }
      );
      const result = yf.data.chart.result[0];
      const closes = result.indicators.quote[0].close;
      const toMD   = ts => {
        const dt = new Date(ts * 1000);
        return `${String(dt.getMonth()+1).padStart(2,'0')}/${String(dt.getDate()).padStart(2,'0')}`;
      };
      const rows = result.timestamp
        .map((ts, i) => ({ ts, close: closes[i] }))
        .filter(x => x.close != null)
        .slice(-6)
        .map(x => ({ date: toMD(x.ts), close: r2(x.close), tradingValueBn: null }));
      if (rows.length >= 2) {
        d.kospiHistory = rows;
        logger.info(`[pipeline] KOSPI 히스토리 Yahoo 폴백: ${rows.length}거래일 (거래대금 없음)`);
      }
    } catch (e) { logger.warn('[pipeline] KOSPI 히스토리 Yahoo 폴백 실패:', e.message); }
  }

  // KOSPI 종가가 m.stock OPEN 으로 못 가져왔을 때 — kospiHistory 마지막을 기준 거래일로 사용
  if (d.kospi?.today == null && (d.kospiHistory ?? []).length >= 2) {
    const hist = d.kospiHistory;
    const last = hist[hist.length - 1];
    const prev = hist[hist.length - 2];
    if (last?.close != null && prev?.close != null) {
      const diff = r2(last.close - prev.close);
      const pct  = prev.close ? r2(diff / prev.close * 100) : 0;
      d.kospi = {
        ...(d.kospi ?? {}),
        today: last.close, prev: prev.close, diff, pct,
        direction: diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat',
        source: 'history-fallback',
      };
      logger.info(`[pipeline] KOSPI 기준 거래일 폴백: ${last.close} (전일 ${prev.close})`);
    }
  }

  // KOSDAQ 종가 폴백 — Yahoo ^KQ11 5거래일 히스토리에서 마지막/마지막-1 추출
  // KOSPI와 달리 KOSDAQ은 별도 히스토리 객체가 없어 m.stock OPEN 거부 후 빈 채로 떨어지던 사고를 방지.
  if (d.kosdaq?.today == null) {
    const kqHist = await _fetchYahooKosdaqHistory();
    if (kqHist?.length >= 2) {
      const last = kqHist[kqHist.length - 1];
      const prev = kqHist[kqHist.length - 2];
      const diff = r2(last - prev);
      const pct  = prev ? r2(diff / prev * 100) : 0;
      d.kosdaq = {
        ...(d.kosdaq ?? {}),
        today: last, prev, diff, pct,
        direction: diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat',
        source: 'history-fallback',
      };
      logger.info(`[pipeline] KOSDAQ 기준 거래일 폴백: ${last} (전일 ${prev})`);
    }
  }

  // ── 시가총액·거래대금 전일比 폴백 (kospiHistory·KOSPI 종가 채워진 후 실행) ────
  // 시가총액 합산 폴백 — Naver polling에 marketCapRaw 없으면 sise_market_sum 전 종목 합산
  // data.date를 캐시 키로 전달 → collectDomestic에서 이미 호출했으면 메모리 hit (0ms).
  if (d.marketCap == null && d.kospi?.today != null) {
    const mc = await fetchKospiMarketCap(data.date);
    if (mc != null) {
      d.marketCap = mc;
      logger.info(`[pipeline] KOSPI 시가총액 합산 폴백: ${mc}조`);
    }
  }

  // 시가총액·거래대금 전일比 — prevOutputDir → PAGES_BASE_URL 순으로 시도
  // GA 워크스페이스는 매번 새것이라 prevOutputDir 로컬 파일이 없을 가능성 높음 → gh-pages에 deploy된 어제 data.json 직접 fetch.
  if ((d.marketCap != null && d.prevMarketCap == null) || (d.volumeBn != null && d.prevVolumeBn == null)) {
    const prevData = await _loadPrevDayData(prevOutputDir, data.date);
    if (prevData) {
      const prevMc = prevData?.domestic?.marketCap ?? null;
      const prevVb = prevData?.domestic?.volumeBn  ?? null;
      if (d.marketCap != null && d.prevMarketCap == null && prevMc != null) {
        d.prevMarketCap = prevMc;
        d.marketCapDiff = r2(d.marketCap - prevMc);
        d.marketCapPct  = prevMc ? r2(d.marketCapDiff / prevMc * 100) : null;
        logger.info(`[pipeline] 시가총액 전일比: ${d.marketCap}조 vs ${prevMc}조 (${d.marketCapPct}%)`);
      }
      if (d.volumeBn != null && d.prevVolumeBn == null && prevVb != null) {
        d.prevVolumeBn = prevVb;
        logger.info(`[pipeline] 거래대금 전일比: ${d.volumeBn}조 vs ${prevVb}조`);
      }
    }
  }

  // 거래대금 prev 폴백 2단계: kospiHistory 마지막에서 두 번째 행 (= 전 거래일 거래대금)
  if (d.volumeBn != null && d.prevVolumeBn == null && (d.kospiHistory?.length ?? 0) >= 2) {
    const hist = d.kospiHistory;
    const prevRow = hist[hist.length - 2];
    if (prevRow?.tradingValueBn != null) {
      d.prevVolumeBn = prevRow.tradingValueBn;
      logger.info(`[pipeline] 거래대금 전일比 (히스토리 폴백): ${d.volumeBn}조 vs ${prevRow.tradingValueBn}조`);
    }
  }
}

// Yahoo Finance ^KQ11 — KOSDAQ 5거래일 종가 배열 (오래된 → 최근). KOSDAQ history 폴백용.
async function _fetchYahooKosdaqHistory() {
  try {
    const yf = await axios.get(
      'https://query1.finance.yahoo.com/v8/finance/chart/%5EKQ11',
      { params: { interval: '1d', range: '10d' }, headers: NAV_H, timeout: 12000 }
    );
    const closes = yf.data.chart.result[0].indicators.quote[0].close;
    return closes.filter(v => v != null).slice(-5).map(r2);
  } catch (e) {
    logger.warn('[pipeline] KOSDAQ Yahoo 폴백 실패:', e.message);
    return null;
  }
}

// 전일 data.json 로드 — 로컬 prevOutputDir 우선, 없으면 gh-pages에 deploy된 파일을 axios로 fetch
// GA 워크스페이스는 매 실행마다 새것이라 로컬엔 파일이 없음 → PAGES_BASE_URL 경로로 직접 받아옴.
async function _loadPrevDayData(prevOutputDir, currentDate) {
  // 1차: 로컬 파일
  if (prevOutputDir) {
    try {
      const content = await fs.readFile(path.join(prevOutputDir, 'data.json'), 'utf-8');
      return JSON.parse(content);
    } catch { /* 다음 시도 */ }
  }
  // 2차: PAGES_BASE_URL/outputs/{prevDate}/data.json
  const pagesBase = process.env.PAGES_BASE_URL?.replace(/\/$/, '');
  if (pagesBase && currentDate) {
    try {
      // 직전 거래일을 영업일 단위로 거꾸로 탐색 (최대 7일까지)
      for (let i = 1; i <= 7; i++) {
        const dt = new Date(new Date(currentDate).getTime() - i * 86400000);
        const dstr = dt.toISOString().slice(0, 10);
        try {
          const r = await axios.get(`${pagesBase}/outputs/${dstr}/data.json`, { timeout: 10000 });
          if (r.data && r.data.domestic) {
            logger.info(`[pipeline] 전일 데이터 fetch 성공: ${pagesBase}/outputs/${dstr}/data.json`);
            return r.data;
          }
        } catch { /* 다음 날짜 */ }
      }
    } catch { /* 무시 */ }
  }
  return null;
}

// Naver m.stock 인덱스 라이브 시세 — KOSPI/KOSDAQ 종가 폴백용
// marketStatus 함께 반환해 호출부에서 OPEN/CLOSE 분기 가능.
async function _fetchNaverIdxLive(symbol) {
  try {
    const res = await axios.get(
      `https://m.stock.naver.com/api/index/${symbol}/basic`,
      { headers: NAV_H, timeout: 8000 }
    );
    const p     = s => parseFloat(String(s ?? '').replace(/,/g, '')) || null;
    const today = p(res.data.closePrice);
    const delta = p(res.data.compareToPreviousClosePrice);
    const marketStatus = res.data.marketStatus ?? null;
    if (today == null) return null;
    const prev = delta != null ? r2(today - delta) : null;
    const pct  = (prev != null && prev !== 0) ? r2((today - prev) / prev * 100) : 0;
    return {
      today, prev, diff: delta, pct,
      direction: delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat',
      marketStatus,
    };
  } catch { return null; }
}

// VKOSPI 폴백 — investing.com 스트리밍 파싱 (Naver 409 영구 차단 대응, 휴장일에도 응답)
async function _fetchInvestingVkospi() {
  try {
    const res = await axios.get('https://kr.investing.com/indices/kospi-volatility', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
      },
      timeout: 12000,
      responseType: 'text',
    });
    const html = res.data;
    const today = parseFloat((html.match(/data-test="instrument-price-last"[^>]*>([\d.,]+)</) ?? [])[1]?.replace(/,/g, '') ?? '');
    const delta = parseFloat((html.match(/data-test="instrument-price-change"[^>]*>([\-\+\d.,]+)</) ?? [])[1]?.replace(/,/g, '') ?? '');
    if (isNaN(today)) return null;
    const prev = !isNaN(delta) ? r2(today - delta) : null;
    return {
      today, prev,
      diff: isNaN(delta) ? null : delta,
      pct:  (prev != null && prev !== 0) ? r2((today - prev) / prev * 100) : 0,
      direction: !isNaN(delta) ? (delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat') : 'flat',
    };
  } catch { return null; }
}

// Naver investorDealTrendDay 스크래핑 — 최근 5거래일 수급 (외국인·기관·개인 순매수, 단위: 억원)
// 휴장일이어도 직전 거래일부터 5거래일 반환. 결과는 시간순(오래된 → 최근).
async function _fetchNaverSupplyHistory(dateStr) {
  try {
    const bizdate = (dateStr ?? '').replace(/-/g, '');
    const r = await axios.get(
      `https://finance.naver.com/sise/investorDealTrendDay.naver?bizdate=${bizdate}&sosok=`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          Referer: 'https://finance.naver.com/sise/sise_trans_style.naver',
        },
        timeout: 12000,
        responseType: 'arraybuffer',
      }
    );
    const html = new TextDecoder('euc-kr').decode(r.data);
    const { load } = await import('cheerio');
    const $ = load(html);
    const pn = s => { const v = parseFloat(String(s ?? '').replace(/,/g, '')); return isNaN(v) ? null : v; };
    const rows = [];
    $('table tr').each((_, tr) => {
      if (rows.length >= 5) return;
      const cells = $(tr).find('td').map((__, td) => $(td).text().trim()).get();
      if (cells.length >= 4 && /^\d{2}\.\d{2}\.\d{2}$/.test(cells[0])) {
        rows.push({
          date:        cells[0],
          individual:  pn(cells[1]),
          foreign:     pn(cells[2]),
          institution: pn(cells[3]),
        });
      }
    });
    return rows.length > 0 ? rows.reverse() : null; // 오래된 날짜 먼저
  } catch { return null; }
}
