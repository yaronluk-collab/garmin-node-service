import express from "express";
import pkg from "@flow-js/garmin-connect";

// Robust import: supports different bundling shapes
const GarminConnect =
  pkg?.GarminConnect ??
  pkg?.default?.GarminConnect ??
  pkg?.default ??
  pkg;

if (typeof GarminConnect !== "function") {
  throw new Error(
    "GarminConnect import failed: expected a constructor function. Check your @flow-js/garmin-connect import shape."
  );
}

const app = express();
app.use(express.json({ limit: "1mb" }));

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
function requestId() {
  return Math.random().toString(16).slice(2, 10);
}

function safeEmailHint(email) {
  if (!email || typeof email !== "string") return null;
  const [u, d] = email.split("@");
  if (!d) return "***";
  return `${u?.slice(0, 2) || ""}***@${d}`;
}

/**
 * Accepts several possible token shapes and normalizes to:
 * { oauth1: <obj>, oauth2: <obj> }
 */
function normalizeTokens(tokenJson) {
  if (!tokenJson || typeof tokenJson !== "object") return null;

  // Preferred: IGarminTokens likely contains oauth1/oauth2
  if (tokenJson.oauth1 && tokenJson.oauth2) {
    return { oauth1: tokenJson.oauth1, oauth2: tokenJson.oauth2 };
  }

  // Some folks store under oauth1Token/oauth2Token
  if (tokenJson.oauth1Token && tokenJson.oauth2Token) {
    return { oauth1: tokenJson.oauth1Token, oauth2: tokenJson.oauth2Token };
  }

  return null;
}

// --------------------
// Health + Debug routes
// --------------------
app.get("/health", (req, res) => res.json({ ok: true }));

// Shows what the module actually exports (helps with ESM/CJS confusion)
app.get("/debug/garmin-exports", requireApiKey, (req, res) => {
  const keys = Object.keys(pkg || {});
  const defaultKeys = pkg?.default ? Object.keys(pkg.default) : [];
  res.json({
    ok: true,
    typeofPkg: typeof pkg,
    keys,
    hasDefault: Boolean(pkg?.default),
    defaultKeys,
    resolvedTypeofGarminConnect: typeof GarminConnect,
  });
});

// Lists instance methods (what you were trying to do) — but guarded + safe
app.get("/debug/garmin-methods", requireApiKey, (req, res) => {
  try {
    const client = new GarminConnect();
    const proto = Object.getPrototypeOf(client);
    const methods = Object.getOwnPropertyNames(proto).filter(
      (k) => k !== "constructor" && typeof client[k] === "function"
    );
    res.json({ ok: true, methods });
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

// --------------------
// Garmin connect
// --------------------

// In-memory cooldown (resets on restart)
const lastPasswordLoginAttemptByEmail = new Map();
const PASSWORD_LOGIN_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes

/**
 * POST /garmin/connect
 * Body:
 *  {
 *    "email": "user@x.com",
 *    "password": "secret",
 *    "tokenJson": { ...IGarminTokens... }  // optional
 *    "dryRun": true|false,                // optional
 *    "verify": true|false                 // optional (calls getUserProfile to validate session)
 *  }
 */
app.post("/garmin/connect", requireApiKey, async (req, res) => {
  const rid = requestId();

  try {
    const { email, password, tokenJson, dryRun, verify } = req.body || {};

    // Dry-run: validate request shape only
    if (dryRun === true) {
      return res.json({
        ok: true,
        dryRun: true,
        received: {
          hasEmail: Boolean(email),
          hasPassword: Boolean(password),
          hasTokenJson: Boolean(tokenJson),
          normalizedTokens: Boolean(normalizeTokens(tokenJson)),
          contentType: req.headers["content-type"] || null,
        },
      });
    }

    // Create client:
    // README supports constructor credentials { username, password } 
    const client =
      email && password
        ? new GarminConnect({ username: email, password })
        : new GarminConnect();

    let connected = false;

    // 1) Token restore path (preferred)
    const tokens = normalizeTokens(tokenJson);
    if (tokens) {
      try {
        client.loadToken(tokens.oauth1, tokens.oauth2); // loadToken(oauth1, oauth2) 
        connected = true;

        // Optional verification call (hits Garmin)
        if (verify === true && typeof client.getUserProfile === "function") {
          await client.getUserProfile();
        }
      } catch (e) {
        console.log(`[${rid}] token login failed; will try password if provided.`);
        connected = false;
      }
    }

    // 2) Password login path (fallback)
    if (!connected) {
      if (!email || !password) {
        return res.status(400).json({
          ok: false,
          error: "Missing credentials",
          hint: "Provide email+password, or a valid tokenJson with oauth1/oauth2.",
        });
      }

      const now = Date.now();
      const last = lastPasswordLoginAttemptByEmail.get(email) || 0;
      const waitMs = PASSWORD_LOGIN_COOLDOWN_MS - (now - last);

      if (waitMs > 0) {
        return res.status(429).json({
          ok: false,
          error: `Cooldown active. Wait ${Math.ceil(waitMs / 1000)}s before trying password login again.`,
        });
      }

      lastPasswordLoginAttemptByEmail.set(email, now);

      console.log(`[${rid}] password login: attempting for ${safeEmailHint(email)}`);

      // login() can be called with no args if credentials were set in constructor  [oai_citation:4‡@flow-js_garmin-connect - npm.html](sediment://file_00000000de7071fdb4d2be7338d5cf6d)
      await client.login();

      connected = true;
    }

    // 3) Export tokens for storage (object form)
    const exported = client.exportToken(); // exportToken(): IGarminTokens  [oai_citation:5‡@flow-js_garmin-connect - npm.html](sediment://file_00000000de7071fdb4d2be7338d5cf6d)

    return res.json({
      ok: true,
      tokenJson: exported,
    });
  } catch (err) {
    console.error(`[${rid}] Garmin connect error:`, err?.message || err);
    return res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

// --------------------
// Start server
// --------------------
const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Listening on", port));
