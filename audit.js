// audit.js
const express = require('express');
const router = express.Router();
const Joi = require('joi');
const { authenticate, authorize } = require('./authMiddleware');
module.exports = function(dbPool) {

  // 对所有审核接口，要求先登录(authenticate)，然后检查角色(authorize)
  router.use(authenticate);
  router.use(authorize(['auditor', 'admin']));

  // 申请列表接口
  router.get('/list', async (req, res) => {
    // 定义并校验用于筛选和分页的查询参数
    const listSchema = Joi.object({
      name: Joi.string().allow('').optional(),        // 允许姓名为空字符串或未定义
      id_number: Joi.string().allow('').optional(),   // 允许证件号为空字符串或未定义
      status: Joi.string().valid('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED').allow('').optional(), // 状态必须是这四者之一，也允许为空
      page: Joi.number().integer().min(1).default(1),      
      pageSize: Joi.number().integer().min(1).default(10) 
    });

    const { error, value } = listSchema.validate(req.query);
    if (error) {
      return res.status(400).json({ success: false, message: `查询参数无效: ${error.details[0].message}` });
    }

    const { name, id_number, status, page, pageSize } = value;
    const offset = (page - 1) * pageSize; // 计算数据库查询的偏移量

    let connection;
    try {
      connection = await dbPool.getConnection();
      
      // 动态构建用于筛选的 WHERE 子句
      let whereClauses = [];
      let queryParams = [];

      if (name) {
        whereClauses.push("name LIKE ?");
        queryParams.push(`%${name}%`); 
      }
      if (id_number) {
        whereClauses.push("id_number = ?");
        queryParams.push(id_number);
      }
      if (status) {
        whereClauses.push("status = ?");
        queryParams.push(status);
      }

      const whereString = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
      
      // 创建两条SQL：一条用于计算符合条件的总数，另一条用于获取分页后的数据
      const countQuery = `SELECT COUNT(*) as total FROM application_info ${whereString}`;
      const dataQuery = `
        SELECT id, name, id_number, phone_number, status, created_at 
        FROM application_info 
        ${whereString} 
        ORDER BY id DESC 
        LIMIT ? OFFSET ?
      `;

      // 执行查询
      const [countResult] = await connection.query(countQuery, queryParams);
      const totalItems = countResult[0].total;

      const [applications] = await connection.query(dataQuery, [...queryParams, pageSize, offset]);
      
      // 返回分页格式的响应
      res.status(200).json({
        success: true,
        message: '成功获取申请列表。',
        data: applications,
        pagination: {
          page,
          pageSize,
          totalItems,
          totalPages: Math.ceil(totalItems / pageSize)
        }
      });

    } catch (dbError) {
      console.error('获取申请列表时发生数据库错误:', dbError);
      res.status(500).json({ success: false, message: '服务器内部错误，获取申请列表失败。' });
    } finally {
      if (connection) connection.release();
    }
  });

  // 申请详情接口
  router.post('/detail', async (req, res) => {
    // 校验URL查询参数中的 application_id
    const detailSchema = Joi.object({
      application_id: Joi.number().integer().required()
    });

    const { error, value } = detailSchema.validate(req.body);
    if (error) {
      return res.status(400).json({ success: false, message: `查询参数无效: ${error.details[0].message}` });
    }

    const { application_id } = value;
    let connection;

    try {
      connection = await dbPool.getConnection();
      // 使用JOIN查询，同时获取申请信息和申请人信息
      const applicationQuery = `
        SELECT a.*, u.name as user_name, u.phone_number as user_phone
        FROM application_info a
        LEFT JOIN users u ON a.user_id = u.id
        WHERE a.id = ?
      `;
      const historyQuery = 'SELECT * FROM audit_log WHERE application_id = ? ORDER BY created_at DESC';

      const [[applications], [history]] = await Promise.all([
        connection.query(applicationQuery, [application_id]),
        connection.query(historyQuery, [application_id])
      ]);

      if (applications.length === 0) {
        return res.status(404).json({ success: false, message: '申请记录不存在。' });
      }
      res.status(200).json({
        success: true,
        message: '成功获取申请详情。',
        data: {
          details: applications[0],
          history: history
        }
      });
    } catch (dbError) {
      console.error('获取申请详情时发生数据库错误:', dbError);
      res.status(500).json({ success: false, message: '服务器内部错误，获取详情失败。' });
    } finally {
      if (connection) connection.release();
    }
  });

  // 审核操作接口 
  router.post('/operate', async (req, res) => {
    // 校验请求体
    const operateSchema = Joi.object({
      application_id: Joi.number().integer().required(),
      action: Joi.string().valid('APPROVED', 'REJECTED').required(), // 操作必须是 'APPROVED' 或 'REJECTED'
      comments: Joi.string().allow('').optional() // 备注是可选的
    });

    const { error, value } = operateSchema.validate(req.body);
    if (error) {
      return res.status(400).json({ success: false, message: `输入数据无效: ${error.details[0].message}` });
    }
    
    const { application_id, action, comments } = value;
    const operator_id = req.user_id; 
    let connection;

    try {
      connection = await dbPool.getConnection();
      await connection.beginTransaction();

      // 使用 FOR UPDATE 对该行加锁，防止多个审核员同时操作同一条申请，避免竞态条件
      const [applications] = await connection.query('SELECT status FROM application_info WHERE id = ? FOR UPDATE;', [application_id]);
      if (applications.length === 0) {
        await connection.rollback();
        return res.status(404).json({ success: false, message: '申请记录不存在。' });
      }

      // 只有处于“待处理”状态的申请才能被审核
      const currentStatus = applications[0].status;
      if (currentStatus !== 'PENDING') {
        await connection.rollback();
        return res.status(403).json({ success: false, message: `操作被拒绝：只有“待处理”的申请才能被审核。当前状态为“${currentStatus}”。` });
      }
      
      // 如果是“驳回”操作，则备注(comments)必须填写
      if (action === 'REJECTED' && (!comments || comments.trim() === '')) {
        await connection.rollback();
        return res.status(400).json({ success: false, message: '输入数据无效: 驳回申请时必须提供备注原因。' });
      }

      // 更新申请表的状态
      const updateStatusSQL = "UPDATE application_info SET status = ?, comments = ?, updated_at = NOW() WHERE id = ?";
      await connection.query(updateStatusSQL, [action, comments||null, application_id]);
      
      // 在审计日志表中记录本次操作
      const logActionSQL = 'INSERT INTO audit_log (application_id, user_id, action, remarks) VALUES (?, ?, ?, ?)';
      await connection.query(logActionSQL, [application_id, operator_id, action, comments || null]);

      await connection.commit();

      res.status(200).json({ success: true, message: `申请 #${application_id} 已成功 ${action === 'APPROVED' ? '通过' : '驳回'}。` });

    } catch (dbError) {
      if (connection) await connection.rollback();
      console.error('审核操作时发生数据库错误:', dbError);
      res.status(500).json({ success: false, message: '服务器内部错误，操作失败。' });
    } finally {
      if (connection) connection.release();
    }
  });

  return router;
};
