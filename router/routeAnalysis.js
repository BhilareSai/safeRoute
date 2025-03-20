// Example of how to use the safety algorithm with direct route data input
import express from "express";

import {
  analyzeRouteSafety,
  insertRouteReview,
} from "../controller/routeController.js"; // Add .js extension here

const router = express.Router();
router.post("/analyze-routes", analyzeRouteSafety);
router.post("/review", insertRouteReview);

export default router;
