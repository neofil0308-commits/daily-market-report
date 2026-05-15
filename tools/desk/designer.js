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

// 변동 셀 — 수치만 표시
const chgCell = (obj) => {
  const d = obj?.diff;
  const p = obj?.pct;
  if (d == null) return '<span class="neu">―</span>';
  return `<span class="chg-val ${dir(d)}">${arr(d)} ${sgn(d)}${N(Math.abs(d))} (${sgn(p)}${N(p)}%)</span>`;
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

  const [summaryMap, rowNotes, histIssues] = await Promise.all([
    _buildSummaryMap(news ?? [], pipelineData),
    _buildRowNotes(pipelineData, tfResults),
    _buildHistIssues(histDisp, histAll, tfResults),
  ]);
  const chartUrl      = _buildChartUrl(histDisp);     // 이메일 폴백용 quickchart
  const chartScript   = _buildChartScript(histDisp);  // Chart.js 인라인 스크립트

  const summaryHtml    = _buildSummarySection(editorialPlan, pipelineData, tfResults);
  const cryptoSection  = editorialPlan.include_crypto
    ? _buildCryptoSection(tfResults.crypto, pipelineData.crypto) : '';
  const analystSection = editorialPlan.include_analyst
    ? _buildAnalystSection(tfResults.analyst) : '';

  const orderedNews = _reorderNewsByTF(news ?? [], tfResults?.news?.findings);

  const html = _assembleHtml({
    date, d, o, fx, c, news: orderedNews,
    histDisp, histAll, chartUrl, chartScript,
    summaryHtml, cryptoSection, analystSection,
    summaryMap, rowNotes, histIssues,
    headline: editorialPlan.headline,
  });

  logger.info(`[desk/designer] HTML 생성 완료 (${Math.round(html.length / 1024)}KB)`);
  return html;
}

// ── 수급 5거래일 추이 테이블 ──────────────────────────────────────────────────

function _buildSupplyHistory(history) {
  if (!history || history.length === 0) return '';

  const maxF = Math.max(...history.map(h => Math.abs(h.foreign ?? 0)), 1);
  const maxI = Math.max(...history.map(h => Math.abs(h.institution ?? 0)), 1);
  const maxP = Math.max(...history.map(h => Math.abs(h.individual ?? 0)), 1);

  const fmt = v => {
    if (v == null) return '―';
    const abs = Math.abs(v);
    const prefix = v >= 0 ? '+' : '';
    return prefix + abs.toLocaleString('ko-KR');
  };

  const barCell = (val, maxAbs, isLast) => {
    if (val == null) return `<td style="padding:3px 4px;"></td>`;
    const isBuy  = val >= 0;
    const pct    = Math.max(8, Math.round(Math.abs(val) / maxAbs * 100));
    const bg     = isBuy ? 'rgba(37,99,235,0.18)' : 'rgba(220,38,38,0.20)';
    const fg     = isBuy ? '#1d4ed8' : '#b91c1c';
    const border = isLast ? 'border:1.5px solid ' + (isBuy ? '#93c5fd' : '#fca5a5') + ';' : '';
    return `<td style="padding:3px 4px;">
      <div style="position:relative;height:24px;border-radius:4px;overflow:hidden;background:#f4f4f5;${border}">
        <div style="position:absolute;left:0;top:0;height:100%;width:${pct}%;background:${bg};"></div>
        <span style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);font-size:11px;font-weight:600;color:${fg};white-space:nowrap;letter-spacing:-0.3px;">${fmt(val)}</span>
      </div></td>`;
  };

  const lastDate = history[history.length - 1]?.date ?? '';
  const TH = 'text-align:center;font-size:11px;color:#888;font-weight:500;padding:4px 4px 6px;';
  const TD = 'font-size:12px;font-weight:700;color:#374151;padding:4px 8px 4px 0;white-space:nowrap;';

  const headers = history.map(h =>
    `<th style="${TH}${h.date === lastDate ? 'color:#1d4ed8;font-weight:700;' : ''}">${h.date}</th>`
  ).join('');

  const rows = [
    { label: '외국인', key: 'foreign',     max: maxF },
    { label: '기관',   key: 'institution', max: maxI },
    { label: '개인',   key: 'individual',  max: maxP },
  ].map(({ label, key, max }) =>
    `<tr><td style="${TD}">${label}</td>${history.map(h => barCell(h[key], max, h.date === lastDate)).join('')}</tr>`
  ).join('');

  return `<div style="margin-top:20px;padding-top:16px;border-top:1px solid #e8eaed">
    <div style="font-size:13px;font-weight:700;color:var(--color-text-primary);margin-bottom:8px">KOSPI 수급 추이 — 최근 ${history.length}거래일 <span style="font-size:11px;color:#9ca3af;font-weight:400">(단위: 억원)</span></div>
    <div style="overflow-x:auto;margin-top:6px">
      <table style="width:100%;border-collapse:collapse;">
        <thead><tr><th style="${TH}"></th>${headers}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </div>`;
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

function _buildMarketCards(supply, breadth, date, prevMd, dateMd, supplyToday, supplyHistory) {
  const hasHistory     = supplyHistory?.length > 0;
  const hasSupply      = supply?.foreign != null || supply?.institution != null || supply?.individual != null;
  const hasSupplyToday = supplyToday?.foreign != null || supplyToday?.institution != null || supplyToday?.individual != null;
  const hasBreadth     = breadth?.advancing != null || breadth?.intraHigh != null;
  if (!hasHistory && !hasSupply && !hasSupplyToday && !hasBreadth) return '';

  // 5거래일 이력이 있으면 새 차트로 대체
  if (hasHistory) {
    const historyHtml = _buildSupplyHistory(supplyHistory);
    if (!hasBreadth) return `<div class="sup-wrap">${historyHtml}</div>`;
    // breadth 카드는 별도 유지
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
    const breadthCard = `<div class="sup-card"><div class="st">시장 강도 (상승/하락 종목)</div>${bars}${hlStr}</div>`;
    return `<div class="sup-wrap">${historyHtml}</div><div class="sup-cards">${breadthCard}</div>`;
  }

  // 첫 번째 카드: 전일 수급
  const supplyCard = hasSupply ? (() => {
    const { foreign, institution, individual } = supply;
    const maxAbs = Math.max(Math.abs(foreign ?? 0), Math.abs(institution ?? 0), Math.abs(individual ?? 0), 1);
    const titleDate = prevMd ?? date?.slice(5)?.replace('-', '/') ?? '';
    return `<div class="sup-card">
      <div class="st">KOSPI 수급 — 전일(${titleDate}) 종가</div>
      ${_supplyBar('외국인', foreign, maxAbs)}
      ${_supplyBar('기관', institution, maxAbs)}
      ${_supplyBar('개인', individual, maxAbs)}
    </div>`;
  })() : '';

  // 두 번째 카드: 당일 수급 우선, 없으면 breadth, 둘 다 없으면 생략
  let secondCard = '';
  if (hasSupplyToday) {
    const { foreign, institution, individual } = supplyToday;
    const maxAbs = Math.max(Math.abs(foreign ?? 0), Math.abs(institution ?? 0), Math.abs(individual ?? 0), 1);
    const titleDate = dateMd ?? date?.slice(5)?.replace('-', '/') ?? '';
    secondCard = `<div class="sup-card">
      <div class="st">당일(${titleDate}) 수급</div>
      ${_supplyBar('외국인', foreign, maxAbs)}
      ${_supplyBar('기관', institution, maxAbs)}
      ${_supplyBar('개인', individual, maxAbs)}
    </div>`;
  } else if (hasBreadth) {
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
    secondCard = `<div class="sup-card">
      <div class="st">시장 강도 (상승/하락 종목)</div>
      ${bars}
      ${hlStr}
    </div>`;
  }

  if (!supplyCard && !secondCard) return '';
  // 카드가 하나뿐이면 grid 없이 단독 표시
  if (!supplyCard || !secondCard) {
    return `<div class="sup-grid">${supplyCard}${secondCard}</div>`;
  }
  return `<div class="sup-grid">${supplyCard}${secondCard}</div>`;
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
  const filteredTop10 = (top10 ?? []).filter(coin =>
    !['BTC', 'ETH'].includes(coin.symbol?.toUpperCase())
  ).slice(0, 5);

  // top10에서 BTC·ETH 실제 순위 조회
  const btcEntry = top10?.find(c => c.symbol?.toUpperCase() === 'BTC') ?? { rank: 1 };
  const ethEntry = top10?.find(c => c.symbol?.toUpperCase() === 'ETH') ?? { rank: 2 };

  // tfCrypto.findings에서 코인별 시장동향 추출
  const findingFor = (sym) =>
    (tfCrypto?.findings ?? []).find(f => (f.asset ?? '').toUpperCase() === sym.toUpperCase())?.key_level ?? '';

  const TH  = 'background:#f8f8f8;font-size:12px;font-weight:600;color:#555;padding:8px 10px;text-align:right;white-space:nowrap;border-bottom:1px solid #e0e0e0';
  const THL = 'background:#f8f8f8;font-size:12px;font-weight:600;color:#555;padding:8px 10px;text-align:left;white-space:nowrap;border-bottom:1px solid #e0e0e0';
  const THC = 'background:#f8f8f8;font-size:12px;font-weight:600;color:#555;padding:8px 10px;text-align:center;white-space:nowrap;border-bottom:1px solid #e0e0e0';
  const TD  = 'padding:7px 10px;border-bottom:1px solid #ebebeb;vertical-align:top;color:#1e2330;text-align:right';
  const TDL = 'padding:7px 10px;border-bottom:1px solid #ebebeb;vertical-align:top;color:#1e2330;font-weight:600';
  const TDC = 'padding:7px 10px;border-bottom:1px solid #ebebeb;vertical-align:top;color:#1e2330;text-align:center';
  const TDNOTE = 'padding:7px 10px;border-bottom:1px solid #ebebeb;vertical-align:top;color:#555;font-size:12px;text-align:left';

  const chgSpan = (v) => {
    const color = v >= 0 ? COLOR.up : COLOR.dn;
    return `<span style="color:${color}">${arr(v)} ${sgn(v)}${N(Math.abs(v ?? 0))}%</span>`;
  };

  const btcNote = findingFor('BTC') || (tfCrypto?.market_summary ? tfCrypto.market_summary.slice(0, 45) : '');
  const ethNote = findingFor('ETH');

  const rows = filteredTop10.map(coin => `
    <tr>
      <td style="${TDC}">${coin.rank}</td>
      <td style="${TDL}">${coin.symbol ?? coin.name}</td>
      <td style="${TD}">$${N(coin.priceUsd)}</td>
      <td style="${TD}">${chgSpan(coin.change24h)}</td>
      <td style="${TDNOTE}">${findingFor(coin.symbol ?? '')}</td>
    </tr>`).join('');

  const footerItems = [
    fearGreed    ? `😱 Fear &amp; Greed: <b style="color:${fgColor}">${fearGreed.value} (${fearGreed.label})</b>` : null,
    btcDominance ? `BTC 도미넌스: <b>${btcDominance}%</b>` : null,
  ].filter(Boolean);
  const footerHtml = footerItems.length
    ? `<table cellpadding="0" cellspacing="0" border="0" style="margin-top:8px"><tr>
        ${footerItems.map(t => `<td style="font-size:12px;color:#555;padding-right:16px">${t}</td>`).join('')}
      </tr></table>` : '';

  return `
<div class="sec">
  <div class="sec-title">블록체인 · 코인</div>
  <div class="tbl-wrap"><table style="width:100%;border-collapse:collapse;font-size:13px">
    <thead><tr>
      <th style="${THC};width:5%">순위</th><th style="${THL};width:10%">심볼</th>
      <th style="${TH};width:22%">시세(USD)</th><th style="${TH};width:15%">24h 변동</th>
      <th style="${THL};width:48%">시장 동향</th>
    </tr></thead>
    <tbody>
      <tr>
        <td style="${TDC}">${btcEntry.rank}</td><td style="${TDL}">BTC</td>
        <td style="${TD}">$${N(btc?.price)}</td>
        <td style="${TD}">${chgSpan(btc?.change24h)}</td>
        <td style="${TDNOTE}">${btcNote}</td>
      </tr>
      ${eth ? `<tr>
        <td style="${TDC}">${ethEntry.rank}</td><td style="${TDL}">ETH</td>
        <td style="${TD}">$${N(eth?.price)}</td>
        <td style="${TD}">${chgSpan(eth?.change24h)}</td>
        <td style="${TDNOTE}">${ethNote}</td>
      </tr>` : ''}
      ${rows}
    </tbody>
  </table></div>
  ${footerHtml}
  ${tfCrypto?.market_summary ? `<div style="margin-top:10px;font-size:13px;color:#374151;background:#f0f4ff;border-left:4px solid #2563eb;padding:10px 14px;border-radius:0 6px 6px 0;line-height:1.6">💡 <strong>코인 시장 요약:</strong> ${tfCrypto.market_summary}</div>` : ''}
</div>`;
}

// ── 애널리스트 섹션 ────────────────────────────────────────────────────────────

function _buildAnalystSection(tfAnalyst) {
  if (!tfAnalyst?.findings?.length) return '';
  const rows = tfAnalyst.findings.slice(0, 5).map(f => {
    const companyHtml = f.dart_url
      ? `<a href="${f.dart_url}" target="_blank" style="color:var(--color-text-info);text-decoration:none;font-weight:600;border-bottom:1px dotted var(--color-text-info)">${f.company ?? '―'}</a>`
      : (f.company ?? '―');
    return `
    <tr ${f.importance >= 8 ? 'style="background:var(--color-background-warning)"' : ''}>
      <td style="font-weight:500">${companyHtml}</td>
      <td>${f.firm ?? '―'}</td>
      <td class="c">${f.rating_change ?? '―'}</td>
      <td class="r">${f.target_price?.new ? NI(f.target_price.new) + '원' : '―'}</td>
      <td class="bi">${f.key_thesis ?? '―'}</td>
    </tr>`;
  }).join('');
  return `
<div class="sec">
  <div class="sec-title">애널리스트 리포트</div>
  <div class="tbl-wrap"><table class="tbl">
    <thead><tr><th class="l">종목</th><th class="l">증권사</th><th>의견</th><th>목표가</th><th class="l">핵심 논거</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>
</div>`;
}

// ── 최종 HTML 조립 ────────────────────────────────────────────────────────────

function _assembleHtml({ date, d, o, fx, c, news, histDisp, histAll,
  chartUrl, chartScript, summaryHtml, cryptoSection, analystSection, summaryMap, rowNotes, histIssues = {}, headline }) {
  const rn = rowNotes ?? {};

  const supply = d.supply ?? {};

  // 날짜 변수: dateMd = 마지막 거래일(5/11), prevMd = 그 전일(5/10)
  const { full: dateFull, md: dateMd, prevMd } = _dataDateInfo(date, histDisp);

  // 전일 거래대금 — pipeline이 채운 d.prevVolumeBn 우선, 없으면 histDisp[마지막-1] 폴백
  // (histDisp 마지막은 "기준 거래일"이라 d.volumeBn과 같아 비교에 사용 불가 — 마지막에서 두 번째가 전일)
  const prevDayTvBn = d.prevVolumeBn ?? histDisp[histDisp.length - 2]?.tradingValueBn ?? null;
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
    const issueStr = (histIssues[h.date] || h.note || h.issue) || '―';
    return `<tr>
      <td>${dateLabel}</td>
      <td class="r">${N(h.close)}</td>
      <td class="r">${diffStr}</td>
      <td class="r">${pctStr}</td>
      <td class="r">${tvStr}</td>
      <td class="bi">${issueStr}</td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="ko"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>시장 리포트 ${date}</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --fn:'Apple SD Gothic Neo','Malgun Gothic','Noto Sans KR',-apple-system,sans-serif;
  --up:#E24B4A;--dn:#378ADD;--neu:#888;
  --color-text-primary:#1e2330;
  --color-text-secondary:#555;
  --color-text-tertiary:#888;
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
body{font-size:14px;background:#f5f7fa;padding:24px 16px;color:var(--color-text-primary)}
.wrap{max-width:1100px;margin:0 auto;background:#fff;border-radius:8px;padding:32px 36px;box-shadow:0 1px 4px rgba(0,0,0,0.08)}
.hdr{display:flex;align-items:baseline;gap:10px;margin-bottom:1.8rem;padding-bottom:12px;border-bottom:0.5px solid var(--color-border-secondary)}
.hdr-title{font-size:20px;font-weight:600}
.hdr-date{font-size:12px;color:var(--color-text-secondary)}
.hdr-headline{font-size:13px;color:var(--color-text-info);margin-top:6px;font-weight:500;display:block}
.sec{margin:0 0 2rem}
.sec-title{font-size:15px;font-weight:700;color:var(--color-text-primary);border-bottom:1px solid var(--color-border-secondary);padding-bottom:6px;margin-bottom:12px}
.tbl-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch}
.tbl{width:100%;border-collapse:collapse;font-size:13px}
.tbl th{font-size:11px;font-weight:700;color:#333;background:#eceef2;padding:7px 8px;border-bottom:1px solid #ced2da;white-space:nowrap;text-align:center}
.tbl th.l{text-align:left}
.tbl td{padding:8px 8px;border-bottom:0.5px solid var(--color-border-tertiary);color:var(--color-text-primary);font-weight:400;vertical-align:middle;line-height:1.5}
.tbl td.r{text-align:right;white-space:nowrap}
.tbl td.c{text-align:center}
.tbl td.bi{font-size:11px;color:var(--color-text-secondary);line-height:1.55}
.tbl tr:last-child td{border-bottom:none}
.tbl tr:hover td{background:var(--color-background-secondary)}
.chg-val{font-size:13px;font-weight:400;white-space:nowrap}
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
.chart-wrap{position:relative;width:100%;height:220px;margin-bottom:6px}
.summary-box{background:var(--color-background-info);border:1px solid #dbe8ff;border-radius:8px;padding:14px 18px;margin-bottom:1.8rem}
.summary-box .s-title{font-size:11px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--color-text-info);margin-bottom:10px}
.s-badge{display:inline-block;font-size:10px;font-weight:700;background:#2563eb;color:#fff;padding:2px 7px;border-radius:10px}
.ntbl{width:100%;border-collapse:collapse;font-size:13px}
.ntbl th{font-size:11px;font-weight:700;color:#333;background:#eceef2;padding:7px 8px;border-bottom:1px solid #ced2da;text-align:center}
.ntbl th.l{text-align:left}
.ntbl td{padding:9px 8px;border-bottom:0.5px solid var(--color-border-tertiary);vertical-align:top;font-weight:400}
.ntbl tr:last-child td{border-bottom:none}
.td-date{white-space:nowrap;font-size:12px;color:var(--color-text-secondary);min-width:68px}
.td-cat{white-space:nowrap;min-width:64px;text-align:center}
.td-ttl{min-width:190px;max-width:320px}
.td-ttl a{color:var(--color-text-info);text-decoration:none;font-size:12px;line-height:1.45;font-weight:400}
.td-ttl a:hover{text-decoration:underline}
.td-src{font-size:11px;color:var(--color-text-secondary);margin-top:3px}
.td-sum{font-size:12px;color:var(--color-text-secondary);line-height:1.65}
.tag{display:inline-block;font-size:10px;font-weight:600;padding:2px 6px;border-radius:4px}
.t-mkt{background:var(--color-background-info);color:var(--color-text-info)}
.t-corp{background:var(--color-background-success);color:var(--color-text-success)}
.t-mac{background:var(--color-background-warning);color:var(--color-text-warning)}
.note{font-size:11px;color:var(--color-text-tertiary);margin-top:5px;line-height:1.7}
.divider{height:0.5px;background:var(--color-border-tertiary);margin:1.5rem 0}
@media(max-width:900px){
  .wrap{padding:24px 20px}
  .td-sum{display:none}
}
@media(max-width:600px){
  body{padding:10px 8px}
  .wrap{padding:16px 14px;border-radius:4px}
  .hdr{flex-wrap:wrap;gap:4px}
  .hdr-title{font-size:17px}
  .hdr-date{font-size:11px}
  .sec-title{font-size:14px}
  .sec{margin-bottom:1.5rem}
  .tbl-wrap{margin:0 -2px}
  .tbl,.ntbl{min-width:480px}
  .tbl th,.tbl td{padding:6px 6px;font-size:12px}
  .ntbl th,.ntbl td{padding:7px 6px;font-size:12px}
  .td-sum{display:none}
  .sup-grid{grid-template-columns:1fr}
  .chart-wrap{height:170px}
  .summary-box{padding:11px 13px}
}
</style>
</head>
<body><div class="wrap">

<!-- HEADER -->
<div class="hdr">
  <span class="hdr-title">일일 시장 리포트</span>
  <span class="hdr-date">${dateFull} 종가 기준 — 한국경제 · 네이버증권</span>
</div>
${headline ? `<div style="margin-top:-1.2rem;margin-bottom:1.8rem"><span class="hdr-headline">${headline}</span></div>` : ''}

<!-- AI SUMMARY -->
${summaryHtml ? `<div class="summary-box"><div class="s-title"><span class="s-badge">✦ AI</span> Summary</div>${summaryHtml}</div>` : ''}

<!-- ══ 1. 국내 증시 ══ -->
<div class="sec">
  <div class="sec-title">국내 증시</div>
  <div class="tbl-wrap"><table class="tbl">
    <thead><tr><th class="l">구분</th><th>당일(${dateMd}) 종가</th><th>전일(${prevMd}) 종가</th><th>변동</th><th class="l">비고</th></tr></thead>
    <tbody>
      ${trow('KOSPI',  d.kospi,  N(d.kospi?.today),  N(d.kospi?.prev),  rn.kospi)}
      ${trow('KOSDAQ', d.kosdaq, N(d.kosdaq?.today), N(d.kosdaq?.prev), rn.kosdaq)}
      ${(d.volumeBn != null || prevDayTvBn != null)
        ? `<tr><td>KOSPI 거래대금</td><td class="r">${d.volumeBn != null ? N(d.volumeBn)+'조원' : '―'}</td><td class="r">${prevDayTvBn != null ? N(prevDayTvBn)+'조원' : '―'}</td><td class="r">${volDiff != null ? `<div class="chg"><span class="chg-val ${dir(volDiff)}">${arr(volDiff)} ${sgn(volDiff)}${N(Math.abs(volDiff))}조원 (${sgn(volPct)}${N(volPct)}%)</span></div>` : '<span class="neu">―</span>'}</td><td class="bi">${rn.volume || '일중 누적'}</td></tr>`
        : ''}
      ${d.vkospi?.today != null
        ? trow(
            d.vkospi.source === 'carry_forward' ? 'VKOSPI (전일값)' : 'VKOSPI (공포지수)',
            d.vkospi,
            N(d.vkospi.today), N(d.vkospi.prev),
            rn.vkospi || (d.vkospi.today > 30 ? '불안심리 고조' : d.vkospi.today > 20 ? '경계' : '안정')
          )
        : ''}
      ${d.marketCap != null
        ? trow(
            'KOSPI 시가총액',
            { diff: d.marketCapDiff, pct: d.marketCapPct },
            N(d.marketCap) + '조원',
            d.prevMarketCap != null ? N(d.prevMarketCap) + '조원' : '―',
            rn.marketCap
          )
        : ''}
    </tbody>
  </table></div>
  ${_buildMarketCards(supply, d.breadth, date, prevMd, dateMd, d.supplyToday, d.supplyHistory)}
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
  <div class="tbl-wrap"><table class="tbl" style="margin-top:6px">
    <colgroup>
      <col style="width:14%"><col style="width:11%"><col style="width:11%">
      <col style="width:9%"><col style="width:12%"><col style="width:43%">
    </colgroup>
    <thead><tr>
      <th class="l">날짜</th><th>KOSPI 종가</th><th>전일比</th><th>등락률</th><th>거래대금</th>
      <th class="l" style="min-width:120px">주요 이슈</th>
    </tr></thead>
    <tbody>${histRows || '<tr><td colspan="6" style="text-align:center;color:#bbb;padding:12px">데이터 없음</td></tr>'}</tbody>
  </table></div>
</div>

<!-- ══ 3. 해외 증시 ══ -->
<div class="sec">
  <div class="sec-title">해외 증시</div>
  <div class="tbl-wrap"><table class="tbl">
    <thead><tr><th class="l">구분</th><th>전일(${dateMd}) 종가</th><th>전전일(${prevMd}) 종가</th><th>변동</th><th class="l">비고</th></tr></thead>
    <tbody>
      ${trow('다우존스',               o.dow,    N(o.dow?.today),    N(o.dow?.prev),    rn.dow)}
      ${trow('S&amp;P 500',            o.sp500,  N(o.sp500?.today),  N(o.sp500?.prev),  rn.sp500)}
      ${trow('나스닥',                 o.nasdaq, N(o.nasdaq?.today), N(o.nasdaq?.prev), rn.nasdaq)}
      ${trow('필라델피아 반도체(SOX)', o.sox,    N(o.sox?.today),    N(o.sox?.prev),    rn.sox)}
      ${trow('닛케이225',              o.nikkei, N(o.nikkei?.today), N(o.nikkei?.prev), rn.nikkei)}
      ${o.dax?.today != null ? trow('DAX (독일)', o.dax, N(o.dax?.today), N(o.dax?.prev)) : ''}
      ${trow('항셍지수',               o.hsi,    N(o.hsi?.today),    N(o.hsi?.prev),    rn.hsi)}
    </tbody>
  </table></div>
</div>

<!-- ══ 4. 환율 · 금리 ══ -->
<div class="sec">
  <div class="sec-title">환율 · 금리</div>
  <div class="tbl-wrap"><table class="tbl">
    <thead><tr><th class="l">구분</th><th>당일(${dateMd})</th><th>전일(${prevMd})</th><th>변동</th><th class="l">비고</th></tr></thead>
    <tbody>
      ${trow('원/달러 환율',    fx.usdKrw, NI(fx.usdKrw?.today) + '원', NI(fx.usdKrw?.prev) + '원', rn.usdKrw)}
      ${trow('달러 인덱스',     fx.dxy,    N(fx.dxy?.today),             N(fx.dxy?.prev),             rn.dxy)}
      ${trow('미 국채 10년물',  fx.us10y,  N(fx.us10y?.today) + '%',     N(fx.us10y?.prev) + '%',     rn.us10y)}
      ${fx.us2y?.today != null ? trow('미 국채 2년물', fx.us2y, N(fx.us2y?.today) + '%', N(fx.us2y?.prev) + '%', rn.us2y || '단기금리 — 연준 정책 민감') : ''}
      ${(() => {
        const f = fx.fomc ?? {};
        const fRow = (lbl, today, prev, note) => {
          const diff = today != null && prev != null ? r2(today - prev) : null;
          const chg = diff == null ? '<span class="neu">―</span>'
            : `<span class="${dir(diff)}">${sgn(diff)}${N(Math.abs(diff))}%p</span>`;
          return `<tr><td>${lbl}</td><td class="r">${today ?? 'N/A'}%</td><td class="r">${prev != null ? prev + '%' : '―'}</td><td class="r">${chg}</td><td class="bi">${note}</td></tr>`;
        };
        return [
          fRow('6월 FOMC 동결확률', f.junHoldPct, f.junHoldPctPrev, 'CME FedWatch'),
          fRow('9월 인하 가능성',   f.sepCutPct,  f.sepCutPctPrev,  'CME FedWatch'),
        ].join('');
      })()}
    </tbody>
  </table></div>
</div>

<!-- ══ 5. 원자재 · 비철금속 ══ -->
<div class="sec">
  <div class="sec-title">원자재 · 비철금속</div>
  <div class="tbl-wrap"><table class="tbl">
    <thead><tr><th class="l">구분</th><th>당일(${dateMd}) 시세</th><th>전일(${prevMd}) 시세</th><th>변동</th><th class="l">비고</th></tr></thead>
    <tbody>
      ${trow('금 (선물, oz)',           c.gold,     '$' + N(c.gold?.today),      '$' + N(c.gold?.prev),        rn.gold    || '안전자산 수요')}
      ${trow('금 (국내 순금 1돈)',      c.goldKrw,  NI(c.goldKrw?.today) + '원', NI(c.goldKrw?.prev) + '원',   '살 때 기준')}
      ${c.silver?.today  != null ? trow('은 (COMEX, oz)',     c.silver,   '$' + N(c.silver?.today),   '$' + N(c.silver?.prev),   '태양광·반도체 수요') : ''}
      ${c.platinum?.today != null ? trow('백금 (COMEX, oz)',  c.platinum, '$' + N(c.platinum?.today), '$' + N(c.platinum?.prev), '귀금속 동조') : ''}
      ${trow('WTI 원유 (bbl)',          c.wti,      '$' + N(c.wti?.today),       '$' + N(c.wti?.prev),         rn.wti     || '')}
      ${trow('구리 (COMEX, lb)',        c.copper,   '$' + N(c.copper?.today),    '$' + N(c.copper?.prev),      rn.copper  || '경기 선행 지표')}
      ${c.aluminum?.today != null ? trow('알루미늄 (LME, t)', c.aluminum, '$' + N(c.aluminum?.today), '$' + N(c.aluminum?.prev), '그린에너지 수요') : ''}
      ${c.zinc?.today != null ? trow('아연 (LME, t)', c.zinc, '$' + N(c.zinc?.today), '$' + N(c.zinc?.prev), '전기차·친환경 도금 수요') : ''}
      ${c.nickel?.today != null ? trow('니켈 (LME, t)', c.nickel, '$' + N(c.nickel?.today), '$' + N(c.nickel?.prev), '배터리 수요 회복') : ''}
    </tbody>
  </table></div>
  <div class="note">※ 은·백금은 Yahoo Finance 선물 기준. 알루미늄·아연·니켈은 LME 참고값. 정확한 공식가는 당일 마감 후 확인 필요.</div>
</div>

${cryptoSection}
${analystSection}

<!-- ══ 6. 주요 뉴스 ══ -->
<div class="sec">
  <div class="sec-title">주요 뉴스</div>
  <div class="tbl-wrap"><table class="ntbl">
    <thead><tr><th class="l" style="width:68px">일자</th><th style="width:64px">구분</th><th class="l" style="width:210px">제목 / 출처</th><th class="l">요약</th></tr></thead>
    <tbody>${newsRows}</tbody>
  </table></div>
</div>

<!-- FOOTER -->
<div class="divider"></div>
<div class="note" style="line-height:1.9">
  출처: Yahoo Finance · 네이버금융 · CoinGecko · DART · CME FedWatch<br>
  본 리포트는 정보 제공 목적이며 투자 권유가 아닙니다.
</div>

</div><!-- /wrap -->

<!-- Chart.js: 브라우저/Notion 전용 (이메일에서는 위 img 폴백 사용) -->
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js"></script>
${chartScript}
</body></html>`;
}

// ── 내부 헬퍼 ────────────────────────────────────────────────────────────────

// TF findings의 source_url·중요도를 기준으로 원시 뉴스를 재정렬.
// findings가 없으면 카테고리 순서(기존 동작)를 유지.
function _reorderNewsByTF(rawNews, tfFindings) {
  if (!tfFindings?.length) return rawNews;
  const importanceMap = new Map();
  tfFindings.forEach(f => {
    const url = f.source_url ?? f.url;
    if (url && !importanceMap.has(url)) importanceMap.set(url, f.importance ?? 0);
  });
  if (!importanceMap.size) return rawNews;
  const NEWS_CAT_ORDER = ['시장전반', '거시경제', '산업·기업'];
  return [...rawNews].sort((a, b) => {
    const ia = importanceMap.get(a.url) ?? -1;
    const ib = importanceMap.get(b.url) ?? -1;
    if (ib !== ia) return ib - ia;
    const oa = NEWS_CAT_ORDER.indexOf(a.category);
    const ob = NEWS_CAT_ORDER.indexOf(b.category);
    return (oa === -1 ? 99 : oa) - (ob === -1 ? 99 : ob);
  });
}

// KOSPI 5거래일 추이 — 날짜별 주요 이슈 한 줄 생성 (±1.5% 이상 변동일 위주)
async function _buildHistIssues(histDisp, histAll, tfResults) {
  if (!histDisp?.length) return {};
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) return {};

  const themes  = tfResults?.news?.themes    ?? [];
  const stories = tfResults?.news?.top_stories ?? [];

  // 직전 종가 계산 (diff/pct 없는 histDisp row 보완)
  const rows = histDisp.map((h, i) => {
    const prev = i === 0
      ? (histAll?.length > histDisp.length ? histAll[histAll.length - histDisp.length - 1] : null)
      : histDisp[i - 1];
    const diff = prev?.close != null ? r2(h.close - prev.close) : null;
    const pct  = diff != null && prev.close ? r2(diff / prev.close * 100) : null;
    return { date: h.date, close: h.close, diff, pct };
  });

  // 데이터 기반 폴백: 등락률 계산 결과를 그대로 표시
  const dataFallback = {};
  rows.forEach(r => {
    if (r.pct != null) {
      const absP = Math.abs(r.pct);
      dataFallback[r.date] = absP < 0.3 ? '보합권 횡보' :
        absP >= 1.5 ? `${r.pct >= 0 ? '+' : ''}${r.pct.toFixed(2)}% 대폭 ${r.pct >= 0 ? '상승' : '하락'}` :
        `${r.pct >= 0 ? '+' : ''}${r.pct.toFixed(2)}% ${r.pct >= 0 ? '소폭 상승' : '소폭 하락'}`;
    }
  });

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: process.env.GEMINI_MODEL ?? 'gemini-2.5-flash' });
    const res = await model.generateContent(`다음 KOSPI 5거래일 종가에서 각 날짜의 주요 시장 이슈를 한 줄로 작성하세요.
- 모든 날짜에 간결한 시장 상황을 기재 (15~30자)
- 큰 변동(±1.5% 이상)은 원인을 구체적으로 (예: "외인 매도·달러 강세 압박")
- 소폭 변동(±0.5% 미만)은 "보합권 횡보" 또는 당일 가장 이슈가 된 뉴스 한 줄
- 오늘 시장 테마: ${themes.join(', ')}
- 최근 핵심 뉴스: ${stories.slice(0, 2).join(' / ')}

KOSPI 데이터:
${JSON.stringify(rows, null, 2)}

반드시 JSON만 응답 (키는 MM/DD 형식): {"05/07":"외인 순매도 확대","05/08":"FOMC 의사록 대기 보합", ...}`);
    const raw = res.response.text().replace(/^```json\s*/, '').replace(/```\s*$/, '').trim();
    return { ...dataFallback, ...JSON.parse(raw) };
  } catch (e) {
    console.warn('[designer] histIssues Gemini 실패 — 데이터 기반 폴백 사용:', e.message);
    return dataFallback;
  }
}

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

// 데이터만으로 비고 열 생성 (AI 없음, 항상 작동)
function _buildRowNotesFallback(d, o, fx, c) {
  const p2   = v => v?.pct != null ? `${v.pct >= 0 ? '+' : ''}${Number(v.pct).toFixed(2)}%` : '';
  const dir  = v => v?.pct != null ? (v.pct > 0.3 ? '↑' : v.pct < -0.3 ? '↓' : '→') : '';
  const join = (...parts) => parts.filter(Boolean).join(' ');

  // VKOSPI 레벨 해석
  const vk     = d?.vkospi?.today;
  const vkLbl  = vk == null ? '' : vk > 30 ? '불안심리 고조' : vk > 25 ? '경계 수준' : vk > 20 ? '관심 필요' : '안정권';

  // 수급 최신 1일 (supplyHistory 마지막 항목)
  const latestSup  = d?.supplyHistory?.at(-1) ?? null;
  const supNote    = latestSup ? (() => {
    const f = latestSup.foreign;
    if (f == null) return '';
    const absF = Math.abs(f);
    const unit = absF >= 1000 ? `${(absF / 1000).toFixed(1)}천억` : `${Math.round(absF)}억`;
    return `외인 ${f >= 0 ? '+' : '-'}${unit}`;
  })() : '';

  // 환율 레벨
  const krwLvl = fx?.usdKrw?.today != null
    ? `${Math.round(fx.usdKrw.today).toLocaleString('ko-KR')}원` : '';

  return {
    kospi:    join(dir(d?.kospi), p2(d?.kospi), supNote),
    kosdaq:   join(dir(d?.kosdaq), p2(d?.kosdaq)),
    vkospi:   vk != null ? `${vk} — ${vkLbl}` : '',
    volume:   d?.volumeBn != null ? `${d.volumeBn.toFixed(1)}조원 거래` : '',
    marketCap: '',
    dow:      join(dir(o?.dow),    p2(o?.dow)),
    sp500:    join(dir(o?.sp500),  p2(o?.sp500)),
    nasdaq:   join(dir(o?.nasdaq), p2(o?.nasdaq)),
    sox:      join(dir(o?.sox),    p2(o?.sox)),
    nikkei:   join(dir(o?.nikkei), p2(o?.nikkei)),
    hsi:      join(dir(o?.hsi),    p2(o?.hsi)),
    usdKrw:   join(krwLvl, dir(fx?.usdKrw)),
    dxy:      fx?.dxy?.today != null ? `${fx.dxy.today.toFixed(2)} ${dir(fx.dxy)}`.trim() : '',
    us10y:    fx?.us10y?.today != null ? `${fx.us10y.today.toFixed(2)}% 수익률` : '',
    us2y:     fx?.us2y?.today  != null ? `${fx.us2y.today.toFixed(2)}%` : '',
    gold:     join(c?.gold?.today  != null ? `$${Number(c.gold.today).toFixed(0)}/oz` : '', dir(c?.gold), '안전자산'),
    wti:      join(c?.wti?.today   != null ? `$${Number(c.wti.today).toFixed(1)}/bbl` : '', dir(c?.wti)),
    copper:   join(c?.copper?.today != null ? `$${Number(c.copper.today).toFixed(2)}/lb` : '', dir(c?.copper), '경기선행'),
  };
}

async function _buildRowNotes(pipelineData, tfResults = {}) {
  const { domestic: d, overseas: o, fxRates: fx, commodities: c } = pipelineData ?? {};
  const fallback = _buildRowNotesFallback(d, o, fx, c);

  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) return fallback;

  try {
    const themes  = tfResults?.news?.themes    ?? [];
    const stories = (tfResults?.news?.top_stories ?? []).slice(0, 3);

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: process.env.GEMINI_MODEL ?? 'gemini-2.5-flash' });

    const prompt = `다음 시장 데이터를 보고 각 항목의 "비고" 컬럼 설명을 작성하세요.
오늘 시장 주요 테마: ${themes.join(', ') || '없음'}
오늘 핵심 뉴스: ${stories.join(' / ') || '없음'}

규칙:
- 단순 방향(상승/하락)이 아닌 배경·원인을 기재 (예: "반도체 수출↑ 주도", "달러 강세 압박", "FOMC 금리 동결 기대")
- 각 항목 50자 이내 (한국어 기준)
- 수치(등락폭, 환율 레벨, 금리 bp)와 원인 키워드를 함께 기재 (예: "미 CPI 둔화 → 달러 약세 반영, 1,370원대 지지", "외인 3일 연속 순매수·반도체 주도")
- 데이터 없는 항목은 빈 문자열("")

데이터:
${JSON.stringify({
  kospi:    d?.kospi,
  kosdaq:   d?.kosdaq,
  vkospi:   d?.vkospi,
  volumeBn: d?.volumeBn,
  dow:      o?.dow,
  sp500:    o?.sp500,
  nasdaq:   o?.nasdaq,
  sox:      o?.sox,
  nikkei:   o?.nikkei,
  hsi:      o?.hsi,
  usdKrw:   fx?.usdKrw,
  dxy:      fx?.dxy,
  us10y:    fx?.us10y,
  gold:     c?.gold,
  wti:      c?.wti,
  copper:   c?.copper,
}, null, 2)}

반드시 아래 JSON 형식으로만 응답 (마크다운 코드블록 없이):
{"kospi":"...","kosdaq":"...","vkospi":"...","volume":"...","marketCap":"","dow":"...","sp500":"...","nasdaq":"...","sox":"...","nikkei":"...","hsi":"...","usdKrw":"...","dxy":"...","us10y":"...","us2y":"...","gold":"...","wti":"...","copper":"..."}`;

    const res = await model.generateContent(prompt);
    const raw = res.response.text().replace(/^```json\s*/, '').replace(/```\s*$/, '').trim();
    return { ...fallback, ...JSON.parse(raw) };
  } catch (e) {
    console.warn('[designer] rowNotes Gemini 실패 — 데이터 기반 폴백 사용:', e.message);
    return fallback;
  }
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


// ── 이메일 카드 빌더 (Morning Brew / The Hustle 스타일 대시보드 뉴스레터) ─────
// Gmail 호환: 인라인 스타일 전용, CSS 변수·table 태그·style 블록 금지
// 최대 너비 600px, 배경 카드 컬러링으로 등락 방향 즉시 인지

export function buildEmailCard(pipelineData, tfResults, editorialPlan, reportUrl) {
  const d  = pipelineData?.domestic    ?? {};
  const o  = pipelineData?.overseas    ?? {};
  const fx = pipelineData?.fxRates     ?? {};
  const c  = pipelineData?.commodities ?? {};
  const cr = pipelineData?.crypto      ?? {};
  const dateStr = pipelineData?.date ?? new Date(Date.now() + 9*60*60*1000).toISOString().slice(0,10);

  // ── 날짜 표기 ──────────────────────────────────────────────────────────────
  const dtObj     = new Date(dateStr + 'T00:00:00+09:00');
  const pad       = n => String(n).padStart(2,'0');
  const KO        = ['일','월','화','수','목','금','토'];
  const MM        = pad(dtObj.getMonth()+1);
  const DD        = pad(dtObj.getDate());
  const dateLabel = `${dtObj.getFullYear()}.${MM}.${DD} (${KO[dtObj.getDay()]})`;
  const baseMd    = `${MM}/${DD}`;

  // ── 상수 ───────────────────────────────────────────────────────────────────
  const FONT = "'Apple SD Gothic Neo','Malgun Gothic','Noto Sans KR',sans-serif";

  // ── 데이터 헬퍼 ────────────────────────────────────────────────────────────
  const dir  = v => v == null ? 'neu' : v > 0 ? 'up' : v < 0 ? 'down' : 'neu';
  const fmtI = v => v == null ? 'N/A' : Math.round(v).toLocaleString('ko-KR');
  const fmt2 = v => v == null ? 'N/A' : Number(v).toLocaleString('ko-KR',{minimumFractionDigits:2,maximumFractionDigits:2});
  const ar   = v => v == null ? '―' : v > 0 ? '▲' : v < 0 ? '▼' : '―';
  const sg   = v => v > 0 ? '+' : '';

  // arrowStr: ▲ +73.22 / ▼ −11.29
  const arrowStr = diff => diff == null ? '―' : `${ar(diff)}&nbsp;${sg(diff)}${fmt2(Math.abs(diff))}`;
  // pctStr: (+0.96%) / (−0.96%)
  const pctStr   = pct  => pct  == null ? ''  : `(${sg(pct)}${fmt2(pct)}%)`;

  // ── 섹션 구분선 ────────────────────────────────────────────────────────────
  const DIVIDER = `<div style="height:1px;background:#f0f2f5"></div>`;

  // ── 섹션 헤더 헬퍼 ─────────────────────────────────────────────────────────
  const secHdr = (emoji, title, meta) =>
    `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:16px">
      <tr>
        <td style="white-space:nowrap;vertical-align:middle;padding-right:8px">
          <span style="font-size:13px;font-weight:700;color:#1a1f2e;font-family:${FONT}">${emoji} ${title}</span>
        </td>
        <td width="100%" style="vertical-align:middle">
          <div style="height:1px;background:#e8eaed"></div>
        </td>
        ${meta ? `<td style="white-space:nowrap;vertical-align:middle;padding-left:8px">
          <span style="font-size:11px;color:#9aa0ab;font-family:${FONT}">${meta}</span>
        </td>` : ''}
      </tr>
    </table>`;

  // ── 카드 컴포넌트 헬퍼 ─────────────────────────────────────────────────────
  // direction: 'up' | 'down' | 'neu'
  const indexCard = (label, valueStr, aStr, pStr, direction, valueFontSize) => {
    const fs    = valueFontSize || '22px';
    const bg    = direction === 'up'   ? '#fff8f8' : direction === 'down' ? '#f0f5ff' : '#f8f9fb';
    const bdr   = direction === 'up'   ? '#ffd6d6' : direction === 'down' ? '#c7d9ff' : '#e8eaed';
    const color = direction === 'up'   ? '#E24B4A' : direction === 'down' ? '#378ADD' : '#888888';
    return `<div style="width:100%;min-height:88px;box-sizing:border-box;background:${bg};border:1px solid ${bdr};border-radius:10px;padding:14px 16px">
      <div style="font-size:11px;font-weight:600;color:#6b7280;margin-bottom:6px;font-family:${FONT}">${label}</div>
      <div style="font-size:${fs};font-weight:700;color:#1a1f2e;margin-bottom:5px;line-height:1.1;font-family:${FONT}">${valueStr}</div>
      <div style="font-size:12px;font-weight:500;color:${color};font-family:${FONT}">${aStr}&nbsp;${pStr}</div>
    </div>`;
  };

  // ── 카드 행 헬퍼 (table 기반, 이메일 클라이언트 호환) ─────────────────────
  const cardRow2 = (cards, mb = '10px') => {
    const c0 = cards[0] ?? '';
    const c1 = cards[1] ?? '';
    return `<table width="100%" cellpadding="0" cellspacing="0" border="0"${mb ? ` style="margin-bottom:${mb}"` : ''}>
      <tr>
        <td width="50%" style="vertical-align:top;padding-right:5px">${c0}</td>
        <td width="50%" style="vertical-align:top;padding-left:5px">${c1}</td>
      </tr>
    </table>`;
  };

  const cardRow3 = (cards, mb = '10px') => {
    const c0 = cards[0] ?? '';
    const c1 = cards[1] ?? '';
    const c2 = cards[2] ?? '';
    return `<table width="100%" cellpadding="0" cellspacing="0" border="0"${mb ? ` style="margin-bottom:${mb}"` : ''}>
      <tr>
        <td width="33%" style="vertical-align:top;padding-right:5px">${c0}</td>
        <td width="34%" style="vertical-align:top;padding-left:5px;padding-right:5px">${c1}</td>
        <td width="33%" style="vertical-align:top;padding-left:5px">${c2}</td>
      </tr>
    </table>`;
  };

  // ── 1. 헤더 ────────────────────────────────────────────────────────────────
  const headerHtml = `<div style="background:#1a1f2e;padding:0 24px">
  <div style="border-top:3px solid #E24B4A;padding:20px 0 18px">
    <table width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr>
        <td style="vertical-align:bottom">
          <div style="color:#fff;font-size:18px;font-weight:700;font-family:${FONT}">일일 시장 리포트</div>
          <div style="color:#8892a4;font-size:11px;margin-top:4px;font-family:${FONT}">Korea Market Daily</div>
        </td>
        <td style="vertical-align:bottom;text-align:right">
          <div style="color:#e8eaed;font-size:13px;font-weight:600;font-family:${FONT}">${dateLabel}</div>
          <div style="color:#8892a4;font-size:11px;margin-top:3px;font-family:${FONT}">장 마감 기준</div>
        </td>
      </tr>
    </table>
  </div>
</div>`;

  // ── 2. 증시 섹션 (2열 2행: KOSPI·KOSDAQ / S&P 500·NASDAQ) ─────────────────
  const mktDefs = [
    { label: 'KOSPI',   obj: d.kospi,  valFn: v => fmtI(v) },
    { label: 'KOSDAQ',  obj: d.kosdaq, valFn: v => fmtI(v) },
    { label: 'S&P 500', obj: o.sp500,  valFn: v => fmt2(v) },
    { label: 'NASDAQ',  obj: o.nasdaq, valFn: v => fmt2(v) },
  ];
  const mkCard = m => m.obj?.today != null
    ? indexCard(m.label, m.valFn(m.obj.today), arrowStr(m.obj.diff), pctStr(m.obj.pct), dir(m.obj.diff), '22px')
    : '';
  const mktRow1 = [mkCard(mktDefs[0]), mkCard(mktDefs[1])];
  const mktRow2 = [mkCard(mktDefs[2]), mkCard(mktDefs[3])];
  const hasMkt  = mktRow1.some(Boolean) || mktRow2.some(Boolean);
  const hasMktR2 = mktRow2.some(Boolean);

  const mktSection = hasMkt ? `<div style="padding:20px 24px 16px">
  ${secHdr('📊', '증시', `${baseMd} 종가`)}
  ${mktRow1.some(Boolean) ? cardRow2(mktRow1, hasMktR2 ? '10px' : '0') : ''}
  ${hasMktR2 ? cardRow2(mktRow2, '0') : ''}
</div>` : '';

  // ── 3. 환율·원자재 섹션 (3열 2행 고정) ─────────────────────────────────────
  // Row 1: 달러/원, 금, 은  |  Row 2: 구리, WTI, DXY
  // 데이터 없는 칸은 빈 문자열 → 빈 <td>로 유지해 열 너비가 흔들리지 않음
  const calcPct = (diff, today) =>
    diff != null && today ? diff / today * 100 : null;

  const fxMk = (label, val, diff, today, fs = '18px') =>
    val != null
      ? indexCard(label, val, arrowStr(diff), pctStr(calcPct(diff, today)), dir(diff), fs)
      : '';

  const fxCards1 = [
    fxMk('달러/원', fx.usdKrw?.today != null ? fmtI(fx.usdKrw.today)+'원' : null, fx.usdKrw?.diff, fx.usdKrw?.today),
    fxMk('금 (oz)',  c.gold?.today   != null ? '$'+fmt2(c.gold.today)   : null, c.gold?.diff,   c.gold?.today),
    fxMk('은 (oz)',  c.silver?.today != null ? '$'+fmt2(c.silver.today) : null, c.silver?.diff, c.silver?.today),
  ];
  const fxCards2 = [
    fxMk('구리 (lb)', c.copper?.today != null ? '$'+fmt2(c.copper.today) : null, c.copper?.diff, c.copper?.today),
    fxMk('WTI (bbl)', c.wti?.today   != null ? '$'+fmt2(c.wti.today)    : null, c.wti?.diff,    c.wti?.today),
    fxMk('DXY',       fx.dxy?.today  != null ? fmt2(fx.dxy.today)       : null, fx.dxy?.diff,   fx.dxy?.today),
  ];
  const hasFxR1 = fxCards1.some(Boolean);
  const hasFxR2 = fxCards2.some(Boolean);

  const fxSection = (hasFxR1 || hasFxR2) ? `<div style="padding:16px 24px">
  ${secHdr('💱', '환율 · 원자재', `${baseMd} 기준`)}
  ${hasFxR1 ? cardRow3(fxCards1, hasFxR2 ? '10px' : '0') : ''}
  ${hasFxR2 ? cardRow3(fxCards2, '0') : ''}
</div>` : '';

  // ── 4. 코인 섹션 (3열 1행 고정) ───────────────────────────────────────────
  const btc   = cr.btc ?? null;
  const eth   = cr.eth ?? null;
  const top10 = (cr.top10 ?? []).filter(x => !['BTC','ETH'].includes(x.symbol?.toUpperCase())).slice(0,1);

  const mkCoinCard = (sym, price, chg) => {
    const chgStr = chg != null ? `${ar(chg)}&nbsp;${sg(chg)}${fmt2(Math.abs(chg))}%` : '―';
    return indexCard(sym, price != null ? '$'+fmtI(price) : 'N/A', chgStr, '', dir(chg), '18px');
  };
  const coinCards3 = [
    btc      ? mkCoinCard('BTC', btc.price, btc.change24h)                             : '',
    eth      ? mkCoinCard('ETH', eth.price, eth.change24h)                             : '',
    top10[0] ? mkCoinCard(top10[0].symbol ?? '―', top10[0].priceUsd, top10[0].change24h) : '',
  ];

  const coinSection = coinCards3.some(Boolean) ? `<div style="padding:16px 24px">
  ${secHdr('₿', '코인', '24h 변동')}
  ${cardRow3(coinCards3, '0')}
</div>` : '';

  // ── 0. 시장 요약 섹션 (Gemini 결과 있을 때만 표시) ───────────────────────
  const summaryBullets = editorialPlan?.summary_bullets ?? [];
  const topStories     = tfResults?.news?.top_stories   ?? [];
  const themes         = tfResults?.news?.themes        ?? [];

  let summarySection = '';
  const summaryLines = summaryBullets.length ? summaryBullets
    : topStories.length ? topStories
    : [];

  if (summaryLines.length) {
    const bullets = summaryLines.map(s =>
      `<table cellpadding="0" cellspacing="0" border="0" style="width:100%;margin-bottom:9px">
        <tr>
          <td style="vertical-align:top;padding-right:8px;white-space:nowrap;color:#2563eb;font-size:14px;line-height:1.6;font-family:${FONT}">•</td>
          <td style="font-size:13px;color:#2d3748;line-height:1.65;font-family:${FONT}">${String(s).replace(/^[•·\-]\s*/,'')}</td>
        </tr>
      </table>`
    ).join('');

    const themePills = themes.length
      ? `<div style="margin-top:12px">${
          themes.map(t => `<span style="display:inline-block;background:#eff6ff;color:#2563eb;font-size:11px;font-weight:600;padding:3px 9px;border-radius:20px;font-family:${FONT};margin:0 3px 3px 0">${t}</span>`).join('')
        }</div>`
      : '';

    summarySection = `<div style="padding:20px 24px 16px;background:#f8faff;border-bottom:1px solid #e0eaff">
  ${secHdr('💡', '오늘의 시장 요약')}
  ${bullets}${themePills}
</div>`;
  }

  // ── 5. 뉴스 섹션 ──────────────────────────────────────────────────────────
  const rawFindings = tfResults?.news?.findings ?? [];
  const rawNews     = pipelineData?.news        ?? [];

  let newsItems = [];
  if (rawFindings.length) {
    const seen    = new Set();
    const ordered = [...rawFindings].sort((a,b) => (b.importance??0)-(a.importance??0));
    for (const f of ordered) {
      if (newsItems.length >= 6) break;
      const theme = f.theme ?? f.category ?? '';
      if (!seen.has(theme)) { seen.add(theme); newsItems.push(f); }
    }
    for (const f of ordered) {
      if (newsItems.length >= 6) break;
      if (!newsItems.includes(f)) newsItems.push(f);
    }
    const urlToTitle = new Map(rawNews.map(n => [n.url, n.title]));
    newsItems = newsItems.map(f => {
      const origTitle = (f.source_url && urlToTitle.get(f.source_url)) ?? null;
      return {
        category: f.theme ?? f.category ?? '시장전반',
        title: origTitle ?? f.headline ?? f.title ?? '',
        summary: Array.isArray(f.summary) ? f.summary
          : (f.market_impact ? [f.market_impact] : []),
        url: f.source_url ?? null,
      };
    });
  } else if (rawNews.length) {
    newsItems = rawNews.slice(0,6).map(n => ({ category: n.category ?? '시장전반', title: n.title ?? '', summary: [], url: n.url ?? null }));
  }

  // 뉴스 태그 색상
  const chipStyle = cat => {
    const s = cat ?? '';
    if (s.includes('반도체') || s.includes('기술') || s.includes('AI') || s.includes('테크'))
      return { bg: '#f5f3ff', txt: '#7c3aed' };
    if (s.includes('산업') || s.includes('기업') || s.includes('종목'))
      return { bg: '#f0fdf4', txt: '#16a34a' };
    if (s.includes('거시') || s.includes('금리') || s.includes('환율') || s.includes('연준') || s.includes('FOMC'))
      return { bg: '#fffbeb', txt: '#d97706' };
    if (s.includes('지정학') || s.includes('정치') || s.includes('무역') || s.includes('관세'))
      return { bg: '#fff1f2', txt: '#e11d48' };
    if (s.includes('코인') || s.includes('블록') || s.includes('가상'))
      return { bg: '#ecfeff', txt: '#0891b2' };
    return { bg: '#eff6ff', txt: '#2563eb' };
  };

  // Gmail 호환: CSS line-clamp 미지원 → JS에서 직접 truncate
  const truncateTitle = (str, max = 60) => {
    if (!str) return '제목 없음';
    return str.length > max ? str.slice(0, max).trimEnd() + '…' : str;
  };

  const newsRows = newsItems.map((n, i) => {
    const chip    = chipStyle(n.category);
    const isLast  = i === newsItems.length - 1;
    const title   = truncateTitle(n.title, 60);
    const bullets = (n.summary ?? []).filter(Boolean);
    const summaryHtml = bullets.length
      ? bullets.map(b =>
          `<div style="font-size:11px;color:#374151;line-height:1.6;font-family:${FONT}">${String(b).startsWith('•') ? b : '• ' + b}</div>`
        ).join('')
      : `<div style="min-height:14px"></div>`;
    return `<div style="padding:12px 0;box-sizing:border-box;${isLast ? '' : 'border-bottom:1px solid #f0f2f5'}">
      <div style="margin-bottom:5px">
        <span style="display:inline-block;background:${chip.bg};color:${chip.txt};font-size:10px;font-weight:600;padding:2px 7px;border-radius:4px;margin-right:7px;font-family:${FONT}">${n.category}</span>
      </div>
      ${n.url
        ? `<a href="${n.url}" target="_blank" rel="noopener" style="display:block;text-decoration:none;font-size:13px;font-weight:500;color:#1a1f2e;line-height:1.55;font-family:${FONT};margin-bottom:5px">${title}</a>`
        : `<div style="font-size:13px;font-weight:500;color:#1a1f2e;line-height:1.55;font-family:${FONT};margin-bottom:5px">${title}</div>`
      }
      ${summaryHtml}
    </div>`;
  }).join('');

  const newsSection = newsItems.length ? `<div style="padding:16px 24px 20px">
  ${secHdr('📰', '주요 뉴스')}
  ${newsRows}
</div>` : '';

  // ── 6. 애널리스트 섹션 ────────────────────────────────────────────────────
  const analystFindings = (tfResults?.analyst?.findings ?? []).slice(0, 3);
  let analystSection = '';
  if (analystFindings.length) {
    const analystRows = analystFindings.map((f, i) => {
      const isLast = i === analystFindings.length - 1;
      const tpPrev = f.target_price?.prev;
      const tpNew  = f.target_price?.new;
      const tpPct  = f.target_price?.change_pct;
      const tpColor = (tpNew != null && tpPrev != null) ? (tpNew > tpPrev ? '#E24B4A' : '#378ADD') : '#1a1f2e';
      const tpStr  = (tpPrev != null && tpNew != null)
        ? `${fmtI(tpPrev)} → <span style="color:${tpColor};font-weight:700">${fmtI(tpNew)}원</span>${tpPct != null ? ` (${tpPct > 0 ? '+' : ''}${fmt2(tpPct)}%)` : ''}`
        : tpNew != null ? `<span style="font-weight:700">${fmtI(tpNew)}원</span>` : '―';
      return `<div style="padding:10px 0;box-sizing:border-box;${isLast ? '' : 'border-bottom:1px solid #f0f2f5'}">
        <table cellpadding="0" cellspacing="0" border="0" style="width:100%">
          <tr>
            <td style="font-size:13px;font-weight:600;color:#1a1f2e;font-family:${FONT}">
              ${f.dart_url
                ? `<a href="${f.dart_url}" target="_blank" style="color:#2563eb;text-decoration:none;font-weight:600;font-family:${FONT}">${f.company ?? '―'}</a>`
                : (f.company ?? '―')}
              <span style="font-size:10px;font-weight:400;color:#6b7280;margin-left:6px">${f.sector ?? ''}</span>
            </td>
            <td style="font-size:11px;color:#6b7280;text-align:right;white-space:nowrap;font-family:${FONT}">${f.firm ?? ''} · ${f.rating_change ?? '―'}</td>
          </tr>
          <tr>
            <td style="font-size:11px;color:#374151;padding-top:4px;font-family:${FONT}">${f.key_thesis ?? ''}</td>
            <td style="font-size:11px;color:#374151;text-align:right;padding-top:4px;white-space:nowrap;font-family:${FONT}">목표가 ${tpStr}</td>
          </tr>
        </table>
      </div>`;
    }).join('');
    analystSection = `<div style="padding:16px 24px 20px">
  ${secHdr('📊', '애널리스트 리포트')}
  ${analystRows}
</div>`;
  }

  // ── 7. CTA 섹션 ────────────────────────────────────────────────────────────
  const url = reportUrl || '#';
  const ctaHtml = `<div style="background:#f8f9fb;padding:20px 24px;text-align:center;border-top:1px solid #edeef0">
  <a href="${url}" target="_blank"
     style="display:inline-block;background:#1a1f2e;color:#fff;font-size:14px;font-weight:600;padding:12px 36px;border-radius:8px;text-decoration:none;font-family:${FONT}">
    전체 리포트 보기 →
  </a>
  <div style="margin-top:14px;font-size:11px;color:#9aa0ab;line-height:1.8;font-family:${FONT}">
    출처: Yahoo Finance · 네이버금융 · CoinGecko<br>
    본 리포트는 정보 제공 목적이며 투자 권유가 아닙니다.
  </div>
</div>`;

  // ── 조립 ───────────────────────────────────────────────────────────────────
  const sections = [
    summarySection,
    mktSection,
    mktSection  && (fxSection || coinSection || newsSection || analystSection) ? DIVIDER : '',
    fxSection,
    fxSection   && (coinSection || newsSection || analystSection)              ? DIVIDER : '',
    coinSection,
    coinSection && (newsSection || analystSection)                             ? DIVIDER : '',
    newsSection,
    newsSection && analystSection                                              ? DIVIDER : '',
    analystSection,
  ].filter(Boolean).join('');

  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>시장 리포트 ${dateStr}</title>
</head>
<body style="margin:0;padding:20px 16px;background:#f0f2f5;font-family:${FONT}">

<div style="max-width:600px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 16px rgba(0,0,0,0.08)">

  ${headerHtml}

  ${sections}

  ${ctaHtml}

</div>

</body>
</html>`;
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
