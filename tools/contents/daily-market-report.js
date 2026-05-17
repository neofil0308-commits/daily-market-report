// tools/contents/daily-market-report.js — 일일 시장 리포트 콘텐츠 정의
//
// 현재 orchestrator의 흐름을 표준 콘텐츠 정의로 추상화한 첫 사례.
// 이 파일이 "매일 시장 리포트를 어떻게 만드는가"의 단일 진실 공급원(single source of truth).
// 새 콘텐츠(equity-deep-dive, card-news 등)는 이 파일을 본받아 추가하면 된다.

import { defineContent } from '../kernel/ContentPipeline.js';
import { runPipeline }   from '../layer-1-pipeline/index.js';
import { runTFNews }     from '../layer-2-research/tf-news/index.js';
import { runTFAnalyst }  from '../layer-2-research/tf-analyst/index.js';
import { runTFCrypto }   from '../layer-2-research/tf-crypto/index.js';
import { runEditor }     from '../layer-3-desk/editor/index.js';
import { buildHtml, buildEmailCard } from '../layer-3-desk/design/index.js';
import { publish }       from '../layer-3-desk/publisher/index.js';
import { logger }        from '../shared/utils/logger.js';
import fs from 'fs/promises';
import path from 'path';

export default defineContent({
  name: 'daily-market-report',
  description: '매일 08:00 KST 시장 리포트 — KOSPI·해외증시·환율·원자재·뉴스·애널리스트·코인 통합',
  schedule: 'daily-08:00',
  outputChannels: ['gmail', 'notion', 'gh-pages'],
  requires: [
    'GOOGLE_API_KEY', 'NAVER_CLIENT_ID', 'NAVER_CLIENT_SECRET',
    'GMAIL_SENDER', 'GMAIL_APP_PASSWORD', 'GMAIL_RECIPIENT',
    'NOTION_API_KEY', 'NOTION_ARCHIVE_DB_ID', 'PAGES_BASE_URL',
  ],

  /**
   * 콘텐츠 실행 — orchestrator 컨텍스트 받음.
   * @param {{ reportDate, outputDir, prevOutputDir, dryRun }} ctx
   */
  async run(ctx) {
    const { reportDate, outputDir, dryRun, skipCollect, preview } = ctx;

    // ── Layer 1: 시장 데이터 ─────────────────────────────────────────────
    let pipelineData;
    if (skipCollect) {
      logger.info('[Layer 1] --skip-collect: 기존 data.json 재사용');
      pipelineData = JSON.parse(await fs.readFile(path.join(outputDir, 'data.json'), 'utf-8'));
    } else {
      logger.info('[Layer 1] 시장 데이터 수집 시작...');
      pipelineData = await runPipeline(reportDate, outputDir);
    }
    logger.info('[Layer 1] 완료 ✓');

    if (dryRun) {
      logger.info('[content/daily-market-report] dry-run: Layer 2·3 생략');
      return { pipelineData, dryRun: true };
    }

    // ── Layer 2: TF 리서치 (tf-news 먼저, 그 결과의 raw를 다른 TF팀에 전달) ──
    logger.info('[Layer 2] TF 리서치 시작...');
    const tfNews = await runTFNews(pipelineData)
      .catch(e => { logger.warn('[TF-1] 실패:', e.message); return { findings:[], top_stories:[], themes:[], news_raw: [] }; });
    const newsRaw = tfNews.news_raw ?? [];

    const [tfAnalystInitial, tfCrypto] = await Promise.all([
      runTFAnalyst(newsRaw)
        .catch(e => { logger.warn('[TF-2] 실패:', e.message); return { findings:[], consensus_raw:[], dart_reports:[] }; }),
      runTFCrypto(newsRaw)
        .catch(e => { logger.warn('[TF-3] 실패:', e.message); return { findings:[], crypto_data: null }; }),
    ]);

    // tf-analyst 폴백 체인 (한경 raw → DART 최종) — 기존 로직 유지
    const tfAnalyst = await _applyAnalystFallback(tfAnalystInitial, newsRaw);

    // 한경 옛 URL 안전망 + 링크 매핑
    _normalizeAnalystLinks(tfAnalyst);

    const tfResults = { news: tfNews, analyst: tfAnalyst, crypto: tfCrypto };
    await fs.writeFile(
      path.join(outputDir, 'tf_results.json'),
      JSON.stringify(tfResults, null, 2),
      'utf-8',
    );
    logger.info(`[Layer 2] 완료 ✓  뉴스: ${tfNews.findings.length}건 | 애널: ${tfAnalyst.findings.length}건 | 코인: ${tfCrypto.findings.length}건`);

    // ── Layer 3: DESK (편집 → 디자인 → 발행) ─────────────────────────────
    // designer 호환 합성: Layer 1이 시장 데이터만 가지므로, TF 결과 raw를 합성해 DESK에 전달
    const desktopData = {
      ...pipelineData,
      news:   newsRaw,
      crypto: tfCrypto.crypto_data ?? null,
      dart:   { reports: tfAnalyst.dart_reports ?? [] },
    };

    logger.info('[Layer 3] DESK 시작...');
    const editorialPlan = await runEditor(desktopData, tfResults)
      .catch(e => { logger.warn('[desk/editor] 실패, 기본 플랜:', e.message); return {}; });
    logger.info(`[desk/editor] 헤드라인: "${editorialPlan.headline ?? '(없음)'}"`);

    const html = await buildHtml(desktopData, tfResults, editorialPlan);
    await fs.writeFile(path.join(outputDir, 'report.html'), html, 'utf-8');
    logger.info('[desk/designer] report.html 저장 완료');

    const reportUrl = `${process.env.PAGES_BASE_URL ?? ''}/outputs/${reportDate}/report.html`;

    // ── Preview 모드: 발송 차단, 메일 카드 별도 저장 (사주가 발간 전 검토) ──
    if (preview) {
      const emailCardHtml = buildEmailCard(desktopData, tfResults, editorialPlan, reportUrl);
      // Gmail로 받는 모습 그대로 — 브라우저에서 열 수 있게 최소 wrapper만 추가
      const wrapped = `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><title>메일 카드 미리보기 ${reportDate}</title>
<style>body{margin:0;padding:24px;background:#e5e7eb;font-family:'Apple SD Gothic Neo','Malgun Gothic',sans-serif}
.wrap{max-width:600px;margin:0 auto;background:#fff;box-shadow:0 4px 16px rgba(0,0,0,0.1);border-radius:8px;overflow:hidden}
.note{max-width:600px;margin:0 auto 16px;font-size:12px;color:#475569;text-align:center}</style></head>
<body>
<div class="note">📧 Gmail로 발송될 카드 본문 미리보기 (${reportDate})</div>
<div class="wrap">${emailCardHtml}</div>
</body></html>`;
      await fs.writeFile(path.join(outputDir, 'email-card-preview.html'), wrapped, 'utf-8');
      logger.info('[desk/designer] email-card-preview.html 저장 완료 (Gmail 발송 차단)');
      return { pipelineData, tfResults, editorialPlan, html, preview: true };
    }

    const pubResult = await publish(reportDate, html, desktopData, outputDir, reportUrl, tfResults, editorialPlan);

    return { pipelineData, tfResults, editorialPlan, html, pubResult };
  },

  /**
   * 발행 전 자동 품질 체크. 콘텐츠가 실제로 사주에게 보낼 만한 상태인지 검증.
   */
  validate(result) {
    if (result?.dryRun) return { ok: true, errors: [] };
    const errors = [];
    const d = result?.pipelineData;
    if (!d) errors.push('pipelineData 없음');
    if (d && !d.domestic?.kospi?.today && !d.meta?.krHoliday) {
      errors.push('KOSPI 종가 없음 (휴장일도 아님)');
    }
    if (!result?.html) errors.push('HTML 미생성');
    return { ok: errors.length === 0, errors };
  },
});


// ── 헬퍼 함수들 (기존 orchestrator의 폴백·링크 매핑 로직) ───────────────────

async function _applyAnalystFallback(tfAnalystInitial, newsRaw) {
  let tfAnalyst = tfAnalystInitial;

  if ((tfAnalyst.findings?.length ?? 0) === 0) {
    const hasAnalystNews = newsRaw.some(n =>
      /목표주가|목표가|투자의견|증권사|리포트|매수|매도|Buy|Hold/i.test((n.title ?? '') + ' ' + (n.body ?? ''))
    );
    const hasConsensus = (tfAnalyst.consensus_raw?.length ?? 0) > 0;
    const hasDart      = (tfAnalyst.dart_reports?.length ?? 0) > 0;
    if (hasAnalystNews || hasConsensus || hasDart) {
      logger.info('[TF-2] 애널리스트 분석 재시도 (3초 후)...');
      await new Promise(r => setTimeout(r, 3000));
      try {
        const retry = await runTFAnalyst(newsRaw);
        if ((retry.findings?.length ?? 0) > 0) {
          tfAnalyst = retry;
          logger.info(`[TF-2] 재시도 성공: ${tfAnalyst.findings.length}건`);
        } else if ((retry.consensus_raw?.length ?? 0) > (tfAnalyst.consensus_raw?.length ?? 0)) {
          tfAnalyst = { ...tfAnalyst, consensus_raw: retry.consensus_raw, dart_reports: retry.dart_reports };
        }
      } catch (e) { logger.warn('[TF-2] 재시도 실패:', e.message); }
    }
  }

  // 한경 컨센서스 raw 폴백
  if ((tfAnalyst.findings?.length ?? 0) === 0 && (tfAnalyst.consensus_raw?.length ?? 0) > 0) {
    tfAnalyst = {
      ...tfAnalyst,
      findings: tfAnalyst.consensus_raw.slice(0, 5).map(c => ({
        company:       c.company ?? '―',
        firm:          c.firm    ?? '―',
        rating_change: '―',
        target_price:  { new: null },
        key_thesis:    c.title   ?? '',
        report_url:    c.url     ?? null,
        importance:    5,
      })),
    };
    logger.info(`[TF-2] 한경 컨센서스 폴백: ${tfAnalyst.findings.length}건`);
  }

  // DART 최종 폴백
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

  return tfAnalyst;
}

function _normalizeAnalystLinks(tfAnalyst) {
  if (!tfAnalyst.findings?.length) return;

  const normalize = s => String(s ?? '')
    .replace(/\(주\)|㈜/g, '')
    .replace(/\s+/g, '')
    .replace(/우[^가-힣]*$/, '')
    .toLowerCase();
  const dartByNorm = new Map(
    (tfAnalyst.dart_reports ?? []).map(r => [normalize(r.company), r.url])
  );

  // 안전망: 옛 한경 URL → 신규 URL 자동 변환 (오답노트 #035)
  const normalizeHankyungUrl = u => {
    if (!u || typeof u !== 'string') return u;
    if (!u.includes('consensus.hankyung.com')) return u;
    return u
      .replace(/\/apps\.analysis\/analysis\.view\?/, '/analysis/downpdf?')
      .replace(/\/apps\.analysis\/analysis\.list\?/, '/analysis/list?')
      .replace(/\/apps\.analysis\//, '/analysis/');
  };

  let directHits = 0, dartHits = 0, searchHits = 0, urlRewrites = 0;
  tfAnalyst.findings = tfAnalyst.findings.map(f => {
    let mapped;
    if (f.report_url) { directHits++; mapped = { ...f, dart_url: f.report_url }; }
    else if (f.dart_url) { mapped = f; }
    else {
      const dartMatch = dartByNorm.get(normalize(f.company));
      if (dartMatch) { dartHits++; mapped = { ...f, dart_url: dartMatch }; }
      else {
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
