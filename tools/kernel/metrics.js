// tools/kernel/metrics.js — 시스템 자체 모니터링 (Phase 1: skeleton)
//
// 매일 발행 중 발생하는 메트릭을 수집해 향후 "시스템 헬스 체크" 리포트의 기초로 사용.
// Phase 1엔 메모리에만 누적, 실행 종료 시 outputs/{date}/metrics.json에 저장.
// Phase 3에서 주간 헬스 체크 메일 등 발전.

import fs from 'fs/promises';
import path from 'path';
import { logger } from '../shared/utils/logger.js';

const _events = [];   // 한 번의 orchestrator 실행 동안 누적

/**
 * 에이전트 실행 결과를 기록.
 * @param {import('./Result.js').AgentResult} result
 */
export function record(result) {
  if (!result || !result.meta) return;
  _events.push({
    agent:      result.meta.agent,
    layer:      result.meta.layer,
    ok:         result.ok,
    durationMs: result.meta.durationMs,
    model:      result.meta.model,
    confidence: result.meta.confidence,
    errors:     result.errors ?? [],
    ts:         new Date().toISOString(),
  });
}

/** 임의 이벤트 (캐시 hit, 폴백 발동 등) */
export function event(kind, payload = {}) {
  _events.push({ kind, ...payload, ts: new Date().toISOString() });
}

/** 현재 누적 통계 요약 */
export function summary() {
  const agents = _events.filter(e => e.agent);
  const totalDuration = agents.reduce((sum, e) => sum + (e.durationMs ?? 0), 0);
  const failedAgents  = agents.filter(e => !e.ok).map(e => e.agent);
  return {
    totalAgents: agents.length,
    failedAgents,
    totalDurationMs: totalDuration,
    eventCount:  _events.length,
  };
}

/** outputs/{date}/metrics.json에 저장 */
export async function flush(outputDir) {
  if (!_events.length) return;
  try {
    const file = path.join(outputDir, 'metrics.json');
    await fs.writeFile(file, JSON.stringify({
      summary: summary(),
      events:  _events,
    }, null, 2), 'utf-8');
    logger.info(`[metrics] ${_events.length}건 기록 → metrics.json`);
  } catch (e) {
    logger.warn('[metrics] 저장 실패:', e.message);
  }
}

export function reset() { _events.length = 0; }
