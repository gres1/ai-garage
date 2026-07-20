#!/usr/bin/env node
// Генератор Pro-ключей AI Garage. Запускает Az приватным ключом подписи.
// НЕ входит в npm-пакет (files[] в package.json). Приватный ключ НИКОГДА не в репо.
//
//   node tools/make-license.mjs --priv <path-to-private.key> --email buyer@x.com [--plan pro] [--days 365]
//
// Без --days ключ бессрочный (lifetime). Печатает готовый ключ — отдать покупателю.

import { readFileSync } from "node:fs";
import { sign as edSign, createPrivateKey } from "node:crypto";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((a, x, i, arr) => {
    if (x.startsWith("--")) a.push([x.slice(2), arr[i + 1] && !arr[i + 1].startsWith("--") ? arr[i + 1] : true]);
    return a;
  }, [])
);

if (!args.priv || !args.email) {
  console.error("нужно: --priv <файл приватного ключа> --email <почта покупателя> [--plan pro] [--days N]");
  process.exit(1);
}

const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const privDer = Buffer.from(readFileSync(args.priv, "utf8").trim(), "base64");
const privKey = createPrivateKey({ key: privDer, format: "der", type: "pkcs8" });

const now = Date.now();
const payload = {
  email: String(args.email),
  plan: args.plan && args.plan !== true ? String(args.plan) : "pro",
  iat: now,
  ...(args.days && args.days !== true ? { exp: now + Number(args.days) * 86400_000 } : {}),
};
const payloadBuf = Buffer.from(JSON.stringify(payload), "utf8");
const sig = edSign(null, payloadBuf, privKey);
const key = `${b64url(payloadBuf)}.${b64url(sig)}`;

console.log("\nPro-ключ (отдать покупателю):\n");
console.log(key);
console.log("\nпокупатель:", payload.email, "| план:", payload.plan, "| срок:", payload.exp ? new Date(payload.exp).toISOString().slice(0, 10) : "бессрочно");
