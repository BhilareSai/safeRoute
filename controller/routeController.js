import asyncErrorHandler from "express-async-handler";
import Review from "../models/safeRoutes.js";

/**
 * Enhanced analyzeRouteSafety controller with detailed segment analysis for all routes
 * This function processes routes and provides comprehensive safety information with explanations
 * Optimized to minimize database queries
 */
export const analyzeRouteSafety = asyncErrorHandler(async (req, res) => {
  try {
    const { timeOfDay, routes } = req.body;

    if (!routes || !Array.isArray(routes) || routes.length === 0) {
      return res.status(400).json({ error: "At least one route is required" });
    }

    // Create options object for safety algorithm
    const options = {
      searchRadius: 100, // 100 meters radius for review search
      recencyWeight: true,
      recencyDays: 60,
      confidenceThreshold: 2,
      analysisTimestamp: new Date().toISOString(), // Add timestamp for analysis
    };

    // Add time of day if provided
    if (timeOfDay) {
      options.timeOfDay = new Date(timeOfDay);
    }

    // Extract all route points to find bounding box
    const allPoints = routes.flat();

    // Calculate bounding box for all routes with buffer for search radius
    // Convert search radius from meters to approximate degrees
    const searchRadiusInDegrees = options.searchRadius / 111000;

    // Find min/max coordinates across all routes
    const minLat =
      Math.min(...allPoints.map((p) => parseFloat(p.latitude))) -
      searchRadiusInDegrees;
    const maxLat =
      Math.max(...allPoints.map((p) => parseFloat(p.latitude))) +
      searchRadiusInDegrees;
    const minLon =
      Math.min(...allPoints.map((p) => parseFloat(p.longitude))) -
      searchRadiusInDegrees;
    const maxLon =
      Math.max(...allPoints.map((p) => parseFloat(p.longitude))) +
      searchRadiusInDegrees;

    // Build query to fetch all needed reviews at once
    const dateFilter = {};
    if (options.timeOfDay) {
      const timeOfDay = new Date(options.timeOfDay);
      const startHour = new Date(timeOfDay);
      startHour.setHours(timeOfDay.getHours() - 2);
      const endHour = new Date(timeOfDay);
      endHour.setHours(timeOfDay.getHours() + 2);
      dateFilter.userDateTime = { $gte: startHour, $lte: endHour };
    }

    // Single database query to fetch all reviews in the area
    const allReviews = await Review.find({
      lat: { $gte: minLat.toString(), $lte: maxLat.toString() },
      lon: { $gte: minLon.toString(), $lte: maxLon.toString() },
      ...dateFilter,
    })
      .lean()
      .exec();

    console.log(
      `Fetched ${allReviews.length} reviews in single query for all routes`
    );

    // Create spatial index for faster lookups
    const reviewSpatialIndex = createSpatialIndex(allReviews);

    // Analyze safety for each provided route
    const routeSafetyPromises = routes.map(async (route, index) => {
      // Validate each route has at least 2 points (source and destination)
      if (!route || !Array.isArray(route) || route.length < 2) {
        throw new Error(`Route ${index + 1} must have at least 2 points`);
      }

      // Set first point as source
      const routeSource = {
        latitude: parseFloat(route[0].latitude),
        longitude: parseFloat(route[0].longitude),
        name: route[0].name || `Source (Route ${index + 1})`,
      };

      // Set last point as destination
      const routeDestination = {
        latitude: parseFloat(route[route.length - 1].latitude),
        longitude: parseFloat(route[route.length - 1].longitude),
        name:
          route[route.length - 1].name || `Destination (Route ${index + 1})`,
      };

      // Use intermediate points (excluding first and last)
      const intermediatePoints = route
        .slice(1, route.length - 1)
        .map((point) => ({
          ...point,
          latitude: parseFloat(point.latitude),
          longitude: parseFloat(point.longitude),
        }));

      // Calculate safety scores for this route using the pre-fetched reviews
      const routeSafety = await findSafestRoute(
        routeSource,
        routeDestination,
        intermediatePoints,
        options,
        reviewSpatialIndex
      );

      // Categorize segments by safety level
      const segments = routeSafety.route
        .filter((point) => point.edgeSafety)
        .map((point) => ({
          safety: point.edgeSafety.safetyScore,
        }));

      const safetyBreakdown = {
        highSafetySegments: segments.filter((s) => s.safety >= 7).length,
        moderateSafetySegments: segments.filter(
          (s) => s.safety >= 4 && s.safety < 7
        ).length,
        lowSafetySegments: segments.filter((s) => s.safety < 4).length,
        calculationMethod:
          "Weighted average of segment safety scores, with higher weight given to longer segments and recent reviews",
      };

      // Create enhanced segment analysis with more detailed information
      const segmentAnalysis = createEnhancedSegmentAnalysis(routeSafety.route);

      // Generate contextual explanation for each route
      const routeExplanation = generateRouteExplanation(
        routeSafety,
        index + 1,
        safetyBreakdown,
        options
      );

      return {
        routeIndex: index,
        routeName: `Route ${index + 1}`,
        overallSafety: routeSafety.overallSafety,
        totalDistance: routeSafety.totalDistance,
        dangerousSegmentsCount: routeSafety.dangerousSegments.length,
        safetyBreakdown: safetyBreakdown,
        segmentAnalysis: segmentAnalysis,
        routeExplanation: routeExplanation,
        safetyAnalysisExplanation: {
          summary: generateSafetySummary(routeSafety, options),
          keyFactors: generateKeyFactors(routeSafety),
          confidenceLevel: generateConfidenceLevel(routeSafety),
          timeFactors: options.timeOfDay
            ? `Analysis considered ${getTimeOfDayDescription(
                options.timeOfDay
              )} conditions as specified in request`
            : "Analysis based on time-independent factors",
        },
        route: routes[index],
      };
    });

    // Wait for all route safety analyses to complete
    const routeSafetyResults = await Promise.all(routeSafetyPromises);

    // Sort routes by overall safety score (highest first)
    routeSafetyResults.sort((a, b) => b.overallSafety - a.overallSafety);

    // Determine recommended route (safest one)
    const recommendedRoute = { ...routeSafetyResults[0] };

    // Prepare a more detailed response format
    const response = {
      recommendedRoute: {
        routeIndex: recommendedRoute.routeIndex,
        routeName: recommendedRoute.routeName,
        overallSafety: recommendedRoute.overallSafety,
        totalDistance: recommendedRoute.totalDistance,
        safetyAnalysisExplanation: recommendedRoute.safetyAnalysisExplanation,
        segmentAnalysis: recommendedRoute.segmentAnalysis,
        routeExplanation: recommendedRoute.routeExplanation,
        route: recommendedRoute.route,
      },
      allRoutes: routeSafetyResults.map((result) => ({
        routeIndex: result.routeIndex,
        routeName: result.routeName,
        overallSafety: result.overallSafety,
        totalDistance: result.totalDistance,
        dangerousSegmentsCount: result.dangerousSegmentsCount,
        safetyBreakdown: result.safetyBreakdown,
        segmentAnalysis: result.segmentAnalysis,
        routeExplanation: result.routeExplanation,
      })),
      requestDetails: {
        timeOfDay: options.timeOfDay ? options.timeOfDay.toISOString() : null,
        analysisParameters: {
          searchRadius: options.searchRadius,
          recencyWeight: options.recencyWeight,
          recencyDays: options.recencyDays,
          confidenceThreshold: options.confidenceThreshold,
          analysisTimestamp: options.analysisTimestamp,
        },
      },
      methodologyExplanation: {
        safetyScoreCalculation:
          "Safety scores are calculated on a scale of 0-10 by analyzing user reviews within 100m of each route segment. Recent reviews (within 60 days) are given higher weight in the calculation.",
        factorsConsidered: [
          "User safety ratings (1-10 scale)",
          "Police presence levels (none, low, moderate, high)",
          "Street lighting quality (none, low, moderate, high)",
          "People density for natural surveillance (none, low, moderate, high)",
          "Traffic conditions (none, low, moderate, high)",
        ],
        confidenceModel:
          "Routes with fewer than 2 reviews per segment may have lower confidence ratings, indicating more variability in the safety assessment.",
        alternativeRoutesExplanation:
          "All routes are ranked by safety score, with detailed segment analysis provided for all options to allow for informed decision making that balances safety, distance, and other factors.",
      },
    };

    return res.status(200).json(response);
  } catch (error) {
    console.error("Error analyzing route safety:", error);
    return res.status(500).json({
      error: "Failed to analyze route safety",
      message: error.message,
    });
  }
});

/**
 * Creates a spatial index for fast lookup of reviews near points
 * @param {Array} reviews - Array of review objects with lat and lon
 * @returns {Object} - Spatial index for fast lookups
 */
function createSpatialIndex(reviews) {
  // Create a simple grid-based spatial index
  const index = {
    reviews: reviews,
    // Function to find reviews near a point
    findNearby: function (lat, lon, radiusInDegrees) {
      // Simple distance filter using bounding box first
      const minLat = lat - radiusInDegrees;
      const maxLat = lat + radiusInDegrees;
      const minLon = lon - radiusInDegrees;
      const maxLon = lon + radiusInDegrees;

      // First-pass filtering using bounding box
      const candidates = this.reviews.filter((review) => {
        const reviewLat = parseFloat(review.lat);
        const reviewLon = parseFloat(review.lon);
        return (
          reviewLat >= minLat &&
          reviewLat <= maxLat &&
          reviewLon >= minLon &&
          reviewLon <= maxLon
        );
      });

      // Second-pass filtering using actual distance calculation
      return candidates.filter((review) => {
        const distance =
          calculateDistance(
            { lat, lon },
            { lat: parseFloat(review.lat), lon: parseFloat(review.lon) }
          ) * 1000; // Convert to meters

        // Return reviews within the search radius
        return distance <= radiusInDegrees * 111000; // Convert to meters
      });
    },
  };

  return index;
}

/**
 * Creates enhanced segment analysis with detailed safety information
 * @param {Array} route - Array of route points with safety data
 * @returns {Array} - Array of segment analysis objects
 */
function createEnhancedSegmentAnalysis(route) {
  return route
    .filter((point) => point.edgeSafety)
    .map((point, idx) => {
      const nextPoint = route[point.edgeSafety.toIndex];

      // Create segment safety factors object with more detailed attributes
      const safetyFactors = {
        policePresence: {
          level: point.safetyData.factors.police_presence || "unknown",
          description: getPolicePresenceDescription(
            point.safetyData.factors.police_presence
          ),
          impact: getSafetyFactorImpact(
            "police_presence",
            point.safetyData.factors.police_presence
          ),
        },
        streetLights: {
          level: point.safetyData.factors.street_lights || "unknown",
          description: getStreetLightsDescription(
            point.safetyData.factors.street_lights
          ),
          impact: getSafetyFactorImpact(
            "street_lights",
            point.safetyData.factors.street_lights
          ),
        },
        peopleDensity: {
          level: point.safetyData.factors.people_density || "unknown",
          description: getPeopleDensityDescription(
            point.safetyData.factors.people_density
          ),
          impact: getSafetyFactorImpact(
            "people_density",
            point.safetyData.factors.people_density
          ),
        },
        traffic: {
          level: point.safetyData.factors.traffic || "unknown",
          description: getTrafficDescription(point.safetyData.factors.traffic),
          impact: getSafetyFactorImpact(
            "traffic",
            point.safetyData.factors.traffic
          ),
        },
      };

      // Calculate normalized safety score (0-1 scale)
      const normalizedSafety = parseFloat(
        (point.edgeSafety.safetyScore / 10).toFixed(2)
      );

      // Determine safety category
      let safetyCategory;
      if (normalizedSafety >= 0.7) {
        safetyCategory = "high";
      } else if (normalizedSafety >= 0.4) {
        safetyCategory = "moderate";
      } else {
        safetyCategory = "low";
      }

      // Create segment object with enhanced properties
      const segment = {
        segmentId: `seg-${idx + 1}`,
        startPoint: {
          latitude: point.latitude.toString(),
          longitude: point.longitude.toString(),
          name: point.name || `Point ${idx}`,
        },
        endPoint: {
          latitude: nextPoint.latitude.toString(),
          longitude: nextPoint.longitude.toString(),
          name: nextPoint.name || `Point ${point.edgeSafety.toIndex}`,
        },
        segmentSafety: normalizedSafety,
        safetyCategory: safetyCategory,
        segmentDistance: parseFloat(point.edgeSafety.distance.toFixed(2)), // in km
        reviewCount: point.safetyData.reviewCount,
        confidence: parseFloat(point.safetyData.confidence.toFixed(2)),
        safetyFactors: safetyFactors,
        segmentExplanation: generateSegmentExplanation(
          point,
          nextPoint,
          normalizedSafety,
          safetyFactors
        ),
      };

      // Add caution notes for segments with safety concerns
      if (segment.segmentSafety < 0.6) {
        segment.cautionNotes = generateCautionNotes(safetyFactors);

        // Add recommendation for improving safety in this segment
        segment.safetyRecommendations =
          generateSafetyRecommendations(safetyFactors);
      }

      return segment;
    });
}

/**
 * Generates a human-readable explanation of the route's safety profile
 * @param {Object} routeSafety - Safety data for the route
 * @param {Number} routeNumber - The route number (for reference)
 * @param {Object} safetyBreakdown - Breakdown of segment safety levels
 * @param {Object} options - Analysis options
 * @returns {String} - Detailed explanation of the route's safety
 */
function generateRouteExplanation(
  routeSafety,
  routeNumber,
  safetyBreakdown,
  options
) {
  const safetyPercentage = Math.round(routeSafety.overallSafety * 1000) / 10;
  const totalDistance = routeSafety.totalDistance.toFixed(2);
  const totalSegments = routeSafety.route.filter((p) => p.edgeSafety).length;

  // Calculate segment percentages
  const highSegmentPercent = Math.round(
    (safetyBreakdown.highSafetySegments / totalSegments) * 100
  );
  const moderateSegmentPercent = Math.round(
    (safetyBreakdown.moderateSafetySegments / totalSegments) * 100
  );
  const lowSegmentPercent = Math.round(
    (safetyBreakdown.lowSafetySegments / totalSegments) * 100
  );

  // Get dominant safety factors across the route
  const dominantFactors = getDominantSafetyFactors(routeSafety.route);

  // Create time-specific context if available
  const timeContext = options.timeOfDay
    ? `when traveling during the ${getTimeOfDayDescription(options.timeOfDay)}`
    : "based on available safety data";

  // Generate primary safety assessment
  let safetyAssessment;
  if (safetyPercentage >= 70) {
    safetyAssessment = `Route ${routeNumber} is considered highly safe overall with a safety rating of ${safetyPercentage}% ${timeContext}. ${highSegmentPercent}% of segments along this ${totalDistance} km route have high safety ratings, with only ${lowSegmentPercent}% categorized as having potential safety concerns.`;
  } else if (safetyPercentage >= 40) {
    safetyAssessment = `Route ${routeNumber} has a moderate overall safety rating of ${safetyPercentage}% ${timeContext}. This ${totalDistance} km route contains a mix of safety profiles with ${highSegmentPercent}% high-safety segments, ${moderateSegmentPercent}% moderate-safety segments, and ${lowSegmentPercent}% segments with safety concerns that may require additional caution.`;
  } else {
    safetyAssessment = `Route ${routeNumber} has safety challenges with an overall safety rating of ${safetyPercentage}% ${timeContext}. This ${totalDistance} km route has ${lowSegmentPercent}% of segments with safety concerns and only ${highSegmentPercent}% high-safety segments. Extra vigilance is recommended when traveling this route.`;
  }

  // Add details about dominant safety factors
  const factorsDescription = `Key safety characteristics of this route include ${dominantFactors.police_presence} police presence, ${dominantFactors.street_lights} street lighting, and ${dominantFactors.people_density} people density throughout most segments.`;

  // Add recommendations section based on safety level
  let recommendations;
  if (safetyPercentage >= 70) {
    recommendations = `This route is recommended for travel during both day and night hours, though standard safety precautions are always advisable.`;
  } else if (safetyPercentage >= 40) {
    recommendations = `This route is generally suitable for travel, with increased awareness recommended particularly in segments with lower safety ratings. Consider using this route during daylight hours if possible.`;
  } else {
    recommendations = `If possible, consider alternative routes with higher safety ratings. If using this route, travel during daylight hours is strongly recommended, and extra vigilance in the identified low-safety segments is advised.`;
  }

  // Combine all sections into one comprehensive explanation
  return `${safetyAssessment} ${factorsDescription} ${recommendations}`;
}

/**
 * Generates explanation for a specific route segment
 * @param {Object} startPoint - Starting point of the segment with safety data
 * @param {Object} endPoint - Ending point of the segment
 * @param {Number} safetyScore - Normalized safety score (0-1)
 * @param {Object} safetyFactors - Object containing safety factor details
 * @returns {String} - Human-readable explanation of the segment
 */
function generateSegmentExplanation(
  startPoint,
  endPoint,
  safetyScore,
  safetyFactors
) {
  const safetyPercentage = Math.round(safetyScore * 100);
  const distance = startPoint.edgeSafety.distance.toFixed(2);
  const reviewCount = startPoint.safetyData.reviewCount;
  const confidence = Math.round(startPoint.safetyData.confidence * 100);

  // Create segment location description
  const segmentDescription =
    startPoint.name && endPoint.name
      ? `from ${startPoint.name} to ${endPoint.name}`
      : `at coordinates (${startPoint.latitude}, ${startPoint.longitude}) to (${endPoint.latitude}, ${endPoint.longitude})`;

  // Determine primary safety level description
  let safetyDescription;
  if (safetyScore >= 0.7) {
    safetyDescription = `This ${distance} km segment ${segmentDescription} has a high safety rating of ${safetyPercentage}%`;
  } else if (safetyScore >= 0.4) {
    safetyDescription = `This ${distance} km segment ${segmentDescription} has a moderate safety rating of ${safetyPercentage}%`;
  } else {
    safetyDescription = `This ${distance} km segment ${segmentDescription} has a low safety rating of ${safetyPercentage}%`;
  }

  // Add confidence information
  const confidenceDescription =
    reviewCount > 0
      ? ` based on ${reviewCount} reviews, with ${confidence}% confidence in this assessment.`
      : ` based on interpolated safety data from nearby areas, with low confidence in this assessment.`;

  // Add key safety factors explanation
  const factorsExplanation = `Key safety characteristics include ${safetyFactors.policePresence.description}, ${safetyFactors.streetLights.description}, and ${safetyFactors.peopleDensity.description}.`;

  return `${safetyDescription}${confidenceDescription} ${factorsExplanation}`;
}

/**
 * Generates safety caution notes based on identified issues
 * @param {Object} safetyFactors - Object containing safety factor details
 * @returns {String} - Combined caution message
 */
function generateCautionNotes(safetyFactors) {
  const cautionItems = [];

  // Check each safety factor for potential issues
  if (["low", "none"].includes(safetyFactors.policePresence.level)) {
    cautionItems.push("limited police presence");
  }

  if (["low", "none"].includes(safetyFactors.streetLights.level)) {
    cautionItems.push("poor lighting conditions");
  }

  if (["low", "none"].includes(safetyFactors.peopleDensity.level)) {
    cautionItems.push("isolated area with few people");
  }

  if (["high"].includes(safetyFactors.traffic.level)) {
    cautionItems.push("heavy traffic conditions");
  }

  // Format the caution message based on number of issues
  if (cautionItems.length === 0) {
    return "Exercise normal caution in this area";
  } else if (cautionItems.length === 1) {
    return `Exercise additional caution due to ${cautionItems[0]}`;
  } else {
    const lastItem = cautionItems.pop();
    return `Exercise additional caution due to ${cautionItems.join(
      ", "
    )} and ${lastItem}`;
  }
}

/**
 * Generates personalized safety recommendations based on identified issues
 * @param {Object} safetyFactors - Object containing safety factor details
 * @returns {Array} - List of recommended safety measures
 */
function generateSafetyRecommendations(safetyFactors) {
  const recommendations = [];

  // Police presence recommendations
  if (["low", "none"].includes(safetyFactors.policePresence.level)) {
    recommendations.push(
      "Consider informing someone of your travel route and estimated arrival time"
    );
  }

  // Street lighting recommendations
  if (["low", "none"].includes(safetyFactors.streetLights.level)) {
    recommendations.push(
      "Carry a flashlight or use your phone's flashlight feature if traveling after dark"
    );
  }

  // People density recommendations
  if (["low", "none"].includes(safetyFactors.peopleDensity.level)) {
    recommendations.push(
      "Stay alert and be aware of your surroundings in this less populated area"
    );
  }

  // Traffic recommendations
  if (["high"].includes(safetyFactors.traffic.level)) {
    recommendations.push(
      "Use designated crosswalks and follow traffic signals carefully"
    );
  }

  // Add default recommendation if no specific issues
  if (recommendations.length === 0) {
    recommendations.push("Follow standard safety practices for urban travel");
  }

  return recommendations;
}

/**
 * Gets descriptive text for police presence levels
 * @param {String} level - Police presence level (none, low, moderate, high)
 * @returns {String} - Human-readable description
 */
function getPolicePresenceDescription(level) {
  switch (level) {
    case "high":
      return "frequent police patrols";
    case "moderate":
      return "regular police presence";
    case "low":
      return "occasional police presence";
    case "none":
      return "minimal to no visible police presence";
    default:
      return "unknown level of police presence";
  }
}

/**
 * Gets descriptive text for street lighting levels
 * @param {String} level - Street lighting level (none, low, moderate, high)
 * @returns {String} - Human-readable description
 */
function getStreetLightsDescription(level) {
  switch (level) {
    case "high":
      return "excellent street lighting";
    case "moderate":
      return "adequate street lighting";
    case "low":
      return "limited street lighting";
    case "none":
      return "minimal to no street lighting";
    default:
      return "unknown level of street lighting";
  }
}

/**
 * Gets descriptive text for people density levels
 * @param {String} level - People density level (none, low, moderate, high)
 * @returns {String} - Human-readable description
 */
function getPeopleDensityDescription(level) {
  switch (level) {
    case "high":
      return "busy area with high foot traffic";
    case "moderate":
      return "moderate pedestrian activity";
    case "low":
      return "sparse pedestrian activity";
    case "none":
      return "very isolated area with minimal pedestrian presence";
    default:
      return "unknown level of pedestrian activity";
  }
}

/**
 * Gets descriptive text for traffic conditions
 * @param {String} level - Traffic level (none, low, moderate, high)
 * @returns {String} - Human-readable description
 */
function getTrafficDescription(level) {
  switch (level) {
    case "high":
      return "heavy vehicular traffic";
    case "moderate":
      return "moderate vehicular traffic";
    case "low":
      return "light vehicular traffic";
    case "none":
      return "minimal to no vehicular traffic";
    default:
      return "unknown traffic conditions";
  }
}

/**
 * Assesses the safety impact of a particular factor level
 * @param {String} factor - Factor name
 * @param {String} level - Factor level
 * @returns {String} - Impact assessment (positive, neutral, negative)
 */
function getSafetyFactorImpact(factor, level) {
  // Default impact mapping
  const impactMap = {
    police_presence: {
      high: "positive",
      moderate: "positive",
      low: "neutral",
      none: "negative",
      unknown: "neutral",
    },
    street_lights: {
      high: "positive",
      moderate: "positive",
      low: "neutral",
      none: "negative",
      unknown: "neutral",
    },
    people_density: {
      high: "positive",
      moderate: "positive",
      low: "neutral",
      none: "negative",
      unknown: "neutral",
    },
    traffic: {
      high: "negative",
      moderate: "neutral",
      low: "positive",
      none: "positive",
      unknown: "neutral",
    },
  };

  return impactMap[factor] ? impactMap[factor][level] || "neutral" : "neutral";
}

/**
 * Gets the dominant safety factors across all points in a route
 * @param {Array} route - Array of route points with safety data
 * @returns {Object} - Object with dominant levels for each factor
 */
function getDominantSafetyFactors(route) {
  // Count occurrences of each factor level
  const factorCounts = {
    police_presence: { none: 0, low: 0, moderate: 0, high: 0, unknown: 0 },
    street_lights: { none: 0, low: 0, moderate: 0, high: 0, unknown: 0 },
    people_density: { none: 0, low: 0, moderate: 0, high: 0, unknown: 0 },
    traffic: { none: 0, low: 0, moderate: 0, high: 0, unknown: 0 },
  };

  // Count factors across all points
  route.forEach((point) => {
    if (point.safetyData && point.safetyData.factors) {
      Object.keys(point.safetyData.factors).forEach((factor) => {
        const level = point.safetyData.factors[factor];
        if (factorCounts[factor] && level) {
          factorCounts[factor][level]++;
        }
      });
    }
  });

  // Find dominant level for each factor
  const dominantFactors = {};
  Object.keys(factorCounts).forEach((factor) => {
    const counts = factorCounts[factor];
    // Filter out unknown
    const knownCounts = { ...counts };
    delete knownCounts.unknown;

    const maxCount = Math.max(...Object.values(knownCounts));
    if (maxCount > 0) {
      // Get all levels with this count (in case of a tie)
      const dominantLevels = Object.keys(knownCounts).filter(
        (level) => knownCounts[level] === maxCount
      );

      // Choose the "best" level in case of a tie (for simplicity)
      const levelPriority = { high: 4, moderate: 3, low: 2, none: 1 };
      dominantLevels.sort((a, b) => levelPriority[b] - levelPriority[a]);

      dominantFactors[factor] = dominantLevels[0];
    } else {
      dominantFactors[factor] = "unknown";
    }
  });

  return dominantFactors;
}

/**
 * Generates a summary of the route's safety profile
 * @param {Object} routeSafety - Safety data for the route
 * @param {Object} options - Analysis options
 * @returns {String} - Summary explanation
 */
function generateSafetySummary(routeSafety, options) {
  const safetyPercentage = Math.round(routeSafety.overallSafety * 1000) / 10;
  const totalReviews = routeSafety.route.reduce(
    (sum, point) => sum + point.safetyData.reviewCount,
    0
  );

  let safetyLevel = "moderate";
  if (routeSafety.overallSafety >= 0.7) safetyLevel = "high";
  if (routeSafety.overallSafety < 0.4) safetyLevel = "low";

  // Get dominant factors across the route
  const dominantFactors = getDominantSafetyFactors(routeSafety.route);

  return `This route received a ${safetyLevel} safety score of ${safetyPercentage}% based on ${
    totalReviews > 0
      ? totalReviews + " reviews along the route"
      : "available safety data"
  }. The calculation weighted recent reviews more heavily (within ${
    options.recencyDays
  } days) and considered factors including ${
    dominantFactors.police_presence
  } police presence, ${dominantFactors.street_lights} street lighting, and ${
    dominantFactors.people_density
  } population density throughout most segments.`;
}

/**
 * Generates a list of key safety factors for the route
 * @param {Object} routeSafety - Safety data for the route
 * @returns {Array} - List of key factors
 */
function generateKeyFactors(routeSafety) {
  // Calculate average safety rating
  const totalSafetyScore = routeSafety.route.reduce(
    (sum, point) => sum + point.safetyData.safetyScore,
    0
  );
  const avgSafetyRating =
    Math.round((totalSafetyScore / routeSafety.route.length) * 10) / 10;

  // Count police presence levels
  const policePresenceCounts = { none: 0, low: 0, moderate: 0, high: 0 };
  routeSafety.route.forEach((point) => {
    if (
      point.safetyData &&
      point.safetyData.factors &&
      point.safetyData.factors.police_presence !== "unknown"
    ) {
      policePresenceCounts[point.safetyData.factors.police_presence]++;
    }
  });

  // Calculate percentage of route with moderate or high police presence
  const totalSegments = routeSafety.route.length;
  const moderateHighPolice =
    policePresenceCounts.moderate + policePresenceCounts.high;
  const policePresencePercentage = Math.round(
    (moderateHighPolice / totalSegments) * 100
  );

  // Determine street lighting description
  let streetLightingDesc = "Varies throughout the route";
  const urbanSegments = routeSafety.route.filter(
    (point) =>
      point.safetyData &&
      point.safetyData.factors &&
      point.safetyData.factors.people_density === "high"
  ).length;

  if (urbanSegments > totalSegments * 0.6) {
    streetLightingDesc = "High in urban segments, moderate in connecting areas";
  } else if (urbanSegments < totalSegments * 0.3) {
    streetLightingDesc = "Moderate to low throughout most of the route";
  }

  // Create key factors array
  return [
    `Average safety rating from user reviews: ${avgSafetyRating}/10`,
    `Police presence: Moderate throughout ${policePresencePercentage}% of the route`,
    `Street lighting: ${streetLightingDesc}`,
    `People density: ${getMostCommonFactor(
      routeSafety.route,
      "people_density"
    )} (providing natural surveillance)`,
    `Traffic conditions: ${getMostCommonFactor(
      routeSafety.route,
      "traffic"
    )}, with well-regulated flow`,
  ];
}

/**
 * Gets the most common value for a specific factor across the route
 * @param {Array} route - Array of route points with safety data
 * @param {String} factorName - Name of the factor to analyze
 * @returns {String} - Description of the most common factor value
 */
function getMostCommonFactor(route, factorName) {
  const counts = { none: 0, low: 0, moderate: 0, high: 0 };

  route.forEach((point) => {
    if (
      point.safetyData &&
      point.safetyData.factors &&
      point.safetyData.factors[factorName] !== "unknown"
    ) {
      counts[point.safetyData.factors[factorName]]++;
    }
  });

  let maxCount = 0;
  let mostCommon = "Moderate"; // Default

  Object.keys(counts).forEach((level) => {
    if (counts[level] > maxCount) {
      maxCount = counts[level];
      mostCommon = level.charAt(0).toUpperCase() + level.slice(1);
    }
  });

  return mostCommon;
}

/**
 * Assesses the confidence level in the safety analysis
 * @param {Object} routeSafety - Safety data for the route
 * @returns {String} - Confidence level description
 */
function generateConfidenceLevel(routeSafety) {
  const totalReviews = routeSafety.route.reduce(
    (sum, point) => sum + point.safetyData.reviewCount,
    0
  );
  const averageConfidence =
    routeSafety.route.reduce(
      (sum, point) => sum + point.safetyData.confidence,
      0
    ) / routeSafety.route.length;

  if (totalReviews === 0) {
    return "Low (no recent reviews available)";
  } else if (totalReviews < 10 || averageConfidence < 0.5) {
    return `Low to moderate (based on ${totalReviews} reviews)`;
  } else if (totalReviews < 20 || averageConfidence < 0.8) {
    return `Moderate (based on ${totalReviews} reviews)`;
  } else {
    return `High (based on ${totalReviews} recent reviews within search radius)`;
  }
}

/**
 * Determines the time of day description from a datetime
 * @param {Date} dateTime - Date object containing time information
 * @returns {String} - Time of day description (morning, afternoon, evening, night)
 */
function getTimeOfDayDescription(dateTime) {
  const hours = dateTime.getHours();

  if (hours >= 5 && hours < 12) {
    return "morning";
  } else if (hours >= 12 && hours < 17) {
    return "afternoon";
  } else if (hours >= 17 && hours < 21) {
    return "evening";
  } else {
    return "night";
  }
}

/**
 * Finds the safest route between source and destination
 * @param {Object} source - Source point with coordinates and name
 * @param {Object} destination - Destination point with coordinates and name
 * @param {Array} intermediatePoints - Array of intermediate points
 * @param {Object} options - Options for safety analysis
 * @param {Object} reviewSpatialIndex - Spatial index of pre-fetched reviews
 * @returns {Object} - Complete route safety analysis
 */
async function findSafestRoute(
  source,
  destination,
  intermediatePoints,
  options = {},
  reviewSpatialIndex
) {
  try {
    // Default options
    const defaultOptions = {
      searchRadius: 50, // Radius in meters to search for reviews around each point
      timeOfDay: null, // Current time for time-specific safety analysis
      recencyWeight: true, // Whether to weight recent reviews more heavily
      recencyDays: 90, // How recent is "recent" in days
      confidenceThreshold: 3, // Minimum number of reviews to have full confidence
    };

    // Merge default options with provided options
    const config = { ...defaultOptions, ...options };

    // Combine source, intermediate points, and destination into a complete route
    const fullRoute = [
      { ...source, type: "Source" },
      ...intermediatePoints,
      { ...destination, type: "Destination" },
    ];

    // Calculate safety scores for each point in the route using pre-fetched reviews
    const routeWithSafetyScores = await Promise.all(
      fullRoute.map(async (point, index) => {
        // Calculate safety score for this point using reviewSpatialIndex
        const safetyData = calculateSafetyScore(
          point,
          config,
          reviewSpatialIndex
        );

        // If this isn't the last point, calculate the "edge" safety to the next point
        let edgeSafety = null;
        if (index < fullRoute.length - 1) {
          const nextPoint = fullRoute[index + 1];

          // Get the distance between current point and next point
          const distance = calculateDistance(
            { lat: point.latitude, lon: point.longitude },
            { lat: nextPoint.latitude, lon: nextPoint.longitude }
          );

          edgeSafety = {
            toIndex: index + 1,
            distance: distance, // in kilometers
            // Combine both point safeties and calculate average for the segment
            // Will be calculated after we have safety scores for all points
          };
        }

        return {
          ...point,
          safetyData: safetyData,
          edgeSafety: edgeSafety,
        };
      })
    );

    // Second pass to calculate edge safety scores now that we have all point safety scores
    for (let i = 0; i < routeWithSafetyScores.length - 1; i++) {
      const currentPoint = routeWithSafetyScores[i];
      const nextPoint = routeWithSafetyScores[i + 1];

      if (currentPoint.edgeSafety) {
        // Edge safety is the average of the two endpoint safeties, weighted by confidence
        const currentConfidence = currentPoint.safetyData.confidence;
        const nextConfidence = nextPoint.safetyData.confidence;
        const totalConfidence = currentConfidence + nextConfidence;

        const weightedSafety =
          (currentPoint.safetyData.adjustedSafetyScore * currentConfidence +
            nextPoint.safetyData.adjustedSafetyScore * nextConfidence) /
          (totalConfidence > 0 ? totalConfidence : 1);

        // Update edge safety
        currentPoint.edgeSafety.safetyScore = weightedSafety;
      }
    }

    // Calculate overall route safety
    const totalDistance = routeWithSafetyScores
      .filter((point) => point.edgeSafety)
      .reduce((sum, point) => sum + point.edgeSafety.distance, 0);

    const weightedSafetySum = routeWithSafetyScores
      .filter((point) => point.edgeSafety)
      .reduce(
        (sum, point) =>
          sum + point.edgeSafety.safetyScore * point.edgeSafety.distance,
        0
      );

    const overallSafety = weightedSafetySum / totalDistance;

    // Identify any dangerous segments (safety score below 5)
    const dangerousSegments = routeWithSafetyScores
      .filter((point) => point.edgeSafety && point.edgeSafety.safetyScore < 5)
      .map((point) => ({
        fromName: point.name,
        toName: routeWithSafetyScores[point.edgeSafety.toIndex].name,
        safetyScore: point.edgeSafety.safetyScore,
        distance: point.edgeSafety.distance,
      }));

    return {
      route: routeWithSafetyScores,
      overallSafety: overallSafety,
      totalDistance: totalDistance,
      dangerousSegments: dangerousSegments,
      routeSummary: {
        safestSegments: findTopSegmentsByMetric(
          routeWithSafetyScores,
          "safetyScore",
          3,
          true
        ),
        leastSafeSegments: findTopSegmentsByMetric(
          routeWithSafetyScores,
          "safetyScore",
          3,
          false
        ),
      },
    };
  } catch (error) {
    console.error("Error finding safest route:", error);
    throw error;
  }
}

/**
 * Finds top segments by a specific metric
 * @param {Array} route - Array of route points with safety data
 * @param {String} metric - Metric to sort by
 * @param {Number} count - Number of segments to return
 * @param {Boolean} highest - Whether to find highest (true) or lowest (false)
 * @returns {Array} - Top segments by metric
 */
function findTopSegmentsByMetric(route, metric, count, highest = true) {
  // Filter for points with edge safety
  const segments = route.filter((point) => point.edgeSafety);

  // Sort by metric
  segments.sort((a, b) => {
    const aValue = a.edgeSafety[metric];
    const bValue = b.edgeSafety[metric];

    return highest ? bValue - aValue : aValue - bValue;
  });

  // Return top segments
  return segments.slice(0, count).map((point) => ({
    fromName: point.name,
    toName: route[point.edgeSafety.toIndex].name,
    value: point.edgeSafety[metric],
    distance: point.edgeSafety.distance,
  }));
}

/**
 * Calculates safety score for a specific point based on nearby reviews from spatial index
 * @param {Object} point - Point with latitude and longitude
 * @param {Object} config - Configuration options for safety calculation
 * @param {Object} reviewSpatialIndex - Spatial index with pre-fetched reviews
 * @returns {Object} - Safety data for the point
 */
function calculateSafetyScore(point, config, reviewSpatialIndex) {
  try {
    // Convert latitude and longitude to numbers
    const latitude = parseFloat(point.latitude);
    const longitude = parseFloat(point.longitude);

    // Convert search radius from meters to approximate degrees
    const searchRadiusInDegrees = config.searchRadius / 111000;

    // Use spatial index to find nearby reviews efficiently
    const nearbyReviews = reviewSpatialIndex.findNearby(
      latitude,
      longitude,
      searchRadiusInDegrees
    );

    // If no reviews found, return a default low confidence safety score
    if (nearbyReviews.length === 0) {
      return {
        safetyScore: 5, // Neutral safety score as default
        confidence: 0,
        adjustedSafetyScore: 5,
        reviewCount: 0,
        factors: {
          police_presence: "unknown",
          street_lights: "unknown",
          people_density: "unknown",
          traffic: "unknown",
        },
      };
    }

    // Calculate weighted safety score based on recency
    let totalWeight = 0;
    let weightedSafetySum = 0;

    // Prepare to count occurrences of each factor
    const factorCounts = {
      police_presence: { none: 0, low: 0, moderate: 0, high: 0 },
      street_lights: { none: 0, low: 0, moderate: 0, high: 0 },
      people_density: { none: 0, low: 0, moderate: 0, high: 0 },
      traffic: { none: 0, low: 0, moderate: 0, high: 0 },
    };

    // Process each review
    const now = new Date();
    nearbyReviews.forEach((review) => {
      // Calculate recency weight
      let weight = 1;
      if (config.recencyWeight && review.dateTime) {
        const ageInDays =
          (now - new Date(review.dateTime)) / (1000 * 60 * 60 * 24);
        if (ageInDays <= config.recencyDays) {
          // More recent reviews get higher weight, exponentially decreasing with age
          weight = Math.exp(-ageInDays / (config.recencyDays / 2));
        } else {
          weight = 0.1; // Older reviews get minimal weight
        }
      }

      // Add to weighted sum
      weightedSafetySum += review.safetyRating * weight;
      totalWeight += weight;

      // Count factors
      ["police_presence", "street_lights", "people_density", "traffic"].forEach(
        (factor) => {
          if (review[factor]) {
            factorCounts[factor][review[factor]] += 1;
          }
        }
      );
    });

    // Calculate safety score
    const safetyScore = weightedSafetySum / totalWeight;

    // Calculate confidence based on number of reviews
    const confidence = Math.min(
      1.0,
      nearbyReviews.length / config.confidenceThreshold
    );

    // Calculate adjusted safety score based on confidence
    // If confidence is low, adjust score towards neutral (5)
    const adjustedSafetyScore = safetyScore * confidence + 5 * (1 - confidence);

    // Determine dominant factor for each category
    const dominantFactors = {};
    Object.keys(factorCounts).forEach((factor) => {
      const counts = factorCounts[factor];
      const maxCount = Math.max(...Object.values(counts));

      // If there's a clear dominant factor, use it, otherwise "unknown"
      if (maxCount > 0) {
        const dominantOptions = Object.keys(counts).filter(
          (option) => counts[option] === maxCount
        );
        dominantFactors[factor] = dominantOptions[0]; // Choose first if ties
      } else {
        dominantFactors[factor] = "unknown";
      }
    });

    return {
      safetyScore: safetyScore,
      confidence: confidence,
      adjustedSafetyScore: adjustedSafetyScore,
      reviewCount: nearbyReviews.length,
      factors: dominantFactors,
    };
  } catch (error) {
    console.error("Error calculating safety score:", error);
    throw error;
  }
}

/**
 * Calculates the distance between two geographical points using the Haversine formula
 * @param {Object} point1 - First point with lat and lon properties
 * @param {Object} point2 - Second point with lat and lon properties
 * @returns {Number} - Distance in kilometers
 */
function calculateDistance(point1, point2) {
  const R = 6371; // Earth's radius in km
  const dLat = (point2.lat - point1.lat) * (Math.PI / 180);
  const dLon = (point2.lon - point1.lon) * (Math.PI / 180);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(point1.lat * (Math.PI / 180)) *
      Math.cos(point2.lat * (Math.PI / 180)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distance = R * c; // Distance in km

  return distance;
}

// Export route insertion and route safety analysis controllers
export const insertRouteReview = asyncErrorHandler(async (req, res) => {
  const {
    lat,
    lon,
    safetyRating,
    police_presence,
    street_lights,
    people_density,
    traffic,
    user_id,
  } = req.body;

  if (!lat || !lon || !safetyRating || !police_presence) {
    res.status(400);
    return res.json({
      error: "Missing required fields lat, lon, safetyRating, police_presence",
    });
  }

  const route = new Review({
    lat,
    lon,
    safetyRating,
    police_presence,
    street_lights,
    people_density,
    traffic,
    user_id,
    dateTime: new Date(), // Add current timestamp
  });

  const newRoute = await route.save();
  res.status(201).json(newRoute);
});

export const generateMockReviews = asyncErrorHandler(async (req, res) => {
  try {
    // Get parameters from request
    const {
      routesCount = 3,
      reviewsPerRouteMin = 10,
      reviewsPerRouteMax = 30,
      clearExisting = false,
      routes,
    } = req.body;

    // Clear existing reviews if requested
    if (clearExisting) {
      await Review.deleteMany({});
      console.log("Cleared existing reviews");
    }

    // Sample route coordinates (can be replaced with actual routes)

    // If provided routes count is less than 3, use first N routes
    const selectedRoutes = routes.slice(0, routesCount);

    // Safety profiles based on route index
    const safetyProfiles = [
      {
        // Route 1 - High Safety
        safetyRange: [7, 9],
        policePresence: ["moderate", "high"],
        streetLights: ["moderate", "high"],
        peopleDensity: ["moderate", "high"],
        traffic: ["low", "moderate"],
      },
      {
        // Route 2 - Low Safety
        safetyRange: [2, 5],
        policePresence: ["none", "low"],
        streetLights: ["none", "low"],
        peopleDensity: ["none", "low"],
        traffic: ["low", "high"],
      },
      {
        // Route 3 - Moderate Safety
        safetyRange: [4, 7],
        policePresence: ["low", "moderate"],
        streetLights: ["low", "moderate"],
        peopleDensity: ["low", "moderate"],
        traffic: ["moderate", "high"],
      },
    ];

    // User IDs for mock data
    const userIds = ["user123", "user456", "user789", "user101", "user202"];

    // Generate time periods (for time-based analysis)
    const timePeriods = [
      // Morning (6 AM - 11 AM)
      { name: "morning", hours: [6, 7, 8, 9, 10, 11] },
      // Afternoon (12 PM - 5 PM)
      { name: "afternoon", hours: [12, 13, 14, 15, 16, 17] },
      // Evening (6 PM - 9 PM)
      { name: "evening", hours: [18, 19, 20, 21] },
      // Night (10 PM - 5 AM)
      { name: "night", hours: [22, 23, 0, 1, 2, 3, 4, 5] },
    ];

    // Generate mock dates (for recency testing)
    const generateDate = () => {
      const now = new Date();
      const randomDays = Math.floor(Math.random() * 120); // 0 to 120 days ago
      const date = new Date(now);
      date.setDate(date.getDate() - randomDays);
      return date;
    };

    // Generate a random time based on time period
    const generateTime = (period) => {
      const date = generateDate();
      const hourIndex = Math.floor(Math.random() * period.hours.length);
      date.setHours(
        period.hours[hourIndex],
        Math.floor(Math.random() * 60),
        0,
        0
      );
      return date;
    };

    // Helper to get random element from array
    const getRandomElement = (array) => {
      return array[Math.floor(Math.random() * array.length)];
    };

    // Helper to get random number in range (inclusive)
    const getRandomInRange = (min, max) => {
      return Math.floor(Math.random() * (max - min + 1)) + min;
    };

    // Generate minor variations around a coordinate to simulate multiple reviews nearby
    const getVariedCoordinate = (coordinate) => {
      // Generate a small random offset (approximately within 10-50 meters)
      const variation = (Math.random() - 0.5) * 0.001; // Roughly 50-100m in decimal degrees
      return (parseFloat(coordinate) + variation).toFixed(6);
    };

    // Generate reviews for each route
    const allReviews = [];
    for (let routeIndex = 0; routeIndex < selectedRoutes.length; routeIndex++) {
      const route = selectedRoutes[routeIndex];
      const safetyProfile = safetyProfiles[routeIndex % safetyProfiles.length]; // Use modulo in case more routes

      // Determine how many reviews to generate for this route
      const reviewsCount = getRandomInRange(
        reviewsPerRouteMin,
        reviewsPerRouteMax
      );

      // Generate reviews per point in route
      for (let pointIndex = 0; pointIndex < route.length; pointIndex++) {
        const point = route[pointIndex];

        // Add some variation to reviews for this point based on position in route
        // For instance, unsafe route might have a safer segment or vice versa
        let pointSafetyModifier = 0;

        // Create a safety variation pattern (e.g., safe route with an unsafe segment)
        if (routeIndex === 0 && pointIndex === 2) {
          // Safe route with a moderately risky middle segment
          pointSafetyModifier = -2;
        } else if (routeIndex === 1 && pointIndex === 0) {
          // Unsafe route with a safe starting point
          pointSafetyModifier = 3;
        } else if (routeIndex === 2 && pointIndex === 3) {
          // Moderate route with an unsafe segment
          pointSafetyModifier = -2;
        }

        // Reviews per point (distribute the total reviews across points)
        const reviewsForPoint = Math.max(
          1,
          Math.floor(reviewsCount / route.length)
        );

        for (let i = 0; i < reviewsForPoint; i++) {
          // Generate time of day for this review (more reviews at night for unsafe areas)
          const timePeriodWeight = Math.random();
          let timePeriod;

          if (routeIndex === 1) {
            // Unsafe route has more night reviews
            timePeriod =
              timePeriodWeight < 0.6
                ? timePeriods[3]
                : getRandomElement(timePeriods);
          } else if (routeIndex === 0) {
            // Safe route has more day reviews
            timePeriod =
              timePeriodWeight < 0.6
                ? timePeriods[1]
                : getRandomElement(timePeriods);
          } else {
            // Moderate route has even distribution
            timePeriod = getRandomElement(timePeriods);
          }

          // Some night reviews should show lower safety levels
          const timeOfDayModifier = timePeriod.name === "night" ? -1 : 0;

          // Calculate a realistic safety rating for this review based on route and modifiers
          const [minSafety, maxSafety] = safetyProfile.safetyRange;
          let safetyRating =
            getRandomInRange(minSafety, maxSafety) +
            pointSafetyModifier +
            timeOfDayModifier;

          // Keep within 1-10 range
          safetyRating = Math.max(1, Math.min(10, safetyRating));

          // Select factors based on safety profile and rating
          const getFactorLevel = (factorOptions, safetyRating) => {
            // Higher safety ratings get better factor levels
            const threshold = safetyRating >= 6 ? 0.7 : 0.3;
            return Math.random() < threshold
              ? factorOptions[1]
              : factorOptions[0];
          };

          const review = {
            lat: getVariedCoordinate(point.latitude),
            lon: getVariedCoordinate(point.longitude),
            safetyRating: safetyRating,
            police_presence: getFactorLevel(
              safetyProfile.policePresence,
              safetyRating
            ),
            street_lights: getFactorLevel(
              safetyProfile.streetLights,
              safetyRating
            ),
            people_density: getFactorLevel(
              safetyProfile.peopleDensity,
              safetyRating
            ),
            traffic: getFactorLevel(safetyProfile.traffic, safetyRating),
            user_id: getRandomElement(userIds),
            userDateTime: generateTime(timePeriod).toISOString(),
            // Add metadata for tracking
            _meta: {
              routeIndex: routeIndex,
              pointIndex: pointIndex,
              timePeriod: timePeriod.name,
            },
          };

          allReviews.push(review);
        }
      }
    }

    // Remove _meta field before saving (as it's not in the schema)
    const reviewsToSave = allReviews.map(({ _meta, ...review }) => review);

    // Save the reviews to the database
    await Review.insertMany(reviewsToSave);

    // Generate summary statistics
    const routeStats = Array(selectedRoutes.length)
      .fill()
      .map(() => ({
        totalReviews: 0,
        avgSafetyRating: 0,
        reviewsByTimePeriod: {
          morning: 0,
          afternoon: 0,
          evening: 0,
          night: 0,
        },
      }));

    // Calculate statistics
    allReviews.forEach((review) => {
      const { routeIndex, timePeriod } = review._meta;

      routeStats[routeIndex].totalReviews++;
      routeStats[routeIndex].avgSafetyRating += review.safetyRating;
      routeStats[routeIndex].reviewsByTimePeriod[timePeriod]++;
    });

    // Finalize statistics
    routeStats.forEach((stats) => {
      if (stats.totalReviews > 0) {
        stats.avgSafetyRating = parseFloat(
          (stats.avgSafetyRating / stats.totalReviews).toFixed(2)
        );
      }
    });

    // Return summary of the generated data
    return res.status(201).json({
      success: true,
      message: `Generated ${allReviews.length} mock reviews across ${selectedRoutes.length} routes`,
      routeStats: routeStats,
      sampleReviews: allReviews.slice(0, 5), // Return first 5 reviews as samples
    });
  } catch (error) {
    console.error("Error generating mock reviews:", error);
    return res.status(500).json({
      error: "Failed to generate mock review data",
      message: error.message,
    });
  }
});

/**
 * Generate simulated route objects with additional data for testing route analyzes
 * @param {Object} req - Request object
 * @param {Object} res - Response object
 */

// Helper functions for generating safety analysis explanations
