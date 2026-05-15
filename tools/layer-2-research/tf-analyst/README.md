# Layer 2 · TF-Analyst

> 애널리스트 리포트 도메인의 1차 책임 에이전트. 한경 컨센서스(1차)와 DART(보조)를 자체 수집한다.

## 한 줄 역할

증권사 애널리스트 리포트의 목표주가 변동·투자의견 변경·핵심 논거를 Gemini로 큐레이션해 오늘 주목할 3건을 선정한다.

## 진입점

```js
import { runTFAnalyst } from './layer-2-research/tf-analyst/index.js';
const result = await runTFAnalyst(newsRaw);   // tf-news가 수집한 raw를 받음
```

## 입력

| 인자 | 타입 | 설명 |
|------|------|------|
| `newsData` | object[] | tf-news가 수집한 원시 뉴스 (애널리스트 관련 기사 필터링용) |

## 출력

```ts
{
  findings: [
    { company, sector, firm, rating_change, target_price: { prev, new, change_pct }, key_thesis, report_url, importance }
  ],
  sector_sentiment: { 반도체: '긍정', ... },
  consensus_changes: number,
  alert_items: object[],     // importance ≥ 8
  confidence: number,
  model_used: 'gemini-2.5-flash',
  consensus_raw: object[],   // ⭐ 한경 컨센서스 raw (orchestrator 폴백·링크 매핑용)
  dart_reports: object[],    // ⭐ DART 공시 raw (orchestrator 최종 폴백용)
}
```

## 데이터 소스 (자기 `feeds/` + 내부 함수)

- `feeds/dart_feed.js` — OpenDART API (DART_API_KEY 필요). 사업보고서류 위주라 애널리스트 리포트는 거의 0건.
- 내부 `fetchHankyungConsensus()` — 한경 컨센서스 스크래핑 (consensus.hankyung.com).
  - **1차 소스** — DART보다 신뢰도·커버리지 압도적.
  - 풀 Chrome UA + Accept 헤더 필수 (짧은 UA는 500 거부).
  - 5xx/네트워크 오류는 1.5초 간격 재시도 (총 3회).

## 의존성

- `shared/utils/logger`, `shared/utils/gemini_retry`
- 외부: Hankyung Consensus, OpenDART, Google Gemini API

## 실패 처리

- 한경 일시 500 → 3회 재시도 후 빈 배열. orchestrator 폴백 체인 발동.
- DART 0건은 정상 (사업보고서류 필터 때문).
- 분석 소스 0건(한경·DART·뉴스 모두 비어있음) → 건너뜀.

## 발전 기록

- 2026-05-16: dart_feed를 tf-analyst 소속으로 이동, 자체 수집. `dart_reports` 노출.
- 2026-05-16: 한경 신규 엔드포인트 대응 (`/apps.analysis/...` → `/analysis/list`).
- 2026-05-16: 옛 한경 URL 자동 변환 안전망 추가 (orchestrator에 `normalizeHankyungUrl`).
- 2026-05-16: 한경 fetch 1.5초 간격 재시도 (간헐 500 자동 복구).
- 2026-05-15: 1차 소스를 DART → 한경 컨센서스로 격상.
