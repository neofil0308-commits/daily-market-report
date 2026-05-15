# Layer 1 · Pipeline

> 시장 데이터를 수집하는 1차 에이전트. AI는 사용하지 않는다 — 빠르고 저렴하다.

## 한 줄 역할

매일 아침, KOSPI·해외 증시·환율·원자재의 종가·전일比·5거래일 추이를 외부 API에서 끌어와 정규화한다.

## 진입점

```js
import { runPipeline } from './layer-1-pipeline/index.js';
const data = await runPipeline({ reportDate, outputDir, prevOutputDir });
```

## 입력

| 인자 | 타입 | 설명 |
|------|------|------|
| `reportDate` | string | YYYY-MM-DD |
| `outputDir` | string | `outputs/{date}/` 경로 |
| `prevOutputDir` | string | 전일자 경로 (전일比 폴백용) |

## 출력 (`pipelineData`)

```ts
{
  date: string,
  domestic: { kospi, kosdaq, marketCap, volumeBn, kospiHistory, supply, vkospi, ... },
  overseas: { sp500, nasdaq, dow, sox, nikkei, dax, hsi },
  fxRates:  { usdKrw, dxy, us10y, us2y, fomcProb },
  commodities: { gold, silver, platinum, wti, copper, ... },
  news: [],   // ← 빈 배열. 실제 뉴스는 tf-news가 자체 수집.
  meta: { krHoliday, usHoliday },
}
```

## 데이터 소스 (자기 `collectors/`)

| 파일 | 외부 API |
|------|---------|
| `collectors/domestic.js` | Yahoo `^KS11`·`^KQ11`, Naver Finance |
| `collectors/overseas.js` | Yahoo Finance v8 |
| `collectors/fx_rates.js` | Yahoo (ZQ 선물), 한국은행 |
| `collectors/commodities.js` | Yahoo, Naver |

> news/dart/crypto는 **이 에이전트 소속이 아니다**. 각 TF팀이 자기 영역에서 수집한다.

## 실패 처리

- 수집기 한 개 실패 → `null` 또는 빈 객체 반환. 전체 파이프라인은 중단하지 않는다.
- 라이브 값이 안 잡히면 실시간 폴백(Naver 모바일·history 마지막 거래일) 발동.
- 휴장일에도 시가총액·VKOSPI·수급·5거래일 추이는 별도 폴백으로 채운다.

## 발전 기록

- 2026-05-16: news 수집을 tf-news 소속으로 이양. Layer 1은 시장 데이터(4종)만 책임.
- 2026-05-16: dart_feed·crypto_feed를 각 TF팀 소속으로 이양 (cross-layer import 제거).
- 2026-05-15: 휴장일 분기 함정 수정 (VKOSPI·시가총액·수급 4행 누락 → 폴백 추가).
- 2026-05-15: KOSPI 종가 폴백을 marketStatus 분기로 (장중 라이브 거부).
