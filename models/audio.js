import mongoose from "mongoose";

const AudioSchema = mongoose.Schema({
  lat: {
    type: String,
    required: true,
  },
  sessionId: {
    type: String,
    required: false,
  },
  lon: {
    type: String,
    required: true,
  },
  audio: {
    type: String,
    required: false,
  },
  user_id: {
    type: String,
    required: false,
  },
  userDateTime: {
    type: Date,
  },
  dateTime: {
    type: Date,
    default: Date.now,
  },
  device_id: {
    type: String,
    required: false,
  },
  batter: {
    type: String,
    required: false,
  },
});

const Audio = mongoose.model("Audio", AudioSchema);
export default Audio;
