import {
  getDocumentClient,
  TableNames,
  executeTransaction,
  generateReservationId,
  calculateTTL,
  OrderItem,
} from "@acme-liquors/shared";
import { GetCommand, TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";

interface ReserveInventoryRequest {
  order_id: string;
  customer_id: string;
  store_id: string;
  items: OrderItem[];
}

interface ReserveInventoryResponse {
  success: boolean;
  reservation_id?: string;
  failed_items?: Array<{
    sku: string;
    requested: number;
    available: number;
  }>;
  error?: string;
}

/**
 * Reserve inventory for order items using DynamoDB transactions
 *
 * This handler:
 * 1. Checks availability for all items
 * 2. Creates reservations atomically using TransactWriteItems
 * 3. Returns failure if any item is unavailable
 */
export async function handler(
  event: ReserveInventoryRequest
): Promise<ReserveInventoryResponse> {
  const client = getDocumentClient();
  const reservationId = generateReservationId();
  const now = new Date().toISOString();
  const ttl = calculateTTL(30); // 30 minute reservation TTL

  console.log("Reserving inventory for order:", event.order_id);

  try {
    // First, check availability for all items
    const availabilityChecks = await Promise.all(
      event.items.map(async (item) => {
        const storeSku = `${event.store_id}#${item.sku}`;
        const result = await client.send(
          new GetCommand({
            TableName: TableNames.INVENTORY,
            Key: { store_sku: storeSku },
          })
        );

        const inventory = result.Item;
        const available = inventory
          ? (inventory.quantity_available ?? 0) - (inventory.quantity_reserved ?? 0)
          : 0;

        return {
          sku: item.sku,
          store_sku: storeSku,
          requested: item.quantity,
          available,
          sufficient: available >= item.quantity,
        };
      })
    );

    // Check if all items are available
    const insufficientItems = availabilityChecks.filter((c) => !c.sufficient);
    if (insufficientItems.length > 0) {
      console.log("Insufficient inventory:", insufficientItems);
      return {
        success: false,
        failed_items: insufficientItems.map((i) => ({
          sku: i.sku,
          requested: i.requested,
          available: i.available,
        })),
        error: "Insufficient inventory",
      };
    }

    // Build transaction to reserve all items
    const transactItems: TransactWriteCommandInput["TransactItems"] = [];

    for (const item of event.items) {
      const storeSku = `${event.store_id}#${item.sku}`;

      // Update inventory - increment reserved quantity
      transactItems.push({
        Update: {
          TableName: TableNames.INVENTORY,
          Key: { store_sku: storeSku },
          UpdateExpression:
            "SET quantity_reserved = if_not_exists(quantity_reserved, :zero) + :qty, updated_at = :now",
          ConditionExpression:
            "(quantity_available - if_not_exists(quantity_reserved, :zero)) >= :qty",
          ExpressionAttributeValues: {
            ":qty": item.quantity,
            ":zero": 0,
            ":now": now,
          },
        },
      });
    }

    // Execute transaction
    await executeTransaction({ TransactItems: transactItems });

    console.log("Inventory reserved successfully:", reservationId);
    return {
      success: true,
      reservation_id: reservationId,
    };
  } catch (error) {
    console.error("Error reserving inventory:", error);

    // Check if it's a transaction cancelled error (condition failed)
    if ((error as Error).name === "TransactionCanceledException") {
      return {
        success: false,
        error: "Inventory changed during reservation, please retry",
      };
    }

    return {
      success: false,
      error: String(error),
    };
  }
}
