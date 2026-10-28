/**
 * Shift auto-close scheduler.
 *
 * Every minute, checks whether it is past midnight (00:00) relative to the
 * last run. Any shift_sessions still ACTIVE at midnight are closed out
 * automatically so a cashier who forgets to close does not leave an open
 * shift carrying into the next business day.
 *
 * A session is considered "already closed for today" if its actual_end_time
 * falls on the same calendar date as the midnight boundary we just passed,
 * so a cashier who re-opens on the same day after an auto-close gets a fresh
 * session (start-shift already blocks duplicate ACTIVE sessions per user).
 */

const { executeQuery } = require('../config/database');

let lastMidnightProcessed = null; // YYYY-MM-DD of the last midnight we closed

function isPastMidnight() {
  const now = new Date();
  const today = now.toISOString().slice(0, 10); // YYYY-MM-DD in local TZ
  return today !== lastMidnightProcessed;
}

async function closeShiftsAtMidnight() {
  try {
    const now = new Date();
    // Only act once per calendar day, at/after 00:00
    if (now.getHours() !== 0 || !isPastMidnight()) return;

    const dateKey = now.toISOString().slice(0, 10);

    const activeSessions = await executeQuery(
      `SELECT id, user_id, actual_start_time
         FROM shift_sessions
        WHERE status = 'ACTIVE'
          AND actual_end_time IS NULL`
    );

    if (activeSessions.length > 0) {
      for (const s of activeSessions) {
        await executeQuery(
          `UPDATE shift_sessions
             SET status = 'ENDED', actual_end_time = NOW()
           WHERE id = ? AND actual_end_time IS NULL`,
          [s.id]
        );
      }
      console.log(`[shiftScheduler] Auto-closed ${activeSessions.length} shift session(s) at midnight ${dateKey}`);
    }

    lastMidnightProcessed = dateKey;
  } catch (error) {
    console.error('[shiftScheduler] Midnight auto-close failed:', error.message);
  }
}

function startShiftScheduler() {
  // Run immediately on startup (in case the server restarted after midnight)
  closeShiftsAtMidnight().catch(() => {});

  // Poll every minute
  setInterval(closeShiftsAtMidnight, 60 * 1000);
}

module.exports = {
  startShiftScheduler,
  closeShiftsAtMidnight,
};
