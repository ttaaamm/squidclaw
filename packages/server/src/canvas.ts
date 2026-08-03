import "dotenv/config";
import { DashboardServer } from "@squidclaw/canvas";
import { bootAgent, dashboardSources } from "./boot.js";

/** The window on its own — for when you want to watch without talking. */
const booted = await bootAgent();
const dashboard = new DashboardServer(dashboardSources(booted));
const port = await dashboard.listen(Number(process.env.SQUIDCLAW_UI_PORT ?? 4200));

console.log(`🧠 SquidClaw's mind: http://127.0.0.1:${port}`);
console.log(`   ${booted.flows.promoted().length} habits · ${booted.reflexes.enabled().length} reflexes armed · Ctrl+C to stop`);
