// tools/utils/gemini_retry.js
// Gemini 429 (Too Many Requests) 자동 재시도 래퍼
import { logger } from './logger.js';

export async function geminiWithRetry(fn, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const status = e?.status ?? e?.response?.status;
      if (status !== 429 || attempt === maxRetries) throw e;

      // retryDelay 파싱 (예: "37s" → 37000ms), 없으면 60초
      const delayStr = e?.errorDetails?.find(d => d.retryDelay)?.retryDelay ?? '60s';
      const delaySec = parseInt(delayStr) || 60;
      const waitMs   = (delaySec + 5) * 1000; // 여유 5초 추가

      logger.warn(`[gemini] 429 한도 초과 — ${delaySec}초 후 재시도 (${attempt}/${maxRetries})`);
      await new Promise(r => setTimeout(r, waitMs));
    }
  }
}
