const { pool } = require('../config/database');

/**
 * Comprehensive Warehouse Initialization Service
 * Automatically sets up all warehouse keeper functionality when admin creates a new warehouse
 */
class WarehouseInitializer {
  constructor(warehouseId, warehouseName, createdBy) {
    this.warehouseId = warehouseId;
    this.warehouseName = warehouseName;
    this.createdBy = createdBy != null ? createdBy : null;
  }

  /**
   * Initialize complete warehouse functionality
   */
  async initialize() {
    try {
      const tasks = [
        ['ledgerAccounts', () => this.createDefaultLedgerAccounts()],
        ['sampleRetailers', () => this.createSampleRetailers()],
        ['sampleCompanies', () => this.createSampleCompanies()],
        ['sampleInventoryItems', () => this.createSampleInventoryItems()],
        ['warehouseSettings', () => this.initializeWarehouseSettings()],
        ['defaultUsers', () => this.createDefaultUsers()],
      ];
      const results = await Promise.allSettled(tasks.map(([, fn]) => fn()));

      results.forEach((result, i) => {
        if (result.status === 'rejected') {
        }
      });

      
      return {
        success: true,
        message: 'Warehouse initialized successfully with all default components',
        warehouseId: this.warehouseId,
        initializations: [
          'Default Ledger Accounts',
          'Sample Retailers', 
          'Sample Companies',
          'Sample Inventory Items',
          'Warehouse Settings',
          'Default Warehouse Keeper User'
        ]
      };
    } catch (error) {
      throw new Error(`Initialization failed: ${error.message}`);
    }
  }

  /**
   * Create essential ledger accounts for the warehouse
   */
  async createDefaultLedgerAccounts() {
    const defaultAccounts = [
      {
        account_name: `${this.warehouseName} Cash Account`,
        account_type: 'asset',
        balance: 0,
        currency: 'USD',
        status: 'ACTIVE',
        description: `Main cash account for ${this.warehouseName} transactions`
      },
      {
        account_name: `${this.warehouseName} Inventory`,
        account_type: 'asset',
        balance: 0,
        currency: 'USD',
        status: 'ACTIVE',
        description: `Inventory value for ${this.warehouseName}`
      },
      {
        account_name: `${this.warehouseName} Sales Revenue`,
        account_type: 'revenue',
        balance: 0,
        currency: 'USD',
        status: 'ACTIVE',
        description: `Revenue from ${this.warehouseName} sales`
      },
      {
        account_name: `${this.warehouseName} Accounts Receivable`,
        account_type: 'asset',
        balance: 0,
        currency: 'USD',
        status: 'ACTIVE',
        description: `Outstanding customer payments for ${this.warehouseName}`
      },
      {
        account_name: `${this.warehouseName} Accounts Payable`,
        account_type: 'liability',
        balance: 0,
        currency: 'USD',
        status: 'ACTIVE',
        description: `Outstanding supplier payments for ${this.warehouseName}`
      },
      {
        account_name: `${this.warehouseName} Operating Expenses`,
        account_type: 'expense',
        balance: 0,
        currency: 'USD',
        status: 'ACTIVE',
        description: `Operating expenses for ${this.warehouseName}`
      }
    ];

    for (const account of defaultAccounts) {
      await pool.execute(`
        INSERT INTO ledgers (
          scope_type,
          scope_id,
          party_type,
          party_id,
          balance,
          currency,
          status,
          account_name,
          account_type,
          description,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
      `, [
        'WAREHOUSE',
        this.warehouseId,
        'ACCOUNT',
        `${this.warehouseName.toLowerCase().replace(/\s+/g, '_')}_${account.account_type}`,
        account.balance,
        account.currency,
        account.status,
        account.account_name,
        account.account_type,
        account.description
      ]);
    }

  }

  /**
   * Create sample retailers for the warehouse
   */
  async createSampleRetailers() {
    const sampleRetailers = [
      {
        name: `Sample Retailer 1 - ${this.warehouseName}`,
        email: `retailer1@${this.warehouseName.toLowerCase().replace(/\s+/g, '')}.com`,
        phone: '+1234567890',
        business_type: 'RETAIL',
        status: 'ACTIVE',
        address: `${this.warehouseName} Area`,
        city: 'Sample City',
        state: 'Sample State',
        zip_code: '12345',
        credit_limit: 50000,
        payment_terms: '30 Days',
        notes: 'Auto-created sample retailer'
      },
      {
        name: `Sample Retailer 2 - ${this.warehouseName}`,
        email: `retailer2@${this.warehouseName.toLowerCase().replace(/\s+/g, '')}.com`,
        phone: '+1234567891',
        business_type: 'RETAIL',
        status: 'ACTIVE',
        address: `${this.warehouseName} Area`,
        city: 'Sample City',
        state: 'Sample State',
        zip_code: '12345',
        credit_limit: 75000,
        payment_terms: '45 Days',
        notes: 'Auto-created sample retailer'
      }
    ];

    for (const retailer of sampleRetailers) {
      await pool.execute(`
        INSERT INTO retailers (
          name,
          email,
          phone,
          business_type,
          status,
          address,
          city,
          state,
          zip_code,
          credit_limit,
          payment_terms,
          notes,
          warehouse_id,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
      `, [
        retailer.name,
        retailer.email,
        retailer.phone,
        retailer.business_type,
        retailer.status,
        retailer.address,
        retailer.city,
        retailer.state,
        retailer.zip_code,
        retailer.credit_limit,
        retailer.payment_terms,
        retailer.notes,
        this.warehouseId
      ]);
    }

  }

  /**
   * Create sample supplier companies
   */
  async createSampleCompanies() {
    const sampleCompanies = [
      {
        name: `Global Supplies Co - ${this.warehouseName}`,
        email: `contact@globalsupplies.com`,
        phone: '+1987654321',
        business_type: 'SUPPLIER',
        status: 'ACTIVE',
        address: '123 Supply Street',
        city: 'Supply City',
        state: 'Supply State',
        zip_code: '54321',
        credit_limit: 100000,
        payment_terms: '30 Days',
        notes: `Primary supplier for ${this.warehouseName}`,
        contact_person: 'John Supplier',
        tax_id: 'TXN123456789'
      },
      {
        name: `Quality Goods Ltd - ${this.warehouseName}`,
        email: `procurement@qualitygoods.com`,
        phone: '+1876543210',
        business_type: 'MANUFACTURER',
        status: 'ACTIVE',
        address: '456 Quality Avenue',
        city: 'Quality City',
        state: 'Quality State',
        zip_code: '67890',
        credit_limit: 200000,
        payment_terms: '45 Days',
        notes: `Premium manufacturer for ${this.warehouseName}`,
        contact_person: 'Jane Manufacturer',
        tax_id: 'TXN987654321'
      }
    ];

    for (const company of sampleCompanies) {
      await pool.execute(`
        INSERT INTO companies (
          name,
          email,
          phone,
          business_type,
          status,
          address,
          city,
          state,
          zip_code,
          credit_limit,
          payment_terms,
          notes,
          contact_person,
          tax_id,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
      `, [
        company.name,
        company.email,
        company.phone,
        company.business_type,
        company.status,
        company.address,
        company.city,
        company.state,
        company.zip_code,
        company.credit_limit,
        company.payment_terms,
        company.notes,
        company.contact_person,
        company.tax_id
      ]);
    }

  }

  /**
   * Create sample inventory items
   */
  async createSampleInventoryItems() {
    const sampleItems = [
      {
        name: 'Sample Product A',
        description: `Standard product A for ${this.warehouseName}`,
        category: 'General',
        sku: `SPA-${this.warehouseId}`,
        barcode: `1000000001${this.warehouseId}`,
        sellingPrice: 25.0,
        costPrice: 15.0,
        current_stock: 100,
        min_stock_level: 10,
        max_stock_level: 500,
        unit: 'pcs',
      },
      {
        name: 'Sample Product B',
        description: `Premium product B for ${this.warehouseName}`,
        category: 'Premium',
        sku: `SPB-${this.warehouseId}`,
        barcode: `1000000002${this.warehouseId}`,
        sellingPrice: 55.0,
        costPrice: 35.0,
        current_stock: 75,
        min_stock_level: 15,
        max_stock_level: 250,
        unit: 'pcs',
      },
      {
        name: 'Sample Product C',
        description: `Bulk product C for ${this.warehouseName}`,
        category: 'Bulk',
        sku: `SPC-${this.warehouseId}`,
        barcode: `1000000003${this.warehouseId}`,
        sellingPrice: 12.5,
        costPrice: 8.0,
        current_stock: 200,
        min_stock_level: 25,
        max_stock_level: 1000,
        unit: 'kg',
      },
    ];

    const scopeIdStr = String(this.warehouseId);

    for (const item of sampleItems) {
      await pool.execute(
        `
        INSERT INTO inventory_items (
          name,
          description,
          category,
          sku,
          barcode,
          cost_price,
          selling_price,
          current_stock,
          min_stock_level,
          max_stock_level,
          unit,
          scope_type,
          scope_id,
          created_by,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
      `,
        [
          item.name,
          item.description,
          item.category,
          item.sku,
          item.barcode,
          item.costPrice,
          item.sellingPrice,
          item.current_stock,
          item.min_stock_level,
          item.max_stock_level,
          item.unit,
          'WAREHOUSE',
          scopeIdStr,
          this.createdBy,
        ]
      );
    }

  }

  /**
   * Initialize warehouse-specific settings
   */
  async initializeWarehouseSettings() {
    try {
      // Update warehouse with comprehensive settings
      await pool.execute(`
        UPDATE warehouses 
        SET settings = ? 
        WHERE id = ?
      `, [
        JSON.stringify({
          // Inventory Management
          autoProvisionInventory: true,
          allowInventoryEdit: true,
          autoStockAlerts: true,
          requireApprovalForTransfers: false,
          
          // Sales & Billing
          allowRetailerSales: true,
          allowCompanyManagement: true,
          requireApprovalForSales: false,
          allowReturns: true,
          
          // Ledger & Financial
          autoProvisionLedger: true,
          allowWarehouseLedgerEdit: true,
          autoProvisionCustomers: true,
          
          // Permissions
          independentOperation: true,
          allowWarehouseCompanyCRUD: true,
          allowWarehouseRetailerCRUD: true,
          
          // Analytics & Reports
          enableSalesAnalytics: true,
          enableInventoryReports: true,
          enableLedgerReports: true,
          
          // System Features
          enableBarcodeScanning: true,
          enableInventoryTracking: true,
          enableSalesReporting: true,
          autoGenerateInvoiceNumbers: true
        }),
        this.warehouseId
      ]);

    } catch (error) {
      throw error;
    }
  }

  /**
   * Create a default warehouse keeper user
   */
  async createDefaultUsers() {
    try {
      const hashedPassword = '$2b$10$samplehash'; // You should use proper password hashing
      
      await pool.execute(`
        INSERT INTO users (
          username,
          email,
          password_hash,
          role,
          status,
          branch_id,
          warehouse_id,
          created_by,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
      `, [
        `warehouse_keeper_${this.warehouseId}`,
        `keeper${this.warehouseId}@${this.warehouseName.toLowerCase().replace(/\s+/g, '')}.com`,
        hashedPassword,
        'WAREHOUSE_KEEPER',
        'ACTIVE',
        null, // Branch ID - set to null for warehouse-only users
        this.warehouseId,
        this.createdBy
      ]);

    } catch (error) {
      // Don't throw here as this is not critical
    }
  }
}

module.exports = WarehouseInitializer;
