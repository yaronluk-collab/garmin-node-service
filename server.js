import express from "express";
import pkg from "@flow-js/garmin-connect";
const { GarminConnect } = pkg;

const app = express();
app.use(express.json());

// --------------------
// Auth (API key)
// --------------------
function requireApiKey(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!process.env.API_KEY || token !== process.env.API_KEY) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  next();
}

// --------------------
// Helpers
// --------------------
function getUsernameFromReq(req) {
  return req.body?.username || req.body?.email || ""; // accept email for backwards compat
}

// In-memory cooldown (resets on restart)
const lastPasswordLoginAttemptByUsername = new Map();
const PASSWORD_LOGIN_COOLDOWN_MS = 10 * 60 * 1000; // 10 min

function canAttemptPasswordLogin(username) {
  const now = Date.now();
  const last = lastPasswordLoginAttemptByUsername.get(username) || 0;
  const waitMs = PASSWORD_LOGIN_COOLDOWN_MS - (now - last);
  return { ok: waitMs <= 0, waitMs: Math.max(0, waitMs) };
}

function markPasswordLoginAttempt(username) {
  lastPasswordLoginAttemptByUsername.set(username, Date.now());
}

// IMPORTANT: In your environment this library requires username+password in constructor.
// For token-only endpoints we pass a dummy non-empty password and NEVER call login().
function createGarminClientForTokenOnly(username) {
  if (!username) throw new Error("Missing username (or email)");
  return new GarminConnect({ username, password: "__token_only__" });
}

function createGarminClientForLogin(username, password) {
  if (!username || !password) {
    throw new Error("Missing credentials. Provide username (or email) and password.");
  }
  return new GarminConnect({ username, password });
}

async function loadTokenIntoClient(client, tokenJson) {
  // tokenJson should be { oauth1: {...}, oauth2: {...} }
  if (tokenJson?.oauth1 && tokenJson?.oauth2) {
    await client.loadToken(tokenJson.oauth1, tokenJson.oauth2);
    return;
  }
  // fallback if someone stored it differently
  await client.loadToken(tokenJson);
}

// --------------------
// Health + Debug routes
// --------------------
app.get("/health", (req, res) => res.json({ ok: true }));

app.get("/debug/auth", (req, res) => {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  res.json({
    hasEnvApiKey: Boolean(process.env.API_KEY),
    envApiKeyLength: process.env.API_KEY?.length ?? 0,
    gotAuthHeader: Boolean(auth),
    authPrefix: auth.slice(0, 7), // should be "Bearer "
    gotTokenLength: token.length,
    tokenFirst8: token.slice(0, 8),
  });
});

app.post("/debug/body", requireApiKey, (req, res) => {
  res.json({
    contentType: req.headers["content-type"] || null,
    body: req.body,
    keys: req.body ? Object.keys(req.body) : null,
  });
});

// Useful to verify what route Express thinks you hit
app.all("/debug/route", (req, res) => {
  res.json({
    ok: true,
    method: req.method,
    path: req.path,
    originalUrl: req.originalUrl,
    contentType: req.headers["content-type"] || null,
    hasBody: Boolean(req.body && Object.keys(req.body).length),
    bodyKeys: req.body ? Object.keys(req.body) : [],
  });
});

// Do NOT instantiate GarminConnect here (constructor needs creds).
app.get("/debug/garmin-methods", requireApiKey, (req, res) => {
  try {
    const proto = GarminConnect?.prototype;
    const methods = proto
      ? Object.getOwnPropertyNames(proto).filter(
          (k) => k !== "constructor" && typeof proto[k] === "function"
        )
      : [];

    res.json({
      ok: true,
      typeofGarminConnect: typeof GarminConnect,
      hasPrototype: Boolean(proto),
      methodsCount: methods.length,
      methods,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

// Optional: show what the module exports look like
app.get("/debug/garmin-exports", requireApiKey, (req, res) => {
  res.json({
    ok: true,
    typeofPkg: typeof pkg,
    keys: pkg ? Object.keys(pkg) : [],
    mention: "GarminConnect should be one of the keys above.",
  });
});

// --------------------
// Garmin: CONNECT (login OR token-first)
// --------------------
app.post("/garmin/connect", requireApiKey, async (req, res) => {
  try {
    const { tokenJson, dryRun } = req.body || {};
    const username = getUsernameFromReq(req);
    const password = req.body?.password || "";

    // ✅ Dry-run: no Garmin calls
    if (dryRun === true) {
      return res.json({
        ok: true,
        dryRun: true,
        received: {
          hasUsername: Boolean(username),
          hasPassword: Boolean(password),
          hasTokenJson: Boolean(tokenJson),
          contentType: req.headers["content-type"] || null,
        },
      });
    }

    // Create client with real creds (connect route is allowed to login)
    if (!username || !password) {
      return res.status(400).json({
        ok: false,
        error: "Missing credentials. Provide username (or email) and password.",
      });
    }
    const client = createGarminClientForLogin(username, password);

    // 1) TOKEN-FIRST (best practice)
    if (tokenJson) {
      try {
        await loadTokenIntoClient(client, tokenJson);

        // Validate token with 1 cheap Garmin call (recommended)
        await client.getUserProfile();

        // Always export latest token (may be refreshed/rotated)
        const refreshed = await client.exportToken();
        return res.json({ ok: true, tokenJson: refreshed });
      } catch (e) {
        // token failed; fall back to password login (below), with cooldown protection
        console.log("Token path failed; will try password login. Reason:", e?.message || e);
      }
    }

    // 2) PASSWORD LOGIN (with cooldown)
    const gate = canAttemptPasswordLogin(username);
    if (!gate.ok) {
      return res.status(429).json({
        ok: false,
        error: `Cooldown active. Wait ${Math.ceil(gate.waitMs / 1000)}s before trying password login again.`,
      });
    }
    markPasswordLoginAttempt(username);

    await client.login(); // creds already in constructor
    const exported = await client.exportToken();

    return res.json({ ok: true, tokenJson: exported });
  } catch (err) {
    console.error("Garmin connect error:", err?.message || err);
    return res.status(500).json({
      ok: false,
      error: err?.message || String(err),
    });
  }
});

// --------------------
// Garmin: PROFILE (TOKEN-ONLY)
// Body: { username/email, tokenJson }
// --------------------
app.post("/garmin/profile", requireApiKey, async (req, res) => {
  try {
    const tokenJson = req.body?.tokenJson;
    const username = getUsernameFromReq(req);

    if (!username) {
      return res.status(400).json({ ok: false, error: "Missing username (or email)" });
    }
    if (!tokenJson?.oauth1 || !tokenJson?.oauth2) {
      return res.status(400).json({ ok: false, error: "Missing tokenJson.oauth1/oauth2" });
    }

    // Token-only client (dummy password; no login() call)
    const client = createGarminClientForTokenOnly(username);
    await loadTokenIntoClient(client, tokenJson);

    const profile = await client.getUserProfile();
    const refreshed = await client.exportToken();

    return res.json({ ok: true, profile, tokenJson: refreshed });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// --------------------
// Garmin: ACTIVITIES (TOKEN-ONLY)
// Body: { username/email, tokenJson, limit? }
// --------------------
app.post("/garmin/activities", requireApiKey, async (req, res) => {
  try {
    const tokenJson = req.body?.tokenJson;
    const username = getUsernameFromReq(req);
    const limitRaw = req.body?.limit;

    if (!username) {
      return res.status(400).json({ ok: false, error: "Missing username (or email)" });
    }
    if (!tokenJson?.oauth1 || !tokenJson?.oauth2) {
      return res.status(400).json({ ok: false, error: "Missing tokenJson.oauth1/oauth2" });
    }

    const n0 = Number(limitRaw ?? 10);
    const n = Number.isFinite(n0) ? Math.max(1, Math.min(n0, 50)) : 10;

    const client = createGarminClientForTokenOnly(username);
    await loadTokenIntoClient(client, tokenJson);

    const activities = await client.getActivities(0, n);
    const refreshed = await client.exportToken();

    return res.json({ ok: true, activities, tokenJson: refreshed });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// --------------------
// --------------------
// --------------------
// Garmin: ACTIVITY DEBUG (PRINT FULL OBJECT)
// Body: { username/email, tokenJson, activityId }
// Also supports: query param ?activityId=...
// --------------------
app.post("/garmin/activity-debug", requireApiKey, async (req, res) => {
  try {
    
    const username = getUsernameFromReq(req);
    const tokenJson = req.body?.tokenJson;

    // Accept activityId from either JSON body OR query param
    const activityIdRaw =
      req.body?.activityId ?? req.query?.activityId ?? req.body?.activityID ?? req.body?.id;

    // Always echo what we actually got (so we stop going in circles)
    const receivedKeys = Object.keys(req.body || {});
    const received = {
      contentType: req.headers["content-type"] || null,
      receivedKeys,
      usernamePresent: Boolean(username),
      activityIdRaw,
      activityIdType: typeof activityIdRaw,
      hasTokenOauth1: Boolean(tokenJson?.oauth1),
      hasTokenOauth2: Boolean(tokenJson?.oauth2),
    };

    if (!username) {
      return res.status(400).json({ ok: false, error: "Missing username (or email)", received });
    }

    if (!tokenJson?.oauth1 || !tokenJson?.oauth2) {
      return res
        .status(400)
        .json({ ok: false, error: "Missing tokenJson.oauth1/oauth2", received });
    }

    // Parse + validate activityId
    const activityIdStr =
      activityIdRaw === undefined || activityIdRaw === null ? "" : String(activityIdRaw).trim();
    const activityIdNum = Number(activityIdStr);

    if (!activityIdStr || !Number.isFinite(activityIdNum) || activityIdNum <= 0) {
      return res.status(400).json({
        ok: false,
        error: "Missing/invalid activityId",
        received,
        parsed: { activityIdStr, activityIdNum },
      });
    }

    const client = createGarminClientForTokenOnly(username);
    await loadTokenIntoClient(client, tokenJson);

    const activity = await client.getActivity(activityIdNum);

    console.log("FULL GARMIN ACTIVITY:");
    console.log(JSON.stringify(activity, null, 2));

    const refreshed = await client.exportToken();

    return res.json({ ok: true, received, activity, tokenJson: refreshed });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// --------------------
// Start server
// --------------------
const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Listening on", port));
