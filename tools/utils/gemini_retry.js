// tools/utils/gemini_retry.js
// Gemini API 자동 재시도 래퍼.
// 처리 대상:
//   • 429 Too Many Requests  → 응답이 명시한 retryDelay 만큼 대기 후 재시도
//   • 503 Service Unavailable → 지수 백오프 (3s → 6s → 12s)
//   • 500/502/504 일시 오류   → 지수 백오프
// 그 외 오류(400 잘못된 요청 등)는 즉시 throw — 재시도해도 같은 결과.
//
// 사용 예:
//   const result = await geminiWithRetry(() => model.generateContent(prompt));
import { logger } from './logger.js';

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

export async function geminiWithRetry(fn, { maxRetries = 3, label = 'gemini' } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const status = e?.status ?? e?.response?.status;
      if (!RETRYABLE.has(status) || attempt === maxRetries) throw e;

      // 429: 서버가 지정한 대기시간을 우선 사용 (예: "37s" → 37초)
      let waitMs;
      if (status === 429) {
        const delayStr = e?.errorDetails?.find(d => d.retryDelay)?.retryDelay ?? '60s';
        const delaySec = parseInt(delayStr) || 60;
        waitMs = (delaySec + 5) * 1000;
      } else {
        // 503/5xx: 지수 백오프 (3s, 6s, 12s …)
        waitMs = 3000 * Math.pow(2, attempt - 1);
      }

      logger.warn(`[${label}] ${status} 오류 — ${Math.round(waitMs / 1000)}초 후 재시도 (${attempt}/${maxRetries - 1})`);
      await new Promise(r => setTimeout(r, waitMs));
    }
  }
  throw lastErr;
}
