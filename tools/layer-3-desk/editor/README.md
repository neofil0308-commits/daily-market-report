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

- 2026-05-15: 헤드라인 데이터 검증 추가 (KOSPI 수치 누락 시 제거).
- 2026-05-14: AI Summary 생성 추가.
