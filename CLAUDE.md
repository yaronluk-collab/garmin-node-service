# Garmin Node Service

## Project Overview
Node.js/Express service that wraps the unofficial `@flow-js/garmin-connect` library (v1.6.7) to expose Garmin Connect data via REST endpoints. Designed to be consumed by a Base44 agent.

## Architecture
- **Single file server**: `server.js` — all endpoints, helpers, and middleware live here.
- **Auth middleware**: `requireApiKey` — every endpoint requires `Authorization: Bearer <API_KEY>`.
- **Token flow**: Most endpoints use `withGarminToken(req, res, actionFn)` — validates `username` + `tokenJson` from the request body, runs the action, and always returns refreshed `tokenJson` in the response. The Base44 agent must store and round-trip `tokenJson` on every call.

## Authentication Model
- **No real OAuth handshake.** The library only supports password-based login (`client.login(username, password)`). Internally it exchanges credentials for OAuth1 + OAuth2 tokens, but this is fully automated and not exposed.
- `/garmin/connect` accepts username+password OR pre-existing tokenJson. There is no redirect/callback flow.
- To get a real OAuth flow, we'd need to join the Garmin Connect Developer Program (partnership agreement required).

## Existing Endpoints

| Endpoint | Method | Purpose |
|---|---|---|
| `/health` | GET | Health check |
| `/garmin/connect` | POST | Login (password or token validation) |
| `/garmin/profile` | POST | User profile |
| `/garmin/user-settings` | POST | User settings |
| `/garmin/athlete-profile` | POST | Athlete/training profile (supports `profile`: `"full"`, `"coaching"`, `"summary"`) |
| `/garmin/activities` | POST | List activities |
| `/garmin/activity` | POST | Single activity details |
| `/garmin/splits` | POST | Activity splits/laps/details |
| `/garmin/workout` | POST | Get workout detail |
| `/garmin/workout/create` | POST | Create a workout |

## Library Methods Available But Not Yet Exposed
These exist in `@flow-js/garmin-connect` but have no server.js endpoint yet:
- `deleteWorkout({ workoutId: string })` — deletes a workout
- `scheduleWorkout({ workoutId: string }, date)` — schedules a workout to a calendar date
- `deleteActivity({ activityId: string })` — deletes an activity
- `getWorkouts(start, limit)` — list workouts (we have getWorkoutDetail but not the list)

## Base44 Integration Notes
- All requests require `Authorization: Bearer <API_KEY>` header and `Content-Type: application/json`.
- Request body always includes `username` (or `email`) and `tokenJson`.
- Response always includes `ok: boolean` and, on success, a refreshed `tokenJson` that must be saved for the next call.
- On 401, the user needs to re-authenticate via `/garmin/connect`.

## `/garmin/athlete-profile` Details
- Added to provide training-relevant athlete data (weight, VO2max, lactate threshold, training schedule, sleep/wake times, etc.).
- Accepts optional `profile` field: `"full"` (default, all fields), `"coaching"` (training-relevant subset), `"summary"` (basics only).
- Fields like `weightKg`, `age`, `sleepTime`/`wakeTime` are computed/converted from Garmin's raw format.
- Any field can be `null` if the athlete hasn't configured it in Garmin Connect.
