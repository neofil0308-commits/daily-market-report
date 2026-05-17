// tools/desk/publisher.js — DESK 발행 에이전트
// Gmail·Notion·GitHub Pages 발행 통합 진입점.
// 중복 발송 방지: 로컬 sent.flag + GA Notion DB 이중 보호.
// 실패 알림: failures.json 누적 + 다음 정상 발송 메일 제목 prefix.
import fs from 'fs/promises';
import path from 'path';
import nodemailer from 'nodemailer';
import { publishToNotion, checkAlreadySent } from './channels/notion.js';
import { buildEmailCard } from '../design/index.js';
import { logger } from '../../shared/utils/logger.js';

// ── 실패 알림 헬퍼 ────────────────────────────────────────────────────────────

/**
 * 실패 이벤트를 outputs/{date}/failures.json에 누적 기록한다.
 * @param {string} outputDir  출력 폴더 경로 (outputs/{date}/)
 * @param {'gmail'|'notion'} channel  실패한 채널
 * @param {string} errorMsg   오류 메시지
 */
async function _recordFailure(outputDir, channel, errorMsg) {
  const failurePath = path.join(outputDir, 'failures.json');
  let existing = [];
  try {
    const raw = await fs.readFile(failurePath, 'utf-8');
    existing = JSON.parse(raw);
  } catch {
    // 파일이 없거나 파싱 실패 → 새로 시작
  }
  existing.push({ ts: new Date().toISOString(), channel, error: errorMsg });
  await fs.writeFile(failurePath, JSON.stringify(existing, null, 2), 'utf-8');
  logger.warn(`[publisher] 실패 기록 → failures.json (channel=${channel}, total=${existing.length}건)`);
}

/**
 * 직전 날짜 폴더의 failures.json을 읽어 미처리 실패 이벤트를 반환한다.
 * consumed.failures.json으로 이름이 바뀐 경우 이미 처리된 것으로 간주하고 빈 배열 반환.
 * @param {string} outputDir  오늘 출력 폴더 경로 (outputs/{date}/)
 * @returns {Promise<Array<{ts:string,channel:string,error:string}>>}
 */
async function _loadPreviousFailures(outputDir) {
  try {
    // outputDir 예: /path/to/outputs/2026-05-16
    // 상위 폴더(outputs/)를 구해 날짜 목록 중 가장 최근 폴더를 찾는다.
    const outputsRoot = path.dirname(outputDir);
    let entries;
    try {
      entries = await fs.readdir(outputsRoot);
    } catch {
      return [];
    }
    // YYYY-MM-DD 형식 폴더만 필터, 오늘 폴더 제외, 내림차순 정렬
    const todayDir = path.basename(outputDir);
    const dateDirs = entries
      .filter(e => /^\d{4}-\d{2}-\d{2}$/.test(e) && e !== todayDir)
      .sort()
      .reverse();

    if (!dateDirs.length) return [];

    const prevDir = path.join(outputsRoot, dateDirs[0]);
    const failurePath = path.join(prevDir, 'failures.json');
    const consumedPath = path.join(prevDir, 'consumed.failures.json');

    // 이미 처리된 경우
    try {
      await fs.access(consumedPath);
      return []; // consumed → 이미 prefix 적용됨
    } catch { /* 없으면 계속 */ }

    // failures.json 읽기
    try {
      const raw = await fs.readFile(failurePath, 'utf-8');
      return JSON.parse(raw);
    } catch {
      return [];
    }
  } catch {
    return [];
  }
}

/**
 * 직전 날짜 failures.json을 consumed.failures.json으로 이름 변경해 "처리됨" 표시.
 * 다음 실행에서 중복 prefix가 붙지 않도록 한다.
 * @param {string} outputDir  오늘 출력 폴더 경로
 */
async function _markPreviousFailuresConsumed(outputDir) {
  try {
    const outputsRoot = path.dirname(outputDir);
    let entries;
    try {
      entries = await fs.readdir(outputsRoot);
    } catch { return; }

    const todayDir = path.basename(outputDir);
    const dateDirs = entries
      .filter(e => /^\d{4}-\d{2}-\d{2}$/.test(e) && e !== todayDir)
      .sort()
      .reverse();

    if (!dateDirs.length) return;

    const prevDir = path.join(outputsRoot, dateDirs[0]);
    const failurePath = path.join(prevDir, 'failures.json');
    const consumedPath = path.join(prevDir, 'consumed.failures.json');

    try {
      await fs.rename(failurePath, consumedPath);
      logger.info(`[publisher] 이전 failures.json → consumed.failures.json (${dateDirs[0]})`);
    } catch { /* 파일이 없으면 무시 */ }
  } catch { /* 안전하게 무시 */ }
}

/**
 * HTML 리포트 발행 (Gmail + Notion 아카이브).
 * @param {string} date       YYYY-MM-DD
 * @param {string} html       최종 HTML 문자열
 * @param {object} data       Layer 1 data.json (Notion 메타데이터용)
 * @param {string} outputDir  출력 폴더 경로
 * @param {string} reportUrl  GitHub Pages 전체 리포트 URL
 * @param {object} tfResults  Layer 2 TF 분석 결과 (메일 카드용)
 * @param {object} editorialPlan  편집 계획 (섹션 Summary 등)
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

  // ── 이전 실패 기록 로드 → 메일 제목 prefix 결정 ──────────────────────────
  // "어제 또는 직전 실행"에서 failures.json이 남아 있으면 사주에게 알린다.
  const prevFailures = await _loadPreviousFailures(outputDir);
  const subjectPrefix = prevFailures.length
    ? `[⚠ 이전 실패 ${prevFailures.length}건] `
    : '';
  const subject = `${subjectPrefix}${date} 시장 리포트`;

  if (prevFailures.length) {
    logger.warn(`[publisher] 이전 실패 ${prevFailures.length}건 감지 — 메일 제목에 prefix 추가`);
  }

  // ── Gmail 발송 (gmail.flag 없을 때만) ──────────────────────────────────────
  if (!gmailDone) {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.GMAIL_SENDER, pass: process.env.GMAIL_APP_PASSWORD },
    });
    try {
      await transporter.sendMail({
        from:    `"시장 리포트" <${process.env.GMAIL_SENDER}>`,
        to:      process.env.GMAIL_RECIPIENT,
        subject,
        html: buildEmailCard(data, tfResults, editorialPlan, reportUrl),
      });
      await fs.writeFile(gmailFlag, new Date().toISOString(), 'utf-8');
      gmailDone = true;
      logger.info(`[publisher] Gmail 발송 완료 → ${process.env.GMAIL_RECIPIENT}`);

      // Gmail 발송 성공 시 이전 failures.json을 consumed로 표시 (중복 prefix 방지)
      if (prevFailures.length) {
        await _markPreviousFailuresConsumed(outputDir);
      }
    } catch (e) {
      // Gmail은 필수 채널이므로 failures.json에 기록하고 오류를 다시 던진다
      await _recordFailure(outputDir, 'gmail', e.message);
      logger.error(`[publisher] Gmail 발송 실패 — failures.json 기록 완료`);
      throw e;
    }
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
      // Notion은 선택 채널 — failures.json 기록 후 계속 진행
      await _recordFailure(outputDir, 'notion', e.message);
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
    prevFailuresDetected: prevFailures.length,
  };
}
