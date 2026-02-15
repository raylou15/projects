import { Room } from "./Room.js";

export class RoomManager {
  constructor(similarityService, statsStore) {
    this.similarityService = similarityService;
    this.statsStore = statsStore;
    this.rooms = new Map();
    this.cleanupTicker = setInterval(() => this.cleanup(), 60_000);
  }

  getOrCreate(roomId) {
    if (!this.rooms.has(roomId)) {
      this.rooms.set(roomId, new Room(roomId, this.similarityService, this.statsStore));
    }
    return this.rooms.get(roomId);
  }

  cleanup() {
    const now = Date.now();
    this.rooms.forEach((room, roomId) => {
      if (room.shouldExpire(now)) this.rooms.delete(roomId);
    });
  }
}
