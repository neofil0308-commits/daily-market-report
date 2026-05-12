// tools/desk/designer.js — DESK HTML 빌더 v2
// 레퍼런스: templates/market_report_reference 기반 완전 재설계
import axios from 'axios';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { logger } from '../utils/logger.js';

const r2  = v => Math.round(v * 100) / 100;
const N   = (v, dec = 2) => v == null ? 'N/A' : Number(v).toLocaleString('ko-KR', { minimumFractionDigits: dec, maximumFractionDigits: dec });
const NI  = v => v == null ? 'N/A' : Math.round(v).toLocaleString('ko-KR');
const arr = v => v == null ? '―' : v > 0 ? '▲' : v < 0 ? '▼' : '―';
const sgn = v => v == null ? '' : v > 0 ? '+' : '';
const dir = v => v == null ? 'neu' : v > 0 ? 'up' : v < 0 ? 'dn' : 'neu';
const COLOR = { up: '#E24B4A', dn: '#378ADD', neu: '#888888' };

function autoLabel(pct) {
  if (pct == null) return '';
  if (pct >= 3)           return '급등';
  if (pct >= 1)           return '상승';
  if (pct >= 0.1)         return '소폭 상승';
  if (Math.abs(pct) < 0.1) return '보합';
  if (pct > -1)           return '소폭 하락';
  if (pct > -3)           return '하락';
  return '급락';
}

// 변동 셀 — .chg 패턴 (레퍼런스 스타일)
const chgCell = (obj) => {
  const d = obj?.diff;
  const p = obj?.pct;
  if (d == null) return '<span class="neu">―</span>';
  const label = autoLabel(p);
  return `<div class="chg">
    <span class="chg-val ${dir(d)}">${arr(d)} ${sgn(d)}${N(Math.abs(d))} (${sgn(p)}${N(p)}%)</span>
    <span class="chg-lbl">(${label})</span>
  </div>`;
};

// 표 행 헬퍼
const trow = (lbl, obj, todayStr, prevStr, note = '') => `<tr>
  <td>${lbl}</td><td class="r">${todayStr}</td><td class="r">${prevStr}</td>
  <td class="r">${chgCell(obj)}</td>
  <td class="bi">${note || '―'}</td>
</tr>`;

// ── 날짜 헬퍼 ────────────────────────────────────────────────────────────────
const KO_DAYS = ['일', '월', '화', '수', '목', '금', '토'];

function _prevTradingDate(d) {
  // Date 객체(KST 기준)에서 1일씩 뒤로 이동해 평일을 찾음
  const r = new Date(d);
  r.setDate(r.getDate() - 1);
  while ([0, 6].includes(r.getDay())) r.setDate(r.getDate() - 1);
  return r;
}

function _dataDateInfo(reportDate, histDisp) {
  // 실제 거래일은 histDisp 마지막 항목의 dateISO 우선 사용
  const lastISO = histDisp?.[histDisp.length - 1]?.dateISO;
  let datObj;
  if (lastISO) {
    datObj = new Date(lastISO + 'T00:00:00+09:00');
  } else {
    datObj = new Date(reportDate + 'T00:00:00+09:00');
    datObj.setDate(datObj.getDate() - 1);
    while ([0, 6].includes(datObj.getDay())) datObj.setDate(datObj.getDate() - 1);
  }
  const pad = n => String(n).padStart(2, '0');
  const mm  = pad(datObj.getMonth() + 1);
  const dd  = pad(datObj.getDate());
  const prevObj = _prevTradingDate(datObj);
  const pmm = pad(prevObj.getMonth() + 1);
  const pdd = pad(prevObj.getDate());
  return {
    full:    `${datObj.getFullYear()}.${mm}.${dd} (${KO_DAYS[datObj.getDay()]})`,
    md:      `${mm}/${dd}`,
    prevMd:  `${pmm}/${pdd}`,
  };
}

export async function buildHtml(pipelineData, tfResults, editorialPlan) {
  const { date, domestic, overseas, fxRates, commodities, news } = pipelineData;
  const d     = domestic    ?? {};
  const o     = overseas    ?? {};
  const fx    = fxRates     ?? {};
  const c     = commodities ?? {};

  // KOSPI 히스토리 폴백 (Yahoo Finance 직접)
  let histAll = d.kospiHistory ?? [];
  if (histAll.length < 6) {
    histAll = await _fetchKospiHistory(date) || histAll;
  }
  const histDisp = histAll.slice(-5);

  // VKOSPI 폴백
  if (d.vkospi?.today == null) {
    const live = await _naverIdxLive('VKOSPI');
    if (live?.today != null) d.vkospi = live;
  }

  const summaryMap    = await _buildSummaryMap(news ?? [], pipelineData);
  const chartUrl      = _buildChartUrl(histDisp);     // 이메일 폴백용 quickchart
  const chartScript   = _buildChartScript(histDisp);  // Chart.js 인라인 스크립트

  const summaryHtml    = _buildSummarySection(editorialPlan, pipelineData, tfResults);
  const cryptoSection  = editorialPlan.include_crypto
    ? _buildCryptoSection(tfResults.crypto, pipelineData.crypto) : '';
  const analystSection = editorialPlan.include_analyst
    ? _buildAnalystSection(tfResults.analyst) : '';

  const html = _assembleHtml({
    date, d, o, fx, c, news: news ?? [],
    histDisp, histAll, chartUrl, chartScript,
    summaryHtml, cryptoSection, analystSection,
    summaryMap,
    headline: editorialPlan.headline,
  });

  logger.info(`[desk/designer] HTML 생성 완료 (${Math.round(html.length / 1024)}KB)`);
  return html;
}

// ── 수급 바 + 시장 강도 섹션 ──────────────────────────────────────────────────

function _supplyBar(name, val, maxAbs) {
  if (val == null) return '';
  const pct    = Math.round(Math.abs(val) / (maxAbs || 1) * 100);
  const isBuy  = val >= 0;
  const cls    = isBuy ? 'b-buy' : 'b-sell';
  const vcls   = isBuy ? 'up' : 'dn';
  const prefix = isBuy ? '+' : '';
  const fmtAmt = (v) => {
    const abs = Math.abs(v);
    if (abs >= 1e12) return `${prefix}${(v / 1e12).toFixed(2)}조원`;
    if (abs >= 1e8)  return `${prefix}${Math.round(v / 1e8).toLocaleString('ko-KR')}억원`;
    return `${prefix}${NI(v)}`;
  };
  return `<div class="bar-row">
    <span class="nm">${name}</span>
    <div class="bwrap"><div class="bfill ${cls}" style="width:${pct}%"></div></div>
    <span class="val ${vcls}">${fmtAmt(val)}</span>
  </div>`;
}

function _buildMarketCards(supply, breadth, date) {
  const hasSupply  = supply?.foreign != null || supply?.institution != null || supply?.individual != null;
  const hasBreadth = breadth?.advancing != null || breadth?.intraHigh != null;
  if (!hasSupply && !hasBreadth) return '';

  const supplyCard = hasSupply ? (() => {
    const { foreign, institution, individual } = supply;
    const maxAbs = Math.max(Math.abs(foreign ?? 0), Math.abs(institution ?? 0), Math.abs(individual ?? 0), 1);
    return `<div class="sup-card">
      <div class="st">📊 KOSPI 수급 (${date?.slice(5)?.replace('-', '/')})</div>
      ${_supplyBar('외국인', foreign, maxAbs)}
      ${_supplyBar('기관', institution, maxAbs)}
      ${_supplyBar('개인', individual, maxAbs)}
    </div>`;
  })() : '';

  const breadthCard = hasBreadth ? (() => {
    const { advancing, declining, unchanged, intraHigh, intraLow } = breadth ?? {};
    const total = (advancing ?? 0) + (declining ?? 0) + (unchanged ?? 0);
    const advPct = total > 0 ? Math.round((advancing ?? 0) / total * 100) : null;
    const bars = total > 0 ? `
      <div class="bar-row">
        <span class="nm">상승</span>
        <div class="bwrap"><div class="bfill b-buy" style="width:${advPct}%"></div></div>
        <span class="val up">${(advancing ?? '—').toLocaleString?.() ?? advancing}</span>
      </div>
      <div class="bar-row">
        <span class="nm">하락</span>
        <div class="bwrap"><div class="bfill b-sell" style="width:${100 - advPct}%"></div></div>
        <span class="val dn">${(declining ?? '—').toLocaleString?.() ?? declining}</span>
      </div>` : '';
    const hlStr = (intraHigh != null && intraLow != null)
      ? `<div style="font-size:11px;color:var(--color-text-secondary);margin-top:6px">장중 ${N(intraHigh)} ↕ ${N(intraLow)}</div>`
      : '';
    return `<div class="sup-card">
      <div class="st">📈 시장 강도 (상승/하락 종목)</div>
      ${bars}
      ${hlStr}
    </div>`;
  })() : '';

  if (!supplyCard && !breadthCard) return '';
  return `<div class="sup-grid">${supplyCard}${breadthCard}</div>`;
}

// ── AI 요약 섹션 ───────────────────────────────────────────────────────────────

function _buildSummarySection(plan, pipelineData, tfResults) {
  const bullets = plan.summary_bullets?.length
    ? plan.summary_bullets
    : (tfResults.news?.top_stories ?? []).map(s => `• ${s}`);
  if (!bullets.length) return '';
  return bullets
    .map(l => `<p style="margin:4px 0;font-size:13px;color:var(--color-text-primary);line-height:1.7">${l.replace(/^[•·\-]\s*/, '• ')}</p>`)
    .join('');
}

// ── 코인 섹션 ─────────────────────────────────────────────────────────────────

function _buildCryptoSection(tfCrypto, rawCrypto) {
  if (!rawCrypto?.btc) return '';
  const { btc, eth, fearGreed, btcDominance, top10 } = rawCrypto;
  const fgColor = fearGreed?.value >= 60 ? COLOR.up : fearGreed?.value <= 30 ? COLOR.dn : COLOR.neu;
  const rows = (top10 ?? []).slice(0, 5).map(coin => `
    <tr>
      <td class="c">${coin.rank}</td>
      <td style="font-weight:500">${coin.symbol}</td>
      <td class="r">$${N(coin.priceUsd)}</td>
      <td class="r"><div class="chg">
        <span class="chg-val ${coin.change24h >= 0 ? 'up' : 'dn'}">${arr(coin.change24h)} ${sgn(coin.change24h)}${N(Math.abs(coin.change24h))}%</span>
      </div></td>
    </tr>`).join('');
  return `
<div class="sec">
  <div class="sec-title">블록체인 · 코인</div>
  <table class="tbl">
    <colgroup><col style="width:36px"><col style="width:72px"><col><col style="width:130px"></colgroup>
    <thead><tr><th>#</th><th class="l">심볼</th><th>시세(USD)</th><th>24h 변동</th></tr></thead>
    <tbody>
      <tr>
        <td class="c">—</td><td style="font-weight:600">BTC</td>
        <td class="r">$${N(btc?.price)}</td>
        <td class="r"><div class="chg"><span class="chg-val ${btc?.change24h >= 0 ? 'up' : 'dn'}">${arr(btc?.change24h)} ${sgn(btc?.change24h)}${N(Math.abs(btc?.change24h ?? 0))}%</span></div></td>
      </tr>
      ${eth ? `<tr>
        <td class="c">—</td><td style="font-weight:600">ETH</td>
        <td class="r">$${N(eth?.price)}</td>
        <td class="r"><div class="chg"><span class="chg-val ${eth?.change24h >= 0 ? 'up' : 'dn'}">${arr(eth?.change24h)} ${sgn(eth?.change24h)}${N(Math.abs(eth?.change24h ?? 0))}%</span></div></td>
      </tr>` : ''}
      ${rows}
    </tbody>
  </table>
  <div style="margin-top:8px;display:flex;gap:16px;font-size:12px;color:var(--color-text-secondary)">
    ${fearGreed ? `<span>😱 Fear &amp; Greed: <b style="color:${fgColor}">${fearGreed.value} (${fearGreed.label})</b></span>` : ''}
    ${btcDominance ? `<span>BTC 도미넌스: <b>${btcDominance}%</b></span>` : ''}
  </div>
  ${tfCrypto?.market_summary ? `<div class="note" style="margin-top:6px">💡 ${tfCrypto.market_summary}</div>` : ''}
</div>`;
}

// ── 애널리스트 섹션 ────────────────────────────────────────────────────────────

function _buildAnalystSection(tfAnalyst) {
  if (!tfAnalyst?.findings?.length) return '';
  const rows = tfAnalyst.findings.slice(0, 5).map(f => `
    <tr ${f.importance >= 8 ? 'style="background:var(--color-background-warning)"' : ''}>
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
    <thead><tr><th class="l">종목</th><th class="l">증권사</th><th>의견</th><th>목표가</th><th class="l">핵심 논거</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</div>`;
}

// ── 최종 HTML 조립 ────────────────────────────────────────────────────────────

function _assembleHtml({ date, d, o, fx, c, news, histDisp, histAll,
  chartUrl, chartScript, summaryHtml, cryptoSection, analystSection, summaryMap, headline }) {

  const supply = d.supply ?? {};

  // 날짜 변수: dateMd = 마지막 거래일(5/11), prevMd = 그 전일(5/10)
  const { full: dateFull, md: dateMd, prevMd } = _dataDateInfo(date, histDisp);

  // 전일 거래대금: histDisp 마지막 항목 (= 어제 거래일)
  const prevDayTvBn = histDisp[histDisp.length - 1]?.tradingValueBn ?? null;
  const volDiff = (d.volumeBn != null && prevDayTvBn != null) ? r2(d.volumeBn - prevDayTvBn) : null;
  const volPct  = (volDiff != null && prevDayTvBn) ? r2(volDiff / prevDayTvBn * 100) : null;

  // 뉴스 행 — 카테고리 순서 정렬 (시장전반 → 거시경제 → 산업·기업)
  const NEWS_CAT_ORDER = ['시장전반', '거시경제', '산업·기업'];
  const sortedNews = [...(news ?? [])].sort((a, b) => {
    const oa = NEWS_CAT_ORDER.indexOf(a.category);
    const ob = NEWS_CAT_ORDER.indexOf(b.category);
    return (oa === -1 ? 99 : oa) - (ob === -1 ? 99 : ob);
  });

  const newsRows = sortedNews.map(n => {
    const sumText = summaryMap.get(n.url);
    const body = sumText
      ? sumText.split('\n').filter(l => l.trim()).map(l => `· ${l.replace(/^[•·]\s*/, '')}`).join('<br>')
      : (n.body ?? '').split(/(?<=[.…])\s+/).slice(0, 2).map(s => `· ${s}`).join('<br>');
    const tagCls = { '시장전반': 't-mkt', '산업·기업': 't-corp', '거시경제': 't-mac' }[n.category] ?? 't-mkt';
    return `<tr>
      <td class="td-date">${(n.date?.slice(5) || '').replace('-', '/')}</td>
      <td class="td-cat"><span class="tag ${tagCls}">${n.category}</span></td>
      <td class="td-ttl"><a href="${n.url}" target="_blank">${n.title}</a><div class="td-src">📰 ${n.source}</div></td>
      <td class="td-sum">${body}</td>
    </tr>`;
  }).join('');

  // KOSPI 역사 행 (날짜 | 종가 | 전일比 | 등락률 | 거래대금)
  const histRows = histDisp.map((h, i) => {
    const prevRow = i === 0
      ? (histAll.length > histDisp.length ? histAll[histAll.length - histDisp.length - 1] : null)
      : histDisp[i - 1];
    const diff  = prevRow?.close != null ? r2(h.close - prevRow.close) : null;
    const pct   = (diff != null && prevRow.close) ? r2(diff / prevRow.close * 100) : null;
    const cls   = dir(diff);
    // 날짜 + 요일 (dateISO 있을 때만)
    const dateLabel = h.dateISO
      ? `${h.date} (${KO_DAYS[new Date(h.dateISO + 'T00:00:00+09:00').getDay()]})`
      : h.date;
    const diffStr = diff != null
      ? `<span class="${cls}">${arr(diff)} ${sgn(diff)}${N(Math.abs(diff))}</span>`
      : '<span class="neu">―</span>';
    const pctStr = pct != null
      ? `<span class="${cls}">${sgn(pct)}${N(pct)}%</span>`
      : '<span class="neu">―</span>';
    // 거래대금 우선, 없으면 거래량 폴백
    const tvStr = h.tradingValueBn != null
      ? `${N(h.tradingValueBn)}조원`
      : (h.volume && h.volume > 1000 ? `${(h.volume / 1e5).toFixed(1)}억주` : '―');
    return `<tr>
      <td>${dateLabel}</td>
      <td class="r">${N(h.close)}</td>
      <td class="r">${diffStr}</td>
      <td class="r">${pctStr}</td>
      <td class="r">${tvStr}</td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="ko"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>시장 리포트 ${date}</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --fn:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;
  --up:#E24B4A;--dn:#378ADD;--neu:#888;
  --color-text-primary:#1a1a1a;
  --color-text-secondary:#666;
  --color-text-tertiary:#999;
  --color-text-info:#2563eb;
  --color-text-success:#16a34a;
  --color-text-warning:#d97706;
  --color-background-secondary:#f8f8f8;
  --color-background-info:#eff6ff;
  --color-background-success:#f0fdf4;
  --color-background-warning:#fffbeb;
  --color-border-secondary:#e0e0e0;
  --color-border-tertiary:#ebebeb;
  --border-radius-md:6px;
}
body,div,span,td,th,a,p{font-family:var(--fn)!important}
body{font-size:14px;background:#f5f5f5;padding:16px;color:var(--color-text-primary)}
.wrap{max-width:720px;margin:0 auto}
.hdr{margin-bottom:1.8rem;padding-bottom:12px;border-bottom:0.5px solid var(--color-border-secondary)}
.hdr-top{display:flex;align-items:baseline;gap:10px}
.hdr-title{font-size:20px;font-weight:600}
.hdr-date{font-size:12px;color:var(--color-text-secondary)}
.hdr-headline{font-size:13px;color:var(--color-text-info);margin-top:6px;font-weight:500;display:block}
.sec{margin:0 0 2rem}
.sec-title{font-size:11px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:var(--color-text-secondary);border-bottom:0.5px solid var(--color-border-secondary);padding-bottom:5px;margin-bottom:12px}
.tbl{width:100%;border-collapse:collapse;font-size:13px}
.tbl th{font-size:11px;font-weight:600;color:var(--color-text-secondary);background:var(--color-background-secondary);padding:6px 8px;border-bottom:0.5px solid var(--color-border-secondary);white-space:nowrap;text-align:center}
.tbl th.l{text-align:left}
.tbl td{padding:8px 8px;border-bottom:0.5px solid var(--color-border-tertiary);color:var(--color-text-primary);vertical-align:middle;line-height:1.5}
.tbl td.r{text-align:right;white-space:nowrap}
.tbl td.c{text-align:center}
.tbl td.bi{font-size:11px;color:var(--color-text-secondary);line-height:1.55}
.tbl tr:last-child td{border-bottom:none}
.tbl tr:hover td{background:var(--color-background-secondary)}
.chg{display:flex;flex-direction:column;align-items:flex-end;gap:2px}
.chg-val{font-size:13px;font-weight:400;white-space:nowrap}
.chg-lbl{font-size:10px;color:var(--color-text-secondary);white-space:nowrap}
.up{color:var(--up)}.dn{color:var(--dn)}.neu{color:var(--neu)}
.bar-row{display:flex;align-items:center;gap:6px;margin-bottom:4px;font-size:12px}
.bar-row .nm{min-width:40px;color:var(--color-text-secondary)}
.bwrap{flex:1;height:4px;background:var(--color-border-tertiary);border-radius:2px}
.bfill{height:100%;border-radius:2px}
.b-buy{background:var(--up)}.b-sell{background:var(--dn)}
.bar-row .val{min-width:90px;text-align:right;font-size:12px}
.sup-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:10px}
.sup-card{background:var(--color-background-secondary);border-radius:var(--border-radius-md);padding:11px 13px}
.sup-card .st{font-size:11px;font-weight:600;color:var(--color-text-secondary);margin-bottom:7px}
.chart-wrap{position:relative;width:100%;height:195px;margin-bottom:6px}
.summary-box{background:var(--color-background-info);border:1px solid #dbe8ff;border-radius:8px;padding:14px 18px;margin-bottom:1.8rem}
.summary-box .s-title{font-size:11px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--color-text-info);margin-bottom:10px}
.s-badge{display:inline-block;font-size:10px;font-weight:700;background:#2563eb;color:#fff;padding:2px 7px;border-radius:10px}
.ntbl{width:100%;border-collapse:collapse;font-size:13px}
.ntbl th{font-size:11px;font-weight:600;color:var(--color-text-secondary);background:var(--color-background-secondary);padding:6px 8px;border-bottom:0.5px solid var(--color-border-secondary);text-align:center}
.ntbl th.l{text-align:left}
.ntbl td{padding:9px 8px;border-bottom:0.5px solid var(--color-border-tertiary);vertical-align:top}
.ntbl tr:last-child td{border-bottom:none}
.td-date{white-space:nowrap;font-size:12px;color:var(--color-text-secondary);min-width:68px}
.td-cat{white-space:nowrap;min-width:64px;text-align:center}
.td-ttl{min-width:190px;max-width:215px}
.td-ttl a{color:var(--color-text-info);text-decoration:none;font-size:12px;line-height:1.45}
.td-ttl a:hover{text-decoration:underline}
.td-src{font-size:11px;color:var(--color-text-secondary);margin-top:3px}
.td-sum{font-size:12px;color:var(--color-text-secondary);line-height:1.65}
.tag{display:inline-block;font-size:10px;font-weight:600;padding:2px 6px;border-radius:4px}
.t-mkt{background:var(--color-background-info);color:var(--color-text-info)}
.t-corp{background:var(--color-background-success);color:var(--color-text-success)}
.t-mac{background:var(--color-background-warning);color:var(--color-text-warning)}
.note{font-size:11px;color:var(--color-text-tertiary);margin-top:5px;line-height:1.7}
.divider{height:0.5px;background:var(--color-border-tertiary);margin:1.5rem 0}
@media(max-width:600px){body{padding:10px}.td-sum{display:none}}
</style>
</head>
<body><div class="wrap">

<!-- HEADER -->
<div class="hdr">
  <div class="hdr-top">
    <span class="hdr-title">📊 일일 시장 리포트</span>
    <span class="hdr-date">${dateFull} 종가 기준 — 한국경제 · 네이버증권</span>
  </div>
  ${headline ? `<span class="hdr-headline">📌 ${headline}</span>` : ''}
</div>

<!-- AI SUMMARY -->
${summaryHtml ? `<div class="summary-box"><div class="s-title"><span class="s-badge">✦ AI</span> Summary</div>${summaryHtml}</div>` : ''}

<!-- ══ 1. 국내 증시 ══ -->
<div class="sec">
  <div class="sec-title">국내 증시</div>
  <table class="tbl">
    <colgroup><col style="width:160px"><col style="width:90px"><col style="width:90px"><col><col style="width:44%"></colgroup>
    <thead><tr><th class="l">구분</th><th>당일(${dateMd}) 종가</th><th>전일(${prevMd}) 종가</th><th>변동</th><th class="l">비고</th></tr></thead>
    <tbody>
      ${trow('KOSPI',  d.kospi,  N(d.kospi?.today),  N(d.kospi?.prev))}
      ${trow('KOSDAQ', d.kosdaq, N(d.kosdaq?.today), N(d.kosdaq?.prev))}
      ${d.vkospi?.today != null
        ? trow(
            d.vkospi.source === 'vix_fallback' ? '미국 VIX (참고)' : 'VKOSPI (공포지수)',
            d.vkospi,
            N(d.vkospi.today), N(d.vkospi.prev),
            d.vkospi.source === 'vix_fallback'
              ? 'Yahoo ^VIX — VKOSPI 수집 불가 시 대체'
              : d.vkospi.today > 30 ? '불안심리 고조' : d.vkospi.today > 20 ? '경계' : '안정'
          )
        : ''}
      ${(d.volumeBn != null || prevDayTvBn != null)
        ? `<tr><td>KOSPI 거래대금</td><td class="r">${d.volumeBn != null ? N(d.volumeBn)+'조원' : '―'}</td><td class="r">${prevDayTvBn != null ? N(prevDayTvBn)+'조원' : '―'}</td><td class="r">${volDiff != null ? `<div class="chg"><span class="chg-val ${dir(volDiff)}">${arr(volDiff)} ${sgn(volDiff)}${N(Math.abs(volDiff))}조원 (${sgn(volPct)}${N(volPct)}%)</span></div>` : '<span class="neu">―</span>'}</td><td class="bi">일중 누적</td></tr>`
        : ''}
      ${d.marketCap != null
        ? `<tr><td>KOSPI 시가총액</td><td class="r">${N(d.marketCap)}조원</td><td class="r">―</td><td class="c neu">―</td><td class="bi"></td></tr>`
        : ''}
    </tbody>
  </table>
  ${_buildMarketCards(supply, d.breadth, date)}
</div>

<!-- ══ 2. KOSPI 5거래일 추이 ══ -->
<div class="sec">
  <div class="sec-title">KOSPI 최근 5거래일 종가 추이 &amp; 거래대금</div>
  <div class="chart-wrap">
    <!-- 이메일 폴백: quickchart 이미지 -->
    <img id="kChartImg" src="${chartUrl}" alt="KOSPI 차트" style="width:100%;height:auto;display:block;border-radius:4px">
    <!-- 브라우저/Notion: Chart.js 캔버스 -->
    <canvas id="kChart" role="img" aria-label="코스피 최근 5거래일 종가 추이"
      style="display:none;width:100%;height:195px"></canvas>
  </div>
  <table class="tbl" style="margin-top:6px">
    <colgroup><col style="width:64px"><col style="width:88px"><col style="width:100px"><col style="width:80px"><col></colgroup>
    <thead><tr><th class="l">날짜</th><th>KOSPI 종가</th><th>전일比</th><th>등락률</th><th>거래대금</th></tr></thead>
    <tbody>${histRows || '<tr><td colspan="5" style="text-align:center;color:#bbb;padding:12px">데이터 없음</td></tr>'}</tbody>
  </table>
</div>

<!-- ══ 3. 해외 증시 ══ -->
<div class="sec">
  <div class="sec-title">해외 증시</div>
  <table class="tbl">
    <colgroup><col style="width:195px"><col style="width:90px"><col style="width:90px"><col><col style="width:44%"></colgroup>
    <thead><tr><th class="l">구분</th><th>전일(${dateMd}) 종가</th><th>전전일(${prevMd}) 종가</th><th>변동</th><th class="l">비고</th></tr></thead>
    <tbody>
      ${trow('다우존스',               o.dow,    N(o.dow?.today),    N(o.dow?.prev))}
      ${trow('S&amp;P 500',            o.sp500,  N(o.sp500?.today),  N(o.sp500?.prev))}
      ${trow('나스닥',                 o.nasdaq, N(o.nasdaq?.today), N(o.nasdaq?.prev))}
      ${trow('필라델피아 반도체(SOX)', o.sox,    N(o.sox?.today),    N(o.sox?.prev))}
      ${trow('닛케이225',              o.nikkei, N(o.nikkei?.today), N(o.nikkei?.prev))}
      ${o.dax?.today != null ? trow('DAX (독일)', o.dax, N(o.dax?.today), N(o.dax?.prev)) : ''}
      ${trow('항셍지수',               o.hsi,    N(o.hsi?.today),    N(o.hsi?.prev))}
    </tbody>
  </table>
</div>

<!-- ══ 4. 환율 · 금리 ══ -->
<div class="sec">
  <div class="sec-title">환율 · 금리</div>
  <table class="tbl">
    <colgroup><col style="width:195px"><col style="width:90px"><col style="width:90px"><col><col style="width:44%"></colgroup>
    <thead><tr><th class="l">구분</th><th>당일(${dateMd})</th><th>전일(${prevMd})</th><th>변동</th><th class="l">비고</th></tr></thead>
    <tbody>
      ${trow('원/달러 환율',    fx.usdKrw, NI(fx.usdKrw?.today) + '원', NI(fx.usdKrw?.prev) + '원')}
      ${trow('달러 인덱스',     fx.dxy,    N(fx.dxy?.today),             N(fx.dxy?.prev))}
      ${trow('미 국채 10년물',  fx.us10y,  N(fx.us10y?.today) + '%',     N(fx.us10y?.prev) + '%')}
      ${fx.us2y?.today != null ? trow('미 국채 2년물', fx.us2y, N(fx.us2y?.today) + '%', N(fx.us2y?.prev) + '%', '단기금리 — 연준 정책 민감') : ''}
      ${(() => {
        const f = fx.fomc ?? {};
        const fRow = (lbl, today, prev, note) => {
          const diff = today != null && prev != null ? r2(today - prev) : null;
          const chg = diff == null ? '<span class="neu">―</span>'
            : `<span class="${dir(diff)}">${sgn(diff)}${N(Math.abs(diff))}%p</span>`;
          return `<tr><td>${lbl}</td><td class="r">${today ?? 'N/A'}%</td><td class="r">${prev != null ? prev + '%' : '―'}</td><td class="c">${chg}</td><td class="bi">${note}</td></tr>`;
        };
        return [
          fRow('6월 FOMC 동결확률', f.junHoldPct, f.junHoldPctPrev, 'CME FedWatch'),
          fRow('9월 인하 가능성',   f.sepCutPct,  f.sepCutPctPrev,  'CME FedWatch'),
        ].join('');
      })()}
    </tbody>
  </table>
</div>

<!-- ══ 5. 원자재 · 비철금속 ══ -->
<div class="sec">
  <div class="sec-title">원자재 · 비철금속</div>
  <table class="tbl">
    <colgroup><col style="width:210px"><col style="width:90px"><col style="width:90px"><col><col style="width:44%"></colgroup>
    <thead><tr><th class="l">구분</th><th>당일(${dateMd}) 시세</th><th>전일(${prevMd}) 시세</th><th>변동</th><th class="l">비고</th></tr></thead>
    <tbody>
      ${trow('🥇 금 (선물, oz)',           c.gold,     '$' + N(c.gold?.today),      '$' + N(c.gold?.prev), '안전자산 수요')}
      ${trow('🥇 금 (국내 순금 1돈)',      c.goldKrw,  NI(c.goldKrw?.today) + '원', NI(c.goldKrw?.prev) + '원', '살 때 기준')}
      ${c.silver?.today  != null ? trow('⚪ 은 (COMEX, oz)',     c.silver,   '$' + N(c.silver?.today),   '$' + N(c.silver?.prev),   '태양광·반도체 수요') : ''}
      ${c.platinum?.today != null ? trow('⚪ 백금 (COMEX, oz)',  c.platinum, '$' + N(c.platinum?.today), '$' + N(c.platinum?.prev), '귀금속 동조') : ''}
      ${trow('🛢️ WTI 원유 (bbl)',          c.wti,      '$' + N(c.wti?.today),       '$' + N(c.wti?.prev))}
      ${trow('🔴 구리 (COMEX, lb)',        c.copper,   '$' + N(c.copper?.today),    '$' + N(c.copper?.prev), '경기 선행 지표')}
      ${c.aluminum?.today != null ? trow('🩶 알루미늄 (선물)', c.aluminum, '$' + N(c.aluminum?.today), '$' + N(c.aluminum?.prev), '그린에너지 수요') : ''}
    </tbody>
  </table>
  <div class="note">※ 은·백금·알루미늄은 Yahoo Finance 선물 기준. 아연·니켈은 LME 데이터 추후 추가 예정.</div>
</div>

${cryptoSection}
${analystSection}

<!-- ══ 6. 주요 뉴스 ══ -->
<div class="sec">
  <div class="sec-title">주요 뉴스</div>
  <table class="ntbl">
    <colgroup><col style="width:68px"><col style="width:64px"><col style="width:210px"><col></colgroup>
    <thead><tr><th class="l">일자</th><th>구분</th><th class="l">제목 / 출처</th><th class="l">요약</th></tr></thead>
    <tbody>${newsRows}</tbody>
  </table>
</div>

<!-- FOOTER -->
<div class="divider"></div>
<div class="note" style="line-height:1.9">
  📌 출처: Yahoo Finance · 네이버금융 · CoinGecko · DART · CME FedWatch<br>
  ⚠️ 본 리포트는 정보 제공 목적이며 투자 권유가 아닙니다.
</div>

</div><!-- /wrap -->

<!-- Chart.js: 브라우저/Notion 전용 (이메일에서는 위 img 폴백 사용) -->
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js"></script>
${chartScript}
</body></html>`;
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

${JSON.stringify(news.slice(0, 12).map(n => ({ url: n.url, title: n.title, body: n.body?.slice(0, 300) })), null, 2)}`);
    const raw = res.response.text().replace(/^```json\s*/, '').replace(/```\s*$/, '').trim();
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
    return { today, prev, diff: delta, pct: prev ? r2((today - prev) / prev * 100) : 0 };
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
    const yfVol = yfRes.indicators.quote[0].volume;
    const toMD  = ts => {
      const dt = new Date(ts * 1000);
      return `${String(dt.getMonth() + 1).padStart(2, '0')}/${String(dt.getDate()).padStart(2, '0')}`;
    };
    return yfRes.timestamp
      .map((ts, i) => ({ ts, close: yfCl[i], volume: yfVol?.[i] }))
      .filter(x => x.close != null)
      .slice(-6)
      .map(x => ({ date: toMD(x.ts), close: r2(x.close), volume: x.volume ?? 0 }));
  } catch { return null; }
}

function _buildChartUrl(histDisp) {
  const allPrices = histDisp.map(h => h.close).filter(Boolean);
  const tvBns     = histDisp.map(h => h.tradingValueBn ?? null);
  const hasTv     = tvBns.some(v => v != null);
  const yMin = allPrices.length ? Math.floor(Math.min(...allPrices) * 0.98 / 100) * 100 : 6000;
  const yMax = allPrices.length ? Math.ceil(Math.max(...allPrices) * 1.02 / 100) * 100  : 8500;
  const tvMax = hasTv ? Math.ceil(Math.max(...tvBns.filter(Boolean)) * 1.4 * 2) / 2 || 80 : 80;
  const cfg = {
    type: 'bar',
    data: {
      labels: histDisp.map(h => h.date),
      datasets: [
        {
          type: 'line', label: 'KOSPI 종가',
          data: histDisp.map(h => h.close),
          borderColor: '#E24B4A', backgroundColor: 'rgba(226,75,74,0.08)',
          borderWidth: 2, pointBackgroundColor: '#E24B4A', pointRadius: 4,
          fill: true, yAxisID: 'A',
        },
        {
          type: 'bar', label: '거래대금',
          data: tvBns,
          backgroundColor: 'rgba(55,138,221,0.22)',
          borderColor: 'rgba(55,138,221,0.55)',
          borderWidth: 1, yAxisID: 'B',
        },
      ],
    },
    options: {
      legend: { display: false },
      scales: {
        xAxes: [{ ticks: { fontSize: 10 } }],
        yAxes: [
          { id: 'A', position: 'left',  ticks: { min: yMin, max: yMax, fontSize: 10 } },
          { id: 'B', position: 'right', ticks: { min: 0, max: tvMax, fontSize: 10 } },
        ],
      },
    },
  };
  return 'https://quickchart.io/chart?w=660&h=200&backgroundColor=white&c=' + encodeURIComponent(JSON.stringify(cfg));
}

function _buildChartScript(histDisp) {
  if (!histDisp.length) return '';
  const prices   = histDisp.map(h => h.close);
  const tvBns    = histDisp.map(h => h.tradingValueBn ?? null);  // 거래대금(조원)
  const hasTv    = tvBns.some(v => v != null);
  const labels   = histDisp.map(h => {
    // 요일 포함 레이블
    if (h.dateISO) {
      const koDays = ['일','월','화','수','목','금','토'];
      const dow = koDays[new Date(h.dateISO + 'T00:00:00+09:00').getDay()];
      return h.date + '(' + dow + ')';
    }
    return h.date;
  });
  const yMin   = Math.floor(Math.min(...prices.filter(Boolean)) * 0.98 / 100) * 100;
  const yMax   = Math.ceil(Math.max(...prices.filter(Boolean)) * 1.02 / 100) * 100;
  const tvMax  = hasTv ? Math.ceil(Math.max(...tvBns.filter(Boolean)) * 1.4 * 2) / 2 || 80 : 80;

  return `<script>
(function() {
  try {
    var img = document.getElementById('kChartImg');
    var cnv = document.getElementById('kChart');
    if (!img || !cnv) return;
    img.style.display = 'none';
    cnv.style.display = 'block';
    var isDark = window.matchMedia && window.matchMedia('(prefers-color-scheme:dark)').matches;
    var gc = isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.06)';
    var tc = isDark ? '#9c9a92' : '#73726c';
    new Chart(cnv, {
      type: 'bar',
      data: {
        labels: ${JSON.stringify(labels)},
        datasets: [
          { type:'line', label:'KOSPI 종가',
            data: ${JSON.stringify(prices)},
            borderColor:'#E24B4A', backgroundColor:'rgba(226,75,74,0.08)',
            borderWidth:2, pointBackgroundColor:'#E24B4A', pointRadius:4,
            fill:true, tension:0.3, yAxisID:'yL' },
          { type:'bar', label:'거래대금(조원)',
            data: ${JSON.stringify(tvBns)},
            backgroundColor: isDark ? 'rgba(55,138,221,0.30)' : 'rgba(55,138,221,0.22)',
            borderColor: isDark ? 'rgba(55,138,221,0.65)' : 'rgba(55,138,221,0.55)',
            borderWidth:1, yAxisID:'yR' }
        ]
      },
      options: {
        responsive:true, maintainAspectRatio:false,
        interaction:{ mode:'index', intersect:false },
        plugins:{
          legend:{ display:false },
          tooltip:{ callbacks:{ label: function(ctx) {
            var v = ctx.parsed.y;
            if (v == null) return ctx.dataset.label + ': —';
            if (ctx.dataset.yAxisID === 'yR') return ctx.dataset.label + ': ' + v.toFixed(2) + '조원';
            return ctx.dataset.label + ': ' + v.toLocaleString('ko-KR', {minimumFractionDigits:2,maximumFractionDigits:2});
          }}}
        },
        scales:{
          x:{ grid:{color:gc}, ticks:{color:tc, font:{size:11}} },
          yL:{ position:'left', min:${yMin}, max:${yMax}, grid:{color:gc},
               ticks:{color:tc, font:{size:11}, callback:function(v){ return v.toLocaleString(); }} },
          yR:{ position:'right', min:0, max:${tvMax}, grid:{drawOnChartArea:false},
               ticks:{color:tc, font:{size:11}, callback:function(v){ return v.toFixed(0)+'조'; }} }
        }
      }
    });
  } catch(e) {}
})();
<\/script>`;
}
