// tools/pipeline/crypto_feed.js — 코인 시세 + 심리 지표 수집
// CoinGecko 무료 API + Alternative.me Fear & Greed
import axios from 'axios';
import { logger } from '../utils/logger.js';

const GECKO_BASE = 'https://api.coingecko.com/api/v3';
const FNG_URL    = 'https://api.alternative.me/fng/?limit=1';

const HEADERS = { 'User-Agent': 'Mozilla/5.0' };
const TIMEOUT = 10000;

/**
 * BTC·ETH 시세, Fear & Greed, 상위 10 코인, 도미넌스 수집.
 * @returns {Promise<CryptoData|null>}
 */
export async function collectCrypto() {
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
      collectedAt: new Date().toISOString(),
    };

    logger.info(`[crypto] 수집 완료 — BTC: $${result.btc?.price ?? 'N/A'}, F&G: ${result.fearGreed?.value ?? 'N/A'}`);
    return result;

  } catch (e) {
    logger.warn('[crypto] 수집 실패:', e.message);
    return null;
  }
}

const round2 = v => Math.round(v * 100) / 100;
