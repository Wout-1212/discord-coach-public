// Registers the /coach, /feedback, /plan, /report and /status slash commands in your private server (guild command = available instantly).
// Run: npm run register   (reads DISCORD_APPLICATION_ID, DISCORD_BOT_TOKEN, DISCORD_GUILD_ID from .dev.vars)

const { DISCORD_APPLICATION_ID, DISCORD_BOT_TOKEN, DISCORD_GUILD_ID } = process.env;

const missing = Object.entries({ DISCORD_APPLICATION_ID, DISCORD_BOT_TOKEN, DISCORD_GUILD_ID })
  .filter(([, value]) => !value)
  .map(([name]) => name);
if (missing.length) {
  console.error(`Missing in .dev.vars: ${missing.join(", ")}`);
  process.exit(1);
}

const commands = [
  {
    name: "coach",
    description: "Ask your training coach (analysis, plans, calendar changes)",
    type: 1, // CHAT_INPUT (slash command)
    options: [
      {
        type: 3, // STRING
        name: "message",
        description: "What do you want to know or change?",
        required: true,
        max_length: 1500,
      },
    ],
  },
  {
    name: "feedback",
    description: "Log how an activity went and felt (saved on the activity in Intervals)",
    type: 1,
    options: [
      {
        type: 4, // INTEGER, Intervals' feel scale
        name: "feel",
        description: "How did you feel?",
        choices: ["Strong", "Good", "Normal", "Poor", "Weak"].map((name, i) => ({
          name: `${i + 1} · ${name}`,
          value: i + 1,
        })),
      },
      {
        type: 4,
        name: "rpe",
        description: "Effort: 1 (very easy) to 10 (max)",
        min_value: 1,
        max_value: 10,
      },
      {
        type: 3,
        name: "notes",
        description: "Anything else: legs, energy, pain, conditions…",
        max_length: 1000,
      },
      {
        type: 3,
        name: "activity",
        description: "Which activity (default: the most recent one)",
        autocomplete: true,
      },
    ],
  },
  {
    name: "plan",
    description: "What's planned (instant, straight from Intervals)",
    type: 1,
    options: [
      {
        type: 3,
        name: "day",
        description: "Which day (default: today)",
        choices: [
          { name: "Today", value: "today" },
          { name: "Tomorrow", value: "tomorrow" },
          { name: "Next 7 days", value: "week" },
          ...["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"].map((name) => ({
            name,
            value: name.slice(0, 3).toLowerCase(),
          })),
        ],
      },
    ],
  },
  {
    name: "report",
    description: "A training report from the coach (long ones come as a file)",
    type: 1,
    options: [
      {
        type: 3,
        name: "type",
        description: "Which report",
        required: true,
        choices: [
          { name: "Weekly", value: "weekly" },
          { name: "Season", value: "season" },
          { name: "Wellness", value: "wellness" },
          { name: "Summary", value: "summary" },
        ],
      },
    ],
  },
  {
    name: "status",
    description: "Load, last night's recovery and ride weather (instant, no coach run)",
    type: 1,
  },
];

// PUT replaces all guild commands of this app with the list above.
const res = await fetch(
  `https://discord.com/api/v10/applications/${DISCORD_APPLICATION_ID}/guilds/${DISCORD_GUILD_ID}/commands`,
  {
    method: "PUT",
    headers: {
      Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(commands),
  },
);

if (!res.ok) {
  console.error(`Registering failed: HTTP ${res.status}\n${await res.text()}`);
  process.exit(1);
}
const registered = await res.json();
console.log(`Registered: ${registered.map((c) => `/${c.name}`).join(", ")} in server ${DISCORD_GUILD_ID}`);
