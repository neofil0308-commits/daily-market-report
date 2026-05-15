// tools/utils/holiday.js

/**
 * 특정 날짜가 해당 국가의 휴장일인지 판별
 * @param {import('dayjs').Dayjs} date
 * @param {'KR'|'US'} country
 */
export async function isHoliday(date, country) {
  const dow = date.day(); // 0=일, 6=토
  if (dow === 0 || dow === 6) return true;

  if (country === 'KR') return KR_HOLIDAYS.includes(date.format('YYYY-MM-DD'));
  if (country === 'US') return US_HOLIDAYS.includes(date.format('YYYY-MM-DD'));
  return false;
}

// 2026년 한국 공휴일
const KR_HOLIDAYS = [
  '2026-01-01', '2026-01-26', '2026-01-27', '2026-01-28',
  '2026-03-01', '2026-05-05', '2026-05-15', '2026-06-06',
  '2026-08-15', '2026-09-24', '2026-09-25', '2026-09-26',
  '2026-10-03', '2026-10-09', '2026-12-25',
];

// 2026년 미국 공휴일
const US_HOLIDAYS = [
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-05-25',
  '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
];
