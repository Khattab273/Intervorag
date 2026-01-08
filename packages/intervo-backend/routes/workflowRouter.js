const express = require("express");
const router = express.Router();
const axios = require("axios");
const { v4: uuidv4 } = require('uuid');
const Agent = require("../models/Agent");
const Contact = require("../models/Contact");
const Activity = require("../models/Activity");
const ConversationState=require("../models/ConversationState");
const Workspace = require('../models/Workspace');
const PhoneNumber = require('../models/PhoneNumber');
const { apiLimiter } = require("../lib/rateLimitMiddleware");
const mongoose = require('mongoose');
const { verifyAgentWorkspace } = require("../lib/checkOwnership");
const { createWidgetTokenGuard } = require("../lib/publicAccessPolicy");

router.use(apiLimiter);

// Middleware to authenticate using apiKey from headers and uniqueIdentifier from the URL
const authenticateApiKeyAndIdentifier = async (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  const { uniqueIdentifier } = req.params;

  console.log(`🔐 Authenticating: uniqueIdentifier=${uniqueIdentifier}, apiKey=${apiKey?.substring(0, 8)}...`);

  if (!apiKey) {
    console.log("❌ No API key provided");
    return res.status(401).json({ error: "API key is required" });
  }

  try {
    // Find an agent with the matching apiKey and uniqueIdentifier
    console.log(`🔍 Looking for agent with apiKey and uniqueIdentifier...`);
    const agent = await Agent.findOne({ apiKey, uniqueIdentifier });

    if (!agent) {
      console.log("❌ No agent found with provided credentials");
      return res.status(401).json({ error: "Invalid API key or unique identifier" });
    }

    console.log(`✅ Agent found: ${agent.name} (${agent._id})`);
    // Attach the agent to the request object for further use
    req.agent = agent;
    next();
  } catch (error) {
    console.error("❌ Error during authentication:", error);
    res.status(500).json({ error: "Internal server error", details: error.message });
  }
};

// Route to handle call data and update contacts/activities using query parameters
router.post("/:uniqueIdentifier", authenticateApiKeyAndIdentifier, async (req, res) => {
  try {
    console.log(`🚀 Starting workflow request for uniqueIdentifier: ${req.params.uniqueIdentifier}`);
    console.log(`📋 Query params:`, req.query);
    
    const { uniqueIdentifier } = req.params;
    const {
        phoneNumber: rawPhoneNumber,
        callType,
        firstName = "John",
        lastName = "Caller",
        email,
        country = "Unknown"
      } = req.query; // Extract data from query parameters

    // Clean the phone number by removing all spaces
    const phoneNumber = rawPhoneNumber ? rawPhoneNumber.trim().replace(/\s+/g, '') : null;

    console.log(`📞 Processing call request: ${phoneNumber} (${firstName} ${lastName})`);

    if (!phoneNumber || !callType) {
      console.log("❌ Missing required parameters");
      return res.status(400).json({ error: "Phone number and call type are required" });
    }

    console.log(`👤 Finding/creating contact for: ${phoneNumber}`);
    // Find or create a contact using the phone number
    let contact = await Contact.findOne({ phoneNumber });
    if (!contact) {
      contact = new Contact({
        phoneNumber,
        firstName,
        lastName,
        email,
        country,
        agent: req.agent._id,
        user: req.agent.user,
      });
      await contact.save();
      console.log(`✅ Created new contact: ${contact._id}`);
    } else {
      console.log(`✅ Found existing contact: ${contact._id}`);
    }

    console.log(`💬 Creating conversation state...`);
    // Create a new conversation state with a unique conversationId
    const conversationId = uuidv4();
    const newConversationState = new ConversationState({
      conversationId,
      memory: {
        entities: {
          fields: new Map(),
          required: new Map(),
          collected: new Map()
        },
        context: new Map(),
        preferences: new Map()
      }
    });

    await newConversationState.save();
    console.log(`✅ Created conversation state: ${conversationId}`);

    console.log(`📊 Creating activity record...`);
    // Create a new activity record
    const newActivity = new Activity({
      user: req.agent.user,
      agent: req.agent._id,
      contact: contact._id,
      callType: callType === 'outbound' ? 'outgoing' : callType === 'inbound' ? 'incoming' : 'outgoing', // Map outbound to outgoing
      conversationId,
      conversationTranscription: [],
      status: 'in-progress',
      createdAt: new Date(),
      conversationMode: 'call', // Required field - this is a phone call
      source: 'api', // Required field - called via workflow API
      workspace: req.agent.workspace, // Add workspace if available
    });

    await newActivity.save();
    console.log(`✅ Created activity: ${newActivity._id}`);

    console.log(`⚙️ Preparing call configuration...`);
    // Prepare the config for the call
    const config = {
      sttService: req.agent.sttSettings?.service || 'Google Speech-to-Text',
      aiEndpoint: "gpt4", 
      ttsService: req.agent.ttsSettings?.service || 'Google Text-to-Speech',
      voiceType: "adam", 
      leadPrompt: req.agent.prompt || "I want to collect information about the business nature of our users.",
      introduction: req.agent.introduction || `Hello ${firstName} ${lastName}, this is an automated call from ${req.agent.name}.`,
      conversationId,
      activityId: newActivity._id.toString(),
      agentId: req.agent._id.toString(),
      contactId: contact._id.toString(),
      source: "api"
    };

    console.log(`📞 Initializing Twilio client...`);
    // Get Twilio credentials from workspace and phone number from PhoneNumber model
    
    console.log(`🏢 Fetching workspace: ${req.agent.workspace}`);
    const workspace = await Workspace.findById(req.agent.workspace);
    if (!workspace) {
      console.error("❌ Workspace not found");
      return res.status(500).json({ 
        error: "Configuration error", 
        details: "Agent workspace not found"
      });
    }
    
    console.log(`🔐 Getting Twilio credentials from workspace...`);
    const twilioAccountSid = workspace.twilioSID; // This will be decrypted automatically by the getter
    const twilioAuthToken = workspace.apiKey; // This will be decrypted automatically by the getter
    
    if (!twilioAccountSid || !twilioAuthToken) {
      console.error("❌ Missing Twilio credentials in workspace");
      console.error("twilioSID exists:", !!workspace.twilioSID);
      console.error("apiKey exists:", !!workspace.apiKey);
      
      return res.status(500).json({ 
        error: "Configuration error", 
        details: "Twilio credentials not configured in workspace. Please configure Twilio SID and API Key in your workspace settings."
      });
    }
    
    console.log(`📱 Finding phone number for agent: ${req.agent._id}`);
    const phoneNumberRecord = await PhoneNumber.findOne({ agent: req.agent._id });
    if (!phoneNumberRecord) {
      console.error("❌ No phone number assigned to agent");
      return res.status(500).json({ 
        error: "Configuration error", 
        details: "No phone number assigned to this agent. Please assign a phone number to the agent."
      });
    }
    
    const twilioPhoneNumber = phoneNumberRecord.phoneNumber;
    console.log(`✅ Found phone number: ${twilioPhoneNumber}`);
    
    // Create Twilio client with workspace credentials
    const twilio = require('twilio');
    const client = twilio(twilioAccountSid, twilioAuthToken);
    
    console.log(`✅ Twilio client initialized with workspace credentials`);

    const serverDomain = process.env.BASE_URL;
    console.log(`🌐 Server domain: ${serverDomain}`);

    console.log(`📱 Initiating Twilio call...`);
    // Initiate the outbound call using Twilio
    try {
      const call = await client.calls.create({
        to: phoneNumber,
        from: twilioPhoneNumber, // Use the phone number assigned to the agent
        twiml: `
          <Response>
            <Connect>
              <Stream url="wss://${serverDomain}" statusCallback="https://${serverDomain}/stream/stream-status-internal" statusCallbackMethod="POST">
                <Parameter name="stt-service" value="${encodeURIComponent(config.sttService)}"/>
                <Parameter name="ai-endpoint" value="${encodeURIComponent(config.aiEndpoint)}"/>
                <Parameter name="tts-service" value="${encodeURIComponent(config.ttsService)}"/>
                <Parameter name="voice-type" value="${encodeURIComponent(config.voiceType)}"/>
                <Parameter name="lead-prompt" value="${encodeURIComponent(config.leadPrompt)}"/>
                <Parameter name="introduction" value="${encodeURIComponent(config.introduction)}"/>
                <Parameter name="agent-id" value="${encodeURIComponent(config.agentId)}"/>
                <Parameter name="activity-id" value="${encodeURIComponent(config.activityId)}"/>
                <Parameter name="contact-id" value="${encodeURIComponent(config.contactId)}"/>
                <Parameter name="source" value="${encodeURIComponent(config.source)}"/>
                <Parameter name="conversation-id" value="${encodeURIComponent(config.conversationId)}"/>
              </Stream>
            </Connect>
            <Pause length="15"/>
          </Response>
        `,
        statusCallback: `https://${serverDomain}/stream-status`,
        statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
      });

      console.log("Outbound call initiated successfully:", call.sid);

      res.status(201).json({
        success: true,
        message: "Call initiated successfully",
        callSid: call.sid,
        contact,
        activity: newActivity,
        conversationState: newConversationState,
      });

    } catch (callError) {
      console.error("❌ Error initiating outbound call:", callError);
      console.error("Twilio error details:", callError.message);
      console.error("Twilio error code:", callError.code);
      
      // Update activity status to failed
      await Activity.findByIdAndUpdate(newActivity._id, { status: 'failed' });
      
      res.status(500).json({ 
        error: "Failed to initiate call", 
        details: callError.message,
        twilioError: callError.code,
        contact,
        activity: newActivity
      });
    }

  } catch (error) {
    console.error("❌ Error processing workflow request:", error);
    console.error("Error stack:", error.stack);
    res.status(500).json({ 
      error: "Failed to process the request", 
      details: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// ============= Widget Endpoints =============
/**
 * Widget related endpoints for handling widget-specific functionality
 * Base path: /widget/:widgetId
 * 
 * Core Widget Operations:
 * - POST    /              - Create widget
 * - GET     /              - Get widget details
 * - PUT     /              - Update widget
 * - DELETE  /              - Delete widget
 * 
 * Widget Communication:
 * - POST    /start-call    - Initiate a call
 * - POST    /start-message - Start messaging session
 * 
 * Widget Contact Management:
 * - GET     /contact       - Get widget contact
 * - POST    /contact       - Create/Update contact
 */

// Create a widget router to handle all widget-specific routes
const widgetRouter = express.Router({ mergeParams: true });
const requireWidgetToken = createWidgetTokenGuard((req) => req.params.widgetId);
router.use('/widget/:widgetId', widgetRouter);
widgetRouter.use(requireWidgetToken);

//Create a widget contact
widgetRouter.post("/contact", async (req, res) => {
  try {
    const { widgetId } = req.params;
    const AgentPublishedModel = mongoose.model('AgentPublished'); // Get published model
    
    // Find the agent first to get the workspace
    console.log(`Widget contact route: Finding published agent by widgetId: ${widgetId}`);
    const agent = await AgentPublishedModel.findOne({ widgetId: widgetId });
    if (!agent) {
      return res.status(404).json({ error: "Agent not found" });
    }

    const { fullName, email, phoneNumber, countryCode } = req.body;

    if (!fullName || !email || !phoneNumber || !countryCode) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Split full name into first and last name
    const nameParts = fullName.trim().split(/\s+/);
    const firstName = nameParts[0];
    const lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : '';

    // Check if contact exists for this specific agent (not entire workspace)
    let contact = await Contact.findOne({
      $and: [
        { agent: agent._id }, // Check only within this agent's scope
        { $or: [
          { email: email },
          { phoneNumber: phoneNumber }
        ]}
      ]
    });

    if (contact) {
      // Update existing contact with any missing fields
      const updates = {
        firstName: contact.firstName || firstName,
        lastName: contact.lastName || lastName,
        email: contact.email || email,
        phoneNumber: contact.phoneNumber || phoneNumber,
        countryCode: contact.countryCode || countryCode,
        agent: agent._id // Update the last interacting agent
      };

      contact = await Contact.findByIdAndUpdate(
        contact._id,
        { $set: updates },
        { new: true }
      );
    } else {
      // Create new contact with workspace
      contact = new Contact({
        firstName,
        lastName,
        email,
        phoneNumber,
        countryCode,
        agent: agent._id,
        user: agent.user,
        workspace: agent.workspace // Added workspace field
      });
      await contact.save();
    }

    res.status(201).json(contact);
  } catch (error) {
    console.error("Contact creation error:", error);
    res.status(500).json({ 
      error: "Failed to create/update contact", 
      details: error.message 
    });
  }
});

// Get widget configuration (agent name and type)
widgetRouter.get("/config", async (req, res) => {
  try {
    const { widgetId } = req.params;
    const AgentPublishedModel = mongoose.model('AgentPublished'); // Get published model

    if (!widgetId) {
      return res.status(400).json({ error: "Widget ID is required" });
    }

    // Find the published agent by widgetId, selecting only necessary fields
    console.log(`Widget config route: Finding published agent by widgetId: ${widgetId}`);
    const agent = await AgentPublishedModel.findOne(
      { widgetId: widgetId },
      'name agentType widgetConfiguration' // Select name, agentType, and widgetConfiguration fields
    );

    if (!agent) {
      // Use 404 Not Found if the widget ID doesn't correspond to a published agent
      return res.status(404).json({ error: "Published agent configuration not found for this widget ID" });
    }

    // Return the selected fields
    res.status(200).json({
      agentName: agent.name,
      agentType: agent.agentType,
      widgetConfiguration: agent.widgetConfiguration
    });

  } catch (error) {
    console.error("Error fetching widget config:", error);
    res.status(500).json({
      error: "Failed to fetch widget configuration",
      details: error.message
    });
  }
});

// Add this endpoint within the widgetRouter section
widgetRouter.get("/call-summary", async (req, res) => {
  let userId = null; // Initialize userId to null

  try {
    // 1. Attempt non-intrusive user identification (e.g., JWT from header)
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.split(' ')[1];
      try {
        // Assuming you have a JWT verification function (replace with your actual implementation)
        // const decoded = jwt.verify(token, process.env.JWT_SECRET); 
        // Example: Replace jwt.verify and User.findById with your actual verification logic
        const decoded = await yourVerifyTokenFunction(token); // Replace with your token verification logic
        if (decoded && decoded.userId) {
             // Optionally find the user if needed, or just use the ID
             // const user = await User.findById(decoded.userId);
             // if (user) { req.user = user; } // Attach full user if needed
             userId = decoded.userId; // Set userId if verification is successful
             console.log(`Authenticated user ID: ${userId}`);
        }
      } catch (jwtError) {
        // Token is invalid or expired, proceed without userId
        console.log("Optional authentication failed:", jwtError.message); 
      }
    } else {
        console.log("No authorization token found, proceeding without user identification.");
    }

    // Proceed with the rest of the logic
    const { widgetId } = req.params;
    // Use the 'userId' obtained above (which might be null) if needed
    const { activityId, agentId } = req.query; 

    // 2. Agent Verification Logic (uses the potentially null userId)
    const AgentPublishedModel = mongoose.model('AgentPublished');
    let agent = await AgentPublishedModel.findOne({ widgetId });

    // Only try workspace verification if we couldn't find by widget AND we successfully got a userId
    if (!agent && agentId && userId) { 
        console.log(`Widget agent not found, attempting workspace verification for agent ${agentId} and user ${userId}`);
        // Ensure verifyAgentWorkspace can handle a null userId if necessary, or keep this check
        agent = await verifyAgentWorkspace(agentId, userId); 
    } else if (!agent && agentId && !userId) {
        console.log(`Widget agent not found, cannot verify workspace access without userId.`);
    }

    // If both methods fail, return 404
    if (!agent) {
      return res.status(404).json({ error: "Agent not found or unauthorized access" });
    }

    // 3. Activity Fetching Logic (remains the same)
    const getActivityWithRetries = async (retries = 2, delay = 3000) => {
      const activity = await Activity.findById(activityId);
      
      // Check if activity exists AND has a conversation summary
      if (activity && activity.conversationSummary) { 
        return activity;
      }
      
      if (retries > 0) {
        console.log(`Activity summary not found for ${activityId}, retrying in ${delay}ms... (${retries} retries left)`);
        await new Promise(resolve => setTimeout(resolve, delay));
        return getActivityWithRetries(retries - 1, delay);
      }
      
      // Return the activity even if summary is missing after retries, 
      // or null if activity itself wasn't found initially
      return activity; 
    };

    const activity = await getActivityWithRetries();
    
    // Check if activity was found at all
    if (!activity) {
      return res.status(404).json({ error: "Activity not found" });
    }

    // Check specifically if the summary is still missing after retries
    if (!activity.conversationSummary) {
        console.warn(`Activity ${activityId} found, but summary is missing after retries.`);
        // Decide how to handle this - maybe return partial data or a specific status
        // For now, let's return the available data but indicate summary is missing
        return res.status(202).json({ // 202 Accepted might indicate processing is ongoing
            message: "Activity found, but summary generation is still pending.",
            status: activity.status,
            duration: activity.callDuration
            // Avoid returning null/undefined summaries if the frontend expects an object
            // summary: null, 
            // singleLineSummary: null 
        });
    }

    // If summary exists, return full data
    return res.json({
      summary: activity.conversationSummary,
      singleLineSummary: activity.singleLineSummary,
      status: activity.status,
      duration: activity.callDuration
    });

  } catch (error) {
    console.error("Error fetching call summary:", error);
    // Avoid exposing internal errors directly unless needed for debugging
    res.status(500).json({ error: "Failed to fetch call summary" }); 
  }
});

module.exports = router;
