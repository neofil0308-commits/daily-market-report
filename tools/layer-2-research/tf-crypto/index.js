// tools/teams/tf_crypto.js — TF-3 블록체인·코인 분석팀
// 코인 시세 + 심리 지표 + 뉴스 → 온체인 해석·관련 기업 영향·규제 리스크
import { GoogleGenerativeAI } from '@google/generative-ai';
import { logger } from '../../shared/utils/logger.js';
import { geminiWithRetry } from '../../shared/utils/gemini_retry.js';

// 국내 코인 관련 상장 기업 추적 목록
const KR_CRYPTO_STOCKS = [
  { company: '카카오',       ticker: '035720', note: '카카오페이·블록체인 연계' },
  { company: '카카오게임즈', ticker: '293490', note: '메타보라 블록체인 게임' },
  { company: '위메이드',     ticker: '112040', note: '위믹스 자체 코인' },
  { company: 'NHN',          ticker: '181710', note: '블록체인 게임 투자' },
];

/**
 * TF-3: 코인 분석 실행.
 * @param {object|null} cryptoData  Layer 1 crypto_feed 결과
 * @param {object[]}    news        Layer 1 원시 뉴스 (코인 관련 필터링용)
 * @returns {Promise<TFCryptoResult>}
 */
export async function runTFCrypto(cryptoData, news = []) {
  if (!cryptoData?.btc) {
    logger.info('[tf-crypto] 코인 데이터 없음 — 건너뜀');
    return _emptyResult();
  }

  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    logger.warn('[tf-crypto] GOOGLE_API_KEY 미설정 — 분석 생략');
    return _emptyResult();
  }

  const modelName = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';
  const cryptoNews = news.filter(n =>
    /비트코인|코인|블록체인|BTC|ETH|가상자산|암호화폐|SEC|가상화폐/i.test(n.title)
  );

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: modelName });

    const prompt = _buildPrompt(cryptoData, cryptoNews);
    const result = await geminiWithRetry(() => model.generateContent(prompt), { label: 'tf-crypto' });
    const raw    = result.response.text()
      .replace(/^```json\s*/,'').replace(/```\s*$/,'').trim();

    const parsed = JSON.parse(raw);
    logger.info(`[tf-crypto] 분석 완료 — BTC 신호: ${parsed.signal ?? '-'}, F&G: ${cryptoData.fearGreed?.value ?? 'N/A'}`);

    return {
      findings:           parsed.findings           ?? [],
      signal:             parsed.signal             ?? null,
      market_summary:     parsed.market_summary     ?? '',
      kr_stocks_impact:   parsed.kr_stocks_impact   ?? [],
      regulatory_alert:   parsed.regulatory_alert   ?? null,
      fear_greed:         cryptoData.fearGreed,
      btc_dominance:      cryptoData.btcDominance,
      confidence:         parsed.confidence         ?? 0.75,
      model_used:         modelName,
    };
  } catch (e) {
    logger.warn('[tf-crypto] 분석 실패:', e.message);
    return _emptyResult();
  }
}

function _buildPrompt(cryptoData, cryptoNews) {
  const { btc, eth, fearGreed, btcDominance, top10 } = cryptoData;
  return `당신은 블록체인·가상자산 전문 리서치 애널리스트입니다.

시장 데이터:
- BTC: $${btc?.price} (24h: ${btc?.change24h}%)
- ETH: $${eth?.price ?? 'N/A'} (24h: ${eth?.change24h ?? 'N/A'}%)
- Fear & Greed: ${fearGreed?.value ?? 'N/A'} (${fearGreed?.label ?? '-'})
- BTC 도미넌스: ${btcDominance ?? 'N/A'}%

아래 데이터를 분석해 다음을 수행하세요:
1. BTC/ETH 기술적 신호 및 주요 가격 레벨
2. 시장 심리 해석 (Fear & Greed 기반)
3. 국내 코인 관련 상장주 영향 (아래 기업 중 관련 있는 것만):
   ${JSON.stringify(KR_CRYPTO_STOCKS)}
4. 규제 리스크 (뉴스에서 SEC·금융위·가상자산법 언급 시)
5. 전통 시장(나스닥) 상관관계

반드시 아래 JSON 형식만 응답하세요:
{
  "findings": [
    { "asset": "BTC", "price_usd": 97500, "key_level": "100,000 저항선 테스트", "importance": 7 }
  ],
  "signal": "축적 구간 | 과매수 | 조정 구간 | 하락 추세 중 하나",
  "market_summary": "한 줄 요약",
  "kr_stocks_impact": [
    { "company": "카카오", "ticker": "035720", "expected_direction": "positive | negative | neutral" }
  ],
  "regulatory_alert": null,
  "confidence": 0.8
}

관련 뉴스 (${cryptoNews.length}건):
${JSON.stringify(cryptoNews.slice(0,10).map(n => ({ title: n.title, date: n.date })), null, 2)}`;
}

function _emptyResult() {
  return {
    findings: [], signal: null, market_summary: '',
    kr_stocks_impact: [], regulatory_alert: null,
    fear_greed: null, btc_dominance: null,
    confidence: 0, model_used: null,
  };
}

// 단독 실행: node tools/teams/tf_crypto.js --date 2026-05-12
if (process.argv.includes('--date')) {
  import('dotenv/config').then(async () => {
    const fs   = await import('fs/promises');
    const path = await import('path');
    const idx  = process.argv.indexOf('--date');
    const date = process.argv[idx + 1] ?? new Date().toISOString().slice(0, 10);
    const data = JSON.parse(await fs.default.readFile(
      path.default.join(process.env.OUTPUT_DIR ?? './outputs', date, 'data.json'), 'utf-8'
    ));
    const result = await runTFCrypto(data.crypto, data.news ?? []);
    console.log(JSON.stringify(result, null, 2));
  });
}
