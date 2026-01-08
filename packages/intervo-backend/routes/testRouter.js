const express = require("express");
const router = express.Router();
const axios = require("axios");
const { apiLimiter } = require("../lib/rateLimitMiddleware");
const authenticateUser = require("../lib/authMiddleware");

router.use(apiLimiter);
router.use(authenticateUser);

// Test endpoint to make calls to the workflow API
router.post("/make-call", async (req, res) => {
  try {
    const {
      phoneNumber,
      firstName = "John",
      lastName = "Doe", 
      email = "john.doe@example.com",
      callType = "outbound",
      country = "United States"
    } = req.body;

    // Validate required fields
    if (!phoneNumber) {
      return res.status(400).json({
        error: "Phone number is required",
        details: "Please provide a valid phone number"
      });
    }

    // Configuration for the workflow API
    const workflowConfig = {
      url: "https://development-api.intervo.ai/workflow/be17a9ba-7402-4f96-9bbe-0be5bd238c6e",
      apiKey: "0b5f4566a2d4635377c0a0719440129bdf37385f446f815990bc81d1e6159f25"
    };

    // Prepare query parameters
    const queryParams = new URLSearchParams({
      phoneNumber: phoneNumber.trim().replace(/\s+/g, ''),
      callType,
      firstName,
      lastName,
      email,
      country
    });

    const fullUrl = `${workflowConfig.url}?${queryParams.toString()}`;
    
    console.log(`🚀 Initiating test call to: ${phoneNumber}`);
    console.log(`📞 Full URL: ${fullUrl}`);
    console.log(`🔑 Using API Key: ${workflowConfig.apiKey.substring(0, 8)}...`);

    // Make the API call to the workflow endpoint
    const response = await axios.post(fullUrl, {}, {
      headers: {
        'x-api-key': workflowConfig.apiKey,
        'Content-Type': 'application/json'
      },
      timeout: 30000 // 30 second timeout
    });

    console.log(`✅ Workflow API response:`, response.status, response.statusText);
    console.log(`📋 Response data:`, JSON.stringify(response.data, null, 2));

    // Return successful response
    res.status(200).json({
      success: true,
      message: "Call initiated successfully via workflow API",
      callSid: response.data.callSid,
      workflowResponse: response.data,
      testConfig: {
        targetPhone: phoneNumber,
        workflowUrl: workflowConfig.url,
        timestamp: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error("❌ Error in test call endpoint:", error.message);
    
    // Handle different types of errors
    if (error.response) {
      // The workflow API responded with an error
      console.error("Workflow API Error:", error.response.status, error.response.statusText);
      console.error("Error response data:", JSON.stringify(error.response.data, null, 2));
      console.error("Error response headers:", JSON.stringify(error.response.headers, null, 2));
      return res.status(error.response.status).json({
        error: "Workflow API error",
        details: error.response.data?.error || error.response.statusText,
        workflowResponse: error.response.data,
        statusCode: error.response.status,
        fullErrorDetails: error.response.data // Include full error details for debugging
      });
    } else if (error.request) {
      // Network error - no response received
      console.error("Network Error:", error.message);
      return res.status(503).json({
        error: "Network error",
        details: "Unable to reach the workflow API. Please check your connection and try again.",
        originalError: error.message
      });
    } else {
      // Other errors
      console.error("Unexpected Error:", error.message);
      return res.status(500).json({
        error: "Internal server error",
        details: error.message
      });
    }
  }
});

// Health check endpoint for the test router
router.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    message: "Test router is operational",
    endpoints: [
      "POST /api/test/make-call - Initiate a test call via workflow API"
    ]
  });
});

// Get workflow configuration (for debugging)
router.get("/config", (req, res) => {
  res.json({
    workflowEndpoint: "https://development-api.intervo.ai/workflow/be17a9ba-7402-4f96-9bbe-0be5bd238c6e",
    apiKeyPreview: "0b5f4566a2d4635377c0a0719440129bdf37385f446f815990bc81d1e6159f25".substring(0, 16) + "...",
    uniqueIdentifier: "be17a9ba-7402-4f96-9bbe-0be5bd238c6e",
    requiredParameters: [
      "phoneNumber (required)",
      "callType (optional, default: outbound)",
      "firstName (optional, default: John)",
      "lastName (optional, default: Doe)",
      "email (optional, default: john.doe@example.com)",
      "country (optional, default: United States)"
    ]
  });
});

module.exports = router; 
