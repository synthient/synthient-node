// Prints proxy sightings from the real-time proxies feed until interrupted, reconnecting
// whenever the server closes the stream. It needs an API key with the PROXY_FIREHOSE scope.
//
//   SYNTHIENT_API_KEY=... node examples/stream.ts
import { setTimeout as sleep } from "node:timers/promises";
import { APIError, Synthient, toDate } from "@synthient/synthient";

const client = new Synthient();
const controller = new AbortController();
process.once("SIGINT", () => {
  controller.abort();
});

while (!controller.signal.aborted) {
  try {
    for await (const event of client.proxies.stream({ signal: controller.signal })) {
      const at = event.timestamp === undefined ? "-" : toDate(event.timestamp).toISOString();
      console.log(at, event.ip, event.provider, event.type, event.country_code);
    }
  } catch (error) {
    if (error === controller.signal.reason) {
      break;
    }
    // A bad key or a missing scope fails the same way on every reconnect.
    if (error instanceof APIError && (error.status === 401 || error.status === 403)) {
      throw error;
    }
    console.error("stream:", error);
  }

  // The server closes each stream after about 30 minutes. Pause before reconnecting so
  // repeated failures stay under the connection rate limit.
  await sleep(2000);
}
