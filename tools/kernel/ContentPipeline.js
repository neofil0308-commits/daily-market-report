// tools/kernel/ContentPipeline.js — 콘텐츠 정의 표준
//
// "오늘 무엇을 만들까?"의 추상화.
// 매일 시장 리포트 1개 → 미래엔 시장 리포트·기업분석·카드뉴스·의향도 등 여러 종류.
//
// 각 콘텐츠는 자기 정의 파일(tools/contents/{name}.js)에서 defineContent()를 export.
// orchestrator가 콘텐츠 정의를 받아 그래프대로 실행한다.

/**
 * @typedef {Object} ContentDefinition
 * @property {string}   name         식별자 ('daily-market-report', 'equity-deep-dive' 등)
 * @property {string}   description  한 줄 역할 (사주가 README 안 봐도 파악)
 * @property {string}   schedule     'daily-08:00' | 'weekly-mon' | 'on-demand' | cron 표기
 * @property {(orchestrator: Object) => Promise<Object>} run  실제 실행 함수
 * @property {(result: Object) => { ok: boolean, errors: string[] }} [validate]  발행 전 자동 품질 체크
 * @property {string[]} [outputChannels] — ['gmail', 'notion', 'gh-pages', 'instagram' 등]
 * @property {string[]} [requires]   필요 환경변수 ('GOOGLE_API_KEY' 등)
 */

/**
 * 콘텐츠 정의 헬퍼 — 필수 필드 검증.
 * @param {ContentDefinition} def
 */
export function defineContent(def) {
  if (!def.name)        throw new Error('[Content] name 필수');
  if (!def.schedule)    throw new Error(`[Content:${def.name}] schedule 필수`);
  if (typeof def.run !== 'function') throw new Error(`[Content:${def.name}] run 함수 필수`);
  return {
    name:           def.name,
    description:    def.description ?? '',
    schedule:       def.schedule,
    run:            def.run,
    validate:       def.validate       ?? (() => ({ ok: true, errors: [] })),
    outputChannels: def.outputChannels ?? [],
    requires:       def.requires       ?? [],
  };
}

/**
 * 콘텐츠 레지스트리 — 콘텐츠 자동 발견.
 */
const _contents = new Map();

export function registerContent(content) {
  if (_contents.has(content.name)) {
    throw new Error(`[Content] 이름 중복: ${content.name}`);
  }
  _contents.set(content.name, content);
  return content;
}

export function getContent(name) {
  const c = _contents.get(name);
  if (!c) throw new Error(`[Content] 등록되지 않은 콘텐츠: ${name}`);
  return c;
}

export function listContents() {
  return [..._contents.values()];
}

/**
 * 스케줄에 따라 오늘 실행할 콘텐츠 필터.
 * Phase 1엔 단순: 'daily-*'은 매일, 'on-demand'는 명시적 호출일 때만.
 * 향후 cron 파싱 추가.
 */
export function getDueContents(date = new Date()) {
  const day = date.getUTCDay(); // 0=Sun .. 6=Sat
  return listContents().filter(c => {
    if (c.schedule.startsWith('daily-')) return true;
    if (c.schedule === 'weekly-mon')     return day === 1;
    if (c.schedule === 'on-demand')      return false;
    return true; // 기타는 일단 매일
  });
}
