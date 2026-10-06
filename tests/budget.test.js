// Offline tests of lib/budget.js, the port of the runner's budget.rs that
// bin/bot-opencode uses. Run with tests/budget.sh, or
// node --test tests/budget.test.js.
"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const budget = require(path.join(__dirname, "..", "lib", "budget.js"));

const MIN = 60000;
const KEEP_WORKING = "This is not a new task and needs no reply: keep working on the task you were given.";

test("human durations", () => {
  const cases = [[0, "0s"], [999, "0s"], [59999, "59s"], [60000, "1m"], [60 * MIN - 1, "59m"],
    [60 * MIN, "1h00m"], [65 * MIN + 30000, "1h05m"], [24 * 60 * MIN, "24h00m"]];
  for (const [ms, want] of cases) assert.equal(budget.human(ms), want, String(ms));
});

test("the hand-back window is 5% of the time", () => {
  for (const [timeoutMs, want] of [[30 * MIN, 90000], [75 * MIN, 225000], [MIN, 3000], [6000, 300]]) {
    assert.equal(budget.handBackWindow(timeoutMs), want, String(timeoutMs));
    assert.equal(new budget.Budget({ timeoutMs }).handBackWindow(), want);
  }
});

// The runner's text, as budget.rs words it.
test("notice texts", () => {
  const cases = [
    [budget.noticeText(60, "18m of 30m"),
      `[bot-harness budget notice] This run has used 60% of its budget (18m of 30m). Converge: start no new line of investigation, and work towards a change you can hand back. Near the limit you are interrupted to hand back, and at the limit the session ends. ${KEEP_WORKING}`],
    [budget.noticeText(80, "24m of 30m"),
      `[bot-harness budget notice] This run has used 80% of its budget (24m of 30m). Stop exploring: finish the smallest correct change, run the cheapest verification that covers it, write your outcome as your task brief says and stop. Near the limit you are interrupted to hand back, and at the limit the session ends. ${KEEP_WORKING}`],
    [budget.lastTaskText(4),
      `[bot-harness budget notice] This run has started 4 subagent tasks, the most it may: do the rest of the work yourself. Starting another one interrupts the run to hand back. ${KEEP_WORKING}`],
    [budget.handBackText("used 28m of 30m", 90000),
      "[bot-harness budget notice] This run has used 28m of 30m, so your work was interrupted. Hand back now: start nothing new and run no more builds or tests. Leave the working tree as the partial change you want collected, write your outcome as your task brief says (what is done, what is not, how to continue, and why you stopped early), then stop. The session ends in 1m; whatever isn't written by then is lost."],
  ];
  for (const [got, want] of cases) assert.equal(got, want);
});

// Each case runs one Budget through steps of [minutes elapsed, tasks
// started, the label of the signal check() returns (kind:label, or null)].
test("signals as time passes and tasks start", () => {
  const cases = [
    { name: "time only, no cap", maxTasks: 0, steps: [[1, 0, null], [17.9, 9, null], [18, 9, "notice:60%"], [20, 9, null],
      [24, 9, "notice:80%"], [28, 9, null], [28.5, 9, "hand_back:hand back"], [29, 9, null], [30, 9, "stop:timeout"]] },
    { name: "a jump past both notices sends only 80%", maxTasks: 0, steps: [[25, 0, "notice:80%"], [26, 0, null]] },
    { name: "a jump to the limit stops", maxTasks: 0, steps: [[31, 0, "stop:timeout"]] },
    { name: "cap 1: the last task when the first starts", maxTasks: 1, steps: [[1, 0, null], [2, 1, "notice:last task"], [3, 1, null],
      [4, 2, "hand_back:hand back"], [5, 3, null], [30, 3, "stop:timeout"]] },
    { name: "cap 4: no notice below it, then once", maxTasks: 4, steps: [[1, 3, null], [2, 4, "notice:last task"], [3, 4, null],
      [18, 4, "notice:60%"], [19, 5, "hand_back:hand back"]] },
    { name: "a time notice goes first, the last task after it", maxTasks: 4, steps: [[18, 4, "notice:60%"], [18, 4, "notice:last task"], [18, 4, null]] },
    { name: "the task cap hands back before a time notice", maxTasks: 1, steps: [[25, 2, "hand_back:hand back"], [26, 2, null]] },
    { name: "cap 0 is no cap", maxTasks: 0, steps: [[1, 0, null], [2, 100, null]] },
  ];
  for (const { name, maxTasks, steps } of cases) {
    const b = new budget.Budget({ timeoutMs: 30 * MIN, maxTasks });
    for (const [min, tasks, want] of steps) {
      const s = b.check(min * MIN, tasks);
      assert.equal(s === null ? null : `${s.kind}:${s.label || s.why}`, want, `${name}: ${min}m, ${tasks} tasks`);
    }
  }
});

test("what a signal carries", () => {
  const b = new budget.Budget({ timeoutMs: 30 * MIN, maxTasks: 2 });
  assert.equal(b.check(18 * MIN + 30000, 0).text, budget.noticeText(60, "18m of 30m"));
  assert.equal(b.check(19 * MIN, 2).text, budget.lastTaskText(2));
  assert.deepEqual(b.check(20 * MIN, 3), { kind: "hand_back", label: budget.LABEL_HAND_BACK, why: budget.WHY_TASKS, windowMs: 90000,
    text: budget.handBackText("started more than 2 subagent tasks", 90000) });
  const t = new budget.Budget({ timeoutMs: 30 * MIN });
  assert.deepEqual(t.check(29 * MIN, 0), { kind: "hand_back", label: budget.LABEL_HAND_BACK, why: budget.WHY_TIMEOUT, windowMs: 90000,
    text: budget.handBackText("used 29m of 30m", 90000) });
  assert.deepEqual(t.check(30 * MIN, 0), { kind: "stop", why: budget.WHY_TIMEOUT });
});

test("when to check next", () => {
  const b = new budget.Budget({ timeoutMs: 1000 });
  for (const [elapsed, want] of [[0, 600], [599, 600], [600, 800], [800, 950], [950, 1000], [1000, 1000]]) {
    assert.equal(b.nextCheckMs(elapsed), want, String(elapsed));
  }
  // A threshold is never reached early: the percent there is the level.
  const odd = new budget.Budget({ timeoutMs: 1201 });
  for (const level of [60, 80, 95, 100]) {
    const at = odd.nextCheckMs(Math.ceil((level * 1201) / 100) - 1);
    assert.equal(odd.percent(at), level);
  }
});

test("which tool calls are subagent tasks", () => {
  const cases = [[{ title: "task" }, true], [{ title: "Task", kind: "think" }, true], [{ title: "task", kind: "other" }, true],
    // A command, whatever it is called.
    [{ title: "task", kind: "execute" }, false], [{ title: "bash", rawInput: { subagent_type: "explore" } }, true],
    [{ title: "Explore the parser", rawInput: {} }, false], [{ title: "bash" }, false], [{}, false]];
  for (const [u, want] of cases) assert.equal(budget.isTaskCall(u), want, JSON.stringify(u));
});

test("a budget needs a timeout", () => {
  for (const timeoutMs of [0, -1, NaN, undefined]) assert.throws(() => new budget.Budget({ timeoutMs }), /needs a timeout/);
});
