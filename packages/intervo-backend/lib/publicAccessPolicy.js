const jwt = require("jsonwebtoken");
const twilio = require("twilio");

const JWT_SECRET = process.env.NEXTAUTH_SECRET;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;

const getRequestUrl = (req) => {
  const protocolHeader = req.headers["x-forwarded-proto"];
  const hostHeader = req.headers["x-forwarded-host"] || req.get("host");
  const protocol = protocolHeader ? protocolHeader.split(",")[0].trim() : req.protocol;
  const host = hostHeader ? hostHeader.split(",")[0].trim() : req.get("host");
  return `${protocol}://${host}${req.originalUrl}`;
};

const validateTwilioSignature = (req, res, next) => {
  if (!TWILIO_AUTH_TOKEN) {
    return res.status(500).json({ error: "Twilio auth token not configured" });
  }

  const signature = req.headers["x-twilio-signature"];
  if (!signature) {
    return res.status(403).json({ error: "Missing Twilio signature" });
  }

  const url = getRequestUrl(req);
  const params = req.body || {};
  const isValid = twilio.validateRequest(TWILIO_AUTH_TOKEN, signature, url, params);

  if (!isValid) {
    return res.status(403).json({ error: "Invalid Twilio signature" });
  }

  return next();
};

const extractWidgetToken = (req) => {
  const authHeader = req.get("authorization");
  if (authHeader && authHeader.startsWith("Bearer ")) {
    return authHeader.slice("Bearer ".length).trim();
  }

  return req.get("x-widget-token");
};

const createWidgetTokenGuard = (getExpectedWidgetId) => (req, res, next) => {
  if (!JWT_SECRET) {
    return res.status(500).json({ error: "JWT secret not configured" });
  }

  const token = extractWidgetToken(req);
  if (!token) {
    return res.status(401).json({ error: "Widget token required" });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const expectedWidgetId = getExpectedWidgetId(req);

    if (!payload.widgetId || !expectedWidgetId || payload.widgetId !== expectedWidgetId) {
      return res.status(403).json({ error: "Widget token does not match widget" });
    }

    if (payload.purpose && !["widget", "websocket"].includes(payload.purpose)) {
      return res.status(403).json({ error: "Widget token purpose not allowed" });
    }

    req.widget = payload;
    return next();
  } catch (error) {
    console.error("Widget token validation failed:", error);
    return res.status(401).json({ error: "Invalid widget token" });
  }
};

module.exports = {
  createWidgetTokenGuard,
  validateTwilioSignature,
};
