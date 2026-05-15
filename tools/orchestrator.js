// tools/orchestrator.js — 3-Layer 통합 오케스트레이터
// Layer 1(Pipeline) → Layer 2(TF Teams) → Layer 3(Desk) 순차 실행.
// 기존 tools/main.js는 GA 하위 호환용으로 유지.
import 'dotenv/config';
import fs   from 'fs/promises';
import path from 'path';
import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone.js';
import utc from 'dayjs/plugin/utc.js';

import { runPipeline }   from './layer-1-pipeline/index.js';
import { runTFNews }     from './layer-2-research/tf-news/index.js';
import { runTFAnalyst }  from './layer-2-research/tf-analyst/index.js';
import { runTFCrypto }   from './layer-2-research/tf-crypto/index.js';
import { runEditor }     from './layer-3-desk/editor/index.js';
import { buildHtml }     from './layer-3-desk/design/index.js';
import { publish }       from './layer-3-desk/publisher/index.js';
import { logger }        from './shared/utils/logger.js';

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

  // 각 TF팀은 자기 도메인 데이터를 직접 수집 (Layer 1 cross-layer 제거 — 2026-05-16)
  // tf-analyst: 한경 컨센서스 + DART 자체 호출 / tf-crypto: CoinGecko 자체 호출
  // 둘 다 결과 객체에 raw data를 노출(dart_reports, crypto_data)해 orchestrator가 폴백·designer 호환에 사용.
  const [tfNews, tfAnalystInitial, tfCrypto] = await Promise.all([
    runTFNews(pipelineData.news, pipelineData)
      .catch(e => { logger.warn('[TF-1] 실패:', e.message); return { findings:[], top_stories:[], themes:[] }; }),
    runTFAnalyst(pipelineData.news ?? [])
      .catch(e => { logger.warn('[TF-2] 실패:', e.message); return { findings:[], consensus_raw:[], dart_reports:[] }; }),
    runTFCrypto(pipelineData.news ?? [])
      .catch(e => { logger.warn('[TF-3] 실패:', e.message); return { findings:[], crypto_data: null }; }),
  ]);

  // ── TF-Analyst Gemini 503 폴백 체인 ──────────────────────────────────────────
  // 사주 정책: 한경 컨센서스가 1차 소스. DART(사업보고서류)는 애널리스트 리포트가 거의 없어 보조.
  // (1) findings 비어 있고 분석 소스 있으면 3초 후 1회 재시도
  // (2) 그래도 비면 한경 컨센서스 raw로 폴백 (Gemini 없이도 섹션 유지, 직링크 포함)
  // (3) 한경도 비면 DART 리포트로 최종 폴백
  let tfAnalyst = tfAnalystInitial;
  if ((tfAnalyst.findings?.length ?? 0) === 0) {
    const hasAnalystNews = (pipelineData.news ?? []).some(n =>
      /목표주가|목표가|투자의견|증권사|리포트|매수|매도|Buy|Hold/i.test((n.title ?? '') + ' ' + (n.body ?? ''))
    );
    const hasConsensus = (tfAnalyst.consensus_raw?.length ?? 0) > 0;
    const hasDart      = (tfAnalyst.dart_reports?.length ?? 0) > 0;
    if (hasAnalystNews || hasConsensus || hasDart) {
      logger.info('[TF-2] 애널리스트 분석 재시도 (3초 후)...');
      await new Promise(r => setTimeout(r, 3000));
      try {
        const retry = await runTFAnalyst(pipelineData.news ?? []);
        if ((retry.findings?.length ?? 0) > 0) {
          tfAnalyst = retry;
          logger.info(`[TF-2] 재시도 성공: ${tfAnalyst.findings.length}건`);
        } else if ((retry.consensus_raw?.length ?? 0) > (tfAnalyst.consensus_raw?.length ?? 0)) {
          // findings는 비었지만 consensus_raw가 추가로 수집됐다면 그것만이라도 반영
          tfAnalyst = { ...tfAnalyst, consensus_raw: retry.consensus_raw, dart_reports: retry.dart_reports };
        }
      } catch (e) { logger.warn('[TF-2] 재시도 실패:', e.message); }
    }
  }
  // (2) 한경 컨센서스 raw 폴백 — Gemini 실패 시에도 한경 리포트 직링크로 섹션 유지
  if ((tfAnalyst.findings?.length ?? 0) === 0 && (tfAnalyst.consensus_raw?.length ?? 0) > 0) {
    tfAnalyst = {
      ...tfAnalyst,
      findings: tfAnalyst.consensus_raw.slice(0, 5).map(c => ({
        company:       c.company ?? '―',
        firm:          c.firm    ?? '―',
        rating_change: '―',
        target_price:  { new: null },
        key_thesis:    c.title   ?? '',
        report_url:    c.url     ?? null,  // 한경 직링크 — 아래 링크 체인에서 dart_url로 승격됨
        importance:    5,
      })),
    };
    logger.info(`[TF-2] 한경 컨센서스 폴백: ${tfAnalyst.findings.length}건`);
  }
  // (3) DART 최종 폴백 — 한경도 비어있는 극단 케이스만 적용
  if ((tfAnalyst.findings?.length ?? 0) === 0 && (tfAnalyst.dart_reports?.length ?? 0) > 0) {
    tfAnalyst = {
      ...tfAnalyst,
      findings: tfAnalyst.dart_reports.slice(0, 5).map(r => ({
        company:       r.company ?? '―',
        firm:          r.flr_nm  ?? '―',
        rating_change: '―',
        target_price:  { new: null },
        key_thesis:    r.reportName ?? '',
        dart_url:      r.url ?? null,
        importance:    5,
      })),
    };
    logger.info(`[TF-2] DART 폴백: ${tfAnalyst.findings.length}건`);
  }
  // ── 애널리스트 종목 링크 폴백 체인 ──────────────────────────────────────────
  // 사주 의도: Gemini가 뽑은 회사라면 무조건 링크가 활성화되어야 한다.
  // 1순위 — report_url: Gemini가 한경 컨센서스 항목에서 그대로 복사한 직링크 (가장 정확)
  // 2순위 — dart_url: 기존 코드/DART 폴백이 채운 값
  // 3순위 — DART 정규화 매칭: 같은 날 DART 응답에 그 회사 공시가 있으면 매칭
  // 4순위 — 한경 컨센서스 검색 URL: 회사명만 있어도 작동하는 최종 안전망
  // designer.js는 f.dart_url을 읽으므로, 1순위 report_url이 있으면 dart_url로 승격해서 통일.
  if ((tfAnalyst.findings?.length ?? 0) > 0) {
    const normalize = s => String(s ?? '')
      .replace(/\(주\)|㈜/g, '')
      .replace(/\s+/g, '')
      .replace(/우[^가-힣]*$/, '')   // 우선주 접미사 제거
      .toLowerCase();
    const dartByNorm = new Map(
      (tfAnalyst.dart_reports ?? []).map(r => [normalize(r.company), r.url])
    );
    // 안전망: Gemini가 학습 시점의 옛 한경 경로(/apps.analysis/analysis.view·analysis.list 등)를
    // URL로 합성하면 메일에서 클릭 시 한경 404로 떨어진다. 모든 한경 도메인 URL을 신규 경로로 강제 변환.
    // 2026-05-15 19:08 KST 발행 메일에서 view 링크 3건 전부 404로 깨졌던 사고 재발 방지.
    const normalizeHankyungUrl = u => {
      if (!u || typeof u !== 'string') return u;
      if (!u.includes('consensus.hankyung.com')) return u;
      return u
        .replace(/\/apps\.analysis\/analysis\.view\?/, '/analysis/downpdf?') // 개별 리포트 → PDF 직접 다운로드
        .replace(/\/apps\.analysis\/analysis\.list\?/, '/analysis/list?')    // 리스트
        .replace(/\/apps\.analysis\//, '/analysis/');                         // 그 외 안전 일반 매핑
    };
    let directHits = 0, dartHits = 0, searchHits = 0, urlRewrites = 0;
    tfAnalyst.findings = tfAnalyst.findings.map(f => {
      let mapped;
      // 1순위: Gemini가 직접 뽑은 한경 URL
      if (f.report_url) { directHits++; mapped = { ...f, dart_url: f.report_url }; }
      else if (f.dart_url) { mapped = f; }
      else {
        // 3순위: DART 정규화 매칭
        const dartMatch = dartByNorm.get(normalize(f.company));
        if (dartMatch) { dartHits++; mapped = { ...f, dart_url: dartMatch }; }
        else {
          // 4순위: 한경 컨센서스 검색 URL — 회사명 인코딩
          // 2026-05-16: 한경 리디자인으로 /apps.analysis/analysis.list 가 404, /analysis/list 로 이전.
          const company = String(f.company ?? '').trim();
          if (company && company !== '―') {
            searchHits++;
            const q = encodeURIComponent(company);
            mapped = { ...f, dart_url: `https://consensus.hankyung.com/analysis/list?search_value=${q}&report_type=&search_type=2` };
          } else {
            mapped = { ...f, dart_url: null };
          }
        }
      }
      const before = mapped.dart_url;
      const after  = normalizeHankyungUrl(before);
      if (before && after !== before) urlRewrites++;
      return { ...mapped, dart_url: after };
    });
    logger.info(`[TF-2] 애널리스트 링크 — 한경 직링크 ${directHits}건, DART 매칭 ${dartHits}건, 한경 검색 폴백 ${searchHits}건, 옛경로 자동변환 ${urlRewrites}건`);
  }

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

  // designer 호환 합성: Layer 1이 더 이상 crypto/dart를 갖지 않으므로,
  // TF팀이 노출한 raw를 designer가 보던 자리(pipelineData.crypto, .dart)에 합성해서 전달.
  // 이렇게 하면 designer.js 변경 없이 새 데이터 흐름 유지.
  const desktopData = {
    ...pipelineData,
    crypto: tfCrypto.crypto_data ?? null,
    dart:   { reports: tfAnalyst.dart_reports ?? [] },
  };

  // 3-A: 편집장 — 선별·교차검증·내러티브
  const editorialPlan = await runEditor(desktopData, tfResults)
    .catch(e => { logger.warn('[desk/editor] 실패, 기본 플랜 사용:', e.message); return {}; });
  logger.info(`[desk/editor] 헤드라인: "${editorialPlan.headline ?? '(없음)'}"`);

  // 3-B: 디자이너 — HTML 조립
  const html = await buildHtml(desktopData, tfResults, editorialPlan);
  await fs.writeFile(path.join(outputDir, 'report.html'), html, 'utf-8');
  logger.info('[desk/designer] report.html 저장 완료');

  // 3-C: 발행
  const reportUrl = `${process.env.PAGES_BASE_URL ?? ''}/outputs/${reportDate}/report.html`;
  const pubResult = await publish(reportDate, html, desktopData, outputDir, reportUrl, tfResults, editorialPlan);
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
