import express from "express";
import pkg from "@flow-js/garmin-connect";
const { GarminConnect } = pkg;

const app = express();
app.use(express.json());

// --------------------
// Timeout protection
// --------------------
class GarminTimeoutError extends Error {
  constructor(ms) {
    super(`Garmin API call timed out after ${ms}ms`);
    this.name = "GarminTimeoutError";
  }
}

function withTimeout(promise, ms) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new GarminTimeoutError(ms)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

const GARMIN_LOGIN_TIMEOUT_MS = 15_000;
const GARMIN_API_TIMEOUT_MS = 10_000;
const SERVER_TIMEOUT_MS = 25_000;

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
    if (e instanceof GarminTimeoutError) {
      return res.status(504).json({
        ok: false,
        error: "Garmin API timed out. Please try again.",
      });
    }
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

// --------------------
// Workout semantic group field lists
// --------------------
const WORKOUT_IDENTITY_FIELDS = [
  "activityId",
  "activityName",
  "description",
  "activityType",
  "sportTypeId",
  "startTimeLocal",
  "startTimeGMT",
  "locationName",
  "startLatitude",
  "startLongitude",
  "endLatitude",
  "endLongitude",
];

const WORKOUT_TIMING_FIELDS = [
  "duration",
  "movingDuration",
  "elapsedDuration",
];

const WORKOUT_DISTANCE_FIELDS = [
  "distance",
  "steps",
];

const WORKOUT_PACE_FIELDS = [
  "averageSpeed",
  "averageMovingSpeed",
  "maxSpeed",
  "avgGradeAdjustedSpeed",
];

const WORKOUT_HR_FIELDS = [
  "averageHR",
  "maxHR",
  "minHR",
];

const WORKOUT_ELEVATION_FIELDS = [
  "elevationGain",
  "elevationLoss",
  "maxElevation",
  "minElevation",
];

const WORKOUT_DYNAMICS_FIELDS = [
  "averageRunCadence",
  "maxRunCadence",
  "strideLength",
  "groundContactTime",
  "verticalOscillation",
  "verticalRatio",
];

const WORKOUT_POWER_FIELDS = [
  "averagePower",
  "maxPower",
  "minPower",
  "normalizedPower",
  "totalWork",
];

const WORKOUT_TRAINING_FIELDS = [
  "trainingEffect",
  "anaerobicTrainingEffect",
  "aerobicTrainingEffectMessage",
  "anaerobicTrainingEffectMessage",
  "trainingEffectLabel",
  "activityTrainingLoad",
];

const WORKOUT_BODY_FIELDS = [
  "calories",
  "avgRespirationRate",
  "minRespirationRate",
  "maxRespirationRate",
  "moderateIntensityMinutes",
  "vigorousIntensityMinutes",
  "differenceBodyBattery",
  "directWorkoutFeel",
  "directWorkoutRpe",
  "waterEstimated",
  "beginPotentialStamina",
  "endPotentialStamina",
  "minAvailableStamina",
];

const WORKOUT_META_FIELDS = [
  "lapCount",
  "hasSplits",
  "manualActivity",
  "pr",
  "favorite",
];

const WORKOUT_LAP_FIELDS = [
  "lapIndex",
  "distance",
  "duration",
  "movingDuration",
  "startTimeGMT",
  "intensityType",
  // Speed
  "averageSpeed",
  "averageMovingSpeed",
  "maxSpeed",
  "avgGradeAdjustedSpeed",
  // Elevation
  "elevationGain",
  "elevationLoss",
  // Heart rate
  "averageHR",
  "maxHR",
  "calories",
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
  "normalizedPower",
  "totalWork",
];

const SPLIT_TYPE_PHASE_MAP = {
  INTERVAL_WARMUP: "warmup",
  INTERVAL_ACTIVE: "active",
  INTERVAL_RECOVERY: "recovery",
  INTERVAL_COOLDOWN: "cooldown",
  RWD_RUN: "run",
  RWD_WALK: "walk",
  RWD_STAND: "stand",
};

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

function transformSplitSummaries(splitSummaries) {
  if (!Array.isArray(splitSummaries)) return [];
  return splitSummaries.map(({ splitType, ...rest }) => ({
    phase: SPLIT_TYPE_PHASE_MAP[splitType] || splitType?.toLowerCase() || "unknown",
    splitType,
    ...rest,
  }));
}

function buildWorkoutResponse(flat, laps) {
  return {
    identity: pickFields(flat, WORKOUT_IDENTITY_FIELDS),
    timing: pickFields(flat, WORKOUT_TIMING_FIELDS),
    distance: pickFields(flat, WORKOUT_DISTANCE_FIELDS),
    pace: pickFields(flat, WORKOUT_PACE_FIELDS),
    heartRate: pickFields(flat, WORKOUT_HR_FIELDS),
    elevation: pickFields(flat, WORKOUT_ELEVATION_FIELDS),
    runningDynamics: pickFields(flat, WORKOUT_DYNAMICS_FIELDS),
    power: pickFields(flat, WORKOUT_POWER_FIELDS),
    training: pickFields(flat, WORKOUT_TRAINING_FIELDS),
    body: pickFields(flat, WORKOUT_BODY_FIELDS),
    workoutStructure: transformSplitSummaries(flat.splitSummaries),
    laps: laps.map((lap) => pickFields(lap, WORKOUT_LAP_FIELDS)),
    meta: pickFields(flat, WORKOUT_META_FIELDS),
  };
}

// --------------------
// Workout creation: translation helpers
// --------------------
const SPORT_TYPE_MAP = {
  running:  { sportTypeId: 1, sportTypeKey: "running" },
  cycling:  { sportTypeId: 2, sportTypeKey: "cycling" },
  swimming: { sportTypeId: 4, sportTypeKey: "swimming" },
  strength: { sportTypeId: 5, sportTypeKey: "strength_training" },
  cardio:   { sportTypeId: 6, sportTypeKey: "cardio_training" },
};

const STEP_TYPE_MAP = {
  warmup:   { stepTypeId: 1, stepTypeKey: "warmup", displayOrder: 1 },
  interval: { stepTypeId: 3, stepTypeKey: "interval", displayOrder: 3 },
  recovery: { stepTypeId: 4, stepTypeKey: "recovery", displayOrder: 4 },
  rest:     { stepTypeId: 5, stepTypeKey: "rest", displayOrder: 5 },
  cooldown: { stepTypeId: 2, stepTypeKey: "cooldown", displayOrder: 2 },
  other:    { stepTypeId: 7, stepTypeKey: "other", displayOrder: 7 },
};

function parsePaceToMps(paceStr) {
  // "5:30" → 5 min 30 sec per km → 330 sec/km → 1000/330 m/s
  const parts = paceStr.split(":");
  if (parts.length !== 2) return null;
  const mins = Number(parts[0]);
  const secs = Number(parts[1]);
  if (!Number.isFinite(mins) || !Number.isFinite(secs) || mins < 0 || secs < 0) return null;
  const totalSec = mins * 60 + secs;
  if (totalSec <= 0) return null;
  return 1000 / totalSec;
}

function buildGarminSportType(sport) {
  return SPORT_TYPE_MAP[sport] || null;
}

function buildGarminDuration(duration) {
  if (!duration || !duration.type) return null;
  switch (duration.type) {
    case "time":
      return {
        endCondition: { conditionTypeId: 2, conditionTypeKey: "time", displayable: true, displayOrder: 1 },
        endConditionValue: duration.seconds,
        endConditionCompare: null,
        endConditionZone: null,
        preferredEndConditionUnit: null,
      };
    case "distance":
      return {
        endCondition: { conditionTypeId: 3, conditionTypeKey: "distance", displayable: true, displayOrder: 3 },
        endConditionValue: duration.meters,
        endConditionCompare: null,
        preferredEndConditionUnit: { unitKey: "kilometer" },
      };
    case "calories":
      return {
        endCondition: { conditionTypeId: 4, conditionTypeKey: "calories", displayable: true, displayOrder: 4 },
        endConditionValue: duration.calories,
        endConditionCompare: null,
        preferredEndConditionUnit: null,
      };
    case "lapButton":
      return {
        endCondition: { conditionTypeId: 1, conditionTypeKey: "lap.button", displayable: true, displayOrder: 1 },
        endConditionValue: null,
        endConditionCompare: null,
        preferredEndConditionUnit: null,
      };
    case "heartRate":
      return {
        endCondition: { conditionTypeId: 6, conditionTypeKey: "heart.rate", displayable: true, displayOrder: 6 },
        endConditionValue: duration.bpm,
        endConditionCompare: duration.comparison || "gt",
        preferredEndConditionUnit: null,
      };
    default:
      return null;
  }
}

function buildGarminTarget(target) {
  if (!target || !target.type) return { targetType: { workoutTargetTypeId: 1, workoutTargetTypeKey: "no.target", displayOrder: 1 } };
  switch (target.type) {
    case "none":
      return {
        targetType: { workoutTargetTypeId: 1, workoutTargetTypeKey: "no.target", displayOrder: 1 },
      };
    case "pace": {
      const minMps = parsePaceToMps(target.minPerKm);
      const maxMps = parsePaceToMps(target.maxPerKm);
      if (!minMps || !maxMps) return null;
      return {
        targetType: { workoutTargetTypeId: 6, workoutTargetTypeKey: "pace.zone", displayOrder: 6 },
        targetValueOne: minMps,
        targetValueTwo: maxMps,
        targetValueUnit: null,
      };
    }
    case "heartRateZone":
      return {
        targetType: { workoutTargetTypeId: 4, workoutTargetTypeKey: "heart.rate.zone", displayOrder: 4 },
        zoneNumber: target.zone,
      };
    case "heartRate":
      return {
        targetType: { workoutTargetTypeId: 4, workoutTargetTypeKey: "heart.rate.zone", displayOrder: 4 },
        targetValueOne: target.min,
        targetValueTwo: target.max,
        targetValueUnit: null,
      };
    case "powerZone":
      return {
        targetType: { workoutTargetTypeId: 2, workoutTargetTypeKey: "power.zone", displayOrder: 2 },
        zoneNumber: target.zone,
      };
    case "power":
      return {
        targetType: { workoutTargetTypeId: 2, workoutTargetTypeKey: "power.zone", displayOrder: 2 },
        targetValueOne: target.min,
        targetValueTwo: target.max,
      };
    case "cadence":
      return {
        targetType: { workoutTargetTypeId: 3, workoutTargetTypeKey: "cadence", displayOrder: 3 },
        targetValueOne: target.min,
        targetValueTwo: target.max,
        targetValueUnit: null,
      };
    default:
      return null;
  }
}

function buildGarminStep(step, stepId) {
  const stepType = STEP_TYPE_MAP[step.type];
  if (!stepType) return null;
  const duration = buildGarminDuration(step.duration);
  if (!duration) return null;
  const target = buildGarminTarget(step.target);
  if (!target) return null;

  return {
    type: "ExecutableStepDTO",
    stepId,
    stepOrder: stepId,
    childStepId: null,
    description: step.notes || null,
    stepType,
    ...duration,
    ...target,
    targetValueOne: target.targetValueOne ?? null,
    targetValueTwo: target.targetValueTwo ?? null,
    targetValueUnit: target.targetValueUnit ?? null,
    zoneNumber: target.zoneNumber ?? null,
    secondaryTargetType: null,
    secondaryTargetValueOne: null,
    secondaryTargetValueTwo: null,
    secondaryTargetValueUnit: null,
    secondaryZoneNumber: null,
    strokeType: {},
    equipmentType: { displayOrder: null, equipmentTypeId: null, equipmentTypeKey: null },
    exerciseName: null,
    category: null,
    workoutProvider: null,
    providerExerciseSourceId: null,
    weightValue: null,
    weightUnit: null,
    stepAudioNote: null,
  };
}

function buildGarminRepeatGroup(step, stepId) {
  const childSteps = [];
  let childId = stepId + 1;
  for (const childStep of step.steps) {
    const built = buildGarminStep(childStep, childId);
    if (!built) return null;
    childSteps.push(built);
    childId++;
  }

  return {
    type: "RepeatGroupDTO",
    stepId,
    stepOrder: stepId,
    childStepId: null,
    stepType: { stepTypeId: 6, stepTypeKey: "repeat", displayOrder: 6 },
    numberOfIterations: step.iterations,
    workoutSteps: childSteps,
    // Total IDs consumed: 1 (group) + childSteps.length
    _nextId: childId,
  };
}

function buildGarminWorkout(workout) {
  const sportType = buildGarminSportType(workout.sport);
  const steps = [];
  let stepId = 1;

  for (const step of workout.steps) {
    if (step.type === "repeat") {
      const group = buildGarminRepeatGroup(step, stepId);
      if (!group) return null;
      stepId = group._nextId;
      const { _nextId, ...cleanGroup } = group;
      steps.push(cleanGroup);
    } else {
      const built = buildGarminStep(step, stepId);
      if (!built) return null;
      steps.push(built);
      stepId++;
    }
  }

  return {
    sportType,
    subSportType: null,
    workoutName: workout.name,
    description: workout.description || null,
    workoutSegments: [{
      segmentOrder: 1,
      sportType,
      workoutSteps: steps,
    }],
    estimatedDurationInSecs: 0,
    estimatedDistanceInMeters: 0,
    estimateType: null,
    avgTrainingSpeed: null,
    estimatedDistanceUnit: { unitKey: null },
    isWheelchair: false,
  };
}

const VALID_SPORTS = new Set(Object.keys(SPORT_TYPE_MAP));
const VALID_STEP_TYPES = new Set([...Object.keys(STEP_TYPE_MAP), "repeat"]);
const VALID_DURATION_TYPES = new Set(["time", "distance", "calories", "lapButton", "heartRate"]);
const VALID_TARGET_TYPES = new Set(["none", "pace", "heartRateZone", "heartRate", "powerZone", "power", "cadence"]);

function validateWorkoutStep(step, allowRepeat) {
  if (!step || typeof step !== "object") return "Each step must be an object";
  if (!VALID_STEP_TYPES.has(step.type)) {
    return `Invalid step type "${step.type}". Must be one of: ${[...VALID_STEP_TYPES].join(", ")}`;
  }

  if (step.type === "repeat") {
    if (!allowRepeat) return "Nested repeats are not allowed";
    if (!Number.isFinite(step.iterations) || step.iterations < 1) {
      return "Repeat iterations must be a positive integer";
    }
    if (!Array.isArray(step.steps) || step.steps.length === 0) {
      return "Repeat must contain at least one step";
    }
    for (const child of step.steps) {
      const err = validateWorkoutStep(child, false);
      if (err) return err;
    }
    return null;
  }

  // Regular step
  if (!step.duration || !VALID_DURATION_TYPES.has(step.duration.type)) {
    return `Invalid duration type. Must be one of: ${[...VALID_DURATION_TYPES].join(", ")}`;
  }
  if (step.duration.type === "time" && (!Number.isFinite(step.duration.seconds) || step.duration.seconds <= 0)) {
    return "Time duration requires a positive seconds value";
  }
  if (step.duration.type === "distance" && (!Number.isFinite(step.duration.meters) || step.duration.meters <= 0)) {
    return "Distance duration requires a positive meters value";
  }
  if (step.duration.type === "calories" && (!Number.isFinite(step.duration.calories) || step.duration.calories <= 0)) {
    return "Calories duration requires a positive calories value";
  }
  if (step.duration.type === "heartRate") {
    if (!Number.isFinite(step.duration.bpm) || step.duration.bpm <= 0) {
      return "Heart rate duration requires a positive bpm value";
    }
    if (step.duration.comparison && step.duration.comparison !== "gt" && step.duration.comparison !== "lt") {
      return 'Heart rate duration comparison must be "gt" or "lt"';
    }
  }

  if (!step.target || !VALID_TARGET_TYPES.has(step.target.type)) {
    return `Invalid target type. Must be one of: ${[...VALID_TARGET_TYPES].join(", ")}`;
  }
  if (step.target.type === "pace") {
    if (!parsePaceToMps(step.target.minPerKm || "")) return "Pace target requires valid minPerKm (e.g. \"5:30\")";
    if (!parsePaceToMps(step.target.maxPerKm || "")) return "Pace target requires valid maxPerKm (e.g. \"5:00\")";
  }
  if (step.target.type === "heartRateZone") {
    if (!Number.isFinite(step.target.zone) || step.target.zone < 1 || step.target.zone > 5) {
      return "Heart rate zone must be 1-5";
    }
  }
  if (step.target.type === "heartRate") {
    if (!Number.isFinite(step.target.min) || !Number.isFinite(step.target.max)) {
      return "Heart rate target requires min and max BPM values";
    }
  }
  if (step.target.type === "powerZone") {
    if (!Number.isFinite(step.target.zone) || step.target.zone < 1) {
      return "Power zone must be a positive integer";
    }
  }
  if (step.target.type === "power") {
    if (!Number.isFinite(step.target.min) || !Number.isFinite(step.target.max)) {
      return "Power target requires min and max watt values";
    }
  }
  if (step.target.type === "cadence") {
    if (!Number.isFinite(step.target.min) || !Number.isFinite(step.target.max)) {
      return "Cadence target requires min and max values";
    }
  }

  return null;
}

function validateWorkoutPayload(workout) {
  if (!workout || typeof workout !== "object") return { ok: false, error: "Missing workout object" };
  if (!workout.name || typeof workout.name !== "string" || !workout.name.trim()) {
    return { ok: false, error: "Workout name is required" };
  }
  if (!VALID_SPORTS.has(workout.sport)) {
    return { ok: false, error: `Invalid sport "${workout.sport}". Must be one of: ${[...VALID_SPORTS].join(", ")}` };
  }
  if (!Array.isArray(workout.steps) || workout.steps.length === 0) {
    return { ok: false, error: "Workout must contain at least one step" };
  }
  for (let i = 0; i < workout.steps.length; i++) {
    const err = validateWorkoutStep(workout.steps[i], true);
    if (err) return { ok: false, error: `Step ${i + 1}: ${err}` };
  }
  return { ok: true };
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
        const data = await withTimeout(client.get(url), GARMIN_API_TIMEOUT_MS);
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
        await withTimeout(client.getUserProfile(), GARMIN_API_TIMEOUT_MS);

        // Always export latest token (may be refreshed/rotated)
        const refreshed = await client.exportToken();
        return res.json({ ok: true, tokenJson: refreshed });
      } catch (e) {
        if (e instanceof GarminTimeoutError) throw e;
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
    await withTimeout(client.login(), GARMIN_LOGIN_TIMEOUT_MS);
    markPasswordLoginAttempt(username); // only burn cooldown on successful login
    const exported = await client.exportToken();
    return res.json({ ok: true, tokenJson: exported });
  } catch (err) {
    console.error("Garmin connect error:", err?.message || err);
    if (err instanceof GarminTimeoutError) {
      return res.status(504).json({
        ok: false,
        error: "Garmin API timed out. Please try again.",
      });
    }
    return res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

// --------------------
// Garmin: PROFILE (TOKEN-ONLY)
// Body: { username/email, tokenJson }
// --------------------
app.post("/garmin/profile", requireApiKey, (req, res) =>
  withGarminToken(req, res, async (client) => ({
    profile: await withTimeout(client.getUserProfile(), GARMIN_API_TIMEOUT_MS),
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
    return { activities: await withTimeout(client.getActivities(offset, limit), GARMIN_API_TIMEOUT_MS) };
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
      const recent = await withTimeout(client.getActivities(0, 1), GARMIN_API_TIMEOUT_MS);
      if (!recent || recent.length === 0) {
        throw new Error("No activities found");
      }
      activityId = recent[0].activityId;
    }

    const raw = await withTimeout(client.getActivity({ activityId }), GARMIN_API_TIMEOUT_MS);
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
      const recent = await withTimeout(client.getActivities(0, 1), GARMIN_API_TIMEOUT_MS);
      if (!recent || recent.length === 0) {
        throw new Error("No activities found");
      }
      activityId = recent[0].activityId;
    }

    const url = `https://connectapi.garmin.com/activity-service/activity/${activityId}/splits`;
    const raw = await withTimeout(client.get(url), GARMIN_API_TIMEOUT_MS);

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
// Garmin: WORKOUT (combined activity + splits, semantically grouped)
// Body: { username/email, tokenJson, activityId? }
// activityId: optional — omit to fetch most recent activity
// --------------------
app.post("/garmin/workout", requireApiKey, (req, res) => {
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
      const recent = await withTimeout(client.getActivities(0, 1), GARMIN_API_TIMEOUT_MS);
      if (!recent || recent.length === 0) {
        throw new Error("No activities found");
      }
      activityId = recent[0].activityId;
    }

    // Parallel fetch: activity detail + splits
    const splitsUrl = `https://connectapi.garmin.com/activity-service/activity/${activityId}/splits`;
    const [rawActivity, rawSplits] = await Promise.all([
      withTimeout(client.getActivity({ activityId }), GARMIN_API_TIMEOUT_MS),
      withTimeout(client.get(splitsUrl), GARMIN_API_TIMEOUT_MS),
    ]);

    const flat = flattenActivityDetail(rawActivity);
    const laps = rawSplits?.lapDTOs || [];
    const workout = buildWorkoutResponse(flat, laps);

    return { activityId, workout };
  });
});

// --------------------
// Garmin: CREATE WORKOUT
// Body: { username/email, tokenJson, workout: { name, sport, steps[] }, scheduleDate? }
// --------------------
app.post("/garmin/workout/create", requireApiKey, (req, res) => {
  const { workout, scheduleDate } = req.body || {};

  const validation = validateWorkoutPayload(workout);
  if (!validation.ok) {
    return res.status(400).json({ ok: false, error: validation.error });
  }

  if (scheduleDate !== undefined && scheduleDate !== null) {
    if (typeof scheduleDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(scheduleDate)) {
      return res.status(400).json({ ok: false, error: "scheduleDate must be YYYY-MM-DD format" });
    }
  }

  return withGarminToken(req, res, async (client) => {
    const garminWorkout = buildGarminWorkout(workout);
    const created = await withTimeout(
      client.createWorkout(garminWorkout),
      GARMIN_API_TIMEOUT_MS
    );

    const result = {
      workoutId: created.workoutId,
      workoutName: created.workoutName,
    };

    if (scheduleDate && created.workoutId) {
      await withTimeout(
        client.scheduleWorkout({ workoutId: String(created.workoutId) }, scheduleDate),
        GARMIN_API_TIMEOUT_MS
      );
      result.scheduled = true;
      result.scheduleDate = scheduleDate;
    }

    return result;
  });
});

// --------------------
// Start server
// --------------------
// Export app and helpers for testing; only start listener when run directly
export {
  app,
  GarminTimeoutError,
  withTimeout,
  GARMIN_LOGIN_TIMEOUT_MS,
  GARMIN_API_TIMEOUT_MS,
  SERVER_TIMEOUT_MS,
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
  buildWorkoutResponse,
  transformSplitSummaries,
  SPLIT_TYPE_PHASE_MAP,
  WORKOUT_IDENTITY_FIELDS,
  WORKOUT_TIMING_FIELDS,
  WORKOUT_DISTANCE_FIELDS,
  WORKOUT_PACE_FIELDS,
  WORKOUT_HR_FIELDS,
  WORKOUT_ELEVATION_FIELDS,
  WORKOUT_DYNAMICS_FIELDS,
  WORKOUT_POWER_FIELDS,
  WORKOUT_TRAINING_FIELDS,
  WORKOUT_BODY_FIELDS,
  WORKOUT_META_FIELDS,
  WORKOUT_LAP_FIELDS,
  SPORT_TYPE_MAP,
  STEP_TYPE_MAP,
  parsePaceToMps,
  buildGarminSportType,
  buildGarminDuration,
  buildGarminTarget,
  buildGarminStep,
  buildGarminRepeatGroup,
  buildGarminWorkout,
  validateWorkoutPayload,
  validateWorkoutStep,
};

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*[\\/]/, ""))) {
  const port = process.env.PORT || 3000;
  const server = app.listen(port, () => console.log("Listening on", port));
  server.setTimeout(SERVER_TIMEOUT_MS);
  process.on("SIGTERM", () => server.close());
}
