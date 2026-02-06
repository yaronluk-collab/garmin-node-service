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

// Shared handler for token-only endpoints: validates inputs, creates client,
// loads token, runs the action, and returns refreshed tokens.
async function withGarminToken(req, res, actionFn) {
  const tokenJson = req.body?.tokenJson;
  const username = getUsernameFromReq(req);

  if (!username) {
    return res.status(400).json({ ok: false, error: "Missing username (or email)" });
  }
  if (!tokenJson?.oauth1 || !tokenJson?.oauth2) {
    return res.status(400).json({ ok: false, error: "Missing tokenJson.oauth1/oauth2" });
  }

  try {
    const client = createGarminClientForTokenOnly(username);
    await loadTokenIntoClient(client, tokenJson);
    const result = await actionFn(client, req);
    const refreshed = await client.exportToken();
    return res.json({ ok: true, ...result, tokenJson: refreshed });
  } catch (e) {
    const msg = e?.message || String(e);
    const isTokenError = /token|unauthorized|auth|expired|session|403|401/i.test(msg);
    if (isTokenError) {
      return res.status(401).json({
        ok: false,
        error: "Token expired or invalid. Re-authenticate via /garmin/connect.",
      });
    }
    return res.status(500).json({ ok: false, error: "Garmin request failed" });
  }
}

function parseActivityIdFromBody(body) {
  const raw = body?.activityId ?? body?.activityID ?? body?.activity_id ?? body?.id ?? null;

  const parsed =
    typeof raw === "number" ? raw : Number(String(raw ?? "").trim());

  const ok = Number.isFinite(parsed) && parsed > 0;
  return {
    ok,
    activityId: ok ? parsed : null,
    activityIdRaw: raw,
    activityIdRawType: typeof raw,
  };
}

// --------------------
// Health + Debug routes
// --------------------
app.get("/health", (req, res) => res.json({ ok: true }));

app.get("/debug/auth", requireApiKey, (req, res) => {
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
app.all("/debug/route", requireApiKey, (req, res) => {
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
// Debug: ECHO activityId (proves what server receives)
// Body: { activityId } (plus anything else)
// --------------------
app.post("/debug/activity-id", requireApiKey, (req, res) => {
  const parsed = parseActivityIdFromBody(req.body);
  return res.json({
    ok: true,
    receivedKeys: Object.keys(req.body || {}),
    activityIdRaw: parsed.activityIdRaw,
    activityIdRawType: parsed.activityIdRawType,
    parsedActivityId: parsed.activityId,
    parsedActivityIdType: parsed.activityId ? typeof parsed.activityId : null,
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

    // Dry-run: no Garmin calls
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

    // 1) TOKEN-FIRST
    if (tokenJson) {
      try {
        await loadTokenIntoClient(client, tokenJson);

        // Validate token with 1 cheap Garmin call
        await client.getUserProfile();

        // Always export latest token (may be refreshed/rotated)
        const refreshed = await client.exportToken();
        return res.json({ ok: true, tokenJson: refreshed });
      } catch (e) {
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
    await client.login();
    markPasswordLoginAttempt(username); // only burn cooldown on successful login
    const exported = await client.exportToken();
    return res.json({ ok: true, tokenJson: exported });
  } catch (err) {
    console.error("Garmin connect error:", err?.message || err);
    return res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

// --------------------
// Garmin: PROFILE (TOKEN-ONLY)
// Body: { username/email, tokenJson }
// --------------------
app.post("/garmin/profile", requireApiKey, (req, res) =>
  withGarminToken(req, res, async (client) => ({
    profile: await client.getUserProfile(),
  }))
);

// --------------------
// Garmin: ACTIVITIES (TOKEN-ONLY)
// Body: { username/email, tokenJson, offset?, limit? }
// --------------------
app.post("/garmin/activities", requireApiKey, (req, res) =>
  withGarminToken(req, res, async (client, req) => {
    const n0 = Number(req.body?.limit ?? 10);
    const limit = Number.isFinite(n0) ? Math.max(1, Math.min(n0, 50)) : 10;
    const o0 = Number(req.body?.offset ?? 0);
    const offset = Number.isFinite(o0) ? Math.max(0, o0) : 0;
    return { activities: await client.getActivities(offset, limit) };
  })
);

// --------------------
// Garmin: SINGLE ACTIVITY
// Body: { username/email, tokenJson, activityId }
// --------------------
app.post("/garmin/activity", requireApiKey, (req, res) => {
  const parsed = parseActivityIdFromBody(req.body);
  if (!parsed.ok) {
    return res.status(400).json({
      ok: false,
      error: "Missing/invalid activityId",
      receivedKeys: Object.keys(req.body || {}),
      receivedActivityIdRaw: parsed.activityIdRaw,
      receivedType: parsed.activityIdRawType,
    });
  }
  return withGarminToken(req, res, async (client) => ({
    activity: await client.getActivity(parsed.activityId),
  }));
});

// --------------------
// Start server
// --------------------
// Export app and helpers for testing; only start listener when run directly
export {
  app,
  parseActivityIdFromBody,
  canAttemptPasswordLogin,
  markPasswordLoginAttempt,
  lastPasswordLoginAttemptByUsername,
  withGarminToken,
};

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*[\\/]/, ""))) {
  const port = process.env.PORT || 3000;
  const server = app.listen(port, () => console.log("Listening on", port));
  process.on("SIGTERM", () => server.close());
}
