/**
 * SSE（Server-Sent Events）增量解析器 —— 后端版本
 *
 * 与前端 AI-Chat-front/src/utils/sse.js 是同一份逻辑，改动时请同步。
 *
 * 用它替代原来在 routes/chat.js 里的 `chunk.split('\n')`：
 * 网络分片边界与 SSE 事件边界无关，按 chunk 切行会把一条完整的
 * `data: {...}` 切断，导致 JSON.parse 失败、该段 delta 被静默丢弃。
 */

const DEFAULT_MAX_BUFFER = 1024 * 1024
const EVENT_SEPARATOR = /\r?\n\r?\n/

/**
 * @param {string} rawEvent
 * @returns {string | null}
 */
function extractPayload(rawEvent) {
  const parts = []
  for (const line of rawEvent.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue
    let value = line.slice(5)
    if (value.startsWith(' ')) value = value.slice(1)
    parts.push(value)
  }
  return parts.length ? parts.join('\n') : null
}

/**
 * @param {(payload: string) => void} onData
 * @param {{ maxBuffer?: number }} [options]
 */
function createSSEParser(onData, options = {}) {
  const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER
  let buffer = ''
  let closed = false

  function emit(rawEvent) {
    const payload = extractPayload(rawEvent)
    if (payload !== null && payload !== '') onData(payload)
  }

  function drain() {
    let match
    while ((match = EVENT_SEPARATOR.exec(buffer)) !== null) {
      emit(buffer.slice(0, match.index))
      buffer = buffer.slice(match.index + match[0].length)
    }
    if (buffer.length > maxBuffer) {
      throw new Error(`SSE 缓冲区超过 ${maxBuffer} 字节仍无事件分隔符，疑似非法流`)
    }
  }

  return {
    push(text) {
      if (closed || !text) return
      buffer += text
      drain()
    },
    end() {
      if (closed) return
      closed = true
      if (buffer.trim()) emit(buffer)
      buffer = ''
    }
  }
}

module.exports = { createSSEParser }
