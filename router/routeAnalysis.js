// Example of how to use the safety algorithm with direct route data input
import express from "express";
import Audio from "../models/audio.js";
import {
  analyzeRouteSafety,
  insertRouteReview,
  generateMockReviews,
  getALLReviews,
} from "../controller/routeController.js"; // Add .js extension here

const router = express.Router();
router.post("/analyze-routes", analyzeRouteSafety);
router.post("/review", insertRouteReview);
router.post("/generateReviwes", generateMockReviews);
router.get("/getReviews", getALLReviews);
router.get("/audio", async (req, res) => {
  const audio = await Audio.find({
    audio: { $ne: null, $ne: "" },
  });
  res.json(audio);
});
router.delete("/del", async (req, res) => {
  try {
    await Audio.deleteMany();
    res.status(200).send("All audio data deleted");
  } catch (err) {
    console.error("Error deleting audio data:", err);
    res.status(500).send("An error occurred while deleting audio data");
  }
});

export default router;
