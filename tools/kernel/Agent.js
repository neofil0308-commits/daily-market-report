// tools/kernel/Agent.js — 에이전트 표준 인터페이스
// "에이전트가 어떤 모양이어야 하는가"의 시스템 헌법.
//
// JavaScript는 인터페이스 강제가 약하므로, 이 파일은 "계약 명세"로서의 역할.
// 각 에이전트는 defineAgent()로 자기를 등록하면 표준 인터페이스를 따르는 것으로 간주된다.

/**
 * @typedef {Object} AgentDefinition
 * @property {string}  name        — 식별자 ('pipeline', 'tf-news' 등). 중복 불가.
 * @property {string}  layer       — 'layer-1' | 'layer-2' | 'layer-3'
 * @property {string}  description — 한 줄 역할
 * @property {string[]} [inputs]   — 받는 입력 키 (orchestrator·다른 에이전트가 줘야 할 것)
 * @property {string[]} [outputs]  — 출력 키 (data 안의 주요 필드)
 * @property {string[]} [feeds]    — 자체 호출하는 외부 데이터 소스 (shared/feeds 또는 자기 feeds)
 * @property {string[]} [requires] — 의존하는 환경변수 ('GOOGLE_API_KEY' 등)
 * @property {(input: any) => Promise<import('./Result.js').AgentResult>} run
 */

/**
 * 에이전트 정의 헬퍼. 이름 충돌·필수 필드 검증.
 * @param {AgentDefinition} def
 * @returns {AgentDefinition} 검증된 정의
 */
export function defineAgent(def) {
  if (!def.name)  throw new Error('[Agent] name 필수');
  if (!def.layer) throw new Error(`[Agent:${def.name}] layer 필수`);
  if (typeof def.run !== 'function') throw new Error(`[Agent:${def.name}] run 함수 필수`);
  if (!['layer-1', 'layer-2', 'layer-3'].includes(def.layer)) {
    throw new Error(`[Agent:${def.name}] layer는 layer-1|layer-2|layer-3 중 하나`);
  }
  return {
    name:        def.name,
    layer:       def.layer,
    description: def.description ?? '',
    inputs:      def.inputs   ?? [],
    outputs:     def.outputs  ?? [],
    feeds:       def.feeds    ?? [],
    requires:    def.requires ?? [],
    run:         def.run,
  };
}

/**
 * 간단한 에이전트 레지스트리. 콘텐츠 정의가 이름으로 에이전트를 참조할 수 있도록.
 */
const _registry = new Map();

export function register(agent) {
  if (_registry.has(agent.name)) {
    throw new Error(`[Agent] 이름 중복: ${agent.name}`);
  }
  _registry.set(agent.name, agent);
  return agent;
}

export function getAgent(name) {
  const a = _registry.get(name);
  if (!a) throw new Error(`[Agent] 등록되지 않은 에이전트: ${name}`);
  return a;
}

export function listAgents() {
  return [..._registry.values()];
}

export function clearRegistry() {
  _registry.clear();
}
