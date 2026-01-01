import {
  FirehoseTransformationEvent,
  FirehoseTransformationResult,
  FirehoseTransformationResultRecord,
} from "aws-lambda";

/**
 * Analytics record structure for Athena queries
 */
interface AnalyticsRecord {
  event_type: string;
  order_id: string;
  customer_id: string;
  store_id: string | null;
  county_id: string | null;
  status: string | null;
  payment_state: string | null;
  subtotal: number | null;
  tax: number | null;
  total: number | null;
  item_count: number | null;
  event_timestamp: string;
  created_at: string | null;
}

/**
 * Firehose Data Transformation Lambda
 *
 * This handler transforms raw EventBridge events into a flattened,
 * analytics-friendly format suitable for Athena queries.
 *
 * Transformations:
 * - Flatten nested structures
 * - Normalize field names
 * - Add consistent timestamp format
 * - Handle missing fields gracefully
 */
export async function handler(
  event: FirehoseTransformationEvent
): Promise<FirehoseTransformationResult> {
  console.log(`Processing ${event.records.length} records`);

  const output: FirehoseTransformationResultRecord[] = event.records.map((record) => {
    try {
      // Decode base64 payload
      const payload = Buffer.from(record.data, "base64").toString("utf-8");
      const data = JSON.parse(payload);

      // Transform to analytics format
      const analyticsRecord = transformToAnalyticsFormat(data);

      // Encode back to base64 with newline delimiter for JSON lines format
      const transformedData = Buffer.from(
        JSON.stringify(analyticsRecord) + "\n"
      ).toString("base64");

      return {
        recordId: record.recordId,
        result: "Ok" as const,
        data: transformedData,
      };
    } catch (error) {
      console.error("Error transforming record:", record.recordId, error);

      // Return original data on error (will go to error prefix in S3)
      return {
        recordId: record.recordId,
        result: "ProcessingFailed" as const,
        data: record.data,
      };
    }
  });

  console.log(`Transformed ${output.filter((r) => r.result === "Ok").length} records successfully`);

  return { records: output };
}

/**
 * Transform EventBridge event to analytics-friendly format
 */
function transformToAnalyticsFormat(event: Record<string, unknown>): AnalyticsRecord {
  // Handle both direct events and EventBridge wrapped events
  const detail = (event.detail as Record<string, unknown>) || event;

  const eventTimestamp = (event.time as string) ||
    (detail.timestamp as string) ||
    new Date().toISOString();

  return {
    event_type: String(detail.event_type || event["detail-type"] || "UNKNOWN"),
    order_id: String(detail.order_id || ""),
    customer_id: String(detail.customer_id || ""),
    store_id: detail.store_id ? String(detail.store_id) : null,
    county_id: detail.county_id ? String(detail.county_id) : null,
    status: detail.status ? String(detail.status) : (detail.new_status ? String(detail.new_status) : null),
    payment_state: detail.payment_state ? String(detail.payment_state) : (detail.new_state ? String(detail.new_state) : null),
    subtotal: typeof detail.subtotal === "number" ? detail.subtotal : null,
    tax: typeof detail.tax === "number" ? detail.tax : null,
    total: typeof detail.total === "number" ? detail.total : null,
    item_count: typeof detail.item_count === "number" ? detail.item_count :
      (Array.isArray(detail.items) ? detail.items.length : null),
    event_timestamp: formatTimestamp(eventTimestamp),
    created_at: detail.created_at ? formatTimestamp(String(detail.created_at)) : null,
  };
}

/**
 * Format timestamp for Athena compatibility
 */
function formatTimestamp(timestamp: string): string {
  try {
    const date = new Date(timestamp);
    // Format: YYYY-MM-DD HH:MM:SS.mmm
    return date.toISOString().replace("T", " ").replace("Z", "");
  } catch {
    return timestamp;
  }
}
