// Opaque cursor over the change_log sequence. base64 of the numeric seq.

export function encodeCursor(seq: number | bigint): string {
  return Buffer.from(String(seq)).toString("base64url");
}

export function decodeCursor(cursor: string | undefined | null): bigint {
  if (!cursor) return 0n;
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const n = BigInt(raw);
    return n >= 0n ? n : 0n;
  } catch {
    return 0n;
  }
}
