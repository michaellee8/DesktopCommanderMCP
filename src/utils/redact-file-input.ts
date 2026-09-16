/** Keep signed file download capabilities out of tool history/debug logs. */
export function redactFileInput(toolName: string, args: unknown): unknown {
    if (toolName !== 'import_file' || !args || typeof args !== 'object' || Array.isArray(args)) return args;
    const record = args as Record<string, unknown>;
    // Redact the entire file object, including malformed inputs. Do not mutate arguments.
    return { ...record, file: '[file reference redacted]' };
}
