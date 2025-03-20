// Modified safety routing algorithm that accepts route data directly
import mongoose from "mongoose";

// Review Schema (for reference)
const ReviewSchema = mongoose.Schema({
  lat: {
    type: String,
    required: true,
  },
  lon: {
    type: String,
    required: true,
  },
  safetyRating: {
    type: Number,
    required: true,
    min: 1,
    max: 10,
  },
  police_presence: {
    type: String,
    required: false,
    enum: ["none", "low", "moderate", "high"],
  },
  street_lights: {
    type: String,
    required: false,
    enum: ["none", "low", "moderate", "high"],
  },
  people_density: {
    type: String,
    required: false,
    enum: ["none", "low", "moderate", "high"],
  },
  traffic: {
    type: String,
    required: false,
    enum: ["none", "low", "moderate", "high"],
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
});

const Review = mongoose.model("Review", ReviewSchema);
export default Review;
