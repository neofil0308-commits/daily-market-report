// tools/desk/editor.js — DESK 편집장
// 책임 분리:
//   • 헤드라인·섹션순서·include 플래그 → 결정론적(AI 미사용). 실제 시장 데이터에서 직접 계산.
//   • AI Summary 불릿 4~6개만 Gemini가 생성 (실패해도 헤드라인은 살아남는다).
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

  // 2) AI Summary — Gemini 호출 (실패해도 다른 항목엔 영향 없음)
  const summary_bullets = await _buildSummaryBullets(pipelineData, tfResults).catch(e => {
    logger.warn('[desk/editor] AI Summary 생성 실패, 빈 배열 반환:', e.message);
    return [];
  });

  return {
    headline,
    summary_bullets,
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

// ── AI Summary 불릿 (Gemini 호출, 실패 시 빈 배열) ────────────────────────────
async function _buildSummaryBullets(pipelineData, tfResults) {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) return [];

  const kospi   = pipelineData.domestic?.kospi;
  const news    = tfResults.news    ?? {};
  const analyst = tfResults.analyst ?? {};
  const crypto  = tfResults.crypto  ?? {};

  // 입력 신호가 아예 없으면 Gemini 호출 자체를 건너뜀 (낭비 방지)
  if (!news.top_stories?.length && !analyst.findings?.length && !crypto.market_summary) {
    return [];
  }

  const modelName = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: modelName });

  const prompt = `당신은 일일 시장 리포트의 AI Summary 작성자입니다.
헤드라인은 별도로 생성되며, 당신은 4~6개의 짧은 불릿(각 50자 이내, "• "로 시작)만 작성합니다.

오늘의 시장:
- KOSPI: ${kospi?.today ?? 'N/A'} (${kospi?.pct ?? 'N/A'}%)
- 뉴스 top_stories: ${JSON.stringify((news.top_stories ?? []).slice(0, 5))}
- 코인 market_summary: ${crypto.market_summary ?? '없음'}
- 애널 알림 ${analyst.findings?.length ?? 0}건

규칙:
1. 각 불릿은 50자 이내 한국어 한 문장
2. 구체적 수치 포함 (퍼센트, 종목, 금액 등)
3. 뉴스에 등장한 KOSPI 종가 숫자를 추측해 쓰지 말 것 — 오직 위 KOSPI 값만 사용
4. JSON 배열 형식만 응답 (예: ["• 첫 번째 포인트", "• 두 번째 포인트"])`;

  const res = await model.generateContent(prompt);
  const raw = res.response.text().replace(/^```json\s*/, '').replace(/```\s*$/, '').trim();
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed.slice(0, 6).filter(s => typeof s === 'string' && s.trim());
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
