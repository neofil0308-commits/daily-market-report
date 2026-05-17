# Layer 3 · Editor (편집)

> 편집장의 1차 보좌역. 모든 TF 결과를 받아 오늘의 핵심 의제와 섹션 우선순위를 결정한다.

## 한 줄 역할

뉴스·애널리스트·코인 분석 결과를 교차 검증하고, **헤드라인 한 줄**과 **섹션 포함 여부**를 결정한다.

## 진입점

```js
import { runEditor } from './layer-3-desk/editor/index.js';
const editorialPlan = await runEditor(desktopData, tfResults);
```

## 입력

| 인자 | 타입 | 설명 |
|------|------|------|
| `desktopData` | object | orchestrator가 합성한 데이터 (`pipelineData` + news/crypto/dart raw) |
| `tfResults` | object | `{ news, analyst, crypto }` 3개 TF팀 결과 |

## 출력 (`editorialPlan`)

```ts
{
  headline: string,         // 오늘을 관통하는 한 줄
  summary_md: string,       // AI 요약 (마크다운 bullet)
  include_crypto: boolean,
  include_analyst: boolean,
  // ...섹션 가중치·내러티브 구성 결정
}
```

## 편집 결정 규칙

1. **헤드라인**: 시장을 관통하는 핵심 한 줄. 휴장일·해외 큰 변동 시 그쪽이 우선.
2. **섹션 우선순위**: 코인 이슈 큰 날 → crypto 섹션 확대 / 평일 → KOSPI 위주.
3. **상충 정보 조율**: 뉴스 악재 ↔ 애널리스트 낙관론 같은 경우 양쪽 명시.
4. **데이터 정합성**: KOSPI 종가가 null이면 헤드라인에서 KOSPI 수치 제외 등.

## 의존성

- `shared/utils/logger`, `shared/utils/gemini_retry`
- 외부: Google Gemini API (헤드라인·AI 요약 생성)

## 실패 처리

- Gemini 실패 → 기본 플랜 사용 (헤드라인 null, 모든 섹션 기본 포함).
- 데이터 부족 → 해당 섹션 자동 제외 플래그.

## 발전 기록

- 2026-05-16: Summary 풍부화 — AI Summary 5~7개 불릿(60~90자 완결 문장)·증권사 데일리 시황 톤으로 강화. sectionSummaries 2~4 문장(수치+트렌드+원인+영향)으로 확장. Gemini 503 폴백을 빈 배열 → sectionSummaries 기반 결정론적 불릿 조립으로 교체. domestic에 VKOSPI·5거래일 수급 추이 추가, overseas에 SOX 및 동조 부담 해석 추가, fxRates에 bp 변화 및 강달러 메커니즘 추가, commodities에 안전자산 vs 위험자산 분석 추가, crypto에 김치프리미엄·공포탐욕지수 해석 추가.
- 2026-05-16: 코인 Summary 일관화 — `_summCrypto()`를 다른 섹션과 동일 패턴(사실 문장 + 원인 절)으로 재작성. tf.crypto.market_summary 직접 재사용 제거, BTC·ETH 가격/등락률·공포탐욕지수·TF 시그널을 자체 조립.
- 2026-05-16: 상충 정보 자동 감지 추가 — `_detectConflicts(tf)` 신설. analyst 긍정 레이팅 + news 부정 시장영향(또는 반대) 조합을 최대 3건 감지해 `editorialPlan.conflicts` 배열로 반환.
- 2026-05-16: 섹션 Summary에 원인 절(why) 추가 — `_findCauseFromNews()` 헬퍼 신설, tf.news.findings 키워드 매칭으로 importance 상위 1~2건 발췌, 매칭 실패 시 themes 힌트 또는 생략.
- 2026-05-16: 5개 섹션 Summary 자동 생성 추가 (sectionSummaries).
- 2026-05-15: 헤드라인 데이터 검증 추가 (KOSPI 수치 누락 시 제거).
- 2026-05-14: AI Summary 생성 추가.
