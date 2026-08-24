const { pool } = require('../config/database');

class AdminSettings {
  constructor(data) {
    this.id = data.id;
    this.settingKey = data.setting_key;
    this.settingValue = data.setting_value;
    this.description = data.description;
    this.createdAt = data.created_at;
    this.updatedAt = data.updated_at;
  }

  // Static method to get a setting value
  static async getSetting(key) {
    const [rows] = await pool.execute(
      'SELECT * FROM admin_settings WHERE setting_key = ?',
      [key]
    );
    
    if (rows.length === 0) return null;
    return rows[0].setting_value;
  }

  // Static method to set a setting value
  static async setSetting(key, value, description = null) {
    const [result] = await pool.execute(
      `INSERT INTO admin_settings (setting_key, setting_value, description) 
       VALUES (?, ?, ?) 
       ON DUPLICATE KEY UPDATE 
       setting_value = VALUES(setting_value),
       description = VALUES(description),
       updated_at = CURRENT_TIMESTAMP`,
      [key, value, description]
    );
    
    return result;
  }

  // Static method to get all settings
  static async getAllSettings() {
    const [rows] = await pool.execute(
      'SELECT * FROM admin_settings ORDER BY setting_key'
    );
    
    return rows.map(row => new AdminSettings(row));
  }

  // Static method to get default branch settings
  static async getDefaultBranchSettings() {
    const settings = await AdminSettings.getAllSettings();
    const branchDefaults = {};
    
    settings.forEach(setting => {
      if (setting.settingKey.startsWith('default_branch_')) {
        const key = setting.settingKey.replace('default_branch_', '');
        // Parse boolean values
        if (setting.settingValue === 'true') {
          branchDefaults[key] = true;
        } else if (setting.settingValue === 'false') {
          branchDefaults[key] = false;
        } else {
          branchDefaults[key] = setting.settingValue;
        }
      }
    });
    
    return branchDefaults;
  }

  // Static method to get default warehouse settings
  static async getDefaultWarehouseSettings() {
    const settings = await AdminSettings.getAllSettings();
    const warehouseDefaults = {};
    
    settings.forEach(setting => {
      if (setting.settingKey.startsWith('default_warehouse_')) {
        const key = setting.settingKey.replace('default_warehouse_', '');
        // Parse boolean values
        if (setting.settingValue === 'true') {
          warehouseDefaults[key] = true;
        } else if (setting.settingValue === 'false') {
          warehouseDefaults[key] = false;
        } else {
          warehouseDefaults[key] = setting.settingValue;
        }
      }
    });
    
    return warehouseDefaults;
  }

  // Static method to initialize default settings
  static async initializeDefaultSettings() {
    const defaultSettings = [
      // Branch default settings
      { key: 'default_branch_allowCashierInventoryEdit', value: 'true', description: 'Allow cashiers to edit inventory by default' },
      { key: 'default_branch_allowWarehouseInventoryEdit', value: 'true', description: 'Allow warehouse keepers to edit inventory by default' },
      { key: 'default_branch_allowWarehouseKeeperCompanyAdd', value: 'true', description: 'Allow warehouse keepers to add companies by default' },
      { key: 'default_branch_allowReturnsByCashier', value: 'true', description: 'Allow cashiers to process returns by default' },
      { key: 'default_branch_allowReturnsByWarehouseKeeper', value: 'true', description: 'Allow warehouse keepers to process returns by default' },
      { key: 'default_branch_openAccount', value: 'true', description: 'Enable open account by default' },
      { key: 'default_branch_autoProvisionPOS', value: 'true', description: 'Auto-provision POS terminals by default' },
      { key: 'default_branch_autoProvisionInventory', value: 'true', description: 'Auto-provision inventory by default' },
      { key: 'default_branch_autoProvisionLedger', value: 'true', description: 'Auto-provision ledger by default' },
      { key: 'default_branch_autoProvisionCreditDebit', value: 'true', description: 'Auto-provision credit/debit system by default' },
      
      // Warehouse default settings
      { key: 'default_warehouse_autoProvisionInventory', value: 'true', description: 'Auto-provision inventory by default' },
      { key: 'default_warehouse_autoProvisionCreditDebit', value: 'true', description: 'Auto-provision credit/debit system by default' },
      { key: 'default_warehouse_allowRetailerSales', value: 'true', description: 'Allow sales to retailers by default' },
      { key: 'default_warehouse_requireApprovalForSales', value: 'false', description: 'Require approval for sales by default' },
      { key: 'default_warehouse_independentOperation', value: 'true', description: 'Enable independent operation by default' }
    ];

    for (const setting of defaultSettings) {
      await AdminSettings.setSetting(setting.key, setting.value, setting.description);
    }
  }

  // Static method to update multiple settings
  static async updateSettings(settings) {
    const results = [];
    
    for (const [key, value] of Object.entries(settings)) {
      const result = await AdminSettings.setSetting(key, value);
      results.push(result);
    }
    
    return results;
  }

  // Static method to delete a setting
  static async deleteSetting(key) {
    const [result] = await pool.execute(
      'DELETE FROM admin_settings WHERE setting_key = ?',
      [key]
    );
    
    return result;
  }
}

module.exports = AdminSettings;
