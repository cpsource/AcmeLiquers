import { SQSEvent, SQSBatchResponse, SQSBatchItemFailure } from "aws-lambda";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import {
  OrderProcessingMessage,
  getOrderById,
  updateOrderStatus,
  OrderStatus,
  PaymentState,
} from "@acme-liquors/shared";

const lambdaClient = new LambdaClient({});

const RESERVE_INVENTORY_FN = process.env.RESERVE_INVENTORY_FN_ARN!;
const PROCESS_PAYMENT_FN = process.env.PROCESS_PAYMENT_FN_ARN!;
const SEND_NOTIFICATIONS_FN = process.env.SEND_NOTIFICATIONS_FN_ARN!;

/**
 * Main SQS consumer - orchestrates the order processing workflow
 *
 * Workflow:
 * 1. Reserve inventory
 * 2. Process payment
 * 3. Update order status to CONFIRMED
 * 4. Send notifications
 */
export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const batchItemFailures: SQSBatchItemFailure[] = [];

  for (const record of event.Records) {
    try {
      const message: OrderProcessingMessage = JSON.parse(record.body);
      console.log("Processing order:", message.order_id);

      // Get current order state
      const order = await getOrderById(message.order_id);
      if (!order) {
        console.error("Order not found:", message.order_id);
        continue; // Don't retry - order doesn't exist
      }

      // Skip if already processed (idempotency)
      if (order.status !== OrderStatus.PENDING) {
        console.log("Order already processed:", message.order_id, order.status);
        continue;
      }

      // Step 1: Reserve inventory
      const inventoryResult = await invokeFunction(RESERVE_INVENTORY_FN, {
        order_id: message.order_id,
        customer_id: message.customer_id,
        items: order.items,
        store_id: order.store_id,
      });

      if (!inventoryResult.success) {
        console.error("Inventory reservation failed:", inventoryResult.error);
        await failOrder(message, "Inventory reservation failed");
        continue;
      }

      // Step 2: Process payment
      const paymentResult = await invokeFunction(PROCESS_PAYMENT_FN, {
        order_id: message.order_id,
        customer_id: message.customer_id,
        amount: order.total,
      });

      if (!paymentResult.success) {
        console.error("Payment processing failed:", paymentResult.error);
        // TODO: Release inventory reservation
        await failOrder(message, "Payment processing failed");
        continue;
      }

      // Step 3: Update order status to CONFIRMED
      const orderTsId = `${order.order_ts}#${order.order_id}`;
      const updated = await updateOrderStatus(
        message.customer_id,
        orderTsId,
        message.order_id,
        OrderStatus.CONFIRMED,
        OrderStatus.PENDING
      );

      if (!updated) {
        console.error("Failed to update order status:", message.order_id);
        batchItemFailures.push({ itemIdentifier: record.messageId });
        continue;
      }

      // Step 4: Send notifications (async, don't wait)
      await invokeFunction(
        SEND_NOTIFICATIONS_FN,
        {
          order_id: message.order_id,
          customer_id: message.customer_id,
          status: OrderStatus.CONFIRMED,
          total: order.total,
        },
        true // Async invocation
      );

      console.log("Order processed successfully:", message.order_id);
    } catch (error) {
      console.error("Error processing message:", record.messageId, error);
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
}

/**
 * Mark order as failed
 */
async function failOrder(
  message: OrderProcessingMessage,
  reason: string
): Promise<void> {
  try {
    const order = await getOrderById(message.order_id);
    if (order) {
      const orderTsId = `${order.order_ts}#${order.order_id}`;
      await updateOrderStatus(
        message.customer_id,
        orderTsId,
        message.order_id,
        OrderStatus.FAILED,
        OrderStatus.PENDING
      );
    }

    // Send failure notification
    await invokeFunction(
      SEND_NOTIFICATIONS_FN,
      {
        order_id: message.order_id,
        customer_id: message.customer_id,
        status: OrderStatus.FAILED,
        reason,
      },
      true
    );
  } catch (error) {
    console.error("Error failing order:", error);
  }
}

/**
 * Invoke a Lambda function
 */
async function invokeFunction(
  functionArn: string,
  payload: unknown,
  async = false
): Promise<{ success: boolean; data?: unknown; error?: string }> {
  try {
    const response = await lambdaClient.send(
      new InvokeCommand({
        FunctionName: functionArn,
        InvocationType: async ? "Event" : "RequestResponse",
        Payload: Buffer.from(JSON.stringify(payload)),
      })
    );

    if (async) {
      return { success: true };
    }

    if (response.FunctionError) {
      const errorPayload = response.Payload
        ? JSON.parse(Buffer.from(response.Payload).toString())
        : {};
      return { success: false, error: errorPayload.errorMessage || "Function error" };
    }

    const result = response.Payload
      ? JSON.parse(Buffer.from(response.Payload).toString())
      : {};
    return { success: true, data: result };
  } catch (error) {
    console.error("Error invoking function:", functionArn, error);
    return { success: false, error: String(error) };
  }
}
