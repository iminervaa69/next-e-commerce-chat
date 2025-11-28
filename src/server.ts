import express, { Request, Response } from 'express'
import { createServer } from 'http'
import { Server, Socket } from 'socket.io'
import cors from 'cors'
import compression from 'compression'
import dotenv from 'dotenv'

dotenv.config()

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

// =============================================
// DATA STRUCTURES (In-Memory)
// =============================================

interface Message {
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

interface Room {
  id: string
  storeId: string
  users: Map<string, { odId: string, userName: string, socketId: string, role: string }>
  messages: Message[]
  createdAt: string
}

const rooms = new Map<string, Room>()
const userSocketMap = new Map<string, string>() // odId -> socketId
const socketUserMap = new Map<string, { odId: string, userName: string, userAvatar?: string, roomId: string, role: string }>()

// =============================================
// HELPER FUNCTIONS
// =============================================

const getOrCreateRoom = (roomId: string, storeId: string = ''): Room => {
  let room = rooms.get(roomId)
  if (!room) {
    room = {
      id: roomId,
      storeId,
      users: new Map(),
      messages: [],
      createdAt: new Date().toISOString()
    }
    rooms.set(roomId, room)
  }
  return room
}

const addMessage = (roomId: string, message: Message) => {
  const room = rooms.get(roomId)
  if (room) {
    room.messages.push(message)
    // Keep only last 100 messages per room to save memory
    if (room.messages.length > 100) {
      room.messages = room.messages.slice(-100)
    }
  }
}

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
  socket.on('join_room', (data: { 
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
      const prevRoom = rooms.get(previousData.roomId)
      if (prevRoom) {
        prevRoom.users.delete(socket.id)
        io.to(previousData.roomId).emit('user_count', prevRoom.users.size)
      }
    }

    // Join new room
    socket.join(roomId)
    const room = getOrCreateRoom(roomId, storeId)
    room.users.set(socket.id, { odId: userId, userName, socketId: socket.id, role })
    
    // Map socket to user
    socketUserMap.set(socket.id, { odId: userId, userName, userAvatar, roomId, role })
    userSocketMap.set(userId, socket.id)

    console.log(`👤 ${userName} joined room: ${roomId}`)

    // Send existing messages
    socket.emit('load_messages', room.messages)

    // Send room info
    socket.emit('room_info', {
      id: roomId,
      storeId: room.storeId,
      userCount: room.users.size,
      messageCount: room.messages.length
    })

    // Notify others
    const joinMessage = createSystemMessage(roomId, `${userName} joined the chat`)
    addMessage(roomId, joinMessage)
    socket.to(roomId).emit('new_message', joinMessage)
    
    // Broadcast user count
    io.to(roomId).emit('user_count', room.users.size)
  })

  // ==================
  // LEAVE ROOM
  // ==================
  socket.on('leave_room', (data: { roomId: string }) => {
    const userData = socketUserMap.get(socket.id)
    if (!userData || userData.roomId !== data.roomId) return

    socket.leave(data.roomId)
    const room = rooms.get(data.roomId)
    if (room) {
      room.users.delete(socket.id)
      
      const leaveMessage = createSystemMessage(data.roomId, `${userData.userName} left the chat`)
      addMessage(data.roomId, leaveMessage)
      socket.to(data.roomId).emit('new_message', leaveMessage)
      io.to(data.roomId).emit('user_count', room.users.size)
    }

    socketUserMap.delete(socket.id)
    userSocketMap.delete(userData.odId)
  })

  // ==================
  // SEND MESSAGE
  // ==================
  socket.on('send_message', (data: { 
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
    const room = rooms.get(roomId)
    if (!room) return

    // Find reply message if replying
    let replyTo: Message['replyTo'] | undefined
    if (data.replyToId) {
      const replyMessage = room.messages.find(m => m.id === data.replyToId)
      if (replyMessage) {
        replyTo = {
          id: replyMessage.id,
          content: replyMessage.content || '',
          senderName: replyMessage.senderName
        }
      }
    }

    const message: Message = {
      id: `msg-${Date.now()}-${socket.id.substr(0, 6)}`,
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

    addMessage(roomId, message)
    
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
  socket.on('mark_read', (data: { roomId: string, messageIds: string[] }) => {
    const userData = socketUserMap.get(socket.id)
    if (!userData) return

    const room = rooms.get(data.roomId)
    if (!room) return

    // Update message statuses
    data.messageIds.forEach(msgId => {
      const msg = room.messages.find(m => m.id === msgId)
      if (msg && msg.senderId !== userData.odId) {
        msg.status = 'read'
      }
    })

    // Notify sender(s)
    socket.to(data.roomId).emit('messages_read', {
      userId: userData.odId,
      messageIds: data.messageIds
    })
  })

  // ==================
  // GET ONLINE USERS
  // ==================
  socket.on('get_online_users', (data?: { roomId?: string }) => {
    const userData = socketUserMap.get(socket.id)
    if (!userData) return

    const roomId = data?.roomId || userData.roomId
    const room = rooms.get(roomId)
    if (!room) return

    const onlineUsers = Array.from(room.users.values()).map(u => ({
      userId: u.odId,
      userName: u.userName,
      role: u.role
    }))

    socket.emit('online_users', onlineUsers)
  })

  // ==================
  // DISCONNECT
  // ==================
  socket.on('disconnect', () => {
    const userData = socketUserMap.get(socket.id)
    
    if (userData) {
      const { roomId, userName, odId } = userData
      const room = rooms.get(roomId)
      
      if (room) {
        room.users.delete(socket.id)
        
        console.log(`👋 ${userName} left room: ${roomId}`)

        const leaveMessage = createSystemMessage(roomId, `${userName} left the chat`)
        addMessage(roomId, leaveMessage)
        socket.to(roomId).emit('new_message', leaveMessage)
        io.to(roomId).emit('user_count', room.users.size)

        // Clean up empty rooms after 1 minute
        if (room.users.size === 0) {
          setTimeout(() => {
            const r = rooms.get(roomId)
            if (r && r.users.size === 0) {
              rooms.delete(roomId)
              console.log(`🗑️  Deleted empty room: ${roomId}`)
            }
          }, 60000)
        }
      }

      socketUserMap.delete(socket.id)
      userSocketMap.delete(odId)
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

// Health check (important for Render)
app.get('/health', (req: Request, res: Response) => {
  res.json({ 
    status: 'ok',
    uptime: process.uptime(),
    connections: io.engine.clientsCount,
    rooms: rooms.size,
    timestamp: new Date().toISOString()
  })
})

// Get server stats
app.get('/stats', (req: Request, res: Response) => {
  const roomStats = Array.from(rooms.entries()).map(([id, room]) => ({
    id,
    storeId: room.storeId,
    users: room.users.size,
    messages: room.messages.length,
    createdAt: room.createdAt
  }))

  res.json({
    totalConnections: io.engine.clientsCount,
    totalRooms: rooms.size,
    rooms: roomStats,
    uptime: process.uptime()
  })
})

// Root endpoint
app.get('/', (req: Request, res: Response) => {
  res.json({ 
    message: 'Chat server is running',
    version: '1.0.0',
    endpoints: {
      health: '/health',
      stats: '/stats'
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
