import { SemanticRankService } from "../similarity/semantic.js";

const similarity = new SemanticRankService();
similarity.load();

const target = similarity.pickTarget();
const round = similarity.buildRound(target);
console.log(`target=${round.targetWord} semantic=${round.semantic}`);

const guesses = [round.targetWord, "house", "music", "table", "ocean", "randomword"];
for (const guess of guesses) {
  // eslint-disable-next-line no-await-in-loop
  const out = await round.evaluateGuess(guess);
  console.log(`${guess} => rank=${out.rank} approx=${out.approx} mode=${out.mode}`);
}
