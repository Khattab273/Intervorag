const express = require('express');
const router = express.Router();
const Activity = require('../models/Activity');
const User = require('../models/User');
const Workspace = require('../models/Workspace');
const authenticateUser = require('../lib/authMiddleware');
const { apiLimiter } = require('../lib/rateLimitMiddleware');
const mongoose = require("mongoose");
const twilio = require("twilio");
const { getWorkspaceAndOwner } = require("../lib/workspaceUtils");

// Apply rate limiting and authentication middleware
router.use(apiLimiter);
router.use(authenticateUser);

router.get('/agent-stats', async (req, res) => {
    try {
        let { startDate, endDate, agentId } = req.query;
        
        // If dates are not provided, default to last 30 days
        if (!startDate || !endDate) {
            endDate = new Date().toISOString().split('T')[0];  // Today
            startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];  // 30 days ago
        } else {
            // Validate date format (YYYY-MM-DD)
            const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
            if (!dateRegex.test(startDate) || !dateRegex.test(endDate)) {
                return res.status(400).json({ 
                    error: 'Invalid date format. Use YYYY-MM-DD' 
                });
            }
        }

        // Find user and populate workspaces for the utility function
        const user = await User.findById(req.user.id)
                                 .populate('defaultWorkspace')
                                 .populate('lastActiveWorkspace');
        if (!user) {
            return res.status(401).json({ error: "User not found or not authenticated." });
        }

        const { workspaceId, error: workspaceError } = getWorkspaceAndOwner(user);

        if (workspaceError) {
            return res.status(400).json({ error: workspaceError });
        }
        if (!workspaceId) {
            return res.status(400).json({ error: "Active workspace could not be determined." });
        }

        // Build match conditions
        // Adjust endDate to include the entire day
        let queryEndDateValue = new Date(endDate);
        queryEndDateValue.setUTCHours(23, 59, 59, 999);

        const matchConditions = {
            workspace: workspaceId,
            user: user._id,
            createdAt: {
                $gte: new Date(startDate),
                $lte: queryEndDateValue // Use the adjusted end date for the query
            },
            status: "completed"
        };

        // Add agent filter if agentId is provided
        if (agentId) {
            if (!mongoose.Types.ObjectId.isValid(agentId)) {
                return res.status(400).json({ error: 'Invalid agent ID format.' });
            }
            matchConditions.agent = new mongoose.Types.ObjectId(agentId);
        }

        const stats = await Activity.aggregate([
            // Match documents with dynamic conditions
            {
                $match: matchConditions
            },
            // Rest of the aggregation remains the same
            {
                $group: {
                    _id: {
                        year: { $year: "$createdAt" },
                        month: { $month: "$createdAt" },
                        day: { $dayOfMonth: "$createdAt" }
                    },
                    conversationCount: { $sum: 1 },
                    callCount: {
                        $sum: {
                            $cond: [{ $eq: ["$conversationMode", "call"] }, 1, 0]
                        }
                    },
                    chatCount: {
                        $sum: {
                            $cond: [{ $eq: ["$conversationMode", "chat"] }, 1, 0]
                        }
                    },
                    totalCredits: { $sum: "$creditsUsed" }
                }
            },
            {
                $project: {
                    _id: 0,
                    date: {
                        $dateFromParts: {
                            year: "$_id.year",
                            month: "$_id.month",
                            day: "$_id.day"
                        }
                    },
                    conversationCount: 1,
                    callCount: 1,
                    chatCount: 1,
                    creditsUsed: { $round: ["$totalCredits", 2] }
                }
            },
            {
                $sort: { date: 1 }
            }
        ]);

        const filledStats = fillMissingDates(stats, new Date(startDate), new Date(endDate));
        res.json(filledStats);

    } catch (error) {
        console.error('Error fetching agent stats:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

//V8bKGowyrhuFuoukQG55fvW6yDQerTir - api key for our account
router.get('/twilio-balance', async (req, res) => {
    try {
        // Find user and populate workspaces for the utility function
        const user = await User.findById(req.user.id)
                                 .populate('defaultWorkspace')
                                 .populate('lastActiveWorkspace');
        if (!user) {
            return res.status(401).json({
                errorCode: "USER_NOT_AUTHENTICATED", 
                error: "User not found or not authenticated. Please ensure you are logged in."
            });
        }

        const { workspaceId, error: workspaceError } = getWorkspaceAndOwner(user);

        if (workspaceError) {
            return res.status(400).json({
                errorCode: "WORKSPACE_RESOLUTION_FAILED",
                error: workspaceError // Pass through specific message from utility
            });
        }
        if (!workspaceId) {
            return res.status(400).json({
                errorCode: "NO_ACTIVE_WORKSPACE_DETERMINED",
                error: "An active workspace could not be determined for your account. Please check your workspace settings or select an active workspace."
            });
        }

        const workspace = await Workspace.findById(workspaceId);
        if (!workspace) {
            return res.status(404).json({
                errorCode: "ACTIVE_WORKSPACE_NOT_FOUND",
                error: "The active workspace associated with your account could not be found. It might have been deleted or there's an issue with its ID."
            });
        }

        // Get decrypted workspace credentials
        // const workspace = user.defaultWorkspace; // This line was redundant and incorrect after fetching workspace by ID
        const twilioSID = workspace.twilioSID;
        const twilioAuthToken = workspace.apiKey;

        if (!twilioSID || !twilioAuthToken) {
            return res.status(400).json({
                errorCode: "MISSING_TWILIO_CREDENTIALS",
                error: "The active workspace is missing necessary Twilio Account SID or Auth Token. Please update your workspace settings with the correct Twilio credentials."
            });
        }

        const client = twilio(twilioSID, twilioAuthToken);

        const balance = await client.balance.fetch();
        const usage = await client.usage.records.lastMonth.list();

        // Calculate total usage for the current period
        const totalUsage = usage.reduce((sum, record) => sum + parseFloat(record.price), 0);

        res.json({
            balance: {
                current: parseFloat(balance.balance),
                currency: balance.currency
            },
            usage: {
                amount: parseFloat(totalUsage.toFixed(2)),
                currency: 'USD',
                period: 'Last 30 days'
            }
        });

    } catch (error) {
        console.error('Error fetching Twilio balance:', error);
        // Distinguish Twilio API errors from other internal errors if possible
        if (error.status && error.message && error.code) { // Heuristic for Twilio-like error object
             return res.status(error.status || 500).json({ 
                errorCode: "TWILIO_REQUEST_FAILED",
                error: `Failed to communicate with Twilio: ${error.message} (Code: ${error.code})`,
                details: error.moreInfo // Or any other relevant detail from Twilio's error
            });
        }
        res.status(500).json({ 
            errorCode: "INTERNAL_SERVER_ERROR",
            error: 'An internal server error occurred while trying to fetch Twilio balance. Please try again later.',
            details: error.message 
        });
    }
});

// Utility function to fill in missing dates with zero values
function fillMissingDates(stats, startDate, endDate) {
    const filledData = [];
    const currentDate = new Date(startDate);
    const statsMap = new Map(
        stats.map(item => [item.date.toISOString().split('T')[0], item])
    );

    while (currentDate <= endDate) {
        const dateStr = currentDate.toISOString().split('T')[0];
        filledData.push(
            statsMap.get(dateStr) || {
                date: new Date(currentDate),
                conversationCount: 0,
                callCount: 0,
                chatCount: 0,
                creditsUsed: 0
            }
        );
        currentDate.setDate(currentDate.getDate() + 1);
    }

    return filledData;
}

module.exports = router;
