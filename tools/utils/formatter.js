// tools/utils/formatter.js

/** 지수 포인트: 소수점 둘째 자리, 천단위 콤마 */
export const formatPts = v =>
  v != null ? v.toLocaleString('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—';

/** 달러 단위: 소수점 둘째 자리 */
export const formatUsd = v =>
  v != null ? `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—';

/** 원화 금액: 정수 + 단위 */
export const formatKrw = v => {
  if (v == null) return '—';
  const abs = Math.abs(v);
  const sign = v < 0 ? '▼' : '+';
  if (abs >= 1e8) return `${sign}${(abs / 1e8).toFixed(2)}조원`;
  if (abs >= 1e4) return `${sign}${Math.round(abs / 1e4).toLocaleString('ko-KR')}억원`;
  return `${sign}${Math.round(abs).toLocaleString('ko-KR')}원`;
};

/** 퍼센트: 소수점 둘째 자리 */
export const formatPct = v =>
  v != null ? `${v >= 0 ? '+' : ''}${v.toFixed(2)}%` : '—';

/** 변동 셀 텍스트 생성 */
export const formatChgCell = ({ diff, pct, direction }) => {
  if (diff == null) return '—';
  const arrow = direction === 'up' ? '▲' : direction === 'down' ? '▼' : '━';
  const diffStr = Math.abs(diff).toLocaleString('ko-KR', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
  return `${arrow} ${diffStr} (${pct >= 0 ? '+' : ''}${pct?.toFixed(2)}%)`;
};
