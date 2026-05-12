// tools/desk/editor.js — DESK 편집장
// TF팀 전체 결과를 받아 오늘의 핵심 의제·섹션 우선순위·내러티브를 결정한다.
import { GoogleGenerativeAI } from '@google/generative-ai';
import { logger } from '../utils/logger.js';

/**
 * DESK 편집 결정 실행.
 * @param {object} pipelineData  Layer 1 data.json
 * @param {object} tfResults     Layer 2 tf_results.json
 * @returns {Promise<EditorialPlan>}
 */
export async function runEditor(pipelineData, tfResults) {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    logger.warn('[desk/editor] GOOGLE_API_KEY 미설정 — 기본 편집 플랜 사용');
    return _defaultPlan(pipelineData, tfResults);
  }

  const modelName = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: modelName });

    const prompt = _buildEditorPrompt(pipelineData, tfResults);
    const result = await model.generateContent(prompt);
    const raw    = result.response.text()
      .replace(/^```json\s*/,'').replace(/```\s*$/,'').trim();

    const plan = JSON.parse(raw);
    logger.info(`[desk/editor] 편집 완료 — 헤드라인: "${plan.headline}"`);

    return {
      headline:          plan.headline          ?? '',
      summary_bullets:   plan.summary_bullets   ?? [],
      section_order:     plan.section_order     ?? _defaultSectionOrder(tfResults),
      emphasis_items:    plan.emphasis_items     ?? [],
      conflict_notes:    plan.conflict_notes     ?? [],
      today_theme:       plan.today_theme        ?? '',
      include_crypto:    _hasCrypto(tfResults),
      include_analyst:   _hasAnalyst(tfResults),
    };
  } catch (e) {
    logger.warn('[desk/editor] 편집 실패, 기본 플랜 사용:', e.message);
    return _defaultPlan(pipelineData, tfResults);
  }
}

function _buildEditorPrompt(pipelineData, tfResults) {
  const kospi = pipelineData.domestic?.kospi;
  const news  = tfResults.news  ?? {};
  const analyst = tfResults.analyst ?? {};
  const crypto  = tfResults.crypto  ?? {};

  return `당신은 일일 시장 리포트의 수석 편집장입니다.

오늘의 시장 스냅샷:
- KOSPI: ${kospi?.today ?? 'N/A'} (${kospi?.diff >= 0 ? '+' : ''}${kospi?.diff ?? 'N/A'}, ${kospi?.pct ?? 'N/A'}%)
- 주요 테마: ${news.themes?.join('·') ?? '없음'}
- BTC 신호: ${crypto.signal ?? '없음'}
- 애널 컨센서스 변경: ${analyst.consensus_changes ?? 0}건

TF팀 주요 발견:
- 뉴스 top_stories: ${JSON.stringify(news.top_stories ?? [])}
- 코인 market_summary: ${crypto.market_summary ?? '없음'}
- 주의 애널 알림: ${analyst.alert_items?.length ?? 0}건

아래를 결정하세요:
1. 오늘 리포트의 헤드라인 (한 줄, 구체적 수치 포함)
2. AI Summary 불릿 4~6개
3. 섹션 순서 (중요도 기준 재배치)
4. 강조 표시 항목 (importance >= 8)
5. 상충 정보 조율 메모 (뉴스 악재 ↔ 리포트 낙관론 등)
6. 오늘의 시장 관통 테마 한 줄

반드시 JSON 형식만 응답:
{
  "headline": "반도체 외국인 순매수 + Fed 동결 기대 → KOSPI +0.11%",
  "summary_bullets": ["• ...", "• ...", "• ...", "• ..."],
  "section_order": ["domestic", "history", "overseas", "fx", "commodities", "crypto", "analyst", "news"],
  "emphasis_items": ["삼성전자 목표가 하향 (미래에셋)", "BTC 100,000 저항선"],
  "conflict_notes": ["뉴스: 경기침체 우려 vs 리포트: 반도체 낙관론 → DESK 판단: 단기 불확실성"],
  "today_theme": "금리 불확실성 속 반도체 선별 매수 기회"
}`;
}

function _defaultPlan(pipelineData, tfResults) {
  return {
    headline:        '',
    summary_bullets: [],
    section_order:   _defaultSectionOrder(tfResults),
    emphasis_items:  [],
    conflict_notes:  [],
    today_theme:     '',
    include_crypto:  _hasCrypto(tfResults),
    include_analyst: _hasAnalyst(tfResults),
  };
}

const _hasCrypto  = tf => (tf.crypto?.findings?.length  ?? 0) > 0;
const _hasAnalyst = tf => (tf.analyst?.findings?.length ?? 0) > 0;

function _defaultSectionOrder(tfResults) {
  const base = ['domestic', 'history', 'overseas', 'fx', 'commodities'];
  if (_hasCrypto(tfResults))  base.push('crypto');
  if (_hasAnalyst(tfResults)) base.push('analyst');
  base.push('news');
  return base;
}
