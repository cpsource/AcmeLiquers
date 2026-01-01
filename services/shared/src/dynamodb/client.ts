import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  TransactWriteCommand,
  TransactWriteCommandInput,
} from "@aws-sdk/lib-dynamodb";

// Singleton DynamoDB client
let dynamoClient: DynamoDBClient | null = null;
let docClient: DynamoDBDocumentClient | null = null;

/**
 * Get DynamoDB client (low-level)
 */
export function getDynamoDBClient(): DynamoDBClient {
  if (!dynamoClient) {
    dynamoClient = new DynamoDBClient({
      region: process.env.AWS_REGION ?? "us-east-1",
    });
  }
  return dynamoClient;
}

/**
 * Get DynamoDB Document client (high-level, with marshalling)
 */
export function getDocumentClient(): DynamoDBDocumentClient {
  if (!docClient) {
    docClient = DynamoDBDocumentClient.from(getDynamoDBClient(), {
      marshallOptions: {
        removeUndefinedValues: true,
        convertEmptyValues: false,
      },
      unmarshallOptions: {
        wrapNumbers: false,
      },
    });
  }
  return docClient;
}

/**
 * Execute a DynamoDB transaction
 */
export async function executeTransaction(
  input: TransactWriteCommandInput
): Promise<void> {
  const client = getDocumentClient();
  await client.send(new TransactWriteCommand(input));
}

// Table names from environment
export const TableNames = {
  ORDERS: process.env.ORDERS_TABLE_NAME ?? "acme-orders",
  ORDERS_BY_ID: process.env.ORDERS_BY_ID_TABLE_NAME ?? "acme-orders-by-id",
  INVENTORY: process.env.INVENTORY_TABLE_NAME ?? "acme-inventory",
} as const;

// GSI names
export const IndexNames = {
  COUNTY_ORDER: "county-order-index",
  STORE_ORDER: "store-order-index",
  STATUS_ORDER: "status-order-index",
} as const;
