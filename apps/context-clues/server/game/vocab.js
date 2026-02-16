const WORD_PATTERN = /^[a-z]+(?:'[a-z]+)?$/;

const FOREIGN_STOPWORDS = new Set([
  "que",
  "qui",
  "como",
  "con",
  "sin",
  "una",
  "uno",
  "las",
  "los",
  "para",
  "por",
  "pero",
  "dans",
  "avec",
  "sans",
  "pour",
  "vous",
  "nous",
  "der",
  "die",
  "das",
  "und",
  "nicht",
  "ein",
  "eine",
  "les",
  "des",
  "gli",
  "della",
]);

const EXTRA_THREE_LETTER_WORDS = [
  "ace","act","add","age","ago","aid","aim","air","ale","ant","any","ape","app","arc","are","arm","art",
  "ash","ask","ate","awe","axe","bad","bag","ban","bar","bat","bay","bed","bee","beg","bet","bib","bid",
  "big","bin","bit","boa","bob","bog","boo","bow","box","boy","bra","bud","bug","bun","bus","but","buy",
  "cab","can","cap","car","cat","caw","cod","cog","col","cop","cow","coy","cry","cub","cue","cup","cut",
  "dab","dad","dam","day","den","dew","did","dig","dim","din","dip","dog","dot","dry","due","dug","dye",
  "ear","eat","eel","egg","ego","elf","elk","elm","end","era","eve","eye","fab","fad","fan","far","fat",
  "fax","fed","fee","few","fig","fin","fir","fit","fix","flu","fly","fog","for","fox","fry","fun","fur",
  "gap","gas","gel","gem","get","gig","gin","god","gum","gun","gut","guy","gym","had","ham","has","hat",
  "hay","hem","hen","her","hid","him","hip","his","hit","hog","hop","hot","how","hub","hue","hug","huh",
  "hum","hut","ice","ink","inn","ion","its","jam","jar","jaw","jay","jet","jig","job","jog","joy","jug",
  "key","kid","kin","kit","lab","lad","lag","lap","law","lay","led","leg","let","lid","lie","lip","lit",
  "log","lot","low","mad","man","map","mat","max","may","men","met","mix","mob","mom","mop","mud","mug",
  "nap","net","new","nil","nod","nor","not","now","nun","nut","oak","odd","off","oft","oil","old","one",
  "orb","ore","our","out","owe","owl","own","pad","pal","pan","par","pat","paw","pay","pea","peg","pen",
  "pet","pie","pig","pin","pit","ply","pod","pop","pot","pro","pub","pug","pun","pup","put","rag","ram",
  "ran","rap","rat","raw","ray","red","rib","rid","rig","rim","rip","rob","rod","rot","row","rub","rug",
  "run","rye","sad","sag","sap","sat","saw","say","sea","see","set","sew","she","shy","sip","sir","sit",
  "six","ski","sky","sly","sob","son","sow","soy","spa","spy","sum","sun","tag","tan","tap","tar","tea",
  "ten","the","tie","tin","tip","toe","ton","top","toy","try","tub","tug","two","urn","use","van","vat",
  "vet","vow","wad","wag","war","was","wax","way","web","wed","wee","wet","who","why","wig","win","wit",
  "woe","wok","won","wow","yak","yam","yap","yaw","yay","yes","yet","yew","you","zip","zoo",
];

function normalizeVocabToken(value = "") {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

export function isAllowedVocabToken(token = "") {
  if (!token) return false;
  if (token.length < 3) return false;
  if (!WORD_PATTERN.test(token)) return false;
  if (FOREIGN_STOPWORDS.has(token)) return false;
  if (/[^\x00-\x7F]/.test(token)) return false;
  return true;
}

export function buildVocabulary(rawWords = []) {
  const out = new Set();

  for (const rawWord of rawWords) {
    const token = normalizeVocabToken(rawWord);
    if (!isAllowedVocabToken(token)) continue;
    out.add(token);
  }

  for (const token of EXTRA_THREE_LETTER_WORDS) {
    if (isAllowedVocabToken(token)) out.add(token);
  }

  return [...out].sort();
}

export { EXTRA_THREE_LETTER_WORDS };
