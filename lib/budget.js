// A run's budget for bin/bot-opencode: when to tell a local worker that
// its time is running out, when to interrupt it to hand back, and when to
// stop it. A port of the runner's bot-harness (harness/src/budget.rs in
// cgwalters-devspace-sandbox), with its thresholds and wording (which
// tests/budget.test.js holds a copy of); locally there is no count of
// model requests, so the budget is the time and the number of subagent
// tasks. Node's standard library only.
"use strict";

// Shares of the time at which the agent is told to converge, to finish,
// and is interrupted to hand back; at 100% the run stops.
const CONVERGE = 60;
const FINISH = 80;
const HAND_BACK = 95;
const STOP = 100;
// The notice levels, highest first: one jump past both sends only the
// higher.
const NOTICES = [FINISH, CONVERGE];
const NOTICE_PREFIX = "[bot-harness budget notice]";
const LABEL_LAST_TASK = "last task";
const LABEL_HAND_BACK = "hand back";
// Why a run stopped early.
const WHY_TIMEOUT = "timeout";
const WHY_TASKS = "task cap";
// opencode's tool that starts a subagent: its ACP tool_call is titled with
// the tool's name, and its input names the subagent.
const TASK_TOOL = "task";
// The kinds it is reported as, as the runner has them; a shell command
// that happens to be titled "task" is not one.
const TASK_KINDS = ["think", "other", ""];

const KEEP_WORKING = "This is not a new task and needs no reply: keep working on the task you were given.";

// A duration in the runner's format: 1h05m, 12m, 40s (rounded down).
function human(ms) {
  const s = Math.floor(ms / 1000);
  if (s >= 3600) return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
  if (s >= 60) return `${Math.floor(s / 60)}m`;
  return `${s}s`;
}

// The time the hand-back turn gets.
function handBackWindow(timeoutMs) {
  return Math.floor((timeoutMs * (STOP - HAND_BACK)) / 100);
}

function noticeText(level, used) {
  const advice = level >= FINISH
    ? "Stop exploring: finish the smallest correct change, run the cheapest verification that covers it, write your outcome as your task brief says and stop."
    : "Converge: start no new line of investigation, and work towards a change you can hand back.";
  return `${NOTICE_PREFIX} This run has used ${level}% of its budget (${used}). ${advice} Near the limit you are interrupted to hand back, and at the limit the session ends. ${KEEP_WORKING}`;
}

function lastTaskText(tasks) {
  return `${NOTICE_PREFIX} This run has started ${tasks} subagent tasks, the most it may: do the rest of the work yourself. Starting another one interrupts the run to hand back. ${KEEP_WORKING}`;
}

function handBackText(used, windowMs) {
  return `${NOTICE_PREFIX} This run has ${used}, so your work was interrupted. Hand back now: start nothing new and run no more builds or tests. Leave the working tree as the partial change you want collected, write your outcome as your task brief says (what is done, what is not, how to continue, and why you stopped early), then stop. The session ends in ${human(windowMs)}; whatever isn't written by then is lost.`;
}

// Whether an ACP tool_call update starts a subagent task.
function isTaskCall(update) {
  if (update?.rawInput?.subagent_type !== undefined) return true;
  return String(update?.title ?? "").toLowerCase() === TASK_TOOL && TASK_KINDS.includes(update?.kind ?? "");
}

// What the run has used, checked against its limits: timeoutMs, and
// maxTasks (null or 0 for no cap). check() returns the next signal, or
// null; each notice is returned once.
class Budget {
  constructor({ timeoutMs, maxTasks = null }) {
    if (!(timeoutMs > 0)) throw new Error(`a budget needs a timeout above 0, not ${timeoutMs}`);
    this.timeoutMs = timeoutMs;
    this.maxTasks = maxTasks || null;
    this.noticed = 0;
    this.lastTaskNoticed = false;
    this.handingBack = false;
  }

  handBackWindow() {
    return handBackWindow(this.timeoutMs);
  }

  percent(elapsedMs) {
    return Math.floor((elapsedMs * 100) / this.timeoutMs);
  }

  // The time, from the start, of the first threshold after elapsedMs: when
  // check() may have something new without a task being started.
  nextCheckMs(elapsedMs) {
    const at = [CONVERGE, FINISH, HAND_BACK, STOP].map((l) => Math.ceil((l * this.timeoutMs) / 100)).find((t) => t > elapsedMs);
    return at === undefined ? elapsedMs : at;
  }

  // One of { kind: "stop", why }, { kind: "notice", label, text },
  // { kind: "hand_back", label, text, why, windowMs }, or null.
  check(elapsedMs, tasks) {
    const percent = this.percent(elapsedMs);
    if (percent >= STOP) return { kind: "stop", why: WHY_TIMEOUT };
    if (this.handingBack) return null;
    const used = `${human(elapsedMs)} of ${human(this.timeoutMs)}`;
    const windowMs = this.handBackWindow();
    const handBack = (what, why) => {
      this.handingBack = true;
      return { kind: "hand_back", label: LABEL_HAND_BACK, text: handBackText(what, windowMs), why, windowMs };
    };
    if (this.maxTasks !== null && tasks > this.maxTasks) {
      return handBack(`started more than ${this.maxTasks} subagent tasks`, WHY_TASKS);
    }
    if (percent >= HAND_BACK) return handBack(`used ${used}`, WHY_TIMEOUT);
    const level = NOTICES.find((l) => percent >= l);
    if (level !== undefined && level > this.noticed) {
      this.noticed = level;
      return { kind: "notice", label: `${level}%`, text: noticeText(level, used) };
    }
    if (this.maxTasks === tasks && !this.lastTaskNoticed) {
      this.lastTaskNoticed = true;
      return { kind: "notice", label: LABEL_LAST_TASK, text: lastTaskText(tasks) };
    }
    return null;
  }
}

module.exports = {
  CONVERGE, FINISH, HAND_BACK, NOTICE_PREFIX, LABEL_LAST_TASK, LABEL_HAND_BACK, WHY_TIMEOUT, WHY_TASKS, TASK_TOOL,
  Budget, human, handBackWindow, noticeText, lastTaskText, handBackText, isTaskCall,
};
