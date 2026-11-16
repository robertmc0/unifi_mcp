/**
 * A small metrics registry with Prometheus text output (spec §12; ADR 0025).
 *
 * Labels are bounded by construction: every label of a metric is declared with the
 * complete list of values it can take. A value outside that list is recorded as the
 * label's last declared value (by convention `other`), so no input can create a new time
 * series. The one exception is a *code label* (`codeLabel`), for this service's own error
 * codes: it accepts lower-case identifiers only (`[a-z][a-z0-9_]*`, which no UUID, address
 * or host name matches) and a fixed number of distinct values, then `other`. Names,
 * addresses and identifiers therefore cannot become label values.
 *
 * There is no dependency and no global state: the service owns one registry and renders
 * it on request.
 */

const METRIC_NAME = /^[a-z][a-z0-9_]{0,99}$/;
const LABEL_NAME = /^[a-z][a-z0-9_]{0,31}$/;
const LABEL_VALUE = /^[A-Za-z0-9_.:-]{1,64}$/;
/** More series than this for one metric is a design error, not a runtime condition. */
const MAX_SERIES = 512;

export type MetricType = 'counter' | 'gauge' | 'histogram';

/** A label for this service's own codes: identifiers only, at most `max` distinct values. */
export interface CodeLabel {
  readonly code: true;
  readonly max: number;
}

export function codeLabel(max: number): CodeLabel {
  return { code: true, max };
}

const CODE_VALUE = /^[a-z][a-z0-9_]{0,47}$/;
const CODE_FALLBACK = 'other';

/**
 * Each label with the values it can take, in output order: a complete list, whose last
 * entry is the fallback, or a code label.
 */
export type LabelSets = Readonly<Record<string, readonly string[] | CodeLabel>>;

function isCodeLabel(set: readonly string[] | CodeLabel): set is CodeLabel {
  return !Array.isArray(set);
}

export interface MetricDefinition {
  name: string;
  help: string;
  type: MetricType;
  labels?: LabelSets;
  /** Histograms only: upper bounds in ascending order (`+Inf` is added). */
  buckets?: readonly number[];
}

export interface MetricFamily {
  name: string;
  help: string;
  type: MetricType;
  labels: LabelSets;
}

type Labels = Readonly<Record<string, string>>;

function escapeHelp(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
}

function formatNumber(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Infinity) return '+Inf';
  if (value === -Infinity) return '-Inf';
  return String(value);
}

abstract class Metric {
  readonly definition: MetricDefinition;
  readonly labelNames: readonly string[];
  readonly #sets: LabelSets;
  readonly #codes = new Map<string, Set<string>>();

  constructor(definition: MetricDefinition) {
    if (!METRIC_NAME.test(definition.name)) {
      throw new TypeError(`Invalid metric name: ${definition.name}`);
    }
    if (definition.help.trim() === '') {
      throw new TypeError(`Metric ${definition.name} needs a help text.`);
    }
    const sets = definition.labels ?? {};
    let series = 1;
    for (const [label, values] of Object.entries(sets)) {
      if (!LABEL_NAME.test(label) || label === 'le') {
        throw new TypeError(`Invalid label name on ${definition.name}: ${label}`);
      }
      if (isCodeLabel(values)) {
        if (!Number.isInteger(values.max) || values.max < 1) {
          throw new TypeError(`Code label ${label} of ${definition.name} needs a maximum.`);
        }
        series *= values.max + 1;
        continue;
      }
      if (values.length === 0 || new Set(values).size !== values.length) {
        throw new TypeError(`Label ${label} of ${definition.name} needs distinct values.`);
      }
      for (const value of values) {
        if (!LABEL_VALUE.test(value)) {
          throw new TypeError(`Invalid value for label ${label} of ${definition.name}: ${value}`);
        }
      }
      series *= values.length;
    }
    if (series > MAX_SERIES) {
      throw new TypeError(`Metric ${definition.name} would have ${String(series)} series.`);
    }
    this.definition = definition;
    this.labelNames = Object.keys(sets);
    this.#sets = sets;
  }

  /** The series key for `labels`: undeclared values fall back, missing ones too. */
  protected key(labels: Labels): string {
    return this.labelNames
      .map((name) => {
        const allowed = this.#sets[name] ?? [];
        const value = labels[name];
        if (isCodeLabel(allowed)) return this.#code(name, allowed, value);
        return value !== undefined && allowed.includes(value) ? value : (allowed.at(-1) ?? '');
      })
      .join('\u0001');
  }

  #code(name: string, label: CodeLabel, value: string | undefined): string {
    if (value === undefined || !CODE_VALUE.test(value) || value === CODE_FALLBACK) {
      return CODE_FALLBACK;
    }
    let seen = this.#codes.get(name);
    if (seen === undefined) {
      seen = new Set();
      this.#codes.set(name, seen);
    }
    if (seen.has(value)) return value;
    if (seen.size >= label.max) return CODE_FALLBACK;
    seen.add(value);
    return value;
  }

  protected renderLabels(key: string, extra = ''): string {
    const values = key === '' && this.labelNames.length === 0 ? [] : key.split('\u0001');
    const parts = this.labelNames.map((name, index) => `${name}="${values[index] ?? ''}"`);
    if (extra !== '') parts.push(extra);
    return parts.length === 0 ? '' : `{${parts.join(',')}}`;
  }

  abstract samples(): string[];
}

export class Counter extends Metric {
  readonly #values = new Map<string, number>();

  inc(labels: Labels = {}, amount = 1): void {
    if (!(amount >= 0) || !Number.isFinite(amount)) return;
    const key = this.key(labels);
    this.#values.set(key, (this.#values.get(key) ?? 0) + amount);
  }

  samples(): string[] {
    const { name } = this.definition;
    if (this.labelNames.length === 0 && this.#values.size === 0) return [`${name} 0`];
    return [...this.#values].map(
      ([key, value]) => `${name}${this.renderLabels(key)} ${formatNumber(value)}`,
    );
  }
}

export class Gauge extends Metric {
  readonly #values = new Map<string, number>();

  set(labels: Labels, value: number): void {
    this.#values.set(this.key(labels), value);
  }

  /** Forgets every series (collectors set them again at each scrape). */
  reset(): void {
    this.#values.clear();
  }

  samples(): string[] {
    const { name } = this.definition;
    return [...this.#values].map(
      ([key, value]) => `${name}${this.renderLabels(key)} ${formatNumber(value)}`,
    );
  }
}

export class Histogram extends Metric {
  readonly #buckets: readonly number[];
  readonly #series = new Map<string, { counts: number[]; sum: number; count: number }>();

  constructor(definition: MetricDefinition) {
    super(definition);
    const buckets = definition.buckets ?? [];
    if (
      buckets.length === 0 ||
      buckets.some((bound, i) => !Number.isFinite(bound) || bound <= (buckets[i - 1] ?? -Infinity))
    ) {
      throw new TypeError(`Histogram ${definition.name} needs ascending finite buckets.`);
    }
    this.#buckets = buckets;
  }

  observe(labels: Labels, value: number): void {
    if (!Number.isFinite(value) || value < 0) return;
    const key = this.key(labels);
    let series = this.#series.get(key);
    if (series === undefined) {
      series = { counts: this.#buckets.map(() => 0), sum: 0, count: 0 };
      this.#series.set(key, series);
    }
    const index = this.#buckets.findIndex((bound) => value <= bound);
    if (index !== -1) series.counts[index] = (series.counts[index] ?? 0) + 1;
    series.sum += value;
    series.count += 1;
  }

  samples(): string[] {
    const { name } = this.definition;
    const lines: string[] = [];
    for (const [key, series] of this.#series) {
      let cumulative = 0;
      this.#buckets.forEach((bound, index) => {
        cumulative += series.counts[index] ?? 0;
        lines.push(
          `${name}_bucket${this.renderLabels(key, `le="${formatNumber(bound)}"`)} ${String(cumulative)}`,
        );
      });
      lines.push(`${name}_bucket${this.renderLabels(key, 'le="+Inf"')} ${String(series.count)}`);
      lines.push(`${name}_sum${this.renderLabels(key)} ${formatNumber(series.sum)}`);
      lines.push(`${name}_count${this.renderLabels(key)} ${String(series.count)}`);
    }
    return lines;
  }
}

export const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

export class MetricsRegistry {
  readonly #metrics = new Map<string, Metric>();
  readonly #collectors: (() => void | Promise<void>)[] = [];

  #add<M extends Metric>(metric: M): M {
    const { name } = metric.definition;
    if (this.#metrics.has(name)) throw new TypeError(`Metric ${name} is already registered.`);
    this.#metrics.set(name, metric);
    return metric;
  }

  counter(definition: Omit<MetricDefinition, 'type' | 'buckets'>): Counter {
    return this.#add(new Counter({ ...definition, type: 'counter' }));
  }

  gauge(definition: Omit<MetricDefinition, 'type' | 'buckets'>): Gauge {
    return this.#add(new Gauge({ ...definition, type: 'gauge' }));
  }

  histogram(
    definition: Omit<MetricDefinition, 'type'> & { buckets: readonly number[] },
  ): Histogram {
    return this.#add(new Histogram({ ...definition, type: 'histogram' }));
  }

  /** Runs before every render, to set gauges from current state. */
  collect(collector: () => void | Promise<void>): void {
    this.#collectors.push(collector);
  }

  /** Every registered metric with its declared labels (for documentation and review). */
  families(): MetricFamily[] {
    return [...this.#metrics.values()].map(({ definition }) => ({
      name: definition.name,
      help: definition.help,
      type: definition.type,
      labels: definition.labels ?? {},
    }));
  }

  /**
   * The Prometheus text exposition (format 0.0.4). A collector that fails is skipped: its
   * gauges keep their previous values, and `onError` is told.
   */
  async render(onError: (error: unknown) => void = () => undefined): Promise<string> {
    for (const collector of this.#collectors) {
      try {
        await collector();
      } catch (error) {
        onError(error);
      }
    }
    const lines: string[] = [];
    for (const metric of this.#metrics.values()) {
      const { name, help, type } = metric.definition;
      lines.push(`# HELP ${name} ${escapeHelp(help)}`, `# TYPE ${name} ${type}`);
      lines.push(...metric.samples());
    }
    return `${lines.join('\n')}\n`;
  }
}
