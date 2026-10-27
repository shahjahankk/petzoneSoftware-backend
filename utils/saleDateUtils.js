/**
 * Normalize optional backdate input into sale_date + created_at/updated_at values.
 * When no valid date is given, timestamps use current Pakistan Standard Time (Asia/Karachi).
 */

const TIME_ZONE = 'Asia/Karachi';

function formatDateTimeInTz(date, tz = TIME_ZONE) {
  const pad = (n) => String(n).padStart(2, '0');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const get = (type) => parts.find((p) => p.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

function formatNowForMysql() {
  return formatDateTimeInTz(new Date());
}

function resolveSaleTimestamps(saleDate) {
  const now = formatNowForMysql();

  if (saleDate == null || String(saleDate).trim() === '') {
    return { saleDateSql: null, createdAt: now, updatedAt: now };
  }

  const raw = String(saleDate).trim();
  const dateOnly = /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : null;

  if (!dateOnly || !/^\d{4}-\d{2}-\d{2}$/.test(dateOnly)) {
    return { saleDateSql: null, createdAt: now, updatedAt: now };
  }

  const noon = `${dateOnly} 12:00:00`;
  return { saleDateSql: dateOnly, createdAt: noon, updatedAt: noon };
}

module.exports = {
  resolveSaleTimestamps,
  formatNowForMysql,
};
