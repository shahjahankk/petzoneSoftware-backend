const { executeQuery } = require('../config/database');

const PK_OFFSET_MS = 5 * 60 * 60 * 1000;
const SALES_TIME_OFFSET_SQL = "INTERVAL (5 - TIMESTAMPDIFF(HOUR, UTC_TIMESTAMP(), NOW())) HOUR";

let lastAutoCloseDate = null;

const roundMoney = (value) => Math.round((Number(value) || 0) * 100) / 100;

const getPkNow = () => {
  const shifted = new Date(Date.now() + PK_OFFSET_MS);
  return {
    dateKey: shifted.toISOString().slice(0, 10),
    hour: shifted.getUTCHours(),
  };
};

async function getSalesTotals(sessionId) {
  const rows = await executeQuery(`
    SELECT
      COALESCE(SUM(CASE WHEN s.id IS NOT NULL
        AND (s.payment_type IS NULL OR s.payment_type NOT IN ('REFUND', 'CASH_REFUND', 'CREDIT_REFUND_SETTLEMENT'))
        AND (s.payment_method IS NULL OR s.payment_method NOT IN ('REFUND', 'CASH_REFUND'))
        AND s.invoice_no NOT LIKE 'RET-%' THEN s.total ELSE 0 END), 0) AS total_sales,
      COALESCE(SUM(CASE WHEN s.payment_method = 'CASH'
        AND (s.payment_type IS NULL OR s.payment_type NOT IN ('REFUND', 'CASH_REFUND', 'CREDIT_REFUND_SETTLEMENT'))
        AND s.invoice_no NOT LIKE 'RET-%' THEN s.total ELSE 0 END), 0) AS cash_sales,
      COALESCE(SUM(CASE WHEN s.payment_method IN ('REFUND', 'CASH_REFUND')
        OR s.payment_type IN ('REFUND', 'CASH_REFUND', 'CREDIT_REFUND_SETTLEMENT')
        OR s.invoice_no LIKE 'RET-%' THEN s.total ELSE 0 END), 0) AS cash_refunds
    FROM shift_sessions ss
    JOIN shifts sh ON sh.id = ss.shift_id
    LEFT JOIN sales s
      ON s.user_id = ss.user_id
     AND s.scope_type = sh.scope_type
     AND (
       s.scope_id = sh.scope_id
       OR s.scope_id = COALESCE(
         CASE sh.scope_type
           WHEN 'BRANCH' THEN (SELECT b.name FROM branches b WHERE b.id = sh.scope_id LIMIT 1)
           WHEN 'WAREHOUSE' THEN (SELECT w.name FROM warehouses w WHERE w.id = sh.scope_id LIMIT 1)
           ELSE NULL
         END, ''
       )
     )
     AND s.status = 'COMPLETED'
     AND s.deleted_at IS NULL
     AND s.created_at >= ss.actual_start_time + ${SALES_TIME_OFFSET_SQL}
     AND s.created_at <= COALESCE(ss.actual_end_time + ${SALES_TIME_OFFSET_SQL}, UTC_TIMESTAMP() + INTERVAL 5 HOUR)
    WHERE ss.id = ?
  `, [sessionId]);
  return rows[0] || {};
}

async function getExpenseTotals(sessionId) {
  const rows = await executeQuery(`
    SELECT COALESCE(SUM(fv.amount), 0) AS cash_expenses
    FROM shift_sessions ss
    JOIN shifts sh ON sh.id = ss.shift_id
    LEFT JOIN financial_vouchers fv
      ON fv.scope_type = sh.scope_type
     AND (
       fv.scope_id = sh.scope_id
       OR fv.scope_id = COALESCE(
         CASE sh.scope_type
           WHEN 'BRANCH' THEN (SELECT b.name FROM branches b WHERE b.id = sh.scope_id LIMIT 1)
           WHEN 'WAREHOUSE' THEN (SELECT w.name FROM warehouses w WHERE w.id = sh.scope_id LIMIT 1)
           ELSE NULL
         END, ''
       )
     )
     AND fv.user_id = ss.user_id
     AND fv.type = 'EXPENSE'
     AND fv.payment_method = 'CASH'
     AND fv.status = 'APPROVED'
     AND fv.deleted_at IS NULL
     AND fv.created_at >= ss.actual_start_time
     AND fv.created_at <= COALESCE(ss.actual_end_time, NOW())
    WHERE ss.id = ?
  `, [sessionId]);
  return rows[0] || {};
}

async function getMovementTotals(sessionId) {
  try {
    const rows = await executeQuery(`
      SELECT
        COALESCE(SUM(CASE WHEN cm.direction = 'IN' THEN cm.amount ELSE 0 END), 0) AS cash_in,
        COALESCE(SUM(CASE WHEN cm.direction = 'OUT' THEN cm.amount ELSE 0 END), 0) AS cash_out
      FROM shift_sessions ss
      JOIN shifts sh ON sh.id = ss.shift_id
      LEFT JOIN shift_cash_movements cm
        ON cm.status = 'APPROVED'
       AND cm.deleted_at IS NULL
       AND (
         cm.shift_session_id = ss.id
         OR (
           cm.shift_session_id IS NULL
           AND cm.scope_type = sh.scope_type
           AND (cm.scope_id = sh.scope_id OR cm.scope_id = COALESCE(
             CASE sh.scope_type
               WHEN 'BRANCH' THEN (SELECT b.name FROM branches b WHERE b.id = sh.scope_id LIMIT 1)
               WHEN 'WAREHOUSE' THEN (SELECT w.name FROM warehouses w WHERE w.id = sh.scope_id LIMIT 1)
               ELSE NULL
             END, ''
           ))
           AND cm.user_id = ss.user_id
           AND cm.created_at >= ss.actual_start_time
           AND cm.created_at <= COALESCE(ss.actual_end_time, NOW())
         )
       )
      WHERE ss.id = ?
    `, [sessionId]);
    return rows[0] || {};
  } catch (error) {
    if (!/ER_NO_SUCH_TABLE|doesn't exist|does not exist/i.test(error.message)) throw error;
    return {};
  }
}

async function closeSessionWithSummary(session) {
  const [sales, expenses, movements] = await Promise.all([
    getSalesTotals(session.id),
    getExpenseTotals(session.id),
    getMovementTotals(session.id),
  ]);

  const finalCash = roundMoney(
    Number(session.initial_cash) +
    Number(sales.cash_sales) +
    Number(sales.cash_refunds) +
    Number(movements.cash_in) -
    Number(movements.cash_out) -
    Number(expenses.cash_expenses)
  );

  await executeQuery(`
    UPDATE shift_sessions
       SET status = 'ENDED', actual_end_time = NOW(), final_cash = ?, total_sales = ?, updated_at = NOW()
     WHERE id = ? AND actual_end_time IS NULL
  `, [finalCash, roundMoney(sales.total_sales), session.id]);

  return finalCash;
}

async function closeShiftsAtMidnight() {
  try {
    const pk = getPkNow();
    if (pk.hour < 1 || lastAutoCloseDate === pk.dateKey) return;

    const activeSessions = await executeQuery(`
      SELECT ss.id, ss.user_id, ss.initial_cash, ss.actual_start_time
      FROM shift_sessions ss
      WHERE ss.status = 'ACTIVE'
        AND ss.actual_end_time IS NULL
        AND DATE(CONVERT_TZ(ss.actual_start_time, '+00:00', '+05:00')) < ?
    `, [pk.dateKey]);

    if (activeSessions.length > 0) {
      for (const session of activeSessions) {
        await closeSessionWithSummary(session);
      }
      console.log(`[shiftScheduler] Auto-closed ${activeSessions.length} shift session(s) for PK date ${pk.dateKey}`);
    }

    lastAutoCloseDate = pk.dateKey;
  } catch (error) {
    console.error('[shiftScheduler] Midnight auto-close failed:', error.message);
  }
}

function startShiftScheduler() {
  closeShiftsAtMidnight().catch(() => {});
  setInterval(closeShiftsAtMidnight, 60 * 1000);
}

module.exports = {
  startShiftScheduler,
  closeShiftsAtMidnight,
};
