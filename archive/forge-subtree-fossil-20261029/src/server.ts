import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { apiReference } from "@scalar/hono-api-reference";
import { borrow, renderBorrow, type SourceName } from "./src/borrow";

export const borrowApi = new OpenAPIHono();

// Interactive Scalar documentation route
borrowApi.get(
  "/docs",
  apiReference({
    theme: "purple",
    pageTitle: "Pattern-Borrow Modular API",
    spec: {
      url: "/openapi.json",
    },
  })
);

const BorrowQuerySchema = z.object({
  query: z.string().openapi({ example: "modern mcp openapi typescript" }),
  top: z.coerce.number().optional().default(5).openapi({ example: 5 }),
  sources: z.string().optional().openapi({ example: "arxiv,github,openalex" }),
  format: z.enum(["json", "compact", "markdown"]).optional().default("compact"),
});

const BorrowRoute = createRoute({
  method: "get",
  path: "/borrow",
  request: {
    query: BorrowQuerySchema,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            ok: z.boolean(),
            query: z.string(),
            timingMs: z.number(),
            count: z.number(),
            items: z.array(z.any()),
          }),
        },
        "text/plain": {
          schema: z.string(),
        },
      },
      description: "Ranked and deduplicated borrow patterns",
    },
  },
});

borrowApi.openapi(BorrowRoute, async (c) => {
  const query = c.req.query("query") || "";
  const top = Number(c.req.query("top") || 5);
  const format = c.req.query("format") || "compact";

  const result = await borrow(query, { perSource: top });

  if (format === "compact" || format === "markdown") {
    return c.text(renderBorrow(result, top));
  }

  return c.json({
    ok: result.ok,
    query: result.query,
    timingMs: result.timingMs,
    count: result.ranked.length,
    items: result.ranked.slice(0, top),
  });
});

borrowApi.doc("/openapi.json", {
  openapi: "3.1.0",
  info: {
    title: "Pattern-Borrow Modern API & Scalar Docs",
    version: "2.0.0",
  },
});

if (import.meta.main) {
  const port = Number(process.env.PORT || 25244);
  console.log(`[+] Starting Pattern-Borrow API with Scalar UI at http://localhost:${port}/docs`);
  Bun.serve({
    fetch: borrowApi.fetch,
    port,
  });
}
