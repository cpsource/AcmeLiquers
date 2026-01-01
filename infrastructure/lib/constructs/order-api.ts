import * as cdk from "aws-cdk-lib";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";
import * as path from "path";

export interface OrderApiProps {
  api: apigateway.RestApi;
  ordersTable: dynamodb.ITable;
  orderByIdTable: dynamodb.ITable;
  orderQueue: sqs.IQueue;
}

export class OrderApi extends Construct {
  public readonly createOrderFn: lambda.Function;
  public readonly getOrderFn: lambda.Function;
  public readonly listOrdersFn: lambda.Function;
  public readonly cancelOrderFn: lambda.Function;

  constructor(scope: Construct, id: string, props: OrderApiProps) {
    super(scope, id);

    const lambdaDir = path.join(__dirname, "../../../services/order-api/src/handlers");

    // Common Lambda configuration
    const commonLambdaProps: Partial<nodejs.NodejsFunctionProps> = {
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: cdk.Duration.seconds(10),
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
        ORDER_QUEUE_URL: props.orderQueue.queueUrl,
      },
    };

    // Create Order Lambda
    this.createOrderFn = new nodejs.NodejsFunction(this, "CreateOrderFn", {
      ...commonLambdaProps,
      entry: path.join(lambdaDir, "create-order.ts"),
      functionName: "acme-create-order",
      description: "Create a new order",
    });

    // Get Order Lambda
    this.getOrderFn = new nodejs.NodejsFunction(this, "GetOrderFn", {
      ...commonLambdaProps,
      entry: path.join(lambdaDir, "get-order.ts"),
      functionName: "acme-get-order",
      description: "Get order by ID",
    });

    // List Orders Lambda
    this.listOrdersFn = new nodejs.NodejsFunction(this, "ListOrdersFn", {
      ...commonLambdaProps,
      entry: path.join(lambdaDir, "list-orders.ts"),
      functionName: "acme-list-orders",
      description: "List orders by customer",
    });

    // Cancel Order Lambda
    this.cancelOrderFn = new nodejs.NodejsFunction(this, "CancelOrderFn", {
      ...commonLambdaProps,
      entry: path.join(lambdaDir, "cancel-order.ts"),
      functionName: "acme-cancel-order",
      description: "Cancel an order",
    });

    // Grant permissions
    props.ordersTable.grantReadWriteData(this.createOrderFn);
    props.ordersTable.grantReadData(this.listOrdersFn);
    props.ordersTable.grantReadWriteData(this.cancelOrderFn);

    props.orderByIdTable.grantReadWriteData(this.createOrderFn);
    props.orderByIdTable.grantReadData(this.getOrderFn);
    props.orderByIdTable.grantReadWriteData(this.cancelOrderFn);

    props.orderQueue.grantSendMessages(this.createOrderFn);

    // API Gateway resources
    const ordersResource = props.api.root.addResource("orders");

    // POST /orders
    ordersResource.addMethod(
      "POST",
      new apigateway.LambdaIntegration(this.createOrderFn, {
        proxy: true,
      }),
      {
        operationName: "CreateOrder",
        requestParameters: {
          "method.request.header.X-Idempotency-Key": true,
        },
        requestValidator: new apigateway.RequestValidator(this, "CreateOrderValidator", {
          restApi: props.api,
          validateRequestBody: true,
          validateRequestParameters: true,
        }),
        requestModels: {
          "application/json": new apigateway.Model(this, "CreateOrderModel", {
            restApi: props.api,
            contentType: "application/json",
            modelName: "CreateOrderRequest",
            schema: {
              type: apigateway.JsonSchemaType.OBJECT,
              required: ["customer_id", "store_id", "county_id", "items", "shipping_address"],
              properties: {
                customer_id: { type: apigateway.JsonSchemaType.STRING },
                store_id: { type: apigateway.JsonSchemaType.STRING },
                county_id: { type: apigateway.JsonSchemaType.STRING },
                items: {
                  type: apigateway.JsonSchemaType.ARRAY,
                  items: {
                    type: apigateway.JsonSchemaType.OBJECT,
                    required: ["sku", "name", "quantity", "unit_price"],
                    properties: {
                      sku: { type: apigateway.JsonSchemaType.STRING },
                      name: { type: apigateway.JsonSchemaType.STRING },
                      quantity: { type: apigateway.JsonSchemaType.INTEGER },
                      unit_price: { type: apigateway.JsonSchemaType.NUMBER },
                    },
                  },
                },
                shipping_address: {
                  type: apigateway.JsonSchemaType.OBJECT,
                  required: ["street", "city", "state", "zip"],
                  properties: {
                    street: { type: apigateway.JsonSchemaType.STRING },
                    city: { type: apigateway.JsonSchemaType.STRING },
                    state: { type: apigateway.JsonSchemaType.STRING },
                    zip: { type: apigateway.JsonSchemaType.STRING },
                  },
                },
              },
            },
          }),
        },
      }
    );

    // GET /orders (list by customer)
    ordersResource.addMethod(
      "GET",
      new apigateway.LambdaIntegration(this.listOrdersFn, {
        proxy: true,
      }),
      {
        operationName: "ListOrders",
        requestParameters: {
          "method.request.querystring.customer_id": true,
          "method.request.querystring.limit": false,
          "method.request.querystring.next_token": false,
        },
      }
    );

    // Single order resource
    const orderResource = ordersResource.addResource("{order_id}");

    // GET /orders/{order_id}
    orderResource.addMethod(
      "GET",
      new apigateway.LambdaIntegration(this.getOrderFn, {
        proxy: true,
      }),
      {
        operationName: "GetOrder",
      }
    );

    // DELETE /orders/{order_id}
    orderResource.addMethod(
      "DELETE",
      new apigateway.LambdaIntegration(this.cancelOrderFn, {
        proxy: true,
      }),
      {
        operationName: "CancelOrder",
      }
    );
  }
}
