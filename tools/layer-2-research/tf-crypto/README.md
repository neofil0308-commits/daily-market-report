# Layer 2 · TF-Crypto

> 가상자산·블록체인 도메인의 1차 책임 에이전트. CoinGecko에서 시세·심리지표를 자체 수집한다.

## 한 줄 역할

BTC/ETH 시세 + Fear & Greed + 코인 뉴스를 Gemini로 분석해 시장 신호·국내 코인 연계 기업 영향·규제 리스크를 판단한다.

## 진입점

```js
import { runTFCrypto } from './layer-2-research/tf-crypto/index.js';
const result = await runTFCrypto(newsRaw);   // tf-news가 수집한 raw를 받음
```

## 입력

| 인자 | 타입 | 설명 |
|------|------|------|
| `news` | object[] | tf-news가 수집한 원시 뉴스 (코인 관련 기사 필터링용) |

## 출력

```ts
{
  findings: [
    { asset: 'BTC', price_usd, key_level, importance }
  ],
  signal: '축적 구간' | '과매수' | '조정 구간' | '하락 추세',
  market_summary: string,
  kr_stocks_impact: [
    { company: '카카오', ticker: '035720', expected_direction: 'positive' | 'negative' | 'neutral' }
  ],
  regulatory_alert: string | null,
  fear_greed: object,
  btc_dominance: number,
  confidence: number,
  model_used: 'gemini-2.5-flash',
  crypto_data: object,   // ⭐ designer가 코인 섹션 그릴 때 받는 raw (orchestrator가 합성해 전달)
}
```

## 데이터 소스 (자기 `feeds/`)

- `feeds/crypto_feed.js` — CoinGecko API (인증 불필요). BTC/ETH 가격·도미넌스·Fear & Greed·Top10.

## 국내 코인 연계 기업 추적 목록 (KR_CRYPTO_STOCKS)

| 기업 | 종목코드 | 비고 |
|------|---------|------|
| 카카오 | 035720 | 카카오페이·블록체인 연계 |
| 카카오게임즈 | 293490 | 메타보라 블록체인 게임 |
| 위메이드 | 112040 | 위믹스 자체 코인 |
| NHN | 181710 | 블록체인 게임 투자 |

## 의존성

- `shared/utils/logger`, `shared/utils/gemini_retry`
- 외부: CoinGecko, Google Gemini API

## 실패 처리

- CoinGecko 실패 → `cryptoData=null`, 분석 생략.
- Gemini 실패 → 빈 결과 + crypto_data만 노출 (designer가 시세는 그릴 수 있도록).

## 발전 기록

- 2026-05-16: crypto_feed를 tf-crypto 소속으로 이동, 자체 수집. `crypto_data` 노출.
- 2026-05-15: tf-crypto 표에 "시장 동향" 열 추가 + 코인 시장 요약 박스.
