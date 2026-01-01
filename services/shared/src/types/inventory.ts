import { z } from "zod";

// Inventory item schema
export const InventoryItemSchema = z.object({
  store_sku: z.string().min(1), // Composite: store_id#sku
  store_id: z.string().min(1),
  sku: z.string().min(1),
  product_name: z.string().min(1),
  quantity_available: z.number().int().min(0),
  quantity_reserved: z.number().int().min(0),
  reorder_level: z.number().int().min(0),
  unit_cost: z.number().positive(),
  updated_at: z.string(),
});

export type InventoryItem = z.infer<typeof InventoryItemSchema>;

// Reservation record
export interface Reservation {
  reservation_id: string;
  order_id: string;
  store_sku: string;
  quantity: number;
  status: "PENDING" | "CONFIRMED" | "RELEASED";
  created_at: string;
  expires_at: string;
}

// Inventory update request
export interface InventoryUpdateRequest {
  store_id: string;
  sku: string;
  quantity_delta: number; // Positive to add, negative to subtract
}

// Reservation request
export interface ReservationRequest {
  order_id: string;
  items: Array<{
    store_id: string;
    sku: string;
    quantity: number;
  }>;
}

// Reservation response
export interface ReservationResponse {
  reservation_id: string;
  order_id: string;
  success: boolean;
  failed_items?: Array<{
    sku: string;
    requested: number;
    available: number;
  }>;
}
