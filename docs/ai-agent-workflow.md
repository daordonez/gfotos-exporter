# AI Agent Workflow

## Purpose

This repository uses GitHub Copilot cloud agent profiles to turn a well-defined
issue into a traceable pull request. The issue remains the source of truth for
scope, acceptance criteria, branch strategy, authority limits, and required
manual validation.

The profiles are intentionally narrow:

| Profile | Responsibility | Tools |
| --- | --- | --- |
| `issue-coordinator` | Plan, delegate, integrate, check criteria, and prepare evidence | Read, search, edit, execute, custom-agent delegation, read-only GitHub context |
| `typescript-backend` | TypeScript implementation and focused native Node tests | Read, search, edit, execute |
| `devops-ci` | CI, package, workflow, release-process review, and independent CI evidence | Read, search, edit, execute, read-only GitHub context |

No profile receives a write-capable MCP server, repository secret, repository
administration permission, merge capability, release capability, or permission
to bypass a ruleset. Copilot's normal task capability can create commits and one
draft pull request on its own task branch; it is not a substitute for those
privileges.

## Repository configuration

`.github/workflows/copilot-setup-steps.yml` installs the exact Node and pnpm
toolchain plus locked dependencies before a cloud-agent session starts. It has
only `contents: read` permission. The setup workflow must remain on the default
branch before GitHub uses it for agent sessions.

Repository-wide instructions live in `.github/copilot-instructions.md`.
Path-specific TypeScript and workflow instructions live under
`.github/instructions/`. The custom agent profiles live under `.github/agents/`.

## Operating sequence

1. Create an issue using the `Agent-ready engineering issue` form, or ensure an
   existing issue contains equivalent objective, scope, exclusions, acceptance
   criteria, validation, dependency, branch, and authority information.
2. Assign the issue to Copilot and select `issue-coordinator`. The coordinator
   reads the full contract, then calls the TypeScript and DevOps specialists
   through the custom-agent tool where their expertise applies.
3. The coordinator combines the specialist results, runs the required commands,
   and creates a draft pull request that targets the base branch selected for
   that cloud-agent task.
4. GitHub Actions validates the pull request. The coordinator records actual
   results and manual-check limitations in the pull request description.
5. A human reviews and merges only after the required status checks and issue
   acceptance criteria are satisfied.

## Coordinating an epic

For an issue that declares child issues or an integration branch, the
coordinator first reads the complete parent contract and every child contract.
It then enforces their declared order, branch base, pull-request target,
validation gates, and authority limits. A child issue must state these values;
the coordinator must not invent them.

GitHub Copilot cloud agent has a hard boundary: one session works on one branch
and can open one pull request. It cannot merge pull requests or push directly
to `main`. A coordinator can delegate specialist work inside its session, but
that is not a GitHub pull-request or merge orchestration service. Separate child
pull requests require separate agent sessions or an external, reviewed
orchestrator.

This repository is public, so GitHub Copilot Automations are not available for
event-driven dispatch. To eliminate human task dispatch across a future epic,
move the repository to private or internal visibility and assess Copilot
Automations, or deploy a separately reviewed GitHub App or Actions-based
orchestrator with narrowly scoped credentials. Neither option removes the
required human review before merging Copilot pull requests.

## Required GitHub settings

Before assigning work, a repository administrator must verify:

1. A paid Copilot plan is active and Copilot cloud agent is enabled for this
   repository.
2. Built-in Copilot code-quality and security validation remain enabled.
3. `main` requires a pull request and the `Validate` status check, with no
   Copilot bypass actor.
4. `Require approval for workflow runs` is disabled only if automatic Actions
   validation of unreviewed Copilot pull requests is an accepted risk. Otherwise
   a user with write access must approve each run.
5. No Agents secret or MCP server is configured unless a concrete requirement
   exists. Add only the exact secret and tool needed, scoped to one profile when
   possible.

The existing `main` ruleset already requires a pull request, `Validate`, and
resolved review threads. Keep those controls in place.
