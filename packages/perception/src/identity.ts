import { createHash } from "node:crypto";
import type { NodeRole } from "./types.js";

export interface IdentityInput {
  role: NodeRole;
  axName: string;
  /** CDP backendDOMNodeId — stable for the same DOM node across mutations. Primary key. */
  backendDOMNodeId?: number;
  explicitId?: string;
  href?: string;
  ancestorRoles: string[];
  ordinal: number;
}

export function computeNodeId(input: IdentityInput): string {
  const { role, axName, backendDOMNodeId, explicitId, href, ancestorRoles, ordinal } = input;

  let fingerprint: string;
  if (backendDOMNodeId !== undefined) {
    // CDP backendDOMNodeId is stable across label/value mutations for the same DOM node
    fingerprint = `bdn:${backendDOMNodeId}`;
  } else if (explicitId && /^[a-zA-Z][\w-]{1,}$/.test(explicitId)) {
    fingerprint = `id:${explicitId}`;
  } else {
    const normalName = axName.trim().toLowerCase().slice(0, 80);
    const path = ancestorRoles.slice(-5).join(">");
    const hrefPart = href ? `:${href.slice(0, 60)}` : "";
    fingerprint = `${role}:${normalName}${hrefPart}:${path}:${ordinal}`;
  }

  const hash = createHash("sha256").update(fingerprint).digest("hex").slice(0, 12);
  return `${role}-${hash}`;
}
