# Product Vision

## The problem

AI can already write code quickly. The bottleneck is no longer generation speed — it is the human effort spent **operating** the AI: opening the right project, restating context, prompting, waiting, reviewing, re-prompting on failure, running tests, fixing, reviewing again, committing, deploying, and checking the result. This loop keeps a developer tethered to the screen even though the actual writing is done by the model.

## What we are building

An **Autonomous Software Development Platform**: a system that takes a plain-language task, independently drives it through investigation, implementation, testing, self-correction, and review, and only interrupts a human when a genuine decision is required.

This is explicitly **not** a chat-based coding assistant (not "another Cursor/Copilot"). The unit of interaction is not a prompt-response turn; it is a **task** that runs to completion (or to a well-defined decision point) without supervision.

## North Star

**Save developer time and increase developer productivity** by removing the "babysitting" work — continuous monitoring, prompting, and re-prompting — from the software delivery loop.

## The experience we are building toward

1. Developer opens the web dashboard (desktop, tablet, or mobile browser).
2. Developer picks a project and writes a task in plain language.
3. Developer leaves.
4. The system investigates the codebase, plans the change, implements it, tests it, fixes what fails, validates the result independently of the implementer's own claims, and prepares a report.
5. If the system hits a point where it cannot safely proceed without human judgment, it stops, explains exactly what it found and why it's stuck, and asks a specific, answerable question — then resumes automatically once answered.
6. Developer returns, reads a concise report or answers a question, and the task finishes.

## Governing principles

- **Do not proceed when uncertain, over guess and risk a change.** Reliability comes from layered, independent verification (tests, static analysis, an independent review pass, deterministic gates) — never from trusting a single model's self-report of "done."
- **Human time is the scarce resource.** Every design choice is evaluated against whether it removes human babysitting or reintroduces it.
- **Stack-, tool-, and vendor-agnostic.** The platform must work across arbitrary languages, frameworks, coding engines, source-control providers, and deployment systems. Project-specific behavior lives in configuration and per-project context files, never in platform code.
- **Simplicity over architectural novelty.** Multi-agent design is used only where it demonstrably improves reliability, not by default. See [AGENT_ARCHITECTURE.md](./AGENT_ARCHITECTURE.md).
- **One product, not a prototype.** The MVP is small in scope but built on a foundation (data model, abstractions, security posture) that does not need to be re-architected to become a real, multi-user, multi-tenant product later. See [MVP_SCOPE.md](./MVP_SCOPE.md).

## Platform vs. Project (read this before anything else)

These are two distinct things and the rest of the documentation set depends on keeping them separate:

- **The Platform** — the product itself: task management, orchestration, agent execution, integrations, auth, persistence, audit, UI. This repository.
- **A connected Project** — an external codebase (e.g. OTT, E-True, XYZ) the platform operates on. It owns its own source code, tests, tech stack, deployment pipeline, and project-specific context/instruction files. The platform never embeds project-specific logic in its own codebase.

See [CONTEXT_ARCHITECTURE.md](./CONTEXT_ARCHITECTURE.md) for how platform-level and project-level instructions are kept separate and non-duplicative.

## Non-goals (for the product, not just the MVP)

- Not a general chatbot / IDE plugin.
- Not a replacement for human code ownership and accountability — a human approves anything that ships to production.
- Not committed to any single coding engine, source-control host, cloud provider, or CI/CD system.
- Not a native mobile app — one responsive web app serves all screen sizes.
