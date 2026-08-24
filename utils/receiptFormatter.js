// ESC/POS command constants
const ESC_POS_COMMANDS = {
  INIT: '\x1B\x40', // Initialize printer
  CUT: '\x1D\x56\x00', // Full cut
  FEED: '\x0A', // Line feed
  CENTER: '\x1B\x61\x01', // Center alignment
  LEFT: '\x1B\x61\x00', // Left alignment
  RIGHT: '\x1B\x61\x02', // Right alignment
  BOLD_ON: '\x1B\x45\x01', // Bold on
  BOLD_OFF: '\x1B\x45\x00', // Bold off
  DOUBLE_HEIGHT: '\x1B\x21\x10', // Double height
  NORMAL_SIZE: '\x1B\x21\x00', // Normal size
  UNDERLINE_ON: '\x1B\x2D\x01', // Underline on
  UNDERLINE_OFF: '\x1B\x2D\x00', // Underline off
  RESET: '\x1B\x40' // Reset printer
};

// Format receipt for ESC/POS printer
const formatReceipt = async (sale, scopeDetails, scopeType) => {
  try {
    let receipt = '';
    
    // Initialize printer
    receipt += ESC_POS_COMMANDS.INIT;
    
    // Header
    receipt += ESC_POS_COMMANDS.CENTER;
    receipt += ESC_POS_COMMANDS.BOLD_ON;
    receipt += ESC_POS_COMMANDS.DOUBLE_HEIGHT;
    receipt += `${scopeDetails.name}\n`;
    receipt += ESC_POS_COMMANDS.BOLD_OFF;
    receipt += ESC_POS_COMMANDS.NORMAL_SIZE;
    
    // Address and contact info
    if (scopeDetails.location) {
      receipt += `${scopeDetails.location}\n`;
    }
    if (scopeDetails.contact) {
      receipt += `Tel: ${scopeDetails.contact}\n`;
    }
    
    // Separator line
    receipt += '================================\n';
    
    // Sale details
    receipt += ESC_POS_COMMANDS.LEFT;
    receipt += ESC_POS_COMMANDS.BOLD_ON;
    receipt += `Invoice: ${sale.invoiceNo}\n`;
    receipt += `Date: ${formatDate(sale.createdAt)}\n`;
    receipt += `Time: ${formatTime(sale.createdAt)}\n`;
    receipt += `Cashier: ${sale.userId.username}\n`;
    receipt += ESC_POS_COMMANDS.BOLD_OFF;
    
    // Customer info
    if (sale.customerInfo && sale.customerInfo.name) {
      receipt += '\n';
      receipt += ESC_POS_COMMANDS.BOLD_ON;
      receipt += 'Customer:\n';
      receipt += ESC_POS_COMMANDS.BOLD_OFF;
      receipt += `Name: ${sale.customerInfo.name}\n`;
      if (sale.customerInfo.phone) {
        receipt += `Phone: ${sale.customerInfo.phone}\n`;
      }
      if (sale.customerInfo.email) {
        receipt += `Email: ${sale.customerInfo.email}\n`;
      }
    }
    
    // Separator line
    receipt += '--------------------------------\n';
    
    // Items
    receipt += ESC_POS_COMMANDS.BOLD_ON;
    receipt += 'ITEMS\n';
    receipt += ESC_POS_COMMANDS.BOLD_OFF;
    receipt += '--------------------------------\n';
    
    sale.items.forEach(item => {
      receipt += `${item.inventoryItemId.name}\n`;
      receipt += `SKU: ${item.inventoryItemId.sku}\n`;
      receipt += `Qty: ${item.quantity} x ${formatCurrency(item.unitPrice)}\n`;
      
      if (item.discount > 0) {
        receipt += `Discount: -${formatCurrency(item.discount)}\n`;
      }
      
      receipt += `Total: ${formatCurrency(item.total)}\n`;
      receipt += '--------------------------------\n';
    });
    
    // Totals
    receipt += '\n';
    receipt += ESC_POS_COMMANDS.RIGHT;
    receipt += ESC_POS_COMMANDS.BOLD_ON;
    receipt += `Subtotal: ${formatCurrency(sale.subtotal)}\n`;
    
    if (sale.tax > 0) {
      receipt += `Tax: ${formatCurrency(sale.tax)}\n`;
    }
    
    if (sale.discount > 0) {
      receipt += `Discount: -${formatCurrency(sale.discount)}\n`;
    }
    
    receipt += `TOTAL: ${formatCurrency(sale.total)}\n`;
    receipt += ESC_POS_COMMANDS.BOLD_OFF;
    
    // Payment info
    receipt += '\n';
    receipt += ESC_POS_COMMANDS.LEFT;
    receipt += ESC_POS_COMMANDS.BOLD_ON;
    receipt += 'Payment Information:\n';
    receipt += ESC_POS_COMMANDS.BOLD_OFF;
    receipt += `Payment Method: ${sale.paymentMethod}\n`;
    
    // Show payment amount (what customer is paying now)
    if (sale.paymentAmount !== undefined && sale.paymentAmount !== null) {
      receipt += `Payment Amount: ${formatCurrency(sale.paymentAmount)}\n`;
    }
    
    // Show credit amount if there's a remaining balance
    if (sale.creditAmount !== undefined && sale.creditAmount !== null && sale.creditAmount > 0) {
      receipt += `Credit Amount: ${formatCurrency(sale.creditAmount)}\n`;
    }
    
    receipt += `Payment Status: ${sale.paymentStatus}\n`;
    
    // Notes
    if (sale.notes) {
      receipt += '\n';
      receipt += ESC_POS_COMMANDS.BOLD_ON;
      receipt += 'Notes:\n';
      receipt += ESC_POS_COMMANDS.BOLD_OFF;
      receipt += `${sale.notes}\n`;
    }
    
    // Return Policy
    receipt += '\n';
    receipt += ESC_POS_COMMANDS.CENTER;
    receipt += ESC_POS_COMMANDS.BOLD_ON;
    receipt += '(Please return or exchange within 3 days)\n';
    receipt += ESC_POS_COMMANDS.BOLD_OFF;
    
    // Footer
    receipt += '\n';
    receipt += ESC_POS_COMMANDS.CENTER;
    receipt += ESC_POS_COMMANDS.BOLD_ON;
    receipt += 'Thank you for your business!\n';
    receipt += ESC_POS_COMMANDS.BOLD_OFF;
    receipt += `Visit us again at ${scopeDetails.name}\n`;
    
    // Separator line
    receipt += '================================\n';
    
    // Final feed and cut
    receipt += ESC_POS_COMMANDS.FEED;
    receipt += ESC_POS_COMMANDS.FEED;
    receipt += ESC_POS_COMMANDS.CUT;
    
    return receipt;
  } catch (error) {
    throw new Error(`Error formatting receipt: ${error.message}`);
  }
};

// Format receipt as JSON (for web-based printers)
const formatReceiptJSON = async (sale, scopeDetails, scopeType) => {
  try {
    const receipt = {
      header: {
        businessName: scopeDetails.name,
        address: scopeDetails.location,
        contact: scopeDetails.contact,
        type: scopeType
      },
      sale: {
        invoiceNo: sale.invoiceNo,
        date: formatDate(sale.createdAt),
        time: formatTime(sale.createdAt),
        cashier: sale.userId.username
      },
      customer: sale.customerInfo || null,
      items: sale.items.map(item => ({
        name: item.inventoryItemId.name,
        sku: item.inventoryItemId.sku,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        discount: item.discount,
        total: item.total
      })),
      totals: {
        subtotal: sale.subtotal,
        tax: sale.tax,
        discount: sale.discount,
        total: sale.total
      },
      payment: {
        method: sale.paymentMethod,
        amount: sale.paymentAmount,
        creditAmount: sale.creditAmount,
        status: sale.paymentStatus
      },
      notes: sale.notes || null,
      returnPolicy: '(Please return or exchange within 3 days)',
      footer: {
        message: 'Thank you for your business!',
        businessName: scopeDetails.name
      }
    };
    
    return JSON.stringify(receipt, null, 2);
  } catch (error) {
    throw new Error(`Error formatting receipt JSON: ${error.message}`);
  }
};

// Format receipt as PDF (for PDF printers)
const formatReceiptPDF = async (sale, scopeDetails, scopeType) => {
  try {
    // This would typically use a PDF library like jsPDF
    // For now, we'll return a simple HTML structure that can be converted to PDF
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Receipt - ${sale.invoiceNo}</title>
        <style>
          body { font-family: monospace; font-size: 12px; margin: 0; padding: 20px; }
          .header { text-align: center; font-weight: bold; font-size: 16px; margin-bottom: 20px; }
          .center { text-align: center; }
          .right { text-align: right; }
          .bold { font-weight: bold; }
          .separator { border-top: 1px solid #000; margin: 10px 0; }
          .item { margin: 5px 0; }
          .totals { margin-top: 20px; }
        </style>
      </head>
      <body>
        <div class="header">${scopeDetails.name}</div>
        <div class="center">${scopeDetails.location || ''}</div>
        <div class="center">${scopeDetails.contact || ''}</div>
        <div class="separator"></div>
        
        <div class="bold">Invoice: ${sale.invoiceNo}</div>
        <div>Date: ${formatDate(sale.createdAt)}</div>
        <div>Time: ${formatTime(sale.createdAt)}</div>
        <div>Cashier: ${sale.userId.username}</div>
        
        ${sale.customerInfo && sale.customerInfo.name ? `
          <div class="separator"></div>
          <div class="bold">Customer:</div>
          <div>Name: ${sale.customerInfo.name}</div>
          ${sale.customerInfo.phone ? `<div>Phone: ${sale.customerInfo.phone}</div>` : ''}
          ${sale.customerInfo.email ? `<div>Email: ${sale.customerInfo.email}</div>` : ''}
        ` : ''}
        
        <div class="separator"></div>
        <div class="bold">ITEMS</div>
        <div class="separator"></div>
        
        ${sale.items.map(item => `
          <div class="item">
            <div class="bold">${item.inventoryItemId.name}</div>
            <div>SKU: ${item.inventoryItemId.sku}</div>
            <div>Qty: ${item.quantity} x ${formatCurrency(item.unitPrice)}</div>
            ${item.discount > 0 ? `<div>Discount: -${formatCurrency(item.discount)}</div>` : ''}
            <div class="bold">Total: ${formatCurrency(item.total)}</div>
          </div>
        `).join('')}
        
        <div class="separator"></div>
        <div class="totals right">
          <div class="bold">Subtotal: ${formatCurrency(sale.subtotal)}</div>
          ${sale.tax > 0 ? `<div>Tax: ${formatCurrency(sale.tax)}</div>` : ''}
          ${sale.discount > 0 ? `<div>Discount: -${formatCurrency(sale.discount)}</div>` : ''}
          <div class="bold">TOTAL: ${formatCurrency(sale.total)}</div>
        </div>
        
        <div class="separator"></div>
        <div class="bold">Payment Information:</div>
        <div>Payment Method: ${sale.paymentMethod}</div>
        ${sale.paymentAmount !== undefined && sale.paymentAmount !== null ? `<div>Payment Amount: ${formatCurrency(sale.paymentAmount)}</div>` : ''}
        ${sale.creditAmount !== undefined && sale.creditAmount !== null && sale.creditAmount > 0 ? `<div>Credit Amount: ${formatCurrency(sale.creditAmount)}</div>` : ''}
        <div>Payment Status: ${sale.paymentStatus}</div>
        
        ${sale.notes ? `
          <div class="separator"></div>
          <div class="bold">Notes:</div>
          <div>${sale.notes}</div>
        ` : ''}
        
        <div class="separator"></div>
        <div class="center bold">(Please return or exchange within 3 days)</div>
        
        <div class="separator"></div>
        <div class="center bold">Thank you for your business!</div>
        <div class="center">Visit us again at ${scopeDetails.name}</div>
      </body>
      </html>
    `;
    
    return html;
  } catch (error) {
    throw new Error(`Error formatting receipt PDF: ${error.message}`);
  }
};

// Helper functions
const formatDate = (date) => {
  return new Date(date).toLocaleDateString('en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
};

const formatTime = (date) => {
  return new Date(date).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
};

const formatCurrency = (amount) => {
  return `${parseFloat(amount).toFixed(2)}`;
};

module.exports = {
  formatReceipt,
  formatReceiptJSON,
  formatReceiptPDF,
  ESC_POS_COMMANDS
};
