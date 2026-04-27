/**
 * Byte-accurate truncation for tool-result text blocks.
 *
 * Operates on UTF-8 byte length (not JS string .length), because the agent
 * context budget is measured in tokens which are tied to bytes, and a single
 * emoji can be 4 bytes / 2 UTF-16 units. We reserve 100 bytes for the trailing
 * marker so the final output stays under \`maxBytes\` even after the marker is
 * appended.
 */
export function truncate(text: string, maxBytes: number): string {
  // Defensive: non-positive limit means "do nothing".
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return text;

  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;

  const reserve = 100;
  const headBytes = Math.max(0, maxBytes - reserve);
  // Buffer#toString may yield a partial UTF-8 sequence at the boundary; that
  // becomes a U+FFFD which is fine — caller will see clean text, not raw
  // bytes.
  const head = buf.subarray(0, headBytes).toString("utf8");
  const dropped = buf.length - headBytes;
  return (
    head +
    `\n\n[...TRUNCATED ${dropped} bytes by tsa-transform-tool-result; original ${buf.length} bytes]`
  );
}
