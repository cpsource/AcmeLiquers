import { OrderStatus, PaymentState, OrderItem } from "./order";

/**
 * Base event interface for all order events
 */
export interface BaseOrderEvent {
  event_type: string;
  order_id: string;
  customer_id: string;
  timestamp: string;
}

/**
 * Event emitted when a new order is created
 */
export interface OrderCreatedEvent extends BaseOrderEvent {
  event_type: "ORDER_CREATED";
  store_id: string;
  county_id: string;
  status: OrderStatus;
  total: number;
  item_count: number;
}

/**
 * Event emitted when order status changes
 */
export interface OrderStatusChangedEvent extends BaseOrderEvent {
  event_type: "ORDER_STATUS_CHANGED";
  store_id: string;
  county_id: string;
  old_status: OrderStatus;
  new_status: OrderStatus;
  total: number;
}

/**
 * Event emitted when order is confirmed
 */
export interface OrderConfirmedEvent extends BaseOrderEvent {
  event_type: "ORDER_CONFIRMED";
  store_id: string;
  county_id: string;
  total: number;
  items: OrderItem[];
  shipping_address: {
    street: string;
    city: string;
    state: string;
    zip: string;
  };
}

/**
 * Event emitted when order is cancelled
 */
export interface OrderCancelledEvent extends BaseOrderEvent {
  event_type: "ORDER_CANCELLED";
  store_id: string;
  county_id: string;
  total: number;
}

/**
 * Event emitted when order is shipped
 */
export interface OrderShippedEvent extends BaseOrderEvent {
  event_type: "ORDER_SHIPPED";
  store_id: string;
  shipping_address: {
    street: string;
    city: string;
    state: string;
    zip: string;
  };
}

/**
 * Event emitted when payment state changes
 */
export interface PaymentStateChangedEvent extends BaseOrderEvent {
  event_type: "PAYMENT_STATE_CHANGED";
  old_state: PaymentState;
  new_state: PaymentState;
  total: number;
}

/**
 * Event emitted when order is deleted (should be rare)
 */
export interface OrderDeletedEvent extends BaseOrderEvent {
  event_type: "ORDER_DELETED";
}

/**
 * Union type of all order events
 */
export type OrderEvent =
  | OrderCreatedEvent
  | OrderStatusChangedEvent
  | OrderConfirmedEvent
  | OrderCancelledEvent
  | OrderShippedEvent
  | PaymentStateChangedEvent
  | OrderDeletedEvent;

/**
 * EventBridge event wrapper
 */
export interface EventBridgeEvent<T extends OrderEvent> {
  version: string;
  id: string;
  "detail-type": string;
  source: string;
  account: string;
  time: string;
  region: string;
  resources: string[];
  detail: T;
}

/**
 * Event detail types for EventBridge rules
 */
export const EventDetailTypes = {
  ORDER_CREATED: "Order Created",
  ORDER_STATUS_CHANGED: "Order Status Changed",
  ORDER_CONFIRMED: "Order Confirmed",
  ORDER_CANCELLED: "Order Cancelled",
  ORDER_SHIPPED: "Order Shipped",
  ORDER_DELIVERED: "Order Delivered",
  PAYMENT_STATE_CHANGED: "Payment State Changed",
  ORDER_DELETED: "Order Deleted",
} as const;

export type EventDetailType = (typeof EventDetailTypes)[keyof typeof EventDetailTypes];
