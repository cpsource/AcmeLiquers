import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as kms from "aws-cdk-lib/aws-kms";
import { Construct } from "constructs";

export interface OrderTableProps {
  encryptionKey: kms.Key;
}

/**
 * Orders table with GSIs for common access patterns:
 * - Primary: customer_id (PK) + order_ts#order_id (SK) - Customer order history
 * - GSI1: county_id + order_ts - County ops dashboard
 * - GSI2: store_id + order_ts - Store fulfillment
 * - GSI3: status + order_ts - Pick/pack queues
 */
export class OrderTable extends Construct {
  public readonly table: dynamodb.Table;

  constructor(scope: Construct, id: string, props: OrderTableProps) {
    super(scope, id);

    this.table = new dynamodb.Table(this, "Table", {
      tableName: "acme-orders",
      partitionKey: {
        name: "customer_id",
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: "order_ts_id",
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: props.encryptionKey,
      pointInTimeRecovery: true,
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      timeToLiveAttribute: "ttl",
    });

    // GSI1: County operations dashboard
    this.table.addGlobalSecondaryIndex({
      indexName: "county-order-index",
      partitionKey: {
        name: "county_id",
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: "order_ts",
        type: dynamodb.AttributeType.STRING,
      },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // GSI2: Store fulfillment
    this.table.addGlobalSecondaryIndex({
      indexName: "store-order-index",
      partitionKey: {
        name: "store_id",
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: "order_ts",
        type: dynamodb.AttributeType.STRING,
      },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // GSI3: Status-based queues (pick/pack)
    this.table.addGlobalSecondaryIndex({
      indexName: "status-order-index",
      partitionKey: {
        name: "status",
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: "order_ts",
        type: dynamodb.AttributeType.STRING,
      },
      projectionType: dynamodb.ProjectionType.ALL,
    });
  }
}
