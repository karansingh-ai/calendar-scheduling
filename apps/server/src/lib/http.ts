import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ZodError, type ZodTypeAny, type z } from "zod";

export class HttpError extends Error {
  constructor(
    public status: ContentfulStatusCode,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) => new HttpError(400, "bad_request", message, details);
export const unauthorized = (message = "Authentication required") => new HttpError(401, "unauthorized", message);
export const forbidden = (message = "You do not have permission to do this") => new HttpError(403, "forbidden", message);
export const notFound = (message = "Not found") => new HttpError(404, "not_found", message);
export const conflict = (message: string, code = "conflict") => new HttpError(409, code, message);

/** Parse a JSON body with a zod schema, returning a 400 with field errors on failure. */
export async function parseBody<T extends ZodTypeAny>(c: Context, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw badRequest("Request body must be valid JSON");
  }
  return parseWith(schema, raw);
}

export function parseQuery<T extends ZodTypeAny>(c: Context, schema: T): z.infer<T> {
  return parseWith(schema, c.req.query());
}

export function parseWith<T extends ZodTypeAny>(schema: T, raw: unknown): z.infer<T> {
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw badRequest("Validation failed", formatZod(result.error));
  }
  return result.data;
}

export function formatZod(error: ZodError) {
  return error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
}

export function errorResponse(c: Context, err: unknown) {
  if (err instanceof HttpError) {
    return c.json({ error: { code: err.code, message: err.message, details: err.details } }, err.status);
  }
  if (err instanceof ZodError) {
    return c.json({ error: { code: "bad_request", message: "Validation failed", details: formatZod(err) } }, 400);
  }
  console.error(err);
  return c.json({ error: { code: "internal_error", message: "Something went wrong" } }, 500);
}
