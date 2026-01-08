const express = require("express");
const router = express.Router();
const Tool = require("../models/Tool");
const authenticateUser = require("../lib/authMiddleware");
const { apiLimiter } = require("../lib/rateLimitMiddleware");

router.use(apiLimiter);
router.use(authenticateUser);

router.get("/", async (req, res) => {
  try {
    const tools = await Tool.find({});
    res.json({
      success: true,
      tools,
    });
  } catch (error) {
    console.error(`Error fetching tools`, error);
    res.status(500).json({ error: `Failed to fetch tools` });
  }
});

module.exports = router;
