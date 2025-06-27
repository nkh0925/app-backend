//导入所需模块
const express = require('express');
const mysql = require('mysql2/promise'); 
const multer = require('multer');
const Joi = require('joi'); //数据校验库
const { blobServiceClient } = require('./azure-service');
const { BlobSASPermissions, generateBlobSASQueryParameters, SASProtocol } = require('@azure/storage-blob');
require('dotenv').config();

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

// 提交申请接口
app.post('/api/application/submit', async (req, res) => {

  console.log("服务器收到的原始请求体 (req.body):", req.body);

  //定义数据校验规则
  const applicationSchema = Joi.object({
    name: Joi.string().min(2).max(50).required(),
    gender: Joi.string().valid('男', '女').required(),
    id_type: Joi.string().valid('居民身份证', '港澳台居民居住证').required(),
    id_number: Joi.string().when('id_type', {
      switch: [
        { 
          is: '居民身份证', 
          then: Joi.string().pattern(/^[1-9]\d{5}(18|19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\d{3}(\d|X|x)$/).required().messages({
            'string.pattern.base': '无效的居民身份证号码格式。'
          })
        },
        { 
          is: '港澳台居民居住证', 
          then: Joi.string().pattern(/^8[123]0000(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dX]$/).required().messages({
            'string.pattern.base': '无效的港澳台居民居住证号码格式。'
          })
        }
      ]
    }),
    phone_number: Joi.string().pattern(/^1[3-9]\d{9}$/).required().messages({
      'string.pattern.base': '无效的手机号码格式。'
    }),
    address: Joi.string().min(5).max(255).required(),
    // 我们只校验收到的 URL 是不是一个合法的字符串，因为真正的文件已经在上传接口验证过了
    id_front_photo_url: Joi.string().uri().required(),
    id_back_photo_url: Joi.string().uri().required(),
  });

  // 使用 Joi 进行数据校验
const { error, value } = applicationSchema.validate(req.body);
if (error) {
  console.error("完整校验错误详情：", error.details);
  const message = error.details[0].message;
  console.error("校验失败详情：", {
    error: error.details,
    receivedData: req.body
  });
  return res.status(400).json({
    success: false,
    message: `输入数据无效: ${message}`
  });
} else if (!value) {
  return res.status(400).json({
    success: false,
    message: '未知校验错误，输入的数据可能不完整。'
  });
}  const {
    name,
    gender,
    id_type,
    id_number,
    phone_number,
    address,
    id_front_photo_url,
    id_back_photo_url
  } = value;
  
  let connection;

  try {
    connection = await dbPool.getConnection();
    await connection.beginTransaction();

    // 更新 SQL 语句以包含所有新字段
    const insertApplicationSQL = `
      INSERT INTO application_info 
      (name, gender, id_type, id_number, phone_number, address, id_front_photo_url, id_back_photo_url) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?);
    `;
    const [applicationResult] = await connection.query(insertApplicationSQL, [
      name,
      gender,
      id_type,
      id_number,
      phone_number,
      address,
      id_front_photo_url,
      id_back_photo_url
    ]);
    
    const newApplicationId = applicationResult.insertId;

    // 日志记录保持不变
    const insertLogSQL = `
      INSERT INTO audit_log (application_id, operator_id, action, remarks) 
      VALUES (?, ?, ?, ?);
    `;
    await connection.query(insertLogSQL, [newApplicationId, 'system', 'SUBMIT', '客户线上提交申请']);

    await connection.commit();

    res.status(201).json({
      success: true,
      message: '申请提交成功！',
      data: {
        applicationId: newApplicationId
      }
    });

  } catch (dbError) {
    if (connection) {
      await connection.rollback();
    }
    
    // 处理唯一的身份证号冲突
    if (dbError.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({
        success: false,
        message: '申请提交失败，该证件号码已经提交过申请。'
      });
    }

    console.error('申请提交时发生数据库错误:', dbError);
    res.status(500).json({
      success: false,
      message: '服务器内部错误，请稍后再试。',
      error: dbError.message
    });

  } finally {
    if (connection) {
      connection.release();
    }
  }
});

// 配置 Multer
// 我们使用 memoryStorage，因为我们只是想获取文件的 buffer，然后直接流式传输到Azure，
// 并不需要在服务器上临时保存文件。
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 限制文件大小为 5MB
});

// 文件上传接口
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
