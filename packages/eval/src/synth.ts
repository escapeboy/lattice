/**
 * A deterministic, ground-truth web-app model for multi-step DELTA scenarios.
 *
 * Why this exists: the single-snapshot fixtures cannot show where the economics
 * actually live — a 15+ step flow where the page mutates a little each step. To
 * compare Lattice against the REAL opponents (the Chrome method: a screenshot
 * agent and a raw-DOM agent) fairly, all representations must come from ONE
 * source of truth. So we model app state and render it three ways from the same
 * tree:
 *
 *   - `renderHtml`  → realistic serialized DOM (what a raw-DOM agent feeds an LLM)
 *   - `renderAx`    → agent-browser's exact a11y text + refs (the parity engine,
 *                      and the input Lattice's snapshotToIG consumes)
 *   - a screenshot  → a fixed vision-token cost per step (pixels don't diff)
 *
 * The HTML carries MODERATE, realistic overhead (semantic tags, a couple of
 * wrapper classes, a data attribute) — not inflated to flatter Lattice and not
 * stripped to flatter the DOM agent. The raw-DOM/a11y ratio is reported so the
 * modeling is auditable.
 */

import type { EvalFrame } from "./frame.js";

export interface SynthNode {
  readonly role: string; // agent-browser role token (button, textbox, link, heading, list, listitem, combobox, checkbox, navigation, main, generic)
  readonly name: string;
  readonly value?: string;
  readonly checked?: boolean;
  readonly children?: ReadonlyArray<SynthNode>;
}

// ── app state model ───────────────────────────────────────────────────────────

interface Task {
  readonly id: number;
  readonly title: string;
  readonly done: boolean;
}

interface FormState {
  readonly title: string;
  readonly desc: string;
  readonly priority: string;
  readonly notify: boolean;
}

export interface AppState {
  readonly view: "list" | "detail" | "settings";
  readonly tasks: ReadonlyArray<Task>;
  readonly filter: "all" | "active" | "done";
  readonly detailId?: number;
  readonly form?: FormState;
  readonly darkMode?: boolean;
  readonly emailNotif?: boolean;
}

function visibleTasks(s: AppState): ReadonlyArray<Task> {
  if (s.filter === "active") return s.tasks.filter((t) => !t.done);
  if (s.filter === "done") return s.tasks.filter((t) => t.done);
  return s.tasks;
}

const nav = (active: string): SynthNode => ({
  role: "navigation",
  name: "Main",
  children: [
    { role: "link", name: "Tasks", checked: active === "Tasks" },
    { role: "link", name: "Settings", checked: active === "Settings" },
  ],
});

/** Render the app state into the canonical semantic tree. */
export function render(s: AppState): SynthNode {
  if (s.view === "settings") {
    return {
      role: "main",
      name: "Settings",
      children: [
        nav("Settings"),
        { role: "heading", name: "Settings" },
        { role: "checkbox", name: "Dark mode", checked: s.darkMode ?? false },
        { role: "checkbox", name: "Email notifications", checked: s.emailNotif ?? false },
        { role: "button", name: "Back to tasks" },
      ],
    };
  }

  if (s.view === "detail" && s.form) {
    return {
      role: "main",
      name: "Edit task",
      children: [
        nav("Tasks"),
        { role: "heading", name: "Edit task" },
        { role: "textbox", name: "Title", value: s.form.title },
        { role: "textbox", name: "Description", value: s.form.desc },
        { role: "combobox", name: "Priority", value: s.form.priority },
        { role: "checkbox", name: "Notify on change", checked: s.form.notify },
        { role: "button", name: "Save changes" },
        { role: "button", name: "Cancel" },
      ],
    };
  }

  const rows: SynthNode[] = visibleTasks(s).map((t) => ({
    role: "listitem",
    name: t.title,
    children: [
      { role: "checkbox", name: `Done ${t.title}`, checked: t.done },
      { role: "button", name: `Edit ${t.title}` },
      { role: "button", name: `Delete ${t.title}` },
    ],
  }));

  return {
    role: "main",
    name: "Tasks",
    children: [
      nav("Tasks"),
      { role: "heading", name: "Tasks" },
      { role: "button", name: "Add task" },
      { role: "combobox", name: "Filter", value: s.filter },
      { role: "list", name: "Task list", children: rows },
    ],
  };
}

// ── renderers ─────────────────────────────────────────────────────────────────

const INTERACTIVE = new Set(["button", "link", "textbox", "combobox", "checkbox"]);

/** agent-browser a11y text: indented `- role "name" [ref=eN]` lines + flags. */
export function renderAx(root: SynthNode): { text: string; refs: Record<string, { name: string; role: string }> } {
  const lines: string[] = [];
  const refs: Record<string, { name: string; role: string }> = {};
  let n = 0;
  const walk = (node: SynthNode, depth: number): void => {
    const ref = `e${++n}`;
    refs[ref] = { name: node.name, role: node.role };
    const indent = "  ".repeat(depth);
    let flags = "";
    if (node.checked === true) flags += " [checked]";
    const val = node.value !== undefined ? `: ${node.value}` : "";
    lines.push(`${indent}- ${node.role} "${node.name}"${val} [ref=${ref}]${flags}`);
    for (const c of node.children ?? []) walk(c, depth + 1);
  };
  walk(root, 0);
  return { text: lines.join("\n"), refs };
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/**
 * Realistic serialized DOM — what a raw-DOM ("Chrome method") agent feeds an LLM.
 * Pretty-printed one element per line (as a readable serialization an agent would
 * actually be given), so a raw-DOM agent that DIFFS the DOM gets a fair,
 * genuinely smaller cost — not a strawman where the whole page is one line.
 */
export function renderHtml(root: SynthNode): string {
  const out: string[] = [];
  const emit = (line: string, depth: number): void => {
    out.push("  ".repeat(depth) + line);
  };
  const walk = (node: SynthNode, depth: number): void => {
    const kids = node.children ?? [];
    const recurse = (open: string, close: string): void => {
      emit(open, depth);
      for (const c of kids) walk(c, depth + 1);
      emit(close, depth);
    };
    switch (node.role) {
      case "navigation":
        return recurse(`<nav class="sidebar" aria-label="${node.name}"><ul class="nav-list">`, `</ul></nav>`);
      case "main":
        return recurse(`<main class="app-main" role="main" aria-label="${node.name}"><div class="content-wrap">`, `</div></main>`);
      case "heading":
        return emit(`<h2 class="section-title" id="${slug(node.name)}-h">${node.name}</h2>`, depth);
      case "list":
        return recurse(`<ul class="task-list" aria-label="${node.name}" data-count="${kids.length}">`, `</ul>`);
      case "listitem":
        return recurse(`<li class="task-row" data-id="${slug(node.name)}"><span class="task-title">${node.name}</span><div class="task-actions">`, `</div></li>`);
      case "button":
        return emit(`<div class="control"><button type="button" class="btn btn-default" data-action="${slug(node.name)}">${node.name}</button></div>`, depth);
      case "link":
        return emit(`<li class="nav-item"><a href="#/${slug(node.name)}" class="nav-link${node.checked ? " is-active" : ""}" aria-current="${node.checked ? "page" : "false"}">${node.name}</a></li>`, depth);
      case "textbox":
        return emit(`<div class="field"><label class="field-label" for="${slug(node.name)}">${node.name}</label><input id="${slug(node.name)}" name="${slug(node.name)}" type="text" class="form-input" value="${node.value ?? ""}" placeholder="Enter ${node.name.toLowerCase()}" /></div>`, depth);
      case "combobox":
        return emit(`<div class="field"><label class="field-label" for="${slug(node.name)}">${node.name}</label><select id="${slug(node.name)}" name="${slug(node.name)}" class="form-select"><option value="${node.value ?? ""}" selected>${node.value ?? ""}</option></select></div>`, depth);
      case "checkbox":
        return emit(`<label class="checkbox-row"><input type="checkbox" class="checkbox-input"${node.checked ? " checked" : ""} aria-label="${node.name}" /><span class="checkbox-label">${node.name}</span></label>`, depth);
      default:
        return emit(`<span class="text">${node.name}</span>`, depth);
    }
  };
  out.push(`<!doctype html>`, `<html lang="en">`, `<head><meta charset="utf-8"><title>Tasks</title></head>`, `<body class="app">`);
  walk(root, 1);
  out.push(`</body>`, `</html>`);
  return out.join("\n");
}

/** Render an app state into an EvalFrame (all four representations from one tree). */
export function synthFrame(s: AppState): EvalFrame {
  const root = render(s);
  const { text, refs } = renderAx(root);
  return {
    refs,
    snapshotText: text,
    raw: { url: "data:synth", refs: [], tree: text },
    html: renderHtml(root),
  };
}

/** The interactive elements an agent could target in a given state, by name. */
export function actionableNames(root: SynthNode): string[] {
  const out: string[] = [];
  const walk = (node: SynthNode): void => {
    if (INTERACTIVE.has(node.role)) out.push(node.name);
    for (const c of node.children ?? []) walk(c);
  };
  walk(root);
  return out;
}

// ── the 17-step flow ──────────────────────────────────────────────────────────

export interface SynthStep {
  readonly state: AppState;
  /** Names the agent acts on at this step (must exist in the state). */
  readonly targets: ReadonlyArray<string>;
}

/**
 * A realistic project-tracker session: load → grow the list → toggle/edit →
 * filter → open a detail form → fill it → submit → back → delete → settings.
 * Each step mutates the tree a little; that is where delta streaming pays off.
 */
export function taskTrackerFlow(): SynthStep[] {
  let tasks: Task[] = [
    { id: 1, title: "Buy milk", done: false },
    { id: 2, title: "Call Ana", done: false },
    { id: 3, title: "Pay rent", done: false },
  ];
  const base: AppState = { view: "list", tasks, filter: "all" };
  const steps: SynthStep[] = [];
  const push = (state: AppState, targets: string[]): void => {
    steps.push({ state, targets });
  };

  // 1. initial dashboard — act on "Add task"
  push(base, ["Add task"]);
  // 2. added Task 4
  tasks = [...tasks, { id: 4, title: "Book flights", done: false }];
  push({ view: "list", tasks, filter: "all" }, ["Add task"]);
  // 3. added Task 5
  tasks = [...tasks, { id: 5, title: "Renew passport", done: false }];
  push({ view: "list", tasks, filter: "all" }, ["Edit Buy milk"]);
  // 4. toggle "Buy milk" done
  tasks = tasks.map((t) => (t.id === 1 ? { ...t, done: true } : t));
  push({ view: "list", tasks, filter: "all" }, ["Done Call Ana"]);
  // 5. toggle "Call Ana" done
  tasks = tasks.map((t) => (t.id === 2 ? { ...t, done: true } : t));
  push({ view: "list", tasks, filter: "all" }, ["Filter"]);
  // 6. filter → active (two rows disappear)
  push({ view: "list", tasks, filter: "active" }, ["Edit Pay rent"]);
  // 7. filter → done (different rows)
  push({ view: "list", tasks, filter: "done" }, ["Edit Buy milk"]);
  // 8. filter → all again
  push({ view: "list", tasks, filter: "all" }, ["Edit Pay rent"]);
  // 9. open detail form for "Pay rent" (whole view changes)
  const form0: FormState = { title: "Pay rent", desc: "", priority: "Normal", notify: false };
  push({ view: "detail", tasks, filter: "all", detailId: 3, form: form0 }, ["Title"]);
  // 10. fill title
  const form1 = { ...form0, title: "Pay rent (June)" };
  push({ view: "detail", tasks, filter: "all", detailId: 3, form: form1 }, ["Description"]);
  // 11. fill description
  const form2 = { ...form1, desc: "Transfer to landlord by 5th" };
  push({ view: "detail", tasks, filter: "all", detailId: 3, form: form2 }, ["Priority"]);
  // 12. set priority
  const form3 = { ...form2, priority: "High" };
  push({ view: "detail", tasks, filter: "all", detailId: 3, form: form3 }, ["Notify on change"]);
  // 13. toggle notify
  const form4 = { ...form3, notify: true };
  push({ view: "detail", tasks, filter: "all", detailId: 3, form: form4 }, ["Save changes"]);
  // 14. save → back to list, task renamed
  tasks = tasks.map((t) => (t.id === 3 ? { ...t, title: "Pay rent (June)" } : t));
  push({ view: "list", tasks, filter: "all" }, ["Delete Book flights"]);
  // 15. delete "Book flights" (row removed)
  tasks = tasks.filter((t) => t.id !== 4);
  push({ view: "list", tasks, filter: "all" }, ["Settings"]);
  // 16. go to settings (whole view changes)
  push({ view: "settings", tasks, filter: "all", darkMode: false, emailNotif: false }, ["Dark mode"]);
  // 17. toggle dark mode
  push({ view: "settings", tasks, filter: "all", darkMode: true, emailNotif: false }, ["Back to tasks"]);

  return steps;
}
