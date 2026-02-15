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
