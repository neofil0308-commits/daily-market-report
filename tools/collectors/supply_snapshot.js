// tools/collectors/supply_snapshot.js — 16:40 KST 장 마감 후 수급 스냅샷 수집
// GitHub Actions supply-collect.yml에서 단독 실행됨
// outputs/{YYYY-MM-DD}/supply.json 저장 → 다음날 08:00 리포트에서 사용
import 'dotenv/config';
import axios from 'axios';
import fs from 'fs/promises';
import path from 'path';

const NAVER_POLL = 'https://polling.finance.naver.com/api/realtime/domestic/index';
const NAVER_HDRS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  Referer: 'https://finance.naver.com/',
};

async function collectSupply() {
  try {
    const res = await axios.get(`${NAVER_POLL}/KOSPI_INVESTOR`, {
      headers: NAVER_HDRS, timeout: 10000,
    });
    const list = res.data?.datas ?? [];
    if (list.length === 0) throw new Error('datas 비어있음 (장 마감 전 또는 API 불가)');

    const find   = t => list.find(d => String(d.investorType ?? d.investorCode ?? d.name ?? '').includes(t));
    const pn     = s => { const v = parseFloat(String(s ?? '').replace(/,/g, '')); return isNaN(v) ? null : v; };
    const getNet = x => pn(x?.netBuySellAmountRaw ?? x?.netBuySellQuantityRaw ?? x?.netCount ?? x?.net);

    return {
      foreign:     getNet(find('외국인') ?? find('FOREIGN') ?? find('8')),
      institution: getNet(find('기관')   ?? find('INSTITUTION') ?? find('4')),
      individual:  getNet(find('개인')   ?? find('INDIVIDUAL')  ?? find('1')),
      collectedAt: new Date().toISOString(),
    };
  } catch (e) {
    console.warn('[supply] KOSPI_INVESTOR 수집 실패:', e.message);
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

const [supply, vkospi] = await Promise.all([collectSupply(), collectVkospi()]);

const snapshot = { date: todayStr, supply, vkospi, savedAt: new Date().toISOString() };
await fs.writeFile(path.join(outputDir, 'supply.json'), JSON.stringify(snapshot, null, 2), 'utf-8');

console.log(`✅ 수급 스냅샷 저장 완료 → outputs/${todayStr}/supply.json`);
console.log('  supply:', supply ? `외국인 ${supply.foreign} / 기관 ${supply.institution} / 개인 ${supply.individual}` : '수집 실패');
console.log('  vkospi:', vkospi?.today ?? '수집 실패');
