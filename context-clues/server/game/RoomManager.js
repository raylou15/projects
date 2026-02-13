import { Room } from "./Room.js";

export class RoomManager {
  constructor() {
    this.rooms = new Map();
    this.cleanupInterval = setInterval(() => this.cleanup(), 60_000);
  }

  getOrCreate(instanceId) {
    if (!this.rooms.has(instanceId)) {
      this.rooms.set(
        instanceId,
        new Room(instanceId, (id) => {
          this.rooms.delete(id);
        }),
      );
    }

    return this.rooms.get(instanceId);
  }

  cleanup() {
    const now = Date.now();
    this.rooms.forEach((room, instanceId) => {
      if (room.shouldExpire(now)) {
        room.clearTimer();
        this.rooms.delete(instanceId);
      }
    });
  }
}
