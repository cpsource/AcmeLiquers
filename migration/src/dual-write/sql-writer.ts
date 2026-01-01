import {
  DynamoDBStreamEvent,
  DynamoDBRecord,
  DynamoDBBatchResponse,
  DynamoDBBatchItemFailure,
} from "aws-lambda";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { AttributeValue } from "@aws-sdk/client-dynamodb";
import { Pool, PoolClient } from "pg";
import { Order } from "@acme-liquors/shared";

const ssmClient = new SSMClient({});
const secretsClient = new SecretsManagerClient({});

const DUAL_WRITE_PARAM_NAME = process.env.DUAL_WRITE_PARAM_NAME!;
const SQL_SECRET_ARN = process.env.SQL_SECRET_ARN!;

// Connection pool (reused across invocations)
let pool: Pool | null = null;
let dualWriteEnabled: boolean | null = null;
let lastParamCheck = 0;
const PARAM_CACHE_TTL = 60000; // 1 minute

/**
 * Dual-Write Lambda Handler
 *
 * This handler listens to DynamoDB Streams and writes changes to
 * the legacy SQL database for backward compatibility during migration.
 *
 * Features:
 * - Feature flag controlled (SSM Parameter)
 * - Connection pooling for efficiency
 * - Batch processing with partial failure reporting
 * - Idempotent operations (UPSERT)
 */
export async function handler(
  event: DynamoDBStreamEvent
): Promise<DynamoDBBatchResponse> {
  const batchItemFailures: DynamoDBBatchItemFailure[] = [];

  // Check if dual-write is enabled
  const enabled = await isDualWriteEnabled();
  if (!enabled) {
    console.log("Dual-write is disabled, skipping");
    return { batchItemFailures: [] };
  }

  // Get database connection
  const client = await getDbClient();

  try {
    for (const record of event.Records) {
      try {
        await processRecord(client, record);
      } catch (error) {
        console.error("Error processing record:", record.eventID, error);
        if (record.eventID) {
          batchItemFailures.push({ itemIdentifier: record.eventID });
        }
      }
    }
  } finally {
    client.release();
  }

  return { batchItemFailures };
}

/**
 * Check if dual-write is enabled (with caching)
 */
async function isDualWriteEnabled(): Promise<boolean> {
  const now = Date.now();
  if (dualWriteEnabled !== null && now - lastParamCheck < PARAM_CACHE_TTL) {
    return dualWriteEnabled;
  }

  try {
    const result = await ssmClient.send(
      new GetParameterCommand({
        Name: DUAL_WRITE_PARAM_NAME,
      })
    );
    dualWriteEnabled = result.Parameter?.Value === "true";
    lastParamCheck = now;
    return dualWriteEnabled;
  } catch (error) {
    console.error("Error checking dual-write parameter:", error);
    return false; // Fail closed
  }
}

/**
 * Get database connection from pool
 */
async function getDbClient(): Promise<PoolClient> {
  if (!pool) {
    const secret = await getSecret();
    pool = new Pool({
      host: secret.host,
      port: secret.port,
      database: secret.database,
      user: secret.username,
      password: secret.password,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
      ssl: { rejectUnauthorized: false },
    });
  }
  return pool.connect();
}

/**
 * Get SQL connection secret
 */
async function getSecret(): Promise<{
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
}> {
  const result = await secretsClient.send(
    new GetSecretValueCommand({
      SecretId: SQL_SECRET_ARN,
    })
  );
  return JSON.parse(result.SecretString!);
}

/**
 * Process a single DynamoDB Stream record
 */
async function processRecord(
  client: PoolClient,
  record: DynamoDBRecord
): Promise<void> {
  const eventName = record.eventName;

  if (!record.dynamodb) {
    return;
  }

  switch (eventName) {
    case "INSERT":
    case "MODIFY": {
      const newImage = record.dynamodb.NewImage
        ? (unmarshall(record.dynamodb.NewImage as Record<string, AttributeValue>) as Order)
        : null;

      if (newImage) {
        await upsertOrder(client, newImage);
      }
      break;
    }

    case "REMOVE": {
      const oldImage = record.dynamodb.OldImage
        ? (unmarshall(record.dynamodb.OldImage as Record<string, AttributeValue>) as Order)
        : null;

      if (oldImage) {
        // Soft delete - update status instead of hard delete
        await softDeleteOrder(client, oldImage.order_id);
      }
      break;
    }
  }
}

/**
 * Upsert order to SQL database
 */
async function upsertOrder(client: PoolClient, order: Order): Promise<void> {
  const query = `
    INSERT INTO orders (
      order_id, customer_id, store_id, county_id,
      status, payment_state, subtotal, tax, total,
      shipping_street, shipping_city, shipping_state, shipping_zip,
      created_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
    ON CONFLICT (order_id) DO UPDATE SET
      status = EXCLUDED.status,
      payment_state = EXCLUDED.payment_state,
      updated_at = EXCLUDED.updated_at
  `;

  const values = [
    order.order_id,
    order.customer_id,
    order.store_id,
    order.county_id,
    order.status,
    order.payment_state,
    order.subtotal,
    order.tax,
    order.total,
    order.shipping_address.street,
    order.shipping_address.city,
    order.shipping_address.state,
    order.shipping_address.zip,
    order.created_at,
    order.updated_at,
  ];

  await client.query(query, values);
  console.log("Upserted order to SQL:", order.order_id);

  // Also upsert order items
  for (const item of order.items) {
    await upsertOrderItem(client, order.order_id, item);
  }
}

/**
 * Upsert order item to SQL database
 */
async function upsertOrderItem(
  client: PoolClient,
  orderId: string,
  item: { sku: string; name: string; quantity: number; unit_price: number; total_price: number }
): Promise<void> {
  const query = `
    INSERT INTO order_items (order_id, sku, name, quantity, unit_price, total_price)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (order_id, sku) DO UPDATE SET
      quantity = EXCLUDED.quantity,
      unit_price = EXCLUDED.unit_price,
      total_price = EXCLUDED.total_price
  `;

  await client.query(query, [
    orderId,
    item.sku,
    item.name,
    item.quantity,
    item.unit_price,
    item.total_price,
  ]);
}

/**
 * Soft delete order in SQL database
 */
async function softDeleteOrder(client: PoolClient, orderId: string): Promise<void> {
  const query = `
    UPDATE orders SET status = 'DELETED', updated_at = NOW()
    WHERE order_id = $1
  `;
  await client.query(query, [orderId]);
  console.log("Soft deleted order in SQL:", orderId);
}
