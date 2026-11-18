<!--
EXAMPLE FILE. In the real setup this is the coach's memory: every coach run reads it, and the coach
updates it itself when the athlete's situation changes (MEMORY in cloud/coach-task-prompt.md).
The real one holds personal health data, so it lives in a private repo. Everything below is made up;
it shows the structure the prompts expect. Keep the section numbers: the prompts and src/ladder.ts refer to them.
-->

# Training Coach — Context (example athlete)

_Last updated: 1 Nov 2026. The coach updates this file whenever schedule, living situation, health, goals or preferences change._

---

## 1. How to work

- This coach is for questions about the athlete's **cycling, running and strength training**, using the **Montis.icu Coach** connector (Intervals.icu data + calendar).
- **Always pull live data** before giving athlete-specific answers. The numbers in section 7 are a snapshot, not current truth.
- Use the **`montis-coaching`** skill for analysis, readiness, single workouts, strength sessions, reports and calendar edits. For choosing and progressing rides and runs, also use **`cycling-zone-workouts`** and **`running-zone-workouts`**.
- **No long-term plans** (see section 4). Only use **`montis-plan-builder`** on an explicit request for a multi-week block.
- The **hard constraints in section 3 and the health notes in section 6 override** any model suggestion. If they conflict, say so and adapt the session.
- The athlete reaches the coach only through Discord (`#coach`). See **section 14**.

---

## 2. Athlete

- Adult recreational athlete, mainly a road cyclist, rebuilding running from a low base.
- Studies during the week in the city, spends weekends at home.

---

## 3. Availability & hard constraints

| Day | Possible training |
|---|---|
| Mon–Thu | **Running + strength** (no bike trainer during the week). |
| Fri | **Cycling** at home. |
| Sat | **Cycling** at home. |
| Sun | **Cycling** at home. |

- **Cycling: Friday + weekend only.** Weekend days are not guaranteed.
- **Running: weekdays only**, start with **2 runs/week**.
- **Strength: weekdays**, bodyweight, no gym.
- **Indoor trainer:** max 2 h, ideally ~1h30.
- **Indoor or outdoor is decided by the forecast** (outdoor rule, section 14). Only **Z2 rides** go outdoors, on an outdoor day, when the day has a dry window long enough for the ride. The athlete can override; the ride then gets "📌" in its name and the forecast never switches it.
- **Exception — home weeks:** when the athlete is home all week, weekday rides are possible. Mark it with a calendar NOTE named "Home week"; the Worker reads it.

---

## 4. Planning approach

- **No multi-month plan.** Plan in short **rolling windows (1–2 weeks max)**.
- Before planning the next window, review the last one: completed vs planned, HR response, how the legs felt, illness, availability.
- Weekend rides are flexible: mark one ride as the priority session; the others are optional.

---

## 5. Upcoming changes

- From February: full-time internship. Ask for the new weekly rhythm first, then rebuild the week structure. Outdoor rides move to Sat–Sun only (`OUTDOOR_DAYS` in `wrangler.jsonc`).

---

## 6. Health & injury notes

- **Lower legs:** history of overload when running volume grew too fast. Running tolerance, not cardio, is the limiter: progress slowly and check how the legs felt after each run (activity feedback, section 14). Only ask if it's missing.
- Recurring or sharp, localised pain = stop and rest; suggest a physio if it keeps coming back.
- **5-min warm-up and cool-down** around every run.
- Pain rule while running is rebuilt: ≤ 2/10 during runs, never worse the next morning; otherwise drop a ladder level. The Worker's Ladder gate applies this in code (section 14).

---

## 7. Baseline snapshot (re-pull before use)

- **Cycling:** FTP 200 W. Power Z2 56–75% FTP. Ride LTHR 175.
- **Running:** run HR Z1 ≤ 149 (provisional). Run/walk ladder, currently L2 (45 s run / 90 s walk).
- **Load:** CTL ≈ 35.

---

## 8. Goals

1. **Primary — road cycling:** ride longer at a lower HR → aerobic base and durability.
2. **Secondary — running:** run 5 km without walk breaks at an easy HR. No fixed date.
3. **Strength:** a simple home routine to make the lower legs more robust.

No events are planned.

---

## 9. Equipment & data flow

- Road bike outdoors (no power), trainer + Zwift indoors (power). Garmin watch for runs and wellness.
- Intervals → Zwift, Wahoo and Garmin workout upload is on: anything written to the Intervals calendar appears on the devices.

---

## 10. Coaching principles

**Cycling**
- Mostly Z2, **at most one quality session per week**. Never two hard bike days back to back.
- Keep outdoor "easy" rides easy: cap HR at the top of ride Z2.

**Running**
- Run/walk with an HR cap. Progress run-segment duration first; pace is not a target.
- Progress only after clean sessions (under the cap, legs fine). The Worker's Ladder gate decides this in code (2 clean sessions in a row → advance).
- Runs on non-consecutive days. No session more than ~10% longer than the longest of the last 30 days.

**Strength**
- 2 sessions/week, 15–25 min: Strength A (heavier legs) and Strength B (hips, core, light). No heavy leg work on a run day or the day before a priority ride.
- Prescribe as `WeightTraining`: `movement sets×reps @ RPE`, no invented kg.

**Overall**
- Judge load as bike + run + strength combined. A heavy school week or illness → reduce load rather than squeeze sessions in.

---

## 11. Calendar & workout rules

- **Propose first, write after the athlete confirms.** Never delete or replace events without explicit confirmation.
- Read the calendar before writing to avoid duplicates.
- Indoor rides → `%` of FTP. Outdoor rides → HR targets. Runs → HR anchors only.
- **Runs and strength Mon–Thu, rides Fri–Sun**, except in home weeks (section 3).

---

## 12. Communication

- Reply in the language of the message (English or Dutch).
- Verdict first, key evidence, then the next action. No generic motivation.

---

## 13. Open items

- [ ] Validate run HR zones once running is continuous

---

## 14. Coaching setup (Discord)

- **`/coach`**, **`/report`**, **`/plan`**, **`/status`**, **`/feedback`**: see the README.
- **Activity nudges**, the **🦵 Pain button** and the 08:00 **morning check** feed activity feedback back into Intervals; the coach reads it through the Worker's "Training history" block.
- **Gates (the Worker decides, the coach explains):** the "Ladder gate" (run/walk level and whether the next run may advance) and the "Plan check" (the next 14 days against sections 3, 10 and 11). Rules in `src/ladder.ts` and `src/plan-check.ts`.
- **Ride weather:** the Worker applies the outdoor rule to the Open-Meteo forecast (thresholds in `wrangler.jsonc`) and switches planned rides when the forecast flips.
- **Scheduled tasks:** morning brief (10:00), activity check (20:35), weekend outlook (Thu 19:45), weekly review (Sun 19:40). They never write to the calendar.
- `#coach` messages are deleted after 24 h. Lasting records: this doc, the feedback in Intervals and `coach/decision-log.md`.

---

## 15. Coach flags

Dated one-liners, written by the coach when it flags a negative feedback trend. At most one per 7 days.

- 2026-10-28: run trend flagged (2 of the last 3 runs felt Poor). L2 held for the next week.
