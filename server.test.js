import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

// ---------------------
// Mock GarminConnect before importing server
// ---------------------
const mockLogin = vi.fn();
const mockGetUserProfile = vi.fn();
const mockGetActivities = vi.fn();
const mockGetActivity = vi.fn();
const mockExportToken = vi.fn();
const mockLoadToken = vi.fn();

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
    exportToken(...args) { return mockExportToken(...args); }
    loadToken(...args) { return mockLoadToken(...args); }
  }
  return { default: { GarminConnect } };
});

// Now import the server (uses the mocked GarminConnect)
const {
  app,
  parseActivityIdFromBody,
  canAttemptPasswordLogin,
  markPasswordLoginAttempt,
  lastPasswordLoginAttemptByUsername,
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
  mockGetActivities.mockResolvedValue([{ activityId: 1 }, { activityId: 2 }]);
  mockGetActivity.mockResolvedValue({ activityId: 99, name: "Morning Run" });
  mockLogin.mockResolvedValue(undefined);
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
});

// ============================================================
// POST /garmin/activity TESTS
// ============================================================

describe("POST /garmin/activity", () => {
  it("returns full activity by ID", async () => {
    const res = await request(app)
      .post("/garmin/activity")
      .set(auth())
      .send({ username: "u", tokenJson: FAKE_TOKEN, activityId: 99 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.activity).toEqual({ activityId: 99, name: "Morning Run" });
    expect(mockGetActivity).toHaveBeenCalledWith(99);
  });

  it("returns 400 for missing activityId", async () => {
    const res = await request(app)
      .post("/garmin/activity")
      .set(auth())
      .send({ username: "u", tokenJson: FAKE_TOKEN });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/activityId/);
  });

  it("returns 400 for invalid activityId", async () => {
    const res = await request(app)
      .post("/garmin/activity")
      .set(auth())
      .send({ username: "u", tokenJson: FAKE_TOKEN, activityId: "abc" });
    expect(res.status).toBe(400);
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

  it("accepts string activityId", async () => {
    const res = await request(app)
      .post("/garmin/activity")
      .set(auth())
      .send({ username: "u", tokenJson: FAKE_TOKEN, activityId: "99" });
    expect(res.status).toBe(200);
    expect(mockGetActivity).toHaveBeenCalledWith(99);
  });

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
