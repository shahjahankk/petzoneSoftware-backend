const InventoryItem = require('../models/InventoryItem');
const Sale = require('../models/Sale');
const HardwareDevice = require('../models/HardwareDevice');
const HardwareSession = require('../models/HardwareSession');
const Branch = require('../models/Branch');
const Warehouse = require('../models/Warehouse');
const { formatReceipt } = require('../utils/receiptFormatter');

// Barcode Scanner - Scan product
const scanBarcode = async (req, res) => {
  try {
    const { barcode, scopeType, scopeId } = req.body;
    
    // Validate scope exists
    await validateScope(scopeType, scopeId);
    
    // Find inventory item by barcode in the specified scope
    const inventoryItem = await InventoryItem.findOne({
      barcode: barcode,
      scopeType: scopeType,
      scopeId: scopeId
    });
    
    if (!inventoryItem) {
      return res.status(404).json({
        success: false,
        message: 'Product not found for this barcode',
        barcode: barcode
      });
    }
    
    // Create hardware session
    const session = await HardwareSession.createSession(
      req.user.id,
      scopeType,
      scopeId,
      req.body.terminalId || 'default',
      req.body.deviceId || 'scanner_001',
      'SCAN',
      {
        barcode: barcode,
        scannedItem: inventoryItem
      }
    );
    
    // Complete session
    await session.complete();
    
    res.status(200).json({
      success: true,
      message: 'Product scanned successfully',
      data: {
        sessionId: session.sessionId,
        item: inventoryItem,
        barcode: barcode
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error scanning barcode',
      error: error.message
    });
  }
};

// Receipt Printer - Print receipt/invoice
const printReceipt = async (req, res) => {
  try {
    const { saleId, scopeType, scopeId } = req.body;
    
    // Validate scope exists
    await validateScope(scopeType, scopeId);
    
    // Get sale details
    const sale = await Sale.findById(saleId);
    
    if (!sale) {
      return res.status(404).json({
        success: false,
        message: 'Sale not found'
      });
    }
    
    // Get scope details for header
    let scopeDetails;
    if (scopeType === 'BRANCH') {
      scopeDetails = await Branch.findById(scopeId);
    } else {
      scopeDetails = await Warehouse.findById(scopeId);
    }
    
    // Format receipt
    const receiptPayload = await formatReceipt(sale, scopeDetails, scopeType);
    
    // Create hardware session
    const session = await HardwareSession.createSession(
      req.user.id,
      scopeType,
      scopeId,
      req.body.terminalId || 'default',
      req.body.deviceId || 'printer_001',
      'PRINT',
      {
        saleId: saleId,
        printPayload: receiptPayload,
        printFormat: 'ESC_POS'
      }
    );
    
    // Complete session
    await session.complete();
    
    res.status(200).json({
      success: true,
      message: 'Receipt printed successfully',
      data: {
        sessionId: session.sessionId,
        saleId: saleId,
        payload: receiptPayload,
        format: 'ESC_POS'
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error printing receipt',
      error: error.message
    });
  }
};

// Cash Drawer - Open cash drawer
const openCashDrawer = async (req, res) => {
  try {
    const { scopeType, scopeId } = req.body;
    
    // Validate scope exists
    await validateScope(scopeType, scopeId);
    
    // Create hardware session
    const session = await HardwareSession.createSession(
      req.user.id,
      scopeType,
      scopeId,
      req.body.terminalId || 'default',
      req.body.deviceId || 'drawer_001',
      'OPEN_DRAWER',
      {
        drawerOpenTime: new Date()
      }
    );
    
    // Complete session immediately (drawer opening is instant)
    await session.complete({
      drawerCloseTime: new Date()
    });
    
    res.status(200).json({
      success: true,
      message: 'Cash drawer opened successfully',
      data: {
        sessionId: session.sessionId,
        scopeType: scopeType,
        scopeId: scopeId,
        openTime: new Date()
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error opening cash drawer',
      error: error.message
    });
  }
};

// Weighing Scale - Get weight and calculate price
const getWeight = async (req, res) => {
  try {
    const { itemId, weight } = req.body;
    
    // Get inventory item
    const inventoryItem = await InventoryItem.findById(itemId);
    
    if (!inventoryItem) {
      return res.status(404).json({
        success: false,
        message: 'Inventory item not found'
      });
    }
    
    // Calculate price based on weight
    let calculatedPrice = 0;
    if (inventoryItem.salePrice && weight > 0) {
      // Assuming salePrice is per unit, calculate based on weight
      calculatedPrice = inventoryItem.salePrice * weight;
    }
    
    // Create hardware session
    const session = await HardwareSession.createSession(
      req.user.id,
      inventoryItem.scopeType,
      inventoryItem.scopeId,
      req.body.terminalId || 'default',
      req.body.deviceId || 'scale_001',
      'WEIGH',
      {
        itemId: itemId,
        weight: weight,
        unit: 'KG',
        calculatedPrice: calculatedPrice
      }
    );
    
    // Complete session
    await session.complete();
    
    res.status(200).json({
      success: true,
      message: 'Weight calculated successfully',
      data: {
        sessionId: session.sessionId,
        itemId: itemId,
        weight: weight,
        unit: 'KG',
        calculatedPrice: calculatedPrice,
        item: inventoryItem
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error calculating weight',
      error: error.message
    });
  }
};

// Get hardware devices for scope
const getHardwareDevices = async (req, res) => {
  try {
    // Check if this is the /devices/all endpoint
    if (req.path === '/devices/all') {
      // Admin can see all devices across all scopes
      const devices = await HardwareDevice.findAll();
      
      res.status(200).json({
        success: true,
        data: devices
      });
      return;
    }
    
    const { scopeType, scopeId } = req.params;
    
    const devices = await HardwareDevice.findByScope(scopeType, scopeId);
    
    res.status(200).json({
      success: true,
      data: devices
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error retrieving hardware devices',
      error: error.message
    });
  }
};

// Register hardware device
const registerDevice = async (req, res) => {
  try {
    const { deviceId, name, type, scopeType, scopeId, terminalId, settings } = req.body;
    
    // Validate scope exists
    await validateScope(scopeType, scopeId);
    
    // Check if device already exists
    const existingDevice = await HardwareDevice.findOne({ deviceId });
    
    if (existingDevice) {
      return res.status(400).json({
        success: false,
        message: 'Device already registered'
      });
    }
    
    const device = await HardwareDevice.create({
      deviceId,
      name,
      type,
      scopeType,
      scopeId,
      terminalId,
      settings: settings || {},
      status: 'ONLINE'
    });
    
    res.status(201).json({
      success: true,
      message: 'Device registered successfully',
      data: device
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error registering device',
      error: error.message
    });
  }
};

// Update device status
const updateDeviceStatus = async (req, res) => {
  try {
    const { deviceId } = req.params;
    const { status } = req.body;
    
    const device = await HardwareDevice.findOne({ deviceId });
    
    if (!device) {
      return res.status(404).json({
        success: false,
        message: 'Device not found'
      });
    }
    
    await device.updateStatus(status);
    
    res.status(200).json({
      success: true,
      message: 'Device status updated successfully',
      data: device
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error updating device status',
      error: error.message
    });
  }
};

// Delete hardware device
const deleteDevice = async (req, res) => {
  try {
    const { id } = req.params;
    
    const device = await HardwareDevice.findById(id);
    
    if (!device) {
      return res.status(404).json({
        success: false,
        message: 'Device not found'
      });
    }
    
    const trashService = require('../services/trashService');
    await trashService.softDelete('hardware_device', id, req.user.id);
    
    res.status(200).json({
      success: true,
      message: 'Device moved to trash successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error deleting device',
      error: error.message
    });
  }
};

// Get hardware sessions
const getHardwareSessions = async (req, res) => {
  try {
    const { scopeType, scopeId, terminalId } = req.query;
    const { page = 1, limit = 20 } = req.query;
    
    let query = {};
    
    if (scopeType && scopeId) {
      query.scopeType = scopeType;
      query.scopeId = scopeId;
    }
    
    if (terminalId) {
      query.terminalId = terminalId;
    }
    
    const options = {
      sort: '-start_time',
      limit: parseInt(limit),
      skip: (parseInt(page) - 1) * parseInt(limit)
    };
    
    const sessions = await HardwareSession.find(query, options);
    const total = await HardwareSession.count(query);
    
    res.status(200).json({
      success: true,
      data: sessions,
      pagination: {
        current: parseInt(page),
        pages: Math.ceil(total / limit),
        total
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error retrieving hardware sessions',
      error: error.message
    });
  }
};

// Helper function to validate scope
const validateScope = async (scopeType, scopeId) => {
  let scope;
  
  switch (scopeType) {
    case 'BRANCH':
      scope = await Branch.findById(scopeId);
      break;
    case 'WAREHOUSE':
      scope = await Warehouse.findById(scopeId);
      break;
    default:
      throw new Error('Invalid scope type');
  }
  
  if (!scope) {
    throw new Error(`${scopeType} not found`);
  }
  
  return scope;
};


// Get latest hardware events (replaces WebSocket real-time updates)
const getLatestEvents = async (req, res) => {
  try {
    const { scopeType, scopeId, terminalId, limit = 10 } = req.query;
    
    let query = {};
    
    if (scopeType && scopeId) {
      query.scopeType = scopeType;
      query.scopeId = scopeId;
    }
    
    if (terminalId) {
      query.terminalId = terminalId;
    }
    
    const sessions = await HardwareSession.find(query, {
      sort: '-created_at',
      limit: parseInt(limit, 10) || 10,
    });
    
    const events = sessions.map(session => ({
      id: session.id,
      sessionId: session.sessionId,
      event: session.operation,
      userId: session.userId,
      scopeType: session.scopeType,
      scopeId: session.scopeId,
      terminalId: session.terminalId,
      data: session.data,
      status: session.status,
      timestamp: session.createdAt
    }));
    
    res.status(200).json({
      success: true,
      data: events,
      count: events.length
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error retrieving latest events',
      error: error.message
    });
  }
};

// Get hardware events since timestamp (for polling)
const getEventsSince = async (req, res) => {
  try {
    const { since, scopeType, scopeId, terminalId } = req.query;
    
    if (!since) {
      return res.status(400).json({
        success: false,
        message: 'Since timestamp is required'
      });
    }
    
    const query = { createdAfter: since };
    if (scopeType && scopeId) {
      query.scopeType = scopeType;
      query.scopeId = scopeId;
    }
    if (terminalId) {
      query.terminalId = terminalId;
    }
    
    const sessions = await HardwareSession.find(query, { sort: '-created_at' });
    
    const events = sessions.map(session => ({
      id: session.id,
      sessionId: session.sessionId,
      event: session.operation,
      userId: session.userId,
      scopeType: session.scopeType,
      scopeId: session.scopeId,
      terminalId: session.terminalId,
      data: session.data,
      status: session.status,
      timestamp: session.createdAt
    }));
    
    res.status(200).json({
      success: true,
      data: events,
      count: events.length,
      lastUpdate: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error retrieving events since timestamp',
      error: error.message
    });
  }
};

// Get hardware status summary
const getHardwareStatus = async (req, res) => {
  try {
    const { scopeType, scopeId } = req.query;
    
    let query = {};
    
    if (scopeType && scopeId) {
      query.scopeType = scopeType;
      query.scopeId = scopeId;
    }
    
    // Get device counts by status
    const devices = await HardwareDevice.find(query);
    const statusCounts = devices.reduce((acc, device) => {
      acc[device.status] = (acc[device.status] || 0) + 1;
      return acc;
    }, {});
    
    // Get recent activity
    const recentSessionsOptions = {
      sort: '-start_time',
      limit: 5
    };
    const recentSessions = await HardwareSession.find(query, recentSessionsOptions);
    
    res.status(200).json({
      success: true,
      data: {
        deviceCounts: statusCounts,
        totalDevices: devices.length,
        recentActivity: recentSessions.map(session => ({
          operation: session.operation,
          userId: session.userId,
          timestamp: session.startTime,
          status: session.status
        }))
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error retrieving hardware status',
      error: error.message
    });
  }
};

module.exports = {
  scanBarcode,
  printReceipt,
  openCashDrawer,
  getWeight,
  getHardwareDevices,
  registerDevice,
  updateDeviceStatus,
  deleteDevice,
  getHardwareSessions,
  getLatestEvents,
  getEventsSince,
  getHardwareStatus
};
