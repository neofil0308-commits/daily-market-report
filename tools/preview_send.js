// tools/preview_send.js — 일일 시장 리포트 Gmail 발송
import 'dotenv/config';
import fs from 'fs/promises';
import axios from 'axios';
import nodemailer from 'nodemailer';
import { GoogleGenerativeAI } from '@google/generative-ai';

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
let   histAll     = d.kospiHistory ?? [];          // 최대 6거래일 (6번째가 전일비 기준)
let   histDisp    = histAll.length >= 2 ? histAll.slice(-5) : histAll;  // 표시용 5거래일
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
  // polling API: accumulatedTradingValueRaw is in 원, ÷1e12 = 조원
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

// 수급 (KRX 세션 필요 → 직전 거래일 데이터 사용, 없으면 null)
const supply = d.supply ?? { foreign: null, institution: null, individual: null };

// ── KOSPI 히스토리 폴백 (6거래일 미만이면 Yahoo Finance 직접 수집) ──────────
if (histAll.length < 6) {
  try {
    const refTs = new Date((prevDateStr || todayStr) + 'T23:59:59+09:00').getTime() / 1000;
    const yf    = await axios.get('https://query1.finance.yahoo.com/v8/finance/chart/%5EKS11', {
      params: { interval: '1d', range: '30d' },
      headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 12000,
    });
    const yfRes  = yf.data.chart.result[0];
    const yfCl   = yfRes.indicators.quote[0].close;
    const yfVo   = yfRes.indicators.quote[0].volume;
    const toMD   = ts => {
      const dt = new Date(ts * 1000);
      return `${String(dt.getMonth()+1).padStart(2,'0')}/${String(dt.getDate()).padStart(2,'0')}`;
    };
    const rows6 = yfRes.timestamp
      .map((ts, i) => ({ ts, close: yfCl[i], volume: yfVo[i] }))
      .filter(x => x.close != null && x.ts <= refTs)
      .slice(-6)
      .map(x => ({ date: toMD(x.ts), close: r2(x.close), volume: x.volume }));
    if (rows6.length >= 2) {
      histAll  = rows6;
      histDisp = rows6.slice(-5);
      console.log('[report] KOSPI 히스토리 폴백 수집 완료:', rows6.length, '거래일');
    }
  } catch (e) { console.warn('[report] KOSPI 히스토리 폴백 실패:', e.message); }
}

// ── Gemini AI 뉴스 요약 (기사별 JSON) ───────────────────────────────────────
const summaryMap = new Map(); // url → summary text (bullet lines)
try {
  const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
  const model = genAI.getGenerativeModel({ model: process.env.GEMINI_MODEL ?? 'gemini-2.5-flash' });
  const result = await model.generateContent(`
다음은 ${data.date} 기준 수집된 금융 뉴스입니다. 각 기사를 한국어 핵심 불릿 2~3개로 요약하세요.
반드시 아래 JSON 배열 형식으로만 응답하고 다른 텍스트는 포함하지 마세요.

[
  {"url": "기사URL", "summary": "• 핵심1\\n• 핵심2\\n• 핵심3"},
  ...
]

뉴스 목록:
${JSON.stringify(news.map(n => ({ url: n.url, title: n.title, body: n.body })), null, 2)}
  `);
  const raw = result.response.text().replace(/^```json\s*/,'').replace(/```\s*$/,'').trim();
  const parsed = JSON.parse(raw);
  parsed.forEach(item => { if (item.url && item.summary) summaryMap.set(item.url, item.summary); });
  console.log('[report] AI 뉴스 요약 생성 완료:', summaryMap.size, '건');
} catch (e) {
  console.warn('[report] Gemini 뉴스 요약 실패 (fallback):', e.message);
}

// ── Gemini AI 종합 요약 (Summary 섹션) ────────────────────────────────────────
let reportSummaryHtml = '';
try {
  const genAI2 = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
  const model2 = genAI2.getGenerativeModel({ model: process.env.GEMINI_MODEL ?? 'gemini-2.5-flash' });
  const domesticSnap = isKrHoliday
    ? { note: `국내 휴장 (직전 거래일: ${prevDateStr})` }
    : { kospi: d.kospi, kosdaq: d.kosdaq, vkospi: d.vkospi, volumeBn: d.volumeBn };
  const result2 = await model2.generateContent(`
다음은 ${data.date} 기준 일일 시장 리포트 데이터입니다.
아래 항목을 포함해 전반적인 시장 상황을 한국어 불릿 4~6개로 간결하게 요약하세요.
각 불릿은 "• "으로 시작하고, 구체적인 수치를 포함하세요.
불릿만 출력하고 다른 텍스트는 포함하지 마세요.

포함 항목: 국내 증시 동향 / 해외 주요 지수 / 환율·금리 특이사항 / 원자재 특이사항 / 뉴스 주요 테마

데이터:
${JSON.stringify({
  date: data.date,
  domestic: domesticSnap,
  overseas: data.overseas,
  fxRates: { usdKrw: data.fxRates.usdKrw, dxy: data.fxRates.dxy, us10y: data.fxRates.us10y, fomc: data.fxRates.fomc },
  commodities: { gold: data.commodities.gold, wti: data.commodities.wti, copper: data.commodities.copper },
  newsHeadlines: news.slice(0, 6).map(n => n.title),
}, null, 2)}
  `);
  const bullets = result2.response.text().trim().split('\n').filter(l => l.trim());
  reportSummaryHtml = bullets
    .map(l => `<p style="margin:4px 0;font-size:13px;color:#1a1a1a;line-height:1.7">${l.replace(/^[•·\-]\s*/, '• ')}</p>`)
    .join('');
  console.log('[report] 종합 요약 생성 완료');
} catch (e) {
  console.warn('[report] Gemini 종합 요약 실패:', e.message);
}

// ── 유틸 ────────────────────────────────────────────────────────────────────
const N   = (v, dec=2) => v == null ? 'N/A' : Number(v).toLocaleString('ko-KR', {minimumFractionDigits:dec, maximumFractionDigits:dec});
const NI  = (v) => v == null ? 'N/A' : Math.round(v).toLocaleString('ko-KR');
const dir = (v) => v == null ? 'neu' : v > 0 ? 'up' : v < 0 ? 'dn' : 'neu';
const arr = (v) => v == null ? '―' : v > 0 ? '▲' : v < 0 ? '▼' : '―';
const sgn = (v) => v == null ? '' : v > 0 ? '+' : '';
const fmtDate = (dt) => dt ? dt.replace(/-/g, '.') : '';

function label(pctVal) {
  if (pctVal == null) return '―';
  if (pctVal >=  3)  return '급등';
  if (pctVal >=  1)  return '강세';
  if (pctVal >   0)  return '소폭 상승';
  if (pctVal === 0)  return '보합';
  if (pctVal >= -1)  return '소폭 하락';
  if (pctVal >= -3)  return '약세';
  return '급락';
}

const COLOR = { up:'#E24B4A', dn:'#378ADD', neu:'#888888' };
function chg(obj, unit='') {
  if (!obj || obj.diff == null) return '<span style="color:#888">―</span>';
  const col = COLOR[dir(obj.diff)];
  const lbl = label(obj.pct);
  return `<span style="color:${col};font-weight:500;white-space:nowrap">${arr(obj.diff)} ${sgn(obj.diff)}${N(Math.abs(obj.diff))}${unit} (${sgn(obj.pct)}${N(obj.pct)}%)</span>`
       + `<br><span style="font-size:11px;color:#888">(${lbl})</span>`;
}

function trow(lbl2, obj, todayVal, prevVal, unit='', note='') {
  return `<tr>
    <td>${lbl2}</td>
    <td class="r">${todayVal}</td>
    <td class="r">${prevVal}</td>
    <td class="c">${chg(obj, unit)}</td>
    <td class="bi">${note || '―'}</td>
  </tr>`;
}

function supplyRow(label2, val) {
  if (val == null) return `<div class="bar-row">${label2} &nbsp;<span style="color:#888">N/A</span></div>`;
  const col  = val > 0 ? COLOR.up : val < 0 ? COLOR.dn : COLOR.neu;
  const sign = val > 0 ? '+' : '';
  return `<div class="bar-row">${label2} &nbsp;<span style="color:${col};font-weight:500">${arr(val)} ${sign}${Math.abs(val).toLocaleString('ko-KR')}주</span></div>`;
}

function dirNote(obj, upNote, dnNote, flatNote='보합') {
  if (!obj || obj.diff == null) return '―';
  if (obj.diff > 0) return upNote;
  if (obj.diff < 0) return dnNote;
  return flatNote;
}

function kospiNote(obj) {
  if (!obj || obj.diff == null) return '―';
  const lbl = label(obj.pct);
  if (obj.diff > 0) return `${lbl} — 매수세 유입`;
  if (obj.diff < 0) return `${lbl} — 매도 우위·차익실현`;
  return '보합 — 관망세 지속';
}
function kosdaqNote(kObj, qObj) {
  if (!qObj || qObj.diff == null) return '―';
  const lbl = label(qObj.pct);
  const rel = (kObj?.pct != null && qObj.pct != null)
    ? (qObj.pct >= kObj.pct ? ' · 코스피 대비 강세' : ' · 코스피 대비 약세')
    : '';
  return `${lbl}${rel}`;
}
function vkospiNote(obj) {
  if (!obj || obj.today == null) return '―';
  if (obj.diff == null || obj.diff === 0) return `현재 ${N(obj.today)} · 변동성 보합`;
  const dir2 = obj.diff > 0 ? '상승 → 변동성 확대' : '하락 → 변동성 축소';
  return `${N(obj.today)} · ${dir2}`;
}
function volumeNote(bn) {
  if (bn == null) return '일중 누적 기준';
  if (bn >= 15)  return '활발한 거래 · 시장 관심 고조';
  if (bn >= 8)   return '보통 수준의 거래';
  return '거래 다소 한산';
}

function goldKrwNote() {
  const intlPct = c.gold?.pct, fxPct = fx.usdKrw?.pct;
  if (intlPct == null && fxPct == null) return '―';
  const parts = [];
  if (intlPct != null) parts.push(`국제금 ${sgn(intlPct)}${N(intlPct)}%`);
  if (fxPct   != null) parts.push(`달러원 ${sgn(fxPct)}${N(fxPct)}%`);
  const res = (c.goldKrw?.pct ?? 0) > 0 ? '원화 환산가 상승' : (c.goldKrw?.pct ?? 0) < 0 ? '원화 환산가 하락' : '보합';
  return `${parts.join(' + ')} → ${res}`;
}

// 마크다운 → HTML (AI 요약 렌더링용)
function mdToHtml(md) {
  if (!md) return '';
  return md.split('\n').map(line => {
    let l = line
      .replace(/\*\*\[([^\]]+)\]\(([^)]+)\)\*\*/g, '<b><a href="$2" target="_blank" style="color:#2563eb;text-decoration:none">$1</a></b>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" style="color:#2563eb;text-decoration:none">$1</a>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
    if (/^#{3,4} /.test(line)) return `<p style="margin:14px 0 4px;font-size:13px;font-weight:700">${l.replace(/^#{3,4} /,'')}</p>`;
    if (/^## /.test(line))     return `<p style="margin:18px 0 6px;font-size:13px;font-weight:700;border-bottom:1px solid #e0e0e0;padding-bottom:4px">${l.slice(3)}</p>`;
    if (/^[-·•] /.test(line))  return `<p style="margin:2px 0 2px 12px;font-size:12px;color:#444;line-height:1.65">• ${l.slice(2)}</p>`;
    if (/^---/.test(line))     return `<hr style="border:none;border-top:1px solid #ebebeb;margin:10px 0">`;
    if (/^> /.test(line))      return `<p style="font-size:11px;color:#666;margin:0 0 6px">${l.slice(2)}</p>`;
    if (line.trim() === '')    return `<div style="height:5px"></div>`;
    return `<p style="font-size:12px;color:#333;line-height:1.7;margin:2px 0">${l}</p>`;
  }).join('');
}

// 뉴스 태그·본문 (기사별 AI 요약 우선, fallback 원문 파싱)
const tagClass = { '시장전반':'t-mkt','산업·기업':'t-corp','거시경제':'t-mac' };
function newsBody(body) {
  if (!body) return '';
  return body.replace(/&quot;/g,'"')
    .split(/(?<=[.…。])\s+/).map(s=>s.trim()).filter(s=>s.length>10).slice(0,3)
    .map(s=>`· ${s}`).join('<br>');
}
function mdBullets(text) {
  return text.split('\n').filter(l => l.trim())
    .map(l => l.replace(/^[•·\-]\s*/, '').trim())
    .filter(Boolean)
    .map(s => `· ${s}`).join('<br>');
}
const newsRows = news.map(n => {
  const sumText = summaryMap.get(n.url);
  const contentHtml = sumText ? mdBullets(sumText) : newsBody(n.body);
  return `
  <tr>
    <td class="td-date">${(n.date?.slice(5)||'').replace('-','/')}</td>
    <td class="td-cat"><span class="tag ${tagClass[n.category]??'t-mkt'}">${n.category}</span></td>
    <td class="td-ttl"><a href="${n.url}" target="_blank">${n.title}</a><div class="td-src">📰 ${n.source}</div></td>
    <td class="td-sum">${contentHtml}</td>
  </tr>`;
}).join('');

function histIssue(dp) {
  if (dp == null) return '―';
  const abs = Math.abs(dp);
  if (dp > 0) {
    if (abs >= 2) return `급등 +${N(abs)}% · 외국인 대규모 순매수`;
    if (abs >= 1) return `강세 +${N(abs)}% · 매수 우위`;
    return `소폭 상승 +${N(abs)}% · 관망 속 매수세`;
  }
  if (dp < 0) {
    if (abs >= 2) return `급락 -${N(abs)}% · 외국인·기관 동반 매도`;
    if (abs >= 1) return `약세 -${N(abs)}% · 매도 우위`;
    return `소폭 하락 -${N(abs)}% · 차익실현`;
  }
  return '보합 · 관망세 지속';
}

// KOSPI 5거래일 히스토리 — 6번째 항목을 첫 행의 전일비 기준으로 사용
const histRows = histDisp.map((h, i) => {
  const prevItem = i === 0
    ? (histAll.length > histDisp.length ? histAll[histAll.length - histDisp.length - 1] : null)
    : histDisp[i - 1];
  const pc   = prevItem?.close ?? null;
  const diff = pc != null ? +(h.close - pc).toFixed(2) : null;
  const dp   = pc != null ? +((diff / pc) * 100).toFixed(2) : null;
  const cls  = dir(diff);
  const valStr = diff != null
    ? `<span style="color:${COLOR[cls]};font-weight:500;white-space:nowrap">${arr(diff)} ${sgn(diff)}${N(Math.abs(diff))} (${sgn(dp)}${N(dp)}%)</span><br><span style="font-size:11px;color:#888">(${label(dp)})</span>`
    : '<span style="color:#888">―</span>';
  // 거래량: 신규 포맷(volume in 천주) 또는 구형 포맷(volumeBn≈0) 처리
  const rawVol = h.volume ?? (h.volumeBn != null && h.volumeBn > 1e-4 ? h.volumeBn * 1e12 / 1e3 : null);
  const volStr = rawVol && rawVol > 1000 ? `${(rawVol / 1e5).toFixed(1)}억주` : '―';
  return `<tr>
    <td>${h.date}</td>
    <td class="r">${N(h.close)}</td>
    <td class="c">${valStr}</td>
    <td class="r">${volStr}</td>
    <td class="bi">${histIssue(dp)}</td>
  </tr>`;
}).join('');

// 차트 데이터 (표시용 5거래일 기준)
const labels    = histDisp.map(h => `'${h.date}'`).join(',');
const closes    = histDisp.map(h => h.close).join(',');
const rawVols   = histDisp.map(h => {
  const rv = h.volume ?? (h.volumeBn != null && h.volumeBn > 1e-4 ? h.volumeBn * 1e12 / 1e3 : null);
  return (rv && rv > 1000) ? +(rv / 1e5).toFixed(1) : 'null';
});
const volumes   = rawVols.join(',');
const hasVol    = rawVols.some(v => v !== 'null');
const allPrices = histDisp.map(h => h.close).filter(Boolean);
const yMin = allPrices.length ? Math.floor(Math.min(...allPrices)*0.98/100)*100 : 6000;
const yMax = allPrices.length ? Math.ceil(Math.max(...allPrices)*1.02/100)*100 : 8000;

// ── QuickChart.io 서버사이드 차트 이미지 (Gmail JS 차단 대응) ────────────────
const qcDatasets = [{
  type: 'line', label: 'KOSPI 종가',
  data: histDisp.map(h => h.close),
  borderColor: '#E24B4A', backgroundColor: 'rgba(226,75,74,0.08)',
  borderWidth: 2, pointBackgroundColor: '#E24B4A', pointRadius: 5,
  fill: true, yAxisID: 'A',
}];
const qcVols = rawVols.map(v => v === 'null' ? null : parseFloat(v));
if (hasVol) {
  qcDatasets.push({
    type: 'bar', label: '거래량(억주)',
    data: qcVols,
    backgroundColor: 'rgba(59,130,246,0.18)', borderColor: 'rgba(59,130,246,0.5)',
    borderWidth: 1, yAxisID: 'B',
  });
}
const qcYAxes = [{ id:'A', position:'left', ticks:{ min:yMin, max:yMax, fontSize:10 } }];
if (hasVol) qcYAxes.push({ id:'B', position:'right', ticks:{ min:0, fontSize:10 }, gridLines:{ drawOnChartArea:false } });
const qcConfig = {
  type: 'bar',
  data: { labels: histDisp.map(h => h.date), datasets: qcDatasets },
  options: {
    legend: { display: hasVol, position:'top', labels:{ fontSize:11, padding:8 } },
    scales: { xAxes:[{ ticks:{ fontSize:10 } }], yAxes: qcYAxes },
  },
};
const chartUrl = 'https://quickchart.io/chart?w=660&h=200&backgroundColor=white&c='
  + encodeURIComponent(JSON.stringify(qcConfig));

const cg = (w1) => `<colgroup>
  <col style="width:${w1}px"><col style="width:88px"><col style="width:88px">
  <col style="width:155px"><col>
</colgroup>`;

// 휴장 안내 주기 (세련된 인라인 뱃지 형태)
const krHolidayNote = isKrHoliday && prevDateStr
  ? `<div style="margin-top:10px;padding:8px 12px;background:#f0f7ff;border-left:3px solid #3b82f6;border-radius:0 6px 6px 0;font-size:11px;color:#1e40af;line-height:1.6">
      📅 금일(${fmtDate(data.date)})은 공휴일로 국내 증시가 휴장합니다. 직전 거래일 <strong>${fmtDate(prevDateStr)}</strong> 종가를 기준으로 표시합니다.
    </div>` : '';

// ── HTML ────────────────────────────────────────────────────────────────────
const html = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<meta name="format-detection" content="telephone=no">
<title>시장 리포트 ${data.date}</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--fn:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif}
body,div,span,td,th,a,p,table,h1,h2,h3,h4{font-family:var(--fn) !important}
body{font-size:14px;background:#f5f5f5;padding:16px;color:#1a1a1a;-webkit-text-size-adjust:100%;text-size-adjust:100%}
.wrap{max-width:720px;margin:0 auto;width:100%}
.hdr{margin-bottom:1.5rem;padding-bottom:12px;border-bottom:1px solid #e0e0e0}
.hdr-title{font-size:20px;font-weight:600;display:block}
.hdr-date{font-size:12px;color:#666;margin-top:3px;display:block}
.sec{margin:0 0 1.8rem}
.sec-title{font-size:11px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:#666;border-bottom:1px solid #e0e0e0;padding-bottom:5px;margin-bottom:10px}
/* 표 공통 */
.tbl{width:100%;border-collapse:collapse;table-layout:fixed}
.tbl th{font-size:11px;font-weight:600;color:#555;background:#f8f8f8;padding:6px 6px;border-bottom:1px solid #e0e0e0;white-space:nowrap;text-align:center}
.tbl th.l{text-align:left}
.tbl td{font-size:12px;padding:7px 6px;border-bottom:1px solid #ebebeb;color:#1a1a1a;vertical-align:middle;line-height:1.5}
.tbl td.r{text-align:right;white-space:nowrap}
.tbl td.c{text-align:center}
.tbl td.bi{font-size:11px;color:#555;line-height:1.55;word-break:keep-all}
.tbl tr:last-child td{border-bottom:none}
.na-row td{color:#bbb;font-size:11px}
/* 수급 */
.sup-grid{display:table;width:100%;margin-top:10px}
.sup-cell{display:table-cell;width:50%;padding-right:8px;vertical-align:top}
.sup-cell:last-child{padding-right:0;padding-left:8px}
.sup-card{background:#f8f8f8;border-radius:6px;padding:10px 12px}
.sup-card .st{font-size:11px;font-weight:600;color:#666;margin-bottom:6px}
.bar-row{margin-bottom:4px;font-size:12px;color:#666}
/* 차트 이미지 */
.chart-wrap{width:100%;margin-bottom:8px}
/* 뉴스 AI 요약 */
.ai-box{background:#fff;border:1px solid #e0e0e0;border-radius:8px;padding:14px 16px;margin-bottom:12px}
.ai-badge{display:inline-block;font-size:10px;font-weight:700;background:#eff6ff;color:#2563eb;padding:2px 7px;border-radius:10px;margin-bottom:10px;letter-spacing:.03em}
/* 뉴스 표 */
.ntbl{width:100%;border-collapse:collapse;table-layout:fixed}
.ntbl th{font-size:11px;font-weight:600;color:#555;background:#f8f8f8;padding:6px 6px;border-bottom:1px solid #e0e0e0;text-align:center}
.ntbl th.l{text-align:left}
.ntbl td{font-size:12px;padding:8px 6px;border-bottom:1px solid #ebebeb;vertical-align:top}
.ntbl tr:last-child td{border-bottom:none}
.td-date{white-space:nowrap;font-size:11px;color:#666;width:46px}
.td-cat{white-space:nowrap;width:54px;text-align:center}
.td-ttl a{color:#2563eb;text-decoration:none;font-size:12px;line-height:1.4;display:block}
.td-src{font-size:10px;color:#888;margin-top:2px}
.td-sum{font-size:11px;color:#555;line-height:1.65}
.tag{display:inline-block;font-size:10px;font-weight:600;padding:2px 5px;border-radius:3px}
.t-mkt{background:#eff6ff;color:#2563eb}
.t-corp{background:#f0fdf4;color:#16a34a}
.t-mac{background:#fffbeb;color:#d97706}
.note{font-size:11px;color:#999;margin-top:5px;line-height:1.7}
.divider{height:1px;background:#ebebeb;margin:1.5rem 0}
/* Summary 섹션 */
.summary-box{background:#f8faff;border:1px solid #dbe8ff;border-radius:8px;padding:14px 18px;margin-bottom:1.8rem}
.summary-box .s-title{font-size:11px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:#2563eb;margin-bottom:10px;display:flex;align-items:center;gap:6px}
.summary-box .s-badge{display:inline-block;font-size:10px;font-weight:700;background:#2563eb;color:#fff;padding:2px 7px;border-radius:10px;letter-spacing:.03em}
/* 모바일 반응형 */
@media screen and (max-width:600px){
  body{padding:10px;font-size:13px}
  .wrap{max-width:100%}
  .hdr-title{font-size:17px}
  .tbl,.ntbl{table-layout:auto}
  .tbl th,.tbl td,.ntbl th,.ntbl td{padding:5px 4px;font-size:11px}
  .tbl td.bi{font-size:10px}
  .chart-wrap{height:140px}
  .sup-grid{display:block}
  .sup-cell,.sup-cell:last-child{display:block;width:100%;padding:0;margin-bottom:8px}
  .td-ttl{min-width:100px}
  .td-sum{display:none}
}
</style>
</head>
<body>
<div class="wrap">

<div class="hdr">
  <span class="hdr-title">📊 일일 시장 리포트</span>
  <span class="hdr-date">${data.date.replace(/-/g,'.')} 종가 기준</span>
</div>

${reportSummaryHtml ? `
<!-- 0. Summary -->
<div class="summary-box">
  <div class="s-title"><span class="s-badge">✦ AI</span> Summary</div>
  ${reportSummaryHtml}
</div>
` : ''}

<!-- 1. 국내 증시 -->
<div class="sec">
  <div class="sec-title">국내 증시</div>
  <table class="tbl">
    ${cg(140)}
    <thead><tr><th class="l">구분</th><th>종가</th><th>전일 종가</th><th>변동</th><th class="l">비고</th></tr></thead>
    <tbody>
      ${trow('KOSPI', d.kospi, N(d.kospi?.today), N(d.kospi?.prev), '', kospiNote(d.kospi))}
      ${trow('KOSDAQ', d.kosdaq, N(d.kosdaq?.today), N(d.kosdaq?.prev), '', kosdaqNote(d.kospi, d.kosdaq))}
      ${d.vkospi?.today != null
        ? trow('VKOSPI', d.vkospi, N(d.vkospi.today), N(d.vkospi.prev), '', vkospiNote(d.vkospi))
        : `<tr class="na-row"><td>VKOSPI</td><td class="c" colspan="3" style="color:#bbb">N/A</td><td class="bi">수집 실패</td></tr>`}
      ${d.volumeBn != null
        ? `<tr><td>KOSPI 거래대금</td><td class="r">${N(d.volumeBn)}조원</td><td class="r c" style="color:#bbb">―</td><td class="c" style="color:#bbb">―</td><td class="bi">${volumeNote(d.volumeBn)}</td></tr>`
        : `<tr class="na-row"><td>KOSPI 거래대금</td><td colspan="3" class="c" style="color:#bbb">N/A</td><td class="bi">수집 실패</td></tr>`}
    </tbody>
  </table>
  ${krHolidayNote}
  <div class="sup-grid">
    <div class="sup-cell">
      <div class="sup-card">
        <div class="st">📊 KOSPI 수급 — 외국인/기관/개인${isKrHoliday && prevDateStr ? ` <span style="font-size:10px;color:#888;font-weight:400">(${fmtDate(prevDateStr)} 기준)</span>` : ''}</div>
        ${supplyRow('외국인', supply.foreign)}
        ${supplyRow('기관', supply.institution)}
        ${supplyRow('개인', supply.individual)}
        ${supply.foreign == null ? '<div class="note">※ 수급 데이터 미수집</div>' : '<div class="note">※ 단위: 주(株) · 네이버 금융 기준</div>'}
      </div>
    </div>
    <div class="sup-cell">
      <div class="sup-card">
        <div class="st">💡 수급 동향</div>
        <div class="note" style="line-height:1.9">${
          supply.foreign != null
            ? `외국인 ${supply.foreign > 0 ? '<span style="color:#E24B4A">순매수</span>' : supply.foreign < 0 ? '<span style="color:#378ADD">순매도</span>' : '보합'}, 기관 ${supply.institution > 0 ? '<span style="color:#E24B4A">순매수</span>' : supply.institution < 0 ? '<span style="color:#378ADD">순매도</span>' : '보합'}`
            : '정식 리포트에서는 Gemini AI가<br>뉴스 기반 수급 동향을 분석합니다.'
        }</div>
      </div>
    </div>
  </div>
</div>

<!-- 2. KOSPI 5거래일 -->
<div class="sec">
  <div class="sec-title">KOSPI 최근 5거래일 종가 추이${isKrHoliday && prevDateStr ? ` <span style="font-size:10px;color:#888;font-weight:400;text-transform:none">(${fmtDate(prevDateStr)} 기준)</span>` : ''}</div>
  <img src="${chartUrl}" alt="KOSPI 종가 추이" style="width:100%;max-width:660px;height:auto;display:block;margin-bottom:8px;border-radius:4px" />
  <table class="tbl" style="margin-top:8px">
    <colgroup>
      <col style="width:58px"><col style="width:88px"><col style="width:155px">
      <col style="width:80px"><col>
    </colgroup>
    <thead><tr><th class="l">날짜</th><th>종가</th><th>전일비 / 변동률</th><th>거래량</th><th class="l">주요 이슈</th></tr></thead>
    <tbody>${histRows || '<tr><td colspan="5" style="text-align:center;color:#bbb;padding:12px">데이터 없음</td></tr>'}</tbody>
  </table>
  <div class="note">※ 거래량: Yahoo Finance 천주 기준(억주 환산) · 거래대금·주요이슈 KRX 미수집</div>
</div>

<!-- 3. 해외 증시 -->
<div class="sec">
  <div class="sec-title">해외 증시</div>
  <table class="tbl">
    ${cg(185)}
    <thead><tr><th class="l">구분</th><th>종가</th><th>전일 종가</th><th>변동</th><th class="l">비고</th></tr></thead>
    <tbody>
      ${trow('다우존스', o.dow, N(o.dow?.today), N(o.dow?.prev), '',
        dirNote(o.dow, '고용 호조 + 금리인하 기대', '美·이란 협상 불확실성, 차익실현'))}
      ${trow('S&amp;P 500', o.sp500, N(o.sp500?.today), N(o.sp500?.prev), '',
        dirNote(o.sp500, '기술주 반등 + 실적 개선 기대', '반도체주 차익실현, 기술주 혼조'))}
      ${trow('나스닥', o.nasdaq, N(o.nasdaq?.today), N(o.nasdaq?.prev), '',
        dirNote(o.nasdaq, 'AI 수혜주 상승 + 금리 안정 기대', 'AI 관련주 혼조, 소폭 하락'))}
      ${trow('필라델피아 반도체(SOX)', o.sox, N(o.sox?.today), N(o.sox?.prev), '',
        dirNote(o.sox, '메모리 수요 강세 + AI 반도체 기대', 'AMD·인텔 약세, 전일 급등 후 조정'))}
      ${trow('닛케이225', o.nikkei, N(o.nikkei?.today), N(o.nikkei?.prev), '',
        dirNote(o.nikkei, '엔화 약세 수혜, 수출주 강세', '엔화 강세 부담, 수출주 이익 감소'))}
      ${trow('DAX (독일)', o.dax, N(o.dax?.today), N(o.dax?.prev), '',
        dirNote(o.dax, 'ECB 금리인하 기대 + 수출 회복', '유럽 경기 둔화 우려, 제조업 위축'))}
      ${trow('항셍지수', o.hsi, N(o.hsi?.today), N(o.hsi?.prev), '',
        dirNote(o.hsi, '중국 부양책 기대 + 본토 자금 유입', '중국 소비 회복 둔화 + 부동산 리스크'))}
    </tbody>
  </table>
</div>

<!-- 4. 환율·금리 -->
<div class="sec">
  <div class="sec-title">환율 · 금리</div>
  <table class="tbl">
    ${cg(185)}
    <thead><tr><th class="l">구분</th><th>금일</th><th>전일</th><th>변동</th><th class="l">비고</th></tr></thead>
    <tbody>
      ${trow('원/달러 환율', fx.usdKrw, NI(fx.usdKrw?.today)+'원', NI(fx.usdKrw?.prev)+'원', '원',
        dirNote(fx.usdKrw, '달러 강세 + 무역수지 우려', '달러 약세 + 원화 강세 압력'))}
      ${trow('달러 인덱스 (DXY)', fx.dxy, N(fx.dxy?.today), N(fx.dxy?.prev), '',
        dirNote(fx.dxy, '연준 매파 발언 + 달러 수요', '연준 금리인하 기대 + 달러 약세'))}
      ${trow('미 국채 10년물', fx.us10y, N(fx.us10y?.today)+'%', N(fx.us10y?.prev)+'%', '%',
        dirNote(fx.us10y, '인플레 우려 지속, 채권 매도', '경기 둔화 우려, 채권 수요 증가'))}
      ${trow('미 국채 2년물', fx.us2y, N(fx.us2y?.today)+'%', N(fx.us2y?.prev)+'%', '%',
        dirNote(fx.us2y, '단기 금리 상승, 연준 동결 반영', '금리인하 기대, 단기 채권 강세', '연준 동결 기대, 단기금리 안정'))}
      <tr>
        <td>6월 FOMC 동결확률</td>
        <td class="r">${fx.fomc?.junHoldPct ?? 'N/A'}%</td><td class="r">―</td>
        <td class="c" style="color:#888">―</td>
        <td class="bi">${(() => {
          const h = fx.fomc?.junHoldPct;
          const r = v => Math.round(v * 10) / 10;
          if (h == null) return 'CME FedWatch';
          if (h >= 80) return `동결 유력 · 인하확률 ${r(100-h)}%`;
          if (h >= 50) return `동결 우세 · 인하확률 ${r(100-h)}%`;
          if (h >= 20) return `인하 우세 · 동결확률 ${r(h)}%`;
          return `인하 유력 · 동결확률 ${r(h)}%`;
        })()}</td>
      </tr>
      <tr>
        <td>9월 인하 가능성</td>
        <td class="r">${fx.fomc?.sepCutPct ?? 'N/A'}%</td><td class="r">―</td>
        <td class="c" style="color:#888">―</td>
        <td class="bi">${(() => {
          const s = fx.fomc?.sepCutPct;
          if (s == null) return 'CME FedWatch';
          if (s >= 80) return '9월 인하 유력 · 시장 기정사실화';
          if (s >= 50) return '9월 인하 우세 · 시장 기대 반영';
          if (s >= 20) return '9월 동결 우세 · 인하 가능성 열려';
          return '9월 동결 유력 · 추가 인하 기대 낮음';
        })()}</td>
      </tr>
    </tbody>
  </table>
</div>

<!-- 5. 원자재 -->
<div class="sec">
  <div class="sec-title">원자재 · 비철금속</div>
  <table class="tbl">
    ${cg(195)}
    <thead><tr><th class="l">구분</th><th>금일 시세</th><th>전일 시세</th><th>변동</th><th class="l">비고</th></tr></thead>
    <tbody>
      ${trow('🥇 금 (선물, oz)', c.gold, '$'+N(c.gold?.today), '$'+N(c.gold?.prev), '',
        dirNote(c.gold, '지정학 리스크 + 달러 약세', '차익실현 + 달러 강세'))}
      ${trow('🥇 금 (국내 1돈)', c.goldKrw, NI(c.goldKrw?.today)+'원', NI(c.goldKrw?.prev)+'원', '원', goldKrwNote())}
      ${trow('⚪ 은 (Micro, oz)', c.silver, '$'+N(c.silver?.today), '$'+N(c.silver?.prev), '',
        dirNote(c.silver, '금 상승 연동 + 산업 수요 증가', '금 하락 연동 + 수요 감소'))}
      ${trow('⚪ 백금 (oz)', c.platinum, '$'+N(c.platinum?.today), '$'+N(c.platinum?.prev), '',
        dirNote(c.platinum, '자동차·수소 산업 수요 회복', '수요 둔화 우려'))}
      ${trow('🛢️ WTI 원유 (bbl)', c.wti, '$'+N(c.wti?.today), '$'+N(c.wti?.prev), '',
        dirNote(c.wti, '美·이란 교착 + OPEC 감산 기대', '美·이란 진전 + 공급 증가 우려'))}
      ${trow('🔴 구리 (COMEX, lb)', c.copper, '$'+N(c.copper?.today), '$'+N(c.copper?.prev), '',
        dirNote(c.copper, '관세 완화 기대 + 제조업 회복', '관세 리스크 + 중국 수요 부진'))}
      ${trow('🟩 알루미늄 (선물)', c.aluminum, '$'+N(c.aluminum?.today), '$'+N(c.aluminum?.prev), '',
        dirNote(c.aluminum, '중국 인프라 수요 + 공급 감소', '수요 우려 + 재고 증가'))}
      ${trow('🟣 아연 (선물)', c.zinc, '$'+N(c.zinc?.today), '$'+N(c.zinc?.prev), '',
        dirNote(c.zinc, '제련소 감산 + 수요 회복', '수요 둔화 + 재고 증가', '수급 균형'))}
    </tbody>
  </table>
  <div class="note">※ Yahoo Finance 선물 종가 기준 · LME 공식가와 단위 상이할 수 있음</div>
</div>

<!-- 6. 뉴스 -->
<div class="sec">
  <div class="sec-title">주요 뉴스</div>
  <table class="ntbl">
    <colgroup>
      <col style="width:46px"><col style="width:54px"><col style="width:38%"><col>
    </colgroup>
    <thead><tr><th class="l">일자</th><th>구분</th><th class="l">제목 / 출처</th><th class="l">내용</th></tr></thead>
    <tbody>${newsRows}</tbody>
  </table>
</div>

<div class="divider"></div>
<div class="note" style="line-height:1.9">
  📌 출처: Yahoo Finance · 네이버금융 · Naver API${summaryMap.size > 0 ? ' · Gemini AI' : ''}<br>
  ⚠️ 본 리포트는 정보 제공 목적이며 투자 권유가 아닙니다.
</div>

</div>
</body>
</html>`;

// ── HTML 파일 저장 ───────────────────────────────────────────────────────────
await fs.writeFile(`./outputs/${todayStr}/report.html`, html, 'utf-8');

// ── 중복 발송 방지 (로컬: sent.flag / GA: Notion DB 조회) ───────────────────
const sentFlagPath = `./outputs/${todayStr}/sent.flag`;
const localSent   = await fs.access(sentFlagPath).then(() => true).catch(() => false);
if (localSent) {
  console.log(`⏭  ${todayStr} 리포트는 이미 발송됨 (로컬 플래그) — 건너뜀`);
  process.exit(0);
}
// GitHub Actions 환경에서는 Notion DB로 중복 체크
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

// 발송 완료 플래그 기록 (재실행 시 중복 방지)
await fs.writeFile(sentFlagPath, new Date().toISOString(), 'utf-8');
console.log(`✅ 리포트 발송 완료 → ${process.env.GMAIL_RECIPIENT}`);

// ── Notion 아카이빙 ───────────────────────────────────────────────────────────
try {
  const { publishToNotion } = await import('./publishers/notion.js');
  await publishToNotion(todayStr, '', html, data);
} catch (e) {
  console.warn('[report] Notion 아카이빙 실패:', e.message);
}
