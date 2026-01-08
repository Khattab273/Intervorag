const express = require("express");
const router = express.Router();
const Voice = require("../models/Voice");
const authenticateUser = require("../lib/authMiddleware");
const { apiLimiter } = require("../lib/rateLimitMiddleware");
const fetchElevenLabsVoices = require("../services/fetchVoices/fetchElevenLabsVoices");
const fetchAzureVoices = require("../services/fetchVoices/fetchAzureVoices");
const fetchGoogleVoices = require("../services/fetchVoices/fetchGoogleVoices");
const fetchAWSVoices = require("../services/fetchVoices/fetchAWSVoices");

router.use(apiLimiter);
router.use(authenticateUser);

/**
 * GET /voices
 * Fetch all curated voices from the database
 * Query parameters: language, gender, premium (optional filters)
 */
router.get("/", async (req, res) => {
  try {
    const { language='', gender='', premium } = req.query;

    // Build query object dynamically based on provided filters
    const query = {};
    if (language) query.language = language;
    if (gender) query.gender = gender;
    if (premium !== undefined) query.premium = premium === "true";

    // Fetch voices from the database based on query
    const voices = await Voice.find(query);

    res.json({
      success: true,
      voices,
    });
  } catch (error) {
    console.error("Error fetching voices:", error);
    res.status(500).json({ error: "Failed to fetch voices" });
  }
});

/**
 * GET /voices/service/:service
 * Fetch voices from a specific service with pagination and filtering
 * Query parameters: offset, limit, language, gender, accent, category, age, search, use_cases
 */
router.get("/service/:service", async (req, res) => {
  try {
    const { service } = req.params;
    const voicesFromDb = await Voice.find({service: service});
    const { 
      offset = 0, 
      limit = 10,
      language,
      gender,
      accent,
      category = 'professional',
      age,
      search,
      use_cases = 'conversational'
    } = req.query; // Extract filter parameters

    // Store custom voices from database
    const data = [...voicesFromDb];
    let voices = [];
    let errorMessage = null;
    let totalCount = 0;

    // Create a filters object to pass to fetching functions
    const filters = {
      language,
      gender,
      accent,
      category,
      age,
      search,
      use_cases
    };

    try {
      switch (service) {
        case "azure":
          const azureResult = await fetchAzureVoices(
            Number(offset), 
            Number(limit), 
            filters
          );
          voices = azureResult.voices;
          totalCount = azureResult.totalCount;
          break;
        case "elevenlabs":
          voices = await fetchElevenLabsVoices(Number(offset), Number(limit), filters);
          totalCount = voices.length; // ElevenLabs doesn't provide total count
          break;
        case "google":
          voices = await fetchGoogleVoices();
          
          // Apply client-side filtering
          if (gender || accent) {
            voices = voices.filter(voice => {
              let match = true;
              if (gender) match = match && voice.gender.toLowerCase() === gender.toLowerCase();
              if (accent) match = match && (!voice.accent || voice.accent.toLowerCase().includes(accent.toLowerCase()));
              return match;
            });
          }
          
          totalCount = voices.length;
          voices = voices.slice(Number(offset), Number(offset) + Number(limit));
          break;
        case "aws":
          voices = await fetchAWSVoices();
          
          // Apply client-side filtering
          if (gender || accent) {
            voices = voices.filter(voice => {
              let match = true;
              if (gender) match = match && voice.gender.toLowerCase() === gender.toLowerCase();
              if (accent) match = match && (!voice.accent || voice.accent.toLowerCase().includes(accent.toLowerCase()));
              return match;
            });
          }
          
          totalCount = voices.length;
          voices = voices.slice(Number(offset), Number(offset) + Number(limit));
          break;
        default:
          return res.status(400).json({ error: `Unsupported service: ${service}` });
      }
    } catch (serviceError) {
      console.error(`Error fetching voices from ${service} API:`, serviceError);
      errorMessage = `Warning: Unable to fetch all ${service} voices. Showing available voices only.`;
      voices = [];
    }

    // Add pagination info to response
    const response = { 
      success: true, 
      service,
      count: totalCount + data.length,
      offset: Number(offset),
      limit: Number(limit),
      voices: [...data, ...voices]
    };

    if (errorMessage) {
      response.warning = errorMessage;
    }

    res.json(response);
  } catch (error) {
    console.error(`Error in voice service endpoint for ${req.params.service}:`, error);
    res.status(500).json({ error: `Failed to fetch voices for ${req.params.service}` });
  }
});

/**
 * GET /voices/:id
 * Fetch details of a specific voice by its ID
 */
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const voice = await Voice.findById(id);

    if (!voice) {
      return res.status(404).json({ error: "Voice not found" });
    }

    res.json({
      success: true,
      voice,
    });
  } catch (error) {
    console.error("Error fetching voice details:", error);
    res.status(500).json({ error: "Failed to fetch voice details" });
  }
});

module.exports = router;
