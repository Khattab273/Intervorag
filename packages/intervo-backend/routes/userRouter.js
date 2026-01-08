const express = require('express');
const User = require('../models/User'); // Your User model
const router = express.Router();
const authenticateUser = require('../lib/authMiddleware');
const { apiLimiter } = require('../lib/rateLimitMiddleware');

router.use(apiLimiter);

// Endpoint to create or update a user using Google ID
router.post('/', async (req, res) => {
  const { email, name, googleId } = req.body;

  try {
    let user = await User.findOne({ 'authProviders.google.id': googleId });

    if (!user) {
      // If user does not exist, create a new one
      user = await new User({
        authProviders: {
          google: { id: googleId },
        },
        displayName: name,
        email: email,
      }).save();
    } else {
      // Optionally update user information here
      user.displayName = name;
      await user.save();
    }

    res.status(200).json({ message: 'User created or updated successfully', userId: user._id });
  } catch (error) {
    console.error('Error creating or updating user:', error);
    res.status(500).json({ message: 'Server error' });
  }
});


// Get complete user profile information
router.get('/profile', authenticateUser, async (req, res) => {
  try {
    // Get user data from database using ID from auth middleware
    const user = await User.findById(req.user.id)
      .select('-password') // Exclude password from the result
     
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    res.status(200).json({ user });
  } catch (error) {
    console.error('Error fetching user profile:', error);
    res.status(500).json({ error: 'Failed to fetch user profile' });
  }
});

// Update user profile
router.put('/profile', authenticateUser, async (req, res) => {
  try {
    const { onBoardingData, onboardingCompleted, agentOnboardingCompleted } = req.body;
    
    // Find the user
    const user = await User.findById(req.user.id);
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    // Update user fields
    if (onBoardingData) {
      user.onBoardingData = onBoardingData;
    }
    
    if (onboardingCompleted !== undefined) {
      user.onboardingCompleted = onboardingCompleted;
    }

    if (agentOnboardingCompleted !== undefined) {
      user.agentOnboardingCompleted = agentOnboardingCompleted;
    }
    
    // Save the updated user
    await user.save();
    
    // Return updated user (excluding password)
    const updatedUser = await User.findById(req.user.id)
      .select('-password');
    
    res.status(200).json({ user: updatedUser });
  } catch (error) {
    console.error('Error updating user profile:', error);
    res.status(500).json({ error: 'Failed to update user profile' });
  }
});


// Endpoint to get user information by identifier (either Google ID or MongoDB ObjectId)
router.get('/:identifier', async (req, res) => {
  const identifier = req.params.identifier;

  try {
    let user;

    // Determine if the identifier is a valid MongoDB ObjectId
    if (identifier.match(/^[0-9a-fA-F]{24}$/)) {
      user = await User.findById(identifier);
    } else {
      user = await User.findOne({ 'authProviders.google.id': identifier });
    }

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    res.status(200).json({
      displayName: user.displayName,
      email: user.email,
    });
  } catch (error) {
    console.error('Error fetching user:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
