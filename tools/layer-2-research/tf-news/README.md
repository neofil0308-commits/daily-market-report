# Layer 2 · TF-News

> 뉴스 도메인의 1차 책임 에이전트. 자기 데이터 소스(Naver News)를 직접 수집하고 분석한다.

## 한 줄 역할

원시 뉴스 헤드라인을 Gemini로 분석해 중요도·테마 분류, 시장 영향 판단, 상위 3개 기사 선정을 한다.

## 진입점

```js
import { runTFNews } from './layer-2-research/tf-news/index.js';
const result = await runTFNews(pipelineData);   // 시장 데이터를 AI 키워드 컨텍스트로 사용
```

## 입력

| 인자 | 타입 | 설명 |
|------|------|------|
| `marketData` | object | Layer 1의 `pipelineData` 전체. `overseas`·`fxRates`는 AI 키워드 생성용 컨텍스트 |

## 출력

```ts
{
  findings: [
    { headline, theme, importance, market_impact, summary[], verified, source_url }
  ],
  top_stories: string[],   // 핵심 기사 3개
  themes: string[],        // 오늘의 핵심 테마 (반도체·금리 등)
  confidence: number,
  model_used: 'gemini-2.5-flash',
  news_raw: object[],      // ⭐ orchestrator가 다른 TF팀·DESK에 합성해 전달
}
```

## 데이터 소스 (자기 `feeds/`)

- `feeds/news_feed.js` — Naver Search API. 시장 컨텍스트(overseas·fxRates)를 AI 키워드 생성에 사용.

## 의존성

- `shared/utils/logger`, `shared/utils/gemini_retry`
- 외부: Google Gemini API (gemini-2.5-flash 기본)

## 실패 처리

- 뉴스 0건 → 분석 생략, `_emptyResult(news=[])` 반환.
- Gemini API 키 없음 → 분석 생략, raw만 노출.
- Gemini 503/네트워크 오류 → `geminiWithRetry` 재시도, 최종 실패 시 빈 결과.

## 발전 기록

- 2026-05-16: news_feed를 tf-news 소속으로 이동, 자체 수집 시작. `news_raw` 노출.
- 2026-05-15: 뉴스 중복 제거 규칙 강화 (같은 기업·이벤트 그룹화).
