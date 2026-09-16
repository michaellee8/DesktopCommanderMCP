import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

export const ApplyPatchArgsSchema = z.object({
    patch: z.string().min(1).max(1024 * 1024).describe('OpenAI/Codex *** Begin Patch ... *** End Patch text.'),
    cwd: z.string().min(1).describe('Working directory on the MCP host. Use an absolute path.'),
});

// All four properties must be declared for ChatGPT fileParams. Only the URL and
// file ID are required; do not replace this object with a path or a base64 string.
export const OpenAIFileSchema = z.object({
    download_url: z.string().url().max(8192),
    file_id: z.string().min(1).max(1024),
    mime_type: z.string().max(256).optional(),
    file_name: z.string().max(1024).optional(),
}).strict();
export const ImportFileArgsSchema = z.object({
    file: OpenAIFileSchema,
    destination: z.string().min(1).describe('Full destination filename on the MCP host, not a ChatGPT sandbox path.'),
    overwrite: z.boolean().default(false),
    expected_sha256: z.string().regex(/^[0-9a-fA-F]{64}$/).optional(),
});

export const patchAndImportSchemas: Record<string, z.ZodTypeAny> = {
    apply_patch: ApplyPatchArgsSchema,
    import_file: ImportFileArgsSchema,
};

// MCP input/output schemas must be objects; retain the literal type in TypeScript.
const jsonSchema = (schema: z.AnyZodObject) => ({
    ...zodToJsonSchema(schema, { $refStrategy: 'none' }),
    type: 'object' as const,
});
export const patchAndImportTools = [
    {
        name: 'apply_patch',
        description: 'Apply OpenAI/Codex-format text patches directly on the MCP host. Supports Add File, Update File, Delete File, Move to, @@ context and End of File. Supply the raw patch and an explicit cwd; no shell or Codex installation is needed. All paths use the existing allowedDirectories checks. Add/move destinations must not already exist. Maximum patch size 1 MiB; existing files 16 MiB. Preflight checks all operations, but a runtime failure can leave a reported prefix of changes committed. Prefer this over shell-based file editing when using patch format.',
        inputSchema: jsonSchema(ApplyPatchArgsSchema),
        outputSchema: jsonSchema(z.object({ changes: z.array(z.object({ operation: z.enum(['add', 'update', 'delete']), path: z.string() })) })),
        annotations: { title: 'Apply Patch', readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    {
        name: 'import_file',
        description: 'Copy an authorized ChatGPT file to this MCP host. Pass the file using the client file bridge, not base64 or a sandbox:/ path. Streams the original binary bytes, returns byte count and SHA-256, and refuses overwrite unless explicitly enabled. Maximum 100 MiB; download timeout 45 seconds. HTTPS public download hosts only. Parent folders are created; archives are not extracted and files are not executed. Uploaded or generated files work only when the ChatGPT client makes them available as file inputs.',
        inputSchema: jsonSchema(ImportFileArgsSchema),
        outputSchema: jsonSchema(z.object({ path: z.string(), bytes: z.number().int().nonnegative(), sha256: z.string(), mime_type: z.string() })),
        annotations: { title: 'Import File to Devbox', readOnlyHint: false, destructiveHint: true, openWorldHint: true },
        _meta: { 'openai/fileParams': ['file'] },
    },
];
