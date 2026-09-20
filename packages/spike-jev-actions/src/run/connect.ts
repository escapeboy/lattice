/**
 * Median TCP+TLS connect time to api.typesafe.ai from this machine.
 *
 * Separating connect from the request answers a question the per-call latency
 * cannot: how much of the round trip is the transatlantic hop itself, and how
 * much would survive a connection-reuse or co-location change.
 */

import { connect as tlsConnect } from "node:tls";

const HOST = "api.typesafe.ai";
const PORT = 443;
const SAMPLES = 15;

function once(): Promise<{ tcpMs: number; tlsMs: number }> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    let tcpMs = 0;
    const socket = tlsConnect({ host: HOST, port: PORT, servername: HOST }, () => {
      const tlsMs = performance.now() - started;
      socket.destroy();
      resolve({ tcpMs, tlsMs });
    });
    socket.once("connect", () => {
      tcpMs = performance.now() - started;
    });
    socket.setTimeout(10_000, () => {
      socket.destroy();
      reject(new Error("connect timeout"));
    });
    socket.once("error", reject);
  });
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export async function connectStats(): Promise<void> {
  const tcp: number[] = [];
  const tls: number[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    const r = await once();
    tcp.push(r.tcpMs);
    tls.push(r.tlsMs);
  }
  console.log(
    JSON.stringify(
      {
        host: HOST,
        samples: SAMPLES,
        tcp_connect_ms: { median: +median(tcp).toFixed(1), min: +Math.min(...tcp).toFixed(1), max: +Math.max(...tcp).toFixed(1) },
        tcp_plus_tls_ms: { median: +median(tls).toFixed(1), min: +Math.min(...tls).toFixed(1), max: +Math.max(...tls).toFixed(1) },
      },
      null,
      2,
    ),
  );
}
