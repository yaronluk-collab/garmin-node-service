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
// Health + basic debug
// --------------------
app.get("/health", (req, res) => res.json({ ok: true }));

app.get("/debug/route", (req, res) => {
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

app.get("/debug/auth", (req, res) => {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  res.json({
    hasEnvApiKey: Boolean(process.env.API_KEY),
    envApiKeyLength: process.env.API_KEY?.length ?? 0,
    gotAuthHeader: Boolean(auth),
    authPrefix: auth.slice(0, 7), // "Bearer "
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

// --------------------
// Garmin library introspection (SAFE)
// --------------------
app.get("/debug/garmin-exports", requireApiKey, (req, res) => {
  const keys = Object.keys(pkg || {});
  res.json({
    ok: true,
    typeofPkg: typeof pkg,
    keys,
    hasGarminConnect: Boolean(pkg?.GarminConnect),
  });
});

// List prototype methods (SAFE: does not hit Garmin)
app.get("/debug/garmin-methods", requireApiKey, (req, res) => {
  const client = new GarminConnect();
  const proto = Object.getPrototypeOf(client);
  const methods = Object.getOwnPropertyNames(proto).filter(
    (k) => k !== "constructor" && typeof client[k] === "function"
  );
  res.json({ ok: true, methods });
});

// --------------------
// Garmin connect (REAL)
// --------------------

// In-memory cooldown (resets when Render restarts)
const lastPasswordLoginAttemptByUsername = new Map();
const PASSWORD_LOGIN_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes

app.post("/garmin/connect", requireApiKey, async (req, res) => {
  try {
    const { username, password, token, dryRun } = req.body || {};

    // Dry-run mode: verify shape without calling Garmin
    if (dryRun === true) {
      return res.json({
        ok: true,
        dryRun: true,
        received: {
          hasUsername: Boolean(username),
          hasPassword: Boolean(password),
          hasToken: Boolean(token),
          tokenKeys: token ? Object.keys(token) : [],
          contentType: req.headers["content-type"] || null,
        },
      });
    }

    const client = new GarminConnect();
    let connected = false;

    // 1) Try token first (README: loadToken(oauth1, oauth2))
    if (token?.oauth1 && token?.oauth2) {
      try {
        await client.loadToken(token.oauth1, token.oauth2);
        connected = true;
      } catch (e) {
        console.log("Token load failed; will try password login if provided.");
      }
    }

    // 2) If token didn't work, try password login (with cooldown)
    if (!connected) {
      if (!username || !password) {
        return res.status(400).json({ ok: false, error: "Missing credentials (username/password)" });
      }

      const now = Date.now();
      const last = lastPasswordLoginAttemptByUsername.get(username) || 0;
      const waitMs = PASSWORD_LOGIN_COOLDOWN_MS - (now - last);
      if (waitMs > 0) {
        return res.status(429).json({
          ok: false,
          error: `Cooldown active. Wait ${Math.ceil(waitMs / 1000)}s before trying password login again.`,
        });
      }

      lastPasswordLoginAttemptByUsername.set(username, now);

      // README pattern: login(username, password)
      await client.login(username, password);
      connected = true;
    }

    // 3) Export fresh token for storage (README: exportToken())
    const exported = await client.exportToken(); // { oauth1, oauth2 }

    return res.json({ ok: true, token: exported });
  } catch (err) {
    console.error("Garmin connect error:", err?.message || err);
    return res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Listening on", port));
