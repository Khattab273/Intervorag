const rateLimit = require('express-rate-limit');

// Generic rate limiter for public API endpoints
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 300, // Limit each IP to 300 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many requests, please try again later.' }
});

// More strict rate limiter for authentication endpoints
const authLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 15, // Limit each IP to 5 requests per windowMs
  standardHeaders: true,
  message: { message: 'Too many authentication attempts, please try again later.' }
});

// Specific rate limiter for magic link endpoints
const magicLinkLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5, // Limit each IP to 3 magic link requests per hour
  standardHeaders: true,
  message: { message: 'Too many magic link requests, please try again later.' },
  keyGenerator: (req) => {
    // Use email as the rate limit key if available, otherwise use IP
    return req.body.email || req.ip;
  }
});

module.exports = {
  apiLimiter,
  authLimiter,
  magicLinkLimiter
}; 
