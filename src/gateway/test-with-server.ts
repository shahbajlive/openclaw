import { afterEach, beforeEach } from "vitest";
import { startServerWithClient } from "./test-helpers.js";
import { connectOk } from "./test-helpers.js";

type StartServerWithClient = typeof startServerWithClient;
export type GatewayWs = Awaited<ReturnType<StartServerWithClient>>["ws"];
export type GatewayServer = Awaited<ReturnType<StartServerWithClient>>["server"];

export async function withServer<T>(run: (ws: GatewayWs) => Promise<T>): Promise<T> {
  const { server, ws, envSnapshot } = await startServerWithClient("secret");
  try {
    return await run(ws);
  } finally {
    ws.close();
    await server.close();
    envSnapshot.restore();
  }
}

export function installConnectedControlUiServerSuite(
  onReady: (started: { server: GatewayServer; ws: GatewayWs; port: number }) => void,
): void {
  let started: Awaited<ReturnType<StartServerWithClient>> | null = null;

  beforeEach(async () => {
    started = await startServerWithClient(undefined, { controlUiEnabled: true });
    onReady({
      server: started.server,
      ws: started.ws,
      port: started.port,
    });
    await connectOk(started.ws);
  });

  afterEach(async () => {
    started?.ws.close();
    if (started?.server) {
      await started.server.close();
    }
    started = null;
  });
}
