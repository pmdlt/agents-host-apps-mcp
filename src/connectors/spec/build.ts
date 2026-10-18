// Excerpt from a private codebase, shared for the Make Something Agents Want hackathon (README.md).
// Imports that point outside this folder are not included, so this does not build on its own.

// One spec in, one index out: the pipeline the index run (R5), the simulator
// (S1) and the lab harness (C6) all build operations with, so all three index
// an app exactly alike (PLAN §5 R2, §7.2).
//
//   detect  → OpenAPI 3.0 or 3.1 JSON, or SPEC_UNSUPPORTED / SPEC_TOO_LARGE
//   extract → keyed operations, references inlined under the spec's budget
//   classify, through the classifier the caller injects
//   name    → `<method>_<tail>_<hash>` (src/connectors/naming.ts)
//   rank    → featured, then by role, depth and key
//   fingerprint
//
// The classifier is a parameter because the policy is not this module's: the
// operation policy (R3) decides what is denied, carded or destructive, from
// Pilae's lists and the entry's. It is required, so a caller that forgets it
// does not compile, rather than indexing `/tokens` as a read nobody reviews.
// `methodClassifier` reads the method alone: the floor the policy builds on,
// and what tests pass. Whatever classifier runs is handed the route, the tags
// and the operationId, never the summary or the description: those are the
// app's prose, and prose decides nothing here.
//
// Pure and deterministic: the same text and options give the same operations,
// names, ranks and fingerprints on every run, in a Worker, a workflow step or
// Node. Nothing here runs at module load, and nothing it imports builds
// anything when it loads either: no zod (the operation patterns come from
// operation-pattern.ts, not the entry format) and no YAML. So a module on the
// Worker's startup path may import it statically, though the index run (R5)
// reaches it through its own deferred workflow module anyway.

import type { AutoConnectorEntry } from "../entry-schema";
import { nameOperations } from "../naming";
import type { OperationClass, StagedOperation } from "../store";
import {
  type DetectedSpec,
  isRecord,
  MAX_SPEC_BYTES,
  type ParsedSpec,
  parseSpec,
  SpecError,
} from "./detect";
import { fingerprintOf, type OperationFingerprint } from "./fingerprint";
import {
  extractOperations,
  type OperationParam,
  type Pagination,
  type ResponseKind,
  type SkippedOperation,
  type SpecMethod,
  type SpecOperation,
} from "./operations";
import { rankOperations } from "./rank";
import { cleanText, SpecBudget, type SpecLimits } from "./resolve";

/** What a classifier is shown of an operation. */
export interface ClassifierInput {
  opKey: string;
  method: SpecMethod;
  pathTemplate: string;
  tags: readonly string[];
  operationId: string | null;
}

export interface Classification {
  class: OperationClass;
  /** Why, in a word or two for the review screen and logs; null for no particular reason. */
  reason: string | null;
}

export type OperationClassifier = (op: ClassifierInput) => Classification;

/**
 * The method's own meaning, and nothing else: GET and HEAD read, POST, PUT and
 * PATCH write, DELETE (and anything else) is destructive. The floor the
 * operation policy builds on, and never a default: it denies nothing. Takes
 * any method string, so a caller holding a stored row's method can ask too.
 */
export function methodClassifier(op: { method: string }): Classification {
  switch (op.method.toUpperCase()) {
    case "GET":
    case "HEAD":
      return { class: "read", reason: "method" };
    case "POST":
    case "PUT":
    case "PATCH":
      return { class: "write", reason: "method" };
    default:
      return { class: "destructive", reason: "method" };
  }
}

const CLASSES: ReadonlySet<string> = new Set(["read", "write", "destructive", "deny"]);

/**
 * One operation as the store stages it (`StagedOperation`), with the shapes
 * this pipeline gives its JSON fields. `bodyKind` is the media type a call
 * sends its body as, and `bodyProps` that body's top-level properties.
 */
export interface IndexedOperation extends StagedOperation {
  method: SpecMethod;
  params: OperationParam[];
  bodyProps: string[] | null;
  pagination: Pagination | null;
  responseKind: ResponseKind;
  fingerprint: OperationFingerprint;
}

export interface OperationIndex {
  openapi: string;
  version: DetectedSpec["version"];
  /** `info.title`, cleaned. */
  title: string | null;
  /** The servers path every template starts with. */
  prefix: string;
  /** In rank order. */
  operations: IndexedOperation[];
  skipped: SkippedOperation[];
  /** What the build spent of the spec's budget. */
  spent: { nodes: number; schemaBytes: number };
}

export interface BuildOptions {
  /** Where the document was served, for a relative server URL. */
  specPath?: string;
  /**
   * The app's entry, when one matched: its featured operations rank first,
   * and the headers it sends itself (the token's, the static ones) are never
   * parameters.
   */
  entry?: Pick<AutoConnectorEntry, "auth" | "staticHeaders" | "featured"> | null;
  /**
   * The header the connection's token travels in, where no entry says: on
   * the generic path, the admin's choice among `AUTH_HEADER_NAMES`
   * (src/connectors/headers.ts). A spec that declares it as a parameter,
   * required on every operation as a spec with an API key often does, is
   * describing the token, which every call carries; without this, each such
   * operation would be skipped as needing a parameter Pilae never sends.
   */
  authHeader?: string | null;
  /**
   * Header parameters to keep beyond the allowlist. The entry format has no
   * field for them yet, so callers pass none; the slot is where one lands.
   */
  headerParams?: readonly string[];
  /**
   * The operation policy (R3). Required: there is no default, because the
   * one there could be (`methodClassifier`) denies nothing.
   */
  classify: OperationClassifier;
  /** Tighter budgets than the defaults, for tests. */
  limits?: Partial<SpecLimits>;
}

/**
 * Build a spec's index, from its text or from what `parseSpec` read of it
 * (never a document parsed some other way, which no size check has seen).
 * Throws `SpecError` for a spec that cannot be indexed at all; every
 * operation that cannot be is in `skipped`, with why.
 */
export async function buildOperationIndex(
  input: string | ParsedSpec,
  options: BuildOptions,
): Promise<OperationIndex> {
  const spec = typeof input === "string" ? parseSpec(input) : input;
  // The type says this already; a document assembled by hand says otherwise.
  if (!(typeof spec.bytes === "number" && spec.bytes <= MAX_SPEC_BYTES)) {
    throw new SpecError(
      "SPEC_TOO_LARGE",
      "the spec was not measured, or is larger than Pilae reads",
      {
        budget: "spec_bytes",
        limit: MAX_SPEC_BYTES,
      },
    );
  }
  const budget = new SpecBudget(options.limits);
  const extracted = extractOperations(spec, {
    specPath: options.specPath,
    suppliedHeaders: [
      ...suppliedHeaders(options.entry ?? null),
      ...(options.authHeader ? [options.authHeader] : []),
    ],
    headerParams: options.headerParams,
    budget,
  });
  const { classify } = options;

  const classified = extracted.operations.map((op) => ({ ...op, ...classOf(classify, op) }));
  // Named before ranking, which naming does not depend on, so that ranks run
  // without gaps over what is kept.
  const { names } = await nameOperations(classified);
  const skipped = [...extracted.skipped];
  for (const op of classified) {
    if (names.has(op.opKey)) continue;
    skipped.push({
      method: op.method,
      path: cleanText(op.pathTemplate, 256) ?? "",
      reason: "name",
    });
  }
  const named = classified.filter((op) => names.has(op.opKey));

  const ranked = rankOperations(named, options.entry?.featured ?? []);
  const operations = ranked.map(
    (op): IndexedOperation => ({
      opKey: op.opKey,
      name: names.get(op.opKey)!,
      method: op.method,
      pathTemplate: op.pathTemplate,
      params: op.params,
      bodyKind: op.body?.mediaType ?? null,
      bodyProps: op.body?.props ?? null,
      inputSchema: op.inputSchema,
      pagination: op.pagination,
      itemsPath: op.itemsPath,
      responseKind: op.responseKind,
      summary: op.summary,
      description: op.description,
      tags: op.tags,
      operationId: op.operationId,
      rank: op.rank,
      policyClass: op.policyClass,
      policyReason: op.policyReason,
      upload: op.upload,
      deprecated: op.deprecated,
      fingerprint: fingerprintOf(op),
    }),
  );

  const info = isRecord(spec.doc.info) ? spec.doc.info : {};
  return {
    openapi: spec.openapi,
    version: spec.version,
    title: cleanText(info.title, 200),
    prefix: extracted.prefix,
    operations,
    skipped,
    spent: { nodes: budget.nodes, schemaBytes: budget.schemaBytes },
  };
}

/**
 * The classifier's answer, held to the four classes: anything else is a bug
 * in the classifier, and an operation nobody could classify is denied.
 */
function classOf(
  classify: OperationClassifier,
  op: SpecOperation,
): { policyClass: OperationClass; policyReason: string | null } {
  const answer = classify({
    opKey: op.opKey,
    method: op.method,
    pathTemplate: op.pathTemplate,
    tags: op.tags,
    operationId: op.operationId,
  });
  if (!CLASSES.has(answer.class)) return { policyClass: "deny", policyReason: "unclassified" };
  return { policyClass: answer.class, policyReason: answer.reason };
}

/** The headers a call to this app carries whatever the operation: never parameters. */
function suppliedHeaders(
  entry: Pick<AutoConnectorEntry, "auth" | "staticHeaders"> | null,
): string[] {
  if (!entry) return [];
  const auth =
    entry.auth.kind === "header"
      ? [entry.auth.name]
      : entry.auth.kind === "none"
        ? []
        : ["authorization"];
  return [...auth, ...Object.keys(entry.staticHeaders ?? {})];
}
