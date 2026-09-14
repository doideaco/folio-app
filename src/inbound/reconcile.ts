// Reconciliation: turn a stream of forwarded emails about the same booking into
// one living record. Each email is a "source"; the card's `extracted` record is
// a projection folded from all sources in message-date order. This is the lean,
// Folio-shaped version of the source→events→record model — the pure logic lives
// here (unit-tested); the DB wiring lives in routes/inbound.ts.

/** The record object stored under a card's `extracted` (minus the `kind` tag). */
export type Rec = Record<string, any>;

/** One email that contributed to a record. */
export interface Source {
  /** ISO message date — used to order the fold, so arrival order doesn't matter. */
  date: string;
  rec: Rec;
}

const SCALARS = [
  "record_kind", "title", "subtitle", "date_label", "date",
  "amount", "action_url", "provider", "provider_logo", "status", "notice", "place",
];

/** Purchases (order + its shipment notices) share one record; other kinds key on
 *  their own kind so a hotel confirmation never merges with a flight. */
function family(kind: unknown): string {
  return kind === "order" || kind === "shipment" ? "purchase" : String(kind ?? "other");
}

/** The strong identity of a booking: its reference/confirmation/order number,
 *  normalized. Null when there's no usable reference (never reconcile on weak
 *  signals like city or name alone). */
export function referenceOf(rec: Rec): string | null {
  const fields = (Array.isArray(rec.fields) ? rec.fields : []) as { label?: string; value?: string }[];
  const byLabel = (re: RegExp) => fields.find((f) => re.test(String(f.label ?? "")))?.value;
  const raw = byLabel(/booking ref|reference|pnr/i) ?? byLabel(/confirmation/i) ?? byLabel(/order/i) ?? null;
  if (!raw) return null;
  const norm = String(raw).toUpperCase().replace(/[^A-Z0-9]/g, "");
  return norm.length >= 4 ? norm : null;
}

/** The reconcile key: same key ⇒ same booking. Null ⇒ can't reconcile safely. */
export function reconcileKey(rec: Rec): string | null {
  const ref = referenceOf(rec);
  return ref ? `${family(rec.record_kind)}:${ref}` : null;
}

/** Fold sources into one projection. Deterministic and order-independent: sorting
 *  by message date means a change email that arrives before the original yields
 *  the same result. Later sources override scalars; fields merge by label; the
 *  most recent non-empty segment list wins; omission never deletes. */
export function mergeRecords(sources: Source[]): Rec {
  const ordered = [...sources].sort((a, b) => a.date.localeCompare(b.date));
  const out: Rec = { fields: [] as any[] };
  const fieldByLabel = new Map<string, any>();

  for (const { rec } of ordered) {
    for (const key of SCALARS) {
      const v = rec[key];
      if (v !== undefined && v !== null && v !== "") out[key] = v;
    }
    if (Array.isArray(rec.segments) && rec.segments.length) out.segments = rec.segments;
    if (Array.isArray(rec.fields)) {
      for (const f of rec.fields) {
        const label = String(f?.label ?? "").toLowerCase();
        if (label) fieldByLabel.set(label, f); // later wins, first-seen order kept
      }
    }
  }
  out.fields = [...fieldByLabel.values()];
  return out;
}

/** Human "what changed" lines between two projections (before → after). Empty for
 *  the first email. Compares status, amount, the key date, and per-label fields;
 *  references are ignored (they're the identity, not a change). */
export function diffRecords(before: Rec | null, after: Rec): string[] {
  if (!before) return [];
  const lines: string[] = [];

  if (after.status && before.status !== after.status) {
    lines.push(`Status: ${before.status ?? "—"} → ${after.status}`);
  }
  if (after.amount && before.amount !== after.amount) {
    lines.push(`Amount: ${before.amount ?? "—"} → ${after.amount}`);
  }
  if (after.date && before.date !== after.date) {
    const label = after.date_label ?? "Date";
    lines.push(`${label} changed`);
  }

  const beforeFields = new Map<string, string>(
    (Array.isArray(before.fields) ? before.fields : []).map((f: any) => [String(f?.label ?? "").toLowerCase(), String(f?.value ?? "")])
  );
  const isRef = (label: string) => /booking ref|reference|pnr|confirmation|order/i.test(label);
  for (const f of (Array.isArray(after.fields) ? after.fields : [])) {
    const label = String(f?.label ?? "");
    const key = label.toLowerCase();
    if (!label || isRef(key)) continue;
    const now = String(f?.value ?? "");
    const was = beforeFields.get(key);
    if (was !== undefined && was !== now) lines.push(`${label}: ${was} → ${now}`);
  }
  return lines.slice(0, 6);
}
