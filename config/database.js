const mysql = require('mysql2/promise');

let pool;

// MySQL configuration
const dbPort = parseInt(process.env.DB_PORT || '3306', 10);

const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: Number.isFinite(dbPort) ? dbPort : 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'multipos_db',
  waitForConnections: true,
  connectionLimit: parseInt(process.env.DB_POOL_LIMIT || '50', 10),
  queueLimit: parseInt(process.env.DB_QUEUE_LIMIT || '200', 10),
  idleTimeout: 600000,        // 10 min idle timeout
  keepAliveInitialDelay: 0,
  enableKeepAlive: true,
  charset: 'utf8mb4',
  timezone: 'Z',
  supportBigNumbers: true,
  bigNumberStrings: true,
};

// Create connection pool once at startup
pool = mysql.createPool(dbConfig);

// Guardrail: block direct stock mutation SQL outside approved services.
const DIRECT_STOCK_MUTATION_RE = /update\s+inventory_items\s+set\s+[^;]*current_stock\s*=\s*current_stock\s*[+-]|update\s+inventory_items\s+set\s+current_stock\s*=/i;
function assertStockMutationAllowed(queryText) {
  const q = String(queryText || '');
  if (!DIRECT_STOCK_MUTATION_RE.test(q)) return;
  const hasMarker = q.includes('/*stock_write_allowed*/');
  if (hasMarker) return;
  const msg =
    'Direct stock mutation forbidden: use inventoryProjectionService.applyEvent() or inventoryRebuildService.rebuildStock().';
  if (process.env.NODE_ENV === 'production') throw new Error('Direct stock mutation forbidden');
  throw new Error(msg);
}

const originalPoolExecute = pool.execute.bind(pool);
pool.execute = async (query, params = []) => {
  assertStockMutationAllowed(query);
  return originalPoolExecute(query, params);
};

const originalGetConnection = pool.getConnection.bind(pool);
pool.getConnection = async (...args) => {
  const conn = await originalGetConnection(...args);
  if (!conn.__stockGuardWrapped) {
    const origConnExecute = conn.execute.bind(conn);
    conn.execute = async (query, params = []) => {
      assertStockMutationAllowed(query);
      return origConnExecute(query, params);
    };
    conn.__stockGuardWrapped = true;
  }
  return conn;
};

// ─────────────────────────────────────────────────────────────
// executeWithRetry — retries only on transient connection errors
// ─────────────────────────────────────────────────────────────
const executeWithRetry = async (query, params = [], retries = 3) => {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const [rows] = await pool.execute(query, params);
      return rows;
    } catch (error) {
      const isTransient = (
        error.code === 'ECONNRESET' ||
        error.code === 'PROTOCOL_CONNECTION_LOST' ||
        error.code === 'ETIMEDOUT' ||
        error.code === 'ECONNREFUSED'
      );

      if (isTransient && attempt < retries) {
        const delay = attempt * 1000; // 1s, 2s backoff
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      // Non-transient error or max retries reached — throw immediately
      throw error;
    }
  }
};

// Simple wrapper (kept for backward compatibility)
const executeQuery = async (query, params = []) => {
  return executeWithRetry(query, params);
};

// ─────────────────────────────────────────────────────────────
// connectDB — test connection at startup only
// ─────────────────────────────────────────────────────────────
const connectDB = async () => {
  try {
    const connection = await pool.getConnection();
    connection.release();
    console.log(`MySQL connected: ${dbConfig.host}:${dbConfig.port}/${dbConfig.database}`);
  } catch (error) {
    console.error(
      `MySQL connection failed (${dbConfig.host}:${dbConfig.port}/${dbConfig.database}): ${error.message}`
    );
    if (error.code === 'ER_ACCESS_DENIED_ERROR') {
      console.error(
        'Remote access denied. In cPanel → Remote MySQL, whitelist your IP and confirm DB_USER/DB_PASSWORD.'
      );
    }
  }
};

// Graceful shutdown
const closeDB = async () => {
  try {
    await pool.end();
  } catch (error) {
  }
};

module.exports = {
  pool,
  connectDB,
  closeDB,
  executeQuery,
  executeWithRetry,
};