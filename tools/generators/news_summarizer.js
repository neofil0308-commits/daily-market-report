// tools/generators/news_summarizer.js
import { GoogleGenerativeAI } from '@google/generative-ai';
import { geminiWithRetry } from '../utils/gemini_retry.js';

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);

export async function summarizeNews(newsItems, reportDate) {
  const model = genAI.getGenerativeModel({ model: process.env.GEMINI_MODEL });

  const prompt = `
다음은 ${reportDate} 기준으로 수집된 금융 뉴스 목록입니다.
각 뉴스를 아래 마크다운 형식으로 섹션별 요약을 작성해주세요.

## 출력 규칙
1. 섹션: 🏛️ 시장 전반 / 💻 기업·산업 / 🌐 거시경제·지표
2. 각 기사: **[제목](URL)** — 출처 / 불릿 3~5개 요약
3. 유사 기사는 대표 1건만 포함
4. 불릿에 핵심 수치와 맥락을 포함하여 간결하게 작성

## 뉴스 목록
${JSON.stringify(newsItems, null, 2)}

## 마크다운 형식 예시
## 📰 오늘의 주요 뉴스 요약
> 기준: ${reportDate} 오전 07:00 KST

---

### 🏛️ 시장 전반
**[제목](URL)** — 출처
- 핵심 내용 1
- 핵심 내용 2

---

### 💻 기업·산업
...

---

### 🌐 거시경제·지표
...
`;

  const result = await geminiWithRetry(() => model.generateContent(prompt));
  return result.response.text();
}
