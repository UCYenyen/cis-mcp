import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { loginWithCredentials } from "../auth.ts";
import { SESSION_FILE } from "../config.ts";

let muted = false;
const output = new Writable({
  write(chunk: Buffer, _encoding, callback) {
    if (!muted) process.stdout.write(chunk);
    callback();
  },
});
const rl = createInterface({ input: process.stdin, output, terminal: true });

async function ask(question: string, hidden = false): Promise<string> {
  const answer = rl.question(question);
  muted = hidden;
  const value = await answer;
  if (hidden) process.stdout.write("\n");
  muted = false;
  return value.trim();
}

async function main(): Promise<void> {
  console.log("Ciputra CEdX Login (student.ciputra.ac.id)\n");
  const username = await ask("Username (or email/NIM): ");
  const password = await ask("Password: ", true);

  if (!username || !password) {
    console.error("Username and password are required.");
    process.exitCode = 1;
    return;
  }

  console.log("Signing in to CEdX...");
  const session = await loginWithCredentials(username, password);
  console.log(`\n✓ Logged in as ${session.fullName} (${session.username})`);
  console.log(`✓ Session saved to ${SESSION_FILE}`);
}

try {
  await main();
} catch (error) {
  console.error(`\nLogin failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  rl.close();
}
