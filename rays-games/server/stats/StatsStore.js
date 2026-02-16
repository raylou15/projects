import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const defaultPath = path.resolve(__dirname, "../data/stats.json");

function nowIso() {
  return new Date().toISOString();
}

export class StatsStore {
  constructor(filePath = defaultPath) {
    this.filePath = filePath;
    this.data = { users: {} };
    this.saveTimer = null;
    this.load();
  }

  load() {
    if (!fs.existsSync(this.filePath)) return;
    try {
      this.data = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
    } catch {
      this.data = { users: {} };
    }
  }

  scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flush();
    }, 200);
  }

  flush() {
    const tmp = `${this.filePath}.tmp`;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.filePath);
  }

  ensureUser(profile) {
    const existing = this.data.users[profile.id] || {
      id: profile.id,
      username: profile.username,
      avatarUrl: profile.avatarUrl || "",
      nickname: profile.nickname || "",
      roundsPlayed: 0,
      wins: 0,
      totalGuesses: 0,
      bestRank: null,
      streak: 0,
      bestStreak: 0,
      lastPlayed: null,
      roomStats: {},
    };

    existing.username = profile.username || existing.username;
    existing.avatarUrl = profile.avatarUrl || existing.avatarUrl || "";
    existing.nickname = profile.nickname || existing.nickname || "";
    this.data.users[profile.id] = existing;
    return existing;
  }

  ensureRoomStats(user, roomId) {
    if (!user.roomStats[roomId]) {
      user.roomStats[roomId] = {
        roundsPlayed: 0,
        wins: 0,
        totalGuesses: 0,
        bestRank: null,
      };
    }
    return user.roomStats[roomId];
  }

  completeRound({ roomId, participants, winnerId, closestRanks }) {
    const stamp = nowIso();

    participants.forEach((participant) => {
      const user = this.ensureUser(participant);
      const roomStats = this.ensureRoomStats(user, roomId);
      const guessCount = participant.guessCount || 0;
      const closest = closestRanks.get(participant.id) || null;

      user.roundsPlayed += 1;
      user.totalGuesses += guessCount;
      user.lastPlayed = stamp;

      roomStats.roundsPlayed += 1;
      roomStats.totalGuesses += guessCount;

      if (closest && (!user.bestRank || closest < user.bestRank)) user.bestRank = closest;
      if (closest && (!roomStats.bestRank || closest < roomStats.bestRank)) roomStats.bestRank = closest;

      if (participant.id === winnerId) {
        user.wins += 1;
        user.streak += 1;
        user.bestStreak = Math.max(user.bestStreak || 0, user.streak);
        roomStats.wins += 1;
      } else {
        user.streak = 0;
      }
    });

    this.scheduleSave();
  }

  statsForUser(userId, roomId) {
    const user = this.data.users[userId];
    if (!user) {
      return {
        roundsPlayed: 0,
        wins: 0,
        totalGuesses: 0,
        bestRank: null,
        streak: 0,
        bestStreak: 0,
        room: { roundsPlayed: 0, wins: 0, totalGuesses: 0, bestRank: null },
      };
    }

    return {
      roundsPlayed: user.roundsPlayed,
      wins: user.wins,
      totalGuesses: user.totalGuesses,
      bestRank: user.bestRank,
      streak: user.streak,
      bestStreak: user.bestStreak,
      room: user.roomStats[roomId] || {
        roundsPlayed: 0,
        wins: 0,
        totalGuesses: 0,
        bestRank: null,
      },
    };
  }
}
