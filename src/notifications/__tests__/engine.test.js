import { test } from "node:test";
import assert from "node:assert/strict";

import { render, helpers } from "../templates/engine.js";
import { Channels } from "../config/events.js";

test("fills placeholders from context (email subject, no escape)", () => {
  const def = { subject: "Hi {{customerName}} re {{bookingId}}", html: "<p>{{customerName}}</p>" };
  const out = render(def, Channels.EMAIL, { customerName: "Alice", bookingId: "B-1" });
  assert.equal(out.subject, "Hi Alice re B-1");
  assert.ok(out.body.includes("Alice"));
});

test("email body HTML-escapes dangerous characters into entities", () => {
  const def = { html: "<p>{{name}}</p>" };
  const out = render(def, Channels.EMAIL, { name: `<script>alert("x")&'</script>` });
  // raw dangerous chars must NOT survive in the placeholder value
  assert.ok(!out.body.includes("<script>"));
  assert.ok(out.body.includes("&lt;script&gt;"));
  assert.ok(out.body.includes("&quot;"));
  assert.ok(out.body.includes("&#39;"));
  assert.ok(out.body.includes("&amp;"));
});

test("email subject is NOT HTML-escaped", () => {
  const def = { subject: "Order <{{id}}> & done", html: "x" };
  const out = render(def, Channels.EMAIL, { id: "5" });
  assert.equal(out.subject, "Order <5> & done");
});

test("sms strips ASCII control chars and collapses whitespace", () => {
  const def = { text: "code:{{v}}" };
  const out = render(def, Channels.SMS, { v: "a\x00b\nc\r\td   e" });
  // control chars (incl \n \r \t) become spaces, then runs collapse to single
  assert.ok(!/[\x00-\x1F\x7F]/.test(out.body));
  assert.equal(out.body, "code:a b c d e");
  assert.equal(out.subject, undefined); // sms has no subject
});

test("whatsapp also sanitizes control chars", () => {
  const def = { text: "msg {{v}}" };
  const out = render(def, Channels.WHATSAPP, { v: "x\x07\x1Fy" });
  assert.ok(!/[\x00-\x1F\x7F]/.test(out.body));
  assert.equal(out.body, "msg x y");
});

test("missing / null / undefined placeholder resolves to empty string", () => {
  const def = { subject: "[{{missing}}]", html: "<i>{{a.b.c}}</i>" };
  const out = render(def, Channels.EMAIL, { a: { b: {} }, nullish: null });
  assert.equal(out.subject, "[]");
  assert.equal(out.body, "<i></i>");

  const out2 = render({ text: "v={{nope}}" }, Channels.SMS, {});
  assert.equal(out2.body, "v=");
});

test("function-style template definitions are invoked with ctx", () => {
  const def = (ctx) => ({
    subject: ctx.paid ? "Paid {{bookingId}}" : "Unpaid {{bookingId}}",
    html: "<p>{{customerName}}</p>",
  });
  const paid = render(def, Channels.EMAIL, { paid: true, bookingId: "B9", customerName: "Bob" });
  assert.equal(paid.subject, "Paid B9");
  assert.ok(paid.body.includes("Bob"));

  const unpaid = render(def, Channels.EMAIL, { paid: false, bookingId: "B9", customerName: "Bob" });
  assert.equal(unpaid.subject, "Unpaid B9");
});

test("empty template definition throws", () => {
  assert.throws(() => render(null, Channels.EMAIL, {}), /empty/);
  assert.throws(() => render(() => null, Channels.SMS, {}), /empty/);
});

test("helpers expose htmlEscape and textSanitize", () => {
  assert.equal(helpers.htmlEscape(`<a>&"'`), "&lt;a&gt;&amp;&quot;&#39;");
  assert.equal(helpers.textSanitize("a\x00 b   c"), "a b c");
});
