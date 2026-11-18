// Generates cloud/setup-script.sh from cloud/discord-post. Paste the result into the "Discord coach"
// cloud environment afterwards (README step 3.1).
// Run: npm run setup-script

import { readFileSync, writeFileSync } from "node:fs";

const helper = readFileSync(new URL("../cloud/discord-post", import.meta.url), "utf8").trimEnd();

const script = `#!/bin/bash
# Setup script for the "Discord coach" cloud environment (claude.ai/code → environment → Setup script).
# Installs the \`discord-post\` helper the coach task uses to post in Discord, and matplotlib for charts.
# Generated from cloud/discord-post by \`npm run setup-script\`: edit that file, not this one.
set -e
cat > /usr/local/bin/discord-post <<'DISCORD_POST_EOF'
${helper}
DISCORD_POST_EOF
chmod +x /usr/local/bin/discord-post
echo "discord-post installed"
# Charts are optional: a failed install must not stop the coach.
python3 -m pip install --quiet matplotlib || python3 -m pip install --quiet --break-system-packages matplotlib || echo "matplotlib not installed"
`;

writeFileSync(new URL("../cloud/setup-script.sh", import.meta.url), script);
console.log("Wrote cloud/setup-script.sh");
