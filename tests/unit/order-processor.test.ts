import { handler as processOrderHandler } from '../../services/order-processor/src/handlers/process-order';
import { handler as reserveInventoryHandler } from '../../services/order-processor/src/handlers/reserve-inventory';
import { handler as processPaymentHandler } from '../../services/order-processor/src/handlers/process-payment';
import { handler as sendNotificationsHandler } from '../../services/order-processor/src/handlers/send-notifications';
import { createMockSqsEvent } from '../utils/sqs-mock';
import {
  resetDynamoMocks,
  mockGetItem,
  mockUpdateItem,
  createDynamoOrderById,
} from '../utils/dynamodb-mock';
import { OrderStatus, PaymentState } from '@acme-liquors/shared';

// Mock Lambda client for process-order tests
jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: jest.fn().mockImplementation(() => ({
    send: jest.fn().mockResolvedValue({
      Payload: Buffer.from(JSON.stringify({ success: true })),
    }),
  })),
  InvokeCommand: jest.fn(),
}));

// Mock SNS client for send-notifications tests
jest.mock('@aws-sdk/client-sns', () => ({
  SNSClient: jest.fn().mockImplementation(() => ({
    send: jest.fn().mockResolvedValue({
      MessageId: 'test-message-id',
    }),
  })),
  PublishCommand: jest.fn(),
}));

describe('Order Processor Handlers', () => {
  beforeEach(() => {
    resetDynamoMocks();
    jest.clearAllMocks();
  });

  describe('reserve-inventory', () => {
    it('should reserve inventory successfully when available', async () => {
      // Mock inventory check - item available
      const { ddbMock } = require('../utils/dynamodb-mock');
      const { GetCommand } = require('@aws-sdk/lib-dynamodb');

      ddbMock.on(GetCommand).resolves({
        Item: {
          store_sku: 'STORE-001#SKU-001',
          quantity_available: 100,
          quantity_reserved: 10,
        },
      });

      // Mock transaction
      const { TransactWriteCommand } = require('@aws-sdk/lib-dynamodb');
      ddbMock.on(TransactWriteCommand).resolves({});

      const result = await reserveInventoryHandler({
        order_id: 'ORD-12345',
        customer_id: 'CUST-001',
        store_id: 'STORE-001',
        items: [
          { sku: 'SKU-001', name: 'Test', quantity: 5, unit_price: 10, total_price: 50 },
        ],
      });

      expect(result.success).toBe(true);
      expect(result.reservation_id).toBeDefined();
    });

    it('should fail when inventory is insufficient', async () => {
      const { ddbMock } = require('../utils/dynamodb-mock');
      const { GetCommand } = require('@aws-sdk/lib-dynamodb');

      ddbMock.on(GetCommand).resolves({
        Item: {
          store_sku: 'STORE-001#SKU-001',
          quantity_available: 5,
          quantity_reserved: 3,
        },
      });

      const result = await reserveInventoryHandler({
        order_id: 'ORD-12345',
        customer_id: 'CUST-001',
        store_id: 'STORE-001',
        items: [
          { sku: 'SKU-001', name: 'Test', quantity: 10, unit_price: 10, total_price: 100 },
        ],
      });

      expect(result.success).toBe(false);
      expect(result.failed_items).toHaveLength(1);
      expect(result.failed_items![0].sku).toBe('SKU-001');
    });
  });

  describe('process-payment', () => {
    it('should process payment successfully', async () => {
      mockUpdateItem();

      // Run multiple times to account for 95% success rate simulation
      let successCount = 0;
      for (let i = 0; i < 20; i++) {
        const result = await processPaymentHandler({
          order_id: 'ORD-12345',
          customer_id: 'CUST-001',
          amount: 100.00,
        });
        if (result.success) successCount++;
      }

      // Should succeed most of the time (95% rate)
      expect(successCount).toBeGreaterThan(15);
    });

    it('should fail for zero or negative amounts', async () => {
      const result = await processPaymentHandler({
        order_id: 'ORD-12345',
        customer_id: 'CUST-001',
        amount: 0,
      });

      expect(result.success).toBe(false);
    });

    it('should return transaction ID on success', async () => {
      mockUpdateItem();

      // Keep trying until we get a success (95% rate)
      let result;
      for (let i = 0; i < 10; i++) {
        result = await processPaymentHandler({
          order_id: 'ORD-12345',
          customer_id: 'CUST-001',
          amount: 50.00,
        });
        if (result.success) break;
      }

      expect(result!.success).toBe(true);
      expect(result!.transaction_id).toMatch(/^TXN-/);
      expect(result!.payment_state).toBe(PaymentState.CAPTURED);
    });
  });

  describe('send-notifications', () => {
    it('should send notification for confirmed order', async () => {
      const result = await sendNotificationsHandler({
        order_id: 'ORD-12345',
        customer_id: 'CUST-001',
        status: OrderStatus.CONFIRMED,
        total: 100.00,
      });

      expect(result.success).toBe(true);
      expect(result.message_id).toBeDefined();
    });

    it('should send notification for failed order', async () => {
      const result = await sendNotificationsHandler({
        order_id: 'ORD-12345',
        customer_id: 'CUST-001',
        status: OrderStatus.FAILED,
        reason: 'Payment declined',
      });

      expect(result.success).toBe(true);
    });

    it('should send notification for cancelled order', async () => {
      const result = await sendNotificationsHandler({
        order_id: 'ORD-12345',
        customer_id: 'CUST-001',
        status: OrderStatus.CANCELLED,
      });

      expect(result.success).toBe(true);
    });
  });
});

describe('Shared Utilities', () => {
  describe('Validation', () => {
    const { validate, CreateOrderRequestSchema } = require('@acme-liquors/shared');

    it('should validate correct order request', () => {
      const validRequest = {
        customer_id: 'CUST-001',
        store_id: 'STORE-001',
        county_id: 'COUNTY-001',
        idempotency_key: 'test-key',
        items: [
          { sku: 'SKU-001', name: 'Test', quantity: 1, unit_price: 10, total_price: 10 },
        ],
        shipping_address: {
          street: '123 Test St',
          city: 'Test City',
          state: 'TX',
          zip: '12345',
        },
      };

      const result = validate(CreateOrderRequestSchema, validRequest);
      expect(result.success).toBe(true);
    });

    it('should reject invalid order request', () => {
      const invalidRequest = {
        customer_id: '',
        items: [],
      };

      const result = validate(CreateOrderRequestSchema, invalidRequest);
      expect(result.success).toBe(false);
      expect(result.errors).toBeDefined();
    });
  });

  describe('Idempotency', () => {
    const { generateOrderId, generateOrderSortKey, parseOrderSortKey } = require('@acme-liquors/shared');

    it('should generate valid order ID', () => {
      const orderId = generateOrderId();
      expect(orderId).toMatch(/^ORD-[0-9A-Z]{26}$/);
    });

    it('should generate unique order IDs', () => {
      const ids = new Set<string>();
      for (let i = 0; i < 100; i++) {
        ids.add(generateOrderId());
      }
      expect(ids.size).toBe(100);
    });

    it('should generate and parse order sort key', () => {
      const orderId = 'ORD-TEST123';
      const sortKey = generateOrderSortKey(orderId);
      const parsed = parseOrderSortKey(sortKey);

      expect(parsed.orderId).toBe(orderId);
      expect(parsed.timestamp).toBeDefined();
    });
  });
});
