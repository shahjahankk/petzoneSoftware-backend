const { pool } = require('../config/database');
const driftDetector = require('./inventoryDriftDetector');

let timer = null;

async function runOnce() {
  const [items] = await pool.execute(
    'SELECT id FROM inventory_items WHERE deleted_at IS NULL ORDER BY id ASC'
  );
  let drifted = 0;
  let healed = 0;

  for (const row of items) {
    try {
      const res = await driftDetector.checkItem(row.id, null, pool);
      if (res.drift !== 0) {
        drifted += 1;
        if (res.healed) healed += 1;
      }
    } catch (err) {
    }
  }

}

function startInventoryReconciliationJob() {
  const enabled = String(process.env.INVENTORY_RECONCILIATION_ENABLED || 'true').toLowerCase() === 'true';
  if (!enabled) return;
  if (timer) return;

  const mins = Number(process.env.INVENTORY_RECONCILIATION_MINUTES || 15);
  const intervalMs = (Number.isFinite(mins) && mins > 0 ? mins : 15) * 60 * 1000;

  timer = setInterval(() => {
    runOnce().catch((err) => {
    });
  }, intervalMs);

  // Initial run shortly after boot.
  setTimeout(() => {
    runOnce().catch((err) => {
    });
  }, 15_000);

}

module.exports = {
  startInventoryReconciliationJob,
  runOnce,
};
