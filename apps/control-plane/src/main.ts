/**
 * Control plane — standalone HTTP + SSE entrypoint.
 *
 * Env:
 *   CONTROL_PLANE_PORT  listen port (default 7900)
 *   CONTROL_PLANE_HOST  bind host (default 127.0.0.1)
 */

import { ControlPlaneServer } from "./server.js";

async function main(): Promise<void> {
  const port = Number(process.env["CONTROL_PLANE_PORT"] ?? "7900");
  const host = process.env["CONTROL_PLANE_HOST"] ?? "127.0.0.1";

  const server = new ControlPlaneServer();
  const { url } = await server.start(port, host);
  console.error(`Lattice control plane on ${url}`);

  const shutdown = () => {
    void server.stop().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
