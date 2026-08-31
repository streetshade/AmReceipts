// What each business-system integration exposes in the admin console.
//
// Declarative on purpose. The form, the validation and the secret handling are
// all driven from these definitions, so adding a field to an integration is one
// entry here rather than three edits kept in step by hand - and the two
// integrations cannot drift into looking like different products.
//
// Two ideas carry most of the weight:
//
//   secret: true    the value is encrypted at rest and NEVER returned to the
//                   browser. The form shows whether it is set, and can replace
//                   it, but cannot read it back.
//   exclusiveGroup  integrations sharing a group cannot be enabled together.
//                   Expenses have one system of record; two enabled at once
//                   means the same spend posted twice.

import { z } from "zod";

export type FieldType = "text" | "password" | "boolean" | "number" | "select";

export interface FieldDef {
  name: string;
  label: string;
  type: FieldType;
  /** Heading this field sits under in the form. */
  group: string;
  /** Encrypted at rest, write-only over the wire. */
  secret?: boolean;
  placeholder?: string;
  help?: string;
  options?: { value: string; label: string }[];
}

export interface IntegrationDef {
  key: string;
  name: string;
  description: string;
  /** Only one enabled integration per group. Null means no restriction. */
  exclusiveGroup: string | null;
  fields: FieldDef[];
  /** Validates the non-secret half. */
  config: z.ZodType<Record<string, unknown>>;
  /** Validates the secret half. All members optional: a save may leave an
   *  already-stored secret untouched rather than re-entering it. */
  secrets: z.ZodType<Record<string, unknown>>;
}

// Shared: both systems are reached over https and neither should be given a
// plaintext endpoint, however internal the network is said to be.
const HttpsUrl = z
  .string()
  .trim()
  .url("Must be a URL")
  .refine((u) => u.startsWith("https://"), "Must use https")
  .or(z.literal(""));

// ---------------------------------------------------------------------------

const psaWeb: IntegrationDef = {
  key: "psa_web",
  name: "PSA Web",
  description: "Posts approved expenses into PSA Web.",
  exclusiveGroup: "expense_posting",
  fields: [
    { name: "baseUrl", label: "API base URL", type: "text", group: "Connection", placeholder: "https://psaweb.example.com/api" },
    { name: "companyId", label: "Company ID", type: "text", group: "Connection", placeholder: "e.g. 10432" },
    { name: "apiKey", label: "API key", type: "password", group: "Connection", secret: true, help: "Stored encrypted. Never shown again once saved." },
    { name: "defaultExpenseAccount", label: "Default expense account", type: "text", group: "GL posting", help: "Used when no rule matches." },
    { name: "defaultCostCentre", label: "Default cost centre", type: "text", group: "GL posting" },
    { name: "syncExpenses", label: "Post approved expenses", type: "boolean", group: "Behaviour", help: "Off means configuration only - nothing is sent." },
  ],
  config: z.object({
    baseUrl: HttpsUrl.default(""),
    companyId: z.string().trim().default(""),
    defaultExpenseAccount: z.string().trim().default(""),
    defaultCostCentre: z.string().trim().default(""),
    syncExpenses: z.boolean().default(false),
  }),
  // Trimmed BEFORE the length check: "   " passes .min(1) untrimmed, and would
  // be stored while the presence check (which trims) reported it as unset.
  secrets: z.object({ apiKey: z.string().trim().min(1, "cannot be blank").optional() }),
};

// ---------------------------------------------------------------------------

const m3Ion: IntegrationDef = {
  key: "m3_ion",
  name: "Infor M3 (ION API)",
  description:
    "Posts approved expenses into on-prem Infor M3 via m3api-rest, authenticating against Infor STS.",
  exclusiveGroup: "expense_posting",
  fields: [
    { name: "baseUrl", label: "m3api-rest base URL", type: "text", group: "Connection", placeholder: "https://grid-host:7443/infor/M3/m3api-rest" },
    { name: "tokenUrl", label: "Infor STS token URL", type: "text", group: "Connection", placeholder: "https://grid-host:2443/InforIntSTS/connect/token", help: ".ionapi pu + ot" },
    { name: "clientId", label: "Client ID", type: "text", group: "Connection", help: ".ionapi ci - not itself a secret" },
    {
      name: "authMode", label: "Authentication", type: "select", group: "Connection",
      options: [
        { value: "oauth_password", label: "OAuth2 password grant (Infor STS)" },
        { value: "basic", label: "HTTP basic (test grids only)" },
      ],
    },
    { name: "clientSecret", label: "Client secret", type: "password", group: "Connection", secret: true, help: ".ionapi cs. Stored encrypted." },
    { name: "saak", label: "Service account key (saak)", type: "password", group: "Connection", secret: true, help: ".ionapi saak. Used as the username." },
    { name: "sask", label: "Service account secret (sask)", type: "password", group: "Connection", secret: true, help: ".ionapi sask. Used as the password." },

    {
      name: "environment", label: "Environment", type: "select", group: "Safety",
      options: [
        { value: "DEV", label: "DEV" },
        { value: "TST", label: "TST" },
        { value: "PRD", label: "PRD - live ledger" },
      ],
    },
    { name: "dryRun", label: "Dry run", type: "boolean", group: "Safety", help: "Resolve and record postings without sending them." },
    { name: "armed", label: "Armed for posting", type: "boolean", group: "Safety", help: "Both dry run off AND armed on are required before anything is written to M3." },
    { name: "verifyTls", label: "Verify TLS certificate", type: "boolean", group: "Safety", help: "May only be turned off below PRD, for a self-signed test grid." },

    { name: "cono", label: "Company (CONO)", type: "text", group: "GL posting", placeholder: "e.g. 100" },
    { name: "divi", label: "Division (DIVI)", type: "text", group: "GL posting", placeholder: "e.g. 001" },
    { name: "currency", label: "Currency", type: "text", group: "GL posting", placeholder: "GBP" },
    { name: "suspenseAccount", label: "Suspense account", type: "text", group: "GL posting", help: "Where unroutable spend lands, if the policy allows it rather than blocking." },
    { name: "voucherSeries", label: "Voucher series", type: "text", group: "GL posting" },
    { name: "famFunction", label: "FAM function", type: "text", group: "GL posting", placeholder: "e.g. AP10" },

    { name: "maxrecs", label: "Max records per call", type: "number", group: "Advanced", help: "Must be positive. 0 means unbounded in m3api-rest and can spike M3 memory." },
    { name: "requestTimeoutMs", label: "Request timeout (ms)", type: "number", group: "Advanced" },
    { name: "connectTimeoutMs", label: "Connect timeout (ms)", type: "number", group: "Advanced" },
  ],
  config: z.object({
    baseUrl: HttpsUrl.default(""),
    tokenUrl: HttpsUrl.default(""),
    clientId: z.string().trim().default(""),
    authMode: z.enum(["oauth_password", "basic"]).default("oauth_password"),
    environment: z.enum(["DEV", "TST", "PRD"]).default("DEV"),
    dryRun: z.boolean().default(true),
    armed: z.boolean().default(false),
    verifyTls: z.boolean().default(true),
    cono: z.string().trim().regex(/^\d{0,3}$/, "Company is up to 3 digits").default(""),
    divi: z.string().trim().max(3).default(""),
    currency: z.string().trim().max(3).default(""),
    suspenseAccount: z.string().trim().default(""),
    voucherSeries: z.string().trim().default(""),
    famFunction: z.string().trim().default(""),
    maxrecs: z.number().int().min(1).max(10_000).default(1000),
    requestTimeoutMs: z.number().int().min(1000).max(120_000).default(30_000),
    connectTimeoutMs: z.number().int().min(1000).max(60_000).default(10_000),
  })
  .superRefine((c, ctx) => {
    // The same guard the connection schema enforces, applied here so an admin
    // is told at save time rather than at posting time.
    if (c.environment === "PRD" && !c.verifyTls) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["verifyTls"], message: "TLS verification cannot be disabled against PRD" });
    }
    if (c.environment === "PRD" && c.authMode !== "oauth_password") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["authMode"], message: "PRD must use the OAuth2 password grant" });
    }
    if (c.armed && !c.dryRun && c.baseUrl === "") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["baseUrl"], message: "Cannot arm posting without a base URL" });
    }
  }) as unknown as z.ZodType<Record<string, unknown>>,
  secrets: z.object({
    clientSecret: z.string().trim().min(1, "cannot be blank").optional(),
    saak: z.string().trim().min(1, "cannot be blank").optional(),
    sask: z.string().trim().min(1, "cannot be blank").optional(),
  }),
};

// ---------------------------------------------------------------------------

export const INTEGRATIONS: IntegrationDef[] = [m3Ion, psaWeb];

export function integrationDef(key: string): IntegrationDef | undefined {
  return INTEGRATIONS.find((i) => i.key === key);
}

/** Names of the secret fields for an integration. */
export function secretFieldNames(def: IntegrationDef): string[] {
  return def.fields.filter((f) => f.secret).map((f) => f.name);
}
