const express = require('express');
const router = express.Router();
const Joi = require('joi');
const multer = require('multer');
const { authenticate } = require('./authMiddleware');
const { blobServiceClient } = require('./azure-service');
const { BlobSASPermissions, generateBlobSASQueryParameters, SASProtocol } = require('@azure/storage-blob');

// 配置 Multer
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 限制文件大小为 5MB
});

module.exports = function(dbPool) {

  router.use(authenticate);
  // 提交申请接口
  router.post('/application/submit', async (req, res) => {
    console.log("服务器收到的原始请求体 (req.body):", req.body);

    //定义数据校验规则
    const applicationSchema = Joi.object({
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
    }
    
    const {
      id_type,
      id_number,
      id_front_photo_url,
      id_back_photo_url
    } = value;
    const user_id = req.user.user_id;
    
    let connection;

    try {
      connection = await dbPool.getConnection();
      await connection.beginTransaction();

      const [users] = await connection.query('SELECT name, gender, phone_number, address FROM users WHERE id = ?', [user_id]);
            if (users.length === 0) {
              return res.status(404).json({ success: false, message: '无法找到当前用户信息。' });
            }
            const userInfo = users[0];

            const insertApplicationSQL = `
              INSERT INTO application_info (user_id, name, gender, id_type, id_number, phone_number, address, id_front_photo_url, id_back_photo_url) 
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);
            `;
            const [applicationResult] = await connection.query(insertApplicationSQL, [
              user_id,
              userInfo.name,
              userInfo.gender,
              id_type,
              id_number,
              userInfo.phone_number,
              userInfo.address,
              id_front_photo_url,
              id_back_photo_url
            ]);
            const newApplicationId = applicationResult.insertId;

            const insertLogSQL = `
              INSERT INTO audit_log (application_id, user_id, action, remarks) 
              VALUES (?, ?, ?, ?);
            `;

            await connection.query(insertLogSQL, [newApplicationId, user_id, 'SUBMIT', '客户线上提交申请']);
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

// 查询申请接口
   router.post('/application/query', async (req, res) => {
    const user_id = req.user.user_id;
    let connection;
    try {
      connection = await dbPool.getConnection();
      // 只允许用户查询自己的申请记录
      const findApplicationSQL = `
        SELECT id, name, status, created_at, updated_at 
        FROM application_info 
        WHERE user_id = ?
        ORDER BY id DESC;
      `;
      const [applications] = await connection.query(findApplicationSQL, [user_id]);

      if (applications.length === 0) {
        return res.status(404).json({ success: false, message: '未找到您的任何申请记录。' });
      }
      res.status(200).json({ success: true, message: '成功查询到申请状态。', data: applications });
    } catch (dbError) {
      console.error('查询申请进度时发生数据库错误:', dbError);
      res.status(500).json({
        success: false,
        message: '服务器内部错误，查询失败。',
        error: dbError.message
      });
    } finally {
      if (connection) {
        connection.release();
      }
    }
  });

// 修改申请接口
  router.post('/application/update', async (req, res) => {
    // 定义可修改字段的校验规则
    const updateSchema = Joi.object({
      application_id: Joi.number().integer().required(),
      id_front_photo_url: Joi.string().uri().required(),
      id_back_photo_url: Joi.string().uri().required(),
    });

    const { error, value } = updateSchema.validate(req.body);

    if (error) {
      return res.status(400).json({
        success: false,
        message: `输入数据无效: ${error.details[0].message}`
      });
    }
    
    const { application_id, ...updateData } = value;
    const user_id = req.user.user_id;

    if (Object.keys(updateData).length === 0) {
    return res.status(400).json({ success: false, message: '无需更新，未提供任何待修改的数据。' });
    }

    let connection;

    try {connection = await dbPool.getConnection();
        await connection.beginTransaction();

        // 查询申请，并加锁防止并发问题
        const [apps] = await connection.query('SELECT user_id, status FROM application_info WHERE id = ? FOR UPDATE', [application_id]);
        if (apps.length === 0) {
            await connection.rollback();
            return res.status(404).json({ success: false, message: '申请记录不存在。' });
        }
        
        // 确保该申请属于当前登录的用户
        if (apps[0].user_id !== user_id) {
            await connection.rollback();
            return res.status(403).json({ success: false, message: '授权失败：您无权修改此申请。' });
        }

        // 确保只有被驳回的申请才能被修改
        if (apps[0].status !== 'REJECTED') {
            await connection.rollback();
            return res.status(403).json({ success: false, message: `操作被拒绝：只有被驳回的申请才能修改，当前状态为 "${apps[0].status}"。` });
        }

        // 将状态重新置为'PENDING'，并更新修改时间
        updateData.status = 'PENDING'; 
        updateData.updated_at = new Date();
        const updateSQL = 'UPDATE application_info SET ? WHERE id = ?';
        await connection.query(updateSQL, [updateData, application_id]);

        // 记录操作日志
        const logSQL = `INSERT INTO audit_log (application_id, user_id, action, remarks) VALUES (?, ?, 'RESUBMIT', '客户修改后重新提交');`;
        await connection.query(logSQL, [application_id, user_id]);

        await connection.commit();
        res.status(200).json({ 
          success: true, 
          message: '申请已成功修改并重新提交审核。' });} 

    catch (dbError) {
        if (connection) await connection.rollback();
        console.error('更新申请时发生数据库错误:', dbError);
        res.status(500).json({ success: false, message: '服务器内部错误，操作失败。' });
    } finally {
      if (connection) connection.release();
    }
  });

//   取消申请接口
  router.post('/application/cancel', async (req, res) => {
    //校验请求体中的 application_id
    const cancelSchema = Joi.object({
      application_id: Joi.number().integer().required().messages({
        'any.required': '申请ID是必填项。',
        'number.base': '申请ID必须是数字。'
      })
    });

    const { error, value } = cancelSchema.validate(req.body);

    if (error) {
      return res.status(400).json({
        success: false,
        message: `输入数据无效: ${error.details[0].message}`
      });
    }

    const { application_id } = value;
    let connection;

    try {
      connection = await dbPool.getConnection();
      await connection.beginTransaction();

      // 查询申请并加锁
        const [apps] = await connection.query('SELECT user_id, status FROM application_info WHERE id = ? FOR UPDATE', [application_id]);
        if (apps.length === 0) {
            await connection.rollback();
            return res.status(404).json({ 
              success: false, 
              message: '申请记录不存在。' });
        }
        
        // 确保申请属于当前用户
        if (apps[0].user_id !== user_id) {
            await connection.rollback();
            return res.status(403).json({ 
              success: false, 
              message: '授权失败：您无权取消此申请。' });
        }

        // 确保只有待处理的申请才能被取消
        if (apps[0].status !== 'PENDING') {
            await connection.rollback();
            return res.status(403).json({ 
              success: false, 
              message: `操作被拒绝：只有待处理的申请才能取消，当前状态为 "${apps[0].status}"。` });
        }

        // 执行更新
        const updateSQL = "UPDATE application_info SET status = 'CANCELLED', updated_at = NOW() WHERE id = ?";
        await connection.query(updateSQL, [application_id]);

        // 记录日志
        const logSQL = `INSERT INTO audit_log (application_id, user_id, action, remarks) VALUES (?, ?, 'CANCEL', '客户主动取消申请');`;
        await connection.query(logSQL, [application_id, user_id]);

        await connection.commit();
        res.status(200).json({ success: true, message: '申请已成功取消。' });

    } catch (dbError) {
      if (connection) await connection.rollback();
      console.error('取消申请时发生数据库错误:', dbError);
      res.status(500).json({ success: false, message: '服务器内部错误，操作失败。' });
    } finally {
      if (connection) connection.release();
    }
  });

  // 文件上传接口
  router.post('/file/upload', upload.single('file'), async (req, res) => {
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

      const sasOptions = {
        containerName: containerName,
        blobName: blobName,
        startsOn: new Date(),
        expiresOn: new Date(new Date().valueOf() + 3600 * 1000),
        permissions: BlobSASPermissions.parse("r"),
        protocol: SASProtocol.Https
      };

      const sasToken = generateBlobSASQueryParameters(sasOptions, blobServiceClient.credential).toString();
      const sasUrl = `${blockBlobClient.url}?${sasToken}`;

      res.status(200).json({
        success: true,
        message: '文件上传成功！',
        data: {
          url: sasUrl 
        }
      });

    } catch (error) {
      console.error('文件上传到Azure时发生错误:', error);
      res.status(500).json({ success: false, message: '服务器内部错误，文件上传失败。', error: error.message });
    }
  });

  return router;
};
