# Layer 3 · Design (디자인)

> 시각화 전담 에이전트. 편집장의 의제(editorialPlan)와 TF 결과를 받아 HTML 리포트와 메일 카드를 조립한다.

## 한 줄 역할

데이터 → HTML/CSS. 한경 코리아마켓 톤(쿨톤·고밀도·한국 증시 빨강/파랑 관례)을 일관되게 적용한다.

## 진입점

```js
import { buildHtml, buildEmailCard } from './layer-3-desk/design/index.js';
const html = buildHtml(desktopData, tfResults, editorialPlan);   // 전체 리포트 (GitHub Pages용)
const card = buildEmailCard(desktopData, tfResults, editorialPlan, reportUrl);  // 메일 본문
```

## 입력

| 인자 | 타입 | 설명 |
|------|------|------|
| `pipelineData` | object | orchestrator가 합성한 데이터 (편의상 인자명 유지) |
| `tfResults` | object | TF팀 결과 |
| `editorialPlan` | object | 편집 결정 |
| `reportUrl` | string | (`buildEmailCard`만) "전체 보기" CTA 링크 |

## 출력

- `buildHtml`: 전체 HTML 문서 (~45KB, Chart.js 포함 5거래일 수급 추이 그래프)
- `buildEmailCard`: Gmail 본문용 인라인 스타일 HTML (Gmail 호환성 위해 `<style>` 최소화)

## 디자인 가이드라인

- **레퍼런스**: `templates/design_guidelines.md` (한경 코리아마켓 8장 분석 결과)
- **색 변수**: `:root` CSS variables — 상승 빨강(`#E24B4A`)·하락 파랑(`#378ADD`)·검정(`#1e2330`)
- **폰트**: Apple SD Gothic Neo > Malgun Gothic > Noto Sans KR
- **콘텐츠 너비**: 최대 1100px

## 의존성

- `shared/utils/logger`, `shared/utils/formatter`
- 외부: Chart.js (CDN 인라인)

## 실패 처리

- 데이터 필드 누락 → 해당 섹션 자동 생략 또는 "—" 표시.
- 휴장일 → "휴장" 표시 + 폴백 데이터로 시가총액·VKOSPI는 표시.

## 발전 기록

- 2026-05-16: 옛 한경 URL 자동 변환 안전망은 orchestrator로 이관 (design은 받은 URL 그대로 사용).
- 2026-05-15: 헤드라인 데이터 검증 + AI Summary 박스.
- 2026-05-14: 5거래일 수급 추이 차트 추가.
