// Excerpt from a private codebase, shared for the Make Something Agents Want hackathon (README.md).
// Imports that point outside this folder are not included, so this does not build on its own.

import type { OrgRole } from "../../middleware/session";

/**
 * Which of the API's operations the agent may call, and what each one means.
 *
 * This table is written by hand on purpose. Deriving tools from the OpenAPI
 * document automatically would be less code and a worse idea: "is this
 * destructive" and "does a human have to confirm it" are product judgements, not
 * facts an HTTP method can carry. `DELETE` is destructive, but so is
 * `PATCH /env` — it overwrites or removes values nobody in the conversation can
 * see, and dropping a variable takes an app down as surely as deleting it does.
 *
 * The generator (`scripts/gen-agent-tools.ts`) reads this table, joins each row
 * to its operation in the committed OpenAPI snapshot for the input schema, and
 * emits `generated.ts`. It FAILS if the snapshot contains an operation that is
 * neither listed here nor explicitly denied below — so adding a route to the API
 * forces a decision about whether the agent gets it, rather than silently
 * granting or silently withholding it.
 */

/** Coarse bucket used by per-step tool selection, not by authorization. */
export type ToolGroup = "core" | "read" | "operate" | "destroy";

/** OAuth scope the remote MCP surface will gate this tool behind. */
export type ToolScope = "read" | "write" | "destructive";

export interface CuratedTool {
  /** Tool name as the model sees it. */
  name: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Path WITH the `/v1` prefix, exactly as the OpenAPI document spells it. */
  path: string;
  group: ToolGroup;
  scope: ToolScope;
  /**
   * The role the underlying route requires: its `x-min-role`, or `member` when
   * the route declares no gate.
   *
   * Held equal to the route, never a second opinion of it. The catalogue check
   * (`catalogueProblems` in scripts/agent-tools/catalogue-lib.ts, which the
   * generator runs and `test/agent/catalogue.test.ts` runs again) fails when the
   * two differ, so a gate raised or lowered on the route makes this row follow.
   *
   * It decides which tools a caller is OFFERED: a console turn shows the model
   * only the tools the member's role reaches (`pilaeToolsForRole` in
   * `select.ts`) and names the others under the role each needs
   * (`withheldTools`), so the agent says "that needs the owner role" instead of
   * raising a card whose only outcome is a 403. It is not what refuses a call:
   * every tool stays registered, every call re-enters its route, and the
   * route's `orgRoleGate` is still the enforcement, so a check made from this
   * field is never the only one.
   */
  minRole: OrgRole;
  /** Changes state. Everything that is not a read. */
  mutation: boolean;
  /**
   * Loses data or takes something away that cannot be put back by repeating the
   * call. Always requires human confirmation, whatever the workspace's
   * auto-apply setting says.
   */
  destructive: boolean;
  /**
   * Registered but never offered to the model by default.
   *
   * Used where another tool covers the same ground more safely — the two
   * env/compose reads return raw values, and the agent gets keys-only views
   * instead so a password never enters the model's context; the whole-env
   * replacement would rewrite values the agent cannot see, and
   * `pilae_services_env_update` changes only the variables it names.
   */
  hidden?: boolean;
  /**
   * What the model reads about the tool, in place of the route's summary and
   * description (which it gets, joined, when this is absent). Given where the
   * route's words, written for people, would mislead a model, or where the
   * tool needs a rule the route does not state.
   */
  description?: string;
}

/**
 * Operations the agent may never call, with the reason.
 *
 * Denial here is belt; `isDeniedGrantPath` in lib/agent-grant.ts is braces — it
 * refuses the same paths at spend time no matter what this table says.
 */
export const DENIED_OPERATIONS: Record<string, string> = {
  "GET /healthz": "Infrastructure probe; nothing for a customer to act on.",
  // Staff surface. The agent acts as a customer, never as Pilae.
  "GET /v1/admin/*": "Staff-only.",
  // The agent must not read or rewrite its own policy, budget or conversations.
  "GET /v1/agent/*": "The agent does not operate itself.",
  // Identity, membership and workspace settings are deliberately human-only:
  // they are the controls that would let an agent widen its own access.
  "GET /v1/account": "Identity; human-only.",
  "PATCH /v1/account": "Identity; human-only.",
  "GET /v1/organizations": "Membership; human-only.",
  "POST /v1/organizations/switch": "Switching tenants mid-conversation is never right.",
  // Documented as unsupported: the route exists to say so and performs no
  // upstream call. Offering it would only teach the model to try.
  "POST /v1/services/{kind}/{id}/cancel-deployment": "Not supported upstream.",
  // Supports Pilae's own consent screen and nothing else. It tells a browser
  // who is asking for access; there is no question a customer could put to the
  // agent that this answers, and an agent reading it would only be reading back
  // the names of the customer's own integrations.
  "GET /v1/oauth/consent-context": "Supports the consent screen; not an agent capability.",
  // Badge numbers for the console's navigation. The agent reads the lists
  // themselves, which name what a count only tallies, so a second way to ask
  // "how many" would only hand the model two answers to reconcile.
  "GET /v1/nav-summary": "Console navigation counts; the lists answer the same question.",
  // A person's own connected applications. Denied for the same reason as
  // `/v1/account`: this is identity, and an agent that could revoke — or
  // enumerate — the customer's integrations is an agent operating the human
  // rather than the workspace.
  "GET /v1/account/mcp-clients": "Identity; human-only.",
  "DELETE /v1/account/mcp-clients/{clientId}": "Identity; human-only.",
  // Customer file storage, not application operation. Deleting a customer's
  // documents is irreversible and has no hosting upside, so the whole family is
  // out of scope for v1 rather than just the upload path.
  "POST /v1/documents/folders": "Document storage is out of scope for the agent.",
  "PATCH /v1/documents/{id}": "Document storage is out of scope for the agent.",
  "DELETE /v1/documents/{id}": "Document storage is out of scope for the agent.",
  // Booking a call puts a meeting in both founders' calendars and emails the
  // member an invite. A person asks for a call; an agent never books one.
  "GET /v1/support/slots": "Booking a call with Pilae is human-only.",
  "POST /v1/support/bookings": "Booking a call with Pilae is human-only.",
  // A database's password must never enter the model's context — the same rule
  // that hides the raw env read — and rotating it hands a new one back in the
  // response while breaking every client still on the old one.
  "GET /v1/services/{kind}/{id}/connection": "Returns a database password; human-only.",
  // An install's one-time sign-in: shown once, to the member who started it,
  // in the console. The route answers every agent grant 404 as well.
  "POST /v1/provisioning/runs/{id}/credentials/reveal":
    "Returns an app's password, once, to the member who installed it; human-only.",
  // "Try again", and above all "Remove and try again", which deletes what the
  // failed attempt left behind: a person's call, made on the install page with
  // the attempt in front of them. The agent starts a new install instead
  // (`pilae_provision_app`, whose NAME_IN_USE comes with a free name). The
  // route refuses an agent grant as well (AGENT_NOT_ALLOWED), and a run's
  // `viewer` never offers it one.
  "POST /v1/provisioning/runs/{id}/retry":
    "Trying an install again, and removing its failed attempt, is done on its install page.",
  "POST /v1/services/{kind}/{id}/rotate-password": "Returns a database password; human-only.",
  // An installed app's own settings, Vikunja's "Allow new sign-ups" first:
  // turned on, anyone who can reach the app can make an account in it. A
  // person decides that on the app's page, and reads it there, until the
  // agent's tools and the console's cards for them are decided together.
  "GET /v1/services/{kind}/{id}/app-settings":
    "An installed app's own settings, read on its page in the console; human-only for now.",
  "PUT /v1/services/{kind}/{id}/app-settings":
    "Can open an app's sign-up to anyone who reaches it; an admin decides that on its page.",
  // Overwrites a database's live data from a dump. The console's typed-name
  // confirmation is the control; an agent proposing it would bypass that.
  "POST /v1/services/{kind}/{id}/restores": "Overwrites live data; human-only.",
  // The route replaces the file whole, and the agent reads only its service
  // names and images (`pilae_compose_services`), never the file: the secrets
  // inlined in it must stay out of the model's context. So whatever the agent
  // wrote would be a new file, losing everything it could not see.
  "PUT /v1/services/compose/{id}/compose-file":
    "Replacing a compose file needs its full contents, which never enter the agent's context; people edit it in the console.",
  // Thresholds decide when the workspace's owners and admins are emailed about
  // their machines. Loosening them silences the alerts meant to catch a
  // problem — the agent's own included — so it is a human decision. Reading
  // them is fine (`pilae_alerts_settings`).
  "PUT /v1/alerts/settings": "Alert thresholds are a human decision.",
  // Workflow secret VALUES never pass through the agent: the agent lists names
  // and tells the customer where to add one. The routes refuse an agent grant
  // as well (AGENT_NOT_ALLOWED), because the GET list shares their path and so
  // cannot be denied by prefix.
  "PUT /v1/workflow-secrets/{name}":
    "Secret values never pass through the agent; members set them in the console.",
  "DELETE /v1/workflow-secrets/{name}": "Secrets are managed by people in the console.",
  // Webhooks: the agent lists, creates, changes and deletes them (curated
  // below, every write on a card), and never holds a secret, because the
  // create route answers none to an agent grant (`withheld`). What stays with
  // people in the console: rotating a secret, whose only purpose is to show
  // one, and every domain write, since a customer domain is a billed resource.
  // Those routes refuse an agent grant as well (AGENT_NOT_ALLOWED).
  //
  // The two lists are offered (`pilae_workflows_hooks_list`,
  // `pilae_workflows_hook_hosts_list`), so the agent can say which workflow a
  // webhook starts and at what address. Neither carries a secret, a signing key
  // or a token (`serializeHook`), and an address is not a credential: the org's
  // one host is in every address it hands an integration, and a customer domain
  // is in public DNS, so only the bearer secret or the signature protects a
  // hook. One that checks neither is public by design (the console calls it
  // that), and every member reads the same list there.
  "POST /v1/workflow-hooks/hosts":
    "A webhook domain is a billed resource; people add one in the console.",
  "POST /v1/workflow-hooks/hosts/{hostname}/recheck":
    "Webhook domains are managed by people in the console.",
  "DELETE /v1/workflow-hooks/hosts/{hostname}":
    "Webhook domains are managed by people in the console.",
  "POST /v1/workflow-hooks/{hook}/rotate-secret":
    "Rotating answers the new secret, and webhook secrets never pass through the agent; people rotate them in the console.",
  // A run's live feed, the install page's polling transport. The agent follows
  // an install through `pilae_provisioning_status`, whose phases and failure
  // already say what happened, in fewer tokens than a build log. A grant may
  // still read these (nothing secret is in them); they are just not tools.
  "GET /v1/runs/{kind}/{id}/events": "The install page's live feed; the agent reads the run.",
  "GET /v1/runs/{kind}/{id}/phases/{phase}/logs":
    "The install page's live feed; the agent reads the run.",
};

/** True when `key` (e.g. `GET /v1/admin/instances`) is denied by the table. */
export function isDeniedOperation(method: string, path: string): boolean {
  const key = `${method.toUpperCase()} ${path}`;
  if (key in DENIED_OPERATIONS) return true;
  // Wildcard families.
  if (path.startsWith("/v1/admin/") || path === "/v1/admin") return true;
  if (path.startsWith("/v1/agent/") || path === "/v1/agent") return true;
  return false;
}

const read = (
  name: string,
  method: CuratedTool["method"],
  path: string,
  extra: Partial<CuratedTool> = {},
): CuratedTool => ({
  name,
  method,
  path,
  group: "read",
  scope: "read",
  minRole: "member",
  mutation: false,
  destructive: false,
  ...extra,
});

const operate = (
  name: string,
  method: CuratedTool["method"],
  path: string,
  minRole: OrgRole,
  extra: Partial<CuratedTool> = {},
): CuratedTool => ({
  name,
  method,
  path,
  group: "operate",
  scope: "write",
  minRole,
  mutation: true,
  destructive: false,
  ...extra,
});

const destroy = (
  name: string,
  method: CuratedTool["method"],
  path: string,
  minRole: OrgRole,
  extra: Partial<CuratedTool> = {},
): CuratedTool => ({
  name,
  method,
  path,
  group: "destroy",
  scope: "destructive",
  minRole,
  mutation: true,
  destructive: true,
  ...extra,
});

export const CURATED_TOOLS: CuratedTool[] = [
  // ─── Services: read ──────────────────────────────────────────────────────
  read("pilae_services_list", "GET", "/v1/services", { group: "core" }),
  read("pilae_services_get", "GET", "/v1/services/{kind}/{id}", { group: "core" }),
  read("pilae_services_deployments", "GET", "/v1/services/{kind}/{id}/deployments", {
    description:
      "A service's deployment history, newest first: each attempt's status, timing and error " +
      "message. To see why a deployment failed, read its build log with pilae_read_deploy_log.",
  }),
  read("pilae_services_domains_list", "GET", "/v1/services/{kind}/{id}/domains"),
  read("pilae_services_public_access", "GET", "/v1/services/{kind}/{id}/public-access"),
  read("pilae_services_ports_list", "GET", "/v1/services/{kind}/{id}/ports"),
  read("pilae_services_mounts_list", "GET", "/v1/services/{kind}/{id}/mounts"),
  // Hidden: `pilae_read_logs` wraps this one with redaction and an untrusted
  // marker, and the raw route would put unredacted log lines in the transcript.
  read("pilae_services_logs_raw", "GET", "/v1/services/{kind}/{id}/logs", { hidden: true }),
  // Hidden for the same reason: a build log is text the customer's code and
  // every dependency it installs wrote. `pilae_read_deploy_log` is what the
  // model gets.
  read(
    "pilae_services_deployment_log_raw",
    "GET",
    "/v1/services/{kind}/{id}/deployments/{deploymentId}/log",
    { hidden: true },
  ),
  // Hidden: both return VALUES. `pilae_env_keys` and `pilae_compose_services`
  // are what the model gets; a value only ever reaches the browser, through the
  // owner-approved reveal.
  read("pilae_services_env_raw", "GET", "/v1/services/{kind}/{id}/env", {
    minRole: "admin",
    hidden: true,
  }),
  read("pilae_services_compose_file_raw", "GET", "/v1/services/compose/{id}/compose-file", {
    minRole: "admin",
    hidden: true,
  }),

  // ─── Services: operate ───────────────────────────────────────────────────
  operate("pilae_services_create", "POST", "/v1/services/{kind}", "admin"),
  // Curated: the route's "env and compose file have their own routes" would
  // send the model looking for a compose-file write it is not offered.
  operate("pilae_services_update", "PATCH", "/v1/services/{kind}/{id}", "admin", {
    description:
      "Change a service's settings: name, description, image, command, replicas, CPU and " +
      "memory limits and reservations, external port, stack type. Applies on the next deploy, " +
      "except a database's external port, which redeploys the database at once. " +
      "Environment variables change with pilae_services_env_update; an app stack's compose " +
      "file is edited by people in the console.",
  }),
  operate("pilae_services_deploy", "POST", "/v1/services/{kind}/{id}/deploy", "admin"),
  operate("pilae_services_redeploy", "POST", "/v1/services/{kind}/{id}/redeploy", "admin"),
  operate("pilae_services_start", "POST", "/v1/services/{kind}/{id}/start", "admin"),
  // Stopping is reversible but takes a running application offline, so it is
  // treated as destructive for approval purposes even though nothing is lost.
  operate("pilae_services_stop", "POST", "/v1/services/{kind}/{id}/stop", "admin", {
    destructive: true,
    group: "destroy",
    scope: "destructive",
  }),
  // The agent's way to change an environment. It names what to set and what
  // to remove, and the route keeps everything else, values it never saw
  // included. Still destructive: it overwrites or removes values the agent
  // cannot see, so the customer confirms every change on a card.
  operate("pilae_services_env_update", "PATCH", "/v1/services/{kind}/{id}/env", "admin", {
    destructive: true,
    group: "destroy",
    scope: "destructive",
    description:
      "Add, change or remove individual environment variables of a service. Every variable " +
      "not named is kept as it is; values are never returned. Put every change to one service " +
      "in a single call. Set a value only when it is not a secret (an address, a port, a " +
      "switch); never ask the customer to paste a secret into the conversation: they set " +
      "those in the console. On an app Pilae installed, leave alone the variables Pilae set it " +
      "up with (its generated passwords and keys, its owner account, its address): a change " +
      "naming one is refused, and the refusal names them. Applies on the next deploy.",
  }),
  // Hidden: `pilae_services_env_update` covers it without losing values. A
  // full replacement from the agent rewrote every value it cannot see.
  operate("pilae_services_env_replace", "PUT", "/v1/services/{kind}/{id}/env", "admin", {
    destructive: true,
    group: "destroy",
    scope: "destructive",
    hidden: true,
    description:
      "Replace a service's entire environment. Every variable not included is removed. " +
      "Read the current keys first and send the complete set.",
  }),
  operate("pilae_services_domain_add", "POST", "/v1/services/{kind}/{id}/domains", "admin"),
  operate(
    "pilae_services_domain_update",
    "PATCH",
    "/v1/services/{kind}/{id}/domains/{domainId}",
    "admin",
  ),
  // Putting an app on the internet, or taking it off. A card either way: some
  // customers never want an app facing the internet.
  operate(
    "pilae_services_public_access_set",
    "PUT",
    "/v1/services/{kind}/{id}/public-access",
    "admin",
  ),
  operate("pilae_services_port_add", "POST", "/v1/services/{kind}/{id}/ports", "admin"),
  operate("pilae_services_mount_add", "POST", "/v1/services/{kind}/{id}/mounts", "admin"),

  // ─── Services: destroy ───────────────────────────────────────────────────
  // What goes with the service is said here because the customer asks: an app
  // stack takes its data with it since 2026-10-14, a swarm stack, an
  // application or a database still leaves its volume behind (no option
  // upstream, or one it ignores).
  destroy("pilae_services_delete", "DELETE", "/v1/services/{kind}/{id}", "owner", {
    description:
      "Delete a service. Deleting an app stack (kind compose) deletes its data on the machine " +
      "too, for good, unless it is a swarm stack (composeType stack), which leaves its data on " +
      "the machine; backups already sent to a backup destination are kept. Deleting an " +
      "application or a database (an installed PostgreSQL included) removes the service but " +
      "leaves its stored data on the machine.",
  }),
  destroy(
    "pilae_services_domain_remove",
    "DELETE",
    "/v1/services/{kind}/{id}/domains/{domainId}",
    "admin",
  ),
  destroy(
    "pilae_services_port_remove",
    "DELETE",
    "/v1/services/{kind}/{id}/ports/{portId}",
    "admin",
  ),
  destroy(
    "pilae_services_mount_remove",
    "DELETE",
    "/v1/services/{kind}/{id}/mounts/{mountId}",
    "admin",
  ),

  // ─── Projects ────────────────────────────────────────────────────────────
  read("pilae_projects_list", "GET", "/v1/projects", { group: "core" }),
  read("pilae_projects_get", "GET", "/v1/projects/{id}"),
  operate("pilae_projects_create", "POST", "/v1/projects", "admin"),
  operate("pilae_projects_update", "PATCH", "/v1/projects/{id}", "admin"),
  destroy("pilae_projects_delete", "DELETE", "/v1/projects/{id}", "owner"),

  // ─── Backups ─────────────────────────────────────────────────────────────
  read("pilae_backups_list", "GET", "/v1/services/{kind}/{id}/backups"),
  read("pilae_backups_runs", "GET", "/v1/backups/{backupId}/runs"),
  read("pilae_restores_list", "GET", "/v1/restores"),
  read("pilae_backup_files", "GET", "/v1/services/{kind}/{id}/backups/{backupId}/files"),
  operate("pilae_backups_create", "POST", "/v1/services/{kind}/{id}/backups", "owner"),
  operate("pilae_backups_run", "POST", "/v1/services/{kind}/{id}/backups/{backupId}/run", "admin"),
  operate(
    "pilae_volume_backups_create",
    "POST",
    "/v1/services/{kind}/{id}/volume-backups",
    "owner",
  ),
  operate(
    "pilae_volume_backups_run",
    "POST",
    "/v1/services/{kind}/{id}/volume-backups/{volumeBackupId}/run",
    "admin",
  ),
  destroy("pilae_backups_delete", "DELETE", "/v1/services/{kind}/{id}/backups/{backupId}", "owner"),
  destroy(
    "pilae_volume_backups_delete",
    "DELETE",
    "/v1/services/{kind}/{id}/volume-backups/{volumeBackupId}",
    "owner",
  ),

  // ─── Destinations ────────────────────────────────────────────────────────
  read("pilae_destinations_list", "GET", "/v1/destinations"),
  operate("pilae_destinations_create", "POST", "/v1/destinations", "owner"),
  operate("pilae_destinations_update", "PATCH", "/v1/destinations/{id}", "owner"),
  destroy("pilae_destinations_delete", "DELETE", "/v1/destinations/{id}", "owner"),

  // ─── Workspace context ───────────────────────────────────────────────────
  // Both answer each machine's live `monitoring`, whose `lost` state is the
  // one a model most readily turns into "your machine is down" — so the rule
  // is on every tool that returns it, not only on the metrics read.
  //
  // `platform-host` is the platform's own server, listed only for a workspace
  // it is effectively the machine of. Its host-level numbers cover everything
  // running on it, so each tool that can return it says what it is.
  read("pilae_machines_list", "GET", "/v1/machines", {
    description:
      "The workspace's machines, each with its live usage in `monitoring` (null when usage is " +
      "not collected for it). An entry with id `platform-host` (`isPlatformHost: true`) is the " +
      "platform's own server, where apps not placed on one of the workspace's machines run. A " +
      "`lost` state means monitoring lost contact with the machine — never say the machine is " +
      "down.",
  }),
  read("pilae_machines_get", "GET", "/v1/machines/{id}", {
    description:
      "One machine, with its live usage in `monitoring` (null when usage is not collected for " +
      "it). The id `platform-host` is the platform's own server, where apps not placed on one " +
      "of the workspace's machines run. A `lost` state means monitoring lost contact with the " +
      "machine — never say the machine is down.",
  }),
  // Usage reads lead with `summary`: a 24h series is ~70 points, and the
  // result cap keeps only the first few kilobytes of anything larger — the
  // routes put the summary before the points so that cap never cuts it.
  read("pilae_machines_metrics", "GET", "/v1/machines/{id}/metrics", {
    description:
      "How loaded a machine is over a time range: CPU, memory, disk, network and load. Answer " +
      "from `monitoring` (now) and `summary` (min/avg/max/last over the range); `points` is the " +
      "series behind it, where null is a gap in the data, not zero. The id `platform-host` is " +
      "the platform's own server; its numbers cover everything running on it. A `lost` state " +
      "means monitoring lost contact with the machine — never say the machine is down.",
  }),
  read("pilae_services_metrics", "GET", "/v1/services/{kind}/{id}/metrics", {
    description:
      "How much CPU (in cores), memory and network one service uses over a time range, with its " +
      "configured limits and its machine's size beside them. Answer from `summary` first. " +
      "NOT_MONITORED means usage is not collected where the service runs.",
  }),
  read("pilae_deployments_list", "GET", "/v1/deployments"),
  read("pilae_activity_list", "GET", "/v1/activity"),
  read("pilae_activity_facets", "GET", "/v1/activity/facets", { hidden: true }),
  read("pilae_documents_list", "GET", "/v1/documents", { hidden: true }),

  // ─── Machine alerts ──────────────────────────────────────────────────────
  // What is wrong with the workspace's machines right now, and the thresholds
  // that decide it. Changing the thresholds is denied above.
  read("pilae_alerts_list", "GET", "/v1/alerts"),
  read("pilae_alerts_settings", "GET", "/v1/alerts/settings"),

  // ─── Provisioning ────────────────────────────────────────────────────────
  // The agent's route from "I need an n8n" to a running, reachable app. Reads
  // are free; starting a run always asks, because it creates real infrastructure
  // the customer is billed for and a hostname that will outlive the conversation.
  // Curated: the route's description argues for the registry, to people.
  read("pilae_recipes_list", "GET", "/v1/recipes", {
    description:
      "The apps Pilae can install, from its curated registry. `minRoleToProvision` is the least " +
      "role that may install each one here now; `publicable` says whether it may be put on the " +
      "internet. An app not listed is asked for with pilae_deploy_request_create, and a person " +
      "on the Pilae team sets it up.",
  }),
  // `canInstall` and the two INSTALLS_* reasons answer for the console's
  // Install button. A workspace that provisions through the agent alone gets
  // them too, and a model told to "deal with reasons[0] first" would refuse
  // exactly where pilae_provision_app works.
  //
  // Either field admits a caller, as the provisioning gate decides it
  // (`admitted` in src/provisioning/policy.ts). The console's agent only runs
  // where `agentProvisioning` is true, so "agentProvisioning decides" held for
  // it. A remote client is admitted by App installs alone too — with the
  // console agent switched off, as in production, by nothing else — and told
  // that, it would refuse to install where pilae_provision_app works. The
  // remote instructions read the same two fields (src/mcp/instructions.ts).
  read("pilae_provisioning_capabilities", "GET", "/v1/provisioning/capabilities", {
    description:
      "Whether this workspace can install an app now and, if not, why. Read it before proposing " +
      "an install. You may provision here at all when installsEnabled or agentProvisioning is " +
      "true. canInstall, INSTALLS_UNAVAILABLE and INSTALLS_NOT_ENABLED describe the console's " +
      "one-click Install button, not you: when either is true, ignore them and deal with the " +
      "first other reason (no machine, a machine not ready or busy, the role, installs in progress).",
  }),
  read("pilae_provisioning_preflight", "GET", "/v1/provisioning/preflight", {
    description:
      "Check an install without starting it: the machine and address it would get, or the " +
      "refusal pilae_provision_app would give (a name in use comes with a free suggestion). " +
      "Creates nothing.",
  }),
  read("pilae_provisioning_runs", "GET", "/v1/provisioning/runs"),
  read("pilae_provisioning_status", "GET", "/v1/provisioning/runs/{id}"),
  // `member`, because with App installs on any member may install a curated
  // app. The route decides per recipe and workspace (an effective minimum the
  // recipe list reports), so this only stops the tool reading as admin-only.
  operate("pilae_provision_app", "POST", "/v1/provisioning/runs", "member", {
    description:
      "Provision an app from Pilae's curated registry. Creates real infrastructure. The app is " +
      "private by default; pass exposure public only when the customer asked for it to be on the " +
      "internet. Check pilae_recipes_list first; anything not listed there needs a deployment request. " +
      "Pass the recipeId and the name the customer gave, and nothing they did not say: leave projectId " +
      "out unless they named a project (the app then goes into the Apps project), and leave machineId " +
      "out unless they named a machine — if the workspace has several, the call is refused and you ask them which. " +
      "machineId takes the machine's name as the customer gave it, or its id. " +
      "inputs: only for a recipe that lists some, and only values the customer gave you. Never ask for " +
      "or pass a secret one (an API key, a password): the customer types those into the console's " +
      "install form, and a call that passes one is refused.",
  }),
  // Cancelling abandons a run part-way and deliberately leaves whatever was
  // already created in place, so the customer confirms rather than discovering
  // half a stack later. Any member, as the route is: recovery is never gated
  // behind someone else.
  destroy("pilae_provisioning_cancel", "POST", "/v1/provisioning/runs/{id}/cancel", "member", {
    description: "Stop a provisioning run. Anything already created is left in place.",
  }),

  // ─── Deployment requests ─────────────────────────────────────────────────
  // How anything outside the recipe registry gets provisioned: the agent files
  // the request, a human fulfils it.
  read("pilae_deploy_requests_list", "GET", "/v1/deploy-requests"),
  operate("pilae_deploy_request_create", "POST", "/v1/deploy-requests", "member", {
    description:
      "Ask the Pilae team for something by hand. kind 'app': an app not in pilae_recipes_list " +
      "(appName required, appId when the catalog lists it). kind 'machine': a machine of the " +
      "workspace's own. kind 'change': anything about what already runs (message of at least 10 " +
      "characters). Put what the customer said in message. If an open request already asks for " +
      "the same thing, the call is refused with that request's id.",
  }),
  operate("pilae_deploy_request_update", "PATCH", "/v1/deploy-requests/{id}", "member", {
    description:
      "Amend an open deployment request ('received' or 'in_progress'): its kind, name, message " +
      "or machine.",
  }),
  destroy("pilae_deploy_request_withdraw", "DELETE", "/v1/deploy-requests/{id}", "member"),

  // ─── Workflows ───────────────────────────────────────────────────────────
  // Automations the agent writes and Pilae runs. Every save and run asks: steps
  // run real code that sends and changes real things. The definition travels as
  // a JSON string (`flow`), so no open-ended schema reaches the model.
  read("pilae_workflows_capabilities", "GET", "/v1/workflows/capabilities"),
  read("pilae_workflows_list", "GET", "/v1/workflows"),
  read("pilae_workflows_get", "GET", "/v1/workflows/{slug}", {
    description:
      "One workflow: its steps, input schema, deployment state and its full definition as a JSON string. " +
      "To change it, edit that definition and send it back whole with pilae_workflows_update.",
  }),
  read("pilae_workflows_versions", "GET", "/v1/workflows/{slug}/versions"),
  read("pilae_workflows_version_get", "GET", "/v1/workflows/{slug}/versions/{version}"),
  read("pilae_workflows_schedules_list", "GET", "/v1/workflows/{slug}/schedules"),
  read("pilae_workflows_runs_list", "GET", "/v1/workflow-runs"),
  read("pilae_workflows_run_get", "GET", "/v1/workflow-runs/{id}"),
  // Hidden: program output. `pilae_workflows_run_logs` and
  // `pilae_workflows_run_result` hand it to the model redacted, marked as
  // untrusted and cut to size; the per-step route serves the console.
  read("pilae_workflows_run_logs_raw", "GET", "/v1/workflow-runs/{id}/logs", { hidden: true }),
  read("pilae_workflows_step_logs_raw", "GET", "/v1/workflow-runs/{id}/steps/{stepRunId}/logs", {
    hidden: true,
  }),
  read("pilae_workflows_run_result_raw", "GET", "/v1/workflow-runs/{id}/result", { hidden: true }),
  read("pilae_workflows_secrets_list", "GET", "/v1/workflow-secrets", {
    description:
      "Names of the workspace's workflow secrets (values are never readable). A step uses one with the " +
      'static input "$secret:NAME". If one is missing, ask the customer to add it under Workflows → Secrets.',
  }),
  // A public hook's address starts runs for anyone who has it, so the
  // description keeps the model from putting it anywhere but its answer. Only
  // a hook with a secret or a signing key waits for a person: one with auth
  // none and no hmac has nothing to withhold and works as soon as it exists.
  read("pilae_workflows_hooks_list", "GET", "/v1/workflow-hooks", {
    description:
      "The workspace's webhooks. A POST to a webhook's `url` starts its `workflow`; the request " +
      "body becomes the run's inputs, as pilae_workflows_guide describes. `auth` secret: callers " +
      "send a bearer secret; `hmac`: they sign the body; auth none without hmac: anyone with the " +
      "address can start runs, so give it only to the customer. A secret or signing key is never " +
      "readable: a person sees it once, on creating the webhook in the console or rotating its " +
      "secret. One you created with auth secret or with hmac was shown to no one, so it accepts " +
      "no call until a person rotates its secret in the console, on the workflow's Webhooks tab. " +
      "One with auth none and no hmac has neither and works at once.",
  }),
  read("pilae_workflows_hook_hosts_list", "GET", "/v1/workflow-hooks/hosts", {
    description:
      "The hosts the workspace's webhook addresses use: its own, and any domain of the " +
      "customer's pointed at it (kind custom). A webhook answers at the same path on every active " +
      "host. A custom domain stays pending until its CNAME record points at `cnameTarget`; " +
      "`problem` says what is wrong. People add and remove domains in the console, under " +
      "Workflows → Webhook domains.",
  }),
  operate("pilae_workflows_create", "POST", "/v1/workflows", "admin", {
    description:
      "Save a new workflow. Read pilae_workflows_guide first and test the definition with " +
      "pilae_workflows_test_run before saving. `flow` is the definition as a JSON string.",
  }),
  operate("pilae_workflows_update", "PUT", "/v1/workflows/{slug}", "admin", {
    description:
      "Replace a workflow's definition: send the complete definition as a JSON string, written " +
      "as pilae_workflows_guide describes. Test it with pilae_workflows_test_run first.",
  }),
  operate("pilae_workflows_test_run", "POST", "/v1/workflows/test-run", "admin", {
    description:
      "Run an unsaved definition once to test it (format: pilae_workflows_guide). The steps " +
      "really run. Poll pilae_workflows_run_get until it ends, then read " +
      "pilae_workflows_run_logs and pilae_workflows_run_result.",
  }),
  operate("pilae_workflows_run", "POST", "/v1/workflows/{slug}/runs", "admin", {
    description:
      "Run a saved workflow now. Returns at once with the run; poll pilae_workflows_run_get " +
      "until it ends.",
  }),
  // Giving a workflow an internet address. Never a safe mutation: a webhook
  // with no auth lets anyone who learns the address start runs, so the
  // customer reads the card. The answer never carries a secret (the route
  // withholds it from an agent grant), and the description says where a
  // person gets one.
  operate("pilae_workflows_hook_create", "POST", "/v1/workflow-hooks", "admin", {
    description:
      "Give a saved workflow a webhook: the internet address https://<the workspace's webhook " +
      "host>/<path>, where a POST starts a run with the request body as its inputs " +
      "(pilae_workflows_guide, section 11); the answer's hook.url is the full address. auth " +
      "none: no secret, so anyone with the address can run the workflow; say so plainly when " +
      "you propose it. auth secret (the default): callers send a bearer secret, which you are " +
      "never shown: the answer withholds it, a person gets it by rotating the secret in the " +
      "console, and until then no call is accepted. hmac adds a signature check of the body, its " +
      "key withheld the same way. response sync: a call waits up to maxWaitSeconds (at most 30, " +
      "default 10) and gets the workflow's result, or a 202 if the run is still going (it goes " +
      "on); async (the default) answers 202 with the run's id at once.",
  }),
  operate("pilae_workflows_hook_update", "PATCH", "/v1/workflow-hooks/{hook}", "admin", {
    description:
      "Change a webhook. status disabled turns it off: every call is refused until it is set " +
      "active again. response sync makes a call wait up to maxWaitSeconds (at most 30) for the " +
      "workflow's result; ratePerMinute is how many calls a minute it accepts. Its address, auth " +
      "and secret do not change.",
  }),
  operate("pilae_workflows_schedule_create", "POST", "/v1/workflows/{slug}/schedules", "admin"),
  operate(
    "pilae_workflows_schedule_update",
    "PATCH",
    "/v1/workflows/{slug}/schedules/{scheduleId}",
    "admin",
  ),
  destroy("pilae_workflows_delete", "DELETE", "/v1/workflows/{slug}", "owner"),
  // Whatever calls the address breaks at once, and a new webhook at the same
  // path gets a new secret the callers do not have.
  destroy("pilae_workflows_hook_delete", "DELETE", "/v1/workflow-hooks/{hook}", "admin", {
    description:
      "Delete a webhook. Its address stops working at once, for everything that calls it; runs " +
      "it already started continue, and the workflow is kept.",
  }),
  destroy(
    "pilae_workflows_schedule_delete",
    "DELETE",
    "/v1/workflows/{slug}/schedules/{scheduleId}",
    "admin",
  ),
  // Member, like cancelling a stuck build — but it abandons work mid-way, so
  // the agent always asks.
  destroy("pilae_workflows_run_cancel", "POST", "/v1/workflow-runs/{id}/cancel", "member", {
    description: "Stop a running workflow run. Steps already finished are not undone.",
  }),
];

/** Lookup key used against the OpenAPI snapshot. */
export function operationKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}
