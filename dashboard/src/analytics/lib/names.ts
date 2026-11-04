/**
 * Friendly, stable names for anonymous visitors ("Amber Heron"), derived from the visitor id so
 * the same visitor always gets the same name. Identified visitors show their profile name.
 */

const ADJECTIVES = [
  "Amber",
  "Azure",
  "Brave",
  "Bright",
  "Calm",
  "Cedar",
  "Coral",
  "Crimson",
  "Dusky",
  "Gentle",
  "Golden",
  "Hazel",
  "Indigo",
  "Ivory",
  "Jade",
  "Lively",
  "Lunar",
  "Maple",
  "Misty",
  "Nimble",
  "Olive",
  "Quiet",
  "Rosy",
  "Rustic",
  "Sandy",
  "Silver",
  "Sunny",
  "Swift",
  "Teal",
  "Velvet",
  "Witty",
  "Zesty",
];

const ANIMALS = [
  "Badger",
  "Bison",
  "Crane",
  "Dolphin",
  "Falcon",
  "Ferret",
  "Finch",
  "Fox",
  "Gecko",
  "Hare",
  "Heron",
  "Ibex",
  "Koala",
  "Lark",
  "Lemur",
  "Lynx",
  "Marten",
  "Moose",
  "Newt",
  "Otter",
  "Owl",
  "Panda",
  "Puffin",
  "Quail",
  "Raven",
  "Seal",
  "Sparrow",
  "Stoat",
  "Tapir",
  "Walrus",
  "Wombat",
  "Yak",
];

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function randomVisitorName(visitorId: string): string {
  const h = hash(visitorId);
  return `${ADJECTIVES[h % ADJECTIVES.length]} ${ANIMALS[(h >>> 8) % ANIMALS.length]}`;
}

export function visitorName(
  visitorId: string,
  displayName?: string | null,
  userId?: string | null,
): string {
  return displayName?.trim() || userId?.trim() || randomVisitorName(visitorId);
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}
