import { Server } from "socket.io";

const messages = {}; // roomKey -> [{sender, data, socketIdSender}]
const timeOnline = {}; // socketId -> Date

// Normalize room key so everyone matches
function normalizeRoomKey(roomKeyRaw) {
  const key = String(roomKeyRaw || "")
    .trim()
    .split("?")[0]
    .replace(/\/+$/, ""); // remove trailing slash
  return key;
}

export const connectToSocket = (server) => {
  const io = new Server(server, {
    cors: {
      origin: "*", // you can replace with your frontend domain later
      methods: ["GET", "POST"],
      credentials: false,
    },
  });

  io.on("connection", (socket) => {
    console.log("✅ socket connected:", socket.id);

    socket.on("join-call", (roomKeyRaw) => {
      const roomKey = normalizeRoomKey(roomKeyRaw);
      if (!roomKey) return;

      // ✅ Socket.IO native rooms (better than manual connections map)
      socket.join(roomKey);
      socket.data.roomKey = roomKey;

      timeOnline[socket.id] = new Date();

      // Get all sockets in this room
      const clients = Array.from(io.sockets.adapter.rooms.get(roomKey) || []);

      // Notify everyone in room that a user joined
      clients.forEach((clientId) => {
        io.to(clientId).emit("user-joined", socket.id, clients);
      });

      // Send existing messages to the newly joined user
      if (messages[roomKey]) {
        for (let i = 0; i < messages[roomKey].length; i++) {
          const m = messages[roomKey][i];
          io.to(socket.id).emit("chat-message", m.data, m.sender, m.socketIdSender);
        }
      }
    });

    socket.on("signal", (toId, message) => {
      io.to(toId).emit("signal", socket.id, message);
    });

    socket.on("chat-message", (data, sender) => {
      const roomKey = socket.data.roomKey;
      if (!roomKey) return;

      if (!messages[roomKey]) messages[roomKey] = [];
      messages[roomKey].push({
        sender,
        data,
        socketIdSender: socket.id,
      });

      // Broadcast to everyone in the room
      const clients = Array.from(io.sockets.adapter.rooms.get(roomKey) || []);
      clients.forEach((clientId) => {
        io.to(clientId).emit("chat-message", data, sender, socket.id);
      });
    });

    socket.on("disconnect", () => {
      const roomKey = socket.data.roomKey;

      // (optional) log online time
      if (timeOnline[socket.id]) {
        const diffMs = Math.abs(timeOnline[socket.id] - new Date());
        console.log(`ℹ️ ${socket.id} was online for ${Math.round(diffMs / 1000)}s`);
        delete timeOnline[socket.id];
      }

      if (!roomKey) return;

      // Notify remaining users in the room
      const clients = Array.from(io.sockets.adapter.rooms.get(roomKey) || []);
      clients.forEach((clientId) => {
        io.to(clientId).emit("user-left", socket.id);
      });

      // Clean up messages if room becomes empty (optional)
      if (clients.length === 0) {
        delete messages[roomKey];
      }
    });
  });

  return io;
};