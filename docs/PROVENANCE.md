# Provenance and "new project" statement

**Hackathon rule (Official Rules §4, "New & Existing"):** "Projects must be either newly created by the Entrant or, if the Entrant's Project existed prior to the Hackathon Submission Period, must have been significantly updated after the start of the Hackathon Submission Period."

**Submission Period:** Thu 1 Oct 2026, 9:15 am PT (= 1 Oct 2026, 21:45 IST) to Thu 12 Nov 2026, 12:00 pm PT (= Fri 13 Nov 2026, 01:30 IST).

## Entrant

- **Entrant:** Akhilesh Patil ([github.com/akhilexx](https://github.com/akhilexx)), entering as an **Individual**.
- **Ownership:** the entrant owns all rights to this project (MIT licensed, © 2026 Akhilesh Patil). No other person or entity has any right or interest in it.

## Statement

- Approvd is a **new project**. The repository was created on **28 Oct 2026 (IST)**, inside the Submission Period. No code predates the hackathon.
- The first commit is `chore: project skeleton, MIT license, env template` (28 Oct 2026, 14:14 +05:30). Every later commit is in the git history with its real timestamp. No dates were rewritten.
- **Runtime dependencies: none.** Only Node.js built-ins and the public PayPal REST sandbox API are used. No third-party code was copied in.
- **Design inspiration, no code reuse:** the policy idea (caps, allowlists, approvals) is the same general pattern the author uses elsewhere, for example in a separate NEAR hackathon prototype. Approvd's implementation was written from scratch for PayPal, and no files were shared.
- **Assistance and authorship:** the initial scaffold, code, tests and docs were produced on 28 Oct 2026 by **Forge**, an AI build assistant working at the entrant's direction. The Official Rules allow technical assistance provided "the Submission components are solely the Entrant's work product and the result of the Entrant's ideas and creativity, and the Entrant owns all rights to them." The entrant chose the direction, reviews the work and owns it.
- **Commit authorship:** the commits were prepared by an AI build assistant at the entrant's direction and were re-attributed to the entrant's GitHub identity (`Akhilesh Patil`) before the first public push. Original timestamps are kept. The assistance is disclosed above.
- **Sponsor support:** none. No funding, contract or commercial licence from PayPal or Devpost (Official Rules §4, "Financial or Preferential Support").

## Commit log at time of writing

| Commit | Date (IST) | Message |
|---|---|---|
| 10c6c38 | 2026-10-28 14:14 | chore: project skeleton, MIT license, env template |
| d581dfa | 2026-10-28 14:15 | feat: PayPal gateway interface with offline simulator and REST sandbox adapter |
| 0ed67b7 | 2026-10-28 14:16 | feat: tool catalogue with strict argument validation and spend-policy engine |
| 9c64411 | 2026-10-28 14:17 | feat: guarded executor, approval queue, audit ledger and tool-calling agent loop (mock + OpenAI-compatible planners) |
| 40caacd | 2026-10-28 14:21 | feat: web console, HTTP API, simulated buyer approval page, CLI demo, MCP bridge and dispute triage |
| cec7662 | 2026-10-28 14:22 | test: 42 tests covering validation, policy, mock state machine, sandbox REST contract, agent loop, server and MCP |
| 1feb068 | 2026-10-28 14:23 | chore: Render blueprint, Dockerfile, console screenshots; record captured amount in ledger |
| 6f3d27a | 2026-10-28 14:23 | feat: per-IP rate limit for the hosted demo |
| 5c397a9 | 2026-10-28 14:24 | docs: README with architecture, judge walkthrough, sandbox setup; provenance statement |
| dd26a2f | 2026-10-28 14:25 | fix: mock dispute message text; clarify sandbox payouts setup |
| 59d9b19 | 2026-10-28 14:27 | chore: use a neutral test domain for the new-payee demo |
| ded94df | 2026-10-28 14:27 | docs: refresh provenance commit table |
| fd49223 | 2026-10-28 14:37 | docs: individual entrant Akhilesh Patil (@akhilexx) as owner; authorship disclosure |
| ca1df05 | 2026-10-28 22:15 | docs: update provenance note on commit authorship |
| 5a64c6f | 2026-10-28 22:30 | fix(sandbox): mirror live PAYER_ACTION_REQUIRED order status in mock; fix-it hints for sandbox account-setup errors; card test-order helper |
| 27a9040 | 2026-10-28 22:30 | test: live sandbox e2e runner with redaction + replay tests on recorded, redacted sandbox fixtures |
| c376818 | 2026-10-28 22:30 | docs: live sandbox verification status and account requirements |
| 9ac6a53 | 2026-10-28 22:38 | fix(sandbox): map Payouts error shape (code in name); live US sandbox e2e re-recorded: card capture, partial/full/over refund, payouts SUCCESS/UNCLAIMED, duplicate batch |
| 6c830ab | 2026-10-28 22:50 | feat(llm): Azure OpenAI provider (chat + Responses auto-switch), typed LLM errors, retries/timeouts, spend guard + circuit breaker with offline fallback; hosted-demo hardening (security headers, locked CORS, per-IP + daily caps, input/body limits, session turn cap, constant-time passcode, content-free logs); live Azure x PayPal sandbox e2e with redacted fixtures |
| 2d0d4e6 | 2026-10-28 22:52 | docs: US sandbox live results, Azure OpenAI provider + live LLM e2e results, hosted-demo protections, Render deploy steps |
| 136a1f9 | 2026-10-28 22:56 | test: record live sandbox capture, partial and full refund, over-refund fixtures |
| b9f133a | 2026-10-28 23:09 | docs: final Devpost status; optional UI_PLANNER_LABEL badge text; provenance table refresh |
| c3182aa | 2026-10-28 23:30 | Disputes v1 read tested live (redacted list/show/triage fixtures and replay tests, read-only e2e mode); agent completes chained requests |
| 0f39ad8 | 2026-10-28 23:33 | policy: deny refunds on a capture with an open PayPal dispute (refunding would settle it); read-only dispute lookup before each refund; mock + live-fixture tests |
| (this commit) | 2026-10-29 | style(console): light glass theme with locally bundled OFL fonts (Fraunces, Manrope); neutral AI badge (live LLM / offline planner); verdict badges; themed return and error pages |

Run `git log --format='%h %ad %s' --date=iso` for the current list.
