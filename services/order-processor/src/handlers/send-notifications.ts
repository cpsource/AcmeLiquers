import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
import { OrderStatus } from "@acme-liquors/shared";

const snsClient = new SNSClient({});
const NOTIFICATION_TOPIC_ARN = process.env.NOTIFICATION_TOPIC_ARN!;

interface SendNotificationRequest {
  order_id: string;
  customer_id: string;
  status: OrderStatus;
  total?: number;
  reason?: string;
}

interface SendNotificationResponse {
  success: boolean;
  message_id?: string;
  error?: string;
}

/**
 * Send order notifications via SNS
 *
 * This handler publishes order events to an SNS topic which can have
 * multiple subscribers:
 * - Email notifications
 * - SMS notifications
 * - Webhook integrations
 * - Other microservices
 */
export async function handler(
  event: SendNotificationRequest
): Promise<SendNotificationResponse> {
  console.log("Sending notification for order:", event.order_id, "status:", event.status);

  try {
    // Build notification message based on status
    const message = buildNotificationMessage(event);

    // Publish to SNS topic
    const result = await snsClient.send(
      new PublishCommand({
        TopicArn: NOTIFICATION_TOPIC_ARN,
        Subject: `Order ${event.order_id} - ${event.status}`,
        Message: JSON.stringify(message),
        MessageAttributes: {
          order_id: {
            DataType: "String",
            StringValue: event.order_id,
          },
          customer_id: {
            DataType: "String",
            StringValue: event.customer_id,
          },
          status: {
            DataType: "String",
            StringValue: event.status,
          },
          event_type: {
            DataType: "String",
            StringValue: `ORDER_${event.status}`,
          },
        },
      })
    );

    console.log("Notification sent:", result.MessageId);
    return {
      success: true,
      message_id: result.MessageId,
    };
  } catch (error) {
    console.error("Error sending notification:", error);
    return {
      success: false,
      error: String(error),
    };
  }
}

/**
 * Build notification message based on order status
 */
function buildNotificationMessage(event: SendNotificationRequest): {
  type: string;
  order_id: string;
  customer_id: string;
  status: OrderStatus;
  timestamp: string;
  details: Record<string, unknown>;
} {
  const baseMessage = {
    type: `ORDER_${event.status}`,
    order_id: event.order_id,
    customer_id: event.customer_id,
    status: event.status,
    timestamp: new Date().toISOString(),
  };

  switch (event.status) {
    case OrderStatus.CONFIRMED:
      return {
        ...baseMessage,
        details: {
          message: "Your order has been confirmed!",
          total: event.total,
          next_step: "Your order is being prepared for shipment.",
        },
      };

    case OrderStatus.FAILED:
      return {
        ...baseMessage,
        details: {
          message: "Unfortunately, your order could not be processed.",
          reason: event.reason || "Unknown error",
          next_step: "Please try placing your order again or contact support.",
        },
      };

    case OrderStatus.CANCELLED:
      return {
        ...baseMessage,
        details: {
          message: "Your order has been cancelled.",
          next_step: "If you did not request this cancellation, please contact support.",
        },
      };

    case OrderStatus.SHIPPED:
      return {
        ...baseMessage,
        details: {
          message: "Your order has been shipped!",
          next_step: "Track your package using the tracking number in your email.",
        },
      };

    case OrderStatus.DELIVERED:
      return {
        ...baseMessage,
        details: {
          message: "Your order has been delivered!",
          next_step: "We hope you enjoy your purchase. Please leave a review!",
        },
      };

    default:
      return {
        ...baseMessage,
        details: {
          message: `Order status updated to ${event.status}`,
        },
      };
  }
}
