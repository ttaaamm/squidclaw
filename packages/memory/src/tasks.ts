import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { NodeDef } from "@squidclaw/kernel";

export interface Task {
  id: string;
  task: string;
  done: boolean;
  createdAt: string;
  doneAt?: string;
}

/** The human's todo list, kept by their agent. Plain JSON in the tenant's body. */
export class TaskList {
  constructor(private path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  private read(): Task[] {
    if (!existsSync(this.path)) return [];
    return JSON.parse(readFileSync(this.path, "utf8")) as Task[];
  }

  private write(tasks: Task[]): void {
    writeFileSync(this.path, `${JSON.stringify(tasks, null, 2)}\n`, "utf8");
  }

  add(task: string): Task {
    const item: Task = { id: randomUUID().slice(0, 6), task, done: false, createdAt: new Date().toISOString() };
    this.write([...this.read(), item]);
    return item;
  }

  open(): Task[] {
    return this.read().filter((t) => !t.done);
  }

  all(): Task[] {
    return this.read();
  }

  /** Marks done by id, or by matching words when the human says it loosely. */
  complete(idOrWords: string): Task | undefined {
    const tasks = this.read();
    const needle = idOrWords.toLowerCase();
    const hit =
      tasks.find((t) => !t.done && t.id === idOrWords) ??
      tasks.find((t) => !t.done && t.task.toLowerCase().includes(needle));
    if (!hit) return undefined;
    hit.done = true;
    hit.doneAt = new Date().toISOString();
    this.write(tasks);
    return hit;
  }
}

export function taskList(dir: string): TaskList {
  return new TaskList(join(dir, "tasks.json"));
}

/** The todo list as tools — per-agent, since a task list is someone's life. */
export function taskNodes(tasks: TaskList): NodeDef[] {
  return [
    {
      name: "task.add",
      description: "Add a task to the human's todo list. Params: task (what needs doing).",
      inputSchema: { type: "object", required: ["task"], properties: { task: { type: "string" } } },
      run: async (params) => [{ json: { added: true, ...tasks.add(String(params.task)) } }],
    },
    {
      name: "task.list",
      description: "List the human's open tasks. No params.",
      inputSchema: { type: "object", properties: {} },
      run: async () => {
        const open = tasks.open();
        return open.length
          ? open.map((t) => ({ json: { ...t } }))
          : [{ json: { empty: true, note: "no open tasks" } }];
      },
    },
    {
      name: "task.done",
      description:
        "Mark a task finished. Params: task (its id, or a few words from it — 'the invoice one' works).",
      inputSchema: { type: "object", required: ["task"], properties: { task: { type: "string" } } },
      run: async (params) => {
        const hit = tasks.complete(String(params.task));
        return [{ json: hit ? { completed: true, ...hit } : { completed: false, note: "no open task matched" } }];
      },
    },
  ];
}
