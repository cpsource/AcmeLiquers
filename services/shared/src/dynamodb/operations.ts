import {
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  UpdateCommandInput,
  DeleteCommand,
  BatchWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { getDocumentClient, TableNames, IndexNames } from "./client";
import { Order, OrderById, OrderStatus } from "../types/order";

/**
 * Create a new order with conditional check (idempotency)
 * Returns existing order if idempotency key matches
 */
export async function createOrder(
  order: Order
): Promise<{ created: boolean; order: Order }> {
  const client = getDocumentClient();

  try {
    await client.send(
      new PutCommand({
        TableName: TableNames.ORDERS,
        Item: order,
        ConditionExpression: "attribute_not_exists(customer_id)",
      })
    );

    // Also write to OrderById table
    const orderById: OrderById = {
      order_id: order.order_id,
      customer_id: order.customer_id,
      order_ts: order.order_ts,
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
    };

    await client.send(
      new PutCommand({
        TableName: TableNames.ORDERS_BY_ID,
        Item: orderById,
      })
    );

    return { created: true, order };
  } catch (error) {
    if (
      error instanceof ConditionalCheckFailedException ||
      (error instanceof Error && error.name === "ConditionalCheckFailedException")
    ) {
      // Order already exists, fetch and return it
      const existing = await getOrderByCustomer(
        order.customer_id,
        order.order_ts_id
      );
      if (existing) {
        return { created: false, order: existing };
      }
    }
    throw error;
  }
}

/**
 * Get order by customer_id and order_ts_id
 */
export async function getOrderByCustomer(
  customerId: string,
  orderTsId: string
): Promise<Order | null> {
  const client = getDocumentClient();

  const result = await client.send(
    new GetCommand({
      TableName: TableNames.ORDERS,
      Key: {
        customer_id: customerId,
        order_ts_id: orderTsId,
      },
    })
  );

  return (result.Item as Order) ?? null;
}

/**
 * Get order by order_id (direct lookup)
 */
export async function getOrderById(orderId: string): Promise<OrderById | null> {
  const client = getDocumentClient();

  const result = await client.send(
    new GetCommand({
      TableName: TableNames.ORDERS_BY_ID,
      Key: { order_id: orderId },
    })
  );

  return (result.Item as OrderById) ?? null;
}

/**
 * List orders by customer
 */
export async function listOrdersByCustomer(
  customerId: string,
  limit: number = 20,
  nextToken?: string
): Promise<{ orders: Order[]; nextToken?: string }> {
  const client = getDocumentClient();

  const result = await client.send(
    new QueryCommand({
      TableName: TableNames.ORDERS,
      KeyConditionExpression: "customer_id = :cid",
      ExpressionAttributeValues: {
        ":cid": customerId,
      },
      ScanIndexForward: false, // Newest first
      Limit: limit,
      ExclusiveStartKey: nextToken ? JSON.parse(nextToken) : undefined,
    })
  );

  return {
    orders: (result.Items as Order[]) ?? [],
    nextToken: result.LastEvaluatedKey
      ? JSON.stringify(result.LastEvaluatedKey)
      : undefined,
  };
}

/**
 * List orders by county (using GSI)
 */
export async function listOrdersByCounty(
  countyId: string,
  startTime?: string,
  endTime?: string,
  limit: number = 100
): Promise<Order[]> {
  const client = getDocumentClient();

  let keyCondition = "county_id = :cid";
  const expressionValues: Record<string, string> = { ":cid": countyId };

  if (startTime && endTime) {
    keyCondition += " AND order_ts BETWEEN :start AND :end";
    expressionValues[":start"] = startTime;
    expressionValues[":end"] = endTime;
  } else if (startTime) {
    keyCondition += " AND order_ts >= :start";
    expressionValues[":start"] = startTime;
  }

  const result = await client.send(
    new QueryCommand({
      TableName: TableNames.ORDERS,
      IndexName: IndexNames.COUNTY_ORDER,
      KeyConditionExpression: keyCondition,
      ExpressionAttributeValues: expressionValues,
      ScanIndexForward: false,
      Limit: limit,
    })
  );

  return (result.Items as Order[]) ?? [];
}

/**
 * List orders by store (using GSI)
 */
export async function listOrdersByStore(
  storeId: string,
  limit: number = 100
): Promise<Order[]> {
  const client = getDocumentClient();

  const result = await client.send(
    new QueryCommand({
      TableName: TableNames.ORDERS,
      IndexName: IndexNames.STORE_ORDER,
      KeyConditionExpression: "store_id = :sid",
      ExpressionAttributeValues: {
        ":sid": storeId,
      },
      ScanIndexForward: false,
      Limit: limit,
    })
  );

  return (result.Items as Order[]) ?? [];
}

/**
 * List orders by status (using GSI)
 */
export async function listOrdersByStatus(
  status: OrderStatus,
  limit: number = 100
): Promise<Order[]> {
  const client = getDocumentClient();

  const result = await client.send(
    new QueryCommand({
      TableName: TableNames.ORDERS,
      IndexName: IndexNames.STATUS_ORDER,
      KeyConditionExpression: "#status = :status",
      ExpressionAttributeNames: {
        "#status": "status",
      },
      ExpressionAttributeValues: {
        ":status": status,
      },
      ScanIndexForward: false,
      Limit: limit,
    })
  );

  return (result.Items as Order[]) ?? [];
}

/**
 * Update order status with conditional check
 */
export async function updateOrderStatus(
  customerId: string,
  orderTsId: string,
  orderId: string,
  newStatus: OrderStatus,
  expectedCurrentStatus?: OrderStatus
): Promise<boolean> {
  const client = getDocumentClient();
  const now = new Date().toISOString();

  try {
    // Update main orders table
    const updateParams: UpdateCommandInput = {
      TableName: TableNames.ORDERS,
      Key: {
        customer_id: customerId,
        order_ts_id: orderTsId,
      },
      UpdateExpression: "SET #status = :newStatus, updated_at = :now",
      ExpressionAttributeNames: {
        "#status": "status",
      },
      ExpressionAttributeValues: {
        ":newStatus": newStatus,
        ":now": now,
      },
    };

    if (expectedCurrentStatus) {
      updateParams.ConditionExpression = "#status = :currentStatus";
      updateParams.ExpressionAttributeValues![":currentStatus"] =
        expectedCurrentStatus;
    }

    await client.send(new UpdateCommand(updateParams));

    // Also update OrderById table
    await client.send(
      new UpdateCommand({
        TableName: TableNames.ORDERS_BY_ID,
        Key: { order_id: orderId },
        UpdateExpression: "SET #status = :newStatus, updated_at = :now",
        ExpressionAttributeNames: {
          "#status": "status",
        },
        ExpressionAttributeValues: {
          ":newStatus": newStatus,
          ":now": now,
        },
      })
    );

    return true;
  } catch (error) {
    if (
      error instanceof ConditionalCheckFailedException ||
      (error instanceof Error && error.name === "ConditionalCheckFailedException")
    ) {
      return false;
    }
    throw error;
  }
}
