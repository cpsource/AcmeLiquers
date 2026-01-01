import * as cdk from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as glue from "aws-cdk-lib/aws-glue";
import * as firehose from "aws-cdk-lib/aws-kinesisfirehose";
import * as events from "aws-cdk-lib/aws-events";
import * as eventsTargets from "aws-cdk-lib/aws-events-targets";
import { Construct } from "constructs";
import * as path from "path";

export interface AnalyticsStackProps extends cdk.StackProps {
  eventBus: events.IEventBus;
}

export class AnalyticsStack extends cdk.Stack {
  public readonly analyticsBucket: s3.Bucket;
  public readonly glueDatabase: glue.CfnDatabase;
  public readonly firehoseStream: firehose.CfnDeliveryStream;

  constructor(scope: Construct, id: string, props: AnalyticsStackProps) {
    super(scope, id, props);

    // S3 bucket for analytics data
    this.analyticsBucket = new s3.Bucket(this, "AnalyticsBucket", {
      bucketName: `acme-liquors-analytics-${this.account}-${this.region}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: true,
      lifecycleRules: [
        {
          id: "TransitionToIA",
          transitions: [
            {
              storageClass: s3.StorageClass.INFREQUENT_ACCESS,
              transitionAfter: cdk.Duration.days(90),
            },
            {
              storageClass: s3.StorageClass.GLACIER,
              transitionAfter: cdk.Duration.days(365),
            },
          ],
        },
      ],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Glue Database for Athena
    this.glueDatabase = new glue.CfnDatabase(this, "GlueDatabase", {
      catalogId: this.account,
      databaseInput: {
        name: "acme_liquors_analytics",
        description: "ACME Liquors order analytics database",
      },
    });

    // Glue Table for orders
    new glue.CfnTable(this, "OrdersTable", {
      catalogId: this.account,
      databaseName: "acme_liquors_analytics",
      tableInput: {
        name: "orders",
        description: "Order events for analytics",
        tableType: "EXTERNAL_TABLE",
        parameters: {
          "projection.enabled": "true",
          "projection.year.type": "integer",
          "projection.year.range": "2024,2030",
          "projection.month.type": "integer",
          "projection.month.range": "1,12",
          "projection.month.digits": "2",
          "projection.day.type": "integer",
          "projection.day.range": "1,31",
          "projection.day.digits": "2",
          "storage.location.template": `s3://${this.analyticsBucket.bucketName}/orders/year=\${year}/month=\${month}/day=\${day}/`,
        },
        storageDescriptor: {
          location: `s3://${this.analyticsBucket.bucketName}/orders/`,
          inputFormat: "org.apache.hadoop.mapred.TextInputFormat",
          outputFormat: "org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat",
          serdeInfo: {
            serializationLibrary: "org.openx.data.jsonserde.JsonSerDe",
            parameters: {
              "ignore.malformed.json": "true",
            },
          },
          columns: [
            { name: "event_type", type: "string" },
            { name: "order_id", type: "string" },
            { name: "customer_id", type: "string" },
            { name: "store_id", type: "string" },
            { name: "county_id", type: "string" },
            { name: "status", type: "string" },
            { name: "payment_state", type: "string" },
            { name: "subtotal", type: "double" },
            { name: "tax", type: "double" },
            { name: "total", type: "double" },
            { name: "item_count", type: "int" },
            { name: "event_timestamp", type: "timestamp" },
            { name: "created_at", type: "timestamp" },
          ],
        },
        partitionKeys: [
          { name: "year", type: "string" },
          { name: "month", type: "string" },
          { name: "day", type: "string" },
        ],
      },
    });

    // Firehose transform Lambda
    const lambdaDir = path.join(__dirname, "../../../services/analytics-export/src/handlers");

    const transformFn = new nodejs.NodejsFunction(this, "FirehoseTransformFn", {
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      entry: path.join(lambdaDir, "firehose-transform.ts"),
      functionName: "acme-firehose-transform",
      description: "Transform events for Firehose delivery to S3",
      memorySize: 256,
      timeout: cdk.Duration.minutes(1),
      tracing: lambda.Tracing.ACTIVE,
      logRetention: logs.RetentionDays.ONE_MONTH,
      bundling: {
        minify: true,
        sourceMap: true,
        externalModules: ["@aws-sdk/*"],
      },
      environment: {
        NODE_OPTIONS: "--enable-source-maps",
      },
    });

    // IAM role for Firehose
    const firehoseRole = new iam.Role(this, "FirehoseRole", {
      assumedBy: new iam.ServicePrincipal("firehose.amazonaws.com"),
      description: "Role for Kinesis Firehose to deliver to S3",
    });

    this.analyticsBucket.grantReadWrite(firehoseRole);
    transformFn.grantInvoke(firehoseRole);

    // CloudWatch log group for Firehose errors
    const firehoseLogGroup = new logs.LogGroup(this, "FirehoseLogGroup", {
      logGroupName: "/aws/kinesisfirehose/acme-orders-analytics",
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const firehoseLogStream = new logs.LogStream(this, "FirehoseLogStream", {
      logGroup: firehoseLogGroup,
      logStreamName: "delivery-errors",
    });

    firehoseLogGroup.grantWrite(firehoseRole);

    // Kinesis Firehose Delivery Stream
    this.firehoseStream = new firehose.CfnDeliveryStream(this, "OrdersFirehose", {
      deliveryStreamName: "acme-orders-analytics",
      deliveryStreamType: "DirectPut",
      extendedS3DestinationConfiguration: {
        bucketArn: this.analyticsBucket.bucketArn,
        roleArn: firehoseRole.roleArn,
        prefix: "orders/year=!{timestamp:yyyy}/month=!{timestamp:MM}/day=!{timestamp:dd}/",
        errorOutputPrefix: "errors/year=!{timestamp:yyyy}/month=!{timestamp:MM}/day=!{timestamp:dd}/!{firehose:error-output-type}/",
        bufferingHints: {
          intervalInSeconds: 60,
          sizeInMBs: 5,
        },
        compressionFormat: "GZIP",
        processingConfiguration: {
          enabled: true,
          processors: [
            {
              type: "Lambda",
              parameters: [
                {
                  parameterName: "LambdaArn",
                  parameterValue: transformFn.functionArn,
                },
                {
                  parameterName: "BufferSizeInMBs",
                  parameterValue: "1",
                },
                {
                  parameterName: "BufferIntervalInSeconds",
                  parameterValue: "60",
                },
              ],
            },
          ],
        },
        cloudWatchLoggingOptions: {
          enabled: true,
          logGroupName: firehoseLogGroup.logGroupName,
          logStreamName: firehoseLogStream.logStreamName,
        },
      },
    });

    // Lambda to forward EventBridge events to Firehose
    const eventForwarderFn = new nodejs.NodejsFunction(this, "EventForwarderFn", {
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      entry: path.join(lambdaDir, "event-forwarder.ts"),
      functionName: "acme-event-forwarder",
      description: "Forward EventBridge events to Firehose",
      memorySize: 128,
      timeout: cdk.Duration.seconds(30),
      logRetention: logs.RetentionDays.ONE_MONTH,
      bundling: {
        minify: true,
        sourceMap: true,
        externalModules: ["@aws-sdk/*"],
      },
      environment: {
        NODE_OPTIONS: "--enable-source-maps",
        FIREHOSE_STREAM_NAME: "acme-orders-analytics",
      },
    });

    // Grant Firehose PutRecord permission
    eventForwarderFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["firehose:PutRecord", "firehose:PutRecordBatch"],
        resources: [this.firehoseStream.attrArn],
      })
    );

    // EventBridge rule to capture all order events
    new events.Rule(this, "OrderEventsToFirehose", {
      eventBus: props.eventBus,
      ruleName: "orders-to-analytics",
      description: "Forward all order events to analytics pipeline",
      eventPattern: {
        source: ["acme.orders"],
      },
      targets: [new eventsTargets.LambdaFunction(eventForwarderFn)],
    });

    // Athena workgroup
    new cdk.CfnResource(this, "AthenaWorkgroup", {
      type: "AWS::Athena::WorkGroup",
      properties: {
        Name: "acme-liquors-analytics",
        Description: "ACME Liquors analytics workgroup",
        State: "ENABLED",
        WorkGroupConfiguration: {
          ResultConfiguration: {
            OutputLocation: `s3://${this.analyticsBucket.bucketName}/athena-results/`,
            EncryptionConfiguration: {
              EncryptionOption: "SSE_S3",
            },
          },
          EnforceWorkGroupConfiguration: true,
          PublishCloudWatchMetricsEnabled: true,
          BytesScannedCutoffPerQuery: 10737418240, // 10 GB
        },
      },
    });

    // Outputs
    new cdk.CfnOutput(this, "AnalyticsBucketName", {
      value: this.analyticsBucket.bucketName,
      exportName: "AcmeLiquors-AnalyticsBucketName",
    });

    new cdk.CfnOutput(this, "GlueDatabaseName", {
      value: "acme_liquors_analytics",
      exportName: "AcmeLiquors-GlueDatabaseName",
    });

    new cdk.CfnOutput(this, "FirehoseStreamName", {
      value: this.firehoseStream.deliveryStreamName!,
      exportName: "AcmeLiquors-FirehoseStreamName",
    });

    new cdk.CfnOutput(this, "AthenaWorkgroupName", {
      value: "acme-liquors-analytics",
      exportName: "AcmeLiquors-AthenaWorkgroupName",
    });
  }
}
