/**
 * MockTransportManager - Manages transport with buffering during disconnection
 * Used by error-propagation scenario tests.
 */

export class MockTransportManager {
  private _primary: any = null;
  private _buffer: Array<{ topic: string; message: any }> = [];
  private _eventBus: any;

  constructor(eventBus?: any) {
    this._eventBus = eventBus;
  }

  get bufferedCount() { return this._buffer.length; }

  setPrimary(transport: any): void {
    this._primary = transport;
  }

  async publish(topic: string, message: any): Promise<void> {
    if (!this._primary || !this._primary.isConnected()) {
      this._buffer.push({ topic, message });
      if (this._eventBus) {
        this._eventBus.emit('transport:error', { topic, reason: 'disconnected' });
      }
      return;
    }

    try {
      await this._primary.publish(topic, message);
    } catch (e: any) {
      this._buffer.push({ topic, message });
      if (this._eventBus) {
        this._eventBus.emit('transport:error', { topic, reason: e.message });
      }
    }
  }

  async flush(): Promise<void> {
    if (!this._primary || !this._primary.isConnected()) return;

    const buffered = [...this._buffer];
    this._buffer = [];
    for (const { topic, message } of buffered) {
      try {
        await this._primary.publish(topic, message);
      } catch {
        this._buffer.push({ topic, message });
      }
    }
  }
}
