const express = require("express");
const router = express.Router();
const Source = require("../models/KnowledgeSource");
const axios = require("axios");
const User = require("../models/User");
const multer = require("multer");
const authenticateUser = require("../lib/authMiddleware");
const { apiLimiter } = require("../lib/rateLimitMiddleware");
const { verifySourceWorkspace } = require("../lib/checkOwnership");
const { getWorkspaceAndOwner } = require('../lib/workspaceUtils');
const Agent = require("../models/Agent");


// Apply rate limiting and authentication middleware to all routes
router.use(apiLimiter);
router.use(authenticateUser);

// Configuration for Python API
const PYTHON_API_URL = "http://0.0.0.0:4003";

const pythonClient = axios.create({
    baseURL: PYTHON_API_URL,
    headers: {
        "Content-Type": "application/json",
    },
});

// Configure multer for file uploads
const storage = multer.memoryStorage();
const upload = multer({ storage });

// Create a new knowledge source
router.post("/", async (req, res) => {
    try {
        const { name, description } = req.body;
        
        // Fetch user and populate necessary workspace info
        const user = await User.findById(req.user.id).populate("defaultWorkspace").populate("lastActiveWorkspace");
        
        // Determine the correct workspace and owner
        const { workspaceId, ownerId, error: workspaceError } = getWorkspaceAndOwner(user);

        if (workspaceError) {
            console.error(`Error getting workspace for user ${req.user.id} during source creation: ${workspaceError}`);
            return res.status(400).json({ error: workspaceError });
        }

        // Create source in our database using the determined IDs
        const source = new Source({
            user: ownerId,         // Use ownerId from utility
            workspace: workspaceId,  // Use workspaceId from utility
            name,
            description,
        });

        await source.save();
        res.status(201).json(source);
    } catch (error) {
        console.error("Error creating knowledge source:", error);
        res.status(500).json({ error: error.message });
    }
});

// Add text content to a source
router.post("/sources/:sourceId/text", async (req, res) => {
    try {
        const { text } = req.body;
        const source = await verifySourceWorkspace(
            req.params.sourceId,
            req.user.id
        );
        if (!source) {
            return res.status(404).json({ error: "Source not found or unauthorized" });
        }

        // Send text to Python API
        await pythonClient.post(`/documents/${source._id}/text`, {
            text: text,
            metadata: {}
        });

        // Mark source as needing training
        await markSourceAsNeedsTraining(source._id);

        res.status(200).json({ message: "Text added successfully" });
    } catch (error) {
        console.error(error);
        if (error?.response?.data) {
            res.status(500).json({ error: error.response.data.detail || error.response.data.message });
            return;
        }
        res.status(500).json({ error: error.message });
    }
});

// Fetch text from a source
router.get("/sources/:sourceId/text", async (req, res) => {
    try {
        const source = await verifySourceWorkspace(
            req.params.sourceId,
            req.user.id
        );
        if (!source) {
            return res.status(404).json({ error: "Source not found or unauthorized" });
        }

        // Get text from Python API - using the correct endpoint
        const response = await pythonClient.get(`/documents/${source._id}/text`);
        
        // The Python API returns the content directly in the data.content field
        const data = response.data?.data;
        res.status(200).json({ 
            message: "success", 
            text: data?.content || "" 
        });
    } catch (error) {
        console.error(error);
        if (error?.response?.data) {
            res.status(500).json({ error: error.response.data.detail || error.response.data.message });
            return;
        }
        res.status(500).json({ error: error.message });
    }
});

// Add FAQ to a source
router.post("/sources/:sourceId/faq", async (req, res) => {
    try {
        const { questions } = req.body; // Array of {question, answer}
        const source = await verifySourceWorkspace(
            req.params.sourceId,
            req.user.id
        );
        if (!source) {
            return res.status(404).json({ error: "Source not found or unauthorized" });
        }

        // Send QA pairs to Python API
        await pythonClient.post(`/documents/${source._id}/qa`, {
            qa_pairs: questions,
            metadata: {}
        });

        // Mark source as needing training
        await markSourceAsNeedsTraining(source._id);

        res.status(200).json({ message: "FAQs added successfully" });
    } catch (error) {
        console.error(error);
        if (error?.response?.data) {
            res.status(500).json({ error: error.response.data.detail || error.response.data.message });
            return;
        }
        res.status(500).json({ error: error.message });
    }
});

// Fetch all FAQs from a source
router.get("/sources/:sourceId/faq", async (req, res) => {
    try {
        const source = await verifySourceWorkspace(
            req.params.sourceId,
            req.user.id
        );
        if (!source) {
            return res.status(404).json({ error: "Source not found or unauthorized" });
        }

        // Get FAQs from Python API
        const response = await pythonClient.get(`/documents/${source._id}/qa`);
        
        const data = response.data?.data;
        res.status(200).json({ 
            message: "success", 
            faqs: data?.content?.qa_pairs || []
        });
    } catch (error) {
        console.error(error);
        if (error?.response?.data) {
            res.status(500).json({ error: error.response.data.detail || error.response.data.message });
            return;
        }
        res.status(500).json({ error: error.message });
    }
});

// Upload files to a source
router.post("/sources/:sourceId/files", upload.array("files"), async (req, res) => {
    try {
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ error: "No files uploaded" });
        }

        const source = await verifySourceWorkspace(
            req.params.sourceId,
            req.user.id
        );
        if (!source) {
            return res.status(404).json({ error: "Source not found or unauthorized" });
        }

        // Create form data for Python API
        const formData = new FormData();
        for (const file of req.files) {
            formData.append("files", new Blob([file.buffer], { type: file.mimetype }), file.originalname);
        }
        if (req.body.metadata) {
            formData.append("metadata", req.body.metadata);
        }

        // Send files to Python API
        const response = await pythonClient.post(
            `/documents/${source._id}/files`,
            formData,
            {
                headers: {
                    "Content-Type": "multipart/form-data",
                },
            }
        );

        // Mark source as needing training
        await markSourceAsNeedsTraining(source._id);

        res.status(200).json({
            message: "Files uploaded successfully",
            data: response.data
        });
    } catch (error) {
        console.error(error);
        if (error?.response?.data) {
            res.status(500).json({ error: error.response.data.detail || error.response.data.message });
            return;
        }
        res.status(500).json({ error: error.message });
    }
});

// List all files from a source
router.get("/sources/:sourceId/files", async (req, res) => {
    try {
        const source = await verifySourceWorkspace(
            req.params.sourceId,
            req.user.id
        );
        if (!source) {
            return res.status(404).json({ error: "Source not found or unauthorized" });
        }

        // Get files from Python API
        const response = await pythonClient.get(`/documents/${source._id}/files/list`);
        
        res.status(200).json({
            message: "success",
            files: response.data?.data?.files || []
        });
    } catch (error) {
        console.error(error);
        if (error?.response?.data) {
            res.status(500).json({ error: error.response.data.detail || error.response.data.message });
            return;
        }
        res.status(500).json({ error: error.message });
    }
});

// Add website and crawl
router.post("/sources/:sourceId/crawl", async (req, res) => {
    try {
        const { url, max_depth, max_pages } = req.body;
        const source = await verifySourceWorkspace(
            req.params.sourceId,
            req.user.id
        );
        if (!source) {
            return res.status(404).json({ error: "Source not found or unauthorized" });
        }

        // Send crawl request to Python API
        const response = await pythonClient.post("/crawl", {
            knowledgebase_id: source._id,
            url,
            max_depth,
            max_pages
        });

        // Mark source as needing training
        await markSourceAsNeedsTraining(source._id);

        res.status(200).json({
            message: "Website crawling initiated",
            links: response.data?.data?.files || [],
           
        });
    } catch (error) {
        console.error(error);
        if (error?.response?.data) {
            res.status(500).json({ error: error.response.data.detail || error.response.data.message });
            return;
        }
        res.status(500).json({ error: error.message });
    }
});

// Crawl next set of pages
router.post("/sources/:sourceId/crawl-next", async (req, res) => {
    try {
        const { max_pages } = req.body;
        const source = await verifySourceWorkspace(
            req.params.sourceId,
            req.user.id
        );
        if (!source) {
            return res.status(404).json({ error: "Source not found or unauthorized" });
        }

        // Send crawl-next request to Python API
        const response = await pythonClient.post("/crawl-next", {
            knowledgebase_id: source._id,
            max_pages
        });

        // Mark source as needing training
        await markSourceAsNeedsTraining(source._id);

        res.status(200).json({
            message: "Additional pages crawling initiated",
            data: {
                ...response.data,
                links: response.data?.data?.files || []
            }
        });
    } catch (error) {
        console.error(error);
        if (error?.response?.data) {
            res.status(500).json({ error: error.response.data.detail || error.response.data.message });
            return;
        }
        res.status(500).json({ error: error.message });
    }
});

// Recrawl existing pages
router.post("/sources/:sourceId/recrawl", async (req, res) => {
    try {
        const source = await verifySourceWorkspace(
            req.params.sourceId,
            req.user.id
        );
        if (!source) {
            return res.status(404).json({ error: "Source not found or unauthorized" });
        }

        // Send recrawl request to Python API
        const response = await pythonClient.post("/recrawl", {
            knowledgebase_id: source._id
        });

        // Mark source as needing training
        await markSourceAsNeedsTraining(source._id);

        res.status(200).json({
            message: "Website recrawling initiated",
                links: response.data?.data?.files || []
            
        });
    } catch (error) {
        console.error(error);
        if (error?.response?.data) {
            res.status(500).json({ error: error.response.data.detail || error.response.data.message });
            return;
        }
        res.status(500).json({ error: error.message });
    }
});

// Fetch all crawled links
router.get("/sources/:sourceId/links", async (req, res) => {
    try {
        const source = await verifySourceWorkspace(
            req.params.sourceId,
            req.user.id
        );
        if (!source) {
            return res.status(404).json({ error: "Source not found or unauthorized" });
        }

        // Get crawled documents from Python API
        const response = await pythonClient.get(`/documents/${source._id}/crawled/list`);
        
        res.status(200).json({
            message: "success",
            links: response.data?.data?.files || []
        });
    } catch (error) {
        console.error(error);
        if (error?.response?.data) {
            res.status(500).json({ error: error.response.data.detail || error.response.data.message });
            return;
        }
        res.status(500).json({ error: error.message });
    }
});

// Delete multiple URLs from a source
router.post("/sources/:sourceId/delete-urls", async (req, res) => {
    try {
        const { urls } = req.body;
        const source = await verifySourceWorkspace(
            req.params.sourceId,
            req.user.id
        );
        if (!source) {
            return res.status(404).json({ error: "Source not found or unauthorized" });
        }

        // Send delete request to Python API
        const response = await pythonClient.post("/delete-urls", {
            knowledgebase_id: source._id,
            urls
        });

        // Mark source as needing training since content was removed
        await markSourceAsNeedsTraining(source._id);

        res.status(200).json(response.data);
    } catch (error) {
        console.error(error);
        if (error?.response?.data) {
            res.status(500).json({ error: error.response.data.detail || error.response.data.message });
            return;
        }
        res.status(500).json({ error: error.message });
    }
});

// Delete multiple files by filename
router.post("/sources/:sourceId/delete-files", async (req, res) => {
    try {
        const { filenames } = req.body;
        const source = await verifySourceWorkspace(
            req.params.sourceId,
            req.user.id
        );
        if (!source) {
            return res.status(404).json({ error: "Source not found or unauthorized" });
        }

        // Send delete request to Python API
        const response = await pythonClient.post("/delete-files", {
            knowledgebase_id: source._id,
            filenames
        });

        // Mark source as needing training since content was removed
        await markSourceAsNeedsTraining(source._id);

        res.status(200).json(response.data);
    } catch (error) {
        console.error(error);
        if (error?.response?.data) {
            res.status(500).json({ error: error.response.data.detail || error.response.data.message });
            return;
        }
        res.status(500).json({ error: error.message });
    }
});

// Train/retrain with RAG
router.post("/sources/:sourceId/train", async (req, res) => {
    try {
        const source = await verifySourceWorkspace(
            req.params.sourceId,
            req.user.id
        );
        if (!source) {
            return res.status(404).json({ error: "Source not found or unauthorized" });
        }

        // Fetch the agent associated with this knowledge source
        let agentPrompt = null;
        try {
            const agent = await Agent.findOne({ "knowledgeBase.sources": source._id }).lean();
            if (agent && agent.prompt) {
                agentPrompt = agent.prompt;
                console.log(`Found agent prompt for source ${source._id}: ${agentPrompt}`);
            } else {
                console.log(`No agent or agent prompt found for source ${source._id}`);
            }
        } catch (agentError) {
            console.error(`Error fetching agent for source ${source._id}:`, agentError);
            // Continue without agent_prompt if an error occurs
        }

        // Send train request to Python API
        const pythonPayload = {
            knowledgebase_id: source._id.toString(), // Ensure it's a string
            config: req.body.config
        };

        if (agentPrompt) {
            pythonPayload.agent_prompt = agentPrompt;
        }

        const response = await pythonClient.post("/train", pythonPayload);

        // Store the knowledge_base_summary and topics in the Agent model
        if (response.data && response.data.knowledge_base_summary) {
            const kbSummaryData = response.data.knowledge_base_summary;
            try {
                const agentToUpdate = await Agent.findOne({ "knowledgeBase.sources": source._id });
                if (agentToUpdate) {
                    agentToUpdate.kbArtifacts = {
                        summary: {
                            overall_theme: kbSummaryData.overall_theme,
                            key_topics_entities: kbSummaryData.key_topics_entities,
                            content_overview: kbSummaryData.content_overview,
                            estimated_detail_level: kbSummaryData.estimated_detail_level,
                            error_details: kbSummaryData.error_details // Will be undefined if no error
                        },
                        topics: kbSummaryData.knowledge_base_topics || [], // Ensure topics is an array
                        lastTrained: new Date()
                    };
                    await agentToUpdate.save();
                    console.log(`Successfully saved kbArtifacts for agent ${agentToUpdate._id}`);
                } else {
                    console.warn(`Could not find agent associated with source ${source._id} to save kbArtifacts.`);
                }
            } catch (saveError) {
                console.error(`Error saving kbArtifacts to agent for source ${source._id}:`, saveError);
                // Do not fail the entire request if saving artifacts fails, but log it.
            }
        }

        // Reset the needsTraining flag since training completed successfully
        try {
            await Source.findByIdAndUpdate(source._id, { needsTraining: false });
            console.log(`Reset needsTraining flag for source ${source._id} after successful training`);
        } catch (resetError) {
            console.error(`Error resetting needsTraining flag for source ${source._id}:`, resetError);
            // Don't fail the entire request if this fails
        }

        res.status(200).json({
            message: "Training completed successfully",
            data: response.data
        });
    } catch (error) {
        console.error(error);
        if (error?.response?.data) {
            res.status(500).json({ error: error.response.data.detail || error.response.data.message });
            return;
        }
        res.status(500).json({ error: error.message });
    }
});

// Get all sources
router.get("/sources", async (req, res) => {
    try {
        // Fetch user and populate necessary workspace info
        const user = await User.findById(req.user.id)
                              .populate('lastActiveWorkspace') 
                              .populate('defaultWorkspace');   

        // Determine the correct workspace using the utility function
        const { workspaceId, error: workspaceError } = getWorkspaceAndOwner(user);

        // Handle cases where workspace couldn't be determined
        if (workspaceError) {
            console.error(`Error getting workspace for user ${req.user.id} when listing sources: ${workspaceError}`);
            return res.status(400).json({ 
                error: workspaceError 
            });
        }

        // Find sources associated with the determined workspace
        const sources = await Source.find({ workspace: workspaceId });
        res.json(sources);
    } catch (error) {
        console.error("Error fetching knowledge sources:", error);
        res.status(500).json({ error: "Failed to fetch knowledge sources", details: error.message });
    }
});

// Get a specific source
router.get("/sources/:sourceId", async (req, res) => {
    try {
        const source = await verifySourceWorkspace(
            req.params.sourceId,
            req.user.id
        );
        if (!source) {
            return res.status(404).json({ error: "Source not found or unauthorized" });
        }

        res.json(source);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Update a source
router.put("/sources/:sourceId", async (req, res) => {
    try {
        const { name, description } = req.body;
        const source = await verifySourceWorkspace(
            req.params.sourceId,
            req.user.id
        );
        if (!source) {
            return res.status(404).json({ error: "Source not found or unauthorized" });
        }

        source.name = name;
        source.description = description;
        source.updatedAt = Date.now();
        await source.save();

        res.json(source);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Delete a source
router.delete("/sources/:sourceId", async (req, res) => {
    try {
        const source = await verifySourceWorkspace(
            req.params.sourceId,
            req.user.id
        );
        if (!source) {
            return res.status(404).json({ error: "Source not found or unauthorized" });
        }

        // Delete from MongoDB
        await Source.findByIdAndDelete(req.params.sourceId);

        // Delete from S3 storage
        try {
            await pythonClient.delete(`/knowledgebase/${source._id}`);
        } catch (storageError) {
            console.error("Error deleting storage:", storageError);
            // Continue with the response even if storage deletion fails
            // The MongoDB record is already deleted
        }

        res.json({ message: "Source and associated storage deleted successfully" });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get character count for a source
router.get("/sources/:sourceId/characters", async (req, res) => {
    try {
        const source = await verifySourceWorkspace(
            req.params.sourceId,
            req.user.id
        );
        if (!source) {
            return res.status(404).json({ error: "Source not found or unauthorized" });
        }

        // Get character count from Python API
        const response = await pythonClient.get(`/knowledgebase/${source._id}/character-count`);
        
        res.status(200).json(response.data);
    } catch (error) {
        console.error(error);
        if (error?.response?.data) {
            res.status(500).json({ error: error.response.data.detail || error.response.data.message });
            return;
        }
        res.status(500).json({ error: error.message });
    }
});

// Get processed chunks for a source
router.get("/sources/:sourceId/chunks", async (req, res) => {
    try {
        const source = await verifySourceWorkspace(
            req.params.sourceId,
            req.user.id
        );
        if (!source) {
            return res.status(404).json({ error: "Source not found or unauthorized" });
        }

        // Get chunks from Python API
        const response = await pythonClient.get(`/knowledgebase/${source._id}/chunks`);
        
        // The Python API returns data structured as GetChunksResponse
        // which includes knowledgebase_id, total_chunks, and chunks list
        res.status(200).json({
            message: "success",
            data: response.data // Forward the whole data object from Python
        });

    } catch (error) {
        console.error("Error fetching chunks:", error);
        if (error?.response?.data) {
            // Forward error from Python API if available
            res.status(error.response.status || 500).json({ 
                error: error.response.data.detail || error.response.data.message || "Failed to fetch chunks from backend service"
            });
            return;
        }
        res.status(500).json({ error: "Failed to fetch chunks", details: error.message });
    }
});

// Helper function to mark source as needing training
async function markSourceAsNeedsTraining(sourceId) {
    try {
        await Source.findByIdAndUpdate(sourceId, { needsTraining: true });
    } catch (error) {
        console.error(`Error marking source ${sourceId} as needing training:`, error);
    }
}

module.exports = router; 
