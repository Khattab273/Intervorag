const removeMarkdown = require('remove-markdown');
const ConversationState = require('./ConversationState');

class OrchestrationManager {
constructor(config, agentRoomBroker) {

  console.log("*********orchestartionNodes*********", config, agentRoomBroker)
    this.agents = new Map();
    this.workflowAgents = new Map(); // Map nodeId -> BaseAgent instance

    this.responseCallbacks = new Map();
    this.ttsQueue = [];
    this.isProcessingTTS = false;
    
    this.config = config;
    this.agentRooms = agentRoomBroker;
    this.logger = null; // Will be initialized when we have conversationId
    this.toolManager = null; // Will be initialized dynamically
    this.orchestrationFlow = null;
  }

  // Add a new async initialization method
async initialize() {
    // Initialize ES module dependencies dynamically
    const { default: ConversationLogger } = await import('./ConversationLogger.js');
    const { default: ToolManager } = await import('./ToolManager.js');
    
    this.toolManager = new ToolManager();
    
    if (this.config?.conversationId) {
        this.conversationId = this.config.conversationId;
        this.state = await ConversationState.getInstance(this.conversationId);
        
        // Initialize conversation logger
        this.logger = new ConversationLogger(this.conversationId);
        
        // Make logger globally accessible for agents
        global.orchestrationLogger = this.logger;
        
        console.log('OrchestrationManager initialized with logger for conversation:', this.conversationId);
    }

    // Load and initialize workflow if agent configuration is provided
    if (this.config?.agentId) {
        await this.loadAgentWorkflow(this.config.agentId);
    }
    
    return this;
}

// Load agent's orchestration workflow from database
async loadAgentWorkflow(agentId) {
    try {
        const Agent = require('../models/Agent');
        const agent = await Agent.findById(agentId);
        
        if (agent && agent.orchestrationFlow) {
            console.log(`Loading orchestration workflow for agent ${agentId}`);
            this.initializeWorkflow(agent.orchestrationFlow);
        } else {
            console.log(`No orchestration workflow found for agent ${agentId}`);
        }
    } catch (error) {
        console.error('Error loading agent workflow:', error);
    }
}


  registerAgent(agent) {
    this.agents.set(agent.name, agent);
    
    // Inject tool manager into the agent
    if (agent.setToolManager) {
      agent.setToolManager(this.toolManager);
    }
  }

  onResponse({ type, callback }) {
    if (!this.responseCallbacks.has(type)) {
      this.responseCallbacks.set(type, new Set());
    }
    const callbacks = this.responseCallbacks.get(type);
    if (!Array.from(callbacks).some(cb => cb.toString() === callback.toString())) {
      callbacks.add(callback);
    }
  }

  async process(input, conversationHistory, eventPhase) {
    console.log(input, "input prompts")
    // Ensure we have initialized state
    if (!this.state) {
      throw new Error('OrchestrationManager not properly initialized');
    }

    const startTime = Date.now();

    try {
      // Log user input
      if (this.logger && input) {
        await this.logger.logUserInput(input);
      }

      // 1. Collect responses from all agents (both registered and workflow agents) in parallel
      const allAgents = [
        ...Array.from(this.agents.values()), // Traditional registered agents
        ...Array.from(this.workflowAgents.values()) // Workflow-based agents
      ];
      
      const agentPromises = allAgents.map(async agent => {
        try {
          const agentStartTime = Date.now();

          // Each agent gets the input and current conversation state
          const response = await agent.process(input, {
            phase: this.state.conversationPhase,
            currentAgent: this.state.currentAgent,
            memoryState: this.state.getMemoryState(),
            conversationHistory: conversationHistory
          }, eventPhase, this.agentRooms);

          const agentProcessingTime = Date.now() - agentStartTime;

          // Log agent response
          if (this.logger) {
            await this.logger.logAgentResponse(agent.name, input, response, agentProcessingTime);
          }

          return {
            agent: agent.name,
            response
          };
        } catch (error) {
          console.error(`Error processing with agent ${agent.name}:`, error);
          
          // Log error
          if (this.logger) {
            await this.logger.logError('agent_processing_error', error, { 
              agentName: agent.name, 
              input: input 
            });
          }
          
          return null;
        }
      });

      // 2. Wait for all agents to respond
      const agentResponses = (await Promise.all(agentPromises))
        .filter(response => response !== null);

      // 3. Get intent classifier's response specifically
      const intentClassifierResponse = agentResponses.find(
        response => response.agent === 'intent-classifier'
      );

      // Log intent classification
      if (this.logger && intentClassifierResponse) {
        const availableAgents = Array.from(this.agents.keys()).filter(name => name !== 'intent-classifier');
        await this.logger.logIntentClassification(
          input, 
          intentClassifierResponse.response, 
          availableAgents
        );
      }

      // 4. Filter valid responses (exclude intent classifier)
      const validResponses = agentResponses.filter(response => 
        response.agent !== 'intent-classifier'
      );

      // 5. Select best response based on classifier recommendation or confidence scores
      let selectedResponse;
      let selectionReason = 'confidence_based';
      
      if (intentClassifierResponse?.response?.classifier?.bestAgent) {
        // Use the classifier's recommended agent
        selectedResponse = validResponses.find(response => 
          response.agent === intentClassifierResponse.response.classifier.bestAgent
        );
        selectionReason = 'intent_classifier_recommendation';
        
        // Fallback to confidence-based selection if recommended agent didn't respond
        if (!selectedResponse) {
          selectedResponse = validResponses.find(response => 
            response.response?.canProcess
          );
          selectionReason = 'fallback_confidence_based';
        }
      } else {
        // Fallback to traditional confidence-based selection
        const processableResponses = validResponses.filter(response => 
          response.response?.canProcess
        );
        
        selectedResponse = processableResponses.reduce((best, current) => {
          return (current.response.confidence > best.response.confidence) 
            ? current 
            : best;
        }, processableResponses[0]);
        selectionReason = 'confidence_based_fallback';
      }

      // Log agent selection
      if (this.logger) {
        await this.logger.logAgentSelection(selectedResponse, validResponses, selectionReason);
      }

      // 6. Update conversation state with selected agent
      if (selectedResponse) {
        this.state.currentAgent = selectedResponse.agent;
        
        // Log conversation state
        if (this.logger) {
          await this.logger.logConversationState(this.state);
        }
        
        // First handle the immediate response (which might be backchannel)
        await this.queueTTSResponse(selectedResponse.response);

        // If this response has a KB promise, wait for it and process it
        if (selectedResponse.response.kbRequired && selectedResponse.response.kbResponse) {
          try {
            const kbStartTime = Date.now();
            const kbResult = await selectedResponse.response.kbResponse;
            const kbProcessingTime = Date.now() - kbStartTime;
            
            // Log knowledge base usage
            if (this.logger) {
              await this.logger.logKnowledgeBaseUsage(
                selectedResponse.agent,
                input,
                selectedResponse.response.knowledgeBase?.sources || [],
                kbResult.text || kbResult,
                kbProcessingTime
              );
            }
            
            // Queue the KB response after the backchannel
            await this.queueTTSResponse({
              ...selectedResponse.response,
              text: kbResult.text || kbResult, // Handle both object and string responses
              priority: 'normal',
              order: 2, // Ensure it comes after backchannel
              kbRequired: false // Prevent recursion
            });
            
            // Return the KB response as the final response
            return {
              ...selectedResponse.response,
              text: kbResult.text || kbResult,
              kbRequired: false
            };
          } catch (error) {
            console.error('Error processing KB response:', error);
            
            // Log KB error
            if (this.logger) {
              await this.logger.logError('knowledge_base_error', error, {
                agentName: selectedResponse.agent,
                input: input
              });
            }
            
            // If KB processing fails, return the original response
            return selectedResponse.response;
          }
        }
      }

      return selectedResponse?.response;
      
    } catch (error) {
      console.error('Error in orchestration process:', error);
      
      // Log orchestration error
      if (this.logger) {
        await this.logger.logError('orchestration_process_error', error, {
          input: input,
          eventPhase: eventPhase,
          processingTimeMs: Date.now() - startTime
        });
      }
      
      throw error;
    }
  }

  selectBestResponse(validResponses, intentClassifierResponse) {
    // Combine confidence scores with intent classification
    const scoredResponses = validResponses.map(response => ({
      ...response,
      finalScore: (
        response.response.confidence * 0.6 + // Agent's confidence
        intentClassifierResponse.confidence * 0.4 // Intent classifier's confidence
      )
    }));

    // Return response with highest final score
    return scoredResponses.reduce((best, current) => {
      return (current.finalScore > best.finalScore) ? current : best;
    }, scoredResponses[0]);
  }

  async queueTTSResponse(response) {
    // Always notify general listeners regardless of mode
    this.notifyListeners('general', response);

    // Skip TTS processing in chat mode
    if (this.config.mode === 'chat') {
      console.log("skipping TTS processing in chat mode")
      return;
    }

    // Add to TTS queue with priority and ordering
    this.ttsQueue.push(response);
    
    this.ttsQueue.sort((a, b) => {
      // Sort by priority first (immediate before delayed)
      if (a.priority !== b.priority) {
        return a.priority === 'immediate' ? -1 : 1;
      }
      // Then by order
      return a.order - b.order;
    });

    // Start processing the queue if not already processing
    if (!this.isProcessingTTS) {
      await this.processTTSQueue();
    }
  }

  async processTTSQueue() {
    if (this.isProcessingTTS || this.ttsQueue.length === 0) return;

    this.isProcessingTTS = true;
    
    try {
      while (this.ttsQueue.length > 0) {
        const response = this.ttsQueue.shift();
      
        // Wait for TTS to fully complete
        const callbacks = this.responseCallbacks.get('tts');

        if (callbacks) {
          for (const callback of callbacks) {
            try {
              // Create a copy for TTS with plain text
              const ttsResponse = { ...response };
              if (ttsResponse.text) {
                ttsResponse.text = removeMarkdown(ttsResponse.text);
              }
              
              await callback({
                ...ttsResponse,
                shouldUseAudio: !!ttsResponse.audio // Flag to indicate audio availability
              });
            } catch (error) {
              // Don't let individual TTS errors stop the entire queue processing
              // Interruption errors are normal and shouldn't break the queue
              console.error(`TTS callback error (continuing queue processing):`, error.message);
              this.isProcessingTTS = false;
            }
          }
        }
      }
    } catch (error) {
      console.error('Error in TTS queue processing:', error);
    } finally {
      this.isProcessingTTS = false;
      console.log('TTS Queue processing complete');
    }
  }

  notifyListeners(type, response) {
    const callbacks = this.responseCallbacks.get(type);
   
    if (callbacks) {
      callbacks.forEach(callback => {
        try {
          callback(response);
        } catch (error) {
          console.error(`Error in ${type} callback:`, error);
        }
      });
    }
  }

  // Initialize workflow agents and their tools
 async initializeWorkflow(orchestrationFlow) {
    if (!orchestrationFlow || !orchestrationFlow.nodes) {
      console.log('No orchestration flow provided');
      return;
    }

    this.orchestrationFlow = orchestrationFlow;
    console.log('Initializing workflow with', orchestrationFlow.nodes.length, 'nodes');

    // Create BaseAgent instances for each node
    orchestrationFlow.nodes.forEach(node => {
      if (this.isAgentNode(node)) {
        const agent = this.createAgentFromNode(node);
        if (agent) {
          this.workflowAgents.set(node.id, agent);
          console.log(`Created workflow agent for node ${node.id}: ${agent.name}`);
        }
      }
    });

    // Initialize tools for the entire workflow (pass agentId for credential loading)
    await this.toolManager.initializeFromWorkflow(orchestrationFlow, this.config?.agentId);
    
    // Inject specific tools into specific agents
    await this.assignToolsToAgents();
    
    console.log('Workflow initialized with agents:', Array.from(this.workflowAgents.keys()));
    console.log('Tools health:', this.toolManager.getToolsHealth());
  }

  isAgentNode(node) {
    // Determine if a node represents an agent (vs other node types like connectors)
    return node.type === 'agent' || 
           node.type === 'customNode' || 
           (node.data && node.data.settings && node.data.settings.type);
  }

  createAgentFromNode(node) {
    const { BaseAgent } = require('../agents/BaseAgent');
    
    const nodeSettings = node.data?.settings || {};
    const agentConfig = {
      type: nodeSettings.type || 'workflow-agent',
      settings: {
        ...nodeSettings,
        nodeId: node.id,
        workflowNode: true
      },
      aiService: nodeSettings.aiService || 'groq',
      aiConfig: nodeSettings.aiConfig || {
        temperature: 0.7,
        maxTokens: 150
      }
    };

    const agentName = nodeSettings.name || `workflow-agent-${node.id}`;
    const agent = new BaseAgent(agentName, agentConfig);
    
    // Store reference to the node
    agent.nodeId = node.id;
    agent.nodeData = node.data;
    
    return agent;
  }

  async assignToolsToAgents() {
    // Assign tools to specific agents based on their node configuration
    const { default: ToolManager } = await import('./ToolManager.js');
    
    for (const node of this.orchestrationFlow.nodes) {
      const agent = this.workflowAgents.get(node.id);
      if (!agent) continue;

      // Check if this node has tools defined
      const nodeTools = node.data?.settings?.tools || [];
      const nodeTool = node.data?.settings?.tool;
      
      if (nodeTools.length > 0 || nodeTool) {
        // Create a node-specific tool manager for this agent
        const nodeToolManager = new ToolManager();
        
        // Initialize tools for this specific node
        const nodeFlow = {
          nodes: [node], // Only this node
          edges: []
        };
        await nodeToolManager.initializeFromWorkflow(nodeFlow, this.config?.agentId);
        
        // Inject the node-specific tool manager
        agent.setToolManager(nodeToolManager);
        
        console.log(`Assigned ${nodeToolManager.getAllTools().length} tools to agent ${agent.name} (node ${node.id})`);
      } else {
        // Agent has no tools
        console.log(`Agent ${agent.name} (node ${node.id}) has no tools defined`);
      }
    }
  }

  // Get workflow agent by node ID
  getWorkflowAgent(nodeId) {
    return this.workflowAgents.get(nodeId);
  }

  // Get all workflow agents
  getWorkflowAgents() {
    return Array.from(this.workflowAgents.values());
  }

  // Get tool manager for external access
  getToolManager() {
    return this.toolManager;
  }

  // When the conversation ends
  cleanup() {
    ConversationState.cleanup(this.conversationId);
  }
}

module.exports = OrchestrationManager;
