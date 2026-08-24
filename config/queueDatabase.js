const mysql = require('mysql2/promise');

let pool;

const dbPort = parseInt(process.env.QUEUE_DB_PORT || process.env.DB_PORT || '3306', 10);

const dbConfig = {
  host: process.env.QUEUE_DB_HOST || process.env.DB_HOST || 'localhost',
  port: Number.isFinite(dbPort) ? dbPort : 3306,
  user: process.env.QUEUE_DB_USER || process.env.DB_USER,
  password: process.env.QUEUE_DB_PASSWORD || process.env.DB_PASSWORD,
  database: process.env.QUEUE_DB_NAME || 'petzonep_queue-management',
  waitForConnections: true,
  connectionLimit: parseInt(process.env.QUEUE_DB_POOL_LIMIT || '10', 10),
  queueLimit: 0,
  charset: 'utf8mb4',
  timezone: 'Z',
};

pool = mysql.createPool(dbConfig);

const executeQuery = async (query, params = []) => {
  const [rows] = await pool.execute(query, params);
  return rows;
};

const connectQueueDB = async () => {
  const conn = await pool.getConnection();
  conn.release();
  console.log(`Queue MySQL connected: ${dbConfig.host}:${dbConfig.port}/${dbConfig.database}`);
};

module.exports = { pool, executeQuery, connectQueueDB };
