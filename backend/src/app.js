import express from "express";
import { createServer } from "node:http";
import { Server } from "socket.io";

import mongoose from "mongoose";
import { connectToSocket } from "./controllers/socketManager.js";

import cors from "cors";
import userRoutes from "./routes/users.routes.js";

import dotenv from "dotenv";
dotenv.config(); // Load environment variables from .env file

const app = express();
const server = createServer(app);
const io = connectToSocket(server);

// Set port from env or default to 8000
app.set("port", process.env.PORT || 8000);

// Middleware
app.use(cors());
app.use(express.json({ limit: "40kb" }));
app.use(express.urlencoded({ limit: "40kb", extended: true }));

// Routes
app.use("/api/v1/users", userRoutes);

// Main Start Function
const start = async () => {
  try {
    // Connect to MongoDB using env variable
    const connectionDb = await mongoose.connect(process.env.MONGO_URI);

    console.log(`✅ MONGO Connected DB Host: ${connectionDb.connection.host}`);

    // Start server
    server.listen(app.get("port"), () => {
      console.log(`Server running on port ${app.get("port")}`);
    });
  } catch (error) {
    console.error("MongoDB connection error:", error);
    process.exit(1);
  }
};

start();
