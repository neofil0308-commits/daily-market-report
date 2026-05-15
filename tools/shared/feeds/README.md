# Shared · Feeds (재사용 가능한 데이터 소스)

> 여러 콘텐츠·에이전트가 공유할 외부 데이터 소스 모음. Phase 2부터 실제 이동 시작.

## 한 줄 역할

DART·CoinGecko·Naver News·한경 컨센서스 같은 외부 데이터 소스를 콘텐츠·에이전트가 직접 import해 쓸 수 있도록 한곳에 모은다. 캐싱은 `tools/kernel/cache.js`로 표준화.

## Phase 1 (현재) — 인프라만 정의

- 폴더 + 표준 인터페이스 정의 (이 README)
- 실제 feed 파일은 각 TF팀의 `feeds/` 아래 유지
  - `layer-2-research/tf-analyst/feeds/dart_feed.js`
  - `layer-2-research/tf-crypto/feeds/crypto_feed.js`
  - `layer-2-research/tf-news/feeds/news_feed.js`

## Phase 2 (예정) — 실제 이동

여러 콘텐츠가 같은 feed를 공유해야 할 때 (예: 시장 리포트 + 기업분석 둘 다 DART 사용) 이쪽으로 이동.

```
shared/feeds/
├── dart.js                 ← layer-2-research/tf-analyst/feeds/dart_feed.js
├── coingecko.js            ← layer-2-research/tf-crypto/feeds/crypto_feed.js
├── naver-news.js           ← layer-2-research/tf-news/feeds/news_feed.js
└── hankyung-consensus.js   (한경 컨센서스 — 현재 tf-analyst 내부)
```

## 표준 인터페이스 (Feed Contract)

모든 feed는 다음 표준을 따른다:

```js
export async function collect{Name}(params) {
  // 1) 캐시 hit 확인
  return cachedFetch('feed-name', cacheKey, async () => {
    // 2) 실제 외부 호출
    // 3) 표준 형태로 정규화
    return { /* 정규화된 객체 */ };
  }, { useDisk: false });   // GA에선 메모리 캐시만, 로컬 디버깅 시 useDisk: true
}
```

## 캐시 정책

- **메모리 캐시** (기본): 한 번의 orchestrator 실행 내내 hit. 같은 날 여러 콘텐츠가 dart_feed를 부르면 1번만 실제 호출.
- **디스크 캐시** (옵션): `outputs/cache/{feed}/{date}.json`. 로컬 디버깅 시에만. GA는 워크스페이스 휘발성이라 사실상 무용지물.

## 발전 기록

- 2026-05-16: 폴더·표준 인터페이스 정의 (Phase 1).
- Phase 2: 실제 feed 이동 예정.
