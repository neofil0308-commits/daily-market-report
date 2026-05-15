// tools/preview_send.js — ⚠️ DEPRECATED ⚠️
// 2026-05-13 이후 GitHub Actions는 이 파일을 호출하지 않는다.
// GA 진입점: tools/orchestrator.js (`.github/workflows/daily-report.yml` 참조).
// 이 파일은 로컬에서 기존 data.json 으로 Gmail 재발송을 검증할 때 쓰는 보조 도구다.
// 새 기능을 여기에 추가하면 GA에 절대 반영되지 않는다 — orchestrator.js / desk/publisher.js 쪽에 추가하라.
// (참조: 오답노트 #033)
import 'dotenv/config';
import fs from 'fs/promises';
import axios from 'axios';
import nodemailer from 'nodemailer';
import { buildHtml, buildEmailCard } from './desk/designer.js';
import { runTFAnalyst } from './teams/tf_analyst.js';
import { runTFNews }    from './teams/tf_news.js';
import { runTFCrypto }  from './teams/tf_crypto.js';

// ── 날짜·데이터 로드 ──────────────────────────────────────────────────────────
const todayStr = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
const data = JSON.parse(await fs.readFile(`./outputs/${todayStr}/data.json`, 'utf-8'));
const { overseas: o, fxRates: fx, commodities: c, news } = data;

// 휴장일이면 직전 거래일 data.json 로드 (국내·KOSPI 히스토리용)
async function loadPrevData() {
  for (let i = 1; i <= 7; i++) {
    const d = new Date(Date.now() + 9 * 60 * 60 * 1000);
    d.setDate(d.getDate() - i);
    const dt = d.toISOString().slice(0, 10);
    try {
      const raw = await fs.readFile(`./outputs/${dt}/data.json`, 'utf-8');
      const p = JSON.parse(raw);
      if (!p.domestic?.isHoliday) return { date: dt, ...p };
    } catch {}
  }
  return null;
}

const isKrHoliday = data.meta.krHoliday;
const prevData    = isKrHoliday ? await loadPrevData() : null;
const d           = isKrHoliday ? (prevData?.domestic ?? {}) : data.domestic;
let   histAll     = d.kospiHistory ?? [];
const prevDateStr = prevData?.date ?? '';

// ── Naver 라이브 폴백 (null 값 보완용) ──────────────────────────────────────
const NAVER_IDX_API = 'https://m.stock.naver.com/api/index';
const NAV_H = { 'User-Agent': 'Mozilla/5.0' };
const r2 = v => Math.round(v * 100) / 100;

async function naverIdxLive(symbol) {
  try {
    const res = await axios.get(`${NAVER_IDX_API}/${symbol}/basic`, { headers: NAV_H, timeout: 8000 });
    const p = s => parseFloat(String(s ?? '').replace(/,/g, '')) || null;
    const today = p(res.data.closePrice);
    const delta = p(res.data.compareToPreviousClosePrice);
    const prev  = (today != null && delta != null) ? r2(today - delta) : null;
    const pct   = (prev != null && prev !== 0) ? r2((today - prev) / prev * 100) : 0;
    return { today, prev, diff: delta, pct, direction: delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat' };
  } catch { return null; }
}

async function naverPollingVolumeBn() {
  try {
    const res = await axios.get('https://polling.finance.naver.com/api/realtime/domestic/index/KOSPI', {
      headers: NAV_H, timeout: 8000,
    });
    const item = res.data?.datas?.[0];
    if (!item) return null;
    const val = parseFloat(String(item.accumulatedTradingValueRaw ?? '').replace(/,/g, ''));
    return isNaN(val) || val === 0 ? null : r2(val / 1e12);
  } catch { return null; }
}

// VKOSPI 폴백
if (d.vkospi?.today == null) {
  const live = await naverIdxLive('VKOSPI');
  if (live?.today != null) {
    d.vkospi = live;
    console.log('[report] VKOSPI 폴백 수집 완료:', live.today);
  }
}

// KOSPI 거래대금 폴백
if (d.volumeBn == null) {
  d.volumeBn = await naverPollingVolumeBn();
  if (d.volumeBn != null) console.log('[report] KOSPI 거래대금 폴백 수집 완료:', d.volumeBn);
}

// ── KOSPI 히스토리 폴백 (6거래일 미만이면 Yahoo Finance 직접 수집) ──────────
if (histAll.length < 6) {
  try {
    const refTs = new Date((prevDateStr || todayStr) + 'T23:59:59+09:00').getTime() / 1000;
    const yf    = await axios.get('https://query1.finance.yahoo.com/v8/finance/chart/%5EKS11', {
      params: { interval: '1d', range: '30d' },
      headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 12000,
    });
    const yfRes = yf.data.chart.result[0];
    const yfCl  = yfRes.indicators.quote[0].close;
    const yfVo  = yfRes.indicators.quote[0].volume;
    const toMD  = ts => {
      const dt = new Date(ts * 1000);
      return `${String(dt.getMonth()+1).padStart(2,'0')}/${String(dt.getDate()).padStart(2,'0')}`;
    };
    const rows6 = yfRes.timestamp
      .map((ts, i) => ({ ts, close: yfCl[i], volume: yfVo[i] }))
      .filter(x => x.close != null && x.ts <= refTs)
      .slice(-6)
      .map(x => ({ date: toMD(x.ts), close: r2(x.close), volume: x.volume, tradingValueBn: null }));
    if (rows6.length >= 2) {
      histAll = rows6;
      d.kospiHistory = rows6;
      console.log('[report] KOSPI 히스토리 폴백 수집 완료:', rows6.length, '거래일');
    }
  } catch (e) { console.warn('[report] KOSPI 히스토리 폴백 실패:', e.message); }
}

// ── TF-1 뉴스 분석 (AI Summary top_stories 생성) ────────────────────────────
let tfNewsResult = { findings: [], top_stories: [], themes: [] };
try {
  tfNewsResult = await runTFNews(news ?? [], data);
  if (tfNewsResult.top_stories?.length) {
    console.log(`[report] 뉴스 요약 ${tfNewsResult.top_stories.length}건 생성 완료`);
  }
} catch (e) {
  console.warn('[report] 뉴스 분석 실패 (무시):', e.message);
}

// ── 수급 5거래일 이력 수집 ────────────────────────────────────────────────────
async function fetchSupplyHistory(dateStr) {
  try {
    const bizdate = dateStr.replace(/-/g, '');
    const r = await axios.get(
      `https://finance.naver.com/sise/investorDealTrendDay.naver?bizdate=${bizdate}&sosok=`,
      { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://finance.naver.com/sise/sise_trans_style.naver' },
        timeout: 12000, responseType: 'arraybuffer' }
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
        rows.push({ date: cells[0], foreign: pn(cells[2]), institution: pn(cells[3]), individual: pn(cells[1]) });
      }
    });
    return rows.length > 0 ? rows.reverse() : null; // 오래된 날짜 먼저
  } catch { return null; }
}

const supplyHistory = await fetchSupplyHistory(todayStr).catch(() => null);
if (supplyHistory) {
  d.supplyHistory = supplyHistory;
  console.log(`[report] 수급 추이 ${supplyHistory.length}거래일 수집 완료`);
}

// ── TF-2 애널리스트 리포트 분석 + TF-3 코인 분석 (병렬) ─────────────────────
let tfAnalystResult = { findings: [] };
let tfCryptoResult  = { findings: [] };
try {
  [tfAnalystResult, tfCryptoResult] = await Promise.all([
    runTFAnalyst(data.dart ?? { reports: [] }, news ?? []).catch(e => {
      console.warn('[report] 애널리스트 분석 실패 (무시):', e.message);
      return { findings: [] };
    }),
    runTFCrypto(data.crypto ?? null, news ?? []).catch(e => {
      console.warn('[report] 코인 분석 실패 (무시):', e.message);
      return { findings: [] };
    }),
  ]);
  if (tfAnalystResult.findings?.length)
    console.log(`[report] 애널리스트 리포트 ${tfAnalystResult.findings.length}건 선정 완료`);
  if (tfCryptoResult.findings?.length)
    console.log(`[report] 코인 분석 ${tfCryptoResult.findings.length}건 완료`);
} catch (e) {
  console.warn('[report] TF 분석 실패 (무시):', e.message);
}

// Gemini 503 재시도 — findings 비어 있고 분석 소스가 있으면 3초 후 1회 재시도
if (tfAnalystResult.findings.length === 0) {
  const hasAnalystNews = (news ?? []).some(n =>
    /목표주가|목표가|투자의견|증권사|리포트|매수|매도|Buy|Hold/i.test((n.title ?? '') + ' ' + (n.body ?? ''))
  );
  if (hasAnalystNews || data.dart?.reports?.length > 0) {
    console.log('[report] 애널리스트 분석 재시도 (3초 후)...');
    await new Promise(r => setTimeout(r, 3000));
    try {
      const retry = await runTFAnalyst(data.dart ?? { reports: [] }, news ?? []);
      if (retry.findings?.length > 0) {
        tfAnalystResult = retry;
        console.log(`[report] 애널리스트 재시도 성공: ${tfAnalystResult.findings.length}건`);
      }
    } catch {}
  }
}

// DART 리포트가 있지만 Gemini가 실패해 findings가 비면 → 원시 DART로 폴백
if (tfAnalystResult.findings.length === 0 && data.dart?.reports?.length > 0) {
  tfAnalystResult.findings = data.dart.reports.slice(0, 5).map(r => ({
    company:      r.company ?? '―',
    firm:         r.flr_nm  ?? '―',
    rating_change: '―',
    target_price: { new: null },
    key_thesis:   r.reportName ?? '',
    dart_url:     r.url ?? null,
    importance:   5,
  }));
  console.log(`[report] 애널리스트 DART 폴백: ${tfAnalystResult.findings.length}건`);
}

// DART URL 매칭 — findings의 company가 DART 리포트와 일치하면 URL 추가
if (data.dart?.reports?.length > 0 && tfAnalystResult.findings.length > 0) {
  const dartByCompany = new Map(data.dart.reports.map(r => [r.company, r.url]));
  tfAnalystResult.findings = tfAnalystResult.findings.map(f => ({
    ...f,
    dart_url: f.dart_url ?? dartByCompany.get(f.company) ?? null,
  }));
}

// ── HTML 생성 (designer.js 공통 빌더) ────────────────────────────────────────
const html = await buildHtml(
  { date: data.date, domestic: d, overseas: o, fxRates: fx, commodities: c, news: news ?? [], crypto: data.crypto },
  { news: tfNewsResult, analyst: tfAnalystResult, crypto: tfCryptoResult },
  { headline: null, include_crypto: !!(data.crypto), include_analyst: tfAnalystResult.findings?.length > 0 }
);

// ── HTML 파일 저장 ───────────────────────────────────────────────────────────
await fs.writeFile(`./outputs/${todayStr}/report.html`, html, 'utf-8');

// ── 중복 발송 방지 (로컬: sent.flag / GA: Notion DB 조회) ───────────────────
const sentFlagPath = `./outputs/${todayStr}/sent.flag`;
const forceResend = process.argv.includes('--force');
const localSent   = await fs.access(sentFlagPath).then(() => true).catch(() => false);
if (localSent && !forceResend) {
  console.log(`⏭  ${todayStr} 리포트는 이미 발송됨 (로컬 플래그) — 건너뜀`);
  process.exit(0);
}
if (localSent && forceResend) {
  console.log(`[INFO] --force 플래그 감지 — sent.flag 무시하고 재발송 진행`);
}
if (process.env.GITHUB_ACTIONS === 'true') {
  const { checkAlreadySent } = await import('./publishers/notion.js');
  if (await checkAlreadySent(todayStr)) {
    console.log(`⏭  ${todayStr} 리포트는 이미 발송됨 (Notion 확인) — 건너뜀`);
    process.exit(0);
  }
}

// ── Gmail 발송 (뉴스카드 요약 이메일 + GitHub Pages 링크) ─────────────────────
const reportUrl = `${process.env.PAGES_BASE_URL ?? ''}/outputs/${todayStr}/report.html`;

const pipelineData = { date: data.date, domestic: d, overseas: o, fxRates: fx, commodities: c, news: news ?? [], crypto: data.crypto };
const cardHtml = buildEmailCard(
  pipelineData,
  { news: tfNewsResult, analyst: tfAnalystResult, crypto: tfCryptoResult },
  { headline: null },
  reportUrl,
);

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.GMAIL_SENDER, pass: process.env.GMAIL_APP_PASSWORD },
});

await transporter.sendMail({
  from:    `"시장 리포트" <${process.env.GMAIL_SENDER}>`,
  to:      process.env.GMAIL_RECIPIENT,
  subject: `${data.date} 시장 리포트`,
  html: cardHtml,
});

await fs.writeFile(sentFlagPath, new Date().toISOString(), 'utf-8');
console.log(`✅ 리포트 발송 완료 → ${process.env.GMAIL_RECIPIENT}`);

// ── Notion 아카이빙 ───────────────────────────────────────────────────────────
try {
  const { publishToNotion } = await import('./publishers/notion.js');
  await publishToNotion(todayStr, '', html, data);
} catch (e) {
  console.warn('[report] Notion 아카이빙 실패:', e.message);
}
