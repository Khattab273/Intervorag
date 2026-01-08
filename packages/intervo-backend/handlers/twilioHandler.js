const WebSocket = require("ws");
const OrchestrationManager  = require('../services/OrchestrationManager');
const { IntentClassifierAgent } = require('../agents/IntentClassifierAgent');
const { QuickResponseAgent } = require('../agents/QuickResponseAgent');
const { RAGAgent } = require('../agents/RAGAgent');
const Agent = require('../models/Agent');
const Contact = require('../models/Contact');
const {BaseAgent} = require('../agents/BaseAgent');
const Activity = require('../models/Activity');
const mongoose = require('mongoose');
// const createAzureSpeechRecognizeStream = require('../services/createAzureSpeechRecognizeStream');
const createSpeechRecognizeStream = require('../services/speechRecognizeStream');
const { getTTSService } = require('../services/ttsRouter');
const PreCallAudioManager = require('../services/PreCallAudioManager');
const handleCallStopEvent=require('../lib/callStopHandler');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const CallRecorder = require('../lib/callRecorder');
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

// Get the model for the published agents collection
const AgentPublishedModel = mongoose.model('AgentPublished'); // Assumes already registered

// --- Configure S3 Client for Hetzner ---
// Ensure HETZNER_STORAGE_ACCESS_KEY_ID, HETZNER_STORAGE_SECRET_ACCESS_KEY,
// HETZNER_STORAGE_ENDPOINT, HETZNER_STORAGE_REGION, HETZNER_STORAGE_BUCKET are in your .env
const s3Client = new S3Client({
    endpoint: process.env.HETZNER_STORAGE_ENDPOINT,
    region: process.env.HETZNER_STORAGE_REGION,
    credentials: {
        accessKeyId: process.env.HETZNER_STORAGE_ACCESS_KEY_ID,
        secretAccessKey: process.env.HETZNER_STORAGE_SECRET_ACCESS_KEY,
    },
    forcePathStyle: true, // Important for S3-compatible storage
});
const uploadBucket = process.env.HETZNER_STORAGE_BUCKET;
// --- End S3 Client Configuration ---

function extractConfig(customParameters) {
  return {
    ...customParameters,
    sttService: customParameters['stt-service'] || customParameters['sttService'],
    aiEndpoint: customParameters['ai-endpoint'] || customParameters['aiEndpoint'],
    ttsService: customParameters['tts-service'] || customParameters['ttsService'],
    voiceType: customParameters['voice-type'] || customParameters['voiceType'],
    leadPrompt: customParameters['lead-prompt'] || customParameters['leadPrompt'],
    introduction: customParameters['introduction'] || customParameters['introduction'],
    agentId: customParameters['agent-id'] || customParameters['agentId'],
    activityId:customParameters['activity-id'] || customParameters['activityId'],
    widgetId: customParameters['widget-id'] || customParameters['widgetId'],
    contactId: customParameters['contact-id'] || customParameters['contactId'],
    conversationId: customParameters['conversation-id'] || customParameters['conversationId'],
  };
}

function handleTwilioConnection(ws, req, wss, agentRoomBroker, mode="call", customParametersFromParams) {

  console.log(customParametersFromParams, "customParametersFromParams")
    let config={};
    let callRecorder = null;
    let orchestrator; // Move orchestrator to be connection-specific
        /* Twilio connection
     * This is where most of the Realtime stuff happens. Highly performance sensitive.
     */ 
    const timer = startTimer();

    let conversationHistory = [];
    let inactivityTimeout;
    let streamSid;
    let isProcessingTTS = false;
    let ignoreNewTranscriptions = false;
    let userInterrupted = { value: false }; // Use object to pass by reference
    let intentClassifier; // Store IntentClassifierAgent instance
    let callStartTime;
    let sessionTimeoutId; // Variable to store the 5-minute session timeout ID
   

    console.log("outside function")
    let recognizeStream;
    ws.on("message",async (message) => {




      const data = JSON.parse(message.toString("utf8"));


      if (data.event === "start") {

        callStartTime = new Date(); 
        streamSid = data.streamSid;
        console.log(customParametersFromParams, "customParametersFromParams")
        config = extractConfig(customParametersFromParams);
        config.conversationMode = mode;
        // Use existing conversationId if provided, otherwise generate new one
        config.conversationId = config.conversationId || uuidv4();

        
        // --- Start Recording Setup ---
        try {
            // Use conversationId or a fallback for filename base
            const recordingBaseName = config.conversationId || `call-${Date.now()}`;
            // You could pass a specific directory path from config if needed
            callRecorder = new CallRecorder(recordingBaseName, config.agentId);
            await callRecorder.startRecording(); // Start recording streams
            console.log(`[Handler] Call recording started for agent ${config.agentId}.`);
        } catch (error) {
            console.error("[Handler] Failed to start call recording:", error);
            // Decide how to handle failure - maybe close connection?
            callRecorder = null; // Ensure it's null if failed
        }
        // --- End Recording Setup ---


        console.log(config, "config")

        // Perform any necessary cleanup or state management here

        //I will be attempting to rewrite the orchestration manager here
        //First we need to fetch the Agent from the database
        let publishedAgent;
        if (config.agentId) {
            // If agentId is provided, fetch the DRAFT agent
            publishedAgent = await Agent.findById(config.agentId); // Fetch draft by ID
            console.log(`Handler: Found DRAFT agent by ID: ${config.agentId}`);
        } else if (config.widgetId) {
            console.log(`Handler: No agentId, finding published agent by widgetId: ${config.widgetId}`);
            publishedAgent = await AgentPublishedModel.findOne({ widgetId: config.widgetId });
            if (publishedAgent) {
                config.agentId = publishedAgent._id?.toString(); // Update config with the found PUBLISHED ID
            }
        }

        if (!publishedAgent) {
            const errorMsg = config.agentId
                ? `Could not find agent with ID: ${config.agentId}`
                : `Could not find agent with widget ID: ${config.widgetId}`;
            console.error(`Handler Error: ${errorMsg}`);
            // Handle error appropriately - maybe send a specific message or close connection
            ws.close(1011, "Agent configuration not found.");
            return;
        }

        config.agent = publishedAgent; // Store the fetched published agent in the config
        config.knowledgeBase = publishedAgent.knowledgeBase;
        const agent = publishedAgent; // Use 'agent' variable locally for convenience

        console.log(`Handler using agent: ID=${agent._id}, Name=${agent.name}`);

        //we need to fetch the contact from the database
        let contact;
        
        if(config.contactId){
          contact = await Contact.findOne({_id:config.contactId, agent: config.agentId});
          config.contact = contact;
        }

        //Activity creation
          //we also need to create a new activity
          const activity = new Activity({
            agent: config.agentId,
            contact: config.contactId,
            status: "in-progress",
            workspace: agent.workspace,
            conversationId: config.conversationId,
            source: config.source || "playground",
            user: agent.user,
            contact: contact?._id.toString(),
            conversationMode: mode,
          });
          await activity.save();
          
          // Broadcast activity ID to all connected clients
          wss.clients.forEach(client => {
              if (client !== ws && client.readyState === WebSocket.OPEN) {
                  client.send(JSON.stringify({
                      event: 'activityComplete',
                      activityId: activity._id
                  }));
              }
          });

          config.activityId = activity._id?.toString();


        //lets get the orchestration workflow from the agent
        const orchestrationWorkflow = agent.orchestrationFlow;

       

        // Step 3: Filter nodes using these IDs
        const agentNodes = orchestrationWorkflow.nodes.filter(node =>
          node.type === "agentNode"
        );

        /* Orchestration manager starts*/
        //we initiate the orchestration manager with the connected nodes
        orchestrator = await new OrchestrationManager(config, agentRoomBroker).initialize();

        // Get intentClassifierNode directly from workflow nodes

        // Get all classItem nodes and map them to their connected agents
        const classesWithAgents = orchestrationWorkflow.nodes
          .filter(node => node.type === "classItem")
          .map(classItem => {
            // Find the edge that connects this classItem to an agent
            const edge = orchestrationWorkflow.edges.find(edge => 
              edge.source === classItem.id
            );
            
            // Find the connected agent node
            const connectedAgent = edge ? 
              orchestrationWorkflow.nodes.find(node => 
                node.id === edge.target && node.type === "agentNode"
              ) : null;

              console.log(classItem, "classItem")
            return {
              // Use selectedTopics if available, otherwise fall back to description for legacy support
              selectedTopics: classItem.data?.settings?.selectedTopics,
              description: classItem.data?.settings?.description,
              agent: connectedAgent
            };
          });

        // Initialize IntentClassifier with mapped classes
        intentClassifier = new IntentClassifierAgent({
          aiService: 'openai',
          aiConfig: { temperature: 0.1 },
          customerName: config.customerName,
          conversationId: config.conversationId,
          classes: classesWithAgents, // Replace settings with mapped classes
          agentsData: agentNodes,
          contactData: config.contact,
          kbArtifacts: config.agent?.kbArtifacts || null
        });
        orchestrator.registerAgent(intentClassifier);

  //do we have access to the agent data here?
  //yes we do
        console.log(config.knowledgeBase, "***************knowledgeBase***************")
        for (const node of agentNodes) {
          const dynamicAgent = new BaseAgent(node.data?.settings?.name, {
            type: node.type,
            settings: {
              ...node.data.settings,
              intents: node.data.settings?.intents || [],
              functions: node.data.settings?.functions || [],
              knowledgeBase: config.knowledgeBase || [],
              policies: node.data.settings?.policies || {
                tone: 'friendly',
                language: 'en-US'
              },
              llm: node.data.settings?.llm || {
                provider: 'groq',
                model: ''
              }
            },
            aiService: node.data.settings?.llm?.provider || 'groq',
            aiConfig: {
              temperature: 0.7,
              ...node.data.settings?.llm
            },
            conversationId: config.conversationId,
            contactData: config.contact,
            kbArtifacts: config.agent?.kbArtifacts || null
          });

          orchestrator.registerAgent(dynamicAgent);
          console.log(`Registered dynamic agent: ${node.data.label}`);
        }

        // Send initial greeting via TTS
        const ttsFunction = getTTSService(agent?.ttsSettings?.service);
        const greeting = await orchestrator.process("", {}, "startEvent");
        if (greeting.text) {
          conversationHistory.push({
            speaker: "agent",
            text: greeting.text,
            timestamp: new Date()
          });
          console.log("*****before initial gretting completed****", agentRoomBroker)

          await broadcastToAgentRoom(agentRoomBroker, ws.roomKey, ws, greeting, config.conversationId);
        
          if(mode === "call"){
          await new Promise((resolve, reject) => {
            ttsFunction(greeting.text, ws, streamSid, {...agent?.ttsSettings}, () => {
              console.log(`[${timer()}] TTS completed for: ${greeting.agent}`);
              setTimeout(() => {
                console.log(`[${timer()}] TTS fully completed, ready for next response`);
                resolve();
              }, 0);
            }, true, callRecorder).catch(reject);
          });
          }
        }

        if (mode === "call") {
          recognizeStream = await createSpeechRecognizeStream(config, {
            timer,
            ws,
            wss,
            agentRoomBroker,
            ignoreNewTranscriptions,
            isProcessingTTS,
            processTranscription,
            resetInactivityTimeout,
            inactivityTimeout,
            userInterrupted
          });
        }
        
        // Reset timer only after initial greeting and setup is fully complete
        resetSessionInactivityTimeout();
      }

      if (data.event === "media") {
        const audioChunk = Buffer.from(data.media.payload, "base64");
        recognizeStream?.write(audioChunk);

        // --- Record Incoming Audio ---
        if (callRecorder) {
            callRecorder.recordIncoming(audioChunk);
        }
        // --- End Record Incoming ---
      }

      if (data.event === "stop") {
        recognizeStream.end();
      }

      if(data.event==="chat_message"){
        console.log("*********chat_message*********", data.message)
        await processTranscription(data.message.text)
      }
    });

    ws.on("close",async () => {
      console.log(`[${timer()}] WebSocket connection closed`);
      if (sessionTimeoutId) { // Clear the session timeout if connection closes
          clearTimeout(sessionTimeoutId);
      }

      // Log session end
      if (global.orchestrationLogger && callStartTime) {
        const sessionDuration = Date.now() - callStartTime.getTime();
        await global.orchestrationLogger.logSessionEnd(
          'connection_closed', 
          sessionDuration, 
          conversationHistory.length
        );
      }

      // --- Stop Recording, Upload, and Update Activity --- (Refined)
      if (callRecorder) {
          console.log(`[Handler] Instructing CallRecorder to stop, mix, and potentially upload...`);
          callRecorder.stopAndMix(true)
              .then(async (recordingResult) => { // Receive the result object
                  if (recordingResult) { // Check if result is not null/undefined
                      const { url: recordingUrl, durationSeconds } = recordingResult; // Destructure

                      if (recordingUrl) {
                          console.log(`[Handler] Recording successfully processed and uploaded to: ${recordingUrl}, Duration: ${durationSeconds}s`);
                      } else if (durationSeconds > 0) {
                           console.log(`[Handler] Recording mix completed (Duration: ${durationSeconds}s), but upload skipped or failed.`);
                      } else {
                           console.log(`[Handler] Recording processing complete, but no audio data found (Duration: 0s).`);
                      }


                      // --- Update Activity with callRecording Object --- (Check activityId again)
                      if (config && config.activityId) {
                          try {
                              // Prepare the update object
                              const updateData = {
                                  callRecording: {
                                      url: recordingUrl, // Store URL (null if upload failed/skipped)
                                      durationSeconds: durationSeconds // Store duration
                                  }
                              };

                              const updatedActivity = await Activity.findByIdAndUpdate(
                                  config.activityId,
                                  updateData,
                                  { new: true } // Optional: get updated doc back
                              );
                              if (updatedActivity) {
                                   console.log(`[Handler] Successfully updated Activity ${config.activityId} with callRecording info.`);
                              } else {
                                   console.warn(`[Handler] Activity ${config.activityId} not found during update attempt.`);
                              }
                          } catch (dbError) {
                              console.error(`[Handler] ERROR updating Activity ${config.activityId} with callRecording info:`, dbError);
                          }
                      } else {
                          console.warn("[Handler] config.activityId missing, cannot update Activity with callRecording info.");
                      }
                      // --- End Activity Update ---
                  } else {
                       console.warn("[Handler] CallRecorder stopAndMix resolved with unexpected empty result.");
                  }
              })
              .catch(error => {
                  // Error during mixing or critical failure in stopAndMix
                  console.error(`[Handler] CallRecorder stopAndMix failed critically:`, error);
                  // Optionally update Activity status to 'failed recording' or similar
              })
              .finally(async () => {
                 // ... (existing finally block: clear recorder, call handleCallStopEvent) ...
                 console.log("[Handler] CallRecorder processing finished. Proceeding with final steps.");
                 callRecorder = null;
                 if (config && config.agentId && callStartTime) {
                      await handleCallStopEvent(config, callStartTime, conversationHistory, wss, ws, timer);
                 } else {
                      console.warn("[Handler] Config/agentId/callStartTime missing after recording; skipping handleCallStopEvent.");
                 }
              });
      } else {
          console.log("[Handler] No active call recorder instance found.");
           // --- Call Stop Event Handling (If no recorder was active) ---
           if (config && config.agentId && callStartTime) {
               await handleCallStopEvent(config, callStartTime, conversationHistory, wss, ws, timer);
           } else {
               console.warn("[Handler] Config/agentId/callStartTime missing; skipping handleCallStopEvent.");
           }
           // --- End Call Stop Event Handling ---
      }
      // --- End Recording Logic Block ---

      recognizeStream?.end(); // Ensure recognizeStream is ended if connection closes
      clearTimeout(inactivityTimeout);
    });

    ws.on("error", (error) => {
      console.error(`[${timer()}] WebSocket error:`, error);
      if (sessionTimeoutId) { // Clear the session timeout on error
        clearTimeout(sessionTimeoutId);
      }
       if (callRecorder) {
           // Maybe attempt cleanup without mixing/uploading on fatal error?
           console.warn("[Handler] WebSocket error occurred, attempting recorder cleanup.");
           callRecorder._cleanupTempDir().catch(err => console.error("Error during forced cleanup:", err));
           callRecorder = null;
       }
       recognizeStream?.end(); // Ensure recognizeStream is ended on error too
       clearTimeout(inactivityTimeout);
    });

    function resetInactivityTimeout(transcription) {
      clearTimeout(inactivityTimeout);
      inactivityTimeout = setTimeout(async () => {
        console.log(`[${timer()}] No new transcription for 1 second, processing...`);
        await processTranscription(transcription);
      }, 200);
    }

    // Helper function to reset the session inactivity timeout
    function resetSessionInactivityTimeout() {

      console.log("***********resetSessionInactivityTimeout111***********")
        // Clear any existing timeout before setting a new one
        if (sessionTimeoutId) {
            clearTimeout(sessionTimeoutId);
        }
        console.log("***********resetSessionInactivityTimeout222***********")

        const CURRENT_TIMEOUT_DURATION_MS = 2 * 60 * 1000; // 10 seconds
        sessionTimeoutId = setTimeout(async () => {
            if (ws.readyState === WebSocket.OPEN) {
                console.log(`[Handler] Session inactivity timeout: 10 seconds elapsed. Processing stop event and closing connection for streamSid: ${streamSid}`);
                
                // If it's a voice call, send a stop event to Twilio first
                if (mode === "call" && streamSid) {
                    try {
                        console.log(`[Handler] Session timeout: Sending stop event to Twilio for streamSid: ${streamSid}`);
                        ws.send(JSON.stringify({
                            event: "stop",
                            streamSid: streamSid
                        }));
                    } catch (twilioStopError) {
                        console.error("[Handler] Session timeout: Error sending stop event to Twilio:", twilioStopError);
                    }
                }

                if (config && config.agentId && callStartTime) {
                    try {
                        console.log("[Handler] Session inactivity timeout: Calling handleCallStopEvent.");
                        await handleCallStopEvent(config, callStartTime, conversationHistory, wss, ws, timer);
                    } catch (stopEventError) {
                        console.error("[Handler] Session inactivity timeout: Error during handleCallStopEvent:", stopEventError);
                    }
                } else {
                    console.warn("[Handler] Session inactivity timeout: Config/agentId/callStartTime missing; skipping handleCallStopEvent.");
                }
                ws.send(JSON.stringify({
                    event: "webhook_closed",
                    reason: "session_timeout_10_seconds_inactivity",
                    streamSid: streamSid, 
                    conversationId: config ? config.conversationId : undefined 
                }));
                ws.close(1000, "Session timed out after 10 seconds of inactivity");
            }
        }, CURRENT_TIMEOUT_DURATION_MS);
        // console.log(`[Handler] Session inactivity timer reset for ${CURRENT_TIMEOUT_DURATION_MS / 1000}s. ID: ${sessionTimeoutId}`);
    }

    async function processTranscription(transcription) {
      // Clear any pending session timeout, as server is now actively processing.
      // This is important if STT inactivity calls this directly.
      if (sessionTimeoutId) {
        clearTimeout(sessionTimeoutId);
        // console.log("[Handler] Cleared session inactivity timer at start of processTranscription.");
      }

      console.log(`[${timer()}] Processing transcription: "${transcription}"`);

      ignoreNewTranscriptions = true;
      // recognizeStream?.pause();
      callRecorder?.pauseIncoming();

      // Initialize full orchestration


      
      // Register the existing IntentClassifier instance
      orchestrator.registerAgent(intentClassifier);

   

      // Add to conversation history
      conversationHistory.push({
        speaker: "user",
        text: transcription,
        timestamp: new Date()
      });

      console.log(conversationHistory, "conversationHistory")

      registerOrchestratorHandlers(orchestrator, ws, wss, streamSid, config, timer, conversationHistory, agentRoomBroker, config.agent, callRecorder, userInterrupted);

      try {

      
        // Process the transcription through all agents
       const response = await orchestrator.process(transcription, conversationHistory);
        conversationHistory.push({
          speaker: "agent",
          text: response.text,
          timestamp: new Date()
        })
      } catch (error) {
        console.error("Error in orchestration:", error);
      } finally {
        // Reset state
        ignoreNewTranscriptions = false;
        // if (mode === "call"){
        //   console.log(`[${timer()}] Ready for new transcriptions, restarting stream`);
        //   recognizeStream = await createSpeechRecognizeStream(config, {
        //     timer,
        //     ws,
        //     wss,
        //     ignoreNewTranscriptions,
        //     isProcessingTTS,
        //     processTranscription,
        //     resetInactivityTimeout,
        //     inactivityTimeout
        //   });
        // }
        // Reset inactivity timer only after all processing for this turn is complete
        resetSessionInactivityTimeout();
      }
    }
  }
function startTimer() {
  const startTime = Date.now();
  return () => `${((Date.now() - startTime) / 1000).toFixed(2)}s`;
}

async function broadcastToAgentRoom(agentRoomBroker, roomKey, ws, response, conversationId) {
  if (agentRoomBroker.hasRoom(roomKey)) {
    // Get conversation state directly
    const state = await require('../services/ConversationState').getInstance(conversationId);
    
    // Send the original message
    await agentRoomBroker.broadcast(roomKey, {
      event: "transcription",
      text: response.text,
      source: response.agent === "user" ? "user" : "assistant",
      priority: response.priority
    });

    // Send state as a separate event
    await agentRoomBroker.broadcast(roomKey, {
      event: "conversationState",
      state: {
        phase: state.conversationPhase,
        currentAgent: state.currentAgent,
        memoryState: state.getMemoryState()
      }
    });
  }
}

function registerOrchestratorHandlers(orchestrator, ws, wss, streamSid, config, timer, conversationHistory, agentRoomBroker, agent, callRecorder, userInterrupted) {
  // Register general response handler (for UI updates)
  orchestrator.onResponse({
    type: 'general',
    callback: (response) => {
      // conversationHistory.push({
      //   speaker: "agent",
      //   text: response.text,
      //   timestamp: new Date()
      // });
      
      // Replace the broadcasting code with the new function
              broadcastToAgentRoom(agentRoomBroker, ws.roomKey, ws, response, config.conversationId);
    }
  });

  // Register TTS-specific handler
  orchestrator.onResponse({
    type: 'tts',
    callback: async (response) => {
      try {
        // Reset interruption flag when starting new TTS
        userInterrupted.value = false;
        
        await new Promise((resolve, reject) => {
          console.log(response.shouldUseAudio, typeof response.audio, "response audio")
          if (response.shouldUseAudio && response.audio) {
            const outgoingAudioChunk = Buffer.from(response.audio);
            // --- Record direct outgoing audio buffer ---
            if (callRecorder) {
                callRecorder.recordOutgoing(outgoingAudioChunk);
            }
            // --- End record direct audio buffer ---

            ws.send(JSON.stringify({
              event: 'media',
              streamSid: streamSid,
              media: {
                payload: outgoingAudioChunk.toString('base64')
              }
            }));
            
            setTimeout(() => {
              console.log(`[${timer()}] Direct audio playback completed for: ${response.agent}`);
              resolve();
            }, 0);
          } else {
            // Fallback to TTS
            const ttsFunction = getTTSService(agent?.ttsSettings?.service);
            // Pass callRecorder instance and interruption checker to TTS function
            ttsFunction(response.text, ws, streamSid, { ...agent?.ttsSettings }, () => {
              console.log(`[${timer()}] TTS completed for: ${response.agent}`);
              resolve();
            }, true, callRecorder, userInterrupted).catch(reject); // <-- Pass userInterrupted
          }
        });
      } catch (error) {
        console.error("Error in audio/TTS processing:", error);
        throw error; 
      }
    }
  });
}

module.exports = handleTwilioConnection;
