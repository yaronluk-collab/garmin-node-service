import express from "express";
import pkg from "@flow-js/garmin-connect";

const { GarminConnect } = pkg;

const app = express();
app.use(express.json());

/* ---------------------------------------------------
   API KEY AUTH
--------------------------------------------------- */

function requireApiKey(req, res, next) {
  try {
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";

    if (!process.env.API_KEY || token !== process.env.API_KEY) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    next();
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Auth middleware crashed" });
  }
}

/* ---------------------------------------------------
   HEALTH
--------------------------------------------------- */

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

/* ---------------------------------------------------
   DEBUG: AUTH HEADER CHECK
--------------------------------------------------- */

app.get("/debug/auth", (req, res) => {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";

  res.json({
    hasEnvApiKey: Boolean(process.env.API_KEY),
    envApiKeyLength: process.env.API_KEY?.length ?? 0,
    gotAuthHeader: Boolean(auth),
    authPrefix: auth.slice(0, 7),
    gotTokenLength: token.length,
    tokenFirst8: token.slice(0, 8),
  });
});

/* ---------------------------------------------------
   DEBUG: BODY SHAPE
--------------------------------------------------- */

app.post("/debug/body", requireApiKey, (req, res) => {
  res.json({
    contentType: req.headers["content-type"] || null,
    body: req.body,
    keys: req.body ? Object.keys(req.body) : null,
  });
});

/* ---------------------------------------------------
   DEBUG: ROUTE VERIFICATION
--------------------------------------------------- */

app.get("/debug/route", (req, res) => {
  res.json({
    ok: true,
    method: req.method,
    path: req.path,
    originalUrl: req.originalUrl,
    contentType: req.headers["content-type"] || null,
    hasBody: Boolean(req.body),
    bodyKeys: req.body ? Object.keys(req.body) : [],
  });
});

/* ---------------------------------------------------
   DEBUG: GARMIN EXPORT STRUCTURE
--------------------------------------------------- */

app.get("/debug/garmin-exports", requireApiKey, (req, res) => {
  try {
    res.json({
      ok: true,
      typeofPkg: typeof pkg,
      keys: Object.keys(pkg || {}),
      hasGarminConnect: Boolean(pkg?.GarminConnect),
      typeofGarminConnect: typeof pkg?.GarminConnect,
      hasPrototype: Boolean(pkg?.GarminConnect?.prototype),
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: e?.message || String(e),
    });
  }
});

/* ---------------------------------------------------
   DEBUG: GARMIN METHODS (SAFE — NO INSTANCE)
--------------------------------------------------- */

app.get("/debug/garmin-methods", requireApiKey, (req, res) => {
  try {
    const GC = GarminConnect;

    const typeofGC = typeof GC;
    const hasPrototype = Boolean(GC && GC.prototype);

    let methods = [];

    if (hasPrototype) {
      const proto = GC.prototype;

      methods = Object.getOwnPropertyNames(proto).filter(
        (k) => k !== "constructor" && typeof proto[k] === "function"
      );
    }

    res.json({
      ok: true,
      typeofGarminConnect: typeofGC,
      hasPrototype,
      methodsCount: methods.length,
      methods,
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      where: "/debug/garmin-methods",
      error: e?.message || String(e),
      stack: e?.stack || null,
    });
  }
});

/* ---------------------------------------------------
   GARMIN CONNECT
--------------------------------------------------- */

/*
  Password login cooldown
  Protects against Garmin account lockout
*/

const lastPasswordLoginAttemptByEmail = new Map();
const PASSWORD_LOGIN_COOLDOWN_MS = 10 * 60 * 1000;

/*
  Helper: create Garmin client safely
  Handles class OR factory export
*/

function createGarminClient() {
  if (typeof GarminConnect === "function") {
    try {
      return new GarminConnect();
    } catch {
      return GarminConnect();
    }
  }

  throw new Error("GarminConnect export is not callable");
}

app.post("/garmin/connect", requireApiKey, async (req, res) => {
  try {
    const { email, password, tokenJson, dryRun } = req.body || {};

    /* ---------- Dry Run ---------- */

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

    const client = createGarminClient();
    let connected = false;

    /* ---------- TOKEN LOGIN ---------- */

    if (tokenJson) {
      try {
        if (typeof client.loadToken === "function") {
          await client.loadToken(tokenJson);
          connected = true;
        }
      } catch (e) {
        console.log("Token login failed, will attempt password login");
      }
    }

    /* ---------- PASSWORD LOGIN ---------- */

    if (!connected) {
      if (!email || !password) {
        return res.status(400).json({
          ok: false,
          error: "Missing credentials",
        });
      }

      if (typeof client.login !== "function") {
        throw new Error("Garmin client has no login() method");
      }

      const now = Date.now();
      const last = lastPasswordLoginAttemptByEmail.get(email) || 0;
      const waitMs = PASSWORD_LOGIN_COOLDOWN_MS - (now - last);

      if (waitMs > 0) {
        return res.status(429).json({
          ok: false,
          error: `Cooldown active. Wait ${Math.ceil(waitMs / 1000)}s`,
        });
      }

      lastPasswordLoginAttemptByEmail.set(email, now);

      console.log("[Garmin] Password login attempt");

      await client.login(email, password);
      connected = true;

      console.log("[Garmin] Password login success");
    }

    /* ---------- EXPORT TOKEN ---------- */

    if (typeof client.exportToken !== "function") {
      throw new Error("Garmin client missing exportToken()");
    }

    const exported = await client.exportToken();

    res.json({
      ok: true,
      tokenJson: exported,
    });
  } catch (err) {
    console.error("Garmin connect error:", err);

    res.status(500).json({
      ok: false,
      error: err?.message || String(err),
      stack: err?.stack || null,
    });
  }
});

/* ---------------------------------------------------
   GLOBAL ERROR HANDLER
--------------------------------------------------- */

app.use((err, req, res, next) => {
  console.error("UNHANDLED ERROR:", err);

  res.status(500).json({
    ok: false,
    error: err?.message || String(err),
    stack: err?.stack || null,
  });
});

/* ---------------------------------------------------
   START SERVER
--------------------------------------------------- */

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log("Listening on", port);
});
