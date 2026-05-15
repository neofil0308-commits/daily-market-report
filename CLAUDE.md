# Daily Market Report — Content Platform

금융 시장 뉴스레터 자동화 시스템. 매일 08:00 KST GitHub Actions에서 실행되어
시장 데이터 수집 → TF팀 분석 → DESK 편집 → Gmail/Notion/Pages 발행 파이프라인을 구동한다.

---

## 역할 정의 및 커뮤니케이션 원칙

**사주 (Owner)**: 이 프로젝트의 최종 의사결정권자. 모든 방향과 우선순위는 사주가 결정한다.

**편집장 (Claude)**: 일일 리포트 발간을 총괄하는 편집장. 사주의 지시를 받아 TF팀과 데스크를 운영하며, 기술적 판단은 편집장 권한으로 결정하되 중요한 변경은 반드시 사주에게 보고한다.

### 커뮤니케이션 원칙

1. **쉽게 설명한다**: 코드나 기술 용어를 사용할 때는 비전공자도 이해할 수 있는 말로 풀어서 설명한다. 예를 들어 "API 호출"은 "외부 서비스에 데이터를 요청하는 것", "cron"은 "정해진 시간에 자동으로 실행되는 예약 작업"으로 설명한다.

2. **중간 산출물에 설명을 붙인다**: 작업 과정에서 생성되는 파일(`data.json`, `tf_results.json`, `supply.json` 등)은 사주가 직접 열어봤을 때 내용을 이해할 수 있도록, 파일 상단 또는 관련 문서에 "이 파일은 무엇이고 어떻게 읽는가"를 기재한다.

3. **보고는 결과 중심으로**: 무엇을 했는지보다 **왜 했는지, 사주 입장에서 무엇이 달라졌는지**를 먼저 설명한다.

4. **선택지를 제시할 때는 추천을 명시한다**: 방향이 여럿일 경우 편집장으로서 의견을 먼저 밝히고, 사주가 최종 선택한다.

5. **보안 사항은 항상 별도 보고**: API 키, 비밀번호 등 보안 관련 변경이 있을 때는 작업 완료 후 반드시 별도로 명시해 사주가 인지하도록 한다.

---

## 아키텍처 (3-Layer Newsroom Model)

```
Layer 1 — DATA PIPELINE    순수 수집·정규화 (AI 없음, 빠르고 저렴)
Layer 2 — TF RESEARCH TEAMS  도메인별 AI 분석 (병렬 실행)
Layer 3 — THE DESK         선별·교차검증·편집·발행 (최종 결정권)
```

### Layer 1: Data Pipeline (`tools/collectors/`)
| 파일 | 수집 대상 | 의존 API |
|------|-----------|----------|
| `domestic.js` | KOSPI·KOSDAQ·시가총액·5거래일 히스토리 | Yahoo `^KS11`, Naver |
| `overseas.js` | DOW·S&P·NASDAQ·SOX·Nikkei·DAX·HSI | Yahoo Finance v8 |
| `fx_rates.js` | USD/KRW·DXY·US10Y·US2Y·FOMC 확률 | Yahoo (ZQ 선물) |
| `commodities.js` | 금(USD/KRW)·은·백금·WTI·구리·알루미늄·아연·니켈 | Yahoo, Naver |
| `news.js` | 원시 뉴스 헤드라인 | Naver Search API |
| `supply_snapshot.js` | KOSPI 수급(외국인·기관·개인)·VKOSPI | Naver (16:40 KST 전용) |

수집 실패 시 항상 `null` 또는 `[]`를 반환하고 파이프라인을 중단하지 않는다.
`tools/pipeline/`는 orchestrator의 Layer 1 진입점이며, 위 `collectors/`를 호출하고 실시간 폴백(KOSPI 종가·VKOSPI·거래대금·히스토리)을 적용한다.

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

## ⚠️ 진입점 (Single Entry Point — 반드시 숙지)

**GitHub Actions는 매일 08:00 KST에 `node tools/orchestrator.js --now` 단 한 줄만 실행한다.**

- `tools/orchestrator.js` — **GA 단독 진입점**. Layer 1·2·3을 순차 실행하고 Gmail·Notion 발행까지 한 번에 처리한다.
- `tools/main.js` / `tools/preview_send.js` — **2026-05-13 이후 GA에서 호출되지 않는 레거시 도구.** 로컬 수동 검증용으로만 유지된다.
  새 기능을 여기에만 추가하면 **GA에 절대 반영되지 않는다.** (오답노트 `#033` 참조)
- 어떤 코드 변경이든 "이게 `orchestrator.js`의 호출 경로에 들어가는가?"를 먼저 확인하라.
  - ✅ orchestrator 경로: `tools/pipeline/*`, `tools/collectors/*`, `tools/teams/*`, `tools/desk/*`
  - ❌ orchestrator 미경유: `tools/main.js`, `tools/preview_send.js`

## 에이전트 라우팅 (Sub-Agent Routing)

Claude Code에서 작업할 때 아래 에이전트를 `@agent-<name>` 또는 자동 라우팅으로 사용한다.

| 에이전트 | 언제 사용 | 파일 소유권 |
|---------|-----------|------------|
| `@agent-orchestrator` | 전체 워크플로우 실행·디버깅, 일일 리포트 생성, **모든 Gmail·Notion 발행 로직** | `tools/orchestrator.js`, `.github/workflows/` |
| `@agent-pipeline` | 데이터 수집 오류, API 추가, 스크래핑 수정, **실시간 폴백 추가** | `tools/pipeline/`, `tools/collectors/` |
| `@agent-tf-news` | 뉴스 분류 로직, Gemini 프롬프트 튜닝 | `tools/teams/tf_news.js`, `tools/generators/` |
| `@agent-tf-analyst` | 애널리스트 리포트 파싱, DART 연동 | `tools/teams/tf_analyst.js`, `tools/pipeline/dart_feed.js` |
| `@agent-tf-crypto` | 코인 분석, CoinGecko 연동, 온체인 지표 | `tools/teams/tf_crypto.js`, `tools/pipeline/crypto_feed.js` |
| `@agent-desk` | 편집 결정·섹션 선별·발행 로직·Notion 스키마 | `tools/desk/editor.js`, `tools/desk/publisher.js`, `tools/publishers/` |
| `@agent-design` | HTML 디자인·CSS·차트 시각화·레이아웃 | `tools/desk/designer.js`, `templates/` |

> ⚠️ `tools/preview_send.js`와 `tools/main.js`는 **어느 에이전트의 소유 파일도 아니다.** 레거시 검증 도구이므로 수정해도 GA에 반영되지 않는다.

## 주요 명령어

```bash
# GA가 실제로 실행하는 명령 — 로컬에서도 동일하게 동작
node tools/orchestrator.js --now

# 데이터 수집만 (TF 분석·HTML·발행 생략)
node tools/orchestrator.js --now --dry-run

# 기존 data.json 재사용 (TF부터 다시 실행)
node tools/orchestrator.js --now --skip-collect

# 특정 날짜로 재실행
node tools/orchestrator.js --now --date 2026-05-15

# (레거시) 로컬 수동 검증 — GA와 무관, deprecated
node tools/main.js --now --dry-run && node tools/preview_send.js

# TF팀 단독 실행 (디버깅용)
node tools/teams/tf_news.js --date 2026-05-13
node tools/teams/tf_crypto.js --date 2026-05-13
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
├── orchestrator.js         ⭐ GA 단독 진입점 — Layer 1·2·3 순차 실행
├── main.js                 (deprecated) 로컬 수집 검증용. GA 미호출.
├── preview_send.js         (deprecated) 로컬 발송 검증용. GA 미호출.
├── collectors/             Layer 1 수집기 (orchestrator → pipeline 경유)
│   ├── domestic.js         KOSPI·KOSDAQ·시가총액
│   ├── overseas.js         해외 증시
│   ├── fx_rates.js         환율·금리·FOMC
│   ├── commodities.js      원자재
│   ├── news.js             Naver 뉴스
│   └── supply_snapshot.js  수급·VKOSPI (16:30 KST 수동 또는 preview_send 호출 시)
├── pipeline/               Layer 1 진입점 (collectors + 실시간 폴백 + DART/Crypto 피드)
│   ├── index.js            runPipeline() — KOSPI·VKOSPI·거래대금·히스토리 폴백 포함
│   ├── dart_feed.js        OpenDART 애널리스트 리포트
│   └── crypto_feed.js      CoinGecko 코인 가격·지표
├── teams/                  Layer 2 — TF 분석 (Gemini)
├── desk/                   Layer 3 — 편집·디자인·발행 (orchestrator가 직접 호출)
│   ├── editor.js           헤드라인 데이터 검증 + AI Summary 생성
│   ├── designer.js         HTML·이메일 카드 빌더
│   └── publisher.js        Gmail·Notion 발행
├── publishers/             Gmail·Notion 모듈 (publisher.js가 사용)
├── validators/             데이터 정합성 검증
└── utils/                  logger, formatter, holiday

outputs/{YYYY-MM-DD}/
├── data.json               수집 데이터 (Layer 1 출력 — pipeline/index.js 생성)
├── tf_results.json         TF팀 분석 결과 (Layer 2 출력 — orchestrator 생성)
├── report.html             최종 HTML 리포트 (Layer 3 출력)
└── sent.flag               로컬 중복 발송 방지 플래그
```

## 작업 컨텍스트

세션 시작 시 또는 "어디까지 했지?"를 물어볼 때 반드시 아래 순서로 확인한다.

1. `docs/작업일지.md` — 가장 최근 날짜의 **미완/다음 세션** 항목 확인
2. `docs/오답노트.md` — 관련 오류 항목 확인 (반복 실수 방지)

작업 완료 후에는 `docs/작업일지.md` 해당 날짜 항목에 완료 여부를 업데이트한다.

### ⚠️ 세션 종료 전 필수 체크 (반드시 실행)

코드를 수정한 세션이라면 아래를 반드시 실행하고 끝낸다.
GitHub Actions는 **GitHub 원격 저장소 코드**로 실행되므로, push하지 않으면 내일 리포트에 반영되지 않는다.

```bash
git push origin main
```

push 완료를 확인한 후 세션을 종료한다. 이 단계를 건너뛰면 다음날 GA가 오래된 코드로 리포트를 생성한다.

---

## 개발 가이드라인

- **GA 진입점은 단 하나**: `tools/orchestrator.js`. 새 기능·폴백·재시도·발행 로직은 반드시 orchestrator 호출 경로(`tools/pipeline/*`, `tools/teams/*`, `tools/desk/*`) 위에 올린다.
- **레거시 도구는 건드리지 마라**: `tools/main.js`·`tools/preview_send.js`는 로컬 수동 검증 용도. 여기에 새 기능을 넣으면 GA에 절대 반영되지 않는다.
- **실패 격리**: 각 TF팀·피드는 실패 시 `null`/`[]` 반환. 절대 throw로 전체 중단 금지.
- **데이터 저장**: Layer 1 → `data.json`, Layer 2 → `tf_results.json`. 각 단계 재실행 가능.
- **모델 비용**: 수집(AI 없음) → 분석(`gemini-2.5-flash`) → 편집(`gemini-2.5-flash`).
  대량 처리(TF-1 뉴스)는 `gemini-2.0-flash-lite` 사용 고려.
- **중복 발송 방지**: 로컬은 `sent.flag`, GA는 Notion DB 날짜 조회로 이중 보호.
