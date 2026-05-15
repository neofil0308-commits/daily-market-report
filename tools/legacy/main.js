// tools/main.js — ⚠️ DEPRECATED ⚠️
// 2026-05-13 이후 GitHub Actions는 이 파일을 호출하지 않는다.
// GA 진입점: tools/orchestrator.js (`.github/workflows/daily-report.yml` 참조).
// 이 파일은 로컬에서 수동으로 데이터 수집만 검증할 때 쓰는 보조 도구다.
// 새 기능을 여기에 추가하면 GA에 절대 반영되지 않는다 — orchestrator.js / pipeline / desk 쪽에 추가하라.
// (참조: 오답노트 #033)
import 'dotenv/config';
import cron from 'node-cron';
import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone.js';
import utc from 'dayjs/plugin/utc.js';
import fs from 'fs/promises';
import path from 'path';

import { collectDomestic }   from '../layer-1-pipeline/collectors/domestic.js';
import { collectOverseas }   from '../layer-1-pipeline/collectors/overseas.js';
import { collectFxRates }    from '../layer-1-pipeline/collectors/fx_rates.js';
import { collectCommodities} from '../layer-1-pipeline/collectors/commodities.js';
import { collectNews }       from '../layer-1-pipeline/collectors/news.js';
import { collectCrypto }     from '../layer-2-research/tf-crypto/feeds/crypto_feed.js';
import { collectDart }       from '../layer-2-research/tf-analyst/feeds/dart_feed.js';
import { validateData }      from '../shared/validators/data_validator.js';
import { isHoliday }         from '../shared/utils/holiday.js';
import { logger }            from '../shared/utils/logger.js';

dayjs.extend(utc);
dayjs.extend(timezone);

// ── 핵심 워크플로우 ───────────────────────────────────────────────────────────
async function runWorkflow(opts = {}) {
  const today = dayjs().tz('Asia/Seoul');
  const reportDate = opts.date ?? today.format('YYYY-MM-DD');
  const outputDir  = path.join(process.env.OUTPUT_DIR ?? './outputs', reportDate);
  const dataPath   = path.join(outputDir, 'data.json');

  logger.info(`=== 일일 시장 리포트 시작: ${reportDate} ===`);
  await fs.mkdir(outputDir, { recursive: true });

  let data;

  if (opts.skipCollect) {
    // 기존 data.json 재사용
    logger.info('--skip-collect: 기존 data.json 로드');
    data = JSON.parse(await fs.readFile(dataPath, 'utf-8'));
  } else {
    // STEP 1: 공휴일 확인
    const krHoliday = await isHoliday(today, 'KR');
    const usHoliday = await isHoliday(today.subtract(1, 'day'), 'US');
    logger.info(`공휴일 여부 — KR: ${krHoliday}, US: ${usHoliday}`);

    // STEP 2: 데이터 수집 — 시장데이터 먼저, 뉴스는 AI 키워드 생성 후
    logger.info('데이터 수집 시작...');
    // 전일 outputs 경로 — VKOSPI carry-forward용
    const prevDate = today.subtract(1, 'day');
    const prevOutputDir = path.join(process.env.OUTPUT_DIR ?? './outputs', prevDate.format('YYYY-MM-DD'));
    const [domestic, overseas, fxRates, commodities, crypto, dart] = await Promise.all([
      collectDomestic(krHoliday, prevOutputDir),
      collectOverseas(usHoliday),
      collectFxRates(),
      collectCommodities(),
      collectCrypto().catch(() => null),
      collectDart().catch(() => ({ reports: [] })),
    ]);
    // 해외증시·환율 데이터를 Gemini에 넘겨 오늘의 추가 키워드 포함해 뉴스 수집
    const rawNews = await collectNews(reportDate, { overseas, fxRates });

    // STEP 3: 검증 및 변동값 계산
    data = validateData({ date: reportDate, domestic, overseas, fxRates, commodities, news: rawNews,
      meta: { krHoliday, usHoliday } });
    data.crypto = crypto ?? null;
    data.dart   = dart   ?? { reports: [] };

    await fs.writeFile(dataPath, JSON.stringify(data, null, 2), 'utf-8');
    logger.info('수집 데이터 저장 완료');
  }

  if (opts.dryRun) {
    logger.info('--dry-run: 리포트 생성 생략');
    return;
  }

  // ⚠️ DEPRECATED 경로 — generators/ 폴더가 2026-05-15에 제거되어 발송 경로가 끊겼다.
  // 발송이 필요하면 GA와 동일한 진입점을 쓰라:
  logger.warn('=================================================================');
  logger.warn('  이 경로는 더 이상 지원되지 않습니다 (generators/ 제거됨, 2026-05-15).');
  logger.warn('  발송까지 실행하려면 아래 명령을 쓰세요:');
  logger.warn('      node tools/orchestrator.js --now');
  logger.warn('  데이터 수집만 검증하려면 --dry-run을 추가하세요.');
  logger.warn('=================================================================');
  process.exitCode = 1;
}

// ── CLI 즉시 실행 (--now 플래그) ─────────────────────────────────────────────
if (process.argv.includes('--now')) {
  const opts = {
    dryRun:      process.argv.includes('--dry-run'),
    skipCollect: process.argv.includes('--skip-collect'),
    date:        (() => {
      const i = process.argv.indexOf('--date');
      return i !== -1 ? process.argv[i + 1] : undefined;
    })(),
  };

  runWorkflow(opts).catch(err => {
    logger.error(err);
    process.exitCode = 1;
  });
} else {
  // ── cron 등록 (평일 08:00 KST) — --now 없을 때만 등록
  cron.schedule('0 8 * * 1-5', () => {
    runWorkflow().catch(err => logger.error('워크플로우 오류:', err));
  }, { timezone: 'Asia/Seoul' });
  logger.info('스케줄러 시작 — 평일 08:00 KST');
}
