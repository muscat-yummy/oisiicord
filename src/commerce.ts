import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
export const COMMERCE_SCHEMA = `
CREATE TABLE IF NOT EXISTS store_orders(id TEXT PRIMARY KEY,user TEXT NOT NULL REFERENCES users(id),product TEXT NOT NULL,guild TEXT REFERENCES guilds(id) ON DELETE SET NULL,amount TEXT NOT NULL,days INTEGER NOT NULL,provider TEXT NOT NULL,store TEXT NOT NULL,invoice TEXT UNIQUE,status TEXT NOT NULL,checkout TEXT,created INTEGER NOT NULL,granted INTEGER);
CREATE TABLE IF NOT EXISTS user_upgrades(user TEXT PRIMARY KEY REFERENCES users(id),order_id TEXT NOT NULL REFERENCES store_orders(id));
CREATE TABLE IF NOT EXISTS server_boosts(guild TEXT PRIMARY KEY REFERENCES guilds(id) ON DELETE CASCADE,expires INTEGER NOT NULL);
`;
export function litoshi(value: unknown): bigint {
  if (
    typeof value !== "string" ||
    !/^(?:0|[1-9]\d{0,6})(?:\.\d{1,8})?$/.test(value)
  )
    throw Error("LTCの金額が不正です");
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 100000000n + BigInt(fraction.padEnd(8, "0"));
}
function providerLitoshi(value: unknown): bigint {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0 || value >= 10000000)
      throw Error("LTCの金額が不正です");
    const decimal = value.toFixed(8);
    if (Number(decimal) !== value) throw Error("LTCの金額が不正です");
    return litoshi(decimal);
  }
  return litoshi(value);
}
const initial = {
  enabled: false,
  btcpay_url: "",
  store_id: "",
  api_key: "",
  plus_ltc: "",
  boost_ltc: "",
  boost_days: 30,
};
export function createCommerce(
  ctx: any,
  directory: string,
  fetcher: typeof fetch = fetch,
  allowLocal = false,
) {
  mkdirSync(directory, { recursive: true });
  const file = join(directory, "store.json");
  try {
    writeFileSync(file, JSON.stringify(initial, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
  } catch (e: any) {
    if (e.code !== "EEXIST") throw e;
  }
  const { one, all, run, db, fail, response, json, limit, changed } = ctx;
  function config() {
    try {
      const folder = lstatSync(directory),
        stat = lstatSync(file);
      if (
        folder.isSymbolicLink() ||
        stat.isSymbolicLink() ||
        !stat.isFile() ||
        stat.size > 65536
      )
        throw Error();
      const c = JSON.parse(readFileSync(file, "utf8"));
      if (typeof c.enabled !== "boolean") throw Error();
      if (!c.enabled) return null;
      const url = new URL(c.btcpay_url);
      if (
        url.username ||
        url.password ||
        url.pathname !== "/" ||
        url.search ||
        url.hash ||
        !(
          url.protocol === "https:" ||
          (allowLocal &&
            url.protocol === "http:" &&
            ["127.0.0.1", "localhost"].includes(url.hostname))
        )
      )
        throw Error();
      if (
        typeof c.store_id !== "string" ||
        !c.store_id ||
        c.store_id.length > 200 ||
        typeof c.api_key !== "string" ||
        !c.api_key ||
        c.api_key.length > 4096 ||
        litoshi(c.plus_ltc) <= 0n ||
        litoshi(c.boost_ltc) <= 0n ||
        !Number.isSafeInteger(c.boost_days) ||
        c.boost_days < 1 ||
        c.boost_days > 365
      )
        throw Error();
      return { ...c, origin: url.origin };
    } catch {
      return fail(503, "購入設定を読み込めません");
    }
  }
  const plus = (uid: string) =>
    !!one("SELECT 1 FROM user_upgrades WHERE user=?", uid);
  const boosted = (guild: string) =>
    Number(
      one("SELECT expires FROM server_boosts WHERE guild=?", guild)?.expires ??
        0,
    ) > Date.now();
  function benefits(uid: string) {
    return {
      plus: plus(uid),
      guildLimit: plus(uid) ? 100 : 30,
      globalEmojis: plus(uid),
    };
  }
  function guildBenefits(guild: string) {
    const active = boosted(guild);
    return {
      boosted: active,
      boostExpires:
        one("SELECT expires FROM server_boosts WHERE guild=?", guild)
          ?.expires ?? null,
      emojiLimit: active ? 300 : 100,
      channelLimit: active ? 300 : 100,
      memberLimit: active ? 300 : 100,
    };
  }
  async function provider(c: any, path: string, body?: any) {
    let res;
    try {
      res = await fetcher(
        c.origin + "/api/v1/stores/" + encodeURIComponent(c.store_id) + path,
        {
          method: body === undefined ? "GET" : "POST",
          headers: {
            Authorization: "token " + c.api_key,
            "Content-Type": "application/json",
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          redirect: "error",
          signal: AbortSignal.timeout(15000),
        },
      );
    } catch {
      return fail(502, "決済サービスに接続できません");
    }
    if (!res.ok) return fail(502, "決済サービスの処理に失敗しました");
    const reader = res.body?.getReader();
    if (!reader) return fail(502, "決済サービスの応答が不正です");
    const chunks = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 1024 * 1024) throw Error();
        chunks.push(value);
      }
      return JSON.parse(Buffer.concat(chunks).toString());
    } catch {
      return fail(502, "決済サービスの応答が不正です");
    } finally {
      await reader.cancel().catch(() => {});
    }
  }
  function cleanOrder(row: any) {
    return {
      id: row.id,
      product: row.product,
      guild: row.guild,
      amount: row.amount,
      currency: "LTC",
      status: row.status,
      checkout: row.checkout,
      created: row.created,
      granted: row.granted,
    };
  }
  async function handle(req: Request, url: URL, uid: string) {
    if (!url.pathname.startsWith("/api/store")) return;
    if (url.pathname === "/api/store" && req.method === "GET") {
      const c = config();
      return response({
        enabled: !!c,
        ...benefits(uid),
        products: c
          ? [
              {
                id: "plus",
                name: "Oisiicord Plus",
                amount: c.plus_ltc,
                currency: "LTC",
                permanent: true,
              },
              {
                id: "boost",
                name: "サーバーブースト",
                amount: c.boost_ltc,
                currency: "LTC",
                days: c.boost_days,
              },
            ]
          : [],
        orders: all(
          "SELECT * FROM store_orders WHERE user=? ORDER BY created DESC LIMIT 20",
          uid,
        ).map(cleanOrder),
      });
    }
    if (url.pathname === "/api/store/orders" && req.method === "POST") {
      limit("checkout:" + uid, 3, 60000);
      const c = config();
      if (!c) return fail(503, "購入受付は準備中です");
      const b = await json(req);
      if (!["plus", "boost"].includes(b.product))
        return fail(400, "商品が不正です");
      if (b.product === "plus" && plus(uid)) return fail(409, "購入済みです");
      if (
        b.product === "boost" &&
        !one("SELECT 1 FROM members WHERE guild=? AND user=?", b.guild, uid)
      )
        return fail(403, "参加中のサーバーを選んでください");
      const pending = one(
        "SELECT * FROM store_orders WHERE user=? AND product=? AND (guild IS ? OR guild=?) AND (status='Processing' OR (status IN ('Creating','New') AND created>?)) ORDER BY created DESC LIMIT 1",
        uid,
        b.product,
        b.product === "boost" ? b.guild : null,
        b.product === "boost" ? b.guild : null,
        Date.now() - 20 * 60000,
      );
      if (pending) {
        if (!pending.checkout) return fail(409, "請求書を作成中です");
        return response(cleanOrder(pending));
      }
      const id = crypto.randomUUID(),
        amount = b.product === "plus" ? c.plus_ltc : c.boost_ltc,
        guild = b.product === "boost" ? b.guild : null;
      run(
        "INSERT INTO store_orders(id,user,product,guild,amount,days,provider,store,status,created) VALUES(?,?,?,?,?,?,?,?,?,?)",
        id,
        uid,
        b.product,
        guild,
        amount,
        c.boost_days,
        c.origin,
        c.store_id,
        "Creating",
        Date.now(),
      );
      const invoice = await provider(c, "/invoices", {
        amount,
        currency: "LTC",
        metadata: { orderId: id, itemCode: b.product },
        checkout: {
          paymentMethods: ["LTC-CHAIN"],
          expirationMinutes: 20,
          monitoringMinutes: 120,
          paymentTolerance: 0,
        },
      }).catch((error: any) => {
        run("UPDATE store_orders SET status='Failed' WHERE id=?", id);
        throw error;
      });
      let checkout;
      try {
        checkout = new URL(invoice.checkoutLink);
        if (
          checkout.origin !== c.origin ||
          checkout.username ||
          checkout.password ||
          typeof invoice.id !== "string" ||
          invoice.id.length > 200
        )
          throw Error();
      } catch {
        return fail(502, "決済ページの応答が不正です");
      }
      run(
        "UPDATE store_orders SET invoice=?,checkout=?,status='New' WHERE id=?",
        invoice.id,
        checkout.href,
        id,
      );
      return response(
        cleanOrder(one("SELECT * FROM store_orders WHERE id=?", id)),
      );
    }
    const m = url.pathname.match(/^\/api\/store\/orders\/([\w-]+)$/);
    if (m && req.method === "GET") {
      limit("payment-poll:" + uid, 12, 60000);
      const order = one(
        "SELECT * FROM store_orders WHERE id=? AND user=?",
        m[1],
        uid,
      );
      if (!order) return fail(404, "購入情報が見つかりません");
      if (order.granted) return response(cleanOrder(order));
      const c = config();
      if (!c || c.origin !== order.provider || c.store_id !== order.store)
        return fail(503, "決済設定が変更されています");
      if (!order.invoice) return fail(409, "請求書を作成できませんでした");
      const invoice = await provider(
        c,
        "/invoices/" + encodeURIComponent(order.invoice),
      );
      if (
        invoice.id !== order.invoice ||
        invoice.metadata?.orderId !== order.id ||
        invoice.currency !== "LTC" ||
        providerLitoshi(invoice.amount) !== litoshi(order.amount)
      )
        return fail(502, "決済内容が一致しません");
      if (invoice.status === "Settled") {
        const methods = await provider(
          c,
          "/invoices/" + encodeURIComponent(order.invoice) + "/payment-methods",
        );
        const ltc = Array.isArray(methods)
          ? methods.find((p: any) => p.paymentMethodId === "LTC-CHAIN")
          : null;
        if (
          !ltc ||
          providerLitoshi(ltc.totalPaid ?? "0") < litoshi(order.amount) ||
          providerLitoshi(ltc.due ?? "1") !== 0n
        )
          return fail(409, "LTCの入金確認を待っています");
        db.transaction(() => {
          const fresh = one(
            "SELECT granted FROM store_orders WHERE id=?",
            order.id,
          );
          if (fresh.granted) return;
          if (
            !one(
              "SELECT 1 FROM users WHERE id=? AND NOT EXISTS(SELECT 1 FROM deleted_accounts WHERE user=?)",
              uid,
              uid,
            )
          )
            return fail(401, "ログインが必要です");
          if (order.product === "plus")
            run(
              "INSERT OR IGNORE INTO user_upgrades VALUES(?,?)",
              uid,
              order.id,
            );
          else {
            if (
              !order.guild ||
              !one("SELECT 1 FROM guilds WHERE id=?", order.guild)
            )
              return fail(
                409,
                "購入先のサーバーがありません。管理者に連絡してください",
              );
            const expires =
              Math.max(
                Date.now(),
                Number(
                  one(
                    "SELECT expires FROM server_boosts WHERE guild=?",
                    order.guild,
                  )?.expires ?? 0,
                ),
              ) +
              order.days * 86400000;
            run(
              "INSERT INTO server_boosts VALUES(?,?) ON CONFLICT(guild) DO UPDATE SET expires=excluded.expires",
              order.guild,
              expires,
            );
          }
          run(
            "UPDATE store_orders SET status='Settled',granted=? WHERE id=?",
            Date.now(),
            order.id,
          );
        })();
        if (order.guild) changed(order.guild);
      } else
        run(
          "UPDATE store_orders SET status=? WHERE id=?",
          String(invoice.status).slice(0, 30),
          order.id,
        );
      return response(
        cleanOrder(one("SELECT * FROM store_orders WHERE id=?", order.id)),
      );
    }
  }
  return { handle, benefits, guildBenefits, plus, boosted };
}
