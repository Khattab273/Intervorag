const express = require('express');
const passport = require('passport');
const router = express.Router();
const User = require('../models/User');
const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.NEXTAUTH_SECRET;
const REFRESH_TOKEN_SECRET = process.env.REFRESH_TOKEN_SECRET || JWT_SECRET;
const Workspace = require('../models/Workspace');
const { authLimiter, magicLinkLimiter } = require('../lib/rateLimitMiddleware');
const { sendMagicLinkEmail } = require('../lib/emailService');
const PendingVerification = require('../models/PendingVerification');
const crypto = require('crypto');
const { createWorkspace } = require('../lib/workspaceService');
const mongoose = require('mongoose');

const AgentPublishedModel = mongoose.model('AgentPublished');

router.use(authLimiter);


// Google authentication route
router.get(
  '/google',
  passport.authenticate('google', {
    scope: ['profile', 'email'],
  })
);

// Google callback route
router.get(
  '/google/callback',
  passport.authenticate('google', { failureRedirect: '/' }),
  async (req, res) => {
    try {
      const user = req.user; // User is already created/found by Passport

      // Add Google auth method if not already present
      const hasGoogleAuth = user.authMethods && 
        user.authMethods.some(method => method.type === 'google');
      
      if (!hasGoogleAuth) {
        // Initialize authMethods array if it doesn't exist
        if (!user.authMethods) {
          user.authMethods = [];
        }
        
        // Add Google as an auth method
        user.authMethods.push({
          type: 'google',
          timestamp: new Date()
        });
      }

      // Only create workspace if it doesn't exist
      let userNeedsSave = !hasGoogleAuth; // Flag if user needs saving due to auth method addition
      if (!user.defaultWorkspace) {
          try {
              const defaultWorkspace = await createWorkspace(
                  user._id,
                  `${user.displayName || user.email.split('@')[0]}'s Workspace`, // Generate name
                  'UTC' // Default timezone, consider making this configurable?
              );
              user.defaultWorkspace = defaultWorkspace._id;
              user.lastActiveWorkspace = defaultWorkspace._id; // Also set as last active
              userNeedsSave = true; // Mark user for saving
              console.log(`Default workspace created for user ${user.email} via Google Auth`);
          } catch (workspaceError) {
              console.error(`Failed to create default workspace for user ${user.email} during Google Auth:`, workspaceError);
              // Log and continue without a default workspace association for now
          }
      } else {
          // If workspace exists, ensure lastActiveWorkspace is set if it's not already
          if (!user.lastActiveWorkspace) {
              user.lastActiveWorkspace = user.defaultWorkspace;
              userNeedsSave = true; // Mark user for saving
          }
      }
      
      // Save user if authMethod was added OR workspace/lastActive was updated
      if(userNeedsSave) {
          await user.save();
      }

      // Generate tokens and set cookies (rest of your existing code)
      const accessToken = jwt.sign(
        { 
          userId: user._id, 
          email: user.email,
          isAdmin: user.isAdmin || false // Include isAdmin flag
        },
        JWT_SECRET,
        { expiresIn: '72h' }
      );

      const refreshToken = jwt.sign(
        { userId: user._id },
        REFRESH_TOKEN_SECRET,
        { expiresIn: '7d' }
      );

      // Clear any existing cookies first
      res.clearCookie('authToken', {
        domain: process.env.DEV_COOKIE_DOMAIN,
        path: '/'
      });
      res.clearCookie('authToken', {
        domain: process.env.COOKIE_DOMAIN,
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'None'
      });
      res.clearCookie('refreshToken', {
        domain: process.env.COOKIE_DOMAIN,
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'None'
      });

      // Set both cookies
      res.cookie('authToken', accessToken, {
        httpOnly: true,
        secure: true,
        sameSite: "None",
        maxAge: 360000000, // 100 hours
        path: "/",
        domain: process.env.COOKIE_DOMAIN
      });

      res.cookie('refreshToken', refreshToken, {
        httpOnly: true,
        secure: true,
        sameSite: "None",
        maxAge: 7 * 24 * 3600000, // 7 days
        path: "/",
        domain: process.env.COOKIE_DOMAIN
      });

      // Redirect to frontend
      const redirectUrl = process.env.FRONTEND_URL;
      res.redirect(redirectUrl);
    } catch (error) {
      console.error('Error during Google callback:', error);
      res.status(500).send('Server error during authentication callback');
    }
  }
);


router.get('/status', (req, res) => {
  const token = req.cookies.authToken;
  console.log(token, "token");

  if (!token) {
    return res.status(401).json({ message: 'Authentication token missing' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    // Include isAdmin from the decoded token payload
    res.status(200).json({ 
      user: { 
        id: decoded.userId, 
        email: decoded.email, 
        isAdmin: decoded.isAdmin || false // Default to false if not present
      } 
    });
  } catch (error) {
    // Clear cookies if token is invalid
    res.clearCookie('authToken', {
      domain: process.env.DEV_COOKIE_DOMAIN,
      path: '/'
    });
    res.clearCookie('authToken', {
      domain: process.env.COOKIE_DOMAIN,
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'None'
    });
    res.clearCookie('refreshToken', {
      domain: process.env.COOKIE_DOMAIN,
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'None'
    });
    res.status(401).json({ message: 'Invalid token' });
  }
});


// Logout route
router.post('/logout', async (req, res) => {
  console.log("logout");
  
  // Options for clearing cookies set for intervo.ai domain
  const intervoCookieClearOptions = {
    domain: process.env.COOKIE_DOMAIN, // Consistent with how it's set
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'None'
  };

  // Clear cookies first
  res.clearCookie('authToken', {
    domain: process.env.DEV_COOKIE_DOMAIN, // Keep as is for this domain
    path: '/'
  });
  res.clearCookie('authToken', intervoCookieClearOptions);
  res.clearCookie('refreshToken', intervoCookieClearOptions);

  res.status(200).json({ message: 'Logged out successfully' });
});

// Refresh token endpoint
router.post('/refresh-token', async (req, res) => {
  const refreshToken = req.body.refreshToken || req.cookies.refreshToken;
  
  if (!refreshToken) {
    return res.status(401).json({ message: 'Refresh token missing' });
  }

  try {
    const decoded = jwt.verify(refreshToken, REFRESH_TOKEN_SECRET);
    const user = await User.findById(decoded.userId);

    if (!user) {
      // Define cookie clearing options (consistent with /logout)
      const intervoCookieClearOptions = {
        domain: process.env.COOKIE_DOMAIN,
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'None'
      };
      // Clear auth cookies
      res.clearCookie('authToken', { domain: process.env.DEV_COOKIE_DOMAIN, path: '/' });
      res.clearCookie('authToken', intervoCookieClearOptions);
      res.clearCookie('refreshToken', intervoCookieClearOptions);
      
      return res.status(401).json({ message: 'User not found' });
    }

    // Generate new access token
    const newAccessToken = jwt.sign(
      { 
        userId: user._id, 
        email: user.email,
        isAdmin: user.isAdmin || false // Include isAdmin flag here too
      },
      JWT_SECRET,
      { expiresIn: '74h' }
    );

    // Set new access token cookie
    res.cookie('authToken', newAccessToken, {
      httpOnly: true,
      secure: true,
      sameSite: "None",
      maxAge: 360000000,//100 hours
      path: "/",
      domain: process.env.COOKIE_DOMAIN
    });

    res.json({ success: true });
  } catch (error) {
    // Define cookie clearing options (consistent with /logout)
    const intervoCookieClearOptions = {
      domain: process.env.COOKIE_DOMAIN,
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'None'
    };
    // Clear auth cookies
    res.clearCookie('authToken', { domain: process.env.DEV_COOKIE_DOMAIN, path: '/' });
    res.clearCookie('authToken', intervoCookieClearOptions);
    res.clearCookie('refreshToken', intervoCookieClearOptions);

    res.status(401).json({ message: 'Invalid refresh token' });
  }
});

// WebSocket token generation endpoint
router.get('/ws-token', async (req, res) => {
  const authToken = req.cookies.authToken;
  const widgetId = req.query.widgetId;
  
  console.log('WS Token Request Origin:', req.headers.origin);
  
  // If widgetId exists, generate anonymous token
  if (widgetId) {
    const agent = await AgentPublishedModel.findOne({ widgetId });
    if (!agent) {
      return res.status(404).json({ message: 'Widget not found' });
    }
    const wsToken = jwt.sign(
      { 
        userId: 'anonymous',
        email: 'anon@example.com',
        purpose: 'widget',
        widgetId: widgetId
      },
      JWT_SECRET,
      { expiresIn: '74h' }
    );
    return res.json({ token: wsToken });
  }

  // Otherwise proceed with normal auth check
  if (!authToken) {
    return res.status(401).json({ message: 'Authentication required' });
  }

  try {
    // Verify the user's authentication token
    const decoded = jwt.verify(authToken, JWT_SECRET);
    
    // Generate a new short-lived token specifically for WebSocket
    const wsToken = jwt.sign(
      { 
        userId: decoded.userId,
        email: decoded.email,
        purpose: 'websocket'
      },
      JWT_SECRET,
      { expiresIn: '74h' }
    );

    res.json({ token: wsToken });
  } catch (error) {
    console.error('WS token error:', error);
    res.status(401).json({ message: 'Invalid authentication' });
  }
});

// 1. Check Email Existence
router.post('/check-email', magicLinkLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    
    if (!email || !validateEmail(email)) {
      return res.status(400).json({ message: 'Invalid email format' });
    }
    
    const user = await User.findOne({ email: email.toLowerCase() });
    
    if (user) {
      return res.status(200).json({
        exists: true,
        userData: {
          email: user.email,
          firstName: user.firstName || user.displayName?.split(' ')[0] || '',
          lastName: user.lastName || user.displayName?.split(' ').slice(1).join(' ') || ''
        }
      });
    } else {
      return res.status(200).json({ exists: false });
    }
  } catch (error) {
    console.error('Email check error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// 2. Send Magic Link
router.post('/send-magic-link', magicLinkLimiter, async (req, res) => {
  try {
    const { email, firstName, lastName, type } = req.body;
    
    if (!email || !validateEmail(email)) {
      return res.status(400).json({ success: false, message: 'Invalid email format' });
    }
    
    if (!['login', 'signup'].includes(type)) {
      return res.status(400).json({ success: false, message: 'Invalid link type' });
    }
    
    // Generate a token for the magic link
    const magicLinkToken = jwt.sign(
      { 
        email: email.toLowerCase(),
        firstName,
        lastName,
        type,
        purpose: 'magic-link'
      },
      JWT_SECRET,
      { expiresIn: '30m' } // 30 minutes expiration
    );
    
    // Construct the magic link URL
    const frontendUrl = process.env.FRONTEND_URL;
    const magicLink = `${frontendUrl}/verify?token=${magicLinkToken}`;
    
    // Create a hash of the token to store (never store the actual token)
    const tokenHash = crypto.createHash('sha256').update(magicLinkToken).digest('hex');
    
    // Calculate expiration time (30 minutes from now)
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
    
    // Save pending verification record
    await PendingVerification.create({
      email: email.toLowerCase(),
      firstName,
      lastName,
      tokenHash,
      type,
      expiresAt,
      ip: req.ip,
      userAgent: req.headers['user-agent']
    });
    
    // Send the magic link email using our email service
    await sendMagicLinkEmail(
      email.toLowerCase(),
      magicLink,
      firstName,
      type
    );
    
    console.log(`Magic link for ${email} generated and email sent`);
    
    return res.status(200).json({
      success: true,
      message: 'Magic link sent successfully'
    });
  } catch (error) {
    console.error('Magic link generation error:', error);
    res.status(500).json({ success: false, message: 'Failed to send magic link' });
  }
});

// 3. Verify Magic Link
router.post('/verify-magic-link', async (req, res) => {
  try {
    const { token } = req.body;
    
    if (!token) {
      return res.status(400).json({ success: false, message: 'Token is required' });
    }
    
    // Verify the token
    const decoded = jwt.verify(token, JWT_SECRET);
    
    // Check if token is a magic link token
    if (decoded.purpose !== 'magic-link') {
      return res.status(401).json({ success: false, message: 'Invalid token type' });
    }
    
    // Extract user info from the token
    const { email, firstName, lastName, type } = decoded;
    
    // Create a hash of the token to find the pending verification
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    
    // Find and update pending verification record
    const pendingVerification = await PendingVerification.findOneAndUpdate(
      { tokenHash },
      { status: 'verified' },
      { new: true }
    );
    
    // Note: Even if we don't find the pending verification (it might have been cleaned up),
    // we still proceed with the verification as the JWT is valid
    
    // Find existing user or create new one based on the token type
    let user = await User.findOne({ email: email.toLowerCase() });
    
    if (!user) {
      // Create new user
      user = new User({
        email,
        firstName: firstName || '',
        lastName: lastName || '',
        displayName: firstName && lastName ? `${firstName} ${lastName}` : email.split('@')[0],
        // Initialize with magic link as the auth method
        authMethods: [{
          type: 'magic-link',
          timestamp: new Date()
        }]
      });
      
      // Create default workspace for new user
      const defaultWorkspace = await new Workspace({
        name: `${user.displayName}'s Workspace`,
        timezone: 'UTC',
        user: user._id,
      }).save();
      
      user.defaultWorkspace = defaultWorkspace._id;
      await user.save();
    } else {
      // For existing users, add magic-link to their auth methods if not already present
      if (!user.authMethods) {
        user.authMethods = [];
      }
      
      const hasMagicLinkAuth = user.authMethods.some(method => method.type === 'magic-link');
      
      if (!hasMagicLinkAuth) {
        user.authMethods.push({
          type: 'magic-link',
          timestamp: new Date()
        });
      }
    }
    
    // Generate auth tokens
    const accessToken = jwt.sign(
      { 
        userId: user._id, 
        email: user.email,
        isAdmin: user.isAdmin || false // Include isAdmin flag
      },
      JWT_SECRET,
      { expiresIn: '74h' }
    );
    
    const refreshToken = jwt.sign(
      { userId: user._id },
      REFRESH_TOKEN_SECRET,
      { expiresIn: '7d' }
    );
    
    // Save user (for auth methods and workspace info)
    await user.save();
    
    // Set cookies
    res.cookie('authToken', accessToken, {
      httpOnly: true,
      secure: true,
      sameSite: "None",
      maxAge: 360000000, // 100 hours
      path: "/",
      domain: process.env.COOKIE_DOMAIN
    });
    
    res.cookie('refreshToken', refreshToken, {
      httpOnly: true,
      secure: true,
      sameSite: "None",
      maxAge: 7 * 24 * 3600000, // 7 days
      path: "/",
      domain: process.env.COOKIE_DOMAIN
    });
    
    // Return user data
    return res.status(200).json({
      success: true,
      token: accessToken,
      user: {
        id: user._id,
        email: user.email,
        firstName: user.firstName || user.displayName?.split(' ')[0] || '',
        lastName: user.lastName || user.displayName?.split(' ').slice(1).join(' ') || ''
      }
    });
  } catch (error) {
    console.error('Token verification error:', error);
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ success: false, message: 'Token has expired' });
    } else if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ success: false, message: 'Invalid token' });
    }
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Helper function to validate email format
function validateEmail(email) {
  const re = /^(([^<>()\[\]\\.,;:\s@"]+(\.[^<>()\[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/;
  return re.test(String(email).toLowerCase());
}

// Admin endpoint to get verification statistics
router.get('/verification-stats', async (req, res) => {
  try {
    // Check for admin authentication
    const token = req.cookies.authToken;
    if (!token) {
      return res.status(401).json({ message: 'Authentication required' });
    }
    
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await User.findById(decoded.userId);
    
    // This is a simple check - in production you would have proper role-based access control
    if (!user || !user.email.endsWith('@intervo.ai')) {
      return res.status(403).json({ message: 'Admin access required' });
    }
    
    // Get statistics
    const stats = {
      // Total pending verifications
      pendingCount: await PendingVerification.countDocuments({ status: 'pending' }),
      
      // Total verified
      verifiedCount: await PendingVerification.countDocuments({ status: 'verified' }),
      
      // Conversions in the last 24 hours
      last24Hours: {
        sent: await PendingVerification.countDocuments({ 
          createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
        }),
        verified: await PendingVerification.countDocuments({ 
          status: 'verified',
          createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
        }),
      },
      
      // Breakdown by type
      signupStats: {
        sent: await PendingVerification.countDocuments({ type: 'signup' }),
        verified: await PendingVerification.countDocuments({ type: 'signup', status: 'verified' }),
      },
      loginStats: {
        sent: await PendingVerification.countDocuments({ type: 'login' }),
        verified: await PendingVerification.countDocuments({ type: 'login', status: 'verified' }),
      },
      
      // Top unverified domains (for detecting spam or problematic domains)
      topUnverifiedDomains: await PendingVerification.aggregate([
        { $match: { status: 'pending' } },
        { $project: { domain: { $split: ["$email", "@"] } } },
        { $project: { domain: { $arrayElemAt: ["$domain", 1] } } },
        { $group: { _id: "$domain", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 }
      ]),
    };
    
    // Calculate conversion rates
    if (stats.signupStats.sent > 0) {
      stats.signupStats.conversionRate = (stats.signupStats.verified / stats.signupStats.sent * 100).toFixed(2) + '%';
    }
    
    if (stats.loginStats.sent > 0) {
      stats.loginStats.conversionRate = (stats.loginStats.verified / stats.loginStats.sent * 100).toFixed(2) + '%';
    }
    
    if (stats.last24Hours.sent > 0) {
      stats.last24Hours.conversionRate = (stats.last24Hours.verified / stats.last24Hours.sent * 100).toFixed(2) + '%';
    }
    
    res.status(200).json(stats);
  } catch (error) {
    console.error('Error getting verification stats:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
