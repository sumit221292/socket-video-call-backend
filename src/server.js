const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createClient } = require('redis');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: ["http://localhost:3000", "https://guileless-fairy-364399.netlify.app"],
    methods: ["GET", "POST"]
  }
});

// Redis Configuration - Fixed for production
let redisClient;

if (process.env.NODE_ENV === 'production' || process.env.REDIS_URL) {
  // Production Redis Cloud Configuration
  redisClient = createClient({
    username: 'default',
    password: 'qX5BFuzpRoRYJf3IROuhTP0urApm0OSN',
    socket: {
      host: 'redis-12982.c14.us-east-1-2.ec2.redns.redis-cloud.com',
      port: 12982,
      tls: false, // Set to true if your Redis Cloud requires TLS
      connectTimeout: 60000,
      lazyConnect: true
    }
  });
} else {
  // Local development Redis
  redisClient = createClient({
    socket: {
      host: 'localhost',
      port: 6379
    }
  });
}

// Enhanced error handling
redisClient.on('error', (err) => {
  console.error('Redis Client Error:', err);
});

redisClient.on('connect', () => {
  console.log('Redis client connected');
});

redisClient.on('ready', () => {
  console.log('Redis client ready');
});

redisClient.on('end', () => {
  console.log('Redis connection ended');
});

// Initialize Redis connection with better error handling
const initRedis = async () => {
  try {
    if (!redisClient.isOpen) {
      await redisClient.connect();
      console.log('Redis connected successfully');
    }
  } catch (error) {
    console.error('Failed to connect to Redis:', error);
    // Continue without Redis for basic functionality
    console.log('Continuing without Redis - some features may be limited');
  }
};

// Update user presence using Redis with fallback
const updateUserPresence = async (userId, status) => {
  try {
    if (redisClient.isOpen) {
      await redisClient.set(`user:${userId}:status`, status);
    }
    // Broadcast to all EXCEPT the user who changed status
    const senderSocketId = activeSessions.get(userId);
    if (senderSocketId) {
      io.to(senderSocketId).broadcast.emit('presence_update', { userId, status });
    }
  } catch (error) {
    console.error('Redis update error:', error);
    // Continue with socket broadcast even if Redis fails
    const senderSocketId = activeSessions.get(userId);
    if (senderSocketId) {
      io.to(senderSocketId).broadcast.emit('presence_update', { userId, status });
    }
  }
};

// Track active sessions
const activeSessions = new Map(); // userId -> socketId
const activeUsers = new Map(); // Store active calls

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);
  
  socket.on('update_status', async ({ userId, status }) => {
    const existingSocketId = activeSessions.get(userId);
    if (existingSocketId && existingSocketId !== socket.id) {
      socket.emit('duplicate_session', { message: 'User already logged in from another browser' });
      socket.disconnect();
      return;
    }

    activeSessions.set(userId, socket.id);
    await updateUserPresence(userId, status);
    socket.userId = userId;
  });

  socket.on('call_invite', ({ callerId, targetUserId, offer }) => {
    const targetSocketId = activeSessions.get(targetUserId);
    if (!targetSocketId) {
      socket.emit('user_offline', { targetUserId });
      return;
    }

    if (activeUsers.has(targetUserId)) {
      socket.emit('user_busy', { targetUserId });
      return;
    }

    // Send call invite only to the target user's socket
    io.to(targetSocketId).emit('incoming_call', {
      callerId,
      targetUserId,
      offer
    });
  });

  socket.on('call_accepted', ({ callerId, targetUserId, answer }) => {
    const callerSocketId = activeSessions.get(callerId);
    if (callerSocketId) {
      activeUsers.set(callerId, targetUserId);
      activeUsers.set(targetUserId, callerId);
      
      // Send call accepted only to the caller's socket
      io.to(callerSocketId).emit('call_accepted', { answer });
    }
  });

  socket.on('ice_candidate', ({ targetUserId, candidate }) => {
    const targetSocketId = activeSessions.get(targetUserId);
    if (targetSocketId) {
      io.to(targetSocketId).emit('ice_candidate', { candidate });
    }
  });

  socket.on('call_rejected', ({ callerId, targetUserId }) => {
    const callerSocketId = activeSessions.get(callerId);
    if (callerSocketId) {
      io.to(callerSocketId).emit('call_ended', {
        reason: 'rejected'
      });
    }
  });

  socket.on('end_call', ({ callerId, targetUserId }) => {
    const otherUserId = activeUsers.get(callerId);
    if (otherUserId) {
      const otherSocketId = activeSessions.get(otherUserId);
      activeUsers.delete(callerId);
      activeUsers.delete(otherUserId);

      if (otherSocketId) {
        io.to(otherSocketId).emit('call_ended', { reason: 'ended' });
      }
    }
  });

  socket.on('disconnect', async () => {
    const userId = socket.userId;
    if (userId && activeSessions.get(userId) === socket.id) {
      activeSessions.delete(userId);
      
      if (activeUsers.has(userId)) {
        const otherUserId = activeUsers.get(userId);
        const otherSocketId = activeSessions.get(otherUserId);
        
        activeUsers.delete(userId);
        activeUsers.delete(otherUserId);
        
        if (otherSocketId) {
          io.to(otherSocketId).emit('call_ended', { reason: 'disconnected' });
        }
      }
      await updateUserPresence(userId, 'offline');
    }
  });
});

// Initialize Redis before starting server
initRedis().then(() => {
  const PORT = process.env.PORT || 4000;
  server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
  });
}).catch((error) => {
  console.error('Failed to initialize Redis, starting server anyway:', error);
  const PORT = process.env.PORT || 4000;
  server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT} (without Redis)`);
  });
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down gracefully...');
  try {
    if (redisClient.isOpen) {
      await redisClient.quit();
    }
  } catch (error) {
    console.error('Error closing Redis connection:', error);
  }
  process.exit(0);
});