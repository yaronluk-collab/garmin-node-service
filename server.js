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

// --------------------
// Garmin connect (safe)
// --------------------

// In-memory cooldown (fine for now; resets when Render restarts)
const lastPasswordLoginAttemptByEmail = new Map();
const PASSWORD_LOGIN_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes

app.post("/garmin/connect", requireApiKey, async (req, res) => {
  try {
    const { email, password, tokenJson, dryRun } = req.body || {};

    // ✅ Dry-run mode: verifies request shape without calling Garmin
    if (dryRun === true) {
      return res.json({
        ok: true,
        dryRun: true,
        received: {
          hasEmail: Boolean(email),
          hasPassword: Boolean(password),
          hasTokenJson: Boolean(tokenJson),
          contentType: req.headers["content-type"] || null,
        },
      });
    }

    const client = new GarminConnect();
    let connected = false;

    // 1) Try token first
    if (tokenJson) {
      try {
        await client.loadToken(tokenJson);
        connected = true;
      } catch (e) {
        console.log("Token login failed; will try password if provided.");
      }
    }

    // 2) If token didn't work, try password (with cooldown)
    if (!connected) {
      if (!email || !password) {
        return res.status(400).json({ ok: false, error: "Missing credentials" });
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

      // ⚠️ Never log the email/password
      await client.login(email, password);
      connected = true;
    }

    // 3) Export fresh token for storage in Base44
    const exported = await client.exportToken();

    return res.json({
      ok: true,
      tokenJson: exported,
    });
  } catch (err) {
    console.error("Garmin connect error:", err?.message || err);
    return res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

// --------------------
// Start server
// --------------------
const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Listening on", port));
