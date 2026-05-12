// tools/teams/tf_news.js — TF-1 뉴스 분석팀
// 원시 뉴스 + 시장 데이터 → 중요도 분류·테마 군집화·시장 영향 판단
import { GoogleGenerativeAI } from '@google/generative-ai';
import { logger } from '../utils/logger.js';

/**
 * TF-1: 뉴스 분석 실행.
 * @param {object[]} news       Layer 1 뉴스 배열
 * @param {object}   marketData Layer 1 시장 데이터 (컨텍스트용)
 * @returns {Promise<TFNewsResult>}
 */
export async function runTFNews(news, marketData = {}) {
  if (!news?.length) {
    logger.info('[tf-news] 뉴스 없음 — 건너뜀');
    return _emptyResult();
  }

  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    logger.warn('[tf-news] GOOGLE_API_KEY 미설정 — 분석 생략');
    return _emptyResult();
  }

  const modelName = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: modelName });

    const prompt = _buildPrompt(news, marketData);
    const result = await model.generateContent(prompt);
    const raw    = result.response.text()
      .replace(/^```json\s*/,'').replace(/```\s*$/,'').trim();

    const parsed = JSON.parse(raw);
    logger.info(`[tf-news] 분석 완료 — ${parsed.findings?.length ?? 0}건, 상위 테마: ${parsed.themes?.slice(0,3).join('·') ?? '-'}`);

    return {
      findings:     parsed.findings     ?? [],
      top_stories:  parsed.top_stories  ?? [],
      themes:       parsed.themes       ?? [],
      confidence:   parsed.confidence   ?? 0.7,
      model_used:   modelName,
    };
  } catch (e) {
    logger.warn('[tf-news] 분석 실패:', e.message);
    return _emptyResult();
  }
}

function _buildPrompt(news, marketData) {
  const kospi  = marketData.domestic?.kospi;
  const market = kospi?.today != null
    ? `KOSPI ${kospi.today} (${kospi.diff >= 0 ? '+' : ''}${kospi.diff}, ${kospi.pct}%)`
    : '시장 데이터 없음';

  return `당신은 한국 금융 시장 전문 뉴스 에디터입니다.
오늘 시장 상황: ${market}

아래 뉴스 목록을 분석해 다음을 수행하세요:
1. 각 기사의 시장 중요도 스코어(0~10) 부여
2. 테마 분류 (금리·환율·반도체·바이오·방산·지정학·실적 중 해당)
3. KOSPI/코스닥에 대한 단기 시장 영향 판단
4. 상위 3개 핵심 기사 선정 (top_stories)
5. 오늘 시장을 관통하는 핵심 테마 최대 5개

반드시 아래 JSON 형식만 응답하세요:
{
  "findings": [
    {
      "headline": "기사 제목",
      "theme": "테마명",
      "importance": 7,
      "market_impact": "KOSPI 단기 상승 압력",
      "verified": false,
      "source_url": "URL"
    }
  ],
  "top_stories": ["핵심 기사1", "핵심 기사2", "핵심 기사3"],
  "themes": ["반도체", "금리", "환율"],
  "confidence": 0.85
}

뉴스 목록 (${news.length}건):
${JSON.stringify(news.slice(0, 20).map(n => ({
    title: n.title, url: n.url, body: n.body?.slice(0, 200), date: n.date,
  })), null, 2)}`;
}

function _emptyResult() {
  return { findings: [], top_stories: [], themes: [], confidence: 0, model_used: null };
}

// 단독 실행 (디버깅용): node tools/teams/tf_news.js --date 2026-05-12
if (process.argv.includes('--date')) {
  import('dotenv/config').then(async () => {
    const fs   = await import('fs/promises');
    const path = await import('path');
    const idx  = process.argv.indexOf('--date');
    const date = process.argv[idx + 1] ?? new Date().toISOString().slice(0, 10);
    const data = JSON.parse(await fs.default.readFile(
      path.default.join(process.env.OUTPUT_DIR ?? './outputs', date, 'data.json'), 'utf-8'
    ));
    const result = await runTFNews(data.news, data);
    console.log(JSON.stringify(result, null, 2));
  });
}
