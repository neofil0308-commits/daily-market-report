// tools/collectors/news.js
import axios from 'axios';
import { GoogleGenerativeAI } from '@google/generative-ai';

const NAVER_NEWS_URL = 'https://openapi.naver.com/v1/search/news.json';

// 업종·테마 기반 기본 쿼리 (특정 종목명 고정 없음)
const BASE_QUERIES = [
  { category: '시장전반',  query: '코스피 코스닥 증시 마감 동향' },
  { category: '시장전반',  query: '외국인 기관 순매수 주요종목' },
  { category: '산업·기업', query: '반도체 주가 실적 수출' },
  { category: '산업·기업', query: '2차전지 바이오 방산 조선 수주' },
  { category: '거시경제',  query: '연준 금리 환율 달러 인플레이션' },
];

/**
 * @param {string} reportDate - YYYY-MM-DD
 * @param {object} marketData - { overseas, fxRates } (선택, AI 키워드 생성에 활용)
 */
export async function collectNews(reportDate, marketData = {}) {
  const aiQueries = await getAiKeywords(reportDate, marketData);
  const allQueries = [...BASE_QUERIES, ...aiQueries];

  const headers = {
    'X-Naver-Client-Id':     process.env.NAVER_CLIENT_ID,
    'X-Naver-Client-Secret': process.env.NAVER_CLIENT_SECRET,
  };

  const cutoff = new Date(reportDate);
  cutoff.setHours(0, 0, 0, 0);

  const allItems = [];
  const seenUrls = new Set();

  await Promise.all(
    allQueries.map(async ({ category, query }) => {
      try {
        const res = await axios.get(NAVER_NEWS_URL, {
          headers,
          params: { query, display: 10, sort: 'date' },
          timeout: 10000,
        });

        const filtered = res.data.items
          .filter(item => new Date(item.pubDate) >= cutoff && !seenUrls.has(item.link))
          .slice(0, 3);

        filtered.forEach(item => {
          seenUrls.add(item.link);
          allItems.push({
            category,
            date:   new Date(item.pubDate).toISOString().slice(0, 10),
            title:  item.title.replace(/<[^>]+>/g, ''),
            source: extractSource(item.originallink),
            url:    item.originallink || item.link,
            body:   item.description.replace(/<[^>]+>/g, '').slice(0, 500),
          });
        });
      } catch (e) {
        console.warn(`[news] "${query}" 수집 실패:`, e.message);
      }
    })
  );

  return deduplicateSimilar(allItems);
}

// Gemini로 오늘의 추가 검색 키워드 2개 생성
async function getAiKeywords(reportDate, marketData) {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) return [];

  try {
    const { overseas, fxRates } = marketData;

    const spx    = overseas?.spx;
    const nasdaq = overseas?.nasdaq;
    const usdKrw = fxRates?.usdKrw;

    const contextLines = [];
    if (spx?.pct    != null) contextLines.push(`S&P500 ${spx.pct > 0 ? '+' : ''}${spx.pct?.toFixed(2)}%`);
    if (nasdaq?.pct != null) contextLines.push(`나스닥 ${nasdaq.pct > 0 ? '+' : ''}${nasdaq.pct?.toFixed(2)}%`);
    if (usdKrw?.today != null) contextLines.push(`원달러 ${usdKrw.today}원`);
    const context = contextLines.length ? contextLines.join(', ') : '시장 데이터 미수신';

    const prompt = `오늘은 ${reportDate}입니다. 한국 증시 일일 리포트용 뉴스를 수집합니다.
오늘 주요 시장 동향: ${context}

위 상황을 고려해 오늘 국내 주식시장 뉴스 수집에 가장 유용한 네이버 검색 키워드 2개를 추천하세요.
카테고리는 반드시 '시장전반', '산업·기업', '거시경제' 중 하나.
JSON 배열만 출력하세요 (설명 없이):
[{"category":"...","query":"..."},{"category":"...","query":"..."}]`;

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: process.env.GEMINI_MODEL ?? 'gemini-2.5-flash' });
    const result = await model.generateContent(prompt);
    const raw = result.response.text().replace(/^```json\s*/,'').replace(/```\s*$/,'').trim();
    const parsed = JSON.parse(raw);

    if (!Array.isArray(parsed)) return [];
    const valid = parsed.filter(q => q.category && q.query && typeof q.query === 'string');
    console.info(`[news] AI 키워드 ${valid.length}개 추가:`, valid.map(q => q.query).join(', '));
    return valid;
  } catch (e) {
    console.warn('[news] AI 키워드 생성 실패 (기본 쿼리만 사용):', e.message);
    return [];
  }
}

function extractSource(url) {
  const map = {
    'hankyung.com': '한국경제', 'mk.co.kr': '매일경제', 'chosun.com': '조선일보',
    'donga.com': '동아일보', 'joins.com': '중앙일보', 'fnnews.com': '파이낸셜뉴스',
    'newspim.com': '뉴스핌', 'etoday.co.kr': '이투데이', 'seoul.co.kr': '서울신문',
    'hani.co.kr': '한겨레', 'khan.co.kr': '경향신문',
  };
  try {
    const host = new URL(url).hostname.replace('www.', '');
    return Object.entries(map).find(([k]) => host.includes(k))?.[1] ?? host;
  } catch { return '출처미상'; }
}

function deduplicateSimilar(items) {
  const seen = new Set();
  return items.filter(item => {
    const key = `${item.category}:${item.title.slice(0, 15)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
