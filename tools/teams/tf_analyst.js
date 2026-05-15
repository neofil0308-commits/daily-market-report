// tools/teams/tf_analyst.js — TF-2 애널리스트 리포트 분석팀
// 뉴스 + 한경컨센서스 + DART 공시 → 주목할 애널리스트 리포트 3개 선정
import axios from 'axios';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { logger } from '../utils/logger.js';
import { geminiWithRetry } from '../utils/gemini_retry.js';

/**
 * TF-2: 애널리스트 리포트 분석 실행.
 * @param {object} dartData  Layer 1 dart_feed 결과
 * @param {Array}  newsData  수집된 뉴스 목록 (선택)
 * @returns {Promise<TFAnalystResult>}
 */
export async function runTFAnalyst(dartData, newsData = []) {
  // ⭐ 한경 컨센서스를 가장 먼저 수집 — Gemini가 실패해도 orchestrator가 raw로 폴백할 수 있도록.
  //   (DART는 사실상 빈 응답이므로 한경이 1차 소스다.)
  const consensusItems = await fetchHankyungConsensus();

  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    logger.warn('[tf-analyst] GOOGLE_API_KEY 미설정 — 분석 생략');
    return _emptyResult(consensusItems);
  }

  // 뉴스에서 애널리스트 관련 기사 필터
  const analystNews = (newsData ?? []).filter(n =>
    /목표주가|목표가|투자의견|증권사|리포트|매수|매도|Buy|Hold|Sell|상향|하향|컨센서스|TP |BUY|HOLD/.test(
      (n.title ?? '') + ' ' + (n.body ?? '')
    )
  );

  const hasDart     = dartData?.reports?.length > 0;
  const hasNews     = analystNews.length > 0;
  const hasConsensus = consensusItems.length > 0;

  if (!hasDart && !hasNews && !hasConsensus) {
    logger.info('[tf-analyst] 분석 소스 없음 — 건너뜀');
    return _emptyResult(consensusItems);
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

    return {
      findings:          parsed.findings          ?? [],
      sector_sentiment:  parsed.sector_sentiment  ?? {},
      consensus_changes: parsed.consensus_changes ?? 0,
      alert_items:       (parsed.findings ?? []).filter(f => f.importance >= 8),
      confidence:        parsed.confidence        ?? 0.8,
      model_used:        modelName,
      consensus_raw:     consensusItems,
    };
  } catch (e) {
    logger.warn('[tf-analyst] 분석 실패:', e.message);
    return _emptyResult(consensusItems);
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

function _emptyResult(consensusItems = []) {
  return {
    findings: [], sector_sentiment: {}, consensus_changes: 0,
    alert_items: [], confidence: 0, model_used: null,
    consensus_raw: consensusItems,
  };
}

// 단독 실행 (디버깅용): node tools/teams/tf_analyst.js --date 2026-05-12
if (process.argv.includes('--date')) {
  import('dotenv/config').then(async () => {
    const fs   = await import('fs/promises');
    const path = await import('path');
    const idx  = process.argv.indexOf('--date');
    const date = process.argv[idx + 1] ?? new Date().toISOString().slice(0, 10);
    const data = JSON.parse(await fs.default.readFile(
      path.default.join(process.env.OUTPUT_DIR ?? './outputs', date, 'data.json'), 'utf-8'
    ));
    const result = await runTFAnalyst(data.dart ?? { reports: [] });
    console.log(JSON.stringify(result, null, 2));
  });
}
