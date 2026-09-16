import type { ServerResult } from '../types.js';
import { validatePath } from './filesystem.js';
import { ApplyPatchArgsSchema, ImportFileArgsSchema } from './patch-and-import-schemas.js';
import { applyPatchToFiles, PatchFailure } from '../utils/patch-engine.js';
import { importFileToPath } from '../utils/import-file.js';

export async function handleApplyPatch(args: unknown): Promise<ServerResult> {
    const parsed = ApplyPatchArgsSchema.safeParse(args);
    if (!parsed.success) return { isError: true, content: [{ type: 'text', text: 'Invalid apply_patch arguments. Supply patch and cwd strings.' }] };
    try {
        const changes = await applyPatchToFiles(parsed.data.patch, parsed.data.cwd, validatePath);
        return {
            content: [{ type: 'text', text: `Patch applied:\n${changes.map(c => `${c.operation.toUpperCase()} ${c.path}`).join('\n')}` }],
            structuredContent: { changes },
        };
    } catch (error) {
        const changes = error instanceof PatchFailure ? error.changes : [];
        const message = error instanceof Error ? error.message : String(error);
        return {
            isError: true,
            content: [{ type: 'text', text: `Patch failed: ${message}\n${changes.length ? `Already committed (not rolled back):\n${changes.map(c => `${c.operation.toUpperCase()} ${c.path}`).join('\n')}` : 'No file changes were committed.'}` }],
        };
    }
}

export async function handleImportFile(args: unknown): Promise<ServerResult> {
    const parsed = ImportFileArgsSchema.safeParse(args);
    if (!parsed.success) return { isError: true, content: [{ type: 'text', text: 'Invalid import_file arguments. Supply an authorized file reference and destination; expected_sha256, when present, must be 64 hexadecimal characters.' }] };
    try {
        const receipt = await importFileToPath(parsed.data, validatePath);
        return {
            content: [{ type: 'text', text: `Imported ${receipt.bytes} bytes to ${receipt.path}\nSHA-256: ${receipt.sha256}\nMIME type: ${receipt.mime_type}` }],
            structuredContent: { ...receipt },
        };
    } catch (error) {
        return { isError: true, content: [{ type: 'text', text: `File import failed: ${error instanceof Error ? error.message : String(error)}` }] };
    }
}
