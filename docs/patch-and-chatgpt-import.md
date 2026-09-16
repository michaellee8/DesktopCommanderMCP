# OpenAI-style patching and ChatGPT file import

This extension adds exactly two MCP tools: `apply_patch` and `import_file`.
It does not add devbox-to-ChatGPT export, a sandbox, an approval service, a model
call, or a Codex installation requirement. Existing Desktop Commander tools and
execution settings are unchanged. No package dependencies are added.

## apply_patch

```json
{
  "cwd": "/home/user/project",
  "patch": "*** Begin Patch\n*** Update File: src/example.ts\n@@\n-export const enabled = false;\n+export const enabled = true;\n*** Add File: notes.txt\n+Done.\n*** End Patch"
}
```

The patch parser is a dependency-free TypeScript implementation of the
OpenAI/Codex patch **format**, not a wrapper around the Codex agent or a vendored
copy of the Codex Rust engine. It accepts:

- `*** Add File: path`, followed by `+`-prefixed lines.
- `*** Delete File: path`.
- `*** Update File: path`, optional `*** Move to: destination`, and update hunks.
- `@@`, `@@ context text`, and `*** End of File`.
- Context, removed, and inserted lines, prefixed with space, `-`, and `+`.

All file paths, including move destinations, pass through Desktop Commander's
existing `validatePath` / `allowedDirectories` handling. `cwd` is a resolution
base, **not a new sandbox boundary**. Absolute paths are accepted if the existing
configuration permits them. An explicit working directory is required.

Exact context matching is tried first, followed by trailing-whitespace and
surrounding-whitespace matching. Repeated matches select the first match after
the previous hunk; an EOF hunk must match at the end. CRLF-style files retain CRLF
on update; otherwise LF is used. Nonempty updated files end in a newline. Mixed
line endings are normalized to that selected style.

Deliberate limits and differences from upstream implementations:

- Patches are capped at 1 MiB, at most 256 file operations, 16 MiB per existing or
  updated file, and a 64 MiB aggregate before/after working set.
- Updates require UTF-8 text, not binary patches. GNU unified-diff headers and
  numbered `@@ -n,m +n,m @@` hunks are not the Codex patch format.
- Add and move operations refuse to overwrite existing destinations. Use Update
  File for existing text files.
- Final-component symlink patch targets and duplicate/overlapping targets in one
  patch are rejected. Hard-link semantics are not preserved by atomic replacement.
- Every operation is parsed and preflighted before any write. File contents are
  checked again before commit, but this is not protection against adversarial
  concurrent filesystem mutation.
- Writes use sibling staging and per-file atomic publication. A multi-file patch
  is **not a transaction**. A later runtime I/O failure returns the committed
  prefix; it does not claim that previous changes were rolled back. A move is
  reported as creating the destination and deleting the source.

Successful results include `structuredContent.changes` as well as a text summary.
Use version control or backups for recovery.

## import_file: ChatGPT to the MCP host only

Tool arguments:

```json
{
  "file": {
    "download_url": "https://authorized-file-host.example/path?temporary-signature=...",
    "file_id": "file-reference-from-client",
    "mime_type": "image/png",
    "file_name": "reference.png"
  },
  "destination": "/home/user/project/assets/reference.png",
  "overwrite": false,
  "expected_sha256": "optional-64-hex-digit-checksum"
}
```

Omit `expected_sha256` unless the actual checksum is known; the illustrative
value above is not a valid checksum. `mime_type` and `file_name` are optional.

The descriptor declares `_meta["openai/fileParams"] = ["file"]`. A compatible
ChatGPT client supplies the authorized file object. The model should pass the
file through its client file bridge, not invent a URL, reproduce binary data as
base64, or send `sandbox:/mnt/data/...` as a URL.

The handler streams exact binary bytes to a private staging directory beside
the destination, computes SHA-256, and publishes only after the download and any
requested checksum verification succeed. The response includes the absolute
path, byte count, checksum, and HTTP MIME type. The MIME type is informational,
not a content-safety determination.

Behavior:

- Maximum download: 100 MiB. Total download timeout: 45 seconds. At most five
  redirects. Client or remote-relay deadlines can be shorter.
- HTTPS on port 443 only, without URL credentials or fragments. Every redirect
  and the actual socket's resolved IPs are checked. Private/reserved addresses
  (including local and metadata endpoints) are refused. This is a bounded file
  downloader, not a general URL-fetch tool.
- Response compression is not negotiated; unexpectedly encoded responses are
  rejected rather than silently importing different bytes.
- Destination directories are created. Overwrite defaults to false and uses an
  atomic no-clobber publish, including when another writer races the download.
  Explicit overwrite replaces the regular file after download verification.
- New imports are private to the execution user by default. Existing destination
  file modes are preserved on overwrite.
- `file_name` is never used as a filesystem path. Archives are not extracted;
  imported files are not executed. Signed references are redacted in the local
  tool logs/history and the remote integration's argument debug log. External
  relays may have their own logging and retention policies.
- An expired reference returns an HTTP-status error without its signed URL. Ask
  the client for a fresh reference; it cannot be reconstructed from `file_id`
  by the devbox alone.

### ChatGPT integration limitations

Metadata support must survive the complete remote MCP relay, not only the local
stdio server. Refresh/reconnect the MCP app after deploying the new tools.

User-uploaded files and generated artifacts are usable **only when the ChatGPT
client exposes them as authorized file inputs**. A generated image being visible
in the conversation does not prove its original bytes are available to the MCP
file bridge. This extension does not mount ChatGPT's sandbox on the devbox, nor
add devbox-to-ChatGPT export.

The real acceptance test is a generated image transferred through the connected
ChatGPT app, with a byte count and SHA-256 checked on the devbox. That live
end-to-end test is separate from the automated transport-mocked tests.

## Build and test

With the repository's existing dependencies installed:

```sh
npm run build
node --test test/test-patch-and-import.js test/test-patch-import-registration.js
```

The existing `npm test` runner also auto-discovers these test files. The core
suite uses the real parser, filesystem writes, download pipeline, hashing, and
staging cleanup, with only the HTTPS transport and directory-policy callback
substituted. Registration tests check the file schema, metadata, defaults, schema
map, and server dispatch wiring.

No full-repository build or live ChatGPT-to-devbox transfer should be claimed from
the core suite alone.

## References

- OpenAI file-input descriptor contract: https://developers.openai.com/plugins/reference#file-apis
- Codex patch grammar reference: https://github.com/openai/codex/tree/8f38d5a877da8c5c2c0b5158e72bb5f2290a3157/codex-rs/apply-patch
- Desktop Commander integration base: https://github.com/michaellee8/DesktopCommanderMCP/commit/dfa84e3066c4d29195f357f0ebf6c8ccb8e62335
