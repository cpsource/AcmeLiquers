import * as cdk from "aws-cdk-lib";
import * as events from "aws-cdk-lib/aws-events";
import * as eventsTargets from "aws-cdk-lib/aws-events-targets";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as logs from "aws-cdk-lib/aws-logs";
import * as lambdaEventSources from "aws-cdk-lib/aws-lambda-event-sources";
import { Construct } from "constructs";
import * as path from "path";

export interface EventsStackProps extends cdk.StackProps {
  ordersTable: dynamodb.ITable;
}

export class EventsStack extends cdk.Stack {
  public readonly eventBus: events.EventBus;
  public readonly streamProcessorFn: lambda.Function;

  constructor(scope: Construct, id: string, props: EventsStackProps) {
    super(scope, id, props);

    // Create custom EventBridge event bus
    this.eventBus = new events.EventBus(this, "OrderEventBus", {
      eventBusName: "acme-liquors-orders",
    });

    // Archive all events for replay capability
    new events.Archive(this, "OrderEventArchive", {
      sourceEventBus: this.eventBus,
      archiveName: "acme-orders-archive",
      description: "Archive of all order events for replay",
      eventPattern: {
        source: ["acme.orders"],
      },
      retention: cdk.Duration.days(90),
    });

    // DynamoDB Stream processor Lambda
    const lambdaDir = path.join(__dirname, "../../../services/stream-processor/src/handlers");

    this.streamProcessorFn = new nodejs.NodejsFunction(this, "StreamProcessorFn", {
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      entry: path.join(lambdaDir, "stream-handler.ts"),
      functionName: "acme-stream-processor",
      description: "Process DynamoDB Streams and publish to EventBridge",
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
        EVENT_BUS_NAME: this.eventBus.eventBusName,
      },
    });

    // Grant permissions to publish to EventBridge
    this.eventBus.grantPutEventsTo(this.streamProcessorFn);

    // Add DynamoDB Streams trigger
    this.streamProcessorFn.addEventSource(
      new lambdaEventSources.DynamoEventSource(props.ordersTable, {
        startingPosition: lambda.StartingPosition.TRIM_HORIZON,
        batchSize: 100,
        maxBatchingWindow: cdk.Duration.seconds(5),
        parallelizationFactor: 2,
        retryAttempts: 3,
        reportBatchItemFailures: true,
        filters: [
          // Only process INSERT and MODIFY events
          lambda.FilterCriteria.filter({
            eventName: lambda.FilterRule.or("INSERT", "MODIFY"),
          }),
        ],
      })
    );

    // Create CloudWatch Log Group for event bus (for debugging)
    const eventLogGroup = new logs.LogGroup(this, "EventBusLogGroup", {
      logGroupName: "/aws/events/acme-liquors-orders",
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Rule to log all events (for debugging/monitoring)
    new events.Rule(this, "LogAllEventsRule", {
      eventBus: this.eventBus,
      ruleName: "log-all-order-events",
      description: "Log all order events to CloudWatch",
      eventPattern: {
        source: ["acme.orders"],
      },
      targets: [new eventsTargets.CloudWatchLogGroup(eventLogGroup)],
    });

    // Example rule: Trigger on order confirmed
    new events.Rule(this, "OrderConfirmedRule", {
      eventBus: this.eventBus,
      ruleName: "order-confirmed",
      description: "Triggered when an order is confirmed",
      eventPattern: {
        source: ["acme.orders"],
        detailType: ["Order Status Changed"],
        detail: {
          new_status: ["CONFIRMED"],
        },
      },
      // Add targets here for downstream processing
      // targets: [new eventsTargets.LambdaFunction(fulfillmentFn)],
    });

    // Example rule: Trigger on order cancelled
    new events.Rule(this, "OrderCancelledRule", {
      eventBus: this.eventBus,
      ruleName: "order-cancelled",
      description: "Triggered when an order is cancelled",
      eventPattern: {
        source: ["acme.orders"],
        detailType: ["Order Status Changed"],
        detail: {
          new_status: ["CANCELLED"],
        },
      },
      // Add targets here for inventory release, refunds, etc.
      // targets: [new eventsTargets.LambdaFunction(refundFn)],
    });

    // Example rule: High-value orders (> $500)
    new events.Rule(this, "HighValueOrderRule", {
      eventBus: this.eventBus,
      ruleName: "high-value-orders",
      description: "Triggered for orders over $500",
      eventPattern: {
        source: ["acme.orders"],
        detailType: ["Order Created"],
        detail: {
          total: [{ numeric: [">", 500] }],
        },
      },
      // Add targets for special handling of high-value orders
      // targets: [new eventsTargets.LambdaFunction(vipHandlerFn)],
    });

    // Outputs
    new cdk.CfnOutput(this, "EventBusName", {
      value: this.eventBus.eventBusName,
      exportName: "AcmeLiquors-EventBusName",
    });

    new cdk.CfnOutput(this, "EventBusArn", {
      value: this.eventBus.eventBusArn,
      exportName: "AcmeLiquors-EventBusArn",
    });

    new cdk.CfnOutput(this, "StreamProcessorFnArn", {
      value: this.streamProcessorFn.functionArn,
      exportName: "AcmeLiquors-StreamProcessorFnArn",
    });
  }
}
