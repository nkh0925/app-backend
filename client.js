const express = require('express');
const router = express.Router();
const path = require('path');
const Joi = require('joi');
const multer = require('multer');
const { authenticate } = require('./authMiddleware');
const { blobServiceClient } = require('./azure-service');

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

    // 校验年龄
    const isAge60OrOver = (value, helpers) => {
        const birthDate = new Date(value);
        const today = new Date();
        let age = today.getFullYear() - birthDate.getFullYear();
        const monthDifference = today.getMonth() - birthDate.getMonth();
        if (monthDifference < 0 || (monthDifference === 0 && today.getDate() < birthDate.getDate())) {
            age--;
        }

        if (age < 60) {
            // 如果年龄小于60，返回错误信息
            return helpers.message('不符合安心卡申领条件：申请人必须年满60周岁');
        }
        return value; 
    };

    //定义数据校验规则
    const applicationSchema = Joi.object({
      name: Joi.string().required().messages({'any.required': '申请人姓名不能为空'}),
      gender: Joi.string().valid('男', '女').required().messages({'any.required': '请选择性别'}),
      phone_number: Joi.string().pattern(/^[1-9]\d{10}$/).required().messages({
          'string.pattern.base': '无效的手机号码格式。',
          'any.required': '手机号码不能为空'
      }),
      address: Joi.string().required().messages({'any.required': '联系地址不能为空'}),  
      birthday: Joi.date().iso().required().custom(isAge60OrOver, 'Age Validation'),        
      id_type: Joi.alternatives().try(
            Joi.string().valid('居民身份证', '港澳台居民居住证'),
            Joi.array().items(Joi.string().valid('居民身份证', '港澳台居民居住证')).single()
          ).required(),
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
            then: Joi.string().pattern(/^8[123]0000(18|19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\d{3}[\dX]$/).required().messages({
              'string.pattern.base': '无效的港澳台居民居住证号码格式。'
            })
          }
        ]
      }),
      id_front_photo_url: Joi.string().uri().required(),
      id_back_photo_url: Joi.string().uri().required(),
    });

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
      name,
      gender,
      phone_number,
      address,  
      birthday,
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

      const insertApplicationSQL = `
        INSERT INTO application_info (user_id, name, gender, birthday, phone_number, address, id_type, id_number, id_front_photo_url, id_back_photo_url) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
        `;
        
      const [applicationResult] = await connection.query(insertApplicationSQL, [
        user_id,
        name,
        gender,
        birthday,
        phone_number,
        address,
        id_type,
        id_number,
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
        SELECT id, name, gender, birthday, phone_number, address, id_type, id_number, 
        id_front_photo_url, id_back_photo_url, status, comments, created_at, updated_at         
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

// 修改重提接口
router.post('/application/update', async (req, res) => {
    const updateSchema = Joi.object({
        application_id: Joi.number().integer().required(),
        name: Joi.string().optional(),
        gender: Joi.string().valid('男', '女').optional(),
        birthday: Joi.date().iso().optional(),
        phone_number: Joi.string().pattern(/^[1-9]\d{10}$/).required().messages({
            'string.pattern.base': '无效的手机号码格式。',
        }),
        address: Joi.string().optional(),
        id_type: Joi.alternatives().try(
            Joi.string().valid('居民身份证', '港澳台居民居住证'),
            Joi.array().items(Joi.string().valid('居民身份证', '港澳台居民居住证')).single()
          ).optional(),
        id_number: Joi.string().when('id_type', {
        switch: [
          { 
            is: '居民身份证', 
            then: Joi.string().pattern(/^[1-9]\d{5}(18|19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\d{3}(\d|X|x)$/).optional().messages({
              'string.pattern.base': '无效的居民身份证号码格式。'
            })
          },
          { 
            is: '港澳台居民居住证', 
            then: Joi.string().pattern(/^8[123]0000(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dX]$/).optional().messages({
              'string.pattern.base': '无效的港澳台居民居住证号码格式。'
            })
          }
        ]
      }),
        id_front_photo_url: Joi.string().uri().optional(),
        id_back_photo_url: Joi.string().uri().optional(),
    }).min(0);

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

    try {
        connection = await dbPool.getConnection();
        await connection.beginTransaction();

        // 验证申请状态
        const [apps] = await connection.query(
            `SELECT user_id, status, name, gender, birthday, phone_number, 
                    address, id_type, id_number, id_front_photo_url, id_back_photo_url 
             FROM application_info 
             WHERE id = ? FOR UPDATE`, 
            [application_id]
        );
        if (apps.length === 0) {
            await connection.rollback();
            return res.status(404).json({ success: false, message: '申请记录不存在。' });
        }
        if (apps[0].user_id !== user_id) {
            await connection.rollback();
            return res.status(403).json({ success: false, message: '授权失败：您无权修改此申请。' });
        }
        if (apps[0].status !== 'REJECTED') {
            await connection.rollback();
            return res.status(403).json({ success: false, message: `操作被拒绝：只有被驳回的申请才能修改，当前状态为 "${apps[0].status}"。` });
        }

        // 构建有效修改字段
        const modifiedFields = {};
        const originalData = apps[0];
        
        // 通用字段对比
        const fieldMapping = {
            name: 'name',
            gender: 'gender',
            birthday: (v) => formatDate(v) === formatDate(originalData.birthday),
            phone_number: 'phone_number',
            address: 'address',
            id_type: 'id_type',
            id_number: 'id_number',
            id_front_photo_url: 'id_front_photo_url',
            id_back_photo_url: 'id_back_photo_url'
        };

        for (const [key, compareFn] of Object.entries(fieldMapping)) {
            if (updateData[key] !== undefined) {
                if (typeof compareFn === 'function') {
                    if (!compareFn(updateData[key])) {
                        modifiedFields[key] = updateData[key];
                    }
                } else if (updateData[key] !== originalData[compareFn]) {
                    modifiedFields[key] = updateData[key];
                }
            }
        }

        // 检测是否有实际修改
        if (Object.keys(modifiedFields).length === 0) {
            await connection.rollback();
            return res.status(400).json({ 
                success: false, 
                message: '未检测到任何有效修改，请修改后重新提交' 
            });
        }

        // 只更新修改过的字段
        modifiedFields.status = 'PENDING';
        modifiedFields.comments = null;
        modifiedFields.updated_at = new Date();

        // 构建动态更新SQL
        const updateFields = Object.keys(modifiedFields).map(key => `${key} = ?`).join(', ');
        const updateValues = Object.values(modifiedFields);
        
        const updateSQL = `UPDATE application_info SET ${updateFields} WHERE id = ?`;
        await connection.query(updateSQL, [...updateValues, application_id]);

        // 记录操作日志
        const logSQL = `INSERT INTO audit_log (application_id, user_id, action, remarks) VALUES (?, ?, 'RESUBMIT', '客户修改后重新提交');`;
        await connection.query(logSQL, [application_id, user_id]);

        await connection.commit();
        res.status(200).json({
            success: true,
            message: '申请已成功修改并重新提交。'
        });

    } catch (dbError) {
        if (connection) await connection.rollback();
        console.error('更新申请时发生数据库错误:', dbError);
        res.status(500).json({ success: false, message: '服务器内部错误，操作失败。' });
    } finally {
        if (connection) connection.release();
    }
});

//  取消申请接口
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
    const user_id = req.user.user_id;
    let connection;

    try {
      connection = await dbPool.getConnection();
      await connection.beginTransaction();

      // 查询申请
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
        if (!['PENDING', 'REJECTED'].includes(apps[0].status) ) {
            await connection.rollback();
            return res.status(403).json({ 
              success: false, 
              message: `操作被拒绝：只有待处理或被驳回的申请才能取消，当前状态为 "${apps[0].status}"。` });
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

      // 规范化文件名
      const containerName = process.env.AZURE_STORAGE_CONTAINER_NAME;
      const fileExtension = path.extname(req.file.originalname); // 获取文件扩展名, e.g., '.png'
      const userId = req.user.user_id; // 从 authenticate 中间件获取用户ID
      const newBlobName = `user_${userId}_${Date.now()}${fileExtension}`; // 创建安全唯一的文件名

      const containerClient = blobServiceClient.getContainerClient(containerName);
      const blockBlobClient = containerClient.getBlockBlobClient(newBlobName); // 使用新文件名

      // 使用 uploadData API
      await blockBlobClient.upload(req.file.buffer, req.file.buffer.length, {
        blobHTTPHeaders: { blobContentType: req.file.mimetype }
      });

      // 返回永久的、公开的URL
      res.status(200).json({
        success: true,
        message: '文件上传成功！',
        data: {
          url: blockBlobClient.url, 
        }
      });

    } catch (error) {
      console.error('文件上传到Azure时发生错误:', error);
      res.status(500).json({ success: false, message: '服务器内部错误，文件上传失败。', error: error.message });
    }
  });

  return router;
};
