const { body, validationResult } = require('express-validator');

// ─────────────────────────────────────────────────────────────
// SHARED HELPER — import in any route that needs validation
// ─────────────────────────────────────────────────────────────
const handleValidation = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      message: 'Validation error',
      errors: errors.array()
    });
  }
  next();
};

// User validation for admin creation
const userValidation = [
  body('username')
    .trim()
    .isLength({ min: 3, max: 30 })
    .withMessage('Username must be between 3 and 30 characters')
    .matches(/^[a-zA-Z0-9_]+$/)
    .withMessage('Username can only contain letters, numbers, and underscores'),
  
  body('email')
    .isEmail()
    .normalizeEmail()
    .withMessage('Please provide a valid email address'),
  
  body('password')
    .isLength({ min: 6 })
    .withMessage('Password must be at least 6 characters long')
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
    .withMessage('Password must contain at least one lowercase letter, one uppercase letter, and one number'),
  
  body('role')
    .isIn(['ADMIN', 'WAREHOUSE_KEEPER', 'CASHIER'])
    .withMessage('Role must be ADMIN, WAREHOUSE_KEEPER, or CASHIER'),
  
  body('branchId')
    .optional()
    .custom((value) => {
      if (value === null || value === undefined || value === '') return true
      if (isNaN(value) || parseInt(value) < 1) {
        throw new Error('Branch ID must be a valid positive integer')
      }
      return true
    }),
  
  body('warehouseId')
    .optional()
    .custom((value) => {
      if (value === null || value === undefined || value === '') return true
      if (isNaN(value) || parseInt(value) < 1) {
        throw new Error('Warehouse ID must be a valid positive integer')
      }
      return true
    }),
  
  body('shift')
    .optional()
    .custom((value) => {
      if (value === null || value === undefined || value === '') return true
      if (!['MORNING', 'AFTERNOON', 'NIGHT'].includes(value)) {
        throw new Error('Shift must be MORNING, AFTERNOON, or NIGHT')
      }
      return true
    })
];

// User validation for admin updates (optional fields)
const userUpdateValidation = [
  body('username')
    .optional()
    .trim()
    .isLength({ min: 3, max: 30 })
    .withMessage('Username must be between 3 and 30 characters')
    .matches(/^[a-zA-Z0-9_]+$/)
    .withMessage('Username can only contain letters, numbers, and underscores'),
  
  body('email')
    .optional()
    .isEmail()
    .normalizeEmail()
    .withMessage('Please provide a valid email address'),
  
  body('password')
    .optional()
    .isLength({ min: 6 })
    .withMessage('Password must be at least 6 characters long')
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
    .withMessage('Password must contain at least one lowercase letter, one uppercase letter, and one number'),
  
  body('role')
    .optional()
    .isIn(['ADMIN', 'WAREHOUSE_KEEPER', 'CASHIER'])
    .withMessage('Role must be ADMIN, WAREHOUSE_KEEPER, or CASHIER'),
  
  body('branchId')
    .optional()
    .custom((value) => {
      if (value === null || value === undefined || value === '') return true
      if (isNaN(value) || parseInt(value) < 1) {
        throw new Error('Branch ID must be a valid positive integer')
      }
      return true
    }),
  
  body('warehouseId')
    .optional()
    .custom((value) => {
      if (value === null || value === undefined || value === '') return true
      if (isNaN(value) || parseInt(value) < 1) {
        throw new Error('Warehouse ID must be a valid positive integer')
      }
      return true
    }),
  
  body('shift')
    .optional()
    .custom((value) => {
      if (value === null || value === undefined || value === '') return true
      if (!['MORNING', 'AFTERNOON', 'NIGHT'].includes(value)) {
        throw new Error('Shift must be MORNING, AFTERNOON, or NIGHT')
      }
      return true
    })
];

const loginValidation = [
  body('email')
    .isEmail()
    .normalizeEmail()
    .withMessage('Please provide a valid email address'),
  
  body('password')
    .notEmpty()
    .withMessage('Password is required')
];

const refreshValidation = [
  body('refreshToken')
    .optional()
    .notEmpty()
    .withMessage('Refresh token is required')
];

// Branch validation
const branchValidation = [
  body('name')
    .trim()
    .isLength({ min: 1, max: 100 })
    .withMessage('Branch name must be between 1 and 100 characters'),
  
  body('code')
    .trim()
    .isLength({ min: 1, max: 10 })
    .withMessage('Branch code must be between 1 and 10 characters')
    .matches(/^[a-zA-Z0-9\-_]+$/)
    .withMessage('Branch code can only contain letters, numbers, hyphens, and underscores'),
  
  body('location')
    .trim()
    .isLength({ min: 1, max: 200 })
    .withMessage('Location must be between 1 and 200 characters'),
  
  body('phone')
    .optional()
    .custom((value) => {
      if (!value || value.trim() === '') {
        return true;
      }
      if (value.length > 20) {
        throw new Error('Phone must not exceed 20 characters');
      }
      return true;
    })
    .withMessage('Phone must not exceed 20 characters'),
  
  body('email')
    .optional()
    .custom((value) => {
      if (!value || value.trim() === '') {
        return true;
      }
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
    })
    .withMessage('Email must be a valid email address'),
  
  body('managerName')
    .optional()
    .custom((value) => {
      if (!value || value.trim() === '') {
        return true;
      }
      if (value.length > 100) {
        throw new Error('Manager name must not exceed 100 characters');
      }
      return true;
    })
    .withMessage('Manager name must not exceed 100 characters'),
  
  body('managerPhone')
    .optional()
    .custom((value) => {
      if (!value || value.trim() === '') {
        return true;
      }
      if (value.length > 20) {
        throw new Error('Manager phone must not exceed 20 characters');
      }
      return true;
    })
    .withMessage('Manager phone must not exceed 20 characters'),
  
  body('managerEmail')
    .optional()
    .custom((value) => {
      if (!value || value.trim() === '') {
        return true;
      }
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
    })
    .withMessage('Manager email must be a valid email address'),
  
  body('linkedWarehouseId')
    .optional({ nullable: true })
    .custom((value) => {
      if (value === null || value === undefined || value === '') {
        return true;
      }
      if (!Number.isInteger(Number(value)) || Number(value) < 1) {
        throw new Error('Linked warehouse ID must be a valid positive integer');
      }
      return true;
    }),
  
  body('status')
    .optional()
    .isIn(['active', 'inactive', 'maintenance'])
    .withMessage('Status must be active, inactive, or maintenance'),
  
  body('settings.openAccount')
    .optional()
    .isBoolean()
    .withMessage('Open account setting must be a boolean'),
  
  body('settings.allowCashierInventoryEdit')
    .optional()
    .isBoolean()
    .withMessage('Allow cashier inventory edit must be a boolean'),
  
  body('settings.allowWarehouseInventoryEdit')
    .optional()
    .isBoolean()
    .withMessage('Allow warehouse inventory edit must be a boolean'),
  
  body('settings.allowWarehouseKeeperCompanyAdd')
    .optional()
    .isBoolean()
    .withMessage('Allow warehouse keeper company add must be a boolean'),
  
  body('settings.allowReturnsByCashier')
    .optional()
    .isBoolean()
    .withMessage('Allow returns by cashier must be a boolean'),
  
  body('settings.allowReturnsByWarehouseKeeper')
    .optional()
    .isBoolean()
    .withMessage('Allow returns by warehouse keeper must be a boolean'),
  
  body('settings.allowCashierSalesEdit')
    .optional()
    .isBoolean()
    .withMessage('Allow cashier sales edit must be a boolean'),
  
  body('settings.allowCashierSalesDelete')
    .optional()
    .isBoolean()
    .withMessage('Allow cashier sales delete must be a boolean'),
];

// Shared chains — POST requires core fields; PUT allows partial updates (all optional when absent).
const warehouseOptionalNumberFields = [
  body('capacity')
    .optional({ nullable: true, checkFalsy: true })
    .custom((value) => {
      if (value === null || value === undefined || value === '') return true
      if (isNaN(value)) return false
      return true
    })
    .withMessage('Capacity must be a valid number'),

  body('stock')
    .optional({ nullable: true, checkFalsy: true })
    .custom((value) => {
      if (value === null || value === undefined || value === '') return true
      if (isNaN(value)) return false
      return true
    })
    .withMessage('Stock must be a valid number'),

  body('manager')
    .optional({ nullable: true, checkFalsy: true })
    .trim()
    .isLength({ max: 100 })
    .withMessage('Manager name must not exceed 100 characters'),

  body('phone')
    .optional({ nullable: true, checkFalsy: true })
    .trim()
    .isLength({ max: 50 })
    .withMessage('Phone must not exceed 50 characters'),

  body('status')
    .optional({ nullable: true, checkFalsy: true })
    .isIn(['active', 'inactive', 'maintenance'])
    .withMessage('Status must be active, inactive, or maintenance'),

  body('linkedBranchId')
    .optional({ nullable: true, checkFalsy: true })
    .isInt({ min: 1 })
    .withMessage('Linked branch ID must be a valid positive integer'),
];

/** POST /api/warehouses — full create */
const warehouseCreateValidation = [
  body('name')
    .trim()
    .isLength({ min: 1, max: 100 })
    .withMessage('Warehouse name must be between 1 and 100 characters'),

  body('code')
    .trim()
    .isLength({ min: 1, max: 10 })
    .withMessage('Warehouse code must be between 1 and 10 characters')
    .matches(/^[A-Z0-9]+$/)
    .withMessage('Warehouse code can only contain uppercase letters and numbers'),

  body('location')
    .trim()
    .isLength({ min: 1, max: 200 })
    .withMessage('Location must be between 1 and 200 characters'),

  ...warehouseOptionalNumberFields,
];

/** PUT /api/warehouses/:id — partial update; validate only fields that are sent */
const warehouseUpdateValidation = [
  body('name')
    .optional()
    .trim()
    .isLength({ min: 1, max: 100 })
    .withMessage('Warehouse name must be between 1 and 100 characters'),

  body('code')
    .optional()
    .trim()
    .isLength({ min: 1, max: 10 })
    .withMessage('Warehouse code must be between 1 and 10 characters')
    .matches(/^[A-Z0-9]+$/)
    .withMessage('Warehouse code can only contain uppercase letters and numbers'),

  body('location')
    .optional()
    .trim()
    .isLength({ min: 1, max: 200 })
    .withMessage('Location must be between 1 and 200 characters'),

  ...warehouseOptionalNumberFields,
];

/** @deprecated use warehouseCreateValidation / warehouseUpdateValidation */
const warehouseValidation = warehouseCreateValidation;

// Inventory item validation
const inventoryItemValidation = [
  body('name')
    .trim()
    .isLength({ min: 1, max: 200 })
    .withMessage('Item name must be between 1 and 200 characters'),
  body('sku')
    .optional()
    .custom(() => {
      throw new Error('SKU is system-generated and cannot be provided');
    }),
  body('barcode').optional().trim(),
  body('category').optional().trim(),
  body('unit').optional().trim(),
  body('costPrice').optional().isFloat({ min: 0 }).withMessage('Cost price must be a positive number'),
  body('sellingPrice').optional().isFloat({ min: 0 }).withMessage('Selling price must be a positive number'),
  body('currentStock').optional().isInt({ min: 0 }).withMessage('Current stock must be a non-negative integer'),
  body('minStockLevel').optional().isInt({ min: 0 }),
  body('maxStockLevel').optional().isInt({ min: 0 }),
  body('scopeType')
    .isIn(['BRANCH', 'WAREHOUSE'])
    .withMessage('Scope type must be BRANCH or WAREHOUSE'),
  body('scopeId')
    .custom((value) => value !== null && value !== undefined && String(value).trim() !== '')
    .withMessage('Scope ID is required')
    .customSanitizer(value => String(value).trim()),
];

// Inventory update validation (more lenient than create validation)
const inventoryItemUpdateValidation = [
  body('sku')
    .optional()
    .custom(() => {
      throw new Error('SKU is immutable and cannot be updated');
    }),
  
  body('barcode')
    .optional()
    .custom((value) => {
      if (value === '' || value === null || value === undefined) {
        return true;
      }
      if (typeof value === 'string' && value.trim().length === 0) {
        return true;
      }
      if (typeof value === 'string' && value.trim().length >= 1 && value.trim().length <= 50) {
        return true;
      }
      throw new Error('Barcode must be between 1 and 50 characters');
    })
    .withMessage('Barcode must be between 1 and 50 characters'),
  
  body('name')
    .optional()
    .trim()
    .isLength({ min: 1, max: 200 })
    .withMessage('Item name must be between 1 and 200 characters'),
  
  body('category')
    .optional()
    .trim()
    .isLength({ min: 1, max: 100 })
    .withMessage('Category must be between 1 and 100 characters'),
  
  body('unit')
    .optional()
    .trim()
    .isLength({ min: 1, max: 20 })
    .withMessage('Unit must be between 1 and 20 characters'),
  
  body('costPrice')
    .optional()
    .isFloat({ min: 0 })
    .withMessage('Cost price must be a positive number'),
  
  body('sellingPrice')
    .optional()
    .isFloat({ min: 0 })
    .withMessage('Selling price must be a positive number'),
  
  body('currentStock')
    .optional()
    .isInt({ min: 0 })
    .withMessage('Current stock must be a non-negative integer'),
  
  body('minStockLevel')
    .optional()
    .isInt({ min: 0 })
    .withMessage('Minimum stock level must be a non-negative integer'),
  
  body('maxStockLevel')
    .optional()
    .isInt({ min: 0 })
    .withMessage('Maximum stock level must be a non-negative integer'),
  
  body('scopeType')
    .optional()
    .isIn(['BRANCH', 'WAREHOUSE'])
    .withMessage('Scope type must be BRANCH or WAREHOUSE'),
  
  body('scopeId')
    .optional()
    .custom((value) => {
      if (value === null || value === undefined || value === '') {
        return true;
      }
      const strValue = String(value);
      return strValue.length >= 1;
    })
    .withMessage('Scope ID must be a valid string or number')
    .customSanitizer(value => {
      if (value !== null && value !== undefined) {
        return String(value);
      }
      return value;
    })
];

// Company validation
const companyValidation = [
  body('name')
    .trim()
    .isLength({ min: 1, max: 200 })
    .withMessage('Company name must be between 1 and 200 characters'),
  
  body('contactPerson')
    .optional()
    .trim()
    .isLength({ min: 1, max: 200 })
    .withMessage('Contact person must be between 1 and 200 characters'),
  
  body('email')
    .optional()
    .isEmail()
    .withMessage('Valid email is required'),
  
  body('phone')
    .optional()
    .trim()
    .isLength({ min: 1, max: 50 })
    .withMessage('Phone number must be between 1 and 50 characters'),
  
  body('address')
    .optional()
    .trim()
    .isLength({ min: 1, max: 500 })
    .withMessage('Address must be between 1 and 500 characters'),
  
  body('status')
    .optional()
    .isIn(['ACTIVE', 'INACTIVE', 'SUSPENDED', 'active', 'inactive', 'suspended'])
    .withMessage('Status must be active, inactive, or suspended'),
  
  body('transactionType')
    .optional()
    .isIn(['CASH', 'CREDIT', 'CARD', 'DIGITAL'])
    .withMessage('Transaction type must be CASH, CREDIT, CARD, or DIGITAL'),
  
  body('scopeType')
    .optional()
    .isIn(['BRANCH', 'WAREHOUSE', 'COMPANY'])
    .withMessage('Scope type must be BRANCH, WAREHOUSE, or COMPANY'),
  
  body('scopeId')
    .optional()
    .custom((value) => {
      if (value === null || value === undefined || value === '') {
        return true;
      }
      const strValue = String(value);
      return strValue.length >= 1 && strValue.length <= 100;
    })
    .withMessage('Scope ID must be between 1 and 100 characters')
    .customSanitizer(value => {
      if (value !== null && value !== undefined) {
        return String(value);
      }
      return value;
    })
];

// Sales validation
const validateSale = [
  body('items')
    .isArray({ min: 1 })
    .withMessage('At least one item is required'),
  
  body('items.*.inventoryItemId')
    .optional({ nullable: true })
    .custom((value) => {
      if (value === null || value === undefined || value === '') {
        return true;
      }
      const num = parseInt(value);
      if (isNaN(num) || num < 1) {
        throw new Error('Inventory item ID must be a valid positive integer');
      }
      return true;
    })
    .withMessage('Inventory item ID must be a valid positive integer or null for clinic/manual items'),

  body('items.*.clinicServiceId')
    .optional({ nullable: true })
    .custom((value) => {
      if (value === null || value === undefined || value === '') {
        return true;
      }
      const num = parseInt(value);
      if (isNaN(num) || num < 1) {
        throw new Error('Clinic service ID must be a valid positive integer');
      }
      return true;
    }),
  
  body('items.*.quantity')
    .isFloat({ min: 0.01 })
    .withMessage('Quantity must be greater than 0'),
  
  body('items.*.unitPrice')
    .isFloat({ min: 0 })
    .withMessage('Unit price must be a positive number'),
  
  body('items.*.discount')
    .optional()
    .custom((value) => {
      if (value === '' || value === null || value === undefined) {
        return true;
      }
      const num = parseFloat(value);
      if (isNaN(num) || num < 0) {
        throw new Error('Discount must be a non-negative number');
      }
      return true;
    })
    .withMessage('Discount must be a non-negative number'),
  
  body('scopeType')
    .isIn(['BRANCH', 'WAREHOUSE'])
    .withMessage('Scope type must be BRANCH or WAREHOUSE'),
  
  body('scopeId')
    .custom((value) => {
      if (value === null || value === undefined || value === '') {
        throw new Error('Scope ID is required');
      }
      return String(value).length >= 1;
    })
    .withMessage('Scope ID must be a valid string or number')
    .customSanitizer(value => String(value)),
  
  body('subtotal')
    .optional()
    .isFloat({ min: 0 })
    .withMessage('Subtotal must be a non-negative number'),
  
  body('tax')
    .optional()
    .custom((value) => {
      if (value === '' || value === null || value === undefined) {
        return true;
      }
      const num = parseFloat(value);
      if (isNaN(num) || num < 0) {
        throw new Error('Tax must be a non-negative number');
      }
      return true;
    })
    .withMessage('Tax must be a non-negative number'),
  
  body('discount')
    .optional()
    .custom((value) => {
      if (value === '' || value === null || value === undefined) {
        return true;
      }
      const num = parseFloat(value);
      if (isNaN(num) || num < 0) {
        throw new Error('Discount must be a non-negative number');
      }
      return true;
    })
    .withMessage('Discount must be a non-negative number'),
  
  body('total')
    .optional()
    .custom((value) => {
      if (value === undefined || value === null || value === '') {
        return true;
      }
      const num = parseFloat(value);
      return !isNaN(num);
    })
    .withMessage('Total must be a valid number'),
  
  body('paymentStatus')
    .optional()
    .isIn(['PENDING', 'COMPLETED', 'FAILED', 'REFUNDED', 'PARTIAL'])
    .withMessage('Payment status must be PENDING, COMPLETED, FAILED, REFUNDED, or PARTIAL'),
  
  body('status')
    .optional()
    .isIn(['PENDING', 'COMPLETED', 'CANCELLED'])
    .withMessage('Status must be PENDING, COMPLETED, or CANCELLED'),
  
  body('paymentMethod')
    .isIn(['CASH', 'CARD', 'BANK_TRANSFER', 'MOBILE_PAYMENT', 'FULLY_CREDIT', 'PARTIAL_PAYMENT'])
    .withMessage('Payment method must be CASH, CARD, BANK_TRANSFER, MOBILE_PAYMENT, FULLY_CREDIT, or PARTIAL_PAYMENT'),
  
  body('paymentAmount')
    .optional()
    .custom((value) => {
      if (value === undefined || value === null || value === '') {
        return true;
      }
      const num = parseFloat(value);
      return !isNaN(num);
    })
    .withMessage('Payment amount must be a valid number'),
  
  body('creditAmount')
    .optional()
    .custom((value) => {
      if (value === undefined || value === null || value === '') {
        return true;
      }
      const num = parseFloat(value);
      return !isNaN(num);
    })
    .withMessage('Credit amount must be a valid number'),
  
  body('creditStatus')
    .optional()
    .isIn(['NONE', 'PENDING', 'PAID', 'OVERDUE'])
    .withMessage('Credit status must be NONE, PENDING, PAID, or OVERDUE'),
  
  body('customerInfo.name')
    .optional()
    .trim()
    .isLength({ max: 100 })
    .withMessage('Customer name cannot exceed 100 characters'),
  
  body('customerInfo.phone')
    .optional()
    .trim()
    .isLength({ max: 20 })
    .withMessage('Customer phone cannot exceed 20 characters'),
  
  body('customerInfo.email')
    .optional()
    .custom((value) => {
      if (value === '' || value === null || value === undefined) {
        return true;
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
        throw new Error('Customer email must be a valid email address');
      }
      return true;
    })
    .withMessage('Customer email must be a valid email address'),
  
  body('customerInfo.address')
    .optional()
    .trim()
    .isLength({ max: 200 })
    .withMessage('Customer address cannot exceed 200 characters'),
  
  body('notes')
    .optional()
    .trim()
    .isLength({ max: 500 })
    .withMessage('Notes cannot exceed 500 characters'),
  
  body('paymentType')
    .optional()
    .custom((value) => {
      if (value === null || value === undefined || value === '') {
        return true;
      }
      const validTypes = ['FULL_PAYMENT', 'PARTIAL_PAYMENT', 'FULLY_CREDIT'];
      if (validTypes.includes(value)) {
        return true;
      }
      throw new Error('Payment type must be FULL_PAYMENT, PARTIAL_PAYMENT, or FULLY_CREDIT');
    })
    .withMessage('Payment type must be FULL_PAYMENT, PARTIAL_PAYMENT, or FULLY_CREDIT')
];

// Sale update validation
const validateSaleUpdate = [
  body('subtotal')
    .optional()
    .isFloat({ min: 0 })
    .withMessage('Subtotal must be a non-negative number'),
  
  body('tax')
    .optional()
    .custom((value) => {
      if (value === '' || value === null || value === undefined) {
        return true;
      }
      const num = parseFloat(value);
      if (isNaN(num) || num < 0) {
        throw new Error('Tax must be a non-negative number');
      }
      return true;
    })
    .withMessage('Tax must be a non-negative number'),
  
  body('discount')
    .optional()
    .custom((value) => {
      if (value === '' || value === null || value === undefined) {
        return true;
      }
      const num = parseFloat(value);
      if (isNaN(num) || num < 0) {
        throw new Error('Discount must be a non-negative number');
      }
      return true;
    })
    .withMessage('Discount must be a non-negative number'),
  
  body('total')
    .optional()
    .custom((value) => {
      if (value === undefined || value === null || value === '') {
        return true;
      }
      const num = parseFloat(value);
      return !isNaN(num);
    })
    .withMessage('Total must be a valid number'),
  
  body('paymentStatus')
    .optional()
    .isIn(['PENDING', 'COMPLETED', 'FAILED', 'REFUNDED', 'PARTIAL'])
    .withMessage('Payment status must be PENDING, COMPLETED, FAILED, REFUNDED, or PARTIAL'),
  
  body('status')
    .optional()
    .isIn(['PENDING', 'COMPLETED', 'CANCELLED'])
    .withMessage('Status must be PENDING, COMPLETED, or CANCELLED'),
  
  body('paymentMethod')
    .optional()
    .isIn(['CASH', 'CARD', 'BANK_TRANSFER', 'MOBILE_PAYMENT', 'FULLY_CREDIT', 'PARTIAL_PAYMENT'])
    .withMessage('Payment method must be CASH, CARD, BANK_TRANSFER, MOBILE_PAYMENT, FULLY_CREDIT, or PARTIAL_PAYMENT'),
  
  body('customerName')
    .optional()
    .trim()
    .isLength({ max: 100 })
    .withMessage('Customer name cannot exceed 100 characters'),
  
  body('customerPhone')
    .optional()
    .trim()
    .isLength({ max: 20 })
    .withMessage('Customer phone cannot exceed 20 characters'),
  
  body('customerEmail')
    .optional()
    .custom((value) => {
      if (value === '' || value === null || value === undefined) {
        return true;
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
        throw new Error('Customer email must be a valid email address');
      }
      return true;
    })
    .withMessage('Customer email must be a valid email address'),
  
  body('customerAddress')
    .optional()
    .trim()
    .isLength({ max: 200 })
    .withMessage('Customer address cannot exceed 200 characters'),
  
  body('notes')
    .optional()
    .trim()
    .isLength({ max: 500 })
    .withMessage('Notes cannot exceed 500 characters')
];

// Return validation
const validateReturn = [
  body('saleId')
    .isInt({ min: 1 })
    .withMessage('Sale ID must be a valid positive integer'),
  
  body('items')
    .isArray({ min: 1 })
    .withMessage('At least one item is required for return'),
  
  body('items.*.productName')
    .trim()
    .isLength({ min: 1 })
    .withMessage('Product name is required'),
  
  body('items.*.quantity')
    .isFloat({ min: 0.01 })
    .withMessage('Quantity must be greater than 0'),
  
  body('items.*.refundAmount')
    .isFloat({ min: 0 })
    .withMessage('Refund amount must be a positive number'),
  
  body('reason')
    .trim()
    .isLength({ min: 1, max: 500 })
    .withMessage('Return reason must be between 1 and 500 characters'),
  
  body('returnType')
    .optional()
    .isIn(['FULL', 'PARTIAL'])
    .withMessage('Return type must be FULL or PARTIAL'),
  
  body('refundMethod')
    .optional()
    .isIn(['CASH', 'CARD_REFUND', 'STORE_CREDIT'])
    .withMessage('Refund method must be CASH, CARD_REFUND, or STORE_CREDIT'),
  
  body('notes')
    .optional()
    .trim()
    .isLength({ max: 500 })
    .withMessage('Notes cannot exceed 500 characters')
];

// POS hold bill validation
const validateHoldBill = [
  body('branchId')
    .isInt({ min: 1 })
    .withMessage('Branch ID must be a valid positive integer'),
  
  body('terminalId')
    .trim()
    .isLength({ min: 1, max: 20 })
    .withMessage('Terminal ID must be between 1 and 20 characters'),
  
  body('items')
    .isArray({ min: 1 })
    .withMessage('At least one item is required'),
  
  body('items.*.inventoryItemId')
    .optional()
    .custom((value) => {
      if (value === null || value === undefined || value === '') {
        return true;
      }
      const num = parseInt(value);
      if (isNaN(num) || num < 1) {
        throw new Error('Inventory item ID must be a valid positive integer');
      }
      return true;
    })
    .withMessage('Inventory item ID must be a valid positive integer or null for manual items'),
  
  body('items.*.quantity')
    .isFloat({ min: 0.01 })
    .withMessage('Quantity must be greater than 0'),
  
  body('items.*.unitPrice')
    .isFloat({ min: 0 })
    .withMessage('Unit price must be a positive number'),
  
  body('items.*.discount')
    .optional()
    .custom((value) => {
      if (value === '' || value === null || value === undefined) {
        return true;
      }
      const num = parseFloat(value);
      if (isNaN(num) || num < 0) {
        throw new Error('Discount must be a non-negative number');
      }
      return true;
    })
    .withMessage('Discount must be a non-negative number'),
  
  body('customerInfo.name')
    .optional()
    .trim()
    .isLength({ max: 100 })
    .withMessage('Customer name cannot exceed 100 characters'),
  
  body('customerInfo.phone')
    .optional()
    .trim()
    .isLength({ max: 20 })
    .withMessage('Customer phone cannot exceed 20 characters'),
  
  body('customerInfo.email')
    .optional()
    .custom((value) => {
      if (value === '' || value === null || value === undefined) {
        return true;
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
        throw new Error('Customer email must be a valid email address');
      }
      return true;
    })
    .withMessage('Customer email must be a valid email address'),
  
  body('customerInfo.address')
    .optional()
    .trim()
    .isLength({ max: 200 })
    .withMessage('Customer address cannot exceed 200 characters'),
  
  body('notes')
    .optional()
    .trim()
    .isLength({ max: 500 })
    .withMessage('Notes cannot exceed 500 characters'),
  
  body('holdReason')
    .optional()
    .trim()
    .isLength({ max: 200 })
    .withMessage('Hold reason cannot exceed 200 characters')
];

// POS complete bill validation
const validateCompleteBill = [
  body('paymentMethod')
    .isIn(['CASH', 'CARD', 'BANK_TRANSFER', 'MOBILE_PAYMENT', 'FULLY_CREDIT', 'PARTIAL_PAYMENT'])
    .withMessage('Payment method must be CASH, CARD, BANK_TRANSFER, MOBILE_PAYMENT, FULLY_CREDIT, or PARTIAL_PAYMENT')
];

// Ledger entry validation
const validateLedgerEntry = [
  body('amount')
    .isFloat({ min: 0.01 })
    .withMessage('Amount must be greater than 0'),
  
  body('description')
    .trim()
    .isLength({ min: 1, max: 500 })
    .withMessage('Description must be between 1 and 500 characters'),
  
  body('reference')
    .trim()
    .isLength({ min: 1, max: 50 })
    .withMessage('Reference must be between 1 and 50 characters'),

  // ✅ FIX: was isMongoId() — your IDs are integers
  body('referenceId')
    .isInt({ min: 1 })
    .withMessage('Reference ID must be a valid positive integer')
];

// Ledger account validation
const validateLedgerAccount = [
  body('accountName').notEmpty().withMessage('Account name is required'),
  body('accountType').notEmpty().withMessage('Account type is required'),
  body('description').notEmpty().withMessage('Description is required'),
  body('balance').isNumeric().withMessage('Balance must be a number')
];

const validateLedgerAccountUpdate = [
  body('accountName').optional().notEmpty().withMessage('Account name cannot be empty'),
  body('accountType').optional().notEmpty().withMessage('Account type cannot be empty'),
  body('description').optional().notEmpty().withMessage('Description cannot be empty'),
  body('balance').optional().isNumeric().withMessage('Balance must be a number')
];

const validateLedgerEntryUpdate = [
  body('amount').optional().isNumeric().withMessage('Amount must be a number'),
  body('description').optional().notEmpty().withMessage('Description cannot be empty'),
  body('reference').optional().isString(),
  body('referenceId').optional().isString()
];

// Transfer validation — ORIGINAL nested format (kept for backward compat)
const validateTransfer = [
  body('from.scopeType')
    .isIn(['BRANCH', 'WAREHOUSE'])
    .withMessage('From scope type must be BRANCH or WAREHOUSE'),
  
  body('from.scopeId')
    .custom((value) => {
      if (value === null || value === undefined || value === '') {
        throw new Error('From scope ID is required');
      }
      return String(value).length >= 1;
    })
    .withMessage('From scope ID must be a valid string or number')
    .customSanitizer(value => String(value)),
  
  body('to.scopeType')
    .isIn(['BRANCH', 'WAREHOUSE'])
    .withMessage('To scope type must be BRANCH or WAREHOUSE'),
  
  body('to.scopeId')
    .custom((value) => {
      if (value === null || value === undefined || value === '') {
        throw new Error('To scope ID is required');
      }
      return String(value).length >= 1;
    })
    .withMessage('To scope ID must be a valid string or number')
    .customSanitizer(value => String(value)),
  
  body('items')
    .isArray({ min: 1 })
    .withMessage('At least one item is required for transfer'),
  
  body('items.*.inventoryItemId')
    .isInt({ min: 1 })
    .withMessage('Inventory item ID must be a valid positive integer'),
  
  body('items.*.quantity')
    .isFloat({ min: 0.01 })
    .withMessage('Quantity must be greater than 0'),
  
  body('reason')
    .trim()
    .isLength({ min: 1, max: 500 })
    .withMessage('Transfer reason must be between 1 and 500 characters'),
  
  body('notes')
    .optional()
    .trim()
    .isLength({ max: 500 })
    .withMessage('Notes cannot exceed 500 characters')
];

// Transfer validation — FLAT format (matches transferController.js fields)
const transferValidation = [
  body('fromScopeType')
    .isIn(['BRANCH', 'WAREHOUSE'])
    .withMessage('From scope type must be BRANCH or WAREHOUSE'),
  body('fromScopeId')
    .isInt({ min: 1 })
    .withMessage('From scope ID must be a positive integer'),
  body('toScopeType')
    .isIn(['BRANCH', 'WAREHOUSE'])
    .withMessage('To scope type must be BRANCH or WAREHOUSE'),
  body('toScopeId')
    .isInt({ min: 1 })
    .withMessage('To scope ID must be a positive integer'),
  body('transferType')
    .isIn(['BRANCH_TO_BRANCH', 'WAREHOUSE_TO_WAREHOUSE', 'BRANCH_TO_WAREHOUSE', 'WAREHOUSE_TO_BRANCH'])
    .withMessage('Invalid transfer type'),
  body('items')
    .isArray({ min: 1 })
    .withMessage('Transfer must contain at least one item'),
  body('items.*.inventoryItemId')
    .isInt({ min: 1 })
    .withMessage('Inventory item ID must be a positive integer'),
  body('items.*.quantityRequested')
    .isFloat({ min: 0.01 })
    .withMessage('Quantity requested must be greater than 0'),
  body('expectedDate')
    .optional()
    .isISO8601()
    .withMessage('Expected date must be a valid date')
];

// Transfer status update validation
const transferStatusValidation = [
  body('status')
    .isIn(['PENDING', 'APPROVED', 'IN_TRANSIT', 'COMPLETED', 'REJECTED', 'CANCELLED'])
    .withMessage('Invalid status'),
  body('notes')
    .optional()
    .isString()
];

// Transfer rejection validation
const validateTransferRejection = [
  body('rejectionReason')
    .trim()
    .isLength({ min: 1, max: 500 })
    .withMessage('Rejection reason must be between 1 and 500 characters')
];

// Hardware operation validation
const validateHardwareOperation = [
  body('scopeType')
    .isIn(['BRANCH', 'WAREHOUSE'])
    .withMessage('Scope type must be BRANCH or WAREHOUSE'),
  
  body('scopeId')
    .custom((value) => {
      if (value === null || value === undefined || value === '') {
        throw new Error('Scope ID is required');
      }
      return String(value).length >= 1;
    })
    .withMessage('Scope ID must be a valid string or number')
    .customSanitizer(value => String(value)),
  
  body('terminalId')
    .optional()
    .trim()
    .isLength({ min: 1, max: 20 })
    .withMessage('Terminal ID must be between 1 and 20 characters'),
  
  body('deviceId')
    .optional()
    .trim()
    .isLength({ min: 1, max: 50 })
    .withMessage('Device ID must be between 1 and 50 characters')
];

// Barcode scan validation
const validateBarcodeScan = [
  body('barcode')
    .trim()
    .isLength({ min: 1, max: 50 })
    .withMessage('Barcode must be between 1 and 50 characters'),
  
  body('scopeType')
    .isIn(['BRANCH', 'WAREHOUSE'])
    .withMessage('Scope type must be BRANCH or WAREHOUSE'),
  
  body('scopeId')
    .custom((value) => {
      if (value === null || value === undefined || value === '') {
        throw new Error('Scope ID is required');
      }
      return String(value).length >= 1;
    })
    .withMessage('Scope ID must be a valid string or number')
    .customSanitizer(value => String(value))
];

// Receipt print validation
const validateReceiptPrint = [
  body('saleId')
    .isInt({ min: 1 })
    .withMessage('Sale ID must be a valid positive integer'),
  
  body('scopeType')
    .isIn(['BRANCH', 'WAREHOUSE'])
    .withMessage('Scope type must be BRANCH or WAREHOUSE'),
  
  body('scopeId')
    .custom((value) => {
      if (value === null || value === undefined || value === '') {
        throw new Error('Scope ID is required');
      }
      return String(value).length >= 1;
    })
    .withMessage('Scope ID must be a valid string or number')
    .customSanitizer(value => String(value))
];

// Weighing scale validation
const validateWeighingScale = [
  // ✅ FIX: was isMongoId() — your IDs are integers
  body('itemId')
    .isInt({ min: 1 })
    .withMessage('Item ID must be a valid positive integer'),
  
  body('weight')
    .isFloat({ min: 0 })
    .withMessage('Weight must be a positive number')
];

// Device registration validation
const validateDeviceRegistration = [
  body('deviceId')
    .trim()
    .isLength({ min: 1, max: 50 })
    .withMessage('Device ID must be between 1 and 50 characters'),
  
  body('name')
    .trim()
    .isLength({ min: 1, max: 100 })
    .withMessage('Device name must be between 1 and 100 characters'),
  
  body('type')
    .isIn(['BARCODE_SCANNER', 'RECEIPT_PRINTER', 'CASH_DRAWER', 'WEIGHING_SCALE', 'DISPLAY'])
    .withMessage('Device type must be BARCODE_SCANNER, RECEIPT_PRINTER, CASH_DRAWER, WEIGHING_SCALE, or DISPLAY'),
  
  body('scopeType')
    .isIn(['BRANCH', 'WAREHOUSE'])
    .withMessage('Scope type must be BRANCH or WAREHOUSE'),
  
  body('scopeId')
    .custom((value) => {
      if (value === null || value === undefined || value === '') {
        throw new Error('Scope ID is required');
      }
      return String(value).length >= 1;
    })
    .withMessage('Scope ID must be a valid string or number')
    .customSanitizer(value => String(value)),
  
  body('terminalId')
    .trim()
    .isLength({ min: 1, max: 20 })
    .withMessage('Terminal ID must be between 1 and 20 characters')
];

module.exports = {
  // ── NEW helpers ──────────────────────────────────────────────
  handleValidation,

  // ── Auth ─────────────────────────────────────────────────────
  userValidation,
  userUpdateValidation,
  loginValidation,
  refreshValidation,

  // ── Branch / Warehouse ───────────────────────────────────────
  branchValidation,
  warehouseValidation,
  warehouseCreateValidation,
  warehouseUpdateValidation,

  // ── Inventory ────────────────────────────────────────────────
  inventoryItemValidation,
  inventoryItemUpdateValidation,

  // ── Company ──────────────────────────────────────────────────
  companyValidation,

  // ── Sales ────────────────────────────────────────────────────
  validateSale,
  validateSaleUpdate,
  validateReturn,

  // ── POS ──────────────────────────────────────────────────────
  validateHoldBill,
  validateCompleteBill,

  // ── Ledger ───────────────────────────────────────────────────
  validateLedgerEntry,
  validateLedgerAccount,
  validateLedgerAccountUpdate,
  validateLedgerEntryUpdate,

  // ── Transfers ────────────────────────────────────────────────
  validateTransfer,
  transferValidation,
  transferStatusValidation,
  validateTransferRejection,

  // ── Hardware ─────────────────────────────────────────────────
  validateHardwareOperation,
  validateBarcodeScan,
  validateReceiptPrint,
  validateWeighingScale,
  validateDeviceRegistration,

  // ── Shifts ───────────────────────────────────────────────────
  validateShift: [
    body('name')
      .trim()
      .notEmpty()
      .withMessage('Shift name is required')
      .isLength({ max: 100 })
      .withMessage('Shift name cannot exceed 100 characters'),
    body('startTime')
      .matches(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/)
      .withMessage('Start time must be in HH:MM format'),
    body('endTime')
      .matches(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/)
      .withMessage('End time must be in HH:MM format'),
    // ✅ FIX: was isMongoId() — your IDs are integers
    body('branchId')
      .isInt({ min: 1 })
      .withMessage('Valid branch ID is required')
  ],

  validateShiftUpdate: [
    body('name')
      .optional()
      .trim()
      .notEmpty()
      .withMessage('Shift name cannot be empty')
      .isLength({ max: 100 })
      .withMessage('Shift name cannot exceed 100 characters'),
    body('startTime')
      .optional()
      .matches(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/)
      .withMessage('Start time must be in HH:MM format'),
    body('endTime')
      .optional()
      .matches(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/)
      .withMessage('End time must be in HH:MM format'),
    body('isActive')
      .optional()
      .isBoolean()
      .withMessage('isActive must be a boolean')
  ],

  validateShiftAssignment: [
    // ✅ FIX: was isMongoId() — your IDs are integers
    body('userId')
      .isInt({ min: 1 })
      .withMessage('Valid user ID is required'),
    body('role')
      .isIn(['CASHIER', 'WAREHOUSE_KEEPER'])
      .withMessage('Role must be either CASHIER or WAREHOUSE_KEEPER')
  ],

  // ── Warehouse Sales ──────────────────────────────────────────
  validateWarehouseSale: [
    body('retailerId')
      .optional({ values: 'falsy' })
      .custom((value) => {
        if (!value || value === 'null' || value === 'undefined') {
          return true;
        }
        const num = parseInt(value);
        return !isNaN(num) && num > 0;
      })
      .withMessage('Retailer ID must be a valid positive integer'),

    body('items')
      .isArray({ min: 1 })
      .withMessage('At least one item is required'),

    body('items.*.itemId')
      .optional()
      .custom((value, { req, path }) => {
        const itemIndex = path.match(/\[(\d+)\]/)?.[1];
        const inventoryItemId = req.body.items?.[itemIndex]?.inventoryItemId;
        if (!value && !inventoryItemId) {
          return false;
        }
        return true;
      })
      .withMessage('Item ID is required'),

    body('items.*.inventoryItemId')
      .optional()
      .custom((value) => {
        if (!value) return true;
        const num = parseInt(value);
        return !isNaN(num) && num > 0;
      })
      .withMessage('Inventory item ID must be a valid positive integer'),

    body('items.*.quantity')
      .isFloat({ min: 0.01 })
      .withMessage('Quantity must be greater than 0'),

    body('items.*.unitPrice')
      .isFloat({ min: 0 })
      .withMessage('Unit price must be a positive number'),

    body('items.*.totalPrice')
      .optional()
      .isFloat({ min: 0 })
      .withMessage('Total price must be a positive number'),

    body('subtotal').optional().isFloat({ min: 0 }).withMessage('Subtotal must be a positive number'),
    body('totalAmount').optional().isFloat({ min: 0 }).withMessage('Total amount must be a positive number'),
    body('total').optional().isFloat({ min: 0 }).withMessage('Total must be a positive number'),
    body('taxAmount').optional().isFloat({ min: 0 }).withMessage('Tax amount must be a positive number'),
    body('taxRate').optional().isFloat({ min: 0 }).withMessage('Tax rate must be a positive number'),
    body('discountAmount').optional().isFloat({ min: 0 }).withMessage('Discount amount must be a positive number'),
    body('finalAmount').optional().isFloat({ min: 0 }).withMessage('Final amount must be a positive number'),

    body('paymentMethod')
      .optional()
      .isIn(['CASH', 'CARD', 'CREDIT', 'PARTIAL_PAYMENT', 'FULLY_CREDIT', 'BANK_TRANSFER', 'CHEQUE', 'MOBILE_MONEY'])
      .withMessage('Payment method must be CASH, CARD, CREDIT, PARTIAL_PAYMENT, FULLY_CREDIT, BANK_TRANSFER, CHEQUE, or MOBILE_MONEY'),

    body('paymentAmount')
      .optional()
      .custom((value) => {
        if (value === undefined || value === null || value === '') return true;
        const num = parseFloat(value);
        return !isNaN(num);
      })
      .withMessage('Payment amount must be a valid number'),

    body('creditAmount')
      .optional()
      .custom((value) => {
        if (value === undefined || value === null || value === '') return true;
        const num = parseFloat(value);
        return !isNaN(num);
      })
      .withMessage('Credit amount must be a valid number'),

    body('paymentTerms').optional().isLength({ max: 100 }).withMessage('Payment terms must not exceed 100 characters'),
    body('notes').optional().isLength({ max: 500 }).withMessage('Notes must not exceed 500 characters')
  ],

// ─────────────────────────────────────────────────────────────────────────────
// PATCH: Replace the existing validateRetailer array in validators.js
// Only `name` is required. Everything else is fully optional.
// ─────────────────────────────────────────────────────────────────────────────

validateRetailer: [
  // ── REQUIRED ──────────────────────────────────────────────────────────────
  body('name')
    .trim()
    .notEmpty()
    .withMessage('Name is required')
    .isLength({ min: 2, max: 100 })
    .withMessage('Name must be between 2 and 100 characters'),

  // ── ALL OPTIONAL ──────────────────────────────────────────────────────────
  body('email')
    .optional({ values: 'falsy' })   // treats '', null, undefined as "not provided"
    .isEmail()
    .normalizeEmail()
    .withMessage('Please provide a valid email address'),

  body('phone')
    .optional({ values: 'falsy' })
    .trim()
    .isLength({ max: 30 })
    .withMessage('Phone must not exceed 30 characters'),
    // NOTE: removed .isMobilePhone() — too strict for Pakistani numbers like 03xx-xxxxxxx

  body('address')
    .optional({ values: 'falsy' })
    .trim()
    .isLength({ max: 200 })
    .withMessage('Address must not exceed 200 characters'),

  body('city')
    .optional({ values: 'falsy' })
    .trim()
    .isLength({ max: 50 })
    .withMessage('City must not exceed 50 characters'),

  body('state')
    .optional({ values: 'falsy' })
    .trim()
    .isLength({ max: 50 })
    .withMessage('State must not exceed 50 characters'),

  body('zipCode')
    .optional({ values: 'falsy' })
    .trim()
    .isLength({ max: 10 })
    .withMessage('ZIP code must not exceed 10 characters'),

  body('businessType')
    .optional({ values: 'falsy' })
    .isIn(['RETAILER', 'WHOLESALER', 'DISTRIBUTOR', 'OTHER'])
    .withMessage('Business type must be RETAILER, WHOLESALER, DISTRIBUTOR, or OTHER'),

  body('taxId')
    .optional({ values: 'falsy' })
    .trim()
    .isLength({ max: 20 })
    .withMessage('Tax ID must not exceed 20 characters'),

  body('creditLimit')
    .optional({ values: 'falsy' })
    .isFloat({ min: 0 })
    .withMessage('Credit limit must be a positive number'),

  body('paymentTerms')
    .optional({ values: 'falsy' })
    .isIn(['CASH', 'NET_15', 'NET_30', 'NET_45', 'NET_60'])
    .withMessage('Payment terms must be CASH, NET_15, NET_30, NET_45, or NET_60'),

  body('status')
    .optional({ values: 'falsy' })
    .isIn(['ACTIVE', 'INACTIVE', 'SUSPENDED'])
    .withMessage('Status must be ACTIVE, INACTIVE, or SUSPENDED'),

  body('notes')
    .optional({ values: 'falsy' })
    .trim()
    .isLength({ max: 500 })
    .withMessage('Notes must not exceed 500 characters'),

  body('warehouseId')
    .optional({ values: 'falsy' })
    .custom((value) => {
      if (!value) return true;
      const num = parseInt(value);
      if (isNaN(num) || num < 1) throw new Error('Warehouse ID must be a valid positive integer');
      return true;
    }),
],

  // ── Customers ────────────────────────────────────────────────
  validateCustomer: [
    body('name')
      .trim()
      .isLength({ min: 2, max: 100 })
      .withMessage('Name must be between 2 and 100 characters'),

    // ✅ FIX: was required — made optional
    body('email')
      .optional()
      .isEmail()
      .normalizeEmail()
      .withMessage('Please provide a valid email address'),

    body('phone')
      .optional({ values: 'falsy' })
      .trim()
      .isLength({ max: 30 })
      .withMessage('Phone must not exceed 30 characters'),

    body('address').optional().isLength({ max: 200 }).withMessage('Address must not exceed 200 characters'),
    body('city').optional().isLength({ max: 50 }).withMessage('City must not exceed 50 characters'),
    body('state').optional().isLength({ max: 50 }).withMessage('State must not exceed 50 characters'),
    body('zipCode').optional().isLength({ max: 10 }).withMessage('ZIP code must not exceed 10 characters'),

    body('customerType')
      .optional()
      .isIn(['INDIVIDUAL', 'BUSINESS', 'RETAILER', 'WHOLESALER'])
      .withMessage('Customer type must be INDIVIDUAL, BUSINESS, RETAILER, or WHOLESALER'),

    body('creditLimit').optional().isFloat({ min: 0 }).withMessage('Credit limit must be a positive number'),

    body('paymentTerms')
      .optional()
      .isIn(['CASH', 'NET_15', 'NET_30', 'NET_60'])
      .withMessage('Payment terms must be CASH, NET_15, NET_30, or NET_60'),

    body('notes').optional().isLength({ max: 500 }).withMessage('Notes must not exceed 500 characters')
  ],

  // ── Credit/Debit ─────────────────────────────────────────────
  validateCreditDebitTransaction: [
    body('customerId').notEmpty().withMessage('Customer ID is required').isInt().withMessage('Customer ID must be a valid integer'),
    body('transactionType').isIn(['CREDIT', 'DEBIT']).withMessage('Transaction type must be CREDIT or DEBIT'),
    body('amount').isFloat({ min: 0.01 }).withMessage('Amount must be a positive number'),
    body('description').trim().isLength({ min: 1, max: 200 }).withMessage('Description must be between 1 and 200 characters'),
    body('referenceType').optional().isIn(['SALE', 'RETURN', 'PAYMENT', 'ADJUSTMENT', 'REFUND', 'OTHER']).withMessage('Reference type must be SALE, RETURN, PAYMENT, ADJUSTMENT, REFUND, or OTHER'),
    body('referenceId').optional().isInt().withMessage('Reference ID must be a valid integer'),
    body('paymentMethod').optional().isIn(['CASH', 'CARD', 'DIGITAL', 'CREDIT', 'CHEQUE']).withMessage('Payment method must be CASH, CARD, DIGITAL, CREDIT, or CHEQUE'),
    body('notes').optional().isLength({ max: 500 }).withMessage('Notes must not exceed 500 characters')
  ],

  // ── Billing ──────────────────────────────────────────────────
  validateBilling: [
    body('invoiceNumber')
      .optional()
      .custom((value) => {
        if (value === null || value === undefined || value === '') return true;
        if (typeof value === 'string' && value.trim().length >= 1 && value.trim().length <= 50) return true;
        throw new Error('Invoice number must be between 1 and 50 characters');
      })
      .withMessage('Invoice number must be between 1 and 50 characters'),

    body('clientName')
      .custom((value) => {
        if (value === null || value === undefined) return true;
        if (typeof value === 'string' && value.trim().length >= 1 && value.trim().length <= 200) return true;
        throw new Error('Client name must be between 1 and 200 characters');
      })
      .withMessage('Client name must be between 1 and 200 characters'),

    body('clientEmail')
      .optional()
      .custom((value) => {
        if (value === null || value === undefined || value === '') return true;
        if (typeof value === 'string' && value.includes('@') && value.includes('.')) return true;
        throw new Error('Client email must be a valid email address');
      })
      .withMessage('Client email must be a valid email address'),

    body('clientPhone')
      .optional()
      .custom((value) => {
        if (value === null || value === undefined || value === '') return true;
        if (typeof value === 'string' && value.trim().length <= 20) return true;
        throw new Error('Client phone must not exceed 20 characters');
      })
      .withMessage('Client phone must not exceed 20 characters'),

    body('clientAddress')
      .optional()
      .custom((value) => {
        if (value === null || value === undefined || value === '') return true;
        if (typeof value === 'string' && value.trim().length <= 500) return true;
        throw new Error('Client address must not exceed 500 characters');
      })
      .withMessage('Client address must not exceed 500 characters'),

    body('amount')
      .optional()
      .custom((value) => {
        if (value === null || value === undefined || value === '') return true;
        const num = parseFloat(value);
        if (!isNaN(num) && num >= 0) return true;
        throw new Error('Amount must be a non-negative number');
      })
      .withMessage('Amount must be a non-negative number'),

    body('tax')
      .optional()
      .custom((value) => {
        if (value === null || value === undefined || value === '') return true;
        const num = parseFloat(value);
        if (!isNaN(num) && num >= 0) return true;
        throw new Error('Tax must be a non-negative number');
      })
      .withMessage('Tax must be a non-negative number'),

    body('discount')
      .optional()
      .custom((value) => {
        if (value === null || value === undefined || value === '') return true;
        const num = parseFloat(value);
        if (!isNaN(num) && num >= 0) return true;
        throw new Error('Discount must be a non-negative number');
      })
      .withMessage('Discount must be a non-negative number'),

    body('dueDate')
      .optional()
      .custom((value) => {
        if (value === null || value === undefined || value === '') return true;
        if (typeof value === 'string' && value.match(/^\d{4}-\d{2}-\d{2}$/)) return true;
        throw new Error('Due date must be a valid date in YYYY-MM-DD format');
      })
      .withMessage('Due date must be a valid date in YYYY-MM-DD format'),

    body('service')
      .optional()
      .custom((value) => {
        if (value === null || value === undefined || value === '') return true;
        if (typeof value === 'string' && value.trim().length >= 1 && value.trim().length <= 200) return true;
        throw new Error('Service must be between 1 and 200 characters');
      })
      .withMessage('Service must be between 1 and 200 characters'),

    body('description')
      .optional()
      .custom((value) => {
        if (value === null || value === undefined || value === '') return true;
        if (typeof value === 'string' && value.trim().length <= 1000) return true;
        throw new Error('Description must not exceed 1000 characters');
      })
      .withMessage('Description must not exceed 1000 characters'),

    body('status')
      .optional()
      .custom((value) => {
        if (value === null || value === undefined || value === '') return true;
        const validStatuses = ['pending', 'paid', 'overdue', 'cancelled'];
        if (validStatuses.includes(value.toLowerCase())) return true;
        throw new Error('Status must be pending, paid, overdue, or cancelled');
      })
      .withMessage('Status must be pending, paid, overdue, or cancelled'),

    body('paymentMethod')
      .optional()
      .custom((value) => {
        if (value === null || value === undefined || value === '') return true;
        const validMethods = ['CASH', 'CARD', 'BANK_TRANSFER', 'MOBILE_PAYMENT', 'CHEQUE', 'MOBILE_MONEY'];
        if (validMethods.includes(value)) return true;
        throw new Error('Payment method must be CASH, CARD, BANK_TRANSFER, MOBILE_PAYMENT, CHEQUE, or MOBILE_MONEY');
      })
      .withMessage('Payment method must be CASH, CARD, BANK_TRANSFER, MOBILE_PAYMENT, CHEQUE, or MOBILE_MONEY'),

    body('paymentDate')
      .optional()
      .custom((value) => {
        if (value === null || value === undefined || value === '') return true;
        if (typeof value === 'string' && value.match(/^\d{4}-\d{2}-\d{2}$/)) return true;
        throw new Error('Payment date must be a valid date in YYYY-MM-DD format');
      })
      .withMessage('Payment date must be a valid date in YYYY-MM-DD format'),

    body('notes')
      .optional()
      .custom((value) => {
        if (value === null || value === undefined || value === '') return true;
        if (typeof value === 'string' && value.trim().length <= 500) return true;
        throw new Error('Notes must not exceed 500 characters');
      })
      .withMessage('Notes must not exceed 500 characters')
  ],

  // ── Billing Update ───────────────────────────────────────────
  validateBillingUpdate: [
    body('invoiceNumber')
      .optional()
      .custom((value) => {
        if (value === null || value === undefined || value === '') return true;
        if (typeof value === 'string' && value.trim().length >= 1 && value.trim().length <= 50) return true;
        throw new Error('Invoice number must be between 1 and 50 characters');
      })
      .withMessage('Invoice number must be between 1 and 50 characters'),

    body('clientName')
      .optional()
      .custom((value) => {
        if (value === null || value === undefined) return true;
        if (typeof value === 'string' && value.trim().length >= 1 && value.trim().length <= 200) return true;
        throw new Error('Client name must be between 1 and 200 characters');
      })
      .withMessage('Client name must be between 1 and 200 characters'),

    body('clientEmail')
      .optional()
      .custom((value) => {
        if (value === null || value === undefined || value === '') return true;
        if (typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return true;
        throw new Error('Client email must be a valid email address');
      })
      .withMessage('Client email must be a valid email address'),

    body('clientPhone')
      .optional()
      .custom((value) => {
        if (value === null || value === undefined || value === '') return true;
        if (typeof value === 'string' && value.trim().length <= 20) return true;
        throw new Error('Client phone must not exceed 20 characters');
      })
      .withMessage('Client phone must not exceed 20 characters'),

    body('clientAddress')
      .optional()
      .custom((value) => {
        if (value === null || value === undefined || value === '') return true;
        if (typeof value === 'string' && value.trim().length <= 500) return true;
        throw new Error('Client address must not exceed 500 characters');
      })
      .withMessage('Client address must not exceed 500 characters'),

    body('amount')
      .optional()
      .custom((value) => {
        if (value === null || value === undefined || value === '') return true;
        const num = parseFloat(value);
        if (!isNaN(num) && num >= 0) return true;
        throw new Error('Amount must be a non-negative number');
      })
      .withMessage('Amount must be a non-negative number'),

    body('tax')
      .optional()
      .custom((value) => {
        if (value === null || value === undefined || value === '') return true;
        const num = parseFloat(value);
        if (!isNaN(num) && num >= 0) return true;
        throw new Error('Tax must be a non-negative number');
      })
      .withMessage('Tax must be a non-negative number'),

    body('discount')
      .optional()
      .custom((value) => {
        if (value === null || value === undefined || value === '') return true;
        const num = parseFloat(value);
        if (!isNaN(num) && num >= 0) return true;
        throw new Error('Discount must be a non-negative number');
      })
      .withMessage('Discount must be a non-negative number'),

    body('dueDate')
      .optional()
      .custom((value) => {
        if (value === null || value === undefined || value === '') return true;
        if (typeof value === 'string' && !isNaN(Date.parse(value))) return true;
        throw new Error('Due date must be a valid date');
      })
      .withMessage('Due date must be a valid date'),

    body('service')
      .optional()
      .custom((value) => {
        if (value === null || value === undefined || value === '') return true;
        if (typeof value === 'string' && value.trim().length >= 1 && value.trim().length <= 200) return true;
        throw new Error('Service must be between 1 and 200 characters');
      })
      .withMessage('Service must be between 1 and 200 characters'),

    body('description')
      .optional()
      .custom((value) => {
        if (value === null || value === undefined || value === '') return true;
        if (typeof value === 'string' && value.trim().length <= 1000) return true;
        throw new Error('Description must not exceed 1000 characters');
      })
      .withMessage('Description must not exceed 1000 characters'),

    body('status')
      .optional()
      .custom((value) => {
        if (value === null || value === undefined || value === '') return true;
        const validStatuses = ['pending', 'paid', 'overdue', 'cancelled'];
        if (validStatuses.includes(value.toLowerCase())) return true;
        throw new Error('Status must be pending, paid, overdue, or cancelled');
      })
      .withMessage('Status must be pending, paid, overdue, or cancelled'),

    // ✅ FIX: array now matches the error message (added CHEQUE and MOBILE_MONEY)
    body('paymentMethod')
      .optional()
      .custom((value) => {
        if (value === null || value === undefined || value === '') return true;
        if (['CASH', 'CARD', 'BANK_TRANSFER', 'MOBILE_PAYMENT', 'FULLY_CREDIT', 'PARTIAL_PAYMENT', 'CHEQUE', 'MOBILE_MONEY'].includes(value)) return true;
        throw new Error('Payment method must be CASH, CARD, BANK_TRANSFER, MOBILE_PAYMENT, CHEQUE, MOBILE_MONEY, FULLY_CREDIT, or PARTIAL_PAYMENT');
      })
      .withMessage('Payment method must be CASH, CARD, BANK_TRANSFER, MOBILE_PAYMENT, CHEQUE, MOBILE_MONEY, FULLY_CREDIT, or PARTIAL_PAYMENT'),

    body('paymentDate')
      .optional()
      .custom((value) => {
        if (value === null || value === undefined || value === '') return true;
        if (typeof value === 'string' && !isNaN(Date.parse(value))) return true;
        throw new Error('Payment date must be a valid date');
      })
      .withMessage('Payment date must be a valid date'),

    body('notes')
      .optional()
      .custom((value) => {
        if (value === null || value === undefined || value === '') return true;
        if (typeof value === 'string' && value.trim().length <= 500) return true;
        throw new Error('Notes must not exceed 500 characters');
      })
      .withMessage('Notes must not exceed 500 characters')
  ],

  // ── Financial Vouchers ───────────────────────────────────────
  financialVoucherValidation: [
    body('type')
      .isIn(['INCOME', 'EXPENSE', 'TRANSFER'])
      .withMessage('Type must be INCOME, EXPENSE, or TRANSFER'),

    body('category')
      .isIn(['SALES', 'EXPENSE', 'TRANSFER', 'ADJUSTMENT', 'REFUND', 'RENT', 'FARE', 'UTILITY'])
      .withMessage('Category must be SALES, EXPENSE, TRANSFER, ADJUSTMENT, REFUND, RENT, FARE, or UTILITY'),

    body('paymentMethod')
      .isIn(['CASH', 'BANK', 'MOBILE', 'CARD', 'CHEQUE'])
      .withMessage('Payment method must be CASH, BANK, MOBILE, CARD, or CHEQUE'),

    body('amount')
      .isFloat({ min: 0.01 })
      .withMessage('Amount must be a positive number greater than 0'),

    body('scopeType')
      .isIn(['BRANCH', 'WAREHOUSE'])
      .withMessage('Scope type must be BRANCH or WAREHOUSE'),

    body('scopeId')
      .custom((value) => {
        if (value === null || value === undefined || value === '') {
          throw new Error('Scope ID is required');
        }
        const strValue = String(value);
        return strValue.length >= 1 && strValue.length <= 255;
      })
      .withMessage('Scope ID must be between 1 and 255 characters')
      .customSanitizer(value => String(value)),

    body('description')
      .optional()
      .isString()
      .isLength({ max: 1000 })
      .withMessage('Description must be a string with maximum 1000 characters'),

    body('reference')
      .optional()
      .isString()
      .isLength({ max: 255 })
      .withMessage('Reference must be a string with maximum 255 characters'),

    body('notes')
      .optional()
      .isString()
      .isLength({ max: 1000 })
      .withMessage('Notes must be a string with maximum 1000 characters')
  ]
};