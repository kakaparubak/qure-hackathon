import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

/** Explicit construction: importing schema/types never opens a connection. */
export function createDatabase(connectionString: string) {
  if (!connectionString?.trim()) throw new Error("DATABASE_URL is required");
  const url = new URL(connectionString);
  if (!["postgres:", "postgresql:"].includes(url.protocol)) {
    throw new Error("DATABASE_URL must use postgres:// or postgresql://");
  }
  const client = postgres(connectionString, { prepare: false });
  return { db: drizzle(client, { schema }), close: () => client.end() };
}
export * from "./schema";
export * from "./mapping";
export * from "./repository";
export * from "./queue";
export * from "./pipeline-store";
