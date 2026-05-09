// tools/generators/report_generator.js
import { GoogleGenerativeAI } from '@google/generative-ai';
import { geminiWithRetry } from '../utils/gemini_retry.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { formatPts, formatUsd, formatKrw, formatChgCell } from '../utils/formatter.js';

const genAI    = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 뉴스 요약 + HTML 리포트를 Gemini 1회 호출로 생성
 * @returns {{ newsSummaryMd: string, reportHtml: string }}
 */
export async function generateReport(data, reportDate) {
  const systemPrompt = await fs.readFile(
    path.join(__dirname, '../../templates/report_prompt.txt'),
    'utf-8'
  );

  const dataBlock = buildDataBlock(data);

  const userPrompt = `
오늘(${reportDate}) 기준 시장 데이터와 뉴스 목록을 사용하여 아래 두 섹션을 순서대로 출력하세요.

━━━━━━━━━━━━━━━━━━━━━━━━
출력 형식 (반드시 이 구분자를 정확히 사용)
━━━━━━━━━━━━━━━━━━━━━━━━

===SUMMARY===
(여기에 뉴스 마크다운 요약)
===HTML===
(여기에 HTML 리포트)

━━━━━━━━━━━━━━━━━━━━━━━━
뉴스 요약 규칙
━━━━━━━━━━━━━━━━━━━━━━━━
1. 섹션: 🏛️ 시장 전반 / 💻 기업·산업 / 🌐 거시경제·지표
2. 각 기사: **[제목](URL)** — 출처 / 불릿 3~5개 요약
3. 유사 기사는 대표 1건만 포함
4. 불릿에 핵심 수치와 맥락을 포함

━━━━━━━━━━━━━━━━━━━━━━━━
HTML 리포트 규칙
━━━━━━━━━━━━━━━━━━━━━━━━
- 완전한 HTML 코드만 출력 (<!DOCTYPE> 없이 <style>부터 시작)
- v5 스타일 일관 적용 (Inter 폰트, CSS 변수 컬러 시스템)
- 뉴스 요약 → HTML 뉴스 섹션으로 배치
- 모든 수치 표기 규칙 준수 (원화 정수, 외화 소수점 둘째 자리)
- Chart.js 이중축 차트 포함 (KOSPI 종가 꺾은선 + 거래대금 막대)

━━━━━━━━━━━━━━━━━━━━━━━━
시장 데이터
━━━━━━━━━━━━━━━━━━━━━━━━
${dataBlock}
`;

  const model = genAI.getGenerativeModel({
    model:             process.env.GEMINI_MODEL,
    systemInstruction: systemPrompt,
  });

  const result = await geminiWithRetry(() => model.generateContent(userPrompt));
  const raw    = result.response.text();

  return parseOutput(raw);
}

function parseOutput(raw) {
  const summaryMatch = raw.match(/===SUMMARY===([\s\S]*?)===HTML===/);
  const htmlMatch    = raw.match(/===HTML===([\s\S]*?)$/);

  const newsSummaryMd = summaryMatch?.[1]?.trim() ?? '';
  let   reportHtml    = htmlMatch?.[1]?.trim()    ?? raw;

  // Gemini가 가끔 ```html ... ``` 코드블록으로 감싸는 경우 벗겨내기
  reportHtml = reportHtml.replace(/^```html\s*/i, '').replace(/\s*```$/, '');

  return { newsSummaryMd, reportHtml };
}

function buildDataBlock(data) {
  const { domestic, overseas, fxRates, commodities, news } = data;
  const d = domestic;

  const historyBlock = (d.kospiHistory ?? []).length > 0
    ? d.kospiHistory.map(h =>
        `  ${h.date}: 종가 ${formatPts(h.close)}, 거래대금 ${h.volumeBn?.toFixed(2) ?? 'N/A'}조원`
      ).join('\n')
    : '  (이력 데이터 없음)';

  return `
[국내 증시]
KOSPI: ${formatPts(d.kospi?.today)} / 전일 ${formatPts(d.kospi?.prev)} / 변동 ${formatChgCell(d.kospi ?? {})}
KOSDAQ: ${formatPts(d.kosdaq?.today)} / 전일 ${formatPts(d.kosdaq?.prev)} / 변동 ${formatChgCell(d.kosdaq ?? {})}
VKOSPI(공포지수): ${formatPts(d.vkospi?.today) ?? 'N/A'} / 전일 ${formatPts(d.vkospi?.prev) ?? 'N/A'}
거래대금: N/A
수급(단위: 억원): 외국인 ${formatKrw(d.supply?.foreign) ?? 'N/A'}, 기관 ${formatKrw(d.supply?.institution) ?? 'N/A'}, 개인 ${formatKrw(d.supply?.individual) ?? 'N/A'}

[KOSPI 5거래일 이력 - Chart.js 이중축 차트용]
labels 순서: 오래된 날짜 → 최근 날짜
${historyBlock}

[해외 증시]
다우: ${formatPts(overseas.dow?.today)} / ${formatChgCell(overseas.dow ?? {})}
S&P500: ${formatPts(overseas.sp500?.today)} / ${formatChgCell(overseas.sp500 ?? {})}
나스닥: ${formatPts(overseas.nasdaq?.today)} / ${formatChgCell(overseas.nasdaq ?? {})}
SOX: ${formatPts(overseas.sox?.today)} / ${formatChgCell(overseas.sox ?? {})}
닛케이: ${formatPts(overseas.nikkei?.today)} / ${formatChgCell(overseas.nikkei ?? {})}
DAX: ${formatPts(overseas.dax?.today)} / ${formatChgCell(overseas.dax ?? {})}
항셍: ${formatPts(overseas.hsi?.today)} / ${formatChgCell(overseas.hsi ?? {})}

[환율·금리]
달러원: ${fxRates.usdKrw.today?.toFixed(2) ?? 'N/A'}원 / 전일 ${fxRates.usdKrw.prev?.toFixed(2) ?? 'N/A'}원
DXY: ${fxRates.dxy.today?.toFixed(2) ?? 'N/A'} / 전일 ${fxRates.dxy.prev?.toFixed(2) ?? 'N/A'}
미10년: ${fxRates.us10y.today?.toFixed(2) ?? 'N/A'}% / 전일 ${fxRates.us10y.prev?.toFixed(2) ?? 'N/A'}%
미2년: ${fxRates.us2y.today?.toFixed(2) ?? 'N/A'}% / 전일 ${fxRates.us2y.prev?.toFixed(2) ?? 'N/A'}%
6월FOMC동결: ${fxRates.fomc.junHoldPct?.toFixed(2) ?? 'N/A'}%
9월인하가능성: ${fxRates.fomc.sepCutPct?.toFixed(2) ?? 'N/A'}%

[원자재]
금(국제): ${formatUsd(commodities.gold?.today)} / 전일 ${formatUsd(commodities.gold?.prev)}
금(국내1돈): ${commodities.goldKrw?.today?.toLocaleString() ?? 'N/A'}원 / 전일 ${commodities.goldKrw?.prev?.toLocaleString() ?? 'N/A'}원
은: ${formatUsd(commodities.silver?.today)} / 전일 ${formatUsd(commodities.silver?.prev)}
백금: ${formatUsd(commodities.platinum?.today)} / 전일 ${formatUsd(commodities.platinum?.prev)}
WTI: ${formatUsd(commodities.wti?.today)} / 전일 ${formatUsd(commodities.wti?.prev)}
구리: ${formatUsd(commodities.copper?.today)} / 전일 ${formatUsd(commodities.copper?.prev)}
알루미늄: ${formatUsd(commodities.aluminum?.today)} / 전일 ${formatUsd(commodities.aluminum?.prev)}
아연: ${formatUsd(commodities.zinc?.today)} / 전일 ${formatUsd(commodities.zinc?.prev)}

[뉴스 목록]
${JSON.stringify(news, null, 2)}
  `;
}
