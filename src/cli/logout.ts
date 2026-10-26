import { clearSession } from "../session.ts";

await clearSession();
console.log("Logged out of CEdX (saved session removed).");
