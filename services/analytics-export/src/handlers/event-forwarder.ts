import { EventBridgeEvent } from "aws-lambda";
import {
  FirehoseClient,
  PutRecordCommand,
} from "@aws-sdk/client-firehose";

const firehoseClient = new FirehoseClient({});
const FIREHOSE_STREAM_NAME = process.env.FIREHOSE_STREAM_NAME!;

/**
 * Forward EventBridge events to Kinesis Firehose
 *
 * This Lambda is triggered by EventBridge rules and forwards
 * order events to the Firehose delivery stream for analytics.
 */
export async function handler(
  event: EventBridgeEvent<string, Record<string, unknown>>
): Promise<void> {
  console.log("Forwarding event to Firehose:", event["detail-type"], event.detail?.order_id);

  try {
    // Prepare the record with the full EventBridge event
    const record = {
      ...event,
      // Ensure we have a consistent structure
      forwarded_at: new Date().toISOString(),
    };

    await firehoseClient.send(
      new PutRecordCommand({
        DeliveryStreamName: FIREHOSE_STREAM_NAME,
        Record: {
          Data: Buffer.from(JSON.stringify(record)),
        },
      })
    );

    console.log("Event forwarded successfully");
  } catch (error) {
    console.error("Error forwarding event to Firehose:", error);
    throw error; // Re-throw to trigger retry
  }
}
