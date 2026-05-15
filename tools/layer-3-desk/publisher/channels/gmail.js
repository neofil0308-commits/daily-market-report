// tools/publishers/gmail.js
import nodemailer from 'nodemailer';
import { logger } from '../../../shared/utils/logger.js';

export async function publishToGmail(date, summaryMd, reportHtml, data) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.GMAIL_SENDER,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
  });

  const kospi  = data.domestic.kospi  ?? {};
  const kosdaq = data.domestic.kosdaq ?? {};
  const arrow  = v => (v ?? 0) >= 0 ? '▲' : '▼';

  // 제목 라인: KOSPI 수치 포함
  const subject = `📊 [${date}] 시장 리포트 — KOSPI ${kospi.today?.toFixed(2) ?? 'N/A'} ${arrow(kospi.diff)}${Math.abs(kospi.diff ?? 0).toFixed(2)}(${kospi.pct?.toFixed(2) ?? 'N/A'}%)`;

  // CSS 변수 안전망: Notion 전용 변수가 이메일 환경에서 undefined가 되는 것을 방지
  const cssVarFallback = `
<style>
  :root {
    --color-text-primary:         #1a1a1a;
    --color-text-secondary:       #666666;
    --color-text-tertiary:        #999999;
    --color-text-info:            #2563eb;
    --color-text-success:         #16a34a;
    --color-text-warning:         #d97706;
    --color-background-secondary: #f8f8f8;
    --color-background-info:      #eff6ff;
    --color-background-success:   #f0fdf4;
    --color-background-warning:   #fffbeb;
    --color-border-secondary:     #e0e0e0;
    --color-border-tertiary:      #ebebeb;
    --border-radius-md:           8px;
  }
</style>`;

  // HTML 본문: CSS 안전망 → 리포트 위젯 → Notion 링크
  const htmlBody = `
<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${subject}</title>
  ${cssVarFallback}
</head>
<body style="margin:0; padding:20px; background:#f5f5f5; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;">

  <!-- 리포트 위젯 -->
  ${reportHtml}

  <!-- Notion 링크 -->
  <div style="margin-top:24px; padding:16px; background:#fff; border-radius:8px; text-align:center;">
    <a href="https://notion.so/${(process.env.NOTION_PAGE_ID ?? '').replace(/-/g, '')}"
       style="color:#4361ee; text-decoration:none; font-size:14px;">
      📝 Notion에서 전체 보기
    </a>
  </div>

</body>
</html>
`;

  await transporter.sendMail({
    from:    `"시장 리포트" <${process.env.GMAIL_SENDER}>`,
    to:      process.env.GMAIL_RECIPIENT,
    subject,
    html:    htmlBody,
  });

  logger.info(`[gmail] 발송 완료 → ${process.env.GMAIL_RECIPIENT}`);
}
