// tools/desk/editor.js — DESK 편집장
// 책임 분리:
//   • 헤드라인·섹션순서·include 플래그 → 결정론적(AI 미사용). 실제 시장 데이터에서 직접 계산.
//   • AI Summary 불릿 5~7개만 Gemini가 생성 (실패해도 헤드라인은 살아남는다).
//   • sectionSummaries → 결정론적, AI 미사용. 2~4 문장, 수치+트렌드+원인+영향 포함.
//
// 이전 구조 문제점:
//   Gemini 한 번에 헤드라인·요약·섹션순서·강조 모두 맡겼다가 503/JSON 파싱 실패 시
//   헤드라인·요약 둘 다 한꺼번에 손실. 어제(2026-05-14) 사고로 "코스피 7981선" 잘못 인용도 발생.
//   → 헤드라인은 실제 데이터를 보고 만드는 결정론적 빌더로 분리.
import { GoogleGenerativeAI } from '@google/generative-ai';
import { logger } from '../../shared/utils/logger.js';

const fmt = {
  num:  v => v == null ? null : v.toLocaleString('ko-KR', { maximumFractionDigits: 2 }),
  pct:  v => v == null ? null : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`,
  sign: v => v == null ? '' : (v > 0 ? '▲' : v < 0 ? '▼' : '―'),
};

/**
 * DESK 편집 결정 실행.
 * @param {object} pipelineData  Layer 1 data.json
 * @param {object} tfResults     Layer 2 tf_results.json
 * @returns {Promise<EditorialPlan>}
 */
export async function runEditor(pipelineData, tfResults) {
  // 1) 헤드라인 — AI 미사용, 실데이터 기반 즉시 생성
  const headline = _buildHeadline(pipelineData, tfResults);
  logger.info(`[desk/editor] 헤드라인: "${headline}"`);

  // 2) 섹션별 글 Summary — 결정론적, AI 미사용 (Gemini 호출 전에 먼저 생성)
  const sectionSummaries = _buildSectionSummaries(pipelineData, tfResults);
  logger.info('[desk/editor] sectionSummaries 생성 완료 (5개 섹션)');

  // 3) AI Summary — Gemini 호출 (실패 시 sectionSummaries로 결정론적 폴백)
  const summary_bullets = await _buildSummaryBullets(pipelineData, tfResults, sectionSummaries).catch(e => {
    logger.warn('[desk/editor] AI Summary 생성 실패, 결정론적 폴백 사용:', e.message);
    return _buildFallbackBullets(pipelineData, tfResults, sectionSummaries);
  });

  // 4) 상충 정보 감지 — analyst 긍정 ↔ news 부정 (또는 반대)
  const conflicts = _detectConflicts(tfResults);
  if (conflicts.length > 0) {
    logger.info(`[desk/editor] 상충 항목 ${conflicts.length}건 감지: ${conflicts.map(c => c.topic).join(', ')}`);
  } else {
    logger.info('[desk/editor] 상충 항목 없음');
  }

  return {
    headline,
    summary_bullets,
    sectionSummaries,
    conflicts,
    section_order:   _defaultSectionOrder(tfResults),
    emphasis_items:  [],
    conflict_notes:  [],
    today_theme:     '',
    include_crypto:  _hasCrypto(tfResults),
    include_analyst: _hasAnalyst(tfResults),
  };
}

// ── 헤드라인 빌더 (결정론적) ────────────────────────────────────────────────────
// 우선순위: 한국 휴장 여부 → KOSPI 변동률 강도 → 환율 급변동 → 코인 신호 → 테마
function _buildHeadline(d, tf) {
  const kospi    = d.domestic?.kospi;
  const kosdaq   = d.domestic?.kosdaq;
  const isKrHol  = d.meta?.krHoliday ?? d.domestic?.isHoliday ?? false;
  const themes   = tf.news?.themes ?? [];
  const usdKrw   = d.fxRates?.usdKrw;
  const themeTail = themes.length ? ` · ${themes.slice(0, 2).join('·')}` : '';

  // 1) 한국 휴장 — 해외·환율·코인 중심
  if (isKrHol) {
    const sp500 = d.overseas?.sp500;
    const nasdaq = d.overseas?.nasdaq;
    const btc = tf.crypto?.findings?.find(f => /BTC|비트/i.test(f.asset ?? ''));
    const parts = ['한국 휴장'];
    if (sp500?.pct != null)  parts.push(`S&P500 ${fmt.pct(sp500.pct)}`);
    if (nasdaq?.pct != null) parts.push(`나스닥 ${fmt.pct(nasdaq.pct)}`);
    if (btc?.signal)         parts.push(`BTC ${btc.signal}`);
    return parts.join(' · ') + themeTail;
  }

  // 2) KOSPI 데이터가 있으면 → KOSPI + 보조 지표
  if (kospi?.today != null && kospi.pct != null) {
    const direction = kospi.pct > 1.0 ? '강세'
                    : kospi.pct > 0.3 ? '상승'
                    : kospi.pct > -0.3 ? '보합'
                    : kospi.pct > -1.0 ? '하락'
                    : '약세';
    const base = `코스피 ${fmt.num(kospi.today)} (${fmt.pct(kospi.pct)}) ${direction}`;

    // 코스닥이 같은 방향이면 동반, 다르면 차별화 언급
    let tail = '';
    if (kosdaq?.pct != null) {
      const sameDir = Math.sign(kospi.pct) === Math.sign(kosdaq.pct);
      tail = sameDir
        ? ` · 코스닥 ${fmt.pct(kosdaq.pct)} 동반`
        : ` · 코스닥은 ${fmt.pct(kosdaq.pct)}`;
    }

    // 환율 급변동(±0.5%)을 헤드라인에 노출
    if (usdKrw?.pct != null && Math.abs(usdKrw.pct) >= 0.5) {
      tail += ` · 환율 ${fmt.num(usdKrw.today)}원 (${fmt.pct(usdKrw.pct)})`;
    }

    return base + tail + themeTail;
  }

  // 3) KOSPI 미수집 폴백 — 해외 + 환율 중심
  const sp500 = d.overseas?.sp500;
  const parts = ['국내 지수 미수집'];
  if (sp500?.pct != null)    parts.push(`S&P500 ${fmt.pct(sp500.pct)}`);
  if (usdKrw?.today != null) parts.push(`환율 ${fmt.num(usdKrw.today)}원`);
  return parts.join(' · ') + themeTail;
}

// ── AI Summary 불릿 (Gemini 호출, 실패 시 결정론적 폴백) ─────────────────────────
async function _buildSummaryBullets(pipelineData, tfResults, sectionSummaries) {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) return _buildFallbackBullets(pipelineData, tfResults, sectionSummaries);

  const kospi    = pipelineData.domestic?.kospi;
  const kosdaq   = pipelineData.domestic?.kosdaq;
  const supply   = pipelineData.domestic?.supply;
  const vkospi   = pipelineData.domestic?.vkospi;
  const overseas = pipelineData.overseas ?? {};
  const fxRates  = pipelineData.fxRates  ?? {};
  const commod   = pipelineData.commodities ?? {};
  const news     = tfResults.news    ?? {};
  const analyst  = tfResults.analyst ?? {};
  const crypto   = tfResults.crypto  ?? {};
  const themes   = news.themes ?? [];

  // 입력 신호가 아예 없으면 Gemini 호출 자체를 건너뜀 (낭비 방지)
  if (!news.top_stories?.length && !analyst.findings?.length && !crypto.market_summary) {
    return _buildFallbackBullets(pipelineData, tfResults, sectionSummaries);
  }

  const modelName = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: modelName });

  // 수급 컨텍스트 구성
  const supplyCtx = supply
    ? `외국인 ${_amtStr(supply.foreign)} (${supply.foreign < 0 ? '순매도' : '순매수'}), 기관 ${_amtStr(supply.institution)} (${supply.institution < 0 ? '순매도' : '순매수'}), 개인 ${_amtStr(supply.individual)} (${supply.individual < 0 ? '순매도' : '순매수'})`
    : '데이터 없음';

  // 5거래일 추이 컨텍스트
  const histCtx = _buildHistoryContext(pipelineData.domestic?.kospiHistory);

  // 해외 컨텍스트
  const ovCtx = [
    overseas.sp500?.pct  != null ? `S&P500 ${fmt.pct(overseas.sp500.pct)}` : null,
    overseas.nasdaq?.pct != null ? `나스닥 ${fmt.pct(overseas.nasdaq.pct)}` : null,
    overseas.dow?.pct    != null ? `다우 ${fmt.pct(overseas.dow.pct)}` : null,
    overseas.sox?.pct    != null ? `SOX ${fmt.pct(overseas.sox.pct)}` : null,
    overseas.nikkei?.pct != null ? `닛케이 ${fmt.pct(overseas.nikkei.pct)}` : null,
    overseas.hsi?.pct    != null ? `항셍 ${fmt.pct(overseas.hsi.pct)}` : null,
    overseas.dax?.pct    != null ? `DAX ${fmt.pct(overseas.dax.pct)}` : null,
  ].filter(Boolean).join(', ') || '데이터 없음';

  // 환율·금리 컨텍스트
  const fxCtx = [
    fxRates.usdKrw?.today != null ? `원달러 ${fmt.num(fxRates.usdKrw.today)}원 (${fmt.pct(fxRates.usdKrw.pct)})` : null,
    fxRates.dxy?.today    != null ? `DXY ${fxRates.dxy.today.toFixed(2)} (${fmt.pct(fxRates.dxy.pct)})` : null,
    fxRates.us10y?.today  != null ? `미 10년 ${fxRates.us10y.today.toFixed(2)}% (${fxRates.us10y.diff != null ? (fxRates.us10y.diff > 0 ? '+' : '') + (fxRates.us10y.diff * 100).toFixed(0) + 'bp' : 'N/A'})` : null,
    fxRates.fomc?.junHoldPct != null ? `FOMC 6월 동결 ${fxRates.fomc.junHoldPct}%` : null,
  ].filter(Boolean).join(', ') || '데이터 없음';

  // 원자재 컨텍스트
  const cmCtx = [
    commod.gold?.today  != null ? `금 $${fmt.num(commod.gold.today)} (${fmt.pct(commod.gold.pct)})` : null,
    commod.wti?.today   != null ? `WTI $${fmt.num(commod.wti.today)} (${fmt.pct(commod.wti.pct)})` : null,
    commod.copper?.pct  != null ? `구리 ${fmt.pct(commod.copper.pct)}` : null,
  ].filter(Boolean).join(', ') || '데이터 없음';

  // 코인 컨텍스트
  const btcFinding = crypto.findings?.find(f => /^BTC$/i.test(f.asset ?? ''));
  const cryptoCtx = btcFinding?.price_usd != null
    ? `BTC $${btcFinding.price_usd.toLocaleString('en-US')} / 공포탐욕지수 ${crypto.fear_greed?.value ?? 'N/A'}(${crypto.fear_greed?.label ?? ''}) / 도미넌스 ${crypto.btc_dominance ?? 'N/A'}% / 신호: ${crypto.signal ?? '없음'} / 김치프리미엄 BTC ${crypto.kimchi_premium?.btc?.premium_pct ?? 'N/A'}%`
    : '데이터 없음';

  // 테마 컨텍스트
  const themeCtx = themes.length ? themes.join(', ') : '없음';

  const prompt = `당신은 국내 유명 증권사의 데일리 시황 작성자입니다.
오늘 시장 전체를 일목요연하게 짚는 5~7개의 불릿을 작성하십시오.

[오늘의 시장 데이터]
- KOSPI: ${kospi?.today ?? 'N/A'} (${kospi?.pct != null ? fmt.pct(kospi.pct) : 'N/A'}) / KOSDAQ: ${kosdaq?.today ?? 'N/A'} (${kosdaq?.pct != null ? fmt.pct(kosdaq.pct) : 'N/A'})
- VKOSPI(변동성): ${vkospi?.today ?? 'N/A'} (${vkospi?.pct != null ? fmt.pct(vkospi.pct) : 'N/A'})
- 수급: ${supplyCtx}
- 5거래일 추이: ${histCtx}
- 해외: ${ovCtx}
- 환율·금리: ${fxCtx}
- 원자재: ${cmCtx}
- 코인: ${cryptoCtx}
- 오늘의 테마: ${themeCtx}
- 뉴스 top_stories: ${JSON.stringify((news.top_stories ?? []).slice(0, 5))}
- 애널 알림 ${analyst.findings?.length ?? 0}건

[작성 규칙]
1. 불릿 5~7개, "• "로 시작
2. 각 불릿 60~90자 (단답형 금지, 완결 문장)
3. 반드시 구체적 수치 포함 (%, 원, 달러, bp, 조원 등)
4. 시장 메커니즘 설명 포함 (예: "미 국채 +12bp → 강달러 → 외국인 매도")
5. KOSPI 수치는 위 데이터만 사용 (추측 금지)
6. 구성 순서: ①오늘의 큰 그림 ②국내증시 ③해외증시 ④환율·금리 ⑤코인 또는 원자재 ⑥오늘의 테마·핵심 위험
7. 한국어, 보수적 톤 ("~의 영향으로 보입니다", "~에 주목됩니다")
8. JSON 배열만 응답: ["• 첫 번째", "• 두 번째", ...]`;

  const res = await model.generateContent(prompt);
  const raw = res.response.text().replace(/^```json\s*/, '').replace(/```\s*$/, '').trim();
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) return _buildFallbackBullets(pipelineData, tfResults, sectionSummaries);
  const bullets = parsed.slice(0, 7).filter(s => typeof s === 'string' && s.trim());
  // Gemini가 너무 적게 반환한 경우 폴백으로 보강
  if (bullets.length < 3) return _buildFallbackBullets(pipelineData, tfResults, sectionSummaries);
  return bullets;
}

/**
 * Gemini 503 등 실패 시 결정론적 폴백 불릿 생성.
 * sectionSummaries 5개에서 핵심 문장을 발췌해 5~6개 불릿으로 조립한다.
 * 빈 메일 발송을 방지하는 최후 방어선.
 */
function _buildFallbackBullets(pipelineData, tfResults, sectionSummaries) {
  const bullets = [];
  const kospi  = pipelineData.domestic?.kospi;
  const sp500  = pipelineData.overseas?.sp500;
  const usdKrw = pipelineData.fxRates?.usdKrw;
  const isHol  = pipelineData.meta?.krHoliday ?? pipelineData.domestic?.isHoliday ?? false;
  const themes = tfResults.news?.themes ?? [];

  // 불릿 1: 큰 그림
  if (isHol) {
    const parts = ['한국 휴장일.'];
    if (sp500?.pct != null) parts.push(`S&P500 ${fmt.pct(sp500.pct)}.`);
    if (usdKrw?.today != null) parts.push(`원달러 ${fmt.num(usdKrw.today)}원.`);
    bullets.push(`• ${parts.join(' ')}`);
  } else if (kospi?.today != null) {
    const dir = kospi.pct > 0 ? '상승' : kospi.pct < 0 ? '하락' : '보합';
    bullets.push(`• 코스피 ${fmt.num(kospi.today)} (${fmt.pct(kospi.pct)}) ${dir} 마감. ${sp500?.pct != null ? `S&P500 ${fmt.pct(sp500.pct)}.` : ''}`);
  }

  // 불릿 2~5: 섹션 요약 첫 문장 발췌
  const sections = [
    sectionSummaries?.domestic,
    sectionSummaries?.overseas,
    sectionSummaries?.fxRates,
    sectionSummaries?.commodities,
    sectionSummaries?.crypto,
  ];
  for (const sec of sections) {
    if (!sec || typeof sec !== 'string') continue;
    // 첫 문장만 추출 (마침표 기준)
    const firstSentence = sec.split(/(?<=\.)\s/)[0]?.trim();
    if (firstSentence && firstSentence.length > 10) {
      bullets.push(`• ${firstSentence.replace(/^•\s*/, '')}`);
    }
    if (bullets.length >= 6) break;
  }

  // 불릿 마지막: 테마
  if (themes.length && bullets.length < 7) {
    bullets.push(`• 오늘의 시장 주요 테마: ${themes.slice(0, 3).join(', ')}.`);
  }

  return bullets.filter(Boolean).slice(0, 7);
}

// ── 섹션 순서·포함 여부 ────────────────────────────────────────────────────────
const _hasCrypto  = tf => (tf.crypto?.findings?.length  ?? 0) > 0;
const _hasAnalyst = tf => (tf.analyst?.findings?.length ?? 0) > 0;

function _defaultSectionOrder(tfResults) {
  const base = ['domestic', 'history', 'overseas', 'fx', 'commodities'];
  if (_hasCrypto(tfResults))  base.push('crypto');
  if (_hasAnalyst(tfResults)) base.push('analyst');
  base.push('news');
  return base;
}

// ── 섹션별 글 Summary 빌더 (결정론적, AI 미사용) ────────────────────────────────
/**
 * 5개 섹션(국내증시·해외증시·환율금리·원자재·코인) 각각에 대한
 * 2~4 문장짜리 한국어 글 Summary를 데이터에서 직접 조립한다.
 * 구성: 핵심 수치 + 트렌드 + 원인/영향
 * Gemini 호출 없이 수치 포맷 + 문구 조합으로 생성.
 * 원인 절(why)은 tfResults.news.findings 키워드 매칭으로 추가한다.
 *
 * @param {object} d   pipelineData (Layer 1 data.json)
 * @param {object} tf  tfResults    (Layer 2 tf_results.json)
 * @returns {{ domestic, overseas, fxRates, commodities, crypto }}
 */
function _buildSectionSummaries(d, tf) {
  return {
    domestic:    _summDomestic(d, tf),
    overseas:    _summOverseas(d, tf),
    fxRates:     _summFxRates(d, tf),
    commodities: _summCommodities(d, tf),
    crypto:      _summCrypto(d, tf),
  };
}

/**
 * TF 뉴스 findings에서 섹션 관련 원인 문장을 추출한다.
 *
 * - findings 배열을 keywords로 필터링(헤드라인·테마 포함 여부)
 * - importance 내림차순으로 최고 2건 선정
 * - 선정된 findings의 market_impact 또는 summary[0]에서 원인 절 조립
 * - 매칭이 없으면 themes 힌트를 활용해 1문장 생성, themes도 없으면 null 반환
 *
 * @param {Array}  findings  tf.news.findings 배열
 * @param {Array}  themes    tf.news.themes 배열
 * @param {string[]} keywords 섹션 관련 검색 키워드
 * @returns {string|null}  원인 절 문장(있으면), 없으면 null
 */
function _findCauseFromNews(findings, themes, keywords) {
  if (!Array.isArray(findings) || findings.length === 0) {
    return _causeFromThemes(themes, keywords);
  }

  // 키워드가 헤드라인 또는 테마에 포함된 findings 필터링
  const kwLower = keywords.map(k => k.toLowerCase());
  const matched = findings.filter(f => {
    const haystack = `${f.headline ?? ''} ${f.theme ?? ''}`.toLowerCase();
    return kwLower.some(k => haystack.includes(k));
  });

  if (matched.length === 0) {
    return _causeFromThemes(themes, keywords);
  }

  // importance 내림차순 정렬 후 최고 2건
  const top = matched
    .slice()
    .sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0))
    .slice(0, 2);

  // 각 finding에서 원인 문구 추출
  // 우선순위: summary[0] (구체 내용) → market_impact (짧은 레이블)
  const causes = top.map(f => {
    const s0 = Array.isArray(f.summary) && f.summary[0]
      ? f.summary[0].replace(/^•\s*/, '').trim()
      : null;
    return s0 || f.market_impact || null;
  }).filter(Boolean);

  if (causes.length === 0) return null;

  // 1~2개의 원인을 "주요 원인:" 라벨 패턴으로 이어붙임.
  // 라벨 패턴을 쓰는 이유: summary[0]가 명사구로 끝날 때도("…규제 강화", "…매도를 촉발")
  // "가 작용했습니다" 같은 무지성 접미를 붙이면 한국어 조사가 깨진다("촉발가 작용했습니다").
  // 콜론 라벨로 시작하면 뒤 내용이 어떤 끝맺음이든 자연스럽다.
  const unique = [...new Set(causes)];
  const body = unique.slice(0, 2).join(' ').replace(/[.。]+$/, '').trim();
  if (!body) return null;
  return `주요 원인: ${body}.`;
}

/**
 * findings 매칭 실패 시 themes 배열에서 힌트 1문장 생성.
 * themes도 없거나 키워드 교집합이 없으면 null 반환.
 */
function _causeFromThemes(themes, keywords) {
  if (!Array.isArray(themes) || themes.length === 0) return null;
  const kwLower = keywords.map(k => k.toLowerCase());
  const relThemes = themes.filter(t => kwLower.some(k => t.toLowerCase().includes(k)));
  if (relThemes.length === 0) return null;
  return `${relThemes.slice(0, 2).join('·')} 관련 불확실성이 영향을 미친 것으로 보입니다.`;
}

/**
 * 거래대금을 조원 단위 문자열로 변환.
 * @param {number} billionKrw  억원 단위 값 (예: supply.foreign = -56040억원)
 * @returns {string}
 */
function _amtStr(billionKrw) {
  if (billionKrw == null) return 'N/A';
  const absVal = Math.abs(billionKrw);
  if (absVal >= 10000) {
    return `${(absVal / 10000).toFixed(1)}조원`;
  }
  return `${absVal.toLocaleString('ko-KR')}억원`;
}

/**
 * 5거래일 히스토리에서 수급 추이 요약 문자열 생성.
 * 예: "외국인 5일 연속 순매도 (총 -19.6조원)"
 */
function _buildSupplyTrendContext(supplyHistory) {
  if (!Array.isArray(supplyHistory) || supplyHistory.length < 2) return null;
  const recent = supplyHistory.slice(-5);
  const foreignSigns = recent.map(h => Math.sign(h.foreign ?? 0));
  const allNeg = foreignSigns.every(s => s < 0);
  const allPos = foreignSigns.every(s => s > 0);
  if (!allNeg && !allPos) return null;
  const dir = allNeg ? '순매도' : '순매수';
  const total = recent.reduce((sum, h) => sum + (h.foreign ?? 0), 0);
  const days = recent.length;
  return `외국인 ${days}거래일 연속 ${dir} (합산 ${_amtStr(total)})`;
}

/**
 * 5거래일 KOSPI 추이에서 방향성 문자열 생성.
 */
function _buildHistoryContext(kospiHistory) {
  if (!Array.isArray(kospiHistory) || kospiHistory.length < 2) return '데이터 없음';
  const closes = kospiHistory.map(h => h.close).filter(v => v != null);
  if (closes.length < 2) return '데이터 없음';
  const first = closes[0];
  const last  = closes[closes.length - 1];
  const pct   = ((last - first) / first) * 100;
  const dir   = pct > 0 ? '상승' : '하락';
  return `${closes.length}거래일 ${dir} (${fmt.pct(pct)}, ${closes.map(v => v.toFixed(0)).join('→')})`;
}

// ─ 국내증시 Summary ─────────────────────────────────────────────────────────────
const KEYWORDS_DOMESTIC = ['KOSPI', '코스피', '코스닥', '외국인', '기관', '한국', '국내', '삼성전자', 'SK하이닉스'];

function _summDomestic(d, tf) {
  const isHol = d.meta?.krHoliday ?? d.domestic?.isHoliday ?? false;
  const kospi  = d.domestic?.kospi;
  const kosdaq = d.domestic?.kosdaq;
  const vkospi = d.domestic?.vkospi;
  const sup    = d.domestic?.supply;
  const kospiHist = d.domestic?.kospiHistory;
  const supplyHist = d.domestic?.supplyHistory;

  // 휴장일인데 전일 데이터가 있는 경우 (리포트 발행일 기준 전 거래일 요약)
  if (isHol) {
    if (kospi?.today != null && kospi.pct != null) {
      const dir  = kospi.pct < 0 ? '하락' : '상승';
      const parts = [
        `오늘은 한국 증시 휴장일이며, 직전 거래일 코스피는 ${fmt.num(kospi.today)} (${fmt.pct(kospi.pct)})로 마감해 ${Math.abs(kospi.pct) >= 3 ? '큰 폭으로 ' : ''}${dir}했습니다.`,
      ];
      if (kosdaq?.pct != null) {
        parts.push(`코스닥도 ${fmt.pct(kosdaq.pct)}로 동반 ${kosdaq.pct < 0 ? '약세' : '강세'}를 보였습니다.`);
      }
      // VKOSPI 추가
      if (vkospi?.today != null) {
        const vDir = vkospi.pct > 0 ? '상승' : '하락';
        parts.push(`변동성지수(VKOSPI)는 ${vkospi.today.toFixed(2)} (${fmt.pct(vkospi.pct)})로 ${vDir}해 시장 불안심리를 반영했습니다.`);
      }
      // 수급 흐름 추가
      if (sup?.foreign != null) {
        const fDir  = sup.foreign  < 0 ? '순매도' : '순매수';
        const iDir  = sup.institution < 0 ? '순매도' : '순매수';
        parts.push(`수급 면에서는 외국인 ${_amtStr(sup.foreign)} ${fDir}, 기관 ${_amtStr(sup.institution)} ${iDir}를 기록했습니다.`);
      }
      // 5거래일 수급 추이
      const trendStr = _buildSupplyTrendContext(supplyHist);
      if (trendStr) {
        parts.push(`최근 ${trendStr}으로, 외국인 매도 압력이 지속되고 있습니다.`);
      }
      // 원인 절
      const cause = _findCauseFromNews(tf.news?.findings, tf.news?.themes, KEYWORDS_DOMESTIC);
      if (cause) parts.push(cause);
      return parts.join(' ');
    }
    return '오늘은 한국 증시 휴장일입니다. 다음 거래일에 지수·수급 데이터가 제공됩니다.';
  }

  // 정상 거래일
  if (kospi?.today == null || kospi.pct == null) {
    return '국내 증시 데이터를 수집하지 못했습니다.';
  }

  const direction = kospi.pct > 1.5 ? '강하게 상승'
                  : kospi.pct > 0.3  ? '상승'
                  : kospi.pct > -0.3 ? '보합'
                  : kospi.pct > -1.5 ? '하락'
                  : '급락';
  const parts = [
    `코스피는 ${fmt.num(kospi.today)} (${fmt.pct(kospi.pct)})로 ${direction}하며 마감했습니다.`,
  ];
  if (kosdaq?.pct != null) {
    const sameDir = Math.sign(kospi.pct) === Math.sign(kosdaq.pct);
    parts.push(
      sameDir
        ? `코스닥도 ${fmt.pct(kosdaq.pct)}로 동반 ${kosdaq.pct < 0 ? '약세' : '강세'}를 나타냈습니다.`
        : `코스닥은 ${fmt.pct(kosdaq.pct)}로 코스피와 반대 방향을 보였습니다.`
    );
  }
  // VKOSPI 추가
  if (vkospi?.today != null) {
    const vDir = vkospi.pct > 0 ? '상승' : '하락';
    const vMeaning = vkospi.today >= 30 ? '높은 수준으로 시장 불안심리가 확대되고 있습니다' : '안정적인 수준을 유지하고 있습니다';
    parts.push(`변동성지수(VKOSPI)는 ${vkospi.today.toFixed(2)} (${fmt.pct(vkospi.pct)}) ${vDir}하며 ${vMeaning}.`);
  }
  // 수급 흐름 추가
  if (sup?.foreign != null) {
    const fDir = sup.foreign  < 0 ? '순매도' : '순매수';
    const iDir = sup.institution < 0 ? '순매도' : '순매수';
    parts.push(`수급 면에서는 외국인이 ${_amtStr(sup.foreign)} ${fDir}, 기관이 ${_amtStr(sup.institution)} ${iDir}를 기록했습니다.`);
  }
  // 5거래일 수급 추이
  const trendStr = _buildSupplyTrendContext(supplyHist);
  if (trendStr) {
    parts.push(`최근 ${trendStr}으로, 외국인 이탈 흐름이 지속되고 있습니다.`);
  }
  // 원인 절
  const cause = _findCauseFromNews(tf.news?.findings, tf.news?.themes, KEYWORDS_DOMESTIC);
  if (cause) parts.push(cause);
  return parts.join(' ');
}

// ─ 해외증시 Summary ─────────────────────────────────────────────────────────────
const KEYWORDS_OVERSEAS = ['미국', '연준', '나스닥', 'S&P', 'SOX', '반도체', 'AI', '다우', '닛케이', '항셍', 'DAX', '뉴욕'];

function _summOverseas(d, tf) {
  const ov = d.overseas;
  if (!ov) return '';

  const sp500  = ov.sp500;
  const nasdaq = ov.nasdaq;
  const dow    = ov.dow;
  const sox    = ov.sox;
  const nikkei = ov.nikkei;

  if (sp500?.pct == null && nasdaq?.pct == null && dow?.pct == null) return '';

  // 전체 방향성 판단
  const pctsAvailable = [sp500?.pct, nasdaq?.pct, dow?.pct].filter(v => v != null);
  const avgPct = pctsAvailable.reduce((a, b) => a + b, 0) / pctsAvailable.length;
  const overallDir = avgPct > 0.5 ? '상승' : avgPct > -0.5 ? '보합' : '하락';

  const parts = [];

  // 첫 문장: 3대 지수 흐름
  const mentions = [];
  if (sp500?.pct  != null) mentions.push(`S&P500 ${fmt.pct(sp500.pct)}`);
  if (nasdaq?.pct != null) mentions.push(`나스닥 ${fmt.pct(nasdaq.pct)}`);
  if (dow?.pct    != null) mentions.push(`다우 ${fmt.pct(dow.pct)}`);
  parts.push(`뉴욕 증시는 ${mentions.join(', ')}로 전반적으로 ${overallDir} 마감했습니다.`);

  // 두 번째 문장: SOX(반도체) 흐름 — 변동률 무관하게 포함
  if (sox?.pct != null) {
    const soxDir = sox.pct < -1.5 ? '급락' : sox.pct < 0 ? '하락' : sox.pct > 1.5 ? '급등' : '상승';
    const soxNote = Math.abs(sox.pct) >= 2 ? ` 반도체 업종 변동성에 주목됩니다.` : '';
    parts.push(`필라델피아 반도체지수(SOX)는 ${fmt.pct(sox.pct)}로 ${soxDir}했습니다.${soxNote}`);
  }

  // 세 번째 문장: 아시아·유럽 흐름 + 연관 해석
  const asiaParts = [];
  if (nikkei?.pct != null) asiaParts.push(`닛케이 ${fmt.pct(nikkei.pct)}`);
  if (ov.hsi?.pct  != null) asiaParts.push(`항셍 ${fmt.pct(ov.hsi.pct)}`);
  if (ov.dax?.pct  != null) asiaParts.push(`DAX ${fmt.pct(ov.dax.pct)}`);
  if (asiaParts.length) {
    parts.push(`아시아·유럽 시장도 ${asiaParts.join(', ')}를 기록했습니다.`);
  }

  // 네 번째 문장: 연관 해석 (미국 약세 → 한국 시장 동조 부담)
  if (avgPct < -0.5 && d.domestic?.kospi?.pct != null) {
    const koDir = d.domestic.kospi.pct < 0 ? '동조 하락' : '역행';
    parts.push(`미국 주요 지수 약세가 국내 시장에도 ${koDir} 영향을 미친 것으로 보입니다.`);
  }

  // 원인 절
  const cause = _findCauseFromNews(tf?.news?.findings, tf?.news?.themes, KEYWORDS_OVERSEAS);
  if (cause) parts.push(cause);

  return parts.join(' ');
}

// ─ 환율·금리 Summary ─────────────────────────────────────────────────────────────
const KEYWORDS_FXRATES = ['환율', '원달러', '달러', '금리', '미국채', '연준', 'FOMC', '인플레이션', '강달러', '약달러'];

function _summFxRates(d, tf) {
  const fx = d.fxRates;
  if (!fx) return '';

  const usdKrw = fx.usdKrw;
  const dxy    = fx.dxy;
  const us10y  = fx.us10y;
  const us2y   = fx.us2y;
  const fomc   = fx.fomc;

  if (usdKrw?.today == null && us10y?.today == null) return '';

  const parts = [];

  // 첫 문장: 원달러 환율 + DXY
  if (usdKrw?.today != null) {
    const envDir = usdKrw.pct > 0 ? '강달러' : '약달러';
    const krwStr = `원/달러 환율은 ${fmt.num(usdKrw.today)}원 (${fmt.pct(usdKrw.pct)})으로`;
    const dxyStr = dxy?.today != null ? `, 달러인덱스(DXY)는 ${dxy.today.toFixed(2)} (${fmt.pct(dxy.pct)})` : '';
    parts.push(`${krwStr}${dxyStr} ${envDir} 기조를 나타냈습니다.`);
  }

  // 두 번째 문장: 미국채 수익률 + bp 변화 강조
  if (us10y?.today != null) {
    const diff10yBp = us10y.diff != null ? Math.round(us10y.diff * 100) : null;
    const diff10yStr = diff10yBp != null ? `(${diff10yBp > 0 ? '+' : ''}${diff10yBp}bp)` : '';
    const us2yStr = us2y?.today != null ? `, 2년물은 ${us2y.today.toFixed(2)}%` : '';
    // 금리 급등 시 강달러 메커니즘 설명
    const rateEffect = diff10yBp != null && Math.abs(diff10yBp) >= 10
      ? ` 미 국채 수익률 급등은 강달러 압력으로 이어져 외국인 매도를 자극하는 요인으로 작용합니다.`
      : '';
    parts.push(`미국채 10년물 수익률은 ${us10y.today.toFixed(2)}% ${diff10yStr}${us2yStr}를 기록했습니다.${rateEffect}`);
  }

  // 세 번째 문장: FOMC 확률
  if (fomc?.junHoldPct != null) {
    const holdPct = fomc.junHoldPct;
    const cutPct  = 100 - holdPct;
    const stance  = holdPct >= 55 ? '동결 가능성이 우세한' : cutPct >= 55 ? '금리인하 기대가 높은' : '방향이 불확실한';
    parts.push(`연준 6월 회의는 ${stance} 상황으로, 동결 ${holdPct}% · 인하 ${cutPct}%의 확률이 반영되어 있습니다.`);
  }

  // 네 번째 문장: 달러·금리 트렌드 종합 해석
  if (usdKrw?.pct != null && us10y?.diff != null) {
    const diff10yBp = Math.round(us10y.diff * 100);
    if (Math.abs(diff10yBp) >= 5 && Math.abs(usdKrw.pct) >= 0.3) {
      const direction = diff10yBp > 0 ? '급등' : '급락';
      parts.push(`미 국채 수익률 ${direction}과 환율 변동이 동반 진행되며 신흥시장 투자심리에 부담을 주고 있습니다.`);
    }
  }

  // 원인 절
  const cause = _findCauseFromNews(tf?.news?.findings, tf?.news?.themes, KEYWORDS_FXRATES);
  if (cause) parts.push(cause);

  return parts.join(' ');
}

// ─ 원자재 Summary ─────────────────────────────────────────────────────────────
const KEYWORDS_COMMODITIES = ['유가', 'WTI', '금', '구리', '알루미늄', '니켈', '원자재', '중국', '안전자산', '은', '백금'];

function _summCommodities(d, tf) {
  const cm = d.commodities;
  if (!cm) return '';

  const wti    = cm.wti;
  const gold   = cm.gold;
  const copper = cm.copper;
  const silver = cm.silver;
  const alum   = cm.aluminum;
  const nickel = cm.nickel;
  const plat   = cm.platinum;

  if (wti?.today == null && gold?.today == null) return '';

  const parts = [];

  // 첫 문장: WTI + 금 (에너지·귀금속)
  const energyParts = [];
  if (wti?.today  != null) energyParts.push(`WTI 원유 ${fmt.num(wti.today)}달러 (${fmt.pct(wti.pct)})`);
  if (gold?.today != null) energyParts.push(`금 ${fmt.num(gold.today)}달러 (${fmt.pct(gold.pct)})`);
  if (energyParts.length) {
    const pctsGold = [wti?.pct, gold?.pct].filter(v => v != null);
    const avgGold  = pctsGold.reduce((a, b) => a + b, 0) / (pctsGold.length || 1);
    const dir = avgGold > 0.5 ? '강세' : avgGold < -0.5 ? '약세' : '혼조';
    parts.push(`에너지·귀금속 시장은 ${energyParts.join(', ')}로 전반적으로 ${dir}를 나타냈습니다.`);
  }

  // 두 번째 문장: 안전자산 vs 위험자산 흐름
  if (gold?.pct != null && wti?.pct != null) {
    const goldDir  = gold.pct >= 0 ? '강세' : '약세';
    const riskDir  = wti.pct >= 0 ? '강세' : '약세';
    if (gold.pct < -1 && wti.pct < -1) {
      parts.push(`안전자산(금)과 위험자산(원유)이 동반 하락하며 전반적인 자산 디레버리징 흐름이 나타나고 있습니다.`);
    } else if (gold.pct > 1 && wti.pct < -1) {
      parts.push(`안전자산 선호가 강화되며 금은 ${goldDir}를 보인 반면 원유는 ${riskDir}를 나타냈습니다.`);
    }
  }

  // 세 번째 문장: 산업금속 종합 (구리·알루미늄·니켈 트렌드)
  const baseParts = [];
  if (copper?.pct != null) baseParts.push(`구리 ${fmt.pct(copper.pct)}`);
  if (alum?.pct   != null) baseParts.push(`알루미늄 ${fmt.pct(alum.pct)}`);
  if (silver?.pct != null) baseParts.push(`은 ${fmt.pct(silver.pct)}`);
  if (nickel?.pct != null) baseParts.push(`니켈 ${fmt.pct(nickel.pct)}`);
  if (plat?.pct   != null) baseParts.push(`백금 ${fmt.pct(plat.pct)}`);
  if (baseParts.length) {
    const basePcts = [copper?.pct, alum?.pct, silver?.pct, nickel?.pct].filter(v => v != null);
    const baseAvg  = basePcts.reduce((a, b) => a + b, 0) / basePcts.length;
    const baseDir  = baseAvg < -3 ? '큰 폭 하락세' : baseAvg < -1 ? '전반적 약세' : baseAvg > 1 ? '전반적 강세' : '혼조';
    parts.push(`비철·귀금속은 ${baseParts.join(', ')}로 ${baseDir}를 보였습니다.`);
  }

  // 원인 절
  const cause = _findCauseFromNews(tf?.news?.findings, tf?.news?.themes, KEYWORDS_COMMODITIES);
  if (cause) parts.push(cause);

  return parts.join(' ');
}

// ─ 코인·블록체인 Summary ─────────────────────────────────────────────────────────
// 다른 섹션(국내·해외·환율·원자재)과 동일한 패턴:
//   사실 1~2문장(가격·등락률·심리) + _findCauseFromNews() 원인 절
// tf.crypto.market_summary는 design이 별도 렌더하지 않으므로 여기서 그대로 재사용하지 않는다.
const KEYWORDS_CRYPTO = ['비트코인', 'BTC', 'ETH', '코인', '블록체인', '가상자산', 'SEC', '규제', '이더리움'];

function _summCrypto(d, tf) {
  // 코인 raw 데이터 — crypto_data(TF가 정제) 우선, 없으면 pipeline d.crypto 사용
  const cryptoRaw = tf.crypto?.crypto_data ?? d.crypto;
  const btc = cryptoRaw?.btc;
  const eth = cryptoRaw?.eth;
  // BTC 가격: findings.price_usd → crypto_data.btc.price 순서
  const btcPrice = tf.crypto?.findings?.find(f => /^BTC$/i.test(f.asset ?? ''))?.price_usd
                ?? btc?.price;
  const btcChg   = btc?.change24h ?? d.crypto?.btc?.change24h;
  const ethPrice = tf.crypto?.findings?.find(f => /^ETH$/i.test(f.asset ?? ''))?.price_usd
                ?? eth?.price;
  const ethChg   = eth?.change24h ?? d.crypto?.eth?.change24h;
  const fg       = tf.crypto?.fear_greed ?? cryptoRaw?.fearGreed ?? d.crypto?.fearGreed;
  const dom      = tf.crypto?.btc_dominance ?? cryptoRaw?.btcDominance;
  const signal   = tf.crypto?.signal; // "조정 구간" 등 TF 진단
  const kimchi   = tf.crypto?.kimchi_premium;

  if (btcPrice == null) return '';

  const parts = [];

  // 첫 문장: BTC 가격·등락률 + TF 시그널
  const signalStr = signal ? ` TF 분석 신호는 '${signal}'입니다.` : '';
  parts.push(`비트코인은 $${btcPrice.toLocaleString('en-US')} (24h ${fmt.pct(btcChg)})로 거래됐습니다.${signalStr}`);

  // 두 번째 문장: ETH 가격
  if (ethPrice != null) {
    parts.push(`이더리움은 $${ethPrice.toLocaleString('en-US')} (24h ${fmt.pct(ethChg)})를 기록했습니다.`);
  }

  // 세 번째 문장: 시장 심리(공포탐욕지수·도미넌스) + 의미 해석
  if (fg?.value != null || dom != null) {
    const fgStr  = fg?.value != null ? `공포탐욕지수 ${fg.value}(${fg.label ?? ''})` : '';
    const domStr = dom != null ? `BTC 도미넌스 ${dom}%` : '';
    const tail   = [fgStr, domStr].filter(Boolean).join(', ');
    // 공포탐욕지수 의미 해석
    const fgMeaning = fg?.value != null
      ? fg.value <= 25 ? ' 극단적 공포 구간으로 투자 심리가 크게 위축된 상태입니다.'
      : fg.value <= 45 ? ' 공포 구간에 위치하며 하락 리스크에 민감한 상태입니다.'
      : fg.value >= 75 ? ' 극단적 탐욕 구간으로 과열 경고가 나타나고 있습니다.'
      : ''
      : '';
    if (tail) parts.push(`시장 심리는 ${tail}를 기록 중입니다.${fgMeaning}`);
  }

  // 네 번째 문장: 김치프리미엄 + 의미 해석
  if (kimchi?.btc?.premium_pct != null) {
    const kPct = kimchi.btc.premium_pct;
    const kMeaning = kPct < -0.5
      ? `역프리미엄(${kPct.toFixed(2)}%)이 발생해 국내 투자자의 매도 우위 심리를 반영하고 있습니다.`
      : kPct > 2
      ? `김치프리미엄 ${kPct.toFixed(2)}%로 국내 수요가 글로벌 대비 높은 상태입니다.`
      : `김치프리미엄은 ${kPct.toFixed(2)}%로 글로벌 대비 거의 차이가 없는 상태입니다.`;
    parts.push(kMeaning);
  }

  // 원인 절 — 다른 섹션과 동일하게 tf.news.findings 키워드 매칭
  const cause = _findCauseFromNews(tf?.news?.findings, tf?.news?.themes, KEYWORDS_CRYPTO);
  if (cause) parts.push(cause);

  return parts.join(' ');
}

// ── 상충 정보 감지 ──────────────────────────────────────────────────────────────
/**
 * tf.analyst.findings(긍정 레이팅)와 tf.news.findings(부정 시장영향)의 교집합을 찾아
 * 상충 항목 배열을 반환한다. 최대 3개.
 *
 * 감지 방향:
 *   A) analyst 긍정 + news 부정  →  "뉴스 악재 vs 애널리스트 낙관"
 *   B) analyst 부정 + news 긍정  →  "뉴스 호재 vs 애널리스트 비관"
 *
 * @param {object} tf  tfResults
 * @returns {Array<{topic, news_view, analyst_view, note}>}
 */
function _detectConflicts(tf) {
  const analystFindings = tf.analyst?.findings ?? [];
  const newsFindings    = tf.news?.findings    ?? [];

  if (analystFindings.length === 0 || newsFindings.length === 0) return [];

  // 레이팅 분류 패턴
  const POSITIVE_RATINGS = /매수|Buy|신규\s*Buy|Buy\s*유지|매수\s*유지|상향/i;
  const NEGATIVE_RATINGS = /Sell|매도|Hold|중립|하향/i;

  // 뉴스 부정 키워드 (market_impact 또는 summary 안에서 찾음)
  const NEG_NEWS_KW = ['하락', '악재', '둔화', '급락', '압력', '충격', '위축', '부담', '부진', '약세'];
  // 뉴스 긍정 키워드
  const POS_NEWS_KW = ['상승', '호재', '급등', '강세', '상향', '개선', '호조', '회복'];

  const conflicts = [];

  for (const af of analystFindings) {
    if (conflicts.length >= 3) break;

    const companyName = af.company ?? '';
    const sectorName  = af.sector  ?? '';
    const rating      = af.rating_change ?? '';

    const isAnalystPos = POSITIVE_RATINGS.test(rating);
    const isAnalystNeg = NEGATIVE_RATINGS.test(rating) && !isAnalystPos;

    if (!isAnalystPos && !isAnalystNeg) continue;

    // news.findings에서 같은 회사명 또는 섹터 테마가 포함된 항목 찾기
    const matched = newsFindings.filter(nf => {
      const hay = `${nf.headline ?? ''} ${nf.theme ?? ''} ${(nf.summary ?? []).join(' ')}`;
      // 회사명(2글자 이상)이 뉴스 텍스트에 등장하거나 섹터 키워드가 테마에 등장
      const compMatch = companyName.length >= 2 && hay.includes(companyName);
      // 섹터에서 대표 단어 추출 ("2차전지 (분리막)" → "2차전지")
      const sectorKey = sectorName.split(/[\s(]/)[0];
      const sectMatch = sectorKey.length >= 2 && hay.includes(sectorKey);
      return compMatch || sectMatch;
    });

    if (matched.length === 0) continue;

    // 매칭된 뉴스 중 importance 최상위 1건 선택
    const topNews = matched.slice().sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0))[0];

    const newsImpact = topNews.market_impact
                    ?? (Array.isArray(topNews.summary) && topNews.summary[0])
                    ?? topNews.headline
                    ?? '';

    const hasNegNews = NEG_NEWS_KW.some(kw => newsImpact.includes(kw));
    const hasPosNews = POS_NEWS_KW.some(kw => newsImpact.includes(kw));

    // A) analyst 긍정 + news 부정
    if (isAnalystPos && hasNegNews) {
      conflicts.push({
        topic:        companyName || sectorName.split(/[\s(]/)[0],
        news_view:    newsImpact.replace(/^•\s*/, '').slice(0, 60),
        analyst_view: rating,
        note:         '뉴스 악재 vs 애널리스트 낙관',
      });
      continue;
    }

    // B) analyst 부정 + news 긍정
    if (isAnalystNeg && hasPosNews) {
      conflicts.push({
        topic:        companyName || sectorName.split(/[\s(]/)[0],
        news_view:    newsImpact.replace(/^•\s*/, '').slice(0, 60),
        analyst_view: rating,
        note:         '뉴스 호재 vs 애널리스트 비관',
      });
    }
  }

  return conflicts;
}
