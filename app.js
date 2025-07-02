const express = require('express');
const morgan = require('morgan');
const mysql = require('mysql2/promise'); 
const compression = require('compression');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(compression());
app.use(express.json());
app.use(cors());

app.use(morgan(':method :url :status :response-time ms'));

// 创建数据库连接池
const dbPool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// 测试数据库连接
app.get('/api/test-db', async (req, res) => {
  try {
    const [rows] = await dbPool.query('SELECT * FROM `application_info` LIMIT 1;');
    res.status(200).json({
      success: true,
      message: '数据库连接成功！',
      data: rows
    });
  } catch (error) {
    console.error('数据库连接测试失败:', error);
    res.status(500).json({
      success: false,
      message: '数据库连接测试失败。',
      error: error.message
    });
  }
});


// 认证路由
const authRoutes = require('./auth')(dbPool);
app.use('/api/auth', authRoutes);

// 客户端路由
const clientRoutes = require('./client')(dbPool);
app.use('/api', clientRoutes);

// 审核路由
const auditRoutes = require('./audit')(dbPool);
app.use('/api/audit', auditRoutes);

// 启动服务器
const PORT = process.env.PORT || 3001;
app.listen(PORT, async () => {
  try {
    const connection = await dbPool.getConnection();
    console.log('成功连接到数据库！');
    connection.release();
  } catch (error) {
    console.error('无法连接到数据库:', error);
  }
  console.log(`服务器正在 http://localhost:${PORT} 上运行`);
});
