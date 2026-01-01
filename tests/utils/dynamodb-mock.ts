import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { Order, OrderById } from '@acme-liquors/shared';

// Create mock client
export const ddbMock = mockClient(DynamoDBDocumentClient);

/**
 * Reset all DynamoDB mocks
 */
export function resetDynamoMocks(): void {
  ddbMock.reset();
}

/**
 * Mock successful GetCommand
 */
export function mockGetItem(item: Record<string, unknown> | null): void {
  ddbMock.on(GetCommand).resolves({
    Item: item ?? undefined,
  });
}

/**
 * Mock GetCommand for specific key
 */
export function mockGetItemForKey(
  key: Record<string, string>,
  item: Record<string, unknown> | null
): void {
  ddbMock.on(GetCommand, { Key: key }).resolves({
    Item: item ?? undefined,
  });
}

/**
 * Mock successful PutCommand
 */
export function mockPutItem(): void {
  ddbMock.on(PutCommand).resolves({});
}

/**
 * Mock PutCommand with conditional check failure
 */
export function mockPutItemConditionalFailure(): void {
  const error = new Error('ConditionalCheckFailedException');
  error.name = 'ConditionalCheckFailedException';
  ddbMock.on(PutCommand).rejects(error);
}

/**
 * Mock successful QueryCommand
 */
export function mockQuery(items: Record<string, unknown>[], lastKey?: Record<string, unknown>): void {
  ddbMock.on(QueryCommand).resolves({
    Items: items,
    LastEvaluatedKey: lastKey,
  });
}

/**
 * Mock successful UpdateCommand
 */
export function mockUpdateItem(): void {
  ddbMock.on(UpdateCommand).resolves({});
}

/**
 * Mock UpdateCommand with conditional check failure
 */
export function mockUpdateItemConditionalFailure(): void {
  const error = new Error('ConditionalCheckFailedException');
  error.name = 'ConditionalCheckFailedException';
  ddbMock.on(UpdateCommand).rejects(error);
}

/**
 * Mock BatchWriteCommand
 */
export function mockBatchWrite(): void {
  ddbMock.on(BatchWriteCommand).resolves({
    UnprocessedItems: {},
  });
}

/**
 * Create a mock order for DynamoDB response
 */
export function createDynamoOrder(overrides: Partial<Order> = {}): Order {
  const now = new Date().toISOString();
  const orderId = `ORD-TEST-${Date.now()}`;

  return {
    customer_id: 'CUST-001',
    order_ts_id: `${now}#${orderId}`,
    order_id: orderId,
    order_ts: now,
    store_id: 'STORE-001',
    county_id: 'COUNTY-001',
    status: 'PENDING',
    payment_state: 'PENDING',
    items: [
      {
        sku: 'SKU-001',
        name: 'Test Product',
        quantity: 1,
        unit_price: 10.00,
        total_price: 10.00,
      },
    ],
    subtotal: 10.00,
    tax: 0.80,
    total: 10.80,
    shipping_address: {
      street: '123 Test St',
      city: 'Test City',
      state: 'TX',
      zip: '12345',
    },
    idempotency_key: 'test-key',
    created_at: now,
    updated_at: now,
    ...overrides,
  } as Order;
}

/**
 * Create a mock OrderById for DynamoDB response
 */
export function createDynamoOrderById(overrides: Partial<OrderById> = {}): OrderById {
  const now = new Date().toISOString();

  return {
    order_id: `ORD-TEST-${Date.now()}`,
    customer_id: 'CUST-001',
    order_ts: now,
    status: 'PENDING',
    payment_state: 'PENDING',
    store_id: 'STORE-001',
    county_id: 'COUNTY-001',
    items: [
      {
        sku: 'SKU-001',
        name: 'Test Product',
        quantity: 1,
        unit_price: 10.00,
        total_price: 10.00,
      },
    ],
    subtotal: 10.00,
    tax: 0.80,
    total: 10.80,
    shipping_address: {
      street: '123 Test St',
      city: 'Test City',
      state: 'TX',
      zip: '12345',
    },
    created_at: now,
    updated_at: now,
    ...overrides,
  } as OrderById;
}
