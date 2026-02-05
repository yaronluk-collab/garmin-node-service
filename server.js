import express from "express";
import { GarminConnect } from "@flow-js/garmin-connect";

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

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Listening on", port));
