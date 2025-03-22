import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import connectDB from "./config/dbConnection.js";
import router from "./router/routeAnalysis.js";
import sosRouter from "./router/sosRoutes.js";
import setupVoiceDetection from "./controller/voiceSetupdetection.js";

// Get directory name in ES module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Create directories for storing sessions if they don't exist
const STORAGE_DIR = path.join(__dirname, "sessions");
if (!fs.existsSync(STORAGE_DIR)) {
  fs.mkdirSync(STORAGE_DIR, { recursive: true });
}

/**
 * Reads all session directories and their audio files
 * @param {string} sessionsPath - Path to the sessions directory
 * @returns {Promise<Array>} - Array of session information objects
 */
async function readSessionsWithAudio(sessionsPath) {
  try {
    // Read the sessions directory
    const sessionDirs = await fs.promises.readdir(sessionsPath);
    console.log(`Found ${sessionDirs.length} sessions in ${sessionsPath}`);

    // Process each session directory
    const sessionInfoPromises = sessionDirs.map(async (sessionId) => {
      const sessionPath = path.join(sessionsPath, sessionId);

      try {
        // Check if it's a directory
        const stats = await fs.promises.stat(sessionPath);

        if (!stats.isDirectory()) {
          return null; // Skip if not a directory
        }

        // Read contents of the session directory
        const sessionFiles = await fs.promises.readdir(sessionPath);

        // Look for audio.mp3 file
        const audioFile = sessionFiles.find((file) => file === "audio.mp3");
        const audioPath = audioFile ? path.join(sessionPath, audioFile) : null;

        // Get audio file stats if it exists
        let audioStats = null;
        if (audioPath) {
          audioStats = await fs.promises.stat(audioPath);
        }

        // Build session info object
        return {
          sessionId: sessionId,
          path: sessionPath,
          hasAudio: !!audioPath,
          audioPath: audioPath,
          audioSize: audioStats ? audioStats.size : 0,
          files: sessionFiles,
          created: stats.birthtime,
        };
      } catch (error) {
        console.error(`Error processing session ${sessionId}:`, error);
        return {
          sessionId: sessionId,
          error: error.message,
        };
      }
    });

    // Wait for all session info promises to resolve
    const sessions = await Promise.all(sessionInfoPromises);

    // Filter out null values (non-directories)
    return sessions.filter((session) => session !== null);
  } catch (error) {
    console.error(`Error reading sessions directory ${sessionsPath}:`, error);
    throw error;
  }
}

// Example usage
const sessionsPath = "./sessions";
readSessionsWithAudio(sessionsPath)
  .then((sessions) => {
    console.log(`Successfully read ${sessions.length} session directories`);

    // Filter sessions with audio files
    const sessionsWithAudio = sessions.filter((session) => session.hasAudio);
    console.log(`Sessions with audio: ${sessionsWithAudio.length}`);

    // Generate URLs for each audio file
    const audioUrls = sessionsWithAudio.map((session) => {
      return {
        sessionId: session.sessionId,
        apiUrl: `/api/audio/${session.sessionId}`,
        created: session.created,
      };
    });

    console.log("Audio URLs:");
    audioUrls.forEach((url) => {
      console.log(`- Session ${url.sessionId}: ${url.apiUrl}`);
    });

    // You could now store these URLs in your database
  })
  .catch((error) => {
    console.error("Error in main function:", error);
  });
const app = express();
const server = http.createServer(app);

// WebSocket setup
const wss = new WebSocketServer({ server });

// Active sessions store
const activeSessions = new Map();

// Store the voiceDetections map at the app level
app.set("activeSessions", activeSessions);

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
    if (client.readyState === WebSocketServer.OPEN) {
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

  // Also make voiceDetections available if it exists
  if (app.get("voiceDetections")) {
    req.voiceDetections = app.get("voiceDetections");
  }

  next();
});

// Your existing routes
app.use("/api/safety", router);

// New SOS routes
app.use("/api/sos", sosRouter);

// Set up voice detection - make sure this is called AFTER setting up the SOS routes
setupVoiceDetection(app, STORAGE_DIR, broadcastSessionUpdate);

// Add a simple status endpoint
app.get("/api/status", (req, res) => {
  const voiceDetections = app.get("voiceDetections") || new Map();

  res.json({
    status: "online",
    time: new Date().toISOString(),
    activeSosSessions: activeSessions.size,
    activeVoiceDetections: voiceDetections.size,
  });
});
app.get("/api/audio/:sessionId", (req, res) => {
  const { sessionId } = req.params;
  const audioPath = path.join(STORAGE_DIR, sessionId, "audio.mp3");

  // Check if the file exists
  fs.access(audioPath, fs.constants.F_OK, (err) => {
    if (err) {
      console.error(`Audio file not found for session ${sessionId}:`, err);
      return res.status(404).send("Audio file not found");
    }

    // Set appropriate headers for audio streaming
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="audio-${sessionId}.mp3"`
    );

    // Stream the file
    const stream = fs.createReadStream(audioPath);
    stream.pipe(res);
  });
});
// Serve monitoring dashboard for SOS sessions
app.get("/sos-monitor", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "monitor.html"));
});
app.get("/analytics", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "audio-analysis.html"));
});
app.get("/", (req, res) => {
  res.send("Hello World! v1");
});
// Static files for the monitoring dashboard
app.use(express.static(path.join(__dirname, "public")));

const PORT = 4001;

await connectDB();
console.log("Voice detection system integrated with SOS routes and WebSocket");
server.listen(PORT, () => {
  console.log(
    "Safety route analysis: http://localhost:4001/api/safety/analyze-routes"
  );
  console.log("SOS emergency stream: http://localhost:4001/api/sos/start");
  console.log("SOS monitoring dashboard: http://localhost:4000/sos-monitor");
  console.log("Status endpoint: http://localhost:4001/analytics");
  console.log(`Server running on port ${PORT}`);
});
