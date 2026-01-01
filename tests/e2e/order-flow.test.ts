/**
 * End-to-End Tests for Order Flow
 *
 * These tests simulate the complete order lifecycle from creation
 * through processing and notification.
 *
 * Note: These are simulated E2E tests using mocks. For true E2E testing,
 * deploy to a test environment and use real AWS services.
 */

import { handler as createOrderHandler } from '../../services/order-api/src/handlers/create-order';
import { handler as getOrderHandler } from '../../services/order-api/src/handlers/get-order';
import { handler as cancelOrderHandler } from '../../services/order-api/src/handlers/cancel-order';
import { handler as reserveInventoryHandler } from '../../services/order-processor/src/handlers/reserve-inventory';
import { handler as processPaymentHandler } from '../../services/order-processor/src/handlers/process-payment';
import { handler as sendNotificationsHandler } from '../../services/order-processor/src/handlers/send-notifications';
import {
  createMockApiEvent,
  createMockCreateOrderRequest,
  parseApiResponse,
  wait,
} from '../utils/test-helpers';
import { ddbMock, resetDynamoMocks, createDynamoOrderById } from '../utils/dynamodb-mock';
import { sqsMock, resetSqsMocks } from '../utils/sqs-mock';
import {
  GetCommand,
  PutCommand,
  UpdateCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { OrderStatus, PaymentState } from '@acme-liquors/shared';

// Mock SNS
jest.mock('@aws-sdk/client-sns', () => ({
  SNSClient: jest.fn().mockImplementation(() => ({
    send: jest.fn().mockResolvedValue({ MessageId: 'test-sns-msg' }),
  })),
  PublishCommand: jest.fn(),
}));

describe('Complete Order Flow E2E', () => {
  beforeEach(() => {
    resetDynamoMocks();
    resetSqsMocks();
  });

  describe('Happy Path: Order Creation to Confirmation', () => {
    it('should complete full order lifecycle', async () => {
      // Step 1: Create Order
      console.log('Step 1: Creating order...');

      ddbMock.on(PutCommand).resolves({});
      sqsMock.on(SendMessageCommand).resolves({ MessageId: 'test-msg' });

      const createEvent = createMockApiEvent({
        httpMethod: 'POST',
        path: '/orders',
        headers: { 'X-Idempotency-Key': 'e2e-test-key' },
        body: JSON.stringify({
          customer_id: 'CUST-E2E-001',
          store_id: 'STORE-001',
          county_id: 'COUNTY-001',
          items: [
            { sku: 'WINE-001', name: 'Test Wine', quantity: 2, unit_price: 25.00 },
            { sku: 'BEER-001', name: 'Test Beer', quantity: 6, unit_price: 8.00 },
          ],
          shipping_address: {
            street: '123 E2E Test St',
            city: 'Test City',
            state: 'TX',
            zip: '12345',
          },
        }),
      });

      const createResult = await createOrderHandler(createEvent);
      const { body: order } = parseApiResponse<{
        order_id: string;
        status: string;
        total: number;
      }>(createResult);

      expect(createResult.statusCode).toBe(201);
      expect(order.status).toBe('PENDING');
      expect(order.total).toBeCloseTo(104.76, 2); // (2*25 + 6*8) * 1.08

      console.log(`Order created: ${order.order_id}, Total: $${order.total}`);

      // Step 2: Reserve Inventory
      console.log('Step 2: Reserving inventory...');

      ddbMock.on(GetCommand).resolves({
        Item: {
          store_sku: 'STORE-001#WINE-001',
          quantity_available: 100,
          quantity_reserved: 0,
        },
      });
      ddbMock.on(TransactWriteCommand).resolves({});

      const inventoryResult = await reserveInventoryHandler({
        order_id: order.order_id,
        customer_id: 'CUST-E2E-001',
        store_id: 'STORE-001',
        items: [
          { sku: 'WINE-001', name: 'Test Wine', quantity: 2, unit_price: 25, total_price: 50 },
          { sku: 'BEER-001', name: 'Test Beer', quantity: 6, unit_price: 8, total_price: 48 },
        ],
      });

      expect(inventoryResult.success).toBe(true);
      console.log(`Inventory reserved: ${inventoryResult.reservation_id}`);

      // Step 3: Process Payment
      console.log('Step 3: Processing payment...');

      ddbMock.on(UpdateCommand).resolves({});

      // Retry until payment succeeds (95% rate)
      let paymentResult;
      for (let i = 0; i < 5; i++) {
        paymentResult = await processPaymentHandler({
          order_id: order.order_id,
          customer_id: 'CUST-E2E-001',
          amount: order.total,
        });
        if (paymentResult.success) break;
      }

      expect(paymentResult!.success).toBe(true);
      expect(paymentResult!.payment_state).toBe(PaymentState.CAPTURED);
      console.log(`Payment processed: ${paymentResult!.transaction_id}`);

      // Step 4: Send Confirmation Notification
      console.log('Step 4: Sending notification...');

      const notificationResult = await sendNotificationsHandler({
        order_id: order.order_id,
        customer_id: 'CUST-E2E-001',
        status: OrderStatus.CONFIRMED,
        total: order.total,
      });

      expect(notificationResult.success).toBe(true);
      console.log(`Notification sent: ${notificationResult.message_id}`);

      console.log('Order flow completed successfully!');
    });
  });

  describe('Failure Scenarios', () => {
    it('should handle inventory shortage', async () => {
      // Create order
      ddbMock.on(PutCommand).resolves({});
      sqsMock.on(SendMessageCommand).resolves({ MessageId: 'test-msg' });

      const createEvent = createMockApiEvent({
        httpMethod: 'POST',
        path: '/orders',
        headers: { 'X-Idempotency-Key': 'inventory-fail-key' },
        body: JSON.stringify(createMockCreateOrderRequest()),
      });

      await createOrderHandler(createEvent);

      // Inventory check fails - not enough stock
      ddbMock.on(GetCommand).resolves({
        Item: {
          store_sku: 'STORE-001#SKU-001',
          quantity_available: 1,
          quantity_reserved: 0,
        },
      });

      const inventoryResult = await reserveInventoryHandler({
        order_id: 'ORD-FAIL',
        customer_id: 'CUST-001',
        store_id: 'STORE-001',
        items: [
          { sku: 'SKU-001', name: 'Test', quantity: 10, unit_price: 10, total_price: 100 },
        ],
      });

      expect(inventoryResult.success).toBe(false);
      expect(inventoryResult.failed_items).toBeDefined();
      expect(inventoryResult.failed_items![0].requested).toBe(10);
      expect(inventoryResult.failed_items![0].available).toBe(1);
    });

    it('should handle payment failure and notify customer', async () => {
      // Force payment failure by using zero amount
      const paymentResult = await processPaymentHandler({
        order_id: 'ORD-PAY-FAIL',
        customer_id: 'CUST-001',
        amount: 0,
      });

      expect(paymentResult.success).toBe(false);

      // Send failure notification
      const notificationResult = await sendNotificationsHandler({
        order_id: 'ORD-PAY-FAIL',
        customer_id: 'CUST-001',
        status: OrderStatus.FAILED,
        reason: 'Payment declined',
      });

      expect(notificationResult.success).toBe(true);
    });
  });

  describe('Order Cancellation Flow', () => {
    it('should cancel order and notify customer', async () => {
      const orderId = 'ORD-CANCEL-E2E';

      // Mock order lookup
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
      const { statusCode } = parseApiResponse<unknown>(cancelResult);

      expect(statusCode).toBe(200);

      // Send cancellation notification
      const notificationResult = await sendNotificationsHandler({
        order_id: orderId,
        customer_id: 'CUST-001',
        status: OrderStatus.CANCELLED,
      });

      expect(notificationResult.success).toBe(true);
    });
  });

  describe('Concurrent Order Processing', () => {
    it('should handle multiple orders concurrently', async () => {
      ddbMock.on(PutCommand).resolves({});
      sqsMock.on(SendMessageCommand).resolves({ MessageId: 'test-msg' });

      // Create 5 orders concurrently
      const orderPromises = Array.from({ length: 5 }, (_, i) =>
        createOrderHandler(
          createMockApiEvent({
            httpMethod: 'POST',
            path: '/orders',
            headers: { 'X-Idempotency-Key': `concurrent-${i}` },
            body: JSON.stringify({
              ...createMockCreateOrderRequest(),
              customer_id: `CUST-CONCURRENT-${i}`,
            }),
          })
        )
      );

      const results = await Promise.all(orderPromises);

      // All should succeed
      results.forEach((result, i) => {
        expect(result.statusCode).toBe(201);
        const { body } = parseApiResponse<{ order_id: string }>(result);
        expect(body.order_id).toBeDefined();
      });

      // All order IDs should be unique
      const orderIds = results.map((r) => {
        const { body } = parseApiResponse<{ order_id: string }>(r);
        return body.order_id;
      });
      const uniqueIds = new Set(orderIds);
      expect(uniqueIds.size).toBe(5);
    });
  });
});

describe('Performance Benchmarks', () => {
  beforeEach(() => {
    resetDynamoMocks();
    resetSqsMocks();
  });

  it('should create order within performance threshold', async () => {
    ddbMock.on(PutCommand).resolves({});
    sqsMock.on(SendMessageCommand).resolves({ MessageId: 'test-msg' });

    const event = createMockApiEvent({
      httpMethod: 'POST',
      path: '/orders',
      headers: { 'X-Idempotency-Key': 'perf-test-key' },
      body: JSON.stringify(createMockCreateOrderRequest()),
    });

    const startTime = Date.now();
    await createOrderHandler(event);
    const duration = Date.now() - startTime;

    // Should complete in under 100ms (mocked)
    expect(duration).toBeLessThan(100);
    console.log(`Order creation took ${duration}ms`);
  });

  it('should handle batch of orders efficiently', async () => {
    ddbMock.on(PutCommand).resolves({});
    sqsMock.on(SendMessageCommand).resolves({ MessageId: 'test-msg' });

    const batchSize = 10;
    const startTime = Date.now();

    for (let i = 0; i < batchSize; i++) {
      await createOrderHandler(
        createMockApiEvent({
          httpMethod: 'POST',
          path: '/orders',
          headers: { 'X-Idempotency-Key': `batch-${i}` },
          body: JSON.stringify(createMockCreateOrderRequest()),
        })
      );
    }

    const totalDuration = Date.now() - startTime;
    const avgDuration = totalDuration / batchSize;

    console.log(`Batch of ${batchSize} orders took ${totalDuration}ms (avg: ${avgDuration}ms)`);
    expect(avgDuration).toBeLessThan(50);
  });
});
