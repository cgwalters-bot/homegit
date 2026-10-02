#!/usr/bin/env node
"use strict";

const fs = require("node:fs");

function userName(item) {
  return item.user && item.user.login ? item.user.login : "deleted user";
}

function text(value) {
  return value || "(no body)";
}

function heading(name, items, format) {
  const lines = [`${name} (${items.length})`];
  for (const item of items) lines.push(`- ${format(item)}`);
  return lines;
}

function reviewCommentLocation(comment) {
  const path = comment.path || "(unknown path)";
  if (comment.line != null) return `${path}:${comment.line}`;
  if (comment.original_line != null) return `${path}:${comment.original_line} (outdated)`;
  return `${path} (outdated)`;
}

function render(context) {
  const pr = context.pull_request;
  if (!pr || !pr.head || !pr.base) throw new Error("pull request response has no head or base");
  const headRepo = pr.head.repo && pr.head.repo.full_name ? pr.head.repo.full_name : "deleted repository";
  const baseRepo = pr.base.repo && pr.base.repo.full_name ? pr.base.repo.full_name : "deleted repository";
  const lines = [
    `${pr.html_url || "Pull request"}: ${pr.title || "(untitled)"}`,
    `State: ${pr.state || "unknown"}${pr.draft ? " (draft)" : ""}`,
    `Head: ${headRepo}:${pr.head.ref || "(unknown ref)"} @ ${pr.head.sha || "(unknown SHA)"}`,
    `Base: ${baseRepo}:${pr.base.ref || "(unknown ref)"} @ ${pr.base.sha || "(unknown SHA)"}`,
    "",
    "Body:",
    text(pr.body),
    "",
    ...heading("Reviews", context.reviews, (review) =>
      `${review.submitted_at || review.created_at || "(unknown time)"} ${userName(review)} ${review.state || "(no state)"}: ${text(review.body)}`),
    "",
    ...heading("Review comments", context.review_comments, (comment) =>
      `${comment.created_at || "(unknown time)"} ${userName(comment)} ${reviewCommentLocation(comment)}: ${text(comment.body)}`),
    "",
    ...heading("Issue comments", context.issue_comments, (comment) =>
      `${comment.created_at || "(unknown time)"} ${userName(comment)}: ${text(comment.body)}`),
  ];
  return `${lines.join("\n")}\n`;
}

try {
  process.stdout.write(render(JSON.parse(fs.readFileSync(0, "utf8"))));
} catch (error) {
  process.stderr.write(`error: ${error.message}\n`);
  process.exitCode = 1;
}
