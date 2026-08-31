# AI Task Manager

An Autonomous Software Development Platform that takes plain-language tasks and drives them through investigation, implementation, testing, self-fix, and independent review against a connected project's repository.

## Overview

This platform is designed to automate software development workflows by acting as an intelligent agent. It understands tasks, performs necessary research in a codebase, implements changes, runs tests, and performs reviews, only interrupting a human when a genuine decision is required.

## Key Features

- **Autonomous Workflow**: Drives tasks from conception to completion.
- **Self-Correction**: Includes a self-fix loop to address failures during development.
- **Review System**: Implements an independent review step for quality assurance.
- **Project-Agnostic**: Designed to work against connected project repositories.

## Getting Started

### Prerequisites

- Node.js (>= 22.5.0)

### Installation

```bash
npm install
```

### Running the Backend

```bash
# Run the API server
npm run api

# Run the background worker
npm run worker
```

### Development

For local development, you can use:
```bash
npm run dev
```

### Running Tests

```bash
npm test
```

### Type Checking

```bash
npm run typecheck
```

## Documentation

For further information, please refer to the `docs/` directory:

- [Product Vision](./docs/PRODUCT_VISION.md)
- [Architecture](./docs/ARCHITECTURE.md)
- [Integration](./docs/INTEGRATION_ARCHITECTURE.md)
- [Security](./docs/SECURITY_ARCHITECTURE.md)

*See `CLAUDE.md` for governing rules for work on this repository.*
