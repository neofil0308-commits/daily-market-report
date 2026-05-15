// tools/pipeline/index.js — Layer 1 집약 진입점
// 모든 피드를 병렬 수집해 PipelineData 객체 반환.
// 수집 실패는 null/[] 반환, 전체 파이프라인 중단 금지.
import axios from 'axios';
import { collectDomestic, fetchKospiMarketCap } from '../collectors/domestic.js';
import { collectOverseas }    from '../collectors/overseas.js';
import { collectFxRates }     from '../collectors/fx_rates.js';
import { collectCommodities } from '../collectors/commodities.js';
import { collectNews }        from '../collectors/news.js';
import { collectDart }        from './dart_feed.js';
import { collectCrypto }      from './crypto_feed.js';
import { validateData }       from '../validators/data_validator.js';
import { isHoliday }          from '../utils/holiday.js';
import { logger }             from '../utils/logger.js';
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
    collectDomestic(krHoliday, prevOutputDir)
      .catch(e => { logger.warn('[pipeline] domestic 실패:', e.message);    return {}; }),
    collectOverseas(usHoliday)
      .catch(e => { logger.warn('[pipeline] overseas 실패:', e.message);    return {}; }),
    collectFxRates()
      .catch(e => { logger.warn('[pipeline] fxRates 실패:', e.message);     return {}; }),
    collectCommodities()
      .catch(e => { logger.warn('[pipeline] commodities 실패:', e.message); return {}; }),
  ]);

  // 뉴스 수집 (시장 데이터 컨텍스트 전달 — AI 키워드 생성용)
  const news = await collectNews(reportDate, { overseas, fxRates })
    .catch(e => { logger.warn('[pipeline] news 실패:', e.message); return []; });

  // 확장 피드 (선택 — API 키 없으면 빈 값 반환)
  const [dart, crypto] = await Promise.all([
    collectDart()
      .catch(e  => { logger.warn('[pipeline] dart 실패:', e.message);   return { reports: [] }; }),
    collectCrypto()
      .catch(e  => { logger.warn('[pipeline] crypto 실패:', e.message); return null; }),
  ]);

  const coreData = validateData({
    date: reportDate,
    domestic, overseas, fxRates, commodities, news,
    meta: { krHoliday, usHoliday },
  });

  const pipelineData = { ...coreData, dart, crypto };

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

  // KOSPI 종가 실시간 폴백 (Yahoo ^KS11 실패 → Naver m.stock 사용)
  // Yahoo가 일시 차단되거나 응답 지연 시 today/prev null로 떨어지는 사고를 방지.
  if (d.kospi?.today == null) {
    const live = await _fetchNaverIdxLive('KOSPI');
    if (live?.today != null) {
      d.kospi = { ...(d.kospi ?? {}), ...live, source: 'naver-fallback' };
      logger.info(`[pipeline] KOSPI 종가 실시간 폴백: ${live.today} (${live.diff >= 0 ? '+' : ''}${live.diff})`);
    }
  }
  if (d.kosdaq?.today == null) {
    const live = await _fetchNaverIdxLive('KOSDAQ');
    if (live?.today != null) {
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

  // 시가총액 폴백 — Naver polling 응답에 없으면 sise_market_sum 전 종목 합산 (휴장일에도 동작)
  // collectDomestic이 휴장일 분기로 일찍 종료해 marketCap이 비는 케이스 대응.
  if (d.marketCap == null && d.kospi?.today != null) {
    const mc = await fetchKospiMarketCap();
    if (mc != null) {
      d.marketCap = mc;
      logger.info(`[pipeline] KOSPI 시가총액 합산 폴백: ${mc}조`);
    }
  }

  // 시가총액 전일比 계산 — prevOutputDir의 data.json에서 전일 marketCap 로드
  if (d.marketCap != null && d.prevMarketCap == null && prevOutputDir) {
    try {
      const prev = JSON.parse(await fs.readFile(path.join(prevOutputDir, 'data.json'), 'utf-8'));
      const prevMc = prev?.domestic?.marketCap ?? null;
      if (prevMc != null) {
        d.prevMarketCap = prevMc;
        d.marketCapDiff = r2(d.marketCap - prevMc);
        d.marketCapPct  = prevMc ? r2(d.marketCapDiff / prevMc * 100) : null;
      }
    } catch { /* 전일 데이터 없으면 무시 */ }
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

  // KOSPI 히스토리 폴백 (6거래일 미만이면 Yahoo Finance 직접 수집)
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
        logger.info(`[pipeline] KOSPI 히스토리 폴백: ${rows.length}거래일`);
      }
    } catch (e) { logger.warn('[pipeline] KOSPI 히스토리 폴백 실패:', e.message); }
  }
}

// Naver m.stock 인덱스 라이브 시세 — KOSPI/KOSDAQ 종가 폴백용
async function _fetchNaverIdxLive(symbol) {
  try {
    const res = await axios.get(
      `https://m.stock.naver.com/api/index/${symbol}/basic`,
      { headers: NAV_H, timeout: 8000 }
    );
    const p     = s => parseFloat(String(s ?? '').replace(/,/g, '')) || null;
    const today = p(res.data.closePrice);
    const delta = p(res.data.compareToPreviousClosePrice);
    if (today == null) return null;
    const prev = delta != null ? r2(today - delta) : null;
    const pct  = (prev != null && prev !== 0) ? r2((today - prev) / prev * 100) : 0;
    return {
      today, prev, diff: delta, pct,
      direction: delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat',
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
