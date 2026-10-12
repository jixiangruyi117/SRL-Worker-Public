// SRL-PUBLIC-SYNC: WORKER-SOURCE id=tavern-bridge-session
const WAITING_TTL_MS = 2 * 60 * 1000
import { handleParcel, cleanupParcels } from './BridgeParcels.js'
const ACTIVE_TTL_MS = 4 * 60 * 60 * 1000
const LONG_POLL_MS = 20 * 1000
const MAX_MESSAGE_BYTES = 512 * 1024
const MAX_QUEUE_BYTES = 4 * 1024 * 1024
const textEncoder = new TextEncoder()

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

async function readBody(request) {
  try {
    return await request.json()
  } catch {
    return {}
  }
}

function base64UrlEncode(bytes) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function opaqueToken() {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)))
}

function pairCode() {
  const value = crypto.getRandomValues(new Uint32Array(1))[0] ?? 0
  return String(value % 1_000_000).padStart(6, '0')
}

async function sha256Hex(value) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', textEncoder.encode(value)))
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function queueSize(messages) {
  return messages.reduce(
    (total, message) => total + textEncoder.encode(JSON.stringify(message)).length,
    0,
  )
}

function messageSize(message) {
  return textEncoder.encode(JSON.stringify(message)).length
}

export class BridgeSession {
  constructor(state) {
    this.state = state
    this.waiters = new Map()
  }

  async alarm() {
    if (await this.state.storage.get('parcel-index')) {
      await this.state.storage.transaction((store) => cleanupParcels(store))
      return
    }
    await this.state.storage.deleteAll()
    for (const resolve of this.waiters.values()) resolve()
    this.waiters.clear()
  }

  async readSession() {
    const session = await this.state.storage.get('session')
    if (!session) return null
    if (session.expiresAt <= Date.now()) {
      await this.alarm()
      return null
    }
    return session
  }

  async authenticate(session, token) {
    if (typeof token !== 'string' || !token) return ''
    const hash = await sha256Hex(token)
    if (hash === session.controllerTokenHash) return 'controller'
    if (hash === session.participantTokenHash) return 'participant'
    return ''
  }

  async refreshActiveSession(session) {
    if (!session.participantTokenHash) return
    session.expiresAt = Date.now() + ACTIVE_TTL_MS
    await this.state.storage.put('session', session)
    await this.state.storage.setAlarm(session.expiresAt)
  }

  otherRole(role) {
    return role === 'controller' ? 'participant' : 'controller'
  }

  queueKey(role) {
    return `queue:${role}`
  }

  wake(role) {
    const resolve = this.waiters.get(role)
    if (!resolve) return
    this.waiters.delete(role)
    resolve()
  }

  async enqueue(role, message, messageId) {
    const size = messageSize(message)
    if (
      messageId !== undefined &&
      (typeof messageId !== 'string' || !/^[\w-]{16,80}$/.test(messageId))
    ) {
      return json({ message: '中继消息 ID 无效' }, 400)
    }
    const fingerprint = messageId ? await sha256Hex(JSON.stringify(message)) : ''
    if (size > MAX_MESSAGE_BYTES) {
      return json({ code: 'MESSAGE_TOO_LARGE', message: '单条中继消息超过 512 KB' }, 413)
    }
    const accepted = await this.state.storage.transaction(async (storage) => {
      const indexKey = `${this.queueKey(role)}:index`
      const receiptKey = `${this.queueKey(role)}:receipts`
      const receipts = (await storage.get(receiptKey)) ?? []
      const received = messageId && receipts.find((entry) => entry.id === messageId)
      if (received) return received.hash === fingerprint ? 'accepted' : 'conflict'
      const index = (await storage.get(indexKey)) ?? []
      const legacy = (await storage.get(this.queueKey(role))) ?? []
      const bytes = index.reduce((sum, entry) => sum + entry.size, 0) + queueSize(legacy)
      if (bytes + size > MAX_QUEUE_BYTES || index.length + legacy.length >= 1024) return 'full'
      const key = `${this.queueKey(role)}:message:${crypto.randomUUID()}`
      // Each stored value stays below 512 KiB, independent of the total queue limit.
      await storage.put(key, message)
      await storage.put(indexKey, [...index, { key, size }])
      if (messageId)
        await storage.put(receiptKey, [
          ...receipts.slice(-4095),
          { id: messageId, hash: fingerprint },
        ])
      return 'accepted'
    })
    if (accepted === 'conflict') return json({ message: '同一消息 ID 的内容发生变化' }, 409)
    if (accepted === 'full')
      return json({ code: 'QUEUE_FULL', message: '中继队列已满，请稍后重试' }, 429)
    this.wake(role)
    return null
  }

  async acknowledgeQueue(role, acknowledgements) {
    if (!Array.isArray(acknowledgements) || !acknowledgements.length) return
    const ack = new Set(acknowledgements.slice(0, 1024))
    await this.state.storage.transaction(async (storage) => {
      const indexKey = `${this.queueKey(role)}:index`
      const index = (await storage.get(indexKey)) ?? []
      const remaining = []
      for (const entry of index) {
        if (ack.has(entry.key)) await storage.delete(entry.key)
        else remaining.push(entry)
      }
      if (remaining.length !== index.length) await storage.put(indexKey, remaining)
    })
  }

  async takeQueue(role, reliable = false, acknowledgements = []) {
    return this.state.storage.transaction(async (storage) => {
      const key = this.queueKey(role)
      const legacy = (await storage.get(key)) ?? []
      let index = (await storage.get(`${key}:index`)) ?? []
      if (reliable) {
        // Convert old queued values once; clients only acknowledge IDs from their own inbox.
        for (const message of legacy) {
          const messageKey = `${key}:message:${crypto.randomUUID()}`
          await storage.put(messageKey, message)
          index.push({ key: messageKey, size: messageSize(message) })
        }
        const ack = new Set(Array.isArray(acknowledgements) ? acknowledgements.slice(0, 1024) : [])
        const remaining = []
        const messages = []
        for (const entry of index) {
          if (ack.has(entry.key)) {
            await storage.delete(entry.key)
            continue
          }
          const message = await storage.get(entry.key)
          if (message !== undefined) {
            remaining.push(entry)
            messages.push(message)
          }
        }
        await storage.delete(key)
        await storage.put(`${key}:index`, remaining)
        return { messages, deliveryIds: remaining.map((entry) => entry.key) }
      }
      const messages = [...legacy]
      for (const entry of index) {
        const message = await storage.get(entry.key)
        if (message) messages.push(message)
        await storage.delete(entry.key)
      }
      await storage.delete(key)
      await storage.delete(`${key}:index`)
      return messages
    })
  }

  async initialize(request) {
    if (await this.readSession()) return json({ code: 'CODE_IN_USE' }, 409)
    const body = await readBody(request)
    const controllerToken = opaqueToken()
    const now = Date.now()
    const session = {
      code: String(body.code ?? ''),
      pairCode: pairCode(),
      srlUrl: String(body.srlUrl ?? '').slice(0, 2048),
      status: 'waiting',
      controllerTokenHash: await sha256Hex(controllerToken),
      participantTokenHash: '',
      expiresAt: now + WAITING_TTL_MS,
    }
    await this.state.storage.put('session', session)
    await this.state.storage.setAlarm(session.expiresAt)
    return json({
      code: session.code,
      pairCode: session.pairCode,
      controllerToken,
      reliableDelivery: true,
      relayBase: '/api/bridge/',
      expiresAt: session.expiresAt,
    })
  }

  async join(_request) {
    const session = await this.readSession()
    if (!session) return json({ code: 'SESSION_NOT_FOUND', message: '设备码不存在或已过期' }, 404)
    if (session.participantTokenHash)
      return json({ code: 'SESSION_ALREADY_JOINED', message: '设备码已被使用' }, 409)

    const participantToken = opaqueToken()
    if (!/^\d{6}$/.test(session.pairCode ?? '')) session.pairCode = pairCode()
    session.participantTokenHash = await sha256Hex(participantToken)
    session.status = 'active'
    session.expiresAt = Date.now() + ACTIVE_TTL_MS
    await this.state.storage.put('session', session)
    await this.state.storage.setAlarm(session.expiresAt)
    await this.enqueue('controller', {
      protocol: 'srl-tavern-bridge-v1',
      type: 'relay-joined',
    })
    return json({
      code: session.code,
      pairCode: session.pairCode,
      participantToken,
      reliableDelivery: true,
      relayBase: '/api/bridge/',
      srlUrl: session.srlUrl,
      expiresAt: session.expiresAt,
    })
  }

  async messages(request) {
    const body = await readBody(request)
    const session = await this.readSession()
    if (!session) return json({ code: 'SESSION_NOT_FOUND', message: '中继会话已过期' }, 404)
    const role = await this.authenticate(session, body.token)
    if (!role) return json({ code: 'INVALID_TOKEN', message: '中继令牌无效' }, 401)
    await this.refreshActiveSession(session)
    // Release validated deliveries before ACKs let the sender refill its window.
    // Only this authenticated role's inbox can be acknowledged.
    await this.acknowledgeQueue(role, body.acknowledgements)
    const problem = await this.enqueue(this.otherRole(role), body.message, body.messageId)
    if (problem) return problem
    return new Response(null, { status: 204 })
  }

  async poll(request) {
    const body = await readBody(request)
    let session = await this.readSession()
    if (!session) return json({ code: 'SESSION_NOT_FOUND', message: '中继会话已过期' }, 404)
    const role = await this.authenticate(session, body.token)
    if (!role) return json({ code: 'INVALID_TOKEN', message: '中继令牌无效' }, 401)
    await this.refreshActiveSession(session)

    const reliable = body.reliableDelivery === true
    let queue = await this.takeQueue(role, reliable, body.acknowledgements)
    if (!(reliable ? queue.messages : queue).length) {
      this.wake(role)
      let waiter
      await new Promise((resolve) => {
        const timeout = setTimeout(resolve, LONG_POLL_MS)
        waiter = () => {
          clearTimeout(timeout)
          resolve()
        }
        this.waiters.set(role, waiter)
      })
      if (this.waiters.get(role) === waiter) this.waiters.delete(role)
      session = await this.readSession()
      if (!session) return json({ code: 'SESSION_NOT_FOUND', message: '中继会话已过期' }, 404)
      queue = await this.takeQueue(role, reliable)
    }
    return json({ ...(reliable ? queue : { messages: queue }), expiresAt: session.expiresAt })
  }

  async close(request) {
    const body = await readBody(request)
    const session = await this.readSession()
    if (!session) return new Response(null, { status: 204 })
    const role = await this.authenticate(session, body.token)
    if (!role) return json({ code: 'INVALID_TOKEN', message: '中继令牌无效' }, 401)
    await this.alarm()
    return new Response(null, { status: 204 })
  }

  async fetch(request) {
    const pathname = new URL(request.url).pathname
    if (pathname.startsWith('/parcels/'))
      return handleParcel(
        request,
        this.state.storage,
        request.headers.get('x-srl-internal-client') || 'unknown',
      )
    if (request.method !== 'POST') return json({ code: 'METHOD_NOT_ALLOWED' }, 405)
    if (pathname === '/initialize') return this.initialize(request)
    if (pathname === '/join') return this.join(request)
    if (pathname === '/messages') return this.messages(request)
    if (pathname === '/poll') return this.poll(request)
    if (pathname === '/close') return this.close(request)
    return json({ code: 'NOT_FOUND' }, 404)
  }
}
