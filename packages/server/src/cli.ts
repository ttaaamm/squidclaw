import { join } from "node:path";
import { Journal } from "@squidclaw/kernel";

const WORKSPACE = process.env.SQUIDCLAW_WORKSPACE ?? join(process.cwd(), "workspace");
const journal = new Journal(join(WORKSPACE, "journal", "executions.db"));

const [cmd, arg] = process.argv.slice(2);

if (cmd === "list") {
  for (const e of journal.list({ limit: 20 })) {
    console.log(
      `${e.id}  ${e.status.padEnd(7)} ${e.kind.padEnd(10)} steps=${e.steps.length}  ${e.startedAt}  [${e.tenantId}]`,
    );
  }
} else if (cmd === "show" && arg) {
  const e = journal.get(arg);
  if (!e) {
    console.error("not found");
    process.exit(1);
  }
  console.log(JSON.stringify(e, null, 2));
} else {
  console.log("usage: npm run journal -- list | show <executionId>");
}
