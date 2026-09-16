import fs from 'node:fs/promises';
import path from 'node:path';

// The OpenAI/Codex *** Begin Patch format, implemented without invoking a shell.
// See docs/patch-and-chatgpt-import.md for supported syntax and deliberate limits.
export const MAX_PATCH_BYTES = 1024 * 1024;
export const MAX_PATCH_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_PATCH_TOTAL_BYTES = 64 * 1024 * 1024;
export type PathValidator = (requestedPath: string) => Promise<string>;
export interface PatchChunk { anchor?: string; before: string[]; after: string[]; eof: boolean }
export type PatchOperation =
    | { type: 'add'; path: string; content: string }
    | { type: 'delete'; path: string }
    | { type: 'update'; path: string; moveTo?: string; chunks: PatchChunk[] };
export interface PatchChange { operation: 'add' | 'update' | 'delete'; path: string }
export class PatchFailure extends Error {
    constructor(message: string, public readonly changes: PatchChange[] = []) {
        super(message);
        this.name = 'PatchFailure';
    }
}

export function parsePatch(patch: string): PatchOperation[] {
    if (Buffer.byteLength(patch, 'utf8') > MAX_PATCH_BYTES) throw new Error('Patch exceeds 1 MiB.');
    if (patch.includes('\0')) throw new Error('NUL bytes are not allowed in patches.');
    const lines = patch.replace(/\r\n/g, '\n').trim().split('\n');
    if (lines[0] !== '*** Begin Patch' || lines[lines.length - 1] !== '*** End Patch') {
        throw new Error('Expected *** Begin Patch and *** End Patch delimiters.');
    }
    const operations: PatchOperation[] = [];
    let i = 1;
    while (i < lines.length - 1) {
        const header = /^\*\*\* (Add|Delete|Update) File: (.+)$/.exec(lines[i++]);
        if (!header || !header[2].trim()) throw new Error(`Invalid file header at patch line ${i}.`);
        const filePath = header[2];
        if (header[1] === 'Delete') {
            operations.push({ type: 'delete', path: filePath });
        } else if (header[1] === 'Add') {
            const content: string[] = [];
            while (i < lines.length - 1 && !lines[i].startsWith('*** ')) {
                if (!lines[i].startsWith('+')) throw new Error(`Added lines must start with + (line ${i + 1}).`);
                content.push(lines[i++].slice(1));
            }
            operations.push({ type: 'add', path: filePath, content: content.length ? content.join('\n') + '\n' : '' });
        } else {
            let moveTo: string | undefined;
            if (lines[i]?.startsWith('*** Move to: ')) {
                moveTo = lines[i++].slice('*** Move to: '.length);
                if (!moveTo.trim()) throw new Error('Move destination must not be empty.');
            }
            const chunks: PatchChunk[] = [];
            while (i < lines.length - 1 && !lines[i].startsWith('*** ')) {
                let anchor: string | undefined;
                if (lines[i] === '@@' || lines[i].startsWith('@@ ')) {
                    anchor = lines[i] === '@@' ? undefined : lines[i].slice(3);
                    i++;
                } else if (chunks.length) {
                    throw new Error(`Expected @@ at patch line ${i + 1}.`);
                }
                const chunk: PatchChunk = { anchor, before: [], after: [], eof: false };
                let count = 0;
                while (i < lines.length - 1 && !lines[i].startsWith('*** ') && !lines[i].startsWith('@@')) {
                    const line = lines[i++];
                    const prefix = line[0] ?? ' '; // Codex accepts an empty context line.
                    if (![' ', '+', '-'].includes(prefix)) throw new Error(`Invalid hunk line ${i}.`);
                    const text = line.slice(1);
                    if (prefix !== '+') chunk.before.push(text);
                    if (prefix !== '-') chunk.after.push(text);
                    count++;
                }
                if (!count) throw new Error('An update hunk must contain at least one line.');
                if (lines[i] === '*** End of File') { chunk.eof = true; i++; }
                chunks.push(chunk);
                if (chunk.eof && i < lines.length - 1 && !lines[i].startsWith('*** ')) {
                    throw new Error('No more hunks may follow *** End of File.');
                }
            }
            if (!chunks.length) throw new Error(`Update has no hunks: ${filePath}`);
            operations.push({ type: 'update', path: filePath, moveTo, chunks });
        }
        if (operations.length > 256) throw new Error('A patch may affect at most 256 files.');
    }
    if (!operations.length) throw new Error('The patch contains no file operations.');
    return operations;
}

function seek(lines: string[], expected: string[], start: number, eof = false): number {
    const first = eof ? lines.length - expected.length : start;
    if (first < start) return -1;
    const last = eof ? first : lines.length - expected.length;
    // Match exact text first; only then relax trailing/all surrounding whitespace.
    for (const normalize of [(s: string) => s, (s: string) => s.trimEnd(), (s: string) => s.trim()]) {
        for (let i = first; i <= last; i++) {
            if (expected.every((line, j) => normalize(line) === normalize(lines[i + j]))) return i;
        }
    }
    return -1;
}

export function applyPatchText(original: string, chunks: PatchChunk[]): string {
    const eol = original.includes('\r\n') ? '\r\n' : '\n';
    const lines = original.replace(/\r\n/g, '\n').split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    let cursor = 0;
    for (const chunk of chunks) {
        if (chunk.anchor !== undefined) {
            const anchor = seek(lines, [chunk.anchor], cursor);
            if (anchor < 0) throw new Error(`Could not find @@ context: ${chunk.anchor}`);
            cursor = anchor + 1;
        }
        let before = chunk.before;
        let after = chunk.after;
        let index = before.length ? seek(lines, before, cursor, chunk.eof) : lines.length;
        // Match the optional terminal empty context line used by Codex patches.
        if (index < 0 && before[before.length - 1] === '') {
            before = before.slice(0, -1);
            if (after[after.length - 1] === '') after = after.slice(0, -1);
            index = before.length ? seek(lines, before, cursor, chunk.eof) : lines.length;
        }
        if (index < 0) throw new Error(`Could not find expected hunk${chunk.eof ? ' at end of file' : ''}.`);
        lines.splice(index, before.length, ...after);
        cursor = index + after.length;
    }
    return lines.length ? lines.join(eol) + eol : '';
}

async function snapshot(filePath: string): Promise<{ bytes: Buffer; mode: number } | undefined> {
    try {
        const stat = await fs.lstat(filePath);
        if (!stat.isFile()) throw new Error(`Not a regular file (symlinks are not patch targets): ${filePath}`);
        if (stat.size > MAX_PATCH_FILE_BYTES) throw new Error(`File exceeds 16 MiB: ${filePath}`);
        const handle = await fs.open(filePath, 'r');
        try {
            // Bounded even if a file grows after lstat: read at most its observed
            // size plus one byte, instead of allocating via unbounded readFile.
            const buffer = Buffer.alloc(stat.size + 1);
            let length = 0;
            while (length < buffer.length) {
                const result = await handle.read(buffer, length, buffer.length - length, null);
                if (!result.bytesRead) break;
                length += result.bytesRead;
            }
            if (length > stat.size) throw new Error(`File grew while reading: ${filePath}`);
            return { bytes: buffer.subarray(0, length), mode: stat.mode & 0o777 };
        } finally { await handle.close(); }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
    }
}

export async function applyPatchToFiles(patch: string, cwd: string, validatePath: PathValidator): Promise<PatchChange[]> {
    const operations = parsePatch(patch);
    const base = await validatePath(cwd);
    if (!(await fs.stat(base)).isDirectory()) throw new Error('cwd must be an existing directory.');
    const seen = new Set<string>();
    const plan: Array<{ path: string; before?: Buffer; after?: Buffer; mode: number }> = [];
    let total = 0;
    const resolve = async (name: string): Promise<string> => {
        const requested = path.resolve(base, name);
        // Check the final lexical component before validatePath resolves symlinks.
        try {
            if ((await fs.lstat(requested)).isSymbolicLink()) throw new Error(`Symlink patch target: ${name}`);
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        const resolved = await validatePath(requested);
        const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
        if (seen.has(key)) throw new Error(`Duplicate/overlapping patch target: ${name}`);
        seen.add(key);
        return resolved;
    };
    // Validate all paths and compute every update before making any changes.
    for (const operation of operations) {
        const target = await resolve(operation.path);
        const old = await snapshot(target);
        const mode = old?.mode ?? (0o666 & ~process.umask());
        total += old?.bytes.length ?? 0;
        if (operation.type === 'add') {
            if (old) throw new Error(`Add File refuses to overwrite an existing file: ${operation.path}`);
            const after = Buffer.from(operation.content);
            total += after.length;
            plan.push({ path: target, after, mode });
        } else {
            if (!old) throw new Error(`File does not exist: ${operation.path}`);
            if (operation.type === 'delete') {
                plan.push({ path: target, before: old.bytes, mode });
            } else {
                const original = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(old.bytes);
                if (original.includes('\0')) throw new Error(`Cannot update a binary file: ${operation.path}`);
                const after = Buffer.from(applyPatchText(original, operation.chunks));
                if (after.length > MAX_PATCH_FILE_BYTES) throw new Error('Updated file exceeds 16 MiB.');
                total += after.length;
                if (operation.moveTo && path.resolve(base, operation.moveTo) !== path.resolve(base, operation.path)) {
                    const destination = await resolve(operation.moveTo);
                    if (await snapshot(destination)) throw new Error(`Move destination already exists: ${operation.moveTo}`);
                    plan.push({ path: destination, after, mode });
                    plan.push({ path: target, before: old.bytes, mode });
                } else plan.push({ path: target, before: old.bytes, after, mode });
            }
        }
        if (total > MAX_PATCH_TOTAL_BYTES) throw new Error('Patch working set exceeds 64 MiB.');
    }
    const changes: PatchChange[] = [];
    try {
        for (const item of plan) {
            if (await validatePath(item.path) !== item.path) throw new Error(`Path changed during patch: ${item.path}`);
            const current = await snapshot(item.path);
            if (item.before ? !current?.bytes.equals(item.before) : current !== undefined) {
                throw new Error(`File changed during patch: ${item.path}`);
            }
            if (item.after === undefined) {
                await fs.unlink(item.path);
                changes.push({ operation: 'delete', path: item.path });
            } else {
                await fs.mkdir(path.dirname(item.path), { recursive: true });
                if (await validatePath(item.path) !== item.path) throw new Error('Destination changed during patch.');
                const staging = await fs.mkdtemp(path.join(path.dirname(item.path), '.dc-patch-'));
                const temp = path.join(staging, 'contents');
                try {
                    await fs.writeFile(temp, item.after, { flag: 'wx', mode: 0o600 });
                    await fs.chmod(temp, item.mode);
                    // link is an atomic no-clobber publish for new files.
                    if (item.before === undefined) await fs.link(temp, item.path);
                    else await fs.rename(temp, item.path);
                    changes.push({ operation: item.before === undefined ? 'add' : 'update', path: item.path });
                } finally { await fs.rm(staging, { recursive: true, force: true }); }
            }
        }
        return changes;
    } catch (error) {
        throw new PatchFailure(error instanceof Error ? error.message : String(error), changes);
    }
}
