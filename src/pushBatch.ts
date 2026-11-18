// Coalesces "@x added a save" pushes so a burst of saves doesn't buzz everyone
// on the board once per card. The first save notifies straight away (nobody
// waits for a single save); further saves by the same person to the same board
// within the window are rolled into one follow-up — "@sam added 4 more saves".
//
// State is in memory: the backend runs as a single machine, and a restart only
// risks dropping one pending follow-up, never a duplicate.

export type BoardNotifier = (
  boardId: string,
  actorId: string,
  title: string,
  body: string,
  extra: Record<string, string>
) => Promise<void>;

export interface SaveEvent {
  boardId: string;
  boardName: string;
  actorId: string;
  handle: string | null;
  cardId: string;
  /** The card's title if it's already known (links get theirs after extraction). */
  cardTitle?: string | null;
}

interface Batch {
  boardName: string;
  handle: string | null;
  /** Saves since the immediate push, waiting for the follow-up. */
  more: number;
  /** The single extra card, so a follow-up of one can still open it. */
  lastCardId: string | null;
}

export interface SaveBatcherOptions {
  windowMs?: number;
  notify: BoardNotifier;
  setTimer?: (fn: () => void, ms: number) => unknown;
}

export const DEFAULT_SAVE_WINDOW_MS = 3 * 60 * 1000;

export function createSaveBatcher(options: SaveBatcherOptions) {
  const windowMs = options.windowMs ?? DEFAULT_SAVE_WINDOW_MS;
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms).unref());
  const batches = new Map<string, Batch>();

  const who = (handle: string | null) => `@${handle ?? "someone"}`;

  function flush(key: string, boardId: string, actorId: string) {
    const batch = batches.get(key);
    batches.delete(key);
    if (!batch || batch.more === 0) return;
    const body =
      batch.more === 1
        ? `${who(batch.handle)} added another save`
        : `${who(batch.handle)} added ${batch.more} more saves`;
    // One extra card opens that card; several open the board.
    const extra: Record<string, string> =
      batch.more === 1 && batch.lastCardId
        ? { board_id: boardId, card_id: batch.lastCardId }
        : { board_id: boardId };
    void options.notify(boardId, actorId, batch.boardName, body, extra);
  }

  return {
    /** Record a new save; pushes now, or folds it into the pending follow-up. */
    add(event: SaveEvent): void {
      const key = `${event.boardId}:${event.actorId}`;
      const existing = batches.get(key);
      if (existing) {
        existing.more += 1;
        existing.lastCardId = event.cardId;
        existing.boardName = event.boardName;
        return;
      }
      batches.set(key, { boardName: event.boardName, handle: event.handle, more: 0, lastCardId: null });
      setTimer(() => flush(key, event.boardId, event.actorId), windowMs);
      const title = event.cardTitle?.trim();
      const body = title
        ? `${who(event.handle)} added “${title.length > 80 ? title.slice(0, 79) + "…" : title}”`
        : `${who(event.handle)} added a save`;
      void options.notify(event.boardId, event.actorId, event.boardName, body, {
        board_id: event.boardId,
        card_id: event.cardId,
      });
    },
    /** Pending follow-ups (for tests / diagnostics). */
    get pendingCount(): number {
      return batches.size;
    },
  };
}
