import * as cdk from "aws-cdk-lib";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as wafv2 from "aws-cdk-lib/aws-wafv2";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";
import { OrderApi } from "../constructs/order-api";

export interface ApiStackProps extends cdk.StackProps {
  ordersTable: dynamodb.ITable;
  orderByIdTable: dynamodb.ITable;
  orderQueue: sqs.IQueue;
}

export class ApiStack extends cdk.Stack {
  public readonly api: apigateway.RestApi;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    // Create REST API
    this.api = new apigateway.RestApi(this, "OrderApi", {
      restApiName: "ACME Liquors Order API",
      description: "API for order intake and management",
      deployOptions: {
        stageName: "prod",
        throttlingBurstLimit: 1000,
        throttlingRateLimit: 500,
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
        dataTraceEnabled: true,
        metricsEnabled: true,
      },
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: [
          "Content-Type",
          "Authorization",
          "X-Idempotency-Key",
        ],
      },
    });

    // Create WAF WebACL
    const webAcl = new wafv2.CfnWebACL(this, "WebAcl", {
      name: "acme-liquors-api-waf",
      scope: "REGIONAL",
      defaultAction: { allow: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: "AcmeLiquorsApiWaf",
        sampledRequestsEnabled: true,
      },
      rules: [
        // Rate limiting rule
        {
          name: "RateLimitRule",
          priority: 1,
          action: { block: {} },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: "RateLimitRule",
            sampledRequestsEnabled: true,
          },
          statement: {
            rateBasedStatement: {
              limit: 2000, // Requests per 5-minute period per IP
              aggregateKeyType: "IP",
            },
          },
        },
        // AWS Managed Rules - Common Rule Set
        {
          name: "AWSManagedRulesCommonRuleSet",
          priority: 2,
          overrideAction: { none: {} },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: "AWSManagedRulesCommonRuleSet",
            sampledRequestsEnabled: true,
          },
          statement: {
            managedRuleGroupStatement: {
              vendorName: "AWS",
              name: "AWSManagedRulesCommonRuleSet",
            },
          },
        },
        // AWS Managed Rules - Known Bad Inputs
        {
          name: "AWSManagedRulesKnownBadInputsRuleSet",
          priority: 3,
          overrideAction: { none: {} },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: "AWSManagedRulesKnownBadInputsRuleSet",
            sampledRequestsEnabled: true,
          },
          statement: {
            managedRuleGroupStatement: {
              vendorName: "AWS",
              name: "AWSManagedRulesKnownBadInputsRuleSet",
            },
          },
        },
      ],
    });

    // Associate WAF with API Gateway
    new wafv2.CfnWebACLAssociation(this, "WebAclAssociation", {
      resourceArn: this.api.deploymentStage.stageArn,
      webAclArn: webAcl.attrArn,
    });

    // Create Order API endpoints
    new OrderApi(this, "OrderApi", {
      api: this.api,
      ordersTable: props.ordersTable,
      orderByIdTable: props.orderByIdTable,
      orderQueue: props.orderQueue,
    });

    // Outputs
    new cdk.CfnOutput(this, "ApiUrl", {
      value: this.api.url,
      exportName: "AcmeLiquors-ApiUrl",
    });

    new cdk.CfnOutput(this, "ApiId", {
      value: this.api.restApiId,
      exportName: "AcmeLiquors-ApiId",
    });
  }
}
