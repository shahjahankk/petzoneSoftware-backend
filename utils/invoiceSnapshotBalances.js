/**
 * When ledger_migration_completed = 1, per-sale balance display must come from
 * invoice_snapshots only — not sales.old_balance / sales.running_balance.
 */

async function mergeSaleRowWithSnapshotBalances(db, saleRow) {
  if (!saleRow?.id) return saleRow;
  const [rows] = await db.execute(
    'SELECT old_balance, final_balance FROM invoice_snapshots WHERE sale_id = ? LIMIT 1',
    [saleRow.id]
  );
  if (!rows.length) {
    const { old_balance: _ob, running_balance: _rb, ...rest } = saleRow;
    return { ...rest, old_balance: null, running_balance: null };
  }
  const snap = rows[0];
  return {
    ...saleRow,
    old_balance: parseFloat(snap.old_balance) || 0,
    running_balance: parseFloat(snap.final_balance) || 0,
  };
}

async function mergeSaleRowsWithSnapshotBalances(db, saleRows) {
  if (!Array.isArray(saleRows) || saleRows.length === 0) return saleRows;
  const ids = saleRows.map((r) => r.id).filter(Boolean);
  if (ids.length === 0) return saleRows;
  const ph = ids.map(() => '?').join(',');
  const [snaps] = await db.execute(
    `SELECT sale_id, old_balance, final_balance FROM invoice_snapshots WHERE sale_id IN (${ph})`,
    ids
  );
  const byId = new Map(snaps.map((s) => [s.sale_id, s]));
  return saleRows.map((r) => {
    const snap = byId.get(r.id);
    if (!snap) {
      const { old_balance: _ob, running_balance: _rb, ...rest } = r;
      return { ...rest, old_balance: null, running_balance: null };
    }
    return {
      ...r,
      old_balance: parseFloat(snap.old_balance) || 0,
      running_balance: parseFloat(snap.final_balance) || 0,
    };
  });
}

module.exports = {
  mergeSaleRowWithSnapshotBalances,
  mergeSaleRowsWithSnapshotBalances,
};
