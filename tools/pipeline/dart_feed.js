// tools/pipeline/dart_feed.js — OpenDART 증권사 공시 수집
// DART_API_KEY 환경변수 미설정 시 빈 결과 반환 (파이프라인 중단 없음).
import axios from 'axios';
import { logger } from '../utils/logger.js';

const DART_BASE = 'https://opendart.fss.or.kr/api';

/**
 * 최근 투자의견 관련 공시 수집 (당일 기준).
 * @returns {Promise<DartData>}
 */
export async function collectDart() {
  const apiKey = process.env.DART_API_KEY?.trim();
  if (!apiKey) {
    logger.info('[dart] DART_API_KEY 미설정 — 공시 수집 생략');
    return { reports: [], lastUpdated: null };
  }

  try {
    const today = new Date();
    const bgn   = _dateStr(new Date(today - 7 * 86400000)); // 7일 전
    const end   = _dateStr(today);

    // 투자의견 변경 공시: 보고서명에 "투자의견" 포함
    const res = await axios.get(`${DART_BASE}/list.json`, {
      params: {
        crtfc_key: apiKey,
        bgn_de:    bgn,
        end_de:    end,
        pblntf_ty: 'B',   // 사업보고서류
        page_count: 40,
      },
      timeout: 10000,
    });

    if (res.data.status !== '000') {
      logger.warn('[dart] API 오류:', res.data.message);
      return { reports: [], lastUpdated: null };
    }

    const items = (res.data.list ?? [])
      .filter(r => /투자의견|목표주가|리서치/.test(r.report_nm))
      .map(r => ({
        company:    r.corp_name,
        reportName: r.report_nm,
        dartId:     r.rcept_no,
        filedAt:    r.rcept_dt,
        url:        `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${r.rcept_no}`,
      }));

    logger.info(`[dart] 공시 수집 완료: ${items.length}건`);
    return { reports: items, lastUpdated: _dateStr(today) };

  } catch (e) {
    logger.warn('[dart] 수집 실패:', e.message);
    return { reports: [], lastUpdated: null };
  }
}

const _dateStr = d =>
  `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
