import { test } from "node:test";
import assert from "node:assert/strict";
import { InvalidTransitionError, canTransition, isTerminal, transition } from "../src/domain/task-state-machine.js";

test("valid transitions succeed", () => {
  assert.equal(transition("TODO", "claim"), "WORKING");
  assert.equal(transition("WORKING", "gates_passed"), "REVIEW");
  assert.equal(transition("WORKING", "blocked"), "NEEDS_INPUT");
  assert.equal(transition("NEEDS_INPUT", "answered"), "WORKING");
  assert.equal(transition("REVIEW", "accepted"), "DONE");
  assert.equal(transition("REVIEW", "changes_requested"), "WORKING");
  assert.equal(transition("WORKING", "infra_failure"), "FAILED");
  assert.equal(transition("NEEDS_INPUT", "infra_failure"), "FAILED");
});

test("invalid transitions throw InvalidTransitionError", () => {
  assert.throws(() => transition("TODO", "gates_passed"), InvalidTransitionError);
  assert.throws(() => transition("TODO", "answered"), InvalidTransitionError);
  assert.throws(() => transition("NEEDS_INPUT", "gates_passed"), InvalidTransitionError);
  assert.throws(() => transition("DONE", "claim"), InvalidTransitionError);
  assert.throws(() => transition("FAILED", "claim"), InvalidTransitionError);
  assert.throws(() => transition("REVIEW", "blocked"), InvalidTransitionError);
});

test("canTransition mirrors transition() without throwing", () => {
  assert.equal(canTransition("TODO", "claim"), true);
  assert.equal(canTransition("TODO", "gates_passed"), false);
});

test("DONE, FAILED, and CANCELLED are terminal; nothing else is", () => {
  assert.equal(isTerminal("DONE"), true);
  assert.equal(isTerminal("FAILED"), true);
  assert.equal(isTerminal("CANCELLED"), true);
  assert.equal(isTerminal("TODO"), false);
  assert.equal(isTerminal("WORKING"), false);
  assert.equal(isTerminal("REVIEW"), false);
  assert.equal(isTerminal("NEEDS_INPUT"), false);
});

test("gates_failed_retry is not a table entry (handled inside the WORKING episode, not as a Task-status change)", () => {
  assert.equal(canTransition("WORKING", "gates_failed_retry"), false);
});

test("TODO, WORKING, and NEEDS_INPUT can all be cancelled", () => {
  assert.equal(transition("TODO", "cancel"), "CANCELLED");
  assert.equal(transition("WORKING", "cancel"), "CANCELLED");
  assert.equal(transition("NEEDS_INPUT", "cancel"), "CANCELLED");
});

test("REVIEW, DONE, and FAILED cannot be cancelled", () => {
  assert.throws(() => transition("REVIEW", "cancel"), InvalidTransitionError);
  assert.throws(() => transition("DONE", "cancel"), InvalidTransitionError);
  assert.throws(() => transition("FAILED", "cancel"), InvalidTransitionError);
});

test("CANCELLED has no outgoing transitions at all — it cannot be resumed or re-cancelled via the state machine", () => {
  assert.throws(() => transition("CANCELLED", "cancel"), InvalidTransitionError);
  assert.throws(() => transition("CANCELLED", "claim"), InvalidTransitionError);
  assert.throws(() => transition("CANCELLED", "answered"), InvalidTransitionError);
  assert.throws(() => transition("CANCELLED", "gates_passed"), InvalidTransitionError);
  assert.equal(canTransition("CANCELLED", "cancel"), false);
});
