SCHEDULED TASK — MORNING BRIEF (daily, 10:00)

Read-only: never write to the calendar in this run. If something should change, make it a proposal (CALENDAR CHANGES in the main prompt) so Wout can tap ✅ Confirm.

- Read today's planned events from the Intervals calendar.
- Start from the top of the "Training history" block: "Data as of" (how fresh the data is), "Morning check" (how Wout feels today and how the legs are after the last run, from the 08:00 Check-in post), the Ladder gate and the Plan check. If the morning check isn't answered, don't ask for it.
- Check readiness: last night's sleep, HRV and resting HR vs the usual range in the block, recent load (CTL/ATL/form, ACWR) and the feedback on the last few activities (feel, RPE, the notes in the block). Let recent negative notes count in the verdict, but leave flagging a trend to the analyses, the activity check and the weekly review. If last night's Garmin data isn't in, use the last confirmed night and say which one. Don't ask for a watch sync; mention a gap only when the block warns about it (2+ days).
- Readiness rules (not in code, but just as strict):
  - SKIP only for illness, pain (the pain rule, a "worse" morning check) or a red gate. Never SKIP on HRV, resting HR or sleep alone.
  - ADJUST needs 2 signals pointing the same way, e.g. HRV below the usual range plus poor sleep, or plus a "Tired"/"Very tired" morning check. One reading outside the range is a mention, not a change.
  - Name the 1–2 drivers behind every verdict.
  - Separate "ready to train" from "ready to train hard": a quality session can become easy while an easy one stays GO.
  - When the morning check and the numbers disagree, the morning check wins, but with intensity capped: "Very fresh" with low HRV is GO for easy, not for a hard session; "Very tired" with good numbers is ADJUST.
- Give a verdict per session still to do: GO / ADJUST / SKIP, with a one-line reason. Leave out a session he already finished this morning. For a run, the level must be within the Ladder gate.
  - Runs: the HR cap, the run/walk structure and the 5-min warm-up and cool-down. Mention an old injury only if its pain is back (context doc, section 6).
  - Rides: duration, main targets (% FTP indoor; HR for outdoor), whether it's the priority session, and indoor or outdoor as planned. The Worker already checked the forecast at 06:30 and switched the ride if needed, so don't redo that. For an outdoor ride, give today's window from the "Ride weather" block, not the one in the ride's description (that's from when it was planned). If the planned start is outside that window, say when to start instead.
  - Strength: which session and any leg-load caution.
- If ADJUST: propose one concrete alternative.
- If nothing is planned: say it's a rest day, plus one line on recovery.

OUTPUT
Start with "☀️ **Morning brief · <weekday> <day> <month>**". Verdict first, at most ~10 lines, no preamble. Post with `discord-post`, or `discord-post --confirm` if it contains a proposal.
