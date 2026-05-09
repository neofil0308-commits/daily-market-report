// tools/publishers/slack.js
import axios from 'axios';
import { logger } from '../utils/logger.js';

export async function publishToSlack(date, data, summaryMd) {
  const kospi  = data.domestic.kospi  ?? {};
  const kosdaq = data.domestic.kosdaq ?? {};
  const arrow  = v => (v ?? 0) >= 0 ? '▲' : '▼';

  const message = {
    text: `📊 *일일 시장 리포트 — ${date}*`,
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: `📊 일일 시장 리포트 — ${date}` },
      },
      {
        type: 'section',
        fields: [
          {
            type: 'mrkdwn',
            text: `*KOSPI*\n${kospi.today?.toFixed(2) ?? 'N/A'} ${arrow(kospi.diff)} ${Math.abs(kospi.diff ?? 0).toFixed(2)} (${kospi.pct?.toFixed(2) ?? 'N/A'}%)`,
          },
          {
            type: 'mrkdwn',
            text: `*KOSDAQ*\n${kosdaq.today?.toFixed(2) ?? 'N/A'} ${arrow(kosdaq.diff)} ${Math.abs(kosdaq.diff ?? 0).toFixed(2)} (${kosdaq.pct?.toFixed(2) ?? 'N/A'}%)`,
          },
        ],
      },
      { type: 'divider' },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: summaryMd.slice(0, 2800),
        },
      },
      {
        type: 'actions',
        elements: [{
          type: 'button',
          text: { type: 'plain_text', text: 'Notion에서 전체 보기' },
          url: `https://notion.so/${(process.env.NOTION_PAGE_ID ?? '').replace(/-/g, '')}`,
        }],
      },
    ],
  };

  await axios.post(process.env.SLACK_WEBHOOK_URL, message);
  logger.info('[slack] 알림 발송 완료');
}
