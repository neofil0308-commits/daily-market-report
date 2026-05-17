// tools/orchestrator.js — 콘텐츠 미디어 플랫폼의 단일 진입점
//
// 사주의 비전: 시장 리포트 + 개별 기업분석 + 카드뉴스 + 투자 의향도 → 다중 콘텐츠 플랫폼.
// orchestrator는 "오늘 어떤 콘텐츠를 만들지" 결정하고 각 콘텐츠 정의에게 실행을 위임한다.
//
// 콘텐츠는 tools/contents/*.js에서 defineContent()로 자기를 등록.
// orchestrator는 콘텐츠 레지스트리를 보고 스케줄에 맞는 것을 실행한다.
import 'dotenv/config';
import fs   from 'fs/promises';
import path from 'path';
import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone.js';
import utc from 'dayjs/plugin/utc.js';

import { logger } from './shared/utils/logger.js';
import { registerContent, listContents, getDueContents } from './kernel/ContentPipeline.js';
import { flush as flushMetrics, event as recordEvent } from './kernel/metrics.js';

// 콘텐츠 자동 등록 — tools/contents/*.js를 import만 하면 defineContent로 등록됨
import dailyMarketReport from './contents/daily-market-report.js';
registerContent(dailyMarketReport);
// (Phase 2·3에서 추가 예정: equity-deep-dive, card-news, investment-tracking)

dayjs.extend(utc);
dayjs.extend(timezone);

async function run(opts = {}) {
  const today      = dayjs().tz('Asia/Seoul');
  const reportDate = opts.date ?? today.format('YYYY-MM-DD');
  const outputDir  = path.join(process.env.OUTPUT_DIR ?? './outputs', reportDate);
  const prevDate   = today.subtract(1, 'day').format('YYYY-MM-DD');
  const prevOutputDir = path.join(process.env.OUTPUT_DIR ?? './outputs', prevDate);

  await fs.mkdir(outputDir, { recursive: true });

  logger.info(`\n${'═'.repeat(60)}`);
  logger.info(`  편집장 오케스트레이터: ${reportDate}`);
  logger.info(`${'═'.repeat(60)}`);

  // 오늘 발행할 콘텐츠 결정 — 명시적 지정 또는 스케줄 기반
  const targetContents = opts.content
    ? [listContents().find(c => c.name === opts.content)].filter(Boolean)
    : getDueContents(today.toDate());

  if (!targetContents.length) {
    logger.warn('[orchestrator] 오늘 발행할 콘텐츠 없음.');
    return;
  }

  logger.info(`[orchestrator] 오늘 발행 콘텐츠 ${targetContents.length}개: ${targetContents.map(c => c.name).join(', ')}`);

  const ctx = {
    reportDate, outputDir, prevOutputDir,
    dryRun:      !!opts.dryRun,
    skipCollect: !!opts.skipCollect,
    preview:     !!opts.preview,    // ⭐ 발송 없이 HTML만 생성 (사주 발간 전 검토용)
  };

  for (const content of targetContents) {
    logger.info(`\n${'─'.repeat(60)}`);
    logger.info(`▶ 콘텐츠 실행: ${content.name} — ${content.description}`);
    logger.info(`${'─'.repeat(60)}`);

    // 필요 환경변수 점검
    const missingEnv = (content.requires ?? []).filter(k => !process.env[k]);
    if (missingEnv.length && !opts.dryRun) {
      logger.warn(`[orchestrator] ${content.name} 필요 환경변수 누락: ${missingEnv.join(', ')} — 건너뜀`);
      recordEvent('content_skipped_missing_env', { content: content.name, missing: missingEnv });
      continue;
    }

    const t0 = Date.now();
    try {
      const result = await content.run(ctx);
      const durationMs = Date.now() - t0;

      // 발행 전 자동 품질 검증
      const check = content.validate(result);
      if (!check.ok) {
        logger.warn(`[orchestrator] ${content.name} 품질 검증 실패: ${check.errors.join(' / ')}`);
        recordEvent('content_validation_failed', { content: content.name, errors: check.errors });
      }

      recordEvent('content_completed', { content: content.name, durationMs, ok: check.ok });
      logger.info(`▶ ${content.name} 완료 (${(durationMs / 1000).toFixed(1)}s)`);
    } catch (e) {
      logger.warn(`[orchestrator] ${content.name} 실행 실패:`, e.message);
      recordEvent('content_failed', { content: content.name, error: e.message });
    }
  }

  // 시스템 메트릭 저장 (Phase 1 skeleton — Phase 3에 주간 헬스 리포트로 발전)
  await flushMetrics(outputDir);

  logger.info(`\n${'═'.repeat(60)}`);
  logger.info(`  완료: ${reportDate}`);
  logger.info(`  출력: ${outputDir}`);
  logger.info(`${'═'.repeat(60)}`);
}

// CLI 진입점
if (process.argv.includes('--now')) {
  const opts = {};
  const idxDate    = process.argv.indexOf('--date');
  const idxContent = process.argv.indexOf('--content');
  if (idxDate    > -1) opts.date    = process.argv[idxDate + 1];
  if (idxContent > -1) opts.content = process.argv[idxContent + 1];
  opts.dryRun      = process.argv.includes('--dry-run');
  opts.skipCollect = process.argv.includes('--skip-collect');
  opts.preview     = process.argv.includes('--preview');   // 발송 없이 HTML만 생성

  run(opts).catch(e => {
    logger.warn('[orchestrator] 실행 실패:', e.message);
    process.exit(1);
  });
}

export { run };
