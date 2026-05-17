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
    const rawFindings = parsed.findings ?? [];
    const dedupedFindings = _dedupeFindings(rawFindings);
    logger.info(`[tf-news] 분석 완료 — 상위 테마: ${parsed.themes?.slice(0,3).join('·') ?? '-'}`);

    return {
      findings:     dedupedFindings,
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
4. 상위 3개 핵심 기사 선정 (top_stories — findings와 별도로, 오늘 시장을 이해하는 데 가장 중요한 3개 헤드라인)
5. 오늘 시장을 관통하는 핵심 테마 최대 5개
6. 동일 기업·사건을 다루는 유사 기사를 하나의 그룹으로 묶고 그룹당 가장 중요한 1건만 findings에 포함

=== 중복 제거 규칙 (반드시 엄격히 준수) ===
STEP 1. 먼저 모든 기사를 토픽 그룹으로 분류한다.
  - 같은 기업(예: 삼성전자, SK하이닉스)이 등장하는 기사 → 동일 그룹
  - 같은 정책·이벤트(예: 연준 금리결정, 환율 방어)를 다루는 기사 → 동일 그룹
  - 같은 업종·섹터의 동일 이슈(예: 반도체 수출 규제) → 동일 그룹

STEP 2. 각 그룹에서 importance가 가장 높은 기사 1건만 findings에 포함한다.
  - 같은 그룹의 나머지 기사는 findings에서 완전히 제외한다.
  - 예시: 삼성전자 1Q 실적 관련 기사 3건(중요도 8·6·5) → 중요도 8인 1건만 findings 포함

STEP 3. findings를 완성한 뒤, 다시 한 번 검토한다.
  - findings 내 각 항목의 headline과 기업명을 비교하여 중복 여부를 재확인
  - 동일 기업·이벤트가 2건 이상이면 importance 낮은 것을 즉시 제거
  - 이 자가 검증을 반드시 완료한 후 최종 JSON을 출력한다

top_stories 규칙:
  - findings 중복 제거와 무관하게 오늘 가장 중요한 3개 헤드라인을 별도 선정
  - findings에 없더라도 top_stories에 포함 가능 (독자 맥락 파악용)

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

/**
 * 헤드라인 정규화: 공백·특수문자·따옴표 제거 후 소문자화해 단어 집합 반환.
 * @param {string} headline
 * @returns {Set<string>}
 */
function _tokenize(headline) {
  const normalized = (headline ?? '')
    .replace(/["""''`~!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return new Set(normalized.split(' ').filter(w => w.length > 1));
}

/**
 * Jaccard 유사도: 두 단어 집합의 교집합 / 합집합.
 * 결과 0~1. 1에 가까울수록 동일 기사.
 * @param {Set<string>} setA
 * @param {Set<string>} setB
 * @returns {number}
 */
function _jaccard(setA, setB) {
  if (!setA.size && !setB.size) return 1;
  const intersection = [...setA].filter(w => setB.has(w)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}

/**
 * 기업명 추출: 한글 2~6자 + 고빈도 증시 접미사 패턴으로 후보 추출.
 * 예: "삼성전자", "SK하이닉스", "현대차"
 * @param {string} headline
 * @returns {string[]}
 */
function _extractCompanyNames(headline) {
  // 영문 대문자 포함(SK, LG 등) + 한글 조합 기업명 패턴
  const matches = (headline ?? '').match(/[A-Z가-힣][가-힣A-Za-z0-9]{1,8}(?:전자|하이닉스|바이오|증권|화학|에너지|차|자동차|건설|물산|생명|은행|카드|그룹|홀딩스|모터스|이노베이션|솔루션|시스템)?/g);
  return matches ?? [];
}

/**
 * Gemini 응답 후 findings를 한 번 더 검증·중복 제거.
 *
 * 중복 판단 기준 (둘 중 하나라도 해당하면 중복):
 *   A. 헤드라인 Jaccard 유사도 ≥ 0.55 (단어 55% 이상 겹침)
 *   B. 동일 기업명이 2개 이상 findings에 등장
 *
 * 중복 그룹에서 importance 높은 1건만 유지. 동점이면 먼저 등장한 것 유지.
 *
 * @param {object[]} findings
 * @returns {object[]}
 */
function _dedupeFindings(findings) {
  if (!Array.isArray(findings) || findings.length <= 1) return findings ?? [];

  const JACCARD_THRESHOLD = 0.55;

  // importance 내림차순 정렬 (높은 것 먼저 → 그룹 내 대표로 선택됨)
  const sorted = [...findings].sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0));

  const kept    = [];   // 최종 유지 항목
  const dropped = [];   // 제거된 항목 인덱스

  for (let i = 0; i < sorted.length; i++) {
    if (dropped.includes(i)) continue;

    const tokensI    = _tokenize(sorted[i].headline);
    const companiesI = _extractCompanyNames(sorted[i].headline);

    let isDupeOfKept = false;
    for (const keptItem of kept) {
      const tokensK    = _tokenize(keptItem.headline);
      const similarity = _jaccard(tokensI, tokensK);

      // A. 헤드라인 유사도 기준
      if (similarity >= JACCARD_THRESHOLD) { isDupeOfKept = true; break; }

      // B. 기업명 겹침 기준
      if (companiesI.length > 0) {
        const companiesK = _extractCompanyNames(keptItem.headline);
        const sharedCo   = companiesI.filter(c => companiesK.includes(c));
        if (sharedCo.length > 0) { isDupeOfKept = true; break; }
      }
    }

    if (!isDupeOfKept) {
      kept.push(sorted[i]);
    } else {
      dropped.push(i);
    }
  }

  // importance 순이 아닌 원래 findings 순서로 복원 (DESK가 원래 순서 기대할 수 있음)
  const keptSet = new Set(kept.map(k => k.headline));
  const result  = findings.filter(f => keptSet.has(f.headline));

  logger.info(`[tf-news] 중복 제거 ${findings.length}건 → ${result.length}건`);
  return result;
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
