import express from "express";
import pkg from "@flow-js/garmin-connect";
const { GarminConnect } = pkg;

const app = express();
app.use(express.json());

// Simple API-key protection
function requireApiKey(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!process.env.API_KEY || token !== process.env.API_KEY) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  next();
}

app.get("/health", (req, res) => res.json({ ok: true }));

app.post("/garmin/connect", requireApiKey, async (req, res) => {
  try {
    const { email, password, tokenJson } = req.body;

    const client = new GarminConnect();

    // If token provided, try it first
    if (tokenJson) {
      try {
        await client.loadToken(tokenJson);
      } catch (e) {
        // ignore and fall back to login
      }
    }

    // If not logged in yet, login with credentials
    // (GarminConnect doesn't give a clean "isLoggedIn", so we just attempt login when creds exist)
    if (email && password) {
      await client.login(email, password);
    }

    const exported = client.exportToken();

    return res.json({
      ok: true,
      tokenJson: exported
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});


app.get("/debug/auth", (req, res) => {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  res.json({
    hasEnvApiKey: Boolean(process.env.API_KEY),
    envApiKeyLength: process.env.API_KEY?.length ?? 0,
    gotAuthHeader: Boolean(auth),
    authPrefix: auth.slice(0, 7),          // should be "Bearer "
    gotTokenLength: token.length,
    tokenFirst8: token.slice(0, 8)
  });
});


const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Listening on", port));
