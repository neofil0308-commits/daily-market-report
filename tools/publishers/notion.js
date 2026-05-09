// tools/publishers/notion.js — 일별 리포트 아카이빙 (데이터베이스)
import { Client } from '@notionhq/client';
import { logger } from '../utils/logger.js';

const notion = new Client({ auth: process.env.NOTION_API_KEY });

export async function publishToNotion(date, summaryMd, reportHtml, data) {
  const dbId = process.env.NOTION_ARCHIVE_DB_ID;
  if (!dbId) {
    logger.warn('[notion] NOTION_ARCHIVE_DB_ID 미설정 — 아카이빙 건너뜀');
    return;
  }

  const kospi      = data.domestic?.kospi;
  const isHoliday  = data.meta?.krHoliday ?? false;
  const kospiStr   = kospi?.today != null
    ? `${kospi.today.toFixed(2)} ${(kospi.diff ?? 0) >= 0 ? '▲' : '▼'}${Math.abs(kospi.diff ?? 0).toFixed(2)} (${(kospi.pct ?? 0).toFixed(2)}%)`
    : 'N/A';

  const title = isHoliday
    ? `📊 [${date}] 시장 리포트 — 국내 휴장`
    : `📊 [${date}] 시장 리포트 — KOSPI ${kospiStr}`;

  const pagesBase = (process.env.PAGES_BASE_URL ?? '').replace(/\/$/, '');
  const htmlUrl   = pagesBase ? `${pagesBase}/outputs/${date}/report.html` : null;

  // Notion 페이지 본문: HTML 링크 + 마크다운 요약
  const children = [];
  if (htmlUrl) {
    children.push(
      {
        type: 'paragraph',
        paragraph: {
          rich_text: [
            { type: 'text', text: { content: '🔗 HTML 리포트 전체 보기: ' } },
            { type: 'text', text: { content: htmlUrl, link: { url: htmlUrl } }, annotations: { color: 'blue', bold: true } },
          ],
        },
      },
      { type: 'divider', divider: {} }
    );
  }
  children.push(...markdownToNotionBlocks(summaryMd));

  await notion.pages.create({
    parent: { database_id: dbId },
    properties: {
      '리포트 제목': { title: [{ text: { content: title } }] },
      '날짜':        { date: { start: date } },
      '상태':        { select: { name: isHoliday ? '휴장' : '발송완료' } },
      'KOSPI':       { rich_text: [{ text: { content: kospiStr } }] },
      ...(htmlUrl ? { 'HTML 링크': { url: htmlUrl } } : {}),
    },
    // Notion API: 한 번에 최대 100개 블록
    children: children.slice(0, 100).length > 0
      ? children.slice(0, 100)
      : [{ type: 'paragraph', paragraph: { rich_text: [{ text: { content: '(요약 없음)' } }] } }],
  });

  logger.info('[notion] 아카이브 완료 →', title);
}

function markdownToNotionBlocks(md) {
  if (!md) return [];
  return md.split('\n').filter(l => l.trim()).map(line => {
    if (/^### /.test(line)) return { type: 'heading_3', heading_3: { rich_text: [{ text: { content: line.slice(4) } }] } };
    if (/^## /.test(line))  return { type: 'heading_2', heading_2: { rich_text: [{ text: { content: line.slice(3) } }] } };
    if (/^# /.test(line))   return { type: 'heading_1', heading_1: { rich_text: [{ text: { content: line.slice(2) } }] } };
    if (/^[-*] /.test(line)) return { type: 'bulleted_list_item', bulleted_list_item: { rich_text: [{ text: { content: line.slice(2) } }] } };
    return { type: 'paragraph', paragraph: { rich_text: [{ text: { content: line } }] } };
  });
}
