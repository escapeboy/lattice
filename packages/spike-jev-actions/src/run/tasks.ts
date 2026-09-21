/**
 * The shared task set for Phase 0 and Phase 1.
 *
 * Public, logged-out sites only, chosen so the same task is expressible in both
 * harnesses: a goal plus a verifier that reads the FINAL page state rather than
 * trusting the agent's own DONE. `verify` is evaluated in the page.
 */

export interface Task {
  readonly id: string;
  readonly url: string;
  readonly goal: string;
  /** Shape of the task, per the brief: search / filter / paginate / detail / form. */
  readonly shape: "search" | "filter" | "paginate" | "detail" | "form";
  /**
   * JS expression evaluated in the page after the run. Must be true for the
   * task to count as a success. Independent of what the model claimed.
   */
  readonly verify: string;
  /** Value the TYPE_TEXT stub supplies (no local instruct model — see report). */
  readonly typedValue?: string;
}

export const TASKS: readonly Task[] = [
  {
    id: "wikipedia-search",
    url: "https://en.wikipedia.org/wiki/Main_Page",
    goal: "Search Wikipedia for the article about interaction design.",
    shape: "search",
    typedValue: "Interaction design",
    verify: "!!document.querySelector('input[name=search],input[type=search]')?.value?.trim()",
  },
  {
    id: "wikipedia-detail",
    url: "https://en.wikipedia.org/wiki/Interaction_design",
    goal: "Open the linked article about usability from this page.",
    shape: "detail",
    verify: "location.pathname.toLowerCase().includes('usability')",
  },
  {
    id: "hn-paginate",
    url: "https://news.ycombinator.com/news",
    goal: "Go to the second page of stories.",
    shape: "paginate",
    verify: "location.search.includes('p=2') || location.href.includes('next')",
  },
  {
    id: "hn-detail",
    url: "https://news.ycombinator.com/news",
    goal: "Open the comments page of the first story.",
    shape: "detail",
    verify: "location.pathname.includes('/item')",
  },
  {
    id: "wikipedia-form",
    url: "https://en.wikipedia.org/wiki/Special:Search",
    goal: "Type the phrase accessibility tree into the search field. Do not submit the form.",
    shape: "form",
    typedValue: "accessibility tree",
    verify:
      "!!Array.from(document.querySelectorAll('input')).find(i=>/accessibility/i.test(i.value||''))",
  },
];

/**
 * The bundled vendor example. Phase 0 runs it 5 times; Phase 1 runs it too, so
 * the two harnesses are compared on identical work.
 */
export const FLIGHTS_TASK: Task = {
  id: "google-flights",
  url: "https://www.google.com/travel/flights?hl=en",
  goal:
    "Find one-way flights from Zurich to London on September 20, 2026, for one adult in economy. " +
    "Stop when matching flight options are visible. Do not select or book a flight.",
  shape: "filter",
  typedValue: "Zurich",
  verify: "location.pathname.includes('/travel/flights/search')",
};
