// tools/pipeline/crypto_feed.js — 코인 시세 + 심리 지표 + 김치프리미엄 수집
// CoinGecko 무료 API + Alternative.me Fear & Greed + 업비트 + Yahoo 환율
import axios from 'axios';
import { logger } from '../../../shared/utils/logger.js';
import { cachedFetch } from '../../../kernel/cache.js';

const GECKO_BASE  = 'https://api.coingecko.com/api/v3';
const FNG_URL     = 'https://api.alternative.me/fng/?limit=1';
const UPBIT_URL   = 'https://api.upbit.com/v1/ticker?markets=KRW-BTC,KRW-ETH';
const YAHOO_FX_URL = 'https://query1.finance.yahoo.com/v8/finance/chart/KRW%3DX?interval=1d&range=1d';

const HEADERS = { 'User-Agent': 'Mozilla/5.0' };
const TIMEOUT = 10000;

/**
 * 업비트 KRW-BTC, KRW-ETH 현재가 수집.
 * @returns {Promise<{btcKrw: number|null, ethKrw: number|null}>}
 */
async function fetchUpbitTickers() {
  try {
    const res = await axios.get(UPBIT_URL, { headers: HEADERS, timeout: TIMEOUT });
    const data = res.data ?? [];
    const btcRow = data.find(r => r.market === 'KRW-BTC');
    const ethRow = data.find(r => r.market === 'KRW-ETH');
    return {
      btcKrw: btcRow?.trade_price ?? null,
      ethKrw: ethRow?.trade_price ?? null,
    };
  } catch (e) {
    logger.warn('[crypto] 업비트 fetch 실패:', e.message);
    return { btcKrw: null, ethKrw: null };
  }
}

/**
 * Yahoo Finance에서 USD/KRW 환율 수집.
 * @returns {Promise<number|null>}
 */
async function fetchUsdKrw() {
  try {
    const res = await axios.get(YAHOO_FX_URL, { headers: HEADERS, timeout: TIMEOUT });
    const price = res.data?.chart?.result?.[0]?.meta?.regularMarketPrice;
    return price ? round2(price) : null;
  } catch (e) {
    logger.warn('[crypto] Yahoo FX fetch 실패:', e.message);
    return null;
  }
}

/**
 * 김치프리미엄 계산.
 * premium_pct = ((kr_price_krw - global_usd × usdkrw) / (global_usd × usdkrw)) × 100
 *
 * @param {number|null} krPriceKrw  국내 거래소 KRW 가격
 * @param {number|null} globalUsd   CoinGecko USD 가격
 * @param {number|null} fxUsdKrw    USD/KRW 환율
 * @returns {{kr_price_krw, global_usd, fx_usdkrw, premium_pct}|null}
 */
function calcKimchiPremium(krPriceKrw, globalUsd, fxUsdKrw) {
  if (!krPriceKrw || !globalUsd || !fxUsdKrw) return null;
  const globalKrw = globalUsd * fxUsdKrw;
  const premiumPct = round2(((krPriceKrw - globalKrw) / globalKrw) * 100);
  return {
    kr_price_krw: Math.round(krPriceKrw),
    global_usd:   round2(globalUsd),
    fx_usdkrw:    round2(fxUsdKrw),
    premium_pct:  premiumPct,
  };
}

/**
 * BTC·ETH 시세, Fear & Greed, 상위 10 코인, 도미넌스, 김치프리미엄 수집.
 * @param {string} [date]  캐시 키용 날짜 (YYYY-MM-DD). 미전달 시 오늘 날짜 사용.
 * @returns {Promise<CryptoData|null>}
 */
export async function collectCrypto(date) {
  const cacheDate = date ?? new Date().toISOString().slice(0, 10);

  try {
    const [priceRes, globalRes, marketsRes, fngRes] = await Promise.allSettled([
      axios.get(`${GECKO_BASE}/simple/price`, {
        params: { ids: 'bitcoin,ethereum', vs_currencies: 'usd', include_24hr_change: true },
        headers: HEADERS, timeout: TIMEOUT,
      }),
      axios.get(`${GECKO_BASE}/global`, { headers: HEADERS, timeout: TIMEOUT }),
      axios.get(`${GECKO_BASE}/coins/markets`, {
        params: { vs_currency: 'usd', order: 'market_cap_desc', per_page: 10, page: 1 },
        headers: HEADERS, timeout: TIMEOUT,
      }),
      axios.get(FNG_URL, { timeout: TIMEOUT }),
    ]);

    const prices  = priceRes.status  === 'fulfilled' ? priceRes.value.data  : null;
    const global_ = globalRes.status === 'fulfilled' ? globalRes.value.data : null;
    const markets = marketsRes.status === 'fulfilled' ? marketsRes.value.data : [];
    const fng     = fngRes.status    === 'fulfilled' ? fngRes.value.data    : null;

    const btc = prices?.bitcoin;
    const eth = prices?.ethereum;

    // 업비트 + 환율 병렬 수집 (캐시 적용)
    const [upbit, fxUsdKrw] = await Promise.all([
      cachedFetch('upbit-ticker', cacheDate, fetchUpbitTickers),
      cachedFetch('fx-usdkrw-crypto', cacheDate, fetchUsdKrw),
    ]);

    // 김치프리미엄 계산
    const kimchiPremium = {
      btc: calcKimchiPremium(upbit.btcKrw, btc?.usd ?? null, fxUsdKrw),
      eth: calcKimchiPremium(upbit.ethKrw, eth?.usd ?? null, fxUsdKrw),
    };

    const result = {
      btc: btc ? {
        price:     round2(btc.usd),
        change24h: round2(btc.usd_24h_change ?? 0),
      } : null,
      eth: eth ? {
        price:     round2(eth.usd),
        change24h: round2(eth.usd_24h_change ?? 0),
      } : null,
      btcDominance: global_
        ? round2(global_.data?.market_cap_percentage?.btc ?? 0)
        : null,
      totalMarketCapUsd: global_
        ? global_.data?.total_market_cap?.usd ?? null
        : null,
      fearGreed: fng?.data?.[0]
        ? { value: Number(fng.data[0].value), label: fng.data[0].value_classification }
        : null,
      top10: (markets ?? []).map(c => ({
        rank:      c.market_cap_rank,
        symbol:    c.symbol?.toUpperCase(),
        name:      c.name,
        priceUsd:  round2(c.current_price ?? 0),
        change24h: round2(c.price_change_percentage_24h ?? 0),
      })),
      kimchiPremium,   // ⭐ 업비트 vs CoinGecko 가격차 (한국 투자 심리 지표)
      collectedAt: new Date().toISOString(),
    };

    logger.info(
      `[crypto] 수집 완료 — BTC: $${result.btc?.price ?? 'N/A'}, ` +
      `F&G: ${result.fearGreed?.value ?? 'N/A'}, ` +
      `김치프리미엄 BTC: ${result.kimchiPremium?.btc?.premium_pct ?? 'N/A'}%`
    );
    return result;

  } catch (e) {
    logger.warn('[crypto] 수집 실패:', e.message);
    return null;
  }
}

const round2 = v => Math.round(v * 100) / 100;
