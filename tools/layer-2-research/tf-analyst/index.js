// tools/layer-2-research/tf-analyst/index.js — TF-2 애널리스트 리포트 분석팀
// 자기 도메인 데이터(dart + 한경 컨센서스)를 직접 수집해 분석. Layer 1 의존 제거(2026-05-16).
// 뉴스 + 한경 컨센서스 + DART 공시 → 주목할 애널리스트 리포트 3개 선정
// 2026-05-16: _loadPrevConsensus() + _diffTargetPrices() 추가 — 목표주가 변동 추적
import axios from 'axios';
import fs from 'fs/promises';
import path from 'path';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { logger } from '../../shared/utils/logger.js';
import { geminiWithRetry } from '../../shared/utils/gemini_retry.js';
import { collectDart } from './feeds/dart_feed.js';

/**
 * TF-2: 애널리스트 리포트 분석 실행.
 * @param {Array}  newsData    수집된 뉴스 목록 (orchestrator가 Layer 1에서 전달)
 * @param {string} reportDate  YYYY-MM-DD (목표주가 비교 기준일, 기본값: 오늘)
 * @returns {Promise<TFAnalystResult>}
 */
export async function runTFAnalyst(newsData = [], reportDate = null) {
  // 자기 도메인 데이터를 직접 수집 (Layer 1의 cross-layer 제거)
  // 한경 컨센서스 + DART + 전일 컨센서스 병렬 — 한쪽 실패해도 다른 쪽 분석 가능
  const today = reportDate ?? new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const [consensusItems, dartData, prevConsensus] = await Promise.all([
    fetchHankyungConsensus(),
    collectDart().catch(e => { logger.warn('[tf-analyst] dart 실패:', e.message); return { reports: [] }; }),
    _loadPrevConsensus(today).catch(e => { logger.warn('[tf-analyst] 전일 컨센서스 로드 실패:', e.message); return []; }),
  ]);

  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    logger.warn('[tf-analyst] GOOGLE_API_KEY 미설정 — 분석 생략');
    return _emptyResult(consensusItems, dartData);
  }

  // 뉴스에서 애널리스트 관련 기사 필터
  const analystNews = (newsData ?? []).filter(n =>
    /목표주가|목표가|투자의견|증권사|리포트|매수|매도|Buy|Hold|Sell|상향|하향|컨센서스|TP |BUY|HOLD/.test(
      (n.title ?? '') + ' ' + (n.body ?? '')
    )
  );

  const hasDart      = dartData?.reports?.length > 0;
  const hasNews      = analystNews.length > 0;
  const hasConsensus = consensusItems.length > 0;

  if (!hasDart && !hasNews && !hasConsensus) {
    logger.info('[tf-analyst] 분석 소스 없음 — 건너뜀');
    return _emptyResult(consensusItems, dartData);
  }

  const modelName = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: modelName });

    const prompt = _buildPrompt(dartData?.reports ?? [], analystNews, consensusItems);
    const result = await geminiWithRetry(() => model.generateContent(prompt), { label: 'tf-analyst' });
    const raw    = result.response.text()
      .replace(/^```json\s*/,'').replace(/```\s*$/,'').trim();

    const parsed = JSON.parse(raw);
    logger.info(`[tf-analyst] 분석 완료 — ${parsed.findings?.length ?? 0}건`);

    const targetPriceChanges = _diffTargetPrices(consensusItems, prevConsensus);
    if (targetPriceChanges.length > 0) {
      logger.info(`[tf-analyst] 목표주가 변동 ${targetPriceChanges.length}건 감지`);
    }

    return {
      findings:             parsed.findings          ?? [],
      sector_sentiment:     parsed.sector_sentiment  ?? {},
      consensus_changes:    parsed.consensus_changes ?? 0,
      alert_items:          (parsed.findings ?? []).filter(f => f.importance >= 8),
      confidence:           parsed.confidence        ?? 0.8,
      model_used:           modelName,
      consensus_raw:        consensusItems,
      dart_reports:         dartData?.reports ?? [],   // ⭐ orchestrator가 폴백·링크 매핑에 사용
      target_price_changes: targetPriceChanges,
    };
  } catch (e) {
    logger.warn('[tf-analyst] 분석 실패:', e.message);
    return _emptyResult(consensusItems, dartData);
  }
}

// 한경 컨센서스 최근 리포트 스크래핑
// 2026-05-16 한경이 엔드포인트를 리디자인. /apps.analysis/analysis.list(404) → /analysis/list,
// 날짜는 YYYYMMDD → YYYY-MM-DD, category=CO → report_type=CO, pagenum은 페이지번호→페이지당건수로 의미가 바뀜.
// 5xx/네트워크 오류는 간헐적이므로 1.5초 간격 2회 재시도 (총 3회 시도). 4xx는 영구 오류로 즉시 포기.
async function fetchHankyungConsensus() {
  const today = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const sdate = new Date(today);
  sdate.setDate(sdate.getDate() - 3);
  const fmt = d => d.toISOString().slice(0, 10); // YYYY-MM-DD

  const reqConfig = {
    params: {
      sdate: fmt(sdate),
      edate: fmt(today),
      report_type: 'CO', // 기업분석
      pagenum: 50,       // 페이지당 건수 (최대치 80, 안정적으로 50)
      now_page: 1,
    },
    headers: {
      // 한경은 짧은 UA를 봇으로 보고 500을 던진다(2026-05-16 확인). 풀 브라우저 UA + Accept 헤더 필수.
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
      'Referer': 'https://consensus.hankyung.com/',
    },
    timeout: 12000,
  };

  const MAX_ATTEMPTS = 3;
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await axios.get('https://consensus.hankyung.com/analysis/list', reqConfig);
      const { load } = await import('cheerio');
      const $ = load(res.data);
      const items = [];

      // 새 구조: <tbody> 안의 <tr>들. 컬럼 순서 = 작성일·제목·적정가격·투자의견·작성자·증권사·...
      // 제목 셀(td.text_l > a) 텍스트가 "회사명(종목코드) 리포트제목" 형태로 합쳐져 있다.
      $('tbody tr').each((_, el) => {
        const tds = $(el).find('td');
        if (tds.length < 6) return;

        const date     = $(tds[0]).text().trim();
        const titleA   = $(tds[1]).find('a').first();
        const rawTitle = titleA.text().replace(/\s+/g, ' ').trim();
        const href     = titleA.attr('href') ?? '';
        const target   = $(tds[2]).text().trim();   // 적정가격
        const rating   = $(tds[3]).text().trim();   // 투자의견
        const firm     = $(tds[5]).text().trim();   // 제공출처(증권사)

        if (!rawTitle || rawTitle.length < 4) return;

        // "회사명(종목코드) 나머지" 분리. 매칭 실패해도 원제목 그대로 사용.
        const m = rawTitle.match(/^(.+?)\s*\((\d{6})\)\s*(.*)$/);
        const company = m ? m[1].trim() : '';
        const ticker  = m ? m[2]        : '';
        const title   = m ? m[3].trim() || rawTitle : rawTitle;

        items.push({
          title,
          firm,
          company,
          ticker,
          target_price: target,
          rating,
          date,
          url: href.startsWith('http') ? href : `https://consensus.hankyung.com${href}`,
        });
      });

      if (items.length > 0) {
        const retryNote = attempt > 1 ? ` (재시도 ${attempt - 1}회 후 성공)` : '';
        logger.info(`[tf-analyst] 한경 컨센서스 ${items.length}건 수집${retryNote}`);
      }
      return items.slice(0, 20);
    } catch (e) {
      lastErr = e;
      const status = e.response?.status;
      // 4xx는 영구 오류(404 URL 변경, 401·403 차단 등) — 재시도 의미 없음
      if (status && status >= 400 && status < 500) {
        logger.warn(`[tf-analyst] 한경 컨센서스 수집 실패 (HTTP ${status}) — 영구 오류, 재시도 안 함`);
        return [];
      }
      // 5xx 또는 네트워크 오류는 일시적일 가능성 → 1.5초 후 재시도
      if (attempt < MAX_ATTEMPTS) {
        logger.warn(`[tf-analyst] 한경 컨센서스 일시 오류 (${status ?? e.code ?? 'NETWORK'}) — ${attempt}회차 실패, 1.5초 후 재시도`);
        await new Promise(r => setTimeout(r, 1500));
      }
    }
  }
  logger.warn(`[tf-analyst] 한경 컨센서스 수집 실패 (${MAX_ATTEMPTS}회 모두 실패):`, lastErr?.message);
  return [];
}

function _buildPrompt(dartReports, analystNews, consensusItems) {
  const sections = [];

  if (dartReports.length > 0) {
    sections.push(`## DART 공시 (${dartReports.length}건)\n${JSON.stringify(dartReports.slice(0, 10), null, 2)}`);
  }
  if (analystNews.length > 0) {
    sections.push(`## 뉴스 (애널리스트 관련, ${analystNews.length}건)\n${analystNews.map(n => `- [${n.source}] ${n.title}\n  ${(n.body ?? '').slice(0, 200)}`).join('\n')}`);
  }
  if (consensusItems.length > 0) {
    // ⭐ url 포함해서 Gemini에게 전달 — 선정한 리포트의 원문 링크를 findings에 그대로 담을 수 있도록.
    // 한경 신규 스크래퍼가 target_price·rating까지 채워주므로 그대로 노출 → Gemini가 추측 대신 사용.
    sections.push(`## 한경 컨센서스 최근 리포트 (${consensusItems.length}건)
각 항목 형식: [INDEX] 회사(종목코드) | 증권사 | 투자의견 | 적정가격 | 제목 | URL
${consensusItems.map((c, i) => `[${i}] ${c.company ?? ''}${c.ticker ? `(${c.ticker})` : ''} | ${c.firm ?? ''} | ${c.rating ?? ''} | ${c.target_price ?? ''} | ${c.title} | ${c.url ?? ''}`).join('\n')}`);
  }

  return `당신은 한국 주식 시장 애널리스트 리포트 큐레이터입니다.

아래 데이터를 바탕으로 오늘 주목할 만한 애널리스트 리포트 3개를 선정하세요.
선정 기준: 목표주가 변동 폭이 크거나, 투자의견 변경, 또는 시장에서 화제가 될 이슈.

⭐ 중요: 선정한 리포트가 "한경 컨센서스" 섹션에 있다면, 그 항목의 URL을 반드시 report_url에 그대로 복사해 출력하라.
URL이 없는 항목(DART·뉴스에서 추출한 경우)은 report_url을 null로 두라.

반드시 아래 JSON 형식만 응답 (코드블록 없이):
{
  "findings": [
    {
      "company": "회사명",
      "sector": "섹터(반도체/바이오/방산 등)",
      "firm": "증권사명",
      "rating_change": "Buy 유지 / Buy→Hold / 신규 Buy 등",
      "target_price": { "prev": 85000, "new": 95000, "change_pct": 11.8 },
      "key_thesis": "핵심 투자 논거 (한 문장)",
      "report_url": "한경 컨센서스 항목의 URL을 그대로 복사 (없으면 null)",
      "importance": 8
    }
  ],
  "sector_sentiment": { "반도체": "긍정", "바이오": "중립" },
  "consensus_changes": 3,
  "confidence": 0.85
}

target_price가 불명확하면 null로 표기. findings는 정확히 3개.

${sections.join('\n\n')}`;
}

function _emptyResult(consensusItems = [], dartData = { reports: [] }) {
  return {
    findings: [], sector_sentiment: {}, consensus_changes: 0,
    alert_items: [], confidence: 0, model_used: null,
    consensus_raw: consensusItems,
    dart_reports: dartData?.reports ?? [],
    target_price_changes: [],
  };
}

// ── 전일 컨센서스 로드 (로컬 tf_results.json → gh-pages 폴백) ─────────────────
// GA 워크스페이스는 매 실행마다 새것이라 로컬에 어제 파일이 없을 수 있음.
// _loadPrevDayData() in layer-1-pipeline/index.js와 동일한 2단계 폴백 패턴.
async function _loadPrevConsensus(currentDate) {
  const outputDir = process.env.OUTPUT_DIR ?? './outputs';

  // 직전 거래일 날짜 후보: 최대 7일 전까지 역순으로 탐색
  for (let i = 1; i <= 7; i++) {
    const dt   = new Date(new Date(currentDate).getTime() - i * 86400000);
    const dstr = dt.toISOString().slice(0, 10);

    // 1차: 로컬 outputs/{prevDate}/tf_results.json
    try {
      const raw = await fs.readFile(
        path.join(outputDir, dstr, 'tf_results.json'),
        'utf-8'
      );
      const parsed = JSON.parse(raw);
      const prev   = parsed?.analyst?.consensus_raw ?? [];
      if (prev.length > 0) {
        logger.info(`[tf-analyst] 전일 컨센서스 로컬 로드 성공: ${dstr} (${prev.length}건)`);
        return prev;
      }
    } catch { /* 다음 시도 */ }

    // 2차: gh-pages 배포된 tf_results.json (GA 환경)
    const pagesBase = (process.env.PAGES_BASE_URL ?? '').replace(/\/$/, '');
    if (pagesBase) {
      try {
        const r = await axios.get(
          `${pagesBase}/outputs/${dstr}/tf_results.json`,
          { timeout: 10000 }
        );
        const prev = r.data?.analyst?.consensus_raw ?? [];
        if (prev.length > 0) {
          logger.info(`[tf-analyst] 전일 컨센서스 gh-pages 로드 성공: ${dstr} (${prev.length}건)`);
          return prev;
        }
      } catch { /* 다음 날짜 */ }
    }
  }

  logger.info('[tf-analyst] 전일 컨센서스 없음 — target_price_changes 빈 배열');
  return [];
}

// ── 목표주가 변동 비교 ─────────────────────────────────────────────────────────
// today/yesterday: 한경 컨센서스 raw 배열 (consensus_raw 형식)
// 의미 있는 변화 기준: 변동률 ≥ 5% 또는 가격 차이 ≥ 5,000원
// 신규 커버리지(어제 없던 종목) 포함. 변동률 절댓값 내림차순 정렬.
function _diffTargetPrices(today = [], yesterday = []) {
  const parsePrice = str => {
    if (str == null || str === '' || str === '-') return null;
    const n = parseFloat(String(str).replace(/,/g, '').replace(/[^0-9.]/g, ''));
    return isNaN(n) || n === 0 ? null : n;
  };

  // 어제 배열을 회사명+증권사 복합키 맵으로 인덱싱 (같은 회사를 여러 증권사가 커버)
  const prevMap = new Map();
  for (const item of yesterday) {
    const key = `${item.company ?? ''}|${item.firm ?? ''}`;
    if (!prevMap.has(key)) prevMap.set(key, item);
  }
  // 회사명만으로도 폴백 인덱스
  const prevByCompany = new Map();
  for (const item of yesterday) {
    if (item.company && !prevByCompany.has(item.company)) {
      prevByCompany.set(item.company, item);
    }
  }

  const changes = [];

  for (const cur of today) {
    const newPrice = parsePrice(cur.target_price);
    if (newPrice == null) continue;

    // 매칭: 회사+증권사 우선, 없으면 회사명만
    const key      = `${cur.company ?? ''}|${cur.firm ?? ''}`;
    const prevItem = prevMap.get(key) ?? prevByCompany.get(cur.company ?? '');

    if (!prevItem) {
      // 신규 커버리지 — 어제 목록에 없던 종목
      changes.push({
        company:    cur.company   ?? '',
        ticker:     cur.ticker    ?? '',
        prev_price: null,
        new_price:  String(cur.target_price).trim(),
        change_pct: null,
        firm:       cur.firm      ?? '',
        direction:  'new',
      });
      continue;
    }

    const prevPrice = parsePrice(prevItem.target_price);
    if (prevPrice == null) continue;
    if (prevPrice === newPrice) continue;

    const diff     = newPrice - prevPrice;
    const changePct = Math.round((diff / prevPrice) * 1000) / 10; // 소수점 1자리

    // 의미 있는 변화만 포함
    if (Math.abs(changePct) < 5 && Math.abs(diff) < 5000) continue;

    changes.push({
      company:    cur.company   ?? '',
      ticker:     cur.ticker    ?? '',
      prev_price: String(prevItem.target_price).trim(),
      new_price:  String(cur.target_price).trim(),
      change_pct: changePct,
      firm:       cur.firm      ?? '',
      direction:  diff > 0 ? 'up' : 'down',
    });
  }

  // 변동률 절댓값 내림차순 정렬 (신규 커버리지는 끝으로)
  changes.sort((a, b) => {
    if (a.direction === 'new' && b.direction !== 'new') return 1;
    if (a.direction !== 'new' && b.direction === 'new') return -1;
    return Math.abs(b.change_pct ?? 0) - Math.abs(a.change_pct ?? 0);
  });

  return changes;
}

// 단독 실행 (디버깅용): node tools/layer-2-research/tf-analyst/index.js --date 2026-05-12
// 2026-05-16: dart는 자체 수집하므로 data.json 불필요. news만 있으면 됨.
if (process.argv.includes('--date')) {
  import('dotenv/config').then(async () => {
    const idx  = process.argv.indexOf('--date');
    const date = process.argv[idx + 1] ?? new Date().toISOString().slice(0, 10);
    let news = [];
    try {
      const data = JSON.parse(await fs.readFile(
        path.join(process.env.OUTPUT_DIR ?? './outputs', date, 'data.json'), 'utf-8'
      ));
      news = data.news ?? [];
    } catch { /* news 없어도 동작 */ }
    const result = await runTFAnalyst(news, date);
    console.log(JSON.stringify(result, null, 2));
  });
}
