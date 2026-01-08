const express = require("express");
const router = express.Router();
const Agent = require("../models/Agent");
const Voice = require("../models/Voice");
const Tool = require("../models/Tool");
const { v4: uuidv4 } = require("uuid");
const authenticateUser = require("../lib/authMiddleware");
const { apiLimiter } = require("../lib/rateLimitMiddleware");
const User = require("../models/User");
const PhoneNumber = require("../models/PhoneNumber");
const { verifyAgentWorkspace } = require("../lib/checkOwnership");
const geminiService = require("../services/geminiService");
const axios = require('axios');
const KnowledgeSource = require("../models/KnowledgeSource");
const fetch = require('node-fetch');
const mongoose = require('mongoose'); // Import Mongoose
const { getWorkspaceAndOwner } = require('../lib/workspaceUtils'); // Import the new utility

// Get the centrally registered model for the 'agents_published' collection
const AgentPublishedModel = mongoose.model('AgentPublished');

/**
 * Removes private properties from agent data object
 * @param {Object} agentData - The agent data object
 * @returns {Object} Sanitized agent data without private properties
 */
const removePrivateProperties = (agentData) => {
  const sanitizedData = { ...agentData };
  
  // List of private properties to remove
  const privateProperties = [
    'workspace',
    'phoneNumber',
    'apiKey',
    'uniqueIdentifier',
    'widgetId',
    'knowledgeBase',
    'published',
    "version"
    // Add any other private properties here
  ];
  
  // Remove each private property if it exists
  privateProperties.forEach(prop => {
    if (prop in sanitizedData) {
      delete sanitizedData[prop];
    }
  });
  
  return sanitizedData;
};

/**
 * Transforms a prompt template by replacing template variables with known values
 * @param {string} promptTemplate - The template containing variables like {{varName}}
 * @param {Object} knownValues - Object containing known variable values
 * @param {Object} defaultValues - Object containing default values for variables not in knownValues
 * @returns {string} Transformed prompt with variables replaced
 */
const transformPromptTemplate = (promptTemplate, knownValues = {}, defaultValues = {}) => {
  if (!promptTemplate) return '';
  
  // Regex to find template variables of the form {{varName}}
  const templateVarRegex = /\{\{([^}]+)\}\}/g;
  
  // Replace all template variables with their values
  return promptTemplate.replace(templateVarRegex, (match, varName) => {
    // Trim potential whitespace
    const trimmedVarName = varName.trim();
    
    // Check if we have a known value for this variable
    if (knownValues[trimmedVarName] !== undefined) {
      return knownValues[trimmedVarName];
    }
    
    // Check if we have a default value for this variable
    if (defaultValues[trimmedVarName] !== undefined) {
      return defaultValues[trimmedVarName];
    }
    
    // If no value is known, use a generic placeholder
    return `ABC ${trimmedVarName}`;
  });
};

/**
 * Generates an introduction for an agent based on a prompt
 * @param {string} prompt - The prompt describing the agent's purpose
 * @returns {Promise<string>} The generated introduction or empty string if generation fails
 */
const generateAgentIntroduction = async (prompt) => {
  try {
    const introSystemPrompt = `
    You are an expert at creating brief, engaging introductions for AI agents. 
    Based on the user's prompt, create a concise and professional introduction 
    that the AI agent will use when first interacting with users.
    
    The introduction should:
    1. Be brief (1-3 sentences)
    2. Be professional and friendly
    3. Capture the purpose of the agent based on the prompt
    4. NOT include any technical details about AI or workflows
    5. Return ONLY the introduction text with no additional formatting or explanation
    6. DO NOT return JSON, arrays, or objects - ONLY return a simple text string
    `;
    
    const introPrompt = `Create a simple text introduction for an AI agent with the following purpose: "${prompt}". Return ONLY the plain text introduction with no formatting, JSON, or additional context.`;
    
    const generatedIntroduction = await geminiService.handleStream(
      introPrompt,
      {
        systemPrompt: introSystemPrompt,
        temperature: 0.7, // Slightly more creative for the introduction
        maxTokens: 200, // Introduction should be brief
        responseFormat: "text" // Explicitly request text format, not JSON
      }
    );
    
    // Process the generated introduction based on its type
    let finalIntroduction = '';
    
    if (generatedIntroduction) {
      if (typeof generatedIntroduction === 'string') {
        // If it's a string, clean it directly
        finalIntroduction = generatedIntroduction.trim().replace(/^["'](.*)["']$/g, '$1');
      } else if (typeof generatedIntroduction === 'object') {
        // If it's an object or array, try to extract a usable introduction
        if (Array.isArray(generatedIntroduction) && generatedIntroduction.length > 0) {
          // If it's an array, use the first element that's a string
          const firstString = generatedIntroduction.find(item => typeof item === 'string');
          if (firstString) {
            finalIntroduction = firstString.trim().replace(/^["'](.*)["']$/g, '$1');
          } else if (typeof generatedIntroduction[0] === 'object') {
            // Try to find introduction, text, or content fields in the first object
            const firstObj = generatedIntroduction[0];
            finalIntroduction = (firstObj.introduction || firstObj.text || firstObj.content || JSON.stringify(firstObj)).trim();
          }
        } else {
          // It's an object, try to find specific properties
          finalIntroduction = (generatedIntroduction.introduction || 
                             generatedIntroduction.text || 
                             generatedIntroduction.content || 
                             JSON.stringify(generatedIntroduction)).trim();
        }
      }
    }
    
    return finalIntroduction;
  } catch (error) {
    console.error("Error generating introduction:", error);
    return '';
  }
};

/**
 * Process orchestrationFlow to create Tool records for any tools with credentials
 * and replace them with toolId references. Also handles tool deletion.
 */
const processOrchestrationFlowTools = async (orchestrationFlow, agent, userId) => {
  if (!orchestrationFlow || !orchestrationFlow.nodes) {
    console.log("no nodes", orchestrationFlow);
    return orchestrationFlow;
  }

  const processedFlow = JSON.parse(JSON.stringify(orchestrationFlow)); // Deep clone

  // Get user workspace info
  const user = await User.findById(userId).populate("defaultWorkspace").populate("lastActiveWorkspace");
  const { workspaceId, ownerId } = getWorkspaceAndOwner(user);

  // Get all existing tools for this agent to track deletions
  const existingTools = await Tool.find({ agent: agent._id, isActive: true });
  const currentToolIds = new Set();

  for (const node of processedFlow.nodes) {
    console.log("node found", node.data, node.data?.name);
    
    // Check for tools in the settings structure
    let tools = null;
    if (node.data && node.data.settings && node.data.settings.tools) {
      tools = node.data.settings.tools;
    }
    
    if (tools) {
      console.log("node data found, tools:", tools);
      const processedTools = [];

      for (const tool of tools) {
        console.log("tool found", tool);
        
        // If tool has a toolId, it's an existing tool - track it
        if (tool.toolId) {
          currentToolIds.add(tool.toolId);
          processedTools.push(tool);
        }
        // Check if this tool has credentials (indicating it's a new tool)
        else if (tool.config && tool.config.apiKey) {
          try {
            // Create a Tool record in the database
            const toolRecord = new Tool({
              name: tool.name,
              type: tool.type,
              serverUrl: tool.serverUrl,
              user: ownerId,
              workspace: workspaceId,
              agent: agent._id,
              credentials: {
                apiKey: tool.config.apiKey
              },
              configuration: tool.config || {},
              protocol: 'mcp',
              createdBy: userId
            });

            await toolRecord.save();
            console.log(`Created Tool record with toolId: ${toolRecord.toolId} for agent ${agent._id}`);

            // Track the new tool
            currentToolIds.add(toolRecord.toolId);

            // Replace the tool with just the reference
            processedTools.push({
              toolId: toolRecord.toolId,
              name: tool.name,
              type: tool.type,
              serverUrl: tool.serverUrl,
              parameters: tool.parameters || {}
            });
          } catch (error) {
            console.error(`Error creating Tool record for ${tool.name}:`, error);
            // If tool creation fails, keep the original tool but remove credentials
            const { config, ...toolWithoutCredentials } = tool;
            processedTools.push(toolWithoutCredentials);
          }
        } else {
          // Tool without credentials or toolId, keep as is
          processedTools.push(tool);
        }
      }

      // Update tools in the correct location
      if (node.data.settings) {
        node.data.settings.tools = processedTools;
      }
    }
  }

  // Delete tools that are no longer referenced in the workflow
  const toolsToDelete = existingTools.filter(tool => !currentToolIds.has(tool.toolId));
  
  if (toolsToDelete.length > 0) {
    console.log(`Deleting ${toolsToDelete.length} unused tools for agent ${agent._id}`);
    
    for (const tool of toolsToDelete) {
      try {
        // Soft delete by setting isActive to false
        tool.isActive = false;
        await tool.save();
        console.log(`Deleted Tool record with toolId: ${tool.toolId}`);
      } catch (error) {
        console.error(`Error deleting Tool record ${tool.toolId}:`, error);
      }
    }
  }

  return processedFlow;
};

// Apply authentication middleware to all routes
router.use(apiLimiter);
router.use(authenticateUser);

// Get all agents for the authenticated user
router.get("/", async (req, res) => {
  try {
    // Find the user and populate relevant workspaces
    const user = await User.findById(req.user.id).populate("defaultWorkspace").populate("lastActiveWorkspace");
    console.log("User for GET /agents:", user);

    const { workspaceId, error } = getWorkspaceAndOwner(user);

    if (error) {
      console.error(`Error getting workspace for user ${req.user.id}: ${error}`);
      return res.status(400).json({ error: error });
    }

    // Find agents associated with the determined workspace
    const agents = await Agent.find({ workspace: workspaceId })
                            .populate("phoneNumber", "phoneNumber");

    res.json(agents);
  } catch (error) {
    console.error("Error fetching agents:", error);
    res.status(500).json({ error: "Failed to fetch agents" });
  }
});

// Get single agent (with user verification)
router.get("/:id", async (req, res) => {
  try {
    const agent = await verifyAgentWorkspace(req.params.id, req.user.id);

    if (!agent) {
      return res.status(404).json({ error: "Agent not found or unauthorized" });
    }
    res.json(agent);
  } catch (error) {
    console.error("Error fetching agent:", error);
    res.status(500).json({ error: "Failed to fetch agent" });
  }
});

// Route to get URL and API key of an agent
router.get("/:id/connect-info", async (req, res) => {
  try {
    const userId = req.user.id;
    const agentId = req.params.id; // This is the ID of the DRAFT agent

    // 1. Find the DRAFT agent first to verify ownership and get its uniqueIdentifier
    const draftAgent = await verifyAgentWorkspace(agentId, userId);

    if (!draftAgent) {
      return res.status(404).json({ error: "Agent (draft) not found or unauthorized" });
    }

    // Check if the draft even has a uniqueIdentifier (might not have been published yet)
    if (!draftAgent.uniqueIdentifier) {
      return res.status(400).json({
         error: "Agent has not been published yet",
         message: "Publish the agent first to get connection information.",
       });
    }

    // 2. Find the PUBLISHED agent using the uniqueIdentifier from the draft
    const publishedAgent = await AgentPublishedModel.findOne({
        _id: draftAgent._id,
        workspace: draftAgent.workspace // Ensure it's from the same workspace
    });
    console.log(publishedAgent, "published agent")

    // Check if a published version actually exists
    if (!publishedAgent || !publishedAgent.apiKey) { // Also check apiKey as a proxy for successful publish
      return res.status(404).json({
        error: "Published agent data not found",
        message: "Could not find the corresponding published version. Please try publishing again.",
      });
    }

    // 3. Generate URL and return info from the PUBLISHED agent
    const url = `https://${process.env.BASE_URL}/workflow/${publishedAgent.uniqueIdentifier}`;
    const apiKey = publishedAgent.apiKey;

    res.json({ url, apiKey });
  } catch (error) {
    console.error("Error retrieving connect info:", error);
    res.status(500).json({ error: "Failed to retrieve connect info", details: error.message });
  }
});

// Create new agent
router.post("/", async (req, res) => {
  try {
    const { name, language, agentType, preferredSetupType } = req.body;

    // Find the user and populate workspaces
    const user = await User.findById(req.user.id).populate("defaultWorkspace").populate("lastActiveWorkspace");

    const { workspaceId, ownerId, error: workspaceError } = getWorkspaceAndOwner(user);

    if (workspaceError) {
      console.error(`Error getting workspace for user ${req.user.id} during agent creation: ${workspaceError}`);
      return res.status(400).json({ error: workspaceError });
    }

    // Validate required fields
    if (!name || !language || !agentType) {
      return res.status(400).json({
        error:
          "Missing required fields: name, language, and agentType are required",
      });
    }

    const templateAgentId = "678f713ab9f771803ef0677c";
    const templateAgent = await Agent.findById(templateAgentId);

    if (!templateAgent) {
      return res.status(400).json({ error: "Template agent not found" });
    }

    // Convert to plain object and remove _id
    const templateData = templateAgent.toObject();
    delete templateData._id;
    
    // Remove any private properties from the template
    const sanitizedTemplateData = removePrivateProperties(templateData);

    // Transform any prompt templates in the data
    if (sanitizedTemplateData.prompt) {
      // Set up known values from the request
      const knownValues = {
        agentName: name,
        agentType: agentType
      };
      
      // Set up default values for any unknown variables
      const defaultValues = {
        businessName: "ABC Business"
      };
      
      // Transform the prompt template
      sanitizedTemplateData.prompt = transformPromptTemplate(
        sanitizedTemplateData.prompt, 
        knownValues, 
        defaultValues
      );
    }
    
    const agentData = {
      ...sanitizedTemplateData,
      name,
      language,
      agentType,
      user: ownerId, // Use ownerId from getWorkspaceAndOwner
      uniqueIdentifier: uuidv4(),
      workspace: workspaceId, // Use workspaceId from getWorkspaceAndOwner
      preferredSetupType: preferredSetupType
    };

    const newAgent = new Agent(agentData);
    
    // Create a knowledge source for this agent
    const knowledgeSource = new KnowledgeSource({
      name: `Knowledge Source for ${name}`,
      description: `Knowledge source created for agent: ${name}`,
      user: ownerId, // Owner of the knowledge source
      workspace: workspaceId, // Workspace for the knowledge source
    });
    
    await knowledgeSource.save();
    
    // Link knowledge source to agent
    newAgent.knowledgeBase = {
      sources: [knowledgeSource._id]
    };
    
    await newAgent.save();
    
    // Remove private properties before sending response
    const responseAgent = removePrivateProperties(newAgent.toObject());
    res.status(201).json(responseAgent);
  } catch (error) {
    console.error("Error creating agent:", error);
    res.status(500).json({
      error: "Failed to create agent",
      details: error.message,
    });
  }
});

router.post("/:agentId/assign-phone", async (req, res) => {
  try {
    const { agentId } = req.params; // agentId from URL parameter
    const { phoneNumberId } = req.body; // phoneNumberId from request body

    const phoneNumber = await PhoneNumber.findById(phoneNumberId);
    if (!phoneNumber) {
      return res.status(404).json({ error: "Phone number not found" });
    }

    const agent = await verifyAgentWorkspace(agentId, req.user.id);
    if (!agent) {
      return res.status(404).json({ error: "Agent not found" });
    }

    // Ensure the phone number is not already in use
    if (phoneNumber.user) {
      return res
        .status(400)
        .json({ error: "Phone number is already assigned to a user" });
    }

    // Assign the phone number to the agent
    phoneNumber.user = agent.user; // Assign to the same user as the agent
    await phoneNumber.save();

    res.json({
      message: "Phone number assigned to agent successfully",
      phoneNumber,
      agent,
    });
  } catch (error) {
    console.error("Error assigning phone number to agent:", error);
    res.status(500).json({ error: "Failed to assign phone number to agent" });
  }
});

router.post(":newAgentId/reassign-phone", async (req, res) => {
  try {
    const { newAgentId } = req.params;
    const { phoneNumberId } = req.body;

    // Find the phone number
    const phoneNumber = await PhoneNumber.findById(phoneNumberId);
    if (!phoneNumber) {
      return res.status(404).json({ error: "Phone number not found" });
    }

    // Check if the new agent exists
    const newAgent = await verifyAgentWorkspace(newAgentId, req.user.id);
    if (!newAgent) {
      return res.status(404).json({ error: "New agent not found" });
    }

    // Verify the current user owns the phone number
    if (
      !phoneNumber.user ||
      phoneNumber.user.toString() !== newAgent.user.toString()
    ) {
      return res.status(403).json({ error: "Phone number ownership mismatch" });
    }

    // Reassign the phone number to the new agent
    phoneNumber.user = newAgent.user;
    await phoneNumber.save();

    res.json({
      message: "Phone number reassigned successfully",
      phoneNumber,
      newAgent,
    });
  } catch (error) {
    console.error("Error reassigning phone number:", error);
    res.status(500).json({ error: "Failed to reassign phone number" });
  }
});

// Route to select and assign a voice to an agent
router.post("/:id/assign-voice", async (req, res) => {
  try {
    const agentId = req.params.id;
    // Rename incoming voiceId to sharedOrDirectVoiceId for clarity when service is ElevenLabs
    // Also expect publicUserId for adding shared voices
    const { voiceId: sharedOrDirectVoiceId, publicUserId, voiceName, service, voiceShortName, traits, audioUrl, gender, language } = req.body;

    // --- Basic Validation ---
    if (!agentId || !sharedOrDirectVoiceId || !voiceName || !service) {
      return res
        .status(400)
        .json({ error: "Agent ID, Voice ID, Voice Name, and Service are required" });
    }
    if (service === 'azure' && !voiceShortName) {
        console.warn("Assigning Azure voice without voiceShortName, using voiceId as fallback.");
        // Potentially return an error if voiceShortName is strictly required for Azure
        // return res.status(400).json({ error: "voiceShortName is required for Azure Speech Services" });
    }

    

    // --- Fetch Agent --- (Ensure verifyAgentWorkspace handles this or do it here)
    // Using await verifyAgentWorkspace directly if it throws on failure or returns null

    const agent = await verifyAgentWorkspace(agentId, req.user.id);
    if (!agent) {
      return res.status(404).json({ error: "Agent not found or access denied" });
    }

    // --- Process Voice ID based on Service ---
    let finalVoiceId = sharedOrDirectVoiceId;
    let finalVoiceName = voiceName; // Usually the same, but could change if corrected
    let finalVoiceShortName = voiceShortName; // Keep for Azure

    if (service === 'elevenlabs') {
      const apiKey = process.env.ELEVENLABS_API_KEY;
      if (!apiKey) {
        console.error("ElevenLabs API key (ELEVENLABS_API_KEY) is not configured.");
        return res.status(500).json({ error: "ElevenLabs service is not configured on the server." });
      }

      try {
        console.log(`Processing ElevenLabs voice assignment for name: "${voiceName}", shared ID: ${sharedOrDirectVoiceId}`);

        // 1. Get user's voices from their ElevenLabs library
        const voicesResponse = await fetch('https://api.elevenlabs.io/v1/voices', {
            headers: { 'xi-api-key': apiKey, 'Accept': 'application/json' }
        });

        if (!voicesResponse.ok) {
            const errorBody = await voicesResponse.text();
            throw new Error(`Failed to fetch ElevenLabs user voices. Status: ${voicesResponse.status}, Body: ${errorBody}`);
        }
        const { voices: userVoices } = await voicesResponse.json();

        // 2. Check if a voice with the *same name* already exists in the user's library
        const existingVoice = userVoices.find(v => v.name === voiceName);

        if (existingVoice) {
            finalVoiceId = existingVoice.voice_id;
            console.log(`Voice "${voiceName}" already exists in ElevenLabs library with ID: ${finalVoiceId}`);
        } else {
            // 3. Voice not found by name, try adding the *shared* voice ID to the library
            console.log(`Voice "${voiceName}" not found in library. Attempting to add shared voice ID ${sharedOrDirectVoiceId}...`);

            // ** Crucial: Check if publicUserId is provided for adding shared voices **
            if (!publicUserId) {
                console.error("Missing publicUserId required for adding shared ElevenLabs voice.");
                return res.status(400).json({ 
                    error: "Missing publicUserId", 
                    message: "The public user ID of the voice owner is required to add a shared ElevenLabs voice."
                });
            }

            // Use the correct endpoint format: /v1/voices/add/:public_user_id/:voice_id
            console.log(`Attempting to add shared voice: Owner Public ID = ${publicUserId}, Voice ID = ${sharedOrDirectVoiceId}`);
            const addResponse = await fetch(`https://api.elevenlabs.io/v1/voices/add/${publicUserId}/${sharedOrDirectVoiceId}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'xi-api-key': apiKey,
                    'Accept': 'application/json'
                },
                body: JSON.stringify({ new_name: voiceName }) // Add with the desired name
            });

            if (!addResponse.ok) {
                 const errorBody = await addResponse.text();
                 console.error(`ElevenLabs add error for shared ID ${sharedOrDirectVoiceId}:`, addResponse.status, errorBody);
                 // Provide specific feedback if possible (e.g., 404 = shared voice not found, 422 = name invalid/taken?)
                 let userMessage = `Failed to add shared ElevenLabs voice "${voiceName}" (Owner: ${publicUserId}, Voice: ${sharedOrDirectVoiceId}) to your library.`;
                 if(addResponse.status === 404) {
                    userMessage = `The shared ElevenLabs voice (Owner: ${publicUserId}, Voice: ${sharedOrDirectVoiceId}) could not be found or is not available for sharing. Check IDs.`;
                 } else if (addResponse.status === 400 || addResponse.status === 422) {
                     // Attempt to parse error detail if JSON
                     let detail = errorBody;
                     try {
                         const parsedError = JSON.parse(errorBody);
                         detail = parsedError.detail?.[0]?.msg || JSON.stringify(parsedError.detail) || errorBody;
                     } catch(e) {/* ignore parsing error */}
                     userMessage = `Could not add shared ElevenLabs voice "${voiceName}" (Owner: ${publicUserId}, Voice: ${sharedOrDirectVoiceId}). The name might be invalid, already taken in your library, or another issue occurred. Detail: ${detail}`;
                 }
                 throw new Error(userMessage); // Throw after logging details
            }

            // Voice added successfully! The API should return 200 OK.
            // Re-fetch the user voices to get the new ID.
            console.log(`Shared voice ${sharedOrDirectVoiceId} added with name "${voiceName}". Re-fetching user voices to get the new ID...`);
            const updatedVoicesResponse = await fetch('https://api.elevenlabs.io/v1/voices', {
                 headers: { 'xi-api-key': apiKey, 'Accept': 'application/json' }
            });
             if (!updatedVoicesResponse.ok) throw new Error('Failed to re-fetch ElevenLabs user voices after adding.');
            const { voices: updatedUserVoices } = await updatedVoicesResponse.json();
            const newlyAddedVoice = updatedUserVoices.find(v => v.name === voiceName);

            if(!newlyAddedVoice) {
                // This shouldn't happen if the add was successful, but handle it.
                 console.error(`Failed to find the newly added voice "${voiceName}" in the user's library after supposedly successful addition.`);
                 throw new Error(`Voice "${voiceName}" was reportedly added to ElevenLabs, but could not be found immediately after.`);
            }

            finalVoiceId = newlyAddedVoice.voice_id;
            console.log(`Successfully added voice "${voiceName}" to ElevenLabs library. New library ID: ${finalVoiceId}`);
        }

      } catch (elevenLabsError) {
        console.error("Error processing ElevenLabs voice:", elevenLabsError);
        return res.status(500).json({
            error: `Failed to process ElevenLabs voice: ${elevenLabsError.message}`
        });
      }
    } else if (service === 'azure') {
        // For Azure, prioritize voiceShortName if provided, otherwise use the voiceId.
        finalVoiceId = voiceShortName || sharedOrDirectVoiceId;
        console.log(`Assigning Azure voice. Using ID: ${finalVoiceId} (ShortName prioritized: ${!!voiceShortName})`);
    }
    // Add other 'else if' blocks here for other TTS services

    // --- Update Agent ---
    // Construct the ttsSettings object cleanly
    let settingsToSave = {
        service: service,
        voiceId: finalVoiceId,
        voiceName: finalVoiceName, // Use potentially corrected/verified name
        traits: traits,
        audioUrl: audioUrl,
        gender: gender,
        language: language
    };
    if (service === 'azure' && finalVoiceShortName) {
        settingsToSave.voiceShortName = finalVoiceShortName; // Only add if Azure and exists
    }

    agent.ttsSettings = settingsToSave;
    await agent.save();

    // --- Respond ---
    res.json({
      success: true,
      message: `Voice "${finalVoiceName}" (${service}) assigned to Agent "${agent.name}" with ID ${finalVoiceId}.`,
      agent: agent // Send back the updated agent
    });

  } catch (error) {
    // Catch errors from Agent fetching, saving, or other unexpected issues
    console.error("Error assigning voice to agent:", error);
    res.status(500).json({ error: "Failed to assign voice to agent. " + error.message });
  }
});

// Route to save webhook configuration
router.put("/:id/webhook", async (req, res) => {
  try {
    const userId = req.user.id; // Assuming user is authenticated
    const agentId = req.params.id;
    const { webhookName, webhookEndpoint, webhookMethod, webhookEvent } =
      req.body;

    // Validate required fields
    if (!webhookName || !webhookEndpoint || !webhookMethod || !webhookEvent) {
      return res.status(400).json({ error: "All webhook fields are required" });
    }

    // Find the agent and ensure the user owns it
    const agent = await verifyAgentWorkspace(agentId, userId);

    if (!agent) {
      return res.status(404).json({ error: "Agent not found or unauthorized" });
    }

    agent.webhook = {
      name: webhookName,
      endpoint: webhookEndpoint,
      method: webhookMethod,
      event: webhookEvent,
    };
    await agent.save();

    res.json({
      success: true,
      message: "Webhook configuration saved successfully",
      agent,
    });
  } catch (error) {
    console.error("Error saving webhook configuration:", error);
    res.status(500).json({ error: "Failed to save webhook configuration" });
  }
});

// Route to configure widget
router.put("/:id/configure-widget", async (req, res) => {
  try {
    const userId = req.user.id;
    const agentId = req.params.id;
    const { widgetConfiguration } = req.body;

    // Find the agent and ensure the user owns it
    const agent = await verifyAgentWorkspace(agentId, userId);

    if (!agent) {
      return res.status(404).json({ error: "Agent not found or unauthorized" });
    }

    // Update the widget configuration
    agent.widgetConfiguration = widgetConfiguration;
    await agent.save();

    // Also update the published agent if it exists
    try {
      const publishedAgent = await AgentPublishedModel.findOneAndUpdate(
        { _id: agentId, workspace: agent.workspace },
        { $set: { widgetConfiguration: widgetConfiguration } },
        { new: true }
      );
      
      if (publishedAgent) {
        console.log(`Updated widget configuration for published agent ${agentId}`);
      }
    } catch (publishedUpdateError) {
      console.error("Error updating published agent widget configuration:", publishedUpdateError);
      // Don't fail the whole request if published update fails
    }

    res.json({
      success: true,
      message: "Widget configuration saved successfully",
      agent,
    });
  } catch (error) {
    console.error("Error saving widget configuration:", error);
    res.status(500).json({ error: "Failed to save widget configuration" });
  }
});

// Route to get webhook (should be more secure?)
router.get("/:id/webhook", async (req, res) => {
  try {
    const userId = req.user.id; // Assuming user is authenticated
    const agentId = req.params.id;

    const agent = await verifyAgentWorkspace(agentId, userId);

    if (!agent) {
      return res.status(404).json({ error: "Agent not found" });
    }

    res.json({ success: true, ...agent.webhook });
  } catch (error) {
    console.error("Error saving webhook configuration:", error);
    res.status(500).json({ error: "Failed to save webhook configuration" });
  }
});

// Update agent (with user verification)
router.put("/:id", async (req, res) => {
  try {
    //!Please verify whether this is working.
    const agent = await verifyAgentWorkspace(req.params.id, req.user.id);
    if (!agent) {
      return res.status(404).json({ error: "Agent not found or unauthorized" });
    }

    // Check if the prompt is being updated
    if (req.body.prompt && req.body.prompt !== agent.prompt) {
      // Set the flag to indicate workflow needs update when prompt changes
      req.body.workflowNeedsUpdate = true;
      console.log(`Prompt updated for agent ${agent._id}, setting workflowNeedsUpdate flag`);
    }

    // Handle orchestrationFlow updates with tool creation
    if (req.body.orchestrationFlow) {
      console.log("orchestrationFlow", req.body.orchestrationFlow);
      const processedFlow = await processOrchestrationFlowTools(req.body.orchestrationFlow, agent, req.user.id);
      req.body.orchestrationFlow = processedFlow;
    }

    Object.assign(agent, req.body);
    const updatedAgent = await agent.save();
    res.json(updatedAgent);
  } catch (error) {
    console.error("Error updating agent:", error);
    res.status(500).json({ error: "Failed to update agent" });
  }
});

// Route to publish an agent
router.put("/:id/publish", async (req, res) => {
  try {
    const userId = req.user.id;
    const agentId = req.params.id; // This is the _id of the DRAFT agent

    // Get the model instance for published agents
    const AgentPublishedModel = mongoose.model('AgentPublished');

    // 1. Find the DRAFT agent to be published
    const draftAgent = await verifyAgentWorkspace(agentId, userId); // Uses AgentModel implicitly

    if (!draftAgent) {
      return res.status(404).json({ error: "Draft agent not found or unauthorized" });
    }

    // 2. Prepare the data for the published version
    const publishedData = draftAgent.toObject();

    // Keep the draft's _id to ensure the published version has the same ID.
    // Remove draft-specific metadata if any (e.g., internal version potentially)
    // delete publishedData.version; // Decide if published version should have its own independent version or sync with draft. Let's keep version aligned for now.
    publishedData.version = draftAgent.version; // Sync version number
    publishedData.lastPublishedAt = new Date();

    // 3. Upsert into the 'agents_published' collection
    // Use the draft agent's _id to find/update the document in the published collection.
    // This ensures the published document has the SAME _id as the draft.
    const publishedAgent = await AgentPublishedModel.findOneAndUpdate(
      { _id: agentId, workspace: draftAgent.workspace }, // Find by draft _id and workspace
      { $set: publishedData }, // Use $set to update fields based on the prepared data
      { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
    );

     // 4. Optionally: Update the original draft agent's status/version
     // Increment draft version to show changes have occurred since last publish
     draftAgent.version = (typeof draftAgent.version === 'number' ? draftAgent.version : 0) + 1;
     // Mark draft as published (or maybe store the published version's _id?)
     draftAgent.published = true; // Update draft's published flag
     await draftAgent.save(); // Save changes back to the draft agent in 'agents' collection

    // 5. Respond with success and relevant info from the PUBLISHED agent
    const url = `https://${process.env.BASE_URL}/workflow/${publishedAgent.uniqueIdentifier}`;

    res.json({
      success: true,
      message: "Agent published successfully",
      // Return details relevant to the *published* state
      publishedAgent: { // Sending back a subset or the full published agent object
          _id: publishedAgent._id,
          uniqueIdentifier: publishedAgent.uniqueIdentifier,
          name: publishedAgent.name,
          lastPublishedAt: publishedAgent.lastPublishedAt,
          // include other relevant fields...
      },
      url: url,
      apiKey: publishedAgent.apiKey,
      draftAgentVersion: draftAgent.version // Can inform the user about the updated draft version
    });

  } catch (error) {
    console.error("Error publishing agent:", error);
    if (error.name === 'ValidationError') {
         return res.status(400).json({ error: "Validation failed during publish", details: error.message });
    }
    res.status(500).json({ error: "Failed to publish agent", details: error.message });
  }
});

// Delete agent (with user verification)
router.delete("/:id", async (req, res) => {
  try {
    // Simple check for deleteKnowledgebase in the body, default to true
    const deleteKnowledgebase = req.body.deleteKnowledgebase !== false;

    // Find the user to determine the correct workspace for deletion check
    const user = await User.findById(req.user.id).populate("defaultWorkspace").populate("lastActiveWorkspace");
    const { workspaceId, ownerId, error: workspaceError } = getWorkspaceAndOwner(user);

    if (workspaceError) {
        console.error(`Error determining workspace for deletion for user ${req.user.id}: ${workspaceError}`);
        // Decide if this is a 400 or 500 - maybe 400 as the user context is bad
        return res.status(400).json({ error: `Could not determine workspace: ${workspaceError}` });
    }

    // Use the determined workspaceId and ownerId (req.user.id) for the query
    const agent = await Agent.findOne({
      _id: req.params.id,
      workspace: workspaceId, // Ensure deletion targets the correct workspace
      user: ownerId // Double-check ownership
    });
    
    if (!agent) {
      // Log more details for debugging
      console.log(`Agent ${req.params.id} not found for user ${ownerId} in workspace ${workspaceId}`);
      return res.status(404).json({ error: "Agent not found in the active workspace or unauthorized" });
    }

    // Delete the agent using the specific criteria
    const deletedAgentResult = await Agent.deleteOne({
      _id: req.params.id,
      workspace: workspaceId,
      user: ownerId
    });

    // Check if deletion actually happened
    if (deletedAgentResult.deletedCount === 0) {
      // This case might occur if the agent existed but somehow wasn't deleted (e.g., race condition, permissions issue not caught)
      console.warn(`Agent ${req.params.id} found but not deleted for user ${ownerId} in workspace ${workspaceId}`);
      // Return a 404 or 500 depending on expected behavior. 404 might be misleading if it *was* found initially.
      return res.status(500).json({ error: "Agent found but could not be deleted." });
    }

    // If deleteKnowledgebase is true and the agent had knowledge sources, delete them
    let knowledgeBaseDeleted = false;
    if (deleteKnowledgebase && agent.knowledgeBase && agent.knowledgeBase.sources && agent.knowledgeBase.sources.length > 0) {
      const sourceIdsToDelete = agent.knowledgeBase.sources;
      // Optionally add workspace check here too for extra safety
      const deleteKbResult = await KnowledgeSource.deleteMany({
        _id: { $in: sourceIdsToDelete },
        user: ownerId // Ensure user owns the knowledge sources being deleted
        // workspace: workspaceId // Optionally add workspace check
      });
      console.log(`Deleted ${deleteKbResult.deletedCount} knowledge sources for agent ${agent._id}`);
      knowledgeBaseDeleted = deleteKbResult.deletedCount > 0;
    }

    res.json({
      message: "Agent deleted successfully",
      knowledgeBaseDeleted: knowledgeBaseDeleted
    });
  } catch (error) {
    console.error(`Error deleting agent ${req.params.id}:`, error);
    res.status(500).json({ error: "Failed to delete agent", details: error.message });
  }
});

// New route to increment agent version
router.put("/:id/increment-version", async (req, res) => {
  try {
    const userId = req.user.id; // Assuming user is authenticated
    const agentId = req.params.id;

    // Find the agent and ensure the user owns it
    const agent = await verifyAgentWorkspace(agentId, userId);

    if (!agent) {
      return res.status(404).json({ error: "Agent not found or unauthorized" });
    }

    // Increment the version number
    // If version is not a number or doesn't exist, initialize it to 1
    agent.version = (typeof agent.version === 'number' ? agent.version : 0) + 1;
    
    // Save the updated agent
    const updatedAgent = await agent.save();

    res.json({ 
      success: true, 
      message: "Agent version incremented successfully", 
      agent: updatedAgent // Return the updated agent
    });

  } catch (error) {
    console.error("Error incrementing agent version:", error);
    res.status(500).json({ 
      error: "Failed to increment agent version",
      details: error.message 
    });
  }
});

// Get agent count for user
router.get("/stats/count", async (req, res) => {
  try {
    const count = await Agent.countDocuments({ user: req.user.id });
    res.json({ count });
  } catch (error) {
    console.error("Error getting agent count:", error);
    res.status(500).json({ error: "Failed to get agent count" });
  }
});

// Route to update agent flow based on prompt using Gemini
router.post("/:id/update-flow-with-prompt", async (req, res) => {
  try {
    const { id } = req.params;
    const { prompt } = req.body;

    if (!prompt) {
      return res.status(400).json({ error: "Prompt is required" });
    }

    // Find the agent and verify ownership
    const agent = await verifyAgentWorkspace(id, req.user.id);
    
    if (!agent) {
      return res.status(404).json({ error: "Agent not found or unauthorized" });
    }

    // Get the current React Flow structure
    const currentFlow = agent.orchestrationFlow;

    // Create the system prompt for Gemini
    const systemPrompt = `
    You are an AI agent workflow expert. You will receive a JSON structure for a React Flow diagram 
    and a user prompt. Your task is to modify the React Flow JSON based on the user's prompt.
    
    Important rules:
    1. The output MUST be a valid JSON object containing 'nodes' and 'edges' arrays
    2. Each node MUST have required properties: id, type, position (with x and y coordinates)
    3. Each edge MUST have required properties: id, source, target
    4. Preserve the basic structure but enhance it according to the prompt
    5. Make sure all connections remain logically valid
    6. Maintain any existing node references in the edges
    7. Return ONLY the modified JSON structure - no explanations or comments
    `;

    // Call Gemini API to update the flow
    const updatedFlow = await geminiService.handleStream(
      `Here is the current React Flow structure: ${JSON.stringify(currentFlow)}
      
      User prompt: ${prompt}
      
      Please modify this React Flow structure based on the prompt. Return only the modified JSON structure.`,
      {
        systemPrompt,
        temperature: 0.2, // Lower temperature for more consistent output
        maxTokens: 4000, // Enough tokens for a complex flow
        responseFormat: "json"
      }
    );

    // Validate the returned flow structure
    if (!updatedFlow || !updatedFlow.nodes || !updatedFlow.edges) {
      return res.status(500).json({ 
        error: "Failed to generate valid flow structure",
        details: "The AI service did not return a valid React Flow structure"
      });
    }

    // Store the prompt in the agent's prompt field
    agent.prompt = prompt;
    
    // Set the version to 1 to indicate the flow has been updated with a prompt
    agent.version = 1;
    
    // Update the agent with the new flow
    agent.orchestrationFlow = updatedFlow;
    
    // Reset the workflowNeedsUpdate flag since workflow was successfully generated from prompt
    agent.workflowNeedsUpdate = false;
    console.log(`Reset workflowNeedsUpdate flag for agent ${agent._id} after successful workflow generation`);
    
    // Generate an introduction based on the prompt
    try {
      const introduction = await generateAgentIntroduction(prompt);
      if (introduction) {
        agent.introduction = introduction;
      }
    } catch (introError) {
      console.error("Error in introduction generation:", introError);
      // Continue with saving even if introduction generation fails
    }
    
    await agent.save();

    res.status(200).json({ 
      message: "Agent flow updated successfully",
      agent: agent
    });
  } catch (error) {
    console.error("Error updating agent flow with prompt:", error);
    res.status(500).json({ 
      error: "Failed to update agent flow",
      details: error.message 
    });
  }
});

// Export the router and utility functions
module.exports = router;

// Export utility functions for use in other modules
module.exports.removePrivateProperties = removePrivateProperties;
module.exports.transformPromptTemplate = transformPromptTemplate; 
