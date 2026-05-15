// tools/kernel/cache.js — 데이터 소스 호출 캐싱 표준
//
// 같은 실행 안에서 여러 에이전트가 동일 feed를 호출하면 캐시 hit으로 중복 호출 제거.
// 디스크 캐시(outputs/cache/{feed}/{date}.json)와 메모리 캐시(프로세스 수명) 이중 활용.
//
// 디스크 캐시는 GitHub Actions 워크스페이스 휘발성 때문에 사실상 무용지물.
// 그러나 로컬 디버깅·여러 콘텐츠가 같은 fetch를 부르는 경우엔 유효.
// 메모리 캐시는 한 번의 orchestrator 실행 내내 살아있음 → GA에서도 효과.

import fs from 'fs/promises';
import path from 'path';
import { logger } from '../shared/utils/logger.js';

const _mem = new Map();   // 메모리 캐시 (key → { value, ts })

/**
 * 캐시된 fetch. 같은 key로 처음 호출 시 fn() 실행하고 결과 캐싱,
 * 두 번째부터는 캐시 반환.
 *
 * @param {string} feed   feed 이름 (예: 'dart', 'crypto', 'hankyung-consensus')
 * @param {string} key    그 feed의 고유 키 (예: 날짜 'YYYY-MM-DD')
 * @param {() => Promise<any>} fn  실제 fetch 함수
 * @param {Object} [opts]
 * @param {boolean} [opts.useDisk=false]  디스크 캐시 사용 여부 (로컬 디버깅용)
 * @param {number}  [opts.maxAgeMs]       디스크 캐시 유효 시간 (밀리초, undefined면 무한)
 */
export async function cachedFetch(feed, key, fn, opts = {}) {
  const cacheKey = `${feed}::${key}`;

  // 1) 메모리 캐시 hit (가장 빠름, GA에서도 효과)
  if (_mem.has(cacheKey)) {
    return _mem.get(cacheKey).value;
  }

  // 2) 디스크 캐시 (옵션) — 로컬 디버깅 때만 활용
  if (opts.useDisk) {
    const diskPath = _diskPath(feed, key);
    try {
      const stat = await fs.stat(diskPath);
      const age  = Date.now() - stat.mtimeMs;
      if (opts.maxAgeMs == null || age < opts.maxAgeMs) {
        const raw = await fs.readFile(diskPath, 'utf-8');
        const value = JSON.parse(raw);
        _mem.set(cacheKey, { value, ts: Date.now() });
        logger.info(`[cache] disk hit: ${feed}/${key} (age=${Math.round(age/1000)}s)`);
        return value;
      }
    } catch { /* 캐시 없음 — 정상, fn 호출로 진행 */ }
  }

  // 3) 실제 fetch
  const value = await fn();
  _mem.set(cacheKey, { value, ts: Date.now() });

  // 디스크에도 저장 (옵션)
  if (opts.useDisk) {
    const diskPath = _diskPath(feed, key);
    try {
      await fs.mkdir(path.dirname(diskPath), { recursive: true });
      await fs.writeFile(diskPath, JSON.stringify(value, null, 2), 'utf-8');
    } catch (e) {
      logger.warn(`[cache] disk write 실패 (${feed}/${key}):`, e.message);
    }
  }

  return value;
}

function _diskPath(feed, key) {
  const outputDir = process.env.OUTPUT_DIR ?? './outputs';
  // path traversal 방어 — feed/key는 영숫자·하이픈·언더스코어만
  const safeFeed = String(feed).replace(/[^a-zA-Z0-9_-]/g, '_');
  const safeKey  = String(key).replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(outputDir, 'cache', safeFeed, `${safeKey}.json`);
}

/** 테스트·디버깅용 — 메모리 캐시 비우기 */
export function clearMemoryCache() {
  _mem.clear();
}

/** 진단용 — 현재 메모리 캐시 상태 */
export function getCacheStats() {
  return {
    entries: _mem.size,
    keys:    [..._mem.keys()],
  };
}
