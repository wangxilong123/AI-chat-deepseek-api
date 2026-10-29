// 引入 Express 路由
const express = require('express')
const { Readable } = require('node:stream')
const pool = require('../db')
const { API_KEY, MODEL, TEMPERATURE, MAX_TOKENS } = require('../config')

// 引入 SSE 增量解析器
const { createSSEParser } = require('../lib/sse')

// 引入对话服务
const { ChatService } = require('../services/chat-service')

// 创建路由实例
const router = express.Router()

// 实例化服务
const chatService = new ChatService()

/**
 * GET /api/sessions
 * 获取所有会话列表
 */
router.get('/sessions', async (req, res) => {
  try {
    const sessions = await chatService.getAllSessions()
    res.json(sessions)
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

/**
 * POST /api/sessions
 * 创建新会话
 */
router.post('/sessions', async (req, res) => {
  try {
    const session = await chatService.createSession()
    res.status(201).json(session)
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

/**
 * GET /api/sessions/:id
 * 获取指定会话信息
 */
router.get('/sessions/:id', async (req, res) => {
  try {
    const session = await chatService.getSession(req.params.id)
    if (!session) return res.status(404).json({ error: 'Session not found' })
    res.json(session)
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

/**
 * PATCH /api/sessions/:id
 * 修改会话标题
 * Body: { "title": "新标题" }
 */
router.patch('/sessions/:id', async (req, res) => {
  try {
    const { title } = req.body
    if (!title) return res.status(400).json({ error: 'Title is required' })
    const session = await chatService.updateSessionTitle(req.params.id, title)
    if (!session) return res.status(404).json({ error: 'Session not found' })
    res.json(session)
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

/**
 * DELETE /api/sessions/:id
 * 删除会话（级联删除所有消息）
 */
router.delete('/sessions/:id', async (req, res) => {
  try {
    await chatService.deleteSession(req.params.id)
    res.status(204).send()  // 204: No Content
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

// ============================================
// 消息相关接口
// ============================================

/**
 * GET /api/sessions/:id/messages
 * 获取会话的所有消息历史
 */
router.get('/sessions/:id/messages', async (req, res) => {
  try {
    const messages = await chatService.getMessages(req.params.id)
    res.json(messages)
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

/**
 * POST /api/sessions/:id/chat
 * 多轮对话
 * Body: { "content": "用户消息" }
 */
router.post('/sessions/:id/chat', async (req, res) => {
  try {
    const { content } = req.body
    if (!content) return res.status(400).json({ error: 'Content is required' })
    const result = await chatService.chat(req.params.id, content)
    res.json(result)
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

/**
 * POST /api/sessions/:id/chat/stream
 * SSE 流式对话
 * Body: { "content": "用户消息" }
 */
router.post('/sessions/:id/chat/stream', async (req, res) => {
  const { content } = req.body
  if (!content || !content.trim()) {
    return res.status(400).json({ error: '消息内容不能为空' })
  }

  // ① 流式输出开始前的失败（会话不存在、上游 4xx/5xx）：
  //    此时还没写 SSE 头，可以返回真实的 HTTP 状态码 + JSON，前端能读到具体原因
  let stream
  let sessionId
  try {
    ({ stream, sessionId } = await chatService.chatStream(req.params.id, content))
  } catch (error) {
    console.error('Chat stream 未能启动:', error.message)
    return res.status(error.status || 500).json({ error: error.message })
  }

  // ② 从这里开始进入 SSE，状态码已被锁定为 200，错误只能走 data 帧
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  // 关掉 Nginx 等反向代理的缓冲，否则整个回答会被攒到最后一次性吐出来
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders()

  const decoder = new TextDecoder()
  let fullReply = ''
  let sentError = false

  // 统一出口：客户端可能已断开，写之前必须确认流还没结束，否则会抛
  // ERR_STREAM_WRITE_AFTER_END，把真正的错误信息盖掉
  const send = (data) => {
    if (res.writableEnded) return
    res.write(`data: ${JSON.stringify(data)}\n\n`)
  }

  // 按 \n\n 切事件，避免上游 data 行被网络分片切断后解析失败、丢掉这段 delta
  const parser = createSSEParser((payload) => {
    if (payload === '[DONE]') {
      send('[DONE]')
      return
    }
    try {
      const parsed = JSON.parse(payload)

      // 上游有时把错误塞在流里返回（如内容过滤、流中途中断）
      if (parsed.error) {
        // error 既可能是字符串，也可能是 { message, type } 对象
        const message = typeof parsed.error === 'string'
          ? parsed.error
          : parsed.error.message || 'AI 服务返回错误'
        sentError = true
        send({ error: message })
        return
      }

      const delta = parsed.choices?.[0]?.delta?.content
      if (delta) {
        fullReply += delta
        send({ content: delta })
      }
    } catch (e) {
      console.error('SSE 数据解析失败，原文前 200 字：', payload.slice(0, 200))
    }
  })

  try {
    for await (const chunk of Readable.fromWeb(stream)) {
      parser.push(decoder.decode(chunk, { stream: true }))
    }
    // 收尾：把解码器里残留的不完整多字节字符吐出来（中文跨分片时会卡在这）
    parser.push(decoder.decode())
    parser.end()

    // 上游 200 却一个 token 都没给：以前就是这样静默变成空气泡的
    if (!fullReply && !sentError) {
      send({ error: 'AI 没有返回任何内容，请重试' })
    }
  } catch (error) {
    // 流已开始后出错，只能用 SSE 通道报错，不能改状态码
    console.error('Stream error:', error)
    send({ error: `生成中断：${error.message}` })
  } finally {
    if (!res.writableEnded) res.end()

    // 已经生成的部分照存，刷新后至少能保住前半段内容
    if (fullReply) {
      try {
        await chatService.saveMessage(sessionId, 'assistant', fullReply)
      } catch (error) {
        console.error('保存助手回复失败:', error.message)
      }
    }
  }
})

// 导出路由
module.exports = router
