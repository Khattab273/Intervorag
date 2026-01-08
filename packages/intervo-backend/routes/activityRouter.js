const express = require("express");
const router = express.Router();
const Activity = require("../models/Activity");
const User = require("../models/User");
const { verifyAgentWorkspace } = require("../lib/checkOwnership");
const authenticateUser = require("../lib/authMiddleware");
const { apiLimiter } = require("../lib/rateLimitMiddleware");
const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { Readable } = require('stream');

// Apply rate limiting and authentication middleware to all routes
router.use(apiLimiter);
router.use(authenticateUser);

// --- Configure Minimal S3 Client for GetObject ---
const s3Client = new S3Client({
    endpoint: process.env.HETZNER_STORAGE_ENDPOINT,
    region: process.env.HETZNER_STORAGE_REGION,
    credentials: {
        accessKeyId: process.env.HETZNER_STORAGE_ACCESS_KEY_ID,
        secretAccessKey: process.env.HETZNER_STORAGE_SECRET_ACCESS_KEY,
    },
    forcePathStyle: true,
});
const s3Endpoint = process.env.HETZNER_STORAGE_ENDPOINT;
const defaultBucket = process.env.HETZNER_STORAGE_BUCKET;
// --- End S3 Client Configuration ---

// Create a new activity
router.post("/", async (req, res) => {
  try {
    const {
      user,
      agent,
      contact,
      conversationTranscription,
      summary,
      memory,
      collectedInfo,
      callDuration,
      callType,
      status,
    } = req.body;

    const curUser = await User.findById(req.user.id).populate(
      "defaultWorkspace"
    );
    if (!curUser || !curUser.defaultWorkspace) {
      return res.status(400).json({ error: "No default workspace found" });
    }

    const activity = new Activity({
      user,
      agent,
      contact,
      conversationTranscription,
      summary,
      memory,
      collectedInfo,
      callDuration,
      callType,
      status,
      workspace: curUser.defaultWorkspace._id,
    });

    await activity.save();
    res.status(201).json(activity);
  } catch (error) {
    res
      .status(500)
      .json({ error: "Failed to create activity", details: error.message });
  }
});

// Get all activities
router.get("/", async (req, res) => {
  try {
    const { agentId, page = 1, limit = 10, from, to, ticketStatus = "open" } = req.query;

    console.log(from, to, "from-to testing")
    
    // Verify agent ownership
    const agent = await verifyAgentWorkspace(agentId, req.user.id);
    if (!agent) {
      return res.status(403).json({ error: "Unauthorized access to this agent" });
    }

    const skip = (page - 1) * limit;
    
    // Build query object
    const query = { 
      agent: agentId,
      ticketStatus
    };
    
    // Add date range filtering if both from and to dates are provided
    if (from && to) {
      query.createdAt = {
        $gte: new Date(from),
        $lte: new Date(to)
      };
    }
    
    const activities = await Activity.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .populate('contact')
      .populate({
        path: 'conversationId',
        ref: 'ConversationState',
        localField: 'conversationId',
        foreignField: 'conversationId'
      })
      .lean()
      .then(activities => {
        // Rename the field in the results
        return activities.map(activity => {
          if (activity.conversationId) {
            activity.conversationData = activity.conversationId;
            delete activity.conversationId;
          }
          return activity;
        });
      });
    // Get total count for pagination
    const total = await Activity.countDocuments(query);

    res.json({
      activities,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error("Error fetching activities:", error);
    res.status(500).json({ error: "Failed to fetch activities" });
  }
});


// Update an activity
router.put("/:id", async (req, res) => {
  try {
    const {
      conversationTranscription,
      summary,
      memory,
      collectedInfo,
      callDuration,
      callType,
      status,
    } = req.body;

    const activity = await Activity.findByIdAndUpdate(
      req.params.id,
      {
        conversationTranscription,
        summary,
        memory,
        collectedInfo,
        callDuration,
        callType,
        status,
      },
      { new: true }
    );

    if (!activity) {
      return res.status(404).json({ error: "Activity not found" });
    }
    res.json(activity);
  } catch (error) {
    res
      .status(500)
      .json({ error: "Failed to update activity", details: error.message });
  }
});

// Partially update an activity
router.patch("/:id", async (req, res) => {
  try {
    const updates = req.body;
    const activity = await Activity.findByIdAndUpdate(req.params.id, updates, {
      new: true,
      runValidators: true,
    });

    if (!activity) {
      return res.status(404).json({ error: "Activity not found" });
    }

    res.json(activity);
  } catch (error) {
    res
      .status(500)
      .json({ error: "Failed to update activity", details: error.message });
  }
});

// Delete an activity
router.delete("/:id", async (req, res) => {
  try {

    const { agentId } = req.params;
      // Verify agent ownership
    const agent = await verifyAgentWorkspace(agentId, req.user.id);
    if (!agent) {
      return res.status(403).json({ error: "Unauthorized access to this agent" });
    }

    const activity = await Activity.findByIdAndDelete(req.params.id);
    if (!activity) {
      return res.status(404).json({ error: "Activity not found" });
    }
    res.json({ message: "Activity deleted successfully" });
  } catch (error) {
    res.status(500).json({ error: "Failed to delete activity" });
  }
});

// Get activities grouped by ticketStatus
router.get("/by-ticket-status", async (req, res) => {
  try {
    const { agentId, ticketStatus, page = 1, limit = 10, from, to } = req.query;
    
    // Verify agent ownership
    const agent = await verifyAgentWorkspace(agentId, req.user.id);
    if (!agent) {
      return res.status(403).json({ error: "Unauthorized access to this agent" });
    }

    const baseQuery = { agent: agentId };
    
    // Add date range filtering if both from and to dates are provided
    if (from && to) {
      baseQuery.createdAt = {
        $gte: new Date(from),
        $lte: new Date(to)
      };
    }

    const skip = (page - 1) * limit;

    // If ticketStatus is specified, return paginated results for that status
    if (ticketStatus) {
      baseQuery.ticketStatus = ticketStatus;
      
      const activities = await Activity.find(baseQuery)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .populate('contact')
        .populate({
          path: 'conversationId',
          ref: 'ConversationState',
          localField: 'conversationId',
          foreignField: 'conversationId'
        })
        .lean()
        .then(activities => activities.map(activity => {
          if (activity.conversationId) {
            activity.conversationData = activity.conversationId;
            delete activity.conversationId;
          }
          return activity;
        }));

      const total = await Activity.countDocuments(baseQuery);

      return res.json({
        activities,
        pagination: {
          total,
          page: parseInt(page),
          limit: parseInt(limit),
          pages: Math.ceil(total / limit)
        }
      });
    }

    // If no ticketStatus specified, return activities grouped by all statuses
    const statusTypes = ['open', 'in-progress', 'closed', 'archived'];
    const result = {};

    await Promise.all(
      statusTypes.map(async (status) => {
        const statusQuery = { ...baseQuery, ticketStatus: status };  // baseQuery now includes date range if specified
        const activities = await Activity.find(statusQuery)
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(parseInt(limit))
          .populate('contact')
          .populate({
            path: 'conversationId',
            ref: 'ConversationState',
            localField: 'conversationId',
            foreignField: 'conversationId'
          })
          .lean()
          .then(activities => activities.map(activity => {
            if (activity.conversationId) {
              activity.conversationData = activity.conversationId;
              delete activity.conversationId;
            }
            return activity;
          }));

        const total = await Activity.countDocuments(statusQuery);

        result[status] = {
          activities,
          pagination: {
            total,
            page: 1,
            limit: parseInt(limit),
            pages: Math.ceil(total / limit)
          }
        };
      })
    );

    res.json(result);
  } catch (error) {
    console.error("Error fetching activities:", error);
    res.status(500).json({ error: "Failed to fetch activities" });
  }
});





// Update activity ticket status
router.patch("/:id/ticket-status", async (req, res) => {
  try {
    const { ticketStatus } = req.body;
    const activityId = req.params.id;

    // Validate ticket status value
    const validStatuses = ["open", "in-progress", "closed", "archived"];
    if (!validStatuses.includes(ticketStatus)) {
      return res.status(400).json({ 
        error: "Invalid ticket status",
        message: `Status must be one of: ${validStatuses.join(', ')}`
      });
    }

    // Find the activity and verify it exists
    const activity = await Activity.findById(activityId);
    if (!activity) {
      return res.status(404).json({ error: "Activity not found" });
    }

    // Verify agent workspace ownership
    const agent = await verifyAgentWorkspace(activity.agent, req.user.id);
    if (!agent) {
      return res.status(403).json({ error: "Unauthorized access to this activity" });
    }

    // Update the ticket status
    await Activity.findByIdAndUpdate(
      activityId,
      { 
        ticketStatus,
        updatedAt: new Date(),
        updatedBy: req.user.id
      }
    );

    res.json({ message: "Ticket status updated successfully" });
  } catch (error) {
    console.error("Error updating ticket status:", error);
    res.status(500).json({ error: "Failed to update ticket status" });
  }
});

// Get a single activity by ID
router.get("/:id", async (req, res) => {
  try {
    const activity = await Activity.findById(req.params.id);
    if (!activity) {
      return res.status(404).json({ error: "Activity not found" });
    }
    res.json(activity);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch activity" });
  }
});

// --- NEW ROUTE: Get Activity Recording Audio ---
router.get("/audio/:activityId", async (req, res) => {
    try {
        const { activityId } = req.params;

        // 1. Find Activity
        const activity = await Activity.findById(activityId).select('+agent +callRecording').lean();

        if (!activity) {
            return res.status(404).json({ error: "Activity not found" });
        }

        if (!activity.callRecording || !activity.callRecording.url) {
             return res.status(404).json({ error: "Recording not available for this activity" });
        }
        const recordingUrl = activity.callRecording.url;

        // 2. Verify User Access
        const agent = await verifyAgentWorkspace(activity.agent, req.user.id);
        if (!agent) {
            return res.status(403).json({ error: "Unauthorized access to this activity's recording" });
        }

        // 3. Parse S3 Bucket and Key from URL
        let bucketName = defaultBucket;
        let objectKey = '';
        try {
            const url = new URL(recordingUrl);
            const pathParts = url.pathname.split('/').filter(part => part.length > 0);

            if (!s3Endpoint || !recordingUrl.startsWith(s3Endpoint)) {
                 console.error(`[ActivityAudio] Recording URL ${recordingUrl} does not match expected endpoint ${s3Endpoint}`);
                 throw new Error("Invalid recording URL format (endpoint mismatch)");
            }
            if (pathParts.length < 2) {
                 throw new Error("Invalid recording URL format (path too short)");
            }
            bucketName = pathParts[0];
            objectKey = pathParts.slice(1).join('/');

             if (bucketName !== defaultBucket) {
                  console.warn(`[ActivityAudio] Extracted bucket '${bucketName}' differs from default '${defaultBucket}'. Proceeding with extracted bucket.`);
             }

        } catch (parseError) {
            console.error(`[ActivityAudio] Error parsing recording URL ${recordingUrl}:`, parseError);
            return res.status(500).json({ error: "Internal error processing recording location" });
        }


        if (!bucketName || !objectKey) {
            return res.status(500).json({ error: "Could not determine recording location" });
        }

        console.log(`[ActivityAudio] User ${req.user.id} requesting audio for Activity ${activityId}. Key: ${objectKey}, Bucket: ${bucketName}`);

        // 4. Fetch from S3
        const getObjectParams = {
            Bucket: bucketName,
            Key: objectKey,
        };

        try {
            const command = new GetObjectCommand(getObjectParams);
            const s3Response = await s3Client.send(command);

            if (!(s3Response.Body instanceof Readable)) {
                console.error("[ActivityAudio] S3 response body is not a readable stream.");
                return res.status(500).send("Error retrieving audio data.");
            }

            // 5. Stream to Client
            res.setHeader('Content-Type', s3Response.ContentType || 'audio/mpeg');
            if (s3Response.ContentLength) {
                 res.setHeader('Content-Length', s3Response.ContentLength);
            }
            // Optional: Set filename for download prompt
            // res.setHeader('Content-Disposition', `attachment; filename="${path.basename(objectKey)}"`);

            s3Response.Body.pipe(res);

             s3Response.Body.on('error', (streamError) => {
                console.error(`[ActivityAudio] Error streaming S3 object ${objectKey}:`, streamError);
                 if (!res.headersSent) {
                     res.status(500).send("Error during audio stream.");
                 }
             });


        } catch (s3Error) {
            console.error(`[ActivityAudio] S3 GetObject error for key ${objectKey}:`, s3Error);
            if (s3Error.name === 'NoSuchKey') {
                return res.status(404).json({ error: "Recording file not found in storage" });
            } else {
                 return res.status(500).json({ error: "Failed to retrieve recording from storage" });
            }
        }

    } catch (error) {
        console.error(`[ActivityAudio] Error fetching activity audio for ID ${req.params.activityId}:`, error);
        res.status(500).json({ error: "Failed to fetch activity audio" });
    }
});
// --- End NEW ROUTE ---

module.exports = router;
