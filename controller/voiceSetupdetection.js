import express from "express";
import fs from "fs";
import path from "path";
import { Transform } from "stream";
import { spawn } from "child_process";
import ffmpegPath from "ffmpeg-static";
import WebSocket from "ws";
import * as tf from "@tensorflow/tfjs-node";
import * as speechCommands from "@tensorflow-models/speech-commands";

// Audio Buffer implementation to store and process audio chunks
export class AudioBuffer extends Transform {
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

  // Get a window of audio data (in seconds)
  getWindow(seconds) {
    // Assuming 16kHz 16-bit mono audio (32000 bytes per second)
    const bytesPerSecond = 32000;
    const bytesToReturn = Math.floor(seconds * bytesPerSecond);

    // Return the most recent audio data up to bytesToReturn
    const buffer = this.getBuffer();
    if (buffer.length <= bytesToReturn) {
      return buffer;
    }

    return buffer.slice(buffer.length - bytesToReturn);
  }
}

// Enhanced speaker detection configuration
const DETECTION_CONFIG = {
  minConfidence: 0.65, // Minimum confidence for detection
  windowSizeMs: 2000, // Size of processing window in ms
  overlappingWindowsMs: 1000, // How much windows should overlap
  updateIntervalMs: 1000, // How often to run detection
  clusteringThreshold: 0.6, // Threshold for speaker clustering
  transitionThreshold: 6.0, // dB threshold for speaker change
  minSpeechSegmentMs: 500, // Minimum length for speech segment
  debugMode: true, // Enable debug output
};

// Extract audio features from raw buffer
export async function extractAudioFeatures(audioBuffer) {
  if (!audioBuffer || audioBuffer.length === 0) {
    console.warn("No audio data to process");
    return [];
  }

  // Create random temp directory to avoid conflicts
  const tempId = Math.random().toString(36).substring(2, 10);
  const tempDir = path.join(process.cwd(), "temp");
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  const tempFile = path.join(tempDir, `temp_process_${tempId}.raw`);
  const wavFile = path.join(tempDir, `temp_process_${tempId}.wav`);

  try {
    // Write buffer to temp file
    fs.writeFileSync(tempFile, audioBuffer);

    // Convert to WAV using ffmpeg
    await new Promise((resolve, reject) => {
      const ffmpegProc = spawn(ffmpegPath, [
        "-y",
        "-f",
        "s16le",
        "-ar",
        "16000",
        "-ac",
        "1",
        "-i",
        tempFile,
        wavFile,
      ]);

      let stderr = "";
      ffmpegProc.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      ffmpegProc.on("close", (code) => {
        if (code === 0) resolve();
        else
          reject(
            new Error(`FFmpeg process exited with code ${code}: ${stderr}`)
          );
      });

      ffmpegProc.on("error", reject);
    });

    // Extract multiple audio features using ffmpeg for better analysis
    const features = await new Promise((resolve, reject) => {
      const result = [];

      // Use FFmpeg to extract more detailed audio features
      const ffmpegSpectrum = spawn(ffmpegPath, [
        "-i",
        wavFile,
        "-af",
        "asetnsamples=2048,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:key=lavfi.astats.Overall.Peak_level:key=lavfi.astats.Overall.Flat_factor:key=lavfi.astats.Overall.Dynamic_range",
        "-f",
        "null",
        "-",
      ]);

      let stderr = "";
      ffmpegSpectrum.stderr.on("data", (data) => {
        stderr += data.toString();

        // We'll parse the stderr output as it contains our analysis data
        const frameMatches = stderr.match(/^frame:\s*(\d+)/gm);

        if (frameMatches) {
          const lastFrameMatch = frameMatches[frameMatches.length - 1];
          const frameNum = parseInt(lastFrameMatch.split(":")[1].trim());

          // Extract RMS levels (volume)
          const rmsMatches = stderr.match(
            /lavfi\.astats\.Overall\.RMS_level=(-?\d+\.\d+)/g
          );
          // Extract peak levels
          const peakMatches = stderr.match(
            /lavfi\.astats\.Overall\.Peak_level=(-?\d+\.\d+)/g
          );
          // Extract flat factor (spectral flatness)
          const flatMatches = stderr.match(
            /lavfi\.astats\.Overall\.Flat_factor=(-?\d+\.\d+)/g
          );
          // Extract dynamic range
          const dynamicMatches = stderr.match(
            /lavfi\.astats\.Overall\.Dynamic_range=(-?\d+\.\d+)/g
          );

          if (rmsMatches && peakMatches) {
            for (let i = result.length; i < rmsMatches.length; i++) {
              if (i < peakMatches.length) {
                const rms = parseFloat(rmsMatches[i].split("=")[1]);
                const peak = parseFloat(peakMatches[i].split("=")[1]);
                const flat =
                  flatMatches && i < flatMatches.length
                    ? parseFloat(flatMatches[i].split("=")[1])
                    : 0;
                const dynamic =
                  dynamicMatches && i < dynamicMatches.length
                    ? parseFloat(dynamicMatches[i].split("=")[1])
                    : 0;

                // Convert dB to linear energy and add other features
                const energy = Math.pow(10, rms / 20);
                result.push({
                  frameIndex: i,
                  timestamp: i * 0.03, // Approximate timestamp (30ms per frame)
                  rms, // RMS level in dB
                  peak, // Peak level in dB
                  flat, // Spectral flatness
                  dynamic, // Dynamic range
                  energy, // Linear energy
                });
              }
            }
          }
        }
      });

      ffmpegSpectrum.on("close", (code) => {
        resolve(result);
      });

      ffmpegSpectrum.on("error", reject);
    });

    // Clean up temp files
    try {
      fs.unlinkSync(tempFile);
      fs.unlinkSync(wavFile);
    } catch (e) {
      console.warn("Error cleaning up temp files:", e);
    }

    return features;
  } catch (error) {
    console.error("Error extracting audio features:", error);

    // Clean up on error
    try {
      if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
      if (fs.existsSync(wavFile)) fs.unlinkSync(wavFile);
    } catch (e) {
      // Ignore cleanup errors
    }

    return [];
  }
}

// Detect speech segments from audio features
export function detectVoiceActivity(features) {
  if (!features || features.length === 0) {
    return [];
  }

  // Calculate energy threshold - adaptive threshold based on audio statistics
  const energyValues = features.map((f) => f.energy);
  const meanEnergy =
    energyValues.reduce((sum, val) => sum + val, 0) / energyValues.length;
  const stdDevEnergy = Math.sqrt(
    energyValues.reduce((sum, val) => sum + Math.pow(val - meanEnergy, 2), 0) /
      energyValues.length
  );

  // Use mean + 0.5 * stdDev as threshold (more sensitive than just mean)
  const energyThreshold = meanEnergy + 0.5 * stdDevEnergy;

  if (DETECTION_CONFIG.debugMode) {
    console.log(
      `Energy stats: mean=${meanEnergy.toFixed(
        6
      )}, stdDev=${stdDevEnergy.toFixed(
        6
      )}, threshold=${energyThreshold.toFixed(6)}`
    );
  }

  // Detect speech segments with smoothing to prevent fragmentation
  const speechSegments = [];
  let inSpeech = false;
  let segmentStart = 0;
  let silenceFrames = 0;
  const frameRate = 0.03; // Approximately 30ms per frame from ffmpeg astats

  // Minimum segment length in frames (convert from ms)
  const minSegmentFrames = Math.ceil(
    DETECTION_CONFIG.minSpeechSegmentMs / 1000 / frameRate
  );

  // Allow short silences (up to 500ms) within speech segments
  const maxSilenceFrames = Math.ceil(500 / 1000 / frameRate);

  for (let i = 0; i < features.length; i++) {
    const isSpeech = features[i].energy > energyThreshold;

    if (isSpeech) {
      if (!inSpeech) {
        // Start of speech segment
        inSpeech = true;
        segmentStart = i;
        silenceFrames = 0;
      } else {
        // Reset silence counter when we detect speech
        silenceFrames = 0;
      }
    } else {
      // Not speech
      if (inSpeech) {
        // Increment silence counter
        silenceFrames++;

        // Only end segment after several consecutive silence frames
        if (silenceFrames > maxSilenceFrames) {
          // End of speech segment
          inSpeech = false;

          // End segment at the last non-silent frame
          const segmentEnd = i - silenceFrames;

          // Only keep segments longer than minimum length
          if (segmentEnd - segmentStart >= minSegmentFrames) {
            speechSegments.push({
              startFrame: segmentStart,
              endFrame: segmentEnd,
              startTime: segmentStart * frameRate,
              endTime: segmentEnd * frameRate,
              features: features.slice(segmentStart, segmentEnd),
            });
          }
        }
      }
    }
  }

  // If still in speech at the end, close the segment
  if (inSpeech) {
    const segmentEnd =
      features.length - (silenceFrames > maxSilenceFrames ? silenceFrames : 0);
    if (segmentEnd - segmentStart >= minSegmentFrames) {
      speechSegments.push({
        startFrame: segmentStart,
        endFrame: segmentEnd,
        startTime: segmentStart * frameRate,
        endTime: segmentEnd * frameRate,
        features: features.slice(segmentStart, segmentEnd),
      });
    }
  }

  if (DETECTION_CONFIG.debugMode) {
    console.log(`Detected ${speechSegments.length} speech segments`);

    // Log details of first few segments
    speechSegments.slice(0, 3).forEach((segment, i) => {
      console.log(
        `Segment ${i}: ${segment.startTime.toFixed(
          2
        )}s - ${segment.endTime.toFixed(2)}s (${(
          segment.endTime - segment.startTime
        ).toFixed(2)}s)`
      );
    });
  }

  return speechSegments;
}

// Extract embeddings from speech segments for speaker detection
export function calculateSpeakerEmbeddings(speechSegments, features) {
  const embeddings = [];

  for (let segment of speechSegments) {
    // Extract segment features
    const segmentFeatures =
      segment.features || features.slice(segment.startFrame, segment.endFrame);

    if (segmentFeatures.length === 0) continue;

    // Calculate advanced statistical features for the segment
    const rmsValues = segmentFeatures.map((f) => f.rms);
    const peakValues = segmentFeatures.map((f) => f.peak);
    const energyValues = segmentFeatures.map((f) => f.energy);
    const flatValues = segmentFeatures.map((f) => f.flat || 0);

    // Calculate averages
    const avgRms =
      rmsValues.reduce((sum, val) => sum + val, 0) / rmsValues.length;
    const avgPeak =
      peakValues.reduce((sum, val) => sum + val, 0) / peakValues.length;
    const avgEnergy =
      energyValues.reduce((sum, val) => sum + val, 0) / energyValues.length;
    const avgFlat =
      flatValues.reduce((sum, val) => sum + val, 0) / flatValues.length;

    // Calculate variances
    const rmsVar =
      rmsValues.reduce((sum, val) => sum + Math.pow(val - avgRms, 2), 0) /
      rmsValues.length;
    const peakVar =
      peakValues.reduce((sum, val) => sum + Math.pow(val - avgPeak, 2), 0) /
      peakValues.length;
    const energyVar =
      energyValues.reduce((sum, val) => sum + Math.pow(val - avgEnergy, 2), 0) /
      energyValues.length;

    // Calculate spectral slope (crude approximation of vocal tract characteristics)
    let spectralSlope = 0;
    if (segmentFeatures.length > 1) {
      const x = Array.from({ length: segmentFeatures.length }, (_, i) => i);
      const y = rmsValues;
      const n = x.length;
      const sumX = x.reduce((a, b) => a + b, 0);
      const sumY = y.reduce((a, b) => a + b, 0);
      const sumXY = x.reduce((sum, xi, i) => sum + xi * y[i], 0);
      const sumXX = x.reduce((sum, xi) => sum + xi * xi, 0);
      spectralSlope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
    }

    // Calculate energy dynamics (first derivative of energy)
    let energyDynamics = 0;
    if (energyValues.length > 1) {
      const diffs = [];
      for (let i = 1; i < energyValues.length; i++) {
        diffs.push(Math.abs(energyValues[i] - energyValues[i - 1]));
      }
      energyDynamics = diffs.reduce((sum, val) => sum + val, 0) / diffs.length;
    }

    // Create a more comprehensive embedding vector
    const embedding = [
      avgRms,
      avgPeak,
      avgEnergy,
      avgFlat,
      rmsVar,
      peakVar,
      energyVar,
      spectralSlope,
      energyDynamics,
      segment.endTime - segment.startTime, // Duration as a feature
    ];

    embeddings.push({
      segment,
      embedding,
    });
  }

  return embeddings;
}

// Cluster speaker embeddings to identify distinct speakers
export function clusterSpeakers(embeddings, maxSpeakers = 6) {
  if (!embeddings || embeddings.length === 0) return [];

  // If only one embedding, it's one speaker
  if (embeddings.length === 1) {
    return [
      {
        speakerId: 1,
        segments: [embeddings[0].segment],
        confidence: 0.95,
      },
    ];
  }

  // Initialize clusters with the first embedding
  const clusters = [
    {
      centroid: embeddings[0].embedding,
      segments: [embeddings[0].segment],
      embeddings: [embeddings[0]],
    },
  ];

  // Set clustering threshold
  const threshold = DETECTION_CONFIG.clusteringThreshold;

  // Assign each embedding to a cluster or create a new one
  for (let i = 1; i < embeddings.length; i++) {
    const embedding = embeddings[i];
    let minDistance = Infinity;
    let closestCluster = -1;

    // Find closest cluster
    for (let j = 0; j < clusters.length; j++) {
      const distance = calculateEuclideanDistance(
        embedding.embedding,
        clusters[j].centroid
      );

      if (distance < minDistance) {
        minDistance = distance;
        closestCluster = j;
      }
    }

    // If close enough to existing cluster, add to it
    if (minDistance < threshold || clusters.length >= maxSpeakers) {
      clusters[closestCluster].segments.push(embedding.segment);
      clusters[closestCluster].embeddings.push(embedding);

      // Update centroid (average of all embeddings)
      const clusterEmbeddings = clusters[closestCluster].embeddings;
      const dimensions = clusterEmbeddings[0].embedding.length;
      const newCentroid = Array(dimensions).fill(0);

      for (let d = 0; d < dimensions; d++) {
        for (let e = 0; e < clusterEmbeddings.length; e++) {
          newCentroid[d] += clusterEmbeddings[e].embedding[d];
        }
        newCentroid[d] /= clusterEmbeddings.length;
      }

      clusters[closestCluster].centroid = newCentroid;
    } else {
      // Create new cluster if we haven't reached max speakers
      clusters.push({
        centroid: embedding.embedding,
        segments: [embedding.segment],
        embeddings: [embedding],
      });
    }
  }

  // Calculate confidence for each cluster based on internal cohesion
  clusters.forEach((cluster) => {
    if (cluster.embeddings.length === 1) {
      cluster.confidence = 0.8; // Single-segment clusters get moderate confidence
    } else {
      // Calculate average distance to centroid
      let totalDistance = 0;
      for (const emb of cluster.embeddings) {
        totalDistance += calculateEuclideanDistance(
          emb.embedding,
          cluster.centroid
        );
      }
      const avgDistance = totalDistance / cluster.embeddings.length;

      // Convert distance to confidence score (lower distance = higher confidence)
      // Scale to 0.5-0.95 range
      cluster.confidence = Math.max(
        0.5,
        Math.min(0.95, 1 - avgDistance / (threshold * 2))
      );
    }

    // Calculate speaking time for the cluster
    cluster.speakingTime = cluster.segments.reduce(
      (sum, seg) => sum + (seg.endTime - seg.startTime),
      0
    );
  });

  // Remove the embeddings from the result to keep it cleaner
  clusters.forEach((cluster) => {
    delete cluster.embeddings;
  });

  // Add speaker IDs and sort clusters by speaking time (most speaking first)
  return clusters
    .sort((a, b) => b.speakingTime - a.speakingTime)
    .map((cluster, index) => ({
      ...cluster,
      speakerId: index + 1,
    }));
}

// Calculate Euclidean distance between two vectors
function calculateEuclideanDistance(vector1, vector2) {
  if (vector1.length !== vector2.length) {
    throw new Error("Vectors must have the same length");
  }

  let sumSquaredDiff = 0;
  for (let i = 0; i < vector1.length; i++) {
    sumSquaredDiff += Math.pow(vector1[i] - vector2[i], 2);
  }

  return Math.sqrt(sumSquaredDiff);
}

// Class to handle voice detection for an SOS session
export class VoiceDetectionManager {
  constructor(sessionId, storageDir, broadcastFn) {
    this.sessionId = sessionId;
    this.storageDir = storageDir;
    this.sessionDir = path.join(storageDir, sessionId);
    this.broadcastUpdate = broadcastFn;

    // Create session directory if it doesn't exist
    if (!fs.existsSync(this.sessionDir)) {
      fs.mkdirSync(this.sessionDir, { recursive: true });
    }

    // Processing state
    this.model = null;
    this.audioBuffer = new AudioBuffer();
    this.audioChunks = [];
    this.processedDuration = 0;
    this.detectedSpeakers = 0;
    this.processingInterval = null;
    this.lastProcessingTime = 0;
    this.isProcessing = false;

    // Speaker tracking
    this.speakerClusters = [];
    this.maxSpeakers = 6;
    this.speakerTimeline = [];

    // Detection results
    this.detectionResults = {
      speakerCount: 0,
      confidence: 0,
      speakingTime: 0,
      timeline: [],
    };

    this.initialize();
  }

  async initialize() {
    try {
      // Create recognizer with proper configuration object instead of positional parameters
      const recognizer = speechCommands.create({
        modelArchitecture: "SOFT_FFT", // Using SOFT_FFT for Node.js environment
        vocabulary: "directional4w", // Using a standard vocabulary
        customModelURL: null, // Not using custom model
        customMetadataURL: null, // Not using custom metadata
        enableEmbeddingExtraction: true, // Enable feature embedding extraction
      });

      await recognizer.ensureModelLoaded();
      console.log(
        `[${this.sessionId}] Speech Commands model loaded successfully`
      );
      this.model = recognizer;
      this.useSimpleAudioFeatures = false;

      // Start processing at regular intervals
      this.processingInterval = setInterval(
        () => this.processAudioChunks(),
        DETECTION_CONFIG.updateIntervalMs
      );

      console.log(
        `[${this.sessionId}] Voice detection initialized, processing every ${DETECTION_CONFIG.updateIntervalMs}ms`
      );

      // Broadcast initialization
      this.broadcastUpdate("detectionStart", this.sessionId, {
        timestamp: new Date().toISOString(),
        type: "voice_detection",
        config: {
          updateInterval: DETECTION_CONFIG.updateIntervalMs,
          windowSize: DETECTION_CONFIG.windowSizeMs,
        },
      });
    } catch (error) {
      console.error(
        `[${this.sessionId}] Failed to initialize voice detection:`,
        error
      );

      // Fall back to simple audio features
      this.useSimpleAudioFeatures = true;

      if (!this.processingInterval) {
        this.processingInterval = setInterval(
          () => this.processAudioChunks(),
          DETECTION_CONFIG.updateIntervalMs
        );
      }
    }
  }

  // Alternative approach (if the above doesn't work)
  // Use this as a fallback if needed
  async initializeAlternative() {
    try {
      // Skip TensorFlow model initialization entirely and rely only on audio processing
      console.log(
        `[${this.sessionId}] Using simplified audio feature detection`
      );
      this.useSimpleAudioFeatures = true;
      this.model = null;

      // Start processing at regular intervals
      this.processingInterval = setInterval(
        () => this.processAudioChunks(),
        DETECTION_CONFIG.updateIntervalMs
      );

      // Broadcast initialization
      this.broadcastUpdate("detectionStart", this.sessionId, {
        timestamp: new Date().toISOString(),
        type: "voice_detection",
        config: {
          updateInterval: DETECTION_CONFIG.updateIntervalMs,
          windowSize: DETECTION_CONFIG.windowSizeMs,
          modelType: "audio_features_only",
        },
      });

      return true; // Initialization successful with fallback approach
    } catch (error) {
      console.error(
        `[${this.sessionId}] Failed to initialize voice detection with fallback method:`,
        error
      );
      return false;
    }
  }

  // Process incoming audio chunk
  addAudioChunk(chunk) {
    if (!chunk || chunk.length === 0) {
      console.warn(`[${this.sessionId}] Received empty audio chunk`);
      return;
    }

    // Store the chunk timestamp for better timeline tracking
    this.audioChunks.push({
      data: chunk,
      timestamp: Date.now(),
    });

    // Add to audio buffer for continuous processing
    this.audioBuffer.write(chunk);

    // If we have more than 60 seconds of audio chunks, trim the oldest ones
    const maxChunks = 60; // Keep approximately last 60 seconds
    if (this.audioChunks.length > maxChunks) {
      this.audioChunks = this.audioChunks.slice(-maxChunks);
    }
  }

  // Process collected audio chunks
  async processAudioChunks() {
    // Avoid overlapping processing calls
    if (this.isProcessing || this.audioChunks.length === 0) return;

    // Throttle processing to avoid CPU overload
    const now = Date.now();
    if (now - this.lastProcessingTime < 500) {
      return; // Don't process more often than every 500ms
    }

    this.isProcessing = true;
    this.lastProcessingTime = now;

    try {
      // Get the audio buffer for the window we want to analyze
      const windowSizeSeconds = DETECTION_CONFIG.windowSizeMs / 1000;
      const audioData = this.audioBuffer.getWindow(windowSizeSeconds);

      // Debug log with proper data
      console.log(
        `[${this.sessionId}] Processing audio: ${this.audioChunks.length} chunks, ${audioData.length} bytes`
      );

      // Skip if not enough audio data
      if (audioData.length < 8000) {
        // Need at least 0.25 seconds at 16kHz/16-bit
        this.isProcessing = false;
        return;
      }

      // Process speech detection using the improved functions
      const features = await extractAudioFeatures(audioData);
      if (features.length === 0) {
        this.isProcessing = false;
        return;
      }

      // Rest of your code remains unchanged...
      const speechSegments = detectVoiceActivity(features);

      // Skip speaker analysis if no speech segments found
      if (speechSegments.length === 0) {
        if (DETECTION_CONFIG.debugMode) {
          console.log(
            `[${this.sessionId}] No speech detected in current window`
          );
        }
        this.isProcessing = false;
        return;
      }

      // Rest of your existing processing code...
    } catch (error) {
      console.error(
        `[${this.sessionId}] Error processing audio for speaker detection:`,
        error
      );
    } finally {
      this.isProcessing = false;
    }
  }

  // Get current status for API response
  getStatus() {
    return {
      sessionId: this.sessionId,
      detectedSpeakers: this.detectedSpeakers,
      processedDuration: this.processedDuration,
      active: !!this.processingInterval,
      confidence: this.detectionResults.confidence,
      lastUpdate: new Date().toISOString(),
    };
  }

  // Stop processing and clean up
  stop() {
    if (this.processingInterval) {
      clearInterval(this.processingInterval);
      this.processingInterval = null;
    }

    // Process any remaining chunks
    this.processAudioChunks();

    // Save detection results to a file
    const resultsPath = path.join(
      this.sessionDir,
      "voice_detection_results.json"
    );
    try {
      fs.writeFileSync(
        resultsPath,
        JSON.stringify(
          {
            detectedSpeakers: this.detectedSpeakers,
            processedDuration: this.processedDuration,
            confidence: this.detectionResults.confidence,
            speakerClusters: this.speakerClusters,
            endTime: new Date().toISOString(),
          },
          null,
          2
        )
      );
    } catch (error) {
      console.error(
        `[${this.sessionId}] Error saving detection results:`,
        error
      );
    }

    // Clean up resources
    this.model = null;
    this.audioChunks = [];
    this.audioBuffer = null;

    return {
      detectedSpeakers: this.detectedSpeakers,
      processedDuration: this.processedDuration,
      confidence: this.detectionResults.confidence,
    };
  }
}

export function endService(router, storageDir, voiceDetections, broadcastFn) {
  clearInterval(processingInterval);
  // Store the original end handler
  const originalEndHandlerLayer = router.stack.find(
    (layer) => layer.route && layer.route.path === "/end"
  );

  if (!originalEndHandlerLayer) {
    console.error("Original /end route handler not found");
    return;
  }

  const originalEndHandler = originalEndHandlerLayer.handle;

  // Remove the original handler
  router.stack = router.stack.filter(
    (layer) => !(layer.route && layer.route.path === "/end")
  );

  // Re-add the endpoint with our enhanced handler
  router.post("/end", async (req, res) => {
    const { session_id } = req.body;

    // Process voice detection finalization before ending session
    if (session_id && voiceDetections.has(session_id)) {
      try {
        console.log(`[${session_id}] Finalizing voice detection`);
        const detector = voiceDetections.get(session_id);
        const result = detector.stop();

        // Add voice detection results to session metadata
        const sessionDir = path.join(storageDir, session_id);
        const metadataPath = path.join(sessionDir, "metadata.json");

        if (fs.existsSync(metadataPath)) {
          const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
          metadata.voiceDetection = {
            detectedSpeakers: result.detectedSpeakers,
            processedDuration: result.processedDuration,
            confidence: result.confidence || 0.7,
            completed: true,
            completedAt: new Date().toISOString(),
          };
          fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
          console.log(
            `[${session_id}] Updated session metadata with voice detection results`
          );
        }

        // Broadcast final detection results
        broadcastFn("detectionEnd", session_id, {
          timestamp: new Date().toISOString(),
          detectedSpeakers: result.detectedSpeakers,
          processedDuration: result.processedDuration,
          confidence: result.confidence || 0.7,
        });

        console.log(
          `[${session_id}] Voice detection completed with ${result.detectedSpeakers} speakers`
        );

        // Remove from active detections
        voiceDetections.delete(session_id);
      } catch (error) {
        console.error(
          `[${session_id}] Error finalizing voice detection:`,
          error
        );
      }
    }

    // Call original handler to end session
    return originalEndHandler(req, res);
  });
}
// Export function to integrate with main SOS routes
export function enhanceSosRoutesWithVoiceDetection(
  router,
  activeSessions,
  storageDir,
  broadcastFn
) {
  // Map to store voice detection managers
  const voiceDetections = new Map();

  // Debug middleware for audio chunks
  const debugAudioChunk = (req, res, next) => {
    const sessionId = req.headers["session-id"];
    if (sessionId && req.body) {
      console.log(
        `[${sessionId}] Received audio chunk: ${req.body.length} bytes`
      );
    }
    next();
  };

  // Add the debug middleware if in debug mode
  if (DETECTION_CONFIG.debugMode) {
    router.use("/stream", debugAudioChunk);
  }

  // Enhance stream endpoint to process audio for voice detection
  const originalStreamHandler = router.stack.find(
    (layer) => layer.route && layer.route.path === "/stream"
  ).handle;

  router.post("/stream", async (req, res) => {
    const sessionId = req.headers["session-id"];

    // Call original handler first
    await originalStreamHandler(req, res);

    // If response was successful, process audio for voice detection
    if (res.statusCode === 200 && sessionId && req.body) {
      try {
        let detector = voiceDetections.get(sessionId);

        // Create detector if it doesn't exist
        if (!detector) {
          console.log(
            `[${sessionId}] Initializing voice detection for session`
          );
          detector = new VoiceDetectionManager(
            sessionId,
            storageDir,
            broadcastFn
          );
          voiceDetections.set(sessionId, detector);

          console.log(`[${sessionId}] Voice detection initialized`);

          // Broadcast detection started
          broadcastFn("detectionStart", sessionId, {
            timestamp: new Date().toISOString(),
            type: "voice_detection",
          });
        }

        // Process the audio chunk
        detector.addAudioChunk(req.body);
      } catch (error) {
        console.error(
          `[${sessionId}] Error in voice detection processing:`,
          error
        );
      }
    }
  });

  // Add the enhanced end service
  endService(router, storageDir, voiceDetections, broadcastFn);

  // Add new endpoint to get current voice detection status
  router.get("/detection-status/:sessionId", (req, res) => {
    try {
      const { sessionId } = req.params;

      if (!sessionId) {
        return res.status(400).json({ error: "Session ID is required" });
      }

      // Check if session has voice detection
      if (voiceDetections.has(sessionId)) {
        const detector = voiceDetections.get(sessionId);
        return res.status(200).json({
          status: "active",
          ...detector.getStatus(),
        });
      }

      // Check archived sessions
      const sessionDir = path.join(storageDir, sessionId);
      const metadataPath = path.join(sessionDir, "metadata.json");
      const detailedResultsPath = path.join(
        sessionDir,
        "voice_detection_results.json"
      );

      if (fs.existsSync(metadataPath)) {
        const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));

        // Check if we have detailed results from the voice detection
        let detailedResults = null;
        if (fs.existsSync(detailedResultsPath)) {
          try {
            detailedResults = JSON.parse(
              fs.readFileSync(detailedResultsPath, "utf8")
            );
          } catch (err) {
            console.error(
              `Error reading detailed results for ${sessionId}:`,
              err
            );
          }
        }

        if (metadata.voiceDetection) {
          return res.status(200).json({
            status: "archived",
            sessionId,
            ...metadata.voiceDetection,
            detailedResults: detailedResults,
          });
        }

        return res.status(200).json({
          status: "no_detection",
          sessionId,
        });
      }

      return res
        .status(404)
        .json({ error: "Session or detection data not found" });
    } catch (error) {
      console.error("Error fetching detection status:", error);
      return res
        .status(500)
        .json({ error: "Failed to fetch detection status" });
    }
  });

  // Add an endpoint to get speaker timeline for a session
  router.get("/speaker-timeline/:sessionId", (req, res) => {
    try {
      const { sessionId } = req.params;

      if (!sessionId) {
        return res.status(400).json({ error: "Session ID is required" });
      }

      // Check if session has active voice detection
      if (voiceDetections.has(sessionId)) {
        const detector = voiceDetections.get(sessionId);
        return res.status(200).json({
          status: "active",
          sessionId,
          timeline: detector.speakerTimeline || [],
          clusters: detector.speakerClusters || [],
        });
      }

      // Check archived sessions
      const detailedResultsPath = path.join(
        storageDir,
        sessionId,
        "voice_detection_results.json"
      );
      if (fs.existsSync(detailedResultsPath)) {
        const results = JSON.parse(
          fs.readFileSync(detailedResultsPath, "utf8")
        );
        return res.status(200).json({
          status: "archived",
          sessionId,
          timeline: results.speakerTimeline || [],
          clusters: results.speakerClusters || [],
        });
      }

      return res.status(404).json({ error: "Speaker timeline data not found" });
    } catch (error) {
      console.error("Error fetching speaker timeline:", error);
      return res
        .status(500)
        .json({ error: "Failed to fetch speaker timeline" });
    }
  });

  return {
    router,
    voiceDetections,
  };
}

// Main integration function
export default function setupVoiceDetection(
  app,
  storageDir,
  broadcastSessionUpdate
) {
  // Get reference to the existing SOS router
  const sosRouter = app._router.stack.find(
    (layer) =>
      layer.name === "router" &&
      layer.handle.stack.some((r) => r.route && r.route.path === "/sos/start")
  )?.handle;

  if (!sosRouter) {
    console.error("SOS router not found for voice detection integration");
    return;
  }

  // Get access to active sessions map
  const activeSessions = app.get("activeSessions");

  if (!activeSessions) {
    console.error("Active sessions map not found in app");
    return;
  }

  // Store voice detections at the app level
  const enhancedRoutes = enhanceSosRoutesWithVoiceDetection(
    sosRouter,
    activeSessions,
    storageDir,
    broadcastSessionUpdate
  );

  // Store voice detections for access in middleware
  app.set("voiceDetections", enhancedRoutes.voiceDetections);

  // Add configuration endpoint to adjust detection parameters
  app.post("/api/sos/configure-detection", (req, res) => {
    try {
      const {
        minConfidence,
        windowSizeMs,
        updateIntervalMs,
        clusteringThreshold,
        debugMode,
      } = req.body;

      // Update configuration with provided values
      if (typeof minConfidence === "number")
        DETECTION_CONFIG.minConfidence = minConfidence;
      if (typeof windowSizeMs === "number")
        DETECTION_CONFIG.windowSizeMs = windowSizeMs;
      if (typeof updateIntervalMs === "number")
        DETECTION_CONFIG.updateIntervalMs = updateIntervalMs;
      if (typeof clusteringThreshold === "number")
        DETECTION_CONFIG.clusteringThreshold = clusteringThreshold;
      if (typeof debugMode === "boolean")
        DETECTION_CONFIG.debugMode = debugMode;

      console.log("Voice detection configuration updated:", DETECTION_CONFIG);

      return res.status(200).json({
        success: true,
        message: "Detection configuration updated",
        config: DETECTION_CONFIG,
      });
    } catch (error) {
      console.error("Error updating detection configuration:", error);
      return res.status(500).json({ error: "Failed to update configuration" });
    }
  });

  // Add endpoint to get current detection configuration
  app.get("/api/sos/detection-config", (req, res) => {
    return res.status(200).json({
      config: DETECTION_CONFIG,
    });
  });

  console.log("Voice detection system integrated with SOS routes");
  console.log("Current detection configuration:", DETECTION_CONFIG);

  return app;
}
