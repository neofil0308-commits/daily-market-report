// tools/orchestrator.js — 3-Layer 통합 오케스트레이터
// Layer 1(Pipeline) → Layer 2(TF Teams) → Layer 3(Desk) 순차 실행.
// 기존 tools/main.js는 GA 하위 호환용으로 유지.
import 'dotenv/config';
import fs   from 'fs/promises';
import path from 'path';
import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone.js';
import utc from 'dayjs/plugin/utc.js';

import { runPipeline }   from './pipeline/index.js';
import { runTFNews }     from './teams/tf_news.js';
import { runTFAnalyst }  from './teams/tf_analyst.js';
import { runTFCrypto }   from './teams/tf_crypto.js';
import { runEditor }     from './desk/editor.js';
import { buildHtml }     from './desk/designer.js';
import { publish }       from './desk/publisher.js';
import { logger }        from './utils/logger.js';

dayjs.extend(utc);
dayjs.extend(timezone);

async function run(opts = {}) {
  const today      = dayjs().tz('Asia/Seoul');
  const reportDate = opts.date ?? today.format('YYYY-MM-DD');
  const outputDir  = path.join(process.env.OUTPUT_DIR ?? './outputs', reportDate);

  logger.info(`\n${'═'.repeat(60)}`);
  logger.info(`  일일 시장 리포트 오케스트레이터: ${reportDate}`);
  logger.info(`${'═'.repeat(60)}`);

  // ──────────────────────────────────────────────────────────────
  // LAYER 1 — DATA PIPELINE
  // ──────────────────────────────────────────────────────────────
  logger.info('\n[Layer 1] 데이터 파이프라인 시작...');
  let pipelineData;

  if (opts.skipCollect) {
    logger.info('[Layer 1] --skip-collect: 기존 data.json 재사용');
    pipelineData = JSON.parse(
      await fs.readFile(path.join(outputDir, 'data.json'), 'utf-8')
    );
  } else {
    pipelineData = await runPipeline(reportDate, outputDir);
  }
  logger.info('[Layer 1] 완료 ✓');

  if (opts.dryRun) {
    logger.info('[orchestrator] --dry-run: Layer 2·3 생략');
    return;
  }

  // ──────────────────────────────────────────────────────────────
  // LAYER 2 — TF RESEARCH TEAMS (병렬)
  // ──────────────────────────────────────────────────────────────
  logger.info('\n[Layer 2] TF 리서치팀 병렬 분석 시작...');

  const [tfNews, tfAnalyst, tfCrypto] = await Promise.all([
    runTFNews(pipelineData.news, pipelineData)
      .catch(e => { logger.warn('[TF-1] 실패:', e.message); return { findings:[], top_stories:[], themes:[] }; }),
    runTFAnalyst(pipelineData.dart)
      .catch(e => { logger.warn('[TF-2] 실패:', e.message); return { findings:[] }; }),
    runTFCrypto(pipelineData.crypto, pipelineData.news)
      .catch(e => { logger.warn('[TF-3] 실패:', e.message); return { findings:[] }; }),
  ]);

  const tfResults = { news: tfNews, analyst: tfAnalyst, crypto: tfCrypto };

  // TF 결과 저장 (재실행 가능성 보장)
  await fs.writeFile(
    path.join(outputDir, 'tf_results.json'),
    JSON.stringify(tfResults, null, 2),
    'utf-8'
  );
  logger.info(`[Layer 2] 완료 ✓  뉴스: ${tfNews.findings.length}건 | 애널: ${tfAnalyst.findings.length}건 | 코인: ${tfCrypto.findings.length}건`);

  // ──────────────────────────────────────────────────────────────
  // LAYER 3 — THE DESK
  // ──────────────────────────────────────────────────────────────
  logger.info('\n[Layer 3] DESK 편집·디자인·발행 시작...');

  // 3-A: 편집장 — 선별·교차검증·내러티브
  const editorialPlan = await runEditor(pipelineData, tfResults)
    .catch(e => { logger.warn('[desk/editor] 실패, 기본 플랜 사용:', e.message); return {}; });
  logger.info(`[desk/editor] 헤드라인: "${editorialPlan.headline ?? '(없음)'}"`);

  // 3-B: 디자이너 — HTML 조립
  const html = await buildHtml(pipelineData, tfResults, editorialPlan);
  await fs.writeFile(path.join(outputDir, 'report.html'), html, 'utf-8');
  logger.info('[desk/designer] report.html 저장 완료');

  // 3-C: 발행
  const pubResult = await publish(reportDate, html, pipelineData, outputDir);
  if (pubResult.skipped) {
    logger.info(`[desk/publisher] 발송 건너뜀 (${pubResult.reason})`);
  } else {
    logger.info(`[desk/publisher] 발행 완료 ✓  ${pubResult.sentAt}`);
  }

  logger.info(`\n${'═'.repeat(60)}`);
  logger.info(`  완료: ${reportDate}`);
  logger.info(`  출력: ${outputDir}`);
  logger.info(`${'═'.repeat(60)}\n`);
}

// ── CLI 즉시 실행 ─────────────────────────────────────────────────────────────
if (process.argv.includes('--now')) {
  const opts = {
    dryRun:      process.argv.includes('--dry-run'),
    skipCollect: process.argv.includes('--skip-collect'),
    date:        (() => {
      const i = process.argv.indexOf('--date');
      return i !== -1 ? process.argv[i + 1] : undefined;
    })(),
  };

  run(opts).catch(err => {
    logger.error('[orchestrator] 치명적 오류:', err);
    process.exitCode = 1;
  });
}

export { run };
