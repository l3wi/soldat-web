import { MetricHistogram, type MetricHistogramSnapshot } from "./metric-histogram.ts";
import type { NodeTransportObserver } from "./transport/ws-server.ts";

export const TRANSPORT_METRICS = ["residenceMs", "oldestQueuedAgeMs", "inFlightAgeMs", "queuedPackets", "queuedBytes", "inFlightBytes", "socketBufferedBytes"] as const;
export type TransportMetricName = typeof TRANSPORT_METRICS[number];
export type TransportQueueMetrics = Record<TransportMetricName, MetricHistogramSnapshot>;

/** Residence samples cover socket handoffs. Other distributions are instantaneous
 * per-socket gauges observed on queue changes and report/flush, not time-weighted
 * averages or peer acknowledgements. The observer never sees packet bytes.
 */
export class TransportMetrics implements NodeTransportObserver {
  private readonly histograms = Object.fromEntries(TRANSPORT_METRICS.map(name => [name, new MetricHistogram(name === "queuedPackets")])) as Record<TransportMetricName, MetricHistogram>;

  handoff(residenceMs: number): void { this.histograms.residenceMs.add(residenceMs); }

  queueState(queuedPackets: number, queuedBytes: number, inFlightBytes: number, socketBufferedBytes: number, oldestQueuedAgeMs: number, inFlightAgeMs: number): void {
    this.histograms.queuedPackets.add(queuedPackets);
    this.histograms.queuedBytes.add(queuedBytes);
    this.histograms.inFlightBytes.add(inFlightBytes);
    this.histograms.socketBufferedBytes.add(socketBufferedBytes);
    this.histograms.oldestQueuedAgeMs.add(oldestQueuedAgeMs);
    this.histograms.inFlightAgeMs.add(inFlightAgeMs);
  }

  take(): TransportQueueMetrics {
    return Object.fromEntries(TRANSPORT_METRICS.map(name => [name, this.histograms[name].take()])) as TransportQueueMetrics;
  }
}
