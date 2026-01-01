import { mockClient } from 'aws-sdk-client-mock';
import { SQSClient, SendMessageCommand, SendMessageBatchCommand, DeleteMessageCommand } from '@aws-sdk/client-sqs';

// Create mock client
export const sqsMock = mockClient(SQSClient);

/**
 * Reset all SQS mocks
 */
export function resetSqsMocks(): void {
  sqsMock.reset();
}

/**
 * Mock successful SendMessageCommand
 */
export function mockSendMessage(messageId: string = 'test-message-id'): void {
  sqsMock.on(SendMessageCommand).resolves({
    MessageId: messageId,
  });
}

/**
 * Mock SendMessageCommand failure
 */
export function mockSendMessageFailure(errorMessage: string = 'SQS Error'): void {
  sqsMock.on(SendMessageCommand).rejects(new Error(errorMessage));
}

/**
 * Mock successful SendMessageBatchCommand
 */
export function mockSendMessageBatch(count: number = 1): void {
  sqsMock.on(SendMessageBatchCommand).resolves({
    Successful: Array.from({ length: count }, (_, i) => ({
      Id: `msg-${i}`,
      MessageId: `test-message-${i}`,
    })),
    Failed: [],
  });
}

/**
 * Mock successful DeleteMessageCommand
 */
export function mockDeleteMessage(): void {
  sqsMock.on(DeleteMessageCommand).resolves({});
}

/**
 * Create a mock SQS event
 */
export function createMockSqsEvent(messages: Array<{ body: unknown; messageId?: string }>) {
  return {
    Records: messages.map((msg, index) => ({
      messageId: msg.messageId || `test-message-${index}`,
      receiptHandle: `test-receipt-${index}`,
      body: JSON.stringify(msg.body),
      attributes: {
        ApproximateReceiveCount: '1',
        SentTimestamp: String(Date.now()),
        SenderId: 'test-sender',
        ApproximateFirstReceiveTimestamp: String(Date.now()),
      },
      messageAttributes: {},
      md5OfBody: 'test-md5',
      eventSource: 'aws:sqs',
      eventSourceARN: 'arn:aws:sqs:us-east-1:123456789:test-queue',
      awsRegion: 'us-east-1',
    })),
  };
}
