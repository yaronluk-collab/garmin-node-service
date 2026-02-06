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
// Activity field profiles
// --------------------
const SUMMARY_FIELDS = [
  "activityId",
  "activityName",
  "activityType",
  "sportTypeId",
  "startTimeLocal",
  "duration",
  "distance",
  "calories",
  "averageHR",
  "maxHR",
  "elevationGain",
  "steps",
];

const COACHING_FIELDS = [
  // Identity
  "activityId",
  "activityName",
  "description",
  "activityType",
  "sportTypeId",
  "startTimeLocal",
  "startTimeGMT",
  "beginTimestamp",
  "locationName",
  // Duration
  "duration",
  "movingDuration",
  "elapsedDuration",
  // Distance & speed
  "distance",
  "averageSpeed",
  "averageMovingSpeed",
  "maxSpeed",
  // Elevation
  "elevationGain",
  "elevationLoss",
  "minElevation",
  "maxElevation",
  // Heart rate
  "averageHR",
  "maxHR",
  // Calories
  "calories",
  // Running metrics (both getActivities and getActivity field names)
  "averageRunningCadenceInStepsPerMinute",
  "averageRunCadence",
  "maxRunningCadenceInStepsPerMinute",
  "maxRunCadence",
  "avgStrideLength",
  "strideLength",
  "steps",
  // Cycling metrics
  "averageBikingCadenceInRevPerMinute",
  "maxBikingCadenceInRevPerMinute",
  // Swimming metrics
  "averageSwimCadenceInStrokesPerMinute",
  "averageSwolf",
  "activeLengths",
  // Power
  "avgPower",
  "maxPower",
  "normPower",
  // Training load & effect (both naming conventions)
  "vO2MaxValue",
  "aerobicTrainingEffect",
  "trainingEffect",
  "anaerobicTrainingEffect",
  "trainingEffectLabel",
  "activityTrainingLoad",
  // Stress & respiration
  "avgStress",
  "startStress",
  "endStress",
  "differenceStress",
  "avgRespirationRate",
  // Strength
  "totalSets",
  "activeSets",
  "totalReps",
  // Structure
  "lapCount",
  "splitSummaries",
  "hasSplits",
  // Flags
  "pr",
  "manualActivity",
];

const PROFILE_FIELDS = {
  summary: SUMMARY_FIELDS,
  coaching: COACHING_FIELDS,
};

// --------------------
// Split/lap field profiles
// --------------------
const SPLIT_SUMMARY_FIELDS = [
  "lapIndex",
  "distance",
  "duration",
  "movingDuration",
  "averageSpeed",
  "maxSpeed",
  "elevationGain",
  "elevationLoss",
  "averageHR",
  "maxHR",
  "calories",
  "startTimeGMT",
  "intensityType",
];

const SPLIT_COACHING_FIELDS = [
  // Identity & timing
  "lapIndex",
  "distance",
  "duration",
  "movingDuration",
  "elapsedDuration",
  "startTimeGMT",
  "intensityType",
  "messageIndex",
  // Speed
  "averageSpeed",
  "averageMovingSpeed",
  "maxSpeed",
  "avgGradeAdjustedSpeed",
  // Elevation
  "elevationGain",
  "elevationLoss",
  "maxElevation",
  "minElevation",
  // Heart rate
  "averageHR",
  "maxHR",
  "calories",
  "bmrCalories",
  // Running dynamics
  "averageRunCadence",
  "maxRunCadence",
  "groundContactTime",
  "strideLength",
  "verticalOscillation",
  "verticalRatio",
  // Power
  "averagePower",
  "maxPower",
  "minPower",
  "normalizedPower",
  "totalWork",
];

const SPLIT_PROFILE_FIELDS = {
  summary: SPLIT_SUMMARY_FIELDS,
  coaching: SPLIT_COACHING_FIELDS,
};

const VALID_PROFILES = new Set(["summary", "coaching", "full"]);

function pickFields(obj, fields) {
  const result = {};
  for (const key of fields) {
    if (key in obj) {
      result[key] = obj[key];
    }
  }
  return result;
}

// getActivity() returns IActivityDetails with nested DTOs (summaryDTO, metadataDTO,
// activityTypeDTO, etc.). Flatten them into a single-level object so profile field
// lists can find metrics like distance, averageHR, calories, etc.
function flattenActivityDetail(raw) {
  if (!raw || typeof raw !== "object") return raw;

  const {
    summaryDTO,
    metadataDTO,
    activityTypeDTO,
    eventTypeDTO,
    timeZoneUnitDTO,
    accessControlRuleDTO,
    ...topLevel
  } = raw;

  const flat = {
    ...topLevel,
    ...(summaryDTO || {}),
  };

  // Map activityTypeDTO → activityType for consistency with getActivities()
  if (activityTypeDTO && !flat.activityType) {
    flat.activityType = activityTypeDTO;
  }

  // Pull useful metadataDTO fields to top level
  if (metadataDTO) {
    if (metadataDTO.lapCount !== undefined) flat.lapCount = metadataDTO.lapCount;
    if (metadataDTO.hasSplits !== undefined) flat.hasSplits = metadataDTO.hasSplits;
    if (metadataDTO.manualActivity !== undefined) flat.manualActivity = metadataDTO.manualActivity;
    if (metadataDTO.personalRecord !== undefined) flat.pr = metadataDTO.personalRecord;
    if (metadataDTO.manufacturer !== undefined) flat.manufacturer = metadataDTO.manufacturer;
    if (metadataDTO.favorite !== undefined) flat.favorite = metadataDTO.favorite;
    if (metadataDTO.autoCalcCalories !== undefined) flat.autoCalcCalories = metadataDTO.autoCalcCalories;
    if (metadataDTO.elevationCorrected !== undefined) flat.elevationCorrected = metadataDTO.elevationCorrected;
  }

  return flat;
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
// Debug: Probe Garmin API for individual lap/split data
// (temporary — remove after discovering the response structure)
// --------------------
app.post("/debug/garmin-splits", requireApiKey, (req, res) => {
  const parsed = parseActivityIdFromBody(req.body);
  if (!parsed.ok) {
    return res.status(400).json({ ok: false, error: "Invalid activityId" });
  }

  return withGarminToken(req, res, async (client) => {
    const id = parsed.activityId;
    const base = "https://connectapi.garmin.com/activity-service/activity";
    const urls = [
      `${base}/${id}/splits`,
      `${base}/${id}/details`,
      `${base}/${id}/laps`,
    ];
    const results = {};
    for (const url of urls) {
      try {
        const data = await client.get(url);
        results[url] = { ok: true, data };
      } catch (e) {
        results[url] = { ok: false, error: e?.message || String(e) };
      }
    }
    return { results };
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
// Body: { username/email, tokenJson, activityId?, profile? }
// activityId: optional — omit to fetch most recent activity
// profile: "summary" | "coaching" | "full" (default: "full")
// --------------------
app.post("/garmin/activity", requireApiKey, (req, res) => {
  const profile = req.body?.profile || "full";
  if (!VALID_PROFILES.has(profile)) {
    return res.status(400).json({
      ok: false,
      error: `Invalid profile "${profile}". Must be one of: summary, coaching, full`,
    });
  }

  const parsed = parseActivityIdFromBody(req.body);
  // If an activityId value was provided but is invalid (e.g. "abc"), that's still an error
  const rawProvided = parsed.activityIdRaw !== null && parsed.activityIdRaw !== undefined;
  if (rawProvided && !parsed.ok) {
    return res.status(400).json({
      ok: false,
      error: "Invalid activityId",
      receivedActivityIdRaw: parsed.activityIdRaw,
      receivedType: parsed.activityIdRawType,
    });
  }

  return withGarminToken(req, res, async (client) => {
    let activityId = parsed.activityId;

    // If no activityId provided, fetch the most recent activity
    if (!activityId) {
      const recent = await client.getActivities(0, 1);
      if (!recent || recent.length === 0) {
        throw new Error("No activities found");
      }
      activityId = recent[0].activityId;
    }

    const raw = await client.getActivity({ activityId });
    const flat = flattenActivityDetail(raw);
    const fields = PROFILE_FIELDS[profile];
    const activity = fields ? pickFields(flat, fields) : flat;

    return { activity, profile };
  });
});

// --------------------
// Garmin: SPLITS / LAPS
// Body: { username/email, tokenJson, activityId?, profile? }
// activityId: optional — omit to fetch most recent activity
// profile: "summary" | "coaching" | "full" (default: "full")
// --------------------
app.post("/garmin/splits", requireApiKey, (req, res) => {
  const profile = req.body?.profile || "full";
  if (!VALID_PROFILES.has(profile)) {
    return res.status(400).json({
      ok: false,
      error: `Invalid profile "${profile}". Must be one of: summary, coaching, full`,
    });
  }

  const parsed = parseActivityIdFromBody(req.body);
  const rawProvided = parsed.activityIdRaw !== null && parsed.activityIdRaw !== undefined;
  if (rawProvided && !parsed.ok) {
    return res.status(400).json({
      ok: false,
      error: "Invalid activityId",
      receivedActivityIdRaw: parsed.activityIdRaw,
      receivedType: parsed.activityIdRawType,
    });
  }

  return withGarminToken(req, res, async (client) => {
    let activityId = parsed.activityId;

    // If no activityId provided, fetch the most recent activity
    if (!activityId) {
      const recent = await client.getActivities(0, 1);
      if (!recent || recent.length === 0) {
        throw new Error("No activities found");
      }
      activityId = recent[0].activityId;
    }

    const url = `https://connectapi.garmin.com/activity-service/activity/${activityId}/splits`;
    const raw = await client.get(url);

    let laps = raw?.lapDTOs || [];

    const fields = SPLIT_PROFILE_FIELDS[profile];
    if (fields) {
      laps = laps.map((lap) => pickFields(lap, fields));
    }

    return {
      activityId: raw?.activityId ?? activityId,
      laps,
      lapCount: laps.length,
      profile,
    };
  });
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
  SUMMARY_FIELDS,
  COACHING_FIELDS,
  SPLIT_SUMMARY_FIELDS,
  SPLIT_COACHING_FIELDS,
  pickFields,
  flattenActivityDetail,
};

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*[\\/]/, ""))) {
  const port = process.env.PORT || 3000;
  const server = app.listen(port, () => console.log("Listening on", port));
  process.on("SIGTERM", () => server.close());
}
