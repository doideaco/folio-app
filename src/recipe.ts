// Deterministic recipe parsing from a freeform social caption (Instagram/TikTok).
// These posts list ingredients as " - " bullets, then a method paragraph. Not
// perfect, but it turns that common shape into a structured recipe so the app
// renders a real recipe card without depending on the on-device model. The
// on-device extractor can still refine when it's available.

const FRACTIONS = "¼½¾⅓⅔⅛⅜⅝⅞";

const UNIT_WORDS = [
  "tbsp", "tablespoon", "tablespoons", "tsp", "teaspoon", "teaspoons",
  "cup", "cups", "g", "gram", "grams", "kg", "ml", "l", "oz",
  "lb", "lbs", "pound", "pounds", "clove", "cloves", "pinch", "handful",
  "can", "cans", "slice", "slices", "stick", "sticks", "sprig", "sprigs",
];

// Words that begin a cooking instruction — used to find where the method starts.
const VERB_STARTS = [
  "combine", "heat", "preheat", "mix", "add", "cook", "stir", "bake", "whisk",
  "season", "place", "pour", "serve", "fry", "roast", "simmer", "blend", "chop",
  "spread", "transfer", "remove", "drizzle", "toss", "marinate", "form", "shape",
  "divide", "cover", "chill", "bring", "reduce", "grill", "boil", "sprinkle",
];

export interface ParsedRecipe {
  ingredients: { qty?: string; unit?: string; item: string }[];
  steps: string[];
}

/**
 * Derive a clean dish title from a recipe caption, so the card shows
 * "Smashed Beef Kabob…" instead of the whole caption wall. Falls back to the
 * provided default when it can't find something sensible.
 */
export function recipeTitle(caption: string | null | undefined, fallback: string): string {
  if (!caption) return fallback;
  let s = caption.replace(/\r/g, "");
  // Drop the Instagram "N likes, M comments - user on date:" prefix (up to first colon).
  s = s.replace(/^\s*\d[\d,.\sKMB]*likes?[\s\S]*?:\s*/i, "");
  // Drop a leading quote and "@handle on Instagram:" style prefixes.
  s = s.replace(/^["“”']+/, "").replace(/^@?[\w.]+\s+on\s+\w+\s*:\s*/i, "");
  // Everything before the first ingredient bullet is the blurb/title area.
  s = s.split(/\n\s*[-•]\s|\s[-•]\s/)[0] ?? s;
  // Prefer the text after a "|" divider (creators put the dish name there).
  if (s.includes("|")) s = s.split("|").pop() ?? s;
  // Cut at marketing phrases.
  s = s.split(/\b(?:check my bio|full (?:written )?recipe|link in bio|recipe below|save this|comment)\b/i)[0] ?? s;
  // If there are multiple sentences, the dish name is usually the last one.
  const sentences = s.split(/(?<=[.!])\s+/).map((x) => x.trim()).filter(Boolean);
  if (sentences.length > 1) s = sentences[sentences.length - 1]!;
  // Drop a leading "Ep 20:" / "Recipe:" label.
  s = s.replace(/^[^:]{0,24}:\s*/, (m) => (/\d|recipe|ep\b/i.test(m) ? "" : m));
  // Drop trailing @mentions and tidy punctuation.
  s = s.replace(/(?:\s+@[\w.]+)+\s*$/, "").replace(/["“”'|:–-]\s*$/, "").trim();
  if (s.length > 70) s = s.slice(0, 70).replace(/\s+\S*$/, "").trim();
  return s.length >= 3 ? s : fallback;
}

/** Does the text carry enough recipe signal to bother parsing? */
export function looksLikeRecipe(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = text.toLowerCase();
  const unitHits = UNIT_WORDS.filter((u) => new RegExp(`\\b${u}\\b`).test(t)).length;
  const hasVerb = VERB_STARTS.some((v) => t.includes(v));
  return unitHits >= 3 || (unitHits >= 2 && hasVerb);
}

function looksLikeIngredient(seg: string): boolean {
  const s = seg.trim();
  if (!s || s.length > 90) return false;
  if (/^\d/.test(s) || new RegExp(`^[${FRACTIONS}]`).test(s)) return true;
  const lower = s.toLowerCase();
  if (UNIT_WORDS.some((u) => new RegExp(`\\b${u}\\b`).test(lower))) return true;
  // A short noun phrase with no sentence punctuation, e.g. "black pepper".
  if (s.split(/\s+/).length <= 4 && !/[.!?]/.test(s)) return true;
  return false;
}

/** Index within a segment where a cooking-instruction clause begins (or -1). */
function methodStartIndex(seg: string): number {
  // A capitalised word (not at position 0) whose lowercase is a cooking verb,
  // or the phrase "In a ...".
  const re = new RegExp(`\\s(${VERB_STARTS.map((v) => v.charAt(0).toUpperCase() + v.slice(1)).join("|")}|In a|In the)\\b`);
  const m = seg.match(re);
  return m && m.index != null ? m.index + 1 : -1;
}

function splitIngredient(raw: string): { qty?: string; unit?: string; item: string } {
  const s = raw.trim().replace(/^[-•]\s*/, "");
  const m = s.match(new RegExp(`^([0-9${FRACTIONS}][0-9${FRACTIONS}\\/.\\s]*)?\\s*([A-Za-z]+)?\\s*(.*)$`));
  if (!m) return { item: s };
  const qty = m[1]?.trim() || undefined;
  const maybeUnit = (m[2] || "").toLowerCase();
  const isUnit = UNIT_WORDS.includes(maybeUnit);
  const unit = isUnit ? m[2] : undefined;
  let item = (isUnit ? (m[3] ?? "") : [m[2], m[3]].filter(Boolean).join(" ")).trim();
  // Strip stray wrapping quotes / trailing sentence punctuation (captions often
  // end the list with a closing quote, e.g. `1 tbsp butter".`).
  item = item.replace(/^["“”']+/, "").replace(/["“”'.]+$/, "").trim();
  return { qty, unit, item: item || s };
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z0-9])/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 8)
    .slice(0, 30);
}

/**
 * Parse a caption into a recipe. Returns null unless we confidently find an
 * ingredient list (≥3), so a non-recipe caption never becomes a bad recipe.
 */
export function parseRecipe(caption: string | null | undefined): ParsedRecipe | null {
  if (!caption) return null;
  const text = caption.replace(/\r/g, "").trim();

  // Bullet segments: " - " / " • " / newline-dash / blank lines.
  const segments = text
    .split(/\s[-•]\s|\n\s*[-•]\s*|\n{2,}/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (segments.length < 4) return null;

  // Find the longest consecutive run of ingredient-like segments — that's the
  // ingredient list. This skips the intro blurb (which often contains " - " too,
  // e.g. "221K likes, 339 comments - user on date: …") and stops at the method.
  const isIng = segments.map(looksLikeIngredient);
  let bestStart = -1, bestLen = 0, curStart = -1, curLen = 0;
  for (let i = 0; i < segments.length; i++) {
    if (isIng[i]) {
      if (curLen === 0) curStart = i;
      curLen++;
      if (curLen > bestLen) { bestLen = curLen; bestStart = curStart; }
    } else {
      curLen = 0;
    }
  }
  if (bestLen < 3) return null;

  const runEnd = bestStart + bestLen - 1;
  const ingredients = segments.slice(bestStart, runEnd + 1).map(splitIngredient);

  // The method is any text after the ingredient run, plus any instruction that
  // got glued onto the last ingredient bullet ("…for serving Combine the yogurt…").
  const methodParts: string[] = [];
  const lastSeg = segments[runEnd] ?? "";
  const cut = methodStartIndex(lastSeg);
  if (cut > 0) {
    ingredients[ingredients.length - 1] = splitIngredient(lastSeg.slice(0, cut).trim());
    methodParts.push(lastSeg.slice(cut).trim());
  }
  methodParts.push(...segments.slice(runEnd + 1));

  return { ingredients, steps: splitSentences(methodParts.join(" ")) };
}
