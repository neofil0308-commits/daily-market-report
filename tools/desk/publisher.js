// tools/desk/publisher.js — DESK 발행 에이전트
// Gmail·Notion·GitHub Pages 발행 통합 진입점.
// 중복 발송 방지: 로컬 sent.flag + GA Notion DB 이중 보호.
import fs from 'fs/promises';
import path from 'path';
import nodemailer from 'nodemailer';
import { publishToNotion, checkAlreadySent } from '../publishers/notion.js';
import { logger } from '../utils/logger.js';

/**
 * HTML 리포트 발행 (Gmail + Notion 아카이브).
 * @param {string} date       YYYY-MM-DD
 * @param {string} html       최종 HTML 문자열
 * @param {object} data       Layer 1 data.json (Notion 메타데이터용)
 * @param {string} outputDir  출력 폴더 경로
 */
export async function publish(date, html, data, outputDir) {
  // ── 중복 발송 방지 ─────────────────────────────────────────────────────────
  const sentFlag = path.join(outputDir, 'sent.flag');
  const localSent = await fs.access(sentFlag).then(() => true).catch(() => false);
  if (localSent) {
    logger.info(`[publisher] ${date} 이미 발송됨 (로컬 플래그) — 건너뜀`);
    return { skipped: true, reason: 'local_flag' };
  }

  if (process.env.GITHUB_ACTIONS === 'true') {
    if (await checkAlreadySent(date)) {
      logger.info(`[publisher] ${date} 이미 발송됨 (Notion 확인) — 건너뜀`);
      return { skipped: true, reason: 'notion_db' };
    }
  }

  // ── Gmail 발송 ─────────────────────────────────────────────────────────────
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.GMAIL_SENDER,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
  });

  await transporter.sendMail({
    from:    `"시장 리포트" <${process.env.GMAIL_SENDER}>`,
    to:      process.env.GMAIL_RECIPIENT,
    subject: `${date} 시장 리포트`,
    html,
  });
  logger.info(`[publisher] Gmail 발송 완료 → ${process.env.GMAIL_RECIPIENT}`);

  // 발송 플래그 기록
  await fs.writeFile(sentFlag, new Date().toISOString(), 'utf-8');

  // ── Notion 아카이브 ────────────────────────────────────────────────────────
  try {
    await publishToNotion(date, '', html, data);
    logger.info('[publisher] Notion 아카이브 완료');
  } catch (e) {
    logger.warn('[publisher] Notion 아카이브 실패 (발송은 완료):', e.message);
  }

  return { skipped: false, sentAt: new Date().toISOString() };
}
