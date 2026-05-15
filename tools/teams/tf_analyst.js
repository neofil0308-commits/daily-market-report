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
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    logger.warn('[tf-analyst] GOOGLE_API_KEY 미설정 — 분석 생략');
    return _emptyResult();
  }

  // 뉴스에서 애널리스트 관련 기사 필터
  const analystNews = (newsData ?? []).filter(n =>
    /목표주가|목표가|투자의견|증권사|리포트|매수|매도|Buy|Hold|Sell|상향|하향|컨센서스|TP |BUY|HOLD/.test(
      (n.title ?? '') + ' ' + (n.body ?? '')
    )
  );

  // 한경 컨센서스 스크래핑
  const consensusItems = await fetchHankyungConsensus();

  const hasDart     = dartData?.reports?.length > 0;
  const hasNews     = analystNews.length > 0;
  const hasConsensus = consensusItems.length > 0;

  if (!hasDart && !hasNews && !hasConsensus) {
    logger.info('[tf-analyst] 분석 소스 없음 — 건너뜀');
    return _emptyResult();
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
    };
  } catch (e) {
    logger.warn('[tf-analyst] 분석 실패:', e.message);
    return _emptyResult();
  }
}

// 한경 컨센서스 최근 리포트 스크래핑
async function fetchHankyungConsensus() {
  try {
    const today = new Date(Date.now() + 9 * 60 * 60 * 1000);
    const sdate = new Date(today);
    sdate.setDate(sdate.getDate() - 3);
    const fmt = d => d.toISOString().slice(0, 10).replace(/-/g, '');

    const res = await axios.get(
      'https://consensus.hankyung.com/apps.analysis/analysis.list',
      {
        params: { pagenum: 1, sdate: fmt(sdate), edate: fmt(today), category: 'CO', report_type: '' },
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          Referer: 'https://consensus.hankyung.com/',
        },
        timeout: 12000,
      }
    );

    const { load } = await import('cheerio');
    const $ = load(res.data);
    const items = [];

    // 한경 컨센서스 리포트 테이블 파싱
    $('ul.analysis_list li, table.type_1 tbody tr, .report_list li').each((_, el) => {
      const titleEl = $(el).find('a.subject, .subject a, td.col_tit a').first();
      const title   = titleEl.text().trim();
      const url     = titleEl.attr('href') ?? '';
      const firm    = $(el).find('.company, .col_company, td:nth-child(4)').first().text().trim();
      const company = $(el).find('.stock_nm, .col_stock, td:nth-child(2)').first().text().trim();
      const date    = $(el).find('.date, .col_date, td:nth-child(6)').first().text().trim();

      if (title && title.length > 4) {
        items.push({ title, firm, company, date, url: url.startsWith('http') ? url : `https://consensus.hankyung.com${url}` });
      }
    });

    if (items.length > 0) logger.info(`[tf-analyst] 한경 컨센서스 ${items.length}건 수집`);
    return items.slice(0, 20);
  } catch (e) {
    logger.warn('[tf-analyst] 한경 컨센서스 수집 실패:', e.message);
    return [];
  }
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
    sections.push(`## 한경 컨센서스 최근 리포트 (${consensusItems.length}건)\n${consensusItems.map(c => `- ${c.company ?? ''} | ${c.firm ?? ''} | ${c.title}`).join('\n')}`);
  }

  return `당신은 한국 주식 시장 애널리스트 리포트 큐레이터입니다.

아래 데이터를 바탕으로 오늘 주목할 만한 애널리스트 리포트 3개를 선정하세요.
선정 기준: 목표주가 변동 폭이 크거나, 투자의견 변경, 또는 시장에서 화제가 될 이슈.

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

function _emptyResult() {
  return {
    findings: [], sector_sentiment: {}, consensus_changes: 0,
    alert_items: [], confidence: 0, model_used: null,
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
