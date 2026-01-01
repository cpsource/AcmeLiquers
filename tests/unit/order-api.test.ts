import { handler as createOrderHandler } from '../../services/order-api/src/handlers/create-order';
import { handler as getOrderHandler } from '../../services/order-api/src/handlers/get-order';
import { handler as listOrdersHandler } from '../../services/order-api/src/handlers/list-orders';
import { handler as cancelOrderHandler } from '../../services/order-api/src/handlers/cancel-order';
import {
  createMockApiEvent,
  createMockCreateOrderRequest,
  parseApiResponse,
} from '../utils/test-helpers';
import {
  ddbMock,
  resetDynamoMocks,
  mockGetItem,
  mockPutItem,
  mockQuery,
  mockUpdateItem,
  mockUpdateItemConditionalFailure,
  createDynamoOrder,
  createDynamoOrderById,
} from '../utils/dynamodb-mock';
import { sqsMock, resetSqsMocks, mockSendMessage } from '../utils/sqs-mock';
import { OrderStatus } from '@acme-liquors/shared';

describe('Order API Handlers', () => {
  beforeEach(() => {
    resetDynamoMocks();
    resetSqsMocks();
  });

  describe('POST /orders (create-order)', () => {
    it('should create a new order successfully', async () => {
      mockPutItem();
      mockSendMessage();

      const event = createMockApiEvent({
        httpMethod: 'POST',
        path: '/orders',
        headers: {
          'X-Idempotency-Key': 'test-idempotency-key',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(createMockCreateOrderRequest()),
      });

      const result = await createOrderHandler(event);
      const { statusCode, body } = parseApiResponse<{ order_id: string; status: string }>(result);

      expect(statusCode).toBe(201);
      expect(body.order_id).toBeDefined();
      expect(body.status).toBe('PENDING');
    });

    it('should return 400 when X-Idempotency-Key header is missing', async () => {
      const event = createMockApiEvent({
        httpMethod: 'POST',
        path: '/orders',
        headers: {},
        body: JSON.stringify(createMockCreateOrderRequest()),
      });

      const result = await createOrderHandler(event);
      const { statusCode, body } = parseApiResponse<{ error: string }>(result);

      expect(statusCode).toBe(400);
      expect(body.error).toContain('Idempotency-Key');
    });

    it('should return 400 when request body is invalid', async () => {
      const event = createMockApiEvent({
        httpMethod: 'POST',
        path: '/orders',
        headers: {
          'X-Idempotency-Key': 'test-key',
        },
        body: JSON.stringify({ invalid: 'data' }),
      });

      const result = await createOrderHandler(event);
      const { statusCode } = parseApiResponse<unknown>(result);

      expect(statusCode).toBe(400);
    });

    it('should return 400 when body is missing', async () => {
      const event = createMockApiEvent({
        httpMethod: 'POST',
        path: '/orders',
        headers: {
          'X-Idempotency-Key': 'test-key',
        },
        body: null,
      });

      const result = await createOrderHandler(event);
      const { statusCode } = parseApiResponse<unknown>(result);

      expect(statusCode).toBe(400);
    });

    it('should calculate totals correctly', async () => {
      mockPutItem();
      mockSendMessage();

      const request = {
        customer_id: 'CUST-001',
        store_id: 'STORE-001',
        county_id: 'COUNTY-001',
        items: [
          { sku: 'SKU-001', name: 'Item 1', quantity: 2, unit_price: 10.00 },
          { sku: 'SKU-002', name: 'Item 2', quantity: 1, unit_price: 25.00 },
        ],
        shipping_address: {
          street: '123 Test St',
          city: 'Test City',
          state: 'TX',
          zip: '12345',
        },
      };

      const event = createMockApiEvent({
        httpMethod: 'POST',
        path: '/orders',
        headers: { 'X-Idempotency-Key': 'test-key' },
        body: JSON.stringify(request),
      });

      const result = await createOrderHandler(event);
      const { statusCode, body } = parseApiResponse<{
        subtotal: number;
        tax: number;
        total: number;
      }>(result);

      expect(statusCode).toBe(201);
      expect(body.subtotal).toBe(45.00); // 2*10 + 1*25
      expect(body.tax).toBeCloseTo(3.60, 2); // 45 * 0.08
      expect(body.total).toBeCloseTo(48.60, 2); // 45 + 3.60
    });
  });

  describe('GET /orders/{order_id} (get-order)', () => {
    it('should return order by ID', async () => {
      const mockOrder = createDynamoOrderById({ order_id: 'ORD-12345' });
      mockGetItem(mockOrder);

      const event = createMockApiEvent({
        httpMethod: 'GET',
        path: '/orders/ORD-12345',
        pathParameters: { order_id: 'ORD-12345' },
      });

      const result = await getOrderHandler(event);
      const { statusCode, body } = parseApiResponse<{ order_id: string }>(result);

      expect(statusCode).toBe(200);
      expect(body.order_id).toBe('ORD-12345');
    });

    it('should return 404 when order not found', async () => {
      mockGetItem(null);

      const event = createMockApiEvent({
        httpMethod: 'GET',
        path: '/orders/ORD-NOTFOUND',
        pathParameters: { order_id: 'ORD-NOTFOUND' },
      });

      const result = await getOrderHandler(event);
      const { statusCode, body } = parseApiResponse<{ error: string }>(result);

      expect(statusCode).toBe(404);
      expect(body.error).toBe('Order not found');
    });

    it('should return 400 when order_id is missing', async () => {
      const event = createMockApiEvent({
        httpMethod: 'GET',
        path: '/orders/',
        pathParameters: null,
      });

      const result = await getOrderHandler(event);
      const { statusCode } = parseApiResponse<unknown>(result);

      expect(statusCode).toBe(400);
    });
  });

  describe('GET /orders (list-orders)', () => {
    it('should list orders by customer', async () => {
      const mockOrders = [
        createDynamoOrder({ order_id: 'ORD-001' }),
        createDynamoOrder({ order_id: 'ORD-002' }),
      ];
      mockQuery(mockOrders);

      const event = createMockApiEvent({
        httpMethod: 'GET',
        path: '/orders',
        queryStringParameters: { customer_id: 'CUST-001' },
      });

      const result = await listOrdersHandler(event);
      const { statusCode, body } = parseApiResponse<{ orders: unknown[] }>(result);

      expect(statusCode).toBe(200);
      expect(body.orders).toHaveLength(2);
    });

    it('should return 400 when customer_id is missing', async () => {
      const event = createMockApiEvent({
        httpMethod: 'GET',
        path: '/orders',
        queryStringParameters: null,
      });

      const result = await listOrdersHandler(event);
      const { statusCode, body } = parseApiResponse<{ error: string }>(result);

      expect(statusCode).toBe(400);
      expect(body.error).toContain('customer_id');
    });

    it('should return 400 when limit is invalid', async () => {
      const event = createMockApiEvent({
        httpMethod: 'GET',
        path: '/orders',
        queryStringParameters: { customer_id: 'CUST-001', limit: '200' },
      });

      const result = await listOrdersHandler(event);
      const { statusCode } = parseApiResponse<unknown>(result);

      expect(statusCode).toBe(400);
    });

    it('should handle pagination with next_token', async () => {
      const mockOrders = [createDynamoOrder()];
      mockQuery(mockOrders, { customer_id: 'CUST-001', order_ts_id: 'next' });

      const event = createMockApiEvent({
        httpMethod: 'GET',
        path: '/orders',
        queryStringParameters: { customer_id: 'CUST-001', limit: '10' },
      });

      const result = await listOrdersHandler(event);
      const { statusCode, body } = parseApiResponse<{ next_token?: string }>(result);

      expect(statusCode).toBe(200);
      expect(body.next_token).toBeDefined();
    });
  });

  describe('DELETE /orders/{order_id} (cancel-order)', () => {
    it('should cancel a pending order', async () => {
      const mockOrder = createDynamoOrderById({
        order_id: 'ORD-12345',
        status: OrderStatus.PENDING,
      });
      mockGetItem(mockOrder);
      mockUpdateItem();

      const event = createMockApiEvent({
        httpMethod: 'DELETE',
        path: '/orders/ORD-12345',
        pathParameters: { order_id: 'ORD-12345' },
      });

      const result = await cancelOrderHandler(event);
      const { statusCode, body } = parseApiResponse<{ status: string }>(result);

      expect(statusCode).toBe(200);
      expect(body.status).toBe('CANCELLED');
    });

    it('should return 404 when order not found', async () => {
      mockGetItem(null);

      const event = createMockApiEvent({
        httpMethod: 'DELETE',
        path: '/orders/ORD-NOTFOUND',
        pathParameters: { order_id: 'ORD-NOTFOUND' },
      });

      const result = await cancelOrderHandler(event);
      const { statusCode } = parseApiResponse<unknown>(result);

      expect(statusCode).toBe(404);
    });

    it('should return 409 when order cannot be cancelled', async () => {
      const mockOrder = createDynamoOrderById({
        order_id: 'ORD-12345',
        status: OrderStatus.SHIPPED,
      });
      mockGetItem(mockOrder);

      const event = createMockApiEvent({
        httpMethod: 'DELETE',
        path: '/orders/ORD-12345',
        pathParameters: { order_id: 'ORD-12345' },
      });

      const result = await cancelOrderHandler(event);
      const { statusCode, body } = parseApiResponse<{ error: string }>(result);

      expect(statusCode).toBe(409);
      expect(body.error).toContain('cannot be cancelled');
    });

    it('should return 409 when order status changed', async () => {
      const mockOrder = createDynamoOrderById({
        order_id: 'ORD-12345',
        status: OrderStatus.PENDING,
      });
      mockGetItem(mockOrder);
      mockUpdateItemConditionalFailure();

      const event = createMockApiEvent({
        httpMethod: 'DELETE',
        path: '/orders/ORD-12345',
        pathParameters: { order_id: 'ORD-12345' },
      });

      const result = await cancelOrderHandler(event);
      const { statusCode } = parseApiResponse<unknown>(result);

      expect(statusCode).toBe(409);
    });
  });
});
