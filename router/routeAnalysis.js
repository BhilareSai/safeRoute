// Example of how to use the safety algorithm with direct route data input
import express from "express";

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

export default router;
