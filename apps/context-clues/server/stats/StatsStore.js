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
    }, 250);
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
      gamesPlayed: 0,
      wins: 0,
      totalGuesses: 0,
      averageGuessesToWin: 0,
      bestWinGuesses: null,
      closestRankAchieved: null,
      points: 0,
      streak: 0,
      lastPlayed: null,
      roomStats: {},
    };
    existing.username = profile.username || existing.username;
    existing.avatarUrl = profile.avatarUrl || existing.avatarUrl;
    this.data.users[profile.id] = existing;
    return existing;
  }

  ensureRoomStats(user, roomId) {
    if (!user.roomStats[roomId]) {
      user.roomStats[roomId] = {
        gamesPlayed: 0,
        wins: 0,
        totalGuesses: 0,
        points: 0,
        closestRankAchieved: null,
      };
    }
    return user.roomStats[roomId];
  }

  completeRound({ roomId, participants, winnerId, winnerGuesses, closestRanks }) {
    const stamp = nowIso();
    const winnersWinGuesses = Number.isFinite(winnerGuesses) ? winnerGuesses : null;
    const pointsAwarded = winnerId ? Math.max(0, 200 - (winnersWinGuesses || 200)) : 0;

    participants.forEach((participant) => {
      const user = this.ensureUser(participant);
      const roomStats = this.ensureRoomStats(user, roomId);
      const userGuessCount = participant.guessCount || 0;

      user.gamesPlayed += 1;
      user.totalGuesses += userGuessCount;
      user.lastPlayed = stamp;

      roomStats.gamesPlayed += 1;
      roomStats.totalGuesses += userGuessCount;

      const closest = closestRanks.get(participant.id) || null;
      if (closest && (!user.closestRankAchieved || closest < user.closestRankAchieved)) user.closestRankAchieved = closest;
      if (closest && (!roomStats.closestRankAchieved || closest < roomStats.closestRankAchieved)) {
        roomStats.closestRankAchieved = closest;
      }

      if (participant.id === winnerId) {
        user.wins += 1;
        user.streak += 1;
        user.points += pointsAwarded;

        roomStats.wins += 1;
        roomStats.points += pointsAwarded;

        if (!user.bestWinGuesses || winnersWinGuesses < user.bestWinGuesses) user.bestWinGuesses = winnersWinGuesses;

        const totalWinGuesses =
          user.averageGuessesToWin * Math.max(user.wins - 1, 0) + (winnersWinGuesses || 0);
        user.averageGuessesToWin = Number((totalWinGuesses / user.wins).toFixed(2));
      } else {
        user.streak = 0;
      }
    });

    this.scheduleSave();
    return pointsAwarded;
  }

  statsForUser(userId, roomId) {
    const user = this.data.users[userId];
    if (!user) return null;
    return {
      ...user,
      room: user.roomStats[roomId] || {
        gamesPlayed: 0,
        wins: 0,
        totalGuesses: 0,
        points: 0,
        closestRankAchieved: null,
      },
    };
  }

  leaderboard(roomId, limit = 10) {
    return Object.values(this.data.users)
      .map((user) => ({
        id: user.id,
        username: user.username,
        avatarUrl: user.avatarUrl,
        wins: user.roomStats[roomId]?.wins || 0,
        points: user.roomStats[roomId]?.points || 0,
      }))
      .filter((entry) => entry.wins > 0 || entry.points > 0)
      .sort((a, b) => b.wins - a.wins || b.points - a.points || a.username.localeCompare(b.username))
      .slice(0, limit);
  }

  reset() {
    this.data = { users: {} };
    this.flush();
  }
}
