export interface Span {
  id: string;
  traceId: string;
  parentSpanId?: string;
  name: string;
  startTime: number;
  endTime?: number;
  status: 'ok' | 'error' | 'timeout';
  attributes: Record<string, unknown>;
  events: Array<{ name: string; timestamp: number; attributes?: Record<string, unknown> }>;
}

export interface Metric {
  name: string;
  value: number;
  labels: Record<string, string>;
  timestamp: number;
  type: 'counter' | 'gauge' | 'histogram';
}

export interface StructuredLog {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  traceId?: string;
  spanId?: string;
  agentId?: string;
  turnNumber?: number;
  timestamp: number;
  context: Record<string, unknown>;
}

export interface ObservabilityConfig {
  /** Max spans to buffer */
  maxBufferSize?: number;
  /** Enable sampling (0-1) */
  samplingRate?: number;
  /** Rate limit for log output */
  logRateLimit?: number; // per second
}

/**
 * Observability system providing distributed tracing (spans), metrics (counters/gauges/histograms),
 * structured logging with rate limiting, buffer-based export, and cascade error detection.
 */
export class Observability {
  private config: Required<ObservabilityConfig>;
  private spans: Span[] = [];
  private metrics: Metric[] = [];
  private logs: StructuredLog[] = [];
  private activeSpans = new Map<string, Span>();
  private traceCounter = 0;
  private spanCounter = 0;
  private logCount = 0;
  private logWindowStart = Date.now();
  private _exported: { spans: Span[]; metrics: Metric[]; logs: StructuredLog[] } = { spans: [], metrics: [], logs: [] };
  private buffer: { spans: Span[]; metrics: Metric[] } = { spans: [], metrics: [] };
  private shedding = false;

  /**
   * Create a new Observability instance with optional configuration.
   *
   * @param config - Configuration for buffer size, sampling rate, and log rate limiting
   */
  constructor(config: ObservabilityConfig = {}) {
    this.config = {
      maxBufferSize: config.maxBufferSize ?? 10000,
      samplingRate: config.samplingRate ?? 1.0,
      logRateLimit: config.logRateLimit ?? 100,
    };
  }

  get allSpans() { return this.spans; }
  get allMetrics() { return this.metrics; }
  get allLogs() { return this.logs; }
  get exported() { return this._exported; }
  get isShedding() { return this.shedding; }


  startSpan(name: string, options?: { traceId?: string; parentSpanId?: string; attributes?: Record<string, unknown> }): Span {
    const span: Span = {
      id: `span-${++this.spanCounter}`,
      traceId: options?.traceId || `trace-${++this.traceCounter}`,
      parentSpanId: options?.parentSpanId,
      name,
      startTime: Date.now(),
      status: 'ok',
      attributes: options?.attributes || {},
      events: [],
    };
    this.activeSpans.set(span.id, span);
    return span;
  }

  endSpan(spanId: string, status?: 'ok' | 'error' | 'timeout', attributes?: Record<string, unknown>): void {
    const span = this.activeSpans.get(spanId);
    if (!span) return;
    span.endTime = Date.now();
    if (status) span.status = status;
    if (attributes) span.attributes = { ...span.attributes, ...attributes };
    this.activeSpans.delete(spanId);

    if (this.spans.length >= this.config.maxBufferSize) {
      this.shedding = true;
        this.spans.shift();
    }

    this.spans.push(span);
    this.buffer.spans.push(span);
  }

  addSpanEvent(spanId: string, name: string, attributes?: Record<string, unknown>): void {
    const span = this.activeSpans.get(spanId) || this.spans.find(s => s.id === spanId);
    if (span) {
      span.events.push({ name, timestamp: Date.now(), attributes });
    }
  }

  /**
   * End all active spans (e.g., on crash - ensures no orphaned spans)
   */
  endAllActiveSpans(status: 'error' | 'timeout' = 'error'): number {
    let count = 0;
    for (const [id] of this.activeSpans) {
      this.endSpan(id, status);
      count++;
    }
    return count;
  }

  /**
   * Get trace (all spans with same traceId)
   */
  getTrace(traceId: string): Span[] {
    return this.spans.filter(s => s.traceId === traceId);
  }


  incrementCounter(name: string, labels: Record<string, string> = {}, value: number = 1): void {
    const metric: Metric = {
      name,
      value,
      labels,
      timestamp: Date.now(),
      type: 'counter',
    };
    this.metrics.push(metric);
    this.buffer.metrics.push(metric);
    if (this.metrics.length > this.config.maxBufferSize) {
      this.shedding = true;
      this.metrics.shift();
    }
  }

  setGauge(name: string, value: number, labels: Record<string, string> = {}): void {
    const metric: Metric = {
      name,
      value,
      labels,
      timestamp: Date.now(),
      type: 'gauge',
    };
    this.metrics.push(metric);
    this.buffer.metrics.push(metric);
  }

  recordHistogram(name: string, value: number, labels: Record<string, string> = {}): void {
    const metric: Metric = {
      name,
      value,
      labels,
      timestamp: Date.now(),
      type: 'histogram',
    };
    this.metrics.push(metric);
    this.buffer.metrics.push(metric);
  }

  /**
   * Get metrics by name
   */
  getMetrics(name: string): Metric[] {
    return this.metrics.filter(m => m.name === name);
  }

  /**
   * Get metrics by label
   */
  getMetricsByLabel(labelKey: string, labelValue: string): Metric[] {
    return this.metrics.filter(m => m.labels[labelKey] === labelValue);
  }


  log(level: StructuredLog['level'], message: string, context: Record<string, unknown> = {}): void {
    const now = Date.now();
    if (now - this.logWindowStart > 1000) {
      this.logCount = 0;
      this.logWindowStart = now;
    }
    this.logCount++;
    if (this.logCount > this.config.logRateLimit) {
      return; // Rate limited
    }

    this.logs.push({
      level,
      message,
      timestamp: now,
      context,
      traceId: context.traceId as string | undefined,
      spanId: context.spanId as string | undefined,
      agentId: context.agentId as string | undefined,
      turnNumber: context.turnNumber as number | undefined,
    });
  }


  /**
   * Export buffered data (simulates sending to observability backend)
   */
  export(): { spans: Span[]; metrics: Metric[] } {
    const data = { spans: [...this.buffer.spans], metrics: [...this.buffer.metrics] };
    this._exported.spans.push(...data.spans);
    this._exported.metrics.push(...data.metrics);
    this.buffer = { spans: [], metrics: [] };
    this.shedding = false;
    return data;
  }

  /**
   * Get buffer size (for detecting bottleneck)
   */
  getBufferSize(): number {
    return this.buffer.spans.length + this.buffer.metrics.length;
  }


  /**
   * Correlate errors across agents via traceId
   */
  getCorrelatedErrors(traceId: string): Array<{ span: Span; log?: StructuredLog }> {
    const errorSpans = this.spans.filter(s => s.traceId === traceId && s.status === 'error');
    return errorSpans.map(span => ({
      span,
      log: this.logs.find(l => l.traceId === traceId && l.spanId === span.id),
    }));
  }

  /**
   * Detect cascade pattern (rapid sequential errors)
   */
  detectCascade(windowMs: number = 5000, threshold: number = 3): { detected: boolean; rootSpan?: Span; affectedSpans: Span[] } {
    const errorSpans = this.spans.filter(s => s.status === 'error').sort((a, b) => a.startTime - b.startTime);

    for (let i = 0; i < errorSpans.length; i++) {
      const window = errorSpans.filter(
        s => s.startTime >= errorSpans[i].startTime && s.startTime <= errorSpans[i].startTime + windowMs
      );
      if (window.length >= threshold) {
        return { detected: true, rootSpan: window[0], affectedSpans: window.slice(1) };
      }
    }

    return { detected: false, affectedSpans: [] };
  }

  reset(): void {
    this.spans = [];
    this.metrics = [];
    this.logs = [];
    this.activeSpans.clear();
    this.buffer = { spans: [], metrics: [] };
    this._exported = { spans: [], metrics: [], logs: [] };
    this.shedding = false;
    this.traceCounter = 0;
    this.spanCounter = 0;
  }
}
