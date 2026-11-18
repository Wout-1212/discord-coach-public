// Creates the "Coach" webhook in #coach through the bot, so the webhook is owned by the app.
// Only app-owned webhooks can post buttons (✅ Confirm under proposals, feel buttons on nudges);
// a webhook made in Discord's channel settings can't.
// Run once: npm run webhook   (reads DISCORD_BOT_TOKEN and COACH_CHANNEL_ID from .dev.vars)
// Needs the bot to have "Manage Webhooks" in #coach (README step 2.5).

const { DISCORD_BOT_TOKEN, COACH_CHANNEL_ID } = process.env;

const missing = Object.entries({ DISCORD_BOT_TOKEN, COACH_CHANNEL_ID })
  .filter(([, value]) => !value)
  .map(([name]) => name);
if (missing.length) {
  console.error(`Missing in .dev.vars: ${missing.join(", ")}`);
  process.exit(1);
}

const res = await fetch(`https://discord.com/api/v10/channels/${COACH_CHANNEL_ID}/webhooks`, {
  method: "POST",
  headers: {
    Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ name: "Coach" }),
});

if (!res.ok) {
  const hint = res.status === 403 ? "\nGive the Coach app 'Manage Webhooks' in #coach first (README step 2.5)." : "";
  console.error(`Creating the webhook failed: HTTP ${res.status}\n${await res.text()}${hint}`);
  process.exit(1);
}
const webhook = await res.json();
console.log(`Created webhook "${webhook.name}" (app-owned: ${webhook.application_id ? "yes" : "no"}).`);
console.log("\nWebhook URL (secret, shown once here):");
console.log(`https://discord.com/api/webhooks/${webhook.id}/${webhook.token}`);
console.log("\nPut it in: the cloud environment's DISCORD_WEBHOOK_URL, and `npx wrangler secret put DISCORD_WEBHOOK_URL`.");
