# Provenance and "new project" statement

**Hackathon rule (Official Rules §4, "New & Existing"):** "Projects must be either newly created by the Entrant or, if the Entrant's Project existed prior to the Hackathon Submission Period, must have been significantly updated after the start of the Hackathon Submission Period."

**Submission Period:** Thu 1 Oct 2026, 9:15 am PT (= 1 Oct 2026, 21:45 IST) to Thu 12 Nov 2026, 12:00 pm PT (= Fri 13 Nov 2026, 01:30 IST).

## Statement

- Approvd is a **new project**. The repository was created on **28 Oct 2026 (IST)**, inside the Submission Period. No code predates the hackathon.
- The first commit is `chore: project skeleton, MIT license, env template` (28 Oct 2026, 14:14 +05:30). Every later commit is in the git history with its real timestamp. No dates were rewritten.
- **Runtime dependencies: none.** Only Node.js built-ins and the public PayPal REST sandbox API are used. No third-party code was copied in.
- **Design inspiration, no code reuse:** the policy idea (caps, allowlists, approvals) is the same general pattern the author uses elsewhere, for example in a separate NEAR hackathon prototype. Approvd's implementation was written from scratch for PayPal, and no files were shared.
- **Assistance:** the initial scaffold and code were produced with an AI coding assistant working under the entrant's direction. The Official Rules allow technical assistance provided "the Submission components are solely the Entrant's work product and the result of the Entrant's ideas and creativity, and the Entrant owns all rights to them." The entrant reviews, directs and owns the work. Commits authored by the assistant are labelled as such in git (`Forge (Jyothish build assistant)`).
- **Sponsor support:** none. No funding, contract or commercial licence from PayPal or Devpost (Official Rules §4, "Financial or Preferential Support").

## Commit log at time of writing

| Commit | Date (IST) | Message |
|---|---|---|
| 7bef247 | 2026-10-28 14:14 | chore: project skeleton, MIT license, env template |
| db328ab | 2026-10-28 14:15 | feat: PayPal gateway interface with offline simulator and REST sandbox adapter |
| 3e51a2b | 2026-10-28 14:16 | feat: tool catalogue with strict argument validation and spend-policy engine |
| 9adac07 | 2026-10-28 14:17 | feat: guarded executor, approval queue, audit ledger and tool-calling agent loop |
| 4755d42 | 2026-10-28 14:21 | feat: web console, HTTP API, simulated buyer approval page, CLI demo, MCP bridge and dispute triage |
| d70617e | 2026-10-28 14:22 | test: 42 tests ... |
| 11dd0f4 | 2026-10-28 14:23 | chore: Render blueprint, Dockerfile, screenshots |
| 5f708d7 | 2026-10-28 14:23 | feat: per-IP rate limit for the hosted demo |

Run `git log --format='%h %ad %s' --date=iso` for the current list.
