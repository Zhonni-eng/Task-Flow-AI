// Matching category names, so the assistant reuses an existing category instead of creating a
// near-duplicate: same name in another case or word form ("Учёба" / "учеба" / "Учебе"), with
// extra spaces or punctuation, or a known Russian/English variant ("Work" / "Работа").
// Matching is deliberately conservative: anything not clearly the same is treated as different,
// and the user always sees and confirms a new category before it is created.

// Groups of names that mean the same category. Compared after folding (lower case, ё -> е).
const SYNONYM_GROUPS = [
  ['работа', 'work', 'job', 'office', 'офис'],
  ['учеба', 'study', 'studies', 'school', 'education', 'university', 'университет', 'школа'],
  ['дом', 'home', 'household', 'хозяйство', 'house'],
  ['личное', 'личные дела', 'personal', 'private'],
  ['покупки', 'shopping', 'магазин', 'groceries', 'продукты'],
  ['здоровье', 'health', 'medical', 'медицина', 'врачи'],
  ['финансы', 'finance', 'finances', 'money', 'деньги', 'счета', 'bills'],
  ['спорт', 'sport', 'sports', 'fitness', 'фитнес', 'тренировки', 'workout'],
  ['семья', 'family'],
  ['путешествия', 'travel', 'trips', 'поездки'],
  ['проекты', 'projects', 'project', 'проект'],
];

/** Lower case, ё -> е, letters/digits/spaces only, single spaces. */
export function foldCategoryName(name) {
  return String(name ?? '')
    .toLocaleLowerCase('ru')
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Same word, or the same stem: the shorter word minus its last letter starts the longer one. */
function sameWord(a, b) {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length < 4 || long.length - short.length > 3) return false;
  return long.startsWith(short.slice(0, short.length - 1));
}

function sameName(a, b) {
  const wordsA = a.split(' ');
  const wordsB = b.split(' ');
  return wordsA.length === wordsB.length && wordsA.every((word, index) => sameWord(word, wordsB[index]));
}

const groupOf = (folded) => SYNONYM_GROUPS.findIndex((group) => group.some((name) => sameName(name, folded)));

/** The existing category that `name` refers to, or null. */
export function findMatchingCategory(name, categories) {
  const folded = foldCategoryName(name);
  if (!folded) return null;
  const direct = categories.find((category) => sameName(foldCategoryName(category.name), folded));
  if (direct) return direct;
  const group = groupOf(folded);
  if (group < 0) return null;
  return categories.find((category) => groupOf(foldCategoryName(category.name)) === group) ?? null;
}
