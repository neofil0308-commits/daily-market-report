// tools/layer-2-research/tf-news/index.js — TF-1 뉴스 분석팀
// 자기 도메인 데이터(Naver News)를 직접 수집해 분석. Layer 1 의존 제거(2026-05-16).
// 원시 뉴스 + 시장 컨텍스트 → 중요도 분류·테마 군집화·시장 영향 판단
import { GoogleGenerativeAI } from '@google/generative-ai';
import { logger } from '../../shared/utils/logger.js';
import { geminiWithRetry } from '../../shared/utils/gemini_retry.js';
import { collectNews } from './feeds/news_feed.js';

/**
 * TF-1: 뉴스 분석 실행.
 * @param {object} marketData Layer 1 시장 데이터 (overseas·fxRates 등 — AI 키워드 생성용)
 * @returns {Promise<TFNewsResult>}
 */
export async function runTFNews(marketData = {}) {
  // 자기 도메인 데이터를 직접 수집 (Layer 1의 cross-layer 제거)
  const date = marketData?.date ?? new Date().toISOString().slice(0, 10);
  const news = await collectNews(date, marketData)
    .catch(e => { logger.warn('[tf-news] 뉴스 수집 실패:', e.message); return []; });

  if (!news?.length) {
    logger.info('[tf-news] 뉴스 없음 — 건너뜀');
    return _emptyResult(news);
  }

  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    logger.warn('[tf-news] GOOGLE_API_KEY 미설정 — 분석 생략');
    return _emptyResult(news);
  }

  const modelName = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: modelName });

    const prompt = _buildPrompt(news, marketData);
    const result = await geminiWithRetry(() => model.generateContent(prompt), { label: 'tf-news' });
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
      news_raw:     news,   // ⭐ orchestrator가 다른 TF팀·DESK에 합성해 전달
    };
  } catch (e) {
    logger.warn('[tf-news] 분석 실패:', e.message);
    return _emptyResult(news);
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
6. 동일 기업·사건을 다루는 유사 기사를 하나의 그룹으로 묶고 그룹당 가장 중요한 1건만 findings에 포함 (예: 삼성전자 관련 3건이면 가장 중요한 1건만 포함)

중복 제거 규칙:
- 같은 기업·정책·이벤트를 다루는 기사는 하나의 토픽 그룹으로 분류
- 그룹에서 중요도(importance)가 가장 높은 1건만 findings에 포함
- 나머지는 제외 (top_stories 선정 시 참고용으로만 사용)

반드시 아래 JSON 형식만 응답하세요:
{
  "findings": [
    {
      "headline": "기사 제목 (원문 그대로 유지)",
      "theme": "테마명",
      "importance": 7,
      "market_impact": "KOSPI 단기 상승 압력",
      "summary": ["• 핵심 포인트 1 — 구체적 사실/수치 포함 (40자 이내)", "• 핵심 포인트 2 — 시장 영향 설명 (40자 이내)", "• 핵심 포인트 3 — 선택 (40자 이내)"],
      "verified": false,
      "source_url": "URL"
    }
  ],
  "top_stories": ["핵심 기사1", "핵심 기사2", "핵심 기사3"],
  "themes": ["반도체", "금리", "환율"],
  "confidence": 0.85
}

summary 작성 지침:
- 각 bullet은 "• "로 시작하는 완결된 한국어 문장
- 단답형·단어 나열 금지. 독자가 기사를 읽지 않아도 내용을 파악할 수 있을 정도로 서술
- 기업명, 수치(%, 원, 달러, bp), 발표기관 등 구체적 사실을 포함해 기술 (예: "• 삼성전자 1Q 영업이익 6.6조원으로 전분기 대비 32% 증가, AI 메모리 수요 견인")
- 시장 영향도 구체적으로 (예: "• 외국인 KOSPI 3,200억원 순매수로 반도체 섹터 2.1% 상승 견인")
- 2개 필수, 3개 권장
- headline은 원문 뉴스 제목을 그대로 사용 (재작성 금지)

뉴스 목록 (${news.length}건):
${JSON.stringify(news.slice(0, 20).map(n => ({
    title: n.title, url: n.url, body: n.body?.slice(0, 200), date: n.date,
  })), null, 2)}`;
}

function _emptyResult(news = []) {
  return {
    findings: [], top_stories: [], themes: [],
    confidence: 0, model_used: null,
    news_raw: news,
  };
}

// 단독 실행: node tools/layer-2-research/tf-news/index.js --date 2026-05-12
// 2026-05-16: news는 자체 수집. 시장 데이터는 data.json에서 컨텍스트로 사용.
if (process.argv.includes('--date')) {
  import('dotenv/config').then(async () => {
    const fs   = await import('fs/promises');
    const path = await import('path');
    const idx  = process.argv.indexOf('--date');
    const date = process.argv[idx + 1] ?? new Date().toISOString().slice(0, 10);
    let marketData = { date };
    try {
      marketData = JSON.parse(await fs.default.readFile(
        path.default.join(process.env.OUTPUT_DIR ?? './outputs', date, 'data.json'), 'utf-8'
      ));
    } catch { /* 시장 컨텍스트 없어도 동작 (기본 키워드만 사용) */ }
    const result = await runTFNews(marketData);
    console.log(JSON.stringify(result, null, 2));
  });
}
