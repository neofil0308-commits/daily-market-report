// tools/desk/designer.js — DESK HTML 빌더 v2
// 레퍼런스: templates/market_report_reference 기반 완전 재설계
import axios from 'axios';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { logger } from '../../shared/utils/logger.js';

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

// 표 행 헬퍼 (비고 열 없는 버전 — v3부터 기본)
const trow = (lbl, obj, todayStr, prevStr) => `<tr>
  <td>${lbl}</td><td class="r">${todayStr}</td><td class="r">${prevStr}</td>
  <td class="r">${chgCell(obj)}</td>
</tr>`;

// 섹션 Summary 박스 헬퍼
// sectionSummaries 객체에서 해당 키의 텍스트를 받아 박스 HTML 반환.
// 비어있거나 null이면 빈 문자열 반환 (섹션 표 위에 삽입).
const _secSummaryBox = (text, accentColor = '#1e3a8a') => {
  if (!text) return '';
  const bg = accentColor + '08';  // 5% opacity via hex — fallback: always shows as near-white
  return `<div style="background:#fafafa;border-left:3px solid ${accentColor};border-radius:0 4px 4px 0;padding:9px 13px;margin-bottom:10px;line-height:1.65;border:1px solid #cbd5e1;border-left-width:3px">
  <span style="font-size:10px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:${accentColor};display:block;margin-bottom:4px">Summary</span>
  <span style="font-size:12px;color:#0f172a">${text}</span>
</div>`;
};

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
  // 섹션별 Summary 박스 — editor가 채워주는 editorialPlan.sectionSummaries 참조
  const secSum = editorialPlan?.sectionSummaries ?? {};

  const _kimchiPremium = pipelineData?.crypto?.kimchiPremium ?? tfResults?.crypto?.kimchi_premium ?? null;
  const cryptoSection  = editorialPlan.include_crypto
    ? _buildCryptoSection(tfResults.crypto, pipelineData.crypto, secSum.crypto, _kimchiPremium) : '';
  const analystSection = editorialPlan.include_analyst
    ? _buildAnalystSection(tfResults.analyst, tfResults?.analyst?.target_price_changes ?? []) : '';

  const orderedNews = _reorderNewsByTF(news ?? [], tfResults?.news?.findings);

  const html = _assembleHtml({
    date, d, o, fx, c, news: orderedNews,
    histDisp, histAll, chartUrl, chartScript,
    summaryHtml, cryptoSection, analystSection,
    summaryMap, rowNotes, histIssues,
    headline: editorialPlan.headline,
    secSum,
    theme: editorialPlan?.theme ?? 'light',
    conflicts: editorialPlan?.conflicts ?? [],
    targetPriceChanges: tfResults?.analyst?.target_price_changes ?? [],
    kimchiPremium: pipelineData?.crypto?.kimchiPremium ?? tfResults?.crypto?.kimchi_premium ?? null,
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
  const TD = 'font-size:12px;font-weight:700;color:#4b5563;padding:4px 8px 4px 0;white-space:nowrap;';

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

function _buildCryptoSection(tfCrypto, rawCrypto, secSummary = '', kimchiPremium = null) {
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

  const TH  = 'background:rgba(14,116,144,0.05);font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#0e7490;padding:5px 7px;text-align:right;white-space:nowrap;border:1px solid #cbd5e1;font-variant-numeric:tabular-nums';
  const THL = 'background:rgba(14,116,144,0.05);font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#0e7490;padding:5px 7px;text-align:left;white-space:nowrap;border:1px solid #cbd5e1';
  const THC = 'background:rgba(14,116,144,0.05);font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#0e7490;padding:5px 7px;text-align:center;white-space:nowrap;border:1px solid #cbd5e1';
  const TD  = 'padding:4px 7px;border:1px solid #cbd5e1;vertical-align:middle;color:#0f172a;font-size:12px;text-align:right;font-variant-numeric:tabular-nums';
  const TDL = 'padding:4px 7px;border:1px solid #cbd5e1;vertical-align:middle;color:#0f172a;font-size:12px;font-weight:600';
  const TDC = 'padding:4px 7px;border:1px solid #cbd5e1;vertical-align:middle;color:#0f172a;font-size:12px;text-align:center;font-variant-numeric:tabular-nums';

  const chgSpan = (v) => {
    const color = v >= 0 ? COLOR.up : COLOR.dn;
    return `<span style="color:${color}">${arr(v)} ${sgn(v)}${N(Math.abs(v ?? 0))}%</span>`;
  };

  const rows = filteredTop10.map(coin => `
    <tr>
      <td style="${TDC}">${coin.rank}</td>
      <td style="${TDL}">${coin.symbol ?? coin.name}</td>
      <td style="${TD}">$${N(coin.priceUsd)}</td>
      <td style="${TD}">${chgSpan(coin.change24h)}</td>
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
  <div class="sec-title"><span class="sec-eng" style="color:var(--accent-crypto)">DIGITAL ASSETS</span><span class="sec-kor">블록체인 · 코인</span></div>
  ${_secSummaryBox(secSummary, '#0e7490')}
  <div class="tbl-wrap"><table style="width:100%;border-collapse:collapse;font-size:13px">
    <thead><tr>
      <th style="${THC};width:12%">순위</th><th style="${THL};width:23%">심볼</th>
      <th style="${TH};width:35%">시세(USD)</th><th style="${TH};width:30%">24h 변동</th>
    </tr></thead>
    <tbody>
      <tr>
        <td style="${TDC}">${btcEntry.rank}</td><td style="${TDL}">BTC</td>
        <td style="${TD}">$${N(btc?.price)}</td>
        <td style="${TD}">${chgSpan(btc?.change24h)}</td>
      </tr>
      ${eth ? `<tr>
        <td style="${TDC}">${ethEntry.rank}</td><td style="${TDL}">ETH</td>
        <td style="${TD}">$${N(eth?.price)}</td>
        <td style="${TD}">${chgSpan(eth?.change24h)}</td>
      </tr>` : ''}
      ${rows}
    </tbody>
  </table></div>
  ${footerHtml}
  ${(() => {
    if (!kimchiPremium) return '';
    const items = [];
    if (kimchiPremium.btc != null) {
      const v = kimchiPremium.btc;
      const color = v >= 0 ? '#E24B4A' : '#378ADD';
      const label = v < -0.3 ? ' (역프리미엄)' : v > 0.3 ? ' (프리미엄)' : '';
      items.push(`BTC <span style="color:${color}">${v >= 0 ? '+' : ''}${N(v)}%${label}</span>`);
    }
    if (kimchiPremium.eth != null) {
      const v = kimchiPremium.eth;
      const color = v >= 0 ? '#E24B4A' : '#378ADD';
      items.push(`ETH <span style="color:${color}">${v >= 0 ? '+' : ''}${N(v)}%</span>`);
    }
    return items.length ? `<div class="kimchi-box"><strong>김치프리미엄</strong> ${items.join(' · ')}</div>` : '';
  })()}
</div>`;
}

// ── 애널리스트 섹션 ────────────────────────────────────────────────────────────

function _buildAnalystSection(tfAnalyst, targetPriceChanges = []) {
  if (!tfAnalyst?.findings?.length) return '';

  // 목표가 변동 박스 (최대 3건)
  const tpcBox = (() => {
    if (!targetPriceChanges?.length) return '';
    const items = targetPriceChanges.slice(0, 3).map(t => {
      const dir = (t.change_pct ?? 0) >= 0 ? '↑' : '↓';
      const color = (t.change_pct ?? 0) >= 0 ? '#E24B4A' : '#378ADD';
      const pct = t.change_pct != null ? `<span style="color:${color}">${t.change_pct >= 0 ? '+' : ''}${N(t.change_pct)}% ${dir}</span>` : '';
      const firm = t.firm ? ` (${t.firm})` : '';
      return `${t.company ?? '?'} ${pct}${firm}`;
    });
    return `<div class="target-box"><strong>전일 대비 목표가 변동</strong> ${items.join(' · ')}</div>`;
  })();

  const rows = tfAnalyst.findings.slice(0, 5).map(f => {
    const companyHtml = f.dart_url
      ? `<a href="${f.dart_url}" target="_blank" style="color:var(--accent-analyst);text-decoration:none;font-weight:600;border-bottom:1px dotted var(--accent-analyst)">${f.company ?? '―'}</a>`
      : (f.company ?? '―');
    return `
    <tr ${f.importance >= 8 ? 'style="background:#fffbeb"' : ''}>
      <td style="font-weight:500">${companyHtml}</td>
      <td>${f.firm ?? '―'}</td>
      <td class="c" style="white-space:normal">${f.rating_change ?? '―'}</td>
      <td class="r" style="white-space:nowrap">${f.target_price?.new ? NI(f.target_price.new) + '원' : '―'}</td>
      <td class="bi" style="white-space:normal;overflow:visible">${f.key_thesis ?? '―'}</td>
    </tr>`;
  }).join('');
  return `
<div class="sec">
  <div class="sec-title"><span class="sec-eng" style="color:var(--accent-analyst)">ANALYST CONSENSUS</span><span class="sec-kor">애널리스트 리포트</span></div>
  ${tpcBox}
  <div class="tbl-wrap"><table class="tbl s-analyst">
    <thead><tr><th class="l" style="width:22%">종목</th><th class="l" style="width:14%">증권사</th><th style="width:10%">의견</th><th class="r" style="width:14%">목표가</th><th class="l" style="width:40%">핵심 논거</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>
</div>`;
}

// ── 최종 HTML 조립 ────────────────────────────────────────────────────────────

function _assembleHtml({ date, d, o, fx, c, news, histDisp, histAll,
  chartUrl, chartScript, summaryHtml, cryptoSection, analystSection, summaryMap, rowNotes, histIssues = {}, headline, secSum = {}, theme = 'light',
  conflicts = [], targetPriceChanges = [], kimchiPremium = null }) {
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

  // 요일 영문 변환 (헤더 메타 표시용)
  const EN_DAYS = ['SUN','MON','TUE','WED','THU','FRI','SAT'];
  const reportDateObj = new Date(date + 'T00:00:00+09:00');
  const reportDow  = EN_DAYS[reportDateObj.getDay()];
  const reportYear = reportDateObj.getFullYear();
  const reportMM   = String(reportDateObj.getMonth()+1).padStart(2,'0');
  const reportDD   = String(reportDateObj.getDate()).padStart(2,'0');
  const reportDatePrimary = `${reportYear}.${reportMM}.${reportDD}`;
  const reportDateSub     = `${reportDow} · 08:00 KST`;

  return `<!DOCTYPE html>
<html lang="ko"${theme === 'dark' ? ' class="theme-dark"' : ''}><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>시장 리포트 ${date}</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}

/* ── 테마 변수 (라이트 기본 / 다크 모드는 .theme-dark 클래스로 활성화) ── */
:root{
  --fn:'Apple SD Gothic Neo',Pretendard,'Malgun Gothic','Noto Sans KR',-apple-system,sans-serif;
  --up:#E24B4A;--dn:#378ADD;--neu:#888888;

  /* ── 사주 인터뷰 기반 증권사 PDF 톤 (2026-05-16) ── */
  --bg-page:#ffffff;
  --bg-card:#ffffff;
  --bg-subtle:#fafafa;
  --text-primary:#0f172a;
  --text-secondary:#475569;
  --text-tertiary:#94a3b8;
  --border-strong:#cbd5e1;
  --border-soft:#e5e7eb;

  /* 섹션별 액센트 */
  --accent-domestic:#1e3a8a;
  --accent-overseas:#374151;
  --accent-fxrates:#4338ca;
  --accent-commodities:#854d0e;
  --accent-crypto:#0e7490;
  --accent-analyst:#1e3a8a;
  --accent-news:#374151;

  /* 하위 호환 aliases (기존 코드가 참조하는 변수 유지) */
  --color-text-primary:#0f172a;
  --color-text-secondary:#475569;
  --color-text-tertiary:#94a3b8;
  --color-text-info:#1e3a8a;
  --color-text-success:#15803d;
  --color-text-warning:#854d0e;
  --color-background-secondary:#fafafa;
  --color-background-info:rgba(30,58,138,0.05);
  --color-background-success:#f0fdf4;
  --color-background-warning:#fffbeb;
  --color-border-secondary:#cbd5e1;
  --color-border-tertiary:#e5e7eb;
  --color-th-bg:#fafafa;
  --color-th-border:#cbd5e1;
  --color-accent:#1e3a8a;
  --border-radius-md:6px;
}

/* 다크 모드 — editorialPlan.theme==='dark' 시 <html>에 .theme-dark 추가 (Phase 3 활성화용) */
.theme-dark{
  --bg-page:#0b0f1a;
  --bg-card:#131929;
  --bg-subtle:#1a2235;
  --text-primary:#e2e8f0;
  --text-secondary:#94a3b8;
  --text-tertiary:#64748b;
  --border-strong:#1e293b;
  --border-soft:#0f172a;
  --color-text-primary:#e2e8f0;
  --color-text-secondary:#94a3b8;
  --color-text-tertiary:#64748b;
  --color-text-info:#60a5fa;
  --color-text-success:#4ade80;
  --color-text-warning:#fbbf24;
  --color-background-secondary:#1e2740;
  --color-background-info:#1e3a5f;
  --color-background-success:#14532d;
  --color-background-warning:#451a03;
  --color-border-secondary:#1e293b;
  --color-border-tertiary:#0f172a;
  --color-th-bg:#1a2235;
  --color-th-border:#1e293b;
  --color-accent:#60a5fa;
}
.theme-dark body{background:var(--bg-page)}
.theme-dark .wrap{background:var(--bg-card)}

/* ── 폰트 위계 (v6 — 증권사 PDF 격식 + 헤드라인 강화)
   헤드라인       : 28px Bold     letter-spacing -0.01em  line-height 1.3
   섹션 영문      : 11px Bold     letter-spacing 0.15em   uppercase  섹션 액센트 색
   섹션 한글      : 16px Bold     잉크 검정
   표 헤더 (th)   : 10px Bold     letter-spacing 0.08em   uppercase
   표 본문 (td)   : 12px Regular  tabular-nums
   메타 (날짜 등) : 11px Regular  tertiary
   라벨 태그      : 10px Bold     letter-spacing 0.04em
───────────────────────────────── */
body,div,span,td,th,a,p{font-family:var(--fn)!important}
body{font-size:14px;background:var(--bg-page);padding:24px 16px;color:var(--text-primary)}
.wrap{max-width:1100px;margin:0 auto;background:var(--bg-card);border-radius:4px;padding:28px 32px;box-shadow:0 0 0 1px var(--border-strong)}
/* ── 헤더 — 좌/우 듀얼 레이아웃 ── */
.hdr{display:flex;align-items:flex-end;justify-content:space-between;margin-bottom:1.8rem;padding-bottom:14px;border-bottom:2px solid var(--border-strong)}
.hdr-brand{}
.hdr-eng{font-size:11px;font-weight:700;letter-spacing:0.15em;text-transform:uppercase;color:#374151;margin-bottom:3px}
.hdr-kor{font-size:16px;font-weight:700;color:var(--text-primary)}
.hdr-meta{text-align:right}
.hdr-date-primary{font-size:13px;font-weight:700;color:var(--text-primary)}
.hdr-date-sub{font-size:10px;letter-spacing:0.10em;text-transform:uppercase;color:var(--text-secondary);margin-top:2px}
/* ── 헤드라인 블록 ── */
.headline-block{border-left:4px solid #1e3a8a;padding:14px 20px;margin-bottom:1.6rem}
.headline-label{font-size:10px;font-weight:700;letter-spacing:0.15em;text-transform:uppercase;color:#374151;display:block;margin-bottom:6px}
.headline-text{font-size:28px;font-weight:700;color:#0f172a;line-height:1.3;letter-spacing:-0.01em;display:block}
.sec{margin:0 0 1.6rem}
/* 섹션 제목 — 듀얼 표기 (영문 + 한글) */
.sec-title{display:flex;flex-direction:column;gap:2px;border-bottom:2px solid var(--border-strong);padding-bottom:7px;margin-bottom:13px}
.sec-eng{font-size:11px;font-weight:700;letter-spacing:0.15em;text-transform:uppercase}
.sec-kor{font-size:16px;font-weight:700;color:var(--text-primary)}
.tbl-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch}
.tbl{width:100%;border-collapse:collapse;font-size:12px;table-layout:fixed}
.tbl th{font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;padding:5px 7px;border:1px solid var(--border-strong);white-space:nowrap;text-align:center;font-variant-numeric:tabular-nums}
.tbl th.l{text-align:left}
.tbl th.r{text-align:right}
.tbl td{padding:4px 7px;border:1px solid var(--border-strong);color:var(--text-primary);font-size:12px;font-weight:400;vertical-align:middle;line-height:1.5;font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tbl td.r{text-align:right;white-space:nowrap}
.tbl td.c{text-align:center}
/* analyst table — 핵심논거 열은 줄바꿈 허용 */
.s-analyst td.bi{white-space:normal;overflow:visible}
.tbl tr:hover td{background:var(--bg-subtle)}
.chg-val{font-size:12px;font-weight:400;white-space:nowrap;font-variant-numeric:tabular-nums}
.up{color:var(--up)}.dn{color:var(--dn)}.neu{color:var(--neu)}
.bar-row{display:flex;align-items:center;gap:6px;margin-bottom:4px;font-size:12px}
.bar-row .nm{min-width:40px;color:var(--text-secondary)}
.bwrap{flex:1;height:4px;background:var(--border-soft);border-radius:2px}
.bfill{height:100%;border-radius:2px}
.b-buy{background:var(--up)}.b-sell{background:var(--dn)}
.bar-row .val{min-width:90px;text-align:right;font-size:12px;font-variant-numeric:tabular-nums}
.sup-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:10px}
.sup-card{background:var(--bg-subtle);border:1px solid var(--border-strong);border-radius:4px;padding:10px 12px}
.sup-card .st{font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:var(--text-secondary);margin-bottom:7px}
.chart-wrap{position:relative;width:100%;height:220px;margin-bottom:6px}
.summary-box{background:rgba(30,58,138,0.04);border:1px solid rgba(30,58,138,0.18);border-left:3px solid var(--accent-domestic);border-radius:0 4px 4px 0;padding:14px 18px;margin-bottom:1.6rem}
.summary-box .s-title{font-size:10px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:var(--accent-domestic);margin-bottom:10px}
.s-badge{display:inline-block;font-size:10px;font-weight:700;background:var(--accent-domestic);color:#fff;padding:2px 7px;border-radius:3px}
.ntbl{width:100%;border-collapse:collapse;font-size:12px;table-layout:fixed}
.ntbl th{font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;padding:5px 7px;border:1px solid var(--border-strong);text-align:center;font-variant-numeric:tabular-nums}
.ntbl th.l{text-align:left}
.ntbl td{padding:6px 7px;border:1px solid var(--border-strong);vertical-align:top;font-weight:400;color:var(--text-primary);overflow:hidden;text-overflow:ellipsis}
.td-ttl,.td-sum{white-space:normal;overflow:visible;text-overflow:clip}
.td-date{white-space:nowrap;font-size:11px;color:var(--text-tertiary);min-width:62px;font-variant-numeric:tabular-nums}
.td-cat{white-space:nowrap;min-width:60px;text-align:center;font-variant-numeric:tabular-nums}
.td-ttl{min-width:180px;max-width:300px}
.td-ttl a{color:var(--accent-news);text-decoration:none;font-size:12px;line-height:1.45;font-weight:400}
.td-ttl a:hover{text-decoration:underline}
.td-src{font-size:10px;color:var(--text-tertiary);margin-top:3px}
.td-sum{font-size:11px;color:var(--text-secondary);line-height:1.65}
.tag{display:inline-block;font-size:10px;font-weight:700;letter-spacing:0.04em;padding:2px 6px;border-radius:3px;text-transform:none}
.t-mkt{background:rgba(30,58,138,0.08);color:var(--accent-domestic)}
.t-corp{background:#f0fdf4;color:#15803d}
.t-mac{background:#fffbeb;color:var(--accent-commodities)}
.note{font-size:11px;color:var(--text-tertiary);margin-top:5px;line-height:1.7}
.divider{height:1px;background:var(--border-strong);margin:1.6rem 0}
/* ── 섹션별 th 액센트 색 (표 헤더 텍스트만, 배경은 --bg-subtle 공통) ── */
.tbl th{background:var(--bg-subtle);color:var(--text-secondary)}
.s-domestic  th{background:rgba(30,58,138,0.04);color:var(--accent-domestic)}
.s-overseas  th{background:rgba(55,65,81,0.04);color:var(--accent-overseas)}
.s-fxrates   th{background:rgba(67,56,202,0.04);color:var(--accent-fxrates)}
.s-commodities th{background:rgba(133,77,14,0.04);color:var(--accent-commodities)}
.s-crypto    th{background:rgba(14,116,144,0.04);color:var(--accent-crypto)}
.s-analyst   th{background:rgba(30,58,138,0.04);color:var(--accent-analyst)}
.s-news      th{background:rgba(55,65,81,0.04);color:var(--accent-news)}
/* ── 새 데이터 박스 ── */
.conflict-box{background:#fff7ed;border:1px solid #fdba74;border-left:3px solid #ea580c;border-radius:0 4px 4px 0;padding:8px 13px;margin-bottom:14px;font-size:12px;color:#9a3412;line-height:1.6}
.kimchi-box{background:rgba(14,116,144,0.05);border:1px solid rgba(14,116,144,0.25);border-left:3px solid var(--accent-crypto);border-radius:0 4px 4px 0;padding:7px 13px;margin-bottom:10px;font-size:12px;color:var(--accent-crypto);line-height:1.6}
.target-box{background:rgba(30,58,138,0.04);border:1px solid rgba(30,58,138,0.18);border-left:3px solid var(--accent-domestic);border-radius:0 4px 4px 0;padding:7px 13px;margin-bottom:10px;font-size:12px;color:var(--accent-domestic);line-height:1.6}

/* ── 풋터 섹션 ── */
.report-footer{background:#fafafa;border-top:1px solid var(--border-strong);padding:20px 24px;margin-top:1.6rem}
.footer-label{font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#374151;display:block;margin-bottom:4px}
.footer-text{font-size:11px;color:var(--text-secondary);line-height:1.8}
.footer-block{margin-bottom:14px}
.footer-block:last-child{margin-bottom:0}

/* ── 모바일 (900px) ── */
@media(max-width:900px){
  .wrap{padding:24px 20px}
  .td-sum{display:none}
}

/* ── 모바일 (600px) — 표 카드형 변환 + 가로 스크롤 폴백 ── */
@media(max-width:600px){
  body{padding:8px 6px}
  .wrap{padding:14px 12px;border-radius:0;box-shadow:none}
  .hdr{flex-wrap:wrap;gap:4px;margin-bottom:1.2rem}
  .hdr-title{font-size:17px}
  .hdr-date{font-size:11px}
  .sec-title{font-size:14px}
  .sec{margin-bottom:1.2rem}
  /* 표: thead 숨김 → 각 tr이 카드 1개로 세로 나열 */
  .tbl-wrap{margin:0;overflow-x:visible}
  .tbl{width:100%;min-width:0}
  .tbl thead{display:none}
  .tbl tbody tr{display:block;padding:12px;border:1px solid var(--border-strong);margin-bottom:8px;border-radius:6px;background:var(--bg-card)}
  .tbl tbody td{display:block;border:none;padding:2px 0;text-align:left!important}
  /* 1열(종목명·구분): 큰 타이틀 */
  .tbl tbody td:first-child{font-size:15px;font-weight:700;color:var(--accent-domestic);margin-bottom:2px}
  /* 2·3열(당일·전일 종가): 수치 */
  .tbl tbody td:nth-child(2){font-size:14px;font-weight:600;color:var(--text-primary)}
  .tbl tbody td:nth-child(3){font-size:14px;font-weight:600;color:var(--text-secondary)}
  /* 4열(변동): 등락 색상 유지 */
  .tbl tbody td:nth-child(4){font-size:14px}
  /* 5열 이후(서브 정보): 작은 보조 텍스트 */
  .tbl tbody td:nth-child(n+5){font-size:11px;color:var(--text-tertiary)}
  /* ntbl(뉴스표)는 기존 가로 스크롤 유지 */
  .ntbl{min-width:460px}
  .ntbl-wrap,.tbl-wrap.ntbl-outer{overflow-x:auto;-webkit-overflow-scrolling:touch}
  /* 부가 정보 열 숨김 */
  .td-sum{display:none}
  .td-date{min-width:56px}
  .td-cat{min-width:56px}
  /* 수급 카드 단열 */
  .sup-grid{grid-template-columns:1fr}
  /* 차트 높이 축소 */
  .chart-wrap{height:160px}
  /* summary box 패딩 */
  .summary-box{padding:10px 12px}
}
</style>
</head>
<body><div class="wrap">

<!-- HEADER — D. 메타 정보 정돈 (영문+한글 듀얼 / 우측 일자·요일·기준시각) -->
<div class="hdr">
  <div class="hdr-brand">
    <div class="hdr-eng">DAILY MARKET REPORT</div>
    <div class="hdr-kor">일일 시장 리포트</div>
  </div>
  <div class="hdr-meta">
    <div class="hdr-date-primary">${reportDatePrimary}</div>
    <div class="hdr-date-sub">${reportDateSub}</div>
  </div>
</div>

<!-- A. 헤드라인 블록 — 강한 시각 무게감 (border-left 딥네이비 + 28px Bold) -->
${headline ? `<div class="headline-block">
  <span class="headline-label">TODAY'S HEADLINE</span>
  <span class="headline-text">${headline}</span>
</div>` : ''}
${conflicts.length ? `<div class="conflict-box"><strong>상충 알림</strong> ${conflicts.slice(0,3).map(cv => typeof cv === 'string' ? cv : `${cv.company ?? ''} — ${cv.note ?? ''}`).join(' · ')}</div>` : ''}

<!-- AI SUMMARY -->
${summaryHtml ? `<div class="summary-box"><div class="s-title"><span class="s-badge">✦ AI</span> Summary</div>${summaryHtml}</div>` : ''}

<!-- ══ 1. 국내 증시 ══ -->
<div class="sec">
  <div class="sec-title"><span class="sec-eng" style="color:var(--accent-domestic)">DOMESTIC MARKET</span><span class="sec-kor">국내 증시</span></div>
  ${_secSummaryBox(secSum.domestic, '#1e3a8a')}
  <div class="tbl-wrap"><table class="tbl s-domestic">
    <thead><tr><th class="l" style="width:34%">구분</th><th style="width:20%">당일(${dateMd}) 종가</th><th style="width:20%">전일(${prevMd}) 종가</th><th style="width:26%">변동</th></tr></thead>
    <tbody>
      ${trow('KOSPI',  d.kospi,  N(d.kospi?.today),  N(d.kospi?.prev))}
      ${trow('KOSDAQ', d.kosdaq, N(d.kosdaq?.today), N(d.kosdaq?.prev))}
      ${(d.volumeBn != null || prevDayTvBn != null)
        ? `<tr><td>KOSPI 거래대금</td><td class="r">${d.volumeBn != null ? N(d.volumeBn)+'조원' : '―'}</td><td class="r">${prevDayTvBn != null ? N(prevDayTvBn)+'조원' : '―'}</td><td class="r">${volDiff != null ? `<div class="chg"><span class="chg-val ${dir(volDiff)}">${arr(volDiff)} ${sgn(volDiff)}${N(Math.abs(volDiff))}조원 (${sgn(volPct)}${N(volPct)}%)</span></div>` : '<span class="neu">―</span>'}</td></tr>`
        : ''}
      ${d.vkospi?.today != null
        ? trow(
            d.vkospi.source === 'carry_forward' ? 'VKOSPI (전일값)' : 'VKOSPI (공포지수)',
            d.vkospi,
            N(d.vkospi.today), N(d.vkospi.prev)
          )
        : ''}
      ${d.marketCap != null
        ? trow(
            'KOSPI 시가총액',
            { diff: d.marketCapDiff, pct: d.marketCapPct },
            N(d.marketCap) + '조원',
            d.prevMarketCap != null ? N(d.prevMarketCap) + '조원' : '―'
          )
        : ''}
    </tbody>
  </table></div>
  ${_buildMarketCards(supply, d.breadth, date, prevMd, dateMd, d.supplyToday, d.supplyHistory)}
</div>

<!-- ══ 2. KOSPI 5거래일 추이 ══ -->
<div class="sec">
  <div class="sec-title"><span class="sec-eng" style="color:var(--accent-domestic)">KOSPI TREND</span><span class="sec-kor">최근 5거래일 종가 추이 &amp; 거래대금</span></div>
  <div class="chart-wrap">
    <!-- 이메일 폴백: quickchart 이미지 -->
    <img id="kChartImg" src="${chartUrl}" alt="KOSPI 차트" style="width:100%;height:auto;display:block;border-radius:4px">
    <!-- 브라우저/Notion: Chart.js 캔버스 -->
    <canvas id="kChart" role="img" aria-label="코스피 최근 5거래일 종가 추이"
      style="display:none;width:100%;height:195px"></canvas>
  </div>
  <div class="tbl-wrap"><table class="tbl s-domestic" style="margin-top:6px">
    <thead><tr>
      <th class="l" style="width:18%">날짜</th><th style="width:14%">KOSPI 종가</th><th style="width:13%">전일比</th><th style="width:10%">등락률</th><th style="width:14%">거래대금</th>
      <th class="l" style="width:31%">주요 이슈</th>
    </tr></thead>
    <tbody>${histRows || '<tr><td colspan="6" style="text-align:center;color:#bbb;padding:12px">데이터 없음</td></tr>'}</tbody>
  </table></div>
</div>

<!-- ══ 3. 해외 증시 ══ -->
<div class="sec">
  <div class="sec-title"><span class="sec-eng" style="color:var(--accent-overseas)">GLOBAL MARKETS</span><span class="sec-kor">해외 증시</span></div>
  ${_secSummaryBox(secSum.overseas, '#374151')}
  <div class="tbl-wrap"><table class="tbl s-overseas">
    <thead><tr><th class="l" style="width:34%">구분</th><th style="width:20%">전일(${dateMd}) 종가</th><th style="width:20%">전전일(${prevMd}) 종가</th><th style="width:26%">변동</th></tr></thead>
    <tbody>
      ${trow('다우존스',               o.dow,    N(o.dow?.today),    N(o.dow?.prev))}
      ${trow('S&amp;P 500',            o.sp500,  N(o.sp500?.today),  N(o.sp500?.prev))}
      ${trow('나스닥',                 o.nasdaq, N(o.nasdaq?.today), N(o.nasdaq?.prev))}
      ${trow('필라델피아 반도체(SOX)', o.sox,    N(o.sox?.today),    N(o.sox?.prev))}
      ${trow('닛케이225',              o.nikkei, N(o.nikkei?.today), N(o.nikkei?.prev))}
      ${o.dax?.today != null ? trow('DAX (독일)', o.dax, N(o.dax?.today), N(o.dax?.prev)) : ''}
      ${trow('항셍지수',               o.hsi,    N(o.hsi?.today),    N(o.hsi?.prev))}
    </tbody>
  </table></div>
</div>

<!-- ══ 4. 환율 · 금리 ══ -->
<div class="sec">
  <div class="sec-title"><span class="sec-eng" style="color:var(--accent-fxrates)">FX &amp; RATES</span><span class="sec-kor">환율 · 금리</span></div>
  ${_secSummaryBox(secSum.fxRates, '#4338ca')}
  <div class="tbl-wrap"><table class="tbl s-fxrates">
    <thead><tr><th class="l" style="width:38%">구분</th><th style="width:20%">당일(${dateMd})</th><th style="width:20%">전일(${prevMd})</th><th style="width:22%">변동</th></tr></thead>
    <tbody>
      ${trow('원/달러 환율',    fx.usdKrw, NI(fx.usdKrw?.today) + '원', NI(fx.usdKrw?.prev) + '원')}
      ${trow('달러 인덱스',     fx.dxy,    N(fx.dxy?.today),             N(fx.dxy?.prev))}
      ${trow('미 국채 10년물',  fx.us10y,  N(fx.us10y?.today) + '%',     N(fx.us10y?.prev) + '%')}
      ${fx.us2y?.today != null ? trow('미 국채 2년물', fx.us2y, N(fx.us2y?.today) + '%', N(fx.us2y?.prev) + '%') : ''}
      ${(() => {
        const f = fx.fomc ?? {};
        const fRow = (lbl, today, prev) => {
          const diff = today != null && prev != null ? r2(today - prev) : null;
          const chg = diff == null ? '<span class="neu">―</span>'
            : `<span class="${dir(diff)}">${sgn(diff)}${N(Math.abs(diff))}%p</span>`;
          return `<tr><td>${lbl}</td><td class="r">${today ?? 'N/A'}%</td><td class="r">${prev != null ? prev + '%' : '―'}</td><td class="r">${chg}</td></tr>`;
        };
        return [
          fRow('6월 FOMC 동결확률', f.junHoldPct, f.junHoldPctPrev),
          fRow('9월 인하 가능성',   f.sepCutPct,  f.sepCutPctPrev),
        ].join('');
      })()}
    </tbody>
  </table></div>
</div>

<!-- ══ 5. 원자재 · 비철금속 ══ -->
<div class="sec">
  <div class="sec-title"><span class="sec-eng" style="color:var(--accent-commodities)">COMMODITIES</span><span class="sec-kor">원자재 · 비철금속</span></div>
  ${_secSummaryBox(secSum.commodities, '#854d0e')}
  <div class="tbl-wrap"><table class="tbl s-commodities">
    <thead><tr><th class="l" style="width:35%">구분</th><th style="width:21%">당일(${dateMd}) 시세</th><th style="width:21%">전일(${prevMd}) 시세</th><th style="width:23%">변동</th></tr></thead>
    <tbody>
      ${trow('금 (선물, oz)',           c.gold,     '$' + N(c.gold?.today),      '$' + N(c.gold?.prev))}
      ${trow('금 (국내 순금 1돈)',      c.goldKrw,  NI(c.goldKrw?.today) + '원', NI(c.goldKrw?.prev) + '원')}
      ${c.silver?.today  != null ? trow('은 (COMEX, oz)',    c.silver,   '$' + N(c.silver?.today),   '$' + N(c.silver?.prev)) : ''}
      ${c.platinum?.today != null ? trow('백금 (COMEX, oz)', c.platinum, '$' + N(c.platinum?.today), '$' + N(c.platinum?.prev)) : ''}
      ${trow('WTI 원유 (bbl)',          c.wti,      '$' + N(c.wti?.today),       '$' + N(c.wti?.prev))}
      ${trow('구리 (COMEX, lb)',        c.copper,   '$' + N(c.copper?.today),    '$' + N(c.copper?.prev))}
      ${c.aluminum?.today != null ? trow('알루미늄 (LME, t)', c.aluminum, '$' + N(c.aluminum?.today), '$' + N(c.aluminum?.prev)) : ''}
      ${c.zinc?.today != null ? trow('아연 (LME, t)', c.zinc, '$' + N(c.zinc?.today), '$' + N(c.zinc?.prev)) : ''}
      ${c.nickel?.today != null ? trow('니켈 (LME, t)', c.nickel, '$' + N(c.nickel?.today), '$' + N(c.nickel?.prev)) : ''}
    </tbody>
  </table></div>
  <div class="note">※ 은·백금은 Yahoo Finance 선물 기준. 알루미늄·아연·니켈은 LME 참고값. 정확한 공식가는 당일 마감 후 확인 필요.</div>
</div>

${cryptoSection}
${analystSection}

<!-- ══ 6. 주요 뉴스 ══ -->
<div class="sec">
  <div class="sec-title"><span class="sec-eng" style="color:var(--accent-news)">TODAY'S NEWS</span><span class="sec-kor">주요 뉴스</span></div>
  <div class="tbl-wrap ntbl-outer"><table class="ntbl s-news">
    <thead><tr><th class="l" style="width:70px">일자</th><th style="width:64px">구분</th><th class="l" style="width:30%">제목 / 출처</th><th class="l">요약</th></tr></thead>
    <tbody>${newsRows}</tbody>
  </table></div>
</div>

<!-- B. 풋터/면책 — 명확한 섹션 분리 (출처 / 발행 정보 / 면책) -->
<div class="report-footer">
  <div class="footer-block">
    <span class="footer-label">데이터 출처</span>
    <span class="footer-text">Yahoo Finance · CoinGecko · 한경 컨센서스 · 네이버 금융 · 한국은행 · OpenDART · Investing.com</span>
  </div>
  <div class="footer-block">
    <span class="footer-label">발행 정보</span>
    <span class="footer-text">${reportDatePrimary} (${reportDow}) · 08:00 KST · Daily Market Report</span>
  </div>
  <div class="footer-block">
    <span class="footer-label">면책</span>
    <span class="footer-text">본 리포트는 정보 제공을 목적으로 작성되었으며, 투자 권유나 매수·매도 추천이 아닙니다.<br>시장 데이터는 외부 API에서 자동 수집되며 지연·오류 가능성이 있습니다.<br>투자 판단의 최종 책임은 사용자에게 있습니다.</span>
  </div>
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
          // C. quickchart 폴백도 딥 네이비 통일
          borderColor: '#1e3a8a', backgroundColor: 'rgba(30,58,138,0.07)',
          borderWidth: 2, pointBackgroundColor: '#1e3a8a', pointRadius: 4,
          fill: true, yAxisID: 'A',
        },
        {
          type: 'bar', label: '거래대금',
          data: tvBns,
          // C. 거래대금 막대: 차콜
          backgroundColor: 'rgba(55,65,81,0.28)',
          borderColor: 'rgba(55,65,81,0.50)',
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
  const d   = pipelineData?.domestic    ?? {};
  const o   = pipelineData?.overseas    ?? {};
  const fx  = pipelineData?.fxRates     ?? {};
  const c   = pipelineData?.commodities ?? {};
  const cr  = pipelineData?.crypto      ?? {};
  const secSum = editorialPlan?.sectionSummaries ?? {};
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
  const DIVIDER = `<div style="height:1px;background:#e5e7eb"></div>`;

  // ── 섹션 Summary 박스 (인라인 스타일 — Gmail 호환) ───────────────────────
  const emailSecSummary = (text) => {
    if (!text) return '';
    return `<div style="background:#eff6ff;border-left:4px solid #1e40af;border-radius:0 6px 6px 0;padding:9px 13px;margin-bottom:12px;box-sizing:border-box">
      <div style="font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#1e40af;margin-bottom:4px;font-family:${FONT}">Summary</div>
      <div style="font-size:12px;color:#111827;line-height:1.65;font-family:${FONT}">${text}</div>
    </div>`;
  };

  // ── 섹션 헤더 헬퍼 (듀얼 표기 — 증권사 PDF 격식) ──────────────────────────
  // accentColor: 섹션별 직접 색 값 (CSS variables 사용 불가 — Gmail 인라인 스타일 전용)
  const secHdr = (engLabel, korLabel, meta, accentColor = '#1e3a8a') =>
    `<div style="border-bottom:2px solid #0f172a;padding-bottom:8px;margin-bottom:14px">
      <div style="font-size:11px;font-weight:700;letter-spacing:0.15em;text-transform:uppercase;color:${accentColor};font-family:${FONT};margin-bottom:2px">${engLabel}</div>
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td style="white-space:nowrap;vertical-align:middle">
            <span style="font-size:16px;font-weight:700;color:#0f172a;font-family:${FONT}">${korLabel}</span>
          </td>
          ${meta ? `<td style="vertical-align:bottom;text-align:right;white-space:nowrap;padding-left:8px">
            <span style="font-size:10px;color:#94a3b8;letter-spacing:0.04em;font-family:${FONT}">${meta}</span>
          </td>` : ''}
        </tr>
      </table>
    </div>`;

  // ── 카드 컴포넌트 헬퍼 ─────────────────────────────────────────────────────
  // direction: 'up' | 'down' | 'neu'
  const indexCard = (label, valueStr, aStr, pStr, direction, valueFontSize) => {
    const fs    = valueFontSize || '22px';
    const bg    = direction === 'up'   ? '#fff8f8' : direction === 'down' ? '#eff6ff' : '#f9fafb';
    const bdr   = direction === 'up'   ? '#fecaca' : direction === 'down' ? '#bfdbfe' : '#d1d5db';
    const color = direction === 'up'   ? '#E24B4A' : direction === 'down' ? '#378ADD' : '#6b7280';
    return `<div style="width:100%;min-height:84px;box-sizing:border-box;background:${bg};border:1px solid ${bdr};border-radius:8px;padding:12px 14px">
      <div style="font-size:10px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:#6b7280;margin-bottom:5px;font-family:${FONT}">${label}</div>
      <div style="font-size:${fs};font-weight:700;color:#111827;margin-bottom:4px;line-height:1.1;font-family:${FONT}">${valueStr}</div>
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

  // ── 1. 헤더 — D. 메타 정보 정돈 (영문+한글 듀얼 / 우측 일자·요일·기준시각) ──
  const EN_DAYS_EMAIL = ['SUN','MON','TUE','WED','THU','FRI','SAT'];
  const emailDow      = EN_DAYS_EMAIL[dtObj.getDay()];
  const emailDatePrimary = `${dtObj.getFullYear()}.${MM}.${DD}`;
  const emailDateSub     = `${emailDow} · 08:00 KST`;

  const headerHtml = `<div style="background:#0f172a;padding:0 24px">
  <div style="border-top:3px solid #E24B4A;padding:20px 0 18px">
    <table width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr>
        <td style="vertical-align:bottom">
          <div style="color:#8892a4;font-size:11px;font-weight:700;letter-spacing:0.15em;text-transform:uppercase;font-family:${FONT};margin-bottom:3px">DAILY MARKET REPORT</div>
          <div style="color:#fff;font-size:16px;font-weight:700;font-family:${FONT}">일일 시장 리포트</div>
        </td>
        <td style="vertical-align:bottom;text-align:right">
          <div style="color:#e8eaed;font-size:13px;font-weight:700;font-family:${FONT}">${emailDatePrimary}</div>
          <div style="color:#8892a4;font-size:10px;letter-spacing:0.08em;text-transform:uppercase;margin-top:2px;font-family:${FONT}">${emailDateSub}</div>
        </td>
      </tr>
    </table>
  </div>
</div>`;

  // 헤드라인 (헤더 바로 아래) — A. 헤드라인 임팩트 + D. 메타 정보 정돈
  const emailHeadline = editorialPlan?.headline
    ? `<div style="border-left:4px solid #1e3a8a;padding:14px 20px 16px;background:#fff;border-bottom:1px solid #e5e7eb">
        <div style="font-size:10px;font-weight:700;letter-spacing:0.15em;text-transform:uppercase;color:#374151;margin-bottom:6px;font-family:${FONT}">TODAY'S HEADLINE</div>
        <div style="font-size:22px;font-weight:700;color:#0f172a;line-height:1.3;letter-spacing:-0.01em;font-family:${FONT}">${editorialPlan.headline}</div>
      </div>`
    : '';

  // ── 2. 핵심 수치 3카드 (KOSPI · S&P500 · BTC 고정) ─────────────────────────
  // 휴장일이면 KOSPI 전일 종가 + "휴장" 표시, 데이터 누락 시 "—" 표시
  const isHoliday = pipelineData?.isHoliday ?? false;

  const _make3Card = (label, accentColor, valueStr, chgStr, chgDir) => {
    const bg    = chgDir === 'up'   ? '#fff8f8' : chgDir === 'down' ? '#eff6ff' : '#f9fafb';
    const bdr   = chgDir === 'up'   ? '#fecaca' : chgDir === 'down' ? '#bfdbfe' : '#d1d5db';
    const color = chgDir === 'up'   ? '#E24B4A' : chgDir === 'down' ? '#378ADD' : '#6b7280';
    return `<td style="width:33%;padding:0 4px;vertical-align:top">
      <div style="background:${bg};border:1px solid ${bdr};border-radius:6px;padding:12px 8px;text-align:center;box-sizing:border-box">
        <div style="font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:${accentColor};font-weight:700;font-family:${FONT};margin-bottom:6px">${label}</div>
        <div style="font-size:20px;font-weight:700;color:#0f172a;font-variant-numeric:tabular-nums;font-family:${FONT};line-height:1.1;margin-bottom:4px">${valueStr}</div>
        <div style="font-size:12px;font-weight:600;color:${color};font-family:${FONT}">${chgStr}</div>
      </div>
    </td>`;
  };

  // KOSPI 카드
  const kospiObj  = d.kospi;
  const kospiDir  = dir(kospiObj?.diff);
  const kospiVal  = kospiObj?.today != null ? fmtI(kospiObj.today) : (kospiObj?.prev != null ? fmtI(kospiObj.prev) : '—');
  const kospiChg  = kospiObj?.diff != null
    ? `${ar(kospiObj.diff)}&nbsp;${sg(kospiObj.diff)}${fmt2(Math.abs(kospiObj.diff))} (${sg(kospiObj.pct)}${fmt2(kospiObj.pct)}%)`
    : '―';
  const kospiLabel = isHoliday && kospiObj?.today == null ? 'KOSPI (휴장)' : 'KOSPI';
  const kospiCard  = _make3Card(kospiLabel, '#1e3a8a', kospiVal, kospiChg, kospiObj?.today == null ? 'neu' : kospiDir);

  // S&P500 카드
  const spObj   = o.sp500;
  const spDir   = dir(spObj?.diff);
  const spVal   = spObj?.today != null ? fmt2(spObj.today) : '—';
  const spChg   = spObj?.diff != null
    ? `${ar(spObj.diff)}&nbsp;${sg(spObj.diff)}${fmt2(Math.abs(spObj.diff))} (${sg(spObj.pct)}${fmt2(spObj.pct)}%)`
    : '―';
  const spCard  = _make3Card('S&P 500', '#374151', spVal, spChg, spObj?.today == null ? 'neu' : spDir);

  // BTC 카드
  const btcObj  = cr.btc ?? null;
  const btcDir  = dir(btcObj?.change24h);
  const btcVal  = btcObj?.price != null ? '$' + fmtI(btcObj.price) : '—';
  const btcChg  = btcObj?.change24h != null
    ? `${ar(btcObj.change24h)}&nbsp;${sg(btcObj.change24h)}${fmt2(Math.abs(btcObj.change24h))}%`
    : '―';
  const btcCard = _make3Card('BTC', '#0e7490', btcVal, btcChg, btcObj?.price == null ? 'neu' : btcDir);

  // 3카드 가로 나열 (모바일: 각 td가 width:100%로 자연스럽게 축소되도록 inline-block 패턴)
  const digest3Cards = `<div style="padding:16px 22px 14px">
  <table cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:separate;border-spacing:0">
    <tr>
      ${kospiCard}
      ${spCard}
      ${btcCard}
    </tr>
  </table>
</div>`;

  // ── AI Summary + 상충 알림 섹션 ──────────────────────────────────────────
  const summaryBullets = editorialPlan?.summary_bullets ?? [];
  const topStories     = tfResults?.news?.top_stories   ?? [];
  const themes         = tfResults?.news?.themes        ?? [];

  let summarySection = '';
  const summaryLines = summaryBullets.length ? summaryBullets
    : topStories.length ? topStories
    : [];

  const emailConflicts = (editorialPlan?.conflicts ?? []).slice(0, 3);
  const conflictBox = emailConflicts.length
    ? `<div style="background:#fff7ed;border-left:3px solid #ea580c;padding:7px 12px;margin-bottom:12px;font-size:12px;color:#9a3412;font-family:${FONT}"><strong>상충 알림</strong> ${emailConflicts.map(cv => typeof cv === 'string' ? cv : `${cv.company ?? ''} — ${cv.note ?? ''}`).join(' · ')}</div>`
    : '';

  if (summaryLines.length) {
    const bullets = summaryLines.map(s =>
      `<table cellpadding="0" cellspacing="0" border="0" style="width:100%;margin-bottom:9px">
        <tr>
          <td style="vertical-align:top;padding-right:8px;white-space:nowrap;color:#2563eb;font-size:14px;line-height:1.6;font-family:${FONT}">•</td>
          <td style="font-size:13px;color:#111827;line-height:1.65;font-family:${FONT}">${String(s).replace(/^[•·\-]\s*/,'')}</td>
        </tr>
      </table>`
    ).join('');

    const themePills = themes.length
      ? `<div style="margin-top:12px">${
          themes.map(t => `<span style="display:inline-block;background:#eff6ff;color:#2563eb;font-size:11px;font-weight:600;padding:3px 9px;border-radius:20px;font-family:${FONT};margin:0 3px 3px 0">${t}</span>`).join('')
        }</div>`
      : '';

    summarySection = `<div style="padding:18px 22px 14px;background:#fafafa;border-bottom:1px solid #cbd5e1">
  ${conflictBox}
  ${secHdr('AI SUMMARY', '오늘의 시장 요약', '', '#1e3a8a')}
  ${bullets}${themePills}
</div>`;
  } else if (conflictBox) {
    // 상충만 있는 경우
    summarySection = `<div style="padding:14px 22px;background:#fafafa;border-bottom:1px solid #cbd5e1">${conflictBox}</div>`;
  }

  // ── 뉴스 3건 다이제스트 ───────────────────────────────────────────────────
  const rawFindings = tfResults?.news?.findings ?? [];
  const rawNews     = pipelineData?.news        ?? [];

  let newsItems = [];
  if (rawFindings.length) {
    const seen    = new Set();
    const ordered = [...rawFindings].sort((a,b) => (b.importance??0)-(a.importance??0));
    for (const f of ordered) {
      if (newsItems.length >= 3) break;  // 다이제스트: 3건 고정
      const theme = f.theme ?? f.category ?? '';
      if (!seen.has(theme)) { seen.add(theme); newsItems.push(f); }
    }
    for (const f of ordered) {
      if (newsItems.length >= 3) break;
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
    newsItems = rawNews.slice(0, 3).map(n => ({ category: n.category ?? '시장전반', title: n.title ?? '', summary: [], url: n.url ?? null }));
  }

  // ── 알림 박스 (김치프리미엄 + 목표가 변동) ──────────────────────────────
  const _alertBoxHtml = (() => {
    const lines = [];

    // 김치프리미엄 한 줄
    const kp = pipelineData?.crypto?.kimchiPremium ?? tfResults?.crypto?.kimchi_premium ?? null;
    if (kp) {
      const items = [];
      if (kp.btc != null) {
        const v = kp.btc;
        const color = v >= 0 ? '#E24B4A' : '#378ADD';
        items.push(`BTC <span style="color:${color}">${v >= 0 ? '+' : ''}${Number(v).toFixed(2)}%${v < -0.3 ? ' (역프리미엄)' : v > 0.3 ? ' (프리미엄)' : ''}</span>`);
      }
      if (kp.eth != null) {
        const v = kp.eth;
        const color = v >= 0 ? '#E24B4A' : '#378ADD';
        items.push(`ETH <span style="color:${color}">${v >= 0 ? '+' : ''}${Number(v).toFixed(2)}%</span>`);
      }
      if (items.length) {
        lines.push(`<div style="padding:7px 12px;border-bottom:1px solid #e0f2fe;font-size:12px;font-family:${FONT};color:#0e7490"><strong>김치프리미엄</strong> ${items.join(' · ')}</div>`);
      }
    }

    // 목표가 변동 한 줄
    const tpcs = tfResults?.analyst?.target_price_changes ?? [];
    if (tpcs.length) {
      const tpcItems = tpcs.slice(0, 4).map(t => {
        const dSymbol = (t.change_pct ?? 0) >= 0 ? '↑' : '↓';
        const color   = (t.change_pct ?? 0) >= 0 ? '#E24B4A' : '#378ADD';
        const pct     = t.change_pct != null ? ` <span style="color:${color}">${t.change_pct >= 0 ? '+' : ''}${Number(t.change_pct).toFixed(1)}% ${dSymbol}</span>` : '';
        const firm    = t.firm ? ` ${t.firm}` : '';
        return `${t.company ?? '?'}${pct}${firm ? `<span style="font-size:10px;color:#6b7280"> / ${firm}</span>` : ''}`;
      });
      const totalNote = tpcs.length > 4 ? ` <span style="font-size:10px;color:#6b7280">(총 ${tpcs.length}건)</span>` : '';
      lines.push(`<div style="padding:7px 12px;font-size:12px;font-family:${FONT};color:#1e3a8a"><strong>목표가 변동</strong> ${tpcItems.join(' · ')}${totalNote}</div>`);
    }

    if (!lines.length) return '';
    return `<div style="background:rgba(30,58,138,0.03);border:1px solid #cbd5e1;border-radius:4px;margin:0 22px 14px;overflow:hidden">${lines.join('')}</div>`;
  })();

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
          `<div style="font-size:11px;color:#4b5563;line-height:1.6;font-family:${FONT}">${String(b).startsWith('•') ? b : '• ' + b}</div>`
        ).join('')
      : `<div style="min-height:14px"></div>`;
    return `<div style="padding:12px 0;box-sizing:border-box;${isLast ? '' : 'border-bottom:1px solid #f0f2f5'}">
      <div style="margin-bottom:5px">
        <span style="display:inline-block;background:${chip.bg};color:${chip.txt};font-size:10px;font-weight:600;padding:2px 7px;border-radius:4px;margin-right:7px;font-family:${FONT}">${n.category}</span>
      </div>
      ${n.url
        ? `<a href="${n.url}" target="_blank" rel="noopener" style="display:block;text-decoration:none;font-size:13px;font-weight:500;color:#111827;line-height:1.55;font-family:${FONT};margin-bottom:5px">${title}</a>`
        : `<div style="font-size:13px;font-weight:500;color:#111827;line-height:1.55;font-family:${FONT};margin-bottom:5px">${title}</div>`
      }
      ${summaryHtml}
    </div>`;
  }).join('');

  const newsSection = newsItems.length ? `<div style="padding:14px 22px 18px">
  ${secHdr("TODAY'S NEWS", '주요 뉴스', '', '#374151')}
  ${newsRows}
</div>` : '';

  // ── CTA + B. 풋터/면책 ─────────────────────────────────────────────────
  const url = reportUrl || '#';
  const ctaHtml = `<div style="padding:18px 22px;text-align:center;border-top:1px solid #cbd5e1">
  <a href="${url}" target="_blank"
     style="display:inline-block;background:#0f172a;color:#fff;font-size:14px;font-weight:700;padding:12px 36px;border-radius:3px;text-decoration:none;font-family:${FONT};letter-spacing:0.04em">
    전체 리포트 보기 →
  </a>
</div>
<div style="background:#fafafa;border-top:1px solid #e5e7eb;padding:20px 22px">
  <div style="margin-bottom:12px">
    <div style="font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#374151;font-family:${FONT};margin-bottom:4px">데이터 출처</div>
    <div style="font-size:11px;color:#64748b;line-height:1.8;font-family:${FONT}">Yahoo Finance · CoinGecko · 한경 컨센서스 · 네이버 금융 · 한국은행 · OpenDART</div>
  </div>
  <div style="margin-bottom:12px">
    <div style="font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#374151;font-family:${FONT};margin-bottom:4px">발행 정보</div>
    <div style="font-size:11px;color:#64748b;line-height:1.8;font-family:${FONT}">${emailDatePrimary} (${emailDow}) · 08:00 KST · Daily Market Report</div>
  </div>
  <div>
    <div style="font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#374151;font-family:${FONT};margin-bottom:4px">면책</div>
    <div style="font-size:11px;color:#64748b;line-height:1.8;font-family:${FONT}">본 리포트는 정보 제공을 목적으로 작성되었으며, 투자 권유나 매수·매도 추천이 아닙니다. 시장 데이터는 외부 API에서 자동 수집되며 지연·오류 가능성이 있습니다. 투자 판단의 최종 책임은 사용자에게 있습니다.</div>
  </div>
</div>`;

  // ── 다이제스트 조립 ── 헤드라인→상충/Summary→3카드→뉴스3건→알림박스→CTA ──
  const sections = [
    summarySection,
    summarySection ? DIVIDER : '',
    digest3Cards,
    DIVIDER,
    newsSection,
    _alertBoxHtml,
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
  ${emailHeadline}
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

  // C. 차트 색 톤 — PDF 보고서 딥네이비 팔레트
  return `<script>
(function() {
  try {
    var img = document.getElementById('kChartImg');
    var cnv = document.getElementById('kChart');
    if (!img || !cnv) return;
    img.style.display = 'none';
    cnv.style.display = 'block';
    var isDark = window.matchMedia && window.matchMedia('(prefers-color-scheme:dark)').matches;
    // C. 격자선: 옅은 그레이 / 축 라벨: 슬레이트
    var gc = isDark ? 'rgba(255,255,255,0.07)' : '#e5e7eb';
    var tc = isDark ? '#94a3b8' : '#475569';
    new Chart(cnv, {
      type: 'bar',
      data: {
        labels: ${JSON.stringify(labels)},
        datasets: [
          { type:'line', label:'KOSPI 종가',
            data: ${JSON.stringify(prices)},
            // C. KOSPI 선/점: 딥 네이비 #1e3a8a
            borderColor:'#1e3a8a', backgroundColor:'rgba(30,58,138,0.07)',
            borderWidth:2, pointBackgroundColor:'#1e3a8a', pointRadius:4,
            fill:true, tension:0.3, yAxisID:'yL' },
          { type:'bar', label:'거래대금(조원)',
            data: ${JSON.stringify(tvBns)},
            // C. 거래대금 막대: 차콜 50% opacity
            backgroundColor: isDark ? 'rgba(55,65,81,0.40)' : 'rgba(55,65,81,0.28)',
            borderColor: isDark ? 'rgba(55,65,81,0.70)' : 'rgba(55,65,81,0.50)',
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
          x:{ grid:{color:gc}, ticks:{color:tc, font:{size:11, family:"'Apple SD Gothic Neo',sans-serif"}} },
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
