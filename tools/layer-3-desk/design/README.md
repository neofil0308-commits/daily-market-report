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

- 2026-05-16 (5차 — 최종 micro 보정): `.ntbl th`에 `font-variant-numeric:tabular-nums` 명시 추가, `.td-cat`에 `font-variant-numeric:tabular-nums` 추가(`.td-date`와 대칭), `.hdr-date-sub` letter-spacing 0.08em→0.10em (`.hdr-eng` 0.15em 과의 위계 간격 유지하되 근접화). 구조·색·기능 변경 없음. 문법 직독 검증 완료.
- 2026-05-16 (4차 보완): A. 헤드라인 임팩트 강화 — `.headline-block` 신설(border-left:4px solid #1e3a8a, 28px Bold, line-height 1.3), `TODAY'S HEADLINE` 레이블(10px uppercase letter-spacing 0.15em), buildHtml·buildEmailCard 양쪽 동일 패턴 적용.
- 2026-05-16 (4차 보완): B. 풋터/면책 강화 — `.report-footer` 섹션 신설(배경 #fafafa, 20px 패딩, 구분선), 출처·발행정보·면책 3블록 분리, 요일 영문(`['SUN'~'SAT'][date.getDay()]`) 포함. 메일 카드 CTA 위쪽 분리 + 동일 3블록 인라인 스타일 풋터 적용.
- 2026-05-16 (4차 보완): C. 차트 색 PDF 톤 통일 — KOSPI 선/점 `#E24B4A`→`#1e3a8a`(딥 네이비), 거래대금 막대 `rgba(55,138,221)`→`rgba(55,65,81)`(차콜), 격자선 `#e5e7eb`, 축 라벨 `#475569`. quickchart.io 폴백도 동일 색 적용.
- 2026-05-16 (4차 보완): D. 메타 정보 위치 정돈 — 헤더 좌측 `DAILY MARKET REPORT`(11px uppercase) + `일일 시장 리포트`(16px Bold), 우측 `YYYY.MM.DD`(13px Bold) + `DOW · 08:00 KST`(10px uppercase). `border-bottom:2px solid var(--border-strong)` 구분선. buildHtml·buildEmailCard 양쪽 적용. 요일 영문 변환 EN_DAYS 배열 추가.
- 2026-05-16 (2): 사주 지적 2건 보정 — 코인 섹션 `tfCrypto.market_summary` 중복 박스 제거(sectionSummaries.crypto 단일화), 전 표 `table-layout:fixed` + th 너비 명시(국내·해외·추이·FX·원자재·코인·애널리스트·뉴스 각 컬럼 %, ntbl px 고정), `.tbl th.r` 추가, `.s-analyst td.bi` 줄바꿈 허용, `.ntbl td` text-overflow 제어.
- 2026-05-16: 사주 인터뷰 2차 — 모바일 다이제스트 적용. buildHtml: @media(max-width:600px) 표 카드형 변환(thead 숨김, tr→블록 카드, 1열 15px Bold 타이틀, 2·3열 14px 수치, 5열~ 11px 서브). buildEmailCard: mktSection·fxSection·coinSection·analystSection 제거, 핵심 수치 3카드(KOSPI·S&P500·BTC) 신규, 뉴스 6→3건 다이제스트, 알림 박스(김치프리미엄 한 줄 + 목표가 변동 한 줄), 헤드라인 박스, 조립 순서 재편(헤드라인→상충/Summary→3카드→뉴스3건→알림→CTA).
- 2026-05-16: 사주 인터뷰 기반 증권사 PDF 격식 전면 재구축 — 순백 배경(#ffffff), 잉크 검정(#0f172a), 5개 섹션별 액센트(네이비·차콜·인디고·어스브론즈·딥티얼), 모든 td/th 1px 전체 경계, 섹션 제목 듀얼 표기(영문 11px uppercase letter-spacing 0.15em + 한글 16px Bold), tabular-nums 숫자 컬럼, 김치프리미엄·목표가변동·상충알림 3개 신규 박스, buildEmailCard 동일 톤 인라인 적용.

- 2026-05-16: 색상·톤 세련화 — 저채도+깊은 콘트라스트 방향 채택. 텍스트 1차 #111827(거의 검정), 2차 #4b5563, 액센트 #1e40af(딥 인디고). CSS variables(--color-th-bg, --color-accent 등) 신설, 라이트/다크 테마 분기 구조 마련.
- 2026-05-16: 표 여백 조정 — th·td 패딩 6→5px(좌우), 폰트 td 13→12px, th 11→10px uppercase. 코인 섹션 인라인 th/td 동일 기준 적용. buildEmailCard 섹션 패딩 24→22px.
- 2026-05-16: 모바일 뷰 최적화 — @media(max-width:600px) 보강. 표 min-width:460px + overflow-x:auto 가로 스크롤, 불필요 열(.td-sum·.td-date) 최소화, 수급 카드 단열, 차트 160px, body padding 8×6px.
- 2026-05-16: 다크 모드 옵션 — editorialPlan.theme==='dark'이면 <html>에 .theme-dark 추가. CSS .theme-dark{} 블록에 --bg-page:#0b0f1a·--bg-card:#131929·--color-accent:#60a5fa 등 다크 팔레트 정의. 라이트 기본, 다크는 향후 활성화용.
- 2026-05-16: 비고 열 제거·섹션 Summary 박스 신설·폰트 위계 통일 — 5개 섹션(국내/해외/환율/원자재/코인) 비고 th·td 삭제, editorialPlan.sectionSummaries 인디고 박스 삽입(buildHtml·buildEmailCard 양쪽), 폰트 위계 표준화(헤드라인 20px Bold, 섹션 15px Bold, th 11px Bold, td 13px Regular, 메타 11px Regular, 태그 10px Bold).
- 2026-05-16: 쿨톤·고밀도 개편 — 강조 배경을 슬레이트·인디고·blue 계열로 통일, 보조 텍스트 #475569/#64748b로 진하게, .wrap 패딩 32×36→24×28px, .sec 간격 2rem→1.4rem, 셀 패딩 8→6px, ntbl 9→7px, summary-box margin 1.8→1.4rem.
- 2026-05-16: 옛 한경 URL 자동 변환 안전망은 orchestrator로 이관 (design은 받은 URL 그대로 사용).
- 2026-05-15: 헤드라인 데이터 검증 + AI Summary 박스.
- 2026-05-14: 5거래일 수급 추이 차트 추가.
