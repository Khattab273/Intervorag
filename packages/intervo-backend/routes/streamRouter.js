const express = require("express");
const router = express.Router();
const VoiceResponse = require("twilio").twiml.VoiceResponse;
const twilio = require("twilio");
const PreCallAudioManager = require("../services/PreCallAudioManager");
const { v4: uuidv4 } = require("uuid");
const Agent = require("../models/Agent");
const mongoose = require("mongoose");
const { apiLimiter } = require("../lib/rateLimitMiddleware");
const authenticateUser = require("../lib/authMiddleware");
const {
  createWidgetTokenGuard,
  validateTwilioSignature,
} = require("../lib/publicAccessPolicy");

// Get the model for the published agents collection
const AgentPublishedModel = mongoose.model("AgentPublished"); // Assumes already registered

router.use(apiLimiter);

const getWidgetIdFromConfig = (req) => {
  const aiConfig = req.body?.aiConfig;
  if (!aiConfig) {
    return null;
  }

  try {
    const parsedConfig =
      typeof aiConfig === "string" ? JSON.parse(aiConfig) : aiConfig;
    return parsedConfig?.widgetId || null;
  } catch (error) {
    console.error("Failed to parse aiConfig for widget token validation:", error);
    return null;
  }
};

const requireWidgetToken = createWidgetTokenGuard(getWidgetIdFromConfig);

const requireUserOrWidgetToken = (req, res, next) => {
  if (req.cookies?.authToken) {
    return authenticateUser(req, res, next);
  }

  return requireWidgetToken(req, res, next);
};

let client;
if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
  try {
    client = twilio(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
    );
  } catch (error) {
    console.error("Error creating Twilio client:", error);
  }
}

// This gets called from both playground and from a real-time call
router.post("/prepare", requireUserOrWidgetToken, async (req, res) => {
  return res.json({ success: true, message: "Prepare route is deprecated" });
  try {
    let aiConfig = {};
    if (req.body?.aiConfig) {
      aiConfig = JSON.parse(req.body?.aiConfig);
    }

    const { agentId, widgetId } = aiConfig;

    // Fetch the PUBLISHED agent configuration
    let publishedAgent;
    if (agentId) {
      // Prefer fetching by specific published agent ID if provided
      publishedAgent = await Agent.findById(agentId);
      console.log(`Prepare route: Found DRAFT agent by ID: ${agentId}`);
    } else if (widgetId) {
      // Fallback to finding by widgetId in the published collection
      console.log(
        "Prepare route: No agentId, finding published agent by widgetId:",
        widgetId
      );
      publishedAgent = await AgentPublishedModel.findOne({
        widgetId: widgetId,
      });
    }

    if (!publishedAgent) {
      const message = agentId
        ? `Published agent with ID ${agentId} not found.`
        : `Published agent with widget ID ${widgetId} not found.`;
      console.error("Error in /prepare:", message);
      return res.status(404).json({ success: false, message });
    }

    //get all the values from the agent
    const { name, ttsSettings, prompt, introduction } = publishedAgent;
    console.log(
      introduction,
      ttsSettings.service,
      prompt,
      agentId,
      "leadprompt"
    );
    if (introduction) {
      const audioParts = await PreCallAudioManager.prepareAudio({
        introduction,
        ttsService: ttsSettings.service,
        leadPrompt: prompt,
      });
      const conversationId = audioParts.metadata?.conversationId;
      console.log("Audio prepared successfully", conversationId);
      res.json({ success: true, conversationId });
    } else {
      res.json({ success: true, message: "No introduction to prepare" });
    }
  } catch (error) {
    console.error("Error preparing audio:", error);
    res.status(500).json({ error: error.message });
  }
});

//This endpoint gets called from the playground and also from a real-time call
router.post("/", validateTwilioSignature, async (req, res) => {
  console.log("Twilio voice request received (stream)");
  /*
     aiConfig: '{"sttService":"google","aiEndpoint":"gpt4","ttsService":"google","voiceType":"adam","leadPrompt":"I want to collection information about the business nature of our users.","introduction":"Hey there! Thanks for getting in touch with CodeDesign.ai. How can we be of assistance."}',
10|twilio  |   AccountSid: 'AC858b3998c6cc9215e68da2f3add3d0fa'
10|twilio  | }

*/

  let aiConfig = {};
  if (req.body?.aiConfig) {
    aiConfig =
      typeof req.body.aiConfig === "string"
        ? JSON.parse(req.body.aiConfig)
        : req.body.aiConfig;
  }

  //Step 1: get the param from aiConfig
  const { playground, widgetId, contactId, source, conversationId } = aiConfig;


  console.log(aiConfig, "aiConfig");
  let { agentId } = aiConfig;

  // Fetch the PUBLISHED agent configuration
  let publishedAgentStream;
  if (agentId) {
    // Prefer fetching by specific published agent ID if provided
    publishedAgentStream = await Agent.findById(agentId);
    console.log(`Stream route: Found DRAFT agent by ID: ${agentId}`);
  } else if (widgetId) {
    // Fallback to finding by widgetId in the published collection
    console.log(
      "Stream route: No agentId, finding published agent by widgetId:",
      widgetId
    );
    publishedAgentStream = await AgentPublishedModel.findOne({
      widgetId: widgetId,
    });
    if (publishedAgentStream) {
      agentId = publishedAgentStream._id?.toString(); // Use the ID of the found PUBLISHED agent
    }
  }

  if (!publishedAgentStream) {
    const message = agentId
      ? `Published agent with ID ${agentId} not found.`
      : `Published agent with widget ID ${widgetId} not found.`;
    console.error("Error in /:", message);
    // Return TwiML error response if possible, or just log and fail
    const twiml = new VoiceResponse();
    twiml.say("Sorry, the requested agent configuration could not be found.");
    twiml.hangup();
    res.type("text/xml");
    return res.status(404).send(twiml.toString());
  }

  // Use the fetched published agent data from here onwards
  const agent = publishedAgentStream;

  const transformedConfig = {
    leadPrompt: agent.prompt,
    sttService: agent.sttSettings.service,
    ttsService: agent.ttsSettings.service,
    introduction: agent.introduction,
    phoneNumber: agent.phoneNumber, // Assuming phoneNumber is stored in the agent model
    activityId: agent.activityId, // Assuming activityId is stored in the agent model
  };

  const {
    phoneNumber,
    leadPrompt,
    introduction,
    sttService,
    aiEndpoint,
    ttsService,
    activityId,
  } = transformedConfig;

  const serverDomain = process.env.BASE_URL;

  console.log(phoneNumber, "phoneNumbera");
  // If no phone number, return TwiML for WebRTC client
  if (true) {
    const twiml = new VoiceResponse();
    const connect = twiml.connect();
    const stream = connect.stream({
      url: `wss://${serverDomain}`,
      statusCallback: `https://${serverDomain}/stream/stream-status-internal`,
      statusCallbackMethod: "POST",
    });

    // Step 2: Add Parameters to the stream
    stream.parameter({ name: "stt-service", value: sttService });
    stream.parameter({ name: "ai-endpoint", value: aiEndpoint });
    stream.parameter({ name: "tts-service", value: ttsService });
    stream.parameter({ name: "lead-prompt", value: leadPrompt });
    stream.parameter({ name: "introduction", value: introduction });
    stream.parameter({ name: "agent-id", value: agentId });
    stream.parameter({ name: "activity-id", value: activityId });
    stream.parameter({ name: "contact-id", value: contactId });
    stream.parameter({ name: "source", value: source });
    stream.parameter({ name: "conversation-id", value: conversationId });
    twiml.pause({ length: 15 });

    res.type("text/xml");
    return res.send(twiml.toString());
  }

  // If phone number exists, make outbound call
  try {
    const call = await client.calls.create({
      to: phoneNumber,
      from: process.env.TWILIO_PHONE_NUMBER,
      twiml: `
        <Response>
          <Say>Welcome!</Say>
          <Connect>
            <Stream url="wss://${serverDomain}">
              <Parameter name="stt-service" value="${encodeURIComponent(
                sttService
              )}"/>
              <Parameter name="ai-endpoint" value="${encodeURIComponent(
                aiEndpoint
              )}"/>
              <Parameter name="tts-service" value="${encodeURIComponent(
                ttsService
              )}"/>
              <Parameter name="voice-type" value="${encodeURIComponent(
                voiceType
              )}"/>
              <Parameter name="lead-prompt" value="${encodeURIComponent(
                leadPrompt
              )}"/>
              <Parameter name="introduction" value="${encodeURIComponent(
                introduction
              )}"/>
              <Parameter name="agent-id" value="${encodeURIComponent(
                agentId
              )}"/>
              <Parameter name="activity-id" value="${encodeURIComponent(
                activityId
              )}"/>
            </Stream>
          </Connect>
          <Pause length="10"/>
        </Response>
      `,
      statusCallback: `https://${serverDomain}/stream-status`,
      statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
    });

    res.json({ success: true, callSid: call.sid });
  } catch (error) {
    console.error("Error initiating call:", error);
    res.status(500).json({ error: error.message });
  }
});

router.post("/stream-status", validateTwilioSignature, (req, res) => {
  const status = req.body.StreamStatus;
  const track = req.body.Track;

  if (status === "failed") {
    console.error("WebSocket stream failed to establish.");
  }

  res.sendStatus(200);
});

router.post("/stream-status-internal", validateTwilioSignature, (req, res) => {
  res.sendStatus(200);
});

module.exports = router;
