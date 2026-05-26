/**
 * Mocks for human-in-the-loop channel tests (Slack, Discord, Email, SMS, etc.)
 * Each mock simulates the external SDK/API the channel wraps.
 */

export interface SentMessage {
  to: string;
  content: string;
  metadata?: Record<string, unknown>;
  timestamp: number;
}

export class MockSlackClient {
  private _sentMessages: SentMessage[] = [];
  private shouldThrow = false;

  get sentMessages() { return this._sentMessages; }

  async postMessage(channel: string, text: string, opts?: Record<string, unknown>): Promise<{ ok: boolean; ts: string }> {
    if (this.shouldThrow) throw new Error('MockSlack: API error');
    this._sentMessages.push({ to: channel, content: text, metadata: opts, timestamp: Date.now() });
    return { ok: true, ts: `${Date.now()}.000` };
  }

  setThrow(shouldThrow: boolean): void { this.shouldThrow = shouldThrow; }
  reset(): void { this._sentMessages = []; this.shouldThrow = false; }
}

export class MockDiscordClient {
  private _sentMessages: SentMessage[] = [];
  private shouldThrow = false;

  get sentMessages() { return this._sentMessages; }

  async sendMessage(channelId: string, content: string): Promise<{ id: string }> {
    if (this.shouldThrow) throw new Error('MockDiscord: API error');
    this._sentMessages.push({ to: channelId, content, timestamp: Date.now() });
    return { id: `msg-${this._sentMessages.length}` };
  }

  setThrow(shouldThrow: boolean): void { this.shouldThrow = shouldThrow; }
  reset(): void { this._sentMessages = []; this.shouldThrow = false; }
}

export class MockEmailClient {
  private _sentEmails: Array<{ to: string; subject: string; body: string; timestamp: number }> = [];
  private shouldThrow = false;

  get sentEmails() { return this._sentEmails; }

  async send(to: string, subject: string, body: string): Promise<{ messageId: string }> {
    if (this.shouldThrow) throw new Error('MockEmail: SMTP error');
    this._sentEmails.push({ to, subject, body, timestamp: Date.now() });
    return { messageId: `email-${this._sentEmails.length}` };
  }

  setThrow(shouldThrow: boolean): void { this.shouldThrow = shouldThrow; }
  reset(): void { this._sentEmails = []; this.shouldThrow = false; }
}

export class MockSMSClient {
  private _sentSMS: SentMessage[] = [];
  private shouldThrow = false;

  get sentSMS() { return this._sentSMS; }

  async send(to: string, body: string): Promise<{ sid: string }> {
    if (this.shouldThrow) throw new Error('MockSMS: Twilio error');
    this._sentSMS.push({ to, content: body, timestamp: Date.now() });
    return { sid: `sms-${this._sentSMS.length}` };
  }

  setThrow(shouldThrow: boolean): void { this.shouldThrow = shouldThrow; }
  reset(): void { this._sentSMS = []; this.shouldThrow = false; }
}

export class MockWhatsAppClient {
  private _sentMessages: SentMessage[] = [];
  private shouldThrow = false;

  get sentMessages() { return this._sentMessages; }

  async sendMessage(to: string, text: string): Promise<{ id: string }> {
    if (this.shouldThrow) throw new Error('MockWhatsApp: API error');
    this._sentMessages.push({ to, content: text, timestamp: Date.now() });
    return { id: `wa-${this._sentMessages.length}` };
  }

  setThrow(shouldThrow: boolean): void { this.shouldThrow = shouldThrow; }
  reset(): void { this._sentMessages = []; this.shouldThrow = false; }
}

export class MockTelegramClient {
  private _sentMessages: SentMessage[] = [];
  private shouldThrow = false;

  get sentMessages() { return this._sentMessages; }

  async sendMessage(chatId: string, text: string): Promise<{ message_id: number }> {
    if (this.shouldThrow) throw new Error('MockTelegram: Bot API error');
    this._sentMessages.push({ to: chatId, content: text, timestamp: Date.now() });
    return { message_id: this._sentMessages.length };
  }

  setThrow(shouldThrow: boolean): void { this.shouldThrow = shouldThrow; }
  reset(): void { this._sentMessages = []; this.shouldThrow = false; }
}

export class MockPushNotificationClient {
  private _sentNotifications: Array<{ token: string; title: string; body: string; timestamp: number }> = [];
  private shouldThrow = false;

  get sentNotifications() { return this._sentNotifications; }

  async send(token: string, title: string, body: string): Promise<{ success: boolean }> {
    if (this.shouldThrow) throw new Error('MockPush: FCM error');
    this._sentNotifications.push({ token, title, body, timestamp: Date.now() });
    return { success: true };
  }

  setThrow(shouldThrow: boolean): void { this.shouldThrow = shouldThrow; }
  reset(): void { this._sentNotifications = []; this.shouldThrow = false; }
}

export class MockWebhookClient {
  private _sentPayloads: Array<{ url: string; payload: unknown; timestamp: number }> = [];
  private shouldThrow = false;
  private responseStatus = 200;

  get sentPayloads() { return this._sentPayloads; }

  async post(url: string, payload: unknown): Promise<{ status: number }> {
    if (this.shouldThrow) throw new Error('MockWebhook: connection refused');
    this._sentPayloads.push({ url, payload, timestamp: Date.now() });
    return { status: this.responseStatus };
  }

  setThrow(shouldThrow: boolean): void { this.shouldThrow = shouldThrow; }
  setResponseStatus(status: number): void { this.responseStatus = status; }
  reset(): void { this._sentPayloads = []; this.shouldThrow = false; this.responseStatus = 200; }
}
