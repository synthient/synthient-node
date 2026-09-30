import { Synthient, type Account } from "@synthient/synthient";

export async function account(): Promise<Account> {
  return new Synthient({ apiKey: "key" }).account();
}
