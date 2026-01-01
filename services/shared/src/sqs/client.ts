import {
  SQSClient,
  SendMessageCommand,
  SendMessageBatchCommand,
  DeleteMessageCommand,
} from "@aws-sdk/client-sqs";

// Singleton SQS client
let sqsClient: SQSClient | null = null;

/**
 * Get SQS client
 */
export function getSQSClient(): SQSClient {
  if (!sqsClient) {
    sqsClient = new SQSClient({
      region: process.env.AWS_REGION ?? "us-east-1",
    });
  }
  return sqsClient;
}

// Queue URLs from environment
export const QueueUrls = {
  ORDER_PROCESSING: process.env.ORDER_QUEUE_URL ?? "",
} as const;

/**
 * Message types for order processing queue
 */
export interface OrderProcessingMessage {
  order_id: string;
  customer_id: string;
  order_ts_id: string;
  action: "PROCESS_ORDER" | "RESERVE_INVENTORY" | "PROCESS_PAYMENT" | "SEND_NOTIFICATION";
  attempt?: number;
  timestamp: string;
}

/**
 * Send a message to the order processing queue
 */
export async function sendOrderMessage(
  message: OrderProcessingMessage,
  delaySeconds?: number
): Promise<string> {
  const client = getSQSClient();

  const result = await client.send(
    new SendMessageCommand({
      QueueUrl: QueueUrls.ORDER_PROCESSING,
      MessageBody: JSON.stringify(message),
      DelaySeconds: delaySeconds,
      MessageAttributes: {
        action: {
          DataType: "String",
          StringValue: message.action,
        },
        order_id: {
          DataType: "String",
          StringValue: message.order_id,
        },
      },
      // Use order_id as deduplication ID for FIFO queues
      // MessageDeduplicationId: message.order_id,
      // MessageGroupId: message.customer_id,
    })
  );

  return result.MessageId ?? "";
}

/**
 * Send multiple messages in a batch
 */
export async function sendOrderMessageBatch(
  messages: OrderProcessingMessage[]
): Promise<{ successful: string[]; failed: string[] }> {
  const client = getSQSClient();

  const result = await client.send(
    new SendMessageBatchCommand({
      QueueUrl: QueueUrls.ORDER_PROCESSING,
      Entries: messages.map((msg, index) => ({
        Id: `msg-${index}`,
        MessageBody: JSON.stringify(msg),
        MessageAttributes: {
          action: {
            DataType: "String",
            StringValue: msg.action,
          },
          order_id: {
            DataType: "String",
            StringValue: msg.order_id,
          },
        },
      })),
    })
  );

  return {
    successful: result.Successful?.map((s) => s.MessageId ?? "") ?? [],
    failed: result.Failed?.map((f) => f.Id ?? "") ?? [],
  };
}

/**
 * Delete a message from the queue (after successful processing)
 */
export async function deleteMessage(receiptHandle: string): Promise<void> {
  const client = getSQSClient();

  await client.send(
    new DeleteMessageCommand({
      QueueUrl: QueueUrls.ORDER_PROCESSING,
      ReceiptHandle: receiptHandle,
    })
  );
}
