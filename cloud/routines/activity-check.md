SCHEDULED TASK — ACTIVITY CHECK (daily, ~20:35)

Read-only: never write to the calendar in this run. Activities usually get analysed right after Wout's feedback (`activity-analysis.md`). The Worker only starts this check for the ones that weren't, and lists them under "Activities to cover" in the request.

- Cover the activities in that list. Skip one that a Coach reply in the channel history already analysed.
- For each activity, start from its line in "Plan vs actual" (Training history block) and give:
  - a one-line verdict from that comparison (as planned / easier / harder / cut short / swapped). No praise without it; a swap is never a miss;
  - 2–4 key numbers:
    - Runs: HR in the run segments vs the cap, time above cap, total run time, longest continuous run segment.
    - Rides: duration, NP/avg power vs targets (indoor), avg HR, and for steady Z2 rides the decoupling and efficiency factor.
    - Strength: completed or not, and any notes.
  - the next step. Runs: the Ladder gate decides (GATES in the main prompt); say what tomorrow's morning check will decide.
- Use Wout's feedback on the activity (feel, RPE, and the notes in the block's "Feedback notes" and "Pain reports" lines; see ANSWERING in the main prompt). If an activity has none, end with: "How did it feel? Log it with `/feedback`."
- Then check FEEDBACK TREND in the main prompt, also when every new activity was already analysed.

OUTPUT
Start with "📊 **Activity check**". Verdict first, at most ~10 lines per activity. If nothing new is left after all and there's no trend to flag, post nothing and stop: the Worker doesn't wait for an answer to this task. A trend goes at the end, in a few lines. Post with `discord-post`, or `discord-post --confirm` if it contains a proposal.
