// tools/kernel/Result.js — 모든 에이전트가 반환할 표준 결과 객체
// "에이전트가 무엇을 돌려주는가"의 시스템 헌법.

/**
 * @typedef {Object} AgentResult
 * @property {boolean} ok            — 정상 실행 여부 (false면 errors 봐야 함)
 * @property {*}       data          — 에이전트 주력 출력 (findings, html, kospi 등)
 * @property {*}       raw           — 다른 에이전트가 활용 가능한 원시 데이터 (선택)
 * @property {Object}  meta          — 에이전트 메타데이터
 * @property {string}  meta.agent    — 에이전트 이름 ('tf-news', 'pipeline' 등)
 * @property {string}  meta.layer    — 'layer-1' | 'layer-2' | 'layer-3'
 * @property {string}  [meta.model]  — 사용 모델 ('gemini-2.5-flash' 등)
 * @property {number}  [meta.durationMs] — 실행 시간 (ms)
 * @property {number}  [meta.confidence] — 0~1
 * @property {string[]} errors       — 발생한 오류 메시지 (있으면 채워짐)
 */

/**
 * 표준 성공 결과 생성.
 * @param {string} agent  에이전트 이름
 * @param {string} layer  'layer-1' | 'layer-2' | 'layer-3'
 * @param {*}      data   주력 출력
 * @param {Object} [opts] { raw, model, confidence, durationMs }
 */
export function ok(agent, layer, data, opts = {}) {
  return {
    ok:     true,
    data,
    raw:    opts.raw,
    meta: {
      agent,
      layer,
      model:      opts.model,
      confidence: opts.confidence,
      durationMs: opts.durationMs,
    },
    errors: [],
  };
}

/**
 * 표준 실패 결과 생성. 에이전트는 throw하지 않고 fail() 반환.
 */
export function fail(agent, layer, errors, opts = {}) {
  const errArr = Array.isArray(errors) ? errors : [String(errors)];
  return {
    ok:     false,
    data:   opts.data ?? null,
    raw:    opts.raw,
    meta: {
      agent,
      layer,
      model:      opts.model,
      durationMs: opts.durationMs,
    },
    errors: errArr,
  };
}

/**
 * 기존 함수 형태(직접 객체 반환) 결과를 표준 AgentResult로 wrapping.
 * Phase 1 호환용 — 기존 에이전트를 다 고치지 않고 점진적으로 표준화.
 */
export function wrap(agent, layer, legacyResult, opts = {}) {
  // legacyResult가 이미 표준 모양이면 그대로
  if (legacyResult && typeof legacyResult === 'object' && 'ok' in legacyResult && 'meta' in legacyResult) {
    return legacyResult;
  }
  return ok(agent, layer, legacyResult, opts);
}
