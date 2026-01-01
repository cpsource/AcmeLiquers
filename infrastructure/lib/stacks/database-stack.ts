import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as kms from "aws-cdk-lib/aws-kms";
import { Construct } from "constructs";
import { OrderTable } from "../constructs/order-table";

export class DatabaseStack extends cdk.Stack {
  public readonly ordersTable: dynamodb.Table;
  public readonly orderByIdTable: dynamodb.Table;
  public readonly inventoryTable: dynamodb.Table;
  public readonly encryptionKey: kms.Key;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // KMS key for encryption at rest
    this.encryptionKey = new kms.Key(this, "EncryptionKey", {
      alias: "acme-liquors/dynamodb",
      description: "KMS key for ACME Liquors DynamoDB encryption",
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Orders table with GSIs
    const orderTable = new OrderTable(this, "OrderTable", {
      encryptionKey: this.encryptionKey,
    });
    this.ordersTable = orderTable.table;

    // OrderById table for direct lookups
    this.orderByIdTable = new dynamodb.Table(this, "OrderByIdTable", {
      tableName: "acme-orders-by-id",
      partitionKey: {
        name: "order_id",
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: this.encryptionKey,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Inventory table
    this.inventoryTable = new dynamodb.Table(this, "InventoryTable", {
      tableName: "acme-inventory",
      partitionKey: {
        name: "store_sku",
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: this.encryptionKey,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Outputs
    new cdk.CfnOutput(this, "OrdersTableName", {
      value: this.ordersTable.tableName,
      exportName: "AcmeLiquors-OrdersTableName",
    });

    new cdk.CfnOutput(this, "OrderByIdTableName", {
      value: this.orderByIdTable.tableName,
      exportName: "AcmeLiquors-OrderByIdTableName",
    });

    new cdk.CfnOutput(this, "InventoryTableName", {
      value: this.inventoryTable.tableName,
      exportName: "AcmeLiquors-InventoryTableName",
    });

    new cdk.CfnOutput(this, "OrdersTableStreamArn", {
      value: this.ordersTable.tableStreamArn ?? "",
      exportName: "AcmeLiquors-OrdersTableStreamArn",
    });
  }
}
