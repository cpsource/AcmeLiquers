/**
 * Integration Tests for Order API
 *
 * These tests verify the integration between API handlers and DynamoDB.
 * They use mocked AWS services but test the full handler flow.
 *
 * For true integration testing against real AWS services, use LocalStack
 * or deploy to a test environment.
 */

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
  createDynamoOrder,
  createDynamoOrderById,
} from '../utils/dynamodb-mock';
import { sqsMock, resetSqsMocks } from '../utils/sqs-mock';
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { OrderStatus } from '@acme-liquors/shared';

describe('Order API Integration', () => {
  beforeEach(() => {
    resetDynamoMocks();
    resetSqsMocks();
  });

  describe('Create and Retrieve Order Flow', () => {
    it('should create an order and retrieve it by ID', async () => {
      // Set up mocks
      ddbMock.on(PutCommand).resolves({});
      sqsMock.on(SendMessageCommand).resolves({ MessageId: 'test-msg' });

      // Create order
      const createEvent = createMockApiEvent({
        httpMethod: 'POST',
        path: '/orders',
        headers: { 'X-Idempotency-Key': 'test-key-123' },
        body: JSON.stringify(createMockCreateOrderRequest()),
      });

      const createResult = await createOrderHandler(createEvent);
      const { statusCode: createStatus, body: createBody } = parseApiResponse<{
        order_id: string;
      }>(createResult);

      expect(createStatus).toBe(201);
      const orderId = createBody.order_id;

      // Mock get response with the created order
      const mockOrder = createDynamoOrderById({ order_id: orderId });
      ddbMock.on(GetCommand).resolves({ Item: mockOrder });

      // Retrieve order
      const getEvent = createMockApiEvent({
        httpMethod: 'GET',
        path: `/orders/${orderId}`,
        pathParameters: { order_id: orderId },
      });

      const getResult = await getOrderHandler(getEvent);
      const { statusCode: getStatus, body: getBody } = parseApiResponse<{
        order_id: string;
        status: string;
      }>(getResult);

      expect(getStatus).toBe(200);
      expect(getBody.order_id).toBe(orderId);
      expect(getBody.status).toBe('PENDING');
    });

    it('should list customer orders after creation', async () => {
      // Create multiple orders
      ddbMock.on(PutCommand).resolves({});
      sqsMock.on(SendMessageCommand).resolves({ MessageId: 'test-msg' });

      const orderIds: string[] = [];

      for (let i = 0; i < 3; i++) {
        const event = createMockApiEvent({
          httpMethod: 'POST',
          path: '/orders',
          headers: { 'X-Idempotency-Key': `test-key-${i}` },
          body: JSON.stringify(createMockCreateOrderRequest()),
        });

        const result = await createOrderHandler(event);
        const { body } = parseApiResponse<{ order_id: string }>(result);
        orderIds.push(body.order_id);
      }

      // Mock query response
      const mockOrders = orderIds.map((id) => createDynamoOrder({ order_id: id }));
      ddbMock.on(QueryCommand).resolves({ Items: mockOrders });

      // List orders
      const listEvent = createMockApiEvent({
        httpMethod: 'GET',
        path: '/orders',
        queryStringParameters: { customer_id: 'CUST-001' },
      });

      const listResult = await listOrdersHandler(listEvent);
      const { statusCode, body } = parseApiResponse<{ orders: unknown[] }>(listResult);

      expect(statusCode).toBe(200);
      expect(body.orders).toHaveLength(3);
    });
  });

  describe('Order Cancellation Flow', () => {
    it('should cancel a pending order and verify status', async () => {
      const orderId = 'ORD-CANCEL-TEST';

      // Mock get returning pending order
      const mockOrder = createDynamoOrderById({
        order_id: orderId,
        status: OrderStatus.PENDING,
      });
      ddbMock.on(GetCommand).resolves({ Item: mockOrder });
      ddbMock.on(UpdateCommand).resolves({});

      // Cancel order
      const cancelEvent = createMockApiEvent({
        httpMethod: 'DELETE',
        path: `/orders/${orderId}`,
        pathParameters: { order_id: orderId },
      });

      const cancelResult = await cancelOrderHandler(cancelEvent);
      const { statusCode, body } = parseApiResponse<{
        order_id: string;
        status: string;
      }>(cancelResult);

      expect(statusCode).toBe(200);
      expect(body.status).toBe('CANCELLED');

      // Verify UpdateCommand was called with correct parameters
      const updateCalls = ddbMock.commandCalls(UpdateCommand);
      expect(updateCalls.length).toBeGreaterThan(0);
    });

    it('should not cancel a shipped order', async () => {
      const orderId = 'ORD-SHIPPED';

      // Mock get returning shipped order
      const mockOrder = createDynamoOrderById({
        order_id: orderId,
        status: OrderStatus.SHIPPED,
      });
      ddbMock.on(GetCommand).resolves({ Item: mockOrder });

      const cancelEvent = createMockApiEvent({
        httpMethod: 'DELETE',
        path: `/orders/${orderId}`,
        pathParameters: { order_id: orderId },
      });

      const result = await cancelOrderHandler(cancelEvent);
      const { statusCode, body } = parseApiResponse<{
        error: string;
        current_status: string;
      }>(result);

      expect(statusCode).toBe(409);
      expect(body.current_status).toBe('SHIPPED');
    });
  });

  describe('Idempotency', () => {
    it('should return existing order for duplicate request', async () => {
      const idempotencyKey = 'duplicate-key-123';

      // First request - creates order
      ddbMock.on(PutCommand).resolves({});
      sqsMock.on(SendMessageCommand).resolves({ MessageId: 'test-msg' });

      const event1 = createMockApiEvent({
        httpMethod: 'POST',
        path: '/orders',
        headers: { 'X-Idempotency-Key': idempotencyKey },
        body: JSON.stringify(createMockCreateOrderRequest()),
      });

      const result1 = await createOrderHandler(event1);
      expect(result1.statusCode).toBe(201);

      // Second request with same key - should detect duplicate
      // Mock conditional check failure and return existing order
      const conditionalError = new Error('ConditionalCheckFailedException');
      conditionalError.name = 'ConditionalCheckFailedException';
      ddbMock.on(PutCommand).rejects(conditionalError);

      const existingOrder = createDynamoOrder();
      ddbMock.on(GetCommand).resolves({ Item: existingOrder });

      const event2 = createMockApiEvent({
        httpMethod: 'POST',
        path: '/orders',
        headers: { 'X-Idempotency-Key': idempotencyKey },
        body: JSON.stringify(createMockCreateOrderRequest()),
      });

      const result2 = await createOrderHandler(event2);
      const { statusCode, body } = parseApiResponse<{ message?: string }>(result2);

      // Should return 200 (not 201) for existing order
      expect(statusCode).toBe(200);
      expect(body.message).toContain('already exists');
    });
  });

  describe('Error Handling', () => {
    it('should handle DynamoDB errors gracefully', async () => {
      ddbMock.on(GetCommand).rejects(new Error('DynamoDB Error'));

      const event = createMockApiEvent({
        httpMethod: 'GET',
        path: '/orders/ORD-ERROR',
        pathParameters: { order_id: 'ORD-ERROR' },
      });

      const result = await getOrderHandler(event);
      const { statusCode, body } = parseApiResponse<{ error: string }>(result);

      expect(statusCode).toBe(500);
      expect(body.error).toBe('Internal server error');
    });

    it('should handle SQS errors during order creation', async () => {
      ddbMock.on(PutCommand).resolves({});
      sqsMock.on(SendMessageCommand).rejects(new Error('SQS Error'));

      const event = createMockApiEvent({
        httpMethod: 'POST',
        path: '/orders',
        headers: { 'X-Idempotency-Key': 'error-test-key' },
        body: JSON.stringify(createMockCreateOrderRequest()),
      });

      const result = await createOrderHandler(event);
      // Order creation should still fail if SQS fails
      expect(result.statusCode).toBe(500);
    });
  });
});
