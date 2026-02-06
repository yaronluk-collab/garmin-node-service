# Garmin Workout API — Base44 Integration Guide

## Overview

The Garmin Node Service exposes a `POST /garmin/workout` endpoint that returns a **single, semantically-grouped JSON representation** of a workout. It combines two Garmin API calls (activity detail + per-km lap splits) into one response, organized into 13 named groups designed for direct database storage and UI rendering.

---

## Authentication Flow

Every Garmin data endpoint requires two layers of auth:

1. **API Key** — `Authorization: Bearer <API_KEY>` header on every request
2. **Garmin OAuth tokens** — passed in the request body as `tokenJson`

### Getting tokens (one-time login)

```
POST /garmin/connect
Headers: { Authorization: Bearer <API_KEY> }
Body: {
  "username": "user@example.com",
  "password": "garmin-password"
}
Response: {
  "ok": true,
  "tokenJson": { "oauth1": {...}, "oauth2": {...} }
}
```

**Store `tokenJson`** — you'll pass it on every subsequent call. The service returns a refreshed `tokenJson` in every response; always store the latest one.

---

## Fetching a Workout

```
POST /garmin/workout
Headers: {
  Authorization: Bearer <API_KEY>,
  Content-Type: application/json
}
Body: {
  "username": "user@example.com",
  "tokenJson": { "oauth1": {...}, "oauth2": {...} },
  "activityId": 21678763609          // optional — omit for most recent
}
```

### Response Structure

```json
{
  "ok": true,
  "activityId": 21678763609,
  "workout": {
    "identity": { ... },
    "timing": { ... },
    "distance": { ... },
    "pace": { ... },
    "heartRate": { ... },
    "elevation": { ... },
    "runningDynamics": { ... },
    "power": { ... },
    "training": { ... },
    "body": { ... },
    "workoutStructure": [ ... ],
    "laps": [ ... ],
    "meta": { ... }
  },
  "tokenJson": { "oauth1": {...}, "oauth2": {...} }
}
```

**Important**: Always update your stored `tokenJson` with the one returned in the response.

---

## Group-by-Group Schema Reference

### 1. `identity` — What, when, where

The workout header. Use this for the top of any workout detail page.

| Field | Type | Example | Notes |
|---|---|---|---|
| `activityId` | number | `21678763609` | **Primary key** — unique identifier for this workout |
| `activityName` | string | `"Running"` | User-editable name from Garmin |
| `description` | string\|null | `"Easy 8k with strides"` | Optional user description |
| `activityType` | object | `{"typeId":1,"typeKey":"running"}` | `typeKey` is the useful one: "running", "cycling", "swimming", etc. |
| `sportTypeId` | number\|null | `1` | Garmin sport type ID |
| `startTimeLocal` | string | `"2026-01-27T12:21:58.0"` | Local time at workout location — **use this for display** |
| `startTimeGMT` | string | `"2026-01-27T10:21:58.0"` | UTC time — **use this for sorting/storage** |
| `locationName` | string\|null | `"Jerusalem"` | City/location name (may be null) |
| `startLatitude` | number\|null | `31.7679` | GPS start point |
| `startLongitude` | number\|null | `35.2019` | GPS start point |
| `endLatitude` | number\|null | `31.7677` | GPS end point |
| `endLongitude` | number\|null | `35.2018` | GPS end point |

### 2. `timing` — Duration breakdown

| Field | Type | Unit | Notes |
|---|---|---|---|
| `duration` | number | seconds | Active moving + stopped time within timer |
| `movingDuration` | number | seconds | Time actually moving (excludes pauses while timer running) |
| `elapsedDuration` | number | seconds | Wall clock time start to finish (includes timer pauses) |

**Display tip**: Show `duration` as the primary time. Show `elapsedDuration` only if it differs significantly (indicates long pauses). Format as `H:MM:SS` or `MM:SS`.

### 3. `distance` — How far

| Field | Type | Unit | Notes |
|---|---|---|---|
| `distance` | number | meters | Total distance. **Divide by 1000 for km.** |
| `steps` | number\|null | count | Step count (running/walking only) |

### 4. `pace` — Speed analysis

All speeds are in **meters per second**. Convert for display.

| Field | Type | Notes |
|---|---|---|
| `averageSpeed` | number | Overall average pace |
| `averageMovingSpeed` | number | Average excluding stopped time |
| `maxSpeed` | number | Peak speed during workout |
| `avgGradeAdjustedSpeed` | number | Pace adjusted for elevation (GAP) — key coaching metric |

**Pace conversion** (m/s → min/km): `paceMinPerKm = 1000 / (speed * 60)` or equivalently `16.6667 / speed`. Example: 2.857 m/s = 5:50 min/km.

### 5. `heartRate` — Cardiovascular response

| Field | Type | Unit |
|---|---|---|
| `averageHR` | number | bpm |
| `maxHR` | number | bpm |
| `minHR` | number | bpm |

### 6. `elevation` — Terrain profile

| Field | Type | Unit |
|---|---|---|
| `elevationGain` | number | meters |
| `elevationLoss` | number | meters |
| `maxElevation` | number | meters above sea level |
| `minElevation` | number | meters above sea level |

### 7. `runningDynamics` — Form & efficiency metrics

Only present for running activities with a compatible device (e.g., Garmin with HRM-Pro or running dynamics pod). **Will be an empty object `{}` for cycling, swimming, etc.** — hide the UI card when empty.

| Field | Type | Unit | What it tells a coach |
|---|---|---|---|
| `averageRunCadence` | number | steps/min | Ideal: 170-185 spm |
| `maxRunCadence` | number | steps/min | Sprint cadence |
| `strideLength` | number | cm | Longer = more power per step |
| `groundContactTime` | number | ms | Lower = more efficient (elite: 200-220ms) |
| `verticalOscillation` | number | cm | Lower = less wasted energy bouncing |
| `verticalRatio` | number | % | verticalOscillation / strideLength — lower is better |

### 8. `power` — Wattage metrics

Available for running (wrist-based or Stryd) and cycling (power meter). **Empty object for activities without power data.**

| Field | Type | Unit | Notes |
|---|---|---|---|
| `averagePower` | number | watts | Average for the workout |
| `maxPower` | number | watts | Peak power |
| `minPower` | number | watts | Usually 0 (standing still moments) |
| `normalizedPower` | number | watts | **More meaningful than average** — accounts for variability |
| `totalWork` | number | kJ | Total energy output |

### 9. `training` — Adaptation & load

Key coaching data — tells you the physiological impact of the workout.

| Field | Type | Notes |
|---|---|---|
| `trainingEffect` | number (0-5) | Aerobic training effect. 2.0-2.9 = maintaining, 3.0-3.9 = improving, 4.0-4.9 = highly improving, 5.0 = overreaching |
| `anaerobicTrainingEffect` | number (0-5) | Same scale for anaerobic system |
| `aerobicTrainingEffectMessage` | string | Garmin's description, e.g. `"IMPROVING_AEROBIC_BASE_8"` |
| `anaerobicTrainingEffectMessage` | string | e.g. `"MAINTAINING_ANAEROBIC_BASE_1"` |
| `trainingEffectLabel` | string | e.g. `"AEROBIC_BASE"`, `"TEMPO"`, `"THRESHOLD"` |
| `activityTrainingLoad` | number | EPOC-based load score. Higher = harder workout. Useful for weekly load tracking. |

### 10. `body` — Physiological response & recovery

| Field | Type | Unit | Notes |
|---|---|---|---|
| `calories` | number | kcal | Total calories burned |
| `avgRespirationRate` | number | breaths/min | |
| `minRespirationRate` | number | breaths/min | |
| `maxRespirationRate` | number | breaths/min | |
| `moderateIntensityMinutes` | number | minutes | WHO activity minutes (moderate zone) |
| `vigorousIntensityMinutes` | number | minutes | WHO activity minutes (vigorous zone) |
| `differenceBodyBattery` | number | points | Negative = drained. e.g. `-15` means workout cost 15 body battery points |
| `directWorkoutFeel` | number | 0-100 | User-reported post-workout feeling (if entered) |
| `directWorkoutRpe` | number | 0-100 | User-reported RPE (if entered) |
| `waterEstimated` | number | ml | Estimated hydration need |
| `beginPotentialStamina` | number | 0-100% | Stamina at workout start |
| `endPotentialStamina` | number | 0-100% | Stamina at workout end |
| `minAvailableStamina` | number | 0-100% | Lowest stamina during workout |

### 11. `workoutStructure` — Workout phases

An array describing the **design of the workout** — warmup, intervals, recovery, cooldown. Derived from Garmin's `splitSummaries`. Each entry aggregates all laps of that phase type.

```json
[
  { "phase": "warmup",   "splitType": "INTERVAL_WARMUP",   "noOfSplits": 1, "distance": 4821.7, "duration": 1728.4, "averageSpeed": 2.79, "averageHR": 132, ... },
  { "phase": "active",   "splitType": "INTERVAL_ACTIVE",   "noOfSplits": 6, "distance": 1209.7, "duration": 288.2,  "averageSpeed": 4.20, "averageHR": 147, ... },
  { "phase": "recovery", "splitType": "INTERVAL_RECOVERY", "noOfSplits": 5, "distance": 1055.2, "duration": 447.3,  "averageSpeed": 2.36, "averageHR": 139, ... },
  { "phase": "cooldown", "splitType": "INTERVAL_COOLDOWN", "noOfSplits": 1, "distance": 2929.3, "duration": 1040.3, "averageSpeed": 2.82, "averageHR": 136, ... },
  { "phase": "run",      "splitType": "RWD_RUN",           "noOfSplits": 12, ... },
  { "phase": "walk",     "splitType": "RWD_WALK",          "noOfSplits": 20, ... },
  { "phase": "stand",    "splitType": "RWD_STAND",         "noOfSplits": 11, ... }
]
```

| `phase` value | Meaning |
|---|---|
| `warmup` | Warm-up portion |
| `active` | Hard intervals / main work |
| `recovery` | Recovery jog between intervals |
| `cooldown` | Cool-down portion |
| `run` | General running segments (non-structured) |
| `walk` | Walking segments |
| `stand` | Standing/stopped segments |

**UI tip**: For a structured workout, show a visual timeline: warmup → active/recovery alternating → cooldown. For a non-structured run, only `run`/`walk`/`stand` phases will appear.

Each phase entry contains the same metric fields as the top-level groups (distance, duration, speed, HR, power, cadence, etc.) but aggregated for that phase. The `noOfSplits` tells you how many individual segments were in that phase.

### 12. `laps` — Per-lap breakdown

An array of individual laps (typically per-km auto-laps, but could be manual lap-button presses). This is the detailed splits table.

```json
[
  {
    "lapIndex": 1,
    "distance": 1000,
    "duration": 361.547,
    "movingDuration": 361.547,
    "startTimeGMT": "2026-01-25T06:08:30.0",
    "intensityType": "INTERVAL",
    "averageSpeed": 2.766,
    "averageMovingSpeed": 2.766,
    "maxSpeed": 3.191,
    "avgGradeAdjustedSpeed": 2.946,
    "elevationGain": 22,
    "elevationLoss": 2,
    "averageHR": 119,
    "maxHR": 141,
    "calories": 73,
    "averageRunCadence": 165.89,
    "maxRunCadence": 182,
    "groundContactTime": 267.8,
    "strideLength": 99.46,
    "verticalOscillation": 8.54,
    "verticalRatio": 8.63,
    "averagePower": 344,
    "maxPower": 405,
    "normalizedPower": 350,
    "totalWork": 29.83
  },
  { "lapIndex": 2, ... }
]
```

**UI tip**: Render as a table. Key columns: Lap #, Distance, Pace (convert averageSpeed), HR, Power, Cadence. Highlight the fastest/slowest laps.

### 13. `meta` — Flags & metadata

| Field | Type | Notes |
|---|---|---|
| `lapCount` | number | Total laps in the workout |
| `hasSplits` | boolean | Whether split data exists |
| `manualActivity` | boolean | `true` if manually entered (no GPS/sensor data) |
| `pr` | boolean | `true` if this workout set a personal record |
| `favorite` | boolean | User-favorited workout |

---

## Database Schema Recommendation

### Option A: Single table with JSON columns (simpler, recommended to start)

```sql
CREATE TABLE workouts (
  -- Primary key
  activity_id        BIGINT PRIMARY KEY,

  -- Identity (indexed for queries)
  activity_name      TEXT,
  activity_type      TEXT,          -- extract from identity.activityType.typeKey
  start_time_local   TIMESTAMP,    -- from identity.startTimeLocal
  start_time_gmt     TIMESTAMP,    -- from identity.startTimeGMT (use for sorting)
  location_name      TEXT,

  -- Top-level metrics (indexed for filtering/sorting)
  distance_meters    REAL,         -- from distance.distance
  duration_seconds   REAL,         -- from timing.duration
  average_hr         INTEGER,      -- from heartRate.averageHR
  calories           INTEGER,      -- from body.calories
  training_load      REAL,         -- from training.activityTrainingLoad
  training_effect    REAL,         -- from training.trainingEffect

  -- Grouped data (stored as JSON)
  identity           JSONB,
  timing             JSONB,
  distance           JSONB,
  pace               JSONB,
  heart_rate         JSONB,
  elevation          JSONB,
  running_dynamics   JSONB,
  power              JSONB,
  training           JSONB,
  body               JSONB,
  workout_structure  JSONB,        -- array
  laps               JSONB,        -- array
  meta               JSONB,

  -- Housekeeping
  user_id            TEXT NOT NULL, -- your app's user ID
  synced_at          TIMESTAMP DEFAULT NOW()
);

-- Essential indexes
CREATE INDEX idx_workouts_user_time ON workouts (user_id, start_time_gmt DESC);
CREATE INDEX idx_workouts_user_type ON workouts (user_id, activity_type);
```

### Option B: Normalized with laps table (if you need to query individual laps)

```sql
-- Same workouts table as above but WITHOUT laps JSONB column

CREATE TABLE workout_laps (
  activity_id        BIGINT REFERENCES workouts(activity_id),
  lap_index          INTEGER,
  distance           REAL,
  duration_seconds   REAL,
  average_speed      REAL,
  average_hr         INTEGER,
  max_hr             INTEGER,
  average_power      INTEGER,
  normalized_power   INTEGER,
  cadence            REAL,
  stride_length      REAL,
  elevation_gain     REAL,
  intensity_type     TEXT,
  start_time_gmt     TIMESTAMP,
  PRIMARY KEY (activity_id, lap_index)
);
```

---

## UI Card Mapping

Each group maps to a UI card/section. Recommended layout:

```
┌─────────────────────────────────────────────────────┐
│ IDENTITY                                             │
│ "Running" · Jerusalem · Jan 27 2026, 12:21 PM        │
│ Activity Type: Running                                │
└─────────────────────────────────────────────────────┘

┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────┐
│ DISTANCE │ │ TIMING   │ │ HEART    │ │ ELEVATION    │
│ 10.01 km │ │ 58:24    │ │ RATE     │ │ ↑ 83m ↓ 80m │
│ 9,402    │ │ moving   │ │ avg 135  │ │ max 784m     │
│ steps    │ │ 58:15    │ │ max 166  │ │ min 727m     │
└──────────┘ └──────────┘ └──────────┘ └──────────────┘

┌─────────────────────────────────────────────────────┐
│ WORKOUT STRUCTURE (visual timeline)                  │
│ ████ warmup (4.8km) ██ active ░ recovery ██ cooldown│
│                                                      │
│ Phase     Distance  Pace    HR    Splits             │
│ Warmup    4,822m    5:58    132   1                  │
│ Active    1,210m    3:58    147   6                  │
│ Recovery  1,055m    7:04    139   5                  │
│ Cooldown  2,929m    5:55    136   1                  │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│ PACE                                                 │
│ Average: 5:50/km · Moving: 5:49/km · Max: 3:35/km  │
│ Grade-Adjusted: 5:48/km                              │
└─────────────────────────────────────────────────────┘

┌──────────────────────┐ ┌────────────────────────────┐
│ POWER                │ │ RUNNING DYNAMICS            │
│ Avg: 329W            │ │ Cadence: 161 spm            │
│ Normalized: 337W     │ │ Stride: 105 cm              │
│ Max: 529W            │ │ GCT: 279 ms                 │
│ Total Work: 276 kJ   │ │ Vert Osc: 9.1 cm           │
└──────────────────────┘ └────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│ TRAINING                                             │
│ Aerobic Effect: 3.4/5 · Anaerobic: 2.0/5            │
│ Label: AEROBIC BASE · Load: 148                      │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│ BODY & RECOVERY                                      │
│ 760 kcal · 973ml water · Body Battery: -15           │
│ Respiration: avg 33 (24-45) breaths/min              │
│ Intensity: 1 min moderate, 71 min vigorous           │
│ Stamina: 100% → 55% (low: 53%)                      │
│ Feel: 50/100 · RPE: 40/100                           │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│ LAPS (table)                                         │
│ #   Distance  Pace     HR   Power  Cadence  Elev    │
│ 1   1,000m    6:01/km  119  344W   166 spm  +22m    │
│ 2   1,000m    5:49/km  126  351W   159 spm  +23m    │
│ 3   1,000m    ...                                    │
│ ...                                                  │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│ META: 15 laps · Not a PR · Not favorited             │
└─────────────────────────────────────────────────────┘
```

---

## Display Formatting Reference

| Raw value | Conversion | Display |
|---|---|---|
| Speed (m/s) → Pace (min/km) | `min = floor(1000/speed/60)`, `sec = round(1000/speed % 60)` | `5:50/km` |
| Duration (seconds) → Time | `hours = floor(s/3600)`, `min = floor(s%3600/60)`, `sec = round(s%60)` | `58:24` or `1:02:15` |
| Distance (meters) → km | `distance / 1000` | `10.01 km` |
| Elevation (meters) | as-is | `↑ 83m ↓ 80m` |
| Heart rate (bpm) | as-is | `135 bpm` |
| Power (watts) | as-is | `329W` |
| Cadence (steps/min) | as-is | `161 spm` |
| Ground contact time (ms) | as-is | `279 ms` |
| Stride length (cm) | as-is | `105 cm` |
| Vertical oscillation (cm) | as-is | `9.1 cm` |
| Calories (kcal) | as-is | `760 kcal` |
| Training effect (0-5) | as-is | `3.4/5.0` |
| Water (ml) | as-is or `/1000` for liters | `973 ml` |
| Body battery (points) | as-is, show sign | `-15` |
| Stamina (%) | as-is | `100% → 55%` |

---

## Handling Empty/Missing Groups

Not all activities have all data. For example:
- **Cycling**: `runningDynamics` will be `{}` (no cadence, GCT, stride)
- **Manual activities**: most groups will be empty
- **No power meter**: `power` will be `{}`
- **No structured workout**: `workoutStructure` will be `[]` or only contain `run`/`walk`/`stand` phases

**Rule: Hide any UI card/section where the group is an empty object `{}` or empty array `[]`.** This way the UI automatically adapts to whatever data the device recorded.

---

## Syncing Multiple Workouts

To backfill or sync a user's workout history, use the activities list endpoint first:

```
POST /garmin/activities
Body: { "username": "...", "tokenJson": {...}, "offset": 0, "limit": 50 }
Response: { "ok": true, "activities": [ { "activityId": 123, ... }, ... ] }
```

Then call `POST /garmin/workout` for each `activityId` to get the full structured data. **Rate limit yourself** — don't hammer Garmin's API. A reasonable approach: fetch 1-2 workouts per second.

---

## Error Handling

| Status | Meaning | Action |
|---|---|---|
| `200` | Success | Store workout + update `tokenJson` |
| `400` | Bad request (missing fields, invalid activityId) | Fix request |
| `401` | Token expired | Re-authenticate via `POST /garmin/connect` with password, get new `tokenJson` |
| `429` | Login cooldown (10 min between password logins) | Wait and retry |
| `500` | Garmin API error | Retry with backoff |

On `401`: call `/garmin/connect` with the user's stored credentials to get fresh tokens, then retry the workout fetch.
