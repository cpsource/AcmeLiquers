import {
  DynamoDBStreamEvent,
  DynamoDBRecord,
  DynamoDBBatchResponse,
  DynamoDBBatchItemFailure,
} from "aws-lambda";
import {
  EventBridgeClient,
  PutEventsCommand,
  PutEventsRequestEntry,
} from "@aws-sdk/client-eventbridge";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { AttributeValue } from "@aws-sdk/client-dynamodb";
import { Order, OrderStatus } from "@acme-liquors/shared";

const eventBridgeClient = new EventBridgeClient({});
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME!;
const EVENT_SOURCE = "acme.orders";

/**
 * Process DynamoDB Streams and publish domain events to EventBridge
 *
 * This handler transforms low-level DynamoDB change events into
 * business-meaningful domain events for downstream consumers.
 */
export async function handler(
  event: DynamoDBStreamEvent
): Promise<DynamoDBBatchResponse> {
  const batchItemFailures: DynamoDBBatchItemFailure[] = [];
  const eventsToPublish: PutEventsRequestEntry[] = [];

  for (const record of event.Records) {
    try {
      const domainEvents = transformToDomainEvents(record);
      eventsToPublish.push(...domainEvents);
    } catch (error) {
      console.error("Error processing record:", record.eventID, error);
      if (record.eventID) {
        batchItemFailures.push({ itemIdentifier: record.eventID });
      }
    }
  }

  // Publish events to EventBridge in batches of 10
  if (eventsToPublish.length > 0) {
    try {
      await publishEvents(eventsToPublish);
    } catch (error) {
      console.error("Error publishing events:", error);
      // Mark all records as failed if we can't publish
      for (const record of event.Records) {
        if (record.eventID) {
          batchItemFailures.push({ itemIdentifier: record.eventID });
        }
      }
    }
  }

  return { batchItemFailures };
}

/**
 * Transform a DynamoDB Stream record into domain events
 */
function transformToDomainEvents(record: DynamoDBRecord): PutEventsRequestEntry[] {
  const events: PutEventsRequestEntry[] = [];
  const eventName = record.eventName;
  const timestamp = new Date().toISOString();

  if (!record.dynamodb) {
    return events;
  }

  const newImage = record.dynamodb.NewImage
    ? (unmarshall(record.dynamodb.NewImage as Record<string, AttributeValue>) as Order)
    : null;

  const oldImage = record.dynamodb.OldImage
    ? (unmarshall(record.dynamodb.OldImage as Record<string, AttributeValue>) as Order)
    : null;

  switch (eventName) {
    case "INSERT":
      if (newImage) {
        events.push({
          EventBusName: EVENT_BUS_NAME,
          Source: EVENT_SOURCE,
          DetailType: "Order Created",
          Time: new Date(timestamp),
          Detail: JSON.stringify({
            event_type: "ORDER_CREATED",
            order_id: newImage.order_id,
            customer_id: newImage.customer_id,
            store_id: newImage.store_id,
            county_id: newImage.county_id,
            status: newImage.status,
            total: newImage.total,
            item_count: newImage.items?.length ?? 0,
            timestamp,
          }),
        });
      }
      break;

    case "MODIFY":
      if (newImage && oldImage) {
        // Check for status change
        if (newImage.status !== oldImage.status) {
          events.push({
            EventBusName: EVENT_BUS_NAME,
            Source: EVENT_SOURCE,
            DetailType: "Order Status Changed",
            Time: new Date(timestamp),
            Detail: JSON.stringify({
              event_type: "ORDER_STATUS_CHANGED",
              order_id: newImage.order_id,
              customer_id: newImage.customer_id,
              store_id: newImage.store_id,
              county_id: newImage.county_id,
              old_status: oldImage.status,
              new_status: newImage.status,
              total: newImage.total,
              timestamp,
            }),
          });

          // Emit specific events for key status transitions
          if (newImage.status === OrderStatus.CONFIRMED) {
            events.push({
              EventBusName: EVENT_BUS_NAME,
              Source: EVENT_SOURCE,
              DetailType: "Order Confirmed",
              Time: new Date(timestamp),
              Detail: JSON.stringify({
                event_type: "ORDER_CONFIRMED",
                order_id: newImage.order_id,
                customer_id: newImage.customer_id,
                store_id: newImage.store_id,
                county_id: newImage.county_id,
                total: newImage.total,
                items: newImage.items,
                shipping_address: newImage.shipping_address,
                timestamp,
              }),
            });
          }

          if (newImage.status === OrderStatus.CANCELLED) {
            events.push({
              EventBusName: EVENT_BUS_NAME,
              Source: EVENT_SOURCE,
              DetailType: "Order Cancelled",
              Time: new Date(timestamp),
              Detail: JSON.stringify({
                event_type: "ORDER_CANCELLED",
                order_id: newImage.order_id,
                customer_id: newImage.customer_id,
                store_id: newImage.store_id,
                county_id: newImage.county_id,
                total: newImage.total,
                timestamp,
              }),
            });
          }

          if (newImage.status === OrderStatus.SHIPPED) {
            events.push({
              EventBusName: EVENT_BUS_NAME,
              Source: EVENT_SOURCE,
              DetailType: "Order Shipped",
              Time: new Date(timestamp),
              Detail: JSON.stringify({
                event_type: "ORDER_SHIPPED",
                order_id: newImage.order_id,
                customer_id: newImage.customer_id,
                store_id: newImage.store_id,
                shipping_address: newImage.shipping_address,
                timestamp,
              }),
            });
          }
        }

        // Check for payment state change
        if (newImage.payment_state !== oldImage.payment_state) {
          events.push({
            EventBusName: EVENT_BUS_NAME,
            Source: EVENT_SOURCE,
            DetailType: "Payment State Changed",
            Time: new Date(timestamp),
            Detail: JSON.stringify({
              event_type: "PAYMENT_STATE_CHANGED",
              order_id: newImage.order_id,
              customer_id: newImage.customer_id,
              old_state: oldImage.payment_state,
              new_state: newImage.payment_state,
              total: newImage.total,
              timestamp,
            }),
          });
        }
      }
      break;

    case "REMOVE":
      // Orders should not be deleted, but log if it happens
      if (oldImage) {
        console.warn("Order deleted:", oldImage.order_id);
        events.push({
          EventBusName: EVENT_BUS_NAME,
          Source: EVENT_SOURCE,
          DetailType: "Order Deleted",
          Time: new Date(timestamp),
          Detail: JSON.stringify({
            event_type: "ORDER_DELETED",
            order_id: oldImage.order_id,
            customer_id: oldImage.customer_id,
            timestamp,
          }),
        });
      }
      break;
  }

  return events;
}

/**
 * Publish events to EventBridge in batches
 */
async function publishEvents(events: PutEventsRequestEntry[]): Promise<void> {
  // EventBridge accepts max 10 events per request
  const batchSize = 10;

  for (let i = 0; i < events.length; i += batchSize) {
    const batch = events.slice(i, i + batchSize);

    console.log(`Publishing ${batch.length} events to EventBridge`);

    const result = await eventBridgeClient.send(
      new PutEventsCommand({
        Entries: batch,
      })
    );

    if (result.FailedEntryCount && result.FailedEntryCount > 0) {
      console.error("Some events failed to publish:", result.Entries);
      throw new Error(`Failed to publish ${result.FailedEntryCount} events`);
    }
  }
}
