// tools/desk/publisher.js — DESK 발행 에이전트
// Gmail·Notion·GitHub Pages 발행 통합 진입점.
// 중복 발송 방지: 로컬 sent.flag + GA Notion DB 이중 보호.
import fs from 'fs/promises';
import path from 'path';
import nodemailer from 'nodemailer';
import { publishToNotion, checkAlreadySent } from './channels/notion.js';
import { buildEmailCard } from '../design/index.js';
import { logger } from '../../shared/utils/logger.js';

/**
 * HTML 리포트 발행 (Gmail + Notion 아카이브).
 * @param {string} date       YYYY-MM-DD
 * @param {string} html       최종 HTML 문자열
 * @param {object} data       Layer 1 data.json (Notion 메타데이터용)
 * @param {string} outputDir  출력 폴더 경로
 * @param {string} reportUrl  GitHub Pages 전체 리포트 URL
 */
export async function publish(date, html, data, outputDir, reportUrl = '', tfResults = {}, editorialPlan = {}) {
  // ── 단계별 발송 플래그 ──────────────────────────────────────────────────────
  // 메일·노션을 따로 도장찍는 이유: 둘 중 하나만 실패해도 성공한 쪽은 재시도하지 않도록.
  //   gmail.flag  — Gmail 발송 완료 (있으면 메일 재발송 금지)
  //   notion.flag — Notion 아카이브 완료 (있으면 노션 재기록 금지)
  //   sent.flag   — 둘 다 완료 (전체 스킵 조건, 하위호환)
  const sentFlag   = path.join(outputDir, 'sent.flag');
  const gmailFlag  = path.join(outputDir, 'gmail.flag');
  const notionFlag = path.join(outputDir, 'notion.flag');

  const has = async p => fs.access(p).then(() => true).catch(() => false);
  let [allDone, gmailDone, notionDone] = await Promise.all([has(sentFlag), has(gmailFlag), has(notionFlag)]);

  if (allDone) {
    logger.info(`[publisher] ${date} 이미 발송·아카이브 완료 (sent.flag) — 건너뜀`);
    return { skipped: true, reason: 'local_flag' };
  }

  // GA 환경에서는 워크스페이스가 매번 새것이라 로컬 flag가 없을 수 있다 → Notion DB로 보강 체크
  if (process.env.GITHUB_ACTIONS === 'true' && !gmailDone) {
    if (await checkAlreadySent(date)) {
      // Notion에는 이미 있으니 Gmail도 발송됐다고 간주 (이중 발송 방지)
      logger.info(`[publisher] ${date} Notion DB에 등록됨 — Gmail 발송 건너뜀`);
      gmailDone = true; notionDone = true;
      await fs.writeFile(sentFlag, new Date().toISOString(), 'utf-8');
      return { skipped: true, reason: 'notion_db' };
    }
  }

  // ── Gmail 발송 (gmail.flag 없을 때만) ──────────────────────────────────────
  if (!gmailDone) {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.GMAIL_SENDER, pass: process.env.GMAIL_APP_PASSWORD },
    });
    await transporter.sendMail({
      from:    `"시장 리포트" <${process.env.GMAIL_SENDER}>`,
      to:      process.env.GMAIL_RECIPIENT,
      subject: `${date} 시장 리포트`,
      html: buildEmailCard(data, tfResults, editorialPlan, reportUrl),
    });
    await fs.writeFile(gmailFlag, new Date().toISOString(), 'utf-8');
    gmailDone = true;
    logger.info(`[publisher] Gmail 발송 완료 → ${process.env.GMAIL_RECIPIENT}`);
  } else {
    logger.info('[publisher] Gmail 이미 발송됨 (gmail.flag) — 재발송 건너뜀');
  }

  // ── Notion 아카이브 (notion.flag 없을 때만) ───────────────────────────────
  if (!notionDone) {
    try {
      await publishToNotion(date, '', html, data);
      await fs.writeFile(notionFlag, new Date().toISOString(), 'utf-8');
      notionDone = true;
      logger.info('[publisher] Notion 아카이브 완료');
    } catch (e) {
      logger.warn('[publisher] Notion 아카이브 실패 (Gmail은 완료, 다음 실행에서 Notion만 재시도):', e.message);
    }
  } else {
    logger.info('[publisher] Notion 이미 아카이브됨 (notion.flag) — 재기록 건너뜀');
  }

  // 둘 다 끝났을 때만 통합 sent.flag 작성
  if (gmailDone && notionDone) {
    await fs.writeFile(sentFlag, new Date().toISOString(), 'utf-8');
  }

  return {
    skipped: false,
    sentAt: new Date().toISOString(),
    gmailSent: gmailDone,
    notionArchived: notionDone,
  };
}
