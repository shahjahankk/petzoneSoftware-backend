/**
 * Normalize optional backdate input into sale_date + created_at/updated_at values.
 * When no valid date is given, timestamps use current server time.
 */

function formatNowForMysql() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
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
