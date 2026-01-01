import { z, ZodError, ZodSchema } from "zod";

/**
 * Validation result type
 */
export interface ValidationResult<T> {
  success: boolean;
  data?: T;
  errors?: ValidationError[];
}

/**
 * Validation error details
 */
export interface ValidationError {
  field: string;
  message: string;
  code: string;
}

/**
 * Validate data against a Zod schema
 */
export function validate<T>(
  schema: ZodSchema<T>,
  data: unknown
): ValidationResult<T> {
  try {
    const result = schema.parse(data);
    return { success: true, data: result };
  } catch (error) {
    if (error instanceof ZodError) {
      const errors: ValidationError[] = error.errors.map((e) => ({
        field: e.path.join("."),
        message: e.message,
        code: e.code,
      }));
      return { success: false, errors };
    }
    throw error;
  }
}

/**
 * Validate and throw if invalid
 */
export function validateOrThrow<T>(schema: ZodSchema<T>, data: unknown): T {
  return schema.parse(data);
}

/**
 * Common validation schemas
 */
export const CommonSchemas = {
  // UUID format
  uuid: z.string().uuid(),

  // Order ID format (ORD-ULID)
  orderId: z.string().regex(/^ORD-[0-9A-Z]{26}$/, "Invalid order ID format"),

  // Customer ID
  customerId: z.string().min(1).max(128),

  // Pagination
  pagination: z.object({
    limit: z.number().int().min(1).max(100).default(20),
    next_token: z.string().optional(),
  }),

  // Date range
  dateRange: z.object({
    start: z.string().datetime().optional(),
    end: z.string().datetime().optional(),
  }),
};

/**
 * Format validation errors for API response
 */
export function formatValidationErrors(errors: ValidationError[]): {
  message: string;
  details: ValidationError[];
} {
  return {
    message: "Validation failed",
    details: errors,
  };
}

/**
 * API Gateway event body parser with validation
 */
export function parseAndValidateBody<T>(
  schema: ZodSchema<T>,
  body: string | null | undefined
): ValidationResult<T> {
  if (!body) {
    return {
      success: false,
      errors: [{ field: "body", message: "Request body is required", code: "required" }],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return {
      success: false,
      errors: [{ field: "body", message: "Invalid JSON", code: "invalid_json" }],
    };
  }

  return validate(schema, parsed);
}

/**
 * Validate query string parameters
 */
export function parseQueryParams<T>(
  schema: ZodSchema<T>,
  params: Record<string, string | undefined> | null
): ValidationResult<T> {
  if (!params) {
    return validate(schema, {});
  }

  // Convert string values to appropriate types based on schema
  return validate(schema, params);
}
