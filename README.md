# Discord coach

> A small personal project, vibe-coded with [Claude Code](https://claude.com/claude-code): a Discord bot that connects me to [Intervals.icu](https://intervals.icu), the training tool where my workouts and training calendar live, with an AI coach in between.

I use it from my phone in a private Discord channel to ask about my training, log how workouts felt and change my plan, for cycling, running and strength.

## Features

- **Ask the coach anything:** `/coach analyse today's ride` or `/coach move Friday's ride to Saturday`. It reads live data from Intervals before it answers, in English or Dutch.
- **Calendar changes behind a ✅ Confirm button.** The coach proposes, and only writes after I tap. The change then syncs to Zwift, Wahoo and Garmin.
- **It remembers:** when my situation changes, the coach updates its own memory file and commits it to git.
- **Instant commands:** `/plan` (upcoming sessions), `/status` (load, sleep, HRV, weather) and `/feedback`, answered by the Worker itself, with no AI involved.
- **Feedback after every workout:** one-tap "how did it feel?" buttons, a notes pop-up that starts an automatic analysis, and a pain button under runs.
- **Daily and weekly posts:** a morning check-in and brief, an evening plan check, a weekend outlook and a weekly review.
- **Weather-aware rides:** easy rides move between indoors and outdoors when the forecast changes.
- **Charts and reports** as images and files.

## How it works

```
Discord  (/coach, buttons, pop-ups)
   │
   ▼
Cloudflare Worker  (TypeScript, free tier)
   - checks Discord's signature and that it's me
   - answers /plan, /status, /feedback straight from Intervals
   - works out the training rules and a training summary
   - cron: workout prompts, check-in, weather and plan checks, cleanup
   │
   ▼
Claude scheduled task
   - reads Intervals data + calendar and the coach memory
   - posts the answer in Discord; writes to the calendar only after ✅
   - commits memory updates and a decision log to the repo
```

**What I found interesting to build:**
- **The model explains, code decides.** Safety rules (when a run may get harder, the +10% volume rule, run days) live in plain TypeScript ([src/ladder.ts](src/ladder.ts), [src/plan-check.ts](src/plan-check.ts)). The coach gets the outcome as a fact to follow.
- **Memory in git.** Every change to the coach's memory is a commit I can review or revert.
- **Human in the loop.** Confirm buttons work once, only for me, and expire after 24 h.
- **No servers to run.** Everything runs on Cloudflare's free tier plus a Claude subscription.

**Stack:** Cloudflare Workers + KV · TypeScript · Discord interactions API · Claude Code scheduled tasks · Intervals.icu API · Open-Meteo · GitHub Actions (typecheck, tests, auto-deploy).

> **Note:** the files in [coach/](coach/) are made-up examples. The real coach memory contains personal health data and lives in a private repo. All IDs in `wrangler.jsonc` are placeholders.

## Run it yourself

<details>
<summary><b>Setup</b> (about 45–60 minutes)</summary>

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

</details>

<details>
<summary><b>Troubleshooting</b></summary>

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

</details>

## Security

- Only requests signed by Discord, from my user ID, are accepted.
- Secrets live in Cloudflare's secret store, not in the code. `.dev.vars` is git-ignored.
- The coach can push to its own repo. The prompt limits it to the two files in `coach/`, and every change is a commit that can be reverted.
- The Worker never writes activity descriptions, because Intervals pushes those to Strava, where they can be public.

## Development

```bash
npm test          # unit tests (Node's built-in runner)
npm run typecheck
npm run dev       # local Worker on http://localhost:8787 (needs .dev.vars)
```

CI runs the typecheck and tests on every push, and deploys `main` when the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repository secrets are set.
