import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP, type LookupFunction } from 'node:net';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { IncomingMessage } from 'node:http';

export const MAX_IMPORT_BYTES = 100 * 1024 * 1024;
export const IMPORT_TIMEOUT_MS = 45_000;
const MAX_REDIRECTS = 5;
export class ImportDownloadError extends Error {}

function v4Integer(address: string): bigint {
    return address.split('.').reduce((n, octet) => (n << 8n) | BigInt(octet), 0n);
}
function v6Integer(address: string): bigint {
    const halves = address.split('::');
    const left = halves[0] ? halves[0].split(':') : [];
    const right = halves[1] ? halves[1].split(':') : [];
    const words = halves.length === 1 ? left : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
    return words.reduce((n, word) => (n << 16n) | BigInt(`0x${word}`), 0n);
}
function inRange(value: bigint, base: bigint, prefix: number, bits: number): boolean {
    return (value >> BigInt(bits - prefix)) === (base >> BigInt(bits - prefix));
}
/** Public unicast only. In particular, no metadata, loopback, private, or mapped IPs. */
export function isPublicDownloadAddress(address: string): boolean {
    if (isIP(address) === 4) {
        const value = v4Integer(address);
        const denied: Array<[string, number]> = [
            ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
            ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
            ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
            ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
        ];
        return !denied.some(([base, prefix]) => inRange(value, v4Integer(base), prefix, 32));
    }
    if (isIP(address) !== 6 || address.includes('.') || address.includes('%')) return false;
    const value = v6Integer(address);
    if (!inRange(value, v6Integer('2000::'), 3, 128)) return false;
    const denied: Array<[string, number]> = [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]];
    return !denied.some(([base, prefix]) => inRange(value, v6Integer(base), prefix, 128));
}

export function validateDownloadUrl(raw: string): URL {
    let url: URL;
    try { url = new URL(raw); } catch { throw new ImportDownloadError('Invalid file download URL.'); }
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || url.hash) {
        throw new ImportDownloadError('File downloads require HTTPS on port 443, without credentials or fragments.');
    }
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    if (isIP(hostname) && !isPublicDownloadAddress(hostname)) {
        throw new ImportDownloadError('Private or reserved download addresses are not allowed.');
    }
    return url;
}

// Check the addresses used by the actual socket, not a separate preliminary DNS lookup.
// autoSelectFamily is disabled below so this callback returns one pinned address.
export function createPublicDownloadLookup(resolve: typeof lookup = lookup): LookupFunction {
    return (hostname, options, callback) => {
    resolve(hostname, { all: true }).then(records => {
        if (!records.length || records.some(record => !isPublicDownloadAddress(record.address))) {
            callback(new ImportDownloadError('Private or reserved download addresses are not allowed.'), '', 4);
            return;
        }
        const family = typeof options === 'number' ? options : options.family;
        const record = records.find(record => !family || record.family === family);
        if (!record) { callback(new ImportDownloadError('No compatible public download address.'), '', 4); return; }
        callback(null, record.address, record.family);
    }, () => callback(new ImportDownloadError('Could not resolve file download host.'), '', 4));
    };
}
export const publicDownloadLookup = createPublicDownloadLookup();

function openResponse(url: URL, signal: AbortSignal): Promise<IncomingMessage> {
    return new Promise((resolve, reject) => {
        const options: https.RequestOptions & { autoSelectFamily: boolean } = {
            signal,
            lookup: publicDownloadLookup,
            autoSelectFamily: false,
            agent: false,
            headers: { 'accept-encoding': 'identity', 'user-agent': 'DesktopCommander-FileImport' },
        };
        const request = https.get(url, options, resolve);
        request.on('error', (error: Error) => reject(error instanceof ImportDownloadError ? error :
            new ImportDownloadError(signal.aborted ? 'File download timed out.' : 'File download connection failed.')));
    });
}

export interface DownloadReceipt { bytes: number; sha256: string; mime_type: string }
/** Writes exact response bytes to a new staging file. Never includes signed URLs in errors. */
export async function downloadImportFile(rawUrl: string, stagingFile: string): Promise<DownloadReceipt> {
    let url = validateDownloadUrl(rawUrl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), IMPORT_TIMEOUT_MS);
    timer.unref();
    try {
        for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
            const response = await openResponse(url, controller.signal);
            const status = response.statusCode ?? 0;
            if ([301, 302, 303, 307, 308].includes(status)) {
                const location = response.headers.location;
                response.destroy();
                if (!location || redirects === MAX_REDIRECTS) throw new ImportDownloadError('Too many or invalid download redirects.');
                let next: string;
                try { next = new URL(location, url).href; } catch { throw new ImportDownloadError('Invalid download redirect.'); }
                url = validateDownloadUrl(next);
                continue;
            }
            if (status !== 200) {
                response.destroy();
                throw new ImportDownloadError(`File download returned HTTP ${status}. Request a fresh file reference if it expired.`);
            }
            const declared = response.headers['content-length'];
            const expectedLength = declared === undefined ? undefined : Number(declared);
            if (expectedLength !== undefined && (!Number.isSafeInteger(expectedLength) || expectedLength < 0 || expectedLength > MAX_IMPORT_BYTES)) {
                response.destroy();
                throw new ImportDownloadError('Invalid or oversized download (maximum 100 MiB).');
            }
            if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
                response.destroy();
                throw new ImportDownloadError('Encoded downloads are not accepted; original file bytes are required.');
            }
            const hash = createHash('sha256');
            let bytes = 0;
            const meter = new Transform({
                transform(chunk: Buffer, _encoding, callback) {
                    bytes += chunk.length;
                    if (bytes > MAX_IMPORT_BYTES) { callback(new ImportDownloadError('Download exceeds 100 MiB.')); return; }
                    hash.update(chunk);
                    callback(null, chunk);
                },
            });
            try {
                await pipeline(response, meter, createWriteStream(stagingFile, { flags: 'wx', mode: 0o600 }), { signal: controller.signal });
            } catch (error) {
                if (error instanceof ImportDownloadError) throw error;
                throw new ImportDownloadError(controller.signal.aborted ? 'File download timed out.' : 'File download interrupted or staging write failed.');
            }
            if (expectedLength !== undefined && bytes !== expectedLength) throw new ImportDownloadError('Download length mismatch.');
            return { bytes, sha256: hash.digest('hex'), mime_type: (response.headers['content-type'] ?? 'application/octet-stream').slice(0, 256) };
        }
        throw new ImportDownloadError('Too many download redirects.');
    } finally { clearTimeout(timer); }
}
