import Redis from 'ioredis'

// Redis connection
const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379'
export const redis = new Redis(redisUrl)

redis.on('connect', () => {
  console.log('✅ Redis connected')
})

redis.on('error', (err: Error) => {
  console.error('❌ Redis error:', err.message)
})

// =============================================
// REDIS KEYS
// =============================================

const KEYS = {
  roomMessages: (roomId: string) => `chat:messages:${roomId}`,
  roomInfo: (roomId: string) => `chat:room:${roomId}`,
  onlineUsers: (roomId: string) => `chat:online:${roomId}`,
  userSocket: (userId: string) => `chat:user:${userId}`,
}

// =============================================
// MESSAGE TYPES
// =============================================

export interface Message {
  id: string
  roomId: string
  senderId: string
  senderName: string
  senderAvatar?: string
  content: string | null
  messageType: 'text' | 'system' | 'attachment'
  attachments?: any[]
  replyTo?: {
    id: string
    content: string
    senderName: string
  }
  status: 'sent' | 'delivered' | 'read'
  createdAt: string
}

export interface RoomInfo {
  id: string
  storeId: string
  createdAt: string
}

// =============================================
// MESSAGE OPERATIONS
// =============================================

const MAX_MESSAGES = 100
const MESSAGE_TTL = 60 * 60 * 24 * 7 // 7 days

export async function addMessage(roomId: string, message: Message): Promise<void> {
  const key = KEYS.roomMessages(roomId)
  
  // Add message to list
  await redis.rpush(key, JSON.stringify(message))
  
  // Trim to keep only last N messages
  await redis.ltrim(key, -MAX_MESSAGES, -1)
  
  // Set TTL (refresh on each message)
  await redis.expire(key, MESSAGE_TTL)
}

export async function getMessages(roomId: string): Promise<Message[]> {
  const key = KEYS.roomMessages(roomId)
  const messages = await redis.lrange(key, 0, -1)
  return messages.map((m: string) => JSON.parse(m) as Message)
}

export async function updateMessageStatus(
  roomId: string, 
  messageId: string, 
  status: 'sent' | 'delivered' | 'read'
): Promise<void> {
  const key = KEYS.roomMessages(roomId)
  const messages = await redis.lrange(key, 0, -1)
  
  for (let i = 0; i < messages.length; i++) {
    const msg: Message = JSON.parse(messages[i])
    if (msg.id === messageId) {
      msg.status = status
      await redis.lset(key, i, JSON.stringify(msg))
      break
    }
  }
}

// =============================================
// ROOM OPERATIONS
// =============================================

export async function createRoom(roomId: string, storeId: string): Promise<RoomInfo> {
  const key = KEYS.roomInfo(roomId)
  const existing = await redis.get(key)
  
  if (existing) {
    return JSON.parse(existing)
  }
  
  const roomInfo: RoomInfo = {
    id: roomId,
    storeId,
    createdAt: new Date().toISOString()
  }
  
  await redis.set(key, JSON.stringify(roomInfo))
  await redis.expire(key, MESSAGE_TTL)
  
  return roomInfo
}

export async function getRoomInfo(roomId: string): Promise<RoomInfo | null> {
  const key = KEYS.roomInfo(roomId)
  const data = await redis.get(key)
  return data ? JSON.parse(data) : null
}

export async function getMessageCount(roomId: string): Promise<number> {
  const key = KEYS.roomMessages(roomId)
  return await redis.llen(key)
}

// =============================================
// ONLINE USERS (in-memory is fine, Redis for persistence across restarts)
// =============================================

export async function addOnlineUser(
  roomId: string, 
  userId: string, 
  userData: { userName: string, role: string }
): Promise<void> {
  const key = KEYS.onlineUsers(roomId)
  await redis.hset(key, userId, JSON.stringify(userData))
  await redis.expire(key, 60 * 60) // 1 hour TTL
}

export async function removeOnlineUser(roomId: string, userId: string): Promise<void> {
  const key = KEYS.onlineUsers(roomId)
  await redis.hdel(key, userId)
}

export async function getOnlineUsers(roomId: string): Promise<Array<{ userId: string, userName: string, role: string }>> {
  const key = KEYS.onlineUsers(roomId)
  const users: Record<string, string> = await redis.hgetall(key)
  
  return Object.entries(users).map(([userId, data]) => ({
    userId,
    ...JSON.parse(data)
  }))
}

export async function getOnlineUserCount(roomId: string): Promise<number> {
  const key = KEYS.onlineUsers(roomId)
  return await redis.hlen(key)
}

// =============================================
// USER-SOCKET MAPPING
// =============================================

export async function setUserSocket(userId: string, socketId: string): Promise<void> {
  await redis.set(KEYS.userSocket(userId), socketId, 'EX', 60 * 60)
}

export async function getUserSocket(userId: string): Promise<string | null> {
  return await redis.get(KEYS.userSocket(userId))
}

export async function removeUserSocket(userId: string): Promise<void> {
  await redis.del(KEYS.userSocket(userId))
}

// =============================================
// STATS
// =============================================

export async function getAllRoomStats(): Promise<Array<{ roomId: string, messageCount: number, userCount: number }>> {
  const keys = await redis.keys('chat:room:*')
  const stats = []
  
  for (const key of keys) {
    const roomId = key.replace('chat:room:', '')
    const messageCount = await getMessageCount(roomId)
    const userCount = await getOnlineUserCount(roomId)
    stats.push({ roomId, messageCount, userCount })
  }
  
  return stats
}
