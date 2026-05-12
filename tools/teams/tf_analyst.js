// tools/teams/tf_analyst.js — TF-2 애널리스트 리포트 분석팀
// DART 공시 → 컨센서스 추적·목표가 변동 감지·섹터 온도 측정
// DART_API_KEY 미설정 시 빈 결과 반환.
import { GoogleGenerativeAI } from '@google/generative-ai';
import { logger } from '../utils/logger.js';

/**
 * TF-2: 애널리스트 리포트 분석 실행.
 * @param {object} dartData  Layer 1 dart_feed 결과
 * @returns {Promise<TFAnalystResult>}
 */
export async function runTFAnalyst(dartData) {
  if (!dartData?.reports?.length) {
    logger.info('[tf-analyst] DART 공시 없음 — 건너뜀');
    return _emptyResult();
  }

  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    logger.warn('[tf-analyst] GOOGLE_API_KEY 미설정 — 분석 생략');
    return _emptyResult();
  }

  const modelName = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: modelName });

    const prompt = _buildPrompt(dartData.reports);
    const result = await model.generateContent(prompt);
    const raw    = result.response.text()
      .replace(/^```json\s*/,'').replace(/```\s*$/,'').trim();

    const parsed = JSON.parse(raw);
    logger.info(`[tf-analyst] 분석 완료 — ${parsed.findings?.length ?? 0}건`);

    return {
      findings:         parsed.findings          ?? [],
      sector_sentiment: parsed.sector_sentiment  ?? {},
      consensus_changes:parsed.consensus_changes ?? 0,
      alert_items:      (parsed.findings ?? []).filter(f => f.importance >= 8),
      confidence:       parsed.confidence        ?? 0.8,
      model_used:       modelName,
    };
  } catch (e) {
    logger.warn('[tf-analyst] 분석 실패:', e.message);
    return _emptyResult();
  }
}

function _buildPrompt(reports) {
  return `당신은 한국 증권사 애널리스트 리포트 전문 분석가입니다.

아래 DART 공시 목록을 분석해 다음을 수행하세요:
1. 투자의견 변경 및 목표주가 변동 파악
2. 섹터별 전반적 방향성 평가
3. importance >= 8: 즉시 알림이 필요한 중요 변경

반드시 아래 JSON 형식만 응답하세요:
{
  "findings": [
    {
      "company": "회사명",
      "sector": "반도체",
      "firm": "증권사명",
      "rating_change": "Buy→Hold",
      "target_price": { "prev": 85000, "new": 72000, "change_pct": -15.3 },
      "key_thesis": "핵심 논거 한 줄",
      "importance": 9,
      "alert": true,
      "source_url": "DART URL"
    }
  ],
  "sector_sentiment": { "반도체": "부정", "바이오": "긍정" },
  "consensus_changes": 3,
  "confidence": 0.85
}

DART 공시 목록 (${reports.length}건):
${JSON.stringify(reports.slice(0, 15), null, 2)}`;
}

function _emptyResult() {
  return {
    findings: [], sector_sentiment: {}, consensus_changes: 0,
    alert_items: [], confidence: 0, model_used: null,
  };
}

// 단독 실행 (디버깅용): node tools/teams/tf_analyst.js --date 2026-05-12
if (process.argv.includes('--date')) {
  import('dotenv/config').then(async () => {
    const fs   = await import('fs/promises');
    const path = await import('path');
    const idx  = process.argv.indexOf('--date');
    const date = process.argv[idx + 1] ?? new Date().toISOString().slice(0, 10);
    const data = JSON.parse(await fs.default.readFile(
      path.default.join(process.env.OUTPUT_DIR ?? './outputs', date, 'data.json'), 'utf-8'
    ));
    const result = await runTFAnalyst(data.dart ?? { reports: [] });
    console.log(JSON.stringify(result, null, 2));
  });
}
