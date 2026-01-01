import { z } from "zod";

// Order status enum
export const OrderStatus = {
  PENDING: "PENDING",
  CONFIRMED: "CONFIRMED",
  PROCESSING: "PROCESSING",
  SHIPPED: "SHIPPED",
  DELIVERED: "DELIVERED",
  CANCELLED: "CANCELLED",
  FAILED: "FAILED",
} as const;

export type OrderStatus = (typeof OrderStatus)[keyof typeof OrderStatus];

// Payment state enum
export const PaymentState = {
  PENDING: "PENDING",
  AUTHORIZED: "AUTHORIZED",
  CAPTURED: "CAPTURED",
  FAILED: "FAILED",
  REFUNDED: "REFUNDED",
} as const;

export type PaymentState = (typeof PaymentState)[keyof typeof PaymentState];

// Order item schema (full, with calculated total_price)
export const OrderItemSchema = z.object({
  sku: z.string().min(1),
  name: z.string().min(1),
  quantity: z.number().int().positive(),
  unit_price: z.number().positive(),
  total_price: z.number().positive(),
});

export type OrderItem = z.infer<typeof OrderItemSchema>;

// Order item schema for create request (total_price calculated by handler)
export const CreateOrderItemSchema = z.object({
  sku: z.string().min(1),
  name: z.string().min(1),
  quantity: z.number().int().positive(),
  unit_price: z.number().positive(),
});

export type CreateOrderItem = z.infer<typeof CreateOrderItemSchema>;

// Create order request schema (idempotency_key comes from header)
export const CreateOrderRequestSchema = z.object({
  customer_id: z.string().min(1),
  store_id: z.string().min(1),
  county_id: z.string().min(1),
  items: z.array(CreateOrderItemSchema).min(1),
  shipping_address: z.object({
    street: z.string().min(1),
    city: z.string().min(1),
    state: z.string().length(2),
    zip: z.string().min(5).max(10),
  }),
});

export type CreateOrderRequest = z.infer<typeof CreateOrderRequestSchema>;

// Full order type (stored in DynamoDB)
export interface Order {
  // Primary key
  customer_id: string;
  order_ts_id: string; // Composite: order_ts#order_id

  // Order identifiers
  order_id: string;
  order_ts: string; // ISO timestamp

  // Location info (for GSIs)
  store_id: string;
  county_id: string;

  // Status
  status: OrderStatus;
  payment_state: PaymentState;

  // Order details
  items: OrderItem[];
  subtotal: number;
  tax: number;
  total: number;

  // Shipping
  shipping_address: {
    street: string;
    city: string;
    state: string;
    zip: string;
  };

  // Idempotency
  idempotency_key: string;

  // Timestamps
  created_at: string;
  updated_at: string;

  // Optional TTL for temporary records
  ttl?: number;
}

// Order stored in OrderById table
export interface OrderById {
  order_id: string;
  customer_id: string;
  order_ts: string;
  status: OrderStatus;
  payment_state: PaymentState;
  store_id: string;
  county_id: string;
  items: OrderItem[];
  subtotal: number;
  tax: number;
  total: number;
  shipping_address: {
    street: string;
    city: string;
    state: string;
    zip: string;
  };
  created_at: string;
  updated_at: string;
}

// API response types
export interface OrderResponse {
  order_id: string;
  customer_id: string;
  status: OrderStatus;
  payment_state: PaymentState;
  items: OrderItem[];
  subtotal: number;
  tax: number;
  total: number;
  created_at: string;
}

export interface OrderListResponse {
  orders: OrderResponse[];
  next_token?: string;
}
