//导入所需模块
const express = require('express');
const mysql = require('mysql2/promise'); 
const multer = require('multer');
const { blobServiceClient } = require('./azure-service');
const { BlobSASPermissions, generateBlobSASQueryParameters, SASProtocol } = require('@azure/storage-blob');
require('dotenv').config(); // 自动加载 .env 文件中的环境变量

// 2. 初始化 Express 应用
const app = express();
app.use(express.json());

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
    // 从连接池中获取一个连接，并执行一个简单的查询
    const [rows] = await dbPool.query('SELECT * FROM `application_info` LIMIT 1;');
    
    // 如果查询成功，返回成功信息和查询到的数据
    res.status(200).json({
      success: true,
      message: '数据库连接成功！',
      data: rows
    });
  } catch (error) {
    // 如果出现错误，打印错误日志并返回服务器错误信息
    console.error('数据库连接测试失败:', error);
    res.status(500).json({
      success: false,
      message: '数据库连接测试失败。',
      error: error.message
    });
  }
});

// 配置 Multer
// 我们使用 memoryStorage，因为我们只是想获取文件的 buffer，然后直接流式传输到Azure，
// 并不需要在服务器上临时保存文件。
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 限制文件大小为 5MB
});

// API 路由: 上传单个文件到 Azure Blob Storage (POST /api/upload)
app.post('/api/file/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: '没有提供文件用于上传。' });
    }

    const containerName = process.env.AZURE_STORAGE_CONTAINER_NAME;
    const containerClient = blobServiceClient.getContainerClient(containerName);
    
    const blobName = `${Date.now()}-${req.file.originalname}`;
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);

    await blockBlobClient.uploadData(req.file.buffer, {
      blobHTTPHeaders: { blobContentType: req.file.mimetype }
    });

    // 生成SAS令牌
    const sasOptions = {
      containerName: containerName,
      blobName: blobName,
      startsOn: new Date(), // 令牌立即生效
      expiresOn: new Date(new Date().valueOf() + 3600 * 1000), // 令牌在1小时后过期
      permissions: BlobSASPermissions.parse("r"), // "r" 代表只读 (Read) 权限
      protocol: SASProtocol.Https // 强制使用 HTTPS
    };

    //生成SAS查询参数字符串
    const sasToken = generateBlobSASQueryParameters(sasOptions, blobServiceClient.credential).toString();

    //将原始URL和SAS令牌组合成最终的、可访问的URL
    const sasUrl = `${blockBlobClient.url}?${sasToken}`;

    res.status(200).json({
      success: true,
      message: '文件上传成功！',
      data: {
        // 返回带有SAS令牌的URL，而不是原始URL
        url: sasUrl 
      }
    });

  } catch (error) {
    console.error('文件上传到Azure时发生错误:', error);
    res.status(500).json({ success: false, message: '服务器内部错误，文件上传失败。', error: error.message });
  }
});

// 启动服务器
const PORT = process.env.PORT || 3001;
app.listen(PORT, async () => {
  // 服务器启动时，也测试一下数据库连接
  try {
    const connection = await dbPool.getConnection();
    console.log('成功连接到数据库！');
    connection.release(); // 释放连接
  } catch (error) {
    console.error('无法连接到数据库:', error);
  }
  console.log(`服务器正在 http://localhost:${PORT} 上运行`);
});
