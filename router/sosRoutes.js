import express from "express";
import fs from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { Readable, Transform } from "stream";
import ffmpegPath from "ffmpeg-static";
import ffmpeg from "fluent-ffmpeg";
import { spawn } from "child_process";
import axios from "axios";

ffmpeg.setFfmpegPath(ffmpegPath);

const router = express.Router();

// Custom Transform stream to buffer audio data
class AudioBuffer extends Transform {
  constructor(options) {
    super(options);
    this.chunks = [];
  }

  _transform(chunk, encoding, callback) {
    this.chunks.push(chunk);
    callback(null, chunk); // Pass through the data
  }

  getBuffer() {
    return Buffer.concat(this.chunks);
  }
}

// Configuration for the voice detection service
const VOICE_DETECTION_URL =
  process.env.VOICE_DETECTION_URL || "http://127.0.0.1:4002";

// Helper function to call the Python voice detection API
async function callVoiceDetectionAPI(endpoint, method = "GET", data = null) {
  try {
    const url = `${VOICE_DETECTION_URL}/api/detection/${endpoint}`;

    const options = {
      method,
      headers: {
        "Content-Type":
          data instanceof Buffer
            ? "application/octet-stream"
            : "application/json",
      },
    };

    if (data) {
      options.data = data;
    }

    const response = await axios(url, options);
    return response.data;
  } catch (error) {
    console.error(
      `Error calling voice detection API (${endpoint}):`,
      error.message
    );
    return { error: error.message };
  }
}

// Start a new SOS session
router.post("/start", async (req, res) => {
  try {
    console.log("Request body new session: ", req.body);
    const {
      session_id,
      type = "audio",
      device_id = "unknown",
      location = null,
    } = req.body;

    const sessionId = session_id || uuidv4();

    if (req.activeSessions.has(sessionId)) {
      console.log("session already exists");
      return res.status(409).json({ error: "Session already exists" });
    }

    // Create session directory
    const sessionDir = path.join(req.storageDir, sessionId);
    if (!fs.existsSync(sessionDir)) {
      fs.mkdirSync(sessionDir, { recursive: true });
    }

    // Create raw PCM file for initial streaming
    const rawFilePath = path.join(sessionDir, "audio.raw");
    const rawWriteStream = fs.createWriteStream(rawFilePath);

    // The final MP3 file path
    const mp3FilePath = path.join(sessionDir, "audio.mp3");
    var result = await axios.post(
      "https://womensafety-1-5znp.onrender.com/users/sendWelcomeMessage1",
      {
        latitude: location.latitude,
        longitude: location.longitude,
        longitude: 77.209,
        url: "https://maps.googleapis.com/maps/api/streetview?size=600x400&location=19.04120,%2073.07794&key=AIzaSyAnFzm0egXHx7P7zBsOjC3NV01Wj3ZHgyo",
        deviceName: device_id,
        battery: 75,
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization:
            "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiI2N2MyMjIwMWY3MmNkOTBiYjAzYjhkYjciLCJ1c2VyTmFtZSI6Im1lc3NpIiwibW9iaWxlTnVtYmVyIjoiOTE2Nzc4NzMyNiIsImlhdCI6MTc0MDk0NzgwNiwiZXhwIjoxNzQzNTM5ODA2fQ.LD1eDGOODJBtaqKmKtBah3czSRItJ-vFBdhxf-0OcmE",
        },
      }
    );
    console.log("response from welcome message", result.data);
    // Create session metadata
    const sessionInfo = {
      startTime: new Date().toISOString(),
      type: type,
      deviceId: device_id,
      location: location, // Store location if provided
      writeStream: rawWriteStream,
      rawFilePath: rawFilePath,
      mp3FilePath: mp3FilePath,
      bytesReceived: 0,
      audioBufferStream: new AudioBuffer(), // To accumulate all audio data
    };

    // Set up the audio buffer to collect all data
    sessionInfo.audioBufferStream.on("error", (err) => {
      console.error(`Audio buffer error for session ${sessionId}:`, err);
    });

    // Connect the buffer to the write stream
    sessionInfo.audioBufferStream.pipe(sessionInfo.writeStream);

    // Store session info
    req.activeSessions.set(sessionId, sessionInfo);

    // Log session start
    console.log(
      `Started new SOS session: ${sessionId} from device ${device_id}`
    );

    // Create session metadata file with location if available
    const metadataPath = path.join(sessionDir, "metadata.json");
    fs.writeFileSync(
      metadataPath,
      JSON.stringify(
        {
          id: sessionId,
          startTime: sessionInfo.startTime,
          type: sessionInfo.type,
          deviceId: sessionInfo.deviceId,
          location: sessionInfo.location,
          format: "mp3", // We'll convert to MP3 at the end
        },
        null,
        2
      )
    );

    // Broadcast session start
    req.broadcastSessionUpdate("sessionStart", sessionId, {
      startTime: sessionInfo.startTime,
      type: sessionInfo.type,
      deviceId: sessionInfo.deviceId,
      location: sessionInfo.location,
    });
    try {
      const voiceDetectionResponse = await callVoiceDetectionAPI(
        "start",
        "POST",
        {
          session_id: sessionId,
        }
      );

      // Store voice detection status in session info
      sessionInfo.pythonVoiceDetection = {
        active: true,
        initialized: true,
      };

      console.log(
        `Python voice detection initialized for session ${sessionId}:`,
        voiceDetectionResponse
      );
    } catch (voiceError) {
      console.error(
        `Failed to initialize Python voice detection for session ${sessionId}:`,
        voiceError
      );
      sessionInfo.pythonVoiceDetection = {
        active: false,
        initialized: false,
        error: voiceError.message,
      };
    }

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
router.post("/stream", async (req, res) => {
  try {
    const sessionId = req.headers["session-id"];

    if (!sessionId) {
      return res.status(400).json({ error: "Session ID header is required" });
    }

    const session = req.activeSessions.get(sessionId);

    if (!session) {
      console.log("Session not found for ID:", sessionId);
      return res.status(404).json({ error: "Session not found" });
    }

    // Get the audio data from the request body
    const audioData = req.body;

    if (!audioData || !audioData.length) {
      return res.status(400).json({ error: "No audio data received" });
    }

    console.log(
      `Received audio chunk: ${audioData.length} bytes for session ${sessionId}`
    );

    // Write to the buffer stream that feeds both the raw file and our buffer
    session.audioBufferStream.write(audioData);

    // Update bytes received
    session.bytesReceived += audioData.length;

    // Broadcast chunk received
    req.broadcastSessionUpdate("chunkReceived", sessionId, {
      chunkSize: audioData.length,
      totalBytes: session.bytesReceived,
    });

    if (session.pythonVoiceDetection && session.pythonVoiceDetection.active) {
      // Send in background without awaiting or blocking response
      callVoiceDetectionAPI(`stream/${sessionId}`, "POST", audioData)
        .then((response) => {
          if (response.error) {
            console.warn(
              `Python voice detection warning for ${sessionId}:`,
              response.error
            );

            // Track errors to disable if too many failures
            if (!session.pythonVoiceDetection.errorCount) {
              session.pythonVoiceDetection.errorCount = 1;
            } else {
              session.pythonVoiceDetection.errorCount++;

              // Disable after repeated errors
              if (session.pythonVoiceDetection.errorCount > 5) {
                console.error(
                  `Disabling Python voice detection for ${sessionId} due to repeated errors`
                );
                session.pythonVoiceDetection.active = false;
              }
            }
          } else {
            // Reset error count on success
            session.pythonVoiceDetection.errorCount = 0;
          }
        })
        .catch((err) => {
          console.error(
            `Error sending to Python voice detection for ${sessionId}:`,
            err
          );
        });
    }

    return res.status(200).end();
  } catch (error) {
    console.error("Error streaming audio:", error);
    return res.status(500).json({ error: "Failed to process audio chunk" });
  }
});

// Convert raw PCM to MP3 - optimized for Android format (16kHz, 16-bit mono PCM)
async function convertAndroidAudioToMp3(session) {
  return new Promise((resolve, reject) => {
    try {
      // Get the buffered audio data
      const audioBuffer = session.audioBufferStream.getBuffer();

      if (!audioBuffer || audioBuffer.length === 0) {
        console.warn("No audio data to convert");
        return reject(new Error("No audio data to convert"));
      }

      console.log(`Audio buffer size: ${audioBuffer.length} bytes`);

      // Create temporary file paths
      const tempRawPath = `${session.rawFilePath}.temp.raw`;
      const tempWavPath = `${session.rawFilePath}.temp.wav`;

      try {
        // Write the buffer to a temporary file
        fs.writeFileSync(tempRawPath, audioBuffer);
        console.log(
          `Raw file saved: ${tempRawPath} (${
            fs.statSync(tempRawPath).size
          } bytes)`
        );

        // Convert raw to WAV - using Android SosButtonService format: 16kHz, mono, 16-bit PCM
        const ffmpegRawToWav = spawn(ffmpegPath, [
          "-y", // Overwrite output
          "-f",
          "s16le", // 16-bit signed little-endian format
          "-ar",
          "16000", // 16kHz sample rate (matches SAMPLE_RATE in Android code)
          "-ac",
          "1", // 1 channel (mono) (matches CHANNEL_CONFIG in Android code)
          "-i",
          tempRawPath, // Input file
          tempWavPath, // Output WAV file
        ]);

        let rawToWavStderr = "";
        ffmpegRawToWav.stderr.on("data", (data) => {
          rawToWavStderr += data.toString();
          console.log(`RAW to WAV conversion: ${data.toString()}`);
        });

        ffmpegRawToWav.on("close", (code) => {
          if (code !== 0) {
            console.error(`RAW to WAV conversion failed with code ${code}`);
            console.error(`Error details: ${rawToWavStderr}`);

            // Try alternative conversion as fallback
            tryAlternativeConversion();
          } else {
            console.log(`Successfully created WAV file: ${tempWavPath}`);
            convertWavToMp3();
          }
        });

        ffmpegRawToWav.on("error", (err) => {
          console.error("Error in RAW to WAV conversion:", err);
          tryAlternativeConversion();
        });

        // Alternative conversion approach
        function tryAlternativeConversion() {
          console.log("Trying alternative conversion approach...");

          // Try with a variety of formats to see which works
          const altRawToWav = spawn(ffmpegPath, [
            "-y",
            "-f",
            "raw", // Generic raw format
            "-ar",
            "16000",
            "-ac",
            "1",
            "-acodec",
            "pcm_s16le", // Explicitly specify codec
            "-i",
            tempRawPath,
            tempWavPath,
          ]);

          let altStderr = "";
          altRawToWav.stderr.on("data", (data) => {
            altStderr += data.toString();
            console.log(`Alternative conversion: ${data.toString()}`);
          });

          altRawToWav.on("close", (altCode) => {
            if (altCode !== 0) {
              console.error(
                `Alternative conversion failed with code ${altCode}`
              );
              cleanup();
              reject(new Error("All conversion methods failed"));
            } else {
              console.log(
                `Successfully created WAV file with alternative method: ${tempWavPath}`
              );
              convertWavToMp3();
            }
          });

          altRawToWav.on("error", (err) => {
            console.error("Error in alternative conversion:", err);
            cleanup();
            reject(err);
          });
        }

        // Convert WAV to MP3
        function convertWavToMp3() {
          console.log("Converting WAV to MP3...");

          // Check if WAV file exists and has content
          if (
            !fs.existsSync(tempWavPath) ||
            fs.statSync(tempWavPath).size === 0
          ) {
            console.error("WAV file missing or empty");
            cleanup();
            reject(new Error("WAV file missing or empty"));
            return;
          }

          // Convert WAV to MP3 with appropriate settings
          const ffmpegWavToMp3 = spawn(ffmpegPath, [
            "-y", // Overwrite output
            "-i",
            tempWavPath, // Input WAV
            "-codec:a",
            "libmp3lame", // MP3 codec
            "-qscale:a",
            "2", // Quality setting (2 is high quality)
            "-ar",
            "44100", // Output sample rate (upsampling to standard rate)
            session.mp3FilePath, // Output MP3
          ]);

          let wavToMp3Stderr = "";
          ffmpegWavToMp3.stderr.on("data", (data) => {
            wavToMp3Stderr += data.toString();
            console.log(`WAV to MP3 conversion: ${data.toString()}`);
          });

          ffmpegWavToMp3.on("close", (code) => {
            if (
              code !== 0 ||
              !fs.existsSync(session.mp3FilePath) ||
              fs.statSync(session.mp3FilePath).size < 1000
            ) {
              console.error(`WAV to MP3 conversion failed with code ${code}`);
              cleanup();
              reject(new Error("WAV to MP3 conversion failed"));
            } else {
              console.log(
                `Successfully created MP3 file: ${session.mp3FilePath} (${
                  fs.statSync(session.mp3FilePath).size
                } bytes)`
              );
              cleanup();
              resolve();
            }
          });

          ffmpegWavToMp3.on("error", (err) => {
            console.error("Error in WAV to MP3 conversion:", err);
            cleanup();
            reject(err);
          });
        }

        // Clean up temporary files
        function cleanup() {
          try {
            if (fs.existsSync(tempRawPath)) fs.unlinkSync(tempRawPath);
            if (fs.existsSync(tempWavPath)) fs.unlinkSync(tempWavPath);
          } catch (e) {
            console.error("Error cleaning up:", e);
          }
        }
      } catch (error) {
        console.error("Error processing audio:", error);
        reject(error);
      }
    } catch (topLevelError) {
      console.error("Top-level error:", topLevelError);
      reject(topLevelError);
    }
  });
}

// End an SOS session
// End an SOS session
// End an SOS session
// End an SOS session - using only Python voice detection
router.post("/end", async (req, res) => {
  try {
    const { session_id } = req.body;

    if (!session_id) {
      return res.status(400).json({ error: "Session ID is required" });
    }

    const session = req.activeSessions.get(session_id);

    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }

    // Finalize Python voice detection if active
    let voiceDetectionResults = null;
    if (session.pythonVoiceDetection && session.pythonVoiceDetection.active) {
      try {
        // Call the Python voice detection API to end the session
        console.log(
          `Finalizing Python voice detection for session ${session_id}`
        );
        const response = await axios({
          method: "POST",
          url: `${VOICE_DETECTION_URL}/api/detection/end/${session_id}`,
          headers: {
            "Content-Type": "application/json",
          },
        });

        voiceDetectionResults = response.data;
        console.log(
          `Python voice detection results for session ${session_id}:`,
          voiceDetectionResults
        );
      } catch (voiceError) {
        console.error(
          `Error finalizing Python voice detection for session ${session_id}:`,
          voiceError
        );
      }
    }

    // Close the write stream for raw audio
    session.writeStream.end();
    session.audioBufferStream.end();

    let conversionSuccess = false;
    let conversionError = null;

    try {
      // Check if we have any audio data to convert
      const audioBuffer = session.audioBufferStream.getBuffer();
      if (!audioBuffer || audioBuffer.length === 0) {
        console.warn(`No audio data to convert for session ${session_id}`);
      } else {
        // Convert the accumulated audio to MP3
        await convertAndroidAudioToMp3(session);
        console.log(
          `Successfully converted audio to MP3 for session ${session_id}`
        );
        conversionSuccess = true;
      }
    } catch (error) {
      conversionError = error;
      console.error(
        `Error converting to MP3 for session ${session_id}:`,
        error
      );
      // Continue with session ending even if conversion fails
    }

    // Update metadata
    const sessionDir = path.join(req.storageDir, session_id);
    const metadataPath = path.join(sessionDir, "metadata.json");

    let metadata;
    try {
      metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
    } catch (err) {
      console.error(`Error reading metadata for session ${session_id}:`, err);
      // Create new metadata if file couldn't be read
      metadata = {
        id: session_id,
        startTime: session.startTime,
        type: session.type,
        deviceId: session.deviceId,
        location: session.location,
        format: "mp3",
      };
    }

    // Add Python voice detection results to metadata
    if (voiceDetectionResults && !voiceDetectionResults.error) {
      metadata.voiceDetection = {
        detectedSpeakers: voiceDetectionResults.speakers || 0,
        confidence: voiceDetectionResults.confidence || 0,
        completed: true,
        completedAt: new Date().toISOString(),
        service: "python",
      };
    }

    metadata.endTime = new Date().toISOString();
    metadata.duration =
      (new Date(metadata.endTime) - new Date(metadata.startTime)) / 1000;
    metadata.bytesReceived = session.bytesReceived;
    metadata.conversionSuccess = conversionSuccess;
    if (conversionError) {
      metadata.conversionError = conversionError.message;
    }

    fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));

    // Check if the MP3 file was created successfully
    const mp3Exists = fs.existsSync(session.mp3FilePath);
    const mp3Size = mp3Exists ? fs.statSync(session.mp3FilePath).size : 0;

    // Broadcast session end
    req.broadcastSessionUpdate("sessionEnd", session_id, {
      endTime: metadata.endTime,
      duration: metadata.duration,
      bytesReceived: session.bytesReceived,
      conversionSuccess: conversionSuccess,
      mp3Exists: mp3Exists,
      mp3Size: mp3Size,
      voiceDetection:
        voiceDetectionResults && !voiceDetectionResults.error
          ? {
              speakers: voiceDetectionResults.speakers,
              confidence: voiceDetectionResults.confidence,
            }
          : null,
    });

    // Remove session from active sessions
    req.activeSessions.delete(session_id);

    console.log(`Ended session: ${session_id}`);

    return res.status(200).json({
      success: true,
      message: "Session ended",
      conversionSuccess: conversionSuccess,
      mp3Exists: mp3Exists,
      mp3Size: mp3Size,
      voiceDetection:
        voiceDetectionResults && !voiceDetectionResults.error
          ? {
              speakers: voiceDetectionResults.speakers,
              confidence: voiceDetectionResults.confidence,
            }
          : null,
    });
  } catch (error) {
    console.error("Error ending session:", error);
    return res.status(500).json({ error: "Failed to end session" });
  }
});

// Check audio file format
router.get("/check-format/:sessionId", (req, res) => {
  try {
    const { sessionId } = req.params;
    const sessionDir = path.join(req.storageDir, sessionId);

    // Check for MP3 file
    const mp3Path = path.join(sessionDir, "audio.mp3");
    if (fs.existsSync(mp3Path)) {
      return res.status(200).json({ format: "mp3", path: mp3Path });
    }

    // Check for RAW file (legacy format)
    const rawPath = path.join(sessionDir, "audio.raw");
    if (fs.existsSync(rawPath)) {
      return res.status(200).json({ format: "raw", path: rawPath });
    }

    return res.status(404).json({ error: "No audio file found" });
  } catch (error) {
    console.error("Error checking audio format:", error);
    return res.status(500).json({ error: "Failed to check audio format" });
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
        deviceId: session.deviceId || "unknown",
        location: session.location,
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

// Get a specific session's details
router.get("/session/:sessionId", (req, res) => {
  try {
    const { sessionId } = req.params;

    // Check if it's an active session
    if (req.activeSessions.has(sessionId)) {
      const session = req.activeSessions.get(sessionId);
      return res.status(200).json({
        id: sessionId,
        status: "active",
        startTime: session.startTime,
        type: session.type,
        deviceId: session.deviceId || "unknown",
        location: session.location,
        bytesReceived: session.bytesReceived,
        duration: (new Date() - new Date(session.startTime)) / 1000,
      });
    }

    // Check if it's an archived session
    const sessionDir = path.join(req.storageDir, sessionId);
    const metadataPath = path.join(sessionDir, "metadata.json");

    if (fs.existsSync(metadataPath)) {
      const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));

      // Check if audio file exists
      const audioPath = path.join(sessionDir, "audio.mp3");
      const audioExists = fs.existsSync(audioPath);

      return res.status(200).json({
        ...metadata,
        status: "archived",
        hasAudio: audioExists,
      });
    }

    return res.status(404).json({ error: "Session not found" });
  } catch (error) {
    console.error("Error fetching session details:", error);
    return res.status(500).json({ error: "Failed to fetch session details" });
  }
});

// Stream audio file for playback
router.get("/audio/:sessionId", (req, res) => {
  try {
    const { sessionId } = req.params;
    const audioPath = path.join(req.storageDir, sessionId, "audio.mp3");

    // Check if the file exists
    if (!fs.existsSync(audioPath)) {
      return res.status(404).json({ error: "Audio file not found" });
    }

    // Get file stats
    const stat = fs.statSync(audioPath);
    const fileSize = stat.size;

    // Handle range requests for streaming
    const range = req.headers.range;

    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunksize = end - start + 1;

      const file = fs.createReadStream(audioPath, { start, end });

      res.writeHead(206, {
        "Content-Range": `bytes ${start}-${end}/${fileSize}`,
        "Accept-Ranges": "bytes",
        "Content-Length": chunksize,
        "Content-Type": "audio/mpeg",
      });

      file.pipe(res);
    } else {
      // Send the entire file
      res.writeHead(200, {
        "Content-Length": fileSize,
        "Content-Type": "audio/mpeg",
      });

      fs.createReadStream(audioPath).pipe(res);
    }
  } catch (error) {
    console.error("Error streaming audio file:", error);
    return res.status(500).json({ error: "Failed to stream audio file" });
  }
});

// Download audio file
router.get("/download/:sessionId", (req, res) => {
  try {
    const { sessionId } = req.params;
    const audioPath = path.join(req.storageDir, sessionId, "audio.mp3");

    // Check if the file exists
    if (!fs.existsSync(audioPath)) {
      return res.status(404).json({ error: "Audio file not found" });
    }

    // Set headers for file download
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="sos_recording_${sessionId}.mp3"`
    );
    res.setHeader("Content-Type", "audio/mpeg");

    // Stream the file as download
    fs.createReadStream(audioPath).pipe(res);
  } catch (error) {
    console.error("Error downloading audio file:", error);
    return res.status(500).json({ error: "Failed to download audio file" });
  }
});

// Get all archived sessions
router.get("/archived-sessions", (req, res) => {
  console.log("hellofrom archived");
  try {
    const sessionDirs = fs.readdirSync(req.storageDir);
    const archivedSessions = [];

    for (const dir of sessionDirs) {
      const sessionDir = path.join(req.storageDir, dir);
      const metadataPath = path.join(sessionDir, "metadata.json");

      // Skip active sessions
      if (req.activeSessions.has(dir)) {
        continue;
      }

      // If metadata exists, this is an archived session
      if (fs.existsSync(metadataPath)) {
        try {
          const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));

          // Check if audio file exists
          const audioPath = path.join(sessionDir, "audio.mp3");
          const audioExists = fs.existsSync(audioPath);

          archivedSessions.push({
            ...metadata,
            hasAudio: audioExists,
          });
        } catch (err) {
          console.error(`Error parsing metadata for session ${dir}:`, err);
        }
      }
    }

    // Sort by start time (newest first)
    archivedSessions.sort(
      (a, b) => new Date(b.startTime) - new Date(a.startTime)
    );

    return res.status(200).json({ sessions: archivedSessions });
  } catch (error) {
    console.error("Error fetching archived sessions:", error);
    return res.status(500).json({ error: "Failed to fetch archived sessions" });
  }
});

export default router;
