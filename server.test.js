import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

// ---------------------
// Mock GarminConnect before importing server
// ---------------------
const mockLogin = vi.fn();
const mockGetUserProfile = vi.fn();
const mockGetActivities = vi.fn();
const mockGetActivity = vi.fn();
const mockGet = vi.fn();
const mockExportToken = vi.fn();
const mockLoadToken = vi.fn();
const mockGetUserSettings = vi.fn();
const mockCreateWorkout = vi.fn();
const mockScheduleWorkout = vi.fn();

vi.mock("@flow-js/garmin-connect", () => {
  class GarminConnect {
    constructor({ username, password }) {
      this.username = username;
      this.password = password;
    }
    login(...args) { return mockLogin(...args); }
    getUserProfile(...args) { return mockGetUserProfile(...args); }
    getActivities(...args) { return mockGetActivities(...args); }
    getActivity(...args) { return mockGetActivity(...args); }
    getUserSettings(...args) { return mockGetUserSettings(...args); }
    get(...args) { return mockGet(...args); }
    exportToken(...args) { return mockExportToken(...args); }
    loadToken(...args) { return mockLoadToken(...args); }
    createWorkout(...args) { return mockCreateWorkout(...args); }
    scheduleWorkout(...args) { return mockScheduleWorkout(...args); }
  }
  return { default: { GarminConnect } };
});

// Now import the server (uses the mocked GarminConnect)
const {
  app,
  GarminTimeoutError,
  withTimeout,
  GARMIN_LOGIN_TIMEOUT_MS,
  GARMIN_API_TIMEOUT_MS,
  parseActivityIdFromBody,
  canAttemptPasswordLogin,
  markPasswordLoginAttempt,
  lastPasswordLoginAttemptByUsername,
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
  parsePaceToMps,
  buildGarminSportType,
  buildGarminDuration,
  buildGarminTarget,
  buildGarminStep,
  buildGarminRepeatGroup,
  buildGarminWorkout,
  validateWorkoutPayload,
  buildAthleteProfile,
  secsToHHMM,
  computeAge,
  ATHLETE_SUMMARY_FIELDS,
  ATHLETE_COACHING_FIELDS,
  ATHLETE_PROFILE_FIELDS,
} = await import("./server.js");

// ---------------------
// Defaults for mocks
// ---------------------
const FAKE_TOKEN = { oauth1: { token: "a" }, oauth2: { token: "b" } };
const REFRESHED_TOKEN = { oauth1: { token: "a2" }, oauth2: { token: "b2" } };
const API_KEY = "test-key-123";

beforeEach(() => {
  vi.resetAllMocks();
  process.env.API_KEY = API_KEY;
  lastPasswordLoginAttemptByUsername.clear();

  // Sensible defaults — override in individual tests as needed
  mockExportToken.mockResolvedValue(REFRESHED_TOKEN);
  mockLoadToken.mockResolvedValue(undefined);
  mockGetUserProfile.mockResolvedValue({ displayName: "TestUser" });
  mockGetUserSettings.mockResolvedValue({
    id: 95492098,
    userData: {
      gender: "MALE",
      weight: 79980,
      height: 176,
      birthDate: "1981-02-02",
      vo2MaxRunning: 50,
      vo2MaxCycling: 51,
      lactateThresholdHeartRate: 158,
      lactateThresholdSpeed: 0.36388787,
      activityLevel: 8,
      availableTrainingDays: ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"],
      preferredLongTrainingDays: ["FRIDAY"],
      measurementSystem: "metric",
    },
    userSleep: { sleepTime: 79200, wakeTime: 21600 },
  });
  mockGetActivities.mockResolvedValue([{ activityId: 1 }, { activityId: 2 }]);
  // Mock returns nested IActivityDetails structure (as real Garmin API does)
  mockGetActivity.mockResolvedValue({
    activityId: 99,
    activityName: "Morning Run",
    userProfileId: 12345,
    isMultiSportParent: false,
    activityTypeDTO: {
      typeId: 1,
      typeKey: "running",
      parentTypeId: 17,
      isHidden: false,
      restricted: false,
      trimmable: true,
    },
    eventTypeDTO: { typeId: 5, typeKey: "training", sortOrder: 7 },
    accessControlRuleDTO: { typeId: 2, typeKey: "private" },
    timeZoneUnitDTO: { unitId: 124, unitKey: "Asia/Jerusalem", factor: 7200, timeZone: "Asia/Jerusalem" },
    metadataDTO: {
      isOriginal: true,
      deviceApplicationInstallationId: 1234,
      manufacturer: "Garmin",
      lapCount: 5,
      hasSplits: true,
      personalRecord: false,
      manualActivity: false,
      autoCalcCalories: false,
      favorite: false,
      elevationCorrected: true,
      hasPolyline: true,
    },
    summaryDTO: {
      startTimeLocal: "2026-02-05 07:15:00",
      startTimeGMT: "2026-02-05 05:15:00",
      startLatitude: 32.0853,
      startLongitude: 34.7818,
      distance: 8012.5,
      duration: 2834.5,
      movingDuration: 2790.1,
      elapsedDuration: 2900.0,
      elevationGain: 45.0,
      elevationLoss: 43.0,
      maxElevation: 28.0,
      minElevation: 2.0,
      averageSpeed: 2.83,
      averageMovingSpeed: 2.87,
      maxSpeed: 4.1,
      calories: 620,
      averageHR: 152,
      maxHR: 178,
      averageRunCadence: 172,
      maxRunCadence: 184,
      strideLength: 1.05,
      trainingEffect: 3.2,
      anaerobicTrainingEffect: 1.1,
      maxVerticalSpeed: 0.5,
    },
    locationName: "Tel Aviv",
    splitSummaries: [
      { distance: 1000, duration: 345.0, splitType: "INTERVAL", noOfSplits: 5 },
    ],
  });
  mockLogin.mockResolvedValue(undefined);
  mockCreateWorkout.mockResolvedValue({ workoutId: 99999, workoutName: "Test Workout" });
  mockScheduleWorkout.mockResolvedValue(undefined);
});

function auth() {
  return { Authorization: `Bearer ${API_KEY}` };
}

// ============================================================
// HELPER FUNCTION TESTS
// ============================================================

describe("parseActivityIdFromBody", () => {
  it("parses numeric activityId", () => {
    const result = parseActivityIdFromBody({ activityId: 123 });
    expect(result).toEqual({
      ok: true,
      activityId: 123,
      activityIdRaw: 123,
      activityIdRawType: "number",
    });
  });

  it("parses string activityId", () => {
    const result = parseActivityIdFromBody({ activityId: "456" });
    expect(result.ok).toBe(true);
    expect(result.activityId).toBe(456);
  });

  it("accepts activityID (capital D)", () => {
    expect(parseActivityIdFromBody({ activityID: 10 }).ok).toBe(true);
  });

  it("accepts activity_id (snake_case)", () => {
    expect(parseActivityIdFromBody({ activity_id: 10 }).ok).toBe(true);
  });

  it("accepts id", () => {
    expect(parseActivityIdFromBody({ id: 10 }).ok).toBe(true);
  });

  it("rejects missing activityId", () => {
    expect(parseActivityIdFromBody({}).ok).toBe(false);
  });

  it("rejects zero", () => {
    expect(parseActivityIdFromBody({ activityId: 0 }).ok).toBe(false);
  });

  it("rejects negative", () => {
    expect(parseActivityIdFromBody({ activityId: -5 }).ok).toBe(false);
  });

  it("rejects non-numeric string", () => {
    expect(parseActivityIdFromBody({ activityId: "abc" }).ok).toBe(false);
  });

  it("rejects null body", () => {
    expect(parseActivityIdFromBody(null).ok).toBe(false);
  });

  it("prefers activityId over id", () => {
    const result = parseActivityIdFromBody({ activityId: 1, id: 2 });
    expect(result.activityId).toBe(1);
  });
});

describe("canAttemptPasswordLogin / markPasswordLoginAttempt", () => {
  it("allows first attempt", () => {
    expect(canAttemptPasswordLogin("user1").ok).toBe(true);
  });

  it("blocks immediately after marking", () => {
    markPasswordLoginAttempt("user2");
    const result = canAttemptPasswordLogin("user2");
    expect(result.ok).toBe(false);
    expect(result.waitMs).toBeGreaterThan(0);
  });

  it("tracks users independently", () => {
    markPasswordLoginAttempt("userA");
    expect(canAttemptPasswordLogin("userA").ok).toBe(false);
    expect(canAttemptPasswordLogin("userB").ok).toBe(true);
  });
});

// ============================================================
// HEALTH + DEBUG ENDPOINT TESTS
// ============================================================

describe("GET /health", () => {
  it("returns ok without auth", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});

describe("GET /debug/auth", () => {
  it("requires API key", async () => {
    const res = await request(app).get("/debug/auth");
    expect(res.status).toBe(401);
  });

  it("returns auth diagnostics with valid API key", async () => {
    const res = await request(app)
      .get("/debug/auth")
      .set(auth());
    expect(res.status).toBe(200);
    expect(res.body.hasEnvApiKey).toBe(true);
  });
});

describe("POST /debug/body", () => {
  it("requires API key", async () => {
    const res = await request(app).post("/debug/body").send({ foo: 1 });
    expect(res.status).toBe(401);
  });

  it("echoes body with valid API key", async () => {
    const res = await request(app)
      .post("/debug/body")
      .set(auth())
      .send({ foo: 1 });
    expect(res.status).toBe(200);
    expect(res.body.body).toEqual({ foo: 1 });
  });
});

describe("ALL /debug/route", () => {
  it("requires API key", async () => {
    const res = await request(app).get("/debug/route");
    expect(res.status).toBe(401);
  });

  it("returns route info with valid API key", async () => {
    const res = await request(app)
      .get("/debug/route")
      .set(auth());
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.path).toBe("/debug/route");
  });
});

describe("POST /debug/activity-id", () => {
  it("parses activity ID from body", async () => {
    const res = await request(app)
      .post("/debug/activity-id")
      .set(auth())
      .send({ activityId: 999 });
    expect(res.status).toBe(200);
    expect(res.body.parsedActivityId).toBe(999);
  });
});

// ============================================================
// AUTH MIDDLEWARE TESTS
// ============================================================

describe("requireApiKey middleware", () => {
  it("rejects missing Authorization header", async () => {
    const res = await request(app)
      .post("/garmin/profile")
      .send({ username: "u", tokenJson: FAKE_TOKEN });
    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);
  });

  it("rejects wrong API key", async () => {
    const res = await request(app)
      .post("/garmin/profile")
      .set("Authorization", "Bearer wrong-key")
      .send({ username: "u", tokenJson: FAKE_TOKEN });
    expect(res.status).toBe(401);
  });

  it("rejects when API_KEY env var is not set", async () => {
    delete process.env.API_KEY;
    const res = await request(app)
      .post("/garmin/profile")
      .set("Authorization", "Bearer anything")
      .send({ username: "u", tokenJson: FAKE_TOKEN });
    expect(res.status).toBe(401);
  });
});

// ============================================================
// POST /garmin/connect TESTS
// ============================================================

describe("POST /garmin/connect", () => {
  it("returns 400 when missing credentials", async () => {
    const res = await request(app)
      .post("/garmin/connect")
      .set(auth())
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Missing credentials/);
  });

  it("supports dryRun mode", async () => {
    const res = await request(app)
      .post("/garmin/connect")
      .set(auth())
      .send({ username: "u", password: "p", dryRun: true });
    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(true);
    expect(res.body.received.hasUsername).toBe(true);
    // No Garmin calls should have been made
    expect(mockLogin).not.toHaveBeenCalled();
    expect(mockGetUserProfile).not.toHaveBeenCalled();
  });

  it("token-first path: succeeds when token is valid", async () => {
    const res = await request(app)
      .post("/garmin/connect")
      .set(auth())
      .send({ username: "u", password: "p", tokenJson: FAKE_TOKEN });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.tokenJson).toEqual(REFRESHED_TOKEN);
    // Should NOT have called login
    expect(mockLogin).not.toHaveBeenCalled();
    expect(mockGetUserProfile).toHaveBeenCalledTimes(1);
  });

  it("token-first path: falls back to password login on token failure", async () => {
    mockGetUserProfile.mockRejectedValueOnce(new Error("token expired"));

    const res = await request(app)
      .post("/garmin/connect")
      .set(auth())
      .send({ username: "u", password: "p", tokenJson: FAKE_TOKEN });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // Should have fallen back to login
    expect(mockLogin).toHaveBeenCalledTimes(1);
  });

  it("password login: succeeds without tokenJson", async () => {
    const res = await request(app)
      .post("/garmin/connect")
      .set(auth())
      .send({ username: "u", password: "p" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mockLogin).toHaveBeenCalledTimes(1);
  });

  it("password login: returns 429 when cooldown is active", async () => {
    markPasswordLoginAttempt("cooldown-user");
    const res = await request(app)
      .post("/garmin/connect")
      .set(auth())
      .send({ username: "cooldown-user", password: "p" });
    expect(res.status).toBe(429);
    expect(res.body.error).toMatch(/Cooldown/);
  });

  it("password login: returns 500 when login() throws", async () => {
    mockLogin.mockRejectedValue(new Error("Garmin is down"));
    const res = await request(app)
      .post("/garmin/connect")
      .set(auth())
      .send({ username: "u", password: "p" });
    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
  });

  it("password login: does NOT burn cooldown when login() throws", async () => {
    mockLogin.mockRejectedValue(new Error("Garmin is down"));
    await request(app)
      .post("/garmin/connect")
      .set(auth())
      .send({ username: "retry-user", password: "p" });
    // Cooldown should NOT be set — user can retry immediately
    expect(canAttemptPasswordLogin("retry-user").ok).toBe(true);
  });

  it("password login: DOES burn cooldown on successful login", async () => {
    await request(app)
      .post("/garmin/connect")
      .set(auth())
      .send({ username: "success-user", password: "p" });
    // Cooldown should be active after successful login
    expect(canAttemptPasswordLogin("success-user").ok).toBe(false);
  });

  it("accepts email field as username", async () => {
    const res = await request(app)
      .post("/garmin/connect")
      .set(auth())
      .send({ email: "test@example.com", password: "p", dryRun: true });
    expect(res.status).toBe(200);
    expect(res.body.received.hasUsername).toBe(true);
  });
});

// ============================================================
// POST /garmin/profile TESTS
// ============================================================

describe("POST /garmin/profile", () => {
  it("returns profile with valid token", async () => {
    const res = await request(app)
      .post("/garmin/profile")
      .set(auth())
      .send({ username: "u", tokenJson: FAKE_TOKEN });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.profile).toEqual({ displayName: "TestUser" });
    expect(res.body.tokenJson).toEqual(REFRESHED_TOKEN);
  });

  it("returns 400 when missing username", async () => {
    const res = await request(app)
      .post("/garmin/profile")
      .set(auth())
      .send({ tokenJson: FAKE_TOKEN });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/username/i);
  });

  it("returns 400 when missing tokenJson", async () => {
    const res = await request(app)
      .post("/garmin/profile")
      .set(auth())
      .send({ username: "u" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/tokenJson/);
  });

  it("returns 400 when tokenJson missing oauth1", async () => {
    const res = await request(app)
      .post("/garmin/profile")
      .set(auth())
      .send({ username: "u", tokenJson: { oauth2: { token: "b" } } });
    expect(res.status).toBe(400);
  });

  it("returns 400 when tokenJson missing oauth2", async () => {
    const res = await request(app)
      .post("/garmin/profile")
      .set(auth())
      .send({ username: "u", tokenJson: { oauth1: { token: "a" } } });
    expect(res.status).toBe(400);
  });

  it("returns 401 when token is expired", async () => {
    mockGetUserProfile.mockRejectedValue(new Error("Unauthorized - token expired"));
    const res = await request(app)
      .post("/garmin/profile")
      .set(auth())
      .send({ username: "u", tokenJson: FAKE_TOKEN });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/Re-authenticate/);
  });

  it("returns 500 for non-token Garmin errors", async () => {
    mockGetUserProfile.mockRejectedValue(new Error("Network timeout"));
    const res = await request(app)
      .post("/garmin/profile")
      .set(auth())
      .send({ username: "u", tokenJson: FAKE_TOKEN });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Garmin request failed");
  });
});

// ============================================================
// POST /garmin/athlete-profile TESTS
// ============================================================

describe("POST /garmin/athlete-profile", () => {
  it("returns full athlete profile by default", async () => {
    const res = await request(app)
      .post("/garmin/athlete-profile")
      .set(auth())
      .send({ username: "u", tokenJson: FAKE_TOKEN });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.profile).toBe("full");
    const ap = res.body.athleteProfile;
    expect(ap.displayName).toBe("TestUser");
    expect(ap.gender).toBe("MALE");
    expect(ap.birthDate).toBe("1981-02-02");
    expect(ap.weightKg).toBe(80);
    expect(ap.heightCm).toBe(176);
    expect(ap.vo2MaxRunning).toBe(50);
    expect(ap.vo2MaxCycling).toBe(51);
    expect(ap.lactateThresholdHeartRate).toBe(158);
    expect(ap.lactateThresholdSpeed).toBe(0.36388787);
    expect(ap.activityLevel).toBe(8);
    expect(ap.availableTrainingDays).toEqual(["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"]);
    expect(ap.preferredLongTrainingDays).toEqual(["FRIDAY"]);
    expect(ap.sleepTime).toBe("22:00");
    expect(ap.wakeTime).toBe("06:00");
    expect(ap.measurementSystem).toBe("metric");
    expect(typeof ap.age).toBe("number");
    expect(ap.age).toBeGreaterThan(0);
  });

  it("returns summary fields only when profile=summary", async () => {
    const res = await request(app)
      .post("/garmin/athlete-profile")
      .set(auth())
      .send({ username: "u", tokenJson: FAKE_TOKEN, profile: "summary" });
    expect(res.status).toBe(200);
    expect(res.body.profile).toBe("summary");
    const ap = res.body.athleteProfile;
    expect(Object.keys(ap).sort()).toEqual([...ATHLETE_SUMMARY_FIELDS].sort());
    expect(ap.displayName).toBe("TestUser");
    expect(ap.gender).toBe("MALE");
    expect(ap.weightKg).toBe(80);
    expect(ap.heightCm).toBe(176);
    // coaching-only fields should be absent
    expect(ap.vo2MaxRunning).toBeUndefined();
    expect(ap.birthDate).toBeUndefined();
  });

  it("returns coaching fields only when profile=coaching", async () => {
    const res = await request(app)
      .post("/garmin/athlete-profile")
      .set(auth())
      .send({ username: "u", tokenJson: FAKE_TOKEN, profile: "coaching" });
    expect(res.status).toBe(200);
    expect(res.body.profile).toBe("coaching");
    const ap = res.body.athleteProfile;
    expect(Object.keys(ap).sort()).toEqual([...ATHLETE_COACHING_FIELDS].sort());
    expect(ap.vo2MaxRunning).toBe(50);
    expect(ap.sleepTime).toBe("22:00");
  });

  it("rejects invalid profile value", async () => {
    const res = await request(app)
      .post("/garmin/athlete-profile")
      .set(auth())
      .send({ username: "u", tokenJson: FAKE_TOKEN, profile: "bad" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid profile/);
  });

  it("calls both getUserSettings and getUserProfile", async () => {
    await request(app)
      .post("/garmin/athlete-profile")
      .set(auth())
      .send({ username: "u", tokenJson: FAKE_TOKEN });
    expect(mockGetUserSettings).toHaveBeenCalledTimes(1);
    expect(mockGetUserProfile).toHaveBeenCalledTimes(1);
  });

  it("returns refreshed tokens", async () => {
    const res = await request(app)
      .post("/garmin/athlete-profile")
      .set(auth())
      .send({ username: "u", tokenJson: FAKE_TOKEN });
    expect(res.body.tokenJson).toEqual(REFRESHED_TOKEN);
  });

  it("returns 400 when username is missing", async () => {
    const res = await request(app)
      .post("/garmin/athlete-profile")
      .set(auth())
      .send({ tokenJson: FAKE_TOKEN });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Missing username/);
  });

  it("returns 400 when tokenJson is missing", async () => {
    const res = await request(app)
      .post("/garmin/athlete-profile")
      .set(auth())
      .send({ username: "u" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Missing tokenJson/);
  });

  it("returns 401 for expired token", async () => {
    mockGetUserSettings.mockRejectedValue(new Error("Token expired"));
    const res = await request(app)
      .post("/garmin/athlete-profile")
      .set(auth())
      .send({ username: "u", tokenJson: FAKE_TOKEN });
    expect(res.status).toBe(401);
  });

  it("returns 504 on timeout", async () => {
    mockGetUserSettings.mockRejectedValue(new GarminTimeoutError(10000));
    const res = await request(app)
      .post("/garmin/athlete-profile")
      .set(auth())
      .send({ username: "u", tokenJson: FAKE_TOKEN });
    expect(res.status).toBe(504);
  });

  it("returns 500 for non-token Garmin errors", async () => {
    mockGetUserSettings.mockRejectedValue(new Error("Network timeout"));
    const res = await request(app)
      .post("/garmin/athlete-profile")
      .set(auth())
      .send({ username: "u", tokenJson: FAKE_TOKEN });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Garmin request failed");
  });
});

// ============================================================
// buildAthleteProfile UNIT TESTS
// ============================================================

describe("buildAthleteProfile", () => {
  const defaultSettings = {
    userData: {
      gender: "MALE",
      weight: 79980,
      height: 176,
      birthDate: "1981-02-02",
      vo2MaxRunning: 50,
      vo2MaxCycling: 51,
      lactateThresholdHeartRate: 158,
      lactateThresholdSpeed: 0.36388787,
      activityLevel: 8,
      availableTrainingDays: ["MONDAY"],
      preferredLongTrainingDays: ["FRIDAY"],
      measurementSystem: "metric",
    },
    userSleep: { sleepTime: 79200, wakeTime: 21600 },
  };
  const defaultSocial = { displayName: "TestUser" };

  it("flattens settings + socialProfile correctly", () => {
    const result = buildAthleteProfile(defaultSettings, defaultSocial);
    expect(result.displayName).toBe("TestUser");
    expect(result.gender).toBe("MALE");
    expect(result.heightCm).toBe(176);
    expect(result.vo2MaxRunning).toBe(50);
  });

  it("computes age from birthDate", () => {
    const result = buildAthleteProfile(defaultSettings, defaultSocial);
    // Born 1981-02-02, should be 44 or 45 depending on today
    expect(result.age).toBeGreaterThanOrEqual(44);
    expect(result.age).toBeLessThanOrEqual(45);
  });

  it("handles birthday boundary (not yet had birthday this year)", () => {
    const today = new Date();
    // Set birthDate to tomorrow's month/day in a past year
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const futureMonth = String(tomorrow.getMonth() + 1).padStart(2, "0");
    const futureDay = String(tomorrow.getDate()).padStart(2, "0");
    const settings = {
      ...defaultSettings,
      userData: { ...defaultSettings.userData, birthDate: `1990-${futureMonth}-${futureDay}` },
    };
    const result = buildAthleteProfile(settings, defaultSocial);
    const expectedAge = today.getFullYear() - 1990 - 1;
    expect(result.age).toBe(expectedAge);
  });

  it("converts weight from grams to kg (1 decimal)", () => {
    const result = buildAthleteProfile(defaultSettings, defaultSocial);
    // 79980g → 80.0 kg (Math.round(79980/100)/10 = 800/10 = 80)
    expect(result.weightKg).toBe(80);

    const settings2 = {
      ...defaultSettings,
      userData: { ...defaultSettings.userData, weight: 72350 },
    };
    const result2 = buildAthleteProfile(settings2, defaultSocial);
    // 72350g → Math.round(72350/100)/10 = Math.round(723.5)/10 = 724/10 = 72.4
    expect(result2.weightKg).toBe(72.4);
  });

  it("converts sleep seconds to HH:MM strings", () => {
    const result = buildAthleteProfile(defaultSettings, defaultSocial);
    expect(result.sleepTime).toBe("22:00");
    expect(result.wakeTime).toBe("06:00");
  });

  it("handles missing/null userData gracefully", () => {
    const result = buildAthleteProfile({}, { displayName: "X" });
    expect(result.displayName).toBe("X");
    expect(result.gender).toBeNull();
    expect(result.age).toBeNull();
    expect(result.weightKg).toBeNull();
    expect(result.heightCm).toBeNull();
    expect(result.sleepTime).toBeNull();
    expect(result.wakeTime).toBeNull();
  });

  it("handles null userSettings gracefully", () => {
    const result = buildAthleteProfile(null, null);
    expect(result.displayName).toBeNull();
    expect(result.gender).toBeNull();
    expect(result.age).toBeNull();
  });
});

describe("secsToHHMM", () => {
  it("converts seconds from midnight to HH:MM", () => {
    expect(secsToHHMM(0)).toBe("00:00");
    expect(secsToHHMM(3600)).toBe("01:00");
    expect(secsToHHMM(79200)).toBe("22:00");
    expect(secsToHHMM(21600)).toBe("06:00");
    expect(secsToHHMM(45060)).toBe("12:31");
  });

  it("returns null for invalid input", () => {
    expect(secsToHHMM(null)).toBeNull();
    expect(secsToHHMM(undefined)).toBeNull();
    expect(secsToHHMM(-1)).toBeNull();
    expect(secsToHHMM(NaN)).toBeNull();
  });
});

describe("computeAge", () => {
  it("computes age from a date string", () => {
    const age = computeAge("1981-02-02");
    expect(age).toBeGreaterThanOrEqual(44);
    expect(age).toBeLessThanOrEqual(45);
  });

  it("returns null for null/undefined/invalid input", () => {
    expect(computeAge(null)).toBeNull();
    expect(computeAge(undefined)).toBeNull();
    expect(computeAge("not-a-date")).toBeNull();
  });
});

// ============================================================
// POST /garmin/activities TESTS
// ============================================================

describe("POST /garmin/activities", () => {
  it("returns activities with default limit and offset", async () => {
    const res = await request(app)
      .post("/garmin/activities")
      .set(auth())
      .send({ username: "u", tokenJson: FAKE_TOKEN });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.activities).toHaveLength(2);
    // Default offset=0, limit=10
    expect(mockGetActivities).toHaveBeenCalledWith(0, 10);
  });

  it("respects custom limit", async () => {
    const res = await request(app)
      .post("/garmin/activities")
      .set(auth())
      .send({ username: "u", tokenJson: FAKE_TOKEN, limit: 25 });
    expect(res.status).toBe(200);
    expect(mockGetActivities).toHaveBeenCalledWith(0, 25);
  });

  it("clamps limit to max 50", async () => {
    const res = await request(app)
      .post("/garmin/activities")
      .set(auth())
      .send({ username: "u", tokenJson: FAKE_TOKEN, limit: 100 });
    expect(res.status).toBe(200);
    expect(mockGetActivities).toHaveBeenCalledWith(0, 50);
  });

  it("clamps limit to min 1", async () => {
    const res = await request(app)
      .post("/garmin/activities")
      .set(auth())
      .send({ username: "u", tokenJson: FAKE_TOKEN, limit: 0 });
    expect(res.status).toBe(200);
    expect(mockGetActivities).toHaveBeenCalledWith(0, 1);
  });

  it("respects custom offset", async () => {
    const res = await request(app)
      .post("/garmin/activities")
      .set(auth())
      .send({ username: "u", tokenJson: FAKE_TOKEN, offset: 20 });
    expect(res.status).toBe(200);
    expect(mockGetActivities).toHaveBeenCalledWith(20, 10);
  });

  it("clamps negative offset to 0", async () => {
    const res = await request(app)
      .post("/garmin/activities")
      .set(auth())
      .send({ username: "u", tokenJson: FAKE_TOKEN, offset: -5 });
    expect(res.status).toBe(200);
    expect(mockGetActivities).toHaveBeenCalledWith(0, 10);
  });

  it("returns 400 when missing username", async () => {
    const res = await request(app)
      .post("/garmin/activities")
      .set(auth())
      .send({ tokenJson: FAKE_TOKEN });
    expect(res.status).toBe(400);
  });

  it("returns 400 when missing tokenJson", async () => {
    const res = await request(app)
      .post("/garmin/activities")
      .set(auth())
      .send({ username: "u" });
    expect(res.status).toBe(400);
  });

  it("returns refreshed tokens", async () => {
    const res = await request(app)
      .post("/garmin/activities")
      .set(auth())
      .send({ username: "u", tokenJson: FAKE_TOKEN });
    expect(res.body.tokenJson).toEqual(REFRESHED_TOKEN);
  });

  it("returns 401 on token-related errors", async () => {
    mockGetActivities.mockRejectedValue(new Error("403 Forbidden"));
    const res = await request(app)
      .post("/garmin/activities")
      .set(auth())
      .send({ username: "u", tokenJson: FAKE_TOKEN });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/Re-authenticate/);
  });

  it("preserves all date/time fields from Garmin untouched", async () => {
    const activitiesFromGarmin = [
      {
        activityId: 201,
        activityName: "Road Cycling",
        startTimeLocal: "2026-01-24 10:37:00",
        startTimeGMT: "2026-01-24 08:37:00",
        beginTimestamp: 1737711420000,
        distance: 72880,
      },
      {
        activityId: 202,
        activityName: "Road Cycling",
        startTimeLocal: "2026-01-17 07:00:00",
        startTimeGMT: "2026-01-17 05:00:00",
        beginTimestamp: 1737090000000,
        distance: 88310,
      },
    ];
    mockGetActivities.mockResolvedValue(activitiesFromGarmin);

    const res = await request(app)
      .post("/garmin/activities")
      .set(auth())
      .send({ username: "u", tokenJson: FAKE_TOKEN, limit: 20 });

    expect(res.status).toBe(200);
    const acts = res.body.activities;
    expect(acts).toHaveLength(2);

    // Dates must pass through byte-for-byte — no parsing, no timezone shift
    expect(acts[0].startTimeLocal).toBe("2026-01-24 10:37:00");
    expect(acts[0].startTimeGMT).toBe("2026-01-24 08:37:00");
    expect(acts[0].beginTimestamp).toBe(1737711420000);

    expect(acts[1].startTimeLocal).toBe("2026-01-17 07:00:00");
    expect(acts[1].startTimeGMT).toBe("2026-01-17 05:00:00");
    expect(acts[1].beginTimestamp).toBe(1737090000000);

    // The two activities must NOT share the same date
    expect(acts[0].startTimeLocal.slice(0, 10)).not.toBe(
      acts[1].startTimeLocal.slice(0, 10)
    );
  });

  it("preserves Garmin's activity ordering (most recent first)", async () => {
    const activitiesFromGarmin = [
      { activityId: 10, startTimeLocal: "2026-02-05 08:00:00", beginTimestamp: 1738742400000 },
      { activityId: 9, startTimeLocal: "2026-02-04 07:00:00", beginTimestamp: 1738652400000 },
      { activityId: 8, startTimeLocal: "2026-02-03 09:30:00", beginTimestamp: 1738573800000 },
    ];
    mockGetActivities.mockResolvedValue(activitiesFromGarmin);

    const res = await request(app)
      .post("/garmin/activities")
      .set(auth())
      .send({ username: "u", tokenJson: FAKE_TOKEN });

    const acts = res.body.activities;
    // Order must match Garmin's response exactly
    expect(acts.map((a) => a.activityId)).toEqual([10, 9, 8]);
    // Each activity's date must be earlier than the previous
    for (let i = 1; i < acts.length; i++) {
      expect(acts[i].beginTimestamp).toBeLessThan(acts[i - 1].beginTimestamp);
    }
  });
});

// ============================================================
// POST /garmin/activity TESTS
// ============================================================

describe("POST /garmin/activity", () => {
  // --- Basic fetch by ID ---

  it("returns full activity by ID (default profile)", async () => {
    const res = await request(app)
      .post("/garmin/activity")
      .set(auth())
      .send({ username: "u", tokenJson: FAKE_TOKEN, activityId: 99 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.profile).toBe("full");
    expect(res.body.activity.activityId).toBe(99);
    expect(res.body.activity.activityName).toBe("Morning Run");
    // Full profile includes flattened summaryDTO fields
    expect(res.body.activity.distance).toBe(8012.5);
    expect(res.body.activity.userProfileId).toBe(12345);
    // Nested DTOs are flattened away
    expect(res.body.activity.summaryDTO).toBeUndefined();
    expect(res.body.activity.metadataDTO).toBeUndefined();
    expect(mockGetActivity).toHaveBeenCalledWith({ activityId: 99 });
  });

  it("accepts string activityId", async () => {
    const res = await request(app)
      .post("/garmin/activity")
      .set(auth())
      .send({ username: "u", tokenJson: FAKE_TOKEN, activityId: "99" });
    expect(res.status).toBe(200);
    expect(mockGetActivity).toHaveBeenCalledWith({ activityId: 99 });
  });

  // --- Profile filtering ---

  it("returns only summary fields with profile=summary", async () => {
    const res = await request(app)
      .post("/garmin/activity")
      .set(auth())
      .send({ username: "u", tokenJson: FAKE_TOKEN, activityId: 99, profile: "summary" });
    expect(res.status).toBe(200);
    expect(res.body.profile).toBe("summary");
    const keys = Object.keys(res.body.activity);
    // Should contain only summary fields
    for (const key of keys) {
      expect(SUMMARY_FIELDS).toContain(key);
    }
    // Should have the core fields (from flattened summaryDTO)
    expect(res.body.activity.activityId).toBe(99);
    expect(res.body.activity.duration).toBe(2834.5);
    expect(res.body.activity.distance).toBe(8012.5);
    expect(res.body.activity.averageHR).toBe(152);
    expect(res.body.activity.calories).toBe(620);
    // Should NOT have coaching/full-only fields
    expect(res.body.activity.userProfileId).toBeUndefined();
    expect(res.body.activity.locationName).toBeUndefined();
    expect(res.body.activity.trainingEffect).toBeUndefined();
  });

  it("returns coaching fields with profile=coaching", async () => {
    const res = await request(app)
      .post("/garmin/activity")
      .set(auth())
      .send({ username: "u", tokenJson: FAKE_TOKEN, activityId: 99, profile: "coaching" });
    expect(res.status).toBe(200);
    expect(res.body.profile).toBe("coaching");
    const keys = Object.keys(res.body.activity);
    for (const key of keys) {
      expect(COACHING_FIELDS).toContain(key);
    }
    // Should have coaching fields (from flattened summaryDTO + metadataDTO)
    expect(res.body.activity.activityId).toBe(99);
    expect(res.body.activity.locationName).toBe("Tel Aviv");
    expect(res.body.activity.trainingEffect).toBe(3.2);
    expect(res.body.activity.averageHR).toBe(152);
    expect(res.body.activity.lapCount).toBe(5);
    expect(res.body.activity.averageRunCadence).toBe(172);
    // Should NOT have non-coaching fields
    expect(res.body.activity.userProfileId).toBeUndefined();
    expect(res.body.activity.startLatitude).toBeUndefined();
  });

  it("returns all fields with profile=full", async () => {
    const res = await request(app)
      .post("/garmin/activity")
      .set(auth())
      .send({ username: "u", tokenJson: FAKE_TOKEN, activityId: 99, profile: "full" });
    expect(res.status).toBe(200);
    expect(res.body.profile).toBe("full");
    // Full includes everything flattened
    expect(res.body.activity.distance).toBe(8012.5);
    expect(res.body.activity.lapCount).toBe(5);
    expect(res.body.activity.locationName).toBe("Tel Aviv");
    expect(res.body.activity.userProfileId).toBe(12345);
  });

  it("rejects invalid profile value", async () => {
    const res = await request(app)
      .post("/garmin/activity")
      .set(auth())
      .send({ username: "u", tokenJson: FAKE_TOKEN, activityId: 99, profile: "xyz" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid profile/);
  });

  // --- Most recent activity (no activityId) ---

  it("fetches most recent activity when activityId is omitted", async () => {
    mockGetActivities.mockResolvedValue([{ activityId: 77 }]);
    const res = await request(app)
      .post("/garmin/activity")
      .set(auth())
      .send({ username: "u", tokenJson: FAKE_TOKEN });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // Should have fetched the list first
    expect(mockGetActivities).toHaveBeenCalledWith(0, 1);
    // Then fetched the detail for the most recent
    expect(mockGetActivity).toHaveBeenCalledWith({ activityId: 77 });
  });

  it("does not call getActivities when activityId is provided", async () => {
    const res = await request(app)
      .post("/garmin/activity")
      .set(auth())
      .send({ username: "u", tokenJson: FAKE_TOKEN, activityId: 99 });
    expect(res.status).toBe(200);
    expect(mockGetActivities).not.toHaveBeenCalled();
  });

  it("returns 500 when user has no activities and activityId omitted", async () => {
    mockGetActivities.mockResolvedValue([]);
    const res = await request(app)
      .post("/garmin/activity")
      .set(auth())
      .send({ username: "u", tokenJson: FAKE_TOKEN });
    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
  });

  it("supports profile with most-recent fetch", async () => {
    mockGetActivities.mockResolvedValue([{ activityId: 77 }]);
    const res = await request(app)
      .post("/garmin/activity")
      .set(auth())
      .send({ username: "u", tokenJson: FAKE_TOKEN, profile: "summary" });
    expect(res.status).toBe(200);
    expect(res.body.profile).toBe("summary");
    // Should NOT have non-summary fields
    expect(res.body.activity.userProfileId).toBeUndefined();
    expect(res.body.activity.locationName).toBeUndefined();
  });

  // --- Validation ---

  it("returns 400 for invalid activityId (e.g. 'abc')", async () => {
    const res = await request(app)
      .post("/garmin/activity")
      .set(auth())
      .send({ username: "u", tokenJson: FAKE_TOKEN, activityId: "abc" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/activityId/i);
  });

  it("returns 400 when missing username", async () => {
    const res = await request(app)
      .post("/garmin/activity")
      .set(auth())
      .send({ tokenJson: FAKE_TOKEN, activityId: 1 });
    expect(res.status).toBe(400);
  });

  it("returns 400 when missing tokenJson", async () => {
    const res = await request(app)
      .post("/garmin/activity")
      .set(auth())
      .send({ username: "u", activityId: 1 });
    expect(res.status).toBe(400);
  });

  // --- Error handling ---

  it("returns 401 on token-related errors", async () => {
    mockGetActivity.mockRejectedValue(new Error("Session expired"));
    const res = await request(app)
      .post("/garmin/activity")
      .set(auth())
      .send({ username: "u", tokenJson: FAKE_TOKEN, activityId: 1 });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/Re-authenticate/);
  });

  it("returns 500 for non-token Garmin errors", async () => {
    mockGetActivity.mockRejectedValue(new Error("Server error"));
    const res = await request(app)
      .post("/garmin/activity")
      .set(auth())
      .send({ username: "u", tokenJson: FAKE_TOKEN, activityId: 1 });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Garmin request failed");
  });
});

// ============================================================
// pickFields HELPER TESTS
// ============================================================

describe("flattenActivityDetail", () => {
  it("spreads summaryDTO fields to top level", () => {
    const raw = {
      activityId: 1,
      summaryDTO: { distance: 5000, duration: 1200, averageHR: 150 },
    };
    const flat = flattenActivityDetail(raw);
    expect(flat.activityId).toBe(1);
    expect(flat.distance).toBe(5000);
    expect(flat.duration).toBe(1200);
    expect(flat.averageHR).toBe(150);
    expect(flat.summaryDTO).toBeUndefined();
  });

  it("maps activityTypeDTO to activityType", () => {
    const raw = {
      activityId: 1,
      activityTypeDTO: { typeId: 1, typeKey: "running" },
    };
    const flat = flattenActivityDetail(raw);
    expect(flat.activityType).toEqual({ typeId: 1, typeKey: "running" });
    expect(flat.activityTypeDTO).toBeUndefined();
  });

  it("pulls metadataDTO fields (lapCount, pr, manualActivity, etc.)", () => {
    const raw = {
      activityId: 1,
      metadataDTO: {
        lapCount: 3,
        hasSplits: true,
        personalRecord: true,
        manualActivity: false,
        manufacturer: "Garmin",
        favorite: false,
        autoCalcCalories: true,
        elevationCorrected: true,
      },
    };
    const flat = flattenActivityDetail(raw);
    expect(flat.lapCount).toBe(3);
    expect(flat.hasSplits).toBe(true);
    expect(flat.pr).toBe(true);
    expect(flat.manualActivity).toBe(false);
    expect(flat.manufacturer).toBe("Garmin");
    expect(flat.metadataDTO).toBeUndefined();
  });

  it("removes eventTypeDTO, timeZoneUnitDTO, accessControlRuleDTO", () => {
    const raw = {
      activityId: 1,
      eventTypeDTO: { typeId: 5 },
      timeZoneUnitDTO: { unitId: 124 },
      accessControlRuleDTO: { typeId: 2 },
    };
    const flat = flattenActivityDetail(raw);
    expect(flat.activityId).toBe(1);
    expect(flat.eventTypeDTO).toBeUndefined();
    expect(flat.timeZoneUnitDTO).toBeUndefined();
    expect(flat.accessControlRuleDTO).toBeUndefined();
  });

  it("returns non-object input as-is", () => {
    expect(flattenActivityDetail(null)).toBe(null);
    expect(flattenActivityDetail(undefined)).toBe(undefined);
  });
});

// ============================================================
// POST /garmin/splits TESTS
// ============================================================

const FAKE_SPLITS_RESPONSE = {
  activityId: 21656174532,
  lapDTOs: [
    {
      startTimeGMT: "2026-01-25T06:08:30.0",
      startLatitude: 31.768,
      startLongitude: 35.201,
      distance: 1000,
      duration: 361.547,
      movingDuration: 361.547,
      elapsedDuration: 474.874,
      elevationGain: 22,
      elevationLoss: 2,
      maxElevation: 750.4,
      minElevation: 727.6,
      averageSpeed: 2.766,
      averageMovingSpeed: 2.766,
      maxSpeed: 3.191,
      calories: 73,
      bmrCalories: 9,
      averageHR: 119,
      maxHR: 141,
      averageRunCadence: 165.89,
      maxRunCadence: 182,
      averagePower: 344,
      maxPower: 405,
      minPower: 0,
      normalizedPower: 350,
      totalWork: 29.83,
      groundContactTime: 267.8,
      strideLength: 99.46,
      verticalOscillation: 8.54,
      verticalRatio: 8.63,
      endLatitude: 31.772,
      endLongitude: 35.208,
      maxVerticalSpeed: 0.4,
      avgGradeAdjustedSpeed: 2.946,
      lapIndex: 1,
      lengthDTOs: [],
      connectIQMeasurement: [],
      intensityType: "INTERVAL",
      messageIndex: 0,
    },
    {
      startTimeGMT: "2026-01-25T06:16:26.0",
      startLatitude: 31.772,
      startLongitude: 35.208,
      distance: 1000,
      duration: 348.731,
      movingDuration: 345,
      elapsedDuration: 702.621,
      elevationGain: 23,
      elevationLoss: 3,
      maxElevation: 771.8,
      minElevation: 750.4,
      averageSpeed: 2.868,
      averageMovingSpeed: 2.899,
      maxSpeed: 3.406,
      calories: 73,
      bmrCalories: 8,
      averageHR: 126,
      maxHR: 144,
      averageRunCadence: 159.05,
      maxRunCadence: 171,
      averagePower: 351,
      maxPower: 448,
      minPower: 0,
      normalizedPower: 351,
      totalWork: 29.36,
      groundContactTime: 275.4,
      strideLength: 105.41,
      verticalOscillation: 9.2,
      verticalRatio: 8.73,
      endLatitude: 31.780,
      endLongitude: 35.208,
      maxVerticalSpeed: 0.2,
      avgGradeAdjustedSpeed: 2.981,
      lapIndex: 2,
      lengthDTOs: [],
      connectIQMeasurement: [],
      intensityType: "INTERVAL",
      messageIndex: 1,
    },
  ],
  eventDTOs: [
    {
      startTimeGMT: "2026-01-25T06:08:29.0",
      startTimeGMTDoubleValue: 1769321309000,
      sectionTypeDTO: { id: 4, key: "timerTrigger", sectionTypeKey: "TIMER_TRIGGER" },
    },
  ],
};

describe("POST /garmin/splits", () => {
  beforeEach(() => {
    mockGet.mockResolvedValue(FAKE_SPLITS_RESPONSE);
  });

  // --- Basic fetch by ID ---

  it("returns full splits by activityId (default profile)", async () => {
    const res = await request(app)
      .post("/garmin/splits")
      .set(auth())
      .send({ username: "u", tokenJson: FAKE_TOKEN, activityId: 21656174532 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.profile).toBe("full");
    expect(res.body.activityId).toBe(21656174532);
    expect(res.body.lapCount).toBe(2);
    expect(res.body.laps).toHaveLength(2);
    // Full profile includes all fields
    expect(res.body.laps[0].lapIndex).toBe(1);
    expect(res.body.laps[0].distance).toBe(1000);
    expect(res.body.laps[0].averagePower).toBe(344);
    expect(res.body.laps[0].startLatitude).toBe(31.768);
    expect(res.body.laps[0].groundContactTime).toBe(267.8);
    expect(res.body.laps[0].intensityType).toBe("INTERVAL");
    // Calls correct Garmin API URL
    expect(mockGet).toHaveBeenCalledWith(
      "https://connectapi.garmin.com/activity-service/activity/21656174532/splits"
    );
  });

  it("accepts string activityId", async () => {
    const res = await request(app)
      .post("/garmin/splits")
      .set(auth())
      .send({ username: "u", tokenJson: FAKE_TOKEN, activityId: "21656174532" });
    expect(res.status).toBe(200);
    expect(mockGet).toHaveBeenCalledWith(
      "https://connectapi.garmin.com/activity-service/activity/21656174532/splits"
    );
  });

  it("returns refreshed tokens", async () => {
    const res = await request(app)
      .post("/garmin/splits")
      .set(auth())
      .send({ username: "u", tokenJson: FAKE_TOKEN, activityId: 100 });
    expect(res.body.tokenJson).toEqual(REFRESHED_TOKEN);
  });

  // --- Profile filtering ---

  it("returns only summary fields with profile=summary", async () => {
    const res = await request(app)
      .post("/garmin/splits")
      .set(auth())
      .send({ username: "u", tokenJson: FAKE_TOKEN, activityId: 100, profile: "summary" });
    expect(res.status).toBe(200);
    expect(res.body.profile).toBe("summary");
    const lap = res.body.laps[0];
    const keys = Object.keys(lap);
    // Every key should be in the summary list
    for (const key of keys) {
      expect(SPLIT_SUMMARY_FIELDS).toContain(key);
    }
    // Core summary fields present
    expect(lap.lapIndex).toBe(1);
    expect(lap.distance).toBe(1000);
    expect(lap.duration).toBeDefined();
    expect(lap.averageHR).toBe(119);
    expect(lap.elevationGain).toBe(22);
    expect(lap.intensityType).toBe("INTERVAL");
    // Coaching/full-only fields excluded
    expect(lap.averagePower).toBeUndefined();
    expect(lap.groundContactTime).toBeUndefined();
    expect(lap.strideLength).toBeUndefined();
    expect(lap.startLatitude).toBeUndefined();
  });

  it("returns coaching fields with profile=coaching", async () => {
    const res = await request(app)
      .post("/garmin/splits")
      .set(auth())
      .send({ username: "u", tokenJson: FAKE_TOKEN, activityId: 100, profile: "coaching" });
    expect(res.status).toBe(200);
    expect(res.body.profile).toBe("coaching");
    const lap = res.body.laps[0];
    const keys = Object.keys(lap);
    for (const key of keys) {
      expect(SPLIT_COACHING_FIELDS).toContain(key);
    }
    // Has coaching-level fields
    expect(lap.averagePower).toBe(344);
    expect(lap.normalizedPower).toBe(350);
    expect(lap.groundContactTime).toBe(267.8);
    expect(lap.strideLength).toBe(99.46);
    expect(lap.verticalOscillation).toBe(8.54);
    expect(lap.avgGradeAdjustedSpeed).toBe(2.946);
    // But not GPS coords (full-only)
    expect(lap.startLatitude).toBeUndefined();
    expect(lap.endLatitude).toBeUndefined();
    expect(lap.lengthDTOs).toBeUndefined();
  });

  it("returns all fields with profile=full", async () => {
    const res = await request(app)
      .post("/garmin/splits")
      .set(auth())
      .send({ username: "u", tokenJson: FAKE_TOKEN, activityId: 100, profile: "full" });
    expect(res.status).toBe(200);
    expect(res.body.profile).toBe("full");
    const lap = res.body.laps[0];
    // Full includes everything
    expect(lap.startLatitude).toBe(31.768);
    expect(lap.endLatitude).toBe(31.772);
    expect(lap.averagePower).toBe(344);
    expect(lap.groundContactTime).toBe(267.8);
    expect(lap.lengthDTOs).toEqual([]);
  });

  it("rejects invalid profile value", async () => {
    const res = await request(app)
      .post("/garmin/splits")
      .set(auth())
      .send({ username: "u", tokenJson: FAKE_TOKEN, activityId: 100, profile: "xyz" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid profile/);
  });

  // --- Most recent activity (no activityId) ---

  it("fetches most recent activity splits when activityId is omitted", async () => {
    mockGetActivities.mockResolvedValue([{ activityId: 77 }]);
    const res = await request(app)
      .post("/garmin/splits")
      .set(auth())
      .send({ username: "u", tokenJson: FAKE_TOKEN });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mockGetActivities).toHaveBeenCalledWith(0, 1);
    expect(mockGet).toHaveBeenCalledWith(
      "https://connectapi.garmin.com/activity-service/activity/77/splits"
    );
  });

  it("does not call getActivities when activityId is provided", async () => {
    const res = await request(app)
      .post("/garmin/splits")
      .set(auth())
      .send({ username: "u", tokenJson: FAKE_TOKEN, activityId: 100 });
    expect(res.status).toBe(200);
    expect(mockGetActivities).not.toHaveBeenCalled();
  });

  it("returns 500 when user has no activities and activityId omitted", async () => {
    mockGetActivities.mockResolvedValue([]);
    const res = await request(app)
      .post("/garmin/splits")
      .set(auth())
      .send({ username: "u", tokenJson: FAKE_TOKEN });
    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
  });

  it("supports profile with most-recent fetch", async () => {
    mockGetActivities.mockResolvedValue([{ activityId: 77 }]);
    const res = await request(app)
      .post("/garmin/splits")
      .set(auth())
      .send({ username: "u", tokenJson: FAKE_TOKEN, profile: "summary" });
    expect(res.status).toBe(200);
    expect(res.body.profile).toBe("summary");
    expect(res.body.laps[0].averagePower).toBeUndefined();
  });

  // --- Validation ---

  it("returns 400 for invalid activityId", async () => {
    const res = await request(app)
      .post("/garmin/splits")
      .set(auth())
      .send({ username: "u", tokenJson: FAKE_TOKEN, activityId: "abc" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/activityId/i);
  });

  it("returns 400 when missing username", async () => {
    const res = await request(app)
      .post("/garmin/splits")
      .set(auth())
      .send({ tokenJson: FAKE_TOKEN, activityId: 1 });
    expect(res.status).toBe(400);
  });

  it("returns 400 when missing tokenJson", async () => {
    const res = await request(app)
      .post("/garmin/splits")
      .set(auth())
      .send({ username: "u", activityId: 1 });
    expect(res.status).toBe(400);
  });

  // --- Error handling ---

  it("returns 401 on token-related errors", async () => {
    mockGet.mockRejectedValue(new Error("Session expired"));
    const res = await request(app)
      .post("/garmin/splits")
      .set(auth())
      .send({ username: "u", tokenJson: FAKE_TOKEN, activityId: 1 });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/Re-authenticate/);
  });

  it("returns 500 for non-token Garmin errors", async () => {
    mockGet.mockRejectedValue(new Error("Server error"));
    const res = await request(app)
      .post("/garmin/splits")
      .set(auth())
      .send({ username: "u", tokenJson: FAKE_TOKEN, activityId: 1 });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Garmin request failed");
  });

  // --- Edge cases ---

  it("handles empty lapDTOs array", async () => {
    mockGet.mockResolvedValue({ activityId: 100, lapDTOs: [], eventDTOs: [] });
    const res = await request(app)
      .post("/garmin/splits")
      .set(auth())
      .send({ username: "u", tokenJson: FAKE_TOKEN, activityId: 100 });
    expect(res.status).toBe(200);
    expect(res.body.laps).toEqual([]);
    expect(res.body.lapCount).toBe(0);
  });

  it("handles missing lapDTOs gracefully", async () => {
    mockGet.mockResolvedValue({ activityId: 100 });
    const res = await request(app)
      .post("/garmin/splits")
      .set(auth())
      .send({ username: "u", tokenJson: FAKE_TOKEN, activityId: 100 });
    expect(res.status).toBe(200);
    expect(res.body.laps).toEqual([]);
    expect(res.body.lapCount).toBe(0);
  });

  it("preserves lap ordering from Garmin", async () => {
    const res = await request(app)
      .post("/garmin/splits")
      .set(auth())
      .send({ username: "u", tokenJson: FAKE_TOKEN, activityId: 100 });
    expect(res.status).toBe(200);
    expect(res.body.laps[0].lapIndex).toBe(1);
    expect(res.body.laps[1].lapIndex).toBe(2);
  });

  it("filters each lap independently with profile", async () => {
    const res = await request(app)
      .post("/garmin/splits")
      .set(auth())
      .send({ username: "u", tokenJson: FAKE_TOKEN, activityId: 100, profile: "summary" });
    expect(res.status).toBe(200);
    // Both laps should be filtered the same way
    for (const lap of res.body.laps) {
      const keys = Object.keys(lap);
      for (const key of keys) {
        expect(SPLIT_SUMMARY_FIELDS).toContain(key);
      }
    }
  });
});

describe("pickFields", () => {
  it("picks only specified fields", () => {
    const obj = { a: 1, b: 2, c: 3 };
    expect(pickFields(obj, ["a", "c"])).toEqual({ a: 1, c: 3 });
  });

  it("ignores fields not present in object", () => {
    const obj = { a: 1 };
    expect(pickFields(obj, ["a", "missing"])).toEqual({ a: 1 });
  });

  it("returns empty object for empty fields list", () => {
    expect(pickFields({ a: 1 }, [])).toEqual({});
  });

  it("preserves nested objects", () => {
    const obj = { activityType: { typeKey: "running" }, other: 1 };
    const result = pickFields(obj, ["activityType"]);
    expect(result).toEqual({ activityType: { typeKey: "running" } });
  });
});

// ============================================================
// transformSplitSummaries TESTS
// ============================================================

describe("transformSplitSummaries", () => {
  it("maps all known split types to phase names", () => {
    const types = [
      ["INTERVAL_WARMUP", "warmup"],
      ["INTERVAL_ACTIVE", "active"],
      ["INTERVAL_RECOVERY", "recovery"],
      ["INTERVAL_COOLDOWN", "cooldown"],
      ["RWD_RUN", "run"],
      ["RWD_WALK", "walk"],
      ["RWD_STAND", "stand"],
    ];
    for (const [splitType, expectedPhase] of types) {
      const result = transformSplitSummaries([{ splitType }]);
      expect(result[0].phase).toBe(expectedPhase);
      expect(result[0].splitType).toBe(splitType);
    }
  });

  it("falls back to lowercase splitType for unknown types", () => {
    const result = transformSplitSummaries([{ splitType: "FUTURE_TYPE" }]);
    expect(result[0].phase).toBe("future_type");
    expect(result[0].splitType).toBe("FUTURE_TYPE");
  });

  it("returns empty array for null/undefined input", () => {
    expect(transformSplitSummaries(null)).toEqual([]);
    expect(transformSplitSummaries(undefined)).toEqual([]);
  });

  it("returns empty array for empty input", () => {
    expect(transformSplitSummaries([])).toEqual([]);
  });

  it("preserves all original fields alongside phase", () => {
    const input = [{
      splitType: "INTERVAL_ACTIVE",
      noOfSplits: 3,
      distance: 3000,
      duration: 900,
      averageHR: 165,
      averageSpeed: 3.33,
    }];
    const result = transformSplitSummaries(input);
    expect(result[0].phase).toBe("active");
    expect(result[0].splitType).toBe("INTERVAL_ACTIVE");
    expect(result[0].noOfSplits).toBe(3);
    expect(result[0].distance).toBe(3000);
    expect(result[0].duration).toBe(900);
    expect(result[0].averageHR).toBe(165);
    expect(result[0].averageSpeed).toBe(3.33);
  });

  it("handles missing splitType gracefully", () => {
    const result = transformSplitSummaries([{ distance: 1000 }]);
    expect(result[0].phase).toBe("unknown");
  });
});

// ============================================================
// buildWorkoutResponse TESTS
// ============================================================

describe("buildWorkoutResponse", () => {
  const FLAT_ACTIVITY = {
    activityId: 99,
    activityName: "Morning Run",
    activityType: { typeId: 1, typeKey: "running" },
    startTimeLocal: "2026-02-05 07:15:00",
    startTimeGMT: "2026-02-05 05:15:00",
    locationName: "Tel Aviv",
    startLatitude: 32.0853,
    startLongitude: 34.7818,
    endLatitude: 32.0901,
    endLongitude: 34.7845,
    duration: 2834.5,
    movingDuration: 2790.1,
    elapsedDuration: 2900.0,
    distance: 8012.5,
    steps: 8500,
    averageSpeed: 2.83,
    averageMovingSpeed: 2.87,
    maxSpeed: 4.1,
    avgGradeAdjustedSpeed: 2.95,
    averageHR: 152,
    maxHR: 178,
    minHR: 90,
    elevationGain: 45.0,
    elevationLoss: 43.0,
    maxElevation: 28.0,
    minElevation: 2.0,
    averageRunCadence: 172,
    maxRunCadence: 184,
    strideLength: 1.05,
    groundContactTime: 245.0,
    verticalOscillation: 8.5,
    verticalRatio: 7.8,
    averagePower: 280,
    maxPower: 450,
    minPower: 0,
    normalizedPower: 290,
    totalWork: 45.2,
    trainingEffect: 3.2,
    anaerobicTrainingEffect: 1.1,
    aerobicTrainingEffectMessage: "IMPROVING_AEROBIC_BASE_8",
    anaerobicTrainingEffectMessage: "MAINTAINING_ANAEROBIC_BASE_1",
    trainingEffectLabel: "AEROBIC_BASE",
    activityTrainingLoad: 125.5,
    calories: 620,
    avgRespirationRate: 28,
    minRespirationRate: 18,
    maxRespirationRate: 42,
    moderateIntensityMinutes: 15,
    vigorousIntensityMinutes: 25,
    differenceBodyBattery: -12,
    directWorkoutFeel: 50,
    directWorkoutRpe: 40,
    waterEstimated: 750,
    beginPotentialStamina: 100,
    endPotentialStamina: 55,
    minAvailableStamina: 53,
    lapCount: 5,
    hasSplits: true,
    manualActivity: false,
    pr: false,
    favorite: false,
    // Fields that should be EXCLUDED from all groups
    userProfileId: 12345,
    activityUUID: "abc-123",
    isMultiSportParent: false,
    bmrCalories: 30,
    manufacturer: "Garmin",
    autoCalcCalories: false,
    elevationCorrected: true,
    maxVerticalSpeed: 0.5,
    splitSummaries: [
      { splitType: "INTERVAL_WARMUP", noOfSplits: 1, distance: 2000 },
      { splitType: "INTERVAL_ACTIVE", noOfSplits: 5, distance: 5000 },
      { splitType: "INTERVAL_RECOVERY", noOfSplits: 4, distance: 800 },
      { splitType: "INTERVAL_COOLDOWN", noOfSplits: 1, distance: 1200 },
    ],
  };

  const MOCK_LAPS = [
    {
      lapIndex: 1, distance: 1000, duration: 350, averageHR: 145,
      averagePower: 300, strideLength: 105, groundContactTime: 260,
      lengthDTOs: [], messageIndex: 0, bmrCalories: 5, minPower: 0,
    },
    {
      lapIndex: 2, distance: 1000, duration: 340, averageHR: 155,
      averagePower: 320, strideLength: 108, groundContactTime: 255,
      lengthDTOs: [], messageIndex: 1, bmrCalories: 5, minPower: 0,
    },
  ];

  it("groups fields into all 13 sections", () => {
    const result = buildWorkoutResponse(FLAT_ACTIVITY, MOCK_LAPS);
    const groups = Object.keys(result);
    expect(groups).toEqual([
      "identity", "timing", "distance", "pace", "heartRate",
      "elevation", "runningDynamics", "power", "training",
      "body", "workoutStructure", "laps", "meta",
    ]);
  });

  it("populates identity correctly", () => {
    const result = buildWorkoutResponse(FLAT_ACTIVITY, MOCK_LAPS);
    expect(result.identity.activityId).toBe(99);
    expect(result.identity.activityName).toBe("Morning Run");
    expect(result.identity.activityType.typeKey).toBe("running");
    expect(result.identity.startTimeLocal).toBe("2026-02-05 07:15:00");
    expect(result.identity.locationName).toBe("Tel Aviv");
    expect(result.identity.startLatitude).toBe(32.0853);
    expect(result.identity.endLongitude).toBe(34.7845);
  });

  it("populates timing correctly", () => {
    const result = buildWorkoutResponse(FLAT_ACTIVITY, MOCK_LAPS);
    expect(result.timing.duration).toBe(2834.5);
    expect(result.timing.movingDuration).toBe(2790.1);
    expect(result.timing.elapsedDuration).toBe(2900.0);
  });

  it("populates distance correctly", () => {
    const result = buildWorkoutResponse(FLAT_ACTIVITY, MOCK_LAPS);
    expect(result.distance.distance).toBe(8012.5);
    expect(result.distance.steps).toBe(8500);
  });

  it("populates pace correctly", () => {
    const result = buildWorkoutResponse(FLAT_ACTIVITY, MOCK_LAPS);
    expect(result.pace.averageSpeed).toBe(2.83);
    expect(result.pace.maxSpeed).toBe(4.1);
    expect(result.pace.avgGradeAdjustedSpeed).toBe(2.95);
  });

  it("populates heartRate correctly", () => {
    const result = buildWorkoutResponse(FLAT_ACTIVITY, MOCK_LAPS);
    expect(result.heartRate.averageHR).toBe(152);
    expect(result.heartRate.maxHR).toBe(178);
    expect(result.heartRate.minHR).toBe(90);
  });

  it("populates elevation correctly", () => {
    const result = buildWorkoutResponse(FLAT_ACTIVITY, MOCK_LAPS);
    expect(result.elevation.elevationGain).toBe(45.0);
    expect(result.elevation.elevationLoss).toBe(43.0);
    expect(result.elevation.maxElevation).toBe(28.0);
    expect(result.elevation.minElevation).toBe(2.0);
  });

  it("populates runningDynamics correctly", () => {
    const result = buildWorkoutResponse(FLAT_ACTIVITY, MOCK_LAPS);
    expect(result.runningDynamics.averageRunCadence).toBe(172);
    expect(result.runningDynamics.strideLength).toBe(1.05);
    expect(result.runningDynamics.groundContactTime).toBe(245.0);
    expect(result.runningDynamics.verticalOscillation).toBe(8.5);
    expect(result.runningDynamics.verticalRatio).toBe(7.8);
  });

  it("populates power correctly", () => {
    const result = buildWorkoutResponse(FLAT_ACTIVITY, MOCK_LAPS);
    expect(result.power.averagePower).toBe(280);
    expect(result.power.normalizedPower).toBe(290);
    expect(result.power.totalWork).toBe(45.2);
  });

  it("populates training correctly", () => {
    const result = buildWorkoutResponse(FLAT_ACTIVITY, MOCK_LAPS);
    expect(result.training.trainingEffect).toBe(3.2);
    expect(result.training.anaerobicTrainingEffect).toBe(1.1);
    expect(result.training.trainingEffectLabel).toBe("AEROBIC_BASE");
    expect(result.training.activityTrainingLoad).toBe(125.5);
  });

  it("populates body correctly", () => {
    const result = buildWorkoutResponse(FLAT_ACTIVITY, MOCK_LAPS);
    expect(result.body.calories).toBe(620);
    expect(result.body.avgRespirationRate).toBe(28);
    expect(result.body.differenceBodyBattery).toBe(-12);
    expect(result.body.directWorkoutFeel).toBe(50);
    expect(result.body.directWorkoutRpe).toBe(40);
    expect(result.body.waterEstimated).toBe(750);
    expect(result.body.beginPotentialStamina).toBe(100);
    expect(result.body.endPotentialStamina).toBe(55);
    expect(result.body.minAvailableStamina).toBe(53);
  });

  it("populates meta correctly", () => {
    const result = buildWorkoutResponse(FLAT_ACTIVITY, MOCK_LAPS);
    expect(result.meta.lapCount).toBe(5);
    expect(result.meta.hasSplits).toBe(true);
    expect(result.meta.pr).toBe(false);
    expect(result.meta.favorite).toBe(false);
  });

  it("transforms splitSummaries into workoutStructure with phases", () => {
    const result = buildWorkoutResponse(FLAT_ACTIVITY, MOCK_LAPS);
    expect(result.workoutStructure).toHaveLength(4);
    expect(result.workoutStructure[0]).toEqual({
      phase: "warmup", splitType: "INTERVAL_WARMUP", noOfSplits: 1, distance: 2000,
    });
    expect(result.workoutStructure[1].phase).toBe("active");
    expect(result.workoutStructure[2].phase).toBe("recovery");
    expect(result.workoutStructure[3].phase).toBe("cooldown");
  });

  it("curates lap fields (drops noise like lengthDTOs, messageIndex, bmrCalories)", () => {
    const result = buildWorkoutResponse(FLAT_ACTIVITY, MOCK_LAPS);
    expect(result.laps).toHaveLength(2);
    expect(result.laps[0].lapIndex).toBe(1);
    expect(result.laps[0].distance).toBe(1000);
    expect(result.laps[0].averagePower).toBe(300);
    // Noise fields excluded
    expect(result.laps[0].lengthDTOs).toBeUndefined();
    expect(result.laps[0].messageIndex).toBeUndefined();
    expect(result.laps[0].bmrCalories).toBeUndefined();
    expect(result.laps[0].minPower).toBeUndefined();
  });

  it("excludes dropped activity fields from all groups", () => {
    const result = buildWorkoutResponse(FLAT_ACTIVITY, MOCK_LAPS);
    const allJson = JSON.stringify(result);
    expect(allJson).not.toContain('"userProfileId"');
    expect(allJson).not.toContain('"activityUUID"');
    expect(allJson).not.toContain('"isMultiSportParent"');
    expect(allJson).not.toContain('"bmrCalories"');
    expect(allJson).not.toContain('"manufacturer"');
    expect(allJson).not.toContain('"autoCalcCalories"');
    expect(allJson).not.toContain('"elevationCorrected"');
    expect(allJson).not.toContain('"maxVerticalSpeed"');
  });

  it("handles empty laps array", () => {
    const result = buildWorkoutResponse(FLAT_ACTIVITY, []);
    expect(result.laps).toEqual([]);
  });

  it("handles missing splitSummaries", () => {
    const noSplits = { ...FLAT_ACTIVITY, splitSummaries: undefined };
    const result = buildWorkoutResponse(noSplits, MOCK_LAPS);
    expect(result.workoutStructure).toEqual([]);
  });

  it("returns empty objects for groups with no matching data", () => {
    const minimal = { activityId: 1, duration: 100 };
    const result = buildWorkoutResponse(minimal, []);
    expect(result.identity.activityId).toBe(1);
    expect(result.timing.duration).toBe(100);
    expect(result.power).toEqual({});
    expect(result.runningDynamics).toEqual({});
    expect(result.training).toEqual({});
    expect(result.body).toEqual({});
  });
});

// ============================================================
// POST /garmin/workout TESTS
// ============================================================

describe("POST /garmin/workout", () => {
  beforeEach(() => {
    mockGet.mockResolvedValue(FAKE_SPLITS_RESPONSE);
  });

  // --- Basic fetch ---

  it("returns structured workout by activityId", async () => {
    const res = await request(app)
      .post("/garmin/workout")
      .set(auth())
      .send({ username: "u", tokenJson: FAKE_TOKEN, activityId: 99 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.activityId).toBe(99);
    expect(res.body.workout).toBeDefined();
    const groups = Object.keys(res.body.workout);
    expect(groups).toContain("identity");
    expect(groups).toContain("timing");
    expect(groups).toContain("distance");
    expect(groups).toContain("pace");
    expect(groups).toContain("heartRate");
    expect(groups).toContain("elevation");
    expect(groups).toContain("runningDynamics");
    expect(groups).toContain("power");
    expect(groups).toContain("training");
    expect(groups).toContain("body");
    expect(groups).toContain("workoutStructure");
    expect(groups).toContain("laps");
    expect(groups).toContain("meta");
  });

  // --- Parallel fetch verification ---

  it("calls both getActivity and splits API", async () => {
    const res = await request(app)
      .post("/garmin/workout")
      .set(auth())
      .send({ username: "u", tokenJson: FAKE_TOKEN, activityId: 99 });
    expect(res.status).toBe(200);
    expect(mockGetActivity).toHaveBeenCalledWith({ activityId: 99 });
    expect(mockGet).toHaveBeenCalledWith(
      "https://connectapi.garmin.com/activity-service/activity/99/splits"
    );
  });

  it("does not call getActivities when activityId is provided", async () => {
    await request(app)
      .post("/garmin/workout")
      .set(auth())
      .send({ username: "u", tokenJson: FAKE_TOKEN, activityId: 99 });
    expect(mockGetActivities).not.toHaveBeenCalled();
  });

  // --- Most recent activity ---

  it("fetches most recent activity when activityId is omitted", async () => {
    mockGetActivities.mockResolvedValue([{ activityId: 77 }]);
    const res = await request(app)
      .post("/garmin/workout")
      .set(auth())
      .send({ username: "u", tokenJson: FAKE_TOKEN });
    expect(res.status).toBe(200);
    expect(mockGetActivities).toHaveBeenCalledWith(0, 1);
    expect(mockGetActivity).toHaveBeenCalledWith({ activityId: 77 });
    expect(mockGet).toHaveBeenCalledWith(
      "https://connectapi.garmin.com/activity-service/activity/77/splits"
    );
  });

  it("returns 500 when user has no activities and activityId omitted", async () => {
    mockGetActivities.mockResolvedValue([]);
    const res = await request(app)
      .post("/garmin/workout")
      .set(auth())
      .send({ username: "u", tokenJson: FAKE_TOKEN });
    expect(res.status).toBe(500);
  });

  // --- Grouped data verification ---

  it("includes flattened activity fields in correct groups", async () => {
    const res = await request(app)
      .post("/garmin/workout")
      .set(auth())
      .send({ username: "u", tokenJson: FAKE_TOKEN, activityId: 99 });
    const w = res.body.workout;
    expect(w.identity.activityName).toBe("Morning Run");
    expect(w.identity.locationName).toBe("Tel Aviv");
    expect(w.timing.duration).toBe(2834.5);
    expect(w.distance.distance).toBe(8012.5);
    expect(w.heartRate.averageHR).toBe(152);
    expect(w.elevation.elevationGain).toBe(45.0);
    expect(w.meta.lapCount).toBe(5);
  });

  it("includes laps from splits API", async () => {
    const res = await request(app)
      .post("/garmin/workout")
      .set(auth())
      .send({ username: "u", tokenJson: FAKE_TOKEN, activityId: 99 });
    expect(res.body.workout.laps).toHaveLength(2);
    expect(res.body.workout.laps[0].lapIndex).toBe(1);
    expect(res.body.workout.laps[0].averagePower).toBe(344);
  });

  it("excludes noise fields from laps", async () => {
    const res = await request(app)
      .post("/garmin/workout")
      .set(auth())
      .send({ username: "u", tokenJson: FAKE_TOKEN, activityId: 99 });
    const lap = res.body.workout.laps[0];
    expect(lap.lengthDTOs).toBeUndefined();
    expect(lap.connectIQMeasurement).toBeUndefined();
    expect(lap.messageIndex).toBeUndefined();
    expect(lap.bmrCalories).toBeUndefined();
  });

  it("transforms splitSummaries into workoutStructure", async () => {
    const res = await request(app)
      .post("/garmin/workout")
      .set(auth())
      .send({ username: "u", tokenJson: FAKE_TOKEN, activityId: 99 });
    const ws = res.body.workout.workoutStructure;
    expect(Array.isArray(ws)).toBe(true);
    // The mock activity has one splitSummary entry
    expect(ws.length).toBeGreaterThan(0);
    expect(ws[0].splitType).toBeDefined();
  });

  it("excludes dropped activity fields", async () => {
    const res = await request(app)
      .post("/garmin/workout")
      .set(auth())
      .send({ username: "u", tokenJson: FAKE_TOKEN, activityId: 99 });
    const allJson = JSON.stringify(res.body.workout);
    expect(allJson).not.toContain('"userProfileId"');
    expect(allJson).not.toContain('"isMultiSportParent"');
  });

  // --- Token refresh ---

  it("returns refreshed tokens", async () => {
    const res = await request(app)
      .post("/garmin/workout")
      .set(auth())
      .send({ username: "u", tokenJson: FAKE_TOKEN, activityId: 99 });
    expect(res.body.tokenJson).toEqual(REFRESHED_TOKEN);
  });

  // --- Validation ---

  it("returns 400 for invalid activityId", async () => {
    const res = await request(app)
      .post("/garmin/workout")
      .set(auth())
      .send({ username: "u", tokenJson: FAKE_TOKEN, activityId: "abc" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/activityId/i);
  });

  it("returns 400 when missing username", async () => {
    const res = await request(app)
      .post("/garmin/workout")
      .set(auth())
      .send({ tokenJson: FAKE_TOKEN, activityId: 1 });
    expect(res.status).toBe(400);
  });

  it("returns 400 when missing tokenJson", async () => {
    const res = await request(app)
      .post("/garmin/workout")
      .set(auth())
      .send({ username: "u", activityId: 1 });
    expect(res.status).toBe(400);
  });

  // --- Error handling ---

  it("returns 401 on token-related errors from activity fetch", async () => {
    mockGetActivity.mockRejectedValue(new Error("401 Unauthorized"));
    const res = await request(app)
      .post("/garmin/workout")
      .set(auth())
      .send({ username: "u", tokenJson: FAKE_TOKEN, activityId: 1 });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/Re-authenticate/);
  });

  it("returns 401 on token-related errors from splits fetch", async () => {
    mockGet.mockRejectedValue(new Error("403 Forbidden"));
    const res = await request(app)
      .post("/garmin/workout")
      .set(auth())
      .send({ username: "u", tokenJson: FAKE_TOKEN, activityId: 1 });
    expect(res.status).toBe(401);
  });

  it("returns 500 for non-token errors", async () => {
    mockGetActivity.mockRejectedValue(new Error("Network timeout"));
    const res = await request(app)
      .post("/garmin/workout")
      .set(auth())
      .send({ username: "u", tokenJson: FAKE_TOKEN, activityId: 1 });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Garmin request failed");
  });

  // --- Edge cases ---

  it("handles empty splits gracefully", async () => {
    mockGet.mockResolvedValue({ activityId: 99, lapDTOs: [] });
    const res = await request(app)
      .post("/garmin/workout")
      .set(auth())
      .send({ username: "u", tokenJson: FAKE_TOKEN, activityId: 99 });
    expect(res.status).toBe(200);
    expect(res.body.workout.laps).toEqual([]);
  });

  it("handles missing lapDTOs gracefully", async () => {
    mockGet.mockResolvedValue({ activityId: 99 });
    const res = await request(app)
      .post("/garmin/workout")
      .set(auth())
      .send({ username: "u", tokenJson: FAKE_TOKEN, activityId: 99 });
    expect(res.status).toBe(200);
    expect(res.body.workout.laps).toEqual([]);
  });

  // --- Auth ---

  it("requires API key", async () => {
    const res = await request(app)
      .post("/garmin/workout")
      .send({ username: "u", tokenJson: FAKE_TOKEN, activityId: 99 });
    expect(res.status).toBe(401);
  });
});

// ============================================================
// TIMEOUT TESTS
// ============================================================

describe("withTimeout", () => {
  it("resolves when promise completes before timeout", async () => {
    const result = await withTimeout(Promise.resolve("ok"), 1000);
    expect(result).toBe("ok");
  });

  it("rejects with GarminTimeoutError when promise exceeds timeout", async () => {
    const slow = new Promise((resolve) => setTimeout(resolve, 5000));
    await expect(withTimeout(slow, 50)).rejects.toThrow(GarminTimeoutError);
  });

  it("propagates the original rejection if it happens before timeout", async () => {
    const failing = Promise.reject(new Error("original error"));
    await expect(withTimeout(failing, 1000)).rejects.toThrow("original error");
  });
});

describe("Timeout handling (504 responses)", () => {
  it("POST /garmin/profile returns 504 on timeout", async () => {
    mockGetUserProfile.mockRejectedValue(new GarminTimeoutError(GARMIN_API_TIMEOUT_MS));
    const res = await request(app)
      .post("/garmin/profile")
      .set(auth())
      .send({ username: "u", tokenJson: FAKE_TOKEN });
    expect(res.status).toBe(504);
    expect(res.body.error).toMatch(/timed out/i);
  });

  it("POST /garmin/activities returns 504 on timeout", async () => {
    mockGetActivities.mockRejectedValue(new GarminTimeoutError(GARMIN_API_TIMEOUT_MS));
    const res = await request(app)
      .post("/garmin/activities")
      .set(auth())
      .send({ username: "u", tokenJson: FAKE_TOKEN });
    expect(res.status).toBe(504);
    expect(res.body.error).toMatch(/timed out/i);
  });

  it("POST /garmin/activity returns 504 on timeout", async () => {
    mockGetActivity.mockRejectedValue(new GarminTimeoutError(GARMIN_API_TIMEOUT_MS));
    const res = await request(app)
      .post("/garmin/activity")
      .set(auth())
      .send({ username: "u", tokenJson: FAKE_TOKEN, activityId: 99 });
    expect(res.status).toBe(504);
    expect(res.body.error).toMatch(/timed out/i);
  });

  it("POST /garmin/splits returns 504 on timeout", async () => {
    mockGet.mockRejectedValue(new GarminTimeoutError(GARMIN_API_TIMEOUT_MS));
    const res = await request(app)
      .post("/garmin/splits")
      .set(auth())
      .send({ username: "u", tokenJson: FAKE_TOKEN, activityId: 99 });
    expect(res.status).toBe(504);
    expect(res.body.error).toMatch(/timed out/i);
  });

  it("POST /garmin/workout returns 504 on timeout", async () => {
    mockGetActivity.mockRejectedValue(new GarminTimeoutError(GARMIN_API_TIMEOUT_MS));
    const res = await request(app)
      .post("/garmin/workout")
      .set(auth())
      .send({ username: "u", tokenJson: FAKE_TOKEN, activityId: 99 });
    expect(res.status).toBe(504);
    expect(res.body.error).toMatch(/timed out/i);
  });

  it("POST /garmin/connect returns 504 when login() times out", async () => {
    mockLogin.mockRejectedValue(new GarminTimeoutError(GARMIN_LOGIN_TIMEOUT_MS));
    const res = await request(app)
      .post("/garmin/connect")
      .set(auth())
      .send({ username: "u", password: "p" });
    expect(res.status).toBe(504);
    expect(res.body.error).toMatch(/timed out/i);
  });

  it("POST /garmin/connect returns 504 (not fallback to login) when token validation times out", async () => {
    mockGetUserProfile.mockRejectedValue(new GarminTimeoutError(GARMIN_API_TIMEOUT_MS));
    const res = await request(app)
      .post("/garmin/connect")
      .set(auth())
      .send({ username: "u", password: "p", tokenJson: FAKE_TOKEN });
    expect(res.status).toBe(504);
    expect(res.body.error).toMatch(/timed out/i);
    // Should NOT have attempted password login
    expect(mockLogin).not.toHaveBeenCalled();
  });
});

// ============================================================
// WORKOUT CREATION: TRANSLATION HELPERS
// ============================================================

describe("parsePaceToMps", () => {
  it("converts 5:00/km to m/s", () => {
    const mps = parsePaceToMps("5:00");
    expect(mps).toBeCloseTo(1000 / 300, 5); // 3.333 m/s
  });

  it("converts 4:30/km to m/s", () => {
    const mps = parsePaceToMps("4:30");
    expect(mps).toBeCloseTo(1000 / 270, 5); // 3.703 m/s
  });

  it("converts 6:15/km to m/s", () => {
    const mps = parsePaceToMps("6:15");
    expect(mps).toBeCloseTo(1000 / 375, 5);
  });

  it("returns null for invalid format", () => {
    expect(parsePaceToMps("abc")).toBeNull();
    expect(parsePaceToMps("")).toBeNull();
    expect(parsePaceToMps("5")).toBeNull();
    expect(parsePaceToMps("0:00")).toBeNull();
  });
});

describe("buildGarminSportType", () => {
  it("maps running", () => {
    expect(buildGarminSportType("running")).toEqual({ sportTypeId: 1, sportTypeKey: "running" });
  });

  it("maps cycling", () => {
    expect(buildGarminSportType("cycling")).toEqual({ sportTypeId: 2, sportTypeKey: "cycling" });
  });

  it("maps swimming", () => {
    expect(buildGarminSportType("swimming")).toEqual({ sportTypeId: 4, sportTypeKey: "swimming" });
  });

  it("maps strength", () => {
    expect(buildGarminSportType("strength")).toEqual({ sportTypeId: 5, sportTypeKey: "strength_training" });
  });

  it("maps cardio", () => {
    expect(buildGarminSportType("cardio")).toEqual({ sportTypeId: 6, sportTypeKey: "cardio_training" });
  });

  it("returns null for unknown sport", () => {
    expect(buildGarminSportType("golf")).toBeNull();
  });
});

describe("buildGarminDuration", () => {
  it("builds time duration", () => {
    const d = buildGarminDuration({ type: "time", seconds: 300 });
    expect(d.endCondition.conditionTypeKey).toBe("time");
    expect(d.endConditionValue).toBe(300);
  });

  it("builds distance duration", () => {
    const d = buildGarminDuration({ type: "distance", meters: 1000 });
    expect(d.endCondition.conditionTypeKey).toBe("distance");
    expect(d.endConditionValue).toBe(1000);
    expect(d.preferredEndConditionUnit.unitKey).toBe("kilometer");
  });

  it("builds calories duration", () => {
    const d = buildGarminDuration({ type: "calories", calories: 200 });
    expect(d.endCondition.conditionTypeKey).toBe("calories");
    expect(d.endConditionValue).toBe(200);
  });

  it("builds lapButton duration", () => {
    const d = buildGarminDuration({ type: "lapButton" });
    expect(d.endCondition.conditionTypeKey).toBe("lap.button");
    expect(d.endConditionValue).toBeNull();
  });

  it("builds heartRate duration", () => {
    const d = buildGarminDuration({ type: "heartRate", bpm: 150, comparison: "gt" });
    expect(d.endCondition.conditionTypeKey).toBe("heart.rate");
    expect(d.endConditionValue).toBe(150);
    expect(d.endConditionCompare).toBe("gt");
  });

  it("returns null for unknown type", () => {
    expect(buildGarminDuration({ type: "unknown" })).toBeNull();
  });

  it("returns null for missing input", () => {
    expect(buildGarminDuration(null)).toBeNull();
  });
});

describe("buildGarminTarget", () => {
  it("builds no target", () => {
    const t = buildGarminTarget({ type: "none" });
    expect(t.targetType.workoutTargetTypeKey).toBe("no.target");
  });

  it("builds pace target", () => {
    const t = buildGarminTarget({ type: "pace", minPerKm: "5:30", maxPerKm: "5:00" });
    expect(t.targetType.workoutTargetTypeKey).toBe("pace.zone");
    // minPerKm (5:30 = 330s/km) should be slower = smaller m/s
    expect(t.targetValueOne).toBeCloseTo(1000 / 330, 5);
    // maxPerKm (5:00 = 300s/km) should be faster = larger m/s
    expect(t.targetValueTwo).toBeCloseTo(1000 / 300, 5);
    expect(t.targetValueOne).toBeLessThan(t.targetValueTwo);
  });

  it("builds heartRateZone target", () => {
    const t = buildGarminTarget({ type: "heartRateZone", zone: 3 });
    expect(t.targetType.workoutTargetTypeKey).toBe("heart.rate.zone");
    expect(t.zoneNumber).toBe(3);
  });

  it("builds heartRate range target", () => {
    const t = buildGarminTarget({ type: "heartRate", min: 140, max: 160 });
    expect(t.targetType.workoutTargetTypeKey).toBe("heart.rate.zone");
    expect(t.targetValueOne).toBe(140);
    expect(t.targetValueTwo).toBe(160);
  });

  it("builds powerZone target", () => {
    const t = buildGarminTarget({ type: "powerZone", zone: 3 });
    expect(t.targetType.workoutTargetTypeKey).toBe("power.zone");
    expect(t.zoneNumber).toBe(3);
  });

  it("builds power range target", () => {
    const t = buildGarminTarget({ type: "power", min: 230, max: 270 });
    expect(t.targetType.workoutTargetTypeKey).toBe("power.zone");
    expect(t.targetValueOne).toBe(230);
    expect(t.targetValueTwo).toBe(270);
  });

  it("builds cadence target", () => {
    const t = buildGarminTarget({ type: "cadence", min: 170, max: 180 });
    expect(t.targetType.workoutTargetTypeKey).toBe("cadence");
    expect(t.targetValueOne).toBe(170);
    expect(t.targetValueTwo).toBe(180);
  });

  it("returns null for invalid pace", () => {
    expect(buildGarminTarget({ type: "pace", minPerKm: "bad", maxPerKm: "5:00" })).toBeNull();
  });

  it("returns no target for missing input", () => {
    const t = buildGarminTarget(null);
    expect(t.targetType.workoutTargetTypeKey).toBe("no.target");
  });
});

describe("buildGarminStep", () => {
  it("builds a complete ExecutableStepDTO", () => {
    const step = buildGarminStep({
      type: "interval",
      duration: { type: "distance", meters: 800 },
      target: { type: "pace", minPerKm: "4:30", maxPerKm: "4:00" },
      notes: "Fast!",
    }, 1);
    expect(step.type).toBe("ExecutableStepDTO");
    expect(step.stepId).toBe(1);
    expect(step.stepOrder).toBe(1);
    expect(step.stepType.stepTypeKey).toBe("interval");
    expect(step.endCondition.conditionTypeKey).toBe("distance");
    expect(step.endConditionValue).toBe(800);
    expect(step.targetType.workoutTargetTypeKey).toBe("pace.zone");
    expect(step.description).toBe("Fast!");
    expect(step.secondaryTargetType).toBeNull();
  });

  it("returns null for invalid step type", () => {
    expect(buildGarminStep({ type: "invalid", duration: { type: "time", seconds: 60 }, target: { type: "none" } }, 1)).toBeNull();
  });

  it("returns null for invalid duration", () => {
    expect(buildGarminStep({ type: "warmup", duration: { type: "bad" }, target: { type: "none" } }, 1)).toBeNull();
  });
});

describe("buildGarminRepeatGroup", () => {
  it("builds a RepeatGroupDTO with child steps", () => {
    const group = buildGarminRepeatGroup({
      type: "repeat",
      iterations: 4,
      steps: [
        { type: "interval", duration: { type: "distance", meters: 800 }, target: { type: "none" } },
        { type: "recovery", duration: { type: "time", seconds: 90 }, target: { type: "none" } },
      ],
    }, 3);
    expect(group.type).toBe("RepeatGroupDTO");
    expect(group.stepId).toBe(3);
    expect(group.stepType.stepTypeKey).toBe("repeat");
    expect(group.numberOfIterations).toBe(4);
    expect(group.workoutSteps).toHaveLength(2);
    expect(group.workoutSteps[0].stepId).toBe(4);
    expect(group.workoutSteps[0].type).toBe("ExecutableStepDTO");
    expect(group.workoutSteps[1].stepId).toBe(5);
    expect(group._nextId).toBe(6);
  });

  it("returns null if child step is invalid", () => {
    expect(buildGarminRepeatGroup({
      type: "repeat",
      iterations: 2,
      steps: [{ type: "bad", duration: { type: "time", seconds: 60 }, target: { type: "none" } }],
    }, 1)).toBeNull();
  });
});

describe("buildGarminWorkout", () => {
  it("builds a full workout with warmup + repeat + cooldown", () => {
    const result = buildGarminWorkout({
      name: "Test Workout",
      description: "A test",
      sport: "running",
      steps: [
        { type: "warmup", duration: { type: "time", seconds: 600 }, target: { type: "none" } },
        {
          type: "repeat", iterations: 3,
          steps: [
            { type: "interval", duration: { type: "distance", meters: 1000 }, target: { type: "pace", minPerKm: "5:00", maxPerKm: "4:30" } },
            { type: "recovery", duration: { type: "time", seconds: 90 }, target: { type: "none" } },
          ],
        },
        { type: "cooldown", duration: { type: "lapButton" }, target: { type: "none" } },
      ],
    });
    expect(result.workoutName).toBe("Test Workout");
    expect(result.description).toBe("A test");
    expect(result.sportType.sportTypeKey).toBe("running");
    expect(result.workoutSegments).toHaveLength(1);
    const steps = result.workoutSegments[0].workoutSteps;
    expect(steps).toHaveLength(3);
    // Warmup
    expect(steps[0].type).toBe("ExecutableStepDTO");
    expect(steps[0].stepId).toBe(1);
    expect(steps[0].stepType.stepTypeKey).toBe("warmup");
    // Repeat group
    expect(steps[1].type).toBe("RepeatGroupDTO");
    expect(steps[1].stepId).toBe(2);
    expect(steps[1].numberOfIterations).toBe(3);
    expect(steps[1].workoutSteps).toHaveLength(2);
    expect(steps[1].workoutSteps[0].stepId).toBe(3);
    expect(steps[1].workoutSteps[1].stepId).toBe(4);
    // _nextId should be stripped
    expect(steps[1]._nextId).toBeUndefined();
    // Cooldown
    expect(steps[2].type).toBe("ExecutableStepDTO");
    expect(steps[2].stepId).toBe(5);
    expect(steps[2].stepType.stepTypeKey).toBe("cooldown");
  });

  it("handles flat steps without repeats", () => {
    const result = buildGarminWorkout({
      name: "Easy Run",
      sport: "running",
      steps: [
        { type: "warmup", duration: { type: "time", seconds: 300 }, target: { type: "none" } },
        { type: "interval", duration: { type: "time", seconds: 1800 }, target: { type: "heartRateZone", zone: 2 } },
        { type: "cooldown", duration: { type: "time", seconds: 300 }, target: { type: "none" } },
      ],
    });
    const steps = result.workoutSegments[0].workoutSteps;
    expect(steps).toHaveLength(3);
    expect(steps[0].stepId).toBe(1);
    expect(steps[1].stepId).toBe(2);
    expect(steps[2].stepId).toBe(3);
  });
});

// ============================================================
// WORKOUT VALIDATION TESTS
// ============================================================

describe("validateWorkoutPayload", () => {
  const validWorkout = {
    name: "Test",
    sport: "running",
    steps: [
      { type: "warmup", duration: { type: "time", seconds: 300 }, target: { type: "none" } },
    ],
  };

  it("accepts a valid workout", () => {
    expect(validateWorkoutPayload(validWorkout).ok).toBe(true);
  });

  it("rejects missing workout", () => {
    expect(validateWorkoutPayload(null).ok).toBe(false);
  });

  it("rejects missing name", () => {
    expect(validateWorkoutPayload({ ...validWorkout, name: "" }).ok).toBe(false);
  });

  it("rejects invalid sport", () => {
    expect(validateWorkoutPayload({ ...validWorkout, sport: "golf" }).ok).toBe(false);
  });

  it("rejects empty steps", () => {
    expect(validateWorkoutPayload({ ...validWorkout, steps: [] }).ok).toBe(false);
  });

  it("rejects invalid step type", () => {
    const w = { ...validWorkout, steps: [{ type: "bad", duration: { type: "time", seconds: 60 }, target: { type: "none" } }] };
    expect(validateWorkoutPayload(w).ok).toBe(false);
  });

  it("rejects invalid duration type", () => {
    const w = { ...validWorkout, steps: [{ type: "warmup", duration: { type: "bad" }, target: { type: "none" } }] };
    expect(validateWorkoutPayload(w).ok).toBe(false);
  });

  it("rejects time duration with non-positive seconds", () => {
    const w = { ...validWorkout, steps: [{ type: "warmup", duration: { type: "time", seconds: 0 }, target: { type: "none" } }] };
    expect(validateWorkoutPayload(w).ok).toBe(false);
  });

  it("rejects distance duration with non-positive meters", () => {
    const w = { ...validWorkout, steps: [{ type: "warmup", duration: { type: "distance", meters: -1 }, target: { type: "none" } }] };
    expect(validateWorkoutPayload(w).ok).toBe(false);
  });

  it("rejects invalid target type", () => {
    const w = { ...validWorkout, steps: [{ type: "warmup", duration: { type: "time", seconds: 60 }, target: { type: "bad" } }] };
    expect(validateWorkoutPayload(w).ok).toBe(false);
  });

  it("rejects invalid pace format", () => {
    const w = { ...validWorkout, steps: [{
      type: "interval", duration: { type: "time", seconds: 60 },
      target: { type: "pace", minPerKm: "bad", maxPerKm: "5:00" },
    }] };
    expect(validateWorkoutPayload(w).ok).toBe(false);
  });

  it("rejects HR zone out of range", () => {
    const w = { ...validWorkout, steps: [{
      type: "interval", duration: { type: "time", seconds: 60 },
      target: { type: "heartRateZone", zone: 6 },
    }] };
    expect(validateWorkoutPayload(w).ok).toBe(false);
  });

  it("accepts valid repeat group", () => {
    const w = { ...validWorkout, steps: [
      { type: "repeat", iterations: 3, steps: [
        { type: "interval", duration: { type: "time", seconds: 60 }, target: { type: "none" } },
        { type: "recovery", duration: { type: "time", seconds: 30 }, target: { type: "none" } },
      ]},
    ]};
    expect(validateWorkoutPayload(w).ok).toBe(true);
  });

  it("rejects repeat with zero iterations", () => {
    const w = { ...validWorkout, steps: [
      { type: "repeat", iterations: 0, steps: [
        { type: "interval", duration: { type: "time", seconds: 60 }, target: { type: "none" } },
      ]},
    ]};
    expect(validateWorkoutPayload(w).ok).toBe(false);
  });

  it("rejects repeat with empty steps", () => {
    const w = { ...validWorkout, steps: [
      { type: "repeat", iterations: 3, steps: [] },
    ]};
    expect(validateWorkoutPayload(w).ok).toBe(false);
  });

  it("rejects nested repeats", () => {
    const w = { ...validWorkout, steps: [
      { type: "repeat", iterations: 2, steps: [
        { type: "repeat", iterations: 2, steps: [
          { type: "interval", duration: { type: "time", seconds: 60 }, target: { type: "none" } },
        ]},
      ]},
    ]};
    expect(validateWorkoutPayload(w).ok).toBe(false);
  });

  it("includes step number in error message", () => {
    const w = { ...validWorkout, steps: [
      { type: "warmup", duration: { type: "time", seconds: 300 }, target: { type: "none" } },
      { type: "interval", duration: { type: "bad" }, target: { type: "none" } },
    ]};
    const result = validateWorkoutPayload(w);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Step 2/);
  });
});

// ============================================================
// POST /garmin/workout/create TESTS
// ============================================================

describe("POST /garmin/workout/create", () => {
  const VALID_WORKOUT_BODY = {
    username: "u",
    tokenJson: FAKE_TOKEN,
    workout: {
      name: "Test Intervals",
      sport: "running",
      steps: [
        { type: "warmup", duration: { type: "time", seconds: 600 }, target: { type: "none" } },
        {
          type: "repeat", iterations: 4,
          steps: [
            { type: "interval", duration: { type: "distance", meters: 800 }, target: { type: "pace", minPerKm: "5:00", maxPerKm: "4:30" } },
            { type: "recovery", duration: { type: "time", seconds: 90 }, target: { type: "none" } },
          ],
        },
        { type: "cooldown", duration: { type: "lapButton" }, target: { type: "none" } },
      ],
    },
  };

  // --- Success ---

  it("creates a workout and returns workoutId", async () => {
    const res = await request(app)
      .post("/garmin/workout/create")
      .set(auth())
      .send(VALID_WORKOUT_BODY);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.workoutId).toBe(99999);
    expect(res.body.workoutName).toBe("Test Workout");
    expect(res.body.tokenJson).toEqual(REFRESHED_TOKEN);
    expect(mockCreateWorkout).toHaveBeenCalledTimes(1);
    expect(mockScheduleWorkout).not.toHaveBeenCalled();
  });

  it("passes correct Garmin JSON to createWorkout", async () => {
    await request(app)
      .post("/garmin/workout/create")
      .set(auth())
      .send(VALID_WORKOUT_BODY);
    const garminPayload = mockCreateWorkout.mock.calls[0][0];
    expect(garminPayload.workoutName).toBe("Test Intervals");
    expect(garminPayload.sportType.sportTypeKey).toBe("running");
    expect(garminPayload.workoutSegments).toHaveLength(1);
    const steps = garminPayload.workoutSegments[0].workoutSteps;
    expect(steps).toHaveLength(3);
    expect(steps[0].type).toBe("ExecutableStepDTO");
    expect(steps[1].type).toBe("RepeatGroupDTO");
    expect(steps[1].numberOfIterations).toBe(4);
    expect(steps[2].type).toBe("ExecutableStepDTO");
  });

  it("creates and schedules when scheduleDate provided", async () => {
    const res = await request(app)
      .post("/garmin/workout/create")
      .set(auth())
      .send({ ...VALID_WORKOUT_BODY, scheduleDate: "2026-03-15" });
    expect(res.status).toBe(200);
    expect(res.body.scheduled).toBe(true);
    expect(res.body.scheduleDate).toBe("2026-03-15");
    expect(mockScheduleWorkout).toHaveBeenCalledTimes(1);
    expect(mockScheduleWorkout).toHaveBeenCalledWith(
      { workoutId: "99999" },
      "2026-03-15"
    );
  });

  it("creates workout with flat steps (no repeats)", async () => {
    const body = {
      username: "u",
      tokenJson: FAKE_TOKEN,
      workout: {
        name: "Easy Run",
        sport: "running",
        steps: [
          { type: "warmup", duration: { type: "time", seconds: 300 }, target: { type: "none" } },
          { type: "interval", duration: { type: "time", seconds: 2400 }, target: { type: "heartRateZone", zone: 2 } },
          { type: "cooldown", duration: { type: "lapButton" }, target: { type: "none" } },
        ],
      },
    };
    const res = await request(app)
      .post("/garmin/workout/create")
      .set(auth())
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("creates cycling workout with power targets", async () => {
    const body = {
      username: "u",
      tokenJson: FAKE_TOKEN,
      workout: {
        name: "Sweet Spot",
        sport: "cycling",
        steps: [
          { type: "warmup", duration: { type: "time", seconds: 600 }, target: { type: "powerZone", zone: 2 } },
          { type: "interval", duration: { type: "time", seconds: 1200 }, target: { type: "power", min: 230, max: 270 } },
          { type: "cooldown", duration: { type: "time", seconds: 300 }, target: { type: "none" } },
        ],
      },
    };
    const res = await request(app)
      .post("/garmin/workout/create")
      .set(auth())
      .send(body);
    expect(res.status).toBe(200);
    const garminPayload = mockCreateWorkout.mock.calls[0][0];
    expect(garminPayload.sportType.sportTypeKey).toBe("cycling");
  });

  // --- Validation errors ---

  it("returns 400 for missing workout", async () => {
    const res = await request(app)
      .post("/garmin/workout/create")
      .set(auth())
      .send({ username: "u", tokenJson: FAKE_TOKEN });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Missing workout/);
  });

  it("returns 400 for invalid sport", async () => {
    const res = await request(app)
      .post("/garmin/workout/create")
      .set(auth())
      .send({ username: "u", tokenJson: FAKE_TOKEN, workout: { name: "X", sport: "golf", steps: [{ type: "warmup", duration: { type: "time", seconds: 60 }, target: { type: "none" } }] } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/sport/i);
  });

  it("returns 400 for invalid scheduleDate format", async () => {
    const res = await request(app)
      .post("/garmin/workout/create")
      .set(auth())
      .send({ ...VALID_WORKOUT_BODY, scheduleDate: "March 15" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/scheduleDate/);
  });

  // --- Auth ---

  it("requires API key", async () => {
    const res = await request(app)
      .post("/garmin/workout/create")
      .send(VALID_WORKOUT_BODY);
    expect(res.status).toBe(401);
  });

  it("returns 400 when missing username", async () => {
    const res = await request(app)
      .post("/garmin/workout/create")
      .set(auth())
      .send({ tokenJson: FAKE_TOKEN, workout: VALID_WORKOUT_BODY.workout });
    expect(res.status).toBe(400);
  });

  it("returns 400 when missing tokenJson", async () => {
    const res = await request(app)
      .post("/garmin/workout/create")
      .set(auth())
      .send({ username: "u", workout: VALID_WORKOUT_BODY.workout });
    expect(res.status).toBe(400);
  });

  // --- Error handling ---

  it("returns 401 on token errors", async () => {
    mockCreateWorkout.mockRejectedValue(new Error("401 Unauthorized"));
    const res = await request(app)
      .post("/garmin/workout/create")
      .set(auth())
      .send(VALID_WORKOUT_BODY);
    expect(res.status).toBe(401);
  });

  it("returns 504 on timeout", async () => {
    mockCreateWorkout.mockRejectedValue(new GarminTimeoutError(10000));
    const res = await request(app)
      .post("/garmin/workout/create")
      .set(auth())
      .send(VALID_WORKOUT_BODY);
    expect(res.status).toBe(504);
    expect(res.body.error).toMatch(/timed out/i);
  });

  it("returns 500 for non-token Garmin errors", async () => {
    mockCreateWorkout.mockRejectedValue(new Error("Server error"));
    const res = await request(app)
      .post("/garmin/workout/create")
      .set(auth())
      .send(VALID_WORKOUT_BODY);
    expect(res.status).toBe(500);
  });
});
