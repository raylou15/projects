# Trivia manual test checklist

1. Open two browser tabs, join same room code; confirm both receive monotonic `seq` state updates and no stale overwrite.
2. Start round and wait until 75% elapsed; confirm auto-hint appears and point multiplier drops to `0.5x`.
3. Trigger user hint; verify immediate `-1` trivia point behavior (clamped at zero).
4. Cast skip votes from multiple users; verify threshold is `min(3, activePlayers)` and round ends early once met.
5. Answer same question correctly as same user more than once in a season; verify points only award once per `season + questionHash + user`.
6. Verify monthly season rollover by simulating an old active season month:
   - old season is finalized with `winners` top 3 by `riddlePoints + triviaPoints`
   - new active season is created with incremented `seasonNumber`.
