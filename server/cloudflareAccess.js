const auth = require('./auth');

/**
 * Cloudflare Access middleware.
 * 
 * When dptv-recorder runs behind Cloudflare Access:
 * - Cloudflare authenticates the user before the request reaches the app
 * - Cloudflare adds headers like Cf-Access-Authenticated-User-Email
 * - This middleware reads those headers and creates a dptv-recorder session
 * - No login prompt needed - user is already authenticated at the proxy
 * 
 * If Cf-Access-Authenticated-User-Email is missing, the request passes through
 * unchanged (either not behind Cloudflare Access, or the user isn't authenticated).
 */
function cloudflareAccessMiddleware(req, res, next) {
  // Check for Cloudflare Access authentication header
  const userEmail = req.headers['cf-access-authenticated-user-email'];
  
  if (!userEmail) {
    // Not authenticated via Cloudflare Access, continue normally
    return next();
  }

  // User is authenticated via Cloudflare Access
  // Find or create a user with this email
  let user = auth.findUserByEmail(userEmail);
  
  if (!user) {
    // Auto-create user from Cloudflare email
    const nameParts = userEmail.split('@')[0].split('.');
    const firstName = nameParts[0] || 'User';
    const lastName = nameParts[1] || userEmail.split('@')[0];
    
    user = auth.createUser({
      username: userEmail.split('@')[0], // Will add numbers if dupe
      firstName,
      lastName,
      email: userEmail,
      isAdmin: false, // New Cloudflare users are regular users by default
      mustChangePassword: false,
    });
    console.log(`[cloudflare-access] auto-created user from Cloudflare: ${userEmail}`);
  }

  // Create a session token and set the cookie
  const token = auth.createSession(user.id);
  auth.setSessionCookie(res, token);

  // Attach the user to req for downstream handlers
  req.user = auth.sanitizeUser(user);
  
  next();
}

module.exports = {
  cloudflareAccessMiddleware,
};
