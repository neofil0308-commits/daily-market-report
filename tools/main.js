// tools/main.js — 오케스트레이터
import 'dotenv/config';
import cron from 'node-cron';
import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone.js';
import utc from 'dayjs/plugin/utc.js';
import fs from 'fs/promises';
import path from 'path';

import { collectDomestic }   from './collectors/domestic.js';
import { collectOverseas }   from './collectors/overseas.js';
import { collectFxRates }    from './collectors/fx_rates.js';
import { collectCommodities} from './collectors/commodities.js';
import { collectNews }       from './collectors/news.js';
import { validateData }      from './validators/data_validator.js';
import { generateReport }    from './generators/report_generator.js';
import { publishToNotion }   from './publishers/notion.js';
import { publishToGmail }    from './publishers/gmail.js';
import { isHoliday }         from './utils/holiday.js';
import { logger }            from './utils/logger.js';

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

    // STEP 2: 데이터 수집 (병렬)
    logger.info('데이터 수집 시작...');
    const [domestic, overseas, fxRates, commodities, rawNews] = await Promise.all([
      collectDomestic(krHoliday),
      collectOverseas(usHoliday),
      collectFxRates(),
      collectCommodities(),
      collectNews(reportDate),
    ]);

    // STEP 3: 검증 및 변동값 계산
    data = validateData({ date: reportDate, domestic, overseas, fxRates, commodities, news: rawNews,
      meta: { krHoliday, usHoliday } });

    await fs.writeFile(dataPath, JSON.stringify(data, null, 2), 'utf-8');
    logger.info('수집 데이터 저장 완료');
  }

  if (opts.dryRun) {
    logger.info('--dry-run: 리포트 생성 생략');
    return;
  }

  // STEP 4+5: 뉴스 요약 + HTML 리포트 생성 (Gemini 1회 호출)
  logger.info('리포트 생성 중 (뉴스 요약 + HTML 통합)...');
  const { newsSummaryMd, reportHtml } = await generateReport(data, reportDate);
  await fs.writeFile(path.join(outputDir, 'summary.md'),  newsSummaryMd, 'utf-8');
  await fs.writeFile(path.join(outputDir, 'report.html'), reportHtml,    'utf-8');
  logger.info('리포트 생성 완료');

  // STEP 6: 발행
  logger.info('Notion 업로드 중...');
  await publishToNotion(reportDate, newsSummaryMd, reportHtml, data);

  logger.info('Gmail 발송 중...');
  await publishToGmail(reportDate, newsSummaryMd, reportHtml, data);

  logger.info(`=== 완료: ${reportDate} ===`);
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
