import { z } from "zod";
import type { ModelConfigFile } from "../shared/types.ts";

export class ConfigValidationError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`Invalid zcode model config: ${issues.join("; ")}`);
    this.name = "ConfigValidationError";
    this.issues = issues;
  }
}

const positiveNumber = z.number().finite().positive();
const headersSchema = z.record(z.string(), z.string());

const providerKindSchema = z.enum(["anthropic", "openai", "openai-compatible"]);

const providerOptionsSchema = z
  .object({
    apiKey: z.string().min(1).optional(),
    baseURL: z.string().min(1).optional(),
    apiKeyRequired: z.boolean().optional(),
    includeUsage: z.boolean().optional(),
    timeout: z.union([positiveNumber, z.literal(false)]).optional(),
    chunkTimeout: positiveNumber.optional(),
    headers: headersSchema.optional(),
  })
  .passthrough();

const modelRefSchema = z.string().refine((value) => /^[^/\s]+\/[^/\s]+/.test(value) && !value.includes(" "), {
  message: "Model references must use provider/model format",
});

const modalitiesSchema = z.object({
  input: z.array(z.enum(["text", "audio", "image", "video", "pdf"])).optional(),
  output: z.array(z.enum(["text", "audio", "image", "video", "pdf"])).optional(),
});

const costSchema = z
  .object({
    input: z.number().nonnegative().optional(),
    output: z.number().nonnegative().optional(),
    cache_read: z.number().nonnegative().optional(),
    cache_write: z.number().nonnegative().optional(),
  })
  .passthrough();

const modelEntrySchema = z
  .object({
    id: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    family: z.string().min(1).optional(),
    release_date: z.string().min(1).optional(),
    attachment: z.boolean().optional(),
    reasoning: z
      .union([
        z.boolean(),
        z.object({
          enabled: z.boolean().optional(),
          levels: z.array(z.string().min(1)).optional(),
          defaultLevel: z.string().min(1).optional(),
          providerOptionsByLevel: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
        }),
      ])
      .optional(),
    temperature: z.boolean().optional(),
    tool_call: z.boolean().optional(),
    structured_output: z.boolean().optional(),
    supportsImages: z.boolean().optional(),
    supportsPdf: z.boolean().optional(),
    supportsVideo: z.boolean().optional(),
    supportsReasoning: z.boolean().optional(),
    supportsToolCall: z.boolean().optional(),
    supportsStructuredOutput: z.boolean().optional(),
    contextWindow: positiveNumber.optional(),
    maxOutputTokens: positiveNumber.optional(),
    limit: z
      .object({ context: positiveNumber.optional(), input: positiveNumber.optional(), output: positiveNumber.optional() })
      .optional(),
    modalities: modalitiesSchema.optional(),
    interleaved: z.union([z.boolean(), z.object({ field: z.string().min(1) })]).optional(),
    reasoningContentField: z.string().min(1).optional(),
    cost: costSchema.optional(),
    options: z.record(z.string(), z.unknown()).optional(),
    headers: headersSchema.optional(),
    variants: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
  })
  .passthrough();

const providerEntrySchema = z
  .object({
    api: z.string().min(1).optional(),
    id: z.string().min(1).optional(),
    kind: providerKindSchema.optional(),
    name: z.string().min(1).optional(),
    npm: z.never().optional(),
    options: providerOptionsSchema.optional(),
    headers: headersSchema.optional(),
    models: z.record(z.string(), modelEntrySchema).optional(),
  })
  .passthrough();

const modelRolesSchema = z
  .object({
    main: modelRefSchema.optional(),
    lite: modelRefSchema.optional(),
  })
  .strict()
  .refine((value) => value.main !== undefined || value.lite !== undefined || Object.keys(value).length === 0, {
    message: "Model role config must include main or lite",
  });

const modelConfigFileSchema = z.object({
  provider: z.record(z.string(), providerEntrySchema).optional(),
  model: modelRolesSchema.optional(),
  modelCatalog: z
    .object({
      overrides: z
        .record(z.string().regex(/^[^/\s]+\/[^/\s]+$/), z.record(z.string(), z.unknown()))
        .optional(),
    })
    .passthrough()
    .optional(),
});

/**
 * Validate the model-related keys of a zcode config file. Mirrors the runtime
 * zod schema (provider/model passthrough, model-role block strict).
 * Throws ConfigValidationError with a flat list of zod issues.
 */
export function validateModelConfig(config: unknown): ModelConfigFile {
  const parsed = modelConfigFileSchema.safeParse(config);
  if (!parsed.success) {
    throw new ConfigValidationError(parsed.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`));
  }
  return parsed.data as ModelConfigFile;
}

export { providerKindSchema, modelRefSchema };
