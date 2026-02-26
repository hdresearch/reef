/**
 * Server-side event bus — lets service modules communicate without
 * importing each other. Same pattern as pi.events on the client side.
 *
 * Typed loosely on purpose: modules define their own event shapes,
 * and subscribers cast as needed. This keeps the bus decoupled from
 * any specific module's types.
 */

type Handler = (data: any) => void | Promise<void>;

export class ServiceEventBus {
  private handlers = new Map<string, Set<Handler>>();

  /** Subscribe to an event. Returns an unsubscribe function. */
  on(event: string, handler: Handler): () => void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler);
    return () => {
      this.handlers.get(event)?.delete(handler);
    };
  }

  /** Emit an event. Handlers run in order, errors are caught and logged. */
  async emit(event: string, data?: unknown): Promise<void> {
    const handlers = this.handlers.get(event);
    if (!handlers) return;

    for (const handler of handlers) {
      try {
        await handler(data);
      } catch (err) {
        console.error(`[events] Handler error for "${event}":`, err);
      }
    }
  }

  /** Fire and forget — emit without awaiting handlers. */
  fire(event: string, data?: unknown): void {
    this.emit(event, data).catch(() => {});
  }
}
