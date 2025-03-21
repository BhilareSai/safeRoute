import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import connectDB from "./config/dbConnection.js";
import router from "./router/routeAnalysis.js";
import sosRouter from "./router/sosRoutes.js";

// Get directory name in ES module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Create directories for storing sessions if they don't exist
const STORAGE_DIR = path.join(__dirname, "sessions");
if (!fs.existsSync(STORAGE_DIR)) {
  fs.mkdirSync(STORAGE_DIR, { recursive: true });
}

const app = express();
const server = http.createServer(app);

// WebSocket setup
const wss = new WebSocketServer({ server });

// Active sessions store
const activeSessions = new Map();

// WebSocket connections store
const connections = new Set();

// Handle WebSocket connections for real-time monitoring
wss.on("connection", (ws) => {
  console.log("New WebSocket client connected");
  connections.add(ws);

  // Send active sessions list to new client
  const sessionInfo = Array.from(activeSessions.entries()).map(
    ([id, session]) => ({
      id,
      startTime: session.startTime,
      bytesReceived: session.bytesReceived,
    })
  );

  ws.send(
    JSON.stringify({
      type: "sessionList",
      sessions: sessionInfo,
    })
  );

  ws.on("close", () => {
    connections.delete(ws);
    console.log("WebSocket client disconnected");
  });
});

// Broadcast session updates to all connected WebSocket clients
const broadcastSessionUpdate = (type, sessionId, data = {}) => {
  const message = JSON.stringify({
    type,
    sessionId,
    ...data,
    timestamp: new Date().toISOString(),
  });

  connections.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
};

// Middleware
app.use(express.json());
app.use(express.raw({ type: "application/octet-stream", limit: "10mb" }));

// Middleware to make activeSessions and broadcast function available to routes
app.use((req, res, next) => {
  req.activeSessions = activeSessions;
  req.broadcastSessionUpdate = broadcastSessionUpdate;
  req.storageDir = STORAGE_DIR;
  next();
});

// Your existing routes
app.use("/api/safety", router);

// New SOS routes
app.use("/api/sos", sosRouter);

// Add a simple status endpoint
app.get("/api/status", (req, res) => {
  res.json({
    status: "online",
    time: new Date().toISOString(),
    activeSosSessions: activeSessions.size,
  });
});

// Serve monitoring dashboard for SOS sessions
app.get("/sos-monitor", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "monitor.html"));
});
app.get("/", (req, res) => {
  res.send("Hello World! v1");
});
// Static files for the monitoring dashboard
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 4000;

await connectDB();

server.listen(PORT, () => {
  console.log(
    "Safety route analysis: http://localhost:4000/api/safety/analyze-routes"
  );
  console.log("SOS emergency stream: http://localhost:4000/api/sos/start");
  console.log("SOS monitoring dashboard: http://localhost:4000/sos-monitor");
  console.log(`Server running on port ${PORT}`);
});
