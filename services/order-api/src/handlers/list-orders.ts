import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { listOrdersByCustomer } from "@acme-liquors/shared";

/**
 * GET /orders?customer_id=xxx&limit=20&next_token=xxx
 * List orders by customer with pagination
 */
export async function handler(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  try {
    const customerId = event.queryStringParameters?.customer_id;
    const limitStr = event.queryStringParameters?.limit;
    const nextToken = event.queryStringParameters?.next_token;

    if (!customerId) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          error: "Missing customer_id query parameter",
        }),
      };
    }

    // Parse and validate limit
    let limit = 20;
    if (limitStr) {
      const parsed = parseInt(limitStr, 10);
      if (isNaN(parsed) || parsed < 1 || parsed > 100) {
        return {
          statusCode: 400,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            error: "Invalid limit parameter. Must be between 1 and 100",
          }),
        };
      }
      limit = parsed;
    }

    // Fetch orders
    const result = await listOrdersByCustomer(customerId, limit, nextToken);

    // Map to response format
    const orders = result.orders.map((order) => ({
      order_id: order.order_id,
      customer_id: order.customer_id,
      status: order.status,
      payment_state: order.payment_state,
      items: order.items,
      subtotal: order.subtotal,
      tax: order.tax,
      total: order.total,
      created_at: order.created_at,
    }));

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        orders,
        next_token: result.nextToken,
      }),
    };
  } catch (error) {
    console.error("Error listing orders:", error);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error: "Internal server error",
      }),
    };
  }
}
