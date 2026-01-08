const cookie = require('cookie');
const jwt = require('jsonwebtoken');

function handleClientConnection(ws, req, wss, agentRoomBroker) {
  try {
    console.log("tokennnnnnnn");
    const cookies = cookie.parse(req.headers.cookie || '');
    const urlParams = new URLSearchParams(req.url.split('?')[1] || '');
    const authToken = cookies.authToken || urlParams.get('token');

    console.log("authToken", authToken);
    if (!authToken) {
      ws.close(1008, "Authentication token missing");
      return false;
    }

    const decoded = jwt.verify(authToken, process.env.NEXTAUTH_SECRET);
    console.log("Authenticated user:", decoded);

    ws.on("close", () => {
      console.log("WebSocket connection closed for client");
    });

    ws.on("error", (error) => {
      console.error("WebSocket error for client:", error);
    });

    return true;
  } catch (error) {
    console.error("Error initializing client connection:", error);
    return false;
  }
}

module.exports = handleClientConnection; 
