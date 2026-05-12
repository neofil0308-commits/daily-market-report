# Daily Market Report — Content Platform

금융 시장 뉴스레터 자동화 시스템. 매일 08:00 KST GitHub Actions에서 실행되어
시장 데이터 수집 → TF팀 분석 → DESK 편집 → Gmail/Notion/Pages 발행 파이프라인을 구동한다.

## 아키텍처 (3-Layer Newsroom Model)

```
Layer 1 — DATA PIPELINE    순수 수집·정규화 (AI 없음, 빠르고 저렴)
Layer 2 — TF RESEARCH TEAMS  도메인별 AI 분석 (병렬 실행)
Layer 3 — THE DESK         선별·교차검증·편집·발행 (최종 결정권)
```

### Layer 1: Data Pipeline (`tools/pipeline/`)
| 파일 | 수집 대상 | 의존 API |
|------|-----------|----------|
| `index.js` | 전체 집약 진입점 | — |
| `market_feed.js` | 증시·환율·금리·원자재 | Yahoo Finance, Naver |
| `news_feed.js` | 원시 뉴스 헤드라인 | Naver Search API |
| `dart_feed.js` | 증권사 공시·리포트 | OpenDART API |
| `crypto_feed.js` | 코인 시세·온체인 | CoinGecko, Alternative.me |

기존 `tools/collectors/`는 `market_feed.js`와 `news_feed.js`로 래핑되었다.
수집 실패 시 항상 `null` 또는 `[]`를 반환하고 파이프라인을 중단하지 않는다.

### Layer 2: TF Research Teams (`tools/teams/`)
| 파일 | 역할 | 모델 | 입력 |
|------|------|------|------|
| `tf_news.js` | 뉴스 중요도 분류·테마 군집화 | gemini-2.5-flash | news_feed + market |
| `tf_analyst.js` | 컨센서스 추적·목표가 변동 감지 | gemini-2.5-flash | dart_feed |
| `tf_crypto.js` | 온체인 해석·규제 리스크·연계 기업 | gemini-2.5-flash | crypto_feed + news |

TF팀은 항상 `{ findings[], confidence, model_used }` 형태로 반환한다.
병렬 실행(`Promise.all`)이 기본이며 한 팀 실패가 전체를 중단하지 않는다.

### Layer 3: The Desk (`tools/desk/`)
| 파일 | 역할 |
|------|------|
| `editor.js` | TF 결과 선별·교차검증·내러티브 구성 |
| `designer.js` | 편집 결과 → HTML 리포트 조립 |
| `publisher.js` | Gmail·Notion·GitHub Pages 발행 |

DESK는 모든 TF 결과를 받아 오늘의 핵심 의제와 스토리를 결정한다.
상충 정보(뉴스 악재 ↔ 리포트 낙관론)는 DESK에서 명시적으로 조율한다.

## 에이전트 라우팅 (Sub-Agent Routing)

Claude Code에서 작업할 때 아래 에이전트를 `@agent-<name>` 또는 자동 라우팅으로 사용한다.

| 에이전트 | 언제 사용 | 파일 소유권 |
|---------|-----------|------------|
| `@agent-orchestrator` | 전체 워크플로우 실행·디버깅, 일일 리포트 생성 | `tools/orchestrator.js`, `.github/workflows/` |
| `@agent-pipeline` | 데이터 수집 오류, API 추가, 스크래핑 수정 | `tools/pipeline/`, `tools/collectors/` |
| `@agent-tf-news` | 뉴스 분류 로직, Gemini 프롬프트 튜닝 | `tools/teams/tf_news.js`, `tools/generators/` |
| `@agent-tf-analyst` | 애널리스트 리포트 파싱, DART 연동 | `tools/teams/tf_analyst.js`, `tools/pipeline/dart_feed.js` |
| `@agent-tf-crypto` | 코인 분석, CoinGecko 연동, 온체인 지표 | `tools/teams/tf_crypto.js`, `tools/pipeline/crypto_feed.js` |
| `@agent-desk` | HTML 디자인, 발행 로직, Notion 스키마 | `tools/desk/`, `tools/publishers/`, `tools/preview_send.js` |

## 주요 명령어

```bash
# 전체 워크플로우 (데이터 수집 + 리포트 생성 + 발행)
node tools/orchestrator.js --now

# 데이터 수집만 (dry-run, 발행 생략)
node tools/main.js --now --dry-run

# 리포트 생성 + 발행 (기존 data.json 재사용)
node tools/preview_send.js

# TF팀 단독 실행 (디버깅용)
node tools/teams/tf_news.js --date 2026-05-12
node tools/teams/tf_crypto.js --date 2026-05-12

# GA 워크플로우 재현 (로컬)
npm run dry-run && node tools/preview_send.js
```

## 환경 변수

```
# 필수
GOOGLE_API_KEY         Gemini API (뉴스 요약·분석)
NAVER_CLIENT_ID        Naver Search API
NAVER_CLIENT_SECRET    Naver Search API
GMAIL_SENDER           발신 Gmail 주소
GMAIL_APP_PASSWORD     Gmail 앱 비밀번호
GMAIL_RECIPIENT        수신 주소
NOTION_API_KEY         Notion 통합 키
NOTION_PAGE_ID         일일 리포트 페이지 ID
NOTION_ARCHIVE_DB_ID   아카이브 DB ID
PAGES_BASE_URL         GitHub Pages 기본 URL

# 선택 (없으면 기능 비활성화)
DART_API_KEY           OpenDART API — tf-analyst 필요
GEMINI_MODEL           기본값: gemini-2.5-flash
OUTPUT_DIR             기본값: ./outputs
```

## 핵심 파일 참조

```
tools/
├── orchestrator.js         새 통합 진입점 (3-layer)
├── main.js                 기존 GA 진입점 (하위 호환 유지)
├── preview_send.js         기존 HTML 생성·발송 스크립트
├── pipeline/               Layer 1 — 데이터 수집
├── teams/                  Layer 2 — TF 분석
├── desk/                   Layer 3 — 편집·발행
├── collectors/             레거시 (pipeline/market_feed.js로 래핑됨)
├── publishers/             Gmail·Notion (desk/publisher.js에서 호출)
├── validators/             데이터 정합성 검증
└── utils/                  공용 유틸 (logger, holiday)

outputs/{YYYY-MM-DD}/
├── data.json               수집 데이터 (Layer 1 출력)
├── tf_results.json         TF팀 분석 결과 (Layer 2 출력)
├── report.html             최종 HTML 리포트
└── sent.flag               로컬 중복 발송 방지 플래그
```

## 개발 가이드라인

- **하위 호환**: `tools/main.js`와 `tools/preview_send.js`는 GA 워크플로우용으로 유지.
  새 기능은 `tools/orchestrator.js` 파이프라인에 추가.
- **실패 격리**: 각 TF팀·피드는 실패 시 `null`/`[]` 반환. 절대 throw로 전체 중단 금지.
- **데이터 저장**: Layer 1 → `data.json`, Layer 2 → `tf_results.json`. 각 단계 재실행 가능.
- **모델 비용**: 수집(AI 없음) → 분석(`gemini-2.5-flash`) → 편집(`gemini-2.5-flash`).
  대량 처리(TF-1 뉴스)는 `gemini-2.0-flash-lite` 사용 고려.
- **중복 발송 방지**: 로컬은 `sent.flag`, GA는 Notion DB 날짜 조회로 이중 보호.
