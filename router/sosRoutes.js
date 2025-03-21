import express from "express";
import fs from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";

const router = express.Router();

router.post("/start", (req, res) => {
  try {
    const { session_id, type = "audio" } = req.body;

    const sessionId = session_id || uuidv4();

    if (req.activeSessions.has(sessionId)) {
      return res.status(409).json({ error: "Session already exists" });
    }

    // Create session directory
    const sessionDir = path.join(req.storageDir, sessionId);
    if (!fs.existsSync(sessionDir)) {
      fs.mkdirSync(sessionDir, { recursive: true });
    }

    // Create a write stream for the audio data
    const audioFilePath = path.join(sessionDir, "audio.raw");
    const writeStream = fs.createWriteStream(audioFilePath);

    // Create session metadata
    const sessionInfo = {
      startTime: new Date().toISOString(),
      type: type,
      writeStream,
      filePath: audioFilePath,
      bytesReceived: 0,
    };

    // Store session info
    req.activeSessions.set(sessionId, sessionInfo);

    // Log session start
    console.log(`Started new SOS session: ${sessionId}`);

    // Create session metadata file
    const metadataPath = path.join(sessionDir, "metadata.json");
    fs.writeFileSync(
      metadataPath,
      JSON.stringify(
        {
          id: sessionId,
          startTime: sessionInfo.startTime,
          type: sessionInfo.type,
        },
        null,
        2
      )
    );

    // Broadcast session start
    req.broadcastSessionUpdate("sessionStart", sessionId, {
      startTime: sessionInfo.startTime,
      type: sessionInfo.type,
    });

    return res.status(200).json({
      success: true,
      message: "Session started",
      session_id: sessionId,
    });
  } catch (error) {
    console.error("Error starting session:", error);
    return res.status(500).json({ error: "Failed to start session" });
  }
});

// Stream audio data to an existing session
router.post("/stream", (req, res) => {
  try {
    const sessionId = req.headers["session-id"];

    if (!sessionId) {
      return res.status(400).json({ error: "Session ID header is required" });
    }

    const session = req.activeSessions.get(sessionId);

    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }

    // Get the audio data from the request body
    const audioData = req.body;

    if (!audioData || !audioData.length) {
      return res.status(400).json({ error: "No audio data received" });
    }

    // Write the audio chunk to the file
    session.writeStream.write(audioData);

    // Update bytes received
    session.bytesReceived += audioData.length;

    // Broadcast chunk received
    req.broadcastSessionUpdate("chunkReceived", sessionId, {
      chunkSize: audioData.length,
      totalBytes: session.bytesReceived,
    });

    return res.status(200).end();
  } catch (error) {
    console.error("Error streaming audio:", error);
    return res.status(500).json({ error: "Failed to process audio chunk" });
  }
});

// End an SOS session
router.post("/end", (req, res) => {
  try {
    const { session_id } = req.body;

    if (!session_id) {
      return res.status(400).json({ error: "Session ID is required" });
    }

    const session = req.activeSessions.get(session_id);

    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }

    // Close the write stream
    session.writeStream.end();

    // Update metadata
    const sessionDir = path.join(req.storageDir, session_id);
    const metadataPath = path.join(sessionDir, "metadata.json");

    const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
    metadata.endTime = new Date().toISOString();
    metadata.duration =
      (new Date(metadata.endTime) - new Date(metadata.startTime)) / 1000;
    metadata.bytesReceived = session.bytesReceived;

    fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));

    // Broadcast session end
    req.broadcastSessionUpdate("sessionEnd", session_id, {
      endTime: metadata.endTime,
      duration: metadata.duration,
      bytesReceived: session.bytesReceived,
    });

    // Remove session from active sessions
    req.activeSessions.delete(session_id);

    console.log(`Ended session: ${session_id}`);

    return res.status(200).json({ success: true, message: "Session ended" });
  } catch (error) {
    console.error("Error ending session:", error);
    return res.status(500).json({ error: "Failed to end session" });
  }
});

// Get active SOS sessions
router.get("/sessions", (req, res) => {
  try {
    const sessions = Array.from(req.activeSessions.entries()).map(
      ([id, session]) => ({
        id,
        startTime: session.startTime,
        type: session.type,
        bytesReceived: session.bytesReceived,
        duration: (new Date() - new Date(session.startTime)) / 1000,
      })
    );

    return res.status(200).json({ sessions });
  } catch (error) {
    console.error("Error fetching sessions:", error);
    return res.status(500).json({ error: "Failed to fetch sessions" });
  }
});

export default router;
