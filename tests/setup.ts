// Jest setup file
import { mockClient } from 'aws-sdk-client-mock';

// Set test environment variables
process.env.AWS_REGION = 'us-east-1';
process.env.ORDERS_TABLE_NAME = 'test-orders';
process.env.ORDERS_BY_ID_TABLE_NAME = 'test-orders-by-id';
process.env.INVENTORY_TABLE_NAME = 'test-inventory';
process.env.ORDER_QUEUE_URL = 'https://sqs.us-east-1.amazonaws.com/123456789/test-queue';
process.env.NOTIFICATION_TOPIC_ARN = 'arn:aws:sns:us-east-1:123456789:test-topic';
process.env.EVENT_BUS_NAME = 'test-event-bus';

// Increase timeout for async operations
jest.setTimeout(30000);

// Clean up after each test
afterEach(() => {
  jest.clearAllMocks();
});
