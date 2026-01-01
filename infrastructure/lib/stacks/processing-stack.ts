import * as cdk from "aws-cdk-lib";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as sns from "aws-cdk-lib/aws-sns";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import { Construct } from "constructs";
import { OrderProcessor } from "../constructs/order-processor";

export interface ProcessingStackProps extends cdk.StackProps {
  ordersTable?: dynamodb.ITable;
  orderByIdTable?: dynamodb.ITable;
  inventoryTable?: dynamodb.ITable;
}

export class ProcessingStack extends cdk.Stack {
  public readonly orderQueue: sqs.Queue;
  public readonly deadLetterQueue: sqs.Queue;
  public readonly notificationTopic: sns.Topic;

  constructor(scope: Construct, id: string, props?: ProcessingStackProps) {
    super(scope, id, props);

    // Dead letter queue for failed messages
    this.deadLetterQueue = new sqs.Queue(this, "OrderDLQ", {
      queueName: "acme-order-processing-dlq",
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });

    // Main order processing queue
    this.orderQueue = new sqs.Queue(this, "OrderQueue", {
      queueName: "acme-order-processing",
      visibilityTimeout: cdk.Duration.seconds(60),
      retentionPeriod: cdk.Duration.days(7),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      deadLetterQueue: {
        queue: this.deadLetterQueue,
        maxReceiveCount: 3, // Move to DLQ after 3 failed attempts
      },
    });

    // SNS topic for order notifications
    this.notificationTopic = new sns.Topic(this, "OrderNotificationTopic", {
      topicName: "acme-order-notifications",
      displayName: "ACME Liquors Order Notifications",
    });

    // Create order processor Lambda functions (if tables are provided)
    if (props?.ordersTable && props?.orderByIdTable && props?.inventoryTable) {
      new OrderProcessor(this, "OrderProcessor", {
        orderQueue: this.orderQueue,
        ordersTable: props.ordersTable,
        orderByIdTable: props.orderByIdTable,
        inventoryTable: props.inventoryTable,
        notificationTopic: this.notificationTopic,
      });
    }

    // Outputs
    new cdk.CfnOutput(this, "OrderQueueUrl", {
      value: this.orderQueue.queueUrl,
      exportName: "AcmeLiquors-OrderQueueUrl",
    });

    new cdk.CfnOutput(this, "OrderQueueArn", {
      value: this.orderQueue.queueArn,
      exportName: "AcmeLiquors-OrderQueueArn",
    });

    new cdk.CfnOutput(this, "OrderDLQUrl", {
      value: this.deadLetterQueue.queueUrl,
      exportName: "AcmeLiquors-OrderDLQUrl",
    });

    new cdk.CfnOutput(this, "NotificationTopicArn", {
      value: this.notificationTopic.topicArn,
      exportName: "AcmeLiquors-NotificationTopicArn",
    });
  }
}
