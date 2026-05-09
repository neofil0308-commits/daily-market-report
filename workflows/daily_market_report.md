# 일일 시장 리포트 워크플로우

**목표**: 매일 오전 7시, 전일 종가 기준 시장 데이터를 수집하고 HTML 리포트 위젯을 생성하여 Notion과 Slack에 발행한다.

**트리거**: 평일 07:00 KST (cron: `0 7 * * 1-5`)

**결과물**:
- `outputs/YYYY-MM-DD/data.json` — 수집 원본 데이터
- `outputs/YYYY-MM-DD/summary.md` — 뉴스 마크다운 요약
- `outputs/YYYY-MM-DD/report.html` — HTML 위젯 리포트
- Notion 페이지 업데이트 (전체 데이터 아카이브)
- Gmail 발송 (HTML 리포트 이메일 전달)

---

## 입력값

| 항목 | 출처 | 비고 |
|------|------|------|
| 국내 증시 (KOSPI/KOSDAQ) | KRX Data API | 전일 종가 |
| 해외 증시 (DOW/S&P/나스닥 등) | Yahoo Finance v8 | 전일 종가 |
| 환율 (USD/KRW, DXY) | 한국은행 OpenAPI + Yahoo Finance | |
| 금리 (미 10년/2년) | Yahoo Finance v8 | |
| 원자재 (금/은/WTI/구리 등) | Yahoo Finance v8 | |
| 뉴스 | 네이버 검색 API | 당일 07:00 이전 기사 |

---

## 실행 단계

### STEP 1 — 환경 확인
- `.env` 파일에 모든 API 키가 세팅되어 있는지 확인
- `outputs/` 디렉토리 생성

### STEP 2 — 공휴일 체크
- `tools/utils/holiday.js` 실행
- 한국/미국 공휴일 여부 판단 → 데이터 수집 방향 결정

### STEP 3 — 데이터 수집 (병렬)
다음 4개를 동시에 실행:
- `tools/collectors/domestic.js` → 국내 증시
- `tools/collectors/overseas.js` → 해외 증시
- `tools/collectors/fx_rates.js` → 환율·금리
- `tools/collectors/commodities.js` → 원자재
- `tools/collectors/news.js` → 뉴스

### STEP 4 — 데이터 검증
- `tools/validators/data_validator.js` 실행
- 전일 대비 변동값(diff, pct) 계산
- 이상치 탐지 (±20% 이상 변동 시 경고)
- `outputs/YYYY-MM-DD/data.json` 저장

### STEP 5 — 뉴스 요약 생성 (Claude API)
- `tools/generators/news_summarizer.js` 실행
- 수집된 뉴스를 카테고리별 마크다운으로 요약
- `outputs/YYYY-MM-DD/summary.md` 저장

### STEP 6 — HTML 리포트 생성 (Claude API)
- `tools/generators/report_generator.js` 실행
- v5 스타일 HTML 위젯 생성 (Chart.js 포함)
- `outputs/YYYY-MM-DD/report.html` 저장

### STEP 7 — 발행
- `tools/publishers/notion.js` → Notion 페이지 업데이트 (전체 데이터 아카이브)
- `tools/publishers/gmail.js` → Gmail로 HTML 리포트 이메일 발송

---

## 실패 처리

| 상황 | 대응 |
|------|------|
| 특정 API 수집 실패 | 해당 항목 `null` 처리 후 계속 진행 |
| Claude API 오류 | 3회 재시도 후 에러 Slack 알림 |
| Notion 업로드 실패 | 에러 로그 기록, Slack 에러 알림 |
| 공휴일(한국) | 국내 증시 데이터 skip, 해외만 수집 |
| 공휴일(미국 전일) | 해외 증시 "휴장" 표기 |

---

## 수동 실행 명령어

```bash
# 즉시 실행
node tools/main.js --now

# 드라이런 (데이터 수집만, 리포트 생성 생략)
node tools/main.js --now --dry-run

# 기존 data.json으로 리포트만 재생성
node tools/main.js --now --skip-collect

# 특정 날짜 리포트 재생성
node tools/main.js --now --date 2026-05-07
```

---

## 도구 목록

| 파일 | 역할 |
|------|------|
| `tools/main.js` | 오케스트레이터 (전체 흐름 제어) |
| `tools/collectors/domestic.js` | KRX 국내 증시 수집 |
| `tools/collectors/overseas.js` | Yahoo Finance 해외 증시 수집 |
| `tools/collectors/fx_rates.js` | 환율·금리 수집 |
| `tools/collectors/commodities.js` | 원자재 수집 |
| `tools/collectors/news.js` | 네이버 뉴스 수집 |
| `tools/validators/data_validator.js` | 데이터 검증 및 변동값 계산 |
| `tools/generators/news_summarizer.js` | Claude API 뉴스 요약 |
| `tools/generators/report_generator.js` | Claude API HTML 리포트 생성 |
| `tools/publishers/notion.js` | Notion 발행 |
| `tools/publishers/gmail.js` | Gmail 이메일 발송 |
| `tools/utils/holiday.js` | 공휴일 판별 |
| `tools/utils/formatter.js` | 숫자 포맷 규칙 |
| `tools/utils/logger.js` | 로그 + Slack 에러 알림 |
