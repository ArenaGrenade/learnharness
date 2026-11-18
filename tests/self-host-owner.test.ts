import assert from "node:assert/strict";
import { test } from "node:test";
import { connectPrivateSubscriptionHost, hasPrivateSubscriptionHost } from "../src/agent/subscription-runtime.ts";
import { webSubscriptionOwner } from "../src/server/web-subscriptions.ts";

test("self-host subscription transport prevents a second filesystem credential owner", () => {
 const disconnect = connectPrivateSubscriptionHost("lh:chatgpt", {request: async () => ({})});
 try {
  assert(hasPrivateSubscriptionHost());
  assert.throws(() => webSubscriptionOwner(), /owned by the self-host connection service/);
 } finally { disconnect(); }
 assert.equal(hasPrivateSubscriptionHost(), false);
});
