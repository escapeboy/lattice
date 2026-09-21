/**
 * Minimal TypeSafe System One client.
 *
 * The API key is read from TYPESAFE_API_KEY, which `op run --env-file=.env.op`
 * puts in the environment. It is never logged: `redactHeaders` is the only way
 * headers reach a log line or an error, and jev-client.test.ts asserts that.
 */

export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";

export const REDACTED = "[redacted]";

export interface ChoiceAnswer {
  readonly type: "choice";
  readonly choice: string;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence: number;
}

export interface JevResponse {
  readonly model: string;
  readonly answers: Readonly<Record<string, ChoiceAnswer>>;
  readonly usage: { readonly input_tokens: number; readonly output_tokens: number };
}

export interface JevCallResult {
  readonly response: JevResponse;
  /** HTTP round trip only — no request building, no browser work. */
  readonly latencyMs: number;
  readonly inputTokens: number;
}

/**
 * Strip every credential-bearing header. Anything that logs, traces, or
 * serialises a request MUST go through this — never the raw header object.
 */
export function redactHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const lower = k.toLowerCase();
    out[k] = lower === "authorization" || lower === "x-api-key" || lower === "cookie" ? REDACTED : v;
  }
  return out;
}

export class JevError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly requestHeaders: Readonly<Record<string, string>>,
  ) {
    // The header map on this error is already redacted by the caller; the
    // message never interpolates a header value at all.
    super(`TypeSafe returned HTTP ${status}: ${body.slice(0, 400)}`);
    this.name = "JevError";
  }
}

function apiKey(): string {
  const key = process.env["TYPESAFE_API_KEY"];
  if (!key) {
    throw new Error(
      "TYPESAFE_API_KEY is not set. Run via: op run --env-file=.env.op -- <command>",
    );
  }
  return key;
}

/**
 * One call, concurrency 1 at the call site. `latencyMs` measures the HTTP round
 * trip and nothing else, which is the number the go/no-go depends on.
 */
export async function callJev(
  body: unknown,
  opts: { timeoutMs?: number; retries?: number } = {},
): Promise<JevCallResult> {
  const { timeoutMs = 30_000, retries = 2 } = opts;
  const headers = {
    Authorization: `Bearer ${apiKey()}`,
    "Content-Type": "application/json",
  };

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = performance.now();
    try {
      const res = await fetch(JEV_ENDPOINT, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const latencyMs = performance.now() - started;
      const text = await res.text();
      if (!res.ok) {
        // 429/529 are documented as retryable with backoff.
        if ((res.status === 429 || res.status === 529) && attempt < retries) {
          await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
          continue;
        }
        throw new JevError(res.status, text, redactHeaders(headers));
      }
      const response = JSON.parse(text) as JevResponse;
      return { response, latencyMs, inputTokens: response.usage?.input_tokens ?? 0 };
    } catch (err) {
      lastError = err;
      if (err instanceof JevError) throw err;
      if (attempt >= retries) break;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("TypeSafe call failed");
}

/**
 * Validate a Choice answer before any of it reaches an executor. A malformed
 * distribution is treated as no answer at all, never as a low-confidence one.
 */
export function validateChoice(
  answer: unknown,
  allowedOptions: readonly string[],
): ChoiceAnswer {
  const a = answer as Partial<ChoiceAnswer> | undefined;
  const allowed = new Set(allowedOptions);
  const probs = a?.probabilities;
  const ok =
    a !== undefined &&
    a.type === "choice" &&
    typeof a.choice === "string" &&
    allowed.has(a.choice) &&
    typeof a.confidence === "number" &&
    probs !== undefined &&
    Object.keys(probs).length === allowed.size &&
    Object.keys(probs).every((k) => allowed.has(k)) &&
    Object.values(probs).every((p) => typeof p === "number" && Number.isFinite(p) && p >= 0 && p <= 1) &&
    Math.abs(Object.values(probs).reduce((s, p) => s + p, 0) - 1) < 0.02;
  if (!ok) {
    throw new Error("Invalid Jev choice answer; no action executed.");
  }
  return a as ChoiceAnswer;
}

/** $42 per billion input tokens; output tokens are free. */
export const USD_PER_INPUT_TOKEN = 42 / 1_000_000_000;

export function costUsd(inputTokens: number): number {
  return inputTokens * USD_PER_INPUT_TOKEN;
}
