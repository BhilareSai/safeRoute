// test/testAudioProcessing.js
import fs from "fs";
import path from "path";
import { Transform } from "stream";
import { spawn } from "child_process";
import ffmpegPath from "ffmpeg-static";

// Since the AudioBuffer class isn't exported from voiceSetupdetection.js,
// let's recreate it here for testing purposes
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

// Function to extract audio features using ffmpeg
async function extractAudioFeatures(audioBuffer) {
  if (!audioBuffer || audioBuffer.length === 0) {
    console.warn("No audio data to process");
    return [];
  }

  // Create temp files for processing
  const tempDir = path.join(process.cwd(), "temp");
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  const tempFile = path.join(tempDir, `temp_process_${Date.now()}.raw`);
  const wavFile = path.join(tempDir, `temp_process_${Date.now()}.wav`);

  try {
    // Write buffer to temp file
    fs.writeFileSync(tempFile, audioBuffer);
    console.log(
      `Temp file created: ${tempFile} (${fs.statSync(tempFile).size} bytes)`
    );

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

    console.log(
      `WAV file created: ${wavFile} (${fs.statSync(wavFile).size} bytes)`
    );

    // Extract audio features using ffmpeg
    const features = await new Promise((resolve, reject) => {
      const result = [];

      // Use FFmpeg to extract audio spectrum data
      const ffmpegSpectrum = spawn(ffmpegPath, [
        "-i",
        wavFile,
        "-af",
        "asetnsamples=2048,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:key=lavfi.astats.Overall.Peak_level:key=lavfi.astats.Overall.Flat_factor",
        "-f",
        "null",
        "-",
      ]);

      let stderr = "";
      ffmpegSpectrum.stderr.on("data", (data) => {
        stderr += data.toString();

        // Extract audio features
        const rmsMatches = stderr.match(
          /lavfi\.astats\.Overall\.RMS_level=(-?\d+\.\d+)/g
        );
        const peakMatches = stderr.match(
          /lavfi\.astats\.Overall\.Peak_level=(-?\d+\.\d+)/g
        );
        const flatMatches = stderr.match(
          /lavfi\.astats\.Overall\.Flat_factor=(-?\d+\.\d+)/g
        );

        if (rmsMatches && peakMatches && flatMatches) {
          // Process a batch of features
          for (let i = 0; i < rmsMatches.length; i++) {
            if (i < peakMatches.length && i < flatMatches.length) {
              const rms = parseFloat(rmsMatches[i].split("=")[1]);
              const peak = parseFloat(peakMatches[i].split("=")[1]);
              const flat = parseFloat(flatMatches[i].split("=")[1]);

              result.push({
                rms,
                peak,
                flat,
                energy: Math.pow(10, rms / 20), // Convert dB to linear energy
                frameIndex: result.length,
              });
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

// Function to detect voice activity from features
function detectVoiceActivity(features) {
  if (!features || features.length === 0) {
    return [];
  }

  // Calculate energy threshold - use the mean plus a small margin
  const energyValues = features.map((f) => f.energy);
  const meanEnergy =
    energyValues.reduce((sum, val) => sum + val, 0) / energyValues.length;
  const energyThreshold = meanEnergy * 1.2; // 20% above mean

  console.log(
    `Energy threshold: ${energyThreshold.toFixed(
      6
    )} (mean: ${meanEnergy.toFixed(6)})`
  );

  // Detect speech segments
  const speechSegments = [];
  let inSpeech = false;
  let segmentStart = 0;
  let frameRate = 0.03; // Assuming approximately 30ms per frame based on astats

  for (let i = 0; i < features.length; i++) {
    const isSpeech = features[i].energy > energyThreshold;

    if (isSpeech && !inSpeech) {
      // Start of speech segment
      inSpeech = true;
      segmentStart = i;
    } else if (!isSpeech && inSpeech) {
      // End of speech segment
      inSpeech = false;

      // Only keep segments longer than 300ms (approximately 10 frames)
      if (i - segmentStart >= 10) {
        speechSegments.push({
          startFrame: segmentStart,
          endFrame: i,
          startTime: segmentStart * frameRate,
          endTime: i * frameRate,
          features: features.slice(segmentStart, i),
        });
      }
    }
  }

  // If still in speech at the end, close the segment
  if (inSpeech && features.length - segmentStart >= 10) {
    speechSegments.push({
      startFrame: segmentStart,
      endFrame: features.length,
      startTime: segmentStart * frameRate,
      endTime: features.length * frameRate,
      features: features.slice(segmentStart),
    });
  }

  return speechSegments;
}

// Configuration
const TEST_SESSION_ID =
  process.argv[2] || "eec1c4f2-95e6-4a16-9b6a-314b6812f22f";
const SESSION_DIR = path.join("../../sessions", TEST_SESSION_ID);
const AUDIO_FILE = path.join(SESSION_DIR, "audio.raw");

console.log(`Testing audio processing for session: ${TEST_SESSION_ID}`);
console.log(`Audio file path: ${AUDIO_FILE}`);

try {
  // Validate file exists
  if (!fs.existsSync(AUDIO_FILE)) {
    console.error(`Error: Audio file not found at ${AUDIO_FILE}`);
    console.log("Available sessions:");

    const sessionsDir = path.join("../../sessions");
    if (fs.existsSync(sessionsDir)) {
      const sessions = fs.readdirSync(sessionsDir);
      sessions.forEach((session) => {
        const audioPath = path.join(sessionsDir, session, "audio.raw");
        console.log(
          `- ${session} ${
            fs.existsSync(audioPath) ? "(has audio)" : "(no audio)"
          }`
        );
      });
    } else {
      console.log("Sessions directory not found.");
    }

    process.exit(1);
  }

  // Get file stats
  const stats = fs.statSync(AUDIO_FILE);
  console.log(
    `Audio file size: ${stats.size} bytes (${(stats.size / 1024 / 1024).toFixed(
      2
    )} MB)`
  );

  // Read the audio file
  console.log("Reading audio file...");
  const testBuffer = fs.readFileSync(AUDIO_FILE);
  console.log(`Successfully read ${testBuffer.length} bytes`);

  // Process with AudioBuffer
  const audioBuffer = new AudioBuffer();
  audioBuffer.write(testBuffer);
  console.log("Audio buffer initialized successfully");

  // Test window extraction with different sizes
  console.log("\n=== Testing Audio Window Extraction ===");
  const windowSizes = [0.5, 1, 2]; // window sizes in seconds

  windowSizes.forEach((seconds) => {
    const window = audioBuffer.getWindow(seconds);
    console.log(`Window size (${seconds}s): ${window.length} bytes`);
  });

  // Test feature extraction with progress reporting
  console.log("\n=== Testing Feature Extraction ===");
  console.log("Extracting audio features...");
  const extractionStart = Date.now();

  extractAudioFeatures(audioBuffer.getBuffer())
    .then((features) => {
      const extractionTime = (Date.now() - extractionStart) / 1000;
      console.log(
        `Features extracted: ${features.length} (took ${extractionTime.toFixed(
          2
        )}s)`
      );

      if (features.length > 0) {
        console.log("Sample feature vector:", features[0]);
      }

      // Test voice activity detection
      console.log("\n=== Testing Voice Activity Detection ===");
      console.log("Detecting speech segments...");
      const vadStart = Date.now();

      const segments = detectVoiceActivity(features);

      const vadTime = (Date.now() - vadStart) / 1000;
      console.log(
        `Speech segments detected: ${segments.length} (took ${vadTime.toFixed(
          2
        )}s)`
      );

      // Print a summary of speech segments
      if (segments.length > 0) {
        console.log("\nSpeech Segments Summary:");
        console.log("------------------------");
        let totalSpeechDuration = 0;

        segments.forEach((segment, index) => {
          // Calculate duration in seconds
          const duration = segment.endTime - segment.startTime;
          totalSpeechDuration += duration;

          // Only print details for first 5 segments to avoid spam
          if (index < 5) {
            console.log(
              `Segment ${index + 1}: ${segment.startTime.toFixed(
                2
              )}s - ${segment.endTime.toFixed(2)}s (${duration.toFixed(2)}s)`
            );
          }
        });

        if (segments.length > 5) {
          console.log(`... and ${segments.length - 5} more segments`);
        }

        const audioLengthSec = testBuffer.length / (16000 * 2); // Assuming 16kHz, 16-bit mono
        console.log(
          `\nTotal speech duration: ${totalSpeechDuration.toFixed(
            2
          )}s out of ${audioLengthSec.toFixed(2)}s (${(
            (totalSpeechDuration / audioLengthSec) *
            100
          ).toFixed(2)}% of audio)`
        );
      }

      console.log("\n=== Test Completed Successfully ===");
    })
    .catch((error) => {
      console.error("Feature extraction failed:", error);
      process.exit(1);
    });
} catch (error) {
  console.error("Test failed with error:", error);
  process.exit(1);
}
