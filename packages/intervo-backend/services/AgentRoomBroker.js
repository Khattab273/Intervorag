const WebSocket = require("ws");
const { v4: uuidv4 } = require("uuid");

const ROOM_EVENT_CHANNEL = "agentRoom:events";
const ROOM_MEMBERS_KEY_PREFIX = "agentRoom:members:";

class AgentRoomBroker {
  constructor({ redisClient, redisSubscriber, instanceId }) {
    this.redisClient = redisClient;
    this.redisSubscriber = redisSubscriber;
    this.instanceId = instanceId || uuidv4();
    this.rooms = new Map();
  }

  async initialize() {
    if (!this.redisSubscriber) {
      return this;
    }

    await this.redisSubscriber.subscribe(ROOM_EVENT_CHANNEL, (message) => {
      this.handleEvent(message);
    });

    return this;
  }

  getRoomCount() {
    return this.rooms.size;
  }

  hasRoom(roomKey) {
    return this.rooms.has(roomKey);
  }

  getRoom(roomKey) {
    return this.rooms.get(roomKey);
  }

  async join(roomKey, ws) {
    if (!roomKey || !ws) {
      return;
    }

    if (!ws.roomConnectionId) {
      ws.roomConnectionId = uuidv4();
    }

    if (!this.rooms.has(roomKey)) {
      this.rooms.set(roomKey, new Set());
    }

    this.rooms.get(roomKey).add(ws);

    await this.publishMembershipEvent("join", roomKey, ws.roomConnectionId);
  }

  async leave(roomKey, ws) {
    if (!roomKey || !ws) {
      return;
    }

    const room = this.rooms.get(roomKey);
    if (room) {
      room.delete(ws);
      if (room.size === 0) {
        this.rooms.delete(roomKey);
      }
    }

    if (ws.roomConnectionId) {
      await this.publishMembershipEvent("leave", roomKey, ws.roomConnectionId);
    }
  }

  broadcastLocal(roomKey, payload, { exclude } = {}) {
    const room = this.rooms.get(roomKey);
    if (!room) {
      return;
    }

    const message = typeof payload === "string" ? payload : JSON.stringify(payload);
    room.forEach((client) => {
      if (client.readyState === WebSocket.OPEN && client !== exclude) {
        client.send(message);
      }
    });
  }

  async broadcast(roomKey, payload, options = {}) {
    this.broadcastLocal(roomKey, payload, options);
    await this.publishRoomMessage(roomKey, payload);
  }

  async publishRoomMessage(roomKey, payload) {
    if (!this.redisClient) {
      return;
    }

    try {
      await this.redisClient.publish(
        ROOM_EVENT_CHANNEL,
        JSON.stringify({
          type: "message",
          roomKey,
          payload,
          originInstanceId: this.instanceId,
        })
      );
    } catch (error) {
      console.error("Failed to publish room message:", error);
    }
  }

  async publishMembershipEvent(type, roomKey, connectionId) {
    if (!this.redisClient) {
      return;
    }

    try {
      const memberKey = `${ROOM_MEMBERS_KEY_PREFIX}${roomKey}`;

      if (type === "join") {
        await this.redisClient.sAdd(memberKey, connectionId);
      }

      if (type === "leave") {
        await this.redisClient.sRem(memberKey, connectionId);
      }

      await this.redisClient.publish(
        ROOM_EVENT_CHANNEL,
        JSON.stringify({
          type,
          roomKey,
          connectionId,
          originInstanceId: this.instanceId,
        })
      );
    } catch (error) {
      console.error("Failed to publish room membership event:", error);
    }
  }

  handleEvent(message) {
    try {
      const event = JSON.parse(message);
      if (event.originInstanceId === this.instanceId) {
        return;
      }

      if (event.type === "message" && event.roomKey) {
        this.broadcastLocal(event.roomKey, event.payload);
      }
    } catch (error) {
      console.error("Failed to process room event:", error);
    }
  }
}

module.exports = AgentRoomBroker;
