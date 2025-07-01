const express = require('express');
const router = express.Router();
const Joi = require('joi');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { authenticate } = require('./authMiddleware');

module.exports = function(dbPool) {

  // 用户注册接口
  router.post('/register', async (req, res) => {
    // 定义注册信息的校验规则
    const registerSchema = Joi.object({
      name: Joi.string().min(2).max(50).required(),
      gender: Joi.string().valid('男', '女').required(),
      address: Joi.string().min(5).max(255).required(),
      phone_number: Joi.string().pattern(/^1[3-9]\d{9}$/).required().messages({
        'string.pattern.base': '无效的手机号码格式。'
      }),
      password: Joi.string().min(6).required().messages({
        'string.min': '密码长度不能少于6位。'
      })
    });

    const { error, value } = registerSchema.validate(req.body);
    if (error) {
      return res.status(400).json({ success: false, message: `输入数据无效: ${error.details[0].message}` });
    }

    const { name, gender, address, phone_number, password } = value;
    let connection;

    try {
      connection = await dbPool.getConnection();
      // 检查手机号是否已被注册
      const [existingUsers] = await connection.query('SELECT id FROM users WHERE phone_number = ?', [phone_number]);
      if (existingUsers.length > 0) {
        return res.status(409).json({ success: false, message: '注册失败，该手机号码已被使用。' });
      }

      const hashedPassword = await bcrypt.hash(password, 10);

      const insertUserSQL = `
        INSERT INTO users (name, gender, address, phone_number, password, role)
        VALUES (?, ?, ?, ?, ?, 'customer');
      `;
      const [result] = await connection.query(insertUserSQL, [name, gender, address, phone_number, hashedPassword]);
      
      res.status(201).json({
        success: true,
        message: '用户注册成功！',
        data: { user_id: result.insertId }
      });

    } catch (dbError) {
      console.error('用户注册时发生数据库错误:', dbError);
      res.status(500).json({ success: false, message: '服务器内部错误，注册失败。' });
    } finally {
      if (connection) connection.release();
    }
  });

  // 用户登录接口
  router.post('/login', async (req, res) => {
    const loginSchema = Joi.object({
      phone_number: Joi.string().required(),
      password: Joi.string().required()
    });

    const { error, value } = loginSchema.validate(req.body);
    if (error) {
      return res.status(400).json({ success: false, message: error.details[0].message });
    }

    const { phone_number, password } = value;
    let connection;
    
    try {
      connection = await dbPool.getConnection();
      const [users] = await connection.query('SELECT * FROM users WHERE phone_number = ?', [phone_number]);

      if (users.length === 0) {
        return res.status(401).json({ success: false, message: '认证失败：用户不存在。' });
      }

      const user = users[0];
      const isPasswordMatch = await bcrypt.compare(password, user.password);

      if (!isPasswordMatch) {
        return res.status(401).json({ success: false, message: '认证失败：密码不正确。' });
      }

      // 密码匹配，生成JWT
      const token = jwt.sign(
        { user_id: user.id, role: user.role }, // 在Token中存储用户ID和角色
        process.env.JWT_SECRET,               // 使用环境变量中的密钥
        { expiresIn: '4h' }                  // Token有效期4小时
      );

      res.status(200).json({
        success: true,
        message: '登录成功！',
        data: {
          token,
          user: { id: user.id, name: user.name, role: user.role }
        }
      });

    } catch (dbError) {
      console.error('登录时发生数据库错误:', dbError);
      res.status(500).json({ success: false, message: '服务器内部错误，登录失败。' });
    } finally {
      if (connection) connection.release();
    }
  });


  // 获取用户个人资料接口 (用于自动填充表单)
  router.get('/profile', authenticate, async (req, res) => {
    const user_id = req.user.user_id; // 从中间件附加的 req.user 中获取用户ID
    let connection;

    try {
      connection = await dbPool.getConnection();
      const [users] = await connection.query(
        'SELECT id, name, gender, address, phone_number, role FROM users WHERE id = ?',
        [user_id]
      );
      
      if (users.length === 0) {
        return res.status(404).json({ success: false, message: '找不到该用户信息。' });
      }

      res.status(200).json({
        success: true,
        message: '成功获取用户资料。',
        data: users[0]
      });

    } catch (dbError) {
      console.error('获取用户资料时发生数据库错误:', dbError);
      res.status(500).json({ success: false, message: '服务器内部错误，获取资料失败。' });
    } finally {
      if (connection) connection.release();
    }
  });

  return router;
};
