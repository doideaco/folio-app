// Coalesces bursts of activity so people aren't buzzed once per action. The
// first event notifies straight away (nobody waits for a single save, comment
// or vote); further events with the same key within the window are rolled into
// one follow-up — "@sam added 4 more saves".
//
// State is in memory: the backend runs as a single machine, and a restart only
// risks dropping one pending follow-up, never a duplicate.

export const DEFAULT_SAVE_WINDOW_MS = 3 * 60 * 1000;

export interface BatcherOptions<E> {
  /** Events with the same key are batched together. */
  key: (event: E) => string;
  /** Send the immediate notification for the first event in a window. */
  first: (event: E) => void;
  /** Send the follow-up for `count` further events; `last` is the newest. */
  rollup: (count: number, last: E) => void;
  windowMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
}

export function createBatcher<E>(options: BatcherOptions<E>) {
  const windowMs = options.windowMs ?? DEFAULT_SAVE_WINDOW_MS;
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms).unref());
  const pending = new Map<string, { more: number; last: E }>();

  return {
    /** Record an event: notifies now, or folds it into the pending follow-up. */
    add(event: E): void {
      const key = options.key(event);
      const batch = pending.get(key);
      if (batch) {
        batch.more += 1;
        batch.last = event;
        return;
      }
      pending.set(key, { more: 0, last: event });
      setTimer(() => {
        const done = pending.get(key);
        pending.delete(key);
        if (done && done.more > 0) options.rollup(done.more, done.last);
      }, windowMs);
      options.first(event);
    },
    /** Open windows (for tests / diagnostics). */
    get pendingCount(): number {
      return pending.size;
    },
  };
}

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
  /** A thumbnail to show in the notification, if the card has one. */
  imageURL?: string | null;
}

const who = (handle: string | null) => `@${handle ?? "someone"}`;

/** Trim a title for a notification line. */
export function shortTitle(title: string, max = 80): string {
  const t = title.trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

/** "@x added a save" — first save names the card, the rest roll up. */
export function createSaveBatcher(options: {
  notify: BoardNotifier;
  windowMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
}) {
  return createBatcher<SaveEvent>({
    windowMs: options.windowMs,
    setTimer: options.setTimer,
    key: (e) => `${e.boardId}:${e.actorId}`,
    first: (e) => {
      const title = e.cardTitle?.trim();
      const body = title ? `${who(e.handle)} added “${shortTitle(title)}”` : `${who(e.handle)} added a save`;
      const extra: Record<string, string> = { board_id: e.boardId, card_id: e.cardId };
      if (e.imageURL) extra.image_url = e.imageURL;
      void options.notify(e.boardId, e.actorId, e.boardName, body, extra);
    },
    rollup: (count, last) => {
      const body = count === 1 ? `${who(last.handle)} added another save` : `${who(last.handle)} added ${count} more saves`;
      // One extra card opens that card; several open the board.
      const extra: Record<string, string> =
        count === 1 ? { board_id: last.boardId, card_id: last.cardId } : { board_id: last.boardId };
      void options.notify(last.boardId, last.actorId, last.boardName, body, extra);
    },
  });
}

export interface CommentEvent {
  boardId: string;
  boardName: string;
  actorId: string;
  handle: string | null;
  cardId: string;
  cardTitle: string | null;
  text: string;
  imageURL?: string | null;
}

/** "@jo on “Tartine”: love this" — a chatty burst on one card rolls up. */
export function createCommentBatcher(options: {
  notify: BoardNotifier;
  windowMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
}) {
  const on = (title: string | null) => (title?.trim() ? ` on “${shortTitle(title, 50)}”` : "");
  return createBatcher<CommentEvent>({
    windowMs: options.windowMs,
    setTimer: options.setTimer,
    key: (e) => `${e.cardId}:${e.actorId}`,
    first: (e) => {
      const extra: Record<string, string> = { board_id: e.boardId, card_id: e.cardId };
      if (e.imageURL) extra.image_url = e.imageURL;
      void options.notify(e.boardId, e.actorId, e.boardName,
        `${who(e.handle)}${on(e.cardTitle)}: ${shortTitle(e.text, 120)}`, extra);
    },
    rollup: (count, last) => {
      void options.notify(last.boardId, last.actorId, last.boardName,
        `${who(last.handle)} left ${count} more comment${count === 1 ? "" : "s"}${on(last.cardTitle)}`,
        { board_id: last.boardId, card_id: last.cardId });
    },
  });
}

export type UserNotifier = (userId: string, title: string, body: string, extra: Record<string, string>) => Promise<unknown>;

export interface VoteEvent {
  boardId: string;
  boardName: string;
  voterId: string;
  handle: string | null;
  /** Who saved the card — the one person told about the vote. */
  saverId: string;
  cardId: string;
  cardTitle: string | null;
  imageURL?: string | null;
}

/** "@jo backed your save “Tartine”" — sent only to the card's saver. */
export function createVoteBatcher(options: {
  notify: UserNotifier;
  windowMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
}) {
  return createBatcher<VoteEvent>({
    windowMs: options.windowMs,
    setTimer: options.setTimer,
    key: (e) => `${e.boardId}:${e.voterId}:${e.saverId}`,
    first: (e) => {
      const body = e.cardTitle?.trim()
        ? `${who(e.handle)} backed your save “${shortTitle(e.cardTitle, 60)}”`
        : `${who(e.handle)} backed one of your saves`;
      const extra: Record<string, string> = { type: "vote", board_id: e.boardId, card_id: e.cardId };
      if (e.imageURL) extra.image_url = e.imageURL;
      void options.notify(e.saverId, e.boardName, body, extra);
    },
    rollup: (count, last) => {
      void options.notify(last.saverId, last.boardName,
        `${who(last.handle)} backed ${count} more of your saves`,
        { type: "vote", board_id: last.boardId });
    },
  });
}

export interface ReactionEvent {
  boardId: string;
  boardName: string;
  reactorId: string;
  handle: string | null;
  /** Who saved the card — the one person told about the reaction. */
  saverId: string;
  cardId: string;
  cardTitle: string | null;
  emoji: string;
  imageURL?: string | null;
}

/** "@jo ❤️ your save “Tartine”" — sent only to the card's saver. */
export function createReactionBatcher(options: {
  notify: UserNotifier;
  windowMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
}) {
  return createBatcher<ReactionEvent>({
    windowMs: options.windowMs,
    setTimer: options.setTimer,
    key: (e) => `${e.boardId}:${e.reactorId}:${e.saverId}`,
    first: (e) => {
      const body = e.cardTitle?.trim()
        ? `${who(e.handle)} ${e.emoji} your save “${shortTitle(e.cardTitle, 60)}”`
        : `${who(e.handle)} ${e.emoji} one of your saves`;
      const extra: Record<string, string> = { type: "reaction", board_id: e.boardId, card_id: e.cardId };
      if (e.imageURL) extra.image_url = e.imageURL;
      void options.notify(e.saverId, e.boardName, body, extra);
    },
    rollup: (count, last) => {
      void options.notify(last.saverId, last.boardName,
        `${who(last.handle)} reacted to ${count} more of your saves`,
        { type: "reaction", board_id: last.boardId });
    },
  });
}
