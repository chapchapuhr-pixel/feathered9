// functions/api/products/[id]/share.ts
import type { PagesFunction } from "@cloudflare/workers-types";
import { createNotification } from "../../../utils/createNotification";

type Env = { DB: D1Database };

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-user-id",
};

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

const toNum = (v: any, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const ALLOWED_DESTINATIONS = new Set([
  "feed",
  "story",
  "message",
  "copy_link",
  "group",
  "external",
]);

export const onRequestOptions: PagesFunction = async () =>
  new Response(null, { status: 204, headers: cors });

export const onRequestPost: PagesFunction<Env> = async ({ request, env, params }) => {
  try {
    if (!env.DB) return json({ success: false, error: "DB binding missing" }, 500);

    // ✅ product id comes from URL path
    const product_id = toNum((params as any)?.id, 0);
    if (!product_id) {
      return json({ success: false, error: "Invalid product id" }, 400);
    }

    const body: any = await request.json().catch(() => ({}));

    const headerUserId = toNum(request.headers.get("x-user-id"), 0);
    const bodyUserId = toNum(body.user_id, 0);
    const user_id = headerUserId || bodyUserId || 0;

    const destination = String(body.destination || "feed").trim().toLowerCase();
    const message =
      typeof body.message === "string" && body.message.trim()
        ? body.message.trim()
        : null;

    if (!user_id) {
      return json({ success: false, error: "user_id is required" }, 400);
    }

    if (!ALLOWED_DESTINATIONS.has(destination)) {
      return json({ success: false, error: "Invalid destination" }, 400);
    }

    // Verify product exists
    const product = await env.DB
      .prepare(
        `SELECT id, seller_id FROM products
         WHERE id = ? AND COALESCE(is_deleted, 0) = 0
         LIMIT 1`
      )
      .bind(product_id)
      .first<any>();

    if (!product) {
      return json({ success: false, error: "Product not found" }, 404);
    }

    // Insert share record
    const ins = await env.DB
      .prepare(
        `INSERT INTO product_shares (product_id, user_id, destination, message, shared_at)
         VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`
      )
      .bind(product_id, user_id, destination, message)
      .run();

    const share_id = toNum(ins.meta?.last_row_id, 0);

    // Best-effort counter update
    try {
      await env.DB
        .prepare(
          `UPDATE products SET shares_count = COALESCE(shares_count, 0) + 1 WHERE id = ?`
        )
        .bind(product_id)
        .run();
    } catch (_) {}

    // Notify owner (never self)
    const ownerId = toNum(product.seller_id, 0);
    if (ownerId && ownerId !== user_id) {
      try {
        await createNotification(
          env,
          ownerId,
          user_id,
          "share",
          "product",
          product_id,
          `share_product_${product_id}`
        );
      } catch (_) {}
    }

    // Count from source of truth
    const countRow = await env.DB
      .prepare(`SELECT COUNT(*) AS c FROM product_shares WHERE product_id = ?`)
      .bind(product_id)
      .first<{ c: number }>();

    const count = toNum(countRow?.c, 0);

    return json({
      success: true,
      share_id,
      product_id,
      shares: count,
      share_count: count,
    });
  } catch (err: any) {
    return json(
      { success: false, error: err?.message || "Failed to share product" },
      500
    );
  }
};
