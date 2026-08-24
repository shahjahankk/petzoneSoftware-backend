/**
 * Clear sales, purchases, and inventory for branch Petzone,Latifabad (#1).
 * Does NOT delete customers, users, companies, or the branch itself.
 */
require('dotenv').config();
const mysql = require('mysql2/promise');

(async () => {
  const c = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });

  const BRANCH_ID = 1;
  const BRANCH_NAME = 'Petzone,Latifabad';
  const SCOPE_VALUES = [BRANCH_NAME, String(BRANCH_ID), BRANCH_ID];

  const deleted = {};

  const del = async (label, sql, params = []) => {
    const [res] = await c.execute(sql, params);
    deleted[label] = res.affectedRows;
    console.log(`  deleted ${label}: ${res.affectedRows}`);
  };

  const inList = (ids) => ids.map(() => '?').join(',');

  try {
    await c.beginTransaction();
    console.log('Clearing Petzone,Latifabad (branch #1)...');

    const [sales] = await c.execute(
      `SELECT id FROM sales WHERE scope_type = 'BRANCH' AND scope_id IN (?, ?, ?)`,
      SCOPE_VALUES
    );
    const saleIds = sales.map((r) => r.id);

    const [returns] = saleIds.length
      ? await c.execute(
          `SELECT id FROM sales_returns WHERE original_sale_id IN (${inList(saleIds)})`,
          saleIds
        )
      : [[]];
    const returnIds = returns.map((r) => r.id);

    const [pos] = await c.execute(
      `SELECT id FROM purchase_orders WHERE scope_type = 'BRANCH' AND scope_id IN (?, ?, ?)`,
      SCOPE_VALUES
    );
    const poIds = pos.map((r) => r.id);

    const [items] = await c.execute(
      `SELECT id FROM inventory_items WHERE scope_type = 'BRANCH' AND scope_id IN (?, ?, ?)`,
      SCOPE_VALUES
    );
    const itemIds = items.map((r) => r.id);

    console.log(`Found: ${saleIds.length} sales, ${poIds.length} POs, ${itemIds.length} inventory items`);

    // --- Sales returns ---
    if (returnIds.length) {
      await del(
        'sales_return_items',
        `DELETE FROM sales_return_items WHERE return_id IN (${inList(returnIds)})`,
        returnIds
      );
      await del(
        'sales_returns',
        `DELETE FROM sales_returns WHERE id IN (${inList(returnIds)})`,
        returnIds
      );
    } else {
      deleted.sales_return_items = 0;
      deleted.sales_returns = 0;
      console.log('  deleted sales_return_items: 0');
      console.log('  deleted sales_returns: 0');
    }

    // --- Sale children ---
    if (saleIds.length) {
      await del(
        'bilty_items',
        `DELETE FROM bilty_items WHERE sale_id IN (${inList(saleIds)})`,
        saleIds
      );
      await del(
        'payments',
        `DELETE FROM payments WHERE sale_id IN (${inList(saleIds)})`,
        saleIds
      );
      await del(
        'invoice_snapshots',
        `DELETE FROM invoice_snapshots WHERE sale_id IN (${inList(saleIds)})`,
        saleIds
      );
      await del(
        'sale_items',
        `DELETE FROM sale_items WHERE sale_id IN (${inList(saleIds)})`,
        saleIds
      );
      await del(
        'sales',
        `DELETE FROM sales WHERE id IN (${inList(saleIds)})`,
        saleIds
      );
    } else {
      deleted.bilty_items = 0;
      deleted.payments = 0;
      deleted.invoice_snapshots = 0;
      deleted.sale_items = 0;
      deleted.sales = 0;
    }

    // Sale-related customer ledger for this branch scope
    await del(
      'customer_ledger_entries',
      `DELETE FROM customer_ledger_entries
       WHERE scope_type = 'BRANCH' AND scope_id IN (?, ?, ?)`,
      SCOPE_VALUES
    );

    // Credit/debit txs for this branch
    await del(
      'credit_debit_transactions',
      `DELETE FROM credit_debit_transactions WHERE branch_id = ?`,
      [BRANCH_ID]
    );

    // Also wipe any leftover invoice_snapshots by scope
    await del(
      'invoice_snapshots_by_scope',
      `DELETE FROM invoice_snapshots
       WHERE scope_type = 'BRANCH' AND scope_id IN (?, ?, ?)`,
      SCOPE_VALUES
    );

    // --- Purchases ---
    if (poIds.length) {
      await del(
        'purchase_order_items',
        `DELETE FROM purchase_order_items WHERE purchase_order_id IN (${inList(poIds)})`,
        poIds
      );
      await del(
        'purchase_orders',
        `DELETE FROM purchase_orders WHERE id IN (${inList(poIds)})`,
        poIds
      );
    } else {
      deleted.purchase_order_items = 0;
      deleted.purchase_orders = 0;
    }

    // --- Inventory / stock ---
    await del(
      'inventory_ledger_entries',
      `DELETE FROM inventory_ledger_entries
       WHERE scope_type = 'BRANCH' AND scope_id IN (?, ?, ?)`,
      SCOPE_VALUES
    );

    await del(
      'stock_reports',
      `DELETE FROM stock_reports
       WHERE scope_type = 'BRANCH' AND scope_id IN (?, ?, ?)`,
      SCOPE_VALUES
    );

    await del(
      'stock_summary',
      `DELETE FROM stock_summary
       WHERE scope_type = 'BRANCH' AND scope_id IN (?, ?, ?)`,
      SCOPE_VALUES
    );

    // Stock movements involving this branch or its items/POs
    if (itemIds.length || poIds.length) {
      const parts = [];
      const params = [];
      if (itemIds.length) {
        parts.push(`inventory_item_id IN (${inList(itemIds)})`);
        params.push(...itemIds);
      }
      parts.push(`(from_scope_type = 'BRANCH' AND from_scope_id IN (?, ?, ?))`);
      params.push(...SCOPE_VALUES);
      parts.push(`(to_scope_type = 'BRANCH' AND to_scope_id IN (?, ?, ?))`);
      params.push(...SCOPE_VALUES);
      if (poIds.length) {
        parts.push(`purchase_order_id IN (${inList(poIds)})`);
        params.push(...poIds);
      }
      await del(
        'stock_movements',
        `DELETE FROM stock_movements WHERE ${parts.join(' OR ')}`,
        params
      );
    } else {
      deleted.stock_movements = 0;
      console.log('  deleted stock_movements: 0');
    }

    // Transfers involving this branch
    const [xfer] = await c.execute(
      `SELECT id FROM transfers WHERE to_branch_id = ? OR from_branch_id = ?`,
      [BRANCH_ID, BRANCH_ID]
    );
    const transferIds = xfer.map((r) => r.id);
    if (transferIds.length) {
      await del(
        'transfer_logs',
        `DELETE FROM transfer_logs WHERE transfer_id IN (${inList(transferIds)})`,
        transferIds
      );
      await del(
        'transfer_items',
        `DELETE FROM transfer_items WHERE transfer_id IN (${inList(transferIds)})`,
        transferIds
      );
      await del(
        'transfers',
        `DELETE FROM transfers WHERE id IN (${inList(transferIds)})`,
        transferIds
      );
    } else {
      deleted.transfer_logs = 0;
      deleted.transfer_items = 0;
      deleted.transfers = 0;
      console.log('  deleted transfers: 0');
    }

    if (itemIds.length) {
      await del(
        'inventory_items',
        `DELETE FROM inventory_items WHERE id IN (${inList(itemIds)})`,
        itemIds
      );
    } else {
      deleted.inventory_items = 0;
      console.log('  deleted inventory_items: 0');
    }

    // Verify leftovers
    const [[{ salesLeft }]] = await c.query(
      `SELECT COUNT(*) AS salesLeft FROM sales
       WHERE scope_type = 'BRANCH' AND scope_id IN (?, ?, ?)`,
      SCOPE_VALUES
    );
    const [[{ poLeft }]] = await c.query(
      `SELECT COUNT(*) AS poLeft FROM purchase_orders
       WHERE scope_type = 'BRANCH' AND scope_id IN (?, ?, ?)`,
      SCOPE_VALUES
    );
    const [[{ invLeft }]] = await c.query(
      `SELECT COUNT(*) AS invLeft FROM inventory_items
       WHERE scope_type = 'BRANCH' AND scope_id IN (?, ?, ?)`,
      SCOPE_VALUES
    );
    const [[{ ledLeft }]] = await c.query(
      `SELECT COUNT(*) AS ledLeft FROM inventory_ledger_entries
       WHERE scope_type = 'BRANCH' AND scope_id IN (?, ?, ?)`,
      SCOPE_VALUES
    );

    console.log('\nVERIFY leftovers:', { salesLeft, poLeft, invLeft, ledLeft });

    if (Number(salesLeft) || Number(poLeft) || Number(invLeft) || Number(ledLeft)) {
      throw new Error('Leftover rows remain — rolling back');
    }

    await c.commit();
    console.log('\nCOMMITTED. Summary:');
    console.log(JSON.stringify(deleted, null, 2));
  } catch (e) {
    await c.rollback();
    console.error('\nROLLED BACK:', e.message);
    process.exitCode = 1;
  } finally {
    await c.end();
  }
})();
