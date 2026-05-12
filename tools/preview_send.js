// tools/preview_send.js — 일일 시장 리포트 Gmail 발송
import 'dotenv/config';
import fs from 'fs/promises';
import axios from 'axios';
import nodemailer from 'nodemailer';
import { buildHtml } from './desk/designer.js';
import { runTFAnalyst } from './teams/tf_analyst.js';

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

// ── 애널리스트 리포트 분석 (tf_analyst) ─────────────────────────────────────
let tfAnalystResult = { findings: [] };
try {
  tfAnalystResult = await runTFAnalyst(data.dart ?? { reports: [] }, news ?? []);
  if (tfAnalystResult.findings?.length) {
    console.log(`[report] 애널리스트 리포트 ${tfAnalystResult.findings.length}건 선정 완료`);
  }
} catch (e) {
  console.warn('[report] 애널리스트 분석 실패 (무시):', e.message);
}

// ── HTML 생성 (designer.js 공통 빌더) ────────────────────────────────────────
const html = await buildHtml(
  { date: data.date, domestic: d, overseas: o, fxRates: fx, commodities: c, news: news ?? [] },
  { analyst: tfAnalystResult },
  { headline: null, include_crypto: false, include_analyst: tfAnalystResult.findings?.length > 0 }
);

// ── HTML 파일 저장 ───────────────────────────────────────────────────────────
await fs.writeFile(`./outputs/${todayStr}/report.html`, html, 'utf-8');

// ── 중복 발송 방지 (로컬: sent.flag / GA: Notion DB 조회) ───────────────────
const sentFlagPath = `./outputs/${todayStr}/sent.flag`;
const localSent   = await fs.access(sentFlagPath).then(() => true).catch(() => false);
if (localSent) {
  console.log(`⏭  ${todayStr} 리포트는 이미 발송됨 (로컬 플래그) — 건너뜀`);
  process.exit(0);
}
if (process.env.GITHUB_ACTIONS === 'true') {
  const { checkAlreadySent } = await import('./publishers/notion.js');
  if (await checkAlreadySent(todayStr)) {
    console.log(`⏭  ${todayStr} 리포트는 이미 발송됨 (Notion 확인) — 건너뜀`);
    process.exit(0);
  }
}

// ── Gmail 발송 ───────────────────────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.GMAIL_SENDER, pass: process.env.GMAIL_APP_PASSWORD },
});

await transporter.sendMail({
  from:    `"시장 리포트" <${process.env.GMAIL_SENDER}>`,
  to:      process.env.GMAIL_RECIPIENT,
  subject: `${data.date} 시장 리포트`,
  html,
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
