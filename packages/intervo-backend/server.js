const express = require("express");
const dotenv = require("dotenv");
const path = require('path');

// Determine which .env file to load
const envFile = process.env.NODE_ENV === 'production'
  ? '.env.production'
  : process.env.NODE_ENV === 'staging'
    ? '.env.staging'
    : '.env.development';

console.log('Loading environment file:', envFile);
console.log('NODE_ENV:', process.env.NODE_ENV);

// Load the environment variables from the file
dotenv.config({ path: path.resolve(process.cwd(), envFile) });

const cors = require("cors");
const http = require("http");
const WebSocket = require("ws");
const twilio = require("twilio");
const mongoose = require("mongoose");
const session = require("express-session");
const RedisStore = require("connect-redis").default;
const { createClient } = require("redis");
const connectDB = require('./config/dbConfig');
const cookieParser = require('cookie-parser');
const siteDataService = require('./lib/siteDataService');

const passport = require("./config/passportConfig");

const app = express();
const port = process.env.PORT || 3003;

// const allowedOrigins = [
//   'https://intervo.ai',
//   'http://localhost:3000',
//   'http://localhost:5173',
//   'https://app.intervo.ai',
//   'https://staging-app.intervo.ai'
// ];

const allowedOrigins = ['*']

const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps, curl, postman)
    if (!origin) return callback(null, true);
    
    // For development environments
    if (process.env.NODE_ENV !== 'production') {
      return callback(null, true);
    }

    // In production, you might want to add some basic validation
    // For example, block requests from IP addresses or known malicious domains
    // But generally allow all domains since this is a chat widget
    callback(null, true);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', "PATCH"],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key'],
  exposedHeaders: ["Set-Cookie"]
}


const apiLogger = (req, res, next) => {
  const startHrTime = process.hrtime(); // Record start time

  // Capture response finish event
  res.on('finish', () => {
    const [seconds, nanoseconds] = process.hrtime(startHrTime);
    const durationInMilliseconds = (seconds * 1000 + nanoseconds / 1e6).toFixed(2);

    console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} ${res.statusCode} ${durationInMilliseconds}ms`);
  });

  // Capture response error event
  res.on('error', (err) => {
    console.error(`[${new Date().toISOString()}] ERROR ${req.method} ${req.originalUrl} - ${err.message}`);
  });

  next();
};



app.use(cors(corsOptions));
app.options('*', cors()); // Handle preflight requests
app.use(cookieParser()); // Add this line

// Use the middleware
app.use(apiLogger);

// Add this before the regular express.json middleware
// Special handling for Stripe webhooks to preserve raw body for signature verification
// // app.use('/billing/webhooks/stripe', express.raw({ type: 'application/json' }));

// Middleware
app.use(express.json({limit: '50mb'}));
app.use(express.urlencoded({limit: '50mb', extended: true}));

// Twilio credentials
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const apiKey = process.env.TWILIO_API_KEY;
const apiSecret = process.env.TWILIO_API_SECRET;
const appSid = process.env.TWILIO_APP_SID;

const redisHost = process.env.REDIS_HOST || "127.0.0.1";
const redisPort = Number(process.env.REDIS_PORT) || 6379;
const redisPassword = process.env.REDIS_PASSWORD || undefined;
const sessionTtlSeconds = Number(process.env.SESSION_TTL_SECONDS) || 60 * 60 * 24 * 7;
const sessionSameSite =
  process.env.SESSION_SAME_SITE || (process.env.NODE_ENV === "production" ? "none" : "lax");

const redisClient = createClient({
  socket: {
    host: redisHost,
    port: redisPort,
  },
  password: redisPassword,
});

redisClient.on("error", (err) => {
  console.error("Redis client error:", err);
});

redisClient.connect().catch((err) => {
  console.error("Failed to connect to Redis:", err);
});

// // Session middleware for authentication
app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    store: new RedisStore({
      client: redisClient,
      ttl: sessionTtlSeconds,
      prefix: "session:",
    }),
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production", // Set to true in production
      sameSite: sessionSameSite, // Helps handle cross-origin requests properly
      maxAge: sessionTtlSeconds * 1000,
    },
  })
);

// 
// Initialize passport and session
app.use(passport.initialize());
app.use(passport.session());

// Connect to MongoDB
connectDB();

// Call loadSettings after initial connection is likely established by connectDB()
// This might need adjustment depending on how connectDB signals readiness.
// If connectDB is synchronous or uses mongoose.connection events, this might be okay.
// Consider adding loadSettings inside connectDB if it provides a callback/promise.
siteDataService.loadSettings().catch(err => {
    console.error("Failed to load initial site settings:", err);
    // Decide if process should exit: process.exit(1);
});

// Import routers
const streamRouter = require("./routes/streamRouter");
const voiceRouter = require("./routes/voiceRouter");
const authRouter = require("./routes/authRouter");
const userRouter = require("./routes/userRouter");
const agentRouter = require("./routes/agentRouter");
const contactRouter = require("./routes/contactRouter");
const activityRouter = require("./routes/activityRouter");
const workflowRouter = require("./routes/workflowRouter");
const interactiveRouter = require("./routes/interactiveRouter");
const knowledgebaseRouter = require("./routes/knowledgebaseRouter");
// const phoneNumbersAdminRouter = require("./routes/phoneNumbersAdminRouter");
const phoneNumbersRouter = require("./routes/phoneNumbersRouter");
const getVoicesRouter = require("./routes/getVoicesRouter");
// const getVoicesAdminRouter = require("./routes/getVoicesAdminRouter");
const twilioRouter = require("./routes/twilioRouter");
const workspaceRouter = require("./routes/workspace");
const usageRouter = require("./routes/usageRouter");
// const getUsersAdminRouter = require("./routes/getUsersAdminRouter");
// const getWorkspacesAdminRouter = require("./routes/getWorkspacesAdminRouter");
// const getAgentsAdminRouter = require("./routes/getAgentsAdminRouter");
// const getActivitiesAdminRouter = require("./routes/getActivitiesAdminRouter");
// const getToolsAdminRouter = require("./routes/getToolsAdminRouter");
const toolsRouter = require("./routes/toolsRouter");
// const siteDataAdminRouter = require('./routes/siteDataAdminRouter');
// const billingRouter = require('./routes/billing');
const testRouter = require('./routes/testRouter');

// Token generation for Twilio Client
app.get("/token", (req, res) => {
  const identity = "user-" + Math.random().toString(36).substring(7);
  const accessToken = new twilio.jwt.AccessToken(accountSid, apiKey, apiSecret, { identity });
  const voiceGrant = new twilio.jwt.AccessToken.VoiceGrant({ outgoingApplicationSid: appSid });
  accessToken.addGrant(voiceGrant);

  res.send({ identity, token: accessToken.toJwt() });
});

// Status callback for call
app.post('/call-status', (req, res) => {
  console.log("Status Callback from Twilio:", req.body);
  res.sendStatus(200);
});

// Add this before the server.listen call
app.get("/health", (req, res) => {
  console.log("Health check requested");
  res.json({
    status: "Server running well",
    environment: process.env.NODE_ENV || "development",
    timestamp: new Date().toISOString()
  });
});

// Use routers
app.use("/stream", streamRouter);
app.use("/voice", voiceRouter);
app.use("/public", express.static(path.join(__dirname, "public")));
app.use("/auth", authRouter);
app.use("/user", userRouter);
app.use("/agent", agentRouter);
app.use("/contacts", contactRouter);
app.use("/activities", activityRouter);
app.use("/workflow", workflowRouter);
app.use("/knowledge-source", knowledgebaseRouter);
app.use("/workspace", workspaceRouter);
// app.use("/admin/users", getUsersAdminRouter);
// app.use("/admin/workspaces", getWorkspacesAdminRouter);
// app.use("/admin/agents", getAgentsAdminRouter);
// app.use("/admin/activities", getActivitiesAdminRouter);
// app.use('/admin/site-data', siteDataAdminRouter);
// app.use('/billing', billingRouter);
app.use('/api/test', testRouter);

//For the interactive agents
app.use("/interactive", interactiveRouter);
app.use("/phone-number", phoneNumbersRouter);
// app.use("/admin-phone-number",phoneNumbersAdminRouter);
app.use("/get-voices",getVoicesRouter);
// app.use("/get-admin-voices",getVoicesAdminRouter);
app.use("/twilio",twilioRouter);
app.use('/usage',usageRouter);
// app.use("/get-admin-tools", getToolsAdminRouter);
app.use("/get-tools", toolsRouter);



// Create shared HTTP server for both Express and WebSocket
const server = http.createServer(app);

// Import WebSocket logic from separate file
require('./streamSocket')(server);

// Start the server
server.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
