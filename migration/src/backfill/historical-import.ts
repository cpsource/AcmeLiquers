import { SSMClient, GetParameterCommand, PutParameterCommand } from "@aws-sdk/client-ssm";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import { Pool } from "pg";
import {
  getDocumentClient,
  TableNames,
  Order,
  OrderById,
  OrderStatus,
  PaymentState,
} from "@acme-liquors/shared";
import { BatchWriteCommand } from "@aws-sdk/lib-dynamodb";

const ssmClient = new SSMClient({});
const secretsClient = new SecretsManagerClient({});

const SQL_SECRET_ARN = process.env.SQL_SECRET_ARN!;
const BACKFILL_PROGRESS_PARAM = process.env.BACKFILL_PROGRESS_PARAM!;
const BATCH_SIZE = 25; // DynamoDB BatchWriteItem limit

interface BackfillProgress {
  status: "NOT_STARTED" | "IN_PROGRESS" | "COMPLETED" | "FAILED";
  lastProcessedId: string | null;
  totalProcessed: number;
  startedAt: string | null;
  updatedAt: string | null;
  error?: string;
}

interface BackfillEvent {
  action: "START" | "CONTINUE" | "STATUS";
  batchSize?: number;
}

interface BackfillResult {
  status: BackfillProgress["status"];
  processedInThisRun: number;
  totalProcessed: number;
  lastProcessedId: string | null;
  hasMore: boolean;
}

/**
 * Historical Import Lambda Handler
 *
 * This handler imports historical orders from SQL to DynamoDB.
 *
 * Features:
 * - Resumable (tracks progress in SSM Parameter)
 * - Batch processing for efficiency
 * - Idempotent (safe to re-run)
 * - Progress reporting
 */
export async function handler(event: BackfillEvent): Promise<BackfillResult> {
  console.log("Backfill event:", event);

  // Get current progress
  const progress = await getProgress();

  if (event.action === "STATUS") {
    return {
      status: progress.status,
      processedInThisRun: 0,
      totalProcessed: progress.totalProcessed,
      lastProcessedId: progress.lastProcessedId,
      hasMore: progress.status === "IN_PROGRESS",
    };
  }

  if (event.action === "START" && progress.status === "IN_PROGRESS") {
    console.log("Backfill already in progress, continuing...");
  }

  // Start or continue backfill
  const batchSize = event.batchSize || BATCH_SIZE;

  try {
    // Update status to IN_PROGRESS
    if (progress.status === "NOT_STARTED") {
      await updateProgress({
        ...progress,
        status: "IN_PROGRESS",
        startedAt: new Date().toISOString(),
      });
    }

    // Connect to SQL database
    const pool = await createPool();

    try {
      // Fetch batch from SQL
      const orders = await fetchOrdersFromSql(
        pool,
        progress.lastProcessedId,
        batchSize * 10 // Fetch more to account for items
      );

      if (orders.length === 0) {
        // All done!
        await updateProgress({
          ...progress,
          status: "COMPLETED",
          updatedAt: new Date().toISOString(),
        });

        return {
          status: "COMPLETED",
          processedInThisRun: 0,
          totalProcessed: progress.totalProcessed,
          lastProcessedId: progress.lastProcessedId,
          hasMore: false,
        };
      }

      // Write to DynamoDB
      const processed = await writeToDynamoDB(orders);

      // Update progress
      const lastOrder = orders[orders.length - 1];
      const newProgress: BackfillProgress = {
        status: "IN_PROGRESS",
        lastProcessedId: lastOrder.order_id,
        totalProcessed: progress.totalProcessed + processed,
        startedAt: progress.startedAt,
        updatedAt: new Date().toISOString(),
      };
      await updateProgress(newProgress);

      return {
        status: "IN_PROGRESS",
        processedInThisRun: processed,
        totalProcessed: newProgress.totalProcessed,
        lastProcessedId: lastOrder.order_id,
        hasMore: orders.length === batchSize * 10,
      };
    } finally {
      await pool.end();
    }
  } catch (error) {
    console.error("Backfill error:", error);

    await updateProgress({
      ...progress,
      status: "FAILED",
      updatedAt: new Date().toISOString(),
      error: String(error),
    });

    throw error;
  }
}

/**
 * Get current progress from SSM
 */
async function getProgress(): Promise<BackfillProgress> {
  const result = await ssmClient.send(
    new GetParameterCommand({
      Name: BACKFILL_PROGRESS_PARAM,
    })
  );
  return JSON.parse(result.Parameter?.Value || "{}");
}

/**
 * Update progress in SSM
 */
async function updateProgress(progress: BackfillProgress): Promise<void> {
  await ssmClient.send(
    new PutParameterCommand({
      Name: BACKFILL_PROGRESS_PARAM,
      Value: JSON.stringify(progress),
      Type: "String",
      Overwrite: true,
    })
  );
}

/**
 * Create PostgreSQL connection pool
 */
async function createPool(): Promise<Pool> {
  const result = await secretsClient.send(
    new GetSecretValueCommand({
      SecretId: SQL_SECRET_ARN,
    })
  );
  const secret = JSON.parse(result.SecretString!);

  return new Pool({
    host: secret.host,
    port: secret.port,
    database: secret.database,
    user: secret.username,
    password: secret.password,
    max: 5,
    ssl: { rejectUnauthorized: false },
  });
}

/**
 * Fetch orders from SQL database
 */
async function fetchOrdersFromSql(
  pool: Pool,
  afterOrderId: string | null,
  limit: number
): Promise<Order[]> {
  const query = `
    SELECT
      o.order_id, o.customer_id, o.store_id, o.county_id,
      o.status, o.payment_state, o.subtotal, o.tax, o.total,
      o.shipping_street, o.shipping_city, o.shipping_state, o.shipping_zip,
      o.created_at, o.updated_at,
      json_agg(json_build_object(
        'sku', oi.sku,
        'name', oi.name,
        'quantity', oi.quantity,
        'unit_price', oi.unit_price,
        'total_price', oi.total_price
      )) as items
    FROM orders o
    LEFT JOIN order_items oi ON o.order_id = oi.order_id
    WHERE ($1::text IS NULL OR o.order_id > $1)
      AND o.status != 'DELETED'
    GROUP BY o.order_id
    ORDER BY o.order_id
    LIMIT $2
  `;

  const result = await pool.query(query, [afterOrderId, limit]);

  return result.rows.map((row) => ({
    customer_id: row.customer_id,
    order_ts_id: `${row.created_at.toISOString()}#${row.order_id}`,
    order_id: row.order_id,
    order_ts: row.created_at.toISOString(),
    store_id: row.store_id,
    county_id: row.county_id,
    status: row.status as OrderStatus,
    payment_state: row.payment_state as PaymentState,
    items: row.items.filter((i: unknown) => i !== null),
    subtotal: parseFloat(row.subtotal),
    tax: parseFloat(row.tax),
    total: parseFloat(row.total),
    shipping_address: {
      street: row.shipping_street,
      city: row.shipping_city,
      state: row.shipping_state,
      zip: row.shipping_zip,
    },
    idempotency_key: `backfill-${row.order_id}`,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  }));
}

/**
 * Write orders to DynamoDB using batch writes
 */
async function writeToDynamoDB(orders: Order[]): Promise<number> {
  const client = getDocumentClient();
  let processed = 0;

  // Process in batches of 25 (DynamoDB limit)
  for (let i = 0; i < orders.length; i += BATCH_SIZE) {
    const batch = orders.slice(i, i + BATCH_SIZE);

    // Build requests for both tables
    const ordersRequests = batch.map((order) => ({
      PutRequest: { Item: order },
    }));

    const orderByIdRequests = batch.map((order) => ({
      PutRequest: {
        Item: {
          order_id: order.order_id,
          customer_id: order.customer_id,
          order_ts: order.order_ts,
          status: order.status,
          payment_state: order.payment_state,
          store_id: order.store_id,
          county_id: order.county_id,
          items: order.items,
          subtotal: order.subtotal,
          tax: order.tax,
          total: order.total,
          shipping_address: order.shipping_address,
          created_at: order.created_at,
          updated_at: order.updated_at,
        } as OrderById,
      },
    }));

    // Write to orders table
    await client.send(
      new BatchWriteCommand({
        RequestItems: {
          [TableNames.ORDERS]: ordersRequests,
        },
      })
    );

    // Write to orders-by-id table
    await client.send(
      new BatchWriteCommand({
        RequestItems: {
          [TableNames.ORDERS_BY_ID]: orderByIdRequests,
        },
      })
    );

    processed += batch.length;
    console.log(`Processed ${processed} orders`);
  }

  return processed;
}
