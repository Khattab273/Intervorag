const express = require("express");
const router = express.Router();
const Contact = require("../models/Contact");
const User = require("../models/User"); // Needed for workspace check
const Agent = require("../models/Agent"); // Needed for agent check
const authenticateUser = require("../lib/authMiddleware"); // Authentication middleware
const { apiLimiter } = require("../lib/rateLimitMiddleware");

// Middleware to rate limit and authenticate all contact routes
router.use(apiLimiter);
router.use(authenticateUser);

// Middleware to get user's active workspace and attach to request
const getUserWorkspace = async (req, res, next) => {
    try {
        const user = await User.findById(req.user.id).populate('defaultWorkspace lastActiveWorkspace');
        if (!user) throw new Error('User not found during workspace check');
        const workspaceId = user.lastActiveWorkspace?._id || user.defaultWorkspace?._id;
        if (!workspaceId) {
            // User exists but has no workspace assigned or active
            return res.status(400).json({ error: 'User has no active or default workspace assigned' });
        }
        req.workspaceId = workspaceId.toString(); // Ensure it's a string for comparisons
        next();
    } catch (error) {
        console.error("Error getting user workspace:", error);
        res.status(500).json({ error: 'Failed to retrieve user workspace', details: error.message });
    }
};
router.use(getUserWorkspace); // Apply workspace check after authentication

// Create a new contact (scoped to user's workspace and specific agent)
router.post("/", async (req, res) => {
  try {
    const { agentId } = req.query; // Agent required via query param
    const { firstName, lastName, email, phoneNumber, countryCode } = req.body;

    if (!agentId) {
      return res.status(400).json({ error: "agentId query parameter is required" });
    }

    // Verify the agent exists and belongs to the user's workspace
    const agent = await Agent.findOne({ _id: agentId, workspace: req.workspaceId });
    if (!agent) {
        return res.status(404).json({ error: "Agent not found within your workspace" });
    }

    // Check if contact already exists for this agent (using compound index)
    const existingContact = await Contact.findOne({
        phoneNumber: phoneNumber, // Or email: email, depending on unique rule
        agent: agentId 
    });
    if (existingContact) {
        return res.status(409).json({ error: `Contact with phone number ${phoneNumber} already exists for this agent.`, contactId: existingContact._id });
    }

    const fullName = `${firstName} ${lastName}`;
    const contact = new Contact({
      firstName,
      lastName,
      fullName,
      email,
      phoneNumber,
      countryCode,
      agent: agentId,
      user: req.user.id,
      workspace: req.workspaceId
    });
    await contact.save();
    res.status(201).json(contact);
  } catch (error) {
    res
      .status(500)
      .json({ error: "Failed to create contact", details: error.message });
  }
});

// // Get all contacts
// router.get("/", async (req, res) => {
//   try {
//     const contacts = await Contact.find();
//     res.json(contacts);
//   } catch (error) {
//     res.status(500).json({ error: "Failed to fetch contacts" });
//   }
// });

router.get("/leads", async (req, res) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 10;
    const offset = (page - 1) * limit;

    // Find contacts only within the user's active workspace
    const query = { workspace: req.workspaceId };
    const contacts = await Contact.find(query).skip(offset).limit(limit);
    const totalContacts = await Contact.countDocuments(query);
    const totalPages = Math.ceil(totalContacts / limit);

    res.json({
      success: true,
      contacts,
      pagination: {
        currentPage: page,
        totalPages,
        totalContacts,
        limit,
      },
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch contacts" });
  }
});

// Get a single contact by ID (scoped to user's workspace)
router.get("/:id", async (req, res) => {
  try {
    // Find contact by ID only within the user's active workspace
    const contact = await Contact.findOne({ _id: req.params.id, workspace: req.workspaceId });
    if (!contact) {
      return res.status(404).json({ error: "Contact not found" });
    }
    res.json(contact);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch contact" });
  }
});

// Update a contact (scoped to user's workspace)
router.put("/:id", async (req, res) => {
  try {
    // Allow updating only specific fields, prevent changing ownership/linking fields
    const { firstName, lastName, email, phoneNumber, countryCode } = req.body;
    const fullName = `${firstName} ${lastName}`; // Recalculate fullName
    const updateData = { firstName, lastName, fullName, email, phoneNumber, countryCode };

    // Find and update contact only within the user's active workspace
    const contact = await Contact.findOneAndUpdate(
      { _id: req.params.id, workspace: req.workspaceId }, // Query includes workspace check
      { $set: updateData },
      { new: true } // Options: run validators, return updated doc
    );
    if (!contact) {
      return res.status(404).json({ error: "Contact not found" });
    }
    res.json(contact);
  } catch (error) {
    res.status(500).json({ error: "Failed to update contact" });
  }
});

// Partially update a contact (scoped to user's workspace)
router.patch("/:id", async (req, res) => {
  try {
    // Sanitize updates: prevent changing ownership/linking fields
    const allowedUpdates = ['firstName', 'lastName', 'fullName', 'email', 'phoneNumber', 'countryCode'];
    const updates = {};
    for (const key in req.body) {
        if (allowedUpdates.includes(key)) {
            updates[key] = req.body[key];
        }
    }
    // Recalculate fullName if firstName or lastName is updated
    if (updates.firstName || updates.lastName) {
        const currentContact = await Contact.findOne({ _id: req.params.id, workspace: req.workspaceId });
        if (currentContact) { // Check if found before accessing properties
          const newFirstName = updates.firstName || currentContact.firstName;
          const newLastName = updates.lastName || currentContact.lastName;
          updates.fullName = `${newFirstName} ${newLastName}`.trim();
        }
    }

    // Find and update contact only within the user's active workspace
    const contact = await Contact.findOneAndUpdate(
      { _id: req.params.id, workspace: req.workspaceId }, // Query includes workspace check
      { $set: updates },
      {
        new: true,
        runValidators: true,
      }
    );

    if (!contact) {
      return res.status(404).json({ error: "Contact not found" });
    }

    res.json(contact);
  } catch (error) {
    res
      .status(500)
      .json({ error: "Failed to update contact", details: error.message });
  }
});

// Delete a contact (scoped to user's workspace)
router.delete("/:id", async (req, res) => {
  try {
    // Find and delete contact only within the user's active workspace
    const contact = await Contact.findOneAndDelete({ _id: req.params.id, workspace: req.workspaceId });
    if (!contact) {
      return res.status(404).json({ error: "Contact not found" });
    }
    res.json({ message: "Contact deleted successfully" });
  } catch (error) {
    res.status(500).json({ error: "Failed to delete contact" });
  }
});

module.exports = router;
