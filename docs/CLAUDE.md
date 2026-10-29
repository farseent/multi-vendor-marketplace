# Multi-Vendor Marketplace — Development Instructions

## 1. Project context

This repository implements a multi-vendor marketplace. Follow the existing project documentation and implementation plan.

## 2. Source of truth

- `docs/PROJECT_MASTER.md`: requirements, stack, conventions.
- `docs/IMPLEMENTATION_PLAN.md`: phases and acceptance criteria.
- `docs/HANDOVER.md`: implementation status, completed work, known issues, next steps.
- `docs/ARCHITECTURE.md`: architecture and data flows.
- `docs/DATABASE_SCHEMA.md`: data models and invariants.
- `docs/API_CONTRACTS.md`: API contracts.
- `docs/DECISIONS.md`: recorded technical decisions.
- `docs/TESTING.md`: testing strategy and acceptance checks.

Verify actual repository paths if any path differs. Treat the repository as evidence of implemented behavior and the documentation as the intended contract. Report discrepancies instead of silently resolving them.

## 3. Engineering rules

- Preserve the documented modular-monolith architecture and existing conventions.
- Follow the documented stack, API response envelopes, validation, error handling, logging, authentication, authorization, and security requirements.
- Keep business logic in services and HTTP concerns in controllers.
- Enforce role and resource-ownership checks in the appropriate service layer.
- Store monetary values as integer paise, as specified in the project decisions.
- Never introduce secrets or put access tokens in localStorage.
- Inspect existing implementations and tests before changing code.
- Reuse established patterns. Avoid unrelated refactoring and unnecessary dependencies.
- Do not implement future phases or expand scope without approval.
- Do not assume a feature, file, command, or test exists without verifying it.

## 4. Context and token efficiency

At the start of each task:

1. Read `docs/HANDOVER.md`.
2. Identify the current phase and its acceptance criteria in `docs/IMPLEMENTATION_PLAN.md`.
3. Read only the relevant sections of other documents.
4. Search the repository and inspect only the source files, imports, and tests needed for the task.

Do not ask me to paste code already available through the connected repository. If access to a necessary file is unavailable, identify the exact file needed.

Do not reread or reproduce all project documentation unnecessarily. Do not rely on previous chat history as the record of project status; use the current handover and repository.

## 5. Work and verification

- For substantial changes, present a concise plan before implementation.
- Implement only the approved task.
- Run relevant tests and checks when the environment permits.
- Clearly distinguish checks that passed, failed, or could not be run.
- Never claim that code was tested, committed, pushed, or merged unless that action was actually completed and verified.
- Update `docs/HANDOVER.md` after implementation, recording completed work, changed files, verification results, known issues, remaining acceptance criteria, and the next recommended task.
- Update other documentation only when a contract, schema, architecture, or technical decision actually changes.

## 6. Task completion

Finish with:

1. What changed.
2. Important files changed.
3. Tests and checks with actual results.
4. Outstanding issues or unverified behavior.
5. Handover update.
6. A suggested conventional commit message.

Stop after the requested task and wait for my review before proceeding to the next task.
