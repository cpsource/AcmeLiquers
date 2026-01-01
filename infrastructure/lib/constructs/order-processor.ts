import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as sns from "aws-cdk-lib/aws-sns";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as logs from "aws-cdk-lib/aws-logs";
import * as lambdaEventSources from "aws-cdk-lib/aws-lambda-event-sources";
import { Construct } from "constructs";
import * as path from "path";

export interface OrderProcessorProps {
  orderQueue: sqs.IQueue;
  ordersTable: dynamodb.ITable;
  orderByIdTable: dynamodb.ITable;
  inventoryTable: dynamodb.ITable;
  notificationTopic: sns.ITopic;
}

export class OrderProcessor extends Construct {
  public readonly processOrderFn: lambda.Function;
  public readonly reserveInventoryFn: lambda.Function;
  public readonly processPaymentFn: lambda.Function;
  public readonly sendNotificationsFn: lambda.Function;

  constructor(scope: Construct, id: string, props: OrderProcessorProps) {
    super(scope, id);

    const lambdaDir = path.join(__dirname, "../../../services/order-processor/src/handlers");

    // Common Lambda configuration
    const commonLambdaProps: Partial<nodejs.NodejsFunctionProps> = {
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      tracing: lambda.Tracing.ACTIVE,
      logRetention: logs.RetentionDays.ONE_MONTH,
      bundling: {
        minify: true,
        sourceMap: true,
        externalModules: ["@aws-sdk/*"],
      },
      environment: {
        NODE_OPTIONS: "--enable-source-maps",
        ORDERS_TABLE_NAME: props.ordersTable.tableName,
        ORDERS_BY_ID_TABLE_NAME: props.orderByIdTable.tableName,
        INVENTORY_TABLE_NAME: props.inventoryTable.tableName,
        ORDER_QUEUE_URL: props.orderQueue.queueUrl,
        NOTIFICATION_TOPIC_ARN: props.notificationTopic.topicArn,
      },
    };

    // Process Order Lambda (main SQS consumer)
    this.processOrderFn = new nodejs.NodejsFunction(this, "ProcessOrderFn", {
      ...commonLambdaProps,
      entry: path.join(lambdaDir, "process-order.ts"),
      functionName: "acme-process-order",
      description: "Main order processor - orchestrates order workflow",
      reservedConcurrentExecutions: 50, // Limit concurrency
    });

    // Reserve Inventory Lambda
    this.reserveInventoryFn = new nodejs.NodejsFunction(this, "ReserveInventoryFn", {
      ...commonLambdaProps,
      entry: path.join(lambdaDir, "reserve-inventory.ts"),
      functionName: "acme-reserve-inventory",
      description: "Reserve inventory for order items",
    });

    // Process Payment Lambda
    this.processPaymentFn = new nodejs.NodejsFunction(this, "ProcessPaymentFn", {
      ...commonLambdaProps,
      entry: path.join(lambdaDir, "process-payment.ts"),
      functionName: "acme-process-payment",
      description: "Process payment for order",
    });

    // Send Notifications Lambda
    this.sendNotificationsFn = new nodejs.NodejsFunction(this, "SendNotificationsFn", {
      ...commonLambdaProps,
      entry: path.join(lambdaDir, "send-notifications.ts"),
      functionName: "acme-send-notifications",
      description: "Send order notifications via SNS",
    });

    // Grant DynamoDB permissions
    props.ordersTable.grantReadWriteData(this.processOrderFn);
    props.ordersTable.grantReadWriteData(this.reserveInventoryFn);
    props.ordersTable.grantReadWriteData(this.processPaymentFn);
    props.ordersTable.grantReadData(this.sendNotificationsFn);

    props.orderByIdTable.grantReadWriteData(this.processOrderFn);
    props.orderByIdTable.grantReadWriteData(this.reserveInventoryFn);
    props.orderByIdTable.grantReadWriteData(this.processPaymentFn);
    props.orderByIdTable.grantReadData(this.sendNotificationsFn);

    props.inventoryTable.grantReadWriteData(this.reserveInventoryFn);

    // Grant SQS permissions
    props.orderQueue.grantConsumeMessages(this.processOrderFn);
    props.orderQueue.grantSendMessages(this.processOrderFn); // For re-queuing

    // Grant SNS permissions
    props.notificationTopic.grantPublish(this.sendNotificationsFn);

    // Add SQS trigger to process order function
    this.processOrderFn.addEventSource(
      new lambdaEventSources.SqsEventSource(props.orderQueue, {
        batchSize: 10,
        maxBatchingWindow: cdk.Duration.seconds(5),
        reportBatchItemFailures: true, // Enable partial batch failure reporting
      })
    );

    // Allow process order to invoke other functions
    this.reserveInventoryFn.grantInvoke(this.processOrderFn);
    this.processPaymentFn.grantInvoke(this.processOrderFn);
    this.sendNotificationsFn.grantInvoke(this.processOrderFn);

    // Add function ARNs to process order environment
    this.processOrderFn.addEnvironment(
      "RESERVE_INVENTORY_FN_ARN",
      this.reserveInventoryFn.functionArn
    );
    this.processOrderFn.addEnvironment(
      "PROCESS_PAYMENT_FN_ARN",
      this.processPaymentFn.functionArn
    );
    this.processOrderFn.addEnvironment(
      "SEND_NOTIFICATIONS_FN_ARN",
      this.sendNotificationsFn.functionArn
    );
  }
}
