const jwt = require('jsonwebtoken');

// 认证中间件：检查Token是否存在且有效
const authenticate = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, message: '认证失败：请求头缺少有效的Bearer Token。' });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decodedPayload = jwt.verify(token, process.env.JWT_SECRET);
    // 将解码后的用户信息（{ userId, role }）附加到请求对象上，供后续路由使用
    req.user = decodedPayload; 
    next(); // 验证通过，继续执行下一个中间件或路由处理函数
  } catch (error) {
    return res.status(401).json({ success: false, message: '认证失败：Token无效或已过期。' });
  }
};

// 授权中间件：检查用户角色是否符合要求
const authorize = (allowedRoles = []) => {
  return (req, res, next) => {
    if (!req.user || !req.user.role) {
      return res.status(403).json({ success: false, message: '授权失败：无法确定用户角色。' });
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ success: false, message: '授权失败：您没有权限执行此操作。' });
    }
    
    next(); // 角色符合要求，继续
  };
};

module.exports = { authenticate, authorize };
