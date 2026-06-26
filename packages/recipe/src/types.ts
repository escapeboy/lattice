/**
 * @lattice/recipe — types for the capability/recipe library (P3.1).
 *
 * A recipe is a per-domain, DECLARATIVE flow: an ordered list of steps, each a
 * semantic locator (role + label — the same vocabulary the IG exposes) plus an
 * action verb from a CLOSED set. It is a shortcut for PERCEPTION and PLANNING,
 * not for gating: applying a recipe resolves each locator against the LIVE IG to
 * a NodeId and routes the resulting command through the same governed actuator as
 * the semantic path. A recipe therefore cannot express a raw ref, a CSS/XPath
 * selector, a URL-by-content, or a script — the types below admit none of those.
 * "Untrusted-source recipe = executable code" is structurally impossible here.
 */

/**
 * A semantic locator: role + label, resolved fresh against the current IG every
 * time the recipe runs. No stable NodeId is baked in (recipes are portable across
 * sessions and survive re-render); no selector/xpath/ref (that would be a perception
 * bypass and a stale-reference hazard).
 */
export interface SemanticLocator {
  readonly role: string;
  readonly label: string;
}

/**
 * The CLOSED set of verbs a recipe step may declare. It is a strict subset of the
 * action vocabulary: no `upload`/`download` (file surface), and crucially no
 * `eval`/script — there is no member that expresses arbitrary code. A recipe that
 * "wants to run JS" cannot be represented.
 */
export type RecipeAction =
  | "navigate"
  | "act"
  | "fill"
  | "select"
  | "set"
  | "submit"
  | "scroll_to"
  | "wait_for"
  | "extract";

export interface RecipeStep {
  readonly action: RecipeAction;
  /** Element-addressed actions (act/fill/select/set/submit/scroll_to) carry a locator. */
  readonly locator?: SemanticLocator;
  /** `navigate` carries a same-origin path/url (still scope-checked by the kernel). */
  readonly url?: string;
  /** `fill`/`select`/`set` carry a value. */
  readonly value?: string;
  /** `extract` carries a query. */
  readonly query?: string;
}

/**
 * Provenance of a recipe. A recipe authored/curated by the operator is `trusted`;
 * one pulled from a marketplace or suggested by page content is `untrusted` and is
 * treated as TAINTED INPUT — its steps still run through the gate like anything
 * else, and the library marks it so a policy can refuse to auto-apply it.
 */
export type RecipeTrust = "trusted" | "untrusted";

export interface Recipe {
  /** Stable id within an origin, e.g. "login" | "checkout". */
  readonly id: string;
  /** The domain this recipe applies to (origin string). */
  readonly origin: string;
  readonly name: string;
  /** Monotonic version; the library keeps every version. */
  readonly version: number;
  readonly steps: ReadonlyArray<RecipeStep>;
  readonly trust: RecipeTrust;
}

/** A recipe definition before the library assigns a version. */
export type RecipeDef = Omit<Recipe, "version"> & { readonly version?: number };
