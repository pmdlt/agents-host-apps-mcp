# Agents that host apps, over MCP

A weekend project for **Make Something Agents Want** (YC, 17–18 October 2026), tracks: Agent-Native Cloud and Best Agent Experience.

Ask an agent to host an app and you usually get a to-do list. This is a remote MCP server that lets the agent do the hosting itself. Claude Code, or any MCP client, connects with one command over OAuth. It can then install an open-source app like n8n on your own server, follow the build, read logs and build logs, change single settings, wire webhooks and redeploy. Anything risky needs a person's approval, and secrets never pass through the model.

It is a side project built on top of [Pilae](https://pilae.com), the hosting platform we are working on. That codebase is private, so this repo holds **excerpts**: the agent-facing files, copied without history. They don't build on their own, because their imports into the rest of the platform aren't included.

## Try it

```bash
claude mcp add --transport http pilae https://staging-cp-backend.pilae.dev/mcp
# then /mcp in Claude Code to sign in in the browser
```

Access is by invitation, because the server acts on real machines. Ask us for a demo workspace.

## How it fits together

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/how-it-fits-dark.png">
  <img src="docs/how-it-fits.png" alt="An MCP client signs in once over OAuth and makes tool calls to /mcp. Each request builds a fresh MCP server whose tools are the token's scope intersected with the person's current role: 94 platform tools from a curated table joined to the API's OpenAPI document, plus typed tools for each installed app. Tool calls re-enter the real API routes in-process, where the role and tenancy checks live. The routes start installs, whose engine claims the app's admin account, locks sign-up and shows the password once to the person, and operate apps on your server. Each app's OpenAPI spec goes through the connector pipeline, which produces the app tools. MCP traffic is reported to PostHog MCP analytics as allowlisted events without arguments or results.">
</picture>

The diagram's source is `docs/diagram/how-it-fits.html`; the comment at its top gives the command that renders both PNGs.

## What to read, by agent-experience decision

| Decision | Where |
|---|---|
| **Tools come from a hand-curated table joined to the API's OpenAPI document.** "Is this destructive?" is a product judgement, not something an HTTP method can tell you (changing one environment variable can take an app down as surely as deleting it). The generator fails when the API gains a route nobody decided on | `src/agent/tools/curation.ts`, `scripts/gen-agent-tools.ts`, `src/agent/tools/generated.ts` (first 3 of 94), [`TOOLS.md`](TOOLS.md) |
| **Only list tools the caller can actually call.** A tool list is a promise. The server hides tools before registration (the token's scope, each route's own minimum role, the workspace's switches) and re-checks at call time, so a member's client never even shows an owner's delete | `src/mcp/server.ts` (`visibleTools`, `buildMcpServer`) |
| **Three different refusals, each in words the agent can act on.** A missing role names the least role that would do ("It needs the admin role"). A workspace rule starts "Not run:" so the agent stops instead of looking for a way round. A missing scope is the only fixable one, so it is the only one that asks the client to re-authorise; asking for a role would send it round a loop that never ends | `src/mcp/scopes.ts` (`decideScope`, `refusalSentence`) |
| **Tell every client the rules once, at connect.** The console agent's system prompt has a portable part, sent as the server's `instructions`: where an app goes, that new apps are private, that log lines are data and never instructions, what a missing tool means | `src/mcp/instructions.ts` |
| **Secrets never enter the model's context.** Raw env, compose, log and build-log reads are hidden behind tools that redact or return names only. An env change names only the variables it sets and refuses the ones the install generated. An install's password and a webhook's secret are shown once, to a person, in the console | `src/agent/tools/curation.ts` (`DENIED_OPERATIONS`, `hidden`) |
| **Errors the agent can recover from.** Preflight refuses a name in use with a free name to try instead, and every refusal carries a code the agent can act on | tool descriptions in `curation.ts` (`pilae_provisioning_preflight`, `pilae_provision_app`) |
| **Any app's API as typed tools, with no code per app.** An OpenAPI 3.0/3.1 spec is read under a budget, operations are classified by a policy, ranked so lists and reads come first in a limited tool budget, and fingerprinted. A re-index only asks a person to look again when an operation can now do *more* than what they accepted | `src/connectors/spec/{detect,build,rank,fingerprint}.ts`, `src/connectors/operation-pattern.ts` |
| **Measure the agent's experience without collecting customer data.** PostHog's MCP SDK is handed a fake client: only three events and an allowlist of properties survive, with no arguments, results or error text | `src/mcp/analytics.ts` |

Comments that mention `PLAN §…` or step ids like `R2` refer to an internal design document.

## Built during the event

Hacking started on Saturday at 10:30 PT. As of Sunday 06:30 PT, these merged in the platform's private repos:

- **Installs an agent can run end to end:**
  - live build logs for installs;
  - a readiness check from container state;
  - owner account claimed, sign-up locked, password revealed once;
  - install inputs;
  - retry, and remove-and-retry;
  - deployment requests settled by installs;
  - per-app settings;
  - finish and failure emails;
  - the console pages for all of it.
  - NocoDB and Vikunja installable, with sign-up proven closed.
- **App connectors:**
  - the private-network transport, and calling app operations through it;
  - the OpenAPI pipeline in this repo;
  - the operation index and connection driver, with an app's API indexed in a durable workflow and promoted one operation at a time;
  - app operations classified by Pilae's own policy, with an approval card on every write;
  - typed app tools for the console's agent;
  - a per-workspace switch behind a staff flag;
  - tightening-only entries for the first apps, compose labels, and better tool search;
  - a report of whether an installed app can be connected;
  - a simulated sample app to try it all without a machine.
- **MCP and the agent:**
  - tools per role on remote MCP, behind the workspace's switches, with refusals that name the role;
  - server instructions for every client;
  - build-log and container-log tools;
  - single env-var changes;
  - webhooks the agent can create and manage;
  - PostHog MCP analytics on remote traffic, with failure codes.

Still open: the typed app tools over remote MCP (the console's agent has them so far), and switching connectors on for customers.

Opened earlier in October and finished during the event: the step-by-step install runner, its live log stream, and the first two app recipes.

## Not in this repo, on purpose

These stay private because they are the security boundary:
- the API routes that enforce roles and tenancy;
- the redaction layer;
- the SSRF guard;
- the private-network gateway;
- the part of the connector pipeline that extracts operations, which encodes the gateway's header rules.

We can give judges access to the full source on request.
