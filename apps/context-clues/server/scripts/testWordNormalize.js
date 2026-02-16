import assert from 'assert/strict';
import { normalizeGuess } from '../../shared/wordNormalize.js';

const cases = [
  [' JUICE!! ', 'juice'],
  ['juices', 'juice'],
  ['hamburgers', 'hamburger'],
  ['berries', 'berry'],
  ['runs', 'run'],
  ['running', 'run'],
  ['class', 'class'],
  ["don't", "don't"],
  ['  DOGS  ', 'dog'],
];

for (const [raw, expected] of cases) {
  const got = normalizeGuess(raw).canonical;
  assert.equal(got, expected, `Expected ${raw} -> ${expected}, got ${got}`);
}

const duplicatePairs = [
  ['JUICE!!', 'juices'],
  ['hamburger', 'hamburgers'],
  ['DOGS', 'dog'],
  ['Runs', 'run'],
];

for (const [a, b] of duplicatePairs) {
  const ca = normalizeGuess(a).canonical;
  const cb = normalizeGuess(b).canonical;
  assert.equal(ca, cb, `Expected duplicate canonical forms for ${a} and ${b}`);
}

console.log('word normalization tests passed');

import { EXTRA_THREE_LETTER_WORDS, buildVocabulary } from '../game/vocab.js';

const uniqueThree = new Set(EXTRA_THREE_LETTER_WORDS);
assert.ok(uniqueThree.size >= 300, `Expected at least 300 curated 3-letter words, got ${uniqueThree.size}`);

const vocab = new Set(buildVocabulary(['cow', 'pig', 'tea', 'zzz']));
for (const word of ['cow', 'pig', 'tea']) {
  assert.ok(vocab.has(word), `Expected vocab to contain ${word}`);
}

console.log('three-letter vocabulary checks passed');
