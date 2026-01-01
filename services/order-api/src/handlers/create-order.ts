import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import {
  CreateOrderRequestSchema,
  Order,
  OrderStatus,
  PaymentState,
  createOrder,
  generateOrderId,
  generateOrderSortKey,
  parseAndValidateBody,
  formatValidationErrors,
  sendOrderMessage,
} from "@acme-liquors/shared";

/**
 * POST /orders
 * Create a new order with idempotency support
 */
export async function handler(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  try {
    // Get idempotency key from header
    const idempotencyKey = event.headers["X-Idempotency-Key"]
      ?? event.headers["x-idempotency-key"];

    if (!idempotencyKey) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          error: "Missing X-Idempotency-Key header",
        }),
      };
    }

    // Parse and validate request body
    const validation = parseAndValidateBody(CreateOrderRequestSchema, event.body);
    if (!validation.success) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formatValidationErrors(validation.errors!)),
      };
    }

    const request = validation.data!;

    // Generate order identifiers
    const orderId = generateOrderId();
    const orderTs = new Date().toISOString();
    const orderTsId = `${orderTs}#${orderId}`;

    // Calculate totals
    const subtotal = request.items.reduce(
      (sum, item) => sum + item.quantity * item.unit_price,
      0
    );
    const tax = subtotal * 0.08; // 8% tax rate
    const total = subtotal + tax;

    // Build order with calculated total_price for each item
    const itemsWithTotals = request.items.map((item) => ({
      ...item,
      total_price: item.quantity * item.unit_price,
    }));

    // Create order object
    const order: Order = {
      customer_id: request.customer_id,
      order_ts_id: orderTsId,
      order_id: orderId,
      order_ts: orderTs,
      store_id: request.store_id,
      county_id: request.county_id,
      status: OrderStatus.PENDING,
      payment_state: PaymentState.PENDING,
      items: itemsWithTotals,
      subtotal,
      tax,
      total,
      shipping_address: request.shipping_address,
      idempotency_key: idempotencyKey,
      created_at: orderTs,
      updated_at: orderTs,
    };

    // Create order with idempotency check
    const result = await createOrder(order);

    // If order was newly created, enqueue for processing
    if (result.created) {
      await sendOrderMessage({
        order_id: orderId,
        customer_id: request.customer_id,
        order_ts_id: orderTsId,
        action: "PROCESS_ORDER",
        timestamp: orderTs,
      });
    }

    // Return response
    const statusCode = result.created ? 201 : 200;
    return {
      statusCode,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        order_id: result.order.order_id,
        customer_id: result.order.customer_id,
        status: result.order.status,
        payment_state: result.order.payment_state,
        items: result.order.items,
        subtotal: result.order.subtotal,
        tax: result.order.tax,
        total: result.order.total,
        created_at: result.order.created_at,
        ...(result.created ? {} : { message: "Order already exists (idempotent)" }),
      }),
    };
  } catch (error) {
    console.error("Error creating order:", error);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error: "Internal server error",
      }),
    };
  }
}
