// Completion evidence visible in Claude's stream, not OS process leftovers.
"use strict";

const TERMINAL_TASK = new Set(["completed", "failed", "stopped", "cancelled"]);

function promisesContinuation(text) {
  // Reports may quote the brief or show example output. Only inspect prose.
  const prose = String(text).replace(/```[^]*?```/g, "").replace(/`[^`\n]*`/g, "").replace(/^\s*>.*$/gm, "");
  return prose.split(/(?<=[.!?])\s+|\n/).some((sentence) => {
    // Optional offers to the reader are not unfinished work in this run.
    if (/^\s*if you\b/i.test(sentence)) return false;
    return /\b(?:I|we)(?:['’]ll| will|['’]m going to| am going to| are going to)\s+(?:(?:now|then|also|next)\s+)*(?:continue|resume|proceed|wait|monitor|follow up|run|rerun|check|verify|test|finish|complete|implement|investigate|fix|address|review|update|push|commit|report back|come back)\b/i.test(sentence);
  });
}

function completionTracker() {
  const pending = new Map();
  const finished = new Set();
  const tools = new Map();
  const waits = new Map();
  let lastText = "";

  const observe = (ev) => {
    if (ev.type === "assistant" && !ev.parent_tool_use_id) {
      const content = ev.message?.content || [];
      // Text accompanying a tool call is commentary before the work, not a
      // final report. The result event still supplies final completion prose.
      lastText = content.some((c) => c.type === "tool_use") ? "" :
        content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
      for (const c of content) {
        if (c.type === "tool_use" && c.name === "TaskOutput" && c.id && c.input?.task_id) waits.set(c.id, c.input.task_id);
        if (c.type !== "tool_use" || !c.id || c.input?.run_in_background !== true) continue;
        const key = `tool:${c.id}`;
        tools.set(c.id, key);
        pending.set(key, c.name || "background tool");
      }
    }
    if (ev.type === "user") {
      for (const c of ev.message?.content || []) {
        if (c.type !== "tool_result") continue;
        const text = typeof c.content === "string" ? c.content :
          (Array.isArray(c.content) ? c.content.filter((b) => b.type === "text").map((b) => b.text).join("\n") : "");
        const waited = waits.get(c.tool_use_id);
        const task = ev.tool_use_result?.task;
        if (waited && task?.task_id === waited && !c.is_error && TERMINAL_TASK.has(task.status)) {
          finished.add(waited);
          pending.delete(waited);
        }
        if (!tools.has(c.tool_use_id)) continue;
        const old = tools.get(c.tool_use_id);
        if (c.is_error) { pending.delete(old); continue; }
        const id = ev.tool_use_result?.backgroundTaskId || /(?:background with ID:\s*|agentId:\s*)([\w-]+)/i.exec(text)?.[1];
        if (TERMINAL_TASK.has(ev.tool_use_result?.status)) {
          // An agent requested in the background may complete synchronously.
          pending.delete(old);
          if (id) {
            finished.add(id);
            pending.delete(id);
          }
          continue;
        }
        if (id) {
          const label = pending.get(old) || "background tool";
          pending.delete(old);
          tools.set(c.tool_use_id, id);
          if (!finished.has(id)) pending.set(id, label);
        } else if (/^Exit code:\s*\d+\s*$/m.test(text)) {
          // A requested background command can finish before being detached.
          pending.delete(old);
        }
      }
    }
    if (ev.type === "system" && ev.task_id) {
      const old = ev.tool_use_id && tools.get(ev.tool_use_id);
      if (ev.subtype === "task_notification" && TERMINAL_TASK.has(ev.status)) {
        finished.add(ev.task_id);
        pending.delete(ev.task_id);
        if (old) pending.delete(old);
      } else if (ev.subtype === "task_started") {
        if (old) pending.delete(old);
        if (ev.tool_use_id) tools.set(ev.tool_use_id, ev.task_id);
        if (!finished.has(ev.task_id)) pending.set(ev.task_id, ev.description || ev.task_type || "background task");
      }
    }
  };

  const reasons = (result) => {
    const reasons = [];
    if (promisesContinuation(result) || promisesContinuation(lastText)) reasons.push("final assistant message promises further work");
    if (pending.size) reasons.push(`outstanding background tasks: ${[...pending.keys()].join(", ")}`);
    return reasons;
  };
  return { observe, reasons };
}

module.exports = { completionTracker, promisesContinuation };
