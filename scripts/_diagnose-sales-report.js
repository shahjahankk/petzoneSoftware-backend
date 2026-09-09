require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { pool } = require('../config/database');
const { CLINIC_LINE_SQL, PRODUCT_LINE_SQL } = require('../utils/clinicSaleItem');
const { dateColumnInTz } = require('../utils/reportDate');

const args = process.argv.slice(2);
const targetDate = args[0] || new Date().toISOString().split('T')[0];

(async () => {
  console.log(`\n=== Sales Report Diagnosis for ${targetDate} ===\n`);

  // 1. Raw sales rows for the date
  const [salesRows] = await pool.execute(
    `SELECT id, invoice_no, total, payment_amount, credit_amount, payment_method, payment_type,
            customer_name, user_id, scope_type, scope_id, created_at, deleted_at, status
     FROM sales
     WHERE ${dateColumnInTz('created_at')} = ?
       AND status = 'COMPLETED'
       AND deleted_at IS NULL
     ORDER BY created_at DESC`,
    [targetDate]
  );

  console.log(`Total COMPLETED sales rows on ${targetDate}: ${salesRows.length}`);
  console.log(`Sum of sales.total on ${targetDate}: ${salesRows.reduce((s, r) => s + parseFloat(r.total || 0), 0).toFixed(2)}`);
  console.log(`Sum of sales.payment_amount on ${targetDate}: ${salesRows.reduce((s, r) => s + parseFloat(r.payment_amount || 0), 0).toFixed(2)}`);

  // 2. Payment method breakdown
  const methodBreakdown = {};
  salesRows.forEach((r) => {
    const m = (r.payment_method || 'CASH').toUpperCase();
    methodBreakdown[m] = (methodBreakdown[m] || 0) + parseFloat(r.total || 0);
  });
  console.log('\nPayment method breakdown (sales.total):');
  Object.entries(methodBreakdown).forEach(([k, v]) => console.log(`  ${k}: ${v.toFixed(2)}`));

  // 2b. Scope / cashier breakdown
  const scopeBreakdown = {};
  const cashierBreakdown = {};
  salesRows.forEach((r) => {
    const scopeKey = `${r.scope_type}:${r.scope_id}`;
    scopeBreakdown[scopeKey] = (scopeBreakdown[scopeKey] || { count: 0, total: 0 });
    scopeBreakdown[scopeKey].count += 1;
    scopeBreakdown[scopeKey].total += parseFloat(r.total || 0);

    const cashierKey = `${r.user_id || 'unknown'}`;
    cashierBreakdown[cashierKey] = (cashierBreakdown[cashierKey] || { count: 0, total: 0, name: r.user_id || 'unknown' });
    cashierBreakdown[cashierKey].count += 1;
    cashierBreakdown[cashierKey].total += parseFloat(r.total || 0);
  });
  console.log('\nScope breakdown (sales.total):');
  Object.entries(scopeBreakdown).forEach(([k, v]) => console.log(`  ${k}: count=${v.count}, total=${v.total.toFixed(2)}`));
  console.log('\nCashier breakdown (sales.total):');
  Object.entries(cashierBreakdown).forEach(([k, v]) => console.log(`  user_id=${k}: count=${v.count}, total=${v.total.toFixed(2)}`));

  // 2c. List all branch sales (for comparison with user's list)
  console.log('\nAll BRANCH sales on this date (invoice, created_at, total, method, cashier_id):');
  salesRows
    .filter((r) => r.scope_type === 'BRANCH')
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
    .forEach((r) => {
      console.log(`  ${r.invoice_no} | ${r.created_at} | ${parseFloat(r.total || 0).toFixed(2)} | ${r.payment_method} | user=${r.user_id}`);
    });

  // 3. Sale line splits
  if (salesRows.length > 0) {
    const saleIds = salesRows.map((r) => r.id);
    const placeholders = saleIds.map(() => '?').join(',');
    const [lineRows] = await pool.execute(
      `SELECT si.sale_id,
         SUM(CASE WHEN ${CLINIC_LINE_SQL} THEN COALESCE(si.total, 0) ELSE 0 END) AS clinic_total,
         SUM(CASE WHEN NOT (${CLINIC_LINE_SQL}) THEN COALESCE(si.total, 0) ELSE 0 END) AS product_total,
         SUM(COALESCE(si.total, 0)) AS line_total,
         COUNT(*) AS line_count,
         SUM(CASE WHEN si.inventory_item_id IS NOT NULL AND si.clinic_service_id IS NOT NULL THEN 1 ELSE 0 END) AS lines_with_both_ids,
         SUM(CASE WHEN si.clinic_service_id IS NOT NULL THEN 1 ELSE 0 END) AS clinic_line_count,
         SUM(CASE WHEN si.inventory_item_id IS NOT NULL THEN 1 ELSE 0 END) AS inventory_line_count
       FROM sale_items si
       WHERE si.sale_id IN (${placeholders})
       GROUP BY si.sale_id`,
      saleIds
    );

    const splitById = Object.fromEntries(lineRows.map((r) => [r.sale_id, r]));

    let reportProductTotal = 0;
    let reportClinicTotal = 0;
    let branchProductTotal = 0;
    let branchClinicTotal = 0;
    let mismatchedSales = [];

    salesRows.forEach((sale) => {
      const split = splitById[sale.id];
      if (!split) {
        // No line items: report treats whole sale as product
        reportProductTotal += parseFloat(sale.total || 0);
        mismatchedSales.push({ invoice: sale.invoice_no, reason: 'NO_LINE_ITEMS', saleTotal: sale.total, productTotal: sale.total });
        return;
      }

      const productTotal = parseFloat(split.product_total || 0);
      const clinicTotal = parseFloat(split.clinic_total || 0);
      const lineTotal = parseFloat(split.line_total || 0);
      const saleTotal = parseFloat(sale.total || 0);

      reportProductTotal += productTotal;
      reportClinicTotal += clinicTotal;
      if (sale.scope_type === 'BRANCH') {
        branchProductTotal += productTotal;
        branchClinicTotal += clinicTotal;
      }

      // Flag if sale total doesn't match line total (possible duplicates or missing lines)
      if (Math.abs(saleTotal - lineTotal) > 0.01) {
        mismatchedSales.push({
          invoice: sale.invoice_no,
          reason: 'SALE_TOTAL_MISMATCH',
          saleTotal,
          lineTotal,
          productTotal,
          clinicTotal,
          lineCount: split.line_count,
        });
      }

      // Flag clinic lines that also have inventory_item_id (would be counted as product)
      if (parseInt(split.lines_with_both_ids || 0) > 0) {
        mismatchedSales.push({
          invoice: sale.invoice_no,
          reason: 'CLINIC_LINE_WITH_INVENTORY_ID',
          saleTotal,
          productTotal,
          clinicTotal,
          linesWithBothIds: split.lines_with_both_ids,
        });
      }
    });

    console.log(`\nReport product total (all scopes): ${reportProductTotal.toFixed(2)}`);
    console.log(`Report clinic total (all scopes): ${reportClinicTotal.toFixed(2)}`);
    console.log(`Report product total (BRANCH only): ${branchProductTotal.toFixed(2)}`);
    console.log(`Report clinic total (BRANCH only): ${branchClinicTotal.toFixed(2)}`);
    console.log(`Sales with anomalies: ${mismatchedSales.length}`);

    if (mismatchedSales.length > 0) {
      console.log('\nAnomalous sales (first 20):');
      mismatchedSales.slice(0, 20).forEach((m) => console.log(' ', m));
    }
  }

  // 4. Check for duplicate sale_items per sale
  const [dupRows] = await pool.execute(
    `SELECT sale_id, inventory_item_id, clinic_service_id, COUNT(*) AS cnt
     FROM sale_items
     WHERE ${dateColumnInTz('created_at')} = ?
     GROUP BY sale_id, inventory_item_id, clinic_service_id
     HAVING cnt > 1`,
    [targetDate]
  );
  console.log(`\nDuplicate sale_items groups (same sale + item/service): ${dupRows.length}`);
  if (dupRows.length > 0) {
    dupRows.slice(0, 10).forEach((r) => console.log(' ', r));
  }

  // 5. Check for multiple invoice_snapshots per sale
  if (salesRows.length > 0) {
    const saleIds = salesRows.map((r) => r.id);
    const placeholders = saleIds.map(() => '?').join(',');
    const [snapRows] = await pool.execute(
      `SELECT sale_id, COUNT(*) AS snapshot_count
       FROM invoice_snapshots
       WHERE sale_id IN (${placeholders})
       GROUP BY sale_id
       HAVING snapshot_count > 1`,
      saleIds
    );
    console.log(`\nSales with multiple invoice_snapshots: ${snapRows.length}`);
    if (snapRows.length > 0) {
      snapRows.slice(0, 10).forEach((r) => console.log(' ', r));
    }
  }

  await pool.end();
})();
