/**
 * Ambient declaration so TypeScript accepts Bun's text-import of `.sql` files:
 *   import schemaSql from "./schema.sql" with { type: "text" };
 * Bun inlines the file content as a string at runtime and when `bun build`
 * bundles (used to make the mirror schema travel inside the standalone plugin).
 */
declare module "*.sql" {
  const content: string;
  export default content;
}
