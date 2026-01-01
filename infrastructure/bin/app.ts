#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { DatabaseStack } from "../lib/stacks/database-stack";
import { ProcessingStack } from "../lib/stacks/processing-stack";
import { ApiStack } from "../lib/stacks/api-stack";
import { EventsStack } from "../lib/stacks/events-stack";
import { AnalyticsStack } from "../lib/stacks/analytics-stack";
import { MigrationStack } from "../lib/stacks/migration-stack";

const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? "us-east-1",
};

// Database stack - DynamoDB tables
const databaseStack = new DatabaseStack(app, "AcmeLiquors-Database", {
  env,
  description: "ACME Liquors DynamoDB tables and indexes",
});

// Processing stack - SQS queues + Lambda workers
const processingStack = new ProcessingStack(app, "AcmeLiquors-Processing", {
  env,
  description: "ACME Liquors order processing queues and workers",
  ordersTable: databaseStack.ordersTable,
  orderByIdTable: databaseStack.orderByIdTable,
  inventoryTable: databaseStack.inventoryTable,
});

// API stack - API Gateway + Lambda handlers
new ApiStack(app, "AcmeLiquors-Api", {
  env,
  description: "ACME Liquors Order API",
  ordersTable: databaseStack.ordersTable,
  orderByIdTable: databaseStack.orderByIdTable,
  orderQueue: processingStack.orderQueue,
});

// Events stack - DynamoDB Streams + EventBridge
const eventsStack = new EventsStack(app, "AcmeLiquors-Events", {
  env,
  description: "ACME Liquors event streaming and EventBridge",
  ordersTable: databaseStack.ordersTable,
});

// Analytics stack - Firehose + S3 + Athena
new AnalyticsStack(app, "AcmeLiquors-Analytics", {
  env,
  description: "ACME Liquors analytics pipeline",
  eventBus: eventsStack.eventBus,
});

// Migration stack - Dual-write + Backfill (optional, for SQL migration)
new MigrationStack(app, "AcmeLiquors-Migration", {
  env,
  description: "ACME Liquors SQL migration tools",
  ordersTable: databaseStack.ordersTable,
  orderByIdTable: databaseStack.orderByIdTable,
  inventoryTable: databaseStack.inventoryTable,
});

app.synth();
