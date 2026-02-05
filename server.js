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
// Always-on route tracer (to prove what you hit)
// --------------------
app.all("/debug/route", requireApiKey, (req, res) => {
  res.json({
    ok: true,
    method: req.method,
    path: req.path,
    originalUrl: req.originalUrl,
    contentType: req.headers["content-type"] || null,
    hasBody: req.body && Object.keys(req.body).length > 0,
    bodyKeys: req.body ? Object.keys(req.body) : [],
  });
});

// --------------------
// Health + Debug routes
// --------------------
app.get("/health", (req, res) => res.json({ ok: true }));

app.get("/debug/garmin-exports", requireApiKey, (req, res) => {
  // No Garmin calls here
  const keys = Object.keys(pkg || {});
  res.json({
    ok: true,
    typeOfPkg: typeof pkg,
    keys,
    hasGarminConnect: keys.includes("GarminConnect"),
    typeOfGarminConnect: typeof pkg?.GarminConnect,
  });
});

app.get("/debug/garmin-methods", requireApiKey, (req, res) => {
  // Also no network calls
  try {
    const Ctor = pkg?.GarminConnect;
    if (typeof Ctor !== "function") {
      return res.status(500).json({
        ok: false,
        error: "GarminConnect export is not a function",
        typeOfGarminConnect: typeof Ctor,
      });
    }

    const client = new Ctor();
    const proto = Object.getPrototypeOf(client);
    const methods = Object.getOwnPropertyNames(proto).filter(
      (k) => k !== "constructor" && typeof client[k] === "function"
    );

    res.json({ ok: true, methods });
  } catch (err) {
    console.error("debug/garmin-methods error:", err?.message || err);
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

// --------------------
// Garmin connect (SAFE-ish)
// --------------------
const lastPasswordLoginAttemptByEmail = new Map();
const PASSWORD_LOGIN_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes

app.post("/garmin/connect", requireApiKey, async (req, res) => {
  try {
    const { email, password, tokenJson, dryRun } = req.body || {};

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

    if (tokenJson) {
      try {
        await client.loadToken(tokenJson);
        connected = true;
      } catch {
        // ignore
      }
    }

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
      await client.login(email, password);
      connected = true;
    }

    // Note: exportToken might be sync; keep it non-awaited to be safe
    const exported = client.exportToken();

    return res.json({ ok: true, tokenJson: exported });
  } catch (err) {
    console.error("Garmin connect error:", err?.message || err);
    return res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Listening on", port));
