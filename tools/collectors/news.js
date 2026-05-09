// tools/collectors/news.js
import axios from 'axios';

const NAVER_NEWS_URL = 'https://openapi.naver.com/v1/search/news.json';

const QUERIES = [
  { category: '시장전반',  query: '코스피 코스닥 증시 마감 시장 동향' },
  { category: '산업·기업', query: '삼성전자 SK하이닉스 반도체 기업 실적 주가' },
  { category: '산업·기업', query: 'HD현대 한화에어로스페이스 전력기기 조선 방산 수주' },
  { category: '거시경제',  query: '연준 금리 환율 달러 WTI 인플레이션 거시경제' },
];

export async function collectNews(reportDate) {
  const headers = {
    'X-Naver-Client-Id':     process.env.NAVER_CLIENT_ID,
    'X-Naver-Client-Secret': process.env.NAVER_CLIENT_SECRET,
  };

  const cutoff = new Date(reportDate);
  cutoff.setHours(0, 0, 0, 0);

  const allItems = [];
  const seenUrls = new Set();

  await Promise.all(
    QUERIES.map(async ({ category, query }) => {
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
        console.warn(`[news] ${category} 수집 실패:`, e.message);
      }
    })
  );

  return deduplicateSimilar(allItems);
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
