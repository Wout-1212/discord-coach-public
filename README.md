# Discord coach

> A small personal project, vibe-coded with [Claude Code](https://claude.com/claude-code): my own AI training coach for cycling, running and strength, which I talk to from Discord on my phone.

**What it is:** a Cloudflare Worker (TypeScript) that turns Discord slash commands and buttons into runs of a Claude scheduled task. The task reads my training data and calendar from [Intervals.icu](https://intervals.icu), answers in the channel, and changes the calendar only after I tap ✅ Confirm. Next to that, the Worker posts on a schedule: workout feedback prompts, a morning check-in, weather-based indoor/outdoor switches and plan checks.

**What I found interesting to build:**
- **The model explains, code decides.** Safety rules (when a run may get harder, the +10% volume rule, run days) are worked out in plain TypeScript ([src/ladder.ts](src/ladder.ts), [src/plan-check.ts](src/plan-check.ts)), and the coach is told to follow them, not to work them out itself.
- **Memory in git.** The coach keeps its own memory in a Markdown file and commits changes to it, so every change shows up as a diff I can review or revert. An append-only decision log records why the plan changed and whether that worked out.
- **Human in the loop.** Calendar writes only happen after a one-time, owner-only, 24 h confirm button.
- **No servers to run.** Discord interactions, cron jobs and KV state all run on Cloudflare's free tier, and the AI part runs on a Claude subscription.

**Stack:** Cloudflare Workers + KV · TypeScript · Discord interactions API (Ed25519 signature checks, buttons, modals) · Claude Code scheduled tasks · Intervals.icu API · Open-Meteo · GitHub Actions (typecheck, ~20 test files with Node's built-in runner, auto-deploy).

> **Note:** the files in [coach/](coach/) are made-up examples. The real coach memory contains personal health data and lives in a private repo. All IDs in `wrangler.jsonc` are placeholders.

---

Ask your training coach from Discord, with your laptop closed:

```
/coach analyse today's ride
/coach move Friday's ride to Saturday     → Coach proposes → tap ✅ Confirm → done
/coach I'm home next week                 → Coach updates its memory: "📌 Saved: …"
/coach chart my CTL for the last 3 months → the chart as an image
/report type:Weekly                       → a Montis report, long ones as a file
/plan tomorrow                            → instant, straight from Intervals
/status                                   → instant: load, last night, ride weather
```

After a workout syncs, an "Intervals" post asks how it felt: one tap saves it, and "📝 RPE + note" opens a pop-up. Sending that pop-up (or `/feedback` for an activity from today or yesterday) starts the coach's analysis of the activity with your feedback; it posts a "🔍" reply about a minute later. Runs also get a "🦵 Pain" button, for when you want to report pain; nothing asks about it. A pain report sent after the analysis gets a short follow-up. When three of your last five sessions went badly, the coach says so and proposes a change or asks you about it.

Every coach run gets a "Training history" block worked out by the Worker:
- how fresh the data is (a Garmin sync gap shows as "missing", not as old numbers);
- this morning's check-in;
- two decisions the coach must follow:
  - the **Ladder gate**: your run/walk level and whether the next run may advance, must hold or drops a level;
  - the **Plan check**: the next 14 days against your hard rules;
- plan vs actual for the last 7 days;
- your longest recent run and its +10% line, the running time of your last runs;
- your notes and pain reports;
- comparable indoor Z2 rides, HRV and resting HR against their usual range, and data problems.

It only reads Intervals' numbers: no scores of its own. When you ask for more than a gate allows, the coach says no and tells you what would unlock it.

At 08:00 a "Check-in" post asks how you feel and, after a run, how your legs are: one tap each, and the 10:00 brief uses it.

The coach plans rides indoors or outdoors from the forecast, and when the forecast for a planned ride changes, a "Weather" post appears and the coach switches it (only Z2 rides go outdoors, Fri–Sun or in a "Home week").

## How it works

```
Discord  /coach <message>
   │
   ▼
Cloudflare Worker (this repo, free, always on)
   1. checks Discord's signature and that the sender is you
   2. replies instantly with your question + "Coach is on it"
   3. reads the last ~20 channel messages (context for follow-ups)
   4. starts the "Discord coach" scheduled task via its API trigger
   5. adds the cloud session link under your question
   │
   ▼
Claude scheduled task (Anthropic cloud, your Pro subscription)
   - Montis connector (Intervals data + calendar), context doc from this repo, skills
   - answers, or proposes a calendar change with ✅ Confirm / Cancel buttons and
     only writes after ✅ (or "/coach yes")
   - when your situation changes, updates coach/training-coach-context.md and
     pushes it to main (its memory; no deploy needed, the next run reads it)
   - notes why the plan changed in coach/decision-log.md, and how that worked out
   - posts the answer to the channel with `discord-post` (webhook), with charts or
     long reports attached

✅ Confirm  → the Worker starts the task again with that exact proposal quoted.
Cancel      → marked cancelled, nothing runs.

Discord  /feedback feel rpe notes [activity]
   → the Worker saves it on the activity in Intervals (feel and RPE in their fields,
     notes as a message under the activity: never in the description, which Intervals
     pushes to Strava) right away. For an activity from today or yesterday it then starts
     the coach's analysis of it ("Automated activity analysis", cloud/routines/).

📝 pop-up under an "Intervals" post
   → saved the same way, then the same analysis. Once per activity (KV); a 🦵 pain
     report after it starts one "pain follow-up". A feel tap alone starts nothing.

Discord  /plan [day]
   → the Worker reads the Intervals calendar and answers in a second; no Claude run.

Discord  /status
   → the Worker reads Intervals wellness + the forecast and answers in a second; no Claude run.

Discord  /report type
   → a /coach run with a fixed request: the matching Montis report.

Cron (every 5 min, Worker)
   - watchdog: no Coach answer 10 min after a /coach → ⚠️ warning with the session link
   - every 15 min, 07:00–22:00: new activity without feedback → "Intervals" post
     with feel buttons (Strong … Weak) and a note pop-up; both save on the activity
   - every hour: delete #coach messages older than 24 h (pinned ones are kept)
   - 08:00: "Check-in" post (feel → Intervals wellness fatigue; legs after a run → a
     "Next morning" message on that run, read by the ladder gate)
   - 19:05: plan check of the next 14 days; a "⚠️ Plan check" post for each new problem
   - scheduled tasks: morning brief (10:00, after your watch has synced), activity check
     (20:35, only for activities of today and yesterday that got no analysis after feedback, and silent when there's nothing to report), weekend outlook (Thu 19:45), weekly review (Sun 19:40, stays pinned).
     The Worker starts the coach with "Automated <task>"; the instructions are in
     cloud/routines/ and the answer is posted in #coach like any other.
   - 06:30 and 19:00: ride weather check. Planned rides of the next 3 days vs the
     Open-Meteo forecast; when one flips (outdoor ↔ indoor) → "Weather" post + a coach
     run that switches it right away (no ✅ needed). Silent when nothing changed.
   - a background job that fails: a ⚠️ "System" post, once until it works again (weather
     check and scheduled tasks right away, the others after 3 failures in a row).

Ride weather (Worker, Open-Meteo, free, no key)
   - every coach run gets a 7-day block: per day ✅ outdoor with its window, or 🏠
     indoor with the reason. The outdoor rule (feels-like, wind, dry window, location)
     is set in wrangler.jsonc vars.
```

| Part | Where | File |
|---|---|---|
| Worker | Cloudflare | `src/` |
| Slash commands | Discord | `scripts/register-commands.mjs` |
| App-owned webhook (needed for buttons) | Discord | `scripts/create-webhook.mjs` |
| Worker state (pending runs, nudged activities, weather flags) | Cloudflare KV `STATE` | `wrangler.jsonc` |
| Scheduled tasks (morning brief, activity check, weekend outlook, weekly review) | Worker cron → coach task | `src/scheduled.ts` (times), `cloud/routines/` (instructions) |
| Outdoor rule + ride location | Worker vars | `wrangler.jsonc` (`OUTDOOR_*`, `WEATHER_*`) |
| Tests + auto-deploy | GitHub Actions | `.github/workflows/ci.yml` |
| Task prompt | this repo (the routine's saved prompt only points to it) | `cloud/coach-task-prompt.md`, saved stub: `cloud/routine-prompt.md` |
| Coach memory (the only copy; the coach commits to it) | this repo | `coach/training-coach-context.md` |
| Decision log (append-only; the coach commits to it) | this repo | `coach/decision-log.md` |
| Training history block (read from Intervals on every run, not stored) | Worker | `src/history.ts` |
| `discord-post` helper + matplotlib | cloud environment setup script | `cloud/setup-script.sh` (generated from `cloud/discord-post` by `npm run setup-script`) |

**Limits:** every message starts a new cloud session (about 20 s to 1.5 min per answer; answers arrive whole, not word by word). A follow-up only sees the last ~20 channel messages + the context doc, and each message uses your Claude usage. The API trigger is a research preview and may change.

The coach commits to `main`, so run `git pull` before working locally.

---

## Setup (about 45–60 minutes)

You need: Node 22+, a free [Cloudflare account](https://dash.cloudflare.com/sign-up), and Discord.

Keep a notes file open: you'll collect 9 values along the way.

| Value | Where it goes |
|---|---|
| Webhook URL (secret, step 6) | Claude cloud environment + `wrangler secret` |
| Application ID | `wrangler.jsonc` + `.dev.vars` |
| Public Key | `wrangler.jsonc` |
| Bot token (secret) | `wrangler secret` + `.dev.vars` |
| Your user ID | `wrangler.jsonc` |
| Server ID | `.dev.vars` |
| Channel ID | `wrangler.jsonc` |
| Task API token (secret) | `wrangler secret` |
| Intervals API key (secret) | `wrangler secret` |

### 1. Discord: server and channel

1. Create a private server (**+** in the server list → *Create My Own* → *For me and my friends*), e.g. "Training".
2. Create a text channel `#coach`.
3. Don't create a webhook in the channel settings: step 6 creates it through the bot, because only a webhook owned by the app can show buttons.
4. Turn on Developer Mode: User Settings → **Advanced** → **Developer Mode**.
   - Right-click your own name → **Copy User ID**. → *Your user ID*
   - Right-click the server icon → **Copy Server ID**. → *Server ID*
   - Right-click `#coach` → **Copy Channel ID**. → *Channel ID* (for the daily cleanup)

### 2. Discord: the app (bot)

1. Go to <https://discord.com/developers/applications> → **New Application** → name it "Coach".
2. **General Information**: copy **Application ID** and **Public Key**.
3. **Bot** tab:
   - **Reset Token** → copy it. → *Bot token* (shown once; keep it secret)
   - Under *Privileged Gateway Intents*, turn on **Message Content Intent** and save. Without it the Worker can't read the Coach's earlier replies, so follow-ups like "yes" lose their context.
4. Invite the bot to your server (replace `APP_ID`):

   ```
   https://discord.com/oauth2/authorize?client_id=APP_ID&scope=bot+applications.commands&permissions=66560
   ```

   (66560 = View Channel + Read Message History; the bot can't post or moderate.)
5. Give the bot two extra permissions in `#coach` only: `#coach` → ⚙️ **Edit Channel** → **Permissions** → **Add members or roles** → *Coach* → turn on **Manage Webhooks** (to create the Coach webhook in step 6) **Manage Messages** (for the cleanup; skip it if you don't want that) and **Pin Messages** (keeps the weekly review pinned) → save.

### 3. Claude: cloud environment + the scheduled task

1. Go to <https://claude.ai/code> → environment selector (cloud icon above the message box) → **Add cloud environment**:
   - **Name:** `Discord coach`
   - **Network access:** **Custom**, allowed domains:
     ```
     discord.com
     ```
     Tick *Also include default list of common package managers*.
   - **Environment variables:**
     ```
     DISCORD_WEBHOOK_URL=<webhook URL from step 6>
     ```
     (Fill it in after step 6; you can edit the environment later.)
     (Anyone who uses this environment can read it. It's only you, but don't add other secrets here.)
   - **Setup script:** paste the full contents of `cloud/setup-script.sh`.
   - **Create environment.**
2. Create the task at <https://claude.ai/code/routines> → **New task** (if asked: *Set up manually*). Don't create it from inside the claude.ai project: project tasks can't get an API trigger or an environment.
   - **Name:** `Discord coach`
   - **Instructions / prompt:** paste the contents of `cloud/routine-prompt.md` (a short pointer: the real prompt is `cloud/coach-task-prompt.md` in the repo, so prompt changes only need a push). Model: Sonnet 5.5, Effort: Medium (the Default model has no effort setting; lower effort means faster answers).
   - **Trigger:** select **API** (remove the schedule if one was added by default).
   - **Advanced settings → General → Repository:** your copy of this repo, kept **private** because the coach writes your health notes to it (the task reads `coach/training-coach-context.md` from it). Then **Cloud environment:** `Discord coach`.
   - **Advanced settings → Connectors:** **Montis ICU Coach** must be included. Others can stay or go.
   - **Create.** The **API token** dialog appears once: copy the token. → *Task API token*
   - On the task's page, copy the **Fire URL**. The part that starts with `trig_` is your task ID. → put it in `wrangler.jsonc` as `CLAUDE_TASK_ID`.

### 4. Cloudflare: deploy the Worker

Open this folder in VS Code, then in the terminal:

```bash
npm install
npx wrangler login              # opens the browser once
```

Fill in `wrangler.jsonc` → `vars`: `DISCORD_APPLICATION_ID`, `DISCORD_PUBLIC_KEY`, `ALLOWED_USER_ID`, `CLAUDE_TASK_ID` (from step 3.2) and `COACH_CHANNEL_ID`.

```bash
npm run deploy                          # first time: pick a workers.dev subdomain
npx wrangler secret put DISCORD_BOT_TOKEN    # paste the bot token
npx wrangler secret put CLAUDE_TASK_TOKEN    # paste the task API token
npx wrangler secret put INTERVALS_API_KEY    # intervals.icu → Settings → Developer Settings → API key
```

`wrangler.jsonc` binds a KV namespace `STATE` (pending runs for the watchdog, nudged activities, button taps). On a new Cloudflare account, create your own with `npx wrangler kv namespace create discord-coach-state` and put its `id` in `kv_namespaces`.

The deploy prints your URL, e.g. `https://discord-coach.<you>.workers.dev`. Opening it in a browser should say *discord-coach is running*.

### 5. Discord: point the app at the Worker

1. Developer Portal → your app → **General Information** → **Interactions Endpoint URL**:
   ```
   https://discord-coach.<you>.workers.dev/interactions
   ```
2. **Save Changes.** Discord immediately sends a test request. If it saves, the signature check works. If it fails, `DISCORD_PUBLIC_KEY` is wrong or the deploy didn't finish.

### 6. Register the commands and create the webhook

```bash
cp .dev.vars.example .dev.vars    # fill in APPLICATION_ID, BOT_TOKEN, GUILD_ID (= Server ID), COACH_CHANNEL_ID
npm run register                  # → Registered: /coach, /feedback, /plan, /report, /status in server …
npm run webhook                   # → prints the Coach webhook URL (app-owned: yes)
npx wrangler secret put DISCORD_WEBHOOK_URL    # paste that URL (activity nudges, watchdog)
```

Then put the same URL in the cloud environment (step 3.1, **Environment variables**) as `DISCORD_WEBHOOK_URL`.

### 7. Test

In `#coach`:

1. `/coach hi, what's on my calendar today?`
   → your question appears immediately with "🧠 Coach is on it". The answer follows in about a minute from **Coach**.
2. `/coach move tomorrow's session to the day after` → a proposal with ✅ Confirm / Cancel buttons.
3. Tap ✅ Confirm (or `/coach yes`) → it's changed in Intervals (and on Zwift/Wahoo/Garmin).
4. `/feedback feel:2 · Good rpe:6 notes:legs fine` → "📝 Feedback saved on …" within a few seconds, and the activity in Intervals shows the feel, RPE and note. Use the `activity` option to pick another activity than the most recent one.
5. `/plan`, `/plan day:Next 7 days`, `/status` → an answer within a second.
6. After your next workout syncs (07:00–22:00), an "Intervals" post appears within 15 min with feel buttons. After a run it also has a 🦵 Pain button.
7. `/coach remember my new bike computer is a Wahoo Bolt` → "📌 Saved: …", and a commit on `main` that only touches `coach/training-coach-context.md`. Then `/coach forget that`.
8. `/coach chart my CTL for the last 3 months` → an image. `/report type:Weekly` → the report.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Saving the Interactions Endpoint URL fails | Wrong `DISCORD_PUBLIC_KEY`, or the URL is missing `/interactions`. Check with `npm run tail` while saving. |
| "This coach is private." | `ALLOWED_USER_ID` isn't your user ID. |
| "⚠️ Couldn't start the coach (…)" | The message says what's wrong: 401 = token (re-generate it, `wrangler secret put CLAUDE_TASK_TOKEN`), 404 = task ID, 429 = hourly limit. |
| A proposal has no buttons | The cloud environment still uses a webhook made in the channel settings. Run `npm run webhook` (step 6) and put the new URL in the environment; delete the old webhook. |
| No "Intervals" posts after a workout | Needs `DISCORD_WEBHOOK_URL` as a Worker secret, the `STATE` KV binding and the Intervals key. Nothing is posted 22:00–07:00 or for activities that already have feel/RPE. Check `npm run tail` at :00/:15/:30/:45. |
| Ack appears, but no answer after 5 min | Open the run at claude.ai/code/routines → the task → latest run. Usually `discord-post` failed: check `DISCORD_WEBHOOK_URL`, the `discord.com` allowed domain, and that the task uses the `Discord coach` environment. If posting fails, the run shows the answer in the session instead. |
| Follow-ups ("yes") don't work | Message Content Intent is off, or the bot can't read `#coach` (re-invite with the URL in step 2). |
| `/coach` doesn't appear | Run `npm run register` again; restart Discord. |
| `/feedback` says the key was rejected, or the activity list is empty | `npx wrangler secret put INTERVALS_API_KEY` again; check `INTERVALS_ATHLETE_ID` in `wrangler.jsonc`. The list only shows the last 7 days. |
| "📌" says NOT saved, or the push fails | The run couldn't push to `main`. Check the run's log and any branch protection on `main`. |
| No chart, only numbers | matplotlib is missing: paste `cloud/setup-script.sh` into the environment again. |
| "⚠️ The … job failed" | The message has the error. HTTP 401/403 from Intervals = `npx wrangler secret put INTERVALS_API_KEY`. A failed weather check or scheduled task isn't retried until its next time. |
| Old messages aren't deleted | `npm run tail` at the top of the hour. `HTTP 403` = the bot lacks **Manage Messages** in `#coach` (step 2.5); nothing logged = `COACH_CHANNEL_ID` is still the placeholder. |

Live logs: `npm run tail`.

## Security

- Only requests signed by Discord are accepted, and only from your user ID.
- Secrets (`DISCORD_BOT_TOKEN`, `CLAUDE_TASK_TOKEN`, `INTERVALS_API_KEY`, `DISCORD_WEBHOOK_URL`) live in Cloudflare's secret store, not in the code. `.dev.vars` is git-ignored. The Intervals key gives full access to your Intervals account; the Worker only uses it to read activities, the calendar and wellness, to set feel, RPE and the morning-check fatigue, and to add messages under activities (your notes). It never writes descriptions: Intervals pushes those to Strava, where they can be public.
- The task token can only start this one task. It can't read your account.
- Calendar writes happen only after an explicit ✅ Confirm or `/coach yes` on a concrete proposal. Buttons only work for your user ID, only once, and only for 24 h.
- The coach can push to this repo. The prompt limits it to `coach/training-coach-context.md` and `coach/decision-log.md`, but that's an instruction, not an enforced permission. Every change is a commit you can see and revert.
- The webhook URL lets anyone who has it post in `#coach` (not read). It's in the cloud environment and in Cloudflare's secret store.
- If a token leaks: regenerate it (Discord: Reset Token; Claude: Generate token on the API trigger) and run `wrangler secret put` again.

## Development

```bash
npm test          # unit tests (Node's built-in runner)
npm run typecheck
npm run dev       # local Worker on http://localhost:8787 (needs .dev.vars)
```

After editing `cloud/discord-post`, run `npm run setup-script` and paste `cloud/setup-script.sh` into the environment again. Its tests need `python3`: they're skipped where it's missing and run in CI.

GitHub Actions (`.github/workflows/ci.yml`) runs the typecheck and tests on every push, and deploys `main` when the repository secrets `CLOUDFLARE_API_TOKEN` (template "Edit Cloudflare Workers") and `CLOUDFLARE_ACCOUNT_ID` are set. Without them it only tests.
