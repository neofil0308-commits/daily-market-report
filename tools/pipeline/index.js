// tools/pipeline/index.js — Layer 1 집약 진입점
// 모든 피드를 병렬 수집해 PipelineData 객체 반환.
// 수집 실패는 null/[] 반환, 전체 파이프라인 중단 금지.
import axios from 'axios';
import { collectDomestic }    from '../collectors/domestic.js';
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

  // ── 실시간 폴백 — null 값 보완 (VKOSPI·거래대금·KOSPI 히스토리) ──────────────
  await _applyLiveFallbacks(pipelineData);

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
async function _applyLiveFallbacks(data) {
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

  // KOSPI 거래대금 실시간 폴백
  if (d.volumeBn == null) {
    try {
      const res  = await axios.get(
        'https://polling.finance.naver.com/api/realtime/domestic/index/KOSPI',
        { headers: NAV_H, timeout: 8000 }
      );
      const item = res.data?.datas?.[0];
      const val  = parseFloat(String(item?.accumulatedTradingValueRaw ?? '').replace(/,/g, ''));
      if (!isNaN(val) && val > 0) {
        d.volumeBn = r2(val / 1e12);
        logger.info(`[pipeline] KOSPI 거래대금 실시간 폴백: ${d.volumeBn}조`);
      }
    } catch (e) { logger.warn('[pipeline] KOSPI 거래대금 폴백 실패:', e.message); }
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
