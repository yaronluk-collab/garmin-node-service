import express from "express";
import pkg from "@flow-js/garmin-connect";
const { GarminConnect } = pkg;

const app = express();
app.use(express.json());

// --------------------
// Small helpers
// --------------------
function requestId() {
  return Math.random().toString(16).slice(2, 10);
}

function safeBool(x) {
  return Boolean(x);
}

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
// Basic routes
// --------------------
app.get("/", (req, res) => res.send("OK"));

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

// --------------------
// Garmin connect guards
// --------------------

// Cooldown + attempt guard (in-memory; resets when Render restarts)
const PASSWORD_LOGIN_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes
const MAX_PASSWORD_ATTEMPTS_PER_HOUR = 3;

const passwordLoginStateByEmail = new Map();
// shape: { lastAttemptMs: number, attempts: number[], lastSuccessMs?: number }
// attempts[] stores timestamps (ms) of recent password login attempts

function pruneAttempts(attempts, windowMs) {
  const cutoff = Date.now() - windowMs;
  return attempts.filter((t) => t >= cutoff);
}

function getOrInitState(email) {
  const existing = passwordLoginStateByEmail.get(email);
  if (existing) return existing;
  const state = { lastAttemptMs: 0, attempts: [] };
  passwordLoginStateByEmail.set(email, state);
  return state;
}

// --------------------
// Garmin connect (safe + explicit)
// --------------------
app.post("/garmin/connect", requireApiKey, async (req, res) => {
  const rid = requestId();

  try {
    const { email, password, tokenJson, dryRun } = req.body || {};

    // ✅ Dry-run: verify request shape without touching Garmin
    if (dryRun === true) {
      return res.json({
        ok: true,
        dryRun: true,
        received: {
          hasEmail: safeBool(email),
          hasPassword: safeBool(password),
          hasTokenJson: safeBool(tokenJson),
          contentType: req.headers["content-type"] || null,
        },
      });
    }

    // Minimal safe logging (no secrets)
    console.log(`[${rid}] /garmin/connect called`, {
      hasEmail: Boolean(email),
      hasPassword: Boolean(password),
      hasTokenJson: Boolean(tokenJson),
      contentType: req.headers["content-type"] || null,
    });

    const client = new GarminConnect();

    // 1) Token path: try token first, if provided
    if (tokenJson) {
      try {
        await client.loadToken(tokenJson);
        const exported = await client.exportToken();
        console.log(`[${rid}] token login: success`);
        return res.json({ ok: true, tokenJson: exported });
      } catch (e) {
        console.log(`[${rid}] token login: failed; will consider password`);
        // fall through to password path
      }
    }

    // 2) Password path: require creds explicitly
    if (!email || !password) {
      // This is a client/request issue -> 400 (not 500)
      return res.status(400).json({ ok: false, error: "Missing credentials" });
    }

    // 3) Cooldown + max attempts guard (prevents lockouts)
    const state = getOrInitState(email);

    // Cooldown since last attempt
    const now = Date.now();
    const waitMs = PASSWORD_LOGIN_COOLDOWN_MS - (now - state.lastAttemptMs);
    if (state.lastAttemptMs && waitMs > 0) {
      return res.status(429).json({
        ok: false,
        error: `Cooldown active. Wait ${Math.ceil(waitMs / 1000)}s before trying password login again.`,
      });
    }

    // Attempts per hour limit
    state.attempts = pruneAttempts(state.attempts, 60 * 60 * 1000);
    if (state.attempts.length >= MAX_PASSWORD_ATTEMPTS_PER_HOUR) {
      return res.status(429).json({
        ok: false,
        error: `Too many password attempts. Try again later.`,
      });
    }

    // Record attempt
    state.lastAttemptMs = now;
    state.attempts.push(now);

    // 4) Perform Garmin login (single attempt)
    console.log(`[${rid}] password login: attempting`);
    await client.login(email, password);

    const exported = await client.exportToken();
    console.log(`[${rid}] password login: success`);

    return res.json({ ok: true, tokenJson: exported });
  } catch (err) {
    // Real errors only -> 500
    console.error(`[${rid}] Garmin connect error:`, err?.message || err);
    return res.status(500).json({
      ok: false,
      error: err?.message || "Internal error",
    });
  }
});

app.get("/debug/garmin-methods", requireApiKey, (req, res) => {
  const client = new GarminConnect();
  const proto = Object.getPrototypeOf(client);
  const methods = Object.getOwnPropertyNames(proto).filter(
    (k) => k !== "constructor" && typeof client[k] === "function"
  );
  res.json({ methods });
});


// --------------------
// Start server
// --------------------
const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Listening on", port));
