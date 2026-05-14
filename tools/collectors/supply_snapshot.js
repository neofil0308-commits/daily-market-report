// tools/collectors/supply_snapshot.js — 16:40 KST 장 마감 후 수급 스냅샷 수집
// GitHub Actions supply-collect.yml에서 단독 실행됨
// outputs/{YYYY-MM-DD}/supply.json 저장 → 다음날 08:00 리포트에서 사용
import 'dotenv/config';
import axios from 'axios';
import fs from 'fs/promises';
import path from 'path';

const NAVER_HDRS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  Referer: 'https://finance.naver.com/sise/sise_trans_style.naver',
};

// 네이버 "투자자별 매매 동향 > 일자별 순매수" 페이지 스크래핑 (장 마감 후에도 작동)
// 단위: 억원 (순매수 양수 = 순매수, 음수 = 순매도)
async function collectSupply(dateStr) {
  try {
    const bizdate = dateStr.replace(/-/g, '');
    const res = await axios.get(
      `https://finance.naver.com/sise/investorDealTrendDay.naver?bizdate=${bizdate}&sosok=`,
      { headers: NAVER_HDRS, timeout: 12000, responseType: 'arraybuffer' }
    );
    const html = new TextDecoder('euc-kr').decode(res.data);

    const { load } = await import('cheerio');
    const $ = load(html);
    const pn = s => { const v = parseFloat(String(s ?? '').replace(/,/g, '')); return isNaN(v) ? null : v; };

    let result = null;
    $('table tr').each((_, tr) => {
      if (result) return;
      const cells = $(tr).find('td').map((__, td) => $(td).text().trim()).get();
      // 날짜 셀 형식: YY.MM.DD
      if (cells.length >= 4 && /^\d{2}\.\d{2}\.\d{2}$/.test(cells[0])) {
        // 첫 번째 데이터 행 = 오늘(bizdate) 데이터
        // 컬럼: 날짜 | 개인 | 외국인 | 기관계 | 금융투자 | 보험 | 투신(사모) | 은행 | 기타금융기관 | 연기금 | 기타법인
        result = {
          individual:  pn(cells[1]),
          foreign:     pn(cells[2]),
          institution: pn(cells[3]),
          collectedAt: new Date().toISOString(),
        };
      }
    });

    if (!result) throw new Error('테이블 행 파싱 실패');
    console.log(`[supply] 수급 수집 완료 (${dateStr}): 외국인 ${result.foreign}억, 기관 ${result.institution}억, 개인 ${result.individual}억`);
    return result;
  } catch (e) {
    console.warn('[supply] 수급 수집 실패:', e.message);
    return null;
  }
}

async function collectVkospi() {
  try {
    const res = await axios.get('https://m.stock.naver.com/api/index/VKOSPI/basic', {
      headers: NAVER_HDRS, timeout: 8000,
    });
    const p = s => parseFloat(String(s ?? '').replace(/,/g, '')) || null;
    const today = p(res.data.closePrice);
    const delta = p(res.data.compareToPreviousClosePrice);
    const prev  = (today != null && delta != null) ? Math.round((today - delta) * 100) / 100 : null;
    if (today != null) {
      console.log('[supply] VKOSPI 수집 완료:', today);
      return { today, prev, source: 'naver' };
    }
  } catch (e) {
    console.warn('[supply] VKOSPI 수집 실패:', e.response?.status ?? e.message);
  }
  return null;
}

// ── 메인 실행 ──────────────────────────────────────────────────────────────────
// KST 기준 날짜 계산.
// GitHub Actions 크론 지연으로 새벽(00:00~08:59 KST)에 실행될 경우,
// 실제 수집 데이터는 전날 종가 기준이므로 전 영업일 폴더에 저장한다.
const nowKST = new Date(Date.now() + 9 * 60 * 60 * 1000);
const kstHour = nowKST.getUTCHours(); // toISOString 기준이므로 +9h 반영된 시각
let dataDate = nowKST;
if (kstHour < 9) {
  // 장전 새벽: 전날 영업일로 후퇴
  dataDate = new Date(nowKST.getTime() - 24 * 60 * 60 * 1000);
  while ([0, 6].includes(dataDate.getUTCDay())) {
    dataDate = new Date(dataDate.getTime() - 24 * 60 * 60 * 1000);
  }
}
const todayStr = dataDate.toISOString().slice(0, 10);
const outputDir = path.join(process.env.OUTPUT_DIR ?? './outputs', todayStr);
await fs.mkdir(outputDir, { recursive: true });

const [supply, vkospi] = await Promise.all([collectSupply(todayStr), collectVkospi()]);

const snapshot = { date: todayStr, supply, vkospi, savedAt: new Date().toISOString() };
await fs.writeFile(path.join(outputDir, 'supply.json'), JSON.stringify(snapshot, null, 2), 'utf-8');

console.log(`✅ 수급 스냅샷 저장 완료 → outputs/${todayStr}/supply.json`);
console.log('  supply:', supply ? `외국인 ${supply.foreign} / 기관 ${supply.institution} / 개인 ${supply.individual}` : '수집 실패');
console.log('  vkospi:', vkospi?.today ?? '수집 실패');
