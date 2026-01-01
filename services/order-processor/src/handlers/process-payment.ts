import {
  getDocumentClient,
  TableNames,
  PaymentState,
} from "@acme-liquors/shared";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";

interface ProcessPaymentRequest {
  order_id: string;
  customer_id: string;
  amount: number;
}

interface ProcessPaymentResponse {
  success: boolean;
  transaction_id?: string;
  payment_state?: PaymentState;
  error?: string;
}

/**
 * Process payment for an order
 *
 * NOTE: This is a STUB implementation for demonstration.
 * In production, this would integrate with a payment provider like:
 * - Stripe
 * - Square
 * - PayPal
 * - Adyen
 *
 * The stub simulates a 95% success rate for testing.
 */
export async function handler(
  event: ProcessPaymentRequest
): Promise<ProcessPaymentResponse> {
  const client = getDocumentClient();
  const now = new Date().toISOString();

  console.log("Processing payment for order:", event.order_id, "amount:", event.amount);

  try {
    // Simulate payment processing
    // In production, this would call a payment provider API
    const paymentSuccess = simulatePayment(event.amount);

    const transactionId = `TXN-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    const paymentState = paymentSuccess ? PaymentState.CAPTURED : PaymentState.FAILED;

    // Update order payment state
    await client.send(
      new UpdateCommand({
        TableName: TableNames.ORDERS_BY_ID,
        Key: { order_id: event.order_id },
        UpdateExpression: "SET payment_state = :state, updated_at = :now",
        ExpressionAttributeValues: {
          ":state": paymentState,
          ":now": now,
        },
      })
    );

    if (paymentSuccess) {
      console.log("Payment successful:", transactionId);
      return {
        success: true,
        transaction_id: transactionId,
        payment_state: PaymentState.CAPTURED,
      };
    } else {
      console.log("Payment failed:", event.order_id);
      return {
        success: false,
        payment_state: PaymentState.FAILED,
        error: "Payment declined",
      };
    }
  } catch (error) {
    console.error("Error processing payment:", error);
    return {
      success: false,
      error: String(error),
    };
  }
}

/**
 * Simulate payment processing with configurable success rate
 *
 * In production, replace this with actual payment provider integration:
 *
 * async function processStripePayment(amount: number, customerId: string) {
 *   const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
 *   const paymentIntent = await stripe.paymentIntents.create({
 *     amount: Math.round(amount * 100), // cents
 *     currency: 'usd',
 *     customer: customerId,
 *     confirm: true,
 *   });
 *   return paymentIntent.status === 'succeeded';
 * }
 */
function simulatePayment(amount: number): boolean {
  // 95% success rate for testing
  // In production, remove this and use real payment processing
  const successRate = 0.95;
  const random = Math.random();

  // Also fail for invalid amounts
  if (amount <= 0) {
    return false;
  }

  return random < successRate;
}
