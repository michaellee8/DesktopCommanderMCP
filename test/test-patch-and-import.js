import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { parsePatch, applyPatchText, applyPatchToFiles, PatchFailure, MAX_PATCH_FILE_BYTES } from '../dist/utils/patch-engine.js';
import { downloadImportFile, isPublicDownloadAddress, validateDownloadUrl, createPublicDownloadLookup, MAX_IMPORT_BYTES } from '../dist/utils/import-download.js';
import { importFileToPath } from '../dist/utils/import-file.js';
import { redactFileInput } from '../dist/utils/redact-file-input.js';

const patch = body => `*** Begin Patch\n${body}\n*** End Patch`;
const update = body => parsePatch(patch(`*** Update File: test.txt\n${body}`))[0].chunks;
const sha256 = data => createHash('sha256').update(data).digest('hex');
const file = { file_id: 'test-file', download_url: 'https://files.example.com/file?signature=SECRET', file_name: '../../must-not-be-used.png' };

async function fixture(t) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dc-new-tools-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    // Inject an allowed-directory validator, as the production handler does.
    const validate = async requested => {
        const absolute = path.resolve(requested);
        let current = absolute;
        const rest = [];
        let resolved;
        for (;;) {
            try { resolved = path.join(await fs.realpath(current), ...rest); break; }
            catch (error) {
                if (error.code !== 'ENOENT' || path.dirname(current) === current) throw error;
                rest.unshift(path.basename(current)); current = path.dirname(current);
            }
        }
        if (resolved !== root && !resolved.startsWith(root + path.sep)) throw new Error('Path not allowed');
        return resolved;
    };
    return { root, validate, name: name => path.join(root, name) };
}

// Stub only the HTTP transport: the real streaming, hashing, staging, and publish code runs.
function mockDownloads(t, steps) {
    const original = https.get;
    const seen = [];
    https.get = (url, options, callback) => {
        const step = steps[seen.length];
        seen.push({ url, options });
        assert.ok(step, 'unexpected HTTP request');
        const request = new EventEmitter();
        queueMicrotask(() => {
            if (step.error) { request.emit('error', new Error(step.error)); return; }
            const response = Readable.from((async function* () {
                if (step.before) await step.before();
                for (const chunk of step.chunks ?? [Buffer.from('payload')]) yield chunk;
                if (step.streamError) throw new Error(step.streamError);
            })());
            response.statusCode = step.status ?? 200;
            response.headers = step.headers ?? {};
            callback(response);
        });
        return request;
    };
    t.after(() => { https.get = original; });
    return seen;
}

for (const [name, input] of [
    ['missing wrapper', 'hello'], ['empty patch', patch('')],
    ['trailing text', patch('*** Delete File: a') + '\noops'],
    ['bad add line', patch('*** Add File: a\nnot-prefixed')],
    ['missing update hunk', patch('*** Update File: a')],
    ['empty update hunk', patch('*** Update File: a\n@@')],
    ['invalid update line', patch('*** Update File: a\n@@\nx')],
    ['empty move destination', patch('*** Update File: a\n*** Move to: \n@@\n-a\n+b')],
    ['NUL', patch('*** Add File: a\n+\0')],
    ['oversized patch', 'x'.repeat(1024 * 1024 + 1)],
]) test(`patch rejects ${name}`, () => assert.throws(() => parsePatch(input)));

test('patch adds, updates, moves, and deletes files', async t => {
    const { root, name, validate } = await fixture(t);
    await fs.writeFile(name('before.txt'), 'old\n');
    await fs.writeFile(name('delete.txt'), 'delete\n');
    const changes = await applyPatchToFiles(patch('*** Add File: nested/new.txt\n+hello\n*** Update File: before.txt\n*** Move to: moved.txt\n@@\n-old\n+new\n*** Delete File: delete.txt'), root, validate);
    assert.equal(await fs.readFile(name('nested/new.txt'), 'utf8'), 'hello\n');
    assert.equal(await fs.readFile(name('moved.txt'), 'utf8'), 'new\n');
    await assert.rejects(fs.stat(name('before.txt')), { code: 'ENOENT' });
    await assert.rejects(fs.stat(name('delete.txt')), { code: 'ENOENT' });
    assert.equal(changes.length, 4);
});
test('patch preserves CRLF and Unicode text', () => {
    assert.equal(applyPatchText('標題\r\n舊值\r\n', update('@@\n 標題\n-舊值\n+新值')), '標題\r\n新值\r\n');
});
test('patch supports anchors, multiple hunks and whitespace fallback', () => {
    const body = '@@ function alpha() {\n-  old\n+  first\n@@ function beta() {\n-old\n+second';
    assert.equal(applyPatchText('function alpha() {\n  old\n}\nfunction beta() {\n  old  \n}\n', update(body)), 'function alpha() {\n  first\n}\nfunction beta() {\nsecond\n}\n');
});
test('EOF marker targets only the end of the file', () => {
    assert.equal(applyPatchText('x\ny\nx\n', update('@@\n-x\n+z\n*** End of File')), 'x\ny\nz\n');
    assert.throws(() => applyPatchText('x\ny\n', update('@@\n-x\n+z\n*** End of File')));
});
test('insertion-only update appends and missing final newline is handled', () => {
    assert.equal(applyPatchText('a', update('@@\n+b')), 'a\nb\n');
});
test('update permits first hunk without @@', () => {
    assert.equal(applyPatchText('old\n', update('-old\n+new')), 'new\n');
});
test('update accepts terminal blank context', () => {
    assert.equal(applyPatchText('old\n', update('@@\n-old\n+new\n ')), 'new\n');
});
test('malformed later hunk leaves every file unchanged', async t => {
    const { root, name, validate } = await fixture(t);
    await fs.writeFile(name('a'), 'old\n');
    await fs.writeFile(name('b'), 'different\n');
    await assert.rejects(applyPatchToFiles(patch('*** Update File: a\n@@\n-old\n+new\n*** Update File: b\n@@\n-not-there\n+new'), root, validate));
    assert.equal(await fs.readFile(name('a'), 'utf8'), 'old\n');
});
test('add refuses existing files and leaves them intact', async t => {
    const { root, name, validate } = await fixture(t);
    await fs.writeFile(name('a'), 'existing');
    await assert.rejects(applyPatchToFiles(patch('*** Add File: a\n+replacement'), root, validate), /overwrite/);
    assert.equal(await fs.readFile(name('a'), 'utf8'), 'existing');
});
test('move refuses an existing destination', async t => {
    const { root, name, validate } = await fixture(t);
    await fs.writeFile(name('a'), 'a\n'); await fs.writeFile(name('b'), 'b\n');
    await assert.rejects(applyPatchToFiles(patch('*** Update File: a\n*** Move to: b\n@@\n-a\n+c'), root, validate), /already exists/);
    assert.equal(await fs.readFile(name('a'), 'utf8'), 'a\n');
});
test('duplicate targets are rejected before writing', async t => {
    const { root, name, validate } = await fixture(t);
    await assert.rejects(applyPatchToFiles(patch('*** Add File: a\n+x\n*** Add File: ./a\n+y'), root, validate), /Duplicate/);
    await assert.rejects(fs.stat(name('a')), { code: 'ENOENT' });
});
test('all patch destinations pass through the allowed-directory validator', async t => {
    const { root, name, validate } = await fixture(t);
    await fs.writeFile(name('a'), 'a\n');
    await assert.rejects(applyPatchToFiles(patch('*** Update File: a\n*** Move to: ../outside\n@@\n-a\n+b'), root, validate), /not allowed/);
    assert.equal(await fs.readFile(name('a'), 'utf8'), 'a\n');
});
test('symlink patch targets are rejected', async t => {
    const { root, name, validate } = await fixture(t);
    await fs.writeFile(name('a'), 'a\n');
    try { await fs.symlink(name('a'), name('link')); } catch (e) { if (e.code === 'EPERM') return t.skip('symlink privilege unavailable'); throw e; }
    await assert.rejects(applyPatchToFiles(patch('*** Update File: link\n@@\n-a\n+b'), root, validate), /Symlink/);
});
test('patch updates preserve executable mode on POSIX', async t => {
    if (process.platform === 'win32') return t.skip('POSIX modes');
    const { root, name, validate } = await fixture(t);
    await fs.writeFile(name('script'), 'old\n', { mode: 0o755 });
    await applyPatchToFiles(patch('*** Update File: script\n@@\n-old\n+new'), root, validate);
    assert.equal((await fs.stat(name('script'))).mode & 0o777, 0o755);
});
test('runtime failure reports the actually committed prefix', async t => {
    const { root, name, validate } = await fixture(t);
    let secondChecks = 0;
    const failDuringCommit = async target => {
        if (target === name('b') && ++secondChecks === 2) throw new Error('simulated I/O failure');
        return validate(target);
    };
    await assert.rejects(applyPatchToFiles(patch('*** Add File: a\n+ok\n*** Add File: b\n+no'), root, failDuringCommit), error => {
        assert.ok(error instanceof PatchFailure);
        assert.deepEqual(error.changes, [{ operation: 'add', path: name('a') }]); return true;
    });
    assert.equal(await fs.readFile(name('a'), 'utf8'), 'ok\n');
    await assert.rejects(fs.stat(name('b')), { code: 'ENOENT' });
});
test('file changes between preflight and commit are detected', async t => {
    const { root, name, validate } = await fixture(t);
    await fs.writeFile(name('a'), 'old\n'); let checks = 0;
    const changingValidator = async target => {
        if (target === name('a') && ++checks === 2) await fs.writeFile(target, 'external\n');
        return validate(target);
    };
    await assert.rejects(applyPatchToFiles(patch('*** Update File: a\n@@\n-old\n+new'), root, changingValidator), /changed during patch/);
    assert.equal(await fs.readFile(name('a'), 'utf8'), 'external\n');
});
test('oversized input files are refused', async t => {
    const { root, name, validate } = await fixture(t);
    await fs.writeFile(name('big'), Buffer.alloc(MAX_PATCH_FILE_BYTES + 1));
    await assert.rejects(applyPatchToFiles(patch('*** Delete File: big'), root, validate), /16 MiB/);
});

for (const address of ['0.0.0.0', '10.1.2.3', '127.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1', '100.64.0.1', '198.18.0.1', '192.0.2.1', '224.0.0.1', '255.255.255.255', '::1', '::', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:8.8.8.8', '2001:db8::1', '2002:7f00:1::', 'not-an-ip']) {
    test(`download rejects nonpublic address ${address}`, () => assert.equal(isPublicDownloadAddress(address), false));
}
for (const address of ['8.8.8.8', '1.1.1.1', '2001:4860:4860::8888', '2606:4700:4700::1111']) {
    test(`download accepts public address ${address}`, () => assert.equal(isPublicDownloadAddress(address), true));
}
for (const url of ['http://example.com/a', 'file:///etc/passwd', 'https://u:p@example.com/a', 'https://example.com:444/a', 'https://127.1/a', 'https://0x7f000001/a', 'https://[::1]/a', 'https://example.com/a#fragment']) {
    test(`download rejects URL ${url}`, () => assert.throws(() => validateDownloadUrl(url)));
}
test('DNS lookup rejects a mixed public/private answer', async () => {
    const lookup = createPublicDownloadLookup(async () => [{ address: '1.1.1.1', family: 4 }, { address: '127.0.0.1', family: 4 }]);
    await assert.rejects(new Promise((resolve, reject) => lookup('example.com', {}, error => error ? reject(error) : resolve())), /Private/);
});
test('DNS lookup pins one public address used for connection', async () => {
    const lookup = createPublicDownloadLookup(async () => [{ address: '1.1.1.1', family: 4 }]);
    const result = await new Promise((resolve, reject) => lookup('example.com', {}, (error, address, family) => error ? reject(error) : resolve({ address, family })));
    assert.deepEqual(result, { address: '1.1.1.1', family: 4 });
});
test('import streams exact binary bytes and returns checksum', async t => {
    const { name, validate } = await fixture(t);
    const data = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0xff, 0xfe]);
    const seen = mockDownloads(t, [{ chunks: [data.subarray(0, 2), data.subarray(2)], headers: { 'content-type': 'image/png', 'content-length': String(data.length) } }]);
    const result = await importFileToPath({ file, destination: name('nested/picture.png'), expected_sha256: sha256(data) }, validate);
    assert.deepEqual(await fs.readFile(result.path), data);
    assert.equal(result.sha256, sha256(data)); assert.equal(result.bytes, data.length); assert.equal(result.mime_type, 'image/png');
    assert.equal(seen[0].options.autoSelectFamily, false); assert.equal(typeof seen[0].options.lookup, 'function');
    assert.deepEqual(await fs.readdir(name('nested')), ['picture.png']);
});
test('import refuses overwrite by default before any HTTP call', async t => {
    const { name, validate } = await fixture(t);
    await fs.writeFile(name('a'), 'old'); const seen = mockDownloads(t, []);
    await assert.rejects(importFileToPath({ file, destination: name('a') }, validate), /already exists/);
    assert.equal(seen.length, 0); assert.equal(await fs.readFile(name('a'), 'utf8'), 'old');
});
test('explicit overwrite replaces content', async t => {
    const { name, validate } = await fixture(t);
    await fs.writeFile(name('a'), 'old'); mockDownloads(t, [{ chunks: [Buffer.from('new')] }]);
    await importFileToPath({ file, destination: name('a'), overwrite: true }, validate);
    assert.equal(await fs.readFile(name('a'), 'utf8'), 'new');
});
test('checksum mismatch leaves destination untouched and cleans staging', async t => {
    const { root, name, validate } = await fixture(t);
    await fs.writeFile(name('a'), 'old'); mockDownloads(t, [{}]);
    await assert.rejects(importFileToPath({ file, destination: name('a'), overwrite: true, expected_sha256: '0'.repeat(64) }, validate), /SHA-256/);
    assert.equal(await fs.readFile(name('a'), 'utf8'), 'old'); assert.deepEqual(await fs.readdir(root), ['a']);
});
test('failed or truncated streams do not publish a partial destination', async t => {
    const { root, name, validate } = await fixture(t);
    mockDownloads(t, [{ chunks: [Buffer.from('partial')], streamError: 'broken stream with SECRET' }]);
    await assert.rejects(importFileToPath({ file, destination: name('a') }, validate), error => !error.message.includes('SECRET'));
    assert.deepEqual(await fs.readdir(root), []);
});
test('invalid Content-Length is refused before writing', async t => {
    const { root, name, validate } = await fixture(t);
    mockDownloads(t, [{ headers: { 'content-length': String(MAX_IMPORT_BYTES + 1) } }]);
    await assert.rejects(importFileToPath({ file, destination: name('a') }, validate), /oversized/);
    assert.deepEqual(await fs.readdir(root), []);
});
test('chunked oversized downloads are bounded even without Content-Length', async t => {
    const { root, name, validate } = await fixture(t);
    mockDownloads(t, [{ chunks: Array(101).fill(Buffer.alloc(1024 * 1024)) }]);
    await assert.rejects(importFileToPath({ file, destination: name('a') }, validate), /100 MiB/);
    assert.deepEqual(await fs.readdir(root), []);
});
test('length mismatch is rejected', async t => {
    const { name, validate } = await fixture(t);
    mockDownloads(t, [{ headers: { 'content-length': '100' }, chunks: [Buffer.from('small')] }]);
    await assert.rejects(importFileToPath({ file, destination: name('a') }, validate), /length mismatch/);
});
test('redirects retain URL queries but do not forward authorization headers', async t => {
    const { name, validate } = await fixture(t);
    const seen = mockDownloads(t, [{ status: 302, headers: { location: '/new?signature=OTHER' } }, {}]);
    await importFileToPath({ file, destination: name('a') }, validate);
    assert.equal(seen[1].url.pathname, '/new'); assert.equal(seen[1].options.headers.authorization, undefined);
});
test('redirect to a private address is rejected before second request', async t => {
    const { name, validate } = await fixture(t);
    const seen = mockDownloads(t, [{ status: 302, headers: { location: 'https://169.254.169.254/metadata' } }]);
    await assert.rejects(importFileToPath({ file, destination: name('a') }, validate), /Private/);
    assert.equal(seen.length, 1);
});
test('redirect loops are bounded', async t => {
    const { name, validate } = await fixture(t);
    const seen = mockDownloads(t, Array(6).fill({ status: 302, headers: { location: '/again' } }));
    await assert.rejects(importFileToPath({ file, destination: name('a') }, validate), /redirects/);
    assert.equal(seen.length, 6);
});
test('expired references return status without leaking the signed URL', async t => {
    const { name, validate } = await fixture(t);
    mockDownloads(t, [{ status: 403 }]);
    await assert.rejects(importFileToPath({ file, destination: name('a') }, validate), error => error.message.includes('403') && !error.message.includes('SECRET'));
});
test('transport errors cannot leak signed URLs', async t => {
    const { name, validate } = await fixture(t);
    mockDownloads(t, [{ error: file.download_url }]);
    await assert.rejects(importFileToPath({ file, destination: name('a') }, validate), error => !error.message.includes('SECRET'));
});
test('destination created during download is never overwritten by default', async t => {
    const { name, validate } = await fixture(t);
    mockDownloads(t, [{ before: () => fs.writeFile(name('a'), 'other writer') }]);
    await assert.rejects(importFileToPath({ file, destination: name('a') }, validate), { code: 'EEXIST' });
    assert.equal(await fs.readFile(name('a'), 'utf8'), 'other writer');
});
test('import validates the destination before downloading', async t => {
    const { root, validate } = await fixture(t); const seen = mockDownloads(t, []);
    await assert.rejects(importFileToPath({ file, destination: path.join(root, '../outside') }, validate), /not allowed/);
    assert.equal(seen.length, 0);
});
test('file-reference redaction does not mutate execution arguments', () => {
    const args = { file, destination: '/tmp/a' };
    const safe = redactFileInput('import_file', args);
    assert.equal(safe.file, '[file reference redacted]'); assert.equal(args.file.download_url, file.download_url);
    assert.equal(redactFileInput('apply_patch', args), args);
    assert.equal(redactFileInput('import_file', { file: 'SECRET' }).file, '[file reference redacted]');
});
test('binary text updates are refused without modifying the file', async t => {
    const { root, name, validate } = await fixture(t);
    const binary = Buffer.from([0xff, 0, 0xfe]);
    await fs.writeFile(name('a'), binary);
    await assert.rejects(applyPatchToFiles(patch('*** Update File: a\n@@\n+text'), root, validate));
    assert.deepEqual(await fs.readFile(name('a')), binary);
});
test('import rejects directories before making an HTTP request', async t => {
    const { root, validate } = await fixture(t); const seen = mockDownloads(t, []);
    await assert.rejects(importFileToPath({ file, destination: root, overwrite: true }, validate), /regular file/);
    assert.equal(seen.length, 0);
});
test('unexpected HTTP content encoding is rejected', async t => {
    const { name, validate } = await fixture(t);
    mockDownloads(t, [{ headers: { 'content-encoding': 'gzip' } }]);
    await assert.rejects(importFileToPath({ file, destination: name('a') }, validate), /Encoded/);
});
test('download timeout aborts and cleans staging (accelerated clock)', async t => {
    const { root, name, validate } = await fixture(t);
    const originalGet = https.get;
    const originalSetTimeout = globalThis.setTimeout;
    t.after(() => { https.get = originalGet; globalThis.setTimeout = originalSetTimeout; });
    globalThis.setTimeout = (callback, delay, ...args) => {
        const timer = originalSetTimeout(callback, delay === 45000 ? 5 : delay, ...args);
        // A real socket keeps the event loop alive; emulate that for this no-socket test.
        if (delay === 45000) timer.unref = () => timer;
        return timer;
    };
    https.get = (_url, options, _callback) => {
        const request = new EventEmitter();
        options.signal.addEventListener('abort', () => request.emit('error', new Error('aborted')));
        return request;
    };
    await assert.rejects(importFileToPath({ file, destination: name('a') }, validate), /timed out/);
    assert.deepEqual(await fs.readdir(root), []);
});
