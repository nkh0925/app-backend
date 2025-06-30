// audit.js
const express = require('express');
const router = express.Router();
const Joi = require('joi');

module.exports = function(dbPool) {

  // 申请列表接口
  router.get('/list', async (req, res) => {
    // 定义并校验用于筛选和分页的查询参数
    const listSchema = Joi.object({
      name: Joi.string().allow('').optional(),        // 允许姓名为空字符串或未定义
      id_number: Joi.string().allow('').optional(),   // 允许证件号为空字符串或未定义
      status: Joi.string().valid('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED').allow('').optional(), // 状态必须是这三者之一，也允许为空
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

      // 使用 Promise.all 并行查询申请详情和审核历史，提高效率
      const applicationQuery = 'SELECT * FROM application_info WHERE id = ?';
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
          details: applications[0], // 申请的完整信息
          history: history          // 相关的审核历史记录数组
        }
      });

    } catch (dbError) {
      console.error('获取申请详情时发生数据库错误:', dbError);
      res.status(500).json({ success: false, message: '服务器内部错误，获取详情失败。' });
    } finally {
      if (connection) connection.release();
    }
  });

  return router;
};
