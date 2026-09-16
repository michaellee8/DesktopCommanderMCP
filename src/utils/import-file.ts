import fs from 'node:fs/promises';
import path from 'node:path';
import { downloadImportFile, type DownloadReceipt } from './import-download.js';
import type { PathValidator } from './patch-engine.js';

export interface ImportFileRequest {
    file: { download_url: string; file_id: string; mime_type?: string; file_name?: string };
    destination: string;
    overwrite?: boolean;
    expected_sha256?: string;
}
export interface ImportFileReceipt extends DownloadReceipt { path: string }

async function destinationStat(destination: string) {
    try {
        const stat = await fs.lstat(destination);
        if (!stat.isFile()) throw new Error('Import destination must be a regular file, not a directory or symlink.');
        return stat;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
    }
}

/** The download stays in a private sibling directory until verified in full. */
export async function importFileToPath(args: ImportFileRequest, validatePath: PathValidator): Promise<ImportFileReceipt> {
    const destination = await validatePath(args.destination);
    const previous = await destinationStat(destination);
    if (previous && !args.overwrite) throw new Error('Destination already exists. Set overwrite=true to replace it.');
    await fs.mkdir(path.dirname(destination), { recursive: true });
    if (await validatePath(args.destination) !== destination) throw new Error('Import destination changed.');
    const staging = await fs.mkdtemp(path.join(path.dirname(destination), '.dc-import-'));
    const temp = path.join(staging, 'payload');
    try {
        // file_name is metadata only, never used to choose a filesystem path.
        const receipt = await downloadImportFile(args.file.download_url, temp);
        if (args.expected_sha256 && receipt.sha256 !== args.expected_sha256.toLowerCase()) {
            throw new Error('SHA-256 mismatch. No destination file was written.');
        }
        if (await validatePath(args.destination) !== destination) throw new Error('Import destination changed.');
        const current = await destinationStat(destination);
        if (args.overwrite) {
            // Preserve existing mode; keep newly imported files private by default.
            if (current) await fs.chmod(temp, current.mode & 0o777);
            await fs.rename(temp, destination);
        } else {
            // Atomic no-clobber, including another writer creating the destination mid-download.
            await fs.link(temp, destination);
        }
        return { path: destination, ...receipt };
    } finally { await fs.rm(staging, { recursive: true, force: true }); }
}
