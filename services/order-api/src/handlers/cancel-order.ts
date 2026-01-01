import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import {
  getOrderById,
  updateOrderStatus,
  OrderStatus,
} from "@acme-liquors/shared";

// Statuses that can be cancelled
const CANCELLABLE_STATUSES: OrderStatus[] = [
  OrderStatus.PENDING,
  OrderStatus.CONFIRMED,
];

/**
 * DELETE /orders/{order_id}
 * Cancel an order (only if in PENDING or CONFIRMED status)
 */
export async function handler(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  try {
    const orderId = event.pathParameters?.order_id;

    if (!orderId) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          error: "Missing order_id parameter",
        }),
      };
    }

    // Fetch order to get customer_id and order_ts_id
    const order = await getOrderById(orderId);

    if (!order) {
      return {
        statusCode: 404,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          error: "Order not found",
          order_id: orderId,
        }),
      };
    }

    // Check if order can be cancelled
    if (!CANCELLABLE_STATUSES.includes(order.status)) {
      return {
        statusCode: 409,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          error: "Order cannot be cancelled",
          order_id: orderId,
          current_status: order.status,
          message: `Order can only be cancelled when status is ${CANCELLABLE_STATUSES.join(" or ")}`,
        }),
      };
    }

    // Build the order_ts_id for the main orders table
    const orderTsId = `${order.order_ts}#${order.order_id}`;

    // Update order status with conditional check
    const updated = await updateOrderStatus(
      order.customer_id,
      orderTsId,
      orderId,
      OrderStatus.CANCELLED,
      order.status // Only update if status hasn't changed
    );

    if (!updated) {
      return {
        statusCode: 409,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          error: "Order status changed, please retry",
          order_id: orderId,
        }),
      };
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        order_id: orderId,
        status: OrderStatus.CANCELLED,
        message: "Order cancelled successfully",
      }),
    };
  } catch (error) {
    console.error("Error cancelling order:", error);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error: "Internal server error",
      }),
    };
  }
}
