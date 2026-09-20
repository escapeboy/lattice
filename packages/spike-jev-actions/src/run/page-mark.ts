/**
 * Did the last action do anything?
 *
 * Three cheap signals read in one round trip. The loop needs to know whether an
 * action had ANY observable effect, not what the effect was: that is what loop
 * detection keys on, and what the model is told when a step achieved nothing.
 */

export interface CdpLike {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

export interface PageMark {
  readonly url: string;
  readonly scrollY: number;
  /** Serialised body length — blunt, but it catches a panel opening or a list re-rendering. */
  readonly domSize: number;
}

export interface ObservedEffect {
  readonly urlChanged: boolean;
  readonly scrollChanged: boolean;
  readonly domChanged: boolean;
}

export const NO_EFFECT: ObservedEffect = { urlChanged: false, scrollChanged: false, domChanged: false };

export async function markPage(cdp: CdpLike): Promise<PageMark> {
  try {
    const r = (await cdp.send("Runtime.evaluate", {
      expression:
        "JSON.stringify({url:location.href,scrollY:Math.round(scrollY),domSize:document.body?document.body.innerHTML.length:0})",
      returnByValue: true,
    })) as { result?: { value?: string } };
    const v = r.result?.value;
    if (typeof v === "string") return JSON.parse(v) as PageMark;
  } catch {
    /* a navigation mid-read is itself a change; the empty mark differs from any real one */
  }
  return { url: "", scrollY: -1, domSize: -1 };
}

/** The DOM moves on its own, so only a sizeable delta counts as "something happened". */
export function effectOf(before: PageMark, after: PageMark): ObservedEffect {
  return {
    urlChanged: before.url !== after.url,
    scrollChanged: Math.abs(before.scrollY - after.scrollY) > 16,
    domChanged: Math.abs(before.domSize - after.domSize) > 64,
  };
}
