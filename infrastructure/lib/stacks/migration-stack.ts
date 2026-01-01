import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as logs from "aws-cdk-lib/aws-logs";
import * as ssm from "aws-cdk-lib/aws-ssm";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as lambdaEventSources from "aws-cdk-lib/aws-lambda-event-sources";
import { Construct } from "constructs";
import * as path from "path";

export interface MigrationStackProps extends cdk.StackProps {
  ordersTable: dynamodb.ITable;
  orderByIdTable: dynamodb.ITable;
  inventoryTable: dynamodb.ITable;
}

export class MigrationStack extends cdk.Stack {
  public readonly dualWriteFn: lambda.Function;
  public readonly backfillFn: lambda.Function;

  constructor(scope: Construct, id: string, props: MigrationStackProps) {
    super(scope, id, props);

    const lambdaDir = path.join(__dirname, "../../../migration/src");

    // SSM Parameter for dual-write feature flag
    const dualWriteEnabled = new ssm.StringParameter(this, "DualWriteEnabled", {
      parameterName: "/acme-liquors/migration/dual-write-enabled",
      stringValue: "false",
      description: "Feature flag to enable/disable dual-write to SQL",
      tier: ssm.ParameterTier.STANDARD,
    });

    // Secret for SQL database connection
    // In production, create this manually or via separate stack
    const sqlConnectionSecret = new secretsmanager.Secret(this, "SqlConnectionSecret", {
      secretName: "acme-liquors/sql-connection",
      description: "SQL database connection string for migration",
      generateSecretString: {
        secretStringTemplate: JSON.stringify({
          host: "your-sql-host.rds.amazonaws.com",
          port: 5432,
          database: "acme_orders",
          username: "migration_user",
        }),
        generateStringKey: "password",
        excludePunctuation: true,
      },
    });

    // Dual-Write Lambda (triggered by DynamoDB Streams)
    this.dualWriteFn = new nodejs.NodejsFunction(this, "DualWriteFn", {
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      entry: path.join(lambdaDir, "dual-write/sql-writer.ts"),
      functionName: "acme-dual-write-sql",
      description: "Write DynamoDB changes to SQL for backward compatibility",
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
        DUAL_WRITE_PARAM_NAME: dualWriteEnabled.parameterName,
        SQL_SECRET_ARN: sqlConnectionSecret.secretArn,
      },
    });

    // Grant permissions
    dualWriteEnabled.grantRead(this.dualWriteFn);
    sqlConnectionSecret.grantRead(this.dualWriteFn);

    // Add DynamoDB Streams trigger for dual-write
    this.dualWriteFn.addEventSource(
      new lambdaEventSources.DynamoEventSource(props.ordersTable, {
        startingPosition: lambda.StartingPosition.TRIM_HORIZON,
        batchSize: 100,
        maxBatchingWindow: cdk.Duration.seconds(5),
        retryAttempts: 3,
        reportBatchItemFailures: true,
      })
    );

    // Backfill Lambda (for historical data migration)
    this.backfillFn = new nodejs.NodejsFunction(this, "BackfillFn", {
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      entry: path.join(lambdaDir, "backfill/historical-import.ts"),
      functionName: "acme-historical-backfill",
      description: "Import historical orders from SQL to DynamoDB",
      memorySize: 1024,
      timeout: cdk.Duration.minutes(15),
      tracing: lambda.Tracing.ACTIVE,
      logRetention: logs.RetentionDays.ONE_MONTH,
      bundling: {
        minify: true,
        sourceMap: true,
        externalModules: ["@aws-sdk/*"],
      },
      environment: {
        NODE_OPTIONS: "--enable-source-maps",
        SQL_SECRET_ARN: sqlConnectionSecret.secretArn,
        ORDERS_TABLE_NAME: props.ordersTable.tableName,
        ORDERS_BY_ID_TABLE_NAME: props.orderByIdTable.tableName,
      },
    });

    // Grant permissions for backfill
    sqlConnectionSecret.grantRead(this.backfillFn);
    props.ordersTable.grantWriteData(this.backfillFn);
    props.orderByIdTable.grantWriteData(this.backfillFn);

    // SSM Parameter for backfill progress tracking
    const backfillProgress = new ssm.StringParameter(this, "BackfillProgress", {
      parameterName: "/acme-liquors/migration/backfill-progress",
      stringValue: JSON.stringify({
        status: "NOT_STARTED",
        lastProcessedId: null,
        totalProcessed: 0,
        startedAt: null,
        updatedAt: null,
      }),
      description: "Tracks progress of historical data backfill",
      tier: ssm.ParameterTier.STANDARD,
    });

    backfillProgress.grantRead(this.backfillFn);
    backfillProgress.grantWrite(this.backfillFn);

    this.backfillFn.addEnvironment("BACKFILL_PROGRESS_PARAM", backfillProgress.parameterName);

    // DMS Replication Instance (commented out - uncomment when ready)
    // Note: DMS requires VPC setup and is expensive, so we provide the
    // configuration but leave it commented for manual deployment
    /*
    const vpc = ec2.Vpc.fromLookup(this, "Vpc", {
      isDefault: true, // Or specify your VPC
    });

    const dmsRole = new iam.Role(this, "DmsRole", {
      assumedBy: new iam.ServicePrincipal("dms.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonDynamoDBFullAccess"),
      ],
    });

    const replicationSubnetGroup = new dms.CfnReplicationSubnetGroup(
      this,
      "ReplicationSubnetGroup",
      {
        replicationSubnetGroupDescription: "ACME Liquors DMS subnet group",
        subnetIds: vpc.privateSubnets.map((s) => s.subnetId),
      }
    );

    const replicationInstance = new dms.CfnReplicationInstance(
      this,
      "ReplicationInstance",
      {
        replicationInstanceClass: "dms.t3.medium",
        allocatedStorage: 50,
        publiclyAccessible: false,
        replicationSubnetGroupIdentifier: replicationSubnetGroup.ref,
        vpcSecurityGroupIds: [securityGroup.securityGroupId],
      }
    );
    */

    // Outputs
    new cdk.CfnOutput(this, "DualWriteParamName", {
      value: dualWriteEnabled.parameterName,
      description: "SSM parameter to enable/disable dual-write",
      exportName: "AcmeLiquors-DualWriteParamName",
    });

    new cdk.CfnOutput(this, "SqlSecretArn", {
      value: sqlConnectionSecret.secretArn,
      description: "Secret ARN for SQL connection",
      exportName: "AcmeLiquors-SqlSecretArn",
    });

    new cdk.CfnOutput(this, "BackfillProgressParam", {
      value: backfillProgress.parameterName,
      description: "SSM parameter tracking backfill progress",
      exportName: "AcmeLiquors-BackfillProgressParam",
    });

    new cdk.CfnOutput(this, "DualWriteFnArn", {
      value: this.dualWriteFn.functionArn,
      exportName: "AcmeLiquors-DualWriteFnArn",
    });

    new cdk.CfnOutput(this, "BackfillFnArn", {
      value: this.backfillFn.functionArn,
      exportName: "AcmeLiquors-BackfillFnArn",
    });
  }
}
