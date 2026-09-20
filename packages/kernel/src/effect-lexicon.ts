/**
 * Effect lexicon — DATA, versioned, not code.
 *
 * The gate reads page-controlled strings (a control's accessible name, the text
 * of the dialog it sits in) to decide how dangerous an action is. Those strings
 * are EVIDENCE, never authority: a match can only raise the policy class, and
 * nothing here can lower one. See `effect.ts` for the enforcement of that rule.
 *
 * Keeping it as data means the term lists can be reviewed, diffed and extended
 * by someone who is not editing the classifier. Bump `EFFECT_LEXICON_VERSION`
 * on every change so an audit record says which list was in force.
 *
 * MATCHING
 * Word-boundary, case-insensitive, whitespace-normalised. The boundary is
 * Unicode-aware (`\p{L}`), NOT JavaScript's `\b` — `\b` is defined over
 * [A-Za-z0-9_], so every Cyrillic letter counts as a non-word character and
 * `\bплати\b` matches inside `заплатила`. English-only boundaries are a silent
 * correctness hole in a bilingual lexicon, which is why it is spelled out.
 *
 * A trailing `*` marks a STEM: it matches the term plus any run of letters.
 * Bulgarian is inflected (изтрий / изтриване / изтриването), so stems are the
 * normal form there and the exception in English, where over-broad stems
 * misfire ("pay*" hits "payload").
 */

export const EFFECT_LEXICON_VERSION = "2026-09-20.4";

export type LexiconLang = "en" | "bg";

/** A term list keyed by language, so coverage gaps are visible per language. */
export interface TermSet {
  readonly en: readonly string[];
  readonly bg: readonly string[];
}

/**
 * Terms that name a primitive from CONSTITUTIONAL_FLOOR.prohibitedPrimitives.
 * A match makes the action prohibited — refused outright, not escalated.
 */
export interface ProhibitedTerms {
  readonly primitive: string;
  readonly terms: TermSet;
}

export interface EffectLexicon {
  readonly version: string;
  readonly prohibited: readonly ProhibitedTerms[];
  /** Destructive / financial / irreversible / publishing effects. */
  readonly consequential: TermSet;
  /** "cannot be undone" markers — raise a consequential into a hard stop. */
  readonly irreversible: TermSet;
  /** Currency symbols and ISO codes, matched near the control. */
  readonly currency: readonly string[];
}

export const EFFECT_LEXICON: EffectLexicon = {
  version: EFFECT_LEXICON_VERSION,

  prohibited: [
    {
      primitive: "payment",
      terms: {
        // ACTIONS that move money. Topic nouns ("billing", "invoice",
        // "payment methods") live in `consequential` — see the note on
        // acl.change: `prohibited` is a refusal nobody can lift, so a page
        // ABOUT payments must not become unreachable.
        en: [
          "pay", "pay now", "make a payment", "pay invoice", "pay now with",
          "buy", "buy now", "complete purchase", "confirm purchase",
          "checkout", "check out", "proceed to checkout",
          "place order", "place the order", "order now", "confirm order",
          "donate", "give now", "contribute now", "add card",
        ],
        bg: [
          "плати*", "заплати*", "плащам",
          "купи*", "купувам", "закупи*", "поръчай*",
          "дари*",
          "към каса", "завърши поръчката", "потвърди поръчката",
        ],
      },
    },
    {
      primitive: "transfer",
      terms: {
        en: [
          "transfer funds", "transfer money", "wire transfer", "send money",
          "withdraw funds", "withdraw money", "remit",
        ],
        bg: ["банков превод", "преведи сума", "прехвърли средства", "изтегли пари"],
      },
    },
    {
      primitive: "account.create",
      terms: {
        en: [
          "create account", "create an account", "create your account",
          "sign up", "signup", "register now", "new account", "join now",
          "get started free", "open an account",
        ],
        bg: [
          "създай акаунт", "създаване на акаунт", "създай профил",
          "регистрация", "регистрирай*", "нов акаунт", "нов профил",
        ],
      },
    },
    {
      primitive: "acl.change",
      terms: {
        // ACTIONS only. A topic noun ("permissions", "access control") is not
        // an action: "View requested permissions" is a read, and `prohibited`
        // is a refusal no human can lift. Topic nouns sit in `consequential`,
        // where they cost an approval rather than a dead end.
        en: [
          "change permissions", "edit permissions", "set permissions",
          "manage access", "grant access", "revoke access", "allow access",
          "authorise access", "authorize access", "approve access",
          "make admin", "make owner", "transfer ownership", "add collaborator",
        ],
        bg: [
          "промени правата за достъп", "управление на достъпа",
          "дай достъп", "отнеми достъп", "разреши достъп",
          "направи администратор", "прехвърли собствеността",
        ],
      },
    },
    {
      primitive: "permission.change",
      terms: {
        en: ["change role", "assign role", "role assignment", "elevate privileges"],
        bg: ["смени ролята", "задай роля", "промени правата"],
      },
    },
    {
      primitive: "hard_delete",
      terms: {
        en: [
          "delete forever", "delete permanently", "permanently delete",
          "delete my account", "close account", "close my account",
          "delete account", "purge", "wipe", "destroy", "erase everything",
        ],
        bg: [
          "изтрий завинаги", "изтриване завинаги", "премахни завинаги",
          "изтрий акаунта", "изтриване на акаунта", "закрий акаунта",
          "унищожи*", "заличи*",
        ],
      },
    },
    {
      primitive: "captcha",
      terms: {
        en: ["captcha", "recaptcha", "hcaptcha", "i'm not a robot", "im not a robot", "verify you are human"],
        bg: ["не съм робот", "потвърдете, че не сте робот"],
      },
    },
    {
      primitive: "persona_import",
      terms: {
        en: ["import cookies", "import profile", "import session"],
        bg: ["импортирай профил", "внеси профил"],
      },
    },
  ],

  consequential: {
    en: [
      // destructive
      "delete", "deletes", "delete all", "remove", "removes", "discard",
      "erase", "clear all", "reset", "revoke", "deactivate", "disable",
      "block", "ban", "suspend", "archive", "unpublish",
      // sending / publishing — an effect outside the page
      "send", "send now", "submit", "post", "publish", "share",
      "email", "e-mail", "send email", "mail", "forward",
      "reply", "comment", "tweet", "broadcast", "invite",
      // access topics: not a hard refusal, but never a silent auto-grant
      "permissions", "permission", "access control", "acl",
      "authorise", "authorize", "consent to", "connect account",
      // commitment
      "confirm", "accept", "agree and continue", "apply changes",
      "save and submit", "activate", "enable", "install", "uninstall",
      "upgrade", "downgrade", "merge", "approve", "reject",
      // money TOPICS — never a silent auto-grant, never an unliftable refusal
      "payment", "payments", "purchase", "purchases", "billing", "invoice",
      "donation", "donations", "card details", "transfer", "withdraw",
      "withdrawal", "refund", "charge",
      // subscription / order lifecycle
      "subscribe", "subscription", "unsubscribe", "cancel subscription",
      "newsletter", "mailing list", "mailing-list", "join the list",
      "cancel order", "cancel booking", "cancel reservation",
      // files
      "download", "upload", "export", "import",
    ],
    bg: [
      "изтрий*", "изтриване*", "премахни*", "премахване*", "изчисти*",
      "нулирай*", "отмени*", "анулирай*", "деактивирай*", "блокирай*",
      "спри*", "архивирай*", "отнеми*",
      "изпрати*", "изпращане", "публикувай*", "публикуване", "сподели*",
      "имейл*", "препрати*", "поща",
      "отговори", "коментирай*", "покани*",
      "права за достъп", "разрешения", "контрол на достъпа",
      "разреши*", "оторизирай*", "свържи акаунт",
      "плащане*", "плащания", "фактура*", "дарение*", "дарения",
      "превод", "преводи", "теглене", "каса", "поръчка*", "възстановяване на сума",
      "потвърди*", "потвърждение", "приеми*", "приложи промените",
      "активирай*", "инсталирай*", "деинсталирай*", "обнови*", "одобри*",
      "абонирай*", "абонамент*", "отпиши се", "прекрати абонамента",
      "бюлетин*", "пощенски списък", "информационен бюлетин",
      "откажи поръчката", "откажи резервацията",
      "изтегли*", "свали*", "качи*", "експортирай*", "импортирай*",
    ],
  },

  irreversible: {
    en: [
      "cannot be undone", "can't be undone", "cannot be reversed",
      "irreversible", "permanent", "permanently", "forever",
      "cannot be recovered", "can't be recovered", "will be lost",
      "no longer be able", "this cannot be undone", "are you sure",
    ],
    bg: [
      "не може да бъде отменено", "не може да се отмени", "необратимо",
      "необратима", "завинаги", "не може да се възстанови",
      "ще бъде загубено", "сигурни ли сте", "сигурен ли сте",
    ],
  },

  // Symbols and codes only. The amount itself is matched by a digit pattern in
  // the classifier — a lexicon should not try to express arithmetic.
  currency: ["$", "€", "£", "¥", "₤", "₽", "лв", "лв.", "usd", "eur", "gbp", "bgn", "chf", "jpy"],
};

/** Escape a literal for use inside a RegExp source. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Unicode-aware boundaries. See the MATCHING note at the top of this file.
const LEFT = "(?<![\\p{L}\\p{N}_])";
const RIGHT = "(?![\\p{L}\\p{N}_])";

function termPattern(term: string): string {
  const stem = term.endsWith("*");
  const body = stem ? term.slice(0, -1) : term;
  // Whitespace inside a multi-word term matches any run of whitespace.
  const core = escapeRe(body).replace(/\\?\s+/g, "\\s+");
  return stem ? `${LEFT}${core}\\p{L}*${RIGHT}` : `${LEFT}${core}${RIGHT}`;
}

const patternCache = new Map<string, RegExp>();

function compile(terms: readonly string[]): RegExp {
  const key = terms.join("\u0000");
  const cached = patternCache.get(key);
  if (cached) return cached;
  const re = new RegExp(terms.map(termPattern).join("|"), "iu");
  patternCache.set(key, re);
  return re;
}

/** Normalised haystack: lowercase, whitespace collapsed. */
export function normalizeForMatch(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * The first term in `set` that occurs in `text` as a whole word, or undefined.
 * Both languages are always checked — the gate must not depend on correctly
 * guessing a page's language.
 */
export function matchTerm(text: string, set: TermSet): string | undefined {
  const hay = normalizeForMatch(text);
  if (!hay) return undefined;
  for (const lang of ["en", "bg"] as const) {
    const terms = set[lang];
    if (terms.length === 0) continue;
    const m = compile(terms).exec(hay);
    if (m) return m[0];
  }
  return undefined;
}

/** True when `text` carries a currency symbol/code next to a number. */
export function hasMonetaryAmount(text: string): boolean {
  const hay = normalizeForMatch(text);
  if (!hay) return false;
  for (const c of EFFECT_LEXICON.currency) {
    const cur = escapeRe(c);
    // symbol before the number, or after it (1 200 лв. / €19.99)
    if (new RegExp(`${cur}\\s*\\d`, "iu").test(hay)) return true;
    if (new RegExp(`\\d[\\d\\s.,]*\\s*${cur}${RIGHT}`, "iu").test(hay)) return true;
  }
  return false;
}
