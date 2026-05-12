// tools/desk/designer.js — DESK HTML 빌더
// 편집 플랜 + 파이프라인 데이터 → 최종 HTML 리포트 조립.
// 기존 preview_send.js의 HTML 생성 로직과 동일한 포맷을 유지한다.
import axios from 'axios';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { logger } from '../utils/logger.js';

const r2  = v => Math.round(v * 100) / 100;
const N   = (v, dec=2) => v == null ? 'N/A' : Number(v).toLocaleString('ko-KR', { minimumFractionDigits: dec, maximumFractionDigits: dec });
const NI  = v => v == null ? 'N/A' : Math.round(v).toLocaleString('ko-KR');
const arr = v => v == null ? '―' : v > 0 ? '▲' : v < 0 ? '▼' : '―';
const sgn = v => v == null ? '' : v > 0 ? '+' : '';
const dir = v => v == null ? 'neu' : v > 0 ? 'up' : v < 0 ? 'dn' : 'neu';
const COLOR = { up: '#E24B4A', dn: '#378ADD', neu: '#888888' };

/**
 * 최종 HTML 리포트 생성.
 * @param {object} pipelineData  Layer 1 데이터
 * @param {object} tfResults     Layer 2 TF팀 결과
 * @param {object} editorialPlan Layer 3 DESK 편집 플랜
 * @returns {Promise<string>}    HTML 문자열
 */
export async function buildHtml(pipelineData, tfResults, editorialPlan) {
  const { date, domestic, overseas, fxRates, commodities, news } = pipelineData;
  const d      = domestic ?? {};
  const o      = overseas ?? {};
  const fx     = fxRates  ?? {};
  const c      = commodities ?? {};
  const isKrH  = d.isHoliday ?? false;

  // KOSPI 히스토리 폴백 (Yahoo Finance 직접 수집)
  let histAll  = d.kospiHistory ?? [];
  let histDisp = histAll.length >= 2 ? histAll.slice(-5) : histAll;
  if (histAll.length < 6) {
    histAll  = await _fetchKospiHistory(date) || histAll;
    histDisp = histAll.length >= 2 ? histAll.slice(-5) : histAll;
  }

  // VKOSPI 폴백
  if (d.vkospi?.today == null) {
    const live = await _naverIdxLive('VKOSPI');
    if (live?.today != null) d.vkospi = live;
  }

  // Gemini 뉴스 요약 (TF-1 결과 없을 때 fallback)
  const summaryMap = await _buildSummaryMap(news ?? [], pipelineData);

  // QuickChart 차트
  const chartUrl = _buildChartUrl(histDisp);

  // AI Summary 섹션 (편집 플랜의 summary_bullets 우선)
  const summaryHtml = _buildSummarySection(editorialPlan, pipelineData, tfResults);

  // 코인 섹션 (TF-3 결과)
  const cryptoSection = editorialPlan.include_crypto
    ? _buildCryptoSection(tfResults.crypto, pipelineData.crypto)
    : '';

  // 애널리스트 섹션 (TF-2 결과)
  const analystSection = editorialPlan.include_analyst
    ? _buildAnalystSection(tfResults.analyst)
    : '';

  const html = _assembleHtml({
    date, d, o, fx, c, news: news ?? [],
    histDisp, histAll, chartUrl,
    summaryHtml, cryptoSection, analystSection,
    summaryMap, isKrH,
    headline: editorialPlan.headline,
  });

  logger.info(`[desk/designer] HTML 생성 완료 (${Math.round(html.length / 1024)}KB)`);
  return html;
}

// ── 섹션 빌더 ────────────────────────────────────────────────────────────────

function _buildSummarySection(plan, pipelineData, tfResults) {
  const bullets = plan.summary_bullets?.length
    ? plan.summary_bullets
    : (tfResults.news?.top_stories ?? []).map(s => `• ${s}`);

  if (!bullets.length) return '';
  return bullets
    .map(l => `<p style="margin:4px 0;font-size:13px;color:#1a1a1a;line-height:1.7">${l.replace(/^[•·\-]\s*/,'• ')}</p>`)
    .join('');
}

function _buildCryptoSection(tfCrypto, rawCrypto) {
  if (!rawCrypto?.btc) return '';
  const { btc, eth, fearGreed, btcDominance, top10 } = rawCrypto;
  const fgColor = fearGreed?.value >= 60 ? COLOR.up : fearGreed?.value <= 30 ? COLOR.dn : COLOR.neu;
  const rows = (top10 ?? []).slice(0,5).map(c => `
    <tr>
      <td>${c.rank}</td>
      <td style="font-weight:500">${c.symbol}</td>
      <td class="r">$${N(c.priceUsd)}</td>
      <td class="c" style="color:${c.change24h >= 0 ? COLOR.up : COLOR.dn}">
        ${arr(c.change24h)} ${sgn(c.change24h)}${N(Math.abs(c.change24h))}%
      </td>
    </tr>`).join('');

  return `
<div class="sec">
  <div class="sec-title">블록체인 · 코인</div>
  <table class="tbl">
    <colgroup><col style="width:40px"><col style="width:80px"><col style="width:110px"><col></colgroup>
    <thead><tr><th>#</th><th>심볼</th><th>시세(USD)</th><th>24h 변동</th></tr></thead>
    <tbody>
      <tr>
        <td>—</td><td style="font-weight:600">BTC</td>
        <td class="r">$${N(btc?.price)}</td>
        <td class="c" style="color:${btc?.change24h >= 0 ? COLOR.up : COLOR.dn}">
          ${arr(btc?.change24h)} ${sgn(btc?.change24h)}${N(Math.abs(btc?.change24h ?? 0))}%
        </td>
      </tr>
      ${eth ? `<tr>
        <td>—</td><td style="font-weight:600">ETH</td>
        <td class="r">$${N(eth?.price)}</td>
        <td class="c" style="color:${eth?.change24h >= 0 ? COLOR.up : COLOR.dn}">
          ${arr(eth?.change24h)} ${sgn(eth?.change24h)}${N(Math.abs(eth?.change24h ?? 0))}%
        </td>
      </tr>` : ''}
      ${rows}
    </tbody>
  </table>
  <div style="margin-top:8px;display:flex;gap:16px;font-size:12px">
    ${fearGreed ? `<span>😱 Fear &amp; Greed: <b style="color:${fgColor}">${fearGreed.value} (${fearGreed.label})</b></span>` : ''}
    ${btcDominance ? `<span>BTC 도미넌스: <b>${btcDominance}%</b></span>` : ''}
  </div>
  ${tfCrypto?.market_summary ? `<div class="note" style="margin-top:6px">💡 ${tfCrypto.market_summary}</div>` : ''}
</div>`;
}

function _buildAnalystSection(tfAnalyst) {
  if (!tfAnalyst?.findings?.length) return '';
  const rows = tfAnalyst.findings.slice(0,5).map(f => `
    <tr ${f.importance >= 8 ? 'style="background:#fff8f0"' : ''}>
      <td style="font-weight:500">${f.company ?? '―'}</td>
      <td>${f.firm ?? '―'}</td>
      <td class="c">${f.rating_change ?? '―'}</td>
      <td class="r">${f.target_price?.new ? NI(f.target_price.new) + '원' : '―'}</td>
      <td class="bi">${f.key_thesis ?? '―'}</td>
    </tr>`).join('');

  return `
<div class="sec">
  <div class="sec-title">애널리스트 리포트</div>
  <table class="tbl">
    <colgroup><col style="width:100px"><col style="width:80px"><col style="width:90px"><col style="width:90px"><col></colgroup>
    <thead><tr><th class="l">종목</th><th class="l">증권사</th><th>의견 변화</th><th>목표주가</th><th class="l">핵심 논거</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</div>`;
}

// ── 최종 HTML 조립 ────────────────────────────────────────────────────────────

function _assembleHtml({ date, d, o, fx, c, news, histDisp, chartUrl,
  summaryHtml, cryptoSection, analystSection, summaryMap, isKrH, headline }) {

  const supply = d.supply ?? {};
  const newsRows = (news ?? []).map(n => {
    const sumText = summaryMap.get(n.url);
    const body = sumText
      ? sumText.split('\n').filter(l=>l.trim()).map(l=>`· ${l.replace(/^[•·]\s*/,'')}`).join('<br>')
      : (n.body ?? '').split(/(?<=[.…])\s+/).slice(0,2).map(s=>`· ${s}`).join('<br>');
    const tagCls = { '시장전반':'t-mkt','산업·기업':'t-corp','거시경제':'t-mac' }[n.category] ?? 't-mkt';
    return `<tr>
      <td class="td-date">${(n.date?.slice(5)||'').replace('-','/')}</td>
      <td class="td-cat"><span class="tag ${tagCls}">${n.category}</span></td>
      <td class="td-ttl"><a href="${n.url}" target="_blank">${n.title}</a><div class="td-src">📰 ${n.source}</div></td>
      <td class="td-sum">${body}</td>
    </tr>`;
  }).join('');

  const histRows = histDisp.map((h,i) => {
    const prev = i===0 ? (histAll?.[histAll.length-histDisp.length-1] ?? null) : histDisp[i-1];
    const diff = prev?.close != null ? r2(h.close - prev.close) : null;
    const dp   = prev?.close ? r2(diff/prev.close*100) : null;
    const cls  = dir(diff);
    const chgStr = diff!=null
      ? `<span style="color:${COLOR[cls]};font-weight:500">${arr(diff)} ${sgn(diff)}${N(Math.abs(diff))} (${sgn(dp)}${N(dp)}%)</span>`
      : '<span style="color:#888">―</span>';
    const rawVol = h.volume;
    const volStr = rawVol && rawVol > 1000 ? `${(rawVol/1e5).toFixed(1)}억주` : '―';
    return `<tr><td>${h.date}</td><td class="r">${N(h.close)}</td><td class="c">${chgStr}</td><td class="r">${volStr}</td></tr>`;
  }).join('');

  // (trow 헬퍼 — 간략 버전)
  const trow = (lbl, obj, todayStr, prevStr, note='') => `<tr>
    <td>${lbl}</td><td class="r">${todayStr}</td><td class="r">${prevStr}</td>
    <td class="c">${obj?.diff != null
      ? `<span style="color:${COLOR[dir(obj.diff)]};font-weight:500;white-space:nowrap">${arr(obj.diff)} ${sgn(obj.diff)}${N(Math.abs(obj.diff))} (${sgn(obj.pct)}${N(obj.pct)}%)</span>`
      : '<span style="color:#888">―</span>'}</td>
    <td class="bi">${note || '―'}</td>
  </tr>`;

  return `<!DOCTYPE html>
<html lang="ko"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>시장 리포트 ${date}</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-size:14px;background:#f5f5f5;padding:16px;color:#1a1a1a;font-family:'Inter',-apple-system,sans-serif}
.wrap{max-width:720px;margin:0 auto}
.hdr{margin-bottom:1.5rem;padding-bottom:12px;border-bottom:1px solid #e0e0e0}
.hdr-title{font-size:20px;font-weight:600;display:block}
.hdr-date{font-size:12px;color:#666;margin-top:3px;display:block}
.hdr-headline{font-size:13px;color:#2563eb;margin-top:6px;font-weight:500;display:block}
.sec{margin:0 0 1.8rem}
.sec-title{font-size:11px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:#666;border-bottom:1px solid #e0e0e0;padding-bottom:5px;margin-bottom:10px}
.tbl{width:100%;border-collapse:collapse;table-layout:fixed}
.tbl th{font-size:11px;font-weight:600;color:#555;background:#f8f8f8;padding:6px;border-bottom:1px solid #e0e0e0;text-align:center}
.tbl th.l{text-align:left}
.tbl td{font-size:12px;padding:7px 6px;border-bottom:1px solid #ebebeb;vertical-align:middle;line-height:1.5}
.tbl td.r{text-align:right;white-space:nowrap}
.tbl td.c{text-align:center}
.tbl td.bi{font-size:11px;color:#555;line-height:1.55}
.tbl tr:last-child td{border-bottom:none}
.summary-box{background:#f8faff;border:1px solid #dbe8ff;border-radius:8px;padding:14px 18px;margin-bottom:1.8rem}
.summary-box .s-title{font-size:11px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:#2563eb;margin-bottom:10px}
.s-badge{display:inline-block;font-size:10px;font-weight:700;background:#2563eb;color:#fff;padding:2px 7px;border-radius:10px}
.ntbl{width:100%;border-collapse:collapse;table-layout:fixed}
.ntbl th{font-size:11px;font-weight:600;color:#555;background:#f8f8f8;padding:6px;border-bottom:1px solid #e0e0e0;text-align:center}
.ntbl th.l{text-align:left}
.ntbl td{font-size:12px;padding:8px 6px;border-bottom:1px solid #ebebeb;vertical-align:top}
.ntbl tr:last-child td{border-bottom:none}
.td-date{white-space:nowrap;font-size:11px;color:#666;width:46px}
.td-cat{white-space:nowrap;width:54px;text-align:center}
.td-ttl a{color:#2563eb;text-decoration:none;font-size:12px;line-height:1.4;display:block}
.td-src{font-size:10px;color:#888;margin-top:2px}
.td-sum{font-size:11px;color:#555;line-height:1.65}
.tag{display:inline-block;font-size:10px;font-weight:600;padding:2px 5px;border-radius:3px}
.t-mkt{background:#eff6ff;color:#2563eb}.t-corp{background:#f0fdf4;color:#16a34a}.t-mac{background:#fffbeb;color:#d97706}
.note{font-size:11px;color:#999;margin-top:5px;line-height:1.7}
.divider{height:1px;background:#ebebeb;margin:1.5rem 0}
@media screen and (max-width:600px){body{padding:10px}.tbl,.ntbl{table-layout:auto}.td-sum{display:none}}
</style>
</head>
<body><div class="wrap">

<div class="hdr">
  <span class="hdr-title">📊 일일 시장 리포트</span>
  <span class="hdr-date">${date.replace(/-/g,'.')} 종가 기준</span>
  ${headline ? `<span class="hdr-headline">📌 ${headline}</span>` : ''}
</div>

${summaryHtml ? `<div class="summary-box"><div class="s-title"><span class="s-badge">✦ AI</span> Summary</div>${summaryHtml}</div>` : ''}

<div class="sec">
  <div class="sec-title">국내 증시</div>
  <table class="tbl">
    <colgroup><col style="width:140px"><col style="width:88px"><col style="width:88px"><col style="width:155px"><col></colgroup>
    <thead><tr><th class="l">구분</th><th>종가</th><th>전일</th><th>변동</th><th class="l">비고</th></tr></thead>
    <tbody>
      ${trow('KOSPI',         d.kospi,   N(d.kospi?.today),   N(d.kospi?.prev))}
      ${trow('KOSDAQ',        d.kosdaq,  N(d.kosdaq?.today),  N(d.kosdaq?.prev))}
      ${d.vkospi?.today != null ? trow('VKOSPI', d.vkospi, N(d.vkospi.today), N(d.vkospi.prev)) : ''}
      ${d.volumeBn != null ? `<tr><td>거래대금</td><td class="r">${N(d.volumeBn)}조원</td><td class="r c" style="color:#bbb">―</td><td class="c" style="color:#bbb">―</td><td class="bi">일중 누적</td></tr>` : ''}
    </tbody>
  </table>
</div>

<div class="sec">
  <div class="sec-title">KOSPI 최근 5거래일</div>
  <img src="${chartUrl}" alt="KOSPI" style="width:100%;max-width:660px;height:auto;display:block;margin-bottom:8px;border-radius:4px"/>
  <table class="tbl" style="margin-top:8px">
    <colgroup><col style="width:58px"><col style="width:88px"><col style="width:155px"><col style="width:80px"></colgroup>
    <thead><tr><th class="l">날짜</th><th>종가</th><th>전일비</th><th>거래량</th></tr></thead>
    <tbody>${histRows || '<tr><td colspan="4" style="text-align:center;color:#bbb;padding:12px">데이터 없음</td></tr>'}</tbody>
  </table>
</div>

<div class="sec">
  <div class="sec-title">해외 증시</div>
  <table class="tbl">
    <colgroup><col style="width:185px"><col style="width:88px"><col style="width:88px"><col style="width:155px"><col></colgroup>
    <thead><tr><th class="l">구분</th><th>종가</th><th>전일</th><th>변동</th><th class="l">비고</th></tr></thead>
    <tbody>
      ${trow('다우존스',              o.dow,    N(o.dow?.today),    N(o.dow?.prev))}
      ${trow('S&amp;P 500',           o.sp500,  N(o.sp500?.today),  N(o.sp500?.prev))}
      ${trow('나스닥',                o.nasdaq, N(o.nasdaq?.today), N(o.nasdaq?.prev))}
      ${trow('필라델피아 반도체(SOX)',o.sox,    N(o.sox?.today),    N(o.sox?.prev))}
      ${trow('닛케이225',             o.nikkei, N(o.nikkei?.today), N(o.nikkei?.prev))}
      ${trow('항셍지수',              o.hsi,    N(o.hsi?.today),    N(o.hsi?.prev))}
    </tbody>
  </table>
</div>

<div class="sec">
  <div class="sec-title">환율 · 금리</div>
  <table class="tbl">
    <colgroup><col style="width:185px"><col style="width:88px"><col style="width:88px"><col style="width:155px"><col></colgroup>
    <thead><tr><th class="l">구분</th><th>금일</th><th>전일</th><th>변동</th><th class="l">비고</th></tr></thead>
    <tbody>
      ${trow('원/달러',       fx.usdKrw, NI(fx.usdKrw?.today)+'원', NI(fx.usdKrw?.prev)+'원')}
      ${trow('달러 인덱스',   fx.dxy,    N(fx.dxy?.today),           N(fx.dxy?.prev))}
      ${trow('미 국채 10년물',fx.us10y,  N(fx.us10y?.today)+'%',     N(fx.us10y?.prev)+'%')}
      <tr><td>6월 FOMC 동결</td><td class="r">${fx.fomc?.junHoldPct ?? 'N/A'}%</td><td class="r">―</td><td class="c" style="color:#888">―</td><td class="bi">CME FedWatch</td></tr>
      <tr><td>9월 인하 확률</td><td class="r">${fx.fomc?.sepCutPct ?? 'N/A'}%</td><td class="r">―</td><td class="c" style="color:#888">―</td><td class="bi">CME FedWatch</td></tr>
    </tbody>
  </table>
</div>

<div class="sec">
  <div class="sec-title">원자재 · 비철금속</div>
  <table class="tbl">
    <colgroup><col style="width:195px"><col style="width:88px"><col style="width:88px"><col style="width:155px"><col></colgroup>
    <thead><tr><th class="l">구분</th><th>금일</th><th>전일</th><th>변동</th><th class="l">비고</th></tr></thead>
    <tbody>
      ${trow('🥇 금 (선물, oz)',       c.gold,     '$'+N(c.gold?.today),     '$'+N(c.gold?.prev))}
      ${trow('🥇 금 (국내 1돈)',       c.goldKrw,  NI(c.goldKrw?.today)+'원',NI(c.goldKrw?.prev)+'원')}
      ${trow('🛢️ WTI 원유 (bbl)',      c.wti,      '$'+N(c.wti?.today),      '$'+N(c.wti?.prev))}
      ${trow('🔴 구리 (COMEX, lb)',    c.copper,   '$'+N(c.copper?.today),   '$'+N(c.copper?.prev))}
    </tbody>
  </table>
</div>

${cryptoSection}
${analystSection}

<div class="sec">
  <div class="sec-title">주요 뉴스</div>
  <table class="ntbl">
    <colgroup><col style="width:46px"><col style="width:54px"><col style="width:38%"><col></colgroup>
    <thead><tr><th class="l">일자</th><th>구분</th><th class="l">제목 / 출처</th><th class="l">내용</th></tr></thead>
    <tbody>${newsRows}</tbody>
  </table>
</div>

<div class="divider"></div>
<div class="note" style="line-height:1.9">
  📌 출처: Yahoo Finance · 네이버금융 · CoinGecko · DART<br>
  ⚠️ 본 리포트는 정보 제공 목적이며 투자 권유가 아닙니다.
</div>
</div></body></html>`;
}

// ── 내부 헬퍼 ────────────────────────────────────────────────────────────────

async function _buildSummaryMap(news, pipelineData) {
  const map = new Map();
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey || !news.length) return map;
  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: process.env.GEMINI_MODEL ?? 'gemini-2.5-flash' });
    const res = await model.generateContent(`
다음 뉴스 기사를 각각 한국어 불릿 2~3개로 요약하세요.
반드시 JSON 배열만 응답: [{"url":"...","summary":"• 핵심1\\n• 핵심2"},...]

${JSON.stringify(news.slice(0,12).map(n => ({ url: n.url, title: n.title, body: n.body?.slice(0,300) })), null, 2)}`);
    const raw = res.response.text().replace(/^```json\s*/,'').replace(/```\s*$/,'').trim();
    JSON.parse(raw).forEach(item => { if (item.url && item.summary) map.set(item.url, item.summary); });
  } catch {}
  return map;
}

async function _naverIdxLive(symbol) {
  try {
    const res = await axios.get(`https://m.stock.naver.com/api/index/${symbol}/basic`, {
      headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 8000,
    });
    const p = s => parseFloat(String(s ?? '').replace(/,/g, '')) || null;
    const today = p(res.data.closePrice);
    const delta = p(res.data.compareToPreviousClosePrice);
    const prev  = (today != null && delta != null) ? r2(today - delta) : null;
    return { today, prev, diff: delta, pct: prev ? r2((today-prev)/prev*100) : 0 };
  } catch { return null; }
}

async function _fetchKospiHistory(refDate) {
  try {
    const res = await axios.get('https://query1.finance.yahoo.com/v8/finance/chart/%5EKS11', {
      params: { interval: '1d', range: '30d' },
      headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 12000,
    });
    const yfRes = res.data.chart.result[0];
    const yfCl  = yfRes.indicators.quote[0].close;
    const toMD  = ts => {
      const dt = new Date(ts * 1000);
      return `${String(dt.getMonth()+1).padStart(2,'0')}/${String(dt.getDate()).padStart(2,'0')}`;
    };
    return yfRes.timestamp
      .map((ts, i) => ({ ts, close: yfCl[i] }))
      .filter(x => x.close != null)
      .slice(-6)
      .map(x => ({ date: toMD(x.ts), close: r2(x.close) }));
  } catch { return null; }
}

function _buildChartUrl(histDisp) {
  const allPrices = histDisp.map(h => h.close).filter(Boolean);
  const yMin = allPrices.length ? Math.floor(Math.min(...allPrices)*0.98/100)*100 : 6000;
  const yMax = allPrices.length ? Math.ceil(Math.max(...allPrices)*1.02/100)*100  : 8000;
  const cfg = {
    type: 'bar',
    data: {
      labels: histDisp.map(h => h.date),
      datasets: [{
        type: 'line', label: 'KOSPI 종가',
        data: histDisp.map(h => h.close),
        borderColor: '#E24B4A', backgroundColor: 'rgba(226,75,74,0.08)',
        borderWidth: 2, pointBackgroundColor: '#E24B4A', pointRadius: 5,
        fill: true, yAxisID: 'A',
      }],
    },
    options: {
      legend: { display: false },
      scales: { xAxes: [{ ticks: { fontSize: 10 } }], yAxes: [{ id:'A', position:'left', ticks:{ min:yMin, max:yMax, fontSize:10 } }] },
    },
  };
  return 'https://quickchart.io/chart?w=660&h=200&backgroundColor=white&c=' + encodeURIComponent(JSON.stringify(cfg));
}

// histAll은 buildHtml 스코프에서 접근 가능하도록 모듈 레벨에 선언
let histAll = [];
