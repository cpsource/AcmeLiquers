import { ulid } from "ulid";

/**
 * Generate a new order ID using ULID
 * ULIDs are sortable and contain a timestamp component
 */
export function generateOrderId(): string {
  return `ORD-${ulid()}`;
}

/**
 * Generate a composite sort key for orders
 * Format: {ISO timestamp}#{order_id}
 */
export function generateOrderSortKey(orderId: string): string {
  const timestamp = new Date().toISOString();
  return `${timestamp}#${orderId}`;
}

/**
 * Parse order sort key to extract timestamp and order_id
 */
export function parseOrderSortKey(sortKey: string): {
  timestamp: string;
  orderId: string;
} {
  const [timestamp, orderId] = sortKey.split("#");
  return { timestamp, orderId };
}

/**
 * Validate idempotency key format
 * Should be a non-empty string, typically UUID or similar
 */
export function isValidIdempotencyKey(key: string): boolean {
  return typeof key === "string" && key.length >= 8 && key.length <= 128;
}

/**
 * Create a hash for idempotency based on request data
 * Used to detect duplicate requests with same idempotency key but different data
 */
export function hashRequestData(data: unknown): string {
  const json = JSON.stringify(data, Object.keys(data as object).sort());
  let hash = 0;
  for (let i = 0; i < json.length; i++) {
    const char = json.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(16);
}

/**
 * Generate a reservation ID
 */
export function generateReservationId(): string {
  return `RES-${ulid()}`;
}

/**
 * Calculate TTL timestamp (seconds since epoch)
 * @param minutes - Number of minutes from now
 */
export function calculateTTL(minutes: number): number {
  return Math.floor(Date.now() / 1000) + minutes * 60;
}
