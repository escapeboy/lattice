/**
 * Serves the 48 fixture pages from localhost. No network, no real account —
 * every page is generated in-process from flows.ts + render.ts.
 */

import { createServer, type Server } from "node:http";
import { FLOWS, VARIANTS, type Flow, type Variant } from "./flows.js";
import { renderFixture } from "./render.js";

export interface FixtureServer {
  readonly port: number;
  urlFor(flowId: string, variant: Variant): string;
  close(): Promise<void>;
}

export function pageCount(): number {
  return FLOWS.length * VARIANTS.length;
}

export async function startFixtureServer(port = 0): Promise<FixtureServer> {
  const byId = new Map<string, Flow>(FLOWS.map((f) => [f.id, f]));

  const server: Server = createServer((req, res) => {
    const [, flowId, variant] = (req.url ?? "").split("?")[0]!.split("/");
    const flow = flowId ? byId.get(flowId) : undefined;
    if (!flow || !VARIANTS.includes(variant as Variant)) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not a fixture");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(renderFixture(flow, variant as Variant));
  });

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const actual = (server.address() as { port: number }).port;

  return {
    port: actual,
    urlFor: (flowId, variant) => `http://127.0.0.1:${actual}/${flowId}/${variant}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
