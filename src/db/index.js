// 引入 mysql2 的 promise 版本，支持 async/await
const mysql = require('mysql2/promise')
// 加载 .env 环境变量
require('dotenv').config()
// 创建数据库连接池
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',      // 数据库主机
  port: process.env.DB_PORT || 3306,             // 数据库端口
  user: process.env.DB_USER || 'root',          // 数据库用户名
  password: process.env.DB_PASSWORD || 'admin123',      // 数据库密码
  database: process.env.DB_NAME || 'ai_chat',   // 数据库名称
  waitForConnections: true,                     // 连接池满时等待
  connectionLimit: 10,                           // 最大连接数
  queueLimit: 0                                  // 队列无限
})
// 导出连接池，供其他模块使用
module.exports = pool