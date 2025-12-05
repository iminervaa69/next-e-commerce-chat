import express, { Request, Response } from 'express'
import { createServer } from 'http'
import { Server, Socket } from 'socket.io'
import cors from 'cors'
import compression from 'compression'
import dotenv from 'dotenv'
import jwt from 'jsonwebtoken'
import * as redisStore from './redis'
import { Message } from './redis'

dotenv.config()

// Chat server secret - should match main app's CHAT_SERVER_SECRET or JWT_SECRET
const CHAT_SECRET = process.env.CHAT_SERVER_SECRET || process.env.JWT_SECRET || 'chat-secret'

interface SocketUser {
  userId: string
  email: string
  role: string
  firstName?: string
  lastName?: string
}

const app = express()

// Middleware
app.use(cors())
app.use(compression())
app.use(express.json())

const httpServer = createServer(app)

// Socket.io configuration
const io = new Server(httpServer, {
  cors: {
    origin: process.env.CLIENT_URL || "*",
    methods: ["GET", "POST"],
    credentials: true
  },
  pingTimeout: 60000,
  pingInterval: 25000,
  transports: ['websocket', 'polling']
})

// Socket authentication middleware
io.use((socket, next) => {
  const token = socket.handshake.auth.token || socket.handshake.query.token

  // Allow unauthenticated connections in development or if no secret is set
  if (!token) {
    if (process.env.NODE_ENV === 'development' || CHAT_SECRET === 'chat-secret') {
      console.log('⚠️ Socket connected without token (dev mode)')
      return next()
    }
    return next(new Error('Authentication token required'))
  }

  try {
    const decoded = jwt.verify(token, CHAT_SECRET) as SocketUser
    ;(socket as any).user = decoded
    console.log(`🔐 Authenticated socket: ${decoded.email}`)
    next()
  } catch (err) {
    console.error('❌ Socket auth failed:', err)
    next(new Error('Invalid authentication token'))
  }
})

// =============================================
// DATA STRUCTURES (In-Memory for active connections)
// =============================================

// Only keep socket mappings in memory (Redis handles persistence)
const socketUserMap = new Map<string, { odId: string, userName: string, userAvatar?: string, roomId: string, role: string }>()

// =============================================
// HELPER FUNCTIONS
// =============================================

const createSystemMessage = (roomId: string, text: string): Message => {
  return {
    id: `sys-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    roomId,
    senderId: 'system',
    senderName: 'System',
    content: text,
    messageType: 'system',
    status: 'sent',
    createdAt: new Date().toISOString()
  }
}

// =============================================
// SOCKET.IO EVENT HANDLERS
// =============================================

io.on('connection', (socket: Socket) => {
  console.log(`🔌 Connected: ${socket.id}`)

  // ==================
  // JOIN ROOM
  // ==================
  socket.on('join_room', async (data: { 
    roomId: string
    storeId?: string
    userId: string
    userName: string
    userAvatar?: string
    role?: string
  }) => {
    const { roomId, storeId = '', userId, userName, userAvatar, role = 'customer' } = data
    
    // Leave previous room if any
    const previousData = socketUserMap.get(socket.id)
    if (previousData && previousData.roomId !== roomId) {
      socket.leave(previousData.roomId)
      await redisStore.removeOnlineUser(previousData.roomId, previousData.odId)
      const prevUserCount = await redisStore.getOnlineUserCount(previousData.roomId)
      io.to(previousData.roomId).emit('user_count', prevUserCount)
    }

    // Join new room
    socket.join(roomId)
    await redisStore.createRoom(roomId, storeId)
    await redisStore.addOnlineUser(roomId, userId, { userName, role })
    await redisStore.setUserSocket(userId, socket.id)
    
    // Map socket to user (in-memory for quick lookup)
    socketUserMap.set(socket.id, { odId: userId, userName, userAvatar, roomId, role })

    console.log(`👤 ${userName} joined room: ${roomId}`)

    // Send existing messages from Redis
    const messages = await redisStore.getMessages(roomId)
    socket.emit('load_messages', messages)

    // Send room info
    const roomInfo = await redisStore.getRoomInfo(roomId)
    const userCount = await redisStore.getOnlineUserCount(roomId)
    const messageCount = await redisStore.getMessageCount(roomId)
    socket.emit('room_info', {
      id: roomId,
      storeId: roomInfo?.storeId || storeId,
      userCount,
      messageCount
    })

    // Notify others
    const joinMessage = createSystemMessage(roomId, `${userName} joined the chat`)
    await redisStore.addMessage(roomId, joinMessage)
    socket.to(roomId).emit('new_message', joinMessage)
    
    // Broadcast user count
    io.to(roomId).emit('user_count', userCount)
  })

  // ==================
  // LEAVE ROOM
  // ==================
  socket.on('leave_room', async (data: { roomId: string }) => {
    const userData = socketUserMap.get(socket.id)
    if (!userData || userData.roomId !== data.roomId) return

    socket.leave(data.roomId)
    await redisStore.removeOnlineUser(data.roomId, userData.odId)
    await redisStore.removeUserSocket(userData.odId)
    
    const leaveMessage = createSystemMessage(data.roomId, `${userData.userName} left the chat`)
    await redisStore.addMessage(data.roomId, leaveMessage)
    socket.to(data.roomId).emit('new_message', leaveMessage)
    
    const userCount = await redisStore.getOnlineUserCount(data.roomId)
    io.to(data.roomId).emit('user_count', userCount)

    socketUserMap.delete(socket.id)
  })

  // ==================
  // SEND MESSAGE
  // ==================
  socket.on('send_message', async (data: { 
    roomId?: string
    content: string
    attachments?: any[]
    replyToId?: string
  }) => {
    const userData = socketUserMap.get(socket.id)
    if (!userData) {
      socket.emit('error', { message: 'Not in a room' })
      return
    }

    const roomId = data.roomId || userData.roomId

    // Find reply message if replying
    let replyTo: Message['replyTo'] | undefined
    if (data.replyToId) {
      const messages = await redisStore.getMessages(roomId)
      const replyMessage = messages.find((m: Message) => m.id === data.replyToId)
      if (replyMessage) {
        replyTo = {
          id: replyMessage.id,
          content: replyMessage.content || '',
          senderName: replyMessage.senderName
        }
      }
    }

    const message: Message = {
      id: `msg-${Date.now()}-${socket.id.substring(0, 6)}`,
      roomId,
      senderId: userData.odId,
      senderName: userData.userName,
      senderAvatar: userData.userAvatar,
      content: data.content?.trim() || null,
      messageType: data.attachments?.length ? 'attachment' : 'text',
      attachments: data.attachments,
      replyTo,
      status: 'sent',
      createdAt: new Date().toISOString()
    }

    await redisStore.addMessage(roomId, message)
    
    // Broadcast to all in room (including sender)
    io.to(roomId).emit('new_message', message)
    
    console.log(`💬 [${roomId}] ${userData.userName}: ${message.content?.substring(0, 50) || '[attachment]'}`)
  })

  // ==================
  // TYPING INDICATORS
  // ==================
  socket.on('typing_start', (data?: { roomId?: string }) => {
    const userData = socketUserMap.get(socket.id)
    if (!userData) return

    const roomId = data?.roomId || userData.roomId
    socket.to(roomId).emit('user_typing', {
      userId: userData.odId,
      userName: userData.userName
    })
  })

  socket.on('typing_stop', (data?: { roomId?: string }) => {
    const userData = socketUserMap.get(socket.id)
    if (!userData) return

    const roomId = data?.roomId || userData.roomId
    socket.to(roomId).emit('user_stop_typing', {
      userId: userData.odId
    })
  })

  // ==================
  // READ RECEIPTS
  // ==================
  socket.on('mark_read', async (data: { roomId: string, messageIds: string[] }) => {
    const userData = socketUserMap.get(socket.id)
    if (!userData) return

    // Update message statuses in Redis
    for (const msgId of data.messageIds) {
      await redisStore.updateMessageStatus(data.roomId, msgId, 'read')
    }

    // Notify sender(s)
    socket.to(data.roomId).emit('messages_read', {
      userId: userData.odId,
      messageIds: data.messageIds
    })
  })

  // ==================
  // GET ONLINE USERS
  // ==================
  socket.on('get_online_users', async (data?: { roomId?: string }) => {
    const userData = socketUserMap.get(socket.id)
    if (!userData) return

    const roomId = data?.roomId || userData.roomId
    const onlineUsers = await redisStore.getOnlineUsers(roomId)
    socket.emit('online_users', onlineUsers)
  })

  // ==================
  // DISCONNECT
  // ==================
  socket.on('disconnect', async () => {
    const userData = socketUserMap.get(socket.id)
    
    if (userData) {
      const { roomId, userName, odId } = userData
      
      await redisStore.removeOnlineUser(roomId, odId)
      await redisStore.removeUserSocket(odId)
      
      console.log(`👋 ${userName} left room: ${roomId}`)

      const leaveMessage = createSystemMessage(roomId, `${userName} left the chat`)
      await redisStore.addMessage(roomId, leaveMessage)
      socket.to(roomId).emit('new_message', leaveMessage)
      
      const userCount = await redisStore.getOnlineUserCount(roomId)
      io.to(roomId).emit('user_count', userCount)

      socketUserMap.delete(socket.id)
    }

    console.log(`❌ Disconnected: ${socket.id}`)
  })

  // ==================
  // ERROR HANDLING
  // ==================
  socket.on('error', (error) => {
    console.error('Socket error:', error)
  })
})

// =============================================
// HTTP ENDPOINTS
// =============================================

// Health check
app.get('/health', async (req: Request, res: Response) => {
  const stats = await redisStore.getAllRoomStats()
  res.json({ 
    status: 'ok',
    uptime: process.uptime(),
    connections: io.engine.clientsCount,
    rooms: stats.length,
    timestamp: new Date().toISOString()
  })
})

// Get server stats
app.get('/stats', async (req: Request, res: Response) => {
  const roomStats = await redisStore.getAllRoomStats()

  res.json({
    totalConnections: io.engine.clientsCount,
    totalRooms: roomStats.length,
    rooms: roomStats,
    uptime: process.uptime()
  })
})

// Root endpoint
app.get('/', (req: Request, res: Response) => {
  res.json({ 
    message: 'Chat server is running',
    version: '1.0.0',
    storage: 'redis',
    endpoints: {
      health: '/health',
      stats: '/stats',
      config: '/api/config'
    }
  })
})

/**
 * POST /api/config
 * Get server configuration (requires API key)
 * This endpoint is called by the main app to get chat server URL and socket token
 */
app.post('/api/config', (req: Request, res: Response) => {
  const { api_key, api_secret } = req.body

  const CHAT_API_KEY = process.env.CHAT_API_KEY || 'chat-api-dev-key'
  const CHAT_API_SECRET = process.env.CHAT_API_SECRET || 'chat-api-dev-secret'

  if (!api_key || !api_secret) {
    return res.status(400).json({
      success: false,
      error: 'api_key and api_secret are required'
    })
  }

  if (api_key !== CHAT_API_KEY || api_secret !== CHAT_API_SECRET) {
    return res.status(401).json({
      success: false,
      error: 'Invalid API credentials'
    })
  }

  const serverUrl = process.env.SERVER_URL || `http://localhost:${process.env.PORT || 3001}`

  // Generate a service token for socket authentication
  const serviceToken = jwt.sign(
    { 
      type: 'service',
      service: 'main-app',
      iat: Date.now()
    },
    CHAT_SECRET,
    { expiresIn: '24h' }
  )

  res.json({
    success: true,
    config: {
      url: serverUrl,
      token: serviceToken,
      websocket: {
        transports: ['websocket', 'polling'],
        path: '/socket.io'
      }
    }
  })
})

// =============================================
// START SERVER
// =============================================

const PORT = process.env.PORT || 3001

httpServer.listen(PORT, () => {
  console.log(`
🚀 Chat server started!
📡 Port: ${PORT}
🌍 Environment: ${process.env.NODE_ENV || 'development'}
🔗 Health: http://localhost:${PORT}/health
  `)
})

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down...')
  httpServer.close(() => {
    console.log('Server closed')
    process.exit(0)
  })
})
