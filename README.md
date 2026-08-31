# Autonomous Software Development Platform

This repository contains the code for an Autonomous Software Development Platform.

## Vision

The platform is an autonomous system that takes a plain-language task, independently drives it through investigation, implementation, testing, self-correction, and review, and only interrupts a human when a genuine decision is required.

It is designed to save developer time and increase productivity by removing the "babysitting" work—continuous monitoring, prompting, and re-prompting—from the software delivery loop.

## Key Features

- **Autonomous Task Execution:** Tasks run from creation to completion (or decision point) without supervision.
- **Evidence-Based Completion:** Tasks require independent validation (tests, static analysis, review) before being marked as done.
- **Human-in-the-Loop:** Only interrupts humans for genuine decisions, providing clear reports and answerable questions.
- **Stack & Vendor Agnostic:** Designed to work across arbitrary languages, frameworks, and source-control providers via adapters.
- **Responsive Web UI:** A single, responsive dashboard for managing tasks across projects.

## Documentation

For a deep dive into the architecture and design, see the [docs/](./docs) directory:

- [Product Vision](./docs/PRODUCT_VISION.md)
- [Product Requirements](./docs/PRODUCT_REQUIREMENTS.md)
- [Architecture](./docs/ARCHITECTURE.md)
- [Agent Architecture](./docs/AGENT_ARCHITECTURE.md)

## Running the Repo

### Backend
- Ensure `npm` is installed.
- `npm install`
- `npm run typecheck`
- `npm test`
- `npm run api` / `npm run worker` (or `npm run dev` for local convenience)

### Frontend
- `cd web && npm install`
- `npm run dev`

See [CLAUDE.md](./CLAUDE.md) for detailed setup, local data management, and development instructions.
