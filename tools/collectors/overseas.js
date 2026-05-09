// tools/collectors/overseas.js
import axios from 'axios';

const YF_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart';

const SYMBOLS = {
  dow:    '^DJI',
  sp500:  '^GSPC',
  nasdaq: '^IXIC',
  sox:    '^SOX',
  nikkei: '^N225',
  dax:    '^GDAXI',
  hsi:    '^HSI',
};

export async function collectOverseas(usHoliday) {
  const result = { usHoliday };

  await Promise.all(
    Object.entries(SYMBOLS).map(async ([key, symbol]) => {
      try {
        const res = await axios.get(`${YF_BASE}/${encodeURIComponent(symbol)}`, {
          params: { interval: '1d', range: '5d' },
          headers: { 'User-Agent': 'Mozilla/5.0' },
          timeout: 10000,
        });
        const closes = res.data.chart.result[0].indicators.quote[0].close.filter(Boolean);
        const len = closes.length;
        result[key] = { close: round2(closes[len - 1]), prevClose: round2(closes[len - 2]) };
      } catch (e) {
        console.warn(`[overseas] ${key} 수집 실패:`, e.message);
        result[key] = { close: null, prevClose: null };
      }
    })
  );

  return result;
}

const round2 = v => Math.round(v * 100) / 100;
