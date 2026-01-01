import { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { Order, OrderItem, OrderStatus, PaymentState } from '@acme-liquors/shared';

/**
 * Create a mock API Gateway event
 */
export function createMockApiEvent(
  overrides: Partial<APIGatewayProxyEvent> = {}
): APIGatewayProxyEvent {
  return {
    body: null,
    headers: {},
    multiValueHeaders: {},
    httpMethod: 'GET',
    isBase64Encoded: false,
    path: '/',
    pathParameters: null,
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    requestContext: {
      accountId: '123456789',
      apiId: 'test-api',
      authorizer: null,
      protocol: 'HTTP/1.1',
      httpMethod: 'GET',
      identity: {
        accessKey: null,
        accountId: null,
        apiKey: null,
        apiKeyId: null,
        caller: null,
        clientCert: null,
        cognitoAuthenticationProvider: null,
        cognitoAuthenticationType: null,
        cognitoIdentityId: null,
        cognitoIdentityPoolId: null,
        principalOrgId: null,
        sourceIp: '127.0.0.1',
        user: null,
        userAgent: 'test',
        userArn: null,
      },
      path: '/',
      stage: 'test',
      requestId: 'test-request-id',
      requestTimeEpoch: Date.now(),
      resourceId: 'test-resource',
      resourcePath: '/',
    },
    resource: '/',
    ...overrides,
  };
}

/**
 * Create a mock Lambda context
 */
export function createMockContext(): Context {
  return {
    callbackWaitsForEmptyEventLoop: true,
    functionName: 'test-function',
    functionVersion: '1',
    invokedFunctionArn: 'arn:aws:lambda:us-east-1:123456789:function:test',
    memoryLimitInMB: '256',
    awsRequestId: 'test-request-id',
    logGroupName: '/aws/lambda/test',
    logStreamName: 'test-stream',
    getRemainingTimeInMillis: () => 30000,
    done: () => {},
    fail: () => {},
    succeed: () => {},
  };
}

/**
 * Create a mock order item
 */
export function createMockOrderItem(overrides: Partial<OrderItem> = {}): OrderItem {
  return {
    sku: 'SKU-001',
    name: 'Test Product',
    quantity: 2,
    unit_price: 19.99,
    total_price: 39.98,
    ...overrides,
  };
}

/**
 * Create a mock order
 */
export function createMockOrder(overrides: Partial<Order> = {}): Order {
  const now = new Date().toISOString();
  const orderId = `ORD-${Date.now()}`;

  return {
    customer_id: 'CUST-001',
    order_ts_id: `${now}#${orderId}`,
    order_id: orderId,
    order_ts: now,
    store_id: 'STORE-001',
    county_id: 'COUNTY-001',
    status: OrderStatus.PENDING,
    payment_state: PaymentState.PENDING,
    items: [createMockOrderItem()],
    subtotal: 39.98,
    tax: 3.20,
    total: 43.18,
    shipping_address: {
      street: '123 Test St',
      city: 'Test City',
      state: 'TX',
      zip: '12345',
    },
    idempotency_key: 'test-idempotency-key',
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

/**
 * Create a mock create order request body
 */
export function createMockCreateOrderRequest() {
  return {
    customer_id: 'CUST-001',
    store_id: 'STORE-001',
    county_id: 'COUNTY-001',
    items: [
      {
        sku: 'SKU-001',
        name: 'Test Wine',
        quantity: 2,
        unit_price: 25.00,
      },
    ],
    shipping_address: {
      street: '123 Test St',
      city: 'Test City',
      state: 'TX',
      zip: '12345',
    },
  };
}

/**
 * Parse API Gateway response
 */
export function parseApiResponse<T>(result: APIGatewayProxyResult): {
  statusCode: number;
  body: T;
} {
  return {
    statusCode: result.statusCode,
    body: JSON.parse(result.body) as T,
  };
}

/**
 * Wait for a specified time
 */
export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
