// 引入 Express 框架
const express = require('express')

// 引入聊天路由
const chatRoutes = require('./routes/chat')

// 创建 Express 应用实例
const app = express()

// ============================================
// 中间件配置
// ============================================
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*')
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE')
  res.header('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') {
    return res.status(204).send()
  }

  next()
})

// 解析 JSON 请求体
app.use(express.json())

// ============================================
// 路由配置
// ============================================

// 所有 /api 开头的请求都交给 chatRoutes 处理
app.use('/api', chatRoutes)

// 健康检查接口
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

// ============================================
// 错误处理中间件（可选）
// ============================================

// 404 处理
app.use((req, res) => {
  res.status(404).json({ error: 'Not Found' })
})

// 导出应用实例
module.exports = app
