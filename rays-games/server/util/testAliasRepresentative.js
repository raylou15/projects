import { chooseRepresentative } from "./aliasRepresentative.js";

function assertRepresentative(words, canonical, expected) {
  const actual = chooseRepresentative(words, canonical);
  if (actual !== expected) {
    throw new Error(`Expected representative "${expected}" for canonical "${canonical}" from [${words.join(", ")}], got "${actual}"`);
  }
}

function run() {
  assertRepresentative(["army", "armies"], "army", "army");
  assertRepresentative(["military", "militaries"], "military", "military");
  assertRepresentative(["country", "countries"], "country", "country");
  assertRepresentative(["class", "classes"], "class", "class");
  assertRepresentative(["series"], "series", "series");
  assertRepresentative(["use", "used"], "use", "use");
  assertRepresentative(["walk", "walked", "walking"], "walk", "walk");

  console.log("OK");
}

try {
  run();
} catch (error) {
  console.error(error.message || error);
  process.exit(1);
}
