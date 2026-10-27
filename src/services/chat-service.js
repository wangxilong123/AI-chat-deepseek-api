// 引入 UUID 生成工具，用于创建唯一会话 ID
const { v4: uuidv4 } = require('uuid')
const { API_KEY } = require('../config')

// 引入数据库连接池
const pool = require('../db')

// 引入封装的 axios 请求工具
const request = require('../request')

// 引入 DeepSeek 配置
const { MODEL, TEMPERATURE, MAX_TOKENS } = require('../config')

/**
 * ChatService：对话服务类
 * 负责所有与数据库和 DeepSeek API 交互的业务逻辑
 */
class ChatService {
  /**
   * 获取所有会话列表
   * @returns {Array} 会话数组，按更新时间倒序
   */
  async getAllSessions() {
    const [rows] = await pool.query(
      'SELECT id, title, created_at, updated_at FROM sessions ORDER BY updated_at DESC'
    )
    return rows
  }

  /**
   * 创建新会话
   * @returns {Object} 新创建的会话信息 { id, title }
   */
  async createSession() {
    const id = uuidv4()  // 生成唯一 UUID
    await pool.query('INSERT INTO sessions (id, title) VALUES (?, ?)', [id, '新对话'])
    return { id, title: '新对话' }
  }

  /**
   * 根据 ID 获取会话信息
   * @param {string} id - 会话 ID
   * @returns {Object|null} 会话信息或 null
   */
  async getSession(id) {
    console.log(id)
    const [rows] = await pool.query('SELECT * FROM sessions WHERE id = ?', [id])
    return rows[0] || null
  }

  /**
   * 更新会话标题
   * @param {string} id - 会话 ID
   * @param {string} title - 新标题（自动截取前20字符）
   * @returns {Object} 更新后的会话信息
   */
  async updateSessionTitle(id, title) {
    await pool.query('UPDATE sessions SET title = ? WHERE id = ?', [title.substring(0, 20), id])
    return this.getSession(id)
  }

  /**
   * 删除会话（级联删除所有消息）
   * @param {string} id - 会话 ID
   */
  async deleteSession(id) {
    await pool.query('DELETE FROM sessions WHERE id = ?', [id])
  }

  /**
   * 获取会话的所有消息历史
   * @param {string} sessionId - 会话 ID
   * @returns {Array} 消息数组，按时间正序
   */
  async getMessages(sessionId) {
    console.log('【调试】查询消息，接收到的 sessionId:', sessionId)
    
    const [rows] = await pool.query(
      'SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC',
      [sessionId]
    )
    
    console.log('【调试】SQL 查询结果行数:', rows.length)
    console.log('【调试】SQL 查询结果:', rows)
    
    return rows
  }

  /**
   * 保存消息到数据库
   * @param {string} sessionId - 会话 ID
   * @param {string} role - 角色（user/assistant）
   * @param {string} content - 消息内容
   */
  async saveMessage(sessionId, role, content) {
    // 插入消息
    await pool.query(
      'INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)',
      [sessionId, role, content]
    )
    // 更新会话的更新时间
    await pool.query('UPDATE sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', [sessionId])
  }

  /**
   * 多轮对话：核心方法
   * 1. 检查会话是否存在
   * 2. 如果是第一条消息，生成标题
   * 3. 保存用户消息
   * 4. 获取历史，调用 DeepSeek API
   * 5. 保存助手回复
   * 6. 返回结果
   * 
   * @param {string} sessionId - 会话 ID
   * @param {string} userMessage - 用户消息
   * @returns {Object} { reply, sessionId, title }
   */
  async chat(sessionId, userMessage) {
    // 检查会话是否存在
    const session = await this.getSession(sessionId)
    if (!session) throw new Error('Session not found')

    // 检查是否是第一条消息
    const isFirst = (await this.getMessages(sessionId)).length === 0
    if (isFirst) {
      // 第一条消息：使用前20字符作为标题
      await this.updateSessionTitle(sessionId, userMessage)
    }

    // 保存用户消息
    await this.saveMessage(sessionId, 'user', userMessage)

    // 获取历史消息，构建消息数组
    const history = await this.getMessages(sessionId)
    const messages = history.map(m => ({ role: m.role, content: m.content }))

    // 调用 DeepSeek API
    const response = await request({
      url: '/chat/completions',
      method: 'POST',
      data: {
        model: MODEL,
        messages,
        temperature: TEMPERATURE,
        max_tokens: MAX_TOKENS
      }
    })

    // 提取助手回复
    const reply = response.data.choices[0].message.content

    // 保存助手回复
    await this.saveMessage(sessionId, 'assistant', reply)

    // 获取更新后的会话信息（包含新标题）
    const updatedSession = await this.getSession(sessionId)
    return { reply, sessionId, title: updatedSession.title }
  }

  /**
   * SSE 流式对话
   * @param {string} sessionId - 会话 ID
   * @param {string} userMessage - 用户消息
   * @returns {Object} { stream, saveMessage, session }
   */
  async chatStream(sessionId, userMessage) {
    const session = await this.getSession(sessionId)
    if (!session) {
      throw new Error('Session not found')
    }

    const isFirst = (await this.getMessages(sessionId)).length === 0
    if (isFirst) {
      await this.updateSessionTitle(sessionId, userMessage)
    }

    await this.saveMessage(sessionId, 'user', userMessage)

    const history = await this.getMessages(sessionId)
    const messages = history.map(m => ({ role: m.role, content: m.content }))

    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`
      },
      body: JSON.stringify({
        model: MODEL,
        messages,
        stream: true,
        temperature: TEMPERATURE,
        max_tokens: MAX_TOKENS
      })
    })

    return {
      stream: response.body,
      sessionId
    }
  }
}

// 导出服务类
module.exports = { ChatService }
