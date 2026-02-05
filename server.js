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
function getCreds(body) {
  const username = body?.username || body?.email || ""; // accept email for backwards compat
  const password = body?.password || "";
  return { username, password };
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

// IMPORTANT: GarminConnect constructor requires credentials (username+password)
function createGarminClient({ username, password }) {
  if (!username || !password) {
    throw new Error("Missing credentials (username/password required in constructor)");
  }
  return new GarminConnect({ username, password });
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
// Garmin connect (safe)
// --------------------
app.post("/garmin/connect", requireApiKey, async (req, res) => {
  const debug = req.body?.debug === true;

  try {
    const { tokenJson, dryRun } = req.body || {};
    const { username, password } = getCreds(req.body || {});

    // Dry-run mode: verifies request shape without calling Garmin
    if (dryRun === true) {
      return res.json({
        ok: true,
        dryRun: true,
        received: {
          hasUsername: Boolean(username),
          hasEmail: Boolean(req.body?.email),
          hasPassword: Boolean(password),
          hasTokenJson: Boolean(tokenJson),
          contentType: req.headers["content-type"] || null,
        },
        expected: {
          bodyFields: ["username (or email)", "password", "tokenJson(optional)"],
        },
      });
    }

    // Constructor requires creds (per library)
    if (!username || !password) {
      return res.status(400).json({
        ok: false,
        error: "Missing credentials. Send username+password (or email+password).",
      });
    }

    const client = createGarminClient({ username, password });

    let connected = false;

    // 1) Try token first (to avoid password login / rate limits)
    if (tokenJson) {
      try {
        await client.loadToken(tokenJson);
        connected = true;
      } catch (e) {
        // token invalid/expired; fall back to password login
      }
    }

    // 2) If token didn't work, do ONE password login attempt with cooldown
    if (!connected) {
      const gate = canAttemptPasswordLogin(username);
      if (!gate.ok) {
        return res.status(429).json({
          ok: false,
          error: `Cooldown active. Wait ${Math.ceil(gate.waitMs / 1000)}s before trying password login again.`,
        });
      }

      markPasswordLoginAttempt(username);

      // Since client already has creds, login() can be called with no args
      await client.login();
      connected = true;
    }

    // 3) Export fresh token for storage in Base44
    const exported = await client.exportToken();

    return res.json({ ok: true, tokenJson: exported });
  } catch (err) {
    console.error("Garmin connect error:", err?.message || err);
    return res.status(500).json({
      ok: false,
      error: err?.message || String(err),
      ...(debug ? { stack: err?.stack } : {}),
    });
  }
});

// --------------------
// Start server
// --------------------
const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Listening on", port));
