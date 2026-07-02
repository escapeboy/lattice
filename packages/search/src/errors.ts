/**
 * Typed search failures — a provider failure is a NAMED error the agent can
 * branch on, never a silent empty result list.
 */

export type SearchErrorCode =
  | "search_config"
  | "search_egress_blocked"
  | "search_upstream"
  | "search_parse";

export class SearchError extends Error {
  constructor(readonly code: SearchErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "SearchError";
  }
}

/** Provider selection/credentials are misconfigured (boot-time detectable). */
export class SearchConfigError extends SearchError {
  constructor(message: string) {
    super("search_config", message);
    this.name = "SearchConfigError";
  }
}

/** The egress firewall refused the provider request (destination not allowlisted). */
export class SearchEgressBlockedError extends SearchError {
  constructor(destination: string) {
    super("search_egress_blocked", `egress firewall blocked search request to ${destination}`);
    this.name = "SearchEgressBlockedError";
  }
}

/** The upstream engine answered with a failure (HTTP error, bot challenge, network). */
export class SearchUpstreamError extends SearchError {
  constructor(message: string, readonly status?: number) {
    super("search_upstream", message);
    this.name = "SearchUpstreamError";
  }
}

/** The upstream answered 200 but the body doesn't parse as results. */
export class SearchParseError extends SearchError {
  constructor(message: string) {
    super("search_parse", message);
    this.name = "SearchParseError";
  }
}
