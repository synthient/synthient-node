import { APIError, Synthient, toDate, type IPInfo, type ProxyEvent } from "@synthient/synthient";
import { fetchSchema, type Schema } from "@synthient/synthient/grpcschema";

const client = new Synthient({ apiKey: "key", maxRetries: 1, timeout: 30_000 });

export async function riskScore(ip: string): Promise<number | undefined> {
  try {
    const info: IPInfo = await client.lookupIP(ip, { signal: AbortSignal.timeout(5000) });
    return info.intelligence?.risk_score;
  } catch (error) {
    if (error instanceof APIError && error.status === 402) {
      return undefined;
    }
    throw error;
  }
}

export async function firstEvent(): Promise<ProxyEvent | undefined> {
  for await (const event of client.proxies.stream()) {
    if (event.timestamp !== undefined) {
      toDate(event.timestamp);
    }
    return event;
  }
  return undefined;
}

export async function download(): Promise<ReadableStream<Uint8Array>> {
  return client.proxies.download("latest");
}

export function schema(): Promise<Schema> {
  return fetchSchema({ endpoint: "localhost:50051", plaintext: true });
}
