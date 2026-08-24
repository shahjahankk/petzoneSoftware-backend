const { pool } = require('../config/database');

/** Escape string for use inside RegExp constructor / MariaDB REGEXP. */
function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

class InvoiceNumberService {
  static async resolveScopeCode(connection, scopeType, scopeId) {
    let code = '';
    let entityName = '';
    if (scopeType === 'BRANCH') {
      const [branches] = await connection.execute(
        'SELECT id, name, code FROM branches WHERE id = ? OR name = ?',
        [scopeId, scopeId]
      );
      if (branches.length === 0) throw new Error(`Branch not found: ${scopeId}`);
      const branch = branches[0];
      code = branch.code;
      entityName = branch.name;
      if (!code) {
        code = branch.name.substring(0, 4).toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (code.length < 2) code = `BR${branch.id.toString().padStart(2, '0')}`;
        await connection.execute('UPDATE branches SET code = ? WHERE id = ?', [code, branch.id]);
      }
    } else if (scopeType === 'WAREHOUSE') {
      const [warehouses] = await connection.execute(
        'SELECT id, name, code FROM warehouses WHERE id = ? OR name = ?',
        [scopeId, scopeId]
      );
      if (warehouses.length === 0) throw new Error(`Warehouse not found: ${scopeId}`);
      const warehouse = warehouses[0];
      code = warehouse.code;
      entityName = warehouse.name;
      if (!code) {
        code = warehouse.name.substring(0, 4).toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (code.length < 2) code = `WH${warehouse.id.toString().padStart(2, '0')}`;
        await connection.execute('UPDATE warehouses SET code = ? WHERE id = ?', [code, warehouse.id]);
      }
    } else {
      throw new Error(`Invalid scope type: ${scopeType}`);
    }
    if (!code) throw new Error(`No code found for ${scopeType}: ${scopeId}`);
    return { code, entityName };
  }

  static async generateSeriesInvoiceNumber(scopeType, scopeId, seriesTag) {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const { code } = await this.resolveScopeCode(connection, scopeType, scopeId);
      const seriesPattern = `^${escapeRegExp(code)}-${escapeRegExp(seriesTag)}-[0-9]+$`;
      const [maxRows] = await connection.execute(
        `SELECT invoice_no FROM sales WHERE invoice_no REGEXP ?
         ORDER BY CAST(SUBSTRING_INDEX(invoice_no, '-', -1) AS UNSIGNED) DESC LIMIT 1`,
        [seriesPattern]
      );
      let nextNumber = 1;
      if (maxRows.length > 0) {
        const match = maxRows[0].invoice_no.match(
          new RegExp(`^${escapeRegExp(code)}-${escapeRegExp(seriesTag)}-(\\d+)$`)
        );
        if (match) nextNumber = parseInt(match[1], 10) + 1;
      }
      let invoiceNumber = `${code}-${seriesTag}-${nextNumber.toString().padStart(6, '0')}`;
      const [existingRows] = await connection.execute('SELECT id FROM sales WHERE invoice_no = ?', [invoiceNumber]);
      if (existingRows.length > 0) {
        nextNumber += 1;
        invoiceNumber = `${code}-${seriesTag}-${nextNumber.toString().padStart(6, '0')}`;
      }
      await connection.commit();
      return invoiceNumber;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }
  /**
   * Generate invoice number with branch/warehouse code prefix and sequential numbering
   * Format: {CODE}-{000001}
   * Example: PTHL-000001, WH01-000001
   */
  static async generateInvoiceNumber(scopeType, scopeId) {
    const connection = await pool.getConnection();
    
    try {
      await connection.beginTransaction();
      
      // Get the code for the branch or warehouse
      let code = '';
      let entityName = '';
      
      if (scopeType === 'BRANCH') {
        const [branches] = await connection.execute(
          'SELECT id, name, code FROM branches WHERE id = ? OR name = ?',
          [scopeId, scopeId]
        );
        if (branches.length === 0) {
          throw new Error(`Branch not found: ${scopeId}`);
        }
        const branch = branches[0];
        code = branch.code;
        entityName = branch.name;
        
        // If no code exists, generate one from name
        if (!code) {
          code = branch.name.substring(0, 4).toUpperCase().replace(/[^A-Z0-9]/g, '');
          if (code.length < 2) {
            code = 'BR' + branch.id.toString().padStart(2, '0');
          }
          
          // Update the branch with the generated code
          await connection.execute(
            'UPDATE branches SET code = ? WHERE id = ?',
            [code, branch.id]
          );
        }
      } else if (scopeType === 'WAREHOUSE') {
        const [warehouses] = await connection.execute(
          'SELECT id, name, code FROM warehouses WHERE id = ? OR name = ?',
          [scopeId, scopeId]
        );
        if (warehouses.length === 0) {
          throw new Error(`Warehouse not found: ${scopeId}`);
        }
        const warehouse = warehouses[0];
        code = warehouse.code;
        entityName = warehouse.name;
        
        // If no code exists, generate one from name
        if (!code) {
          code = warehouse.name.substring(0, 4).toUpperCase().replace(/[^A-Z0-9]/g, '');
          if (code.length < 2) {
            code = 'WH' + warehouse.id.toString().padStart(2, '0');
          }
          
          // Update the warehouse with the generated code
          await connection.execute(
            'UPDATE warehouses SET code = ? WHERE id = ?',
            [code, warehouse.id]
          );
        }
      } else {
        throw new Error(`Invalid scope type: ${scopeType}`);
      }
      
      if (!code) {
        throw new Error(`No code found for ${scopeType}: ${scopeId}`);
      }
      
      // Flat sales only: {CODE}-{000001}. Exclude settlement/bilty rows (e.g. HYDWH-STL-000001),
      // which sort above HYDWH-000241 as strings and break ^CODE-(\\d+)$.
      const flatPattern = `^${escapeRegExp(code)}-[0-9]+$`;
      const [maxRows] = await connection.execute(
        `SELECT invoice_no FROM sales WHERE invoice_no REGEXP ?
         ORDER BY CAST(SUBSTRING_INDEX(invoice_no, '-', -1) AS UNSIGNED) DESC LIMIT 1`,
        [flatPattern]
      );

      let nextNumber = 1;
      if (maxRows.length > 0) {
        const lastInvoice = maxRows[0].invoice_no;
        const match = lastInvoice.match(new RegExp(`^${escapeRegExp(code)}-(\\d+)$`));
        if (match) {
          nextNumber = parseInt(match[1], 10) + 1;
        }
      }
      
      const invoiceNumber = `${code}-${nextNumber.toString().padStart(6, '0')}`;
      
      // Verify the invoice number doesn't already exist (extra safety check)
      const [existingRows] = await connection.execute(
        'SELECT id FROM sales WHERE invoice_no = ?',
        [invoiceNumber]
      );
      
      if (existingRows.length > 0) {
        // If it exists, increment and try again
        nextNumber++;
        const invoiceNumber2 = `${code}-${nextNumber.toString().padStart(6, '0')}`;
        
        await connection.commit();
        return invoiceNumber2;
      }
      
      await connection.commit();
      return invoiceNumber;
      
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  static async generateSettlementNumber(scopeType, scopeId) {
    return this.generateSeriesInvoiceNumber(scopeType, scopeId, 'STL');
  }

  static async generateBiltyNumber(scopeType, scopeId) {
    return this.generateSeriesInvoiceNumber(scopeType, scopeId, 'BIL');
  }
  
  /**
   * Generate invoice number with salesperson identification for warehouses
   * Format: {WAREHOUSE_CODE}-{SALESPERSON_CODE}-{000001}
   * Example: WH01-AHM-000001, WH01-SAL-000001
   */
  static async generateInvoiceNumberWithSalesperson(scopeType, scopeId, userId) {
    const connection = await pool.getConnection();
    
    try {
      await connection.beginTransaction();
      
      // Get the warehouse code
      let warehouseCode = '';
      if (scopeType === 'WAREHOUSE') {
        const [warehouses] = await connection.execute(
          'SELECT code FROM warehouses WHERE id = ? OR name = ?',
          [scopeId, scopeId]
        );
        if (warehouses.length === 0) {
          throw new Error(`Warehouse not found: ${scopeId}`);
        }
        warehouseCode = warehouses[0].code;
      } else {
        throw new Error(`Salesperson-specific numbering only supported for warehouses`);
      }
      
      if (!warehouseCode) {
        throw new Error(`No code found for warehouse: ${scopeId}`);
      }
      
      // Get salesperson code (first 3 letters of username)
      const [users] = await connection.execute(
        'SELECT username FROM users WHERE id = ?',
        [userId]
      );
      
      if (users.length === 0) {
        throw new Error(`User not found: ${userId}`);
      }
      
      const username = users[0].username;
      const salespersonCode = username.substring(0, 3).toUpperCase();
      
      // Get the next invoice number for this warehouse-salesperson combination
      const prefix = `${warehouseCode}-${salespersonCode}`;
      const [countRows] = await connection.execute(
        'SELECT COUNT(*) as count FROM sales WHERE invoice_no LIKE ?',
        [`${prefix}-%`]
      );
      
      const nextNumber = (countRows[0].count || 0) + 1;
      const invoiceNumber = `${prefix}-${nextNumber.toString().padStart(6, '0')}`;
      
      // Verify the invoice number doesn't already exist
      const [existingRows] = await connection.execute(
        'SELECT id FROM sales WHERE invoice_no = ?',
        [invoiceNumber]
      );
      
      if (existingRows.length > 0) {
        // If it exists, try the next number
        const [countRows2] = await connection.execute(
          'SELECT COUNT(*) as count FROM sales WHERE invoice_no LIKE ?',
          [`${prefix}-%`]
        );
        const nextNumber2 = countRows2[0].count + 1;
        const invoiceNumber2 = `${prefix}-${nextNumber2.toString().padStart(6, '0')}`;
        
        await connection.commit();
        return invoiceNumber2;
      }
      
      await connection.commit();
      return invoiceNumber;
      
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  /**
   * Generate invoice number with custom prefix
   * Format: {PREFIX}-{000001}
   */
  static async generateInvoiceNumberWithPrefix(prefix) {
    const connection = await pool.getConnection();
    
    try {
      await connection.beginTransaction();
      
      // Get the next invoice number for this prefix
      const [countRows] = await connection.execute(
        'SELECT COUNT(*) as count FROM sales WHERE invoice_no LIKE ?',
        [`${prefix}-%`]
      );
      
      const nextNumber = (countRows[0].count || 0) + 1;
      const invoiceNumber = `${prefix}-${nextNumber.toString().padStart(6, '0')}`;
      
      // Verify the invoice number doesn't already exist
      const [existingRows] = await connection.execute(
        'SELECT id FROM sales WHERE invoice_no = ?',
        [invoiceNumber]
      );
      
      if (existingRows.length > 0) {
        // If it exists, try the next number
        const [countRows2] = await connection.execute(
          'SELECT COUNT(*) as count FROM sales WHERE invoice_no LIKE ?',
          [`${prefix}-%`]
        );
        const nextNumber2 = countRows2[0].count + 1;
        const invoiceNumber2 = `${prefix}-${nextNumber2.toString().padStart(6, '0')}`;
        
        await connection.commit();
        return invoiceNumber2;
      }
      
      await connection.commit();
      return invoiceNumber;
      
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }
  
  /**
   * Get the next invoice number for a specific code without generating it
   * Useful for previewing what the next number will be
   */
  static async getNextInvoiceNumber(scopeType, scopeId) {
    const connection = await pool.getConnection();
    
    try {
      // Get the code for the branch or warehouse
      let code = '';
      if (scopeType === 'BRANCH') {
        const [branches] = await connection.execute(
          'SELECT code FROM branches WHERE id = ? OR name = ?',
          [scopeId, scopeId]
        );
        if (branches.length === 0) {
          throw new Error(`Branch not found: ${scopeId}`);
        }
        code = branches[0].code;
      } else if (scopeType === 'WAREHOUSE') {
        const [warehouses] = await connection.execute(
          'SELECT code FROM warehouses WHERE id = ? OR name = ?',
          [scopeId, scopeId]
        );
        if (warehouses.length === 0) {
          throw new Error(`Warehouse not found: ${scopeId}`);
        }
        code = warehouses[0].code;
      } else {
        throw new Error(`Invalid scope type: ${scopeType}`);
      }
      
      if (!code) {
        throw new Error(`No code found for ${scopeType}: ${scopeId}`);
      }

      const flatPattern = `^${escapeRegExp(code)}-[0-9]+$`;
      const [maxRows] = await connection.execute(
        `SELECT invoice_no FROM sales WHERE invoice_no REGEXP ?
         ORDER BY CAST(SUBSTRING_INDEX(invoice_no, '-', -1) AS UNSIGNED) DESC LIMIT 1`,
        [flatPattern]
      );
      let nextNumber = 1;
      if (maxRows.length > 0) {
        const m = maxRows[0].invoice_no.match(new RegExp(`^${escapeRegExp(code)}-(\\d+)$`));
        if (m) nextNumber = parseInt(m[1], 10) + 1;
      }
      return `${code}-${nextNumber.toString().padStart(6, '0')}`;
      
    } finally {
      connection.release();
    }
  }
  
  /**
   * Validate invoice number format
   * Should match pattern: {CODE}-{000001}
   */
  static validateInvoiceNumber(invoiceNumber) {
    const pattern = /^[A-Z0-9]+-\d{6}$/;
    return pattern.test(invoiceNumber);
  }
  
  /**
   * Extract code and number from invoice number
   * Returns: { code: 'PTHL', number: 1 }
   */
  static parseInvoiceNumber(invoiceNumber) {
    const match = invoiceNumber.match(/^([A-Z0-9]+)-(\d{6})$/);
    if (!match) {
      throw new Error(`Invalid invoice number format: ${invoiceNumber}`);
    }
    
    return {
      code: match[1],
      number: parseInt(match[2], 10)
    };
  }
  
  /**
   * Get invoice statistics for a specific code
   */
  static async getInvoiceStats(scopeType, scopeId) {
    const connection = await pool.getConnection();
    
    try {
      // Get the code for the branch or warehouse
      let code = '';
      if (scopeType === 'BRANCH') {
        const [branches] = await connection.execute(
          'SELECT code FROM branches WHERE id = ? OR name = ?',
          [scopeId, scopeId]
        );
        if (branches.length === 0) {
          throw new Error(`Branch not found: ${scopeId}`);
        }
        code = branches[0].code;
      } else if (scopeType === 'WAREHOUSE') {
        const [warehouses] = await connection.execute(
          'SELECT code FROM warehouses WHERE id = ? OR name = ?',
          [scopeId, scopeId]
        );
        if (warehouses.length === 0) {
          throw new Error(`Warehouse not found: ${scopeId}`);
        }
        code = warehouses[0].code;
      } else {
        throw new Error(`Invalid scope type: ${scopeType}`);
      }
      
      if (!code) {
        throw new Error(`No code found for ${scopeType}: ${scopeId}`);
      }

      const flatPattern = `^${escapeRegExp(code)}-[0-9]+$`;
      const [statsRows] = await connection.execute(
        `SELECT 
          (SELECT COUNT(*) FROM sales WHERE invoice_no REGEXP ?) AS total_invoices,
          (SELECT invoice_no FROM sales WHERE invoice_no REGEXP ? ORDER BY invoice_no ASC LIMIT 1) AS first_invoice,
          (SELECT invoice_no FROM sales WHERE invoice_no REGEXP ?
           ORDER BY CAST(SUBSTRING_INDEX(invoice_no, '-', -1) AS UNSIGNED) DESC LIMIT 1) AS last_invoice,
          (SELECT MIN(created_at) FROM sales WHERE invoice_no REGEXP ?) AS first_date,
          (SELECT MAX(created_at) FROM sales WHERE invoice_no REGEXP ?) AS last_date`,
        [flatPattern, flatPattern, flatPattern, flatPattern, flatPattern]
      );

      const stats = statsRows[0];
      let nextNumber = 1;
      if (stats.last_invoice) {
        const m = String(stats.last_invoice).match(new RegExp(`^${escapeRegExp(code)}-(\\d+)$`));
        if (m) nextNumber = parseInt(m[1], 10) + 1;
      }

      return {
        code,
        totalInvoices: stats.total_invoices || 0,
        firstInvoice: stats.first_invoice,
        lastInvoice: stats.last_invoice,
        firstDate: stats.first_date,
        lastDate: stats.last_date,
        nextInvoiceNumber: `${code}-${nextNumber.toString().padStart(6, '0')}`,
      };
      
    } finally {
      connection.release();
    }
  }
}

module.exports = InvoiceNumberService;
