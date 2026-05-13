# 일일 시장 리포트 워크플로우

**목표**: 매 평일 08:00 KST, 전일 종가 기준 시장 데이터를 수집하고 HTML 리포트를 생성하여
Gmail·Notion·GitHub Pages에 발행한다. 16:40 KST에는 당일 수급 스냅샷을 별도로 수집한다.

**아키텍처**: 3-Layer Newsroom Model
```
Layer 1 — DATA PIPELINE      tools/pipeline/ + tools/collectors/  (AI 없음)
Layer 2 — TF RESEARCH TEAMS  tools/teams/                          (Gemini)
Layer 3 — THE DESK           tools/desk/ + tools/preview_send.js  (Gemini + 발행)
```

---

## GitHub Actions 스케줄

| 워크플로우 | 파일 | 트리거 | 실행 시각 (KST) |
|-----------|------|--------|----------------|
| Daily Market Report | `.github/workflows/daily-report.yml` | cron + workflow_dispatch | 08:00 (주) / 10:00 (백업) |
| Supply Snapshot | `.github/workflows/supply-collect.yml` | cron + workflow_dispatch | 16:40 (장 마감 후) |

> **cron-job.org 외부 스케줄러**: GA Free Plan cron은 최대 수 시간 지연될 수 있다.
> 두 워크플로우 모두 cron-job.org가 `workflow_dispatch` API를 호출해 보장한다.
> - daily-report: jobId **7594591** (08:00 KST)
> - supply-collect: jobId **7594700** (16:40 KST)

---

## 결과물

| 파일 | 생성 시점 | 설명 |
|------|-----------|------|
| `outputs/YYYY-MM-DD/data.json` | 08:00 Step 1 | Layer 1 수집 원본 |
| `outputs/YYYY-MM-DD/tf_results.json` | 08:00 Step 2 | Layer 2 TF팀 분석 결과 |
| `outputs/YYYY-MM-DD/report.html` | 08:00 Step 3 | 최종 HTML 리포트 |
| `outputs/YYYY-MM-DD/sent.flag` | 08:00 Step 3 | 로컬 중복 발송 방지 플래그 |
| `outputs/YYYY-MM-DD/supply.json` | 16:40 별도 | 수급·VKOSPI 스냅샷 |

---

## 일일 리포트 실행 단계 (daily-report.yml)

### STEP 1 — 데이터 수집
```bash
node tools/main.js --now --dry-run
```
`tools/collectors/` 하위 5개 수집기를 병렬 실행:
- `domestic.js` — KOSPI·KOSDAQ·시가총액·KOSPI 5거래일 히스토리
- `overseas.js` — DOW·S&P500·NASDAQ·SOX·Nikkei·DAX·HSI
- `fx_rates.js` — USD/KRW·DXY·US10Y·US2Y·FOMC 확률 (ZQ 선물)
- `commodities.js` — 금(USD/KRW)·은·백금·WTI·구리·알루미늄·아연·니켈
- `news.js` — Naver Search API 뉴스 헤드라인

결과 → `outputs/{date}/data.json` 저장

### STEP 2 — HTML 생성 + 발행
```bash
node tools/preview_send.js
```
내부에서 아래 순서로 실행:
1. `data.json` 로드
2. TF팀 병렬 실행: `tf_news.js` + `tf_analyst.js` (Gemini)
3. `buildHtml()` — HTML 리포트 생성 (`designer.js`)
   - `_buildSummaryMap()` — Gemini AI 요약 생성
   - `_buildRowNotes()` — KOSPI 추이 테이블 비고 생성
4. Gmail 발송 (`nodemailer`)
5. Notion 아카이브 DB 저장 (`@notionhq/client`)
6. `sent.flag` 생성 (중복 방지)

### STEP 3 — GitHub Pages 배포
```yaml
peaceiris/actions-gh-pages@v4
publish_dir: ./outputs → destination_dir: outputs
```
리포트 HTML이 `PAGES_BASE_URL/outputs/{date}/report.html` 로 접근 가능해진다.

---

## 수급 스냅샷 실행 단계 (supply-collect.yml)

```bash
node tools/collectors/supply_snapshot.js
```
- Naver `polling.finance.naver.com/api/realtime/domestic/index/KOSPI_INVESTOR` 호출
- **16:30 KST 이후에만 당일 최종 수급 데이터 반환** (장 중엔 null)
- 09:00 KST 이전 실행 시 → 전 거래일 폴더에 저장
- 결과 → `outputs/{date}/supply.json` 저장 후 git commit·push

> **소급 수집 불가**: Naver API는 실시간 전용이다. 당일 16:30~16:40 사이를 놓치면
> 해당 날의 수급 데이터는 영구적으로 복구 불가능하다. (오답노트 #011 참조)

---

## 입력 데이터 소스

| 항목 | API/URL | 비고 |
|------|---------|------|
| 국내 증시 | Yahoo `^KS11`·`^KQ11`, Naver m.stock.naver.com | 전일 종가 |
| 해외 증시 | Yahoo Finance v8 | 전일 종가 |
| 환율·금리 | Yahoo `USDKRW=X`, `DX-Y.NYB`, `^TNX`, `^IRX` | |
| FOMC 확률 | Yahoo ZQ 선물 `ZQK26`, `ZQM26`, `ZQU26` | CME |
| 원자재 | Yahoo `GC=F`·`SI=F`·`PL=F`·`CL=F`·`HG=F`·`ALI=F`·`HG=F` | |
| 국내 금 시세 | Naver `finance.naver.com/marketindex/goldDailyQuote` (EUC-KR) | |
| 수급 스냅샷 | Naver `polling.finance.naver.com/api/realtime` | 16:30 KST 이후 |
| 뉴스 헤드라인 | Naver Search API `openapi.naver.com/v1/search/news` | |
| 증권사 공시 | OpenDART `opendart.fss.or.kr/api` | DART_API_KEY 필요 |
| 코인 | CoinGecko `api.coingecko.com/api/v3` | |
| Fear & Greed | `api.alternative.me/fng/` | |

---

## 실패 처리

| 상황 | 대응 |
|------|------|
| 특정 API 수집 실패 | `null`/`[]` 반환, 파이프라인 계속 진행 |
| Gemini API 429 (quota) | AI Summary·비고·TF 분석 빈값, 리포트는 정상 생성 |
| supply.json 없음 | 수급 카드 대신 시장 강도(breadth) 카드로 자동 대체 |
| 공휴일(한국) | `meta.krHoliday=true`, 국내 증시 데이터 skip |
| 공휴일(미국 전일) | 해외 증시 "휴장" 표기 |
| sent.flag 존재 | Gmail 재발송 차단 (로컬 중복 방지) |
| Notion DB 날짜 존재 | GA 환경에서 재발송 차단 (GA 중복 방지) |

---

## 수동 실행 명령어

```bash
# 전체 워크플로우 (수집 + HTML 생성 + Gmail + Notion)
node tools/main.js --now --dry-run && node tools/preview_send.js

# 데이터 수집만 (리포트 생략)
node tools/main.js --now --dry-run

# 기존 data.json으로 리포트만 재생성·재발송
node tools/preview_send.js

# TF팀 단독 실행 (디버깅)
node tools/teams/tf_news.js --date 2026-05-13
node tools/teams/tf_crypto.js --date 2026-05-13

# 수급 스냅샷 수동 수집
node tools/collectors/supply_snapshot.js

# GitHub Actions 수동 트리거 (curl)
curl -X POST \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/neofil0308-commits/daily-market-report/actions/workflows/daily-report.yml/dispatches \
  -d '{"ref":"main"}'
```

---

## 진단 체크리스트

문제 발생 시 이 순서로 확인한다:

1. `outputs/{date}/data.json` 존재? → Layer 1 수집 성공 여부
2. `outputs/{date}/report.html` 존재? → HTML 생성 성공 여부
3. `outputs/{date}/sent.flag` 존재? → Gmail 발송 완료 여부
4. `outputs/{date}/supply.json` 존재? → 수급 스냅샷 수집 여부
5. GitHub Actions 탭 → run log 확인
6. Notion DB에 해당 날짜 항목 존재 여부

---

## 핵심 파일 참조

```
tools/
├── main.js                 GA 데이터 수집 진입점 (--dry-run 모드로만 사용)
├── preview_send.js         HTML 생성 + Gmail + Notion 발행
├── orchestrator.js         3-layer 통합 진입점 (실험적, 미사용 중)
├── collectors/
│   ├── domestic.js         KOSPI·KOSDAQ·시가총액 수집
│   ├── overseas.js         해외 증시 수집
│   ├── fx_rates.js         환율·금리·FOMC 수집
│   ├── commodities.js      원자재 수집
│   ├── news.js             Naver 뉴스 수집
│   └── supply_snapshot.js  수급·VKOSPI 스냅샷 (16:40 KST 별도 실행)
├── teams/
│   ├── tf_news.js          뉴스 중요도 분류·테마 군집화 (Gemini)
│   ├── tf_analyst.js       증권사 리포트 파싱·컨센서스 추적 (Gemini)
│   └── tf_crypto.js        코인 분석·온체인·규제 리스크 (Gemini)
├── desk/
│   ├── designer.js         HTML 리포트 조립·CSS (Gemini for 비고·Summary)
│   └── publisher.js        Gmail·Notion·Pages 발행
├── pipeline/               신규 아키텍처 피드 (orchestrator.js 전용)
├── validators/             데이터 정합성 검증
└── utils/                  logger, formatter, holiday

.github/workflows/
├── daily-report.yml        08:00 KST 메인 워크플로우
└── supply-collect.yml      16:40 KST 수급 스냅샷 워크플로우
```
