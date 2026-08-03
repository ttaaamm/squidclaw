import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { taskList, taskNodes } from "@squidclaw/memory";

const dir = () => mkdtempSync(join(tmpdir(), "tasks-"));

describe("the human's todo list", () => {
  it("adds, lists open, completes by id", () => {
    const tasks = taskList(dir());
    const a = tasks.add("send the invoice to Al Jood");
    tasks.add("write the Saudi Times post");

    expect(tasks.open()).toHaveLength(2);
    expect(tasks.complete(a.id)?.task).toContain("invoice");
    expect(tasks.open()).toHaveLength(1);
    expect(tasks.all()).toHaveLength(2); // done tasks stay in history
  });

  it("completes by loose words, the way a human refers to things", () => {
    const tasks = taskList(dir());
    tasks.add("send the invoice to Al Jood");
    tasks.add("water the plants");

    expect(tasks.complete("the invoice one".replace("the ", "").replace(" one", ""))?.task).toContain("invoice");
    expect(tasks.complete("nothing like this")).toBeUndefined();
  });

  it("works as the agent's tools", async () => {
    const [add, list, done] = taskNodes(taskList(dir()));

    await add.run({ task: "renew the domain" }, [], { tenantId: "t" });
    const listed = await list.run({}, [], { tenantId: "t" });
    expect(listed[0].json.task).toBe("renew the domain");

    const completed = await done.run({ task: "domain" }, [], { tenantId: "t" });
    expect(completed[0].json.completed).toBe(true);
    expect((await list.run({}, [], { tenantId: "t" }))[0].json.empty).toBe(true);
  });
});
