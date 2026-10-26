import { SITE_URL } from "./config.ts";
import { firstMatch } from "./html.ts";
import type { CisSession } from "./session.ts";
import { cookieHeader, mergeSetCookies, saveSession } from "./session.ts";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/**
 * Logs in to the Ciputra CEdX portal using username and password.
 * Saves the session cookie to ~/.config/cis-mcp/session.json on success.
 */
export async function loginWithCredentials(username: string, password: string): Promise<CisSession> {
  const trimmedUser = username.trim();
  if (!trimmedUser) throw new Error("Username cannot be empty.");
  if (!password) throw new Error("Password cannot be empty.");

  // 1. Fetch the login page to acquire initial ci_session cookie and stc token
  const initialRes = await fetch(`${SITE_URL}/`, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });
  if (!initialRes.ok) {
    throw new Error(`Failed to load CEdX login page (HTTP ${initialRes.status}).`);
  }

  const initialHtml = await initialRes.text();
  // Collects every cookie the portal sets; the logged-in state is carried by tokencis, not ci_session.
  const jar: CisSession = {
    siteUrl: SITE_URL,
    ciSession: "-",
    cookies: {},
    username: trimmedUser,
    fullName: "",
    createdAt: new Date().toISOString(),
  };
  mergeSetCookies(jar, initialRes.headers.getSetCookie());
  if (!jar.cookies.ci_session) {
    throw new Error("Could not acquire initial CEdX session cookie.");
  }

  const stc = firstMatch(initialHtml, /name=["']stc["']\s+value=["']([^"']+)["']/i);
  if (!stc) {
    throw new Error("Could not extract security token (stc) from CEdX login page.");
  }

  // 2. Submit credentials to authenticate endpoint
  const params = new URLSearchParams({
    stc,
    username: trimmedUser,
    password,
  });

  const authRes = await fetch(`${SITE_URL}/front/authenticate`, {
    method: "POST",
    headers: {
      "User-Agent": USER_AGENT,
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: cookieHeader(jar),
      Referer: `${SITE_URL}/`,
      Origin: SITE_URL,
    },
    body: params.toString(),
    redirect: "manual",
  });

  mergeSetCookies(jar, authRes.headers.getSetCookie());

  // 3. Inspect redirect target or follow-up page
  const redirectLoc = authRes.headers.get("location");
  let dashboardHtml = "";

  if (redirectLoc) {
    const fullLoc = redirectLoc.startsWith("http")
      ? redirectLoc
      : `${SITE_URL}${redirectLoc.startsWith("/") ? "" : "/"}${redirectLoc}`;

    const followRes = await fetch(fullLoc, {
      headers: {
        "User-Agent": USER_AGENT,
        Cookie: cookieHeader(jar),
      },
    });
    mergeSetCookies(jar, followRes.headers.getSetCookie());

    const followHtml = await followRes.text();

    // Check if redirected back to login page with an error
    const errorMsg = firstMatch(followHtml, /id=["']login-message["'][^>]*>(.*?)<\/div>/is)?.trim();
    if (errorMsg && !/Use your CEdX account to log in/i.test(errorMsg)) {
      throw new Error(`CEdX login failed: ${errorMsg}`);
    }

    if (fullLoc.includes("/student_dashboard")) {
      dashboardHtml = followHtml;
    }
  }

  // 4. Verify login and extract student name from student_dashboard
  if (!dashboardHtml) {
    const dashRes = await fetch(`${SITE_URL}/student_dashboard`, {
      headers: {
        "User-Agent": USER_AGENT,
        Cookie: cookieHeader(jar),
      },
    });
    mergeSetCookies(jar, dashRes.headers.getSetCookie());
    dashboardHtml = await dashRes.text();
  }

  const nameMatch = firstMatch(dashboardHtml, /Hi,\s*([^<&"]+?)\s*[<&"]/i);
  if (!nameMatch) {
    throw new Error(
      "CEdX login failed. Incorrect username or password, or session was rejected.",
    );
  }

  jar.fullName = nameMatch.trim();
  await saveSession(jar);
  return jar;
}
