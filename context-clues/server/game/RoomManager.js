import { Room } from "./Room.js";

export class RoomManager {
  constructor(similarityService) {
    this.similarityService = similarityService;
    this.rooms = new Map();
    this.cleanupTicker = setInterval(() => this.cleanup(), 60_000);
  }

  getOrCreate(instanceId) {
    if (!this.rooms.has(instanceId)) {
      this.rooms.set(instanceId, new Room(instanceId, this.similarityService));
    }
    return this.rooms.get(instanceId);
  }

  cleanup() {
    const now = Date.now();
    this.rooms.forEach((room, instanceId) => {
      if (room.shouldExpire(now)) this.rooms.delete(instanceId);
    });
  }
}
