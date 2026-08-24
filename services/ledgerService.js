const { pool } = require('../config/database');

const MONEY_EPS = 0.02;

class LedgerService {
  static assertPaymentSplit(totalAmount, paymentAmount, creditAmount) {
    const total = parseFloat(totalAmount) || 0;
    const pay = parseFloat(paymentAmount) || 0;
    const credit = parseFloat(creditAmount) || 0;
    if (total <= 0) return;
    // Skip when POS uses negative credit (customer advance / balance applied)
    if (pay < 0 || credit < 0) return;
    if (Math.abs(pay + credit - total) > MONEY_EPS) {
      throw new Error(
        `GL posting rejected: payment (${pay}) + credit (${credit}) must equal total (${total})`
      );
    }
  }

  /**
   * Record a sale transaction in the ledger with proper debit/credit entries.
   * @param {object} saleData
   * @param {import('mysql2/promise').PoolConnection} [externalConn] When set, runs inside caller's transaction (no commit/release).
   */
  static async recordSaleTransaction(saleData, externalConn = null) {
    const ownsConnection = !externalConn;
    const connection = externalConn || (await pool.getConnection());

    try {
      if (ownsConnection) await connection.beginTransaction();
      
      const {
        saleId,
        invoiceNo,
        scopeType,
        scopeId,
        totalAmount,
        paymentAmount,
        creditAmount,
        paymentMethod,
        customerInfo,
        userId,
        items = []
      } = saleData;
      
      this.assertPaymentSplit(totalAmount, paymentAmount, creditAmount);

      // Get or create ledger accounts (scoped chart of accounts)
      const cashAccount = await this.getOrCreateAccount('Cash Account', 'asset', scopeType, scopeId, connection);
      const salesRevenueAccount = await this.getOrCreateAccount('Sales Revenue', 'revenue', scopeType, scopeId, connection);
      const accountsReceivableAccount = await this.getOrCreateAccount('Accounts Receivable', 'asset', scopeType, scopeId, connection);
      const inventoryAccount = await this.getOrCreateAccount('Inventory', 'asset', scopeType, scopeId, connection);
      const costOfGoodsSoldAccount = await this.getOrCreateAccount('Cost of Goods Sold', 'expense', scopeType, scopeId, connection);
      
      // Calculate cost of goods sold
      let totalCost = 0;
      for (const item of items) {
        if (item.costPrice) {
          totalCost += item.costPrice * item.quantity;
        }
      }
      
      // Record the sale transaction with double-entry bookkeeping
      const transactionDate = new Date();
      
       // Check if user exists, if not use NULL
       const [users] = await connection.execute('SELECT id FROM users WHERE id = ?', [userId]);
       const validUserId = users.length > 0 ? userId : null;
       
       // 1. DEBIT: Cash Account (for payment received)
       if (paymentAmount > 0) {
         await this.createLedgerEntry(connection, {
           accountId: cashAccount.id,
           type: 'DEBIT',
           amount: paymentAmount,
           description: `Sale ${invoiceNo} - Cash Payment`,
           reference: 'SALE',
           referenceId: saleId,
           date: transactionDate,
           createdBy: validUserId
         });
       }
       
       // 2. DEBIT: Accounts Receivable (for credit amount)
       if (creditAmount > 0) {
         await this.createLedgerEntry(connection, {
           accountId: accountsReceivableAccount.id,
           type: 'DEBIT',
           amount: creditAmount,
           description: `Sale ${invoiceNo} - Credit to ${customerInfo?.name || 'Customer'}`,
           reference: 'SALE',
           referenceId: saleId,
           date: transactionDate,
           createdBy: validUserId
         });
       }
       
       // 3. CREDIT: Sales Revenue Account
       await this.createLedgerEntry(connection, {
         accountId: salesRevenueAccount.id,
         type: 'CREDIT',
         amount: totalAmount,
         description: `Sale ${invoiceNo} - Revenue`,
         reference: 'SALE',
         referenceId: saleId,
         date: transactionDate,
         createdBy: validUserId
       });
       
       // 4. DEBIT: Cost of Goods Sold (if items have cost data)
       if (totalCost > 0) {
         await this.createLedgerEntry(connection, {
           accountId: costOfGoodsSoldAccount.id,
           type: 'DEBIT',
           amount: totalCost,
           description: `Sale ${invoiceNo} - Cost of Goods Sold`,
           reference: 'SALE',
           referenceId: saleId,
           date: transactionDate,
           createdBy: validUserId
         });
         
         // 5. CREDIT: Inventory Account (reduce inventory value)
         await this.createLedgerEntry(connection, {
           accountId: inventoryAccount.id,
           type: 'CREDIT',
           amount: totalCost,
           description: `Sale ${invoiceNo} - Inventory Reduction`,
           reference: 'SALE',
           referenceId: saleId,
           date: transactionDate,
           createdBy: validUserId
         });
       }
      
      if (ownsConnection) await connection.commit();

      return {
        success: true,
        message: 'Sale transaction recorded in ledger',
        entries: [
          { account: 'Cash Account', type: 'DEBIT', amount: paymentAmount },
          { account: 'Accounts Receivable', type: 'DEBIT', amount: creditAmount },
          { account: 'Sales Revenue', type: 'CREDIT', amount: totalAmount },
          { account: 'Cost of Goods Sold', type: 'DEBIT', amount: totalCost },
          { account: 'Inventory', type: 'CREDIT', amount: totalCost }
        ]
      };
      
    } catch (error) {
      if (ownsConnection) await connection.rollback();
      throw error;
    } finally {
      if (ownsConnection) connection.release();
    }
  }
  
  /**
   * Get or create a ledger account (chart-of-accounts row in `ledgers`).
   */
  static async getOrCreateAccount(accountName, accountType, scopeType, scopeId, connection = null) {
    const conn = connection || (await pool.getConnection());
    const shouldRelease = !connection;

    try {
      const [existing] = await conn.execute(
        'SELECT * FROM ledgers WHERE account_name = ? AND scope_type = ? AND scope_id = ?',
        [accountName, scopeType, scopeId]
      );

      if (existing.length > 0) {
        return existing[0];
      }

      const [result] = await conn.execute(
        `INSERT INTO ledgers (account_name, account_type, balance, currency, status, description, scope_type, scope_id, party_type, party_id, created_at, updated_at)
         VALUES (?, ?, 0.00, 'PKR', 'ACTIVE', ?, ?, ?, 'SYSTEM', 'DEFAULT', NOW(), NOW())`,
        [accountName, accountType, `Auto-created ${accountType} account`, scopeType, scopeId]
      );

      const [newAccount] = await conn.execute('SELECT * FROM ledgers WHERE id = ?', [result.insertId]);
      return newAccount[0];
    } finally {
      if (shouldRelease) conn.release();
    }
  }
  
  /**
   * Create a ledger entry
   */
  static async createLedgerEntry(connection, entryData) {
    const {
      accountId,
      type,
      amount,
      description,
      reference,
      referenceId,
      date,
      createdBy
    } = entryData;
    
     // `ledger_entries.branch_id` stores the chart-of-accounts id (`ledgers.id`), not branches.id
     const [result] = await connection.execute(
       `INSERT INTO ledger_entries (entry_type, reference_id, description, debit_amount, credit_amount, branch_id, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
       [
         type,
         referenceId,
         description,
         type === 'DEBIT' ? amount : 0,
         type === 'CREDIT' ? amount : 0,
         accountId,
         createdBy || null,
       ]
     );
    
    // Update account balance
    if (type === 'DEBIT') {
      await connection.execute(
        'UPDATE ledgers SET balance = balance + ?, updated_at = NOW() WHERE id = ?',
        [amount, accountId]
      );
    } else if (type === 'CREDIT') {
      await connection.execute(
        'UPDATE ledgers SET balance = balance - ?, updated_at = NOW() WHERE id = ?',
        [amount, accountId]
      );
    }
    
    return result.insertId;
  }
  
  /**
   * Record a sales return transaction in the ledger with proper debit/credit entries
   * This reverses the original sale transaction following double-entry bookkeeping principles
   */
  static async recordReturnTransaction(returnData, externalConn = null) {
    const ownsConnection = !externalConn;
    const connection = externalConn || (await pool.getConnection());

    try {
      if (ownsConnection) await connection.beginTransaction();
      
      const {
        returnId,
        returnNo,
        originalSaleId,
        originalSale,
        scopeType,
        scopeId,
        totalRefund,
        items = [],
        userId
      } = returnData;
      
      
      // Get original sale details if not provided
      let sale = originalSale;
      if (!sale) {
        const [sales] = await connection.execute(
          'SELECT * FROM sales WHERE id = ?',
          [originalSaleId]
        );
        if (sales.length === 0) {
          throw new Error(`Original sale ${originalSaleId} not found`);
        }
        sale = sales[0];
      }
      
      const cashAccount = await this.getOrCreateAccount('Cash Account', 'asset', scopeType, scopeId, connection);
      const salesRevenueAccount = await this.getOrCreateAccount('Sales Revenue', 'revenue', scopeType, scopeId, connection);
      const accountsReceivableAccount = await this.getOrCreateAccount('Accounts Receivable', 'asset', scopeType, scopeId, connection);
      const inventoryAccount = await this.getOrCreateAccount('Inventory', 'asset', scopeType, scopeId, connection);
      const costOfGoodsSoldAccount = await this.getOrCreateAccount('Cost of Goods Sold', 'expense', scopeType, scopeId, connection);
      
      // Calculate original sale amounts
      const originalTotal = parseFloat(sale.total || sale.subtotal || 0);
      const originalPaymentAmount = parseFloat(sale.payment_amount || 0);
      const originalCreditAmount = parseFloat(sale.credit_amount || 0);
      const originalPaymentMethod = sale.payment_method || 'CASH';
      
      // Calculate refund proportions based on original payment method
      let refundToCash = 0;
      let refundToCredit = 0;
      
      if (originalTotal > 0) {
        if (originalPaymentMethod === 'FULLY_CREDIT' || originalPaymentAmount === 0) {
          // Original sale was fully credit, refund reduces Accounts Receivable
          refundToCredit = totalRefund;
        } else if (originalCreditAmount === 0) {
          // Original sale was fully paid, refund goes to Cash
          refundToCash = totalRefund;
        } else {
          // Original sale was partial payment, refund proportionally
          const paymentRatio = originalPaymentAmount / originalTotal;
          const creditRatio = originalCreditAmount / originalTotal;
          refundToCash = totalRefund * paymentRatio;
          refundToCredit = totalRefund * creditRatio;
        }
      }
      
      // Calculate cost of goods returned
      let totalCost = 0;
      for (const item of items) {
        if (item.costPrice && item.quantity) {
          totalCost += parseFloat(item.costPrice) * parseFloat(item.quantity);
        }
      }
      
      // Check if user exists
      const [users] = await connection.execute('SELECT id FROM users WHERE id = ?', [userId]);
      const validUserId = users.length > 0 ? userId : null;
      
      const transactionDate = new Date();
      
      // 1. CREDIT: Cash Account (if refunding cash)
      if (refundToCash > 0) {
        await this.createLedgerEntry(connection, {
          accountId: cashAccount.id,
          type: 'CREDIT',
          amount: refundToCash,
          description: `Return ${returnNo} - Cash Refund`,
          reference: 'RETURN',
          referenceId: returnId,
          date: transactionDate,
          createdBy: validUserId
        });
      }
      
      // 2. CREDIT: Accounts Receivable (if refunding credit)
      if (refundToCredit > 0) {
        await this.createLedgerEntry(connection, {
          accountId: accountsReceivableAccount.id,
          type: 'CREDIT',
          amount: refundToCredit,
          description: `Return ${returnNo} - Credit Reduction`,
          reference: 'RETURN',
          referenceId: returnId,
          date: transactionDate,
          createdBy: validUserId
        });
      }
      
      // 3. DEBIT: Sales Revenue Account (reverse the sale)
      await this.createLedgerEntry(connection, {
        accountId: salesRevenueAccount.id,
        type: 'DEBIT',
        amount: totalRefund,
        description: `Return ${returnNo} - Revenue Reversal`,
        reference: 'RETURN',
        referenceId: returnId,
        date: transactionDate,
        createdBy: validUserId
      });
      
      // 4. CREDIT: Cost of Goods Sold (reverse COGS)
      if (totalCost > 0) {
        await this.createLedgerEntry(connection, {
          accountId: costOfGoodsSoldAccount.id,
          type: 'CREDIT',
          amount: totalCost,
          description: `Return ${returnNo} - COGS Reversal`,
          reference: 'RETURN',
          referenceId: returnId,
          date: transactionDate,
          createdBy: validUserId
        });
        
        // 5. DEBIT: Inventory Account (restore inventory value)
        await this.createLedgerEntry(connection, {
          accountId: inventoryAccount.id,
          type: 'DEBIT',
          amount: totalCost,
          description: `Return ${returnNo} - Inventory Restoration`,
          reference: 'RETURN',
          referenceId: returnId,
          date: transactionDate,
          createdBy: validUserId
        });
      }
      
      if (ownsConnection) await connection.commit();

      return {
        success: true,
        message: 'Return transaction recorded in ledger',
        entries: [
          { account: 'Cash Account', type: 'CREDIT', amount: refundToCash },
          { account: 'Accounts Receivable', type: 'CREDIT', amount: refundToCredit },
          { account: 'Sales Revenue', type: 'DEBIT', amount: totalRefund },
          { account: 'Cost of Goods Sold', type: 'CREDIT', amount: totalCost },
          { account: 'Inventory', type: 'DEBIT', amount: totalCost }
        ]
      };
      
    } catch (error) {
      if (ownsConnection) await connection.rollback();
      throw error;
    } finally {
      if (ownsConnection) connection.release();
    }
  }
  
  /**
   * Record a partial payment (when customer pays remaining credit)
   */
  static async recordPartialPayment(paymentData) {
    const connection = await pool.getConnection();
    
    try {
      await connection.beginTransaction();
      
      const {
        saleId,
        invoiceNo,
        paymentAmount,
        scopeType,
        scopeId,
        userId
      } = paymentData;
      
      // Get accounts
      const cashAccount = await this.getOrCreateAccount('Cash Account', 'asset', scopeType, scopeId, connection);
      const accountsReceivableAccount = await this.getOrCreateAccount('Accounts Receivable', 'asset', scopeType, scopeId, connection);
      
      const transactionDate = new Date();
      
      // DEBIT: Cash Account (payment received)
      await this.createLedgerEntry(connection, {
        accountId: cashAccount.id,
        type: 'DEBIT',
        amount: paymentAmount,
        description: `Partial Payment for Sale ${invoiceNo}`,
        reference: 'PARTIAL_PAYMENT',
        referenceId: saleId,
        date: transactionDate,
        createdBy: userId
      });
      
      // CREDIT: Accounts Receivable (reduce credit balance)
      await this.createLedgerEntry(connection, {
        accountId: accountsReceivableAccount.id,
        type: 'CREDIT',
        amount: paymentAmount,
        description: `Partial Payment for Sale ${invoiceNo}`,
        reference: 'PARTIAL_PAYMENT',
        referenceId: saleId,
        date: transactionDate,
        createdBy: userId
      });
      
      await connection.commit();
      
      return {
        success: true,
        message: 'Partial payment recorded in ledger'
      };
      
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }
  
  /**
   * Remove all GL lines for a sale/settlement reference and adjust account balances.
   */
  static async removeEntriesForSaleReference(connection, referenceId) {
    const [entries] = await connection.execute(
      `SELECT id, debit_amount, credit_amount, branch_id
       FROM ledger_entries WHERE reference_id = ?`,
      [referenceId]
    );

    for (const e of entries) {
      const debit = parseFloat(e.debit_amount) || 0;
      const credit = parseFloat(e.credit_amount) || 0;
      if (debit > 0 && e.branch_id) {
        await connection.execute(
          'UPDATE ledgers SET balance = balance - ?, updated_at = NOW() WHERE id = ?',
          [debit, e.branch_id]
        );
      }
      if (credit > 0 && e.branch_id) {
        await connection.execute(
          'UPDATE ledgers SET balance = balance + ?, updated_at = NOW() WHERE id = ?',
          [credit, e.branch_id]
        );
      }
    }

    await connection.execute('DELETE FROM ledger_entries WHERE reference_id = ?', [referenceId]);
  }

  /**
   * Get ledger entries for a specific account
   */
  static async getAccountEntries(accountId, startDate = null, endDate = null) {
    const connection = await pool.getConnection();
    
    try {
      let query = `
        SELECT 
          le.*,
          l.account_name,
          l.account_type,
          u.username as created_by_name
        FROM ledger_entries le
        LEFT JOIN ledgers l ON le.branch_id = l.id
        LEFT JOIN users u ON le.created_by = u.id
        WHERE le.branch_id = ?
      `;
      const params = [accountId];
      
      if (startDate) {
        query += ' AND le.created_at >= ?';
        params.push(startDate);
      }

      if (endDate) {
        query += ' AND le.created_at <= ?';
        params.push(endDate);
      }

      query += ' ORDER BY le.created_at DESC, le.id DESC';
      
      const [entries] = await connection.execute(query, params);
      return entries;
      
    } finally {
      connection.release();
    }
  }
  
  /**
   * Get account balance
   */
  static async getAccountBalance(accountId) {
    const connection = await pool.getConnection();
    
    try {
      const [accounts] = await connection.execute(
        'SELECT balance FROM ledgers WHERE id = ?',
        [accountId]
      );
      
      return accounts.length > 0 ? parseFloat(accounts[0].balance) : 0;
      
    } finally {
      connection.release();
    }
  }
  
  /**
   * Get trial balance for a scope
   */
  static async getTrialBalance(scopeType, scopeId) {
    const connection = await pool.getConnection();
    
    try {
      const [accounts] = await connection.execute(
        `SELECT 
          account_name,
          account_type,
          balance,
          CASE 
            WHEN account_type IN ('asset', 'expense') THEN balance
            ELSE 0
          END as debit_balance,
          CASE 
            WHEN account_type IN ('liability', 'equity', 'revenue') THEN balance
            ELSE 0
          END as credit_balance
        FROM ledgers 
        WHERE scope_type = ? AND scope_id = ? AND status = 'ACTIVE'
        ORDER BY account_type, account_name`,
        [scopeType, scopeId]
      );
      
      const totalDebits = accounts.reduce((sum, acc) => sum + parseFloat(acc.debit_balance), 0);
      const totalCredits = accounts.reduce((sum, acc) => sum + parseFloat(acc.credit_balance), 0);
      
      return {
        accounts,
        totalDebits,
        totalCredits,
        isBalanced: Math.abs(totalDebits - totalCredits) < 0.01
      };
      
    } finally {
      connection.release();
    }
  }
}

module.exports = LedgerService;
