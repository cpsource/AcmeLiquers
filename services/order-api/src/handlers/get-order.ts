import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { getOrderById } from "@acme-liquors/shared";

/**
 * GET /orders/{order_id}
 * Get order by ID using the OrderById table for fast lookup
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

    // Fetch order from OrderById table
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

    // Return order response
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        order_id: order.order_id,
        customer_id: order.customer_id,
        status: order.status,
        payment_state: order.payment_state,
        store_id: order.store_id,
        county_id: order.county_id,
        items: order.items,
        subtotal: order.subtotal,
        tax: order.tax,
        total: order.total,
        shipping_address: order.shipping_address,
        created_at: order.created_at,
        updated_at: order.updated_at,
      }),
    };
  } catch (error) {
    console.error("Error getting order:", error);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error: "Internal server error",
      }),
    };
  }
}
