// tools/pipeline/index.js — Layer 1 집약 진입점
// 모든 피드를 병렬 수집해 PipelineData 객체 반환.
// 수집 실패는 null/[] 반환, 전체 파이프라인 중단 금지.
import { collectDomestic }    from '../collectors/domestic.js';
import { collectOverseas }    from '../collectors/overseas.js';
import { collectFxRates }     from '../collectors/fx_rates.js';
import { collectCommodities } from '../collectors/commodities.js';
import { collectNews }        from '../collectors/news.js';
import { collectDart }        from './dart_feed.js';
import { collectCrypto }      from './crypto_feed.js';
import { validateData }       from '../validators/data_validator.js';
import { isHoliday }          from '../utils/holiday.js';
import { logger }             from '../utils/logger.js';
import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone.js';
import utc from 'dayjs/plugin/utc.js';
import fs from 'fs/promises';
import path from 'path';

dayjs.extend(utc);
dayjs.extend(timezone);

/**
 * 전체 Layer 1 수집 실행.
 * @param {string} reportDate  YYYY-MM-DD
 * @param {string} outputDir   저장 폴더 경로
 * @returns {Promise<PipelineData>}
 */
export async function runPipeline(reportDate, outputDir) {
  const today     = dayjs(reportDate).tz('Asia/Seoul');
  const krHoliday = await isHoliday(today, 'KR');
  const usHoliday = await isHoliday(today.subtract(1, 'day'), 'US');
  logger.info(`[pipeline] 공휴일 — KR: ${krHoliday}, US: ${usHoliday}`);

  // 시장 데이터 병렬 수집
  const [domestic, overseas, fxRates, commodities] = await Promise.all([
    collectDomestic(krHoliday).catch(e => { logger.warn('[pipeline] domestic 실패:', e.message); return {}; }),
    collectOverseas(usHoliday).catch(e => { logger.warn('[pipeline] overseas 실패:', e.message); return {}; }),
    collectFxRates().catch(e           => { logger.warn('[pipeline] fxRates 실패:', e.message);  return {}; }),
    collectCommodities().catch(e       => { logger.warn('[pipeline] commodities 실패:', e.message); return {}; }),
  ]);

  // 뉴스 수집 (시장 데이터 컨텍스트 전달)
  const news = await collectNews(reportDate, { overseas, fxRates })
    .catch(e => { logger.warn('[pipeline] news 실패:', e.message); return []; });

  // 확장 피드 (선택 — API 키 없으면 빈 값)
  const [dart, crypto] = await Promise.all([
    collectDart().catch(e    => { logger.warn('[pipeline] dart 실패:', e.message);   return { reports: [] }; }),
    collectCrypto().catch(e  => { logger.warn('[pipeline] crypto 실패:', e.message); return null; }),
  ]);

  const coreData = validateData({
    date: reportDate,
    domestic, overseas, fxRates, commodities, news,
    meta: { krHoliday, usHoliday },
  });

  const pipelineData = { ...coreData, dart, crypto };

  // Layer 1 결과 저장
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(
    path.join(outputDir, 'data.json'),
    JSON.stringify(pipelineData, null, 2),
    'utf-8'
  );
  logger.info(`[pipeline] data.json 저장 완료 → ${outputDir}`);

  return pipelineData;
}
